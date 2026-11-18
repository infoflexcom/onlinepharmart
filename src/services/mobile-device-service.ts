import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import type Database from 'better-sqlite3'
import { hashSync } from 'bcryptjs'
import type { AuthenticatedPrincipal } from './permissions'
import type {
  MobileLoginInput,
  MobileLoginResult,
  MobilePairInput,
  MobileSessionCredentials,
  PairedMobileDevice,
} from '../shared/mobile/types'
import type { LicenseManager } from '../license/license-manager'
import { rememberRateLimitState } from './rate-limit-state'
import { assessMobileEligibility, MOBILE_LOGIN_DENIED } from './mobile-login-policy'

const PAIRING_LIFETIME_MS = 5 * 60_000
const ACCESS_TOKEN_LIFETIME_MS = 15 * 60_000
const REFRESH_TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60_000
const IDLE_TIMEOUT_MS = 30 * 60_000
const FAILURE_WINDOW_MS = 60_000
const FAILURE_LIMIT = 5
const BLOCK_DURATION_MS = 60_000
/** Per-account lockout for the phone login, separate from the per-IP budget above. */
const ACCOUNT_FAILURE_LIMIT = 5
const ACCOUNT_LOCK_MS = 15 * 60_000


export interface PendingApproval {
  requestId: string
  deviceName: string
  platform: string
  code: string
  ipAddress: string | null
  requestedAt: string
  expiresAt: string
}

export interface PairStart {
  requestId: string
  requestToken: string
  deviceName: string
  platform: string
  /** The four-digit code the Admin compares with the pop-up on the PC. */
  code: string
  expiresAt: string
}

interface PendingPairing {
  adminUserId: string
  codeHash: Buffer
  expiresAt: number
}

interface FailureState {
  windowStartedAt: number
  count: number
  blockedUntil: number
}

interface RefreshRow {
  refresh_id: string
  issued_at: string
  refresh_expires_at: string
  revoked_at: string | null
  last_used_at: string | null
  user_id: string
  username: string
  role: string
  is_active: number
  locked_at: string | null
  device_id: string
  device_revoked: number
}

interface DeviceIdentity {
  id: string
  name: string
  admin_user_id: string
  approved_at: string | null
  locked_until: string | null
}

/**
 * SQLite-backed Admin phone identity:
 *
 * 1. `beginPairing` opens a five-minute window on the PC.
 * 2. `startPairRequest` turns a scanned code into a PENDING device plus a `requestToken` (held only by the
 *    phone). A pending device has no access token, so it can reach nothing but the pairing page.
 * 3. The Admin approves on the PC; `approve` mints the hashed device token and returns it once, to be
 *    handed to the phone on its next poll via the `requestToken`.
 * 4. `login` exchanges Admin username + password (+ authenticator code on the Internet) + device token for
 *    a short-lived access token and a rotating refresh token.
 *
 * Every step re-reads the user row, so demoting, deactivating or locking an Admin cuts the phone off on the
 * next request rather than at token expiry.
 */
export class MobileDeviceService {
  private pendingPairing: PendingPairing | null = null
  private readonly failuresByIp = new Map<string, FailureState>()
  /** A bcrypt hash of a random string, so an unknown username costs the same work as a wrong password. */
  private dummy: string | null = null
  private readonly approvalListeners = new Set<(pending: PendingApproval[]) => void>()

  constructor(
    private readonly database: Database.Database,
    private readonly license: LicenseManager,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = randomUUID,
  ) {}

  // ---------------------------------------------------------------- pairing window on the PC

  beginPairing(adminUserId: string): { code: string; expiresAt: string } {
    const admin = this.readEligibleAdmin(adminUserId)
    this.expireExpiredSessions(admin.id)
    this.license.assertFeature('mobileLan')
    this.license.assertAdminPhoneCapacityForUser(admin.id)
    const code = String(randomInt(0, 100_000_000)).padStart(8, '0')
    const expiresAt = this.now() + PAIRING_LIFETIME_MS
    this.pendingPairing = { adminUserId: admin.id, codeHash: hashPairingCode(code), expiresAt }
    return { code, expiresAt: new Date(expiresAt).toISOString() }
  }

  // ---------------------------------------------------------------- phone side

