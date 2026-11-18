import { describe, expect, it, vi } from 'vitest'
import { getCurrency } from '../currency/catalog'
import { defaultDisplayOptions } from '../currency/money'
import { DEFAULT_OPERATIONAL_SETTINGS, type ShopSettings } from '../shared/shop/types'
import type { LicenseSummary } from '../shared/license/types'
import type { ReturnApprovalDecision, ReturnRecord } from '../shared/returns/types'
import type { ReturnActor, ReturnService } from '../services/return-service'
import type { MobileAccountingSummary } from '../shared/reports/types'
import { createHostApi, createReturnApprovalAdapter, type MobileReportAdapter } from './server'

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
const activeLicense: LicenseSummary = {
  status: 'active', canUse: true, licenseId: 'api-test-license', source: 'online', edition: 'BOTH',
  startsAt: null, endsAt: null, defaultCurrencyCode: null, lockCurrency: false,
  features: { mobileLan: true, mobileInternet: true }, adminPhoneLimit: 2, graceDays: 0,
  lastOnlineCheck: null, reportedToPortal: true, vendorConfigured: false,
  maximumOnsitePeriodYears: null, licenseServerUrl: null, message: 'active',
}

describe('host API adapter', () => {
  it('uses the shared service only after host-verified Admin auth and rate-limits/audits denials generically', async () => {
    const getSettings = vi.fn(() => settings)
    const recordDeniedAccess = vi.fn()
    let principal: { userId: string; username: string; role: 'ADMIN' | 'CASHIER' } | null = null
    const server = await createHostApi({
      service: { getSettings, recordDeniedAccess },
      license: { getSnapshot: () => activeLicense },
      authenticate: async () => principal,
      tls: {},
      now: () => 10_000,
    })
    try {
      const denied = await server.inject({ method: 'GET', url: '/api/v1/admin/settings', headers: { 'user-agent': 'Admin PWA test' } })
      expect(denied.statusCode).toBe(401)
      expect(denied.json()).toEqual({ message: 'This account cannot use the mobile app' })
      expect(getSettings).not.toHaveBeenCalled()
      expect(recordDeniedAccess).toHaveBeenLastCalledWith(expect.objectContaining({
        reason: 'unauthenticated',
        ipAddress: '127.0.0.1',
        userAgent: 'Admin PWA test',
      }))

      principal = { userId: 'user-cashier', username: 'cashier', role: 'CASHIER' }
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const response = await server.inject({ method: 'GET', url: '/api/v1/admin/settings' })
        expect(response.statusCode).toBe(403)
        expect(response.json()).toEqual({ message: 'This account cannot use the mobile app' })
      }
      const limited = await server.inject({ method: 'GET', url: '/api/v1/admin/settings' })
      expect(limited.statusCode).toBe(429)
      expect(limited.json()).toEqual({ message: 'This account cannot use the mobile app' })
      expect(recordDeniedAccess).toHaveBeenCalledTimes(6)
      expect(recordDeniedAccess).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'rate_limited' }))
      expect(getSettings).not.toHaveBeenCalled()

      principal = { userId: 'user-admin', username: 'admin', role: 'ADMIN' }
      const allowed = await server.inject({ method: 'GET', url: '/api/v1/admin/settings' })
      expect(allowed.statusCode).toBe(429)
      expect(getSettings).not.toHaveBeenCalled()
    } finally {
      await server.close()
    }
  })

  it('selects the LAN or Internet license feature from the socket address and stops denied requests', async () => {
    const getSettings = vi.fn(() => settings)
    const recordDeniedAccess = vi.fn()
    const server = await createHostApi({
      service: { getSettings, recordDeniedAccess },
      license: { getSnapshot: () => ({ ...activeLicense, features: { mobileLan: false, mobileInternet: true } }) },
      authenticate: async () => ({ userId: 'user-admin', username: 'admin', role: 'ADMIN' }),
      tls: {},
    })
    try {
      const local = await server.inject({ method: 'GET', url: '/api/v1/admin/settings', remoteAddress: '192.168.1.24' })
      expect(local.statusCode).toBe(403)
      expect(local.json()).toEqual({ message: 'This account cannot use the mobile app' })
      expect(getSettings).not.toHaveBeenCalled()
      expect(recordDeniedAccess).toHaveBeenCalledWith(expect.objectContaining({
        reason: 'license_feature', feature: 'mobileLan', ipAddress: '192.168.1.24',
      }))

      const internet = await server.inject({ method: 'GET', url: '/api/v1/admin/settings', remoteAddress: '198.51.100.24' })
      expect(internet.statusCode).toBe(200)
      expect(getSettings).toHaveBeenCalledTimes(1)
    } finally {
      await server.close()
    }
  })

  it('denies public socket addresses for the LAN-only Electron listener despite Internet entitlement', async () => {
    const recordDeniedAccess = vi.fn()
    const server = await createHostApi({
      service: { getSettings: vi.fn(() => settings), recordDeniedAccess },
      license: { getSnapshot: () => activeLicense },
      authenticate: async () => ({ userId: 'user-admin', username: 'admin', role: 'ADMIN' }),
      localNetworkOnly: true,
      tls: {},
    })
    try {
      const publicRequest = await server.inject({
        method: 'GET', url: '/api/v1/health', remoteAddress: '203.0.113.24',
        headers: { 'x-forwarded-for': '192.168.1.24' },
      })
      expect(publicRequest.statusCode).toBe(403)
      expect(publicRequest.json()).toEqual({ message: 'This account cannot use the mobile app' })
      expect(recordDeniedAccess).toHaveBeenCalledWith(expect.objectContaining({
        reason: 'license_feature', feature: 'mobileInternet', ipAddress: '203.0.113.24',
      }))

      const mappedPublicRequest = await server.inject({ method: 'GET', url: '/api/v1/health', remoteAddress: '::ffff:203.0.113.24' })
      expect(mappedPublicRequest.statusCode).toBe(403)
      const localRequest = await server.inject({ method: 'GET', url: '/api/v1/health', remoteAddress: '192.168.1.24' })
      expect(localRequest.statusCode).toBe(200)
      expect(localRequest.json()).toEqual({ status: 'ok' })
    } finally {
      await server.close()
    }
  })

  it('adapts the verified Admin principal to the shared mobile Returns service and serializes exact minor amounts', async () => {
    const record: ReturnRecord = {
      id: 42, returnNumber: 'C-0000000042', saleId: 9, receiptNumber: 'R-0000000009', status: 'PENDING',
      reason: 'DAMAGED', reasonNote: 'Bottle was cracked.', type: 'REFUND', refundMethod: 'CASH', paymentReference: '',
      createdAt: '2026-11-17T11:00:00.000Z', cashierId: 'cashier-9', cashier: 'Till Cashier',
      approverId: null, approvedBy: '', approvedAt: null, approvalChannel: null, approvalRequestId: 'return-approval-42',
      returnWindowDays: 7, returnWindowOverride: false, returnWindowOverrideReason: '',
      currency, display: defaultDisplayOptions(currency), store: { name: 'Harbor Health', address: '', phone: '' }, customer: null,
      subtotalMinor: 5_000n, totalMinor: 5_000n, promotionAmountReversedMinor: 0n, loyaltyDiscountReversedMinor: 0n,
      loyaltyPointsReversed: 0, loyaltyPointsRestored: 0,
      items: [{
        id: 'return-item-42', saleItemId: 'sale-item-9', productId: 'product-9', sku: 'RX-009',
        description: 'Vitamin C', unit: 'each', quantityMilli: 1_000n, condition: 'RESELLABLE',
        stockDisposition: 'RESTOCKED', writeoffReason: '', sourceBatchId: null, sourceBatchNumber: '', sourceExpiryDate: '',
        grossAmountMinor: 5_000n, manualDiscountMinor: 0n, promotionDiscountMinor: 0n,
        loyaltyDiscountMinor: 0n, lineTotalMinor: 5_000n,
      }],
      credit: null, duplicate: false, printCount: 0,
    }
    const returnService: Pick<ReturnService, 'listPendingMobileApprovals' | 'resolveMobileApproval'> = {
      listPendingMobileApprovals: vi.fn(() => [record]),
      resolveMobileApproval: vi.fn((_returnId: string | number, decision: ReturnApprovalDecision, admin: ReturnActor) => {
        const status: ReturnRecord['status'] = decision === 'APPROVE' ? 'COMPLETED' : 'REJECTED'
        const returnRecord: ReturnRecord = {
          ...record, status,
          approverId: admin.id, approvedBy: 'Mobile Admin', approvedAt: '2026-11-17T12:00:00.000Z', approvalChannel: 'MOBILE',
        }
        return { decision, returnRecord }
      }),
    }
    let principal: { userId: string; username: string; role: 'ADMIN' | 'CASHIER' } = {
      userId: 'user-admin', username: 'admin', role: 'ADMIN',
    }
    const listPending = returnService.listPendingMobileApprovals as ReturnType<typeof vi.fn>
    const resolveMobile = returnService.resolveMobileApproval as ReturnType<typeof vi.fn>
    const server = await createHostApi({
      service: { getSettings: () => settings, recordDeniedAccess: vi.fn() },
      license: { getSnapshot: () => activeLicense },
      authenticate: async () => principal,
      returnApprovals: createReturnApprovalAdapter(returnService),
      tls: {},
    })
    try {
      const pending = await server.inject({ method: 'GET', url: '/api/v1/admin/returns/pending' })
      expect(pending.statusCode).toBe(200)
      expect(pending.json()).toEqual({ requests: [{
        id: 42, returnNumber: 'C-0000000042', receiptNumber: 'R-0000000009', status: 'PENDING',
        reason: 'DAMAGED', reasonNote: 'Bottle was cracked.', type: 'REFUND', createdAt: '2026-11-17T11:00:00.000Z',
        requester: 'Till Cashier', amountMinor: '5000',
        currency: { code: 'NGN', name: 'Nigerian naira', symbol: '₦', decimalPlaces: 2 },
        storeName: 'Harbor Health', items: [{
          description: 'Vitamin C', sku: 'RX-009', quantityMilli: '1000', condition: 'RESELLABLE', stockDisposition: 'RESTOCKED',
        }],
      }] })
      expect(listPending).toHaveBeenCalledWith({ id: 'user-admin', username: 'admin', role: 'ADMIN' })

      const invalid = await server.inject({ method: 'POST', url: '/api/v1/admin/returns/42/approval', payload: { decision: 'MAYBE' } })
      expect(invalid.statusCode).toBe(400)
      expect(resolveMobile).not.toHaveBeenCalled()

      const approved = await server.inject({ method: 'POST', url: '/api/v1/admin/returns/42/approval', payload: { decision: 'APPROVE' } })
      expect(approved.statusCode).toBe(200)
      expect(approved.json()).toMatchObject({
        decision: 'APPROVE', return: { id: 42, returnNumber: 'C-0000000042', status: 'COMPLETED', amountMinor: '5000' },
      })
      expect(resolveMobile).toHaveBeenCalledWith('42', 'APPROVE', { id: 'user-admin', username: 'admin', role: 'ADMIN' })

      principal = { userId: 'user-cashier', username: 'cashier', role: 'CASHIER' }
      const denied = await server.inject({ method: 'GET', url: '/api/v1/admin/returns/pending' })
      expect(denied.statusCode).toBe(403)
      expect(listPending).toHaveBeenCalledTimes(1)
    } finally {
      await server.close()
    }
  })

  it('keeps mobile Returns disabled unless a host injects the shared service adapter', async () => {
    const server = await createHostApi({
      service: { getSettings: () => settings, recordDeniedAccess: vi.fn() },
      license: { getSnapshot: () => activeLicense },
      authenticate: async () => ({ userId: 'user-admin', username: 'admin', role: 'ADMIN' }),
      tls: {},
    })
    try {
      const response = await server.inject({ method: 'GET', url: '/api/v1/admin/returns/pending' })
      expect(response.statusCode).toBe(503)
      expect(response.json()).toEqual({ message: 'Return approvals are not configured on this host.' })
    } finally {
      await server.close()
    }
  })

  it('serves mobile daily/monthly report data and PDF only after Admin and license checks', async () => {
    const summary: MobileAccountingSummary = {
      header: {
        storeName: 'Harbor Health', storeAddress: '14 Marina Road', currency,
        period: { type: 'DAY', startDate: '2026-11-17', endDate: '2026-11-17', label: '2026-11-17' },
        generatedAt: '2026-11-17T12:00:00.000Z',
      },
      summary: {
        grossSalesMinor: 11_000n, totalSalesMinor: 10_000n, transactions: 2,
        retail: { totalMinor: 7_000n, transactions: 1 }, wholesale: { totalMinor: 3_000n, transactions: 1 },
        discountsMinor: 1_000n, returnsMinor: 500n, refundsMinor: 500n, netSalesMinor: 9_500n,
        cogsMinor: 4_000n, grossProfitMinor: 5_500n, returnTransactions: 1,
      },
      daily: [{
        date: '2026-11-17', totalSalesMinor: 10_000n, transactions: 2,
        retailSalesMinor: 7_000n, retailTransactions: 1, wholesaleSalesMinor: 3_000n, wholesaleTransactions: 1,
        discountsMinor: 1_000n, returnsMinor: 500n, refundsMinor: 500n, netSalesMinor: 9_500n,
        cogsMinor: 4_000n, grossProfitMinor: 5_500n,
      }],
      paymentMethods: [{ method: 'CASH', totalMinor: 7_000n, transactions: 1 }],
      refundMethods: [{ method: 'CASH', totalMinor: 500n, transactions: 1 }],
      salesByUser: [{
        userId: 'user-cashier', userName: 'Amaka Obi', username: 'cashier',
        transactions: 2, retailSalesMinor: 7_000n, wholesaleSalesMinor: 3_000n,
        totalSalesMinor: 10_000n, discountsMinor: 1_000n, returnsMinor: 500n,
        netSalesMinor: 9_500n, cogsMinor: 4_000n, grossProfitMinor: 5_500n,
      }],
    }
    const getSummary = vi.fn((_input, _admin) => summary)
    const exportPdf = vi.fn(async () => new Uint8Array([37, 80, 68, 70, 45, 49]))
    const mobileReports: MobileReportAdapter = { getSummary, exportPdf }
    let principal: { userId: string; username: string; role: 'ADMIN' | 'CASHIER' } = {
      userId: 'user-admin', username: 'admin', role: 'ADMIN',
    }
    const server = await createHostApi({
      service: { getSettings: () => settings, recordDeniedAccess: vi.fn() },
      license: { getSnapshot: () => activeLicense },
      authenticate: async () => principal,
      mobileReports,
      tls: {},
      now: () => Date.parse('2026-11-17T12:00:00.000Z'),
    })
    try {
      const response = await server.inject({ method: 'GET', url: '/api/v1/admin/reports/summary?period=DAY&date=2026-11-17' })
      expect(response.statusCode).toBe(200)
      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.json()).toMatchObject({
        header: { storeName: 'Harbor Health', currency: { code: 'NGN' }, period: { label: '2026-11-17' } },
        summary: { totalSalesMinor: '10000', returnsMinor: '500', netSalesMinor: '9500', cogsMinor: '4000' },
        daily: [{ date: '2026-11-17', netSalesMinor: '9500' }],
      })
      expect(getSummary).toHaveBeenCalledWith({ period: 'DAY', date: '2026-11-17' }, expect.objectContaining({
        userId: 'user-admin', username: 'admin', role: 'ADMIN', isActive: true, isLocked: false,
      }))

      // The retired token-authenticated HTML page must not linger as a second, unusable report entry point.
      const retiredPage = await server.inject({ method: 'GET', url: '/api/v1/admin/reports/phone?period=MONTH&date=2026-11' })
      expect(retiredPage.statusCode).toBe(404)
      expect(getSummary).toHaveBeenCalledTimes(1)

      const pdf = await server.inject({ method: 'GET', url: '/api/v1/admin/reports/summary.pdf?period=MONTH&date=2026-11' })
      expect(pdf.statusCode).toBe(200)
      expect(pdf.headers['content-type']).toBe('application/pdf')
      expect(pdf.headers['content-disposition']).toContain('infoflex-month-2026-11.pdf')
      expect(pdf.body).toBe('%PDF-1')
      expect(exportPdf).toHaveBeenCalledWith({ period: 'MONTH', date: '2026-11' }, expect.objectContaining({ role: 'ADMIN' }))

      principal = { userId: 'user-cashier', username: 'cashier', role: 'CASHIER' }
      const denied = await server.inject({ method: 'GET', url: '/api/v1/admin/reports/summary' })
      expect(denied.statusCode).toBe(403)
      expect(getSummary).toHaveBeenCalledTimes(1)
      expect(exportPdf).toHaveBeenCalledTimes(1)
    } finally {
      await server.close()
    }
  })
})

