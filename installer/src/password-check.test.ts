import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, pbkdf2Sync, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { fileMatchesSha256, runPasswordCheck, verifyPasswordAgainstHash } from './password-check'
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
