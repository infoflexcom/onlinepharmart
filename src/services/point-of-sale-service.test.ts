import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { getCurrency } from '../currency/catalog'
import { defaultDisplayOptions } from '../currency/money'
import { migrateDatabase } from '../db/migrate'
import { SQLiteShopRepository } from '../db/sqlite-shop-repository'
import type { PublicUser } from '../shared/auth/types'
import type { ProductDraft, ProductRecord } from '../shared/inventory/types'
import type { CompletePosSaleInput } from '../shared/pos/types'
import { formatReceiptMoney, usesIsoCodeFallback } from '../shared/pos/receipt-format'
import { ProductInventoryService } from './product-inventory-service'
import { PointOfSaleService } from './point-of-sale-service'

const ADMIN: PublicUser = {
  id: 'pos-admin', fullName: 'POS Admin', username: 'posadmin', role: 'ADMIN', isActive: true, isLocked: false,
  permissions: { allowWholesale: true, maxDiscountBasisPoints: 10_000, allowCreditSales: true, returnLimitMinor: 0n },
}
const CASHIER: PublicUser = {
  id: 'pos-cashier', fullName: 'POS Cashier', username: 'poscashier', role: 'CASHIER', isActive: true, isLocked: false,
  permissions: { allowWholesale: false, maxDiscountBasisPoints: 0, allowCreditSales: false, returnLimitMinor: 0n },
}
const NOW = Date.parse('2026-11-17T12:00:00.000Z')

function createHarness(currencyCode = 'NGN') {
  const database = new Database(':memory:')
  migrateDatabase(database)
  const shop = new SQLiteShopRepository(database, false)
  const currency = getCurrency(currencyCode)!
  shop.saveSettings({
    ...shop.readSettings(),
    profile: {
      name: 'Harbor Health', address: '12 Dock Road', phone: '+234 1 555 0100', email: 'receipts@harbor.example',
      licenceNumber: 'LIC-204', taxNumber: 'TIN-887', storeLogo: null,
      receiptFooter: 'Keep your receipt.', thankYouNote: 'Thank you for shopping with us.',
    },
    currency,
    display: defaultDisplayOptions(currency),
    setupComplete: true,
    currencyConfirmed: true,
  })
  const insertUser = database.prepare('INSERT INTO users (id, username, password_hash, role, full_name) VALUES (?, ?, ?, ?, ?)')
  insertUser.run(ADMIN.id, ADMIN.username, 'test-hash', ADMIN.role, ADMIN.fullName)
  insertUser.run(CASHIER.id, CASHIER.username, 'test-hash', CASHIER.role, CASHIER.fullName)
  database.prepare(`
    INSERT INTO user_permissions (user_id, allow_wholesale, max_discount_pct, allow_credit_sales, return_limit)
    VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)
  `).run(ADMIN.id, 1, 10_000, 1, 0, CASHIER.id, 0, 0, 0, 0)

  let inventoryId = 0
  let posId = 0
  const inventory = new ProductInventoryService(database, shop, {
    deviceName: 'POS-TEST-REGISTER',
    now: () => NOW,
    newId: () => `inventory-test-${++inventoryId}`,
  })
  const pointOfSale = new PointOfSaleService(database, shop, {
    workstation: 'POS-TEST-REGISTER',
    now: () => NOW,
    newId: () => `pos-test-${++posId}`,
  })
  return { database, shop, inventory, pointOfSale, close: () => database.close() }
}

function productDraft(overrides: Partial<ProductDraft> = {}): ProductDraft {
  return {
    sku: 'POS-001', name: 'Vitamin C', brand: 'Harbor', description: 'Vitamin supplement',
    barcode: '1234567890123', additionalBarcodes: [], category: 'Vitamins', subCategory: 'Supplements',
    department: '', shelfLocation: '', unit: 'tablet', packSizeUnits: 10,
    cost: '10.00', retailPrice: '20.00', wholesalePrice: '18.00', wholesaleMinimumQuantity: '5', reorderLevel: '2',
    genericName: '', prescriptionRequired: false, weighedItem: false, pluCode: '', pricePerKg: '',
    expiryTracking: false, variants: [], isActive: true,
    ...overrides,
  }
}

function createProduct(
  harness: ReturnType<typeof createHarness>,
  edition: 'PHARMACY' | 'SUPERMARKET' | 'BOTH',
  overrides: Partial<ProductDraft> = {},
): ProductRecord {
  return harness.inventory.createProduct(productDraft(overrides), { id: ADMIN.id, username: ADMIN.username, role: ADMIN.role }, edition)
}