describe('relayed arrivals', () => {
  /**
   * The relay's marker is the only thing that can turn a loopback request into an "internet" request, and it is
   * honoured from a loopback peer alone. These two tests are the security boundary: a phone on mobile data must
   * get the internet rules, and a phone on the shop's Wi-Fi must not be able to claim it came over the internet
   * (or vice versa) by adding a header.
   */
  it('treats a relayed loopback request as the internet: no LAN entitlement, and no skipping the authenticator', async () => {
    const recordDeniedAccess = vi.fn()
    const login = vi.fn(async () => ({
      deviceId: 'device-1', accessToken: 'a'.repeat(43), refreshToken: 'r'.repeat(43),
      accessTokenExpiresAt: '2026-11-17T12:15:00.000Z', refreshTokenExpiresAt: '2027-02-15T12:00:00.000Z',
      user: { id: 'admin-1', username: 'admin', fullName: 'Admin', role: 'ADMIN' as const }, requiresTotp: true,
    }))
    const server = await createHostApi({
      service: { getSettings: () => settings, recordDeniedAccess },
      // Only the internet entitlement: a relayed request must be allowed, a LAN one must not.
      license: { getSnapshot: () => ({ ...activeLicense, features: { mobileLan: false, mobileInternet: true } }) },
      authenticate: async () => ({ userId: 'admin-1', username: 'admin', role: 'ADMIN' }),
      mobileSessions: {
        startPairRequest: vi.fn(), pairStatus: vi.fn(), login, refreshSession: () => null, logout: vi.fn(),
      },
      localNetworkOnly: true,
      allowRelayArrival: true,
      tls: {},
    })
    try {
      const relayed = await server.inject({
        method: 'GET', url: '/api/v1/admin/settings', remoteAddress: '127.0.0.1',
        headers: { 'x-infoflex-relay': '1' },
      })
      expect(relayed.statusCode).toBe(200)

      // The same address without the marker is an ordinary loopback caller, which counts as the shop's own network.
      const plainLoopback = await server.inject({ method: 'GET', url: '/api/v1/admin/settings', remoteAddress: '127.0.0.1' })
      expect(plainLoopback.statusCode).toBe(403)
      expect(recordDeniedAccess).toHaveBeenCalledWith(expect.objectContaining({ feature: 'mobileLan' }))

      // And the phone login is told the truth: this session came over the internet.
      const signedIn = await server.inject({
        method: 'POST', url: '/api/v1/mobile/session/login', remoteAddress: '127.0.0.1',
        headers: { 'x-infoflex-relay': '1' },
        payload: { username: 'admin', password: 'secret', deviceToken: 'd'.repeat(43) },
      })
      expect(signedIn.statusCode).toBe(200)
      expect(login).toHaveBeenCalledWith(
        expect.objectContaining({ username: 'admin' }),
        expect.objectContaining({ relayed: true }),
      )
    } finally {
      await server.close()
    }
  })

  it('ignores the marker from any address that is not loopback, so a phone cannot claim to be the relay', async () => {
    const recordDeniedAccess = vi.fn()
    const server = await createHostApi({
      service: { getSettings: () => settings, recordDeniedAccess },
      license: { getSnapshot: () => ({ ...activeLicense, features: { mobileLan: false, mobileInternet: true } }) },
      authenticate: async () => ({ userId: 'admin-1', username: 'admin', role: 'ADMIN' }),
      localNetworkOnly: true,
      allowRelayArrival: true,
      tls: {},
    })
    try {
      // A public address with the marker is still public: the LAN-only listener refuses it outright.
      const forged = await server.inject({
        method: 'GET', url: '/api/v1/admin/settings', remoteAddress: '198.51.100.7',
        headers: { 'x-infoflex-relay': '1' },
      })
      expect(forged.statusCode).toBe(403)

      // A shop Wi-Fi address with the marker stays on the LAN rules, so a phone cannot buy the internet rules.
      const lanForged = await server.inject({
        method: 'GET', url: '/api/v1/admin/settings', remoteAddress: '192.168.1.31',
        headers: { 'x-infoflex-relay': '1' },
      })
      expect(lanForged.statusCode).toBe(403)
      expect(recordDeniedAccess).toHaveBeenCalledWith(expect.objectContaining({ feature: 'mobileLan', ipAddress: '192.168.1.31' }))
    } finally {
      await server.close()
    }
  })
})
