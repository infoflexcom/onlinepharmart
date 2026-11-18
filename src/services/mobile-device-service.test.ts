import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { hashSync } from 'bcryptjs'
import { describe, expect, it, vi } from 'vitest'
import { migrateDatabase } from '../db/migrate'
import type { LicenseManager } from '../license/license-manager'
import { MobileDeviceService } from './mobile-device-service'
import { MOBILE_LOGIN_DENIED } from './mobile-login-policy'

const PASSWORD = 'Harbor-Admin-Pass-9'

interface Fixture {
  database: Database.Database
  service: MobileDeviceService
  setNow(value: number): void
  capacityChecks: ReturnType<typeof vi.fn>
  audits: Array<{ action: string; actor: string; metadata: Record<string, unknown> }>
}

function fixture(phoneLimit = 2, mobileLan = true): Fixture {
  const database = new Database(':memory:')
  migrateDatabase(database)
  database.prepare(`
    INSERT INTO users (id, full_name, username, password_hash, role)
    VALUES ('admin-1', 'Harbor Admin', 'admin', ?, 'ADMIN')
  `).run(hashSync(PASSWORD, 4))
  let now = Date.parse('2026-11-17T12:00:00.000Z')
  const capacityChecks = vi.fn((adminUserId: string) => {
    if (adminUserId !== 'admin-1') throw new Error('wrong Admin')
    const count = (database.prepare('SELECT COUNT(*) AS count FROM devices WHERE admin_user_id = ? AND revoked = 0 AND approved_at IS NOT NULL')
      .get(adminUserId) as { count: number }).count
    if (count >= phoneLimit) throw new Error('The licensed Admin-phone limit has been reached.')
  })
  const license = {
    assertFeature: vi.fn((feature: string) => {
      if (feature !== 'mobileLan' || !mobileLan) throw new Error('LAN mobile access is not included.')
    }),
    assertAdminPhoneCapacityForUser: capacityChecks,
  } as unknown as LicenseManager
  const service = new MobileDeviceService(database, license, () => now)
  const audits: Fixture['audits'] = []
  return { database, service, setNow: (value) => { now = value }, capacityChecks, audits }
}

/** Phone-side pairing plus the Admin's approval on the PC; returns the token the phone holds. */
function pairAndApprove(service: MobileDeviceService, ip = '192.168.1.55') {
  const window = service.beginPairing('admin-1')
  const request = service.startPairRequest({ code: window.code, deviceName: 'Admin iPhone', platform: 'iPhone Safari' }, ip)
  const pending = service.listPendingApprovals()
  expect(pending).toHaveLength(1)
  expect(pending[0]!.code).toBe(request.code)
  expect(service.pairStatus(request.requestToken).status).toBe('PENDING')
  service.approveDevice('admin-1', request.requestId)
  expect(service.pairStatus(request.requestToken)).toEqual({ status: 'APPROVED', deviceId: request.requestId })
  return { request, deviceToken: request.requestToken }
}

function loginOptions(overrides: Partial<Parameters<MobileDeviceService['login']>[0]> = {}) {
  return {
    deviceName: 'Admin iPhone',
    userAgent: 'iPhone Safari',
    isLocalNetwork: true,
    requireTotpOnLan: false,
    verifyPassword: async (password: string, hash: string) => {
      const { compare } = await import('bcryptjs')
      return password.length <= 72 && await compare(password, hash)
    },
    totp: { isEnrolled: () => false, verify: () => false },
    ...overrides,
  }
}

async function login(service: MobileDeviceService, deviceToken: string, overrides: Record<string, unknown> = {}) {
  return service.login({
    ...loginOptions(overrides as Partial<Parameters<MobileDeviceService['login']>[0]>),
    credentials: { username: 'admin', password: PASSWORD, ...(overrides.credentials as object ?? {}) },
    deviceToken,
    ipAddress: '192.168.1.55',
    audit: vi.fn(),
  } as Parameters<MobileDeviceService['login']>[0])
}

