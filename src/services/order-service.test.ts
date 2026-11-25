import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { getCurrency } from '../currency/catalog'
import { defaultDisplayOptions } from '../currency/money'
import { migrateDatabase } from '../db/migrate'
import { SQLiteShopRepository } from '../db/sqlite-shop-repository'
import type { PublicUser } from '../shared/auth/types'
import type { ProductDraft, ProductRecord } from '../shared/inventory/types'
import { ORDER_SLIP_NOT_A_RECEIPT } from '../shared/orders/types'
import { ProductInventoryService } from './product-inventory-service'
import { PointOfSaleService } from './point-of-sale-service'
import { OrderAlreadyCompletedError, OrderPriceChangedError, OrderService } from './order-service'

/**
 * The order-to-receipt workflow, end to end against a real database.
 *
 * Every test here drives the service the way the host will: a picker creates, an Account finalizes, and the assertions
 * are about stock, money and the audit trail rather than about the shape of a return value. The rules that matter are
 * the ones a shop would notice — the last unit promised twice, a sale created by a double-click, stock held forever by
 * an order nobody paid for.
 */

const PERMS_ADMIN = { allowWholesale: true, maxDiscountBasisPoints: 10_000, allowCreditSales: true, returnLimitMinor: 0n }
const PERMS_PICKER = { allowWholesale: false, maxDiscountBasisPoints: 0, allowCreditSales: false, returnLimitMinor: 0n }
const PERMS_ACCOUNT = { allowWholesale: false, maxDiscountBasisPoints: 500, allowCreditSales: true, returnLimitMinor: 0n }

const ADMIN: PublicUser = { id: 'u-admin', fullName: 'Ada Admin', username: 'ada', role: 'ADMIN', isActive: true, isLocked: false, permissions: PERMS_ADMIN }
const PICKER: PublicUser = { id: 'u-picker', fullName: 'Uche Picker', username: 'user1', role: 'USER', isActive: true, isLocked: false, permissions: PERMS_PICKER }
const OTHER_PICKER: PublicUser = { id: 'u-picker2', fullName: 'Bola Picker', username: 'user2', role: 'USER', isActive: true, isLocked: false, permissions: PERMS_PICKER }
const ACCOUNT: PublicUser = { id: 'u-account', fullName: 'Amaka Account', username: 'account1', role: 'ACCOUNT', isActive: true, isLocked: false, permissions: PERMS_ACCOUNT }
const SECOND_ACCOUNT: PublicUser = { id: 'u-account2', fullName: 'Tunde Account', username: 'account2', role: 'ACCOUNT', isActive: true, isLocked: false, permissions: PERMS_ACCOUNT }
const SUPERVISOR: PublicUser = { id: 'u-supervisor', fullName: 'Sam Supervisor', username: 'supervisor1', role: 'SUPERVISOR', isActive: true, isLocked: false, permissions: PERMS_PICKER }

const NOW = Date.parse('2026-11-17T12:00:00.000Z')

interface Harness {
  database: Database.Database
  shop: SQLiteShopRepository
  inventory: ProductInventoryService
  pointOfSale: PointOfSaleService
  orders: OrderService
  /** Move the clock, so expiry can be tested without waiting two hours. */
  advance: (minutes: number) => void
}

function createHarness(currencyCode = 'NGN', edition: 'PHARMACY' | 'SUPERMARKET' | 'BOTH' = 'PHARMACY'): Harness {
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
  const insertPerms = database.prepare(`
    INSERT INTO user_permissions (user_id, allow_wholesale, max_discount_pct, allow_credit_sales, return_limit)
    VALUES (?, ?, ?, ?, ?)
  `)
  for (const user of [ADMIN, PICKER, OTHER_PICKER, ACCOUNT, SECOND_ACCOUNT, SUPERVISOR]) {
    insertUser.run(user.id, user.username, 'test-hash', user.role, user.fullName)
    const perms = user.permissions
    insertPerms.run(user.id, perms.allowWholesale ? 1 : 0, perms.maxDiscountBasisPoints, perms.allowCreditSales ? 1 : 0, Number(perms.returnLimitMinor))
  }
  void edition

  let clock = NOW
  let inventoryId = 0
  let posId = 0
  let orderId = 0
  const inventory = new ProductInventoryService(database, shop, {
    deviceName: 'ORDER-TEST-PC', now: () => clock, newId: () => `inventory-${++inventoryId}`,
  })
  const pointOfSale = new PointOfSaleService(database, shop, {
    workstation: 'ORDER-TEST-PC', now: () => clock, newId: () => `pos-${++posId}`,
  })
  const orders = new OrderService(database, shop, pointOfSale, {
    workstation: 'ORDER-TEST-PC', now: () => clock, newId: () => `order-${++orderId}`,
  })
  return { database, shop, inventory, pointOfSale, orders, advance: (minutes) => { clock += minutes * 60_000 } }
}

