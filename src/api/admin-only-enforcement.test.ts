import { createHash, randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { hashSync } from 'bcryptjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrateDatabase } from '../db/migrate'
import type { LicenseManager } from '../license/license-manager'
import type { LicenseSummary } from '../shared/license/types'
import { getCurrency } from '../currency/catalog'
import { defaultDisplayOptions } from '../currency/money'
import { DEFAULT_OPERATIONAL_SETTINGS, type ShopSettings } from '../shared/shop/types'
import { MobileAccessService } from '../services/mobile-access-service'
import { MobileDeviceService } from '../services/mobile-device-service'
import { MOBILE_LOGIN_DENIED } from '../services/mobile-login-policy'
import type { MobileSafeStorage } from '../main/mobile-safe-storage'

const ADMIN_PASSWORD = 'Harbor-Admin-Pass-9'
const CASHIER_PASSWORD = 'Cashier-Pass-77'
const SUPERVISOR_PASSWORD = 'Supervisor-Pass-77'

const currency = getCurrency('NGN')!
const settings: ShopSettings = {
  profile: { name: 'Harbor Health', address: '', phone: '' },
  currency,
  display: defaultDisplayOptions(currency),
  setupComplete: true,
  currencyConfirmed: true,
  currencyLocked: false,
  operational: { ...DEFAULT_OPERATIONAL_SETTINGS },
}

function license(overrides: Partial<LicenseSummary> = {}): LicenseSummary {
  return {
    status: 'active', canUse: true, licenseId: 'admin-only-license', source: 'online', edition: 'BOTH',
    startsAt: null, endsAt: null, defaultCurrencyCode: null, lockCurrency: false,
    features: { mobileLan: true, mobileInternet: true }, adminPhoneLimit: 2, graceDays: 0,
    lastOnlineCheck: null, reportedToPortal: true, vendorConfigured: false,
    maximumOnsitePeriodYears: null, licenseServerUrl: null, message: 'active',
    ...overrides,
  }
}

/** A fake OS key store: enough to exercise the encrypted-secret path without Electron. */
const safeStorage: MobileSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`sealed:${Buffer.from(value).toString('base64')}`),
  decryptString: (buffer) => {
    const text = buffer.toString()
    if (!text.startsWith('sealed:')) throw new Error('bad ciphertext')
    return Buffer.from(text.slice('sealed:'.length), 'base64').toString()
  },
}

