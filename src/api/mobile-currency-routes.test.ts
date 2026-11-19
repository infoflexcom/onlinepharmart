import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { getCurrency } from '../currency/catalog'
import { defaultDisplayOptions } from '../currency/money'
import { fromMinor } from '../currency/parse'
import { migrateDatabase } from '../db/migrate'
import { SQLiteShopRepository } from '../db/sqlite-shop-repository'
import { SQLiteUserRepository } from '../db/sqlite-user-repository'
import { ShopService } from '../services/shop-service'
import { ProductInventoryService } from '../services/product-inventory-service'
import { PointOfSaleService } from '../services/point-of-sale-service'
import { ReturnService } from '../services/return-service'
import { AccountingReportService } from '../services/accounting-report-service'
import { ApprovalQueueService } from '../services/approval-queue-service'
import { UserService } from '../services/user-service'
import { createMobileAdminSurface } from './mobile-admin-surface'
import { createHostApi } from './server'
import type { AuthenticatedPrincipal } from '../services/permissions'
import type { PublicUser } from '../shared/auth/types'
import type { LicenseSummary } from '../shared/license/types'
import type { ProductDraft } from '../shared/inventory/types'
import { defaultPermissions } from '../shared/auth/policy'
import type { FastifyInstance } from 'fastify'
import { formatMobileMoney, parseMoneyInput, shopCurrencyContext } from '../../mobile/src/money'

/**
 * The Admin phone has to show and accept money in whatever currency the shop actually sells in, on the real
 * route stack — not just in the money module's own unit tests.
 *
 * Each case builds a real database in the chosen currency, sells a real product through the real POS service,
 * then reads the result back over the real HTTP routes the phone calls, and finally types the amount back into
 * the phone's own price parser. That closes the loop the brief cares about: what the host stored, what the route
 * put on the wire, what the phone draws, and what the phone will accept are the same number.
 *
 * The four currencies are chosen because they are the four genuinely different shapes:
 * NGN (2 decimals, symbol before), USD (2 decimals, symbol before, a different symbol), JPY (0 decimals, so no
 * decimal point may appear at all) and KWD (3 decimals, symbol after).
 */

/**
 * Anchored to the real clock, because one route (`dashboard`) deliberately reads `new Date()` to decide what
 * "today" means — that is the behaviour a shop wants — while the rest of the stack is driven by the injected
 * clock. Seeding the sale on a frozen past date would make the two disagree for reasons that have nothing to do
 * with money. `TODAY` is computed from the same instant so every assertion names the day the sale really landed.
 */
const NOW = Date.now()
const TODAY = new Date(NOW)
const TODAY_ISO = [
  TODAY.getFullYear(),
  String(TODAY.getMonth() + 1).padStart(2, '0'),
  String(TODAY.getDate()).padStart(2, '0'),
].join('-')
const PASSWORD = 'cellar-door-99'

const LICENCE: LicenseSummary = {
  status: 'active', canUse: true, licenseId: `phone-money`, source: 'online', edition: 'BOTH',
  startsAt: null, endsAt: null, defaultCurrencyCode: null, lockCurrency: false,
  features: { mobileLan: true, mobileInternet: false }, adminPhoneLimit: 2, graceDays: 0,
  lastOnlineCheck: null, reportedToPortal: true, vendorConfigured: false,
  maximumOnsitePeriodYears: null, licenseServerUrl: null, message: 'active',
}

/** Retail 20 units, wholesale 18 units, cost 10 units — in *major* units of whichever currency this is. */
function draftFor(currencyCode: string): ProductDraft {
  const currency = getCurrency(currencyCode)!
  const m = (major: string) => fromMinor(BigInt(Math.round(Number(major) * 10 ** currency.decimalPlaces)), currency)
  return {
    sku: `PHONE-${currencyCode}`, name: 'Vitamin C 1000mg', brand: 'Harbor', description: '',
    barcode: '', additionalBarcodes: [], category: 'Vitamins', subCategory: '', department: 'Health',
    shelfLocation: 'A-01', unit: 'pack', packSizeUnits: 1,
    cost: m('10'), retailPrice: m('20'), wholesalePrice: m('18'),
    wholesaleMinimumQuantity: '1', reorderLevel: '2', genericName: '', prescriptionRequired: false,
    weighedItem: false, pluCode: '', pricePerKg: '', expiryTracking: false, variants: [], isActive: true,
  }
}