function productDraft(overrides: Partial<ProductDraft> = {}): ProductDraft {
  return {
    sku: 'ORD-001', name: 'Vitamin C', brand: 'Harbor', description: 'Vitamin supplement',
    barcode: '1234567890123', additionalBarcodes: [], category: 'Vitamins', subCategory: 'Supplements',
    department: '', shelfLocation: '', unit: 'tablet', packSizeUnits: 10,
    cost: '10.00', retailPrice: '20.00', wholesalePrice: '18.00', wholesaleMinimumQuantity: '5', reorderLevel: '2',
    genericName: '', prescriptionRequired: false, weighedItem: false, pluCode: '', pricePerKg: '',
    expiryTracking: false, variants: [], isActive: true,
    ...overrides,
  }
}

function createProduct(harness: Harness, edition: 'PHARMACY' | 'SUPERMARKET' | 'BOTH', overrides: Partial<ProductDraft> = {}): ProductRecord {
  return harness.inventory.createProduct(productDraft(overrides), ADMIN, edition)
}

function receiveStock(
  harness: Harness, product: ProductRecord, edition: 'PHARMACY' | 'SUPERMARKET' | 'BOTH',
  quantity: string, batchNumber = 'LOT-DEFAULT', expiryDate = '2028-12-31',
): ProductRecord {
  // In the pharmacy edition every product is expiry-tracked, so a receipt without a batch and an expiry is refused.
  // The defaults here are a long-dated lot; the FEFO test passes its own so the ordering is the thing under test.
  return harness.inventory.receiveStock({
    productId: product.id, expectedProductVersion: product.rowVersion, expectedStockVersion: product.stockVersion,
    quantity, quantityUnit: 'unit', unitCost: '10.00', supplierName: 'Coastal Medical Supplies',
    supplierReference: `INV-${batchNumber || product.sku}`, note: 'Order workflow test stock',
    batchNumber, expiryDate,
  }, ADMIN, edition).product
}

/**
 * Change a product's retail price through the real inventory service.
 *
 * Not a direct UPDATE: the price-change test is about the order service noticing, and it should notice a price that
 * changed the way prices really change — through the Admin's screen, with the row version checked.
 */
function reprice(harness: Harness, product: ProductRecord, retailPrice: string): ProductRecord {
  const current = harness.database.prepare('SELECT row_version FROM products WHERE id = ?').get(product.id) as { row_version: number }
  return harness.inventory.updateProduct({
    ...productDraft({ sku: product.sku, name: product.name }), id: product.id,
    expectedVersion: current.row_version, retailPrice,
  } as ProductDraft, ADMIN, 'PHARMACY')
}

function stockOf(harness: Harness, productId: string): { quantity: bigint; reserved: bigint } {
  const row = harness.database.prepare(`
    SELECT CAST(quantity_milli AS TEXT) AS q, CAST(reserved_milli AS TEXT) AS r FROM stock WHERE product_id = ?
  `).get(productId) as { q: string; r: string }
  return { quantity: BigInt(row.q), reserved: BigInt(row.r) }
}

function cashFor(totalMinor: bigint, decimals: number): string {
  const factor = 10n ** BigInt(decimals)
  const whole = totalMinor / factor
  const fraction = (totalMinor % factor).toString().padStart(decimals, '0')
  return decimals === 0 ? whole.toString() : `${whole}.${fraction}`
}

/** Create an order for one product and return it with the stock it reserved. */
function oneLineOrder(harness: Harness, product: ProductRecord, quantity = '2', actor: PublicUser = PICKER) {
  return harness.orders.createOrder({
    saleType: 'RETAIL', items: [{ productId: product.id, quantity }], idempotencyKey: `key-${product.id}-${quantity}-${actor.id}`,
  }, actor, 'PHARMACY')
}

