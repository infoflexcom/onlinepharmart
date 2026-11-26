import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createHostApi } from './server'
import { MobileAdminService } from './mobile-admin-service'
import type { AuthenticatedPrincipal } from '../services/permissions'
import type { LicenseSummary } from '../shared/license/types'
import type { ShopSettings } from '../shared/shop/types'
import { CURRENCIES, getCurrency } from '../currency/catalog'
import { defaultDisplayOptions } from '../currency/money'

/**
 * The build the desktop actually serves to a phone.
 *
 * The unit tests render the screens from source; this test reads the *built* bundle in `out/mobile` and asks
 * the real host for it over HTTP, the way a phone would. That catches the classes of failure a component
 * test cannot: a build that silently stopped emitting the service worker, an HTML entry that no longer names
 * the right icons, or a route that the mobile client cannot reach because the server put it behind the wrong
 * prefix. It skips only when the PWA has not been built, so `npm test` alone still works.
 */

const MOBILE_OUTPUT = resolve(process.cwd(), 'out/mobile')
const built = existsSync(resolve(MOBILE_OUTPUT, 'index.html'))

const settings: ShopSettings = {
  profile: { name: 'Harbor Health Pharmacy', address: '14 Marina Road', phone: '+234 800 111 2222' },
  currency: getCurrency('NGN')!,
  display: defaultDisplayOptions(getCurrency('NGN')!),
  setupComplete: true, currencyConfirmed: true, currencyLocked: false,
  operational: {} as ShopSettings['operational'],
}

const license = {
  status: 'active', canUse: true, licenseId: 'lic-1', source: 'online', edition: 'BOTH',
  startsAt: '2026-01-01', endsAt: '2027-01-01', defaultCurrencyCode: null, lockCurrency: false,
  features: { mobileLan: true, mobileInternet: false }, adminPhoneLimit: 2, graceDays: 7,
} as LicenseSummary

const admin: AuthenticatedPrincipal = { userId: 'user-admin', username: 'admin', role: 'ADMIN' }

describe.skipIf(!built)('the mobile app the host serves', () => {
  it('is a real build with a manifest, icons, a service worker and hashed assets', () => {
    const index = readFileSync(resolve(MOBILE_OUTPUT, 'index.html'), 'utf8')
    for (const asset of ['manifest.webmanifest', 'service-worker.js', 'icons/icon-192.png', 'icons/icon-180.png', 'icons/icon-512.png']) {
      expect(existsSync(resolve(MOBILE_OUTPUT, asset)), `${asset} must be in the built PWA`).toBe(true)
    }
    // The entry document must point at the hashed bundle, not at a dev server.
    expect(index).toMatch(/<script type="module" crossorigin src="\/assets\/index-[A-Za-z0-9_-]+\.js">/u)
    expect(index).toMatch(/<link rel="stylesheet" crossorigin href="\/assets\/index-[A-Za-z0-9_-]+\.css">/u)
    expect(index).toContain('apple-touch-icon')
    expect(index).toContain('viewport-fit=cover')
    expect(index).not.toContain('/src/main.ts')

    const assets = readdirSync(resolve(MOBILE_OUTPUT, 'assets'))
    const entry = assets.find((name) => /^index-.*\.js$/u.test(name))!
    const entrySource = readFileSync(resolve(MOBILE_OUTPUT, 'assets', entry), 'utf8')
    // The built-in currency table is the *only* place a symbol may appear. One occurrence means no screen
    // has hard-coded a symbol of its own; amounts are always formatted from the shop's currency definition.
    // `$` is left out: it is a template-literal character and would match every bundled string.
    for (const glyph of ['\u20a6', '\u00a3', '\u20ac', 'GH\u20b5', '\u20b9']) {
      const fromTable = CURRENCIES.filter((currency) => currency.symbol.includes(glyph)).length
      expect(countOccurrences(entrySource, glyph), `only the currency table may spell ${glyph}`).toBe(fromTable)
    }
    // The scanner must be a separate chunk so the first paint stays small on a weak connection.
    expect(assets.some((name) => /barcode-scanner/u.test(name))).toBe(true)
    expect(entrySource).toContain('Admin login')
  })

  it('serves the shell, its assets and the service worker over HTTP from the host', async () => {
    const server = await createHostApi({
      service: { getSettings: () => settings, recordDeniedAccess: () => undefined },
      license: { getSnapshot: () => license },
      authenticate: async () => admin,
      mobileAdmin: { service: new MobileAdminService(proxyHost()) },
      mobileClientDirectory: MOBILE_OUTPUT,
      localNetworkOnly: false,
      tls: {},
    })
    try {
      const page = await server.inject({ method: 'GET', url: '/' })
      expect(page.statusCode).toBe(200)
      expect(page.headers['content-type']).toContain('text/html')
      expect(page.body).toContain('Infoflex Admin Mobile')

      const worker = await server.inject({ method: 'GET', url: '/service-worker.js' })
      expect(worker.statusCode).toBe(200)
      expect(worker.headers['cache-control']).toBe('no-cache')

      const manifest = await server.inject({ method: 'GET', url: '/manifest.webmanifest' })
      expect(manifest.statusCode).toBe(200)

      const icon = await server.inject({ method: 'GET', url: '/icons/icon-192.png' })
      expect(icon.statusCode).toBe(200)
      // Immutable, content-hashed assets can be cached hard; the HTML and the worker cannot.
      expect(icon.headers['cache-control']).toContain('immutable')

      const index = readFileSync(resolve(MOBILE_OUTPUT, 'index.html'), 'utf8')
      const script = /src="(\/assets\/index-[A-Za-z0-9_-]+\.js)"/u.exec(index)![1]!
      const bundle = await server.inject({ method: 'GET', url: script })
      expect(bundle.statusCode).toBe(200)
      expect(bundle.headers['content-type']).toContain('text/javascript')

      // The one route the phone's dashboard uses, over the same origin that served the shell.
      const dashboard = await server.inject({ method: 'GET', url: '/api/v1/mobile/admin/dashboard', headers: { authorization: 'Bearer token' } })
      expect(dashboard.statusCode).toBe(200)
      expect(dashboard.json().header.storeName).toBe('Harbor Health Pharmacy')
      // The audit block is null over the wire, not missing and not an empty list: null is how the phone learns that this
      // Server has no audit service, and the rest of the dashboard still arrived. A block that could not be built must
      // not take the day's sales down with it.
      const body = dashboard.json() as { audit?: unknown; header: { storeName: string } }
      expect('audit' in body, 'the audit key is present, so the phone can tell null from an old Server').toBe(true)
      expect(body.audit).toBeNull()
      expect(body.header.storeName).toBe('Harbor Health Pharmacy')
    } finally {
      await server.close()
    }
  })

  it('refuses a Cashier on the served API, so a Cashier cannot use the installed app', async () => {
    const server = await createHostApi({
      service: { getSettings: () => settings, recordDeniedAccess: () => undefined },
      license: { getSnapshot: () => license },
      authenticate: async () => ({ userId: 'user-cashier', username: 'amaka', role: 'CASHIER' }),
      mobileAdmin: { service: new MobileAdminService(proxyHost()) },
      mobileClientDirectory: MOBILE_OUTPUT,
      localNetworkOnly: false,
      tls: {},
    })
    try {
      const response = await server.inject({ method: 'GET', url: '/api/v1/mobile/admin/dashboard', headers: { authorization: 'Bearer token' } })
      expect(response.statusCode).toBe(403)
      expect(response.json()).toEqual({ message: 'This account cannot use the mobile app' })
    } finally {
      await server.close()
    }
  })
})

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

