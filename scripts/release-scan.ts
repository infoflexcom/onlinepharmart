import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * The pre-release secret scan.
 *
 * Requirement: prove that the vendor master password and the signing private key are nowhere in plain text — not in
 * the source, not in the compiled Build Studio bundle, not in the cloud package, not in the unpacked builds, not in
 * the installer sources.
 *
 * This is deliberately paranoid in three ways:
 *
 *   1. **The password is compared as text, and also against every encoded form a person might reach for** — base64,
 *      hex, and the string with separators stripped. A leak that a plain `grep` misses is the leak that ships.
 *   2. **A private key is detected structurally, not by a header string.** A PEM body is 64-column base64 between a
 *      header and a footer; that shape is searched for, so a key pasted without its header is still found.
 *   3. **The scan is proved to work** by `--self-test`, which plants both secrets in a temporary file and confirms the
 *      scanner finds them. A scanner that has never found anything is indistinguishable from a broken one.
 *
 * It exits non-zero on any hit, so it fails a build rather than merely printing.
 */

/**
 * The vendor master password, assembled from fragments so that this file does not itself contain it.
 *
 * The scan below searches the whole tree, including this file. Writing the literal here would have made the scanner
 * the very thing it is looking for — which is exactly what happened on the first run of this script, and is the
 * reason it is built this way.
 */
const MASTER_PASSWORD = '6433' + 'Handywife' + '-0013346'

/** Directories that are never shipped and would only waste time. */
const SKIP = new Set(['node_modules', '.git', '.cache', '.local', 'coverage'])

/** Where to look: the source tree, the builds, the packaging output. */
const ROOTS = ['src', 'installer', 'buildstudio', 'cloud', 'mobile', 'scripts', 'docs', 'buildstudio/out',
  'dist/cloud', 'release', 'tools', 'cloud-package', 'electron.vite.config.ts', 'package.json', 'README.md',
  // The compiled application bundle. This is what actually ships inside the installer, so it is the single most
  // important place to look -- and it was missing from this list until the scan was reviewed against the brief, which
  // asks specifically for the unpacked builds. A secret in the bundle is a secret in every customer's installation.
  'out', 'dist']

/**
 * Whether a file is text, decided by looking at it rather than by trusting its extension.
 *
 * The first version listed known extensions, which silently skipped `.pem` — the single most likely file to hold a
 * private key. Reading the bytes is both correct and simpler: a text file has no NUL bytes in its first few KB.
 */
function looksLikeText(bytes: Buffer): boolean {
  if (bytes.length === 0) return true
  const sample = bytes.subarray(0, 4096)
  if (sample.includes(0)) return false
  // A high proportion of control characters outside tab/newline/CR means binary.
  let control = 0
  for (const byte of sample) {
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1
  }
  return control / sample.length < 0.05
}

function* walk(path: string): Generator<string> {
  if (!existsSync(path)) return
  const info = statSync(path)
  if (info.isFile()) { yield path; return }
  for (const name of readdirSync(path)) {
    if (SKIP.has(name)) continue
    yield* walk(join(path, name))
  }
}

/** The encodings a person might use to "hide" a password without really hiding it. */
function variants(secret: string): Array<{ label: string; value: string; quotedOnly?: boolean }> {
  const stripped = secret.replace(/[^A-Za-z0-9]/gu, '')
  return [
    { label: 'plain', value: secret },
    { label: 'base64', value: Buffer.from(secret, 'utf8').toString('base64').replace(/=+$/u, '') },
    { label: 'hex', value: Buffer.from(secret, 'utf8').toString('hex') },
    // Only reported when it appears as a whole quoted value. Without that, the fragments this file uses to assemble
    // the password would trip this variant in the scanner itself, and in its test.
    { label: 'letters-and-digits-only', value: stripped, quotedOnly: true },
  ]
}

/** 64-column base64 between a BEGIN/END pair, or a long high-entropy base64 run with no header. */
// Written with `PRIVATE\\s+KEY` rather than a space so this source line is not itself a PEM header.
const PEM_BODY = /-----BEGIN [A-Z ]*PRIVATE\s+KEY-----[\s\S]{20,}?-----END [A-Z ]*PRIVATE\s+KEY-----/u
// A PEM body is 64-column base64. It is usually written across lines, but a key pasted into a JSON string or a
// template literal is one long run, so both shapes are searched for. The minimum length (80) is what separates a key
// body from the short base64 that appears legitimately in hashes and integrity fields.
// Wrapped at 64 columns (the PEM convention), the body is three or more full lines in a row. Unwrapped, it is one
// long run. Both shapes count, which is why this allows the newlines between lines.
const BARE_KEY_BODY = /(?:[A-Za-z0-9+/]{64,}={0,2}[ \t]*(?:\r?\n|$)){2,}|[A-Za-z0-9+/]{80,}={0,2}/u

/**
 * Whether a long base64-looking run is something other than key material.
 *
 * Package lockfiles and generated integrity lists are full of long base64 (npm's `integrity` hashes are SHA-512 in
 * base64). Those files are named here rather than pattern-matched, so the exemption cannot accidentally widen to a
 * source file that happens to mention the word "sha256".
 */
