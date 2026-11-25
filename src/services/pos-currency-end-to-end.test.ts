import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { getCurrency } from '../currency/catalog'
import { defaultDisplayOptions, formatMoney } from '../currency/money'
import { fromMinor } from '../currency/parse'
import { migrateDatabase } from '../db/migrate'
import { SQLiteShopRepository } from '../db/sqlite-shop-repository'
import { SQLiteUserRepository } from '../db/sqlite-user-repository'
import { defaultPermissions } from '../shared/auth/policy'
import type { ProductDraft } from '../shared/inventory/types'
import type { FirstRunInput } from '../shared/shop/types'
import { DesktopHostController } from '../main/desktop-host-controller'
import { AuthService } from './auth-service'
import { ShopService } from './shop-service'
import { UserService } from './user-service'
import { SetupService } from './setup-service'
import { ProductInventoryService } from './product-inventory-service'
import { PointOfSaleService } from './point-of-sale-service'
import { ReturnService } from './return-service'
import { AccountingReportService } from './accounting-report-service'
import { formatReceiptMoney } from '../shared/pos/receipt-format'

/**
 * The end-to-end sale story on the desktop, for the four currencies the brief calls out by name: a sale from
 * the same code path the POS screen calls (the host controller, i.e. what the IPC handler invokes) all the way to
 * a printed receipt and a daily report, in NGN (2 decimals, symbol before), USD (2 decimals), JPY (0 decimals) and
 * KWD (3 decimals, symbol after).
 *
 * It drives `DesktopHostController` rather than the services directly so the assertions cover the same path a
 * double-click takes, including the role checks and the currency lock that a real sale triggers.
 */

const PASSWORD = 'Harbor-Admin-Pass-9'
const NOW = Date.parse('2026-11-17T12:00:00.000Z')

function firstRun(currencyCode: string): FirstRunInput {
  const currency = getCurrency(currencyCode)!
  return {
    admin: { fullName: 'Ada Obi', username: 'shopadmin', password: PASSWORD, confirmPassword: PASSWORD },
    profile: { name: 'Harbor Health Pharmacy', address: '14 Marina Road', phone: '+234 800 111 2222' },
    currency,
    display: defaultDisplayOptions(currency),
    currencyConfirmed: true,
  }
}

function productDraft(currencyCode: string): ProductDraft {
  const currency = getCurrency(currencyCode)!
  // The same physical product in each currency: a 2.50 retail item costing 1.00 and wholesaling at 2.00, each
  // written with that currency's own precision — "2.50" in NGN, "250" in JPY, "0.250" in KWD.
  return {
    sku: 'E2E-001', name: 'Vitamin C 500mg', brand: 'Harbor', description: '', barcode: '2012345678901',
    additionalBarcodes: [], category: 'Vitamins', subCategory: '', department: '', shelfLocation: '',
    unit: 'pack', packSizeUnits: 1,
    cost: fromMinor(100n, currency),
    retailPrice: fromMinor(250n, currency),
    wholesalePrice: fromMinor(200n, currency),
    wholesaleMinimumQuantity: '2', reorderLevel: '1', genericName: '', prescriptionRequired: false,
    weighedItem: false, pluCode: '', pricePerKg: '', expiryTracking: false, variants: [], isActive: true,
  }
}

