import { compare as bcryptCompare, hash as bcryptHash } from 'bcryptjs'

/**
 * Re-entering the Admin password on the phone before a sensitive change (prices, another user's permission).
 *
 * This is deliberately *not* a login: it does not issue a session, it does not touch the failed-login counter
 * of the account, and it does not allow a non-Admin to escape the generic denial. It answers one question —
 * "is the person holding this already-signed-in phone still the Admin?" — because the real risk on a counter
 * phone is a cashier picking it up, not a remote password guess (which the login route already rate-limits).
 */
export interface AdminPasswordVerifier {
  /** Async because bcrypt at cost 12 takes ~300 ms; blocking the host's event loop for that is not acceptable. */
  verify(userId: string, password: string): Promise<boolean>
}

export interface PasswordHashLookup {
  /** Returns the stored bcrypt hash for a user, or null when that user no longer exists. */
  getPasswordHash(userId: string): string | null | Promise<string | null>
}

const BCRYPT_ROUNDS = 12

export class BcryptAdminPasswordVerifier implements AdminPasswordVerifier {
  /**
   * One dummy hash, computed once, so an unknown user is as slow as a real one and cannot be distinguished
   * by timing. bcrypt silently truncates after 72 bytes, so anything longer is compared as empty.
   */
  private readonly dummyHash = bcryptHash('infoflex-admin-reentry-placeholder', BCRYPT_ROUNDS)

  constructor(private readonly lookup: PasswordHashLookup) {}

  async verify(userId: string, password: string): Promise<boolean> {
    const stored = await this.lookup.getPasswordHash(userId)
    const hash = stored ?? await this.dummyHash
    const withinLimit = password.length <= 72 && new TextEncoder().encode(password).length <= 72
    return await bcryptCompare(withinLimit ? password : '', hash)
  }
}