  /**
   * The phone submits the code it read from the QR/typed. This never returns credentials: it creates a
   * PENDING device and a request token so the phone can long-poll for the Admin's decision.
   */
  startPairRequest(input: MobilePairInput, ipAddress: string | null): PairStart {
    const ipKey = ipAddress ?? 'unknown'
    const now = this.now()
    this.assertNotRateLimited(ipKey, now)

    const code = typeof input?.code === 'string' ? input.code.trim() : ''
    const candidateHash = hashPairingCode(code)
    const pending = this.pendingPairing
    if (!/^\d{8}$/u.test(code) || !pending || now >= pending.expiresAt || !safeHashEqual(candidateHash, pending.codeHash)) {
      this.recordFailure(ipKey, now)
      throw new Error('The pairing code is invalid or expired.')
    }

    const name = cleanRequiredText(input?.deviceName, 'Device name', 80)
    const platform = cleanRequiredText(input?.platform, 'Device platform', 40)
    const admin = this.readEligibleAdmin(pending.adminUserId)
    const deviceId = this.newId()
    const requestToken = randomBytes(32).toString('base64url')
    /** The short code the Admin reads off the phone and matches in the desktop pop-up. */
    const approvalCode = String(randomInt(1000, 10_000))
    const requestedAt = new Date(now).toISOString()
    const expiresAt = new Date(now + PAIRING_LIFETIME_MS).toISOString()

    this.database.transaction(() => {
      this.readEligibleAdmin(admin.id)
      this.expireExpiredSessionsInTransaction(admin.id)
      this.license.assertFeature('mobileLan')
      this.license.assertAdminPhoneCapacityForUser(admin.id)
      this.database.prepare(`
        INSERT INTO devices (
          id, name, platform, token_hash, device_token_hash, request_token_hash, admin_user_id,
          approved_by, approved_at, last_seen, last_ip, first_ip, revoked, created_at, access_token_expires_at
        ) VALUES (?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, NULL, ?, ?, 0, ?, NULL)
      `).run(deviceId, name, platform, hashBearerToken(requestToken), admin.id, ipAddress, ipAddress, requestedAt)
      this.audit(admin.username, 'mobile.device.requested', {
        deviceId, deviceName: name, platform, ipAddress, approvalCode,
      }, requestedAt)
    }).immediate()

    // The window is single-use: consuming it here stops a second phone replaying the same code.
    this.pendingPairing = null
    this.failuresByIp.delete(ipKey)
    this.emitApprovals()
    return { requestId: deviceId, requestToken, deviceName: name, platform, code: approvalCode, expiresAt }
  }

  /**
   * Long-poll target for the phone while it waits for the Admin. The phone already holds its device token
   * (the opaque value it sent as `requestToken`); approval activates it server-side, so there is no secret
   * to re-transmit and a second poll is harmless.
   */
  pairStatus(requestToken: string): { status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED'; deviceId?: string } {
    if (!isOpaqueToken(requestToken)) return { status: 'EXPIRED' }
    const row = this.database.prepare(`
      SELECT id, revoked, device_token_hash, created_at FROM devices WHERE request_token_hash = ?
    `).get(hashBearerToken(requestToken)) as
      { id: string; revoked: number; device_token_hash: string | null; created_at: string } | undefined
    if (!row) return { status: 'EXPIRED' }
    if (row.revoked === 1) return { status: 'REJECTED' }
    if (row.device_token_hash) return { status: 'APPROVED', deviceId: row.id }
    if (Date.parse(row.created_at) + PAIRING_LIFETIME_MS * 6 < this.now()) return { status: 'EXPIRED' }
    return { status: 'PENDING' }
  }

  // ---------------------------------------------------------------- Admin side of the approval

  listPendingApprovals(): PendingApproval[] {
    const now = this.now()
    const rows = this.database.prepare(`
      SELECT id, name, platform, first_ip, created_at FROM devices
      WHERE revoked = 0 AND approved_at IS NULL AND created_at > ?
      ORDER BY created_at, id
    `).all(new Date(now - PAIRING_LIFETIME_MS).toISOString()) as Array<{
      id: string; name: string; platform: string; first_ip: string | null; created_at: string
    }>
    return rows.map((row) => ({
      requestId: row.id,
      deviceName: row.name,
      platform: row.platform,
      // The code the phone shows; taken from the request audit entry so it is not stored separately.
      code: this.readApprovalCode(row.id) ?? '',
      ipAddress: row.first_ip,
      requestedAt: row.created_at,
      expiresAt: new Date(Date.parse(row.created_at) + PAIRING_LIFETIME_MS * 6).toISOString(),
    }))
  }

  onApprovalNeeded(listener: (pending: PendingApproval[]) => void): () => void {
    this.approvalListeners.add(listener)
    return () => { this.approvalListeners.delete(listener) }
  }