describe('a picker generates an order and the stock is reserved, not deducted', () => {
  it('creates a PENDING order with a number, and holds the stock', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '10')

    const order = oneLineOrder(harness, product)

    expect(order.status).toBe('PENDING')
    expect(order.orderNumber).toMatch(/^ORD-\d{6}$/u)
    expect(order.createdByName).toBe('Uche Picker')
    const stock = stockOf(harness, product.id)
    // Reserved, not gone: the goods are still on the shelf and still counted, but promised.
    expect(stock.quantity, 'quantity is untouched until payment').toBe(10_000n)
    expect(stock.reserved, 'the order holds what it asked for').toBe(2_000n)
  })

  it('marks the slip as not a receipt, and gives the picker no way to print it', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '10')
    const order = oneLineOrder(harness, product)

    expect(order.receiptNumber, 'an unpaid order has no receipt number').toBeNull()
    expect(order.saleId).toBeNull()
    // The constant is what the screen prints; asserting it here keeps the wording from drifting silently.
    expect(ORDER_SLIP_NOT_A_RECEIPT).toBe('NOT PAID - NOT A RECEIPT')
    // The service exposes no print method at all: the rule is not "the button is hidden".
    expect(typeof (harness.orders as unknown as Record<string, unknown>).printOrder).toBe('undefined')
    expect(typeof (harness.orders as unknown as Record<string, unknown>).printSlip).toBe('undefined')
  })

  it('snapshots the price, so a later price change does not rewrite the slip', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '10')
    const order = oneLineOrder(harness, product)
    expect(order.lines[0]!.unitPriceMinor).toBe(2_000n)

    reprice(harness, product, '35.00')
    const reread = harness.orders.getOrder(order.id, PICKER)
    expect(reread.lines[0]!.unitPriceMinor, 'the snapshot holds').toBe(2_000n)
  })

  it('sets an expiry from the shop setting, defaulting to two hours', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '10')
    const order = oneLineOrder(harness, product)
    expect(order.expiresAt).toBe('2026-11-17T14:00:00.000Z')
  })

  it('refuses to reserve more than is available, and leaves nothing half-created', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '3')
    expect(() => harness.orders.createOrder({
      saleType: 'RETAIL', items: [{ productId: product.id, quantity: '9' }], idempotencyKey: 'too-much-key',
    }, PICKER, 'PHARMACY')).toThrow(/not enough available stock/u)
    // The order row and any partial reservation must both be gone, not left to confuse the queue.
    expect((harness.database.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n).toBe(0)
    expect(stockOf(harness, product.id).reserved).toBe(0n)
  })

  it('will not let two orders promise the same last unit', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '2')
    oneLineOrder(harness, product, '2', PICKER)
    // The second picker is refused by the condition on the UPDATE, not by a check that ran a moment earlier.
    expect(() => oneLineOrder(harness, product, '1', OTHER_PICKER)).toThrow(/not enough available stock/u)
    expect(stockOf(harness, product.id).reserved).toBe(2_000n)
  })

  it('returns the same order for a retried create instead of reserving twice', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '10')
    const first = harness.orders.createOrder({
      saleType: 'RETAIL', items: [{ productId: product.id, quantity: '3' }], idempotencyKey: 'same-create-key',
    }, PICKER, 'PHARMACY')
    const second = harness.orders.createOrder({
      saleType: 'RETAIL', items: [{ productId: product.id, quantity: '3' }], idempotencyKey: 'same-create-key',
    }, PICKER, 'PHARMACY')
    expect(second.id).toBe(first.id)
    expect(stockOf(harness, product.id).reserved, 'reserved once').toBe(3_000n)
  })
})

describe('the order appears live in the Account queue', () => {
  it('lists pending orders for an Account, oldest first', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '20')
    const first = oneLineOrder(harness, product, '1', PICKER)
    harness.advance(5)
    const second = oneLineOrder(harness, product, '2', OTHER_PICKER)

    const queue = harness.orders.listQueue(ACCOUNT)
    expect(queue.map((order) => order.id)).toEqual([first.id, second.id])
    expect(queue[0]!.createdByName).toBe('Uche Picker')
  })

  it('refuses the queue to a picker, who sees only their own orders', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '20')
    oneLineOrder(harness, product, '1', PICKER)
    oneLineOrder(harness, product, '1', OTHER_PICKER)

    expect(() => harness.orders.listQueue(PICKER)).toThrow(/cannot see the order queue/u)
    const mine = harness.orders.listMyOrders(PICKER)
    expect(mine).toHaveLength(1)
    expect(mine[0]!.createdByName).toBe('Uche Picker')
  })

  it('refuses a picker another picker\'s order by id', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '20')
    const theirs = oneLineOrder(harness, product, '1', OTHER_PICKER)
    expect(() => harness.orders.getOrder(theirs.id, PICKER)).toThrow(/belongs to another picker/u)
  })

  it('shows a picker their own order status changing to PAID', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '20')
    const order = oneLineOrder(harness, product, '1', PICKER)
    expect(harness.orders.getOrder(order.id, PICKER).status).toBe('PENDING')

    harness.orders.finalizeOrder(order.id, {
      idempotencyKey: 'pay-key-1', payments: [{ method: 'CASH', amount: cashFor(order.totalMinor, 2) }],
    }, ACCOUNT, 'PHARMACY')

    expect(harness.orders.getOrder(order.id, PICKER).status).toBe('PAID')
  })
})

