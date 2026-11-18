import { describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createHostApi } from './server'
import { MobileAdminService, MobileStaleVersionError } from './mobile-admin-service'
import type { MobileAdminHost } from './mobile-admin-service'
import type { AuthenticatedPrincipal } from '../services/permissions'
import type { LicenseSummary } from '../shared/license/types'
import type { ShopSettings } from '../shared/shop/types'
import type { PublicUser } from '../shared/auth/types'
import { getCurrency } from '../currency/catalog'
import { defaultDisplayOptions } from '../currency/money'

/**
 * These exercise the real HTTP surface the phone talks to: the guard order, the refusals, the shape of the
 * replies, and the offline/write rules. The service is real; only the host behind it is a small double, so
 * the test is about the routes rather than about SQLite (which `mobile-admin-service.test.ts` covers).
 */

const NGN = getCurrency('NGN')!
const UGANDA = getCurrency('UGX')!

const settings: ShopSettings = {
  profile: { name: 'Harbor Health Pharmacy', address: '14 Marina Road', phone: '+234 800 111 2222' },
  currency: NGN,
  display: defaultDisplayOptions(NGN),
  setupComplete: true,
  currencyConfirmed: true,
  currencyLocked: false,
  operational: {} as ShopSettings['operational'],
}

const activeLicense: LicenseSummary = {
  status: 'active', canUse: true, licenseId: 'lic-1', source: 'online', edition: 'BOTH',
  startsAt: '2026-01-01', endsAt: '2027-01-01', defaultCurrencyCode: null, lockCurrency: false,
  features: { mobileLan: true, mobileInternet: false }, adminPhoneLimit: 2, graceDays: 7,
} as LicenseSummary

const ADMIN_USER: PublicUser = {
  id: 'user-admin', fullName: 'Tunde Bakare', username: 'admin', role: 'ADMIN', isActive: true, isLocked: false,
  permissions: { allowWholesale: true, maxDiscountBasisPoints: 10_000, allowCreditSales: true, returnLimitMinor: 0n },
}

interface HostState {
  principal: AuthenticatedPrincipal | null
  /** When true, the bearer token belongs to a Cashier who somehow holds a device token. */
  licence: LicenseSummary
}

function stubHost(state: HostState) {
  const sold = { allowWholesale: true }
  const host: MobileAdminHost = {
    getSettings: () => settings,
    getEdition: () => (state.licence.canUse ? state.licence.edition : null),
    getLicense: () => state.licence,
    revalidateAdmin: (userId) => userId === 'user-admin'
      ? { id: userId, username: 'admin', role: 'ADMIN', isActive: true, isLocked: false }
      : null,
    getUser: (userId) => userId === 'user-admin' ? ADMIN_USER : null,
    verifyAdminPassword: async (_userId, password) => password === 'correct-horse-battery',
    listProducts: () => [],
    // The route loads the current row (to prove the versions match) before calling updateProduct.
    getProduct: () => ({
      id: 'p1', sku: 'PARA-500', name: 'Paracetamol', brand: '', description: '', barcode: '',
      additionalBarcodes: [], category: '', subCategory: '', department: '', shelfLocation: '',
      unit: 'pack', packSizeUnits: 1, costMinor: 12000n, retailPriceMinor: 25000n, wholesalePriceMinor: 22000n,
      wholesaleMinimumQuantityMilli: 1000n, reorderLevelMilli: 10000n, quantityMilli: 0n, reservedMilli: 0n,
      rowVersion: 1, stockVersion: 1, genericName: '', prescriptionRequired: false, weighedItem: false,
      pluCode: '', pricePerKgMinor: null, expiryTracking: false, isActive: true, variants: [],
    }),
    createProduct: () => { throw new Error('Unused in this test.') },
    updateProduct: () => { throw new Error('Unused in this test.') },
    adjustStock: () => { throw new Error('Unused in this test.') },
    receiveStock: () => { throw new Error('Unused in this test.') },
    getSellableBatches: () => [],
    getAlerts: () => [],
    getReport: (input) => ({
      header: {
        storeName: settings.profile.name, storeAddress: settings.profile.address,
        currency: settings.currency, display: settings.display,
        period: { type: input.period, startDate: input.date, endDate: input.date, label: input.date },
        generatedAt: '2026-11-17T09:00:00.000Z', scope: 'STORE',
      },
      summary: {
        grossSalesMinor: 0n, totalSalesMinor: 0n, transactions: 0,
        retail: { totalMinor: 0n, transactions: 0 }, wholesale: { totalMinor: 0n, transactions: 0 },
        discountsMinor: 0n, returnsMinor: 0n, refundsMinor: 0n, netSalesMinor: 0n,
        cogsMinor: 0n, grossProfitMinor: 0n, returnTransactions: 0,
      },
      daily: [], paymentMethods: [], refundMethods: [],
      salesByUser: [], cashPosition: null, dayClose: null, shifts: [], adminReports: null,
    } as never),
    exportReportPdf: async () => new Uint8Array([37, 80, 68, 70]),
    listRecentSales: () => [],
    getReceipt: () => { throw new Error('No sale in this stub.') },
    recordReceiptViewed: () => { throw new Error('No sale in this stub.') },
    listUsers: () => [ADMIN_USER],
    updateUser: (_actor, id, input) => {
      Object.assign(sold, { allowWholesale: input.permissions.allowWholesale })
      return { ...ADMIN_USER, id, permissions: input.permissions }
    },
    listPendingApprovals: () => [],
    listRecentApprovals: () => [],
    pendingApprovalCount: () => 0,
    resolveApproval: () => { throw new StaleLike() },
    listPendingReturnApprovals: () => [],
    resolveReturnApproval: () => { throw new Error('Choose a valid return request.') },
    countConnectedDevices: () => 1,
    listPairedDevices: () => [
      { id: 'dev-1', name: 'Ada\u2019s iPhone', platform: 'iPhone (Safari)', lastSeen: '2026-11-17T09:00:00.000Z', lastIp: '192.168.1.24', createdAt: '2026-11-01T08:00:00.000Z', connected: true },
    ],
    revokePairedDevice: () => undefined,
  }
  return host
}

