import { createHash, pbkdf2Sync, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'

/**
 * The helper the NSIS installer runs to answer two questions it cannot answer itself.
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

export const PASSWORD_CHECK_USAGE = 'password-check <salt> <hash> <iterations> <password> | --sha256 <hex> <file>'

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

/** The program's entry point, split from the crypto so the crypto is directly testable. */
export function runPasswordCheck(argv: string[]): { code: number; message: string } {
  if (argv[0] === '--sha256') {
    const [, expected, file] = argv
    if (!expected || !file) return { code: 2, message: PASSWORD_CHECK_USAGE }
    return fileMatchesSha256(file, expected)
      ? { code: 0, message: '' }
      : { code: 1, message: 'The file does not match the expected checksum.' }
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
