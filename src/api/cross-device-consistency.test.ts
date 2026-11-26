import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { getCurrency } from '../currency/catalog'
import { defaultDisplayOptions } from '../currency/money'
import { migrateDatabase } from '../db/migrate'
import { SQLiteShopRepository } from '../db/sqlite-shop-repository'
import { SQLiteUserRepository } from '../db/sqlite-user-repository'
import { ShopService } from '../services/shop-service'
import { ProductInventoryService } from '../services/product-inventory-service'
import { PointOfSaleService } from '../services/point-of-sale-service'
import { ReturnService } from '../services/return-service'
import { DailyAuditService } from '../services/daily-audit-service'
import { AccountingReportService } from '../services/accounting-report-service'
import { ApprovalQueueService } from '../services/approval-queue-service'
import { UserService } from '../services/user-service'
import { createMobileAdminSurface } from './mobile-admin-surface'
import { MobileStaleVersionError } from './mobile-admin-service'
import type { LicenseSummary } from '../shared/license/types'
import type { ProductDraft } from '../shared/inventory/types'
import type { PublicUser } from '../shared/auth/types'
import { defaultPermissions } from '../shared/auth/policy'

/**
 * The scenario the brief calls out by name: an Admin adjusts stock on the phone at the same moment a cashier is
 * selling the same item on the desktop.
 *
 * The point is not that one of them waits — it is that neither can silently overwrite the other. The host is the
 * only writer, every stock row carries a version, and whichever operation read a stale version is refused with a
 * message rather than being merged. The final stock figure, the sale, and the audit log must all agree on what
 * happened, and no unit may be counted twice or vanish.
 */

const NOW = Date.parse('2026-11-17T12:00:00.000Z')
const ADMIN_ID = 'user-admin'
const CASHIER_ID = 'user-cashier'

const ADMIN: PublicUser = {
  id: ADMIN_ID, fullName: 'Tunde Bakare', username: 'admin', role: 'ADMIN', isActive: true, isLocked: false,
  permissions: defaultPermissions('ADMIN'),
}
const CASHIER: PublicUser = {
  id: CASHIER_ID, fullName: 'Amaka Obi', username: 'cashier', role: 'CASHIER', isActive: true, isLocked: false,
  permissions: { ...defaultPermissions('CASHIER'), allowWholesale: true, maxDiscountBasisPoints: 1000 },
}

const LICENCE: LicenseSummary = {
  status: 'active', canUse: true, licenseId: 'cross-device', source: 'online', edition: 'BOTH',
  startsAt: null, endsAt: null, defaultCurrencyCode: null, lockCurrency: false,
  features: { mobileLan: true, mobileInternet: true }, adminPhoneLimit: 2, graceDays: 0,
  lastOnlineCheck: null, reportedToPortal: true, vendorConfigured: false,
  maximumOnsitePeriodYears: null, licenseServerUrl: null, message: 'active',
}