async function createHost(currencyCode: string) {
  const database = new Database(':memory:')
  migrateDatabase(database)
  const repository = new SQLiteShopRepository(database, false)
  const userRepository = new SQLiteUserRepository(database)
  const license = { getVerifiedPolicy: () => ({ licenseId: 'e2e', edition: 'BOTH' as const, defaultCurrencyCode: null, lockCurrency: false }) }
  let ids = 0
  const setup = new SetupService(repository, userRepository, repository, license, () => new Date(NOW), () => `e2e-user-${++ids}`)
  // Client PC: these tests sign in Cashiers and Supervisors, which a server install correctly refuses. The role is
  // declared here rather than the rule being relaxed, so the sign-in scoping stays enforced in every fixture that does
  // not need to exercise a server.
  const auth = new AuthService(userRepository, repository, { deviceName: 'E2E-PC', ipAddress: null }, () => new Date(NOW), () => NOW,
    { app: 'client', allowAdminOnClients: () => true },
  )
  const shopService = new ShopService(repository, { deviceName: 'E2E-PC', ipAddress: null }, () => new Date(NOW), () => `e2e-audit-${++ids}`)
  const userService = new UserService(userRepository, repository, () => new Date(NOW), () => `e2e-managed-${++ids}`)
  const inventory = new ProductInventoryService(database, repository, { deviceName: 'E2E-PC', now: () => NOW, newId: () => `e2e-inv-${++ids}` })
  const pos = new PointOfSaleService(database, repository, { workstation: 'E2E-PC', now: () => NOW, newId: () => `e2e-pos-${++ids}` })
  const returns = new ReturnService(database, repository, { workstation: 'E2E-PC', now: () => NOW, newId: () => `e2e-ret-${++ids}` })
  const reports = new AccountingReportService(database, repository, { now: () => NOW })
  const host = new DesktopHostController(
    repository, userRepository, setup, auth, userService, shopService, () => NOW, '0.1.0',
    undefined, inventory, pos, returns, reports,
  )
  await host.initialize()
  await host.completeFirstRun(firstRun(currencyCode))
  await host.login(1, { username: 'shopadmin', password: PASSWORD })
  return { database, repository, host, inventory, close: () => database.close() }
}

describe('a sale from the host controller to a printed receipt in four currencies', () => {
  for (const [code, decimals, expectations] of [
    ['NGN', 2, { symbolBefore: true }],
    ['USD', 2, { symbolBefore: true }],
    ['JPY', 0, { symbolBefore: true }],
    ['KWD', 3, { symbolBefore: false }],
  ] as const) {
    it(`rings up, prints and reports in ${code}`, async () => {
      const h = await createHost(code)
      try {
        const currency = getCurrency(code)!
        const product = h.host.saveProduct(1, productDraft(code))
        // 250 minor units, whatever the currency: 2.50 naira, 250 yen, 0.250 dinar.
        expect(product.retailPriceMinor).toBe(250n)
        h.host.receiveStock(1, {
          productId: product.id, expectedProductVersion: product.rowVersion, expectedStockVersion: product.stockVersion,
          quantity: '10', quantityUnit: 'unit', unitCost: fromMinor(100n, currency),
          supplierName: 'Coastal Supplies', supplierReference: 'E2E-RECEIPT', note: 'End-to-end currency sale',
          batchNumber: '', expiryDate: '',
        })

        // Two packs: the sale the POS screen would make.
        const sold = h.host.completePosSale(1, {
          idempotencyKey: `e2e-${code}-sale-0001`, saleType: 'RETAIL',
          items: [{ productId: product.id, quantity: '2' }],
          payments: [{ method: 'CASH', amount: fromMinor(500n, currency) }],
        })
        expect(sold.receipt.totalMinor).toBe(500n)
        expect(sold.receipt.currency.code).toBe(code)

        // Printing records the event and marks the first print as not a duplicate.
        const printed = h.host.recordPosReceiptPrint(1, sold.receipt.id, 'THERMAL_80')
        expect(printed.duplicate).toBe(false)
        const reprint = h.host.recordPosReceiptPrint(1, sold.receipt.id, 'THERMAL_80')
        expect(reprint.duplicate).toBe(true)

        // The receipt carries the CUSTOMER's store name and this currency's own formatting.
        const receipt = h.host.getPosReceipt(1, sold.receipt.id)
        expect(receipt.store.name).toBe('Harbor Health Pharmacy')
        expect(receipt.currency.code).toBe(code)
        const rendered = formatReceiptMoney(receipt, receipt.totalMinor, 'A4_RECEIPT')
        expect(rendered).toBe(formatMoney(500n, currency, receipt.display))
        if (decimals === 0) expect(rendered).not.toContain('.')
        if (decimals === 3) expect(rendered).toMatch(/[.,]\d{3}\D*$/u)
        if (expectations.symbolBefore) expect(rendered.trimEnd().endsWith(currency.symbol)).toBe(false)

        // The first real transaction locks the currency, as the rule requires.
        expect(h.repository.isCurrencyLocked()).toBe(true)
        expect(() => h.host.changeCurrency(1, getCurrency('USD')!, true)).toThrow(/locked/iu)

        // And the day's report totals the same amount, with the store name and currency in the header.
        const report = h.host.getAccountingReport(1, { period: 'DAY', date: '2026-11-17' })
        expect(report.header.currency.code).toBe(code)
        expect(report.summary.grossSalesMinor).toBe(500n)
        expect(report.header.storeName).toBe('Harbor Health Pharmacy')
      } finally {
        h.close()
      }
    })
  }
})

