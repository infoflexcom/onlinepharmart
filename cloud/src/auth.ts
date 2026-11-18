import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import * as argon2 from 'argon2'
import type Database from 'better-sqlite3'
import { encodeBase32, verifyTotp } from '../../src/services/totp'

/**
 * Vendor sign-in. Email + strong password + TOTP, and nothing less: there is no password-only path, no
 * "remember this device", and no API key that skips the second factor. The portal can create licences and
 * suspend a shop's software, so an account takeover is a business-ending event, not an inconvenience.
 *
 * Deliberate choices:
 *   - Argon2id, not PBKDF2/bcrypt, because the brief names argon2 for the vendor portal and it is available
 *     as a prebuilt module for the Linux container this deploys into. The desktop's own passwords stay bcrypt
 *     (unchanged, and unrelated) — the two systems never share a password store.
 *   - Sessions are opaque random tokens whose SHA-256 is stored, so a database leak does not hand over live
 *     sessions. The CSRF token is separate and per-session.
 *   - TOTP codes are single-use per account (`totp_last_step`), so a shoulder-surfed code cannot be replayed.
 */
export interface VendorUser {
  id: string
  email: string
  display_name: string
  role: 'OWNER' | 'STAFF'
  password_hash: string
  password_updated_at: string
  totp_secret: string
  totp_confirmed_at: string | null
  totp_last_step: number | null
  failed_logins: number
  locked_until: string | null
  is_active: number
  created_at: string
  last_login_at: string | null
}

export interface SessionRow {
  id: string
  vendor_user_id: string
  token_hash: string
  csrf_token: string
  ip_address: string | null
  user_agent: string | null
  created_at: string
  last_seen_at: string
  expires_at: string
}

export interface AuthenticatedVendor {
  user: VendorUser
  session: SessionRow
}

export type LoginFailure =
  | { ok: false; reason: 'invalid'; message: string }
  | { ok: false; reason: 'totp_required'; message: string }
  | { ok: false; reason: 'locked'; message: string }

export type LoginSuccess = { ok: true; token: string; csrfToken: string; user: VendorUser; expiresAt: string }

const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const
const MAX_FAILED_LOGINS = 8
const LOCKOUT_MINUTES = 15
export const MIN_PASSWORD_LENGTH = 12

