import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { getCurrency } from '../currency/catalog'
import { defaultDisplayOptions } from '../currency/money'
import { fromMinor } from '../currency/parse'
import { migrateDatabase } from '../db/migrate'
import { SQLiteShopRepository } from '../db/sqlite-shop-repository'
import { SQLiteUserRepository } from '../db/sqlite-user-repository'
import type { PublicUser } from '../shared/auth/types'
import type { ProductDraft } from '../shared/inventory/types'
import type { FirstRunInput } from '../shared/shop/types'
import { DesktopHostController } from '../main/desktop-host-controller'
import { ApprovalQueueService } from './approval-queue-service'
import { AuthService } from './auth-service'
import { ShopService } from './shop-service'
import { UserService } from './user-service'
import { SetupService } from './setup-service'
import { ProductInventoryService } from './product-inventory-service'
import { PointOfSaleService, SaleApprovalRequired } from './point-of-sale-service'
import { ReturnService } from './return-service'
import { OrderService } from './order-service'
import { PrintGateService } from './print-gate-service'
import { AccountingReportService } from './accounting-report-service'

/**
 * The two limits a cashier cannot cross alone, and what happens when they do.
 *
 * Before Phase 18 both were flat refusals: a discount above the cap and a credit sale above the customer's limit each
 * threw, and the cashier's only way forward was to take the discount off — overcharging the customer — or to abandon
 * the sale. The brief wants the Admin asked instead, so these tests hold the whole loop: the request is raised, nothing
 * is charged while it is pending, the Admin accepts it, and the same attempt then completes.
 *
 * The loop is driven through `DesktopHostController` because that is where the request is raised. The sale's own
 * transaction has to roll back first — raising a request inside a transaction that then throws would erase the request,
 * and the cashier would be told to wait for an approval nobody had ever been asked for.
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

let productSequence = 0

function productDraft(currencyCode: string): ProductDraft {
  const currency = getCurrency(currencyCode)!
  productSequence += 1
  // A distinct SKU and barcode per product: `products.sku` is UNIQUE, so two products sharing one literal fails at
  // creation with an error that has nothing to do with the limit under test.
  return {
    sku: `APR-${String(productSequence).padStart(4, '0')}`, name: `Test product ${productSequence}`, brand: 'Harbor',
    description: '', barcode: `22000000${String(productSequence).padStart(5, '0')}`,
    additionalBarcodes: [], category: 'Vitamins', subCategory: '', department: '', shelfLocation: '',
    unit: 'pack', packSizeUnits: 1,
    cost: fromMinor(100n, currency),
    retailPrice: fromMinor(10_000n, currency),
    wholesalePrice: fromMinor(8_000n, currency),
    wholesaleMinimumQuantity: '2', reorderLevel: '1', genericName: '', prescriptionRequired: false,
    weighedItem: false, pluCode: '', pricePerKg: '', expiryTracking: false, variants: [], isActive: true,
  }
}

function createHost(currencyCode = 'NGN') {
  const database = new Database(':memory:')
  migrateDatabase(database)
  const repository = new SQLiteShopRepository(database, false)
  const userRepository = new SQLiteUserRepository(database)
  const license = {
    getVerifiedPolicy: () => ({ licenseId: 'apr', edition: 'BOTH' as const, defaultCurrencyCode: null, lockCurrency: false }),
  }
  let ids = 0
  const setup = new SetupService(repository, userRepository, repository, license, () => new Date(NOW), () => `apr-user-${++ids}`)
  const auth = new AuthService(
    userRepository, repository, { deviceName: 'TILL-01', ipAddress: null }, () => new Date(NOW), () => NOW,
    { app: 'server', allowAdminOnClients: () => true },
  )
  const shopService = new ShopService(repository, { deviceName: 'TILL-01', ipAddress: null }, () => new Date(NOW), () => `apr-audit-${++ids}`)
  const userService = new UserService(userRepository, repository, () => new Date(NOW), () => `apr-managed-${++ids}`)
  const inventory = new ProductInventoryService(database, repository, { deviceName: 'TILL-01', now: () => NOW, newId: () => `apr-inv-${++ids}` })
  const pos = new PointOfSaleService(database, repository, { workstation: 'TILL-01', now: () => NOW, newId: () => `apr-pos-${++ids}` })
  const returns = new ReturnService(database, repository, { workstation: 'TILL-01', now: () => NOW, newId: () => `apr-ret-${++ids}` })
  const reports = new AccountingReportService(database, repository, { now: () => NOW })
  const approvals = new ApprovalQueueService(database, () => new Date(NOW), () => `apr-approval-${++ids}`)
  const orders = new OrderService(database, repository, pos, { workstation: 'TILL-01', now: () => NOW, newId: () => `apr-order-${++ids}` })
  const printGate = new PrintGateService(database, repository, pos, returns, { workstation: 'TILL-01', now: () => NOW })
  const host = new DesktopHostController(
    repository, userRepository, setup, auth, userService, shopService, () => NOW, '0.1.0',
    undefined, inventory, pos, returns, reports,
    // Positional gaps: mobileAccess, backup, then the approvals queue, then demoData and team, then the app role this
    // fixture models, then the order service and the print gate.
    undefined, undefined, approvals, undefined, undefined, 'server',
    orders, printGate,
  )
  return {
    database, repository, host, approvals, inventory, pos, orders, currencyCode,
    close: () => database.close(),
    /** How much unreserved stock is left, read the way the sale reads it. */
    stockOf(productId: string) {
      return database.prepare('SELECT quantity_milli, reserved_milli FROM stock WHERE product_id = ?')
        .get(productId) as { quantity_milli: number; reserved_milli: number } | undefined
    },
    saleCount() {
      return (database.prepare('SELECT COUNT(*) AS count FROM sales').get() as { count: number }).count
    },
    /** The Admin signs in at sender 1 and the till's own account at sender 2. */
    async signInAdmin() {
      await host.completeFirstRun(firstRun(currencyCode))
      return host.login(1, { username: 'shopadmin', password: PASSWORD })
    },
    makeProduct() {
      // The signed-in Admin's own row, read from the session. An invented id would fail the foreign key on the stock
      // receipt, and "who received this stock" has to be a real account for the audit trail to mean anything.
      const current = host.getCurrentUser(1)
      if (!current) throw new Error('The Admin must be signed in before the harness can create products.')
      const adminActor = { id: current.id, username: current.username, role: current.role }
      const product = inventory.createProduct(productDraft(currencyCode), adminActor, 'BOTH')
      return inventory.receiveStock({
        productId: product.id, expectedProductVersion: product.rowVersion, expectedStockVersion: product.stockVersion,
        quantity: '50', quantityUnit: 'unit', unitCost: fromMinor(100n, getCurrency(currencyCode)!),
        supplierName: 'Coastal Medical Supplies', supplierReference: `INV-${product.sku}`, note: 'approval test stock',
        batchNumber: '', expiryDate: '',
      }, adminActor, 'BOTH').product
    },
    /** Sets the shop-wide discount ceiling, which applies to everybody including the Admin. */
    setShopDiscountLimit(basisPoints: number) {
      const settings = repository.readSettings()
      return host.updateOperationalSettings(1, {
        ...settings.operational, discountLimitBasisPoints: basisPoints,
      })
    },
  }
}