describe('finalizing deducts the stock once and records one sale', () => {
  it('releases the hold and deducts the goods in one step', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '10')
    const order = oneLineOrder(harness, product, '4', PICKER)
    expect(stockOf(harness, product.id)).toMatchObject({ quantity: 10_000n, reserved: 4_000n })

    const result = harness.orders.finalizeOrder(order.id, {
      idempotencyKey: 'pay-key-2', payments: [{ method: 'CASH', amount: cashFor(order.totalMinor, 2) }],
    }, ACCOUNT, 'PHARMACY')

    const stock = stockOf(harness, product.id)
    // 10 − 4 = 6 on the shelf, and nothing held: the reservation became the deduction rather than sitting on top of it.
    expect(stock).toMatchObject({ quantity: 6_000n, reserved: 0n })
    expect(result.receiptNumber).toMatch(/^R-\d{10}$/u)
    expect(result.order.status).toBe('PAID')
    expect(result.order.finalizedByName).toBe('Amaka Account')
  })

  it('records the sale with the Account as cashier and the picker on the order', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '10')
    const order = oneLineOrder(harness, product, '1', PICKER)
    const result = harness.orders.finalizeOrder(order.id, {
      idempotencyKey: 'pay-key-3', payments: [{ method: 'CASH', amount: cashFor(order.totalMinor, 2) }],
    }, ACCOUNT, 'PHARMACY')

    const sale = harness.database.prepare('SELECT cashier_id, receipt_number, currency_code, store_name FROM sales WHERE id = ?')
      .get(result.saleId) as { cashier_id: string; receipt_number: string; currency_code: string; store_name: string }
    expect(sale.cashier_id).toBe(ACCOUNT.id)
    expect(sale.receipt_number).toBe(result.receiptNumber)
    expect(sale.currency_code).toBe('NGN')
    expect(sale.store_name, 'the store name is snapshotted on the sale').toBe('Harbor Health')
  })

  it('audits the finalize with the receipt number and the workstation', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '10')
    const order = oneLineOrder(harness, product, '1', PICKER)
    const result = harness.orders.finalizeOrder(order.id, {
      idempotencyKey: 'pay-key-4', payments: [{ method: 'CASH', amount: cashFor(order.totalMinor, 2) }],
    }, ACCOUNT, 'PHARMACY')

    const row = harness.database.prepare("SELECT actor, metadata_json, device_name FROM audit_log WHERE action = 'order.finalized'")
      .get() as { actor: string; metadata_json: string; device_name: string }
    expect(row.actor).toBe('account1')
    expect(row.device_name).toBe('ORDER-TEST-PC')
    const metadata = JSON.parse(row.metadata_json)
    expect(metadata.receiptNumber).toBe(result.receiptNumber)
    expect(metadata.orderNumber).toBe(order.orderNumber)
  })

  it('takes FEFO across batches in the pharmacy edition', () => {
    const harness = createHarness()
    const product = createProduct(harness, 'PHARMACY', { expiryTracking: true, sku: 'FEFO-1', name: 'Amoxicillin' })
    // Received out of expiry order on purpose: the earlier-expiring batch arrives second, so "first received" and
    // "first to expire" disagree and only a real FEFO allocation picks the right one.
    let updated = receiveStock(harness, product, 'PHARMACY', '5', 'B-LATER', '2027-06-30')
    updated = receiveStock(harness, updated, 'PHARMACY', '5', 'B-SOONER', '2026-12-31')

    const order = harness.orders.createOrder({
      saleType: 'RETAIL', items: [{ productId: product.id, quantity: '3' }], idempotencyKey: 'fefo-key-1',
    }, PICKER, 'PHARMACY')
    harness.orders.finalizeOrder(order.id, {
      idempotencyKey: 'pay-key-fefo', payments: [{ method: 'CASH', amount: cashFor(order.totalMinor, 2) }],
      prescriptionAcknowledged: true,
    }, ACCOUNT, 'PHARMACY')

    const batches = harness.database.prepare(`
      SELECT b.batch_no, CAST(b.quantity_milli AS TEXT) AS q FROM product_batches b
      WHERE b.product_id = ? ORDER BY b.batch_no
    `).all(product.id) as Array<{ batch_no: string; q: string }>
    const byBatch = Object.fromEntries(batches.map((batch) => [batch.batch_no, BigInt(batch.q)]))
    // The sooner-expiring batch is drawn down first, and the later one is untouched.
    expect(byBatch['B-SOONER']).toBe(2_000n)
    expect(byBatch['B-LATER']).toBe(5_000n)
  })

  it('warns on a prescription item and refuses to finalize without acknowledgement', () => {
    const harness = createHarness()
    const product = createProduct(harness, 'PHARMACY', {
      prescriptionRequired: true, sku: 'RX-1', name: 'Codeine syrup',
    })
    const stocked = receiveStock(harness, product, 'PHARMACY', '10')
    const order = oneLineOrder(harness, stocked, '1', PICKER)
    expect(order.needsPrescriptionAck, 'the slip flags the prescription line').toBe(true)

    expect(() => harness.orders.finalizeOrder(order.id, {
      idempotencyKey: 'pay-key-rx', payments: [{ method: 'CASH', amount: cashFor(order.totalMinor, 2) }],
    }, ACCOUNT, 'PHARMACY')).toThrow(/Prescription confirmation/u)

    // Acknowledged, it goes through — and the reservation is not left behind by the failed attempt.
    expect(stockOf(harness, product.id).reserved, 'the failed attempt rolled back').toBe(1_000n)
    harness.orders.finalizeOrder(order.id, {
      idempotencyKey: 'pay-key-rx', payments: [{ method: 'CASH', amount: cashFor(order.totalMinor, 2) }],
      prescriptionAcknowledged: true,
    }, ACCOUNT, 'PHARMACY')
    expect(stockOf(harness, product.id)).toMatchObject({ quantity: 9_000n, reserved: 0n })
  })
})