export class VendorAuth {
  constructor(
    private readonly database: Database.Database,
    private readonly options: { now?: () => number; sessionMinutes?: number } = {},
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private get sessionMinutes(): number {
    return this.options.sessionMinutes ?? 30
  }

  // ---------------------------------------------------------------- accounts

  async createUser(input: { email: string; displayName: string; password: string; role: 'OWNER' | 'STAFF' }, actor: string): Promise<VendorUser> {
    const email = requireEmail(input.email)
    const displayName = requireText(input.displayName, 'Name', 120)
    assertStrongPassword(input.password)
    const existing = this.database.prepare('SELECT id FROM vendor_users WHERE email = ? COLLATE NOCASE').get(email)
    if (existing) throw new Error('That email already has a vendor account.')
    const passwordHash = await argon2.hash(input.password, ARGON2_OPTIONS)
    const row: VendorUser = {
      id: randomUUID(),
      email,
      display_name: displayName,
      role: input.role,
      password_hash: passwordHash,
      password_updated_at: new Date(this.now()).toISOString(),
      // The secret exists before the account is usable; sign-in refuses until a code from it is confirmed.
      totp_secret: createTotpSecret(),
      totp_confirmed_at: null,
      totp_last_step: null,
      failed_logins: 0,
      locked_until: null,
      is_active: 1,
      created_at: new Date(this.now()).toISOString(),
      last_login_at: null,
    }
    this.database.prepare(`
      INSERT INTO vendor_users (id, email, display_name, role, password_hash, password_updated_at, totp_secret,
        totp_confirmed_at, totp_last_step, failed_logins, locked_until, is_active, created_at, last_login_at)
      VALUES (@id, @email, @display_name, @role, @password_hash, @password_updated_at, @totp_secret,
        @totp_confirmed_at, @totp_last_step, @failed_logins, @locked_until, @is_active, @created_at, @last_login_at)
    `).run(row)
    this.audit(actor, 'vendor_user.created', row.id, { email, role: row.role })
    return row
  }

  findUserByEmail(email: string): VendorUser | undefined {
    return this.database.prepare('SELECT * FROM vendor_users WHERE email = ? COLLATE NOCASE').get(email.trim()) as VendorUser | undefined
  }

  findUserById(id: string): VendorUser | undefined {
    return this.database.prepare('SELECT * FROM vendor_users WHERE id = ?').get(id) as VendorUser | undefined
  }

  getUser(id: string): VendorUser {
    const user = this.findUserById(id)
    if (!user) throw new Error('That vendor account no longer exists.')
    return user
  }

  countUsers(): number {
    return (this.database.prepare('SELECT COUNT(*) AS count FROM vendor_users').get() as { count: number }).count
  }

  listUsers(): Array<Omit<VendorUser, 'password_hash' | 'totp_secret'>> {
    return this.database.prepare(`
      SELECT id, email, display_name, role, password_updated_at, totp_confirmed_at, totp_last_step, failed_logins,
        locked_until, is_active, created_at, last_login_at FROM vendor_users ORDER BY created_at
    `).all() as Array<Omit<VendorUser, 'password_hash' | 'totp_secret'>>
  }

  async setPassword(userId: string, newPassword: string, actor: string): Promise<void> {
    assertStrongPassword(newPassword)
    const passwordHash = await argon2.hash(newPassword, ARGON2_OPTIONS)
    this.database.prepare('UPDATE vendor_users SET password_hash = ?, password_updated_at = ? WHERE id = ?')
      .run(passwordHash, new Date(this.now()).toISOString(), userId)
    // Changing a password ends every existing session for that account.
    this.database.prepare('DELETE FROM sessions WHERE vendor_user_id = ?').run(userId)
    this.audit(actor, 'vendor_user.password_changed', userId, {})
  }

  setActive(userId: string, active: boolean, actor: string): void {
    this.database.prepare('UPDATE vendor_users SET is_active = ? WHERE id = ?').run(active ? 1 : 0, userId)
    if (!active) this.database.prepare('DELETE FROM sessions WHERE vendor_user_id = ?').run(userId)
    this.audit(actor, active ? 'vendor_user.enabled' : 'vendor_user.disabled', userId, {})
  }

  /**
   * The first-time 2FA enrolment: confirm a code from the generated secret. Until this succeeds the account
   * exists but cannot sign in, which is what makes "create the first Owner account with 2FA" a real gate.
   */
  confirmTotpSetup(userId: string, code: string): void {
    const user = this.getUser(userId)
    const result = verifyTotp({ secret: user.totp_secret, code: normaliseCode(code), atMs: this.now() })
    if (!result.valid) throw new Error('That authentication code is not correct. Check your authenticator app and try again.')
    this.database.prepare('UPDATE vendor_users SET totp_confirmed_at = ?, totp_last_step = ? WHERE id = ?')
      .run(new Date(this.now()).toISOString(), result.step, userId)
    this.audit(user.email, 'vendor_user.totp_confirmed', userId, {})
  }

  /** Replacing a lost authenticator is an Owner action and is audited. */
  resetTotp(userId: string, actor: string): string {
    const secret = createTotpSecret()
    this.database.prepare('UPDATE vendor_users SET totp_secret = ?, totp_confirmed_at = NULL, totp_last_step = NULL WHERE id = ?')
      .run(secret, userId)
    this.database.prepare('DELETE FROM sessions WHERE vendor_user_id = ?').run(userId)
    this.audit(actor, 'vendor_user.totp_reset', userId, {})
    return secret
  }

  // ---------------------------------------------------------------- sign-in

  async login(input: { email: string; password: string; code: string; ipAddress: string | null; userAgent: string }): Promise<LoginFailure | LoginSuccess> {
    const email = typeof input.email === 'string' ? input.email.trim() : ''
    const user = this.findUserByEmail(email)
    // Always do the expensive hash, so a missing account and a wrong password take the same time. The stand-in
    // is generated on first use from random bytes rather than committed, so the source holds no hash at all.
    const hash = user?.password_hash ?? await dummyPasswordHash()
    let passwordOk = false
    try {
      passwordOk = await argon2.verify(hash, typeof input.password === 'string' ? input.password : '')
    } catch {
      passwordOk = false
    }
    if (!user || !passwordOk) {
      if (user) this.recordFailure(user)
      this.audit(email || '(blank)', 'vendor.login.failed', user?.id ?? null, { reason: 'credentials' }, input.ipAddress)
      return { ok: false, reason: 'invalid', message: 'That email or password is not correct.' }
    }
    if (user.locked_until && Date.parse(user.locked_until) > this.now()) {
      return { ok: false, reason: 'locked', message: `Too many attempts. Try again after ${new Date(user.locked_until).toLocaleTimeString()}.` }
    }
    if (user.is_active !== 1) {
      this.audit(user.email, 'vendor.login.failed', user.id, { reason: 'disabled' }, input.ipAddress)
      return { ok: false, reason: 'invalid', message: 'That email or password is not correct.' }
    }
    if (!user.totp_confirmed_at) {
      this.audit(user.email, 'vendor.login.failed', user.id, { reason: 'totp_not_enrolled' }, input.ipAddress)
      return { ok: false, reason: 'totp_required', message: 'This account has not finished setting up two-factor authentication.' }
    }
    const verification = verifyTotp({
      secret: user.totp_secret,
      code: normaliseCode(input.code),
      atMs: this.now(),
      lastUsedStep: user.totp_last_step,
    })
    if (!verification.valid) {
      this.recordFailure(user)
      this.audit(user.email, 'vendor.login.failed', user.id, { reason: verification.step === null ? 'totp' : 'totp_replayed' }, input.ipAddress)
      return { ok: false, reason: 'invalid', message: 'That authentication code is not correct.' }
    }

    const token = randomBytes(32).toString('base64url')
    const csrfToken = randomBytes(24).toString('base64url')
    const nowIso = new Date(this.now()).toISOString()
    const expiresAt = new Date(this.now() + this.sessionMinutes * 60_000).toISOString()
    this.database.transaction(() => {
      this.database.prepare('UPDATE vendor_users SET failed_logins = 0, locked_until = NULL, totp_last_step = ?, last_login_at = ? WHERE id = ?')
        .run(verification.step, nowIso, user.id)
      this.database.prepare(`
        INSERT INTO sessions (id, vendor_user_id, token_hash, csrf_token, ip_address, user_agent, created_at, last_seen_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), user.id, hashToken(token), csrfToken, input.ipAddress, input.userAgent.slice(0, 300), nowIso, nowIso, expiresAt)
      this.cleanupExpired()
    })()
    this.audit(user.email, 'vendor.login.succeeded', user.id, {}, input.ipAddress)
    return { ok: true, token, csrfToken, user: { ...user, totp_last_step: verification.step }, expiresAt }
  }

  /** Sliding expiry: an active session extends, an idle one dies at its original expiry. */
  authenticate(token: string | undefined): AuthenticatedVendor | null {
    if (!token) return null
    const session = this.database.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hashToken(token)) as SessionRow | undefined
    if (!session) return null
    if (Date.parse(session.expires_at) <= this.now()) {
      this.database.prepare('DELETE FROM sessions WHERE id = ?').run(session.id)
      return null
    }
    const user = this.findUserById(session.vendor_user_id)
    if (!user || user.is_active !== 1) return null
    // Touching the row keeps the session's own idle window meaningful without shortening a busy session.
    const nextExpiry = new Date(this.now() + this.sessionMinutes * 60_000).toISOString()
    this.database.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
      .run(new Date(this.now()).toISOString(), nextExpiry, session.id)
    return { user, session: { ...session, expires_at: nextExpiry } }
  }

  logout(token: string | undefined): void {
    if (!token) return
    this.database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token))
  }

  listSessions(userId: string): SessionRow[] {
    return this.database.prepare('SELECT * FROM sessions WHERE vendor_user_id = ? ORDER BY last_seen_at DESC').all(userId) as SessionRow[]
  }

  private recordFailure(user: VendorUser): void {
    const failures = user.failed_logins + 1
    const lockedUntil = failures >= MAX_FAILED_LOGINS ? new Date(this.now() + LOCKOUT_MINUTES * 60_000).toISOString() : null
    this.database.prepare('UPDATE vendor_users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(failures, lockedUntil, user.id)
  }

  private cleanupExpired(): void {
    this.database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date(this.now()).toISOString())
  }

  private audit(actor: string, action: string, target: string | null, detail: Record<string, unknown>, ipAddress: string | null = null): void {
    this.database.prepare(
      'INSERT INTO audit_log (actor, action, target, ip_address, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(actor, action, target, ipAddress, JSON.stringify(detail), new Date(this.now()).toISOString())
  }
}

/**
 * A throwaway argon2id hash used to keep a failed sign-in's timing constant when the e-mail is unknown. It is
 * minted once per process from random bytes: there is no committed hash in the source, and the value cannot
 * match any real password because nobody ever learns it.
 */
let dummyHash: Promise<string> | null = null
function dummyPasswordHash(): Promise<string> {
  dummyHash ??= argon2.hash(randomBytes(32).toString('base64url'), ARGON2_OPTIONS)
  return dummyHash
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Constant-time CSRF comparison; a length mismatch is already a rejection. */
export function csrfMatches(expected: string, provided: string | undefined): boolean {
  if (!provided) return false
  const left = Buffer.from(expected)
  const right = Buffer.from(provided)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function assertStrongPassword(password: unknown): void {
  if (typeof password !== 'string') throw new Error('Enter a password.')
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`Use at least ${MIN_PASSWORD_LENGTH} characters for the password.`)
  if (password.length > 200) throw new Error('The password is too long.')
  const classes = [/[a-z]/u, /[A-Z]/u, /\d/u, /[^A-Za-z0-9]/u].filter((pattern) => pattern.test(password)).length
  // Four classes is ideal; three is accepted so a long passphrase is not rejected for being all words.
  if (classes < 3 && password.length < 20) {
    throw new Error('Use a mix of upper case, lower case, numbers and symbols, or a passphrase of at least 20 characters.')
  }
  // A long password made of one repeated character is long but not strong; count the distinct characters.
  if (new Set(password.toLowerCase()).size < 5) throw new Error('That password repeats too few characters to be safe.')
  if (/^(password|letmein|qwerty|admin|welcome)/iu.test(password)) throw new Error('That password is too easy to guess.')
}

function requireEmail(value: unknown): string {
  if (typeof value !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/u.test(value.trim()) || value.length > 200) {
    throw new Error('Enter a valid email address.')
  }
  return value.trim()
}

function requireText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Enter the ${label.toLowerCase()}.`)
  return value.trim().slice(0, maxLength)
}

function normaliseCode(code: unknown): string {
  return typeof code === 'string' ? code.replace(/\s+/gu, '') : ''
}

/** RFC 4226's recommended 160-bit secret, base32 so every authenticator app accepts it. */
export function createTotpSecret(): string {
  return encodeBase32(randomBytes(20))
}