type Harness = ReturnType<typeof createHost>

/** The Admin accepts whatever is waiting, the way the Approvals screen does. */
async function adminApprovesEverything(harness: Harness): Promise<void> {
  for (const request of harness.host.listPendingApprovals(1)) {
    harness.host.resolveApproval(1, request.id, 'APPROVE')
  }
}

describe('a sale that crosses a limit an Admin can lift', () => {
  it('raises an approval request instead of refusing, and completes the sale once the Admin accepts it', async () => {
    const harness = createHost()
    try {
      await harness.signInAdmin()
      harness.setShopDiscountLimit(500) // 5%
      const product = harness.makeProduct()

      // 1,000 minor units off a 10,000 basket is 10%, twice the 5% ceiling.
      const attempt = {
        idempotencyKey: 'apr-discount-loop-0001',
        saleType: 'RETAIL' as const,
        items: [{ productId: product.id, quantity: '1' }],
        payments: [{ method: 'CASH' as const, amount: '100.00' }],
      }
      const manualDiscount = () => harness.host.completePosSale(1, {
        ...attempt, items: [{ productId: product.id, quantity: '1', manualDiscount: '10.00' }],
      })

      // Nothing is sold and nothing is charged while the request waits.
      expect(() => manualDiscount()).toThrowError(/exceeds the 5% shop limit/u)
      expect(harness.saleCount()).toBe(0)
      expect(harness.stockOf(product.id)?.quantity_milli).toBe(50_000)

      const pending = harness.host.listPendingApprovals(1)
      expect(pending).toHaveLength(1)
      expect(pending[0]!.kind).toBe('DISCOUNT')
      // The Admin is shown how far over the line the cashier went, not just that they went over it.
      expect(pending[0]!.amountMinor).toBe('500')

      await adminApprovesEverything(harness)
      const completed = manualDiscount()
      expect(completed.receipt.receiptNumber).toMatch(/^R-/u)
      expect(harness.saleCount()).toBe(1)
      expect(harness.stockOf(product.id)?.quantity_milli).toBe(49_000)
      expect(harness.host.listPendingApprovals(1)).toHaveLength(0)
    } finally {
      harness.close()
    }
  })

  it('asks the Admin once, however many times the cashier presses Complete while it waits', async () => {
    const harness = createHost()
    try {
      await harness.signInAdmin()
      harness.setShopDiscountLimit(500) // 5%
      const product = harness.makeProduct()
      const attempt = {
        idempotencyKey: 'apr-discount-repeat-0001',
        saleType: 'RETAIL' as const,
        items: [{ productId: product.id, quantity: '1', manualDiscount: '10.00' }],
        payments: [{ method: 'CASH' as const, amount: '100.00' }],
      }
      // The message tells the cashier to press Complete again once the Admin accepts, so pressing it again is the
      // instructed thing to do — including before anybody has answered.
      const messages: string[] = []
      for (const _ of [1, 2, 3]) {
        try {
          harness.host.completePosSale(1, attempt)
          throw new Error('the sale should not have completed while the request waits')
        } catch (error) {
          messages.push((error as Error).message)
        }
      }

      const pending = harness.host.listPendingApprovals(1)
      expect(pending, 'one question, asked three times').toHaveLength(1)
      // Every attempt names the same request, so a cashier reading the screen aloud to the Admin over the phone is
      // reading the id of the row that is actually waiting.
      // Anything up to the closing bracket, not a hex class: the id is a uuid in the product and a fixture counter here.
      const ids = messages.map((message) => /to the Admin \(([^)]+)\)/u.exec(message)?.[1])
      expect(new Set(ids).size, 'the same id every time').toBe(1)
      expect(ids[0]).toBe(pending[0]!.id.slice(0, 8))
      // And one entry in the audit trail, not one per press.
      const asked = harness.database.prepare(`SELECT COUNT(*) AS count FROM audit_log WHERE action = 'approvals.requested'`)
        .get() as { count: number }
      expect(asked.count).toBe(1)

      // Nothing sold and nothing moved across all three attempts, and the single request still unlocks the sale.
      expect(harness.saleCount()).toBe(0)
      expect(harness.stockOf(product.id)?.quantity_milli).toBe(50_000)
      await adminApprovesEverything(harness)
      expect(harness.host.completePosSale(1, attempt).receipt.receiptNumber).toMatch(/^R-/u)
      expect(harness.saleCount()).toBe(1)
      expect(harness.host.listPendingApprovals(1), 'no phantom left behind for the Admin to reject').toHaveLength(0)
    } finally {
      harness.close()
    }
  })

  it('files a fresh request when the retry asks for more than the one already waiting', async () => {
    const harness = createHost()
    try {
      await harness.signInAdmin()
      harness.setShopDiscountLimit(500) // 5%
      const product = harness.makeProduct()
      const sale = (key: string, discount: string) => ({
        idempotencyKey: key,
        saleType: 'RETAIL' as const,
        items: [{ productId: product.id, quantity: '1', manualDiscount: discount }],
        payments: [{ method: 'CASH' as const, amount: '100.00' }],
      })

      expect(() => harness.host.completePosSale(1, sale('apr-discount-grew-0001', '10.00'))).toThrowError(/exceeds the 5% shop limit/u)
      expect(harness.host.listPendingApprovals(1)).toHaveLength(1)
      // A cashier who raises the discount and tries again is asking a different question, and an Admin who authorized
      // 500 must not find themselves recorded as authorizing 1,000.
      expect(() => harness.host.completePosSale(1, sale('apr-discount-grew-0001', '15.00'))).toThrowError(/exceeds the 5% shop limit/u)

      const pending = harness.host.listPendingApprovals(1)
      expect(pending).toHaveLength(2)
      expect(pending.map((request) => request.amountMinor)).toEqual(['500', '1000'])
    } finally {
      harness.close()
    }
  })

  it('refuses a retry that asks for more than the Admin approved', async () => {
    const harness = createHost()
    try {
      await harness.signInAdmin()
      harness.setShopDiscountLimit(500)
      const product = harness.makeProduct()
      const key = 'apr-discount-amount-0001'

      expect(() => harness.host.completePosSale(1, {
        idempotencyKey: key, saleType: 'RETAIL',
        items: [{ productId: product.id, quantity: '1', manualDiscount: '10.00' }],
        payments: [{ method: 'CASH', amount: '100.00' }],
      })).toThrowError(/exceeds the 5% shop limit/u)
      await adminApprovesEverything(harness)

      // Same key, but a bigger discount than the 500 the Admin accepted. An approval for one amount is not a pass for
      // every amount: without this, approving a small overage once would authorize anything the cashier tried next.
      expect(() => harness.host.completePosSale(1, {
        idempotencyKey: key, saleType: 'RETAIL',
        items: [{ productId: product.id, quantity: '1', manualDiscount: '20.00' }],
        payments: [{ method: 'CASH', amount: '100.00' }],
      })).toThrowError(/exceeds the 5% shop limit/u)
      expect(harness.saleCount()).toBe(0)
      // And the larger amount is itself a new request, so the Admin sees it rather than the sale being quietly dropped.
      expect(harness.host.listPendingApprovals(1)).toHaveLength(1)
    } finally {
      harness.close()
    }
  })

  it('files no request when the basket is only being quoted', async () => {
    const harness = createHost()
    try {
      await harness.signInAdmin()
      harness.setShopDiscountLimit(500)
      const product = harness.makeProduct()

      // Quoting is what the till does on every keystroke. Filing a request here would bury the Admin in paperwork for
      // baskets nobody ever sold, and the cashier would be unable to see the total they were typing towards.
      expect(() => harness.host.quotePosSale(1, {
        saleType: 'RETAIL',
        items: [{ productId: product.id, quantity: '1', manualDiscount: '10.00' }],
        customerId: null,
      })).toThrowError(/exceeds the 5% shop limit/u)
      expect(harness.host.listPendingApprovals(1)).toHaveLength(0)
      expect(harness.saleCount()).toBe(0)
    } finally {
      harness.close()
    }
  })

  it('holds an order’s reservation while its discount waits for the Admin, and finalizes once accepted', async () => {
    const harness = createHost()
    try {
      await harness.signInAdmin()
      harness.setShopDiscountLimit(500)
      const product = harness.makeProduct()
      const createKey = 'apr-order-create-0001'

      // Two units at 100.00 with 20.00 off is 10% against a 5% ceiling: over the line by 10.00.
      const generate = () => harness.host.createOrder(1, {
        saleType: 'RETAIL',
        items: [{ productId: product.id, quantity: '2', manualDiscount: '20.00' }],
        customerId: null,
        idempotencyKey: createKey,
      })

      expect(() => generate()).toThrowError(/exceeds the 5% shop limit/u)
      // No order was created and nothing was reserved: an order that cannot be paid must not hold stock hostage while
      // it waits for a decision.
      expect(harness.host.listOrderQueue(1)).toHaveLength(0)
      expect(harness.stockOf(product.id)).toMatchObject({ quantity_milli: 50_000, reserved_milli: 0 })
      expect(harness.host.listPendingApprovals(1)).toHaveLength(1)

      await adminApprovesEverything(harness)
      const order = generate()
      expect(order.status).toBe('PENDING')
      expect(order.discountMinor).toBe(2000n)
      expect(harness.stockOf(product.id)).toMatchObject({ quantity_milli: 50_000, reserved_milli: 2_000 })

      // The Account pays with a key of their own. The Admin's decision was about this basket, not about that key, so it
      // still applies — otherwise one discount would have to be approved twice.
      const result = harness.host.finalizeOrder(1, order.id, {
        idempotencyKey: 'apr-order-finalize-0001',
        payments: [{ method: 'CASH', amount: '180.00' }],
      })
      expect(result.order.status).toBe('PAID')
      expect(harness.stockOf(product.id)).toMatchObject({ quantity_milli: 48_000, reserved_milli: 0 })

      // And the discount actually reached the sale. The order's money columns and the receipt's have to agree, or the
      // customer is charged the undiscounted price for a discount printed on their own slip.
      const sale = harness.database.prepare(
        'SELECT subtotal, discount, total FROM sales WHERE order_id = ?',
      ).get(order.id) as { subtotal: number; discount: number; total: number }
      expect(sale).toEqual({ subtotal: 20_000, discount: 2_000, total: 18_000 })
    } finally {
      harness.close()
    }
  })

  it('carries an in-cap order discount into the sale without asking anybody', async () => {
    const harness = createHost()
    try {
      await harness.signInAdmin()
      harness.setShopDiscountLimit(500)
      const product = harness.makeProduct()

      // 10.00 off a 200.00 basket is exactly the 5% ceiling, so it needs no approval — and must still be honoured.
      const order = harness.host.createOrder(1, {
        saleType: 'RETAIL',
        items: [{ productId: product.id, quantity: '2', manualDiscount: '10.00' }],
        customerId: null,
        idempotencyKey: 'apr-order-incap-0001',
      })
      const result = harness.host.finalizeOrder(1, order.id, {
        idempotencyKey: 'apr-order-incap-pay-0001',
        payments: [{ method: 'CASH', amount: '190.00' }],
      })
      expect(result.order.status).toBe('PAID')
      expect(harness.host.listPendingApprovals(1)).toHaveLength(0)
      const sale = harness.database.prepare(
        'SELECT subtotal, discount, total FROM sales WHERE order_id = ?',
      ).get(order.id) as { subtotal: number; discount: number; total: number }
      expect(sale).toEqual({ subtotal: 20_000, discount: 1_000, total: 19_000 })
    } finally {
      harness.close()
    }
  })

  it('raises a request when a credit sale would exceed the customer’s limit, and completes it once accepted', async () => {
    const harness = createHost()
    try {
      await harness.signInAdmin()
      const product = harness.makeProduct()
      const customer = harness.host.createPosCustomer(1, {
        name: 'Ada Customer', phone: '', email: '', address: '', creditLimit: '50.00', enrolLoyalty: false,
      })

      // A 100.00 basket put entirely on account against a 50.00 limit.
      const key = 'apr-credit-loop-0001'
      const attempt = () => harness.host.completePosSale(1, {
        idempotencyKey: key, saleType: 'RETAIL',
        items: [{ productId: product.id, quantity: '1' }],
        payments: [{ method: 'CREDIT', amount: '' }],
        customerId: customer.id,
      })

      expect(() => attempt()).toThrowError(/credit limit/u)
      expect(harness.saleCount()).toBe(0)
      // A refused credit sale must not leave the customer owing money for goods they never got.
      expect(harness.database.prepare('SELECT balance FROM customers WHERE id = ?').get(customer.id))
        .toEqual({ balance: 0 })

      const pending = harness.host.listPendingApprovals(1)
      expect(pending).toHaveLength(1)
      expect(pending[0]!.kind).toBe('CREDIT')
      // The Admin is asked about the excess — 100.00 requested against a 50.00 limit — not about the whole sale.
      expect(pending[0]!.amountMinor).toBe('5000')

      await adminApprovesEverything(harness)
      const completed = attempt()
      expect(completed.receipt.receiptNumber).toMatch(/^R-/u)
      expect(harness.saleCount()).toBe(1)
      // The debt is recorded once. A retry that quietly sold twice would show 200.00 here.
      expect(harness.database.prepare('SELECT balance FROM customers WHERE id = ?').get(customer.id))
        .toEqual({ balance: 10_000 })
    } finally {
      harness.close()
    }
  })

  it('asks the Admin for the whole amount when a customer has no credit limit at all', async () => {
    const harness = createHost()
    try {
      await harness.signInAdmin()
      const product = harness.makeProduct()
      const customer = harness.host.createPosCustomer(1, {
        name: 'No Limit Customer', phone: '', email: '', address: '', creditLimit: '0', enrolLoyalty: false,
      })

      expect(() => harness.host.completePosSale(1, {
        idempotencyKey: 'apr-credit-nolimit-0001', saleType: 'RETAIL',
        items: [{ productId: product.id, quantity: '1' }],
        payments: [{ method: 'CREDIT', amount: '' }],
        customerId: customer.id,
      })).toThrowError(/credit limit/u)

      const pending = harness.host.listPendingApprovals(1)
      expect(pending).toHaveLength(1)
      // With no ceiling there is nothing to measure an excess against, so the whole 100.00 on account is what the
      // Admin is being asked to authorize. Reporting an excess of zero here would make the request look trivial.
      expect(pending[0]!.amountMinor).toBe('10000')
    } finally {
      harness.close()
    }
  })

  it('refuses a credit sale larger than the one the Admin approved', async () => {
    const harness = createHost()
    try {
      await harness.signInAdmin()
      const product = harness.makeProduct()
      const customer = harness.host.createPosCustomer(1, {
        name: 'Ada Customer', phone: '', email: '', address: '', creditLimit: '50.00', enrolLoyalty: false,
      })
      const key = 'apr-credit-amount-0001'
      const sell = (quantity: string) => harness.host.completePosSale(1, {
        idempotencyKey: key, saleType: 'RETAIL',
        items: [{ productId: product.id, quantity }],
        payments: [{ method: 'CREDIT', amount: '' }],
        customerId: customer.id,
      })

      expect(() => sell('1')).toThrowError(/credit limit/u)
      await adminApprovesEverything(harness)

      // The Admin authorized putting 100.00 on account against a 50.00 limit. Two units is 200.00, a different
      // question, and a yes to the first is not a yes to the second.
      expect(() => sell('2')).toThrowError(/credit limit/u)
      expect(harness.saleCount()).toBe(0)
      expect(harness.host.listPendingApprovals(1)).toHaveLength(1)
    } finally {
      harness.close()
    }
  })
})