describe('mobile Admin device pairing and sessions', () => {
  it('gives the phone nothing until the Admin approves it on the PC', async () => {
    const { database, service } = fixture(1)
    try {
      const window = service.beginPairing('admin-1')
      expect(window.code).toMatch(/^\d{8}$/u)
      expect(Date.parse(window.expiresAt)).toBe(Date.parse('2026-11-17T12:05:00.000Z'))
      const request = service.startPairRequest({ code: window.code, deviceName: 'Admin iPhone', platform: 'iPhone Safari' }, '192.168.1.55')
      expect(request.requestToken).toMatch(/^[A-Za-z0-9_-]{43}$/u)

      // A pending device has no token at all: it can neither call the API nor log in.
      const row = database.prepare('SELECT token_hash, device_token_hash, approved_at, revoked FROM devices WHERE id = ?')
        .get(request.requestId) as { token_hash: string | null; device_token_hash: string | null; approved_at: string | null; revoked: number }
      expect(row).toEqual({ token_hash: null, device_token_hash: null, approved_at: null, revoked: 0 })
      expect(service.authenticateBearer(`Bearer ${request.requestToken}`, '192.168.1.55')).toBeNull()
      await expect(login(service, request.requestToken)).rejects.toThrow(MOBILE_LOGIN_DENIED)
      expect(service.listForAdmin('admin-1')).toHaveLength(0)

      service.approveDevice('admin-1', request.requestId)
      expect(service.pairStatus(request.requestToken)).toEqual({ status: 'APPROVED', deviceId: request.requestId })
      expect(service.listPendingApprovals()).toHaveLength(0)

      // Approval is not a session: the device token alone still cannot call the API.
      expect(service.authenticateBearer(`Bearer ${request.requestToken}`, '192.168.1.55')).toBeNull()

      const session = await login(service, request.requestToken)
      expect(session.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/u)
      expect(session.refreshToken).not.toBe(session.accessToken)
      expect(session.user).toEqual({ id: 'admin-1', username: 'admin', fullName: 'Harbor Admin', role: 'ADMIN' })

      const device = database.prepare('SELECT token_hash, access_token_expires_at, last_ip, revoked FROM devices WHERE id = ?')
        .get(session.deviceId) as { token_hash: string; access_token_expires_at: string; last_ip: string; revoked: number }
      expect(device.token_hash).not.toBe(session.accessToken)
      expect(device.token_hash).toMatch(/^[a-f0-9]{64}$/u)
      expect(device.access_token_expires_at).toBe(session.accessTokenExpiresAt)
      expect(device.last_ip).toBe('192.168.1.55')
      expect(device.revoked).toBe(0)
      expect(service.authenticateBearer(`Bearer ${session.accessToken}`, '192.168.1.55')).toEqual({
        userId: 'admin-1', username: 'admin', role: 'ADMIN', isActive: true, isLocked: false,
      })
    } finally {
      database.close()
    }
  })

  it('consumes the pairing window once, so a second phone cannot replay the code', () => {
    const { database, service } = fixture(2)
    try {
      const window = service.beginPairing('admin-1')
      service.startPairRequest({ code: window.code, deviceName: 'First', platform: 'Android' }, '192.168.1.55')
      expect(() => service.startPairRequest({ code: window.code, deviceName: 'Second', platform: 'Android' }, '192.168.1.55'))
        .toThrow(/invalid or expired/u)
    } finally {
      database.close()
    }
  })

  it('reports a rejected device as rejected and never as approved', () => {
    const { database, service } = fixture(1)
    try {
      const window = service.beginPairing('admin-1')
      const request = service.startPairRequest({ code: window.code, deviceName: 'Unknown phone', platform: 'Android' }, '192.168.1.90')
      service.rejectDevice('admin-1', request.requestId)
      expect(service.pairStatus(request.requestToken)).toEqual({ status: 'REJECTED' })
      expect(service.listPendingApprovals()).toHaveLength(0)
      expect(database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'mobile.device.rejected'").get()).toEqual({ count: 1 })
    } finally {
      database.close()
    }
  })

  it('rotates refresh credentials, rejects replay by revoking the device, and releases its license slot', async () => {
    const { database, service } = fixture(1)
    try {
      const { deviceToken } = pairAndApprove(service)
      const initial = await login(service, deviceToken)
      const rotated = service.refreshSession(initial.refreshToken, '192.168.1.55')
      expect(rotated).not.toBeNull()
      expect(rotated?.accessToken).not.toBe(initial.accessToken)
      expect(rotated?.refreshToken).not.toBe(initial.refreshToken)
      expect(service.authenticateBearer(`Bearer ${initial.accessToken}`, '192.168.1.55')).toBeNull()
      expect(service.authenticateBearer(`Bearer ${rotated!.accessToken}`, '192.168.1.55')?.userId).toBe('admin-1')

      // Replaying the rotated refresh secret is treated as theft.
      expect(service.refreshSession(initial.refreshToken, '192.168.1.55')).toBeNull()
      expect(service.authenticateBearer(`Bearer ${rotated!.accessToken}`, '192.168.1.55')).toBeNull()
      expect(service.listForAdmin('admin-1')).toHaveLength(0)
      const state = database.prepare(`
        SELECT d.revoked, COUNT(rt.id) AS refresh_count, SUM(rt.revoked_at IS NULL) AS live_refresh
        FROM devices d LEFT JOIN refresh_tokens rt ON rt.device_id = d.id WHERE d.id = ? GROUP BY d.id
      `).get(initial.deviceId) as { revoked: number; refresh_count: number; live_refresh: number }
      expect(state).toEqual({ revoked: 1, refresh_count: 2, live_refresh: 0 })

      // The freed licence slot can be reused by a replacement phone.
      expect(() => pairAndApprove(service)).not.toThrow()
    } finally {
      database.close()
    }
  })

  it('expires stale refresh sessions and releases their licensed device slot', async () => {
    const { database, service, setNow } = fixture(1)
    try {
      const { deviceToken } = pairAndApprove(service)
      const initial = await login(service, deviceToken)
      setNow(Date.parse(initial.refreshTokenExpiresAt) + 1)
      expect(service.refreshSession(initial.refreshToken, '192.168.1.55')).toBeNull()
      expect(service.listForAdmin('admin-1')).toHaveLength(0)
      const replacement = pairAndApprove(service, '192.168.1.56')
      expect(replacement.request.requestId).not.toBe(initial.deviceId)
      expect(database.prepare('SELECT COUNT(*) AS count FROM devices WHERE revoked = 0').get()).toEqual({ count: 1 })
    } finally {
      database.close()
    }
  })

  it('ends the session after thirty minutes idle without a refresh', async () => {
    const { database, service, setNow } = fixture(1)
    try {
      const { deviceToken } = pairAndApprove(service)
      const initial = await login(service, deviceToken)
      setNow(Date.parse(initial.accessTokenExpiresAt) + 31 * 60_000)
      expect(service.refreshSession(initial.refreshToken, '192.168.1.55')).toBeNull()
      expect(database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'mobile.session.idle_timeout'").get())
        .toEqual({ count: 1 })
    } finally {
      database.close()
    }
  })

  it('blocks repeated invalid codes and refuses a pair if licensed capacity filled after code generation', () => {
    const first = fixture(1)
    try {
      const pending = first.service.beginPairing('admin-1')
      const wrongCode = String((Number(pending.code) + 1) % 100_000_000).padStart(8, '0')
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect(() => first.service.startPairRequest({ code: wrongCode, deviceName: 'Phone', platform: 'Browser' }, '192.168.1.21'))
          .toThrow(/invalid or expired/u)
      }
      expect(first.database.prepare(`
        SELECT actor, action, COUNT(*) AS count FROM audit_log
        WHERE action = 'mobile.pair.failed' GROUP BY actor, action
      `).get()).toEqual({ actor: 'UNAUTHENTICATED', action: 'mobile.pair.failed', count: 5 })
      expect(() => first.service.startPairRequest({ code: pending.code, deviceName: 'Phone', platform: 'Browser' }, '192.168.1.21'))
        .toThrow(/temporarily blocked/u)
      expect(() => first.service.startPairRequest({ code: pending.code, deviceName: 'Phone', platform: 'Browser' }, '192.168.1.22'))
        .not.toThrow()
      expect(first.database.prepare('SELECT COUNT(*) AS count FROM devices').get()).toEqual({ count: 1 })
    } finally {
      first.database.close()
    }

    const second = fixture(1)
    try {
      const pending = second.service.beginPairing('admin-1')
      second.database.prepare(`
        INSERT INTO devices (
          id, name, platform, token_hash, admin_user_id, created_at, access_token_expires_at, approved_at
        ) VALUES (?, 'Competitor', 'Browser', ?, 'admin-1', ?, ?, ?)
      `).run(
        'competing-device', randomBytes(32).toString('hex'), '2026-11-17T12:00:01.000Z',
        '2026-11-17T12:15:00.000Z', '2026-11-17T12:00:01.000Z',
      )
      second.database.prepare(`
        INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, device_id, created_at)
        VALUES ('competing-refresh', 'admin-1', ?, '2027-02-15T12:00:00.000Z', 'competing-device', '2026-11-17T12:00:01.000Z')
      `).run(randomBytes(32).toString('hex'))
      expect(() => second.service.startPairRequest({
        code: pending.code, deviceName: 'New phone', platform: 'Android',
      }, '192.168.1.55')).toThrow(/limit has been reached/u)
      expect(second.database.prepare('SELECT COUNT(*) AS count FROM devices').get()).toEqual({ count: 1 })
      expect(second.database.prepare('SELECT COUNT(*) AS count FROM refresh_tokens').get()).toEqual({ count: 1 })
    } finally {
      second.database.close()
    }
  })

  it('rejects pairing without the LAN entitlement or an active unlocked Admin', () => {
    const { database, service } = fixture(2, false)
    try {
      expect(() => service.beginPairing('admin-1')).toThrow(/not included/u)
      expect(() => service.beginPairing('missing-admin')).toThrow(/Admin account/u)
      database.prepare("UPDATE users SET is_active = 0 WHERE id = 'admin-1'").run()
      expect(() => service.beginPairing('admin-1')).toThrow(/unlocked Admin/u)
    } finally {
      database.close()
    }
  })

  it('revokes refresh credentials when the Admin revokes or signs out a paired device', async () => {
    const { database, service } = fixture(2)
    try {
      const firstPair = pairAndApprove(service)
      const first = await login(service, firstPair.deviceToken)
      service.logoutBearer(`Bearer ${first.accessToken}`)
      expect(service.authenticateBearer(`Bearer ${first.accessToken}`, null)).toBeNull()
      expect(service.listForAdmin('admin-1')).toHaveLength(0)
      expect(service.refreshSession(first.refreshToken, null)).toBeNull()

      const secondPair = pairAndApprove(service, '192.168.1.56')
      const second = await login(service, secondPair.deviceToken)
      service.revokeForAdmin('admin-1', second.deviceId)
      expect(service.authenticateBearer(`Bearer ${second.accessToken}`, '192.168.1.56')).toBeNull()
      expect(service.refreshSession(second.refreshToken, '192.168.1.56')).toBeNull()
      expect(database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action IN ('mobile.device.signed_out', 'mobile.device.revoked')").get())
        .toEqual({ count: 2 })
    } finally {
      database.close()
    }
  })

  it('renames, revokes all, and lists owner/status/connected without guessing', async () => {
    const { database, service } = fixture(2)
    try {
      const firstPair = pairAndApprove(service)
      await login(service, firstPair.deviceToken)
      const devices = service.listForAdmin('admin-1')
      expect(devices[0]).toMatchObject({
        ownerUsername: 'admin', approvalStatus: 'APPROVED', connected: true, lastIp: '192.168.1.55',
      })
      expect(service.countConnected('admin-1')).toBe(1)

      const renamed = service.renameDevice('admin-1', devices[0]!.id, "Tunde's Samsung")
      expect(renamed[0]!.name).toBe("Tunde's Samsung")

      const revoked = service.revokeAllForAdmin('admin-1')
      expect(revoked).toBe(1)
      expect(service.listForAdmin('admin-1')).toHaveLength(0)
      expect(service.countConnected('admin-1')).toBe(0)
    } finally {
      database.close()
    }
  })
})