class StaleLike extends Error {
  constructor() {
    super('This request was already decided.')
  }
}

async function createServer(state: HostState): Promise<{ server: FastifyInstance; denied: ReturnType<typeof vi.fn> }> {
  const denied = vi.fn()
  const service = new MobileAdminService(stubHost(state))
  const server = await createHostApi({
    service: { getSettings: () => settings, recordDeniedAccess: denied },
    license: { getSnapshot: () => state.licence },
    authenticate: async () => state.principal,
    mobileAdmin: { service },
    localNetworkOnly: false,
    tls: {},
    now: () => Date.parse('2026-11-17T12:00:00.000Z'),
  })
  return { server, denied }
}

function bearer(token = 'device-token'): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

describe('the Admin phone API', () => {
  it('refuses a Cashier or Supervisor token on every admin route with the generic sentence', async () => {
    const state: HostState = { principal: null, licence: activeLicense }
    const { server, denied } = await createServer(state)
    try {
      const routes: Array<[string, string]> = [
        ['GET', '/api/v1/mobile/admin/dashboard'],
        ['GET', '/api/v1/mobile/admin/products'],
        ['GET', '/api/v1/mobile/admin/products/p1'],
        ['GET', '/api/v1/mobile/admin/reports'],
        ['GET', '/api/v1/mobile/admin/sales'],
        ['GET', '/api/v1/mobile/admin/cashiers'],
        ['GET', '/api/v1/mobile/admin/approvals'],
        ['GET', '/api/v1/mobile/admin/devices'],
        ['POST', '/api/v1/mobile/admin/devices/dev-1/revoke'],
        ['POST', '/api/v1/mobile/admin/approvals/r1'],
        ['POST', '/api/v1/mobile/admin/cashiers/u1/wholesale'],
        ['POST', '/api/v1/mobile/admin/products/p1/stock'],
        ['POST', '/api/v1/mobile/admin/products'],
      ]
      for (const role of ['CASHIER', 'SUPERVISOR'] as const) {
        state.principal = { userId: 'user-cashier', username: 'amaka', role }
        for (const [method, url] of routes) {
          const response = await server.inject({ method: method as 'GET' | 'POST', url, headers: bearer() })
          expect(response.statusCode, `${role} ${method} ${url}`).toBe(403)
          expect(response.json()).toEqual({ message: 'This account cannot use the mobile app' })
        }
        // Every refusal is audited as a non-Admin attempt.
        expect(denied).toHaveBeenCalled()
        expect(denied.mock.calls.every(([input]) => input.reason === 'non_admin' || input.reason === 'non_admin')).toBe(true)
      }
    } finally {
      await server.close()
    }
  })

  it('answers 401, not 403, when no token is presented at all', async () => {
    const state: HostState = { principal: null, licence: activeLicense }
    const { server } = await createServer(state)
    try {
      const response = await server.inject({ method: 'GET', url: '/api/v1/mobile/admin/dashboard' })
      expect(response.statusCode).toBe(401)
      expect(response.json()).toEqual({ message: 'This account cannot use the mobile app' })
    } finally {
      await server.close()
    }
  })

  it('serves the dashboard to an Admin with the store name and integer amounts', async () => {
    const state: HostState = { principal: { userId: 'user-admin', username: 'admin', role: 'ADMIN' }, licence: activeLicense }
    const { server } = await createServer(state)
    try {
      const response = await server.inject({ method: 'GET', url: '/api/v1/mobile/admin/dashboard', headers: bearer() })
      expect(response.statusCode).toBe(200)
      expect(response.headers['cache-control']).toBe('no-store')
      const body = response.json()
      expect(body.header.storeName).toBe('Harbor Health Pharmacy')
      expect(body.header.currency.code).toBe('NGN')
      expect(typeof body.today.totalSalesMinor).toBe('string')
      expect(body.counts.connectedDevices).toBe(1)
    } finally {
      await server.close()
    }
  })

  it('refuses every admin route while the licence is expired, including reads', async () => {
    const state: HostState = {
      principal: { userId: 'user-admin', username: 'admin', role: 'ADMIN' },
      licence: { ...activeLicense, canUse: false, status: 'expired' },
    }
    const { server } = await createServer(state)
    try {
      const response = await server.inject({ method: 'GET', url: '/api/v1/mobile/admin/dashboard', headers: bearer() })
      expect(response.statusCode).toBe(403)
      expect(response.json().message).toMatch(/licence/iu)
    } finally {
      await server.close()
    }
  })

  it('requires the Admin password to change a cashier permission, and rejects a wrong one', async () => {
    const state: HostState = { principal: { userId: 'user-admin', username: 'admin', role: 'ADMIN' }, licence: activeLicense }
    const { server } = await createServer(state)
    try {
      const missing = await server.inject({
        method: 'POST', url: '/api/v1/mobile/admin/cashiers/user-cashier/wholesale', headers: bearer(),
        payload: { allowWholesale: false },
      })
      expect(missing.statusCode).toBe(400)
      expect(missing.json().message).toMatch(/Admin password/iu)

      const wrong = await server.inject({
        method: 'POST', url: '/api/v1/mobile/admin/cashiers/user-cashier/wholesale', headers: bearer(),
        payload: { allowWholesale: false, adminPassword: 'nope' },
      })
      expect(wrong.statusCode).toBe(400)
      expect(wrong.json().message).toMatch(/not correct/iu)
    } finally {
      await server.close()
    }
  })

  it('lists the Admin’s paired phones and revokes one only with the Admin password', async () => {
    const state: HostState = { principal: { userId: 'user-admin', username: 'admin', role: 'ADMIN' }, licence: activeLicense }
    const revoked: string[] = []
    const service = new MobileAdminService({
      ...stubHost(state),
      revokePairedDevice: (_adminId, deviceId) => { revoked.push(deviceId) },
    })
    const server = await createHostApi({
      service: { getSettings: () => settings, recordDeniedAccess: () => {} },
      license: { getSnapshot: () => state.licence },
      authenticate: async () => state.principal,
      mobileAdmin: { service },
      localNetworkOnly: false,
      tls: {},
      now: () => Date.parse('2026-11-17T12:00:00.000Z'),
    })
    try {
      const listed = await server.inject({ method: 'GET', url: '/api/v1/mobile/admin/devices', headers: bearer() })
      expect(listed.statusCode).toBe(200)
      expect(listed.json().devices[0].name).toBe('Ada\u2019s iPhone')
      // Only an Admin can even see the list, and nothing is revoked by reading it.
      expect(revoked).toEqual([])

      const noPassword = await server.inject({
        method: 'POST', url: '/api/v1/mobile/admin/devices/dev-1/revoke', headers: bearer(), payload: {},
      })
      expect(noPassword.statusCode).toBe(400)
      expect(noPassword.json().message).toMatch(/Admin password/iu)
      expect(revoked).toEqual([])

      const wrong = await server.inject({
        method: 'POST', url: '/api/v1/mobile/admin/devices/dev-1/revoke', headers: bearer(), payload: { adminPassword: 'nope' },
      })
      expect(wrong.statusCode).toBe(400)
      expect(revoked).toEqual([])

      const ok = await server.inject({
        method: 'POST', url: '/api/v1/mobile/admin/devices/dev-1/revoke', headers: bearer(), payload: { adminPassword: 'correct-horse-battery' },
      })
      expect(ok.statusCode).toBe(200)
      expect(revoked).toEqual(['dev-1'])
    } finally {
      await server.close()
    }
  })

  it('returns 409 with reloadRequired when the screen is stale, so the phone says "changed, reload"', async () => {
    const state: HostState = { principal: { userId: 'user-admin', username: 'admin', role: 'ADMIN' }, licence: activeLicense }
    const service = new MobileAdminService({
      ...stubHost(state),
      resolveApproval: () => { throw new StaleLike() },
    })
    const server = await createHostApi({
      service: { getSettings: () => settings, recordDeniedAccess: vi.fn() },
      license: { getSnapshot: () => activeLicense },
      authenticate: async () => state.principal,
      mobileAdmin: { service },
      localNetworkOnly: false,
      tls: {},
    })
    try {
      const response = await server.inject({
        method: 'POST', url: '/api/v1/mobile/admin/approvals/anything', headers: bearer(),
        payload: { decision: 'APPROVE' },
      })
      expect(response.statusCode).toBe(409)
      expect(response.json()).toMatchObject({ reloadRequired: true, code: 'ALREADY_DECIDED' })
    } finally {
      await server.close()
    }
  })

  it('rejects an unknown decision without touching the queue', async () => {
    const state: HostState = { principal: { userId: 'user-admin', username: 'admin', role: 'ADMIN' }, licence: activeLicense }
    const { server } = await createServer(state)
    try {
      const response = await server.inject({
        method: 'POST', url: '/api/v1/mobile/admin/approvals/r1', headers: bearer(), payload: { decision: 'MAYBE' },
      })
      expect(response.statusCode).toBe(400)
      expect(response.json().message).toMatch(/Approve or Reject/iu)
    } finally {
      await server.close()
    }
  })

  it('uses the shop’s own currency for a 0-decimal shop and never a hard-coded symbol', async () => {
    const state: HostState = { principal: { userId: 'user-admin', username: 'admin', role: 'ADMIN' }, licence: activeLicense }
    const ugandaSettings: ShopSettings = {
      ...settings,
      currency: UGANDA,
      display: defaultDisplayOptions(UGANDA),
    }
    const service = new MobileAdminService({ ...stubHost(state), getSettings: () => ugandaSettings })
    const server = await createHostApi({
      service: { getSettings: () => ugandaSettings, recordDeniedAccess: vi.fn() },
      license: { getSnapshot: () => activeLicense },
      authenticate: async () => state.principal,
      mobileAdmin: { service },
      localNetworkOnly: false,
      tls: {},
    })
    try {
      const response = await server.inject({ method: 'GET', url: '/api/v1/mobile/admin/dashboard', headers: bearer() })
      const body = response.json()
      expect(body.header.currency.code).toBe('UGX')
      expect(body.header.currency.decimalPlaces).toBe(0)
    } finally {
      await server.close()
    }
  })

  it('serves the report PDF as base64, because a phone shares a file, not a stream', async () => {
    const state: HostState = { principal: { userId: 'user-admin', username: 'admin', role: 'ADMIN' }, licence: activeLicense }
    const { server } = await createServer(state)
    try {
      const response = await server.inject({
        method: 'GET', url: '/api/v1/mobile/admin/reports.pdf?period=DAY&date=2026-11-17', headers: bearer(),
      })
      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.fileName).toBe('infoflex-day-2026-11-17.pdf')
      expect(Buffer.from(body.pdf, 'base64').subarray(0, 4).toString()).toBe('%PDF')
    } finally {
      await server.close()
    }
  })

  it('round-trips a stale-version error from the product editor', async () => {
    const state: HostState = { principal: { userId: 'user-admin', username: 'admin', role: 'ADMIN' }, licence: activeLicense }
    const service = new MobileAdminService({
      ...stubHost(state),
      updateProduct: () => { throw new MobileStaleVersionError() },
    })
    const server = await createHostApi({
      service: { getSettings: () => settings, recordDeniedAccess: vi.fn() },
      license: { getSnapshot: () => activeLicense },
      authenticate: async () => state.principal,
      mobileAdmin: { service },
      localNetworkOnly: false,
      tls: {},
    })
    try {
      const response = await server.inject({
        method: 'POST', url: '/api/v1/mobile/admin/products/p1', headers: bearer(),
        payload: {
          expectedRowVersion: 1, adminPassword: 'correct-horse-battery', name: 'Paracetamol',
          brand: '', category: '', unit: 'pack', barcode: '', reorderLevel: '10',
          retailPrice: '250.00', wholesalePrice: '220.00', cost: '120.00',
        },
      })
      expect(response.statusCode, JSON.stringify(response.json())).toBe(409)
      expect(response.json()).toMatchObject({ reloadRequired: true, code: 'STALE_VERSION' })
      expect(response.json().message).toBe('This item was changed, reload.')
    } finally {
      await server.close()
    }
  })
})