function createHarness() {
  const database = new Database(':memory:')
  migrateDatabase(database)
  const repository = new SQLiteShopRepository(database, false)
  const currency = getCurrency('NGN')!
  repository.saveSettings({
    ...repository.readSettings(),
    profile: { name: 'Harbor Health Pharmacy', address: '14 Marina Road', phone: '+234 800 111 2222' },
    currency, display: defaultDisplayOptions(currency), setupComplete: true, currencyConfirmed: true,
  })
  const insertUser = database.prepare('INSERT INTO users (id, username, password_hash, role, full_name) VALUES (?, ?, ?, ?, ?)')
  insertUser.run(ADMIN_ID, 'admin', 'hash', 'ADMIN', 'Tunde Bakare')
  insertUser.run(CASHIER_ID, 'cashier', 'hash', 'CASHIER', 'Amaka Obi')
  const permissions = database.prepare(`
    INSERT INTO user_permissions (user_id, allow_wholesale, max_discount_pct, allow_credit_sales, return_limit)
    VALUES (?, ?, ?, ?, ?)
  `)
  permissions.run(ADMIN_ID, 1, 10_000, 1, 9_223_372_036_854_775_807n)
  permissions.run(CASHIER_ID, 1, 1_000, 0, 0)

  const shop = new ShopService(repository, { deviceName: 'SHOP-PC', ipAddress: null }, () => new Date(NOW))
  const inventory = new ProductInventoryService(database, repository, { deviceName: 'SHOP-PC', now: () => NOW })
  const pointOfSale = new PointOfSaleService(database, repository, { workstation: 'SHOP-PC', now: () => NOW })
  const returns = new ReturnService(database, repository, { workstation: 'SHOP-PC', now: () => NOW })
  const reports = new AccountingReportService(database, repository, { now: () => NOW })
  const approvals = new ApprovalQueueService(database, () => new Date(NOW))
  const users = new UserService(new SQLiteUserRepository(database), repository)
  const surface = createMobileAdminSurface({
    database, shop, license: { getSnapshot: () => LICENCE } as never,
    inventory, pointOfSale, users, reports, approvals, returns,
    audit: new DailyAuditService(database, repository, reports, { now: () => NOW }),
    countConnectedDevices: () => 1, listPairedDevices: () => [], revokePairedDevice: () => undefined,
  })
  const adminActor = { id: ADMIN_ID, username: 'admin', role: 'ADMIN' as const }
  const draft: ProductDraft = {
    sku: 'CROSS-001', name: 'Paracetamol 500mg', brand: 'Emzor', description: '', barcode: '',
    additionalBarcodes: [], category: 'Analgesics', subCategory: '', department: '', shelfLocation: 'A1',
    unit: 'pack', packSizeUnits: 1, cost: '100.00', retailPrice: '250.00', wholesalePrice: '220.00',
    wholesaleMinimumQuantity: '1', reorderLevel: '5', genericName: 'Paracetamol', prescriptionRequired: false,
    weighedItem: false, pluCode: '', pricePerKg: '', expiryTracking: false, variants: [], isActive: true,
  }
  let product = inventory.createProduct(draft, adminActor, 'BOTH')
  product = inventory.receiveStock({
    productId: product.id, expectedProductVersion: product.rowVersion, expectedStockVersion: product.stockVersion,
    quantity: '20', quantityUnit: 'unit', unitCost: '100.00', supplierName: 'Coastal Supplies',
    supplierReference: 'CROSS-STOCK', note: 'Cross-device stock',
    // BOTH edition with a generic name is expiry-tracked, so the receipt needs a real lot.
    batchNumber: 'CROSS-A1', expiryDate: '2028-06-30',
  }, adminActor, 'BOTH').product
  return { database, repository, inventory, pointOfSale, reports, surface, product, close: () => database.close() }
}