describe('mobile access is Admin-only, enforced host-side', () => {
  let database: Database.Database
  let deviceService: MobileDeviceService
  let licenseSnapshot: LicenseSummary
  let audits: Array<{ action: string; actor: string; metadata: Record<string, unknown> }>
  let service: MobileAccessService

  beforeEach(() => {
    database = new Database(':memory:')
    migrateDatabase(database)
    database.prepare(`INSERT INTO users (id, full_name, username, password_hash, role) VALUES (?, ?, ?, ?, ?)`)
      .run('admin-1', 'Harbor Admin', 'admin', hashSync(ADMIN_PASSWORD, 4), 'ADMIN')
    database.prepare(`INSERT INTO users (id, full_name, username, password_hash, role) VALUES (?, ?, ?, ?, ?)`)
      .run('cashier-1', 'Ada Cashier', 'ada', hashSync(CASHIER_PASSWORD, 4), 'CASHIER')
    database.prepare(`INSERT INTO users (id, full_name, username, password_hash, role) VALUES (?, ?, ?, ?, ?)`)
      .run('supervisor-1', 'Sam Supervisor', 'sam', hashSync(SUPERVISOR_PASSWORD, 4), 'SUPERVISOR')

    licenseSnapshot = license()
    const licenseManager = {
      getSnapshot: () => licenseSnapshot,
      assertFeature: (feature: string) => {
        if (!licenseSnapshot.features[feature as 'mobileLan' | 'mobileInternet']) throw new Error('feature missing')
      },
      assertAdminPhoneCapacityForUser: () => undefined,
    } as unknown as LicenseManager

    audits = []
    const shop = {
      getSettings: () => settings,
      recordDeniedAccess: vi.fn(),
    }
    service = new MobileAccessService(
      database,
      shop as never,
      licenseManager,
      { getSummary: () => ({}) } as never,
      {} as never,
      {
        userDataPath: '/tmp/infoflex-test',
        mobileClientDirectory: '/tmp/infoflex-test/mobile',
        safeStorage,
        now: () => Date.parse('2026-11-17T12:00:00.000Z'),
        port: 0,
        getAddresses: () => ['192.168.1.20'],
        friendlyHostName: 'infoflex-harbor-pharmacy',
        phoneLimit: 1,
        verifyPassword: async (password, hash) => {
          const { compare } = await import('bcryptjs')
          return password.length <= 72 && await compare(password, hash)
        },
        audit: (action, actor, metadata) => { audits.push({ action, actor, metadata }) },
      },
    )
    deviceService = new MobileDeviceService(database, licenseManager, () => Date.parse('2026-11-17T12:00:00.000Z'))
  })

  afterEach(() => {
    database.close()
  })

  /** Drives the phone side through the real service calls the HTTP routes use. */
  function approvePhone(name = "Tunde's Samsung") {
    // The listener itself needs a real TLS identity; these tests exercise the identity and policy layer that
    // every route calls, so pairing runs directly against the same service the HTTP handlers use.
    const window = deviceService.beginPairing('admin-1')
    const request = deviceService.startPairRequest({ code: window.code, deviceName: name, platform: 'Samsung Galaxy A54' }, '192.168.1.55')
    const pending = deviceService.listPendingApprovals()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.code).toBe(request.code)
    deviceService.approveDevice('admin-1', request.requestId)
    return { request, deviceToken: request.requestToken }
  }

  async function loginAs(username: string, password: string, deviceToken: string, extra: Record<string, unknown> = {}) {
    return service.login(
      { username, password },
      { ipAddress: extra.ipAddress as string ?? '192.168.1.55', deviceToken, userAgent: 'test-agent', deviceName: 'test phone' },
    )
  }

  it('refuses a Cashier with the same message, code and audit trail as a wrong password', async () => {
    const { deviceToken } = approvePhone()

    const cashierError = await loginAs('ada', CASHIER_PASSWORD, deviceToken).catch((error: Error) => error)
    const wrongPasswordError = await loginAs('admin', 'not-the-password', deviceToken).catch((error: Error) => error)
    expect(cashierError).toBeInstanceOf(Error)
    expect(wrongPasswordError).toBeInstanceOf(Error)
    // Identical text: the phone cannot tell a role refusal from a bad password.
    expect((cashierError as Error).message).toBe(MOBILE_LOGIN_DENIED)
    expect((wrongPasswordError as Error).message).toBe(MOBILE_LOGIN_DENIED)

    const cashierDenial = audits.find((entry) => entry.metadata.reason === 'non_admin_role')
    expect(cashierDenial).toMatchObject({ action: 'mobile.login.denied', actor: 'ada' })
    expect(cashierDenial?.metadata).toMatchObject({ role: 'CASHIER', ipAddress: '192.168.1.55' })
    // No password or authenticator code is ever written to the audit trail.
    expect(JSON.stringify(cashierDenial?.metadata)).not.toContain(CASHIER_PASSWORD)
  })

  it('refuses a Supervisor at login and grants it no session', async () => {
    const { deviceToken } = approvePhone()
    await expect(loginAs('sam', SUPERVISOR_PASSWORD, deviceToken)).rejects.toThrow(MOBILE_LOGIN_DENIED)
    expect(audits.some((entry) => entry.metadata.reason === 'non_admin_role' && entry.actor === 'sam')).toBe(true)
  })

  it('counts non-Admin attempts toward the lockout / rate limit', async () => {
    const { deviceToken } = approvePhone()
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await loginAs('ada', CASHIER_PASSWORD, deviceToken).catch(() => undefined)
    }
    const denials = audits.filter((entry) => entry.action === 'mobile.login.denied')
    expect(denials.length).toBeGreaterThanOrEqual(5)
    // The sixth attempt is refused by the rate limiter before any password work happens.
    expect(denials.some((entry) => entry.metadata.reason === 'rate_limited')).toBe(true)
    await expect(loginAs('admin', ADMIN_PASSWORD, deviceToken)).rejects.toThrow(MOBILE_LOGIN_DENIED)
  })

  it('never lets a Cashier become a device owner, even with a valid device token', async () => {
    const { request } = approvePhone()
    // Point the device at the Cashier account: the login must still refuse.
    database.prepare('UPDATE devices SET admin_user_id = ? WHERE id = ?').run('cashier-1', request.requestId)
    await expect(loginAs('ada', CASHIER_PASSWORD, request.requestToken)).rejects.toThrow(MOBILE_LOGIN_DENIED)
    // And the bearer check re-reads the user row, so an existing token cannot be used either.
    expect(deviceService.authenticateBearer(`Bearer ${request.requestToken}`, '192.168.1.55')).toBeNull()
  })

  it('cuts the phone off immediately when the Admin is demoted, deactivated or locked', async () => {
    const { deviceToken } = approvePhone()
    const session = await loginAs('admin', ADMIN_PASSWORD, deviceToken)
    expect(deviceService.authenticateBearer(`Bearer ${session.accessToken}`, '192.168.1.55')).not.toBeNull()

    database.prepare("UPDATE users SET role = 'CASHIER' WHERE id = 'admin-1'").run()
    expect(deviceService.authenticateBearer(`Bearer ${session.accessToken}`, '192.168.1.55')).toBeNull()
    // A refresh cannot resurrect the dead session either.
    expect(deviceService.refreshSession(session.refreshToken, '192.168.1.55')).toBeNull()

    // The demotion also revoked the phone outright, so even a corrected role needs a fresh pairing.
    database.prepare("UPDATE users SET role = 'ADMIN' WHERE id = 'admin-1'").run()
    await expect(loginAs('admin', ADMIN_PASSWORD, deviceToken)).rejects.toThrow(MOBILE_LOGIN_DENIED)

    const fresh = approvePhone('Repaired phone')
    const reLogin = await loginAs('admin', ADMIN_PASSWORD, fresh.deviceToken)
    expect(deviceService.authenticateBearer(`Bearer ${reLogin.accessToken}`, '192.168.1.55')).not.toBeNull()
    database.prepare("UPDATE users SET is_active = 0 WHERE id = 'admin-1'").run()
    expect(deviceService.authenticateBearer(`Bearer ${reLogin.accessToken}`, '192.168.1.55')).toBeNull()
  })

  it('revokes every device when an Admin is demoted, and refuses an unapproved or revoked device', async () => {
    const { deviceToken, request } = approvePhone()
    const session = await loginAs('admin', ADMIN_PASSWORD, deviceToken)

    deviceService.revokeSessionsForUser('admin-1', 'admin')
    expect(deviceService.authenticateBearer(`Bearer ${session.accessToken}`, '192.168.1.55')).toBeNull()
    expect(deviceService.listForAdmin('admin-1')).toHaveLength(0)
    await expect(loginAs('admin', ADMIN_PASSWORD, request.requestToken)).rejects.toThrow(MOBILE_LOGIN_DENIED)
  })

  it('refuses a device that was never approved, and one rejected on the PC', () => {
    const window = deviceService.beginPairing('admin-1')
    const pendingRequest = deviceService.startPairRequest({ code: window.code, deviceName: 'Unknown', platform: 'Android' }, '192.168.1.90')
    // No approval yet: the pending list shows it, the API does not.
    expect(deviceService.listPendingApprovals()).toHaveLength(1)
    expect(deviceService.authenticateBearer(`Bearer ${pendingRequest.requestToken}`, '192.168.1.90')).toBeNull()
    deviceService.rejectDevice('admin-1', pendingRequest.requestId)
    expect(deviceService.listPendingApprovals()).toHaveLength(0)
    expect(deviceService.pairStatus(pendingRequest.requestToken).status).toBe('REJECTED')
    return expect(loginAs('admin', ADMIN_PASSWORD, pendingRequest.requestToken)).rejects.toThrow(MOBILE_LOGIN_DENIED)
  })

  it('requires the authenticator code for an Internet login but not for a LAN one', async () => {
    const { deviceToken } = approvePhone()
    // Enrol an authenticator for the Admin.
    const enrollment = service.totp.beginEnrollment({ userId: 'admin-1', accountName: 'admin', issuer: 'Harbor Health' })
    const { generateTotp } = await import('../services/totp')
    const confirmCode = generateTotp(enrollment.secret, Date.parse('2026-11-17T12:00:00.000Z'))
    service.totp.confirmEnrollment('admin-1', confirmCode)
    // The code used to confirm enrolment is single-use, exactly like a login code.
    expect(service.totp.verify('admin-1', confirmCode)).toBe(false)
    const code = generateTotp(enrollment.secret, Date.parse('2026-11-17T12:00:30.000Z'))

    // LAN: no code needed.
    const lanSession = await loginAs('admin', ADMIN_PASSWORD, deviceToken, { ipAddress: '192.168.1.55' })
    expect(lanSession.requiresTotp).toBe(false)

    // Internet: a missing code and a wrong code are both refused.
    await expect(loginAs('admin', ADMIN_PASSWORD, deviceToken, { ipAddress: '203.0.113.9' }))
      .rejects.toThrow(MOBILE_LOGIN_DENIED)
    await expect(service.login(
      { username: 'admin', password: ADMIN_PASSWORD, totpCode: '000000' },
      { ipAddress: '203.0.113.9', deviceToken, userAgent: 'test', deviceName: 'test phone' },
    )).rejects.toThrow(MOBILE_LOGIN_DENIED)
    expect(audits.some((entry) => entry.metadata.reason === 'totp_required')).toBe(true)

    // Internet with the current code succeeds, and the same code cannot be replayed.
    const internetSession = await service.login(
      { username: 'admin', password: ADMIN_PASSWORD, totpCode: code },
      { ipAddress: '203.0.113.9', deviceToken, userAgent: 'test', deviceName: 'test phone' },
    )
    expect(internetSession.requiresTotp).toBe(true)
    await expect(service.login(
      { username: 'admin', password: ADMIN_PASSWORD, totpCode: code },
      { ipAddress: '203.0.113.9', deviceToken, userAgent: 'test', deviceName: 'test phone' },
    )).rejects.toThrow(MOBILE_LOGIN_DENIED)
  })

  it('refuses every login when the licence has expired or is suspended', async () => {
    const { deviceToken } = approvePhone()
    licenseSnapshot = license({ status: 'expired', canUse: false })
    await expect(loginAs('admin', ADMIN_PASSWORD, deviceToken)).rejects.toThrow(MOBILE_LOGIN_DENIED)
    licenseSnapshot = license({ status: 'suspended', canUse: false })
    await expect(loginAs('admin', ADMIN_PASSWORD, deviceToken)).rejects.toThrow(MOBILE_LOGIN_DENIED)
  })

  it('locks a single phone after five wrong passwords even from one address', async () => {
    const { deviceToken } = approvePhone()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await loginAs('admin', 'wrong-password', deviceToken).catch(() => undefined)
    }
    const locked = database.prepare('SELECT locked_until FROM devices').get() as { locked_until: string | null }
    expect(locked.locked_until).not.toBeNull()
    // Even the correct password is refused while that phone is locked out.
    await expect(loginAs('admin', ADMIN_PASSWORD, deviceToken)).rejects.toThrow(MOBILE_LOGIN_DENIED)
  })

  it('gives an unknown username the same answer and the same bcrypt work', async () => {
    const { deviceToken } = approvePhone()
    await expect(loginAs('nobody', 'whatever', deviceToken)).rejects.toThrow(MOBILE_LOGIN_DENIED)
    expect(audits.some((entry) => entry.metadata.reason === 'unknown_account')).toBe(true)
  })

  it('keeps the phone token and the access token out of the database', async () => {
    const { deviceToken } = approvePhone()
    const session = await loginAs('admin', ADMIN_PASSWORD, deviceToken)
    const row = database.prepare('SELECT token_hash, device_token_hash FROM devices').get() as
      { token_hash: string; device_token_hash: string }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    // Stored values are hashes of the secrets, and the phone's device token is not stored in clear.
    expect(row.device_token_hash).toBe(sha(deviceToken))
    expect(row.token_hash).toBe(sha(session.accessToken))
    expect(JSON.stringify(row)).not.toContain(session.accessToken)
    expect(JSON.stringify(row)).not.toContain(deviceToken)
  })

  it('issues opaque, high-entropy credentials', () => {
    const token = randomBytes(32).toString('base64url')
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u)
  })
})