interface Shop {
  adminId: string
  database: Database.Database
  surface: ReturnType<typeof createMobileAdminSurface>
  server: FastifyInstance
  productId: string
  close: () => Promise<void>
}

const shops: Shop[] = []
afterEach(async () => {
  for (const shop of shops.splice(0)) await shop.close()
})

async function createShop(currencyCode: string): Promise<Shop> {
  const database = new Database(':memory:')
  migrateDatabase(database)
  const repository = new SQLiteShopRepository(database, false)
  const currency = getCurrency(currencyCode)!
  repository.saveSettings({
    ...repository.readSettings(),
    profile: { name: 'Harbor Health Pharmacy', address: '14 Marina Road, Lagos', phone: '+234 1 555 0100' },
    currency, display: defaultDisplayOptions(currency), setupComplete: true, currencyConfirmed: true,
  })
  const users = new SQLiteUserRepository(database)
  const userService = new UserService(users, repository, () => new Date(NOW), (() => { let n = 0; return () => `pm-${++n}` })())
  const seedAdmin: PublicUser = {
    id: 'seed', fullName: 'Seed Admin', username: 'seed', role: 'ADMIN', isActive: true, isLocked: false,
    permissions: defaultPermissions('ADMIN'),
  }
  const createdAdmin = await userService.createUser(seedAdmin, {
    fullName: 'Tunde Bakare', username: 'admin', password: PASSWORD, confirmPassword: PASSWORD,
    role: 'ADMIN', permissions: defaultPermissions('ADMIN'),
  }, 'BOTH')

  const shopService = new ShopService(repository, { deviceName: 'PHONE-MONEY-PC', ipAddress: null }, () => new Date(NOW))
  const options = { now: () => NOW }
  const inventory = new ProductInventoryService(database, repository, { ...options, deviceName: 'PHONE-MONEY-PC' })
  const pointOfSale = new PointOfSaleService(database, repository, { ...options, workstation: 'PHONE-MONEY-PC' })
  const returns = new ReturnService(database, repository, { ...options, workstation: 'PHONE-MONEY-PC' })
  const reports = new AccountingReportService(database, repository, options)
  const approvals = new ApprovalQueueService(database, () => new Date(NOW))

  // The real row's id, not a hard-coded one: purchases and audits reference `users.id` with a foreign key.
  const ADMIN_ID = createdAdmin.id
  const adminActor: PublicUser = createdAdmin
  let product = inventory.createProduct(draftFor(currencyCode), adminActor, 'BOTH')
  product = inventory.receiveStock({
    productId: product.id, expectedProductVersion: product.rowVersion, expectedStockVersion: product.stockVersion,
    quantity: '10', quantityUnit: 'unit', unitCost: fromMinor(10n * 10n ** BigInt(currency.decimalPlaces), currency),
    supplierName: 'Coastal Medical Supplies', supplierReference: `PHONE-${currencyCode}`,
    note: 'Phone money test', batchNumber: '', expiryDate: '',
  }, adminActor, 'BOTH').product

  // One real sale: two packs at the retail price, paid in cash.
  const receipt = pointOfSale.completeSale({
    idempotencyKey: `phone-money-${currencyCode}`, saleType: 'RETAIL',
    items: [{ productId: product.id, quantity: '2' }],
    payments: [{ method: 'CASH', amount: fromMinor(40n * 10n ** BigInt(currency.decimalPlaces), currency) }],
  }, adminActor, 'BOTH').receipt

  const surface = createMobileAdminSurface({
    database, shop: shopService, license: { getSnapshot: () => LICENCE } as never,
    inventory, pointOfSale, users: userService, reports, approvals, returns,
    countConnectedDevices: () => 1, listPairedDevices: () => [], revokePairedDevice: () => undefined,
  })

  const principal: AuthenticatedPrincipal = { userId: ADMIN_ID, username: 'admin', role: 'ADMIN' }
  const server = await createHostApi({
    service: { getSettings: () => repository.readSettings(), recordDeniedAccess: () => undefined },
    license: { getSnapshot: () => LICENCE } as never,
    authenticate: async () => principal,
    mobileAdmin: { service: surface.service },
    localNetworkOnly: false, tls: {}, now: () => NOW,
  })
  void receipt

  return {
    adminId: ADMIN_ID, database, surface, server, productId: product.id,
    close: async (): Promise<void> => { await server.close(); database.close() },
  }
}