  approveDevice(adminUserId: string, requestId: string): { deviceId: string; deviceName: string } {
    const admin = this.readEligibleAdmin(adminUserId)
    const id = cleanRequiredText(requestId, 'Pairing request', 120)
    let approved: { deviceId: string; deviceName: string }
    this.database.transaction(() => {
      const row = this.database.prepare(`
        SELECT id, name FROM devices
        WHERE id = ? AND admin_user_id = ? AND revoked = 0 AND approved_at IS NULL
          AND (device_token_hash IS NOT NULL OR request_token_hash IS NOT NULL)
      `).get(id, admin.id) as { id: string; name: string } | undefined
      if (!row) throw new Error('This pairing request no longer exists or was already handled.')
      this.license.assertFeature('mobileLan')
      this.license.assertAdminPhoneCapacityForUser(admin.id)
      const timestamp = new Date(this.now()).toISOString()
      // The phone's request token becomes its device token; the hash was stored at pairing time.
      this.database.prepare(`
        UPDATE devices SET approved_by = ?, approved_at = ?, device_token_hash = request_token_hash
        WHERE id = ? AND revoked = 0 AND approved_at IS NULL
      `).run(admin.id, timestamp, id)
      this.audit(admin.username, 'mobile.device.approved', { deviceId: id, deviceName: row.name }, timestamp)
      approved = { deviceId: id, deviceName: row.name }
    }).immediate()
    this.emitApprovals()
    return approved!
  }

  rejectDevice(adminUserId: string, requestId: string, reason = 'Rejected by the Admin'): void {
    const admin = this.readEligibleAdmin(adminUserId)
    const id = cleanRequiredText(requestId, 'Pairing request', 120)
    this.database.transaction(() => {
      const row = this.database.prepare(`
        SELECT id, name FROM devices
        WHERE id = ? AND admin_user_id = ? AND revoked = 0 AND (request_token_hash IS NOT NULL OR approved_at IS NOT NULL)
      `).get(id, admin.id) as { id: string; name: string } | undefined
      if (!row) throw new Error('This pairing request no longer exists or was already handled.')
      const timestamp = new Date(this.now()).toISOString()
      this.database.prepare('UPDATE devices SET revoked = 1 WHERE id = ? AND revoked = 0').run(id)
      this.database.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL').run(timestamp, id)
      this.audit(admin.username, 'mobile.device.rejected', { deviceId: id, deviceName: row.name, reason: reason.slice(0, 120) }, timestamp)
    }).immediate()
    this.emitApprovals()
  }

  // ---------------------------------------------------------------- phone login

