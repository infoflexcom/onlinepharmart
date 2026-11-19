import { createHash, pbkdf2Sync, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

/**
 * The helper the NSIS installer runs to answer the questions it cannot answer itself: is this the vendor's password,
 * are these the bytes the vendor pinned, and who signed them.
 *
 * NSIS has no crypto. Rather than weaken the gate to something NSIS *can* do (a plain comparison, or a hash
 * NSIS can compute in a few instructions — both of which would be trivially reversible from the installer
 * binary), the installer shells out to this program, which is built into the installer's payload.
 *
 *    password-check.exe <saltB64url> <hashB64url> <iterations> <password>
 *        exit 0 on a match, 1 on a mismatch, 2 on bad arguments
 *
 *    password-check.exe --sha256 <expectedHex> <file>
 *        exit 0 when the file's SHA-256 matches, 1 when it does not
 *
 * It is deliberately a separate, tiny executable with no dependencies. Everything it prints goes to stderr, so a
 * failure can never be mistaken for a success by the NSIS `nsExec` call that reads its exit code.
 */

export const PASSWORD_CHECK_USAGE =
  'password-check <salt> <hash> <iterations> <password> | --sha256 <hex> <file> | --authenticode <publisher> <file>'

export function verifyPasswordAgainstHash(
  password: string,
  saltBase64Url: string,
  expectedHashBase64Url: string,
  iterations: number,
): boolean {
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 2_000_000) return false
  const salt = Buffer.from(saltBase64Url, 'base64url')
  const expected = Buffer.from(expectedHashBase64Url, 'base64url')
  if (salt.length === 0 || expected.length === 0) return false
  const actual = pbkdf2Sync(password, salt, iterations, expected.length, 'sha256')
  // Constant time: a timing side channel on a password comparison is a real, if slow, way to leak it.
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function sha256FileHex(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function fileMatchesSha256(path: string, expectedHex: string): boolean {
  try {
    const actual = sha256FileHex(path)
    if (actual.length !== expectedHex.length) return false
    return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expectedHex.toLowerCase(), 'hex'))
  } catch {
    return false
  }
}

/**
 * What the Authenticode check concluded, as a decision rather than as a process result.
 *
 * Fails closed in every uncertain case: a non-zero exit, no output, an unsigned file (PowerShell prints nothing), or
 * output that is not a plain single-line value all resolve to `null`, which the caller treats as "do not run this".
 * This mirrors buildstudio/src/authenticode.ts deliberately -- the vendor's build tool makes the same judgement about
 * the same file, and the two must not disagree about what counts as verified.
 */
export function interpretAuthenticode(input: { exitCode: number | null; stdout: string }): string | null {
  if (input.exitCode !== 0) return null
  const subject = input.stdout.trim()
  if (!subject) return null
  // An unsigned file prints an empty string; a file that could not be read prints nothing too. Anything that is not
  // a plain single-line value is not a publisher name, and guessing would defeat the check.
  if (subject.includes('\n')) return null
  return subject
}

/**
 * `--authenticode <expectedPublisherSubstring> <file>`: exit 0 only when the file carries a valid signature whose
 * subject names the expected publisher.
 *
 * This exists because the installer downloads and RUNS the VC++ redistributable, and the checksum alone proves only
 * that the bytes are the ones the vendor pinned -- it says nothing about who signed them. The brief requires the
 * signature and the publisher to be checked before an executable runs, and the installer simply never did it.
 *
 * PowerShell is the only way to read Authenticode without linking Crypt32, and this helper is deliberately tiny and
 * dependency-free. On a machine where PowerShell is missing or blocked, this exits non-zero and the caller refuses,
 * which is the safe direction.
 */
export function runAuthenticodeCheck(argv: string[]): { code: number; message: string } {
  const [expected, file] = argv
  if (!expected || !file || !existsSync(file)) return { code: 2, message: PASSWORD_CHECK_USAGE }
  // Single-quoted string with '' for an embedded quote: PowerShell escapes a quote that way, and backtick and $ are
  // literal inside single quotes. Same rule as buildstudio/src/authenticode.ts -- a path must not be able to end the
  // literal and append a command.
  const escaped = file.replace(/'/gu, "''")
  const command =
    "$s = Get-AuthenticodeSignature -LiteralPath '" + escaped + "'; " +
    'if ($s.Status -ne \"Valid\") { exit 1 }; $s.SignerCertificate.Subject'
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  })
  const subject = interpretAuthenticode({ exitCode: result.status, stdout: result.stdout ?? '' })
  if (subject === null) return { code: 1, message: 'The file has no valid digital signature.' }
  if (!subject.toLowerCase().includes(expected.toLowerCase())) {
    return { code: 1, message: `The file was signed by "${subject}", not ${expected}.` }
  }
  return { code: 0, message: '' }
}

/** The program's entry point, split from the crypto so the crypto is directly testable. */
export function runPasswordCheck(argv: string[]): { code: number; message: string } {
  if (argv[0] === '--sha256') {
    const [, expected, file] = argv
    if (!expected || !file) return { code: 2, message: PASSWORD_CHECK_USAGE }
    return fileMatchesSha256(file, expected)
      ? { code: 0, message: '' }
      : { code: 1, message: 'The file does not match the expected checksum.' }
  }
  if (argv[0] === '--authenticode') {
    return runAuthenticodeCheck(argv.slice(1))
  }
  const [salt, hash, iterations, ...rest] = argv
  const password = rest.join(' ')
  if (!salt || !hash || !iterations) return { code: 2, message: PASSWORD_CHECK_USAGE }
  const parsed = Number(iterations)
  if (!Number.isInteger(parsed)) return { code: 2, message: PASSWORD_CHECK_USAGE }
  return verifyPasswordAgainstHash(password, salt, hash, parsed)
    ? { code: 0, message: '' }
    : { code: 1, message: 'That password is not correct.' }
}
