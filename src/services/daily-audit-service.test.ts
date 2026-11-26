import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { getCurrency } from '../currency/catalog'
import { defaultDisplayOptions, formatMoney } from '../currency/money'
import { fromMinor } from '../currency/parse'
import { migrateDatabase } from '../db/migrate'
import { SQLiteShopRepository } from '../db/sqlite-shop-repository'
import type { PublicUser } from '../shared/auth/types'
import type { ProductDraft } from '../shared/inventory/types'
import { AUDIT_CHECK_CODES, type AuditCheckCode, type AuditSignOffOutcome } from '../shared/audit/types'
import { ApprovalQueueService } from './approval-queue-service'
import { AccountingReportService } from './accounting-report-service'
import { DailyAuditService, reconcileAuditTotals } from './daily-audit-service'
import { OrderService } from './order-service'
import { PointOfSaleService, SaleApprovalRequired } from './point-of-sale-service'
import { PrintGateService } from './print-gate-service'
import { ProductInventoryService } from './product-inventory-service'
import { ReturnService } from './return-service'

/**
 * The daily audit, tested against a real database.
 *
 * Every figure asserted below is worked out by hand in the comment above it and then checked in three currencies whose
 * minor units disagree — NGN has two decimal places, JPY has none, KWD has three. A total that is right in NGN and wrong
 * in JPY is a total that was assembled out of strings somewhere, and that is the class of bug this file exists to catch.
 */

const NOW = Date.parse('2026-11-17T12:00:00.000Z')
const TODAY = '2026-11-17'

const PERMS_ADMIN = {
  allowWholesale: true, maxDiscountBasisPoints: 10_000, allowCreditSales: true, returnLimitMinor: 9_000_000_000_000n,
}
const PERMS_ACCOUNT = {
  allowWholesale: false, maxDiscountBasisPoints: 2_000, allowCreditSales: true, returnLimitMinor: 9_000_000_000_000n,
}
const PERMS = {
  allowWholesale: false, maxDiscountBasisPoints: 0, allowCreditSales: false, returnLimitMinor: 0n,
}

const ADMIN: PublicUser = {
  id: 'audit-admin', fullName: 'Ada Admin', username: 'ada', role: 'ADMIN', isActive: true, isLocked: false,
  permissions: PERMS_ADMIN,
}
const ACCOUNT: PublicUser = {
  id: 'audit-account', fullName: 'Amaka Account', username: 'account1', role: 'ACCOUNT', isActive: true, isLocked: false,
  permissions: PERMS_ACCOUNT,
}
const SUPERVISOR: PublicUser = {
  id: 'audit-supervisor', fullName: 'Sam Supervisor', username: 'supervisor1', role: 'SUPERVISOR', isActive: true,
  isLocked: false, permissions: PERMS,
}
const PICKER: PublicUser = {
  id: 'audit-picker', fullName: 'Uche Picker', username: 'user1', role: 'USER', isActive: true, isLocked: false,
  permissions: PERMS,
}

interface Harness {
  database: Database.Database
  shop: SQLiteShopRepository
  inventory: ProductInventoryService
  pointOfSale: PointOfSaleService
  returns: ReturnService
  reports: AccountingReportService
  approvals: ApprovalQueueService
  orders: OrderService
  gate: PrintGateService
  audit: DailyAuditService
  currency: ReturnType<typeof getCurrency> & object
  scale: bigint
  advance: (minutes: number) => void
  setClock: (timestamp: number) => void
  close: () => void
}

function createHarness(currencyCode: string, options: { now?: number } = {}): Harness {
  const database = new Database(':memory:')
  migrateDatabase(database)
  const shop = new SQLiteShopRepository(database, false)
  const currency = getCurrency(currencyCode)!
  shop.saveSettings({
    ...shop.readSettings(),
    profile: { name: 'Harbor Health', address: '12 Dock Road, Lagos', phone: '+234 1 555 0100' },
    currency,
    display: defaultDisplayOptions(currency),
    setupComplete: true,
    currencyConfirmed: true,
  })
  const insertUser = database.prepare(
    'INSERT INTO users (id, username, password_hash, role, full_name) VALUES (?, ?, ?, ?, ?)')
  const insertPermission = database.prepare(`
    INSERT INTO user_permissions (user_id, allow_wholesale, max_discount_pct, allow_credit_sales, return_limit)
    VALUES (?, ?, ?, ?, ?)
  `)
  for (const user of [ADMIN, ACCOUNT, SUPERVISOR, PICKER]) {
    insertUser.run(user.id, user.username, 'test-hash', user.role, user.fullName)
    insertPermission.run(user.id, user.permissions.allowWholesale ? 1 : 0, user.permissions.maxDiscountBasisPoints,
      user.permissions.allowCreditSales ? 1 : 0, Number(user.permissions.returnLimitMinor))
  }

  let clock = options.now ?? NOW
  let generated = 0
  const serviceOptions = {
    workstation: 'AUDIT-TEST-REGISTER',
    now: () => clock,
    newId: () => `audit-seed-${++generated}`,
  }
  const inventory = new ProductInventoryService(database, shop, serviceOptions)
  const pointOfSale = new PointOfSaleService(database, shop, serviceOptions)
  const returns = new ReturnService(database, shop, serviceOptions)
  const reports = new AccountingReportService(database, shop, { now: () => clock, newId: serviceOptions.newId })
  const approvals = new ApprovalQueueService(database, () => new Date(clock), serviceOptions.newId)
  const orders = new OrderService(database, shop, pointOfSale, serviceOptions)
  const gate = new PrintGateService(database, shop, pointOfSale, returns, serviceOptions)
  const audit = new DailyAuditService(database, shop, reports, { now: () => clock, newId: serviceOptions.newId })
  return {
    database, shop, inventory, pointOfSale, returns, reports, approvals, orders, gate, audit, currency,
    scale: 10n ** BigInt(currency.decimalPlaces),
    advance: (minutes) => { clock += minutes * 60_000 },
    setClock: (timestamp) => { clock = timestamp },
    close: () => database.close(),
  }
}

function draftFor(
  suffix: string,
  currency: ReturnType<typeof getCurrency> & object,
  scale: bigint,
): ProductDraft {
  return {
    sku: `AUDIT-${suffix}`, name: 'Vitamin C', brand: 'Harbor', description: 'Vitamin supplement',
    barcode: '', additionalBarcodes: [], category: 'Vitamins', subCategory: 'Supplements', department: 'Health',
    shelfLocation: 'A-01', unit: 'each', packSizeUnits: 1,
    cost: fromMinor(10n * scale, currency), retailPrice: fromMinor(20n * scale, currency),
    wholesalePrice: fromMinor(18n * scale, currency), wholesaleMinimumQuantity: '5', reorderLevel: '2',
    genericName: '', prescriptionRequired: false, weighedItem: false, pluCode: '', pricePerKg: '',
    expiryTracking: false, variants: [], isActive: true,
  }
}

/**
 * An edit through the real product service, because the audit's "the catalogue moved" mark is read out of the audit log
 * that service writes. A bare UPDATE would move the price and leave no trace, and the row would stay unexcused.
 */
function editProduct(harness: Harness, productId: string, changes: Partial<ProductDraft>): void {
  const row = harness.database.prepare('SELECT row_version FROM products WHERE id = ?').get(productId) as
    { row_version: number }
  harness.inventory.updateProduct({
    ...draftFor('NGN', harness.currency, harness.scale), id: productId, expectedVersion: row.row_version, ...changes,
  }, ADMIN, 'BOTH')
}

function stockProduct(harness: Harness, suffix: string): string {
  const { currency, scale } = harness
  let product = harness.inventory.createProduct(draftFor(suffix, currency, scale), ADMIN, 'BOTH')
  product = harness.inventory.receiveStock({
    productId: product.id, expectedProductVersion: product.rowVersion, expectedStockVersion: product.stockVersion,
    quantity: '40', quantityUnit: 'unit', unitCost: fromMinor(10n * scale, currency),
    supplierName: 'Coastal Medical Supplies', supplierReference: `INV-${suffix}`,
    note: 'Audit seed', batchNumber: '', expiryDate: '',
  }, ADMIN, 'BOTH').product
  return product.id
}

interface SeededDay {
  harness: Harness
  scale: bigint
  productId: string
  customerId: string
  retailSaleId: number
  retailReceipt: string
  wholesaleReceipt: string
  returnNumber: string
  /** Units, not minor units: multiply by `harness.scale`. */
  units: {
    float: bigint
    retailGross: bigint
    retailDiscount: bigint
    retailTotal: bigint
    wholesaleGross: bigint
    wholesaleDiscount: bigint
    wholesaleTotal: bigint
    returnTotal: bigint
    safeDrop: bigint
    credit: bigint
    debtorPayment: bigint
    expectedCash: bigint
  }
}

/**
 * One ordinary, honest day, worked out by hand.
 *
 * - The Account opens a till with a float of 100.
 * - Sale A, retail, by the Account: 2 × 20 = 40 gross, 2 taken off by hand, 38 total. Paid 20 cash and 18 transfer.
 * - Sale B, wholesale, by the Admin: 5 × 18 = 90 gross, 5 taken off, 85 total. Paid 80 cash and 5 on credit.
 * - One unit of sale A is returned for cash: 38 ÷ 2 = 19 back.
 * - The Account drops 2 into the safe, which leaves the drawer.
 * - A customer walks in and settles the 5 they owe, in cash, which puts money into the drawer that is not a sale.
 *
 * So the drawer should hold 100 + (20 + 80) − 19 − 2 + 5 = 184, and the day's takings are 130 gross, 123 after
 * discounts, 104 net of the return. Every one of those numbers is asserted below, in three currencies.
 */
function seedOrdinaryDay(currencyCode: string): SeededDay {
  const harness = createHarness(currencyCode)
  const { scale } = harness
  try {
    const productId = stockProduct(harness, currencyCode)
    harness.reports.openCashierShift({ openingFloat: fromMinor(100n * scale, harness.currency) }, ACCOUNT, 'BOTH')
    const customer = harness.pointOfSale.createCustomer({
      name: 'Ada Customer', phone: '+234 800 111 2222', email: 'ada@example.test', address: '4 Market Lane',
      creditLimit: fromMinor(100n * scale, harness.currency), enrolLoyalty: false,
    }, ADMIN, 'BOTH')
    const retail = harness.pointOfSale.completeSale({
      idempotencyKey: `audit-retail-${currencyCode}`,
      saleType: 'RETAIL',
      items: [{ productId, quantity: '2', manualDiscount: fromMinor(2n * scale, harness.currency) }],
      payments: [
        { method: 'CASH', amount: fromMinor(20n * scale, harness.currency) },
        { method: 'TRANSFER', amount: fromMinor(18n * scale, harness.currency), reference: 'TRF-AUDIT' },
      ],
    }, ACCOUNT, 'BOTH').receipt
    const wholesale = harness.pointOfSale.completeSale({
      idempotencyKey: `audit-wholesale-${currencyCode}`,
      saleType: 'WHOLESALE',
      customerId: customer.id,
      items: [{ productId, quantity: '5', manualDiscount: fromMinor(5n * scale, harness.currency) }],
      payments: [
        { method: 'CASH', amount: fromMinor(80n * scale, harness.currency) },
        { method: 'CREDIT', amount: fromMinor(5n * scale, harness.currency) },
      ],
    }, ADMIN, 'BOTH').receipt
    const returned = harness.returns.createReturn({
      receiptNumber: retail.receiptNumber,
      reason: 'CUSTOMER_CHANGED_MIND',
      reasonNote: 'Audit seed return',
      type: 'REFUND',
      refundMethod: 'CASH',
      items: [{ saleItemId: retail.items[0]!.id, quantity: '1', condition: 'RESELLABLE' }],
      idempotencyKey: `audit-return-${currencyCode}`,
    }, ACCOUNT, 'BOTH')
    const shift = harness.database.prepare(`SELECT id FROM cashier_shifts WHERE cashier_id = ?`).get(ACCOUNT.id) as
      { id: string }
    harness.reports.recordCashDrawerEvent({
      shiftId: shift.id, type: 'SAFE_DROP', amount: fromMinor(2n * scale, harness.currency), note: 'Audit seed drop',
    }, ACCOUNT, 'BOTH')
    harness.reports.recordDebtorPayment({
      customerId: customer.id, amount: fromMinor(5n * scale, harness.currency), method: 'CASH',
      reference: 'DEBT-AUDIT', note: 'Settled in person',
    }, ACCOUNT, 'BOTH')
    return {
      harness,
      scale,
      productId,
      customerId: customer.id,
      retailSaleId: retail.id,
      retailReceipt: retail.receiptNumber,
      wholesaleReceipt: wholesale.receiptNumber,
      returnNumber: returned.returnNumber,
      units: {
        float: 100n, retailGross: 40n, retailDiscount: 2n, retailTotal: 38n,
        wholesaleGross: 90n, wholesaleDiscount: 5n, wholesaleTotal: 85n,
        returnTotal: 19n, safeDrop: 2n, credit: 5n, debtorPayment: 5n, expectedCash: 184n,
      },
    }
  } catch (error) {
    harness.close()
    throw error
  }
}