  /**
   * The only way to obtain an access token. Any failure — unknown user, wrong password, Cashier or
   * Supervisor role, unapproved device, missing code — throws MOBILE_LOGIN_DENIED after the same work, and
   * the caller audits the attempt. The caller supplies the password verifier so bcrypt work is shared with
   * the desktop login path.
   */
  async login(input: {
    credentials: MobileLoginInput
    deviceToken: string
    deviceName: string
    ipAddress: string | null
    userAgent: string
    verifyPassword: (password: string, hash: string) => Promise<boolean>
    totp: { isEnrolled(userId: string): boolean; verify(userId: string, code: string): boolean }
    requireTotpOnLan: boolean
    isLocalNetwork: boolean
    audit: (action: string, actor: string, metadata: Record<string, unknown>) => void
  }): Promise<MobileLoginResult> {
    const ipKey = input.ipAddress ?? 'unknown'
    const now = this.now()
    const username = typeof input.credentials?.username === 'string' ? input.credentials.username.trim().slice(0, 120) : ''
    const password = typeof input.credentials?.password === 'string' ? input.credentials.password : ''
    const totpCode = typeof input.credentials?.totpCode === 'string' ? input.credentials.totpCode : ''
    function deny(reason: string, role: string | null, userId?: string | null): never {
      input.audit('mobile.login.denied', username || 'UNKNOWN', {
        reason, role, ipAddress: input.ipAddress, deviceName: input.deviceName.slice(0, 80),
        userAgent: input.userAgent.slice(0, 160), totpSupplied: totpCode.length > 0, userId: userId ?? null,
      })
      throw new Error(MOBILE_LOGIN_DENIED)
    }
    if (this.isRateLimited(ipKey, now)) deny('rate_limited', null)

    const device: DeviceIdentity | undefined = this.readDeviceByToken(input.deviceToken)
    if (!device || device.approved_at === null) {
      this.recordFailure(ipKey, now)
      deny('unapproved_device', null)
    }

    // A per-device lockout means a stolen phone cannot brute-force the password even from one address.
    if (device.locked_until && Date.parse(device.locked_until) > now) deny('device_locked', null, device.admin_user_id)

    const row = username
      ? this.database.prepare(`
          SELECT id, username, full_name, role, is_active, locked_at, password_hash,
            totp_secret_ciphertext, totp_confirmed_at
          FROM users WHERE lower(username) = lower(?)
        `).get(username) as (AccountRow | undefined)
      : undefined
    const eligibility = assessMobileEligibility(row ?? null)
    const hash = row?.password_hash ?? this.dummyHash()
    // Always run bcrypt so an unknown username and a wrong password cost the same time.
    const withinBcryptLimit = password.length <= 72 && Buffer.byteLength(password, 'utf8') <= 72
    const passwordMatches = await input.verifyPassword(withinBcryptLimit ? password : '', hash)
    if (!eligibility.eligible) {
      this.recordFailure(ipKey, now)
      if (row) this.recordDeviceFailure(device.id, now)
      deny(eligibility.reason, row?.role ?? null, row?.id ?? null)
    }
    if (!withinBcryptLimit || !passwordMatches) {
      this.recordFailure(ipKey, now)
      const failures = this.recordDeviceFailure(device.id, now)
      deny(failures >= ACCOUNT_FAILURE_LIMIT ? 'account_locked_after_failed_attempts' : 'invalid_password', row!.role, row!.id)
    }

    // Only an Admin can own a device, but a device could have been re-pointed; check explicitly.
    if (device.admin_user_id !== eligibility.account.id) {
      this.recordFailure(ipKey, now)
      deny('device_not_owned_by_account', row!.role, row!.id)
    }
    const totpEnrolled = input.totp.isEnrolled(eligibility.account.id)
    const totpRequired = totpEnrolled && (!input.isLocalNetwork || input.requireTotpOnLan)
    if (totpRequired && !totpCode.trim()) deny('totp_required', row!.role, row!.id)
    if (totpRequired && !input.totp.verify(eligibility.account.id, totpCode)) {
      this.recordFailure(ipKey, now)
      const failures = this.recordDeviceFailure(device.id, now)
      deny(failures >= ACCOUNT_FAILURE_LIMIT ? 'account_locked_after_failed_attempts' : 'invalid_totp', row!.role, row!.id)
    }

    const credentials = createCredentials(device.id, now)
    const timestamp = new Date(now).toISOString()
    this.database.transaction(() => {
      this.license.assertFeature(input.isLocalNetwork ? 'mobileLan' : 'mobileInternet')
      this.database.prepare('UPDATE devices SET token_hash = ?, access_token_expires_at = ?, last_seen = ?, last_ip = ?, login_failure_count = 0, locked_until = NULL WHERE id = ? AND revoked = 0')
        .run(hashBearerToken(credentials.accessToken), credentials.accessTokenExpiresAt, timestamp, input.ipAddress, device.id)
      this.database.prepare(`
        INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, device_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(this.newId(), eligibility.account.id, hashBearerToken(credentials.refreshToken), credentials.refreshTokenExpiresAt, device.id, timestamp)
      this.audit(eligibility.account.username, 'mobile.login.succeeded', {
        deviceId: device.id, deviceName: device.name, ipAddress: input.ipAddress, totpUsed: totpRequired,
        internet: !input.isLocalNetwork,
      }, timestamp)
    }).immediate()
    this.failuresByIp.delete(ipKey)
    return {
      ...credentials,
      user: { id: eligibility.account.id, username: eligibility.account.username, fullName: eligibility.account.full_name, role: 'ADMIN' },
      requiresTotp: totpRequired,
    }
  }

  // ---------------------------------------------------------------- bearer sessions

  authenticateBearer(authorization: string | undefined, ipAddress: string | null): AuthenticatedPrincipal | null {
    const token = bearerToken(authorization)
    if (!token) return null
    const tokenHash = hashBearerToken(token)
    const row = this.database.prepare(`
      SELECT u.id, u.username, u.role, u.is_active, u.locked_at, d.access_token_expires_at, d.approved_at
      FROM devices d JOIN users u ON u.id = d.admin_user_id
      WHERE d.token_hash = ? AND d.revoked = 0
    `).get(tokenHash) as {
      id: string; username: string; role: string; is_active: number; locked_at: string | null
      access_token_expires_at: string | null; approved_at: string | null
    } | undefined
    if (!row || row.role !== 'ADMIN' || row.is_active !== 1 || row.locked_at !== null || row.approved_at === null
      || !row.access_token_expires_at || Date.parse(row.access_token_expires_at) <= this.now()) return null
    this.database.prepare(`
      UPDATE devices SET last_seen = ?, last_ip = ? WHERE token_hash = ? AND revoked = 0
    `).run(new Date(this.now()).toISOString(), ipAddress, tokenHash)
    return { userId: row.id, username: row.username, role: 'ADMIN', isActive: true, isLocked: false }
  }

  /** Refresh credentials are opaque, single-use, hashed at rest, and rotated transactionally. */
  refreshSession(refreshToken: string, ipAddress: string | null): MobileSessionCredentials | null {
    if (!isOpaqueToken(refreshToken)) return null
    const tokenHash = hashBearerToken(refreshToken)
    const now = this.now()
    let credentials: MobileSessionCredentials | null = null

    this.database.transaction(() => {
      const row = this.database.prepare(`
        SELECT rt.id AS refresh_id, rt.expires_at AS refresh_expires_at, rt.revoked_at,
          rt.created_at AS issued_at, u.id AS user_id, u.username, u.role, u.is_active, u.locked_at,
          d.id AS device_id, d.revoked AS device_revoked, d.approved_at, d.last_seen
        FROM refresh_tokens rt
        JOIN devices d ON d.id = rt.device_id
        JOIN users u ON u.id = rt.user_id
        WHERE rt.token_hash = ?
      `).get(tokenHash) as (RefreshRow & { approved_at: string | null; last_seen: string | null }) | undefined
      if (!row) return

      if (row.revoked_at !== null) {
        // Reuse of a rotated refresh secret is treated as theft; revoke the complete device session.
        if (row.device_revoked === 0) this.revokeDeviceInTransaction(row.device_id, row.username, 'mobile.session.refresh_reuse_detected')
        return
      }
      if (Date.parse(row.refresh_expires_at) <= now) {
        this.revokeDeviceInTransaction(row.device_id, row.username, 'mobile.session.expired')
        return
      }
      // Idle auto-logout: a phone left unlocked on a counter cannot hold a session for ever.
      const lastSeen = row.last_seen ? Date.parse(row.last_seen) : Date.parse(row.issued_at)
      if (now - lastSeen > IDLE_TIMEOUT_MS + ACCESS_TOKEN_LIFETIME_MS) {
        this.revokeDeviceInTransaction(row.device_id, row.username, 'mobile.session.idle_timeout')
        return
      }
      if (row.device_revoked !== 0 || row.approved_at === null || row.role !== 'ADMIN' || row.is_active !== 1 || row.locked_at !== null) {
        if (row.device_revoked === 0) this.revokeDeviceInTransaction(row.device_id, row.username, 'mobile.session.account_invalidated')
        return
      }

      this.license.assertFeature('mobileLan')
      const refreshed = createCredentials(row.device_id, now)
      const timestamp = new Date(now).toISOString()
      const rotation = this.database.prepare(`
        UPDATE refresh_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL
      `).run(timestamp, row.refresh_id)
      if (rotation.changes !== 1) return
      this.database.prepare(`
        INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, device_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        this.newId(), row.user_id, hashBearerToken(refreshed.refreshToken),
        refreshed.refreshTokenExpiresAt, row.device_id, timestamp,
      )
      this.database.prepare(`
        UPDATE devices SET token_hash = ?, access_token_expires_at = ?, last_seen = ?, last_ip = ?
        WHERE id = ? AND revoked = 0
      `).run(hashBearerToken(refreshed.accessToken), refreshed.accessTokenExpiresAt, timestamp, ipAddress, row.device_id)
      this.audit(row.username, 'mobile.session.refreshed', { deviceId: row.device_id, ipAddress }, timestamp)
      credentials = refreshed
    }).immediate()

    return credentials
  }

