import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { getCurrency } from '../currency/catalog'
import { defaultDisplayOptions } from '../currency/money'
import type { MobileSessionCredentials } from '../shared/mobile/types'
import type { LicenseSummary } from '../shared/license/types'
import { DEFAULT_OPERATIONAL_SETTINGS, type ShopSettings } from '../shared/shop/types'
import { createHostApi } from './server'

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
const license: LicenseSummary = {
  status: 'active', canUse: true, licenseId: 'mobile-test', source: 'online', edition: 'BOTH',
  startsAt: null, endsAt: null, defaultCurrencyCode: null, lockCurrency: false,
  features: { mobileLan: true, mobileInternet: true }, adminPhoneLimit: 2, graceDays: 0,
  lastOnlineCheck: null, reportedToPortal: true, vendorConfigured: false,
  maximumOnsitePeriodYears: null, licenseServerUrl: null, message: 'active',
}
const credentials: MobileSessionCredentials = {
  deviceId: 'device-1',
  loginRequired: false,
  accessToken: 'a'.repeat(43),
  refreshToken: 'r'.repeat(43),
  accessTokenExpiresAt: '2026-11-17T12:15:00.000Z',
  refreshTokenExpiresAt: '2027-02-15T12:00:00.000Z',
}

describe('mobile pairing and refresh API', () => {
  it('only pairs over a licensed local-network address and returns no credentials until the Admin approves', async () => {
    const startPairRequest = vi.fn(() => ({
      requestId: 'device-1', requestToken: 't'.repeat(43), deviceName: 'Admin phone',
      platform: 'iPhone Safari', code: '4821', expiresAt: '2026-11-17T12:05:00.000Z',
    }))
    const recordDeniedAccess = vi.fn()
    const server = await createHostApi({
      service: { getSettings: () => settings, recordDeniedAccess },
      license: { getSnapshot: () => license },
      authenticate: async () => null,
      mobileSessions: {
        startPairRequest,
        pairStatus: () => ({ status: 'PENDING' as const }),
        login: async () => { throw new Error('not used here') },
        refreshSession: () => null,
        logout: vi.fn(),
      },
      localNetworkOnly: true,
      tls: {},
    })
    try {
      const paired = await server.inject({
        method: 'POST', url: '/api/v1/mobile/pair', remoteAddress: '192.168.1.41',
        payload: { code: '01234567', deviceName: 'Admin phone', platform: 'iPhone Safari' },
      })
      // 202 Accepted: the request exists but there is no session yet.
      expect(paired.statusCode).toBe(202)
      expect(paired.headers['cache-control']).toBe('no-store')
      expect(paired.json()).toEqual({
        requestId: 'device-1', requestToken: 't'.repeat(43), deviceName: 'Admin phone',
        platform: 'iPhone Safari', expiresAt: '2026-11-17T12:05:00.000Z', status: 'PENDING',
      })
      // No access or refresh token is ever returned by pairing.
      expect(JSON.stringify(paired.json())).not.toMatch(/accessToken|refreshToken/)
      expect(startPairRequest).toHaveBeenCalledWith(
        { code: '01234567', deviceName: 'Admin phone', platform: 'iPhone Safari' },
        { ipAddress: '192.168.1.41' },
      )

      const publicPair = await server.inject({
        method: 'POST', url: '/api/v1/mobile/pair', remoteAddress: '198.51.100.40',
        payload: { code: '01234567', deviceName: 'Remote', platform: 'Browser' },
      })
      expect(publicPair.statusCode).toBe(403)
      expect(startPairRequest).toHaveBeenCalledTimes(1)
      expect(recordDeniedAccess).toHaveBeenCalledWith(expect.objectContaining({ feature: 'mobileInternet', ipAddress: '198.51.100.40' }))

      const invalid = await server.inject({
        method: 'POST', url: '/api/v1/mobile/pair',
        payload: { code: '123', deviceName: 'Phone', platform: 'Browser' },
      })
      expect(invalid.statusCode).toBe(400)
    } finally {
      await server.close()
    }
  })

  it('rotates sessions on LAN and requires an Admin for sign-out', async () => {
    const refreshSession = vi.fn(() => credentials)
    const logout = vi.fn()
    const server = await createHostApi({
      service: { getSettings: () => settings, recordDeniedAccess: vi.fn() },
      license: { getSnapshot: () => license },
      authenticate: async () => null,
      mobileSessions: {
        startPairRequest: vi.fn(), pairStatus: vi.fn(),
        login: async () => { throw new Error('not used here') }, refreshSession, logout,
      },
      localNetworkOnly: true,
      tls: {},
    })
    try {
      const refreshed = await server.inject({
        method: 'POST', url: '/api/v1/mobile/session/refresh', remoteAddress: '10.1.2.3',
        payload: { refreshToken: 'r'.repeat(43) },
      })
      expect(refreshed.statusCode).toBe(200)
      expect(refreshed.headers['cache-control']).toBe('no-store')
      expect(refreshed.json()).toEqual(credentials)
      expect(refreshSession).toHaveBeenCalledWith('r'.repeat(43), '10.1.2.3')

      const publicRefresh = await server.inject({
        method: 'POST', url: '/api/v1/mobile/session/refresh', remoteAddress: '198.51.100.11',
        payload: { refreshToken: 'r'.repeat(43) },
      })
      expect(publicRefresh.statusCode).toBe(403)
      expect(refreshSession).toHaveBeenCalledTimes(1)

      // With no Admin session behind the bearer token, sign-out is refused and nothing is revoked.
      const unsigned = await server.inject({
        method: 'POST', url: '/api/v1/mobile/session/logout',
        headers: { authorization: `Bearer ${'a'.repeat(43)}` },
      })
      expect(unsigned.statusCode).toBe(401)
      expect(logout).not.toHaveBeenCalled()
    } finally {
      await server.close()
    }
  })

  it('serves a same-origin PWA shell with a restrictive CSP and keeps static assets LAN-only', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'infoflex-mobile-client-'))
    writeFileSync(join(directory, 'index.html'), '<!doctype html><title>Mobile app</title>')
    writeFileSync(join(directory, 'service-worker.js'), 'self.addEventListener("install", () => {})')
    const recordDeniedAccess = vi.fn()
    const server = await createHostApi({
      service: { getSettings: () => settings, recordDeniedAccess },
      license: { getSnapshot: () => license },
      authenticate: async () => null,
      mobileClientDirectory: directory,
      localNetworkOnly: true,
      tls: {},
    })
    try {
      const page = await server.inject({ method: 'GET', url: '/' })
      expect(page.statusCode).toBe(200)
      expect(page.body).toContain('Mobile app')
      expect(page.headers['content-security-policy']).toContain("script-src 'self'")
      expect(page.headers['x-content-type-options']).toBe('nosniff')
      expect(page.headers['cache-control']).toBe('no-cache')

      const worker = await server.inject({ method: 'GET', url: '/service-worker.js' })
      expect(worker.statusCode).toBe(200)
      expect(worker.headers['cache-control']).toBe('no-cache')
      const publicPage = await server.inject({ method: 'GET', url: '/', remoteAddress: '203.0.113.24' })
      const publicWorker = await server.inject({ method: 'GET', url: '/service-worker.js', remoteAddress: '203.0.113.24' })
      expect(publicPage.statusCode).toBe(403)
      expect(publicWorker.statusCode).toBe(403)
      expect(publicPage.body).not.toContain('Mobile app')
      expect(recordDeniedAccess).toHaveBeenCalledWith(expect.objectContaining({
        reason: 'license_feature', feature: 'mobileInternet', ipAddress: '203.0.113.24',
      }))

      const missing = await server.inject({ method: 'GET', url: '/api/v1/health' })
      expect(missing.statusCode).toBe(200)
      expect(missing.json()).toEqual({ status: 'ok' })
      const missingAsset = await server.inject({ method: 'GET', url: '/../../outside.txt' })
      expect(missingAsset.statusCode).not.toBe(200)
    } finally {
      await server.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