describe('the payment endpoint is closed to the roles that may not take money', () => {
  const refused: Array<[string, PublicUser]> = [
    ['a USER (picker)', PICKER],
    ['a SUPERVISOR', SUPERVISOR],
  ]

  it.each(refused)('refuses finalize to %s', (_label, actor) => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '10')
    const order = oneLineOrder(harness, product, '1', PICKER)
    expect(() => harness.orders.finalizeOrder(order.id, {
      idempotencyKey: 'nope-key-1', payments: [{ method: 'CASH', amount: cashFor(order.totalMinor, 2) }],
    }, actor, 'PHARMACY')).toThrow(/cannot finalize an order and take payment/u)
    // Refused before anything was written: the stock is still held, not deducted.
    expect(stockOf(harness, product.id)).toMatchObject({ quantity: 10_000n, reserved: 1_000n })
    expect((harness.database.prepare('SELECT COUNT(*) AS n FROM sales').get() as { n: number }).n).toBe(0)
  })

  it('refuses a locked or inactive account even in an allowed role', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '10')
    const order = oneLineOrder(harness, product, '1', PICKER)
    const locked = { ...ACCOUNT, isLocked: true }
    expect(() => harness.orders.finalizeOrder(order.id, {
      idempotencyKey: 'locked-key-1', payments: [{ method: 'CASH', amount: cashFor(order.totalMinor, 2) }],
    }, locked, 'PHARMACY')).toThrow(/active signed-in user/u)
  })

  it('refuses to create an order to a role that may not build one', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '10')
    // A SUPERVISOR is read-only: it may not build an order any more than it may take payment.
    expect(() => harness.orders.createOrder({
      saleType: 'RETAIL', items: [{ productId: product.id, quantity: '1' }], idempotencyKey: 'sup-key-1',
    }, SUPERVISOR, 'PHARMACY')).toThrow(/cannot create an order/u)
  })
})

describe('two Accounts finalizing one order produce exactly one sale', () => {
  it('lets the first through and tells the second it is already completed', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '10')
    const order = oneLineOrder(harness, product, '3', PICKER)

    const first = harness.orders.finalizeOrder(order.id, {
      idempotencyKey: 'race-key-a', payments: [{ method: 'CASH', amount: cashFor(order.totalMinor, 2) }],
    }, ACCOUNT, 'PHARMACY')
    expect(first.idempotentReplay).toBe(false)

    let caught: unknown = null
    try {
      harness.orders.finalizeOrder(order.id, {
        idempotencyKey: 'race-key-b', payments: [{ method: 'CASH', amount: cashFor(order.totalMinor, 2) }],
      }, SECOND_ACCOUNT, 'PHARMACY')
    } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(OrderAlreadyCompletedError)
    expect(String((caught as Error).message)).toMatch(/already completed by another account/u)

    const sales = harness.database.prepare('SELECT COUNT(*) AS n FROM sales').get() as { n: number }
    expect(sales.n, 'one sale, not two').toBe(1)
    expect(stockOf(harness, product.id), 'stock deducted once').toMatchObject({ quantity: 7_000n, reserved: 0n })
  })

  it('replaying the same key returns the first result rather than selling again', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '10')
    const order = oneLineOrder(harness, product, '2', PICKER)
    const input = { idempotencyKey: 'double-click-key', payments: [{ method: 'CASH', amount: cashFor(order.totalMinor, 2) }] }

    const first = harness.orders.finalizeOrder(order.id, input, ACCOUNT, 'PHARMACY')
    const second = harness.orders.finalizeOrder(order.id, input, ACCOUNT, 'PHARMACY')

    expect(second.idempotentReplay, 'the retry says it replayed').toBe(true)
    expect(second.receiptNumber).toBe(first.receiptNumber)
    expect(second.saleId).toBe(first.saleId)
    expect((harness.database.prepare('SELECT COUNT(*) AS n FROM sales').get() as { n: number }).n).toBe(1)
    expect(stockOf(harness, product.id), 'deducted once').toMatchObject({ quantity: 8_000n, reserved: 0n })
  })

  it('refuses to finalize without a key at all, because a keyless retry is two sales', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '10')
    const order = oneLineOrder(harness, product, '1', PICKER)
    expect(() => harness.orders.finalizeOrder(order.id, {
      idempotencyKey: '   ', payments: [{ method: 'CASH', amount: cashFor(order.totalMinor, 2) }],
    }, ACCOUNT, 'PHARMACY')).toThrow(/needs an idempotency key/u)
  })

  it('refuses a picker and a SUPERVISOR at the payment endpoint, and lets an Account through', () => {
    // The brief asks for both ends of this to be tested: no print endpoint and no payment endpoint for these two
    // roles. The print half is in `print-gate-service.test.ts`; this is the payment half, called as each role rather
    // than asserted from a table, because a capability row can be right while the service forgets to consult it.
    for (const actor of [PICKER, SUPERVISOR]) {
      const harness = createHarness()
      const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '10')
      const order = oneLineOrder(harness, product, '1', PICKER)
      expect(
        () => harness.orders.finalizeOrder(order.id, {
          idempotencyKey: `refused-${actor.role.toLowerCase()}-0001`,
          payments: [{ method: 'CASH', amount: cashFor(order.totalMinor, 2) }],
        }, actor, 'PHARMACY'),
        `${actor.role} must be refused at the payment endpoint`,
      ).toThrow(/role cannot/u)
      // Refused means nothing happened: the order is still awaiting payment and its stock is still held, not sold.
      // Read from the row rather than through the service, because the service would rightly refuse to show this order
      // to a SUPERVISOR at all, and "you may not read it" would then be standing in for "nothing changed".
      expect(harness.database.prepare('SELECT status FROM orders WHERE id = ?').get(order.id))
        .toEqual({ status: 'PENDING' })
      expect(stockOf(harness, product.id).reserved).toBe(1_000n)
      harness.database.close()
    }

    // And the role that is meant to get through does, on the same order shape.
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '10')
    const order = oneLineOrder(harness, product, '1', PICKER)
    const result = harness.orders.finalizeOrder(order.id, {
      idempotencyKey: 'allowed-account-0001',
      payments: [{ method: 'CASH', amount: cashFor(order.totalMinor, 2) }],
    }, ACCOUNT, 'PHARMACY')
    expect(result.order.status).toBe('PAID')
    harness.database.close()
  })
})

