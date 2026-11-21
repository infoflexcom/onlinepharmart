import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { getCurrency } from '../currency/catalog'
import { defaultDisplayOptions } from '../currency/money'
import { fromMinor } from '../currency/parse'
import { migrateDatabase } from '../db/migrate'
import { SQLiteShopRepository } from '../db/sqlite-shop-repository'
import type { PublicUser } from '../shared/auth/types'
import type { ProductDraft, ProductRecord } from '../shared/inventory/types'
import type { CompletePosSaleInput, PosQuoteInput } from '../shared/pos/types'
import type { RequestReturnInput } from '../shared/returns/types'
import { ProductInventoryService } from './product-inventory-service'
import { PointOfSaleService } from './point-of-sale-service'
import { ReturnService } from './return-service'
import { ShopService } from './shop-service'

const INITIAL_TIME = Date.parse('2026-11-17T12:00:00.000Z')
const ADMIN: PublicUser = {
  id: 'return-admin', fullName: 'Return Admin', username: 'returnadmin', role: 'ADMIN', isActive: true, isLocked: false,
  permissions: { allowWholesale: true, maxDiscountBasisPoints: 10_000, allowCreditSales: true, returnLimitMinor: 9_223_372_036_854_775_807n },
}
const SUPERVISOR: PublicUser = {
  id: 'return-supervisor', fullName: 'Return Supervisor', username: 'returnsupervisor', role: 'SUPERVISOR', isActive: true, isLocked: false,
  permissions: { allowWholesale: false, maxDiscountBasisPoints: 0, allowCreditSales: false, returnLimitMinor: 0n },
}
const CASHIER: PublicUser = {
  id: 'return-cashier', fullName: 'Return Cashier', username: 'returncashier', role: 'CASHIER', isActive: true, isLocked: false,
  permissions: { allowWholesale: false, maxDiscountBasisPoints: 0, allowCreditSales: false, returnLimitMinor: 100_000n },
}

function createHarness(currencyCode = 'NGN') {
  const database = new Database(':memory:')
  migrateDatabase(database)
  const shop = new SQLiteShopRepository(database, false)
  const currency = getCurrency(currencyCode)!
  shop.saveSettings({
    ...shop.readSettings(),
    profile: {
      name: 'Harbor Health', address: '12 Dock Road', phone: '+234 1 555 0100', email: 'receipts@harbor.example',
      licenceNumber: 'LIC-204', taxNumber: 'TIN-887', receiptFooter: 'Keep your receipt.', thankYouNote: 'Thank you.',
    },
    currency,
    display: defaultDisplayOptions(currency),
    setupComplete: true,
    currencyConfirmed: true,
  })
  const insertUser = database.prepare('INSERT INTO users (id, username, password_hash, role, full_name) VALUES (?, ?, ?, ?, ?)')
  for (const user of [ADMIN, SUPERVISOR, CASHIER]) insertUser.run(user.id, user.username, 'test-hash', user.role, user.fullName)
  const insertPermission = database.prepare(`
    INSERT INTO user_permissions (user_id, allow_wholesale, max_discount_pct, allow_credit_sales, return_limit)
    VALUES (?, ?, ?, ?, ?)
  `)
  insertPermission.run(ADMIN.id, 1, 10_000, 1, 9_223_372_036_854_775_807n)
  insertPermission.run(SUPERVISOR.id, 0, 0, 0, 0)
  insertPermission.run(CASHIER.id, 0, 0, 0, 100_000n)

  let clock = INITIAL_TIME
  let inventoryId = 0
  let posId = 0
  let returnId = 0
  const inventory = new ProductInventoryService(database, shop, {
    deviceName: 'RETURNS-TEST-REGISTER', now: () => clock, newId: () => `return-inventory-${++inventoryId}`,
  })
  const pointOfSale = new PointOfSaleService(database, shop, {
    workstation: 'RETURNS-TEST-REGISTER', now: () => clock, newId: () => `return-pos-${++posId}`,
  })
  const returns = new ReturnService(database, shop, {
    workstation: 'RETURNS-TEST-REGISTER', now: () => clock, newId: () => `return-service-${++returnId}`,
  })
  const shopService = new ShopService(shop, { deviceName: 'RETURNS-TEST-REGISTER', ipAddress: null }, () => new Date(clock), () => `return-shop-${++returnId}`)
  return {
    database, shop, inventory, pointOfSale, returns, shopService,
    setNow(value: number) { clock = value }, now() { return clock },
    close() { database.close() },
  }
}