describe('what counts as an approval for a given attempt', () => {
  // These exercise the matching rule directly, because the rule is the whole security property: an approval that is
  // loosely matched is an approval that authorizes sales nobody looked at.
  function serviceHarness() {
    const database = new Database(':memory:')
    migrateDatabase(database)
    const shop = new SQLiteShopRepository(database, false)
    const currency = getCurrency('NGN')!
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
      operational: { ...shop.readSettings().operational, discountLimitBasisPoints: 500 },
    })
    database.prepare('INSERT INTO users (id, username, password_hash, role, full_name) VALUES (?, ?, ?, ?, ?)')
      .run('apr-cashier', 'tillcashier', 'test-hash', 'USER', 'Till Cashier')
    database.prepare('INSERT INTO users (id, username, password_hash, role, full_name) VALUES (?, ?, ?, ?, ?)')
      .run('apr-other', 'othercashier', 'test-hash', 'USER', 'Other Cashier')
    // The Admin who decides the requests. `approval_requests.approved_by` is a foreign key, so a decision attributed
    // to an account that does not exist is refused by the database rather than recorded.
    database.prepare('INSERT INTO users (id, username, password_hash, role, full_name) VALUES (?, ?, ?, ?, ?)')
      .run('apr-admin', 'apradmin', 'test-hash', 'ADMIN', 'Apr Admin')
    database.prepare(`
      INSERT INTO user_permissions (user_id, allow_wholesale, max_discount_pct, allow_credit_sales, return_limit)
      VALUES ('apr-cashier', 0, 10000, 1, 0), ('apr-other', 0, 10000, 1, 0), ('apr-admin', 1, 10000, 1, 0)
    `).run()
    let ids = 0
    const inventory = new ProductInventoryService(database, shop, { deviceName: 'TILL-02', now: () => NOW, newId: () => `apr2-inv-${++ids}` })
    const pos = new PointOfSaleService(database, shop, { workstation: 'TILL-02', now: () => NOW, newId: () => `apr2-pos-${++ids}` })
    const approvals = new ApprovalQueueService(database, () => new Date(NOW), () => `apr2-approval-${++ids}`)
    const product = inventory.createProduct(productDraft('NGN'), { id: 'apr-cashier', username: 'tillcashier', role: 'ADMIN' }, 'BOTH')
    inventory.receiveStock({
      productId: product.id, expectedProductVersion: product.rowVersion, expectedStockVersion: product.stockVersion,
      quantity: '50', quantityUnit: 'unit', unitCost: '1.00', supplierName: 'Coastal Medical Supplies',
      supplierReference: `INV-${product.sku}`, note: 'approval test stock', batchNumber: '', expiryDate: '',
    }, { id: 'apr-cashier', username: 'tillcashier', role: 'ADMIN' }, 'BOTH')
    const cashier: PublicUser = {
      id: 'apr-cashier', fullName: 'Till Cashier', username: 'tillcashier', role: 'CASHIER', isActive: true, isLocked: false,
      permissions: { allowWholesale: false, maxDiscountBasisPoints: 10_000, allowCreditSales: true, returnLimitMinor: 0n },
    }
    return { database, pos, approvals, product, cashier, close: () => database.close() }
  }

  /** An Admin's decision, written the way the Approvals screen writes it. */
  function recordDecision(h: ReturnType<typeof serviceHarness>, status: 'APPROVED' | 'REJECTED' | 'PENDING', requestedBy: string, payload: Record<string, unknown>) {
    h.database.prepare(`
      INSERT INTO approval_requests (id, request_type, requested_by, status, payload_json, created_at, approved_by, resolved_at)
      VALUES (?, 'DISCOUNT', ?, ?, ?, ?, ?, ?)
    `).run(
      `apr2-row-${Math.random().toString(36).slice(2, 10)}`, requestedBy, status, JSON.stringify(payload),
      new Date(NOW).toISOString(), status === 'PENDING' ? null : 'apr-admin', status === 'PENDING' ? null : new Date(NOW).toISOString(),
    )
  }

  function discountedSale(h: ReturnType<typeof serviceHarness>, key: string, discount: string) {
    return h.pos.completeSale({
      idempotencyKey: key,
      saleType: 'RETAIL',
      items: [{ productId: h.product.id, quantity: '1', manualDiscount: discount }],
      payments: [{ method: 'CASH', amount: '100.00' }],
    }, h.cashier, 'BOTH')
  }

  const EXCESS = 500n // 10.00 asked for against a 5% ceiling on a 100.00 basket

  it('completes the sale once an approval exists for this key and this amount', () => {
    const h = serviceHarness()
    try {
      recordDecision(h, 'APPROVED', h.cashier.id, { idempotencyKey: 'apr2-match-0001', excessMinor: EXCESS.toString() })
      expect(discountedSale(h, 'apr2-match-0001', '10.00').receipt.receiptNumber).toMatch(/^R-/u)
    } finally {
      h.close()
    }
  })

  it('refuses when the approval was filed for a different idempotency key', () => {
    const h = serviceHarness()
    try {
      recordDecision(h, 'APPROVED', h.cashier.id, { idempotencyKey: 'apr2-other-key-0001', excessMinor: EXCESS.toString() })
      expect(() => discountedSale(h, 'apr2-match-0002', '10.00')).toThrowError(SaleApprovalRequired)
    } finally {
      h.close()
    }
  })

  it('refuses when the approval covered a smaller excess', () => {
    const h = serviceHarness()
    try {
      recordDecision(h, 'APPROVED', h.cashier.id, { idempotencyKey: 'apr2-match-0003', excessMinor: '100' })
      expect(() => discountedSale(h, 'apr2-match-0003', '10.00')).toThrowError(SaleApprovalRequired)
    } finally {
      h.close()
    }
  })

  it('refuses while the request is still pending', () => {
    const h = serviceHarness()
    try {
      recordDecision(h, 'PENDING', h.cashier.id, { idempotencyKey: 'apr2-match-0004', excessMinor: EXCESS.toString() })
      expect(() => discountedSale(h, 'apr2-match-0004', '10.00')).toThrowError(SaleApprovalRequired)
    } finally {
      h.close()
    }
  })

  it('refuses after the Admin rejected the request', () => {
    const h = serviceHarness()
    try {
      recordDecision(h, 'REJECTED', h.cashier.id, { idempotencyKey: 'apr2-match-0005', excessMinor: EXCESS.toString() })
      expect(() => discountedSale(h, 'apr2-match-0005', '10.00')).toThrowError(SaleApprovalRequired)
    } finally {
      h.close()
    }
  })

  it('refuses when a different cashier holds the approval', () => {
    const h = serviceHarness()
    try {
      // An approval is not transferable. Without this, one cashier could spend another's, and the audit trail would
      // show an Admin authorizing a sale they were never shown.
      recordDecision(h, 'APPROVED', 'apr-other', { idempotencyKey: 'apr2-match-0006', excessMinor: EXCESS.toString() })
      expect(() => discountedSale(h, 'apr2-match-0006', '10.00')).toThrowError(SaleApprovalRequired)
    } finally {
      h.close()
    }
  })

  it('refuses when the approval names a different kind of limit', () => {
    const h = serviceHarness()
    try {
      // A CREDIT approval must not unlock a DISCOUNT. Both are "an Admin said yes", but to different questions.
      h.database.prepare(`
        INSERT INTO approval_requests (id, request_type, requested_by, status, payload_json, created_at, approved_by, resolved_at)
        VALUES ('apr2-kind-row', 'CREDIT', ?, 'APPROVED', ?, ?, 'apr-admin', ?)
      `).run(
        h.cashier.id, JSON.stringify({ idempotencyKey: 'apr2-match-0007', excessMinor: EXCESS.toString() }),
        new Date(NOW).toISOString(), new Date(NOW).toISOString(),
      )
      expect(() => discountedSale(h, 'apr2-match-0007', '10.00')).toThrowError(SaleApprovalRequired)
    } finally {
      h.close()
    }
  })

  it('ignores an approval row whose payload cannot be read', () => {
    const h = serviceHarness()
    try {
      h.database.prepare(`
        INSERT INTO approval_requests (id, request_type, requested_by, status, payload_json, created_at, approved_by, resolved_at)
        VALUES ('apr2-bad-json', 'DISCOUNT', ?, 'APPROVED', '{not json', ?, 'apr-admin', ?)
      `).run(h.cashier.id, new Date(NOW).toISOString(), new Date(NOW).toISOString())
      // Unreadable means unproven, and unproven means refused. Treating a corrupt row as consent would turn a damaged
      // database into a way to sell without approval.
      expect(() => discountedSale(h, 'apr2-match-0008', '10.00')).toThrowError(SaleApprovalRequired)
    } finally {
      h.close()
    }
  })
})
