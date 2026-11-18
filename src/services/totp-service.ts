import type Database from 'better-sqlite3'
import type { MobileSafeStorage } from '../main/mobile-safe-storage'
import { buildTotpUri, createTotpSecret, verifyTotp } from './totp'

/** The authenticator secret is sealed with the OS key store; without one we refuse to enrol at all. */
export class TotpUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TotpUnavailableError'
  }
}

export interface TotpStatus {
  enrolled: boolean
  confirmedAt: string | null
  backupCodesRemaining?: number
}

/**
 * Owns the Admin's authenticator enrolment. The secret is never written in clear text: it is encrypted with
 * Electron safeStorage (DPAPI on Windows), stored in `users.totp_secret_ciphertext`, and decrypted only while
 * verifying a code. To stop a shoulder-surfed code being reused, the last accepted 30-second step is kept.
 */
export class TotpService {
  constructor(
    private readonly database: Database.Database,
    private readonly safeStorage: MobileSafeStorage,
    private readonly now: () => number = Date.now,
  ) {}

  status(userId: string): TotpStatus {
    const row = this.database.prepare('SELECT totp_confirmed_at FROM users WHERE id = ?').get(userId) as
      { totp_confirmed_at: string | null } | undefined
    return { enrolled: Boolean(row?.totp_confirmed_at), confirmedAt: row?.totp_confirmed_at ?? null }
  }

  isEnrolled(userId: string): boolean {
    const row = this.database.prepare('SELECT totp_secret_ciphertext, totp_confirmed_at FROM users WHERE id = ?')
      .get(userId) as { totp_secret_ciphertext: string | null; totp_confirmed_at: string | null } | undefined
    return Boolean(row?.totp_secret_ciphertext && row.totp_confirmed_at)
  }

  /** Creates a new, not-yet-confirmed secret and the otpauth URI the desktop renders as a QR code. */
  beginEnrollment(input: { userId: string; accountName: string; issuer: string }): {
    secret: string
    uri: string
    accountName: string
    issuer: string
    formattedSecret: string
  } {
    this.assertAvailable()
    const user = this.database.prepare('SELECT id, username FROM users WHERE id = ?').get(input.userId) as
      { id: string; username: string } | undefined
    if (!user) throw new Error('Sign in again before setting up the authenticator.')
    const secret = createTotpSecret()
    const sealed = this.safeStorage.encryptString(secret).toString('base64')
    // Confirmation is deliberately cleared: until the Admin proves the app produces a code, no login requires it.
    this.database.prepare('UPDATE users SET totp_secret_ciphertext = ?, totp_confirmed_at = NULL, totp_last_step = NULL WHERE id = ?')
      .run(sealed, user.id)
    const accountName = input.accountName || user.username
    const issuer = input.issuer || 'Infoflex'
    return {
      secret,
      uri: buildTotpUri({ secret, account: accountName, issuer }),
      accountName,
      issuer,
      formattedSecret: secret.replace(/(.{4})/gu, '$1 ').trim(),
    }
  }

  /** Proves the phone has the secret, then locks the requirement on for this account. */
  confirmEnrollment(userId: string, code: string): TotpStatus {
    const secret = this.readSecret(userId)
    if (!secret) throw new Error('Start the authenticator set-up again; no secret is waiting to be confirmed.')
    const verification = verifyTotp({ secret, code, atMs: this.now(), lastUsedStep: null })
    if (!verification.valid) throw new Error('That code did not match. Check the phone clock and enter the current six digits.')
    const timestamp = new Date(this.now()).toISOString()
    this.database.prepare('UPDATE users SET totp_confirmed_at = ?, totp_last_step = ?, totp_last_used_at = ? WHERE id = ?')
      .run(timestamp, verification.step, timestamp, userId)
    return { enrolled: true, confirmedAt: timestamp }
  }

  /** Used by the mobile login. Returns false for a malformed, expired or replayed code. */
  verify(userId: string, code: string): boolean {
    const secret = this.readSecret(userId)
    if (!secret) return false
    const row = this.database.prepare('SELECT totp_last_step FROM users WHERE id = ?').get(userId) as
      { totp_last_step: number | null } | undefined
    const verification = verifyTotp({ secret, code, atMs: this.now(), lastUsedStep: row?.totp_last_step ?? null })
    if (!verification.valid) return false
    this.database.prepare('UPDATE users SET totp_last_step = ?, totp_last_used_at = ? WHERE id = ?')
      .run(verification.step, new Date(this.now()).toISOString(), userId)
    return true
  }

  /** Turning the authenticator off is an Admin action and is audit-logged by the caller. */
  disable(userId: string): void {
    this.database.prepare('UPDATE users SET totp_secret_ciphertext = NULL, totp_confirmed_at = NULL, totp_last_step = NULL, totp_last_used_at = NULL WHERE id = ?')
      .run(userId)
  }

  private readSecret(userId: string): string | null {
    const row = this.database.prepare('SELECT totp_secret_ciphertext FROM users WHERE id = ?').get(userId) as
      { totp_secret_ciphertext: string | null } | undefined
    if (!row?.totp_secret_ciphertext) return null
    try {
      return this.safeStorage.decryptString(Buffer.from(row.totp_secret_ciphertext, 'base64'))
    } catch {
      return null
    }
  }

  private assertAvailable(): void {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new TotpUnavailableError('This computer cannot store the authenticator secret securely. Sign in with your Windows account and try again.')
    }
  }
}