describe('prices are re-checked at finalize', () => {
  it('refuses and shows the difference when a price moved, then accepts once told to', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '10')
    const order = oneLineOrder(harness, product, '2', PICKER)
    const wasTotal = order.totalMinor

    reprice(harness, product, '25.00')

    let caught: unknown = null
    try {
      harness.orders.finalizeOrder(order.id, {
        idempotencyKey: 'price-key-1', payments: [{ method: 'CASH', amount: cashFor(wasTotal, 2) }],
      }, ACCOUNT, 'PHARMACY')
    } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(OrderPriceChangedError)
    const changes = (caught as OrderPriceChangedError).changes
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ wasMinor: 2_000n, nowMinor: 2_500n })
    // Nothing was written while the Account was being asked.
    expect(stockOf(harness, product.id).reserved).toBe(2_000n)

    const accepted = harness.orders.finalizeOrder(order.id, {
      idempotencyKey: 'price-key-2', payments: [{ method: 'CASH', amount: '50.00' }], acceptPriceChange: true,
    }, ACCOUNT, 'PHARMACY')
    expect(accepted.priceChangesAccepted).toHaveLength(1)
    expect(accepted.order.status).toBe('PAID')
  })

  it('leaves an order alone when no price moved', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '10')
    const order = oneLineOrder(harness, product, '1', PICKER)
    const result = harness.orders.finalizeOrder(order.id, {
      idempotencyKey: 'no-change-key', payments: [{ method: 'CASH', amount: cashFor(order.totalMinor, 2) }],
    }, ACCOUNT, 'PHARMACY')
    expect(result.priceChangesAccepted).toEqual([])
  })
})