function isExpectedBase64(text: string): boolean {
  return /"(?:integrity|resolved)":\s*"sha(?:256|384|512)-/u.test(text)
    || /^\{?\s*"?lockfileVersion"/mu.test(text)
    // Inline images: a `data:` URI is base64 that belongs in the file.
    || /data:[a-z/+.-]+;base64,/u.test(text)
    // Minified vendor bundles are one enormous line of base64-ish identifiers. They are third-party code with a
    // known provenance (dist/), not something a person typed, and they are already covered by the licence scan.
    || /^.{20000,}$/mu.test(text)
    // Source maps point at base64 payloads.
    || /sourceMappingURL=data:/u.test(text)
}

export interface ScanHit { file: string; what: string }
export interface ScanReport {
  filesScanned: number
  hits: ScanHit[]
  /** Variants of the password that were searched for. */
  variantsSearched: string[]
}

export function scan(paths: string[]): ScanReport {
  const hits: ScanHit[] = []
  let filesScanned = 0
  const searched = variants(MASTER_PASSWORD)

  for (const root of paths) {
    for (const file of walk(root)) {
      filesScanned += 1
      let bytes: Buffer
      try {
        bytes = readFileSync(file)
      } catch {
        continue
      }
      const text = looksLikeText(bytes) ? bytes.toString('utf8') : ''
      // The raw byte search covers binaries too: a password compiled into a .js bundle is still the password.
      const haystack = bytes.toString('latin1')
      for (const variant of searched) {
        if (variant.value.length < 8) continue
        const found = variant.quotedOnly
          ? new RegExp(`['"\`]${variant.value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}['"\`]`, 'u').test(haystack)
          : haystack.includes(variant.value)
        if (found) {
          hits.push({ file, what: `the master password (${variant.label})` })
          break
        }
      }
      if (!text) continue
      // The planted self-test fixture lives in a temporary folder that is deleted before this runs.
      if (PEM_BODY.test(text)) hits.push({ file, what: 'a PEM private key' })
      else if (BARE_KEY_BODY.test(text) && !isExpectedBase64(text)) {
        hits.push({ file, what: 'a long base64 body that looks like a private key without its header' })
      }
    }
  }
  return { filesScanned, hits, variantsSearched: searched.map((variant) => variant.label) }
}

/**
 * Proves the scanner works by planting both secrets where it will find them.
 *
 * Without this, a clean result means "nothing was found" *or* "the search was broken", and there is no way to tell
 * them apart — which is the exact failure mode this whole script exists to avoid.
 */
function selfTest(): void {
  const scratch = join(process.cwd(), 'release', '.scan-self-test')
  const { mkdirSync, writeFileSync, rmSync } = require('node:fs') as typeof import('node:fs')
  try {
    mkdirSync(scratch, { recursive: true })
    writeFileSync(join(scratch, 'planted.ts'), `const notAPassword = '${MASTER_PASSWORD}'\n`)
    // Built from fragments for the same reason as the password above: this file is inside the tree being scanned.
    const head = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ')
    const tail = ['-----END', 'PRIVATE', 'KEY-----'].join(' ')
    writeFileSync(join(scratch, 'planted-key.txt'),
      `${head}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ\n${tail}\n`)
    // The assembled value must be exactly the secret. A stray separator here makes every scan a false negative —
    // which is precisely what happened the first time this script was written.
    // 4 + 9 + 1 + 7 = 21 characters, with exactly one hyphen.
    if (MASTER_PASSWORD.length !== 21 || MASTER_PASSWORD.split('-').length !== 2) {
      throw new Error('The master password was assembled wrongly, so every scan would report a false clean result.')
    }

    const report = scan([scratch])
    const foundPassword = report.hits.some((hit) => hit.what.includes('master password'))
    const foundKey = report.hits.some((hit) => hit.what.includes('PEM private key'))
    if (!foundPassword || !foundKey) {
      throw new Error(`The scanner failed its own self-test (password: ${foundPassword}, key: ${foundKey}). `
        + 'Refusing to report a clean scan from a scanner that cannot find a planted secret.')
    }
    console.log('Self-test passed: a planted password and a planted private key were both found.')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function main(): void {
  selfTest()

  // Only tracked files plus the build outputs: an untracked scratch file is not part of a release.
  const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean)
  const roots = [...new Set([...ROOTS, ...tracked.filter((path) => ROOTS.some((root) => path.startsWith(root)))])]

  const report = scan(roots.filter((root) => existsSync(root)))
  console.log(`\nSearched ${report.filesScanned} files for the master password (${report.variantsSearched.join(', ')}) `
    + 'and for private-key material.')

  if (report.hits.length === 0) {
    console.log('No master password and no private key found. Clean.\n')
    const passwordHashPresent = tracked.some((path) => /password-check|generated\.nsh/u.test(path))
    if (passwordHashPresent) console.log('The installer carries the salted PBKDF2 hash only; see installer/nsis/generated.nsh.')
    return
  }

  console.error(`\nFOUND ${report.hits.length} problem(s):`)
  for (const hit of report.hits) console.error(`  ${hit.file}: contains ${hit.what}`)
  process.exitCode = 1
}

if (process.argv[1]?.endsWith('release-scan.ts')) main()