function draft(overrides: Partial<ProductDraft> = {}, currency = getCurrency('NGN')!): ProductDraft {
  return {
    sku: `RET-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`.slice(0, 40),
    name: 'Return test product', brand: 'Harbor', description: 'Return service test item',
    barcode: '', additionalBarcodes: [], category: 'General', subCategory: '', department: '', shelfLocation: '',
    unit: 'each', packSizeUnits: 1, cost: fromMinor(100n, currency), retailPrice: fromMinor(2_000n, currency), wholesalePrice: fromMinor(1_800n, currency),
    wholesaleMinimumQuantity: '0', reorderLevel: '0', genericName: '', prescriptionRequired: false,
    weighedItem: false, pluCode: '', pricePerKg: '', expiryTracking: false, variants: [], isActive: true,
    ...overrides,
  }
}

function createProduct(
  harness: ReturnType<typeof createHarness>,
  edition: 'PHARMACY' | 'SUPERMARKET' | 'BOTH',
  overrides: Partial<ProductDraft> = {},
): ProductRecord {
  return harness.inventory.createProduct(draft(overrides, harness.shop.readSettings().currency), { id: ADMIN.id, username: ADMIN.username, role: ADMIN.role }, edition)
}

function receiveStock(
  harness: ReturnType<typeof createHarness>,
  product: ProductRecord,
  edition: 'PHARMACY' | 'SUPERMARKET' | 'BOTH',
  quantity: string,
  batchNumber = '',
  expiryDate = '',
): ProductRecord {
  const currency = harness.shop.readSettings().currency
  return harness.inventory.receiveStock({
    productId: product.id, expectedProductVersion: product.rowVersion, expectedStockVersion: product.stockVersion,
    quantity, quantityUnit: 'unit', unitCost: fromMinor(100n, currency), supplierName: 'Coastal Supplies',
    supplierReference: `INV-${batchNumber || product.sku}`, note: 'Return workflow stock', batchNumber, expiryDate,
  }, { id: ADMIN.id, username: ADMIN.username, role: ADMIN.role }, edition).product
}

function sell(
  harness: ReturnType<typeof createHarness>,
  product: ProductRecord,
  edition: 'PHARMACY' | 'SUPERMARKET' | 'BOTH',
  quantity: string,
  options: Partial<Pick<PosQuoteInput, 'customerId' | 'loyaltyPointsToRedeem'>> = {},
) {
  const quote = harness.pointOfSale.quoteSale({
    saleType: 'RETAIL', items: [{ productId: product.id, quantity }],
    customerId: options.customerId, loyaltyPointsToRedeem: options.loyaltyPointsToRedeem,
  }, ADMIN, edition)
  const currency = harness.shop.readSettings().currency
  const input: CompletePosSaleInput = {
    idempotencyKey: `returns-sale-key-${Math.random().toString(36).slice(2, 14)}`,
    saleType: 'RETAIL', items: [{ productId: product.id, quantity }],
    customerId: options.customerId, loyaltyPointsToRedeem: options.loyaltyPointsToRedeem,
    payments: quote.totalMinor > 0n ? [{ method: 'CASH', amount: fromMinor(quote.totalMinor, currency) }] : [],
  }
  return harness.pointOfSale.completeSale(input, ADMIN, edition).receipt
}

function returnInput(
  receiptNumber: string,
  saleItemId: string,
  quantity: string,
  overrides: Partial<RequestReturnInput> = {},
): RequestReturnInput {
  return {
    receiptNumber, reason: 'CUSTOMER_CHANGED_MIND', reasonNote: '', type: 'REFUND', refundMethod: 'CASH',
    items: [{ saleItemId, quantity, condition: 'RESELLABLE' }],
    idempotencyKey: `returns-request-${Math.random().toString(36).slice(2, 14)}`,
    ...overrides,
  }
}

