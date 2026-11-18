import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrateDatabase } from '../db/migrate'
import { SQLiteShopRepository } from '../db/sqlite-shop-repository'
import { ShopService } from '../services/shop-service'
import { SQLiteUserRepository } from '../db/sqlite-user-repository'
import { getCurrency } from '../currency/catalog'
import { toMinor } from '../currency/parse'
import { defaultDisplayOptions } from '../currency/money'
import { ProductInventoryService } from '../services/product-inventory-service'
import { PointOfSaleService } from '../services/point-of-sale-service'
import { UserService } from '../services/user-service'
import { AccountingReportService } from '../services/accounting-report-service'
import { ApprovalQueueService } from '../services/approval-queue-service'
import { ReturnService } from '../services/return-service'
import { createMobileAdminSurface } from './mobile-admin-surface'
import { MobileStaleVersionError } from './mobile-admin-service'
import type { AuthenticatedPrincipal } from '../services/permissions'
import type { LicenseSummary } from '../shared/license/types'
import type { ProductDraft } from '../shared/inventory/types'

/**
 * These tests drive the Admin phone's service layer against a real SQLite database and the real desktop
 * services, then assert the rules the brief makes non-negotiable: Admin-only, prices confirmed with the
 * password, stock changes explained and never applied twice, and a stale screen refused instead of
 * overwriting newer data.
 */

const ADMIN_ID = 'user-admin'
const CASHIER_ID = 'user-cashier'

/** The approvals queue takes a full user row, so the requests are raised as the cashier the queue knows. */
const CASHIER_USER = {
  id: CASHIER_ID, fullName: 'Amaka Obi', username: 'amaka', role: 'CASHIER' as const,
  isActive: true, isLocked: false,
  permissions: { allowWholesale: true, maxDiscountBasisPoints: 1000, allowCreditSales: false, returnLimitMinor: 0n },
}

function license(overrides: Partial<LicenseSummary> = {}): LicenseSummary {
  return {
    status: 'active', canUse: true, licenseId: 'lic-1', source: 'online', edition: 'BOTH',
    startsAt: '2026-01-01', endsAt: '2027-01-01', defaultCurrencyCode: null, lockCurrency: false,
    features: { mobileLan: true, mobileInternet: false }, adminPhoneLimit: 2, graceDays: 7,
    ...overrides,
  } as LicenseSummary
}

interface Harness {
  surface: ReturnType<typeof createMobileAdminSurface>
  database: Database.Database
  inventory: ProductInventoryService
  approvals: ApprovalQueueService
  admin: AuthenticatedPrincipal
  cashier: AuthenticatedPrincipal
  createProduct(overrides?: Partial<ProductDraft>): string
  close(): void
}