  /** Logout revokes the entire paired device; repeating logout is intentionally harmless. */
  logoutBearer(authorization: string | undefined, actorName = 'MOBILE ADMIN'): void {
    const token = bearerToken(authorization)
    if (!token) return
    const tokenHash = hashBearerToken(token)
    const row = this.database.prepare(`
      SELECT d.id, u.username FROM devices d JOIN users u ON u.id = d.admin_user_id
      WHERE d.token_hash = ? AND d.revoked = 0
    `).get(tokenHash) as { id: string; username: string } | undefined
    if (!row) return
    this.database.transaction(() => {
      this.revokeDeviceInTransaction(row.id, actorName || row.username, 'mobile.device.signed_out')
    }).immediate()
  }

  readAdminStatus(adminUserId: string): { role: string; is_active: number; locked_at: string | null } | undefined {
    return this.database.prepare('SELECT role, is_active, locked_at FROM users WHERE id = ?').get(adminUserId) as
      { role: string; is_active: number; locked_at: string | null } | undefined
  }

  expireExpiredSessions(adminUserId?: string): void {
    this.database.transaction(() => this.expireExpiredSessionsInTransaction(adminUserId)).immediate()
  }

  listForAdmin(adminUserId: string): PairedMobileDevice[] {
    this.readEligibleAdmin(adminUserId)
    this.expireExpiredSessions(adminUserId)
    const nowIso = new Date(this.now()).toISOString()
    const rows = this.database.prepare(`
      SELECT d.id, d.name, d.platform, d.created_at, d.last_seen, d.last_ip, d.approved_at,
        d.access_token_expires_at, u.username AS owner_username
      FROM devices d JOIN users u ON u.id = d.admin_user_id
      WHERE d.admin_user_id = ? AND d.revoked = 0 AND d.approved_at IS NOT NULL
      ORDER BY COALESCE(d.last_seen, d.created_at) DESC, d.id
    `).all(adminUserId) as Array<{
      id: string; name: string; platform: string; created_at: string; last_seen: string | null
      last_ip: string | null; approved_at: string | null; access_token_expires_at: string | null; owner_username: string
    }>
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      platform: row.platform,
      createdAt: row.created_at,
      lastSeen: row.last_seen,
      lastIp: row.last_ip,
      ownerUsername: row.owner_username,
      approvedAt: row.approved_at,
      approvalStatus: 'APPROVED',
      connected: Boolean(row.access_token_expires_at && row.access_token_expires_at > nowIso),
    }))
  }

  countConnected(adminUserId?: string): number {
    const nowIso = new Date(this.now()).toISOString()
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM devices
      WHERE revoked = 0 AND approved_at IS NOT NULL AND access_token_expires_at > ?
        AND (? IS NULL OR admin_user_id = ?)
    `).get(nowIso, adminUserId ?? null, adminUserId ?? null) as { count: number }
    return row.count
  }

  renameDevice(adminUserId: string, deviceId: string, name: string): PairedMobileDevice[] {
    const admin = this.readEligibleAdmin(adminUserId)
    const id = cleanRequiredText(deviceId, 'Paired device', 120)
    const cleanName = cleanRequiredText(name, 'Phone name', 80)
    const result = this.database.prepare(`
      UPDATE devices SET name = ? WHERE id = ? AND admin_user_id = ? AND revoked = 0
    `).run(cleanName, id, admin.id)
    if (result.changes !== 1) throw new Error('This paired phone no longer exists or was already revoked.')
    this.audit(admin.username, 'mobile.device.renamed', { deviceId: id, name: cleanName }, new Date(this.now()).toISOString())
    return this.listForAdmin(admin.id)
  }

  revokeForAdmin(adminUserId: string, deviceId: string): void {
    const admin = this.readEligibleAdmin(adminUserId)
    const id = cleanRequiredText(deviceId, 'Paired device', 120)
    this.database.transaction(() => {
      const result = this.database.prepare(`
        UPDATE devices SET revoked = 1
        WHERE id = ? AND admin_user_id = ? AND revoked = 0
      `).run(id, admin.id)
      if (result.changes !== 1) throw new Error('This paired phone no longer exists or was already revoked.')
      this.database.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL')
        .run(new Date(this.now()).toISOString(), id)
      this.audit(admin.username, 'mobile.device.revoked', { deviceId: id }, new Date(this.now()).toISOString())
    }).immediate()
    this.emitApprovals()
  }

  /** "Revoke all" — the master kill switch and the per-device list both use this. */
  revokeAllForAdmin(adminUserId: string, reason = 'Revoked by the Admin'): number {
    const admin = this.readEligibleAdmin(adminUserId)
    let revoked = 0
    this.database.transaction(() => {
      const rows = this.database.prepare('SELECT id FROM devices WHERE revoked = 0').all() as Array<{ id: string }>
      const timestamp = new Date(this.now()).toISOString()
      for (const row of rows) {
        this.database.prepare('UPDATE devices SET revoked = 1 WHERE id = ? AND revoked = 0').run(row.id)
        this.database.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL')
          .run(timestamp, row.id)
      }
      revoked = rows.length
      this.audit(admin.username, 'mobile.device.revoked_all', { count: revoked, reason: reason.slice(0, 120) }, timestamp)
    }).immediate()
    this.emitApprovals()
    return revoked
  }

  /** Called after an Admin changes or resets a user account; it does not trust user-supplied identity claims. */
  revokeSessionsForUser(userId: string, actor: string): void {
    if (typeof userId !== 'string' || !userId.trim()) return
    const username = this.database.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string } | undefined
    if (!username) return
    this.database.transaction(() => {
      const rows = this.database.prepare('SELECT id FROM devices WHERE admin_user_id = ? AND revoked = 0')
        .all(userId) as Array<{ id: string }>
      const timestamp = new Date(this.now()).toISOString()
      for (const row of rows) {
        this.database.prepare('UPDATE devices SET revoked = 1 WHERE id = ? AND revoked = 0').run(row.id)
        this.database.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL')
          .run(timestamp, row.id)
        this.audit(actor || username.username, 'mobile.device.revoked_by_account_change', { deviceId: row.id, userId }, timestamp)
      }
    }).immediate()
    this.emitApprovals()
  }

  // ---------------------------------------------------------------- internals

  private dummyHash(): string {
    // A real hash of a random throwaway string: it never matches, but an unknown account still pays for a
    // full bcrypt comparison, so response time cannot reveal whether a username exists.
    this.dummy ??= hashSync(randomUUID(), 12)
    return this.dummy
  }

  private readDeviceByToken(deviceToken: unknown): DeviceIdentity | undefined {
    if (typeof deviceToken !== 'string' || !isOpaqueToken(deviceToken)) return undefined
    return this.database.prepare(`
      SELECT id, name, admin_user_id, approved_at, locked_until FROM devices
      WHERE device_token_hash = ? AND revoked = 0
    `).get(hashBearerToken(deviceToken)) as DeviceIdentity | undefined
  }

  private recordDeviceFailure(deviceId: string, now: number): number {
    const row = this.database.prepare('SELECT login_failure_count FROM devices WHERE id = ?').get(deviceId) as
      { login_failure_count: number } | undefined
    const failures = (row?.login_failure_count ?? 0) + 1
    const lockedUntil = failures >= ACCOUNT_FAILURE_LIMIT ? new Date(now + ACCOUNT_LOCK_MS).toISOString() : null
    this.database.prepare('UPDATE devices SET login_failure_count = ?, locked_until = ? WHERE id = ?')
      .run(failures, lockedUntil, deviceId)
    if (failures >= ACCOUNT_FAILURE_LIMIT) {
      this.audit('MOBILE DEVICE', 'mobile.login.device_locked', { deviceId, failures, lockedUntil }, new Date(now).toISOString())
    }
    return failures
  }

  private readApprovalCode(deviceId: string): string | null {
    const row = this.database.prepare(`
      SELECT metadata_json FROM audit_log
      WHERE action = 'mobile.device.requested' AND json_extract(metadata_json, '$.deviceId') = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(deviceId) as { metadata_json: string } | undefined
    if (!row) return null
    try {
      const parsed = JSON.parse(row.metadata_json) as { approvalCode?: unknown }
      return typeof parsed.approvalCode === 'string' ? parsed.approvalCode : null
    } catch {
      return null
    }
  }

  private emitApprovals(): void {
    if (this.approvalListeners.size === 0) return
    let pending: PendingApproval[] = []
    try {
      pending = this.listPendingApprovals()
    } catch {
      return
    }
    for (const listener of this.approvalListeners) {
      try {
        listener(pending)
      } catch {
        // A broken UI listener must never break pairing.
      }
    }
  }

  private expireExpiredSessionsInTransaction(adminUserId?: string): void {
    const now = this.now()
    const timestamp = new Date(now).toISOString()
    const rows = this.database.prepare(`
      SELECT d.id AS device_id, u.username, u.role, u.is_active, u.locked_at,
        EXISTS (
          SELECT 1 FROM refresh_tokens rt
          WHERE rt.device_id = d.id AND rt.revoked_at IS NULL AND rt.expires_at > ?
        ) AS has_live_refresh,
        -- An approved phone that has not signed in yet is still a valid paired phone: approval is the
        -- trusted state, and a session on top of it is what expires.
        NOT EXISTS (
          SELECT 1 FROM refresh_tokens rt2 WHERE rt2.device_id = d.id
        ) AS never_logged_in
      FROM devices d JOIN users u ON u.id = d.admin_user_id
      WHERE d.revoked = 0
        -- A device still waiting for approval has no session to expire; it ages out with its request.
        AND d.approved_at IS NOT NULL
        AND (? IS NULL OR d.admin_user_id = ?)
    `).all(timestamp, adminUserId ?? null, adminUserId ?? null) as Array<{
      device_id: string; username: string; role: string; is_active: number; locked_at: string | null
      has_live_refresh: number; never_logged_in: number
    }>
    for (const row of rows) {
      if (row.role === 'ADMIN' && row.is_active === 1 && row.locked_at === null
        && (row.has_live_refresh === 1 || row.never_logged_in === 1)) continue
      const action = row.role !== 'ADMIN' || row.is_active !== 1 || row.locked_at !== null
        ? 'mobile.session.account_invalidated'
        : 'mobile.session.expired'
      this.revokeDeviceInTransaction(row.device_id, row.username, action)
    }
    const retentionCutoff = new Date(now - 90 * 24 * 60 * 60_000).toISOString()
    this.database.prepare('DELETE FROM refresh_tokens WHERE revoked_at IS NOT NULL AND revoked_at < ?').run(retentionCutoff)
    // Abandoned pairing requests are revoked after a day so the pending list cannot grow without bound.
    const abandoned = new Date(now - 24 * 60 * 60_000).toISOString()
    const stale = this.database.prepare(`
      SELECT id FROM devices
      WHERE revoked = 0 AND approved_at IS NULL AND created_at < ?
        AND (? IS NULL OR admin_user_id = ?)
    `).all(abandoned, adminUserId ?? null, adminUserId ?? null) as Array<{ id: string }>
    for (const row of stale) {
      this.database.prepare('UPDATE devices SET revoked = 1 WHERE id = ? AND revoked = 0').run(row.id)
      this.audit('MOBILE DEVICE', 'mobile.device.request_expired', { deviceId: row.id }, timestamp)
    }
  }

  private readEligibleAdmin(adminUserId: string): { id: string; username: string } {
    if (typeof adminUserId !== 'string' || !adminUserId.trim()) throw new Error('A signed-in Admin account is required.')
    const row = this.database.prepare(`
      SELECT id, username, role, is_active, locked_at FROM users WHERE id = ?
    `).get(adminUserId) as {
      id: string; username: string; role: string; is_active: number; locked_at: string | null
    } | undefined
    if (!row || row.role !== 'ADMIN' || row.is_active !== 1 || row.locked_at !== null) {
      throw new Error('A current, unlocked Admin account is required for mobile pairing.')
    }
    return { id: row.id, username: row.username }
  }

  private isRateLimited(ipAddress: string, now: number): boolean {
    const failure = this.failuresByIp.get(ipAddress)
    return Boolean(failure?.blockedUntil && now < failure.blockedUntil)
  }

  private assertNotRateLimited(ipAddress: string, now: number): void {
    if (this.isRateLimited(ipAddress, now)) throw new Error('Pairing is temporarily blocked. Wait a minute and try again.')
  }

  private recordFailure(ipAddress: string, now: number): void {
    const previous = this.failuresByIp.get(ipAddress)
    const state = !previous || now - previous.windowStartedAt >= FAILURE_WINDOW_MS
      ? { windowStartedAt: now, count: 0, blockedUntil: 0 }
      : previous
    state.count += 1
    if (state.count >= FAILURE_LIMIT) state.blockedUntil = now + BLOCK_DURATION_MS
    rememberRateLimitState(this.failuresByIp, ipAddress, state, now, FAILURE_WINDOW_MS)
    this.audit('UNAUTHENTICATED', 'mobile.pair.failed', { ipAddress, reason: 'invalid_or_expired_code' }, new Date(now).toISOString())
  }

  private revokeDeviceInTransaction(deviceId: string, actor: string, action: string): void {
    const timestamp = new Date(this.now()).toISOString()
    this.database.prepare('UPDATE devices SET revoked = 1 WHERE id = ? AND revoked = 0').run(deviceId)
    this.database.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL')
      .run(timestamp, deviceId)
    this.audit(actor, action, { deviceId }, timestamp)
  }

  private audit(actor: string, action: string, metadata: Record<string, unknown>, createdAt: string): void {
    this.database.prepare(`
      INSERT INTO audit_log (id, actor, action, metadata_json, device_name, ip_address, created_at)
      VALUES (?, ?, ?, ?, 'Infoflex Mobile Access', ?, ?)
    `).run(this.newId(), actor, action, JSON.stringify(metadata), typeof metadata.ipAddress === 'string' ? metadata.ipAddress : null, createdAt)
  }
}

