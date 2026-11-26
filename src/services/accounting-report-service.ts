import { randomUUID } from 'node:crypto'
import { can } from '../../packages/core/src/capabilities'
import { resolveRole } from '../../packages/core/src/roles'
import type Database from 'better-sqlite3'
import { parseMoneyExact } from '../currency/parse'
import { formatMoney, roundHalfUp } from '../currency/money'
import type { Edition } from '../editions'
import type {
  AccountingReport,
  AdminReportData,
  AuditLogReportRow,
  CashDrawerEventInput,
  CashPositionSummary,
  CashierShiftReportRow,
  CloseCashierShiftInput,
  CloseDayInput,
  DailyAccountingSummary,
  DayCloseRecord,
  DebtorReportRow,
  DepartmentSalesReportRow,
  InventoryValuationReport,
  InventoryValuationRow,
  LowStockReportRow,
  OpenCashierShiftInput,
  PharmacyExpiryReportRow,
  PharmacyPrescriptionReportRow,
  PharmacyWriteOffReportRow,
  PaymentMethodSummary,
  PromotionSalesReportRow,
  PurchasesReportRow,
  RefundMethodSummary,
  ReportActor,
  RecordDebtorPaymentInput,
  ReportExportInput,
  ReportPeriod,
  ReportPeriodInput,
  ReportSectionId,
  SalesSplit,
  StocktakeReportRow,
  SupplierPurchaseSummary,
  SupermarketLoyaltyReport,
  UserPerformanceReportRow,
  UserSalesSummary,
  ProductSalesReportRow,
} from '../shared/reports/types'
import type { ShopRepository } from './contracts/shop-repository'
import type { AuditDebtorPaymentRow } from '../shared/audit/types'
import { drawerAdjustmentSigned, expectedDrawerCash, isDrawerEventType } from './cash-drawer'
import {
  createReportPdf,
  createReportWorkbookBase64,
  createReportCsv,
} from './report-export'

const MAX_SQLITE_INTEGER = 9_223_372_036_854_775_807n
const EXPIRY_REPORT_DAYS = 90
const ADMIN_REPORT_LIMIT = 500

export interface AccountingReportServiceOptions {
  now?: () => number
  newId?: () => string
}

interface NormalizedPeriod {
  type: ReportPeriod
  startDate: string
  endDate: string
  endExclusive: string
  label: string
  days: string[]
}

interface SaleRow {
  id: number
  cashier_id: string | null
  cashier_name_snapshot: string
  sale_type: 'RETAIL' | 'WHOLESALE'
  subtotal_text: string
  discount_text: string
  total_text: string
  business_date: string
}

interface ReturnRow {
  id: number
  cashier_id: string | null
  cashier_name_snapshot: string
  return_type: string
  total_text: string
  business_date: string
}

interface MutableDay {
  date: string
  totalSalesMinor: bigint
  transactions: number
  retailSalesMinor: bigint
  retailTransactions: number
  wholesaleSalesMinor: bigint
  wholesaleTransactions: number
  discountsMinor: bigint
  returnsMinor: bigint
  refundsMinor: bigint
  cogsMinor: bigint
}

interface MutableUser {
  userId: string | null
  userName: string
  username: string
  transactions: number
  retailSalesMinor: bigint
  wholesaleSalesMinor: bigint
  discountsMinor: bigint
  returnsMinor: bigint
  returnsProcessed: number
  cogsMinor: bigint
}

interface ShiftMoney {
  cashSalesMinor: bigint
  cashRefundsMinor: bigint
  drawerAdjustmentsMinor: bigint
  debtorCashMinor: bigint
  expectedCashMinor: bigint
}

interface ProductSaleAccumulator {
  productId: string | null
  sku: string
  productName: string
  unit: string
  quantitySoldMilli: bigint
  salesMinor: bigint
  saleIds: Set<number>
  genericName: string
}

interface InventoryRow {
  productId: string
  sku: string
  productName: string
  unit: string
  quantityMilli: bigint
  reservedMilli: bigint
  reorderLevelMilli: bigint
  costPerUnitMinor: bigint
}

export class AccountingReportService {
  private readonly now: () => number
  private readonly newId: () => string

  constructor(
    private readonly database: Database.Database,
    private readonly shop: ShopRepository,
    options: AccountingReportServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.newId = options.newId ?? randomUUID
  }

  getDashboard(input: ReportPeriodInput, actor: ReportActor, edition: Edition): AccountingReport {
    // Reading the day's accounts is the one place authority matters. The shift and drawer methods below call
    // `validateActor` only, because an ACCOUNT counting its own drawer is not reading a report.
    requireReportViewer(actor)
    validateEdition(edition)
    const period = normalizePeriod(input, this.now())
    const settings = this.shop.readSettings()
    const isAdmin = actor.role === 'ADMIN'
    const dailyMap = new Map(period.days.map((day) => [day, emptyDay(day)]))
    const userMap = new Map<string, MutableUser>()
    let grossSalesMinor = 0n
    let totalSalesMinor = 0n
    let transactions = 0
    let retailTotalMinor = 0n
    let retailTransactions = 0
    let wholesaleTotalMinor = 0n
    let wholesaleTransactions = 0
    let discountsMinor = 0n

    const sales = this.database.prepare(`
      SELECT s.id, s.cashier_id, s.cashier_name_snapshot, s.sale_type,
        CAST(s.subtotal AS TEXT) AS subtotal_text, CAST(s.discount AS TEXT) AS discount_text,
        CAST(s.total AS TEXT) AS total_text, date(s.created_at, 'localtime') AS business_date
      FROM sales s
      WHERE s.status = 'COMPLETED' AND s.currency_code = ?
        AND date(s.created_at, 'localtime') >= ? AND date(s.created_at, 'localtime') < ?
        AND (? = 1 OR s.cashier_id = ?)
      ORDER BY s.created_at, s.id
    `).all(settings.currency.code, period.startDate, period.endExclusive, isAdmin ? 1 : 0, actor.id) as SaleRow[]

    for (const sale of sales) {
      const gross = BigInt(sale.subtotal_text)
      const discount = BigInt(sale.discount_text)
      const total = BigInt(sale.total_text)
      const day = dailyMap.get(sale.business_date)
      if (day) {
        day.totalSalesMinor += total
        day.transactions += 1
        day.discountsMinor += discount
        if (sale.sale_type === 'WHOLESALE') {
          day.wholesaleSalesMinor += total
          day.wholesaleTransactions += 1
        } else {
          day.retailSalesMinor += total
          day.retailTransactions += 1
        }
      }
      grossSalesMinor += gross
      totalSalesMinor += total
      discountsMinor += discount
      transactions += 1
      if (sale.sale_type === 'WHOLESALE') {
        wholesaleTotalMinor += total
        wholesaleTransactions += 1
      } else {
        retailTotalMinor += total
        retailTransactions += 1
      }
      const user = this.getOrCreateUser(userMap, sale.cashier_id, sale.cashier_name_snapshot, actor)
      user.transactions += 1
      user.discountsMinor += discount
      if (sale.sale_type === 'WHOLESALE') user.wholesaleSalesMinor += total
      else user.retailSalesMinor += total
    }

    let returnsMinor = 0n
    let refundsMinor = 0n
    let returnTransactions = 0
    const returnsByUser = new Map<string, number>()
    const returns = this.database.prepare(`
      SELECT r.id, r.cashier_id, r.cashier_name_snapshot, r.return_type,
        CAST(r.total AS TEXT) AS total_text, date(r.created_at, 'localtime') AS business_date
      FROM returns r
      WHERE r.status = 'COMPLETED' AND r.currency_code = ?
        AND date(r.created_at, 'localtime') >= ? AND date(r.created_at, 'localtime') < ?
        AND (? = 1 OR r.cashier_id = ?)
      ORDER BY r.created_at, r.id
    `).all(settings.currency.code, period.startDate, period.endExclusive, isAdmin ? 1 : 0, actor.id) as ReturnRow[]

    for (const record of returns) {
      const amount = BigInt(record.total_text)
      const day = dailyMap.get(record.business_date)
      if (day) {
        day.returnsMinor += amount
        if (record.return_type === 'REFUND') day.refundsMinor += amount
      }
      returnsMinor += amount
      returnTransactions += 1
      if (record.return_type === 'REFUND') refundsMinor += amount
      if (record.cashier_id) {
        returnsByUser.set(record.cashier_id, (returnsByUser.get(record.cashier_id) ?? 0) + 1)
      }
      const user = this.getOrCreateUser(userMap, record.cashier_id, record.cashier_name_snapshot, actor)
      user.returnsMinor += amount
      user.returnsProcessed += 1
    }

    const paymentMethods = this.readPaymentMethods(period, settings.currency.code, isAdmin, actor.id)
    const refundMethods = this.readRefundMethods(period, settings.currency.code, isAdmin, actor.id)
    const cogsByActor = new Map<string, bigint>()
    let cogsMinor = 0n
    if (isAdmin) {
      const movementRows = this.database.prepare(`
        SELECT movement_type, created_by, CAST(quantity_delta_milli AS TEXT) AS quantity_text,
          CAST(unit_cost AS TEXT) AS cost_text, date(created_at, 'localtime') AS business_date
        FROM stock_movements
        WHERE movement_type IN ('SALE', 'RETURN') AND currency_code = ?
          AND ((movement_type = 'SALE' AND reference_type = 'SALE')
            OR (movement_type = 'RETURN' AND reference_type = 'RETURN'))
          AND date(created_at, 'localtime') >= ? AND date(created_at, 'localtime') < ?
        ORDER BY created_at, id
      `).all(settings.currency.code, period.startDate, period.endExclusive) as Array<{
        movement_type: 'SALE' | 'RETURN'
        created_by: string | null
        quantity_text: string
        cost_text: string
        business_date: string
      }>
      for (const row of movementRows) {
        const quantity = BigInt(row.quantity_text)
        const cost = BigInt(row.cost_text)
        const amount = roundHalfUp(cost * (quantity < 0n ? -quantity : quantity), 1_000n)
        const signed = row.movement_type === 'RETURN' ? -amount : amount
        cogsMinor += signed
        const day = dailyMap.get(row.business_date)
        if (day) day.cogsMinor += signed
        if (row.created_by) cogsByActor.set(row.created_by, (cogsByActor.get(row.created_by) ?? 0n) + signed)
      }
    } else {
      const ownCogsRows = this.database.prepare(`
        SELECT movement_type, CAST(quantity_delta_milli AS TEXT) AS quantity_text,
          CAST(unit_cost AS TEXT) AS cost_text, date(created_at, 'localtime') AS business_date
        FROM stock_movements
        WHERE movement_type IN ('SALE', 'RETURN') AND currency_code = ? AND created_by = ?
          AND ((movement_type = 'SALE' AND reference_type = 'SALE')
            OR (movement_type = 'RETURN' AND reference_type = 'RETURN'))
          AND date(created_at, 'localtime') >= ? AND date(created_at, 'localtime') < ?
        ORDER BY created_at, id
      `).all(settings.currency.code, actor.id, period.startDate, period.endExclusive) as Array<{
        movement_type: 'SALE' | 'RETURN'
        quantity_text: string
        cost_text: string
        business_date: string
      }>
      for (const row of ownCogsRows) {
        const quantity = BigInt(row.quantity_text)
        const cost = BigInt(row.cost_text)
        const amount = roundHalfUp(cost * (quantity < 0n ? -quantity : quantity), 1_000n)
        const signed = row.movement_type === 'RETURN' ? -amount : amount
        cogsMinor += signed
        const day = dailyMap.get(row.business_date)
        if (day) day.cogsMinor += signed
      }
    }

    for (const [userId, amount] of cogsByActor) {
      const user = this.getOrCreateUser(userMap, userId, '', actor)
      user.cogsMinor += amount
    }
    const cogsVisible = isAdmin ? cogsMinor : null
    const netSalesMinor = totalSalesMinor - returnsMinor
    const summary = {
      grossSalesMinor,
      totalSalesMinor,
      transactions,
      retail: { totalMinor: retailTotalMinor, transactions: retailTransactions } satisfies SalesSplit,
      wholesale: { totalMinor: wholesaleTotalMinor, transactions: wholesaleTransactions } satisfies SalesSplit,
      discountsMinor,
      returnsMinor,
      refundsMinor,
      netSalesMinor,
      cogsMinor: cogsVisible,
      grossProfitMinor: isAdmin ? netSalesMinor - cogsMinor : null,
      returnTransactions,
    }

    const salesByUser: UserSalesSummary[] = [...userMap.values()]
      .map((user) => {
        const userTotal = user.retailSalesMinor + user.wholesaleSalesMinor
        const userNet = userTotal - user.returnsMinor
        return {
          userId: user.userId,
          userName: user.userName,
          username: user.username,
          transactions: user.transactions,
          retailSalesMinor: user.retailSalesMinor,
          wholesaleSalesMinor: user.wholesaleSalesMinor,
          totalSalesMinor: userTotal,
          discountsMinor: user.discountsMinor,
          returnsMinor: user.returnsMinor,
          netSalesMinor: userNet,
          cogsMinor: isAdmin ? user.cogsMinor : null,
          grossProfitMinor: isAdmin ? userNet - user.cogsMinor : null,
        }
      })
      .sort((left, right) => left.totalSalesMinor === right.totalSalesMinor
        ? left.userName.localeCompare(right.userName)
        : left.totalSalesMinor > right.totalSalesMinor ? -1 : 1)

    const daily: DailyAccountingSummary[] = period.days.map((date) => {
      const day = dailyMap.get(date)!
      const net = day.totalSalesMinor - day.returnsMinor
      return {
        date,
        totalSalesMinor: day.totalSalesMinor,
        transactions: day.transactions,
        retailSalesMinor: day.retailSalesMinor,
        retailTransactions: day.retailTransactions,
        wholesaleSalesMinor: day.wholesaleSalesMinor,
        wholesaleTransactions: day.wholesaleTransactions,
        discountsMinor: day.discountsMinor,
        returnsMinor: day.returnsMinor,
        refundsMinor: day.refundsMinor,
        netSalesMinor: net,
        cogsMinor: isAdmin ? day.cogsMinor : null,
        grossProfitMinor: isAdmin ? net - day.cogsMinor : null,
      }
    })

    const shifts = supportsSupermarket(edition)
      ? this.readShifts(period, settings.currency.code, actor)
      : []
    const cashPosition = period.type === 'DAY'
      ? this.getCashPosition(period.startDate, settings.currency.code, actor)
      : null
    const dayClose = isAdmin && period.type === 'DAY'
      ? this.readDayClose(period.startDate, settings.currency.code)
      : null
    const adminReports = isAdmin
      ? this.getAdminReports(period, settings.currency.code, edition, salesByUser, returnsByUser)
      : null

    return {
      header: {
        storeName: settings.profile.name,
        storeAddress: settings.profile.address,
        currency: settings.currency,
        display: settings.display,
        period: {
          type: period.type,
          startDate: period.startDate,
          endDate: period.endDate,
          label: period.label,
        },
        generatedAt: new Date(this.now()).toISOString(),
        scope: isAdmin ? 'STORE' : 'PERSONAL',
        viewerName: actor.fullName?.trim() || actor.username,
        edition,
      },
      summary,
      daily,
      paymentMethods,
      refundMethods,
      salesByUser,
      cashPosition,
      dayClose,
      shifts,
      // Read for every caller, not only an Admin: a balance carries no cost, and the role that settles one is the
      // ACCOUNT. Building it inside `getAdminReports` would have left the capability with nothing to act on.
      debtors: this.readDebtors(),
      adminReports,
    }
  }