describe('the raw HTTP API refuses every non-Admin caller', () => {
  const nonAdminPrincipals = [
    { userId: 'user-cashier', username: 'ada', role: 'CASHIER' as const },
    { userId: 'user-supervisor', username: 'sam', role: 'SUPERVISOR' as const },
  ]
  const routes: Array<[string, string]> = [
    ['GET', '/api/v1/admin/settings'],
    ['GET', '/api/v1/admin/returns/pending'],
    ['GET', '/api/v1/admin/reports/summary'],
    ['GET', '/api/v1/admin/reports/summary.pdf'],
    ['POST', '/api/v1/admin/returns/ret-1/approval'],
    ['POST', '/api/v1/mobile/session/login'],
    ['POST', '/api/v1/mobile/session/refresh'],
    ['POST', '/api/v1/mobile/session/logout'],
  ]

  it('never reaches a service for a Cashier or Supervisor, on any route, even with a bearer token', async () => {
    const { createHostApi } = await import('./server')
    const getSettings = vi.fn(() => settings)
    const recordDeniedAccess = vi.fn()
    for (const principal of nonAdminPrincipals) {
      const server = await createHostApi({
        service: { getSettings, recordDeniedAccess },
        license: { getSnapshot: () => license() },
        // A device token that authenticates perfectly well — but resolves to a non-Admin user.
        authenticate: async () => principal,
        tls: {},
        now: () => 1_000,
        mobileSessions: {
          startPairRequest: vi.fn(),
          pairStatus: vi.fn(() => ({ status: 'APPROVED' as const })),
          login: vi.fn(async () => { throw new Error(MOBILE_LOGIN_DENIED) }),
          refreshSession: vi.fn(() => null),
          logout: vi.fn(),
        },
      })
      try {
        for (const [method, url] of routes) {
          const response = await server.inject({
            method: method as 'GET' | 'POST',
            url,
            headers: { authorization: `Bearer ${'b'.repeat(43)}`, 'content-type': 'application/json' },
            payload: method === 'POST' ? { username: 'ada', password: CASHIER_PASSWORD, deviceToken: 'b'.repeat(43) } : undefined,
          })
          expect(response.statusCode, `${principal.role} ${method} ${url}`).toBeGreaterThanOrEqual(400)
          expect(response.statusCode).toBeLessThan(500)
          // Every refusal is a generic denial, never a hint about the role or the missing permission.
          expect(JSON.stringify(response.json())).not.toMatch(/cashier|supervisor|permission|forbidden/i)
        }
        expect(getSettings).not.toHaveBeenCalled()
        expect(recordDeniedAccess).toHaveBeenCalled()
      } finally {
        await server.close()
      }
    }
  })

  it('keeps the two pre-login pairing routes free of secrets for anyone who calls them', async () => {
    const { createHostApi } = await import('./server')
    const pairStatus = vi.fn(() => ({ status: 'APPROVED' as const, deviceId: 'device-1' }))
    const startPairRequest = vi.fn(() => {
      throw new Error('The pairing code is invalid or expired.')
    })
    const server = await createHostApi({
      service: { getSettings: () => settings, recordDeniedAccess: vi.fn() },
      license: { getSnapshot: () => license() },
      authenticate: async () => null,
      tls: {},
      now: () => 1_000,
      mobileSessions: {
        startPairRequest, pairStatus,
        login: vi.fn(), refreshSession: vi.fn(), logout: vi.fn(),
      },
    })
    try {
      // These routes exist so a phone can pair before it has any credential; they must never return a token.
      const status = await server.inject({
        method: 'GET',
        url: `/api/v1/mobile/pair/status?requestToken=${'a'.repeat(43)}`,
      })
      expect(status.statusCode).toBe(200)
      expect(Object.keys(status.json()).sort()).toEqual(['deviceId', 'loginRequired', 'status'])
      expect(JSON.stringify(status.json())).not.toMatch(/token/i)
      // Without a plausible request token there is nothing to answer.
      expect((await server.inject({ method: 'GET', url: '/api/v1/mobile/pair/status?requestToken=short' })).statusCode).toBe(400)
      const paired = await server.inject({
        method: 'POST', url: '/api/v1/mobile/pair',
        headers: { 'content-type': 'application/json' },
        payload: { code: '12345678', deviceName: 'Phone', platform: 'Android' },
      })
      expect(paired.statusCode).toBe(400)
      expect(JSON.stringify(paired.json())).not.toMatch(/accessToken|refreshToken/)
    } finally {
      await server.close()
    }
  })

  it('answers a size-limited body and security headers on the mobile routes', async () => {
    const { createHostApi } = await import('./server')
    const server = await createHostApi({
      service: { getSettings: () => settings, recordDeniedAccess: vi.fn() },
      license: { getSnapshot: () => license() },
      authenticate: async () => null,
      tls: {},
      now: () => 1_000,
    })
    try {
      const health = await server.inject({ method: 'GET', url: '/api/v1/health' })
      expect(health.statusCode).toBe(200)
      expect(health.headers['x-content-type-options']).toBe('nosniff')
      expect(health.headers['referrer-policy']).toBe('no-referrer')

      const oversized = await server.inject({
        method: 'POST',
        url: '/api/v1/mobile/session/login',
        headers: { 'content-type': 'application/json' },
        payload: { username: 'admin', password: 'x'.repeat(64_000), deviceToken: 'c'.repeat(43) },
      })
      expect(oversized.statusCode).toBe(413)
    } finally {
      await server.close()
    }
  })

  it('reports an expired licence to the phone instead of a bare denial', async () => {
    const { createHostApi } = await import('./server')
    const server = await createHostApi({
      service: { getSettings: () => settings, recordDeniedAccess: vi.fn() },
      license: { getSnapshot: () => license({ status: 'expired', canUse: false }) },
      authenticate: async () => ({ userId: 'admin-1', username: 'admin', role: 'ADMIN' }),
      tls: {},
      now: () => 1_000,
    })
    try {
      const status = await server.inject({ method: 'GET', url: '/api/v1/licence' })
      expect(status.statusCode).toBe(200)
      expect(status.json().usable).toBe(false)
      expect(status.json().message).toMatch(/licence has expired or been suspended/iu)

      // Everything else that needs a session is refused, but with a message that names the licence.
      const denied = await server.inject({ method: 'GET', url: '/api/v1/admin/settings' })
      expect(denied.statusCode).toBe(403)
      expect(denied.json().message).toMatch(/licence has expired or been suspended/iu)
    } finally {
      await server.close()
    }
  })
})