interface AccountRow {
  id: string
  username: string
  full_name: string
  role: string
  is_active: number
  locked_at: string | null
  password_hash: string
  totp_secret_ciphertext: string | null
  totp_confirmed_at: string | null
}

function createCredentials(deviceId: string, now: number): MobileSessionCredentials {
  return {
    deviceId,
    accessToken: randomBytes(32).toString('base64url'),
    refreshToken: randomBytes(32).toString('base64url'),
    accessTokenExpiresAt: new Date(now + ACCESS_TOKEN_LIFETIME_MS).toISOString(),
    refreshTokenExpiresAt: new Date(now + REFRESH_TOKEN_LIFETIME_MS).toISOString(),
    loginRequired: false,
  }
}

function bearerToken(authorization: string | undefined): string | null {
  if (typeof authorization !== 'string') return null
  const match = /^Bearer ([A-Za-z0-9_-]{40,100})$/u.exec(authorization)
  return match?.[1] ?? null
}

function isOpaqueToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{40,100}$/u.test(value)
}

function hashBearerToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function hashPairingCode(code: string): Buffer {
  return createHash('sha256').update(`infoflex-mobile-pairing\0${code}`).digest()
}

function safeHashEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right)
}

function cleanRequiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Enter a ${label.toLowerCase()}.`)
  const clean = value.trim().replace(/[\u0000-\u001f\u007f]/gu, '')
  if (!clean || clean.length > maxLength) throw new Error(`${label} must be 1–${maxLength} characters.`)
  return clean
}