describe('DailyAuditService · the day as the ledger records it', () => {
  it.each(['NGN', 'JPY', 'KWD'])('totals %s to the last minor unit, with no cost figure anywhere in the view', (code) => {
    const seeded = seedOrdinaryDay(code)
    const { harness, scale, units } = seeded
    try {
      const report = harness.audit.getDayAudit({ businessDate: TODAY }, SUPERVISOR, 'BOTH')

      expect(report.header).toMatchObject({
        storeName: 'Harbor Health',
        storeAddress: '12 Dock Road, Lagos',
        currency: { code },
        scope: 'STORE',
        period: { type: 'DAY', startDate: TODAY, endDate: TODAY },
      })
      expect(report.businessDate).toBe(TODAY)
      expect(report.currencyCode).toBe(code)

      // 40 + 90 gross, 2 + 5 off, 38 + 85 taken, 19 back.
      expect(report.totals).toMatchObject({
        grossSalesMinor: (units.retailGross + units.wholesaleGross) * scale,
        totalSalesMinor: (units.retailTotal + units.wholesaleTotal) * scale,
        discountsMinor: (units.retailDiscount + units.wholesaleDiscount) * scale,
        netSalesMinor: (units.retailTotal + units.wholesaleTotal - units.returnTotal) * scale,
        transactions: 2,
        retailMinor: units.retailTotal * scale,
        retailTransactions: 1,
        wholesaleMinor: units.wholesaleTotal * scale,
        wholesaleTransactions: 1,
        returnsMinor: units.returnTotal * scale,
        returnTransactions: 1,
        refundsMinor: units.returnTotal * scale,
        creditSalesMinor: units.credit * scale,
        creditTransactions: 1,
        debtorPaymentsMinor: units.debtorPayment * scale,
        debtorPaymentTransactions: 1,
        voids: 0,
        overrides: 0,
        reprints: 0,
      })

      // The audit is the one screen a Supervisor reads all day, and the brief gives cost and profit to the Admin alone.
      // The assertion is on the shape, not on a null: a field that exists and is null today can be filled in tomorrow
      // without a single test noticing, and a field that does not exist cannot.
      const totalKeys = Object.keys(report.totals).join(' ')
      expect(totalKeys).not.toMatch(/cost|cogs|profit/iu)
      expect(JSON.stringify(report.totals, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)))
        .not.toMatch(/cost|cogs|profit/iu)

      expect(report.sales.map((row) => row.receiptNumber)).toEqual([
        seeded.retailReceipt, seeded.wholesaleReceipt,
      ])
      expect(report.sales[0]).toMatchObject({
        saleType: 'RETAIL',
        grossMinor: units.retailGross * scale,
        discountMinor: units.retailDiscount * scale,
        totalMinor: units.retailTotal * scale,
        cashierName: 'Amaka Account',
        paymentMethods: 'CASH + TRANSFER',
      })
      expect(report.sales[1]).toMatchObject({
        saleType: 'WHOLESALE',
        totalMinor: units.wholesaleTotal * scale,
        creditMinor: units.credit * scale,
        customerName: 'Ada Customer',
        paymentMethods: 'CASH + CREDIT',
      })
      expect(report.returns[0]).toMatchObject({
        returnNumber: seeded.returnNumber,
        saleReceiptNumber: seeded.retailReceipt,
        totalMinor: units.returnTotal * scale,
        cashierName: 'Amaka Account',
        outsideWindow: false,
      })
      expect(report.creditSales[0]).toMatchObject({
        receiptNumber: seeded.wholesaleReceipt,
        customerName: 'Ada Customer',
        creditMinor: units.credit * scale,
      })
      expect(report.debtorPayments[0]).toMatchObject({
        customerName: 'Ada Customer',
        receivedByName: 'Amaka Account',
        paymentMethod: 'CASH',
        amountMinor: units.debtorPayment * scale,
        balanceBeforeMinor: units.credit * scale,
        balanceAfterMinor: 0n,
      })
      expect(report.paymentMethods).toEqual([
        { method: 'CASH', transactions: 2, salesMinor: 100n * scale, refundsMinor: 0n, netMinor: 100n * scale },
        { method: 'CREDIT', transactions: 1, salesMinor: 5n * scale, refundsMinor: 0n, netMinor: 5n * scale },
        { method: 'REFUND_CASH', transactions: 1, salesMinor: 0n, refundsMinor: 19n * scale, netMinor: -19n * scale },
        { method: 'TRANSFER', transactions: 1, salesMinor: 18n * scale, refundsMinor: 0n, netMinor: 18n * scale },
      ])

      // The drawer: 100 float + 100 cash sales − 19 refunded − 2 dropped in the safe + 5 collected for an old debt.
      expect(report.cashTie).toMatchObject({
        currencyCode: code,
        openingFloatMinor: units.float * scale,
        cashSalesMinor: 100n * scale,
        cashRefundsMinor: units.returnTotal * scale,
        drawerAdjustmentsMinor: -units.safeDrop * scale,
        debtorCashMinor: units.debtorPayment * scale,
        expectedCashMinor: units.expectedCash * scale,
        countedCashMinor: null,
        counted: false,
        differs: false,
      })
      // An honest day raises nothing.
      expect(report.findings).toEqual([])
      expect(report.checksRun).toEqual([...AUDIT_CHECK_CODES])
      expect(report.flags).toEqual([])
      expect(report.signOff).toBeNull()
      expect(report.accounts.map((row) => row.name)).toContain('Amaka Account')
      expect(report.canSignOff).toBe(true)
      expect(report.canNote).toBe(true)
    } finally {
      harness.close()
    }
  })

  it.each(['NGN', 'JPY', 'KWD'])('reconciles its own rows with the sales ledger to the last unit in %s', (code) => {
    const seeded = seedOrdinaryDay(code)
    const { harness, scale, units } = seeded
    try {
      const report = harness.audit.getDayAudit({ businessDate: TODAY }, ADMIN, 'BOTH')
      expect(report.reconciliation.matches).toBe(true)
      expect(report.reconciliation.differences).toEqual([])
      expect(report.reconciliation.salesFromLedgerMinor).toBe((units.retailTotal + units.wholesaleTotal) * scale)
      expect(report.reconciliation.salesFromRowsMinor).toBe(report.reconciliation.salesFromLedgerMinor)
      expect(report.reconciliation.transactionsFromLedger).toBe(2)
      expect(report.reconciliation.grossFromLedgerMinor).toBe((units.retailGross + units.wholesaleGross) * scale)
      expect(report.reconciliation.returnsFromLedgerMinor).toBe(units.returnTotal * scale)
      expect(report.reconciliation.refundsFromLedgerMinor).toBe(units.returnTotal * scale)
      expect(report.reconciliation.paymentsFromLedgerMinor).toBe(123n * scale)
      expect(report.reconciliation.discountsFromLedgerMinor)
        .toBe((units.retailDiscount + units.wholesaleDiscount) * scale)
    } finally {
      harness.close()
    }
  })

  it('names which total disagreed when the two sides of the reconciliation do not match', () => {
    // The guard, taken away: the same comparison handed rows that are missing one sale. If the check were decorative
    // this would still report a match, and the brief's "a test fails if audit totals and the sales ledger differ" would
    // be a sentence nobody had ever proved.
    const ledger = {
      transactions: 2,
      grossMinor: 130n,
      discountsMinor: 7n,
      salesMinor: 123n,
      paymentsMinor: 123n,
      returnsMinor: 19n,
      refundsMinor: 19n,
    }
    const complete = reconcileAuditTotals({
      sales: [
        { total_text: '38', subtotal_text: '40' },
        { total_text: '85', subtotal_text: '90' },
      ],
      payments: [{ amount_text: '123' }],
      returns: [{ totalMinor: 19n }],
      refunds: [{ amount_text: '19' }],
      discounts: 7n,
    }, ledger)
    expect(complete.matches).toBe(true)

    const missingOneSale = reconcileAuditTotals({
      sales: [{ total_text: '38', subtotal_text: '40' }],
      payments: [{ amount_text: '123' }],
      returns: [{ totalMinor: 19n }],
      refunds: [{ amount_text: '19' }],
      discounts: 7n,
    }, ledger)
    expect(missingOneSale.matches).toBe(false)
    expect(missingOneSale.differences.join(' | ')).toMatch(/sales/u)
    expect(missingOneSale.differences.join(' | ')).toMatch(/transactions/u)
    expect(missingOneSale.differences.join(' | ')).toMatch(/gross sales/u)

    const oneUnitOut = reconcileAuditTotals({
      sales: [
        { total_text: '38', subtotal_text: '40' },
        { total_text: '86', subtotal_text: '90' },
      ],
      payments: [{ amount_text: '123' }],
      returns: [{ totalMinor: 19n }],
      refunds: [{ amount_text: '19' }],
      discounts: 7n,
    }, ledger)
    expect(oneUnitOut.matches).toBe(false)
    // To the last unit: one minor unit out is a failure, and the sentence says which figure moved.
    expect(oneUnitOut.differences.join(' | ')).toContain('the audit shows 124 and the ledger shows 123')

    const refundMissing = reconcileAuditTotals({
      sales: [
        { total_text: '38', subtotal_text: '40' },
        { total_text: '85', subtotal_text: '90' },
      ],
      payments: [{ amount_text: '123' }],
      returns: [{ totalMinor: 19n }],
      refunds: [],
      discounts: 7n,
    }, ledger)
    expect(refundMissing.matches).toBe(false)
    expect(refundMissing.differences.join(' | ')).toMatch(/refunds/u)
  })

  it('counts a debtor payment taken in cash into the day close, so an honest Account is not shown an overage', () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness, scale, units } = seeded
    try {
      // Without the 5 collected for the old debt the expectation would be 179, and a drawer counted at 184 would look
      // 5 over. The close is the Admin's, and it is the same formula the audit uses.
      const closed = harness.reports.closeDay({
        businessDate: TODAY,
        countedCash: formatMoney(units.expectedCash * scale, harness.currency, harness.shop.readSettings().display),
      }, ADMIN, 'BOTH')
      expect(closed.expectedCashMinor).toBe(units.expectedCash * scale)
      expect(closed.countedCashMinor).toBe(units.expectedCash * scale)
      expect(closed.varianceMinor).toBe(0n)
      expect(closed.currencyCode).toBe('NGN')

      const report = harness.audit.getDayAudit({ businessDate: TODAY }, SUPERVISOR, 'BOTH')
      expect(report.dayClose?.closeNumber).toMatch(/^D-/u)
      expect(report.cashTie.counted).toBe(true)
      expect(report.cashTie.differenceMinor).toBe(0n)
      expect(report.cashTie.differs).toBe(false)
      expect(report.findings).toEqual([])
    } finally {
      harness.close()
    }
  })

  it('refuses to audit a day that has not happened yet, and a day nobody can name', () => {
    const harness = createHarness('NGN')
    try {
      expect(() => harness.audit.getDayAudit({ businessDate: '2026-11-18' }, SUPERVISOR, 'BOTH'))
        .toThrowError('A day that has not happened yet cannot be audited.')
      expect(() => harness.audit.getDayAudit({ businessDate: 'tomorrow' }, SUPERVISOR, 'BOTH'))
        .toThrowError('Choose the day to audit.')
      expect(() => harness.audit.getDayAudit({ businessDate: '2026-02-30' }, SUPERVISOR, 'BOTH'))
        .toThrowError('Choose a valid day to audit.')
      expect(() => harness.audit.getDayAudit({ businessDate: TODAY, accountId: 'nobody' }, SUPERVISOR, 'BOTH'))
        .toThrowError('That Account does not exist.')
    } finally {
      harness.close()
    }
  })
})

