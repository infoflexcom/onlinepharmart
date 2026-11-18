import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Runs the PHP build's own test suite inside a WebAssembly PHP, so the PHP variant is verified on every run of
 * the repository's tests instead of only on a server somebody remembers to check.
 *
 * The suite lives in `cloud/php/tests/run.php` and is a normal PHP script: a vendor can run it on their own host
 * with `php cloud/php/tests/run.php` and see the same output.
 *
 * What the WebAssembly build cannot do is Ed25519 (its OpenSSL has no such curve) or MySQL. The suite therefore
 * takes an HMAC signer for the envelope tests and uses SQLite; the Ed25519 path is asserted separately below by
 * checking that the production code asks for it, and `cloud/tests/license-flow.test.ts` proves the Node build
 * signs tokens the desktop accepts with the same canonical payload.
 */
const ROOT = resolve(__dirname, '..', '..')
const PHP_LIB = join(ROOT, 'cloud', 'php', 'lib')
const PHP_TESTS = join(ROOT, 'cloud', 'php', 'tests')

interface PhpRun {
  output: string
  status: number
}

/**
 * The PHP runtime is a dev dependency (`php-wasm` and its openssl/sqlite extensions). It is imported lazily so a
 * checkout that has not installed dev dependencies still runs every other cloud test instead of failing to load.
 */
async function loadPhp(): Promise<{ PhpNode: new (options: { version: string; sharedLibs: unknown[] }) => PhpRuntime; libs: unknown[] } | null> {
  try {
    const [base, opensslModule, sqliteModule] = await Promise.all([
      import('php-wasm/PhpNode.mjs'),
      import('php-wasm-openssl'),
      import('php-wasm-sqlite'),
    ])
    return {
      // The runtime's own types are narrower than this test needs; the wrapper below is the only thing used.
      PhpNode: base.PhpNode as unknown as new (options: { version: string; sharedLibs: unknown[] }) => PhpRuntime,
      libs: [opensslModule.default, sqliteModule.default],
    }
  } catch {
    return null
  }
}

interface PhpRuntime {
  mkdir(path: string): Promise<unknown>
  writeFile(path: string, contents: string | Uint8Array): Promise<void>
  run(path: string): Promise<number>
  exec(code: string): Promise<unknown>
  addEventListener(name: string, listener: (event: { detail: string[] }) => void): void
}

async function runPhpSuite(runtime: { PhpNode: new (options: { version: string; sharedLibs: unknown[] }) => PhpRuntime; libs: unknown[] }): Promise<PhpRun> {
  const php = new runtime.PhpNode({ version: '8.4', sharedLibs: runtime.libs })
  let output = ''
  php.addEventListener('output', (event: { detail: string[] }) => {
    output += event.detail[0] ?? ''
  })

  await php.mkdir('/php')
  await php.mkdir('/php/lib')
  await php.mkdir('/php/tests')
  for (const name of readdirSync(PHP_LIB)) {
    if (name.endsWith('.php')) await php.writeFile(`/php/lib/${name}`, readFileSync(join(PHP_LIB, name)))
  }
  // The suite includes its libraries by a path relative to itself; inside the sandbox that path is /php/lib.
  const suite = readFileSync(join(PHP_TESTS, 'run.php'), 'utf8')
    .replace(/__DIR__ \. '\/\.\.\/lib\//gu, "'/php/lib/")
  await php.writeFile('/php/tests/run.php', suite)

  // `run()` with a path echoes the path; `exec()` evaluates the include, which is what actually runs the suite.
  const result = await php.exec("include '/php/tests/run.php';")
  return { output, status: typeof result === 'number' ? result : 0 }
}

const phpRuntime = await loadPhp()

describe('the PHP and MySQL build', () => {
  it.skipIf(phpRuntime === null)('passes its own test suite', async () => {
    const { output } = await runPhpSuite(phpRuntime!)
    // A failure prints the count and the failing names; surfacing the tail makes a red test readable.
    expect(output).not.toMatch(/^FAIL /mu)
    expect(output).toMatch(/\d+ passed, 0 failed/u)
    const passed = Number(/(\d+) passed/u.exec(output)?.[1] ?? 0)
    expect(passed).toBeGreaterThanOrEqual(30)
  }, 120_000)

  it('signs with Ed25519 in production code, not the HMAC test seam', () => {
    const licence = readFileSync(join(PHP_LIB, 'licence.php'), 'utf8')
    // The real signer is `openssl_sign($payload, $signature, $key, 0)`: the 0 is "no digest", as Ed25519 requires.
    expect(licence).toMatch(/openssl_sign\(\$payload, \$signature, \$key, 0\)/u)
    const service = readFileSync(join(PHP_LIB, 'service.php'), 'utf8')
    // The service passes its signer through only when it is callable, and the API never sets one.
    expect(service).toMatch(/is_callable\(\$this->signer\)/u)
    const bootstrap = readFileSync(join(PHP_LIB, 'bootstrap.php'), 'utf8')
    expect(bootstrap).toMatch(/new IfxService\(ifx_database\(\), ifx_key_pem\(\$config\)/u)
    // Four arguments: database, key, key id. No signer, so production takes the OpenSSL path.
    expect(bootstrap).not.toMatch(/new IfxService\([^)]*,\s*[^)]*,\s*[^)]*,\s*[^)]*,/u)
  })

  it('requires the signing key to be a file path, never a value in the source', () => {
    const example = readFileSync(join(ROOT, 'cloud', 'php', 'config.example.php'), 'utf8')
    expect(example).toMatch(/'signing_key_path'/u)
    expect(example).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/u)
    const bootstrap = readFileSync(join(PHP_LIB, 'bootstrap.php'), 'utf8')
    expect(bootstrap).toMatch(/is_readable\(\$path\)/u)
  })

  it('keeps the schema free of business data and the currency list in step', () => {
    const database = readFileSync(join(PHP_LIB, 'database.php'), 'utf8')
    // Column declarations, not prose: a `price`/`amount` column would appear as a name followed by its type.
    expect(database).not.toMatch(/^\s*(price|amount|total|cost|quantity|sale_total|stock_level)\s+(INT|TEXT|DECIMAL|VARCHAR)/imu)
    const views = readFileSync(join(PHP_LIB, 'views.php'), 'utf8')
    expect(views).toMatch(/'NGN', 'Nigerian naira'/u)
    const pages = readFileSync(join(PHP_LIB, 'pages.php'), 'utf8')
    expect(pages).toMatch(/DEFAULT CURRENCY/u)
    expect(pages).toMatch(/lockCurrency/u)
  })

  it('escapes every value it prints and never builds SQL from input', () => {
    for (const name of readdirSync(PHP_LIB).filter((entry) => entry.endsWith('.php'))) {
      const source = readFileSync(join(PHP_LIB, name), 'utf8')
      // A query built by string concatenation of a request value is the one mistake this build must not make.
      expect(source, name).not.toMatch(/\$_(GET|POST|REQUEST)\[[^\]]*\]\s*\.\s*['"]\s*(WHERE|SELECT|INSERT|UPDATE|DELETE)/u)
      expect(source, name).not.toMatch(/query\(\s*['"][^'"]*\$_(GET|POST)/u)
    }
  })

  it('does not include the relay, which this build deliberately omits', () => {
    const files = readdirSync(join(ROOT, 'cloud', 'php'), { recursive: true }) as string[]
    expect(files.some((name) => /relay|websocket/iu.test(name))).toBe(false)
  })
})