function stockQuantity(harness: ReturnType<typeof createHarness>, productId: string): bigint {
  const row = harness.database.prepare('SELECT CAST(quantity_milli AS TEXT) AS quantity_text FROM stock WHERE product_id = ?').get(productId) as { quantity_text: string }
  return BigInt(row.quantity_text)
}

describe('ReturnService', () => {
  it('rejects over-returns and allocates exact saved line value across partial returns without changing the sale', () => {
    const harness = createHarness()
    try {
      let product = createProduct(harness, 'SUPERMARKET', { sku: 'RET-OVER', retailPrice: '10.00' })
      product = receiveStock(harness, product, 'SUPERMARKET', '3')
      const sale = sell(harness, product, 'SUPERMARKET', '3')
      const saleItem = sale.items[0]!
      const first = harness.returns.createReturn(returnInput(sale.receiptNumber, saleItem.id, '1'), CASHIER, 'SUPERMARKET')
      expect(first).toMatchObject({ status: 'COMPLETED', totalMinor: 1_000n, currency: { code: 'NGN' } })
      expect(() => harness.returns.createReturn(returnInput(sale.receiptNumber, saleItem.id, '2.001'), CASHIER, 'SUPERMARKET'))
        .toThrow(/exceeds the quantity sold/u)
      const second = harness.returns.createReturn(returnInput(sale.receiptNumber, saleItem.id, '1'), CASHIER, 'SUPERMARKET')
      const third = harness.returns.createReturn(returnInput(sale.receiptNumber, saleItem.id, '1'), CASHIER, 'SUPERMARKET')
      expect([first.totalMinor, second.totalMinor, third.totalMinor]).toEqual([1_000n, 1_000n, 1_000n])
      expect(stockQuantity(harness, product.id)).toBe(3_000n)
      expect(harness.database.prepare('SELECT COUNT(*) AS count FROM payments WHERE return_id IS NOT NULL').get()).toEqual({ count: 3 })
      expect(harness.database.prepare('SELECT total, status FROM sales WHERE id = ?').get(sale.id)).toEqual({ total: 3_000, status: 'COMPLETED' })
      expect(() => harness.database.prepare('UPDATE sales SET total = 1 WHERE id = ?').run(sale.id)).toThrow(/Completed sales cannot be changed/u)
      expect(() => harness.database.prepare('DELETE FROM sales WHERE id = ?').run(sale.id)).toThrow(/Completed sales cannot be deleted/u)
      expect(() => harness.database.prepare('UPDATE returns SET total = 1 WHERE id = ?').run(first.id)).toThrow(/Completed returns cannot be changed/u)
      expect(() => harness.database.prepare('DELETE FROM return_items WHERE return_id = ?').run(first.id)).toThrow(/completed returns cannot be deleted|cannot be deleted/u)
    } finally {
      harness.close()
    }
  })

  it('rolls back stock, payments, return rows, and ledger entries if completion auditing fails', () => {
    const harness = createHarness()
    try {
      let product = createProduct(harness, 'SUPERMARKET', { sku: 'RET-ROLLBACK', retailPrice: '10.00' })
      product = receiveStock(harness, product, 'SUPERMARKET', '1')
      const sale = sell(harness, product, 'SUPERMARKET', '1')
      harness.database.exec(`
        CREATE TRIGGER reject_return_completion_audit
        BEFORE INSERT ON audit_log WHEN NEW.action = 'returns.completed'
        BEGIN SELECT RAISE(ABORT, 'Returns audit unavailable'); END;
      `)
      expect(() => harness.returns.createReturn(returnInput(sale.receiptNumber, sale.items[0]!.id, '1'), CASHIER, 'SUPERMARKET'))
        .toThrow(/Returns audit unavailable/u)
      expect(harness.database.prepare('SELECT COUNT(*) AS count FROM returns WHERE sale_id = ?').get(sale.id)).toEqual({ count: 0 })
      expect(harness.database.prepare('SELECT COUNT(*) AS count FROM payments WHERE return_id IS NOT NULL').get()).toEqual({ count: 0 })
      expect(harness.database.prepare("SELECT COUNT(*) AS count FROM business_entries WHERE kind = 'return'").get()).toEqual({ count: 0 })
      expect(harness.database.prepare("SELECT COUNT(*) AS count FROM stock_movements WHERE movement_type = 'RETURN'").get()).toEqual({ count: 0 })
      expect(stockQuantity(harness, product.id)).toBe(0n)

      harness.database.exec('DROP TRIGGER reject_return_completion_audit')
      const input = returnInput(sale.receiptNumber, sale.items[0]!.id, '1', { idempotencyKey: 'return-atomic-retry-001' })
      const completed = harness.returns.createReturn(input, CASHIER, 'SUPERMARKET')
      const replay = harness.returns.createReturn(input, CASHIER, 'SUPERMARKET')
      expect(replay.id).toBe(completed.id)
      expect(stockQuantity(harness, product.id)).toBe(1_000n)
      expect(harness.database.prepare('SELECT COUNT(*) AS count FROM returns WHERE sale_id = ?').get(sale.id)).toEqual({ count: 1 })
      expect(harness.database.prepare('SELECT COUNT(*) AS count FROM payments WHERE return_id IS NOT NULL').get()).toEqual({ count: 1 })
    } finally {
      harness.close()
    }
  })

  it('reserves above-limit requests without effects and completes atomically only after a Supervisor approval', () => {
    const harness = createHarness()
    try {
      harness.database.prepare('UPDATE user_permissions SET return_limit = 100 WHERE user_id = ?').run(CASHIER.id)
      let product = createProduct(harness, 'SUPERMARKET', { sku: 'RET-APPROVAL', retailPrice: '25.00' })
      product = receiveStock(harness, product, 'SUPERMARKET', '3')
      const sale = sell(harness, product, 'SUPERMARKET', '2')
      const pending = harness.returns.createReturn(returnInput(sale.receiptNumber, sale.items[0]!.id, '1'), CASHIER, 'SUPERMARKET')
      expect(pending.status).toBe('PENDING')
      expect(pending.totalMinor).toBe(2_500n)
      expect(stockQuantity(harness, product.id)).toBe(1_000n)
      expect(harness.database.prepare('SELECT COUNT(*) AS count FROM payments WHERE return_id IS NOT NULL').get()).toEqual({ count: 0 })
      expect(() => harness.returns.createReturn(returnInput(sale.receiptNumber, sale.items[0]!.id, '1'), CASHIER, 'SUPERMARKET'))
        .toThrow(/already has a return awaiting approval/u)
      expect(harness.returns.listPendingMobileApprovals(ADMIN).map((record) => record.id)).toEqual([pending.id])

      const approved = harness.returns.resolveApproval(pending.id, 'APPROVE', SUPERVISOR, 'DESKTOP')
      expect(approved).toMatchObject({ decision: 'APPROVE', returnRecord: {
        status: 'COMPLETED', approvedBy: SUPERVISOR.fullName, approvalChannel: 'DESKTOP', totalMinor: 2_500n,
      } })
      expect(stockQuantity(harness, product.id)).toBe(2_000n)
      expect(harness.database.prepare('SELECT amount, payment_method FROM payments WHERE return_id = ?').get(pending.id)).toEqual({ amount: 2_500, payment_method: 'REFUND_CASH' })
      expect(harness.database.prepare("SELECT status FROM approval_requests WHERE request_type = 'RETURN'").get()).toEqual({ status: 'APPROVED' })
      expect(() => harness.returns.resolveApproval(pending.id, 'APPROVE', CASHIER)).toThrow(/Admin or Supervisor/u)
    } finally {
      harness.close()
    }
  })

  it('records Admin phone approvals with a mobile channel while rejecting mobile Supervisor decisions', () => {
    const harness = createHarness()
    try {
      harness.database.prepare('UPDATE user_permissions SET return_limit = 100 WHERE user_id = ?').run(CASHIER.id)
      let product = createProduct(harness, 'SUPERMARKET', { sku: 'RET-MOBILE-APPROVAL', retailPrice: '25.00' })
      product = receiveStock(harness, product, 'SUPERMARKET', '1')
      const sale = sell(harness, product, 'SUPERMARKET', '1')
      const pending = harness.returns.createReturn(returnInput(sale.receiptNumber, sale.items[0]!.id, '1'), CASHIER, 'SUPERMARKET')
      // The return stores the requester, not the original sale cashier, so the phone approval list is accurate.
      expect(pending).toMatchObject({ cashierId: CASHIER.id, cashier: CASHIER.fullName })
      expect(sale.cashier).toBe(ADMIN.fullName)

      expect(() => harness.returns.resolveMobileApproval(pending.id, 'APPROVE', SUPERVISOR)).toThrow(/Mobile return approvals are restricted to Admin/u)
      expect(harness.returns.listPendingMobileApprovals(ADMIN).map((record) => record.id)).toEqual([pending.id])
      const result = harness.returns.resolveMobileApproval(pending.id, 'APPROVE', ADMIN)
      expect(result).toMatchObject({ decision: 'APPROVE', returnRecord: {
        status: 'COMPLETED', approvedBy: ADMIN.fullName, approvalChannel: 'MOBILE',
      } })
      expect(harness.database.prepare("SELECT status, approved_by FROM approval_requests WHERE request_type = 'RETURN'").get())
        .toEqual({ status: 'APPROVED', approved_by: ADMIN.id })
      expect(harness.database.prepare("SELECT approval_channel FROM returns WHERE id = ?").get(pending.id))
        .toEqual({ approval_channel: 'MOBILE' })
    } finally {
      harness.close()
    }
  })

  it('rejects self-approval and releases the reserved quantity after a rejection', () => {
    const harness = createHarness()
    try {
      harness.database.prepare('UPDATE user_permissions SET return_limit = 0 WHERE user_id = ?').run(ADMIN.id)
      let product = createProduct(harness, 'SUPERMARKET', { sku: 'RET-REJECT', retailPrice: '5.00' })
      product = receiveStock(harness, product, 'SUPERMARKET', '1')
      const sale = sell(harness, product, 'SUPERMARKET', '1')
      const pending = harness.returns.createReturn(returnInput(sale.receiptNumber, sale.items[0]!.id, '1'), ADMIN, 'SUPERMARKET')
      expect(() => harness.returns.resolveApproval(pending.id, 'APPROVE', ADMIN)).toThrow(/cannot approve their own/u)
      const rejected = harness.returns.resolveApproval(pending.id, 'REJECT', SUPERVISOR)
      expect(rejected.returnRecord.status).toBe('REJECTED')
      const found = harness.returns.findSaleForReturn(sale.receiptNumber, CASHIER, 'SUPERMARKET')
      expect(found.items[0]?.returnableQuantityMilli).toBe(1_000n)
      expect(stockQuantity(harness, product.id)).toBe(0n)
      expect(harness.database.prepare('SELECT COUNT(*) AS count FROM payments WHERE return_id IS NOT NULL').get()).toEqual({ count: 0 })
    } finally {
      harness.close()
    }
  })

  it('enforces the configurable seven-day window and permits an audited Admin override', () => {
    const harness = createHarness()
    try {
      let product = createProduct(harness, 'SUPERMARKET', { sku: 'RET-WINDOW', retailPrice: '10.00' })
      product = receiveStock(harness, product, 'SUPERMARKET', '1')
      const sale = sell(harness, product, 'SUPERMARKET', '1')
      expect(harness.shop.readSettings().returnWindowDays).toBe(7)
      harness.shopService.updateReturnWindowDays(3, ADMIN.username)
      harness.setNow(INITIAL_TIME + 4 * 86_400_000)
      expect(() => harness.returns.createReturn(returnInput(sale.receiptNumber, sale.items[0]!.id, '1'), CASHIER, 'SUPERMARKET'))
        .toThrow(/outside the 3-day return window/u)
      const overridden = harness.returns.createReturn(returnInput(sale.receiptNumber, sale.items[0]!.id, '1', {
        overrideReturnWindow: true, windowOverrideReason: 'Manager confirmed the receipt and customer claim.',
      }), ADMIN, 'SUPERMARKET')
      expect(overridden).toMatchObject({
        status: 'COMPLETED', returnWindowDays: 3, returnWindowOverride: true,
        returnWindowOverrideReason: 'Manager confirmed the receipt and customer claim.',
      })
      expect(harness.database.prepare("SELECT action FROM audit_log WHERE action = 'returns.requested'").get()).toEqual({ action: 'returns.requested' })
      expect(harness.database.prepare("SELECT action FROM audit_log WHERE action = 'returns.window.updated'").get()).toEqual({ action: 'returns.window.updated' })
    } finally {
      harness.close()
    }
  })

  it('restores sealed Pharmacy goods to the original batch and records opened/expired returns as write-offs', () => {
    const harness = createHarness()
    try {
      let product = createProduct(harness, 'PHARMACY', { sku: 'RET-PHARM', genericName: 'ascorbic acid', retailPrice: '10.00' })
      product = receiveStock(harness, product, 'PHARMACY', '3', 'LOT-ORIGINAL', '2028-12-31')
      const sale = sell(harness, product, 'PHARMACY', '3')
      const saleItem = sale.items[0]!
      const batchId = saleItem.batches[0]!.batchId

      const sealed = harness.returns.createReturn(returnInput(sale.receiptNumber, saleItem.id, '1'), CASHIER, 'PHARMACY')
      expect(sealed.items[0]).toMatchObject({ stockDisposition: 'RESTOCKED', sourceBatchId: batchId, sourceBatchNumber: 'LOT-ORIGINAL' })
      expect(harness.database.prepare('SELECT quantity_milli FROM product_batches WHERE id = ?').get(batchId)).toEqual({ quantity_milli: 1_000 })

      const opened = harness.returns.createReturn(returnInput(sale.receiptNumber, saleItem.id, '1', {
        reason: 'OTHER', reasonNote: 'Package was opened.', items: [{ saleItemId: saleItem.id, quantity: '1', condition: 'OPENED' }],
      }), CASHIER, 'PHARMACY')
      expect(opened.items[0]).toMatchObject({ stockDisposition: 'WRITTEN_OFF', writeoffReason: expect.stringContaining('Opened') })
      const expired = harness.returns.createReturn(returnInput(sale.receiptNumber, saleItem.id, '1', { reason: 'EXPIRED' }), CASHIER, 'PHARMACY')
      expect(expired.items[0]).toMatchObject({ condition: 'EXPIRED', stockDisposition: 'WRITTEN_OFF' })
      expect(stockQuantity(harness, product.id)).toBe(1_000n)
      expect(harness.database.prepare('SELECT quantity_milli FROM product_batches WHERE id = ?').get(batchId)).toEqual({ quantity_milli: 1_000 })
      expect(harness.database.prepare("SELECT COUNT(*) AS count FROM stock_movements WHERE movement_type = 'RETURN'").get()).toEqual({ count: 1 })
    } finally {
      harness.close()
    }
  })

  it('writes an otherwise resellable Pharmacy return off if its original batch has expired by the return date', () => {
    const harness = createHarness()
    try {
      let product = createProduct(harness, 'PHARMACY', { sku: 'RET-EXPIRED-BATCH', genericName: 'amoxicillin', retailPrice: '12.00' })
      const expiry = new Date(INITIAL_TIME + 2 * 86_400_000).toISOString().slice(0, 10)
      product = receiveStock(harness, product, 'PHARMACY', '1', 'LOT-NEAR-EXPIRY', expiry)
      const sale = sell(harness, product, 'PHARMACY', '1')
      harness.setNow(INITIAL_TIME + 3 * 86_400_000)
      const returned = harness.returns.createReturn(returnInput(sale.receiptNumber, sale.items[0]!.id, '1'), CASHIER, 'PHARMACY')
      expect(returned.items[0]).toMatchObject({
        condition: 'RESELLABLE', stockDisposition: 'WRITTEN_OFF',
        writeoffReason: 'The original Pharmacy batch is expired.',
      })
      expect(stockQuantity(harness, product.id)).toBe(0n)
      expect(harness.database.prepare('SELECT quantity_milli FROM product_batches WHERE id = ?').get(sale.items[0]!.batches[0]!.batchId)).toEqual({ quantity_milli: 0 })
    } finally {
      harness.close()
    }
  })

  it('reverses Supermarket promotion and loyalty discounts proportionally, including loyalty debt when points were spent', () => {
    const harness = createHarness()
    try {
      let product = createProduct(harness, 'SUPERMARKET', { sku: 'RET-LOYALTY', retailPrice: '100.00', department: 'Pantry' })
      product = receiveStock(harness, product, 'SUPERMARKET', '10')
      const customer = harness.pointOfSale.createCustomer({ name: 'Ada Return', creditLimit: '0', enrolLoyalty: true }, ADMIN, 'SUPERMARKET')
      harness.database.prepare('UPDATE loyalty_members SET points_balance = 500 WHERE id = ?').run(customer.loyaltyMemberId)
      harness.database.prepare(`
        INSERT INTO promotions (
          id, name, promotion_type, amount_minor, discount_basis_points, starts_at, ends_at, is_active,
          product_id, department_id, minimum_quantity_milli, minimum_subtotal
        ) VALUES (?, ?, 'PERCENT', NULL, ?, ?, ?, 1, NULL, NULL, 0, 0)
      `).run('return-promo-10', 'Pantry return test', 1_000,
        new Date(INITIAL_TIME - 86_400_000).toISOString(), new Date(INITIAL_TIME + 86_400_000).toISOString())
      const quote = harness.pointOfSale.quoteSale({
        saleType: 'RETAIL', items: [{ productId: product.id, quantity: '10' }], customerId: customer.id, loyaltyPointsToRedeem: 200,
      }, ADMIN, 'SUPERMARKET')
      expect(quote).toMatchObject({ promotionDiscountMinor: 10_000n, loyaltyDiscountMinor: 200n, totalMinor: 89_800n, loyaltyPointsEarned: 898 })
      const sale = sell(harness, product, 'SUPERMARKET', '10', { customerId: customer.id, loyaltyPointsToRedeem: 200 })
      harness.database.prepare('UPDATE loyalty_members SET points_balance = 0, row_version = row_version + 1 WHERE id = ?').run(customer.loyaltyMemberId)
      const returned = harness.returns.createReturn(returnInput(sale.receiptNumber, sale.items[0]!.id, '5'), CASHIER, 'SUPERMARKET')
      expect(returned).toMatchObject({
        totalMinor: 44_900n, promotionAmountReversedMinor: 5_000n,
        loyaltyDiscountReversedMinor: 100n, loyaltyPointsReversed: 449, loyaltyPointsRestored: 100,
      })
      expect(harness.database.prepare('SELECT points_balance, points_debt FROM loyalty_members WHERE id = ?').get(customer.loyaltyMemberId))
        .toEqual({ points_balance: 0, points_debt: 349 })
      expect(harness.database.prepare('SELECT points_delta, transaction_type, return_id FROM loyalty_transactions WHERE return_id = ? ORDER BY rowid').all(returned.id))
        .toEqual([
          { points_delta: 100, transaction_type: 'ADJUST', return_id: returned.id },
          { points_delta: -449, transaction_type: 'ADJUST', return_id: returned.id },
        ])
    } finally {
      harness.close()
    }
  })

  it('uses exact stored amounts and half-up cumulative allocation for two-decimal and zero-decimal currencies', () => {
    const twoDecimal = createHarness('NGN')
    try {
      let product = createProduct(twoDecimal, 'SUPERMARKET', { sku: 'RET-NGN-ROUND', retailPrice: '0.01' })
      product = receiveStock(twoDecimal, product, 'SUPERMARKET', '3')
      const sale = sell(twoDecimal, product, 'SUPERMARKET', '3')
      const first = twoDecimal.returns.createReturn(returnInput(sale.receiptNumber, sale.items[0]!.id, '1'), CASHIER, 'SUPERMARKET')
      const second = twoDecimal.returns.createReturn(returnInput(sale.receiptNumber, sale.items[0]!.id, '1'), CASHIER, 'SUPERMARKET')
      const third = twoDecimal.returns.createReturn(returnInput(sale.receiptNumber, sale.items[0]!.id, '1'), CASHIER, 'SUPERMARKET')
      expect([first.totalMinor, second.totalMinor, third.totalMinor]).toEqual([1n, 1n, 1n])
      expect(first.currency.decimalPlaces).toBe(2)
    } finally {
      twoDecimal.close()
    }

    const zeroDecimal = createHarness('JPY')
    try {
      let product = createProduct(zeroDecimal, 'SUPERMARKET', { sku: 'RET-JPY-ROUND', retailPrice: '1' })
      product = receiveStock(zeroDecimal, product, 'SUPERMARKET', '1')
      const sale = sell(zeroDecimal, product, 'SUPERMARKET', '1')
      const first = zeroDecimal.returns.createReturn(returnInput(sale.receiptNumber, sale.items[0]!.id, '0.5'), CASHIER, 'SUPERMARKET')
      const second = zeroDecimal.returns.createReturn(returnInput(sale.receiptNumber, sale.items[0]!.id, '0.5'), CASHIER, 'SUPERMARKET')
      expect([first.totalMinor, second.totalMinor]).toEqual([1n, 0n])
      expect(first.currency.decimalPlaces).toBe(0)
      expect(fromMinor(first.totalMinor, first.currency)).toBe('1')
      expect(fromMinor(second.totalMinor, second.currency)).toBe('0')
    } finally {
      zeroDecimal.close()
    }
  })

  it('prints and shares notes with the original sale store and currency snapshot and creates store credit', () => {
    const harness = createHarness()
    try {
      let product = createProduct(harness, 'SUPERMARKET', { sku: 'RET-SNAPSHOT', retailPrice: '23.45' })
      product = receiveStock(harness, product, 'SUPERMARKET', '1')
      const sale = sell(harness, product, 'SUPERMARKET', '1')
      const settings = harness.shop.readSettings()
      harness.shop.saveSettings({
        ...settings,
        profile: { ...settings.profile, name: 'Renamed Harbor Market' },
        display: { ...settings.display, amountDisplay: 'code' },
      })
      const returned = harness.returns.createReturn(returnInput(sale.receiptNumber, sale.items[0]!.id, '1', { type: 'STORE_CREDIT' }), CASHIER, 'SUPERMARKET')
      expect(returned).toMatchObject({
        status: 'COMPLETED', type: 'STORE_CREDIT', totalMinor: 2_345n,
        store: { name: 'Harbor Health' }, currency: { code: 'NGN', symbol: '₦', decimalPlaces: 2 },
        display: { amountDisplay: 'symbol' },
        credit: { type: 'STORE_CREDIT', amountMinor: 2_345n, remainingMinor: 2_345n },
      })
      const firstPrint = harness.returns.recordReturnPrint(returned.id, 'A4_RECEIPT', CASHIER)
      const reprint = harness.returns.recordReturnPrint(returned.id, 'THERMAL_80', CASHIER)
      expect(firstPrint).toMatchObject({ duplicate: false, printCount: 1, store: { name: 'Harbor Health' } })
      expect(reprint).toMatchObject({ duplicate: true, printCount: 2, currency: { code: 'NGN', symbol: '₦' } })
      expect(harness.database.prepare("SELECT payment_method, amount, currency_code FROM payments WHERE return_id = ?").get(returned.id))
        .toEqual({ payment_method: 'STORE_CREDIT', amount: 2_345, currency_code: 'NGN' })
      expect(harness.database.prepare("SELECT kind, currency_code, amount_minor FROM business_entries WHERE kind = 'return'").get())
        .toEqual({ kind: 'return', currency_code: 'NGN', amount_minor: 2_345 })
    } finally {
      harness.close()
    }
  })
})