function proxyHost() {
  const settingsValue = settings
  return new Proxy({} as never, {
    get: (_target, key) => {
      const name = String(key)
      if (name === 'getSettings') return () => settingsValue
      if (name === 'getEdition') return () => 'BOTH' as const
      if (name === 'getLicense') return () => license
      if (name === 'revalidateAdmin') return () => ({ id: 'user-admin', username: 'admin', role: 'ADMIN', isActive: true, isLocked: false })
      if (name === 'getUser') return () => ({
        id: 'user-admin', fullName: 'Tunde Bakare', username: 'admin', role: 'ADMIN', isActive: true, isLocked: false,
        permissions: { allowWholesale: true, maxDiscountBasisPoints: 10_000, allowCreditSales: true, returnLimitMinor: 0n },
      })
      if (name === 'verifyAdminPassword') return async () => true
      if (name === 'getReport') return (input: { period: string; date: string }) => ({
        header: {
          storeName: settingsValue.profile.name, storeAddress: settingsValue.profile.address,
          currency: settingsValue.currency, display: settingsValue.display,
          period: { type: input.period, startDate: input.date, endDate: input.date, label: input.date },
          generatedAt: '2026-11-17T09:00:00.000Z', scope: 'STORE',
        },
        summary: {
          grossSalesMinor: 0n, totalSalesMinor: 0n, transactions: 0,
          retail: { totalMinor: 0n, transactions: 0 }, wholesale: { totalMinor: 0n, transactions: 0 },
          discountsMinor: 0n, returnsMinor: 0n, refundsMinor: 0n, netSalesMinor: 0n,
          cogsMinor: 0n, grossProfitMinor: 0n, returnTransactions: 0,
        },
        daily: [], paymentMethods: [], refundMethods: [], salesByUser: [],
      })
      if (name === 'getAlerts') return () => []
      if (name === 'countConnectedDevices') return () => 0
      if (name === 'listProducts') return () => []
      if (name === 'pendingApprovalCount') return () => 0
      // Named rather than left to the catch-all below, which answers *any* unknown method with an empty array. That is a
      // plausible-looking lie about every method this double has not been told about, and a new optional method would
      // silently be given one. Here it tells the truth about the case the dashboard has to survive: a Server whose host
      // has no audit service, which is what an Admin upgrading from an older build is talking to.
      if (name === 'getAuditSummary') return undefined
      return () => []
    },
  })
}