const CASES = [
  { code: 'NGN', decimals: 2, saleMinor: 4000n, unitMinor: 2000n },
  { code: 'USD', decimals: 2, saleMinor: 4000n, unitMinor: 2000n },
  { code: 'JPY', decimals: 0, saleMinor: 40n, unitMinor: 20n },
  { code: 'KWD', decimals: 3, saleMinor: 40_000n, unitMinor: 20_000n },
] as const

describe.each(CASES)('the Admin phone in $code', ({ code, decimals, saleMinor, unitMinor }) => {
  const currency = getCurrency(code)!

  it('serves dashboard, product, sale and report amounts in integer minor units the phone can draw', async () => {
    const shop = await createShop(code)
    shops.push(shop)
    const auth = { headers: { authorization: 'Bearer phone-token' } }

    const dashboard = await shop.server.inject({ method: 'GET', url: '/api/v1/mobile/admin/dashboard', ...auth })
    expect(dashboard.statusCode, `dashboard said ${dashboard.body}`).toBe(200)
    const dashboardBody = dashboard.json()
    expect(dashboardBody.header.currency.code).toBe(code)
    expect(dashboardBody.header.currency.decimalPlaces).toBe(decimals)
    expect(dashboardBody.today.date).toBe(TODAY_ISO)
    // The money on the wire is a decimal string of minor units, never a float and never a major amount.
    expect(dashboardBody.today.totalSalesMinor).toBe(saleMinor.toString())
    expect(dashboardBody.today.transactions).toBe(1)

    const product = await shop.server.inject({ method: 'GET', url: `/api/v1/mobile/admin/products/${shop.productId}`, ...auth })
    expect(product.statusCode).toBe(200)
    expect(product.json().product.retailPriceMinor).toBe(unitMinor.toString())
    // 10 received, 2 sold.
    expect(product.json().product.quantityMilli).toBe('8000')

    const sales = await shop.server.inject({ method: 'GET', url: '/api/v1/mobile/admin/sales', ...auth })
    expect(sales.statusCode).toBe(200)
    expect(sales.json().sales[0].totalMinor).toBe(saleMinor.toString())
    expect(sales.json().sales[0].currencyCode).toBe(code)

    const report = await shop.server.inject({ method: 'GET', url: `/api/v1/mobile/admin/reports?period=DAY&date=${TODAY_ISO}`, ...auth })
    expect(report.statusCode, `report said ${report.body}`).toBe(200)
    expect(report.json().header.currency.code).toBe(code)
    expect(report.json().summary.totalSalesMinor).toBe(saleMinor.toString())
  })

  it('draws those amounts in the shop currency and accepts them back typed on the phone', async () => {
    const shop = await createShop(code)
    shops.push(shop)
    const settings = shop.surface.service.dashboard({ userId: shop.adminId, username: 'admin', role: 'ADMIN' })
    const context = shopCurrencyContext(settings.header.currency, settings.header.display)

    // What the phone draws for the sale and for one unit.
    const shown = formatMobileMoney(saleMinor.toString(), context)
    expect(shown, code).toContain(currency.symbol)
    expect(shown, code).toContain((saleMinor / 10n ** BigInt(decimals)).toString().replace(/\B(?=(\d{3})+(?!\d))/gu, (m) => m))
    if (decimals === 0) {
      // A 0-decimal currency must not sprout a decimal point or a ",00".
      expect(shown, `${code}: ${shown}`).not.toMatch(/[.,]\d/u)
    }
    if (decimals === 3) {
      // Three decimals really are shown, not rounded away to two.
      expect(shown.replace(/\D/gu, '').endsWith('000'), `${code}: ${shown}`).toBe(true)
    }

    // What the phone will accept when the Admin retypes that same amount into a price field.
    const typed = parseMoneyInput(shown, context)
    expect(typed, `${code}: typing back “${shown}”`).toEqual({ ok: true, minor: saleMinor.toString() })

    // A plain decimal typed without a symbol parses to the same minor units.
    const plain = parseMoneyInput(fromMinor(saleMinor, currency), context)
    expect(plain, code).toEqual({ ok: true, minor: saleMinor.toString() })

    // And a currency's own precision is enforced rather than silently rounded.
    const tooPrecise = decimals === 0 ? '1.5' : decimals === 2 ? '1.005' : '1.0005'
    const refused = parseMoneyInput(tooPrecise, context)
    expect(refused.ok, `${code} must refuse ${tooPrecise}`).toBe(false)
  })
})