function receiveStock(
  harness: ReturnType<typeof createHarness>,
  product: ProductRecord,
  edition: 'PHARMACY' | 'SUPERMARKET' | 'BOTH',
  quantity: string,
  batchNumber = '',
  expiryDate = '',
): ProductRecord {
  return harness.inventory.receiveStock({
    productId: product.id,
    expectedProductVersion: product.rowVersion,
    expectedStockVersion: product.stockVersion,
    quantity,
    quantityUnit: 'unit',
    unitCost: '10.00',
    supplierName: 'Coastal Medical Supplies',
    supplierReference: `INV-${batchNumber || product.sku}`,
    note: 'POS service test stock',
    batchNumber,
    expiryDate,
  }, { id: ADMIN.id, username: ADMIN.username, role: ADMIN.role }, edition).product
}

function oneLineSale(productId: string, overrides: Partial<CompletePosSaleInput> = {}): CompletePosSaleInput {
  return {
    idempotencyKey: 'pos-test-checkout-0001',
    saleType: 'RETAIL',
    items: [{ productId, quantity: '1' }],
    payments: [{ method: 'CASH', amount: '20.00' }],
    ...overrides,
  }
}

describe('PointOfSaleService settings enforcement', () => {
  it('refuses a payment method the shop switched off, and allows it again once re-enabled', () => {
    const harness = createHarness()
    try {
      const product = receiveStock(harness, createProduct(harness, 'PHARMACY', { sku: 'PAY-001' }), 'PHARMACY', '10', 'LOT-PAY', '2028-01-31')
      const settings = harness.shop.readSettings()
      harness.shop.saveSettings({
        ...settings,
        operational: { ...settings.operational, enabledPaymentMethods: ['CASH'] },
      })

      expect(() => harness.pointOfSale.completeSale(oneLineSale(product.id, {
        idempotencyKey: 'pos-test-payoff-0001',
        payments: [{ method: 'TRANSFER', amount: '20.00', reference: 'TRX-1' }],
      }), ADMIN, 'PHARMACY')).toThrow(/Bank transfer payments are switched off in Settings/i)

      expect(() => harness.pointOfSale.completeSale(oneLineSale(product.id, {
        idempotencyKey: 'pos-test-payoff-0002',
        payments: [{ method: 'CASH', amount: '20.00' }],
      }), ADMIN, 'PHARMACY')).not.toThrow()
    } finally {
      harness.close()
    }
  })

  it('applies the shop-wide discount ceiling even to an Admin', () => {
    const harness = createHarness()
    try {
      const product = receiveStock(harness, createProduct(harness, 'PHARMACY', { sku: 'DISC-001' }), 'PHARMACY', '10', 'LOT-DISC', '2028-01-31')
      const settings = harness.shop.readSettings()
      harness.shop.saveSettings({
        ...settings,
        operational: { ...settings.operational, discountLimitBasisPoints: 500 },
      })

      expect(() => harness.pointOfSale.completeSale(oneLineSale(product.id, {
        idempotencyKey: 'pos-test-disc-0001',
        items: [{ productId: product.id, quantity: '1', manualDiscount: '5.00' }],
      }), ADMIN, 'PHARMACY')).toThrow(/5% shop limit set in Settings/i)

      expect(harness.pointOfSale.completeSale(oneLineSale(product.id, {
        idempotencyKey: 'pos-test-disc-0002',
        items: [{ productId: product.id, quantity: '1', manualDiscount: '0.50' }],
      }), ADMIN, 'PHARMACY').receipt.totalMinor).toBe(1_950n)
    } finally {
      harness.close()
    }
  })
})