describe('unpaid orders expire and release their stock', () => {
  it('releases the reservation after the configured window', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '10')
    const order = oneLineOrder(harness, product, '4', PICKER)
    expect(stockOf(harness, product.id).reserved).toBe(4_000n)

    harness.advance(119)
    expect(harness.orders.expireDueOrders(ADMIN), 'not yet due').toBe(0)
    expect(stockOf(harness, product.id).reserved).toBe(4_000n)

    harness.advance(2)
    const expired = harness.orders.expireDueOrders(ADMIN)
    expect(expired).toBe(1)
    const stock = stockOf(harness, product.id)
    expect(stock, 'the goods are available again and nothing was sold').toMatchObject({ quantity: 10_000n, reserved: 0n })
    expect(harness.orders.getOrder(order.id, PICKER).status).toBe('EXPIRED')
  })

  it('refuses to finalize an order that expired while the Account was counting cash', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '10')
    const order = oneLineOrder(harness, product, '1', PICKER)
    harness.advance(180)
    expect(() => harness.orders.finalizeOrder(order.id, {
      idempotencyKey: 'too-late-key', payments: [{ method: 'CASH', amount: cashFor(order.totalMinor, 2) }],
    }, ACCOUNT, 'PHARMACY')).toThrow(OrderAlreadyCompletedError)
    expect((harness.database.prepare('SELECT COUNT(*) AS n FROM sales').get() as { n: number }).n).toBe(0)
  })

  it('honours a shorter expiry set by the Admin', () => {
    const harness = createHarness()
    harness.database.prepare('UPDATE settings SET order_expiry_minutes = 30').run()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '10')
    const order = oneLineOrder(harness, product, '1', PICKER)
    expect(order.expiresAt).toBe('2026-11-17T12:30:00.000Z')
    harness.advance(31)
    expect(harness.orders.expireDueOrders(ADMIN)).toBe(1)
  })

  it('cannot be given an expiry the schema rejects, so an order can never hold stock forever', () => {
    const harness = createHarness()
    // The service reads this column with no fallback of its own, on the understanding that the schema makes a bad value
    // impossible. These assertions are what makes that understanding true rather than assumed: an order that never
    // expires would hold stock the shop can never sell, and nobody would notice until a stocktake.
    expect(() => harness.database.prepare('UPDATE settings SET order_expiry_minutes = NULL').run())
      .toThrow(/NOT NULL/u)
    expect(() => harness.database.prepare('UPDATE settings SET order_expiry_minutes = 0').run())
      .toThrow(/CHECK/u)
    expect(() => harness.database.prepare('UPDATE settings SET order_expiry_minutes = 10081').run())
      .toThrow(/CHECK/u)

    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '10')
    const order = oneLineOrder(harness, product, '1', PICKER)
    expect(order.expiresAt, 'the default still applies').toBe('2026-11-17T14:00:00.000Z')
  })
})

describe('cancelling an order releases its stock', () => {
  it('releases on a picker cancel, and records the reason', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '10')
    const order = oneLineOrder(harness, product, '3', PICKER)

    const cancelled = harness.orders.cancelOrder(order.id, 'Customer left the queue', PICKER)
    expect(cancelled.status).toBe('CANCELLED')
    expect(stockOf(harness, product.id)).toMatchObject({ quantity: 10_000n, reserved: 0n })
    expect(cancelled.events.some((event) => event.detail === 'Customer left the queue')).toBe(true)
  })

  it('lets an Account cancel an order they did not create', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '10')
    const order = oneLineOrder(harness, product, '1', OTHER_PICKER)
    expect(harness.orders.cancelOrder(order.id, 'Could not be paid', ACCOUNT).status).toBe('CANCELLED')
  })

  it('refuses a picker cancelling somebody else\'s order', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '10')
    const order = oneLineOrder(harness, product, '1', OTHER_PICKER)
    expect(() => harness.orders.cancelOrder(order.id, 'Not mine to cancel', PICKER)).toThrow(/belongs to another picker/u)
    expect(stockOf(harness, product.id).reserved, 'still held').toBe(1_000n)
  })

  it('refuses to cancel without a reason', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '10')
    const order = oneLineOrder(harness, product, '1', PICKER)
    expect(() => harness.orders.cancelOrder(order.id, '   ', PICKER)).toThrow(/Give a reason/u)
    expect(harness.orders.getOrder(order.id, PICKER).status).toBe('PENDING')
  })

  it('refuses to cancel a paid order, which is a completed sale', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '10')
    const order = oneLineOrder(harness, product, '1', PICKER)
    harness.orders.finalizeOrder(order.id, {
      idempotencyKey: 'paid-key-1', payments: [{ method: 'CASH', amount: cashFor(order.totalMinor, 2) }],
    }, ACCOUNT, 'PHARMACY')
    expect(() => harness.orders.cancelOrder(order.id, 'Changed my mind', ACCOUNT))
      .toThrow(/completed sale cannot be cancelled/u)
    expect((harness.database.prepare('SELECT COUNT(*) AS n FROM sales').get() as { n: number }).n, 'the sale survives').toBe(1)
  })
})

describe('wholesale is refused to anybody without the permission', () => {
  it('refuses a wholesale order from a picker who was not given it', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '50')
    expect(() => harness.orders.createOrder({
      saleType: 'WHOLESALE', items: [{ productId: product.id, quantity: '10' }], idempotencyKey: 'ws-key-1',
    }, PICKER, 'PHARMACY')).toThrow(/wholesale/u)
    expect(stockOf(harness, product.id).reserved).toBe(0n)
  })

  it('allows it once the Admin gives the permission', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '50')
    harness.database.prepare('UPDATE user_permissions SET allow_wholesale = 1 WHERE user_id = ?').run(PICKER.id)
    const permitted = { ...PICKER, permissions: { ...PICKER.permissions, allowWholesale: true } }
    const order = harness.orders.createOrder({
      saleType: 'WHOLESALE', items: [{ productId: product.id, quantity: '10' }], idempotencyKey: 'ws-key-2',
    }, permitted, 'PHARMACY')
    expect(order.type).toBe('WHOLESALE')
    // The wholesale tier price, not the retail one: 18.00 rather than 20.00.
    expect(order.lines[0]!.unitPriceMinor).toBe(1_800n)
  })
})