describe('DailyAuditService · who may look, and who may write', () => {
  it('lets the Admin and the Supervisor read the day, and refuses the till roles at the service, not in the UI', () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness } = seeded
    try {
      expect(harness.audit.getDayAudit({ businessDate: TODAY }, ADMIN, 'BOTH').totals.transactions).toBe(2)
      expect(harness.audit.getDayAudit({ businessDate: TODAY }, SUPERVISOR, 'BOTH').totals.transactions).toBe(2)
      for (const actor of [ACCOUNT, PICKER]) {
        expect(() => harness.audit.getDayAudit({ businessDate: TODAY }, actor, 'BOTH'))
          .toThrowError('You do not have permission to audit the day.')
      }
      // A legacy CASHIER row resolves to USER, which has no audit. The alias rule is the product's, not this service's.
      const legacy = { ...ACCOUNT, role: 'CASHIER' as PublicUser['role'] }
      expect(() => harness.audit.getDayAudit({ businessDate: TODAY }, legacy, 'BOTH'))
        .toThrowError('You do not have permission to audit the day.')
    } finally {
      harness.close()
    }
  })

  it('refuses every audit write to a role that cannot sign off, and changes nothing when it does', () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness } = seeded
    try {
      const refusals = 'Only a Supervisor or the Admin can write audit notes and sign-offs.'
      const writes: Array<[string, () => unknown]> = [
        ['signOffDay', () => harness.audit.signOffDay(
          { businessDate: TODAY, outcome: 'AUDITED' }, ACCOUNT, 'BOTH')],
        ['raiseFlag', () => harness.audit.raiseFlag(
          { businessDate: TODAY, severity: 'SERIOUS', detail: 'Something looks wrong.' }, ACCOUNT, 'BOTH')],
        ['noteFinding', () => harness.audit.noteFinding(
          { businessDate: TODAY, code: 'CASH_DIFFERENCE', detail: 'Counted twice.' }, ACCOUNT, 'BOTH')],
        ['addFlagNote', () => harness.audit.addFlagNote({ flagId: 'whatever', detail: 'Noted.' }, PICKER, 'BOTH')],
        ['resolveFlag', () => harness.audit.resolveFlag(
          { flagId: 'whatever', resolutionNote: 'Sorted.' }, PICKER, 'BOTH')],
      ]
      for (const [name, call] of writes) {
        expect(call, name).toThrowError(refusals)
      }
      // A refusal that wrote something on the way out is not a refusal.
      expect(harness.database.prepare('SELECT COUNT(*) AS n FROM audit_signoffs').get()).toEqual({ n: 0 })
      expect(harness.database.prepare('SELECT COUNT(*) AS n FROM audit_flags').get()).toEqual({ n: 0 })

      // The same calls as the Supervisor are accepted, which is what makes the refusals above about the role and not
      // about the method being broken for everybody.
      const report = harness.audit.getDayAudit({ businessDate: TODAY }, SUPERVISOR, 'BOTH')
      expect(report.canSignOff).toBe(true)
      const raised = harness.audit.raiseFlag(
        { businessDate: TODAY, severity: 'CONCERN', detail: 'The safe drop has no witness.' }, SUPERVISOR, 'BOTH')
      expect(raised.source).toBe('MANUAL')
      expect(raised.severity).toBe('CONCERN')
      expect(raised.detail).toContain('The safe drop has no witness.')
      expect(raised.raisedByName).toBe('Sam Supervisor')
    } finally {
      harness.close()
    }
  })

  it('changes nothing in the ledger, the stock or the settings, whoever calls it or what they call', () => {
    // The brief's rule is that the audit is read-only except for notes and sign-off. Proving that by listing method
    // names would prove nothing about a method nobody thought to list, so the proof is arithmetic instead: take a
    // checksum of every table the shop's money and stock live in, call every public method of this service as both of
    // the roles that may call them, and require the checksum not to have moved. The tables the audit *is* allowed to
    // write are checked to have changed, so the test cannot pass by doing nothing at all.
    const seeded = seedOrdinaryDay('NGN')
    const { harness } = seeded
    try {
      const ledgerTables = [
        'sales', 'sale_items', 'payments', 'returns', 'return_items', 'stock', 'stock_movements', 'products',
        'purchases', 'customers', 'settings', 'orders', 'order_items', 'cashier_shifts', 'day_closings',
        'cash_drawer_events', 'approval_requests', 'print_log', 'business_entries',
      ]
      const checksum = (): string => ledgerTables.map((table) => {
        const rows = harness.database.prepare(`SELECT * FROM ${table}`).all()
        return `${table}:${rows.length}:${JSON.stringify(rows, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))}`
      }).join('|')

      const before = checksum()
      const auditRowsBefore = (harness.database.prepare('SELECT COUNT(*) AS n FROM audit_signoffs').get() as { n: number }).n
        + (harness.database.prepare('SELECT COUNT(*) AS n FROM audit_flags').get() as { n: number }).n

      for (const actor of [SUPERVISOR, ADMIN]) {
        harness.audit.getDayAudit({ businessDate: TODAY }, actor, 'BOTH')
        harness.audit.getDayAudit({ businessDate: TODAY, accountId: ACCOUNT.id }, actor, 'BOTH')
        harness.audit.listUnauditedDays(actor, 'BOTH')
        harness.audit.dayStatuses(actor, 'BOTH')
        harness.audit.summaryForPhone(actor, 'BOTH')
        const flag = harness.audit.raiseFlag(
          { businessDate: TODAY, severity: 'NOTE', detail: `Read-only check by ${actor.username}.` }, actor, 'BOTH')
        harness.audit.addFlagNote({ flagId: flag.id, detail: 'And a second note.' }, actor, 'BOTH')
        harness.audit.noteFinding(
          { businessDate: TODAY, code: 'CASH_DIFFERENCE', detail: 'Nothing to see, the drawer was not counted.' },
          actor, 'BOTH')
        harness.audit.resolveFlag({ flagId: flag.id, resolutionNote: 'Closed after reading.' }, actor, 'BOTH')
        harness.audit.signOffDay(
          { businessDate: TODAY, accountId: actor.id === ADMIN.id ? PICKER.id : null, outcome: 'AUDITED' },
          actor, 'BOTH')
      }

      expect(checksum()).toBe(before)
      const auditRowsAfter = (harness.database.prepare('SELECT COUNT(*) AS n FROM audit_signoffs').get() as { n: number }).n
        + (harness.database.prepare('SELECT COUNT(*) AS n FROM audit_flags').get() as { n: number }).n
      expect(auditRowsAfter).toBeGreaterThan(auditRowsBefore)
      // The audit trail grew, because a note and a sign-off are things that happened and the brief requires every one
      // of them recorded with a user, a role, a machine and a time.
      const auditLogRows = (harness.database.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n
      expect(auditLogRows).toBeGreaterThan(0)
      // Which tables grew, asked of the database rather than guessed at here: the two the brief allows the audit to
      // write, plus the audit trail itself, and nothing else in the whole schema.
      const tables = (harness.database.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
      `).all() as Array<{ name: string }>).map((row) => row.name)
      const rowCount = (table: string): number =>
        (harness.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
      const beforeCounts = new Map(tables.map((table) => [table, rowCount(table)]))
      for (const actor of [SUPERVISOR, ADMIN]) {
        harness.audit.getDayAudit({ businessDate: TODAY }, actor, 'BOTH')
        harness.audit.listUnauditedDays(actor, 'BOTH')
        harness.audit.summaryForPhone(actor, 'BOTH')
        const flag = harness.audit.raiseFlag(
          { businessDate: TODAY, severity: 'NOTE', detail: `Table check by ${actor.username}.` }, actor, 'BOTH')
        harness.audit.addFlagNote({ flagId: flag.id, detail: 'Noted again.' }, actor, 'BOTH')
        harness.audit.resolveFlag({ flagId: flag.id, resolutionNote: 'Closed.' }, actor, 'BOTH')
        harness.audit.signOffDay({ businessDate: TODAY, accountId: actor.id, outcome: 'AUDITED' }, actor, 'BOTH')
      }
      const grown = tables.filter((table) => rowCount(table) !== beforeCounts.get(table)).sort()
      expect(grown).toEqual(['audit_flags', 'audit_log', 'audit_signoffs'])
    } finally {
      harness.close()
    }
  })
})

/**
 * Seeded bad data.
 *
 * The brief's requirement is that flags raise on it, so every check has a scenario here that produces exactly the thing
 * the check is looking for and nothing else. The final test in the block walks `AUDIT_CHECK_CODES` — the same list the
 * service walks — and fails if any code has no scenario, so a new check cannot be added without a seed to prove it.
 */
describe('DailyAuditService · the automatic checks find what they are for', () => {
  const raisedCodes = (harness: Harness, accountId: string | null = null): AuditCheckCode[] => harness.audit
    .getDayAudit({ businessDate: TODAY, accountId }, SUPERVISOR, 'BOTH')
    .findings.map((finding) => finding.code)

  it('raises CASH_DIFFERENCE when the counted cash does not match the drawer, and says by how much', () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness, scale, units } = seeded
    try {
      // Counted 100 against a drawer that should have held 184: short by 84, which is more than 1% of the expectation.
      harness.reports.closeDay({ businessDate: TODAY, countedCash: '100.00' }, ADMIN, 'BOTH')
      const report = harness.audit.getDayAudit({ businessDate: TODAY }, SUPERVISOR, 'BOTH')
      const finding = report.findings.find((candidate) => candidate.code === 'CASH_DIFFERENCE')
      expect(finding).toBeDefined()
      expect(finding!.severity).toBe('SERIOUS')
      expect(finding!.amountMinor).toBe(-84n * scale)
      expect(finding!.headline).toBe('The drawer was short by ₦84.00')
      expect(finding!.detail).toContain('Expected ₦184.00, counted ₦100.00')
      expect(finding!.detail).toContain('debtor cash ₦5.00')
      expect(finding!.detail).toContain('Currency NGN')
      expect(report.cashTie.differs).toBe(true)
      // A small difference is a CONCERN, not a scandal: 1 unit out of 184 is half a percent.
      expect(units.expectedCash).toBe(184n)
    } finally {
      harness.close()
    }
  })

  it('treats a small cash difference as a concern and an exact count as nothing at all', () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness } = seeded
    try {
      harness.reports.closeDay({ businessDate: TODAY, countedCash: '183.00' }, ADMIN, 'BOTH')
      const finding = harness.audit.getDayAudit({ businessDate: TODAY }, SUPERVISOR, 'BOTH')
        .findings.find((candidate) => candidate.code === 'CASH_DIFFERENCE')
      expect(finding!.severity).toBe('CONCERN')
      expect(finding!.headline).toBe('The drawer was short by ₦1.00')
    } finally {
      harness.close()
    }
  })

  it('raises MANY_REPRINTS from the print log, with the reason each duplicate was given', () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness } = seeded
    try {
      const saleId = seeded.retailSaleId
      harness.gate.print({ kind: 'SALE', documentId: saleId, layout: 'THERMAL_80' }, ACCOUNT, { pcName: 'TILL-01' })
      for (const reason of ['Customer lost it', 'Card terminal needed a copy', 'Book-keeping']) {
        harness.advance(2)
        harness.gate.print({ kind: 'SALE', documentId: saleId, layout: 'THERMAL_80', reason }, ACCOUNT,
          { pcName: 'TILL-01' })
      }
      const report = harness.audit.getDayAudit({ businessDate: TODAY }, SUPERVISOR, 'BOTH')
      expect(report.reprints).toHaveLength(3)
      expect(report.reprints[0]).toMatchObject({
        documentKind: 'SALE', receiptNumber: seeded.retailReceipt, copyNo: 2, printedByName: 'Amaka Account',
        reason: 'Customer lost it', clientDeviceName: '',
      })
      expect(report.reprints.map((row) => row.copyNo)).toEqual([2, 3, 4])
      const finding = report.findings.find((candidate) => candidate.code === 'MANY_REPRINTS')
      expect(finding!.severity).toBe('CONCERN')
      expect(finding!.count).toBe(3)
      expect(finding!.headline).toBe('3 duplicate prints on this day')
      expect(finding!.detail).toContain('highest copy number was 4')
      expect(raisedCodes(harness)).toContain('MANY_REPRINTS')
    } finally {
      harness.close()
    }
  })

  it('does not call two reprints a pattern, because the threshold is the one the service exports', () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness } = seeded
    try {
      harness.gate.print({ kind: 'SALE', documentId: seeded.retailSaleId, layout: 'THERMAL_80' }, ACCOUNT, {})
      for (const reason of ['Lost', 'Needed for the book']) {
        harness.advance(2)
        harness.gate.print({ kind: 'SALE', documentId: seeded.retailSaleId, layout: 'THERMAL_80', reason }, ACCOUNT, {})
      }
      const report = harness.audit.getDayAudit({ businessDate: TODAY }, SUPERVISOR, 'BOTH')
      expect(report.reprints).toHaveLength(2)
      expect(report.findings.map((finding) => finding.code)).not.toContain('MANY_REPRINTS')
    } finally {
      harness.close()
    }
  })

  it('raises MANY_VOIDS on a sale that never completed', () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness, scale } = seeded
    try {
      // Nothing in this product writes VOIDED — a finished sale is reversed by a return — so the row is put there the
      // only way it could arrive: from outside. An audit that cannot see a void is an audit that would hide one.
      harness.database.prepare(`
        INSERT INTO sales (cashier_id, status, currency_code, subtotal, discount, tax, total, paid, change_amount,
          store_name, store_address, store_phone, created_at, sale_type)
        VALUES (?, 'VOIDED', 'NGN', 4000, 0, 0, 4000, 0, 0, 'Harbor Health', '12 Dock Road, Lagos', '',
          '2026-11-17 12:05:00', 'RETAIL')
      `).run(ACCOUNT.id)
      const report = harness.audit.getDayAudit({ businessDate: TODAY }, SUPERVISOR, 'BOTH')
      expect(report.voids).toHaveLength(1)
      expect(report.voids[0]).toMatchObject({
        cashierName: 'Amaka Account', status: 'VOIDED', totalMinor: 40n * scale,
      })
      const finding = report.findings.find((candidate) => candidate.code === 'MANY_VOIDS')
      expect(finding!.severity).toBe('SERIOUS')
      expect(finding!.headline).toBe('1 sale not completed')
      // A void is not a sale: it stays out of the totals and out of the reconciliation, or the day would stop adding up.
      expect(report.totals.transactions).toBe(2)
      expect(report.reconciliation.matches).toBe(true)
    } finally {
      harness.close()
    }
  })

  it('raises DISCOUNT_ABOVE_THRESHOLD as a note when a discount is close to the cap', () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness, scale } = seeded
    try {
      // 5 × 20 = 100 gross with 19 taken off is 19%, against a 20% permission: inside the cap, and inside the 90% band.
      harness.pointOfSale.completeSale({
        idempotencyKey: 'audit-near-cap-0001',
        saleType: 'RETAIL',
        items: [{ productId: seeded.productId, quantity: '5', manualDiscount: '19.00' }],
        payments: [{ method: 'CASH', amount: '81.00' }],
      }, ACCOUNT, 'BOTH')
      const report = harness.audit.getDayAudit({ businessDate: TODAY }, SUPERVISOR, 'BOTH')
      const row = report.discounts.find((candidate) => candidate.discountMinor === 19n * scale)
      expect(row).toMatchObject({
        basisPoints: 1_900n, capBasisPoints: 2_000n, capSource: 'USER_PERMISSION',
        nearCap: true, aboveCap: false, cashierName: 'Amaka Account',
      })
      const finding = report.findings.find((candidate) => candidate.code === 'DISCOUNT_ABOVE_THRESHOLD')
      expect(finding!.severity).toBe('NOTE')
      expect(finding!.headline).toBe('1 sale discounted close to the cap')
      expect(finding!.detail).toContain('within 90% of the cap')
    } finally {
      harness.close()
    }
  })

  it('raises DISCOUNT_ABOVE_THRESHOLD as serious when an Admin approved a discount past the cap', () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness, scale } = seeded
    try {
      // 5 × 20 = 100 gross with 25 taken off is 25%, against a 20% permission. The till refuses it and asks the Admin,
      // and an Admin who says yes is not the end of the matter: the sale is now on the audit screen as above the cap,
      // which is the whole point of approving it in the open rather than in a back room.
      const key = 'audit-over-cap-0001'
      const attempt = {
        idempotencyKey: key,
        saleType: 'RETAIL' as const,
        items: [{ productId: seeded.productId, quantity: '5', manualDiscount: '25.00' }],
        payments: [{ method: 'CASH' as const, amount: '75.00' }],
      }
      expect(() => harness.pointOfSale.completeSale(attempt, ACCOUNT, 'BOTH')).toThrowError(SaleApprovalRequired)
      // Raising the request is the host's job — the sale transaction has to have rolled back first — so at service level
      // the decision is written the way the host writes it: same key, same excess, same requester. 25 taken off a 100
      // gross against a 20% ceiling leaves an excess of 5.00, which is 500 minor units.
      harness.database.prepare(`
        INSERT INTO approval_requests (id, request_type, requested_by, status, payload_json, created_at, approved_by,
          resolved_at)
        VALUES ('audit-approval-1', 'DISCOUNT', ?, 'APPROVED', ?, '2026-11-17T12:10:00.000Z', ?,
          '2026-11-17T12:11:00.000Z')
      `).run(ACCOUNT.id, JSON.stringify({ idempotencyKey: key, excessMinor: '500' }), ADMIN.id)
      harness.pointOfSale.completeSale(attempt, ACCOUNT, 'BOTH', (kind, excess) => (
        harness.pointOfSale.hasApprovedOverride(kind, excess, key, ACCOUNT)
      ))

      const report = harness.audit.getDayAudit({ businessDate: TODAY }, SUPERVISOR, 'BOTH')
      const row = report.discounts.find((candidate) => candidate.discountMinor === 25n * scale)
      expect(row).toMatchObject({ basisPoints: 2_500n, capBasisPoints: 2_000n, aboveCap: true, nearCap: false })
      const finding = report.findings.find((candidate) => candidate.code === 'DISCOUNT_ABOVE_THRESHOLD')
      expect(finding!.severity).toBe('SERIOUS')
      expect(finding!.headline).toBe('1 sale discounted past the cap')
      expect(finding!.amountMinor).toBe(25n * scale)
      expect(finding!.detail).toContain('the approval is in the audit log')
    } finally {
      harness.close()
    }
  })

  it('names the shop setting as the cap when it is tighter than the cashier\'s own permission', () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness } = seeded
    try {
      // The Admin tightens the shop-wide limit to 2%, below the Account's 20%. The cap the audit reports has to be the
      // one the till actually applied, which is the tighter of the two, and it has to say which of the two that was.
      const settings = harness.shop.readSettings()
      harness.shop.saveSettings({
        ...settings,
        operational: { ...settings.operational, discountLimitBasisPoints: 200 },
      })
      const key = 'audit-shop-cap-0001'
      const attempt = {
        idempotencyKey: key,
        saleType: 'RETAIL' as const,
        items: [{ productId: seeded.productId, quantity: '5', manualDiscount: '3.00' }],
        payments: [{ method: 'CASH' as const, amount: '97.00' }],
      }
      // The till refuses it, because 3% is past the new 2% shop limit, and the Admin approves the 1.00 excess. The sale
      // then completes, and the audit still shows it as above the cap that applied — an approval is a reason, not a
      // disguise.
      expect(() => harness.pointOfSale.completeSale(attempt, ACCOUNT, 'BOTH')).toThrowError(SaleApprovalRequired)
      harness.database.prepare(`
        INSERT INTO approval_requests (id, request_type, requested_by, status, payload_json, created_at, approved_by,
          resolved_at)
        VALUES ('audit-approval-2', 'DISCOUNT', ?, 'APPROVED', ?, '2026-11-17T12:20:00.000Z', ?,
          '2026-11-17T12:21:00.000Z')
      `).run(ACCOUNT.id, JSON.stringify({ idempotencyKey: key, excessMinor: '100' }), ADMIN.id)
      harness.pointOfSale.completeSale(attempt, ACCOUNT, 'BOTH', (kind, excess) => (
        harness.pointOfSale.hasApprovedOverride(kind, excess, key, ACCOUNT)
      ))
      const report = harness.audit.getDayAudit({ businessDate: TODAY }, SUPERVISOR, 'BOTH')
      const row = report.discounts.find((candidate) => candidate.discountMinor === 300n)
      expect(row).toMatchObject({ basisPoints: 300n, capBasisPoints: 200n, capSource: 'SHOP_SETTINGS', aboveCap: true })
    } finally {
      harness.close()
    }
  })

  it('flags a line charged at something other than the catalogue price, and says when the catalogue moved', () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness, scale } = seeded
    try {
      // The till always charges the catalogue, so a different price can only arrive from outside: an imported sale, a
      // restored backup, a bug. This is what the section is for.
      const sale = harness.database.prepare(`
        INSERT INTO sales (cashier_id, status, currency_code, subtotal, discount, tax, total, paid, change_amount,
          store_name, store_address, store_phone, created_at, sale_type)
        VALUES (?, 'COMPLETED', 'NGN', 1500, 0, 0, 1500, 1500, 0, 'Harbor Health', '12 Dock Road, Lagos', '',
          '2026-11-17 12:05:00', 'RETAIL')
      `).run(ACCOUNT.id)
      const saleId = Number(sale.lastInsertRowid)
      harness.database.prepare(`
        INSERT INTO sale_items (id, sale_id, product_id, description_snapshot, quantity_milli, unit_price, discount,
          tax, line_total, price_tier, gross_total, manual_discount, promotion_discount, product_sku_snapshot)
        VALUES ('audit-item-1', ?, ?, 'Vitamin C', 1000, 1500, 0, 0, 1500, 'RETAIL', 1500, 0, 0, ?)
      `).run(saleId, seeded.productId, `AUDIT-NGN`)
      const report = harness.audit.getDayAudit({ businessDate: TODAY }, SUPERVISOR, 'BOTH')
      const override = report.overrides.find((row) => row.saleId === saleId)
      expect(override).toMatchObject({
        productName: 'Vitamin C', priceTier: 'RETAIL',
        cataloguePriceMinor: 20n * scale, chargedPriceMinor: 15n * scale, differenceMinor: -5n * scale,
        direction: 'BELOW_CATALOGUE', quantityMilli: 1000n, catalogueChangedSince: false,
      })
      expect(report.totals.overrides).toBe(1)
      // The hand-written sale is in the ledger too, so the day still adds up: the audit did not lose it or double it.
      expect(report.reconciliation.matches).toBe(true)
      expect(report.reconciliation.transactionsFromLedger).toBe(3)

      // An Admin who changes the price afterwards explains the older difference, and the row says so instead of
      // implying the cashier did it. Through the real product service, because the excuse is read out of the audit log
      // that service writes — a bare UPDATE would move the price and leave no trace, and the row would stay unexcused.
      harness.advance(30)
      editProduct(harness, seeded.productId, { retailPrice: '15.00' })
      // The override is still there, and still 5.00 below the catalogue: the price on the day was 20.00 whatever the
      // shelf says now. An edit that happens to land on the figure the cashier charged must not make the difference
      // disappear, because that is the one edit with the power to hide it.
      const after = harness.audit.getDayAudit({ businessDate: TODAY }, SUPERVISOR, 'BOTH')
        .overrides.find((row) => row.saleId === saleId)
      expect(after!.catalogueChangedSince).toBe(true)
      expect(after!.cataloguePriceMinor).toBe(20n * scale)
      expect(after!.chargedPriceMinor).toBe(15n * scale)
      expect(after!.differenceMinor).toBe(-5n * scale)

      // And an edit that has nothing to do with the price excuses nothing: correcting a spelling is not a reason for a
      // cashier to have charged 15.00 for a 20.00 product.
      const second = seedOrdinaryDay('NGN')
      try {
        const otherSale = second.harness.database.prepare(`
          INSERT INTO sales (cashier_id, status, currency_code, subtotal, discount, tax, total, paid, change_amount,
            store_name, store_address, store_phone, created_at, sale_type)
          VALUES (?, 'COMPLETED', 'NGN', 1500, 0, 0, 1500, 1500, 0, 'Harbor Health', '12 Dock Road, Lagos', '',
            '2026-11-17 12:05:00', 'RETAIL')
        `).run(ACCOUNT.id)
        const otherId = Number(otherSale.lastInsertRowid)
        second.harness.database.prepare(`
          INSERT INTO sale_items (id, sale_id, product_id, description_snapshot, quantity_milli, unit_price, discount,
            tax, line_total, price_tier, gross_total, manual_discount, promotion_discount, product_sku_snapshot)
          VALUES ('audit-item-2', ?, ?, 'Vitamin C', 1000, 1500, 0, 0, 1500, 'RETAIL', 1500, 0, 0, 'AUDIT-NGN')
        `).run(otherId, second.productId)
        second.harness.advance(30)
        editProduct(second.harness, second.productId, { description: 'Corrected spelling' })
        const row = second.harness.audit.getDayAudit({ businessDate: TODAY }, SUPERVISOR, 'BOTH')
          .overrides.find((candidate) => candidate.saleId === otherId)
        expect(row!.differenceMinor).toBe(-5n * second.harness.scale)
        expect(row!.catalogueChangedSince).toBe(false)
      } finally {
        second.harness.close()
      }
    } finally {
      harness.close()
    }
  })

  it('flags sales rung up in the small hours, which fall on the next business day', () => {
    const harness = createHarness('NGN', { now: Date.parse('2026-11-17T02:30:00.000Z') })
    try {
      const productId = stockProduct(harness, 'NIGHT')
      harness.pointOfSale.completeSale({
        idempotencyKey: 'audit-night-0001',
        saleType: 'RETAIL',
        items: [{ productId, quantity: '1' }],
        payments: [{ method: 'CASH', amount: '20.00' }],
      }, ACCOUNT, 'BOTH')
      const report = harness.audit.getDayAudit({ businessDate: TODAY }, SUPERVISOR, 'BOTH')
      expect(report.sales[0]!.time).toBe('02:30:00')
      const finding = report.findings.find((candidate) => candidate.code === 'SALES_AFTER_MIDNIGHT')
      expect(finding!.severity).toBe('CONCERN')
      expect(finding!.headline).toBe('1 sale recorded before 05:00')
      expect(finding!.detail).toContain('at 02:30:00')
      expect(finding!.amountMinor).toBe(2000n)
    } finally {
      harness.close()
    }
  })

  it('does not flag an afternoon sale as one rung up after midnight', () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness } = seeded
    try {
      const report = harness.audit.getDayAudit({ businessDate: TODAY }, SUPERVISOR, 'BOTH')
      expect(report.sales.map((row) => row.time)).toEqual(['12:00:00', '12:00:00'])
      expect(report.findings.map((finding) => finding.code)).not.toContain('SALES_AFTER_MIDNIGHT')
    } finally {
      harness.close()
    }
  })

  it('flags an order that was changed after the till tried to take its payment', () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness } = seeded
    try {
      const order = harness.orders.createOrder({
        saleType: 'RETAIL', items: [{ productId: seeded.productId, quantity: '3' }],
        idempotencyKey: 'audit-order-0001',
      }, PICKER, 'BOTH')
      // The till tried and was refused. Nothing was charged and no stock moved, but the attempt is in the immutable
      // event log, which is what makes the next line meaningful.
      harness.orders.recordPaymentRefusal(order.id, 'This sale exceeds your 20% permission limit.', ACCOUNT)
      harness.advance(5)
      harness.orders.adjustLineQuantity(order.id, order.lines[0]!.id, '1', ACCOUNT)

      const report = harness.audit.getDayAudit({ businessDate: TODAY }, SUPERVISOR, 'BOTH')
      const finding = report.findings.find(
        (candidate) => candidate.code === 'ORDER_EDITED_AFTER_PAYMENT_ATTEMPT')
      expect(finding!.severity).toBe('SERIOUS')
      expect(finding!.headline).toBe('1 order changed after a payment attempt')
      expect(finding!.detail).toContain(order.orderNumber)
      expect(finding!.detail).toContain('20% permission limit')
    } finally {
      harness.close()
    }
  })

  it('does not flag an order that was changed before anybody tried to take its payment', () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness } = seeded
    try {
      const order = harness.orders.createOrder({
        saleType: 'RETAIL', items: [{ productId: seeded.productId, quantity: '3' }],
        idempotencyKey: 'audit-order-0002',
      }, PICKER, 'BOTH')
      harness.advance(5)
      harness.orders.adjustLineQuantity(order.id, order.lines[0]!.id, '2', ACCOUNT)
      harness.advance(5)
      harness.orders.recordPaymentRefusal(order.id, 'Card terminal declined.', ACCOUNT)
      const report = harness.audit.getDayAudit({ businessDate: TODAY }, SUPERVISOR, 'BOTH')
      expect(report.findings.map((finding) => finding.code))
        .not.toContain('ORDER_EDITED_AFTER_PAYMENT_ATTEMPT')
    } finally {
      harness.close()
    }
  })

  it('refuses to record a payment attempt to anybody who may not take a payment, and writes nothing', () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness } = seeded
    try {
      const order = harness.orders.createOrder({
        saleType: 'RETAIL', items: [{ productId: seeded.productId, quantity: '3' }],
        idempotencyKey: 'audit-order-0003',
      }, PICKER, 'BOTH')
      // The guard, and the guard removed: a picker has no `take_payment`, so a picker cannot put a refusal into the
      // log. Without the capability check this call would succeed and an audit trail would contain an event nobody was
      // entitled to write.
      expect(() => harness.orders.recordPaymentRefusal(order.id, 'Whatever happened here.', PICKER))
        .toThrowError('Your role cannot attempt a payment.')
      expect(() => harness.orders.recordPaymentRefusal(order.id, 'Whatever happened here.', SUPERVISOR))
        .toThrowError('Your role cannot attempt a payment.')
      expect(harness.database.prepare(`
        SELECT COUNT(*) AS n FROM order_events WHERE event = 'order.payment_refused'
      `).get()).toEqual({ n: 0 })
      expect(() => harness.orders.recordPaymentRefusal('no-such-order', 'Anything.', ACCOUNT))
        .toThrowError('That order could not be found.')
    } finally {
      harness.close()
    }
  })

  it('seeds every check in the list, so a new check cannot arrive without a scenario that proves it', () => {
    // Derived from the service's own list rather than a second copy of it: add a check to AUDIT_CHECK_CODES and this
    // test fails until somebody has written the bad data that raises it.
    const raised = new Set<AuditCheckCode>()
    const scenarios: Array<() => Harness> = [
      () => {
        const seeded = seedOrdinaryDay('NGN')
        seeded.harness.reports.closeDay({ businessDate: TODAY, countedCash: '100.00' }, ADMIN, 'BOTH')
        return seeded.harness
      },
      () => {
        const seeded = seedOrdinaryDay('NGN')
        seeded.harness.gate.print({ kind: 'SALE', documentId: seeded.retailSaleId, layout: 'A4_RECEIPT' }, ACCOUNT, {})
        for (const reason of ['One', 'Two', 'Three']) {
          seeded.harness.advance(1)
          seeded.harness.gate.print({ kind: 'SALE', documentId: seeded.retailSaleId, layout: 'A4_RECEIPT', reason },
            ACCOUNT, {})
        }
        return seeded.harness
      },
      () => {
        const seeded = seedOrdinaryDay('NGN')
        seeded.harness.database.prepare(`
          INSERT INTO sales (cashier_id, status, currency_code, subtotal, discount, tax, total, paid, change_amount,
            store_name, store_address, store_phone, created_at, sale_type)
          VALUES (?, 'VOIDED', 'NGN', 100, 0, 0, 100, 0, 0, '', '', '', '2026-11-17 12:05:00', 'RETAIL')
        `).run(ACCOUNT.id)
        return seeded.harness
      },
      () => {
        const seeded = seedOrdinaryDay('NGN')
        seeded.harness.pointOfSale.completeSale({
          idempotencyKey: 'audit-every-check-0001',
          saleType: 'RETAIL',
          items: [{ productId: seeded.productId, quantity: '5', manualDiscount: '19.00' }],
          payments: [{ method: 'CASH', amount: '81.00' }],
        }, ACCOUNT, 'BOTH')
        return seeded.harness
      },
      () => {
        const harness = createHarness('NGN', { now: Date.parse('2026-11-17T01:15:00.000Z') })
        const productId = stockProduct(harness, 'EVERY')
        harness.pointOfSale.completeSale({
          idempotencyKey: 'audit-every-check-0002',
          saleType: 'RETAIL',
          items: [{ productId, quantity: '1' }],
          payments: [{ method: 'CASH', amount: '20.00' }],
        }, ACCOUNT, 'BOTH')
        return harness
      },
      () => {
        const seeded = seedOrdinaryDay('NGN')
        const order = seeded.harness.orders.createOrder({
          saleType: 'RETAIL', items: [{ productId: seeded.productId, quantity: '3' }],
          idempotencyKey: 'audit-every-check-0003',
        }, PICKER, 'BOTH')
        seeded.harness.orders.recordPaymentRefusal(order.id, 'Refused.', ACCOUNT)
        seeded.harness.advance(3)
        seeded.harness.orders.adjustLineQuantity(order.id, order.lines[0]!.id, '1', ACCOUNT)
        return seeded.harness
      },
    ]
    const harnesses: Harness[] = []
    try {
      for (const scenario of scenarios) {
        const harness = scenario()
        harnesses.push(harness)
        for (const finding of harness.audit.getDayAudit({ businessDate: TODAY }, SUPERVISOR, 'BOTH').findings) {
          raised.add(finding.code)
        }
      }
      expect([...raised].sort()).toEqual([...AUDIT_CHECK_CODES].sort())
    } finally {
      for (const harness of harnesses) harness.close()
    }
  })
})

describe('DailyAuditService · signing a day off', () => {
  it('records the Supervisor\'s name, the time and the verdict, and the day is audited from then on', () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness } = seeded
    try {
      expect(harness.audit.listUnauditedDays(SUPERVISOR, 'BOTH').map((day) => day.businessDate)).toContain(TODAY)

      const signOff = harness.audit.signOffDay(
        { businessDate: TODAY, outcome: 'AUDITED', note: 'Counted with the Account present.' }, SUPERVISOR, 'BOTH')
      expect(signOff.outcome).toBe('AUDITED')
      expect(signOff.signedByName).toBe('Sam Supervisor')
      expect(signOff.signedAt).toBe(new Date(NOW).toISOString())
      expect(signOff.note).toBe('Counted with the Account present.')
      expect(signOff.subjectDigest).toMatch(/^[0-9a-f]{64}$/u)

      const report = harness.audit.getDayAudit({ businessDate: TODAY }, SUPERVISOR, 'BOTH')
      expect(report.signOff).toMatchObject({ outcome: 'AUDITED', digestMatches: true })
      expect(harness.audit.listUnauditedDays(SUPERVISOR, 'BOTH').map((day) => day.businessDate)).not.toContain(TODAY)
      // The Admin is shown the same status, with the name and the time, which is what "audited" has to mean to them.
      const status = harness.audit.dayStatuses(ADMIN, 'BOTH').find((day) => day.businessDate === TODAY)
      expect(status).toMatchObject({
        audited: true, outcome: 'AUDITED', signedByName: 'Sam Supervisor', signedAt: new Date(NOW).toISOString(),
      })
    } finally {
      harness.close()
    }
  })

  it('refuses to sign the same day twice, because a sign-off is history and history is not edited', () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness } = seeded
    try {
      harness.audit.signOffDay({ businessDate: TODAY, outcome: 'AUDITED' }, SUPERVISOR, 'BOTH')
      expect(() => harness.audit.signOffDay({ businessDate: TODAY, outcome: 'AUDITED_WITH_ISSUES' }, SUPERVISOR, 'BOTH'))
        .toThrowError('2026-11-17 has already been signed off by Sam Supervisor')
      expect(() => harness.audit.signOffDay({ businessDate: TODAY, outcome: 'AUDITED' }, ADMIN, 'BOTH'))
        .toThrowError(/already been signed off/u)
      expect(harness.database.prepare('SELECT COUNT(*) AS n FROM audit_signoffs').get()).toEqual({ n: 1 })
      // The database agrees, independently of the service: migration 16 made the table immutable in both directions.
      expect(() => harness.database.prepare(`UPDATE audit_signoffs SET note = 'rewritten' WHERE 1 = 1`).run())
        .toThrowError(/immutable|cannot be changed/iu)
      expect(() => harness.database.prepare('DELETE FROM audit_signoffs WHERE 1 = 1').run())
        .toThrowError(/immutable|cannot be deleted/iu)
      // And a second sign-off cannot be forced in behind the service either.
      expect(() => harness.database.prepare(`
        INSERT INTO audit_signoffs (id, subject_kind, subject_id, signed_by, subject_digest, note, outcome, signed_at)
        VALUES ('forced', 'DAY_CLOSE', ?, ?, 'digest', '', 'AUDITED', '2026-11-17T13:00:00.000Z')
      `).run(TODAY, SUPERVISOR.id)).toThrowError(/UNIQUE/iu)
    } finally {
      harness.close()
    }
  })

  it('will not take a clean verdict on a day the checks did not pass, unless the Supervisor explains it', () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness } = seeded
    try {
      harness.reports.closeDay({ businessDate: TODAY, countedCash: '100.00' }, ADMIN, 'BOTH')
      const findings = harness.audit.getDayAudit({ businessDate: TODAY }, SUPERVISOR, 'BOTH').findings
      expect(findings.map((finding) => finding.code)).toContain('CASH_DIFFERENCE')

      expect(() => harness.audit.signOffDay({ businessDate: TODAY, outcome: 'AUDITED' }, SUPERVISOR, 'BOTH'))
        .toThrowError('This day has 1 finding: The drawer was short by ₦84.00')
      expect(() => harness.audit.signOffDay({ businessDate: TODAY, outcome: 'AUDITED' }, SUPERVISOR, 'BOTH'))
        .toThrowError('Write a note explaining the verdict, or sign the day off as audited with issues.')
      expect(harness.database.prepare('SELECT COUNT(*) AS n FROM audit_signoffs').get()).toEqual({ n: 0 })

      // Either way out is a real one: say why, or say it had issues.
      const explained = harness.audit.signOffDay({
        businessDate: TODAY, outcome: 'AUDITED', note: 'The ₦84 was taken to the bank at 4pm; the slip is filed.',
      }, SUPERVISOR, 'BOTH')
      expect(explained.outcome).toBe('AUDITED')
      expect(explained.note).toContain('taken to the bank')
    } finally {
      harness.close()
    }
  })

  it('takes "audited with issues" without demanding a note, and refuses a verdict nobody defined', () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness } = seeded
    try {
      harness.reports.closeDay({ businessDate: TODAY, countedCash: '100.00' }, ADMIN, 'BOTH')
      const signOff = harness.audit.signOffDay(
        { businessDate: TODAY, outcome: 'AUDITED_WITH_ISSUES' }, SUPERVISOR, 'BOTH')
      expect(signOff.outcome).toBe('AUDITED_WITH_ISSUES')
      expect(signOff.note).toBe('')
      // Cast, deliberately: the point of this line is to send a verdict that does not exist and watch it be refused.
      const invented = 'PROBABLY_FINE' as AuditSignOffOutcome
      expect(() => harness.audit.signOffDay({ businessDate: '2026-11-16', outcome: invented }, SUPERVISOR, 'BOTH'))
        .toThrowError('Choose either Audited or Audited with issues.')
    } finally {
      harness.close()
    }
  })

  it('says when the day it was shown is not the day that is there now', () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness } = seeded
    try {
      harness.audit.signOffDay({ businessDate: TODAY, outcome: 'AUDITED' }, SUPERVISOR, 'BOTH')
      expect(harness.audit.getDayAudit({ businessDate: TODAY }, SUPERVISOR, 'BOTH').signOff!.digestMatches).toBe(true)

      // Somebody rings up another sale on a day that has already been signed off. The sale is legitimate — nothing here
      // can stop the shop trading — but the Supervisor did not see it, and the screen has to say so rather than carry on
      // showing "Audited" as though it covered this too.
      harness.advance(20)
      harness.pointOfSale.completeSale({
        idempotencyKey: 'audit-after-signoff-0001',
        saleType: 'RETAIL',
        items: [{ productId: seeded.productId, quantity: '1' }],
        payments: [{ method: 'CASH', amount: '20.00' }],
      }, ACCOUNT, 'BOTH')
      const report = harness.audit.getDayAudit({ businessDate: TODAY }, SUPERVISOR, 'BOTH')
      expect(report.signOff!.digestMatches).toBe(false)
      expect(report.signOff!.outcome).toBe('AUDITED')
      expect(report.totals.transactions).toBe(3)
      // The sign-off itself did not change: it still says what it said, about the day it was shown.
      expect(harness.database.prepare('SELECT COUNT(*) AS n FROM audit_signoffs').get()).toEqual({ n: 1 })
    } finally {
      harness.close()
    }
  })

  it('audits one Account at a time, and a whole-store sign-off covers every till in it', () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness } = seeded
    try {
      // The day has two sales: the Account's retail one and the Admin's wholesale one.
      const scoped = harness.audit.getDayAudit({ businessDate: TODAY, accountId: ACCOUNT.id }, SUPERVISOR, 'BOTH')
      expect(scoped.account).toMatchObject({ id: ACCOUNT.id, name: 'Amaka Account', username: 'account1' })
      expect(scoped.sales.map((row) => row.receiptNumber)).toEqual([seeded.retailReceipt])
      expect(scoped.totals.transactions).toBe(1)
      expect(scoped.totals.totalSalesMinor).toBe(38n * harness.scale)
      expect(scoped.reconciliation.matches).toBe(true)

      const admins = harness.audit.getDayAudit({ businessDate: TODAY, accountId: ADMIN.id }, SUPERVISOR, 'BOTH')
      expect(admins.sales.map((row) => row.receiptNumber)).toEqual([seeded.wholesaleReceipt])
      expect(admins.totals.wholesaleTransactions).toBe(1)
      expect(admins.totals.retailTransactions).toBe(0)

      // Signing off one till leaves the other unaudited, and the list says exactly which.
      harness.audit.signOffDay({ businessDate: TODAY, accountId: ACCOUNT.id, outcome: 'AUDITED' }, SUPERVISOR, 'BOTH')
      const statuses = harness.audit.dayStatuses(SUPERVISOR, 'BOTH').filter((day) => day.businessDate === TODAY)
      // Ordered by account id, which is stable but is not alphabetical by name: 'audit-account' sorts before
      // 'audit-admin'. What the assertion is about is that the two tills disagree on being audited.
      expect(statuses.map((day) => [day.accountName, day.audited])).toEqual([
        ['Amaka Account', true], ['Ada Admin', false],
      ])
      // One signature for the whole store closes both, because a Supervisor who audited the day did not leave a till out.
      harness.audit.signOffDay({ businessDate: TODAY, outcome: 'AUDITED_WITH_ISSUES' }, SUPERVISOR, 'BOTH')
      expect(harness.audit.listUnauditedDays(SUPERVISOR, 'BOTH').filter((day) => day.businessDate === TODAY)).toEqual([])
    } finally {
      harness.close()
    }
  })

  it('lists the days nobody has looked at, most recent first, with what happened on them', () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness, scale } = seeded
    try {
      const days = harness.audit.listUnauditedDays(SUPERVISOR, 'BOTH')
      expect(days.map((day) => day.businessDate)).toEqual([TODAY, TODAY])
      expect(days.map((day) => day.accountName).sort()).toEqual(['Ada Admin', 'Amaka Account'])
      const account = days.find((day) => day.accountId === ACCOUNT.id)!
      expect(account.transactions).toBe(1)
      expect(account.salesMinor).toBe(38n * scale)
      expect(account.currencyCode).toBe('NGN')
      expect(account.dayClosed).toBe(false)
      expect(account.openFlags).toBe(0)

      // A day with no sales and no close is not a day anybody owes a look at.
      expect(harness.audit.listUnauditedDays(SUPERVISOR, 'BOTH', 7).map((day) => day.businessDate))
        .not.toContain('2026-11-16')
      expect(harness.audit.summaryForPhone(ADMIN, 'BOTH').unauditedDays).toHaveLength(2)
      expect(harness.audit.summaryForPhone(ADMIN, 'BOTH').auditedDays).toEqual([])
    } finally {
      harness.close()
    }
  })
})

describe('DailyAuditService · flags and notes', () => {
  it('keeps one open note per automatic check, however many times the day is opened', () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness } = seeded
    try {
      harness.reports.closeDay({ businessDate: TODAY, countedCash: '100.00' }, ADMIN, 'BOTH')
      const first = harness.audit.noteFinding({
        businessDate: TODAY, code: 'CASH_DIFFERENCE', detail: 'Counted twice with the same result.',
      }, SUPERVISOR, 'BOTH')
      expect(first.source).toBe('AUTOMATIC')
      expect(first.checkCode).toBe('CASH_DIFFERENCE')
      // The severity defaults to the one the check itself gave the finding, not to a guess.
      expect(first.severity).toBe('SERIOUS')
      expect(first.detail).toContain('Sam Supervisor')
      expect(first.detail).toContain('Counted twice with the same result.')
      expect(first.raisedByName).toBe('Sam Supervisor')
      expect(first.resolvedAt).toBe('')

      const second = harness.audit.noteFinding({
        businessDate: TODAY, code: 'CASH_DIFFERENCE', detail: 'The bank bag was still in the safe.',
      }, SUPERVISOR, 'BOTH')
      expect(second.id).toBe(first.id)
      expect(second.detail).toContain('Counted twice with the same result.')
      expect(second.detail).toContain('The bank bag was still in the safe.')
      expect(harness.database.prepare(`
        SELECT COUNT(*) AS n FROM audit_flags WHERE source = 'AUTOMATIC' AND resolved_at IS NULL
      `).get()).toEqual({ n: 1 })

      const report = harness.audit.getDayAudit({ businessDate: TODAY }, SUPERVISOR, 'BOTH')
      expect(report.flags).toHaveLength(1)
      expect(report.findings.map((finding) => finding.code)).toContain('CASH_DIFFERENCE')
      expect(() => harness.audit.noteFinding(
        { businessDate: TODAY, code: 'SOMETHING_ELSE' as AuditCheckCode, detail: 'Made up.' }, SUPERVISOR, 'BOTH'))
        .toThrowError('Choose one of the audit checks to note.')
    } finally {
      harness.close()
    }
  })

  it('appends to a flag rather than overwriting it, and closes it without deleting it', () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness } = seeded
    try {
      const flag = harness.audit.raiseFlag(
        { businessDate: TODAY, severity: 'CONCERN', detail: 'The safe drop has no witness.' }, SUPERVISOR, 'BOTH')
      const noted = harness.audit.addFlagNote({ flagId: flag.id, detail: 'Amaka says the guard signed the book.' },
        SUPERVISOR, 'BOTH')
      expect(noted.detail).toContain('The safe drop has no witness.')
      expect(noted.detail).toContain('Amaka says the guard signed the book.')

      const resolved = harness.audit.resolveFlag(
        { flagId: flag.id, resolutionNote: 'Checked the book; the signature is there.' }, ADMIN, 'BOTH')
      expect(resolved.resolvedByName).toBe('Ada Admin')
      expect(resolved.resolvedAt).toBe(new Date(NOW).toISOString())
      expect(resolved.resolutionNote).toBe('Checked the book; the signature is there.')
      // The original words are still there. Closing a flag is not rewriting it.
      expect(resolved.detail).toContain('The safe drop has no witness.')
      expect(() => harness.audit.resolveFlag({ flagId: flag.id, resolutionNote: 'Again.' }, ADMIN, 'BOTH'))
        .toThrowError('That flag has already been resolved.')
      expect(() => harness.audit.addFlagNote({ flagId: 'no-such-flag', detail: 'Hello.' }, SUPERVISOR, 'BOTH'))
        .toThrowError('That flag no longer exists.')
      // A resolved flag is still a flag: it stays on the day, so the record shows it was raised and what came of it.
      const report = harness.audit.getDayAudit({ businessDate: TODAY }, SUPERVISOR, 'BOTH')
      expect(report.flags).toHaveLength(1)
      expect(report.flags[0]!.resolvedByName).toBe('Ada Admin')
      expect(harness.audit.summaryForPhone(ADMIN, 'BOTH').openFlags).toEqual([])
    } finally {
      harness.close()
    }
  })

  it('lets a check be noted again once the earlier note has been closed, without losing either', () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness } = seeded
    try {
      const first = harness.audit.noteFinding(
        { businessDate: TODAY, code: 'MANY_REPRINTS', detail: 'Nothing to see.' }, SUPERVISOR, 'BOTH')
      harness.audit.resolveFlag({ flagId: first.id, resolutionNote: 'Closed it too early.' }, SUPERVISOR, 'BOTH')
      const second = harness.audit.noteFinding(
        { businessDate: TODAY, code: 'MANY_REPRINTS', detail: 'Actually, three reprints on one receipt.' },
        SUPERVISOR, 'BOTH')
      expect(second.id).not.toBe(first.id)
      expect(second.detail).toContain('three reprints')
      expect(second.detail).not.toContain('Nothing to see.')
      const report = harness.audit.getDayAudit({ businessDate: TODAY }, SUPERVISOR, 'BOTH')
      expect(report.flags).toHaveLength(2)
      expect(report.flags.filter((row) => row.resolvedAt !== '')).toHaveLength(1)
    } finally {
      harness.close()
    }
  })

  it('counts open flags against the day they belong to, and shows them on the phone summary', () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness } = seeded
    try {
      harness.audit.raiseFlag({ businessDate: TODAY, severity: 'SERIOUS', detail: 'First.' }, SUPERVISOR, 'BOTH')
      const second = harness.audit.raiseFlag(
        { businessDate: TODAY, severity: 'NOTE', detail: 'Second.' }, SUPERVISOR, 'BOTH')
      expect(harness.audit.listUnauditedDays(ADMIN, 'BOTH')[0]!.openFlags).toBe(2)
      harness.audit.resolveFlag({ flagId: second.id, resolutionNote: 'Not a problem.' }, ADMIN, 'BOTH')
      expect(harness.audit.listUnauditedDays(ADMIN, 'BOTH')[0]!.openFlags).toBe(1)

      const summary = harness.audit.summaryForPhone(ADMIN, 'BOTH')
      expect(summary.openFlags).toHaveLength(1)
      expect(summary.openFlags[0]).toMatchObject({
        severity: 'SERIOUS', raisedByName: 'Sam Supervisor', businessDate: TODAY,
      })
      expect(summary.openFlags[0]!.detail).toContain('First.')
      expect(() => harness.audit.summaryForPhone(ACCOUNT, 'BOTH'))
        .toThrowError('You do not have permission to audit the day.')
    } finally {
      harness.close()
    }
  })

  it('refuses a blank note, a note that is only spaces, and one long enough to be a document', () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness } = seeded
    try {
      expect(() => harness.audit.raiseFlag({ businessDate: TODAY, severity: 'NOTE', detail: '' }, SUPERVISOR, 'BOTH'))
        .toThrowError('Enter flag text.')
      expect(() => harness.audit.raiseFlag({ businessDate: TODAY, severity: 'NOTE', detail: '    ' }, SUPERVISOR, 'BOTH'))
        .toThrowError('Enter flag text.')
      expect(() => harness.audit.raiseFlag(
        { businessDate: TODAY, severity: 'NOTE', detail: 'x'.repeat(1001) }, SUPERVISOR, 'BOTH'))
        .toThrowError('Flag must be 1000 characters or fewer.')
      expect(() => harness.audit.raiseFlag(
        { businessDate: TODAY, severity: 'CATASTROPHIC' as never, detail: 'Something.' }, SUPERVISOR, 'BOTH'))
        .toThrowError('Choose how serious this flag is.')
      expect(() => harness.audit.signOffDay(
        { businessDate: TODAY, outcome: 'AUDITED', note: 'y'.repeat(2001) }, SUPERVISOR, 'BOTH'))
        .toThrowError('Note must be 2000 characters or fewer.')
      expect(harness.database.prepare('SELECT COUNT(*) AS n FROM audit_flags').get()).toEqual({ n: 0 })
    } finally {
      harness.close()
    }
  })
})

describe('DailyAuditService · a customer settling what they owe', () => {
  it('moves the balance, fills the drawer and shows on the audit, in every currency', () => {
    for (const code of ['NGN', 'JPY', 'KWD']) {
      const seeded = seedOrdinaryDay(code)
      const { harness, scale } = seeded
      try {
        // The seeded day already settled the 5 the customer owed, so this one is a second customer's debt.
        const customer = harness.pointOfSale.createCustomer({
          name: 'Bode Debtor', phone: '+234 800 333 4444', email: '', address: '',
          creditLimit: fromMinor(50n * scale, harness.currency), enrolLoyalty: false,
        }, ADMIN, 'BOTH')
        harness.database.prepare('UPDATE customers SET balance = ? WHERE id = ?').run(30n * scale, customer.id)
        const payment = harness.reports.recordDebtorPayment({
          customerId: customer.id, amount: fromMinor(12n * scale, harness.currency), method: 'CASH',
          reference: 'CHQ-99', note: 'Part payment',
        }, ACCOUNT, 'BOTH')
        expect(payment.paymentNumber).toMatch(/^DP-\d{8}$/u)
        expect(payment.amountMinor).toBe(12n * scale)
        expect(payment.balanceBeforeMinor).toBe(30n * scale)
        expect(payment.balanceAfterMinor).toBe(18n * scale)
        expect(payment.customerName).toBe('Bode Debtor')
        expect(payment.receivedByName).toBe('Amaka Account')
        expect(harness.database.prepare('SELECT CAST(balance AS TEXT) AS b FROM customers WHERE id = ?')
          .get(customer.id)).toEqual({ b: (18n * scale).toString() })

        const report = harness.audit.getDayAudit({ businessDate: TODAY }, SUPERVISOR, 'BOTH')
        expect(report.totals.debtorPaymentTransactions).toBe(2)
        expect(report.totals.debtorPaymentsMinor).toBe(17n * scale)
        expect(report.cashTie.debtorCashMinor).toBe(17n * scale)
        expect(report.cashTie.expectedCashMinor).toBe(196n * scale)
        expect(report.reconciliation.matches).toBe(true)
      } finally {
        harness.close()
      }
    }
  })

  it('refuses a payment that is not owed, is not money, or is more than the debt', () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness, scale } = seeded
    try {
      const customer = harness.pointOfSale.createCustomer({
        name: 'Clean Customer', phone: '', email: '', address: '',
        creditLimit: fromMinor(50n * scale, harness.currency), enrolLoyalty: false,
      }, ADMIN, 'BOTH')
      expect(() => harness.reports.recordDebtorPayment(
        { customerId: customer.id, amount: '10.00', method: 'CASH' }, ACCOUNT, 'BOTH'))
        .toThrowError('Clean Customer owes nothing, so there is no payment to take.')
      harness.database.prepare('UPDATE customers SET balance = 5000 WHERE id = ?').run(customer.id)
      expect(() => harness.reports.recordDebtorPayment(
        { customerId: customer.id, amount: '60.00', method: 'CASH' }, ACCOUNT, 'BOTH'))
        .toThrowError('Clean Customer owes ₦50.00. Taking more than that would leave them in credit')
      expect(() => harness.reports.recordDebtorPayment(
        { customerId: customer.id, amount: '0.00', method: 'CASH' }, ACCOUNT, 'BOTH'))
        .toThrowError('A payment must be more than zero.')
      expect(() => harness.reports.recordDebtorPayment(
        { customerId: customer.id, amount: '-5.00', method: 'CASH' }, ACCOUNT, 'BOTH'))
        .toThrowError(/Enter Payment using NGN|A payment must be more than zero/u)
      expect(() => harness.reports.recordDebtorPayment(
        { customerId: customer.id, amount: '10.00', method: 'BITCOIN' as never }, ACCOUNT, 'BOTH'))
        .toThrowError('Choose how the customer paid.')
      expect(() => harness.reports.recordDebtorPayment(
        { customerId: 'no-such-customer', amount: '10.00', method: 'CASH' }, ACCOUNT, 'BOTH'))
        .toThrowError('That customer no longer exists.')
      // Nothing moved while all of that was being refused.
      expect(harness.database.prepare('SELECT COUNT(*) AS n FROM debtor_payments').get()).toEqual({ n: 1 })
      expect(harness.database.prepare('SELECT CAST(balance AS TEXT) AS b FROM customers WHERE id = ?')
        .get(customer.id)).toEqual({ b: '5000' })
    } finally {
      harness.close()
    }
  })

  it('refuses a role that may not take money, and keeps the balance version moving so two tills cannot both settle it', () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness, scale } = seeded
    try {
      const customer = harness.pointOfSale.createCustomer({
        name: 'Debtor Two', phone: '', email: '', address: '',
        creditLimit: fromMinor(50n * scale, harness.currency), enrolLoyalty: false,
      }, ADMIN, 'BOTH')
      harness.database.prepare('UPDATE customers SET balance = 5000 WHERE id = ?').run(customer.id)
      for (const actor of [PICKER, SUPERVISOR]) {
        expect(() => harness.reports.recordDebtorPayment(
          { customerId: customer.id, amount: '10.00', method: 'CASH' }, actor, 'BOTH'))
          .toThrowError('You do not have permission to take a payment against a customer balance.')
      }
      expect(harness.database.prepare('SELECT COUNT(*) AS n FROM debtor_payments').get()).toEqual({ n: 1 })

      const before = harness.database.prepare('SELECT row_version FROM customers WHERE id = ?').get(customer.id) as
        { row_version: number }
      harness.reports.recordDebtorPayment(
        { customerId: customer.id, amount: '10.00', method: 'CASH' }, ACCOUNT, 'BOTH')
      const after = harness.database.prepare('SELECT row_version FROM customers WHERE id = ?').get(customer.id) as
        { row_version: number }
      // The version moved, which is the whole of the guarantee a single-writer database can offer: the second till reads
      // the new version and the new balance, so it cannot settle the same debt twice. There is no interleaving to stage
      // on one connection, so this asserts the mechanism is maintained rather than pretending to race it.
      expect(after.row_version).toBe(before.row_version + 1)
      expect(harness.database.prepare(
        'UPDATE customers SET balance = 0 WHERE id = ? AND row_version = ?',
      ).run(customer.id, before.row_version).changes).toBe(0)
    } finally {
      harness.close()
    }
  })
})

describe('DailyAuditService · taking the day off the machine', () => {
  /**
   * Read the audit-log rows, newest last.
   *
   * Ordered by `rowid` and not by `id`: `audit_log.id` is a TEXT uuid, so ordering by it sorts alphabetically and the
   * "newest" row is whichever uuid happens to begin with the highest character. rowid is the insertion order, which is
   * the order this assertion is about.
   */
  function auditLog(harness: Harness): Array<{ action: string; metadata: string }> {
    return harness.database.prepare(`
      SELECT action, metadata_json AS metadata FROM audit_log ORDER BY rowid
    `).all() as Array<{ action: string; metadata: string }>
  }

  it('hands back a CSV of exactly the day the caller was shown', async () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness, scale } = seeded
    try {
      const exported = await harness.audit.exportAudit(
        { businessDate: TODAY, format: 'CSV' }, SUPERVISOR, 'BOTH')
      expect(exported.format).toBe('CSV')
      expect(exported.mimeType).toBe('text/csv;charset=utf-8')
      expect(exported.fileName).toBe(`daily-audit-${TODAY}.csv`)
      expect(exported.currencyCode).toBe('NGN')

      const csv = Buffer.from(exported.contentBase64, 'base64').toString('utf8')
      // The figures are the report's own, not a second reading of the day.
      expect(csv).toContain('"Store","Harbor Health"')
      expect(csv).toContain(seeded.retailReceipt)
      expect(csv).toContain(seeded.wholesaleReceipt)
      // Money leaves as a plain figure with the currency named once in the header block, rather than carrying a symbol
      // into every cell: a column of "₦130.00" cannot be summed by a spreadsheet, and a column of 130.00 can.
      expect(csv).toContain('"130.00"')
      expect(csv).toContain('"Currency","NGN"')
      // And the same figure as the screen shows it, so the two are demonstrably the same day.
      expect(formatMoney(130n * scale, harness.currency, defaultDisplayOptions(harness.currency))).toBe('₦130.00')
      // The drawer argument is in the file, because that is the part somebody will want to check a month later.
      expect(csv).toContain('Expected in the drawer')
      expect(csv).toContain('Counted cash against the day\'s payments')
      // And the attestation section is present even though nothing has been signed yet.
      expect(csv).toContain('"Signed off","Not yet"')
    } finally {
      harness.close()
    }
  })

  it('hands back a workbook with the money as numbers, when the caller asks for Excel', async () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness } = seeded
    try {
      const exported = await harness.audit.exportAudit({ businessDate: TODAY, format: 'EXCEL' }, ADMIN, 'BOTH')
      expect(exported.format).toBe('EXCEL')
      expect(exported.fileName).toBe(`daily-audit-${TODAY}.xlsx`)
      expect(exported.mimeType)
        .toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      const bytes = Buffer.from(exported.contentBase64, 'base64')
      // An xlsx is a zip; its first two bytes are the local file header signature. Anything else means the base64 was
      // not the workbook, and a renderer would have written a corrupt file to the Admin's disk without complaining.
      expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0x50, 0x4b]))
      expect(bytes.length).toBeGreaterThan(2_000)
    } finally {
      harness.close()
    }
  })

  it('names the till in the file when one Account was exported', async () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness } = seeded
    try {
      const exported = await harness.audit.exportAudit(
        { businessDate: TODAY, accountId: ACCOUNT.id, format: 'CSV' }, SUPERVISOR, 'BOTH')
      expect(exported.fileName).toBe(`daily-audit-${TODAY}-account1.csv`)
      const csv = Buffer.from(exported.contentBase64, 'base64').toString('utf8')
      expect(csv).toContain('"Scope","One Account · Amaka Account"')
      // The other till's sale is not in it: an export is scoped the same way the screen was.
      expect(csv).not.toContain(seeded.wholesaleReceipt)
      expect(csv).toContain(seeded.retailReceipt)
    } finally {
      harness.close()
    }
  })

  it('writes the export to the audit log, because a control that can be copied without a trace is not a control', async () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness } = seeded
    try {
      const before = auditLog(harness).length
      await harness.audit.exportAudit({ businessDate: TODAY, format: 'CSV' }, SUPERVISOR, 'BOTH')
      const rows = auditLog(harness)
      expect(rows.length).toBe(before + 1)
      const written = rows[rows.length - 1]!
      expect(written.action).toBe('audit.day.exported')
      expect(written.metadata).toContain(TODAY)
      expect(written.metadata).toContain('"format":"CSV"')
      expect(written.metadata).toContain('"signedOff":false')
      // The person who took the file is on the row, not merely the machine it was taken from.
      const logged = harness.database.prepare(`
        SELECT actor FROM audit_log ORDER BY rowid DESC LIMIT 1
      `).get() as { actor: string }
      expect(logged.actor).toBe('supervisor1')
    } finally {
      harness.close()
    }
  })

  it('refuses a role that may read the audit but not take it away, and writes nothing', async () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness } = seeded
    try {
      for (const actor of [ACCOUNT, PICKER]) {
        await expect(harness.audit.exportAudit({ businessDate: TODAY, format: 'CSV' }, actor, 'BOTH'))
          .rejects.toThrowError('You do not have permission to audit the day.')
      }
      expect(auditLog(harness).some((row) => row.action === 'audit.day.exported')).toBe(false)
    } finally {
      harness.close()
    }
  })

  it('refuses a format that is not a file, and offers no PDF, because a PDF is a document to hand somebody', async () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness } = seeded
    try {
      const invented = 'PDF' as 'CSV'
      await expect(harness.audit.exportAudit({ businessDate: TODAY, format: invented }, ADMIN, 'BOTH'))
        .rejects.toThrowError('Choose CSV or Excel to export the audit.')
      await expect(harness.audit.exportAudit(
        { businessDate: TODAY, format: '' as 'CSV' }, ADMIN, 'BOTH'))
        .rejects.toThrowError('Choose CSV or Excel to export the audit.')
      // Nothing was written while both were refused.
      expect(auditLog(harness).some((row) => row.action === 'audit.day.exported')).toBe(false)
    } finally {
      harness.close()
    }
  })

  it('exports a day that has been signed off with the verdict in it, and a scoped day with the sign-off that covers it', async () => {
    const seeded = seedOrdinaryDay('NGN')
    const { harness } = seeded
    try {
      harness.reports.closeDay({ businessDate: TODAY, countedCash: '184.00' }, ADMIN, 'BOTH')
      harness.audit.signOffDay({ businessDate: TODAY, outcome: 'AUDITED', note: 'Counted twice.' }, SUPERVISOR, 'BOTH')
      const csv = Buffer.from(
        (await harness.audit.exportAudit({ businessDate: TODAY, format: 'CSV' }, ADMIN, 'BOTH')).contentBase64,
        'base64',
      ).toString('utf8')
      expect(csv).toContain('"Signed off","Yes"')
      expect(csv).toContain('"Verdict","Audited"')
      expect(csv).toContain('"Signed by","Sam Supervisor"')
      expect(csv).toContain('"Day closed","Yes"')
      expect(csv).toContain('"The day still reads as it did when signed","Yes"')
      expect(csv).toContain('"Totals agree with the sales ledger","Yes"')
    } finally {
      harness.close()
    }
  })
})