describe('PointOfSaleService', () => {
  it('allocates FEFO batches, persists an idempotent receipt, and audits first prints versus reprints', () => {
    const harness = createHarness()
    try {
      let product = createProduct(harness, 'PHARMACY', { genericName: 'ascorbic acid', sku: 'FEFO-001' })
      product = receiveStock(harness, product, 'PHARMACY', '3', 'LOT-LATE', '2028-06-30')
      product = receiveStock(harness, product, 'PHARMACY', '2', 'LOT-EARLY', '2027-03-31')
      const input = oneLineSale(product.id, {
        idempotencyKey: 'pos-test-fefo-0001',
        items: [{ productId: product.id, quantity: '2.5' }],
        payments: [{ method: 'CASH', amount: '60.00' }],
      })

      const quote = harness.pointOfSale.quoteSale({ saleType: input.saleType, items: input.items }, ADMIN, 'PHARMACY')
      expect(quote.totalMinor).toBe(5_000n)
      expect(quote.warnings).toEqual([])
      const completed = harness.pointOfSale.completeSale(input, ADMIN, 'PHARMACY')
      expect(completed.idempotentReplay).toBe(false)
      expect(completed.receipt).toMatchObject({
        receiptNumber: 'R-0000000001', saleType: 'RETAIL', subtotalMinor: 5_000n, totalMinor: 5_000n,
        paidMinor: 5_000n, tenderedMinor: 6_000n, changeMinor: 1_000n, currency: { code: 'NGN' },
        store: { name: 'Harbor Health', email: 'receipts@harbor.example', licenceNumber: 'LIC-204' },
        cashier: 'POS Admin', workstation: 'POS-TEST-REGISTER',
      })
      expect(usesIsoCodeFallback(completed.receipt, 'THERMAL_80')).toBe(true)
      expect(formatReceiptMoney(completed.receipt, 5_000n, 'THERMAL_80')).toContain('NGN')
      expect(usesIsoCodeFallback(completed.receipt, 'A4_RECEIPT')).toBe(false)
      const changedSettings = harness.shop.readSettings()
      harness.shop.saveSettings({ ...changedSettings, profile: { ...changedSettings.profile, name: 'Renamed Store' } })
      expect(harness.pointOfSale.getReceipt(completed.receipt.id, ADMIN).store.name).toBe('Harbor Health')
      const batchIds = harness.database.prepare('SELECT id, batch_no FROM product_batches').all() as Array<{ id: string; batch_no: string }>
      const earlyBatchId = batchIds.find(({ batch_no }) => batch_no === 'LOT-EARLY')!.id
      const lateBatchId = batchIds.find(({ batch_no }) => batch_no === 'LOT-LATE')!.id
      expect(completed.receipt.items[0]?.batches).toEqual([
        { batchId: earlyBatchId, batchNumber: 'LOT-EARLY', expiryDate: '2027-03-31', quantityMilli: 2_000n },
        { batchId: lateBatchId, batchNumber: 'LOT-LATE', expiryDate: '2028-06-30', quantityMilli: 500n },
      ])
      expect(completed.receipt.payments).toMatchObject([
        { method: 'CASH', amountMinor: 5_000n, tenderedMinor: 6_000n, changeMinor: 1_000n, currencyCode: 'NGN' },
      ])
      expect(harness.database.prepare('SELECT quantity_milli FROM stock WHERE product_id = ?').get(product.id)).toEqual({ quantity_milli: 2_500 })
      expect(harness.database.prepare('SELECT batch_no, quantity_milli FROM product_batches ORDER BY expiry_date').all()).toEqual([
        { batch_no: 'LOT-EARLY', quantity_milli: 0 }, { batch_no: 'LOT-LATE', quantity_milli: 2_500 },
      ])
      expect(harness.database.prepare('SELECT movement_type, reference_id, quantity_delta_milli FROM stock_movements WHERE movement_type = ?').get('SALE')).toMatchObject({
        movement_type: 'SALE', reference_id: 'R-0000000001', quantity_delta_milli: -2_500,
      })
      expect(harness.database.prepare("SELECT kind, amount_minor FROM business_entries WHERE kind = 'sale'").get()).toEqual({ kind: 'sale', amount_minor: 5_000 })

      const replay = harness.pointOfSale.completeSale(input, ADMIN, 'PHARMACY')
      expect(replay.idempotentReplay).toBe(true)
      expect(replay.receipt.id).toBe(completed.receipt.id)
      expect(harness.database.prepare('SELECT COUNT(*) AS count FROM sales').get()).toEqual({ count: 1 })
      expect(harness.database.prepare("SELECT COUNT(*) AS count FROM stock_movements WHERE movement_type = 'SALE'").get()).toEqual({ count: 1 })

      const firstPrint = harness.pointOfSale.recordReceiptPrint(completed.receipt.id, 'THERMAL_80', ADMIN)
      expect(firstPrint).toMatchObject({ duplicate: false, printCount: 1, store: { name: 'Harbor Health' } })
      expect(harness.pointOfSale.getReceipt(completed.receipt.id, ADMIN)).toMatchObject({ duplicate: false, printCount: 1 })
      expect(harness.pointOfSale.listRecentSales(ADMIN)[0]).toMatchObject({ duplicate: false, printCount: 1, currency: { code: 'NGN' } })
      const secondPrint = harness.pointOfSale.recordReceiptPrint(completed.receipt.id, 'A4_RECEIPT', ADMIN)
      expect(secondPrint).toMatchObject({ duplicate: true, printCount: 2 })
      expect(harness.database.prepare('SELECT is_duplicate, document_layout FROM sale_print_events ORDER BY printed_at, rowid').all()).toEqual([
        { is_duplicate: 0, document_layout: 'THERMAL_80' }, { is_duplicate: 1, document_layout: 'A4_RECEIPT' },
      ])
      expect(() => harness.database.prepare('UPDATE sale_print_events SET workstation = ?').run('tampered'))
        .toThrow(/immutable/u)
      expect(() => harness.database.prepare('DELETE FROM sale_print_events').run()).toThrow(/immutable/u)
    } finally {
      harness.close()
    }
  })

  it('shares quote and checkout discounts across promotion, manual discount, loyalty, split tender, and credit', () => {
    const harness = createHarness()
    try {
      const product = createProduct(harness, 'SUPERMARKET', { sku: 'GROCERY-001', department: 'Pantry' })
      receiveStock(harness, product, 'SUPERMARKET', '10')
      const customer = harness.pointOfSale.createCustomer({
        name: 'Ada Customer', phone: '+234 800 111 2222', email: 'ada@example.com', address: '4 Market Lane',
        creditLimit: '100.00', enrolLoyalty: true,
      }, ADMIN, 'SUPERMARKET')
      harness.database.prepare('UPDATE loyalty_members SET points_balance = 500 WHERE id = ?').run(customer.loyaltyMemberId)
      harness.database.prepare(`
        INSERT INTO promotions (
          id, name, promotion_type, amount_minor, discount_basis_points, starts_at, ends_at, is_active,
          product_id, department_id, minimum_quantity_milli, minimum_subtotal
        ) VALUES (?, ?, 'PERCENT', NULL, ?, ?, ?, 1, NULL, NULL, 0, 0)
      `).run('pos-promo-10', 'Pantry offer', 1_000, '2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z')

      const quote = harness.pointOfSale.quoteSale({
        saleType: 'RETAIL', items: [{ productId: product.id, quantity: '5', manualDiscount: '5.00' }],
        customerId: customer.id, loyaltyPointsToRedeem: 200,
      }, ADMIN, 'SUPERMARKET')
      expect(quote).toMatchObject({
        subtotalMinor: 10_000n, promotionName: 'Pantry offer', promotionDiscountMinor: 1_000n,
        manualDiscountMinor: 500n, loyaltyDiscountMinor: 200n, loyaltyPointsToRedeem: 200,
        loyaltyPointsEarned: 83, totalMinor: 8_300n, creditBalanceMinor: 0n, creditLimitMinor: 10_000n,
      })
      expect(quote.items[0]).toMatchObject({
        grossTotalMinor: 10_000n, manualDiscountMinor: 500n, promotionDiscountMinor: 1_000n,
        loyaltyDiscountMinor: 200n, lineTotalMinor: 8_300n,
      })

      const completed = harness.pointOfSale.completeSale({
        idempotencyKey: 'pos-test-credit-0001', saleType: 'RETAIL',
        items: [{ productId: product.id, quantity: '5', manualDiscount: '5.00' }],
        customerId: customer.id, loyaltyPointsToRedeem: 200,
        payments: [
          { method: 'TRANSFER', amount: '50.00', reference: 'BANK-REF-88' },
          { method: 'CASH', amount: '20.00' },
          { method: 'CREDIT', amount: '' },
        ],
      }, ADMIN, 'SUPERMARKET')
      expect(completed.receipt).toMatchObject({
        subtotalMinor: 10_000n, promotionDiscountMinor: 1_000n, manualDiscountMinor: 500n,
        loyaltyDiscountMinor: 200n, loyaltyPointsEarned: 83, loyaltyPointsRedeemed: 200,
        totalMinor: 8_300n, paidMinor: 7_000n, creditMinor: 1_300n, tenderedMinor: 7_000n,
        changeMinor: 0n, customer: { id: customer.id, name: 'Ada Customer', phone: '+234 800 111 2222' },
      })
      expect(completed.receipt.items[0]).toMatchObject({
        grossTotalMinor: 10_000n, discountMinor: 1_700n, lineTotalMinor: 8_300n,
      })
      expect(completed.receipt.payments).toMatchObject([
        { method: 'TRANSFER', amountMinor: 5_000n, reference: 'BANK-REF-88' },
        { method: 'CASH', amountMinor: 2_000n, tenderedMinor: 2_000n },
        { method: 'CREDIT', amountMinor: 1_300n },
      ])
      expect(harness.database.prepare('SELECT balance FROM customers WHERE id = ?').get(customer.id)).toEqual({ balance: 1_300 })
      expect(harness.database.prepare('SELECT points_balance FROM loyalty_members WHERE id = ?').get(customer.loyaltyMemberId)).toEqual({ points_balance: 383 })
      expect(harness.database.prepare('SELECT transaction_type, points_delta FROM loyalty_transactions ORDER BY rowid').all()).toEqual([
        { transaction_type: 'REDEEM', points_delta: -200 }, { transaction_type: 'EARN', points_delta: 83 },
      ])
      expect(harness.database.prepare('SELECT currency_name_snapshot, currency_decimals_snapshot, display_mode_snapshot FROM sales WHERE id = ?').get(completed.receipt.id)).toMatchObject({
        currency_name_snapshot: 'Nigerian naira', currency_decimals_snapshot: 2, display_mode_snapshot: 'symbol',
      })
    } finally {
      harness.close()
    }
  })

  it('snapshots expiry tracking for future returns and applies earned loyalty points against existing return debt', () => {
    const harness = createHarness()
    try {
      let product = createProduct(harness, 'BOTH', {
        sku: 'RETURN-SNAPSHOT-001', department: 'Pantry', expiryTracking: true,
      })
      product = receiveStock(harness, product, 'BOTH', '2', 'LOT-RETURN-SNAPSHOT', '2028-11-30')
      const customer = harness.pointOfSale.createCustomer({
        name: 'Loyal Customer', creditLimit: '0', enrolLoyalty: true,
      }, ADMIN, 'SUPERMARKET')
      harness.database.prepare('UPDATE loyalty_members SET points_debt = 35 WHERE id = ?').run(customer.loyaltyMemberId)

      const completed = harness.pointOfSale.completeSale({
        idempotencyKey: 'pos-return-snapshot-loyalty-0001', saleType: 'RETAIL',
        items: [{ productId: product.id, quantity: '1' }], customerId: customer.id,
        payments: [{ method: 'CASH', amount: '20.00' }],
      }, ADMIN, 'BOTH')

      expect(completed.receipt.items[0]?.batches).toMatchObject([
        { batchNumber: 'LOT-RETURN-SNAPSHOT', expiryDate: '2028-11-30', quantityMilli: 1_000n },
      ])
      expect(harness.database.prepare('SELECT expiry_tracking_snapshot FROM sale_items WHERE id = ?')
        .get(completed.receipt.items[0]!.id)).toEqual({ expiry_tracking_snapshot: 1 })
      expect(harness.database.prepare('SELECT points_balance, points_debt FROM loyalty_members WHERE id = ?')
        .get(customer.loyaltyMemberId)).toEqual({ points_balance: 0, points_debt: 15 })
      expect(harness.database.prepare('SELECT points_delta, transaction_type FROM loyalty_transactions ORDER BY rowid').all())
        .toEqual([
          { points_delta: 20, transaction_type: 'EARN' },
          { points_delta: -20, transaction_type: 'ADJUST' },
        ])
    } finally {
      harness.close()
    }
  })

  it('keeps held carts cashier-private and removes a recalled cart only after successful checkout', () => {
    const harness = createHarness()
    try {
      const product = createProduct(harness, 'SUPERMARKET', { sku: 'HELD-001' })
      receiveStock(harness, product, 'SUPERMARKET', '2')
      const held = harness.pointOfSale.holdCart({
        saleType: 'RETAIL', items: [{ productId: product.id, quantity: '1', manualDiscount: '0' }],
        customerId: null, loyaltyPointsToRedeem: 0,
      }, CASHIER)
      expect(harness.pointOfSale.listHeldCarts(CASHIER)).toHaveLength(1)
      expect(harness.pointOfSale.listHeldCarts(ADMIN)).toHaveLength(0)
      expect(() => harness.pointOfSale.recallHeldCart(held.id, ADMIN)).toThrow(/another cashier/u)
      expect(harness.pointOfSale.recallHeldCart(held.id, CASHIER)).toMatchObject({ id: held.id, data: { saleType: 'RETAIL' } })

      const completed = harness.pointOfSale.completeSale(oneLineSale(product.id, {
        idempotencyKey: 'pos-test-held-0001', heldCartId: held.id,
      }), CASHIER, 'SUPERMARKET')
      expect(completed.receipt.totalMinor).toBe(2_000n)
      expect(harness.pointOfSale.listHeldCarts(CASHIER)).toEqual([])
      expect(harness.database.prepare('SELECT COUNT(*) AS count FROM held_carts').get()).toEqual({ count: 0 })
      expect(harness.database.prepare('SELECT quantity_milli FROM stock WHERE product_id = ?').get(product.id)).toEqual({ quantity_milli: 1_000 })
    } finally {
      harness.close()
    }
  })

  it('rolls back sale, stock, payment, and business records together when the audit ledger fails', () => {
    const harness = createHarness()
    try {
      const product = createProduct(harness, 'PHARMACY', { sku: 'ROLLBACK-001', genericName: 'ascorbic acid', prescriptionRequired: true })
      receiveStock(harness, product, 'PHARMACY', '2', 'LOT-ROLLBACK', '2027-12-31')
      const input = oneLineSale(product.id, { idempotencyKey: 'pos-test-rollback-0001', prescriptionAcknowledged: true })
      const quote = harness.pointOfSale.quoteSale({ saleType: 'RETAIL', items: input.items }, ADMIN, 'PHARMACY')
      expect(quote.warnings).toEqual(['Prescription required: Vitamin C'])
      expect(() => harness.pointOfSale.completeSale({ ...input, prescriptionAcknowledged: false }, ADMIN, 'PHARMACY'))
        .toThrow(/Prescription confirmation is required/u)
      harness.database.exec(`
        CREATE TRIGGER reject_pos_sale_audit
        BEFORE INSERT ON audit_log WHEN NEW.action = 'pos.sale.completed'
        BEGIN SELECT RAISE(ABORT, 'POS audit unavailable'); END;
      `)
      expect(() => harness.pointOfSale.completeSale(input, ADMIN, 'PHARMACY')).toThrow(/POS audit unavailable/u)
      expect(harness.database.prepare('SELECT COUNT(*) AS count FROM sales').get()).toEqual({ count: 0 })
      expect(harness.database.prepare('SELECT COUNT(*) AS count FROM payments').get()).toEqual({ count: 0 })
      expect(harness.database.prepare('SELECT COUNT(*) AS count FROM business_entries WHERE kind = ?').get('sale')).toEqual({ count: 0 })
      expect(harness.database.prepare("SELECT COUNT(*) AS count FROM stock_movements WHERE movement_type = 'SALE'").get()).toEqual({ count: 0 })
      expect(harness.database.prepare('SELECT quantity_milli FROM stock WHERE product_id = ?').get(product.id)).toEqual({ quantity_milli: 2_000 })
      expect(harness.database.prepare('SELECT quantity_milli FROM product_batches WHERE batch_no = ?').get('LOT-ROLLBACK')).toEqual({ quantity_milli: 2_000 })

      harness.database.exec('DROP TRIGGER reject_pos_sale_audit')
      const completed = harness.pointOfSale.completeSale(input, ADMIN, 'PHARMACY')
      expect(completed.idempotentReplay).toBe(false)
      expect(() => harness.pointOfSale.completeSale(input, CASHIER, 'PHARMACY')).toThrow(/belongs to another cashier/u)
      expect(() => harness.pointOfSale.quoteSale({
        saleType: 'WHOLESALE', items: [{ productId: product.id, quantity: '1' }],
      }, CASHIER, 'PHARMACY')).toThrow(/permission to make wholesale/u)
      expect(() => harness.pointOfSale.quoteSale({
        saleType: 'RETAIL', items: [{ productId: product.id, quantity: '1', manualDiscount: '1.00' }],
      }, CASHIER, 'PHARMACY')).toThrow(/discount exceeds your 0%/u)
      expect(() => harness.pointOfSale.createCustomer({ name: 'Unauthorized', creditLimit: '0' }, CASHIER, 'PHARMACY')).toThrow(/Only the Admin/u)
      expect(() => harness.pointOfSale.createCustomer({ name: 'Pharmacy loyalty', creditLimit: '0', enrolLoyalty: true }, ADMIN, 'PHARMACY'))
        .toThrow(/supermarket edition/u)
      expect(harness.database.prepare('SELECT COUNT(*) AS count FROM sales').get()).toEqual({ count: 1 })
    } finally {
      harness.close()
    }
  })
})