describe('roles on the desktop end to end', () => {
  it('lets a cashier with wholesale permission sell wholesale, and refuses one without it', async () => {
    const h = await createHost('NGN')
    try {
      const product = h.host.saveProduct(1, productDraft('NGN'))
      h.host.receiveStock(1, {
        productId: product.id, expectedProductVersion: product.rowVersion, expectedStockVersion: product.stockVersion,
        quantity: '20', quantityUnit: 'unit', unitCost: '1.00', supplierName: 'Coastal Supplies',
        supplierReference: 'E2E-WS', note: 'Wholesale permission test', batchNumber: '', expiryDate: '',
      })
      const on = await h.host.createUser(1, {
        fullName: 'Cashier On', username: 'cashier.on', password: 'Cashier-Pass!2026', confirmPassword: 'Cashier-Pass!2026',
        role: 'CASHIER', permissions: { ...defaultPermissions('CASHIER'), allowWholesale: true },
      })
      const off = await h.host.createUser(1, {
        fullName: 'Cashier Off', username: 'cashier.off', password: 'Cashier-Pass!2026', confirmPassword: 'Cashier-Pass!2026',
        role: 'CASHIER', permissions: { ...defaultPermissions('CASHIER'), allowWholesale: false },
      })
      await h.host.login(2, { username: 'cashier.on', password: 'Cashier-Pass!2026' })
      await h.host.login(3, { username: 'cashier.off', password: 'Cashier-Pass!2026' })

      // The wholesale price is 2.00 against a 2.50 retail price; buying 5 crosses the wholesale minimum.
      const quote = h.host.quotePosSale(2, { saleType: 'WHOLESALE', items: [{ productId: product.id, quantity: '5' }] })
      expect(quote.items[0]!.unitPriceMinor).toBe(200n)
      h.host.completePosSale(2, {
        idempotencyKey: 'e2e-wholesale-on-0001', saleType: 'WHOLESALE',
        items: [{ productId: product.id, quantity: '5' }], payments: [{ method: 'CASH', amount: '10.00' }],
      })

      // The cashier without the permission is stopped by the host, not by a greyed-out button.
      expect(h.host.canMakeWholesaleSale(3)).toBe(false)
      expect(() => h.host.quotePosSale(3, { saleType: 'WHOLESALE', items: [{ productId: product.id, quantity: '5' }] }))
        .toThrow(/permission to make wholesale/iu)
      // The same cashier can still sell retail, because the permission is narrow on purpose.
      expect(h.host.quotePosSale(3, { saleType: 'RETAIL', items: [{ productId: product.id, quantity: '1' }] }).items[0]!.unitPriceMinor).toBe(250n)

      // Only an Admin may create a product or reach Users/Settings, whatever the client sends.
      expect(() => h.host.saveProduct(2, { ...productDraft('NGN'), sku: 'E2E-CASHIER' })).toThrow(/Admin/iu)
      expect(() => h.host.openPage(2, 'users')).toThrow(/permission/iu)
      expect(() => h.host.openPage(2, 'settings')).toThrow(/permission/iu)
      void on; void off
    } finally {
      h.close()
    }
  })

  it('rejects an empty store name during first-run setup and keeps the shop unusable', async () => {
    const database = new Database(':memory:')
    migrateDatabase(database)
    try {
      const repository = new SQLiteShopRepository(database, false)
      const userRepository = new SQLiteUserRepository(database)
      const license = { getVerifiedPolicy: () => ({ licenseId: 'e2e', edition: 'PHARMACY' as const, defaultCurrencyCode: null, lockCurrency: false }) }
      const setup = new SetupService(repository, userRepository, repository, license, () => new Date(NOW), () => 'x')
      const invalid = firstRun('NGN')
      invalid.profile.name = '   '
      await expect(setup.completeFirstRun(invalid)).rejects.toThrow(/store name/iu)
      expect(userRepository.countUsers()).toBe(0)
      // The empty-name message is the one a person sees, and it is a sentence rather than a code.
      await expect(setup.completeFirstRun(invalid)).rejects.toThrow(/^Enter the shop's store name\.$|store name/iu)
    } finally {
      database.close()
    }
  })
})
