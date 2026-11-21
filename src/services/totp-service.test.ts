import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrateDatabase } from '../db/migrate'
import type { MobileSafeStorage } from '../main/mobile-safe-storage'
import { generateTotp } from './totp'
import { TotpService, TotpUnavailableError } from './totp-service'

const NOW_MS = Date.parse('2026-11-17T12:00:00.000Z')

function safeStorage(available = true): MobileSafeStorage {
  return {
    isEncryptionAvailable: () => available,
    // A stand-in for DPAPI: reversible here, but never stored in clear by the service either way.
    encryptString: (value) => Buffer.from(`vault:${Buffer.from(value).toString('base64')}`),
    decryptString: (buffer) => {
      const text = buffer.toString()
      if (!text.startsWith('vault:')) throw new Error('Unable to decrypt')
      return Buffer.from(text.slice('vault:'.length), 'base64').toString()
    },
  }
}

function setup(available = true) {
  const database = new Database(':memory:')
  migrateDatabase(database)
  database.prepare(`INSERT INTO users (id, full_name, username, password_hash, role) VALUES (?, ?, ?, ?, ?)`)
    .run('admin-1', 'Harbor Admin', 'admin', 'hash', 'ADMIN')
  const service = new TotpService(database, safeStorage(available), () => NOW_MS)
  return { database, service }
}

describe('authenticator (TOTP) enrolment for the Admin phone login', () => {
  it('stores the secret encrypted, never in clear text', () => {
    const { database, service } = setup()
    const enrollment = service.beginEnrollment({ userId: 'admin-1', accountName: 'admin', issuer: 'Harbor Health' })
    const row = database.prepare('SELECT totp_secret_ciphertext, totp_confirmed_at FROM users WHERE id = ?')
      .get('admin-1') as { totp_secret_ciphertext: string; totp_confirmed_at: string | null }
    expect(row.totp_secret_ciphertext).not.toBe(enrollment.secret)
    expect(row.totp_secret_ciphertext).not.toContain(enrollment.secret)
    // The stored blob is the OS-sealed envelope, not the base32 secret.
    expect(Buffer.from(row.totp_secret_ciphertext, 'base64').toString()).toMatch(/^vault:/u)
    // Enrolment is not active until the Admin proves the app works.
    expect(row.totp_confirmed_at).toBeNull()
    expect(service.isEnrolled('admin-1')).toBe(false)
  })

  it('confirms with a real code and then requires it', () => {
    const { service } = setup()
    const enrollment = service.beginEnrollment({ userId: 'admin-1', accountName: 'admin', issuer: 'Harbor Health' })
    const code = generateTotp(enrollment.secret, NOW_MS)
    const status = service.confirmEnrollment('admin-1', code)
    expect(status.enrolled).toBe(true)
    expect(status.confirmedAt).toBe('2026-11-17T12:00:00.000Z')
    expect(service.isEnrolled('admin-1')).toBe(true)
  })

  it('refuses a wrong code at confirmation and stays unenrolled', () => {
    const { service } = setup()
    service.beginEnrollment({ userId: 'admin-1', accountName: 'admin', issuer: 'Harbor Health' })
    expect(() => service.confirmEnrollment('admin-1', '000000')).toThrow(/did not match/u)
    expect(service.isEnrolled('admin-1')).toBe(false)
  })

  it('accepts a code once and rejects a replay of the same code', () => {
    const { service } = setup()
    const enrollment = service.beginEnrollment({ userId: 'admin-1', accountName: 'admin', issuer: 'Harbor Health' })
    const confirmCode = generateTotp(enrollment.secret, NOW_MS)
    service.confirmEnrollment('admin-1', confirmCode)
    expect(service.verify('admin-1', confirmCode)).toBe(false)
    // The next step's code is accepted, because an authenticator rolls forward.
    expect(service.verify('admin-1', generateTotp(enrollment.secret, NOW_MS + 30_000))).toBe(true)
  })

  it('starts a fresh secret and clears confirmation when enrolment is repeated', () => {
    const { database, service } = setup()
    const first = service.beginEnrollment({ userId: 'admin-1', accountName: 'admin', issuer: 'Harbor Health' })
    service.confirmEnrollment('admin-1', generateTotp(first.secret, NOW_MS))
    expect(service.isEnrolled('admin-1')).toBe(true)

    const second = service.beginEnrollment({ userId: 'admin-1', accountName: 'admin', issuer: 'Harbor Health' })
    expect(second.secret).not.toBe(first.secret)
    // Re-enrolling drops the old confirmation so a half-finished set-up cannot lock the Admin out.
    expect(service.isEnrolled('admin-1')).toBe(false)
    const row = database.prepare('SELECT totp_last_step FROM users WHERE id = ?').get('admin-1') as { totp_last_step: number | null }
    expect(row.totp_last_step).toBeNull()
  })

  it('builds a scannable otpauth URI carrying the issuer and account', () => {
    const { service } = setup()
    const enrollment = service.beginEnrollment({ userId: 'admin-1', accountName: 'admin', issuer: 'Harbor Health' })
    expect(enrollment.uri.startsWith('otpauth://totp/')).toBe(true)
    expect(enrollment.uri).toContain(`secret=${enrollment.secret}`)
    expect(decodeURIComponent(enrollment.uri)).toContain('Harbor Health:admin')
    // The typeable form is grouped in fours for people who cannot scan.
    expect(enrollment.formattedSecret.replace(/\s/gu, '')).toBe(enrollment.secret)
    expect(enrollment.formattedSecret).toMatch(/^[A-Z2-7]{4}( [A-Z2-7]{4})*$/u)
  })

  it('refuses to enrol when the operating system cannot protect the secret', () => {
    const { service } = setup(false)
    expect(() => service.beginEnrollment({ userId: 'admin-1', accountName: 'admin', issuer: 'Harbor' }))
      .toThrow(TotpUnavailableError)
    expect(() => service.beginEnrollment({ userId: 'admin-1', accountName: 'admin', issuer: 'Harbor' }))
      .toThrow(/cannot store the authenticator secret securely/u)
  })

  it('turns the authenticator off and forgets the secret', () => {
    const { database, service } = setup()
    const enrollment = service.beginEnrollment({ userId: 'admin-1', accountName: 'admin', issuer: 'Harbor Health' })
    service.confirmEnrollment('admin-1', generateTotp(enrollment.secret, NOW_MS))
    service.disable('admin-1')
    expect(service.isEnrolled('admin-1')).toBe(false)
    expect(service.verify('admin-1', generateTotp(enrollment.secret, NOW_MS + 60_000))).toBe(false)
    const row = database.prepare('SELECT totp_secret_ciphertext FROM users WHERE id = ?').get('admin-1') as
      { totp_secret_ciphertext: string | null }
    expect(row.totp_secret_ciphertext).toBeNull()
  })

  it('fails closed when the stored secret cannot be decrypted', () => {
    const { database, service } = setup()
    const enrollment = service.beginEnrollment({ userId: 'admin-1', accountName: 'admin', issuer: 'Harbor Health' })
    service.confirmEnrollment('admin-1', generateTotp(enrollment.secret, NOW_MS))
    // Simulate a corrupted or foreign-OS blob.
    database.prepare('UPDATE users SET totp_secret_ciphertext = ? WHERE id = ?').run(Buffer.from('rubbish').toString('base64'), 'admin-1')
    expect(service.verify('admin-1', generateTotp(enrollment.secret, NOW_MS + 60_000))).toBe(false)
    expect(service.isEnrolled('admin-1')).toBe(true)
  })
})