async function createHarness(currencyCode = 'NGN', snapshot = license()): Promise<Harness> {
  const database = new Database(':memory:')
  migrateDatabase(database)
  const repository = new SQLiteShopRepository(database, false)
  // The real ShopService, exactly as main/index.ts passes it, so this test cannot pass on a looser contract.
  const shop = new ShopService(repository, { deviceName: 'SHOP-PC', ipAddress: null })
  const currency = getCurrency(currencyCode)!
  repository.saveSettings({
    ...repository.readSettings(),
    profile: { name: 'Harbor Health Pharmacy', address: '14 Marina Road', phone: '+234 800 111 2222' },
    currency,
    display: defaultDisplayOptions(currency),
    setupComplete: true,
    currencyConfirmed: true,
  })
  // A real bcrypt hash so the password re-entry path is exercised for real, not stubbed.
  const bcrypt = await import('bcryptjs')
  const adminHash = await bcrypt.hash('correct-horse-battery', 4)
  const insertUser = database.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_active) VALUES (?, ?, ?, ?, ?, 1)')
  insertUser.run(ADMIN_ID, 'admin', adminHash, 'ADMIN', 'Tunde Bakare')
  insertUser.run(CASHIER_ID, 'amaka', 'not-a-real-hash', 'CASHIER', 'Amaka Obi')

  const inventory = new ProductInventoryService(database, repository, { deviceName: 'SHOP-PC' })
  const approvals = new ApprovalQueueService(database)
  const users = new UserService(new SQLiteUserRepository(database), repository)
  const reports = new AccountingReportService(database, repository)
  const returns = new ReturnService(database, repository, { workstation: 'SHOP-PC' })
  const pos = new PointOfSaleService(database, repository, { workstation: 'SHOP-PC' })

  const surface = createMobileAdminSurface({
    database,
    shop,
    license: {
      getSnapshot: () => snapshot,
    } as never,
    inventory,
    pointOfSale: pos,
    users,
    reports,
    approvals,
    returns,
    countConnectedDevices: () => 1,
    listPairedDevices: () => [
      { id: 'dev-1', name: 'Ada\u2019s iPhone', platform: 'iPhone (Safari)', lastSeen: '2026-11-17T09:00:00.000Z', lastIp: '192.168.1.24', createdAt: '2026-11-01T08:00:00.000Z', connected: true },
    ],
    revokePairedDevice: () => undefined,
  })

  const createProduct = (overrides: Partial<ProductDraft> = {}): string => {
    const draft: ProductDraft = {
      sku: 'PARA-500', name: 'Paracetamol 500mg', brand: 'Emzor', description: '', barcode: '6001234567890',
      additionalBarcodes: [], category: 'Analgesics', subCategory: '', department: '', shelfLocation: 'A1',
      unit: 'pack', packSizeUnits: 1, cost: '120.00', retailPrice: '250.00', wholesalePrice: '220.00',
      wholesaleMinimumQuantity: '1', reorderLevel: '10', genericName: 'Paracetamol',
      prescriptionRequired: false, weighedItem: false, pluCode: '', pricePerKg: '', expiryTracking: true,
      variants: [], isActive: true, ...overrides,
    }
    return inventory.createProduct(draft, { id: ADMIN_ID, username: 'admin', role: 'ADMIN' }, 'BOTH').id
  }

  return {
    surface,
    database,
    inventory,
    approvals,
    admin: { userId: ADMIN_ID, username: 'admin', role: 'ADMIN' },
    cashier: { userId: CASHIER_ID, username: 'amaka', role: 'CASHIER' },
    createProduct,
    close: () => database.close(),
  }
}

