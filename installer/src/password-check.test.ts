import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, pbkdf2Sync, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { fileMatchesSha256, interpretAuthenticode, runPasswordCheck, verifyPasswordAgainstHash } from './password-check'
import { INSTALLER_PASSWORD_HASH } from './installer-policy'

/**
 * The helper the installer's password page and download verification both depend on.
 *
 * Its whole job is to answer "does this match?" with an exit code, so the tests are about the exit codes as much
 * as the crypto: a helper that returns 0 for a wrong password, or that crashes and returns 0 because nothing
 * checked the status, would defeat the gate silently.
 */

const directory = mkdtempSync(join(tmpdir(), 'infoflex-installer-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

function hashOf(password: string): { salt: string; hash: string } {
  const salt = randomBytes(16)
  const hash = pbkdf2Sync(password, salt, 10_000, 32, 'sha256')
  return { salt: salt.toString('base64url'), hash: hash.toString('base64url') }
}

// The check the brief requires and the installer never performed: the checksum proves the bytes are the pinned ones,
// it says nothing about who signed them, and this file is then EXECUTED. Everything here fails closed.
describe('the Authenticode decision', () => {
  it('accepts a valid single-line publisher subject', () => {
    expect(interpretAuthenticode({ exitCode: 0, stdout: 'CN=Microsoft Corporation, O=Microsoft Corporation\r\n' }))
      .toBe('CN=Microsoft Corporation, O=Microsoft Corporation')
  })

  it('refuses an unsigned file, which prints nothing', () => {
    // Get-AuthenticodeSignature prints an empty string for an unsigned file. Treating that as "no publisher to
    // compare" and carrying on is the exact mistake this check exists to prevent.
    expect(interpretAuthenticode({ exitCode: 0, stdout: '' })).toBeNull()
    expect(interpretAuthenticode({ exitCode: 0, stdout: '   \r\n ' })).toBeNull()
  })

  it('refuses a non-zero exit, which is how PowerShell reports a failure to read the file', () => {
    expect(interpretAuthenticode({ exitCode: 1, stdout: 'CN=Microsoft Corporation' })).toBeNull()
  })

  it('refuses when the process never produced an exit code at all', () => {
    // spawnSync gives status === null on a timeout or a signal. That is not a verification.
    expect(interpretAuthenticode({ exitCode: null, stdout: 'CN=Microsoft Corporation' })).toBeNull()
  })

  it('refuses output that is not a single line', () => {
    // Two subjects, or a warning followed by a subject, is not something to substring-match: the answer is ambiguous
    // and the safe reading of an ambiguous security answer is no.
    expect(interpretAuthenticode({ exitCode: 0, stdout: 'CN=A\nCN=B' })).toBeNull()
  })
})

describe('the --authenticode argument handling', () => {
  it('reports bad arguments rather than pretending to verify', () => {
    expect(runPasswordCheck(['--authenticode']).code).toBe(2)
    expect(runPasswordCheck(['--authenticode', 'Microsoft Corporation']).code).toBe(2)
    expect(runPasswordCheck(['--authenticode', 'Microsoft Corporation', '/nonexistent/file.exe']).code).toBe(2)
  })

  it('mentions the check in its usage text, so a failure is diagnosable', () => {
    expect(runPasswordCheck(['--authenticode']).message).toContain('--authenticode')
  })
})

describe('the installer password checker', () => {
  it('matches the shipped hash with the shipped parameters', () => {
    // Derived from the shipped salt, so this proves the shipped hash and the checker agree — and it never
    // contains the password itself.
    expect(INSTALLER_PASSWORD_HASH.iterations).toBeGreaterThanOrEqual(310_000)
    const salt = Buffer.from(INSTALLER_PASSWORD_HASH.salt, 'base64url')
    expect(salt).toHaveLength(16)
  })

  it('accepts the right password and refuses everything else', () => {
    const { salt, hash } = hashOf('a-long-vendor-password')
    expect(verifyPasswordAgainstHash('a-long-vendor-password', salt, hash, 10_000)).toBe(true)
    expect(verifyPasswordAgainstHash('a-long-vendor-passworD', salt, hash, 10_000)).toBe(false)
    expect(verifyPasswordAgainstHash('', salt, hash, 10_000)).toBe(false)
    expect(verifyPasswordAgainstHash('a-long-vendor-password ', salt, hash, 10_000)).toBe(false)
  })

  it('refuses nonsense parameters instead of throwing', () => {
    const { salt, hash } = hashOf('x')
    for (const iterations of [0, -1, 1.5, 9_999_999, Number.NaN]) {
      expect(verifyPasswordAgainstHash('x', salt, hash, iterations), String(iterations)).toBe(false)
    }
    expect(verifyPasswordAgainstHash('x', '', hash, 10_000)).toBe(false)
    expect(verifyPasswordAgainstHash('x', salt, '', 10_000)).toBe(false)
  })

  it('answers with exit 0 only on a match, so NSIS cannot misread a failure', () => {
    const { salt, hash } = hashOf('correct-horse')
    expect(runPasswordCheck([salt, hash, '10000', 'correct-horse'])).toEqual({ code: 0, message: '' })
    expect(runPasswordCheck([salt, hash, '10000', 'wrong-horse']).code).toBe(1)
    expect(runPasswordCheck([salt, hash, 'not-a-number', 'x']).code).toBe(2)
    expect(runPasswordCheck([]).code).toBe(2)
    expect(runPasswordCheck(['onlyone']).code).toBe(2)
  })

  it('keeps a password containing spaces intact', () => {
    const { salt, hash } = hashOf('two words here')
    expect(runPasswordCheck([salt, hash, '10000', 'two', 'words', 'here']).code).toBe(0)
  })

  it('verifies a downloaded file against the pinned checksum', () => {
    const path = join(directory, 'component.bin')
    const bytes = Buffer.from('pretend this is the redistributable')
    writeFileSync(path, bytes)
    const digest = createHash('sha256').update(bytes).digest('hex')

    expect(runPasswordCheck(['--sha256', digest, path]).code).toBe(0)
    expect(runPasswordCheck(['--sha256', digest.toUpperCase(), path]).code).toBe(0)
    expect(runPasswordCheck(['--sha256', '0'.repeat(64), path]).code).toBe(1)
    // A file that is not there is a failure, not an exception.
    expect(runPasswordCheck(['--sha256', digest, join(directory, 'missing.bin')]).code).toBe(1)
    expect(fileMatchesSha256(join(directory, 'missing.bin'), digest)).toBe(false)
  })
})