  /**
   * Outstanding customer balances, largest first.
   *
   * The same list the Admin's Debtors section has always shown, now read once for whoever asked. It carries a name, a
   * phone number, a balance and a credit limit - no cost, no margin, nothing about what the shop paid for the goods - so
   * there is nothing in it that a personal view has to withhold.
   */
  private readDebtors(): { totalBalanceMinor: bigint; items: DebtorReportRow[] } {
    const items = (this.database.prepare(`
      SELECT id, name, phone, CAST(balance AS TEXT) AS balance_text, CAST(credit_limit AS TEXT) AS limit_text
      FROM customers WHERE is_active = 1 AND balance > 0 ORDER BY balance DESC, name COLLATE NOCASE LIMIT ?
    `).all(ADMIN_REPORT_LIMIT) as Array<{
      id: string; name: string; phone: string; balance_text: string; limit_text: string
    }>).map((row): DebtorReportRow => ({
      customerId: row.id,
      customerName: row.name,
      phone: row.phone,
      balanceMinor: BigInt(row.balance_text),
      creditLimitMinor: BigInt(row.limit_text),
    }))
    return { totalBalanceMinor: items.reduce((sum, row) => sum + row.balanceMinor, 0n), items }
  }

  closeDay(input: CloseDayInput, actor: ReportActor, edition: Edition): DayCloseRecord {
    validateActor(actor)
    validateEdition(edition)
    requireAdmin(actor)
    const businessDate = normalizeBusinessDate(input?.businessDate)
    if (businessDate > localDateString(this.now())) throw new Error('A cash close cannot be saved for a future business date.')
    const settings = this.shop.readSettings()
    const counted = parseMoney(input?.countedCash, settings.currency, settings.display, 'Counted cash')
    if (counted < 0n) throw new Error('Counted cash cannot be negative.')
    const note = optionalText(input?.note, 500)
    let closeId = 0
    const closedAt = new Date(this.now()).toISOString()

    this.database.transaction(() => {
      const existing = this.database.prepare(`
        SELECT id FROM day_closings WHERE business_date = ? AND currency_code = ?
      `).get(businessDate, settings.currency.code)
      if (existing) throw new Error('A cash close has already been saved for this business date.')
      const cash = this.getCashPosition(businessDate, settings.currency.code, actor)
      if (cash.expectedCashMinor < 0n) {
        throw new Error('Expected drawer cash is negative. Review refunds and drawer events before closing.')
      }
      assertSqliteInteger(counted, 'Counted cash')
      const variance = counted - cash.expectedCashMinor
      assertSqliteInteger(variance, 'Cash difference')
      const totals = this.readDaySalesAndReturns(businessDate, settings.currency.code)
      const openedAt = new Date(`${businessDate}T00:00:00`).toISOString()
      const result = this.database.prepare(`
        INSERT INTO day_closings (
          closed_by, opened_at, closed_at, currency_code, sales_total, returns_total, cash_total, note,
          business_date, expected_cash, counted_cash, variance, store_name_snapshot, store_address_snapshot
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(actor.id, openedAt, closedAt, settings.currency.code, totals.salesMinor, totals.returnsMinor,
        counted, note, businessDate, cash.expectedCashMinor, counted, variance,
        settings.profile.name, settings.profile.address)
      closeId = Number(result.lastInsertRowid)
      this.database.prepare(`
        INSERT INTO business_entries (
          id, kind, currency_code, amount_minor, store_name_snapshot, store_address_snapshot,
          store_phone_snapshot, created_at
        ) VALUES (?, 'day_close', ?, ?, ?, ?, ?, ?)
      `).run(this.newId(), settings.currency.code, counted, settings.profile.name,
        settings.profile.address, settings.profile.phone, closedAt)
      this.audit(actor, 'reports.day.closed', {
        closeId,
        businessDate,
        currencyCode: settings.currency.code,
        expectedCashMinor: cash.expectedCashMinor.toString(),
        countedCashMinor: counted.toString(),
        varianceMinor: variance.toString(),
        salesTotalMinor: totals.salesMinor.toString(),
        returnsTotalMinor: totals.returnsMinor.toString(),
      })
    }).immediate()
    return this.readDayClose(businessDate, settings.currency.code) ?? (() => { throw new Error(`Day close ${closeId} could not be read after saving.`) })()
  }

  openCashierShift(input: OpenCashierShiftInput, actor: ReportActor, edition: Edition): CashierShiftReportRow {
    validateActor(actor)
    validateEdition(edition)
    requireSupermarket(edition)
    const settings = this.shop.readSettings()
    const openingFloat = parseMoney(input?.openingFloat, settings.currency, settings.display, 'Opening float')
    if (openingFloat < 0n) throw new Error('Opening float cannot be negative.')
    assertSqliteInteger(openingFloat, 'Opening float')
    const openedAt = new Date(this.now()).toISOString()
    let shiftId = ''
    this.database.transaction(() => {
      const existing = this.database.prepare(`
        SELECT id FROM cashier_shifts WHERE cashier_id = ? AND currency_code = ? AND status = 'OPEN'
        ORDER BY opened_at DESC LIMIT 1
      `).get(actor.id, settings.currency.code) as { id: string } | undefined
      if (existing) throw new Error('You already have an open cashier shift. Close it before starting another.')
      shiftId = this.newId()
      this.database.prepare(`
        INSERT INTO cashier_shifts (id, cashier_id, currency_code, opened_at, opening_float, status)
        VALUES (?, ?, ?, ?, ?, 'OPEN')
      `).run(shiftId, actor.id, settings.currency.code, openedAt, openingFloat)
      this.audit(actor, 'cashier_shift.opened', {
        shiftId,
        currencyCode: settings.currency.code,
        openingFloatMinor: openingFloat.toString(),
      })
    }).immediate()
    const period = normalizePeriod({ period: 'DAY', date: localDateString(this.now()) }, this.now())
    const row = this.readShifts(period, settings.currency.code, actor).find((candidate) => candidate.id === shiftId)
    if (!row) throw new Error('The new cashier shift could not be read.')
    return row
  }

  closeCashierShift(input: CloseCashierShiftInput, actor: ReportActor, edition: Edition): CashierShiftReportRow {
    validateActor(actor)
    validateEdition(edition)
    requireSupermarket(edition)
    const shiftId = requiredText(input?.shiftId, 'Cashier shift', 120)
    const note = optionalText(input?.note, 500)
    const settings = this.shop.readSettings()
    const counted = parseMoney(input?.countedCash, settings.currency, settings.display, 'Counted cash')
    if (counted < 0n) throw new Error('Counted cash cannot be negative.')
    assertSqliteInteger(counted, 'Counted cash')
    const closedAt = new Date(this.now()).toISOString()

    this.database.transaction(() => {
      const shift = this.database.prepare(`
        SELECT id, cashier_id, currency_code, status FROM cashier_shifts WHERE id = ?
      `).get(shiftId) as { id: string; cashier_id: string; currency_code: string; status: string } | undefined
      if (!shift || shift.status !== 'OPEN') throw new Error('This cashier shift is no longer open.')
      if (shift.currency_code !== settings.currency.code) throw new Error('This cashier shift uses a different currency from the shop.')
      if (actor.role !== 'ADMIN' && shift.cashier_id !== actor.id) throw new Error('You can close only your own cashier shift.')
      const money = this.getShiftMoney(shiftId, shift.currency_code, BigInt(this.readOpeningFloat(shiftId)))
      if (money.expectedCashMinor < 0n) throw new Error('Expected drawer cash is negative. Record the correct paid-in amount before closing.')
      const variance = counted - money.expectedCashMinor
      assertSqliteInteger(variance, 'Cash difference')
      const result = this.database.prepare(`
        UPDATE cashier_shifts SET closed_at = ?, expected_cash = ?, counted_cash = ?, variance = ?,
          status = 'CLOSED', closed_by = ?, close_note = ?
        WHERE id = ? AND status = 'OPEN'
      `).run(closedAt, money.expectedCashMinor, counted, variance, actor.id, note, shiftId)
      if (result.changes !== 1) throw new Error('This cashier shift changed while it was being closed. Refresh and try again.')
      this.audit(actor, 'cashier_shift.closed', {
        shiftId,
        cashierId: shift.cashier_id,
        currencyCode: shift.currency_code,
        expectedCashMinor: money.expectedCashMinor.toString(),
        countedCashMinor: counted.toString(),
        varianceMinor: variance.toString(),
      })
    }).immediate()

    const period = normalizePeriod({ period: 'DAY', date: localDateString(this.now()) }, this.now())
    const row = this.readShifts(period, settings.currency.code, actor).find((candidate) => candidate.id === shiftId)
    if (!row) throw new Error('The closed cashier shift could not be read.')
    return row
  }

  recordCashDrawerEvent(input: CashDrawerEventInput, actor: ReportActor, edition: Edition): void {
    validateActor(actor)
    validateEdition(edition)
    requireSupermarket(edition)
    const shiftId = requiredText(input?.shiftId, 'Cashier shift', 120)
    const type = input?.type
    // The list lives in `cash-drawer`, which is also what decides which way each type moves the drawer. A type accepted
    // here but unknown there would be recorded and then counted as money in, silently.
    if (!isDrawerEventType(type)) {
      throw new Error('Choose a valid cash drawer event.')
    }
    const amount = parseMoney(input?.amount, this.shop.readSettings().currency, this.shop.readSettings().display, 'Drawer amount')
    if (amount <= 0n) throw new Error('Drawer event amount must be greater than zero.')
    assertSqliteInteger(amount, 'Drawer amount')
    const note = requiredText(input?.note, 'Drawer event note', 240)
    const settings = this.shop.readSettings()
    this.database.transaction(() => {
      const shift = this.database.prepare(`SELECT cashier_id, currency_code, status FROM cashier_shifts WHERE id = ?`)
        .get(shiftId) as { cashier_id: string; currency_code: string; status: string } | undefined
      if (!shift || shift.status !== 'OPEN') throw new Error('Drawer events can be recorded only on an open shift.')
      if (shift.currency_code !== settings.currency.code) throw new Error('This cashier shift uses a different currency from the shop.')
      if (actor.role !== 'ADMIN' && shift.cashier_id !== actor.id) throw new Error('You can record events only on your own cashier shift.')
      this.database.prepare(`
        INSERT INTO cash_drawer_events (id, shift_id, user_id, event_type, amount, currency_code, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(this.newId(), shiftId, actor.id, type, amount, settings.currency.code, note, new Date(this.now()).toISOString())
      this.audit(actor, 'cashier_shift.drawer_event', {
        shiftId,
        type,
        amountMinor: amount.toString(),
        currencyCode: settings.currency.code,
        note,
      })
    }).immediate()
  }

  /**
   * A customer settling what they owe.
   *
   * This is not a sale and it is not a return, which is why it has its own table: `payments` cannot hold it, because a
   * CHECK there forces every row to name either a sale or a return. Before migration 19 the capability
   * `record_debtor_payment` was granted to ACCOUNT and gated nothing at all, and the daily audit was asked to show
   * "credit sales and debtor payments" with nowhere to read the second half from.
   *
   * Two things about the money matter and both are enforced here rather than left to the caller:
   *
   * - The customer's balance moves in the same transaction, with optimistic locking, so a payment can never be recorded
   *   against a balance that has already been settled by somebody else at the other till.
   * - Cash taken this way is added to the drawer's expectation. A day close that ignored it would report an overage and
   *   blame an honest Account for money the shop collected.
   */
  recordDebtorPayment(
    input: RecordDebtorPaymentInput,
    actor: ReportActor,
    edition: Edition,
  ): AuditDebtorPaymentRow {
    validateActor(actor)
    validateEdition(edition)
    // The capability the role table has carried since it was written. Read from the table rather than from a list of
    // role names here, so a role the Admin grants it to later is not refused by this line.
    if (!can(aliasOf(actor.role), 'record_debtor_payment')) {
      throw new Error('You do not have permission to take a payment against a customer balance.')
    }
    const settings = this.shop.readSettings()
    const customerId = requiredText(input?.customerId, 'Customer', 120)
    const amount = parseMoney(input?.amount, settings.currency, settings.display, 'Payment')
    if (amount <= 0n) throw new Error('A payment must be more than zero.')
    assertSqliteInteger(amount, 'Payment')
    const method = input?.method
    if (method !== 'CASH' && method !== 'TRANSFER' && method !== 'CARD') {
      throw new Error('Choose how the customer paid.')
    }
    const reference = optionalText(input?.reference, 120)
    const note = optionalText(input?.note, 500)
    const businessDate = localDateString(this.now())
    const recordedAt = new Date(this.now()).toISOString()
    let paymentNumber = ''

    this.database.transaction(() => {
      const customer = this.database.prepare(`
        SELECT name, CAST(balance AS TEXT) AS balance_text, row_version FROM customers WHERE id = ?
      `).get(customerId) as { name: string; balance_text: string; row_version: number } | undefined
      if (!customer) throw new Error('That customer no longer exists.')
      const balanceBefore = BigInt(customer.balance_text)
      if (balanceBefore <= 0n) throw new Error(`${customer.name} owes nothing, so there is no payment to take.`)
      if (amount > balanceBefore) {
        throw new Error(
          `${customer.name} owes ${formatMoney(balanceBefore, settings.currency, settings.display)}. `
          + 'Taking more than that would leave them in credit, which this product does not do.',
        )
      }
      // Optimistic locking, as everywhere else money moves: if the balance is not what this till was shown, somebody
      // else has taken a payment in the meantime and this one must not go through on top of it.
      const updated = this.database.prepare(`
        UPDATE customers SET balance = balance - ?, row_version = row_version + 1, updated_at = ?
        WHERE id = ? AND row_version = ?
      `).run(amount, recordedAt, customerId, customer.row_version)
      if (updated.changes !== 1) {
        throw new Error('This customer balance changed while the payment was being taken. Refresh and try again.')
      }
      // The shift the money went into, found the same way the till finds it for a sale: this cashier's open shift.
      const openShift = this.database.prepare(`
        SELECT id FROM cashier_shifts
        WHERE cashier_id = ? AND currency_code = ? AND status = 'OPEN'
        ORDER BY opened_at DESC LIMIT 1
      `).get(actor.id, settings.currency.code) as { id: string } | undefined
      paymentNumber = this.nextDebtorPaymentNumber(recordedAt)
      this.database.prepare(`
        INSERT INTO debtor_payments (
          id, payment_number, customer_id, received_by, payment_method, amount, currency_code,
          balance_before, balance_after, reference, note, business_date, shift_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(this.newId(), paymentNumber, customerId, actor.id, method, amount, settings.currency.code,
        balanceBefore, balanceBefore - amount, reference, note, businessDate, openShift?.id ?? null, recordedAt)
      this.audit(actor, 'debtor.payment.recorded', {
        paymentNumber,
        customerId,
        customerName: customer.name,
        paymentMethod: method,
        amountMinor: amount.toString(),
        currencyCode: settings.currency.code,
        balanceBeforeMinor: balanceBefore.toString(),
        balanceAfterMinor: (balanceBefore - amount).toString(),
        businessDate,
        shiftId: openShift?.id ?? null,
      })
    }).immediate()

    const row = this.database.prepare(`
      SELECT dp.payment_number, dp.payment_method, dp.reference, dp.created_at,
        COALESCE(c.name, '') AS customer_name,
        COALESCE(NULLIF(u.full_name, ''), u.username, '') AS received_by_name,
        CAST(dp.amount AS TEXT) AS amount_text,
        CAST(dp.balance_before AS TEXT) AS before_text,
        CAST(dp.balance_after AS TEXT) AS after_text
      FROM debtor_payments dp
        LEFT JOIN customers c ON c.id = dp.customer_id
        LEFT JOIN users u ON u.id = dp.received_by
      WHERE dp.payment_number = ?
    `).get(paymentNumber) as {
      payment_number: string; payment_method: AuditDebtorPaymentRow['paymentMethod']; reference: string
      created_at: string; customer_name: string; received_by_name: string; amount_text: string
      before_text: string; after_text: string
    } | undefined
    if (!row) throw new Error('The payment could not be read back after saving.')
    return {
      paymentNumber: row.payment_number,
      customerName: row.customer_name,
      receivedByName: row.received_by_name,
      paymentMethod: row.payment_method,
      amountMinor: BigInt(row.amount_text),
      balanceBeforeMinor: BigInt(row.before_text),
      balanceAfterMinor: BigInt(row.after_text),
      reference: row.reference,
      at: row.created_at,
    }
  }

  /** Numbered from the one allocator migration 16 built, never from MAX() over the table it numbers. */
  private nextDebtorPaymentNumber(recordedAt: string): string {
    this.database.prepare(`
      UPDATE document_sequences SET last_value = last_value + 1, updated_at = ? WHERE kind = 'DEBTOR_PAYMENT'
    `).run(recordedAt)
    const row = this.database.prepare(
      `SELECT last_value FROM document_sequences WHERE kind = 'DEBTOR_PAYMENT'`,
    ).get() as { last_value: number } | undefined
    if (!row) throw new Error('The debtor-payment sequence is missing. Ask the Admin to check the database.')
    return `DP-${String(row.last_value).padStart(8, '0')}`
  }

  exportCsv(input: ReportExportInput, actor: ReportActor, edition: Edition): string {
    const { section, ...periodInput } = input
    const report = this.getDashboard(periodInput, actor, edition)
    return createReportCsv(report, section)
  }

  async exportExcel(input: ReportExportInput, actor: ReportActor, edition: Edition): Promise<string> {
    const { section, ...periodInput } = input
    const report = this.getDashboard(periodInput, actor, edition)
    return createReportWorkbookBase64(report, section)
  }

  async exportPdf(input: ReportExportInput, actor: ReportActor, edition: Edition): Promise<Uint8Array> {
    const { section, ...periodInput } = input
    const report = this.getDashboard(periodInput, actor, edition)
    return createReportPdf(report, section)
  }

  private getAdminReports(
    period: NormalizedPeriod,
    currencyCode: string,
    edition: Edition,
    salesByUser: UserSalesSummary[],
    returnsByUser: Map<string, number>,
  ): AdminReportData {
    const inventoryRows = this.readInventoryRows()
    const inventorySales = this.readProductSales(period, currencyCode)
    const topSellers = [...inventorySales.values()]
      .map(toProductSalesRow)
      .sort((left, right) => left.quantitySoldMilli === right.quantitySoldMilli
        ? left.salesMinor > right.salesMinor ? -1 : left.salesMinor < right.salesMinor ? 1 : 0
        : left.quantitySoldMilli > right.quantitySoldMilli ? -1 : 1)
      .slice(0, 25)
    const slowMovers = inventoryRows
      .filter((row) => row.quantityMilli > 0n)
      .map((row) => {
        const sales = inventorySales.get(row.productId)
        return {
          productId: row.productId,
          sku: row.sku,
          productName: row.productName,
          unit: row.unit,
          quantitySoldMilli: sales?.quantitySoldMilli ?? 0n,
          salesMinor: sales?.salesMinor ?? 0n,
          transactions: sales?.saleIds.size ?? 0,
          onHandQuantityMilli: row.quantityMilli,
        }
      })
      .sort((left, right) => left.quantitySoldMilli === right.quantitySoldMilli
        ? left.productName.localeCompare(right.productName)
        : left.quantitySoldMilli < right.quantitySoldMilli ? -1 : 1)
      .slice(0, 25)

    const valuationItems = this.readValuation(inventoryRows)
    const valuation: InventoryValuationReport = {
      totalQuantityMilli: valuationItems.reduce((sum, row) => sum + row.quantityMilli, 0n),
      totalValueMinor: valuationItems.reduce((sum, row) => sum + row.valueMinor, 0n),
      items: valuationItems,
    }
    const lowStock: LowStockReportRow[] = inventoryRows
      .filter((row) => row.quantityMilli <= row.reorderLevelMilli)
      .map((row) => ({
        productId: row.productId,
        sku: row.sku,
        productName: row.productName,
        unit: row.unit,
        quantityMilli: row.quantityMilli,
        reservedMilli: row.reservedMilli,
        reorderLevelMilli: row.reorderLevelMilli,
      }))
      .sort((left, right) => left.quantityMilli === right.quantityMilli
        ? left.productName.localeCompare(right.productName)
        : left.quantityMilli < right.quantityMilli ? -1 : 1)

    const purchases = this.readPurchases(period, currencyCode)
    const purchaseBySupplier = new Map<string, SupplierPurchaseSummary>()
    for (const purchase of purchases) {
      const supplier = purchase.supplierName || 'Unspecified supplier'
      const record = purchaseBySupplier.get(supplier) ?? { supplierName: supplier, transactions: 0, totalMinor: 0n }
      record.transactions += 1
      record.totalMinor += purchase.totalMinor
      purchaseBySupplier.set(supplier, record)
    }
    const userPerformance: UserPerformanceReportRow[] = salesByUser.map((user) => ({
      ...user,
      returnsProcessed: user.userId ? returnsByUser.get(user.userId) ?? 0 : 0,
    }))
    const auditLog = this.readAuditLog(period)
    const stocktakes = this.readStocktakes(period)
    const pharmacy = supportsPharmacy(edition) ? this.readPharmacyReports(period, currencyCode) : null
    const supermarket = supportsSupermarket(edition) ? this.readSupermarketReports(period, currencyCode) : null

    return {
      topSellers,
      slowMovers,
      valuation,
      lowStock,
      purchases: {
        totalMinor: purchases.reduce((sum, row) => sum + row.totalMinor, 0n),
        transactions: purchases.length,
        items: purchases,
        bySupplier: [...purchaseBySupplier.values()].sort((left, right) => left.totalMinor > right.totalMinor ? -1 : 1),
      },
      userPerformance,
      auditLog,
      stocktakes,
      pharmacy,
      supermarket,
    }
  }

  private readPaymentMethods(period: NormalizedPeriod, currencyCode: string, isAdmin: boolean, actorId: string): PaymentMethodSummary[] {
    const methods = new Map<string, { totalMinor: bigint; saleIds: Set<number> }>()
    const rows = this.database.prepare(`
      SELECT p.payment_method, p.sale_id, CAST(p.amount AS TEXT) AS amount_text
      FROM payments p JOIN sales s ON s.id = p.sale_id
      WHERE s.status = 'COMPLETED' AND p.currency_code = ? AND s.currency_code = ?
        AND date(s.created_at, 'localtime') >= ? AND date(s.created_at, 'localtime') < ?
        AND (? = 1 OR s.cashier_id = ?)
      ORDER BY p.created_at, p.id
    `).all(currencyCode, currencyCode, period.startDate, period.endExclusive, isAdmin ? 1 : 0, actorId) as Array<{
      payment_method: string; sale_id: number; amount_text: string
    }>
    for (const row of rows) {
      const method = row.payment_method
      if (!['CASH', 'TRANSFER', 'CARD', 'CREDIT'].includes(method)) continue
      const current = methods.get(method) ?? { totalMinor: 0n, saleIds: new Set<number>() }
      current.totalMinor += BigInt(row.amount_text)
      current.saleIds.add(row.sale_id)
      methods.set(method, current)
    }
    return (['CASH', 'TRANSFER', 'CARD', 'CREDIT'] as const).map((method) => ({
      method,
      totalMinor: methods.get(method)?.totalMinor ?? 0n,
      transactions: methods.get(method)?.saleIds.size ?? 0,
    }))
  }

  private readRefundMethods(period: NormalizedPeriod, currencyCode: string, isAdmin: boolean, actorId: string): RefundMethodSummary[] {
    const methods = new Map<string, { totalMinor: bigint; returnIds: Set<number> }>()
    const rows = this.database.prepare(`
      SELECT p.payment_method, p.return_id, CAST(p.amount AS TEXT) AS amount_text
      FROM payments p JOIN returns r ON r.id = p.return_id
      WHERE r.status = 'COMPLETED' AND p.currency_code = ? AND r.currency_code = ?
        AND date(r.created_at, 'localtime') >= ? AND date(r.created_at, 'localtime') < ?
        AND (? = 1 OR r.cashier_id = ?)
      ORDER BY p.created_at, p.id
    `).all(currencyCode, currencyCode, period.startDate, period.endExclusive, isAdmin ? 1 : 0, actorId) as Array<{
      payment_method: string; return_id: number; amount_text: string
    }>
    const translate: Record<string, RefundMethodSummary['method']> = {
      REFUND_CASH: 'CASH',
      REFUND_TRANSFER: 'TRANSFER',
      REFUND_CARD: 'CARD',
      STORE_CREDIT: 'STORE_CREDIT',
      EXCHANGE_CREDIT: 'EXCHANGE_CREDIT',
    }
    for (const row of rows) {
      const method = translate[row.payment_method]
      if (!method) continue
      const current = methods.get(method) ?? { totalMinor: 0n, returnIds: new Set<number>() }
      current.totalMinor += BigInt(row.amount_text)
      current.returnIds.add(row.return_id)
      methods.set(method, current)
    }
    return (['CASH', 'TRANSFER', 'CARD', 'STORE_CREDIT', 'EXCHANGE_CREDIT'] as const).map((method) => ({
      method,
      totalMinor: methods.get(method)?.totalMinor ?? 0n,
      transactions: methods.get(method)?.returnIds.size ?? 0,
    }))
  }

  private readInventoryRows(): InventoryRow[] {
    return (this.database.prepare(`
      SELECT p.id AS product_id, p.sku, p.name, p.unit,
        CAST(COALESCE(s.quantity_milli, 0) AS TEXT) AS quantity_text,
        CAST(COALESCE(s.reserved_milli, 0) AS TEXT) AS reserved_text,
        CAST(p.reorder_level_milli AS TEXT) AS reorder_text,
        CAST(p.cost AS TEXT) AS cost_text
      FROM products p LEFT JOIN stock s ON s.product_id = p.id
      WHERE p.is_active = 1 ORDER BY p.name COLLATE NOCASE, p.id
    `).all() as Array<{
      product_id: string; sku: string; name: string; unit: string
      quantity_text: string; reserved_text: string; reorder_text: string; cost_text: string
    }>).map((row) => ({
      productId: row.product_id,
      sku: row.sku,
      productName: row.name,
      unit: row.unit,
      quantityMilli: BigInt(row.quantity_text),
      reservedMilli: BigInt(row.reserved_text),
      reorderLevelMilli: BigInt(row.reorder_text),
      costPerUnitMinor: BigInt(row.cost_text),
    }))
  }

  private readValuation(rows: InventoryRow[]): InventoryValuationRow[] {
    const batches = this.database.prepare(`
      SELECT product_id, CAST(quantity_milli AS TEXT) AS quantity_text, CAST(cost AS TEXT) AS cost_text
      FROM product_batches WHERE quantity_milli > 0 ORDER BY product_id, expiry_date, created_at, id
    `).all() as Array<{ product_id: string; quantity_text: string; cost_text: string }>
    const byProduct = new Map<string, Array<{ quantity: bigint; cost: bigint }>>()
    for (const batch of batches) {
      const list = byProduct.get(batch.product_id) ?? []
      list.push({ quantity: BigInt(batch.quantity_text), cost: BigInt(batch.cost_text) })
      byProduct.set(batch.product_id, list)
    }
    return rows.map((row) => {
      let remaining = row.quantityMilli
      let value = 0n
      for (const batch of byProduct.get(row.productId) ?? []) {
        if (remaining <= 0n) break
        const quantity = batch.quantity < remaining ? batch.quantity : remaining
        value += roundHalfUp(batch.cost * quantity, 1_000n)
        remaining -= quantity
      }
      if (remaining > 0n) value += roundHalfUp(row.costPerUnitMinor * remaining, 1_000n)
      return {
        productId: row.productId,
        sku: row.sku,
        productName: row.productName,
        unit: row.unit,
        quantityMilli: row.quantityMilli,
        reservedMilli: row.reservedMilli,
        costPerUnitMinor: row.costPerUnitMinor,
        valueMinor: value,
      }
    })
  }

  private readProductSales(period: NormalizedPeriod, currencyCode: string): Map<string, ProductSaleAccumulator> {
    const rows = this.database.prepare(`
      SELECT si.product_id, si.product_sku_snapshot AS sku, si.description_snapshot, si.unit_snapshot,
        si.generic_name_snapshot, CAST(si.quantity_milli AS TEXT) AS quantity_text,
        CAST(si.line_total AS TEXT) AS line_total_text, s.id AS sale_id
      FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE s.status = 'COMPLETED' AND s.currency_code = ?
        AND date(s.created_at, 'localtime') >= ? AND date(s.created_at, 'localtime') < ?
      ORDER BY s.created_at, si.id
    `).all(currencyCode, period.startDate, period.endExclusive) as Array<{
      product_id: string | null; sku: string; description_snapshot: string; unit_snapshot: string
      generic_name_snapshot: string; quantity_text: string; line_total_text: string; sale_id: number
    }>
    const totals = new Map<string, ProductSaleAccumulator>()
    for (const row of rows) {
      const key = row.product_id ?? `legacy:${row.sku}:${row.description_snapshot}`
      const item = totals.get(key) ?? {
        productId: row.product_id,
        sku: row.sku,
        productName: row.description_snapshot,
        unit: row.unit_snapshot,
        quantitySoldMilli: 0n,
        salesMinor: 0n,
        saleIds: new Set<number>(),
        genericName: row.generic_name_snapshot,
      }
      item.quantitySoldMilli += BigInt(row.quantity_text)
      item.salesMinor += BigInt(row.line_total_text)
      item.saleIds.add(row.sale_id)
      if (!item.genericName && row.generic_name_snapshot) item.genericName = row.generic_name_snapshot
      totals.set(key, item)
    }
    return totals
  }

  private readPurchases(period: NormalizedPeriod, currencyCode: string): PurchasesReportRow[] {
    return (this.database.prepare(`
      SELECT p.id, p.purchase_number, COALESCE(s.name, '') AS supplier_name,
        COALESCE(u.full_name, u.username, '') AS received_by, p.created_at,
        CAST(p.total AS TEXT) AS total_text, p.currency_code
      FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id
        LEFT JOIN users u ON u.id = p.received_by
      WHERE p.status = 'COMPLETED' AND p.currency_code = ?
        AND date(p.created_at, 'localtime') >= ? AND date(p.created_at, 'localtime') < ?
      ORDER BY p.created_at DESC, p.id DESC LIMIT ?
    `).all(currencyCode, period.startDate, period.endExclusive, ADMIN_REPORT_LIMIT) as Array<{
      id: number; purchase_number: string; supplier_name: string; received_by: string
      created_at: string; total_text: string; currency_code: string
    }>).map((row): PurchasesReportRow => ({
      purchaseId: row.id,
      purchaseNumber: row.purchase_number,
      supplierName: row.supplier_name,
      receivedBy: row.received_by,
      createdAt: row.created_at,
      totalMinor: BigInt(row.total_text),
      currencyCode: row.currency_code,
    }))
  }

  private readAuditLog(period: NormalizedPeriod): AuditLogReportRow[] {
    const rows = this.database.prepare(`
      SELECT actor, action, metadata_json, device_name, ip_address, created_at
      FROM audit_log
      WHERE date(created_at, 'localtime') >= ? AND date(created_at, 'localtime') < ?
      ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(period.startDate, period.endExclusive, ADMIN_REPORT_LIMIT) as Array<{
      actor: string; action: string; metadata_json: string; device_name: string; ip_address: string | null; created_at: string
    }>
    return rows.map((row): AuditLogReportRow => ({
      actor: row.actor,
      action: row.action,
      metadata: parseMetadata(row.metadata_json),
      deviceName: row.device_name,
      ipAddress: row.ip_address,
      createdAt: row.created_at,
    }))
  }

  private readStocktakes(period: NormalizedPeriod): StocktakeReportRow[] {
    const rows = this.database.prepare(`
      SELECT actor, metadata_json, device_name, created_at
      FROM audit_log
      WHERE action = 'inventory.stocktake.completed'
        AND date(created_at, 'localtime') >= ? AND date(created_at, 'localtime') < ?
      ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(period.startDate, period.endExclusive, ADMIN_REPORT_LIMIT) as Array<{
      actor: string; metadata_json: string; device_name: string; created_at: string
    }>
    const result: StocktakeReportRow[] = []
    for (const row of rows) {
      const data = parseMetadata(row.metadata_json)
      if (typeof data.productId !== 'string' || typeof data.sku !== 'string'
        || typeof data.expectedQuantityMilli !== 'string' || typeof data.countedQuantityMilli !== 'string'
        || typeof data.varianceMilli !== 'string' || typeof data.reason !== 'string') continue
      const product = this.database.prepare('SELECT name FROM products WHERE id = ?').get(data.productId) as { name: string } | undefined
      result.push({
        productId: data.productId,
        sku: data.sku,
        productName: product?.name ?? data.sku,
        expectedQuantityMilli: BigInt(data.expectedQuantityMilli),
        countedQuantityMilli: BigInt(data.countedQuantityMilli),
        varianceMilli: BigInt(data.varianceMilli),
        reason: data.reason,
        actor: row.actor,
        deviceName: row.device_name,
        createdAt: row.created_at,
      })
    }
    return result
  }

  private readPharmacyReports(period: NormalizedPeriod, currencyCode: string): NonNullable<AdminReportData['pharmacy']> {
    const today = localDateString(this.now())
    const expiryLimit = addDays(today, EXPIRY_REPORT_DAYS)
    const expiryRows = this.database.prepare(`
      SELECT p.id AS product_id, p.sku, p.name, p.unit, b.batch_no, b.expiry_date,
        CAST(b.quantity_milli AS TEXT) AS quantity_text, CAST(b.cost AS TEXT) AS cost_text
      FROM product_batches b JOIN products p ON p.id = b.product_id
      WHERE p.is_active = 1 AND b.quantity_milli > 0 AND b.expiry_date <= ?
      ORDER BY b.expiry_date, p.name COLLATE NOCASE, b.batch_no
    `).all(expiryLimit) as Array<{
      product_id: string; sku: string; name: string; unit: string; batch_no: string; expiry_date: string
      quantity_text: string; cost_text: string
    }>
    const expiryLots: PharmacyExpiryReportRow[] = expiryRows.map((row) => {
      const quantity = BigInt(row.quantity_text)
      const unitCost = BigInt(row.cost_text)
      return {
        productId: row.product_id,
        sku: row.sku,
        productName: row.name,
        batchNumber: row.batch_no,
        expiryDate: row.expiry_date,
        quantityMilli: quantity,
        unit: row.unit,
        unitCostMinor: unitCost,
        valueMinor: roundHalfUp(unitCost * quantity, 1_000n),
        state: row.expiry_date < today ? 'EXPIRED' : 'EXPIRING',
      }
    })
    const prescriptionRows = this.database.prepare(`
      SELECT si.product_id, si.product_sku_snapshot AS sku, si.description_snapshot, si.unit_snapshot,
        si.generic_name_snapshot, CAST(si.quantity_milli AS TEXT) AS quantity_text,
        CAST(si.line_total AS TEXT) AS line_total_text, s.id AS sale_id
      FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE si.prescription_required = 1 AND s.status = 'COMPLETED' AND s.currency_code = ?
        AND date(s.created_at, 'localtime') >= ? AND date(s.created_at, 'localtime') < ?
      ORDER BY s.created_at, si.id
    `).all(currencyCode, period.startDate, period.endExclusive) as Array<{
      product_id: string | null; sku: string; description_snapshot: string; unit_snapshot: string
      generic_name_snapshot: string; quantity_text: string; line_total_text: string; sale_id: number
    }>
    const prescription = new Map<string, ProductSaleAccumulator>()
    for (const row of prescriptionRows) {
      const key = row.product_id ?? `legacy:${row.sku}:${row.description_snapshot}`
      const item = prescription.get(key) ?? {
        productId: row.product_id,
        sku: row.sku,
        productName: row.description_snapshot,
        unit: row.unit_snapshot,
        quantitySoldMilli: 0n,
        salesMinor: 0n,
        saleIds: new Set<number>(),
        genericName: row.generic_name_snapshot,
      }
      item.quantitySoldMilli += BigInt(row.quantity_text)
      item.salesMinor += BigInt(row.line_total_text)
      item.saleIds.add(row.sale_id)
      prescription.set(key, item)
    }
    const prescriptionSales: PharmacyPrescriptionReportRow[] = [...prescription.values()]
      .map((row) => ({ ...toProductSalesRow(row), genericName: row.genericName }))
      .sort((left, right) => left.salesMinor > right.salesMinor ? -1 : 1)
    const writeOffRows = this.database.prepare(`
      SELECT COALESCE(NULLIF(ri.writeoff_reason, ''), ri.item_condition) AS reason,
        CAST(ri.quantity_milli AS TEXT) AS quantity_text, CAST(ri.line_total AS TEXT) AS amount_text
      FROM return_items ri JOIN returns r ON r.id = ri.return_id
      WHERE r.status = 'COMPLETED' AND r.currency_code = ? AND ri.stock_disposition = 'WRITTEN_OFF'
        AND date(r.created_at, 'localtime') >= ? AND date(r.created_at, 'localtime') < ?
      ORDER BY r.created_at, ri.id
    `).all(currencyCode, period.startDate, period.endExclusive) as Array<{
      reason: string; quantity_text: string; amount_text: string
    }>
    const writeOffsByReason = new Map<string, PharmacyWriteOffReportRow>()
    for (const row of writeOffRows) {
      const item = writeOffsByReason.get(row.reason) ?? { reason: row.reason, items: 0, quantityMilli: 0n, returnedValueMinor: 0n }
      item.items += 1
      item.quantityMilli += BigInt(row.quantity_text)
      item.returnedValueMinor += BigInt(row.amount_text)
      writeOffsByReason.set(row.reason, item)
    }
    return {
      expiryLots,
      prescriptionSales,
      writeOffs: [...writeOffsByReason.values()].sort((left, right) => right.returnedValueMinor > left.returnedValueMinor ? 1 : -1),
    }
  }

  private readSupermarketReports(period: NormalizedPeriod, currencyCode: string): NonNullable<AdminReportData['supermarket']> {
    const departmentRows = this.database.prepare(`
      SELECT COALESCE(NULLIF(si.department_snapshot, ''), 'Unassigned / historical') AS department,
        s.id AS sale_id, CAST(si.quantity_milli AS TEXT) AS quantity_text,
        CAST(si.line_total AS TEXT) AS total_text, CAST(si.discount AS TEXT) AS discount_text
      FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE s.status = 'COMPLETED' AND s.currency_code = ?
        AND date(s.created_at, 'localtime') >= ? AND date(s.created_at, 'localtime') < ?
      ORDER BY s.created_at, si.id
    `).all(currencyCode, period.startDate, period.endExclusive) as Array<{
      department: string; sale_id: number; quantity_text: string; total_text: string; discount_text: string
    }>
    const departments = new Map<string, DepartmentSalesReportRow & { saleIds: Set<number> }>()
    for (const row of departmentRows) {
      const item = departments.get(row.department) ?? {
        department: row.department, transactions: 0, quantitySoldMilli: 0n, salesMinor: 0n, discountsMinor: 0n,
        saleIds: new Set<number>(),
      }
      item.quantitySoldMilli += BigInt(row.quantity_text)
      item.salesMinor += BigInt(row.total_text)
      item.discountsMinor += BigInt(row.discount_text)
      item.saleIds.add(row.sale_id)
      departments.set(row.department, item)
    }
    const departmentSales = [...departments.values()].map(({ saleIds, ...row }) => ({ ...row, transactions: saleIds.size }))
      .sort((left, right) => left.salesMinor > right.salesMinor ? -1 : 1)

    const promotionRows = this.database.prepare(`
      SELECT promotion_name_snapshot, CAST(promotion_discount AS TEXT) AS discount_text,
        CAST(total AS TEXT) AS total_text, id
      FROM sales
      WHERE status = 'COMPLETED' AND currency_code = ? AND promotion_discount > 0
        AND date(created_at, 'localtime') >= ? AND date(created_at, 'localtime') < ?
      ORDER BY created_at, id
    `).all(currencyCode, period.startDate, period.endExclusive) as Array<{
      promotion_name_snapshot: string; discount_text: string; total_text: string; id: number
    }>
    const promotions = new Map<string, PromotionSalesReportRow & { saleIds: Set<number> }>()
    for (const row of promotionRows) {
      const name = row.promotion_name_snapshot || 'Promotion'
      const item = promotions.get(name) ?? { promotion: name, transactions: 0, discountsMinor: 0n, salesMinor: 0n, saleIds: new Set<number>() }
      item.discountsMinor += BigInt(row.discount_text)
      item.salesMinor += BigInt(row.total_text)
      item.saleIds.add(row.id)
      promotions.set(name, item)
    }
    const promotionSales = [...promotions.values()].map(({ saleIds, ...row }) => ({ ...row, transactions: saleIds.size }))
      .sort((left, right) => left.discountsMinor > right.discountsMinor ? -1 : 1)
    const loyaltyRows = this.database.prepare(`
      SELECT CAST(loyalty_points_redeemed AS TEXT) AS points_text, CAST(loyalty_discount AS TEXT) AS discount_text
      FROM sales WHERE status = 'COMPLETED' AND currency_code = ? AND loyalty_points_redeemed > 0
        AND date(created_at, 'localtime') >= ? AND date(created_at, 'localtime') < ?
    `).all(currencyCode, period.startDate, period.endExclusive) as Array<{
      points_text: string; discount_text: string
    }>
    const loyalty: SupermarketLoyaltyReport = {
      transactions: loyaltyRows.length,
      pointsRedeemed: loyaltyRows.reduce((sum, row) => sum + BigInt(row.points_text), 0n),
      discountsMinor: loyaltyRows.reduce((sum, row) => sum + BigInt(row.discount_text), 0n),
    }
    return { departments: departmentSales, promotions: promotionSales, loyalty }
  }

  /**
   * One business day's shifts, with their money worked out the same way the close works it out.
   *
   * This exists so the daily audit can show a Supervisor the over/short per shift without spelling the drawer sum out a
   * second time. A closed shift reports what was stored when it closed — that is the figure the count was compared
   * against and it must not move afterwards; an open shift reports what the drawer should hold so far, which is the only
   * honest answer to "how is this till doing" at four in the afternoon.
   */
  shiftRowsForDay(
    businessDate: string,
    currencyCode: string,
    accountId: string | null,
  ): CashierShiftReportRow[] {
    const rows = this.database.prepare(`
      SELECT sh.id, sh.cashier_id, sh.opened_at, sh.closed_at, sh.status, sh.currency_code,
        COALESCE(NULLIF(u.full_name, ''), u.username, 'Unknown cashier') AS cashier_name,
        COALESCE(NULLIF(c.full_name, ''), c.username, '') AS closed_by_name,
        COALESCE(sh.close_note, '') AS close_note,
        CAST(sh.opening_float AS TEXT) AS opening_float_text,
        CAST(sh.expected_cash AS TEXT) AS expected_cash_text,
        CAST(sh.counted_cash AS TEXT) AS counted_cash_text,
        CAST(sh.variance AS TEXT) AS variance_text
      FROM cashier_shifts sh
        JOIN users u ON u.id = sh.cashier_id
        LEFT JOIN users c ON c.id = sh.closed_by
      WHERE sh.currency_code = ? AND date(sh.opened_at, 'localtime') = ?
        AND (? IS NULL OR sh.cashier_id = ?)
      ORDER BY sh.opened_at, sh.id
    `).all(currencyCode, businessDate, accountId, accountId) as Array<{
      id: string; cashier_id: string; cashier_name: string; opened_at: string; closed_at: string | null
      status: 'OPEN' | 'CLOSED'; currency_code: string; opening_float_text: string
      expected_cash_text: string | null; counted_cash_text: string | null; variance_text: string | null
      closed_by_name: string; close_note: string
    }>
    return rows.map((row) => {
      const money = this.getShiftMoney(row.id, row.currency_code, BigInt(row.opening_float_text))
      return {
        id: row.id,
        cashierId: row.cashier_id,
        cashierName: row.cashier_name,
        openedAt: row.opened_at,
        closedAt: row.closed_at,
        status: row.status,
        currencyCode: row.currency_code,
        openingFloatMinor: BigInt(row.opening_float_text),
        cashSalesMinor: money.cashSalesMinor,
        cashRefundsMinor: money.cashRefundsMinor,
        drawerAdjustmentsMinor: money.drawerAdjustmentsMinor,
        debtorCashMinor: money.debtorCashMinor,
        expectedCashMinor: row.status === 'CLOSED' && row.expected_cash_text !== null
          ? BigInt(row.expected_cash_text)
          : money.expectedCashMinor,
        countedCashMinor: row.counted_cash_text === null ? null : BigInt(row.counted_cash_text),
        varianceMinor: row.variance_text === null ? null : BigInt(row.variance_text),
        closedBy: row.closed_by_name,
        closeNote: row.close_note,
      }
    })
  }

  private readShifts(period: NormalizedPeriod, currencyCode: string, actor: ReportActor): CashierShiftReportRow[] {
    const isAdmin = actor.role === 'ADMIN'
    const rows = this.database.prepare(`
      SELECT sh.id, sh.cashier_id, COALESCE(u.full_name, u.username, 'Unknown cashier') AS cashier_name,
        sh.opened_at, sh.closed_at, sh.status, sh.currency_code,
        CAST(sh.opening_float AS TEXT) AS opening_float_text,
        CAST(sh.expected_cash AS TEXT) AS expected_cash_text,
        CAST(sh.counted_cash AS TEXT) AS counted_cash_text,
        CAST(sh.variance AS TEXT) AS variance_text,
        COALESCE(c.full_name, c.username, '') AS closed_by_name, sh.close_note
      FROM cashier_shifts sh JOIN users u ON u.id = sh.cashier_id
        LEFT JOIN users c ON c.id = sh.closed_by
      WHERE sh.currency_code = ? AND (? = 1 OR sh.cashier_id = ?)
        AND (sh.status = 'OPEN'
          OR date(sh.opened_at, 'localtime') >= ? AND date(sh.opened_at, 'localtime') < ?
          OR sh.closed_at IS NOT NULL AND date(sh.closed_at, 'localtime') >= ? AND date(sh.closed_at, 'localtime') < ?)
      ORDER BY CASE WHEN sh.status = 'OPEN' THEN 0 ELSE 1 END, sh.opened_at DESC
      LIMIT ?
    `).all(currencyCode, isAdmin ? 1 : 0, actor.id, period.startDate, period.endExclusive,
      period.startDate, period.endExclusive, ADMIN_REPORT_LIMIT) as Array<{
      id: string; cashier_id: string; cashier_name: string; opened_at: string; closed_at: string | null
      status: 'OPEN' | 'CLOSED'; currency_code: string; opening_float_text: string
      expected_cash_text: string | null; counted_cash_text: string | null; variance_text: string | null
      closed_by_name: string; close_note: string
    }>
    return rows.map((row) => {
      const money = this.getShiftMoney(row.id, row.currency_code, BigInt(row.opening_float_text))
      const storedExpected = row.expected_cash_text === null ? null : BigInt(row.expected_cash_text)
      const counted = row.counted_cash_text === null ? null : BigInt(row.counted_cash_text)
      const variance = row.variance_text === null ? null : BigInt(row.variance_text)
      return {
        id: row.id,
        cashierId: row.cashier_id,
        cashierName: row.cashier_name,
        openedAt: row.opened_at,
        closedAt: row.closed_at,
        status: row.status,
        currencyCode: row.currency_code,
        openingFloatMinor: BigInt(row.opening_float_text),
        cashSalesMinor: money.cashSalesMinor,
        cashRefundsMinor: money.cashRefundsMinor,
        drawerAdjustmentsMinor: money.drawerAdjustmentsMinor,
        debtorCashMinor: money.debtorCashMinor,
        expectedCashMinor: row.status === 'CLOSED' && storedExpected !== null ? storedExpected : money.expectedCashMinor,
        countedCashMinor: counted,
        varianceMinor: variance,
        closedBy: row.closed_by_name,
        closeNote: row.close_note,
      }
    })
  }

  private getShiftMoney(shiftId: string, currencyCode: string, openingFloat: bigint): ShiftMoney {
    const paymentRows = this.database.prepare(`
      SELECT p.payment_method, CAST(p.amount AS TEXT) AS amount_text
      FROM payments p
        LEFT JOIN sales s ON s.id = p.sale_id
        LEFT JOIN returns r ON r.id = p.return_id
      WHERE p.currency_code = ? AND (
        (p.sale_id IS NOT NULL AND COALESCE(p.shift_id, s.shift_id) = ?)
        OR (p.return_id IS NOT NULL AND p.shift_id = ?)
      )
      ORDER BY p.created_at, p.id
    `).all(currencyCode, shiftId, shiftId) as Array<{ payment_method: string; amount_text: string }>
    let cashSalesMinor = 0n
    let cashRefundsMinor = 0n
    for (const row of paymentRows) {
      if (row.payment_method === 'CASH') cashSalesMinor += BigInt(row.amount_text)
      else if (row.payment_method === 'REFUND_CASH') cashRefundsMinor += BigInt(row.amount_text)
    }
    const drawerRows = this.database.prepare(`
      SELECT event_type, CAST(amount AS TEXT) AS amount_text
      FROM cash_drawer_events WHERE shift_id = ? AND currency_code = ? ORDER BY created_at, id
    `).all(shiftId, currencyCode) as Array<{ event_type: string; amount_text: string }>
    let drawerAdjustmentsMinor = 0n
    for (const row of drawerRows) {
      drawerAdjustmentsMinor += drawerAdjustmentSigned(row.event_type, BigInt(row.amount_text))
    }
    const debtorCashMinor = this.readDebtorCashForShift(shiftId, currencyCode)
    return {
      cashSalesMinor,
      cashRefundsMinor,
      drawerAdjustmentsMinor,
      debtorCashMinor,
      expectedCashMinor: expectedDrawerCash({
        openingFloatMinor: openingFloat,
        cashSalesMinor,
        cashRefundsMinor,
        drawerAdjustmentsMinor,
        debtorCashMinor,
      }),
    }
  }

  /**
   * Cash collected from customers settling an old credit balance during this shift.
   *
   * Migration 19 gives `debtor_payments` a `shift_id` for exactly this. Money taken for a debt is not a sale and appears
   * in no sales report, but it is in the drawer, and a shift closed without it would report an overage that the cashier
   * did not cause.
   */
  private readDebtorCashForShift(shiftId: string, currencyCode: string): bigint {
    const rows = this.database.prepare(`
      SELECT CAST(amount AS TEXT) AS amount_text FROM debtor_payments
      WHERE shift_id = ? AND currency_code = ? AND payment_method = 'CASH'
    `).all(shiftId, currencyCode) as Array<{ amount_text: string }>
    return rows.reduce((sum, row) => sum + BigInt(row.amount_text), 0n)
  }

  private readOpeningFloat(shiftId: string): string {
    const row = this.database.prepare('SELECT CAST(opening_float AS TEXT) AS amount FROM cashier_shifts WHERE id = ?')
      .get(shiftId) as { amount: string } | undefined
    if (!row) throw new Error('The cashier shift no longer exists.')
    return row.amount
  }

  private getCashPosition(businessDate: string, currencyCode: string, actor: ReportActor): CashPositionSummary {
    const isAdmin = actor.role === 'ADMIN'
    const openingRows = this.database.prepare(`
      SELECT CAST(opening_float AS TEXT) AS amount_text FROM cashier_shifts
      WHERE currency_code = ? AND date(opened_at, 'localtime') = ? AND (? = 1 OR cashier_id = ?)
    `).all(currencyCode, businessDate, isAdmin ? 1 : 0, actor.id) as Array<{ amount_text: string }>
    const openingFloatMinor = openingRows.reduce((sum, row) => sum + BigInt(row.amount_text), 0n)
    const salesRows = this.database.prepare(`
      SELECT CAST(p.amount AS TEXT) AS amount_text FROM payments p JOIN sales s ON s.id = p.sale_id
      WHERE p.currency_code = ? AND p.payment_method = 'CASH' AND s.status = 'COMPLETED'
        AND date(s.created_at, 'localtime') = ? AND (? = 1 OR s.cashier_id = ?)
    `).all(currencyCode, businessDate, isAdmin ? 1 : 0, actor.id) as Array<{ amount_text: string }>
    const cashSalesMinor = salesRows.reduce((sum, row) => sum + BigInt(row.amount_text), 0n)
    const refundRows = this.database.prepare(`
      SELECT CAST(p.amount AS TEXT) AS amount_text FROM payments p JOIN returns r ON r.id = p.return_id
      WHERE p.currency_code = ? AND p.payment_method = 'REFUND_CASH' AND r.status = 'COMPLETED'
        AND date(r.created_at, 'localtime') = ? AND (? = 1 OR r.cashier_id = ?)
    `).all(currencyCode, businessDate, isAdmin ? 1 : 0, actor.id) as Array<{ amount_text: string }>
    const cashRefundsMinor = refundRows.reduce((sum, row) => sum + BigInt(row.amount_text), 0n)
    const eventRows = this.database.prepare(`
      SELECT event_type, CAST(amount AS TEXT) AS amount_text FROM cash_drawer_events
      WHERE currency_code = ? AND date(created_at, 'localtime') = ? AND (? = 1 OR user_id = ?)
    `).all(currencyCode, businessDate, isAdmin ? 1 : 0, actor.id) as Array<{ event_type: string; amount_text: string }>
    const drawerAdjustmentsMinor = eventRows.reduce(
      (sum, row) => sum + drawerAdjustmentSigned(row.event_type, BigInt(row.amount_text)), 0n)
    // Cash collected against an old credit balance is in the drawer too. Without it the day close stores an expectation
    // the counted cash cannot match, and the difference is blamed on the Account.
    const debtorRows = this.database.prepare(`
      SELECT CAST(amount AS TEXT) AS amount_text FROM debtor_payments
      WHERE currency_code = ? AND payment_method = 'CASH' AND business_date = ? AND (? = 1 OR received_by = ?)
    `).all(currencyCode, businessDate, isAdmin ? 1 : 0, actor.id) as Array<{ amount_text: string }>
    const debtorCashMinor = debtorRows.reduce((sum, row) => sum + BigInt(row.amount_text), 0n)
    return {
      businessDate,
      currencyCode,
      openingFloatMinor,
      cashSalesMinor,
      cashRefundsMinor,
      drawerAdjustmentsMinor,
      debtorCashMinor,
      expectedCashMinor: expectedDrawerCash({
        openingFloatMinor,
        cashSalesMinor,
        cashRefundsMinor,
        drawerAdjustmentsMinor,
        debtorCashMinor,
      }),
    }
  }

  private readDaySalesAndReturns(businessDate: string, currencyCode: string): { salesMinor: bigint; returnsMinor: bigint } {
    const saleRows = this.database.prepare(`
      SELECT CAST(total AS TEXT) AS amount_text FROM sales
      WHERE status = 'COMPLETED' AND currency_code = ? AND date(created_at, 'localtime') = ?
    `).all(currencyCode, businessDate) as Array<{ amount_text: string }>
    const returnRows = this.database.prepare(`
      SELECT CAST(total AS TEXT) AS amount_text FROM returns
      WHERE status = 'COMPLETED' AND currency_code = ? AND date(created_at, 'localtime') = ?
    `).all(currencyCode, businessDate) as Array<{ amount_text: string }>
    return {
      salesMinor: saleRows.reduce((sum, row) => sum + BigInt(row.amount_text), 0n),
      returnsMinor: returnRows.reduce((sum, row) => sum + BigInt(row.amount_text), 0n),
    }
  }

  private readDayClose(businessDate: string, currencyCode: string): DayCloseRecord | null {
    const row = this.database.prepare(`
      SELECT d.id, d.closing_number, d.business_date, d.opened_at, d.closed_at,
        COALESCE(u.full_name, u.username, '') AS closed_by,
        d.currency_code, CAST(d.sales_total AS TEXT) AS sales_text,
        CAST(d.returns_total AS TEXT) AS returns_text,
        CAST(d.expected_cash AS TEXT) AS expected_text,
        CAST(d.counted_cash AS TEXT) AS counted_text,
        CAST(d.variance AS TEXT) AS variance_text,
        d.note, d.store_name_snapshot, d.store_address_snapshot
      FROM day_closings d LEFT JOIN users u ON u.id = d.closed_by
      WHERE d.business_date = ? AND d.currency_code = ? ORDER BY d.id DESC LIMIT 1
    `).get(businessDate, currencyCode) as {
      id: number; closing_number: string; business_date: string; opened_at: string; closed_at: string
      closed_by: string; currency_code: string; sales_text: string; returns_text: string
      expected_text: string; counted_text: string; variance_text: string; note: string
      store_name_snapshot: string; store_address_snapshot: string
    } | undefined
    if (!row) return null
    return {
      id: row.id,
      closeNumber: row.closing_number,
      businessDate: row.business_date,
      openedAt: row.opened_at,
      closedAt: row.closed_at,
      closedBy: row.closed_by,
      currencyCode: row.currency_code,
      salesTotalMinor: BigInt(row.sales_text),
      returnsTotalMinor: BigInt(row.returns_text),
      expectedCashMinor: BigInt(row.expected_text),
      countedCashMinor: BigInt(row.counted_text),
      varianceMinor: BigInt(row.variance_text),
      note: row.note,
      storeName: row.store_name_snapshot,
      storeAddress: row.store_address_snapshot,
    }
  }

  private getOrCreateUser(map: Map<string, MutableUser>, id: string | null, snapshotName: string, viewer: ReportActor): MutableUser {
    const key = id ?? '__unassigned__'
    const existing = map.get(key)
    if (existing) return existing
    const account = id
      ? this.database.prepare('SELECT username, full_name FROM users WHERE id = ?').get(id) as { username: string; full_name: string } | undefined
      : undefined
    const username = id === viewer.id ? viewer.username : account?.username ?? ''
    const userName = id === viewer.id
      ? viewer.fullName?.trim() || snapshotName || viewer.username
      : snapshotName || account?.full_name || account?.username || 'Unassigned'
    const result: MutableUser = {
      userId: id,
      userName,
      username,
      transactions: 0,
      retailSalesMinor: 0n,
      wholesaleSalesMinor: 0n,
      discountsMinor: 0n,
      returnsMinor: 0n,
      returnsProcessed: 0,
      cogsMinor: 0n,
    }
    map.set(key, result)
    return result
  }

  private audit(actor: ReportActor, action: string, metadata: Record<string, unknown>): void {
    this.database.prepare(`
      INSERT INTO audit_log (id, actor, action, metadata_json, device_name, ip_address, created_at)
      VALUES (?, ?, ?, ?, 'LOCAL', NULL, ?)
    `).run(this.newId(), actor.username, action, JSON.stringify(metadata), new Date(this.now()).toISOString())
  }
}

export function buildMobileAccountingSummary(report: AccountingReport) {
  return {
    header: {
      storeName: report.header.storeName,
      storeAddress: report.header.storeAddress,
      currency: report.header.currency,
      period: report.header.period,
      generatedAt: report.header.generatedAt,
    },
    summary: report.summary,
    daily: report.daily,
    paymentMethods: report.paymentMethods,
    refundMethods: report.refundMethods,
    // The phone's dashboard lists today's sales by cashier. The desktop already computes this for Admins
    // only, and this summary is only ever built from an Admin-scoped report.
    salesByUser: report.salesByUser ?? [],
  }
}

export function isReportSection(value: unknown): value is ReportSectionId {
  return typeof value === 'string' && [
    'summary', 'top-sellers', 'slow-movers', 'valuation', 'low-stock', 'debtors', 'purchases',
    'user-performance', 'audit-log', 'stocktake', 'pharmacy', 'supermarket',
  ].includes(value)
}

function emptyDay(date: string): MutableDay {
  return {
    date,
    totalSalesMinor: 0n,
    transactions: 0,
    retailSalesMinor: 0n,
    retailTransactions: 0,
    wholesaleSalesMinor: 0n,
    wholesaleTransactions: 0,
    discountsMinor: 0n,
    returnsMinor: 0n,
    refundsMinor: 0n,
    cogsMinor: 0n,
  }
}

function toProductSalesRow(row: ProductSaleAccumulator): ProductSalesReportRow {
  return {
    productId: row.productId,
    sku: row.sku,
    productName: row.productName,
    unit: row.unit,
    quantitySoldMilli: row.quantitySoldMilli,
    salesMinor: row.salesMinor,
    transactions: row.saleIds.size,
  }
}

function normalizePeriod(input: ReportPeriodInput, now: number): NormalizedPeriod {
  if (!input || (input.period !== 'DAY' && input.period !== 'MONTH') || typeof input.date !== 'string') {
    throw new Error('Choose a daily or monthly report period.')
  }
  let startDate: string
  let endExclusive: string
  if (input.period === 'DAY') {
    startDate = normalizeBusinessDate(input.date)
    endExclusive = addDays(startDate, 1)
  } else {
    if (!/^\d{4}-\d{2}$/u.test(input.date)) throw new Error('Choose a month using YYYY-MM.')
    const [year, month] = input.date.split('-').map(Number)
    if (month! < 1 || month! > 12 || year! < 1900 || year! > 9999) throw new Error('Choose a valid report month.')
    startDate = `${input.date}-01`
    endExclusive = month === 12 ? `${String(year! + 1).padStart(4, '0')}-01-01` : `${input.date.slice(0, 5)}${String(month! + 1).padStart(2, '0')}-01`
  }
  const endDate = addDays(endExclusive, -1)
  if (startDate > localDateString(now)) throw new Error('Reports cannot be requested for a future period.')
  const days: string[] = []
  for (let day = startDate; day < endExclusive; day = addDays(day, 1)) days.push(day)
  const label = input.period === 'DAY'
    ? startDate
    : new Date(`${startDate}T00:00:00Z`).toLocaleDateString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  return { type: input.period, startDate, endDate, endExclusive, label, days }
}

function normalizeBusinessDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error('Choose a business date using YYYY-MM-DD.')
  }
  const [year, month, day] = value.split('-').map(Number)
  if (year! < 1900 || year! > 9999 || month! < 1 || month! > 12 || day! < 1 || day! > 31) {
    throw new Error('Choose a valid business date.')
  }
  const check = new Date(0)
  check.setUTCHours(0, 0, 0, 0)
  check.setUTCFullYear(year!, month! - 1, day!)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month! - 1 || check.getUTCDate() !== day) {
    throw new Error('Choose a valid business date.')
  }
  return value
}

function addDays(value: string, amount: number): string {
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(0)
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCFullYear(year!, month! - 1, day! + amount)
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

function localDateString(timestamp: number): string {
  const date = new Date(timestamp)
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function parseMoney(value: unknown, currency: ReturnType<ShopRepository['readSettings']>['currency'], display: ReturnType<ShopRepository['readSettings']>['display'], label: string): bigint {
  if (typeof value !== 'string') throw new Error(`Enter ${label.toLowerCase()} using ${currency.code}.`)
  const amount = parseMoneyExact(value, currency, display)
  assertSqliteInteger(amount, label)
  return amount
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Enter a ${label.toLowerCase()}.`)
  const cleaned = value.trim()
  if (cleaned.length > maxLength) throw new Error(`${label} must be ${maxLength} characters or fewer.`)
  return cleaned
}

function optionalText(value: unknown, maxLength: number): string {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string') throw new Error('Enter a valid note.')
  const cleaned = value.trim()
  if (cleaned.length > maxLength) throw new Error(`Note must be ${maxLength} characters or fewer.`)
  return cleaned
}

function assertSqliteInteger(value: bigint, label: string): void {
  if (value > MAX_SQLITE_INTEGER || value < -MAX_SQLITE_INTEGER) throw new Error(`${label} exceeds the supported integer range.`)
}

/**
 * A real, identified person.
 *
 * This checks *identity*, not authority: it is used both by the report readers and by the shift and drawer methods that
 * an ACCOUNT calls for its own till. It previously hard-coded `['ADMIN', 'SUPERVISOR', 'CASHIER']`, which silently
 * excluded ACCOUNT — the role the brief makes the till role — from opening its own cashier shift. Reading the roles
 * from the table instead means a future role is not forgotten here.
 */
function validateActor(actor: ReportActor): void {
  if (!actor || typeof actor.id !== 'string' || !actor.id.trim()
    || typeof actor.username !== 'string' || !actor.username.trim()
    || resolveRole(actor.role) === null) {
    throw new Error('A valid signed-in report user is required.')
  }
}

/**
 * Authority to read the shop's accounts.
 *
 * Separate from `validateActor` on purpose. The brief gives reports to the Admin and to ACCOUNT and to nobody else, and
 * `view_reports` is the capability the policy row for the accounting report already uses — so this reads the same
 * answer rather than a second list. The shift methods do *not* call this: an ACCOUNT's own drawer is not a report.
 */
function requireReportViewer(actor: ReportActor): void {
  validateActor(actor)
  if (!can(aliasOf(actor.role), 'view_reports')) throw new Error('You do not have permission to view reports.')
}

/**
 * A legacy CASHIER row resolves to USER at every read, and a USER has no reports and no debtor payments.
 *
 * Through `resolveRole`, which is the product's one alias rule, rather than a second spelling of it here. The
 * `validateActor` check above accepts the alias for the same reason: refusing a shop's upgraded cashier rows as
 * "not a valid user" would lock out somebody the migration deliberately kept.
 */
function aliasOf(role: ReportActor['role']): 'ADMIN' | 'ACCOUNT' | 'USER' | 'SUPERVISOR' {
  const resolved = resolveRole(role)
  if (!resolved) throw new Error('A valid signed-in report user is required.')
  return resolved
}

function requireAdmin(actor: ReportActor): void {
  if (actor.role !== 'ADMIN') throw new Error('This report action is restricted to the Admin.')
}

function validateEdition(edition: Edition): void {
  if (!['PHARMACY', 'SUPERMARKET', 'BOTH'].includes(edition)) throw new Error('A valid licensed edition is required for reports.')
}

function requireSupermarket(edition: Edition): void {
  if (!supportsSupermarket(edition)) throw new Error('Cashier shifts and supermarket reports require a Supermarket license.')
}

function supportsPharmacy(edition: Edition): boolean {
  return edition === 'PHARMACY' || edition === 'BOTH'
}

function supportsSupermarket(edition: Edition): boolean {
  return edition === 'SUPERMARKET' || edition === 'BOTH'
}

function parseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}