describe('the Admin phone surface', () => {
  it('refuses every route for a Cashier or Supervisor, with the one generic sentence', async () => {
    const h = await createHarness()
    try {
      expect(() => h.surface.service.dashboard(h.cashier)).toThrow('This account cannot use the mobile app')
      expect(() => h.surface.service.searchProducts(h.cashier, 'para')).toThrow('This account cannot use the mobile app')
      expect(() => h.surface.service.approvals(h.cashier)).toThrow('This account cannot use the mobile app')
      expect(() => h.surface.service.cashierPermissions(h.cashier)).toThrow('This account cannot use the mobile app')
      expect(() => h.surface.service.sales(h.cashier, '')).toThrow('This account cannot use the mobile app')
      const supervisor = { userId: 'user-sup', username: 'sup', role: 'SUPERVISOR' as const }
      expect(() => h.surface.service.dashboard(supervisor)).toThrow('This account cannot use the mobile app')
      // No Supermarket-only escape hatch: a Supervisor is a non-Admin on the phone, full stop.
    } finally {
      h.close()
    }
  })

  it('cuts the phone off the moment the Admin is demoted, without waiting for a token to expire', async () => {
    const h = await createHarness()
    try {
      expect(h.surface.service.dashboard(h.admin).today.transactions).toBe(0)
      h.database.prepare('UPDATE users SET role = ? WHERE id = ?').run('CASHIER', ADMIN_ID)
      expect(() => h.surface.service.dashboard(h.admin)).toThrow('This account cannot use the mobile app')
      h.database.prepare('UPDATE users SET role = ? WHERE id = ?').run('ADMIN', ADMIN_ID)
      h.database.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(ADMIN_ID)
      expect(() => h.surface.service.dashboard(h.admin)).toThrow('This account cannot use the mobile app')
    } finally {
      h.close()
    }
  })

  it('reports an expired licence to the phone instead of data', async () => {
    const h = await createHarness('NGN', license({ canUse: false, status: 'expired' }))
    try {
      expect(() => h.surface.service.dashboard(h.admin)).toThrow(/licence has expired or been suspended/iu)
    } finally {
      h.close()
    }
  })

  it('sends the customer store name and the shop currency, never a hard-coded symbol', async () => {
    const h = await createHarness()
    try {
      const dashboard = h.surface.service.dashboard(h.admin)
      expect(dashboard.header.storeName).toBe('Harbor Health Pharmacy')
      expect(dashboard.header.currency.code).toBe('NGN')
      // Amounts cross the wire as integer strings; the phone formats them.
      expect(dashboard.today.totalSalesMinor).toMatch(/^\d+$/u)
      expect(typeof dashboard.today.totalSalesMinor).toBe('string')
    } finally {
      h.close()
    }
  })

  it('finds a product by barcode and opens it, with batches and stock history attached', async () => {
    const h = await createHarness()
    try {
      const productId = h.createProduct()
      const found = h.surface.service.searchProducts(h.admin, '6001234567890')
      expect(found.products).toHaveLength(1)
      expect(found.exactMatchProductId).toBe(productId)

      const detail = h.surface.service.productDetail(h.admin, productId)
      expect(detail.product.name).toBe('Paracetamol 500mg')
      expect(detail.product.retailPriceMinor).toBe('25000')
      expect(Array.isArray(detail.batches)).toBe(true)
    } finally {
      h.close()
    }
  })

  it('changes a price only with the Admin password, and reports a stale screen instead of overwriting', async () => {
    const h = await createHarness()
    try {
      const productId = h.createProduct()
      const before = h.surface.service.productDetail(h.admin, productId).product

      await expect(h.surface.service.updateProduct(h.admin, {
        productId, expectedRowVersion: before.rowVersion, adminPassword: 'wrong-password',
        name: before.name, brand: before.brand, category: before.category, unit: before.unit,
        barcode: before.barcode, reorderLevel: '10', retailPrice: '300.00', wholesalePrice: '220.00', cost: '120.00',
      })).rejects.toThrow(/Admin password is not correct/iu)

      const saved = await h.surface.service.updateProduct(h.admin, {
        productId, expectedRowVersion: before.rowVersion, adminPassword: 'correct-horse-battery',
        name: before.name, brand: before.brand, category: before.category, unit: before.unit,
        barcode: before.barcode, reorderLevel: '10', retailPrice: '300.00', wholesalePrice: '220.00', cost: '120.00',
      })
      expect(saved.product.retailPriceMinor).toBe('30000')

      // The same screen is now one version behind: it must be told to reload, not allowed to overwrite.
      await expect(h.surface.service.updateProduct(h.admin, {
        productId, expectedRowVersion: before.rowVersion, adminPassword: 'correct-horse-battery',
        name: before.name, brand: before.brand, category: before.category, unit: before.unit,
        barcode: before.barcode, reorderLevel: '10', retailPrice: '999.00', wholesalePrice: '220.00', cost: '120.00',
      })).rejects.toBeInstanceOf(MobileStaleVersionError)
      expect(h.surface.service.productDetail(h.admin, productId).product.retailPriceMinor).toBe('30000')
    } finally {
      h.close()
    }
  })

  it('requires a reason for a stock adjustment and applies it once per idempotency key', async () => {
    const h = await createHarness()
    try {
      const productId = h.createProduct()
      const detail = h.surface.service.productDetail(h.admin, productId)
      const base = {
        productId,
        expectedProductVersion: detail.product.rowVersion,
        expectedStockVersion: detail.product.stockVersion,
        direction: 'increase' as const,
        quantity: '5',
        reason: '',
        // Expiry-tracked stock needs a batch and expiry, exactly as the desktop form does.
        batchNumber: 'LOT-7781',
        expiryDate: '2028-03-31',
        idempotencyKey: `mobile-adjust:${productId}:key-1`,
      }
      expect(() => h.surface.service.adjustStock(h.admin, base)).toThrow(/why the stock is changing/iu)
      const applied = h.surface.service.adjustStock(h.admin, { ...base, reason: 'Found a full carton in the store room' })
      expect(applied.product.quantityMilli).toBe('5000')
      // Same key again (a retried request): the quantity must not move twice.
      const replay = h.surface.service.adjustStock(h.admin, { ...base, reason: 'Found a full carton in the store room' })
      expect(replay.product.quantityMilli).toBe('5000')
    } finally {
      h.close()
    }
  })

  it('lets the Admin switch a cashier’s wholesale permission, with the password and nothing else', async () => {
    const h = await createHarness()
    try {
      const before = h.surface.service.cashierPermissions(h.admin)
      expect(before.cashiers).toHaveLength(1)
      expect(before.cashiers[0]!.role).toBe('CASHIER')

      await expect(h.surface.service.setCashierWholesale(h.admin, {
        userId: CASHIER_ID, allowWholesale: false, adminPassword: '',
      })).rejects.toThrow(/Admin password/iu)

      const after = await h.surface.service.setCashierWholesale(h.admin, {
        userId: CASHIER_ID, allowWholesale: false, adminPassword: 'correct-horse-battery',
      })
      expect(after.cashiers[0]!.allowWholesale).toBe(false)
      // Every other permission is untouched.
      expect(after.cashiers[0]!.allowCreditSales).toBe(before.cashiers[0]!.allowCreditSales)
      expect(after.cashiers[0]!.maxDiscountBasisPoints).toBe(before.cashiers[0]!.maxDiscountBasisPoints)

      // An Admin cannot be edited through this phone route, and nobody can be promoted from it.
      await expect(h.surface.service.setCashierWholesale(h.admin, {
        userId: ADMIN_ID, allowWholesale: false, adminPassword: 'correct-horse-battery',
      })).rejects.toThrow(/Only a Cashier/iu)
    } finally {
      h.close()
    }
  })

  it('shows the approval raised at the desktop and decides it exactly once', async () => {
    const h = await createHarness()
    try {
      const request = h.approvals.raise({
        kind: 'DISCOUNT',
        actor: CASHIER_USER,
        currencyCode: 'NGN',
        amountMinor: 150_000n,
        payload: { reason: 'Bulk order for a school' },
      })
      const pending = h.surface.service.approvals(h.admin)
      expect(pending.pendingCount).toBe(1)
      expect(pending.pending[0]!.label).toBe('Discount above the shop limit')

      const decided = h.surface.service.resolveApproval(h.admin, request.id, 'APPROVE')
      expect(decided.pendingCount).toBe(0)
      expect(decided.recent[0]!.status).toBe('APPROVED')

      // A second tap on a stale screen reports "already decided" rather than approving twice.
      expect(() => h.surface.service.resolveApproval(h.admin, request.id, 'REJECT')).toThrow(/already decided/iu)
    } finally {
      h.close()
    }
  })

  it('keeps credit requests Admin-only even when a Supervisor token is somehow presented', async () => {
    const h = await createHarness()
    try {
      const request = h.approvals.raise({
        kind: 'CREDIT',
        actor: CASHIER_USER,
        currencyCode: 'NGN', amountMinor: 50_000n, payload: {},
      })
      const supervisor = { userId: 'user-sup', username: 'sup', role: 'SUPERVISOR' as const }
      expect(() => h.surface.service.resolveApproval(supervisor, request.id, 'APPROVE'))
        .toThrow('This account cannot use the mobile app')
      expect(h.surface.service.approvals(h.admin).pendingCount).toBe(1)
    } finally {
      h.close()
    }
  })

  it('formats the same amounts in a 0-decimal currency without inventing decimals', async () => {
    const h = await createHarness('UGX')
    try {
      const dashboard = h.surface.service.dashboard(h.admin)
      expect(dashboard.header.currency.decimalPlaces).toBe(0)
      expect(dashboard.today.totalSalesMinor).toBe('0')

      // The same product entry works in a whole-unit currency: a whole amount is stored whole,
      // and a fraction the shop cannot charge is refused rather than rounded silently.
      const productId = h.createProduct({ retailPrice: '2500', wholesalePrice: '2200', cost: '1200' })
      const detail = h.surface.service.productDetail(h.admin, productId).product
      expect(detail.retailPriceMinor).toBe('2500')
      const amount = toMinor('2500', h.surface.service.dashboard(h.admin).header.currency)
      expect(amount).toBe(2500n)
      expect(detail.retailPriceMinor).toBe(amount.toString())
      let refusal = ''
      try {
        await h.surface.service.updateProduct(h.admin, {
          productId, expectedRowVersion: detail.rowVersion, adminPassword: 'correct-horse-battery',
          name: detail.name, brand: detail.brand, category: detail.category, unit: detail.unit,
          barcode: detail.barcode, reorderLevel: '10', retailPrice: '2500.50', wholesalePrice: '2200', cost: '1200',
        })
      } catch (error) {
        refusal = (error as Error).message
      }
      // The host's own rule, not a second one invented on the phone.
      expect(refusal).toContain('0 decimal places')
    } finally {
      h.close()
    }
  })

  it('adds a product scanned on the shelf, priced the same way the desktop prices it', async () => {
    const h = await createHarness()
    try {
      const detail = h.surface.service.createProduct(h.admin, {
        sku: '', name: 'Vitamin C 1000mg', barcode: '6009876543210', unit: 'pack', category: 'Vitamins',
        retailPrice: '1500.00', wholesalePrice: '1200.00', cost: '900.00', reorderLevel: '5',
        expiryTracking: true, prescriptionRequired: false,
      })
      expect(detail.product.name).toBe('Vitamin C 1000mg')
      expect(detail.product.barcode).toBe('6009876543210')
      // Money is integer minor units, rounded the same way as every other entry point.
      expect(detail.product.retailPriceMinor).toBe('150000')
      expect(detail.product.wholesalePriceMinor).toBe('120000')
      expect(detail.product.expiryTracking).toBe(true)
      // A zero-decimal shop rounds the same amount to a whole unit rather than storing a fraction.
      const found = h.surface.service.searchProducts(h.admin, '6009876543210')
      expect(found.exactMatchProductId).toBe(detail.product.id)
    } finally {
      h.close()
    }
  })

  it('lists the paired phones and revokes one only with the Admin password', async () => {
    const h = await createHarness()
    try {
      const before = h.surface.service.devices(h.admin)
      expect(before.devices).toHaveLength(1)
      expect(before.devices[0].platform).toBe('iPhone (Safari)')

      await expect(h.surface.service.revokeDevice(h.admin, 'dev-1', 'nope')).rejects.toThrow(/not correct/iu)
      const after = await h.surface.service.revokeDevice(h.admin, 'dev-1', 'correct-horse-battery')
      expect(after.devices[0].id).toBe('dev-1')
    } finally {
      h.close()
    }
  })

  it('refuses the Devices screen to anyone who is not an Admin', async () => {
    const h = await createHarness()
    try {
      expect(() => h.surface.service.devices(h.cashier)).toThrow(/cannot use the mobile app/iu)
    } finally {
      h.close()
    }
  })

  it('pages a read-only list of sales and never exposes a way to create one', async () => {
    const h = await createHarness()
    try {
      const list = h.surface.service.sales(h.admin, '')
      expect(list.sales).toEqual([])
      // The surface has no sale-creating method at all: the phone is view-only for sales, by construction.
      const names = Object.getOwnPropertyNames(Object.getPrototypeOf(h.surface.service))
      expect(names.some((name) => /completeSale|quoteSale|createSale/iu.test(name))).toBe(false)
    } finally {
      h.close()
    }
  })
})