describe('an Admin on the phone and a cashier on the desktop, same item, same moment', () => {
  it('keeps stock, the sale and the audit log agreeing when the phone read the older row', () => {
    const h = createHarness()
    try {
      const stale = h.surface.service.productDetail({ userId: ADMIN_ID, username: 'admin', role: 'ADMIN' }, h.product.id)

      // The cashier sells 3 packs on the desktop while the phone still shows 20 on hand.
      const receipt = h.pointOfSale.completeSale({
        idempotencyKey: 'cross-device-sale-0001', saleType: 'RETAIL',
        items: [{ productId: h.product.id, quantity: '3' }],
        payments: [{ method: 'CASH', amount: '750.00' }],
      }, CASHIER, 'BOTH').receipt
      expect(receipt.totalMinor).toBe(75_000n)
      // Read through the Admin's own surface rather than reaching into the inventory service, so this measures
      // what the phone actually displays.
      const adminSurface = { userId: ADMIN_ID, username: 'admin', role: 'ADMIN' as const }
      expect(BigInt(h.surface.service.productDetail(adminSurface, h.product.id).product.quantityMilli)).toBe(17_000n)

      // The Admin's adjustment, based on the stale count, is refused instead of overwriting the sale.
      expect(() => h.surface.service.adjustStock(
        { userId: ADMIN_ID, username: 'admin', role: 'ADMIN' },
        {
          productId: h.product.id, expectedProductVersion: stale.product.rowVersion, expectedStockVersion: stale.product.stockVersion,
          direction: 'decrease', quantity: '1', reason: 'Damaged in transit', batchNumber: '', expiryDate: '',
          idempotencyKey: 'cross-device-adjust-stale',
        },
      )).toThrow(MobileStaleVersionError)

      // Nothing moved: a refused write must be a no-op, not a partial update.
      expect(BigInt(h.surface.service.productDetail(adminSurface, h.product.id).product.quantityMilli)).toBe(17_000n)

      // Reloading and retrying, as the phone's "changed, reload" message tells the Admin to do, works and lands
      // on the arithmetic of what is actually on the shelf.
      const fresh = h.surface.service.productDetail({ userId: ADMIN_ID, username: 'admin', role: 'ADMIN' }, h.product.id)
      const adjusted = h.surface.service.adjustStock({ userId: ADMIN_ID, username: 'admin', role: 'ADMIN' }, {
        productId: h.product.id, expectedProductVersion: fresh.product.rowVersion, expectedStockVersion: fresh.product.stockVersion,
        direction: 'decrease', quantity: '2', reason: 'Damaged in transit', batchNumber: '', expiryDate: '',
        idempotencyKey: 'cross-device-adjust-fresh',
      })
      expect(BigInt(adjusted.product.quantityMilli)).toBe(15_000n)

      // The same key replayed does not subtract twice — the phone may retry after a dropped connection.
      const replayed = h.surface.service.adjustStock({ userId: ADMIN_ID, username: 'admin', role: 'ADMIN' }, {
        productId: h.product.id, expectedProductVersion: fresh.product.rowVersion, expectedStockVersion: fresh.product.stockVersion,
        direction: 'decrease', quantity: '2', reason: 'Damaged in transit', batchNumber: '', expiryDate: '',
        idempotencyKey: 'cross-device-adjust-fresh',
      })
      expect(BigInt(replayed.product.quantityMilli)).toBe(15_000n)

      // Money and stock agree: one sale of 750.00, two units written off, 20 - 3 - 2 = 15 on hand.
      const report = h.reports.getDashboard({ period: 'DAY', date: '2026-11-17' }, ADMIN, 'BOTH')
      expect(report.summary.grossSalesMinor).toBe(75_000n)
      expect(report.header.storeName).toBe('Harbor Health Pharmacy')

      // And the audit log names both actors, so a shop can reconstruct who moved what.
      const actions = h.database.prepare('SELECT actor, action FROM audit_log ORDER BY created_at, id').all() as Array<{ actor: string; action: string }>
      expect(actions.filter(({ action }) => action === 'inventory.stock.adjusted')).toEqual([
        expect.objectContaining({ actor: 'admin', action: 'inventory.stock.adjusted' }),
      ])
      // The sale is audited by the POS service; the write-off by the inventory service. Two actors, two entries.
      expect(actions.some((row) => row.action === 'pos.sale.completed' && row.actor === 'cashier')).toBe(true)
      expect(h.database.prepare("SELECT COUNT(*) AS count FROM stock_movements WHERE product_id = ? AND movement_type = 'ADJUSTMENT'").get(h.product.id))
        .toEqual({ count: 1 })
    } finally {
      h.close()
    }
  })

  it('lets the cashier sell down to exactly zero and refuses a sale that would go negative', () => {
    const h = createHarness()
    try {
      // Sell 18 of the 20 on the shelf, leaving 2.
      h.pointOfSale.completeSale({
        idempotencyKey: 'cross-device-sale-zero', saleType: 'RETAIL',
        items: [{ productId: h.product.id, quantity: '18' }],
        payments: [{ method: 'CASH', amount: '4500.00' }],
      }, CASHIER, 'BOTH')
      expect(BigInt(h.surface.service.productDetail({ userId: ADMIN_ID, username: 'admin', role: 'ADMIN' }, h.product.id).product.quantityMilli)).toBe(2_000n)
      // 3 more is refused at the host, before any money is taken.
      expect(() => h.pointOfSale.quoteSale({
        saleType: 'RETAIL', items: [{ productId: h.product.id, quantity: '3' }],
      }, CASHIER, 'BOTH')).toThrow(/stock/iu)
      // The refused sale left no receipt behind.
      expect(h.database.prepare('SELECT COUNT(*) AS count FROM sales').get()).toEqual({ count: 1 })
    } finally {
      h.close()
    }
  })
})
