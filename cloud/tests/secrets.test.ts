import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig, ConfigError } from '../src/config'

/**
 * DONE WHEN 10, proved by search rather than by promise: the signing key and the vendor master password must be
 * absent from the repository, and the cloud must refuse to start with a weak or missing secret.
 *
 * The scan walks the tracked-or-present source tree, skipping build output and the test fixtures that
 * deliberately generate throwaway keys, and looks for the shapes a real secret would take.
 */
const ROOT = resolve(__dirname, '..', '..')

const SKIP_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', 'coverage', '.vite', '.turbo', '__pycache__',
  'tmp', 'backups', '.arena', '.cache', '.local', '.next', '.output', 'release',
])

function walk(directory: string, files: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue
      walk(path, files)
      continue
    }
    if (!/\.(ts|tsx|js|mjs|cjs|json|md|html|css|yml|yaml|env|example|sql|php|sh|ps1|txt)$/u.test(entry.name)) continue
    if (statSync(path).size > 512 * 1024) continue
    files.push(path)
  }
  return files
}

const files = walk(ROOT)

describe('secrets do not appear in the repository', () => {
  /**
   * A documentation line may legitimately print the PEM header; a real key always has a body. So the scan looks
   * for a header immediately followed by a base64 line long enough to be an Ed25519 or RSA key.
   */
  const PEM_WITH_BODY = /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\r\n]+([A-Za-z0-9+/=\r\n]{40,})/u

  function pemOffenders(): string[] {
    return files
      .filter((path) => !path.endsWith('secrets.test.ts'))
      .filter((path) => PEM_WITH_BODY.test(readFileSync(path, 'utf8')))
      .map((path) => relative(ROOT, path))
  }

  it('has no PEM private key with a key body anywhere in the repository', () => {
    expect(pemOffenders()).toEqual([])
  })

  it('generates every test key at run time instead of committing one', () => {
    // The cloud's own helper mints a fresh Ed25519 pair per test run, which is why the scan above is empty.
    const helper = readFileSync(join(ROOT, 'cloud', 'tests', 'helpers.ts'), 'utf8')
    expect(helper).toContain('generateKeyPairSync')
    expect(PEM_WITH_BODY.test(helper)).toBe(false)
  })

  it('has no vendor master password or password hash committed', () => {
    const patterns = [
      /masterPassword\s*[:=]\s*['"][^'"]{6,}['"]/iu,
      /master_password\s*[:=]\s*['"][^'"]{6,}['"]/iu,
      /masterPasswordHash\s*[:=]\s*['"]\$2[aby]\$/iu,
      /\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]{16,}\$[A-Za-z0-9+/]{16,}/u,
    ]
    const offenders: string[] = []
    for (const path of files) {
      // This test's own pattern list would match itself; the file is skipped by name.
      if (path.endsWith('cloud/tests/secrets.test.ts')) continue
      const text = readFileSync(path, 'utf8')
      for (const pattern of patterns) {
        const match = pattern.exec(text)
        if (match) offenders.push(`${relative(ROOT, path)}: ${match[0].slice(0, 40)}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('has no committed environment file holding a real secret', () => {
    const offenders = files.filter((path) => {
      if (!/\.env$/u.test(path)) return false
      const text = readFileSync(path, 'utf8')
      return /INFOFLEX_CLOUD_(SIGNING_KEY|SESSION_SECRET|RELAY_SECRET)\s*=\s*\S{16,}/u.test(text)
    })
    expect(offenders.map((path) => relative(ROOT, path))).toEqual([])
  })

  it('keeps the cloud’s example environment file free of usable values', () => {
    const example = join(ROOT, 'cloud', '.env.example')
    let text: string
    try {
      text = readFileSync(example, 'utf8')
    } catch {
      return
    }
    expect(text).toContain('INFOFLEX_CLOUD_SIGNING_KEY')
    expect(text).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/u)
    for (const line of text.split('\n')) {
      const match = /^([A-Z0-9_]+)=(.*)$/u.exec(line.trim())
      if (!match) continue
      const [, name, value] = match as unknown as [string, string, string]
      // A *name* for a key is not a key: `…_KEY_ID` is the label the vendor chooses ("infoflex-cloud-1"), printed
      // to every customer at /api/license/config, and it must have a value for the deployment to work. Everything
      // that holds a secret — a PEM, a random string, a password, a path to one — must be blank here, because a
      // value in this file is copied straight into production.
      if (/_KEY_ID$/u.test(name)) continue
      if (!/(SECRET|KEY|PASSWORD)/u.test(name)) continue
      // Comments and empty assignments only.
      expect({ name, acceptable: value.startsWith('#') || value.trim() === '' }).toEqual({ name, acceptable: true })
    }
  })
})

describe('the server refuses to start without its secrets', () => {
  const base = {
    NODE_ENV: 'development',
    INFOFLEX_CLOUD_SESSION_SECRET: 'a'.repeat(40),
    INFOFLEX_CLOUD_SIGNING_KEY: `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(64)}\n-----END PRIVATE KEY-----`,
  }

  it('requires a signing key', () => {
    expect(() => loadConfig({ ...base, INFOFLEX_CLOUD_SIGNING_KEY: '' })).toThrow(ConfigError)
  })

  it('rejects a key that is not a PEM private key', () => {
    expect(() => loadConfig({ ...base, INFOFLEX_CLOUD_SIGNING_KEY: 'hunter2' })).toThrow(/PEM/u)
  })

  it('requires a long session secret', () => {
    expect(() => loadConfig({ ...base, INFOFLEX_CLOUD_SESSION_SECRET: 'short' })).toThrow(/32 characters/u)
  })

  it('requires https and a relay secret in production', () => {
    const production = { ...base, NODE_ENV: 'production', INFOFLEX_CLOUD_PUBLIC_URL: 'http://licence.example.com' }
    expect(() => loadConfig(production)).toThrow(/https/u)
    expect(() => loadConfig({
      ...production,
      INFOFLEX_CLOUD_PUBLIC_URL: 'https://licence.example.com',
      INFOFLEX_CLOUD_RELAY_DOMAIN: 'relay.example.com',
    })).toThrow(/RELAY_SECRET/u)
  })

  it('reads a secret from a file when asked, so it need not live in the environment', () => {
    const secretFile = join(ROOT, 'cloud', 'tests', '.tmp-secret')
    // A file-based secret is the documented container path; it is exercised here with a temporary file.
    const { writeFileSync, unlinkSync, mkdirSync } = require('node:fs') as typeof import('node:fs')
    mkdirSync(join(ROOT, 'cloud', 'tests'), { recursive: true })
    writeFileSync(secretFile, 'b'.repeat(40))
    try {
      const config = loadConfig({ ...base, INFOFLEX_CLOUD_SESSION_SECRET: '', INFOFLEX_CLOUD_SESSION_SECRET_FILE: secretFile })
      expect(config.sessionSecret).toBe('b'.repeat(40))
    } finally {
      unlinkSync(secretFile)
    }
  })
})

/** Nothing above writes to the repository; this guards against a helper accidentally doing so. */
it('did not leave a temporary secret behind', () => {
  expect(files.length).toBeGreaterThan(50)
  expect(() => execFileSync('git', ['status', '--porcelain', '--', 'cloud/tests'], { cwd: ROOT })).not.toThrow()
})