describe('an Account may adjust quantities, and every adjustment is logged', () => {
  it('changes the line and the stock hold together', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '10')
    const order = oneLineOrder(harness, product, '2', PICKER)
    expect(stockOf(harness, product.id).reserved).toBe(2_000n)

    const adjusted = harness.orders.adjustLineQuantity(order.id, order.lines[0]!.id, '5', ACCOUNT)
    expect(adjusted.lines[0]!.quantityMilli).toBe(5_000n)
    expect(stockOf(harness, product.id).reserved, 'the hold follows the quantity').toBe(5_000n)
  })

  it('releases the difference when the quantity goes down', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '10')
    const order = oneLineOrder(harness, product, '6', PICKER)
    harness.orders.adjustLineQuantity(order.id, order.lines[0]!.id, '2', ACCOUNT)
    expect(stockOf(harness, product.id).reserved).toBe(2_000n)
  })

  it('refuses to raise a quantity beyond the available stock', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '4')
    const order = oneLineOrder(harness, product, '2', PICKER)
    expect(() => harness.orders.adjustLineQuantity(order.id, order.lines[0]!.id, '9', ACCOUNT))
      .toThrow(/not enough available stock/u)
    expect(stockOf(harness, product.id).reserved, 'the failed adjustment changed nothing').toBe(2_000n)
  })

  it('records who changed it, from what to what', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '10')
    const order = oneLineOrder(harness, product, '2', PICKER)
    harness.orders.adjustLineQuantity(order.id, order.lines[0]!.id, '4', ACCOUNT)

    const row = harness.database.prepare("SELECT actor, metadata_json FROM audit_log WHERE action = 'order.line_adjusted'")
      .get() as { actor: string; metadata_json: string }
    expect(row.actor).toBe('account1')
    const metadata = JSON.parse(row.metadata_json)
    expect(metadata.quantityWasMilli).toBe('2000')
    expect(metadata.quantityNowMilli).toBe('4000')
  })

  it('refuses the adjustment to a picker, who may not change an order at the till', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '10')
    const order = oneLineOrder(harness, product, '2', PICKER)
    expect(() => harness.orders.adjustLineQuantity(order.id, order.lines[0]!.id, '4', PICKER))
      .toThrow(/cannot adjust an order/u)
  })

  it('refuses to adjust an order that is no longer pending', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '10')
    const order = oneLineOrder(harness, product, '2', PICKER)
    harness.orders.cancelOrder(order.id, 'Not needed', PICKER)
    expect(() => harness.orders.adjustLineQuantity(order.id, order.lines[0]!.id, '4', ACCOUNT))
      .toThrow(/can no longer be changed/u)
  })
})

describe('the release and the deduction stand or fall together', () => {
  it('undoes the released reservation when the sale itself fails', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '10')
    const order = oneLineOrder(harness, product, '2', PICKER)

    // Underpaid: `completeSale` refuses the tender. The release ran before it, inside the same transaction, so it must
    // have been rolled back — otherwise the stock would be neither held nor sold and a second customer could take it.
    expect(() => harness.orders.finalizeOrder(order.id, {
      idempotencyKey: 'short-key-1', payments: [{ method: 'CASH', amount: '1.00' }],
    }, ACCOUNT, 'PHARMACY')).toThrow()

    expect(stockOf(harness, product.id), 'the hold survives the failed finalize').toMatchObject({ quantity: 10_000n, reserved: 2_000n })
    expect(harness.orders.getOrder(order.id, PICKER).status, 'and the order is still payable').toBe('PENDING')
    expect((harness.database.prepare('SELECT COUNT(*) AS n FROM sales').get() as { n: number }).n).toBe(0)
  })

  it('still finalizes cleanly afterwards, so the rollback left nothing broken', () => {
    const harness = createHarness()
    const product = receiveStock(harness, createProduct(harness, 'PHARMACY'), 'PHARMACY', '10')
    const order = oneLineOrder(harness, product, '2', PICKER)
    expect(() => harness.orders.finalizeOrder(order.id, {
      idempotencyKey: 'short-key-1', payments: [{ method: 'CASH', amount: '1.00' }],
    }, ACCOUNT, 'PHARMACY')).toThrow()

    const result = harness.orders.finalizeOrder(order.id, {
      idempotencyKey: 'proper-key-1', payments: [{ method: 'CASH', amount: cashFor(order.totalMinor, 2) }],
    }, ACCOUNT, 'PHARMACY')
    expect(result.order.status).toBe('PAID')
    expect(stockOf(harness, product.id)).toMatchObject({ quantity: 8_000n, reserved: 0n })
  })
})
