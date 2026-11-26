import { createHash, randomUUID } from 'node:crypto'
import { can } from '../../packages/core/src/capabilities'
import { resolveRole } from '../../packages/core/src/roles'
import type Database from 'better-sqlite3'
import { isEdition, isEditionEnabled, type Edition } from '../editions'
import type { ShopRepository } from './contracts/shop-repository'
import type { AccountingReportService } from './accounting-report-service'
import { drawerAdjustmentSigned, expectedDrawerCash } from './cash-drawer'
import { runAuditChecks, type OrderEditedAfterAttempt } from './audit-checks'
import { auditDigestKey } from './audit-digest'
import { createAuditCsv, createAuditWorkbookBase64 } from './audit-export'
import { resolveDiscountCap, shopDiscountLimit } from './discount-cap'
import type {
  AuditAccountOption,
  AuditActor,
  AuditExportInput,
  AuditExportResult,
  AuditCashTie,
  AuditCheckCode,
  AuditCreditSaleRow,
  AuditDayStatus,
  AuditDebtorPaymentRow,
  AuditDiscountRow,
  AuditFinding,
  AuditFlagRow,
  AuditFlagSeverity,
  AuditNoteFindingInput,
  AuditOrderRow,
  AuditOverrideRow,
  AuditPaymentMethodTotal,
  AuditReconciliation,
  AuditReprintRow,
  AuditReturnRow,
  AuditSaleRow,
  AuditSignOffOutcome,
  AuditSignOffRow,
  AuditSummaryForPhone,
  AuditTotals,
  AuditVoidRow,
  DailyAuditReport,
  DayAuditInput,
  RaiseAuditFlagInput,
  ResolveAuditFlagInput,
  SignOffDayInput,
  UnauditedDay,
} from '../shared/audit/types'
// The thresholds themselves moved to `audit-checks.ts` with the rules that use them; what is left here is the list of
// check codes, which this service still needs to validate a note against and to say which checks ran.
import { AUDIT_CHECK_CODES, DISCOUNT_NEAR_CAP_BASIS_POINTS } from '../shared/audit/types'
import type { CashierShiftReportRow, DayCloseRecord, ReportHeader } from '../shared/reports/types'

/**
 * The Supervisor's daily audit.
 *
 * The brief's sentence that governs this whole file is "READ-ONLY except for notes and sign-off". That is not a comment
 * about the user interface; it is the shape of the class. There is no method here that touches `sales`, `sale_items`,
 * `payments`, `returns`, `stock`, `products` or `settings`, and no method that could be given one: the two writes this
 * service performs are a row in `audit_flags` and a row in `audit_signoffs`, and migration 16 made sign-offs immutable
 * at the database level so that "the Supervisor signed this day" can never become "the Supervisor signed something
 * else".
 *
 * The second governing sentence is "totals reconcile to receipts to the last unit". Every figure below is therefore a
 * query over the ledger at the moment it is asked for. Nothing is stored, cached or carried over, and the reconciliation
 * is computed by summing the rows the screen is about to show and comparing that with an independent aggregate over the
 * same tables — a total compared with itself would prove nothing.
 */

/** How far back the dashboard, the Supervisor's home page and the phone look for unaudited days. */
export const AUDIT_LOOKBACK_DAYS = 30

const MAX_SQLITE_INTEGER = 9_223_372_036_854_775_807n
const FLAG_DETAIL_MAX = 1_000
const SIGN_OFF_NOTE_MAX = 2_000
const DAY_CLOSE_SUBJECT = 'DAY_CLOSE'

export interface DailyAuditServiceOptions {
  now?: () => number
  newId?: () => string
}

interface SaleLedgerRow {
  sale_id: number
  receipt_number: string
  status: string
  sale_type: string
  cashier_id: string | null
  cashier_name: string
  customer_name: string
  order_id: string | null
  subtotal_text: string
  discount_text: string
  total_text: string
  credit_text: string
  clock_time: string
  created_at: string
}

interface SaleItemLedgerRow {
  sale_id: number
  product_id: string | null
  product_name: string
  sku: string
  description_snapshot: string
  price_tier: string
  quantity_text: string
  unit_price_text: string
  discount_text: string
  manual_discount_text: string
  gross_text: string
  promotion_discount_text: string
  catalogue_price_text: string | null
}

/**
 * Raised when the audit surface is asked for something the actor's role does not allow.
 *
 * The message never names the role that *would* be allowed beyond what the caller already knows, for the same reason
 * the print gate keeps its refusals about the caller: an error string is read aloud in a shop, and "only the Admin can
 * do this" said to a Supervisor in front of a queue is an invitation to go and find one.
 */
export class AuditRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuditRefusedError'
  }
}

export class DailyAuditService {
  private readonly now: () => number
  private readonly newId: () => string

  constructor(
    private readonly database: Database.Database,
    private readonly shop: ShopRepository,
    /**
     * The accounting service, for the one figure this service must not compute for itself: what a shift's drawer should
     * have held. The day close is written by that service, and a Supervisor shown a different expectation from the one
     * the Account was measured against would be shown a difference that does not exist.
     */
    private readonly reports: AccountingReportService,
    options: DailyAuditServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.newId = options.newId ?? randomUUID
  }

  // ---------------------------------------------------------------- the day

  getDayAudit(input: DayAuditInput, actor: AuditActor, edition: Edition): DailyAuditReport {
    requireAuditor(actor)
    validateEdition(edition)
    const settings = this.shop.readSettings()
    const businessDate = normalizeBusinessDate(input?.businessDate)
    this.refuseFutureDate(businessDate)
    const accountId = this.normalizeAccount(input?.accountId)
    const currencyCode = settings.currency.code
    const scopeAll = accountId === null ? 1 : 0
    const scopeId = accountId ?? ''

    const sales = this.readSales(businessDate, currencyCode, scopeAll, scopeId)
    const items = this.readSaleItems(businessDate, currencyCode, scopeAll, scopeId)
    const payments = this.readPayments(businessDate, currencyCode, scopeAll, scopeId)
    const returns = this.readReturns(businessDate, currencyCode, scopeAll, scopeId)
    const refunds = this.readRefunds(businessDate, currencyCode, scopeAll, scopeId)
    const reprints = this.readReprints(businessDate, scopeAll, scopeId)
    const creditSales = this.readCreditSales(sales, payments)
    const debtorPayments = this.readDebtorPayments(businessDate, currencyCode, scopeAll, scopeId)
    const orders = this.readOrders(businessDate, currencyCode, scopeAll, scopeId)
    const overrides = this.findOverrides(sales, items)
    const discounts = this.findDiscounts(sales, items, settings)
    const voids = this.readVoids(businessDate, currencyCode, scopeAll, scopeId)
    const paymentMethods = this.summarizeMethods(payments, refunds)
    const dayClose = this.readDayClose(businessDate, currencyCode, scopeAll, scopeId)
    const shifts = isEditionEnabled(edition, 'supermarket')
      ? this.readShifts(businessDate, currencyCode, accountId)
      : []
    const cashTie = this.tieCash(businessDate, currencyCode, scopeAll, scopeId, dayClose, shifts, debtorPayments)
    const totals = this.summarize({
      sales, payments, returns, refunds, creditSales, debtorPayments, voids, overrides, reprints, orders,
    })
    const reconciliation = reconcileAuditTotals(
      { sales, payments, returns, refunds, discounts: totals.discountsMinor },
      this.readLedgerTotals(businessDate, currencyCode, scopeAll, scopeId),
    )
    const findings = this.runChecks({
      businessDate,
      currency: settings.currency,
      display: settings.display,
      sales,
      voids,
      discounts,
      reprints,
      cashTie,
      edition,
      accountId,
    })
    const flags = this.readFlags(businessDate, accountId)
    const signOffRow = this.readSignOff(businessDate, accountId)

    const report: DailyAuditReport = {
      header: this.header(settings, businessDate, actor, edition),
      businessDate,
      currencyCode,
      edition,
      account: accountId === null ? null : this.describeAccount(accountId),
      accounts: this.readAccountOptions(businessDate, currencyCode),
      totals,
      sales: sales.map((row) => this.saleRow(row, payments)),
      voids,
      overrides,
      discounts,
      reprints,
      returns,
      creditSales,
      debtorPayments,
      orders,
      paymentMethods,
      cashTie,
      dayClose,
      shifts,
      findings,
      checksRun: [...AUDIT_CHECK_CODES],
      flags,
      signOff: signOffRow,
      reconciliation,
      canSignOff: mayWrite(actor),
      canNote: mayWrite(actor),
      canExport: mayExport(actor),
    }
    // Filled in last, and deliberately: `digestMatches` is the stored digest compared with the day as it stands now, so
    // the day has to have been read first. Comparing a stored digest with itself would always be true and would look
    // exactly like this.
    if (signOffRow) {
      report.signOff = { ...signOffRow, digestMatches: auditDigest(report) === signOffRow.subjectDigest }
    }
    return report
  }

  // ------------------------------------------------------- notes and sign-off

  /**
   * Sign a day off. Append-only: a second attempt on the same day and till is refused rather than overwriting, because
   * "who audited this day and what did they conclude" is the one thing on this screen that must not be editable.
   */
  signOffDay(input: SignOffDayInput, actor: AuditActor, edition: Edition): AuditSignOffRow {
    requireNoteWriter(actor)
    validateEdition(edition)
    const businessDate = normalizeBusinessDate(input?.businessDate)
    this.refuseFutureDate(businessDate)
    const accountId = this.normalizeAccount(input?.accountId)
    const outcome = normalizeOutcome(input?.outcome)
    const note = optionalText(input?.note, SIGN_OFF_NOTE_MAX, 'note')

    const row = this.database.transaction(() => {
      const existing = this.readSignOff(businessDate, accountId)
      if (existing) {
        throw new AuditRefusedError(
          `${businessDate} has already been signed off by ${existing.signedByName} at ${existing.signedAt}. `
          + 'A sign-off cannot be changed — raise a flag if something new has come to light.',
        )
      }
      // A clean verdict on a day the checks did not pass is the one thing an audit must not let through silently. The
      // Supervisor may still give it: they are the person who looked. They just have to say why.
      const findings = this.getDayAudit({ businessDate, accountId }, actor, edition).findings
      if (outcome === 'AUDITED' && findings.length > 0 && !note.trim()) {
        const list = findings.map((finding) => finding.headline).join('; ')
        throw new AuditRefusedError(
          `This day has ${findings.length} finding${findings.length === 1 ? '' : 's'}: ${list}. `
          + 'Write a note explaining the verdict, or sign the day off as audited with issues.',
        )
      }
      const digest = this.digestFor(businessDate, accountId, actor, edition)
      const id = this.newId()
      this.database.prepare(`
        INSERT INTO audit_signoffs (id, subject_kind, subject_id, scope_account_id, signed_by, subject_digest, note,
          outcome, signed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, DAY_CLOSE_SUBJECT, businessDate, accountId, actor.id, digest, note, outcome,
        new Date(this.now()).toISOString())
      this.audit(actor, 'audit.day.signed_off', {
        businessDate,
        accountId,
        outcome,
        signOffId: id,
        subjectDigest: digest,
      })
      return id
    }).immediate()

    const saved = this.readSignOff(businessDate, accountId)
    if (!saved || saved.id !== row) throw new Error('The sign-off could not be read back after saving.')
    return saved
  }

  /** A new flag, written by a person. */
  raiseFlag(input: RaiseAuditFlagInput, actor: AuditActor, edition: Edition): AuditFlagRow {
    requireNoteWriter(actor)
    validateEdition(edition)
    const businessDate = normalizeBusinessDate(input?.businessDate)
    this.refuseFutureDate(businessDate)
    const accountId = this.normalizeAccount(input?.accountId)
    const severity = normalizeSeverity(input?.severity)
    const detail = requiredText(input?.detail, FLAG_DETAIL_MAX, 'flag')
    return this.writeFlag({
      businessDate, accountId, actor, source: 'MANUAL', checkCode: '', severity, detail,
    })
  }

  /**
   * The Supervisor's note on something a check found.
   *
   * The finding itself is never stored — it is recomputed from the ledger every time the day is opened, so it cannot go
   * stale. What is stored is the human response to it, keyed by the check's code, which is why the same check cannot
   * produce two open notes for one day and one till.
   */
  noteFinding(input: AuditNoteFindingInput, actor: AuditActor, edition: Edition): AuditFlagRow {
    requireNoteWriter(actor)
    validateEdition(edition)
    const businessDate = normalizeBusinessDate(input?.businessDate)
    this.refuseFutureDate(businessDate)
    const accountId = this.normalizeAccount(input?.accountId)
    if (!(AUDIT_CHECK_CODES as readonly string[]).includes(input?.code as string)) {
      throw new Error('Choose one of the audit checks to note.')
    }
    const detail = requiredText(input?.detail, FLAG_DETAIL_MAX, 'note')
    const severity = input?.severity === undefined
      ? this.severityOf(input.code, businessDate, accountId, actor, edition)
      : normalizeSeverity(input.severity)
    return this.writeFlag({
      businessDate, accountId, actor, source: 'AUTOMATIC', checkCode: input.code, severity, detail,
    })
  }

  /** A note on a flag that already exists, whether a person raised it or a check did. */
  addFlagNote(input: { flagId: string; detail: string }, actor: AuditActor, edition: Edition): AuditFlagRow {
    requireNoteWriter(actor)
    validateEdition(edition)
    const flagId = requiredText(input?.flagId, 120, 'flag')
    const detail = requiredText(input?.detail, FLAG_DETAIL_MAX, 'note')
    this.database.transaction(() => {
      const flag = this.readFlagRow(flagId)
      if (!flag) throw new Error('That flag no longer exists.')
      // Appended rather than replaced: the first thing an audit note must never lose is what it said before. Each
      // append is also written to the audit log with the actor and the time, so the trail of who added what survives
      // even though the row holds one string.
      const stamped = `\n[${this.personName(actor.id)} · ${new Date(this.now()).toISOString()}] ${detail}`
      const grown = flag.detail + stamped
      if (grown.length > FLAG_DETAIL_MAX * 4) {
        throw new Error('This flag has too many notes. Raise a new flag for anything further.')
      }
      this.database.prepare('UPDATE audit_flags SET detail = ? WHERE id = ?').run(grown, flagId)
      this.audit(actor, 'audit.flag.noted', { flagId, businessDate: flag.business_date, checkCode: flag.check_code })
    }).immediate()
    const updated = this.readFlagView(flagId)
    if (!updated) throw new Error('The flag could not be read back after noting.')
    return updated
  }

  /** Close a flag out. Closing is not deleting: the row, who raised it and when all stay. */
  resolveFlag(input: ResolveAuditFlagInput, actor: AuditActor, edition: Edition): AuditFlagRow {
    requireNoteWriter(actor)
    validateEdition(edition)
    const flagId = requiredText(input?.flagId, 120, 'flag')
    const resolutionNote = requiredText(input?.resolutionNote, FLAG_DETAIL_MAX, 'resolution note')
    this.database.transaction(() => {
      const flag = this.readFlagRow(flagId)
      if (!flag) throw new Error('That flag no longer exists.')
      if (flag.resolved_at !== null) throw new Error('That flag has already been resolved.')
      this.database.prepare(`
        UPDATE audit_flags SET resolved_by = ?, resolved_at = ?, resolution_note = ? WHERE id = ? AND resolved_at IS NULL
      `).run(actor.id, new Date(this.now()).toISOString(), resolutionNote, flagId)
      this.audit(actor, 'audit.flag.resolved', { flagId, businessDate: flag.business_date, resolutionNote })
    }).immediate()
    const resolved = this.readFlagView(flagId)
    if (!resolved) throw new Error('The flag could not be read back after resolving.')
    return resolved
  }

  // ------------------------------------------------------------ days to audit

  /**
   * The days that still need somebody to look at them.
   *
   * Derived, not stored: a day needs auditing when the ledger says something happened on it, and it is audited when a
   * sign-off exists for it. Keeping a list of unaudited days would be a second copy of a fact the sign-offs already
   * hold, and the two would disagree the first time somebody sold something after the list was written.
   */
  listUnauditedDays(actor: AuditActor, edition: Edition, days = AUDIT_LOOKBACK_DAYS): UnauditedDay[] {
    requireAuditor(actor)
    validateEdition(edition)
    return this.dayStatuses(actor, edition, days).filter((day) => !day.audited).map((day) => ({
      businessDate: day.businessDate,
      accountId: day.accountId,
      accountName: day.accountName,
      transactions: day.transactions,
      salesMinor: day.salesMinor,
      currencyCode: day.currencyCode,
      openFlags: day.openFlags,
      dayClosed: day.dayClosed,
    }))
  }

  dayStatuses(actor: AuditActor, edition: Edition, days = AUDIT_LOOKBACK_DAYS): AuditDayStatus[] {
    requireAuditor(actor)
    validateEdition(edition)
    const settings = this.shop.readSettings()
    const currencyCode = settings.currency.code
    const lookback = Number.isInteger(days) && days > 0 && days <= 366 ? days : AUDIT_LOOKBACK_DAYS
    const earliest = addDays(localDateString(this.now()), -(lookback - 1))
    const activity = this.database.prepare(`
      SELECT business_date, account_id, SUM(transactions) AS transactions, CAST(SUM(sales_minor) AS TEXT) AS sales_text
      FROM (
        SELECT date(created_at, 'localtime') AS business_date, cashier_id AS account_id,
          1 AS transactions, total AS sales_minor
          FROM sales
          WHERE status = 'COMPLETED' AND currency_code = ? AND date(created_at, 'localtime') >= ?
        UNION ALL
        SELECT business_date, closed_by, 0, 0 FROM day_closings
          WHERE currency_code = ? AND business_date >= ? AND business_date <> ''
        UNION ALL
        SELECT date(opened_at, 'localtime'), cashier_id, 0, 0 FROM cashier_shifts
          WHERE currency_code = ? AND date(opened_at, 'localtime') >= ?
      )
      GROUP BY business_date, account_id
      ORDER BY business_date DESC, account_id
    `).all(currencyCode, earliest, currencyCode, earliest, currencyCode, earliest) as Array<{
      business_date: string; account_id: string | null; transactions: number; sales_text: string
    }>
    const signOffs = this.database.prepare(`
      SELECT a.subject_id, a.scope_account_id, a.outcome, a.signed_at,
        COALESCE(NULLIF(u.full_name, ''), u.username, '') AS signed_by_name
      FROM audit_signoffs a LEFT JOIN users u ON u.id = a.signed_by
      WHERE a.subject_kind = ? AND a.subject_id >= ?
    `).all(DAY_CLOSE_SUBJECT, earliest) as Array<{
      subject_id: string; scope_account_id: string | null; outcome: AuditSignOffOutcome
      signed_at: string; signed_by_name: string
    }>
    const openFlags = this.database.prepare(`
      SELECT business_date, scope_account_id, COUNT(*) AS open_count FROM audit_flags
      WHERE resolved_at IS NULL AND business_date <> '' GROUP BY business_date, scope_account_id
    `).all() as Array<{ business_date: string; scope_account_id: string | null; open_count: number }>
    const closedDays = new Set(
      (this.database.prepare(`
        SELECT DISTINCT business_date FROM day_closings WHERE currency_code = ? AND business_date >= ?
      `).all(currencyCode, earliest) as Array<{ business_date: string }>).map((row) => row.business_date),
    )

    return activity.map((row) => {
      // A sign-off for the whole store covers every till in it: the Supervisor who audited the day did not leave one
      // Account out, and asking them to sign the same day nine times would teach them to sign without looking.
      const signOff = signOffs.find((candidate) => candidate.subject_id === row.business_date
        && (candidate.scope_account_id === null || candidate.scope_account_id === row.account_id))
      const flags = openFlags.filter((candidate) => candidate.business_date === row.business_date
        && (candidate.scope_account_id === null || candidate.scope_account_id === row.account_id))
      return {
        businessDate: row.business_date,
        accountId: row.account_id,
        accountName: row.account_id ? this.personName(row.account_id) : 'Whole store',
        audited: Boolean(signOff),
        outcome: signOff?.outcome ?? null,
        signedByName: signOff?.signed_by_name ?? '',
        signedAt: signOff?.signed_at ?? '',
        openFlags: flags.reduce((sum, candidate) => sum + candidate.open_count, 0),
        transactions: row.transactions,
        salesMinor: BigInt(row.sales_text ?? '0'),
        currencyCode,
        dayClosed: closedDays.has(row.business_date),
      }
    })
  }

  /** What the Admin's phone needs: the days nobody has looked at, and everything still open. */
  summaryForPhone(actor: AuditActor, edition: Edition, days = AUDIT_LOOKBACK_DAYS): AuditSummaryForPhone {
    requireAuditor(actor)
    validateEdition(edition)
    const statuses = this.dayStatuses(actor, edition, days)
    const unauditedDays: UnauditedDay[] = statuses.filter((day) => !day.audited).map((day) => ({
      businessDate: day.businessDate,
      accountId: day.accountId,
      accountName: day.accountName,
      transactions: day.transactions,
      salesMinor: day.salesMinor,
      currencyCode: day.currencyCode,
      openFlags: day.openFlags,
      dayClosed: day.dayClosed,
    }))
    const flagRows = this.database.prepare(`
      SELECT f.id, f.business_date, f.severity, f.detail, f.raised_at,
        COALESCE(u.full_name, u.username, '') AS raised_by_name
      FROM audit_flags f LEFT JOIN users u ON u.id = f.raised_by
      WHERE f.resolved_at IS NULL AND f.business_date <> ''
      ORDER BY f.business_date DESC, f.raised_at DESC LIMIT 100
    `).all() as Array<{
      id: string; business_date: string; severity: AuditFlagSeverity; detail: string
      raised_at: string; raised_by_name: string
    }>
    return {
      unauditedDays,
      openFlags: flagRows.map((row) => ({
        id: row.id,
        businessDate: row.business_date,
        severity: row.severity,
        detail: row.detail,
        raisedByName: row.raised_by_name,
        raisedAt: row.raised_at,
      })),
      auditedDays: statuses.filter((day) => day.audited),
    }
  }

  /**
   * The day as a file.
   *
   * Built from `getDayAudit` rather than from a second set of queries, so the document contains exactly the rows the
   * caller was just shown — a Supervisor's export has no cost in it because the report it came from has no cost in it,
   * not because this method remembered to leave one out. And the export is itself written to the audit log: a control
   * that can be copied off the machine without a trace is not much of a control.
   *
   * There is no PDF and no print. An audit is a file the Admin keeps, not a document to hand across a counter, and the
   * one thing this screen must never be able to do is produce something that could be mistaken for a receipt.
   */
  async exportAudit(input: AuditExportInput, actor: AuditActor, edition: Edition): Promise<AuditExportResult> {
    requireAuditor(actor)
    validateEdition(edition)
    if (!mayExport(actor)) {
      throw new AuditRefusedError('Your role may read the audit but not export it.')
    }
    const format = input?.format === 'EXCEL' ? 'EXCEL' : input?.format === 'CSV' ? 'CSV' : null
    if (format === null) throw new Error('Choose CSV or Excel to export the audit.')
    const report = this.getDayAudit(input, actor, edition)
    const contentBase64 = format === 'CSV'
      ? Buffer.from(createAuditCsv(report), 'utf8').toString('base64')
      : await createAuditWorkbookBase64(report)
    const extension = format === 'CSV' ? 'csv' : 'xlsx'
    const fileName = `daily-audit-${report.businessDate}${report.account ? `-${slugOf(report.account.username)}` : ''}.${extension}`
    this.audit(actor, 'audit.day.exported', {
      businessDate: report.businessDate,
      accountId: report.account?.id ?? null,
      format,
      fileName,
      currencyCode: report.currencyCode,
      transactions: report.totals.transactions,
      findings: report.findings.length,
      signedOff: report.signOff !== null,
    })
    return {
      format,
      contentBase64,
      fileName,
      mimeType: format === 'CSV'
        ? 'text/csv;charset=utf-8'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      storeName: report.header.storeName,
      currencyCode: report.currencyCode,
    }
  }

  // ------------------------------------------------------------------ reads

  private header(
    settings: ReturnType<ShopRepository['readSettings']>,
    businessDate: string,
    actor: AuditActor,
    edition: Edition,
  ): ReportHeader {
    return {
      storeName: settings.profile.name,
      storeAddress: settings.profile.address,
      currency: settings.currency,
      display: settings.display,
      period: { type: 'DAY', startDate: businessDate, endDate: businessDate, label: businessDate },
      generatedAt: new Date(this.now()).toISOString(),
      scope: 'STORE',
      viewerName: actor.fullName?.trim() || actor.username,
      edition,
    }
  }

  private readSales(businessDate: string, currencyCode: string, scopeAll: number, scopeId: string): SaleLedgerRow[] {
    return this.database.prepare(`
      SELECT s.id AS sale_id, s.receipt_number, s.status, s.sale_type, s.cashier_id,
        COALESCE(NULLIF(u.full_name, ''), u.username, s.cashier_name_snapshot, '') AS cashier_name,
        COALESCE(NULLIF(s.customer_name_snapshot, ''), c.name, '') AS customer_name,
        s.order_id,
        CAST(s.subtotal AS TEXT) AS subtotal_text,
        CAST(s.discount AS TEXT) AS discount_text,
        CAST(s.total AS TEXT) AS total_text,
        CAST(COALESCE(s.credit_amount, 0) AS TEXT) AS credit_text,
        time(s.created_at, 'localtime') AS clock_time,
        s.created_at
      FROM sales s
        LEFT JOIN users u ON u.id = s.cashier_id
        LEFT JOIN customers c ON c.id = s.customer_id
      WHERE s.currency_code = ? AND date(s.created_at, 'localtime') = ?
        AND s.status = 'COMPLETED' AND (? = 1 OR s.cashier_id = ?)
      ORDER BY s.id
    `).all(currencyCode, businessDate, scopeAll, scopeId) as SaleLedgerRow[]
  }

  private readVoids(businessDate: string, currencyCode: string, scopeAll: number, scopeId: string): AuditVoidRow[] {
    const rows = this.database.prepare(`
      SELECT s.id AS sale_id, s.receipt_number, s.status,
        COALESCE(NULLIF(u.full_name, ''), u.username, s.cashier_name_snapshot, '') AS cashier_name,
        CAST(s.total AS TEXT) AS total_text, s.created_at
      FROM sales s LEFT JOIN users u ON u.id = s.cashier_id
      WHERE s.currency_code = ? AND date(s.created_at, 'localtime') = ?
        AND s.status <> 'COMPLETED' AND (? = 1 OR s.cashier_id = ?)
      ORDER BY s.id
    `).all(currencyCode, businessDate, scopeAll, scopeId) as Array<{
      sale_id: number; receipt_number: string; status: string; cashier_name: string
      total_text: string; created_at: string
    }>
    return rows.map((row) => ({
      saleId: row.sale_id,
      receiptNumber: row.receipt_number,
      cashierName: row.cashier_name,
      status: row.status,
      totalMinor: BigInt(row.total_text),
      at: row.created_at,
    }))
  }

  private readSaleItems(
    businessDate: string,
    currencyCode: string,
    scopeAll: number,
    scopeId: string,
  ): SaleItemLedgerRow[] {
    return this.database.prepare(`
      SELECT si.sale_id, si.product_id,
        COALESCE(NULLIF(p.name, ''), si.description_snapshot) AS product_name,
        COALESCE(NULLIF(si.product_sku_snapshot, ''), p.sku, '') AS sku,
        si.description_snapshot, si.price_tier,
        CAST(si.quantity_milli AS TEXT) AS quantity_text,
        CAST(si.unit_price AS TEXT) AS unit_price_text,
        CAST(si.discount AS TEXT) AS discount_text,
        CAST(si.manual_discount AS TEXT) AS manual_discount_text,
        CAST(si.gross_total AS TEXT) AS gross_text,
        CAST(si.promotion_discount AS TEXT) AS promotion_discount_text,
        CAST(CASE WHEN si.price_tier = 'WHOLESALE' THEN p.wholesale_price ELSE p.sale_price END AS TEXT)
          AS catalogue_price_text
      FROM sale_items si
        JOIN sales s ON s.id = si.sale_id
        LEFT JOIN products p ON p.id = si.product_id
      WHERE s.currency_code = ? AND date(s.created_at, 'localtime') = ? AND s.status = 'COMPLETED'
        AND (? = 1 OR s.cashier_id = ?)
      ORDER BY si.sale_id, si.id
    `).all(currencyCode, businessDate, scopeAll, scopeId) as SaleItemLedgerRow[]
  }

  private readPayments(
    businessDate: string,
    currencyCode: string,
    scopeAll: number,
    scopeId: string,
  ): Array<{ sale_id: number; method: string; amount_text: string }> {
    return this.database.prepare(`
      SELECT p.sale_id, p.payment_method AS method, CAST(p.amount AS TEXT) AS amount_text
      FROM payments p JOIN sales s ON s.id = p.sale_id
      WHERE p.sale_id IS NOT NULL AND p.currency_code = ? AND date(s.created_at, 'localtime') = ?
        AND s.status = 'COMPLETED' AND (? = 1 OR s.cashier_id = ?)
      ORDER BY p.created_at, p.id
    `).all(currencyCode, businessDate, scopeAll, scopeId) as Array<{
      sale_id: number; method: string; amount_text: string
    }>
  }

  private readRefunds(
    businessDate: string,
    currencyCode: string,
    scopeAll: number,
    scopeId: string,
  ): Array<{ method: string; amount_text: string }> {
    return this.database.prepare(`
      SELECT p.payment_method AS method, CAST(p.amount AS TEXT) AS amount_text
      FROM payments p JOIN returns r ON r.id = p.return_id
      WHERE p.return_id IS NOT NULL AND p.currency_code = ? AND r.status = 'COMPLETED'
        AND date(r.created_at, 'localtime') = ? AND (? = 1 OR r.cashier_id = ?)
      ORDER BY p.created_at, p.id
    `).all(currencyCode, businessDate, scopeAll, scopeId) as Array<{ method: string; amount_text: string }>
  }

  private readReturns(
    businessDate: string,
    currencyCode: string,
    scopeAll: number,
    scopeId: string,
  ): AuditReturnRow[] {
    const windowDays = this.returnWindowDays()
    const rows = this.database.prepare(`
      SELECT r.id AS return_id, r.return_number, r.created_at,
        COALESCE(s.receipt_number, '') AS sale_receipt_number,
        s.created_at AS sale_created_at,
        COALESCE(NULLIF(uc.full_name, ''), uc.username, '') AS cashier_name,
        COALESCE(NULLIF(ua.full_name, ''), ua.username, '') AS approved_name,
        CAST(r.total AS TEXT) AS total_text
      FROM returns r
        LEFT JOIN sales s ON s.id = r.sale_id
        LEFT JOIN users uc ON uc.id = r.cashier_id
        LEFT JOIN users ua ON ua.id = r.approved_by
      WHERE r.currency_code = ? AND r.status = 'COMPLETED' AND date(r.created_at, 'localtime') = ?
        AND (? = 1 OR r.cashier_id = ?)
      ORDER BY r.id
    `).all(currencyCode, businessDate, scopeAll, scopeId) as Array<{
      return_id: number; return_number: string; created_at: string; sale_receipt_number: string
      sale_created_at: string | null; cashier_name: string; approved_name: string; total_text: string
    }>
    return rows.map((row) => ({
      returnId: row.return_id,
      returnNumber: row.return_number,
      saleReceiptNumber: row.sale_receipt_number,
      cashierName: row.cashier_name,
      approvedByName: row.approved_name,
      totalMinor: BigInt(row.total_text),
      refundMethods: '',
      at: row.created_at,
      // Measured in whole local days against the shop's own return window, so "outside the window" means the same thing
      // here that it meant to the person who was refused a return at the counter.
      outsideWindow: row.sale_created_at === null
        ? false
        : daysBetween(row.sale_created_at, row.created_at) > windowDays,
    }))
  }

  private readReprints(businessDate: string, scopeAll: number, scopeId: string): AuditReprintRow[] {
    const rows = this.database.prepare(`
      SELECT pl.document_kind, pl.document_id, pl.copy_no, pl.printed_at, pl.reprint_reason,
        COALESCE(NULLIF(u.full_name, ''), u.username, '') AS printed_by_name,
        COALESCE(cd.name, '') AS device_name,
        COALESCE(s.receipt_number, r.return_number, o.order_number, '') AS document_number
      FROM print_log pl
        LEFT JOIN users u ON u.id = pl.printed_by
        LEFT JOIN client_devices cd ON cd.id = pl.client_device_id
        LEFT JOIN sales s ON pl.document_kind = 'SALE' AND CAST(s.id AS TEXT) = pl.document_id
        LEFT JOIN returns r ON pl.document_kind = 'RETURN' AND CAST(r.id AS TEXT) = pl.document_id
        LEFT JOIN orders o ON pl.document_kind = 'ORDER' AND o.id = pl.document_id
      WHERE pl.duplicate = 1 AND date(pl.printed_at, 'localtime') = ? AND (? = 1 OR pl.printed_by = ?)
      ORDER BY pl.printed_at, pl.id
    `).all(businessDate, scopeAll, scopeId) as Array<{
      document_kind: AuditReprintRow['documentKind']; document_id: string; copy_no: number; printed_at: string
      reprint_reason: string; printed_by_name: string; device_name: string; document_number: string
    }>
    return rows.map((row) => ({
      documentKind: row.document_kind,
      documentId: row.document_id,
      receiptNumber: row.document_number,
      copyNo: row.copy_no,
      printedByName: row.printed_by_name,
      printedAt: row.printed_at,
      reason: row.reprint_reason,
      clientDeviceName: row.device_name,
    }))
  }

  private readCreditSales(
    sales: SaleLedgerRow[],
    payments: Array<{ sale_id: number; method: string; amount_text: string }>,
  ): AuditCreditSaleRow[] {
    const bySale = new Map<number, bigint>()
    for (const payment of payments) {
      if (payment.method !== 'CREDIT') continue
      bySale.set(payment.sale_id, (bySale.get(payment.sale_id) ?? 0n) + BigInt(payment.amount_text))
    }
    return sales
      .filter((sale) => (bySale.get(sale.sale_id) ?? 0n) > 0n)
      .map((sale) => {
        const customer = this.readCustomer(sale.customer_name, sale.sale_id)
        return {
          saleId: sale.sale_id,
          receiptNumber: sale.receipt_number,
          customerName: sale.customer_name,
          cashierName: sale.cashier_name,
          creditMinor: bySale.get(sale.sale_id) ?? 0n,
          customerBalanceMinor: customer?.balance ?? 0n,
          creditLimitMinor: customer?.limit ?? 0n,
          at: sale.created_at,
        }
      })
  }

  private readCustomer(customerName: string, saleId: number): { balance: bigint; limit: bigint } | null {
    const row = this.database.prepare(`
      SELECT CAST(c.balance AS TEXT) AS balance_text, CAST(c.credit_limit AS TEXT) AS limit_text
      FROM sales s JOIN customers c ON c.id = s.customer_id WHERE s.id = ?
    `).get(saleId) as { balance_text: string; limit_text: string } | undefined
    if (!row) return customerName ? { balance: 0n, limit: 0n } : null
    return { balance: BigInt(row.balance_text), limit: BigInt(row.limit_text) }
  }

  private readDebtorPayments(
    businessDate: string,
    currencyCode: string,
    scopeAll: number,
    scopeId: string,
  ): AuditDebtorPaymentRow[] {
    const rows = this.database.prepare(`
      SELECT dp.payment_number, dp.payment_method, dp.reference, dp.created_at,
        COALESCE(c.name, '') AS customer_name,
        COALESCE(NULLIF(u.full_name, ''), u.username, '') AS received_by_name,
        CAST(dp.amount AS TEXT) AS amount_text,
        CAST(dp.balance_before AS TEXT) AS before_text,
        CAST(dp.balance_after AS TEXT) AS after_text
      FROM debtor_payments dp
        LEFT JOIN customers c ON c.id = dp.customer_id
        LEFT JOIN users u ON u.id = dp.received_by
      WHERE dp.currency_code = ? AND dp.business_date = ? AND (? = 1 OR dp.received_by = ?)
      ORDER BY dp.created_at, dp.payment_number
    `).all(currencyCode, businessDate, scopeAll, scopeId) as Array<{
      payment_number: string; payment_method: AuditDebtorPaymentRow['paymentMethod']; reference: string
      created_at: string; customer_name: string; received_by_name: string; amount_text: string
      before_text: string; after_text: string
    }>
    return rows.map((row) => ({
      paymentNumber: row.payment_number,
      customerName: row.customer_name,
      receivedByName: row.received_by_name,
      paymentMethod: row.payment_method,
      amountMinor: BigInt(row.amount_text),
      balanceBeforeMinor: BigInt(row.before_text),
      balanceAfterMinor: BigInt(row.after_text),
      reference: row.reference,
      at: row.created_at,
    }))
  }

  private readOrders(
    businessDate: string,
    currencyCode: string,
    scopeAll: number,
    scopeId: string,
  ): AuditOrderRow[] {
    const rows = this.database.prepare(`
      SELECT o.id AS order_id, o.order_number, o.status, o.updated_at,
        COALESCE(NULLIF(u.full_name, ''), u.username, '') AS picked_by_name,
        CAST(o.total AS TEXT) AS total_text
      FROM orders o LEFT JOIN users u ON u.id = o.created_by
      WHERE o.currency_code = ? AND o.status IN ('CANCELLED', 'EXPIRED')
        AND date(o.updated_at, 'localtime') = ? AND (? = 1 OR o.created_by = ?)
      ORDER BY o.updated_at, o.order_number
    `).all(currencyCode, businessDate, scopeAll, scopeId) as Array<{
      order_id: string; order_number: string; status: 'CANCELLED' | 'EXPIRED'; updated_at: string
      picked_by_name: string; total_text: string
    }>
    // `orders` has no reason column and never will: the reason a person gave is history, and history lives in the
    // immutable event log where it cannot be edited into something more comfortable.
    return rows.map((row) => ({
      orderId: row.order_id,
      orderNumber: row.order_number,
      status: row.status,
      pickedByName: row.picked_by_name,
      totalMinor: BigInt(row.total_text),
      at: row.updated_at,
      reason: this.readOrderReason(row.order_id, row.status),
    }))
  }

  private readOrderReason(orderId: string, status: 'CANCELLED' | 'EXPIRED'): string {
    const event = status === 'CANCELLED' ? 'order.cancelled' : 'order.expired'
    const row = this.database.prepare(`
      SELECT detail FROM order_events WHERE order_id = ? AND event = ? ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(orderId, event) as { detail: string } | undefined
    return row?.detail ?? ''
  }

  /**
   * Lines charged at something other than the catalogue price for the tier they were sold on.
   *
   * There is no override column to read, and adding one would only describe sales made from now on: comparing the price
   * charged with the product's own price finds every difference that has ever been recorded. The comparison is against
   * the catalogue *as it stands*, so a row is marked when the price was changed after the sale — a price the Admin
   * moved on Tuesday explains a difference on Monday's receipt, and saying so is the difference between an audit and an
   * accusation.
   *
   * The mark comes from the audit log's `product.updated` entries, which carry the price before and after, and not from
   * `products.updated_at`. That column moves when anything at all about the product is edited — a spelling, a reorder
   * level — so it would excuse an override because somebody fixed a typo six months later, which is worse than offering
   * no excuse at all.
   */
  private findOverrides(sales: SaleLedgerRow[], items: SaleItemLedgerRow[]): AuditOverrideRow[] {
    const saleById = new Map(sales.map((sale) => [sale.sale_id, sale]))
    const priceChanges = this.readPriceChanges(sales)
    const rows: AuditOverrideRow[] = []
    for (const item of items) {
      const sale = saleById.get(item.sale_id)
      if (!sale || item.catalogue_price_text === null) continue
      const charged = BigInt(item.unit_price_text)
      // The price that was on the shelf that day, not the price on the shelf now. Without this, an Admin who changed a
      // product to the very figure a cashier had charged would erase the difference from the audit — the one edit that
      // most needs to stay visible.
      const catalogue = this.cataloguePriceAtSale(item, sale, priceChanges)
      // A promotion is a price the shop set, not one the cashier typed, and it is recorded in its own column.
      if (charged === catalogue || BigInt(item.promotion_discount_text) > 0n) continue
      rows.push({
        saleId: sale.sale_id,
        receiptNumber: sale.receipt_number,
        cashierName: sale.cashier_name,
        productName: item.product_name,
        sku: item.sku,
        priceTier: item.price_tier,
        cataloguePriceMinor: catalogue,
        chargedPriceMinor: charged,
        differenceMinor: charged - catalogue,
        direction: charged < catalogue ? 'BELOW_CATALOGUE' : 'ABOVE_CATALOGUE',
        quantityMilli: BigInt(item.quantity_text),
        catalogueChangedSince: catalogue !== BigInt(item.catalogue_price_text),
      })
    }
    return rows
  }

  /**
   * What this line's tier cost in the catalogue when the sale was rung up.
   *
   * Walked back out of the audit log: the first recorded price change *after* the sale says what the price was before
   * it, which is what the till saw. With no change after the sale, today's price is the price of the day, which is the
   * only answer available and the right one.
   */
  private cataloguePriceAtSale(
    item: SaleItemLedgerRow,
    sale: SaleLedgerRow,
    changes: Map<string, PriceChange[]>,
  ): bigint {
    const current = BigInt(item.catalogue_price_text!)
    if (item.product_id === null) return current
    for (const change of changes.get(item.product_id) ?? []) {
      if (change.at <= sale.created_at) continue
      const was = item.price_tier === 'WHOLESALE' ? change.wholesaleOld : change.retailOld
      return was === null ? current : BigInt(was)
    }
    return current
  }

  /**
   * When each product's price was changed, from the audit log.
   *
   * Read once per day rather than once per line: a busy day can have hundreds of lines and one price change. The
   * earliest sale of the day is the only entry point that matters, because a change before every sale on the day cannot
   * explain any of them.
   */
  private readPriceChanges(sales: SaleLedgerRow[]): Map<string, PriceChange[]> {
    const changes = new Map<string, PriceChange[]>()
    if (sales.length === 0) return changes
    const earliest = sales.reduce((min, sale) => (sale.created_at < min ? sale.created_at : min), sales[0]!.created_at)
    const rows = this.database.prepare(`
      SELECT metadata_json, created_at FROM audit_log
      WHERE action = 'product.updated' AND created_at > ? ORDER BY created_at
    `).all(earliest) as Array<{ metadata_json: string; created_at: string }>
    for (const row of rows) {
      const metadata = parseJsonObject(row.metadata_json)
      const productId = metadata.productId
      if (typeof productId !== 'string') continue
      const prices = parseJsonObject(metadata.prices)
      const before = parseJsonObject(prices.old)
      const after = parseJsonObject(prices.new)
      // An edit that changed a spelling, a shelf or a reorder level is not a price change, and must not be allowed to
      // explain a difference between what was charged and what the catalogue said.
      const moved = before.retailPriceMinor !== after.retailPriceMinor
        || before.wholesalePriceMinor !== after.wholesalePriceMinor
      if (!moved) continue
      const known = changes.get(productId) ?? []
      known.push({
        at: row.created_at,
        retailOld: textOrNull(before.retailPriceMinor),
        wholesaleOld: textOrNull(before.wholesalePriceMinor),
      })
      changes.set(productId, known)
    }
    // Oldest first, so the walk back from today stops at the first change after the sale.
    for (const list of changes.values()) list.sort((left, right) => (left.at < right.at ? -1 : 1))
    return changes
  }

  private findDiscounts(
    sales: SaleLedgerRow[],
    items: SaleItemLedgerRow[],
    settings: ReturnType<ShopRepository['readSettings']>,
  ): AuditDiscountRow[] {
    const saleById = new Map(sales.map((sale) => [sale.sale_id, sale]))
    const shopCap = shopDiscountLimit(settings)
    const bySale = new Map<number, { gross: bigint; manual: bigint }>()
    for (const item of items) {
      const existing = bySale.get(item.sale_id) ?? { gross: 0n, manual: 0n }
      existing.gross += BigInt(item.gross_text)
      existing.manual += BigInt(item.manual_discount_text)
      bySale.set(item.sale_id, existing)
    }
    const rows: AuditDiscountRow[] = []
    for (const [saleId, money] of bySale) {
      const sale = saleById.get(saleId)
      if (!sale || money.manual <= 0n) continue
      const cashier = this.readCashierCap(sale.cashier_id)
      const cap = resolveDiscountCap(cashier.basisPoints, shopCap)
      const basisPoints = money.gross > 0n ? (money.manual * 10_000n) / money.gross : 0n
      rows.push({
        saleId,
        receiptNumber: sale.receipt_number,
        cashierName: sale.cashier_name,
        grossMinor: money.gross,
        discountMinor: money.manual,
        basisPoints,
        capBasisPoints: BigInt(cap.limitBasisPoints),
        capSource: cap.setBy,
        nearCap: basisPoints * 10_000n >= BigInt(cap.limitBasisPoints) * DISCOUNT_NEAR_CAP_BASIS_POINTS
          && basisPoints <= BigInt(cap.limitBasisPoints),
        aboveCap: basisPoints > BigInt(cap.limitBasisPoints),
      })
    }
    return rows.sort((left, right) => left.saleId - right.saleId)
  }

  /**
   * The cap that applied to this cashier, read the way the till read it.
   *
   * An Admin's own permission is the whole price; everybody else's comes from their permission row. Going through
   * `discount-cap` rather than restating the rule is what makes "above the cap" on this screen mean the same thing as
   * "above the cap" in the refusal the cashier saw.
   */
  private readCashierCap(cashierId: string | null): { basisPoints: number } {
    if (cashierId === null) return { basisPoints: 0 }
    const row = this.database.prepare(`
      SELECT u.role, COALESCE(p.max_discount_pct, 0) AS max_discount_pct
      FROM users u LEFT JOIN user_permissions p ON p.user_id = u.id WHERE u.id = ?
    `).get(cashierId) as { role: string; max_discount_pct: number } | undefined
    if (!row) return { basisPoints: 0 }
    return { basisPoints: row.role === 'ADMIN' ? 10_000 : row.max_discount_pct }
  }

  private summarizeMethods(
    payments: Array<{ method: string; amount_text: string }>,
    refunds: Array<{ method: string; amount_text: string }>,
  ): AuditPaymentMethodTotal[] {
    const byMethod = new Map<string, AuditPaymentMethodTotal>()
    const bucket = (method: string): AuditPaymentMethodTotal => {
      const existing = byMethod.get(method)
      if (existing) return existing
      const created: AuditPaymentMethodTotal = {
        method, transactions: 0, salesMinor: 0n, refundsMinor: 0n, netMinor: 0n,
      }
      byMethod.set(method, created)
      return created
    }
    for (const payment of payments) {
      const row = bucket(payment.method)
      row.transactions += 1
      row.salesMinor += BigInt(payment.amount_text)
    }
    for (const refund of refunds) {
      const row = bucket(refund.method)
      row.transactions += 1
      row.refundsMinor += BigInt(refund.amount_text)
    }
    return [...byMethod.values()]
      .map((row) => ({ ...row, netMinor: row.salesMinor - row.refundsMinor }))
      .sort((left, right) => left.method.localeCompare(right.method))
  }

  private summarize(parts: {
    sales: SaleLedgerRow[]
    payments: Array<{ method: string; amount_text: string }>
    returns: AuditReturnRow[]
    refunds: Array<{ method: string; amount_text: string }>
    creditSales: AuditCreditSaleRow[]
    debtorPayments: AuditDebtorPaymentRow[]
    voids: AuditVoidRow[]
    overrides: AuditOverrideRow[]
    reprints: AuditReprintRow[]
    orders: AuditOrderRow[]
  }): AuditTotals {
    const gross = parts.sales.reduce((sum, sale) => sum + BigInt(sale.subtotal_text), 0n)
    const discounts = parts.sales.reduce((sum, sale) => sum + BigInt(sale.discount_text), 0n)
    const total = parts.sales.reduce((sum, sale) => sum + BigInt(sale.total_text), 0n)
    const retail = parts.sales.filter((sale) => sale.sale_type !== 'WHOLESALE')
    const wholesale = parts.sales.filter((sale) => sale.sale_type === 'WHOLESALE')
    const returnsTotal = parts.returns.reduce((sum, row) => sum + row.totalMinor, 0n)
    const refundsTotal = parts.refunds.reduce((sum, row) => sum + BigInt(row.amount_text), 0n)
    return {
      grossSalesMinor: gross,
      totalSalesMinor: total,
      netSalesMinor: total - returnsTotal,
      transactions: parts.sales.length,
      retailMinor: retail.reduce((sum, sale) => sum + BigInt(sale.total_text), 0n),
      retailTransactions: retail.length,
      wholesaleMinor: wholesale.reduce((sum, sale) => sum + BigInt(sale.total_text), 0n),
      wholesaleTransactions: wholesale.length,
      discountsMinor: discounts,
      returnsMinor: returnsTotal,
      returnTransactions: parts.returns.length,
      refundsMinor: refundsTotal,
      creditSalesMinor: parts.creditSales.reduce((sum, row) => sum + row.creditMinor, 0n),
      creditTransactions: parts.creditSales.length,
      debtorPaymentsMinor: parts.debtorPayments.reduce((sum, row) => sum + row.amountMinor, 0n),
      debtorPaymentTransactions: parts.debtorPayments.length,
      voids: parts.voids.length,
      overrides: parts.overrides.length,
      reprints: parts.reprints.length,
      cancelledOrders: parts.orders.filter((order) => order.status === 'CANCELLED').length,
      expiredOrders: parts.orders.filter((order) => order.status === 'EXPIRED').length,
    }
  }

  /**
   * The ledger's own answer, by a different route from the rows.
   *
   * Aggregates in SQL rather than a second pass over the same lists in TypeScript: two routes to the same number is what
   * makes the comparison worth running, and a route that reuses the first route's rows would agree with itself no matter
   * how wrong it was.
   */
  private readLedgerTotals(
    businessDate: string,
    currencyCode: string,
    scopeAll: number,
    scopeId: string,
  ): LedgerTotals {
    const sales = this.database.prepare(`
      SELECT COUNT(*) AS transactions,
        CAST(COALESCE(SUM(subtotal), 0) AS TEXT) AS gross_text,
        CAST(COALESCE(SUM(discount), 0) AS TEXT) AS discount_text,
        CAST(COALESCE(SUM(total), 0) AS TEXT) AS total_text
      FROM sales
      WHERE currency_code = ? AND status = 'COMPLETED' AND date(created_at, 'localtime') = ?
        AND (? = 1 OR cashier_id = ?)
    `).get(currencyCode, businessDate, scopeAll, scopeId) as {
      transactions: number; gross_text: string; discount_text: string; total_text: string
    }
    const payments = this.database.prepare(`
      SELECT CAST(COALESCE(SUM(p.amount), 0) AS TEXT) AS total_text
      FROM payments p JOIN sales s ON s.id = p.sale_id
      WHERE p.sale_id IS NOT NULL AND p.currency_code = ? AND s.status = 'COMPLETED'
        AND date(s.created_at, 'localtime') = ? AND (? = 1 OR s.cashier_id = ?)
    `).get(currencyCode, businessDate, scopeAll, scopeId) as { total_text: string }
    const returns = this.database.prepare(`
      SELECT CAST(COALESCE(SUM(total), 0) AS TEXT) AS total_text
      FROM returns
      WHERE currency_code = ? AND status = 'COMPLETED' AND date(created_at, 'localtime') = ?
        AND (? = 1 OR cashier_id = ?)
    `).get(currencyCode, businessDate, scopeAll, scopeId) as { total_text: string }
    const refunds = this.database.prepare(`
      SELECT CAST(COALESCE(SUM(p.amount), 0) AS TEXT) AS total_text
      FROM payments p JOIN returns r ON r.id = p.return_id
      WHERE p.return_id IS NOT NULL AND p.currency_code = ? AND r.status = 'COMPLETED'
        AND date(r.created_at, 'localtime') = ? AND (? = 1 OR r.cashier_id = ?)
    `).get(currencyCode, businessDate, scopeAll, scopeId) as { total_text: string }
    return {
      transactions: sales.transactions,
      grossMinor: BigInt(sales.gross_text),
      discountsMinor: BigInt(sales.discount_text),
      salesMinor: BigInt(sales.total_text),
      paymentsMinor: BigInt(payments.total_text),
      returnsMinor: BigInt(returns.total_text),
      refundsMinor: BigInt(refunds.total_text),
    }
  }

  private readDayClose(
    businessDate: string,
    currencyCode: string,
    scopeAll: number,
    scopeId: string,
  ): DayCloseRecord | null {
    const row = this.database.prepare(`
      SELECT d.id, d.closing_number, d.business_date, d.opened_at, d.closed_at,
        COALESCE(NULLIF(u.full_name, ''), u.username, '') AS closed_by,
        d.currency_code, CAST(d.sales_total AS TEXT) AS sales_text,
        CAST(d.returns_total AS TEXT) AS returns_text, CAST(d.expected_cash AS TEXT) AS expected_text,
        CAST(d.counted_cash AS TEXT) AS counted_text, CAST(d.variance AS TEXT) AS variance_text,
        d.note, d.store_name_snapshot, d.store_address_snapshot
      FROM day_closings d LEFT JOIN users u ON u.id = d.closed_by
      WHERE d.business_date = ? AND d.currency_code = ? AND (? = 1 OR d.closed_by = ?)
      ORDER BY d.id DESC LIMIT 1
    `).get(businessDate, currencyCode, scopeAll, scopeId) as {
      id: number; closing_number: string; business_date: string; opened_at: string; closed_at: string
      closed_by: string; currency_code: string; sales_text: string; returns_text: string; expected_text: string
      counted_text: string; variance_text: string; note: string; store_name_snapshot: string
      store_address_snapshot: string
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

  /**
   * The day's shifts, asked of the service that closes them.
   *
   * Reading `cashier_shifts` here would mean a second spelling of what a drawer should have held, and an open shift's
   * `expected_cash` column is NULL until somebody closes it — so the naive read does not merely duplicate the rule, it
   * reports a zero that looks like a counted empty drawer.
   */
  private readShifts(
    businessDate: string,
    currencyCode: string,
    accountId: string | null,
  ): CashierShiftReportRow[] {
    return this.reports.shiftRowsForDay(businessDate, currencyCode, accountId)
  }

  /**
   * The day's payment totals tied to the cash that was counted.
   *
   * Which counted figure applies depends on what is being audited: a single till is counted on its shift, and a whole
   * store is counted on the day close. Both are the same idea — money the shop expected against money somebody actually
   * held — and the expectation is the shared formula in `cash-drawer`, not a fourth spelling of it.
   */
  private tieCash(
    businessDate: string,
    currencyCode: string,
    scopeAll: number,
    scopeId: string,
    dayClose: DayCloseRecord | null,
    shifts: CashierShiftReportRow[],
    debtorPayments: AuditDebtorPaymentRow[],
  ): AuditCashTie {
    const openingRows = this.database.prepare(`
      SELECT CAST(opening_float AS TEXT) AS amount_text FROM cashier_shifts
      WHERE currency_code = ? AND date(opened_at, 'localtime') = ? AND (? = 1 OR cashier_id = ?)
    `).all(currencyCode, businessDate, scopeAll, scopeId) as Array<{ amount_text: string }>
    const openingFloatMinor = openingRows.reduce((sum, row) => sum + BigInt(row.amount_text), 0n)
    const cashSalesRows = this.database.prepare(`
      SELECT CAST(p.amount AS TEXT) AS amount_text
      FROM payments p JOIN sales s ON s.id = p.sale_id
      WHERE p.sale_id IS NOT NULL AND p.currency_code = ? AND p.payment_method = 'CASH' AND s.status = 'COMPLETED'
        AND date(s.created_at, 'localtime') = ? AND (? = 1 OR s.cashier_id = ?)
    `).all(currencyCode, businessDate, scopeAll, scopeId) as Array<{ amount_text: string }>
    const cashSalesMinor = cashSalesRows.reduce((sum, row) => sum + BigInt(row.amount_text), 0n)
    const cashRefundRows = this.database.prepare(`
      SELECT CAST(p.amount AS TEXT) AS amount_text
      FROM payments p JOIN returns r ON r.id = p.return_id
      WHERE p.return_id IS NOT NULL AND p.currency_code = ? AND p.payment_method = 'REFUND_CASH'
        AND r.status = 'COMPLETED' AND date(r.created_at, 'localtime') = ? AND (? = 1 OR r.cashier_id = ?)
    `).all(currencyCode, businessDate, scopeAll, scopeId) as Array<{ amount_text: string }>
    const cashRefundsMinor = cashRefundRows.reduce((sum, row) => sum + BigInt(row.amount_text), 0n)
    const eventRows = this.database.prepare(`
      SELECT event_type, CAST(amount AS TEXT) AS amount_text FROM cash_drawer_events
      WHERE currency_code = ? AND date(created_at, 'localtime') = ? AND (? = 1 OR user_id = ?)
    `).all(currencyCode, businessDate, scopeAll, scopeId) as Array<{ event_type: string; amount_text: string }>
    const drawerAdjustmentsMinor = eventRows.reduce(
      (sum, row) => sum + drawerAdjustmentSigned(row.event_type, BigInt(row.amount_text)), 0n)
    const debtorCashMinor = debtorPayments
      .filter((payment) => payment.paymentMethod === 'CASH')
      .reduce((sum, payment) => sum + payment.amountMinor, 0n)
    const expectedCashMinor = expectedDrawerCash({
      openingFloatMinor, cashSalesMinor, cashRefundsMinor, drawerAdjustmentsMinor, debtorCashMinor,
    })
    // A till is counted on its shift; the store is counted on the day close. Whichever applies, an uncounted drawer is
    // reported as uncounted rather than as a difference of zero, because "no difference" and "nobody counted" are not
    // the same sentence and only one of them is reassuring.
    const countedCashMinor = scopeAll === 1
      ? dayClose?.countedCashMinor ?? null
      : shifts.reduce<bigint | null>(
        (sum, shift) => (shift.countedCashMinor === null ? sum : (sum ?? 0n) + shift.countedCashMinor), null)
        ?? dayClose?.countedCashMinor ?? null
    const differenceMinor = countedCashMinor === null ? null : countedCashMinor - expectedCashMinor
    return {
      currencyCode,
      openingFloatMinor,
      cashSalesMinor,
      cashRefundsMinor,
      drawerAdjustmentsMinor,
      debtorCashMinor,
      expectedCashMinor,
      countedCashMinor,
      differenceMinor,
      counted: countedCashMinor !== null,
      closedByName: dayClose?.closedBy ?? '',
      closedAt: dayClose?.closedAt ?? '',
      differs: differenceMinor !== null && differenceMinor !== 0n,
    }
  }

  private readAccountOptions(businessDate: string, currencyCode: string): AuditAccountOption[] {
    const rows = this.database.prepare(`
      SELECT account_id, SUM(transactions) AS transactions, CAST(SUM(sales_minor) AS TEXT) AS sales_text
      FROM (
        SELECT s.cashier_id AS account_id, 1 AS transactions, s.total AS sales_minor
        FROM sales s
        WHERE s.status = 'COMPLETED' AND s.currency_code = ? AND date(s.created_at, 'localtime') = ?
          AND s.cashier_id IS NOT NULL
        UNION ALL
        SELECT cs.cashier_id, 0, 0 FROM cashier_shifts cs
        WHERE cs.currency_code = ? AND date(cs.opened_at, 'localtime') = ?
        UNION ALL
        SELECT dp.received_by, 0, 0 FROM debtor_payments dp
        WHERE dp.currency_code = ? AND dp.business_date = ?
      )
      GROUP BY account_id ORDER BY account_id
    `).all(currencyCode, businessDate, currencyCode, businessDate, currencyCode, businessDate) as Array<{
      account_id: string; transactions: number; sales_text: string
    }>
    return rows.map((row) => ({
      id: row.account_id,
      name: this.personName(row.account_id),
      username: this.personUsername(row.account_id),
      transactions: row.transactions,
      salesMinor: BigInt(row.sales_text ?? '0'),
    }))
  }

  private saleRow(
    sale: SaleLedgerRow,
    payments: Array<{ sale_id: number; method: string; amount_text: string }>,
  ): AuditSaleRow {
    const methods = payments.filter((payment) => payment.sale_id === sale.sale_id)
    return {
      saleId: sale.sale_id,
      receiptNumber: sale.receipt_number,
      time: sale.clock_time,
      cashierName: sale.cashier_name,
      saleType: sale.sale_type === 'WHOLESALE' ? 'WHOLESALE' : 'RETAIL',
      grossMinor: BigInt(sale.subtotal_text),
      discountMinor: BigInt(sale.discount_text),
      totalMinor: BigInt(sale.total_text),
      // Sorted, because "CASH + TRANSFER" and "TRANSFER + CASH" are the same fact and an audit screen that shows them
      // differently on two reads of the same day is a screen nobody can compare with a receipt.
      paymentMethods: [...new Set(methods.map((payment) => payment.method))].sort().join(' + '),
      creditMinor: BigInt(sale.credit_text),
      customerName: sale.customer_name,
      orderNumber: sale.order_id ? this.readOrderNumber(sale.order_id) : '',
    }
  }

  private readOrderNumber(orderId: string): string {
    const row = this.database.prepare('SELECT order_number FROM orders WHERE id = ?').get(orderId) as
      { order_number: string } | undefined
    return row?.order_number ?? ''
  }

  // ------------------------------------------------------------------ checks

  /**
   * The automatic checks, delegated.
   *
   * The rules themselves live in `audit-checks.ts` and are shared with the browser preview, so there is one spelling of
   * "serious" in this product rather than one per caller. What is left here is the translation: ledger rows in the
   * database's own snake_case vocabulary in, the checks' own vocabulary out, plus the one check that needs a query.
   */
  private runChecks(parts: {
    businessDate: string
    currency: ReportHeader['currency']
    display: ReportHeader['display']
    sales: SaleLedgerRow[]
    voids: AuditVoidRow[]
    discounts: AuditDiscountRow[]
    reprints: AuditReprintRow[]
    cashTie: AuditCashTie
    edition: Edition
    accountId: string | null
  }): AuditFinding[] {
    const edited: OrderEditedAfterAttempt[] =
      this.readOrdersEditedAfterPaymentAttempt(parts.businessDate, parts.accountId)
    return runAuditChecks({
      currency: parts.currency,
      display: parts.display,
      sales: parts.sales.map((sale) => ({
        receiptNumber: sale.receipt_number,
        clockTime: sale.clock_time,
        totalMinor: BigInt(sale.total_text),
      })),
      voids: parts.voids,
      discounts: parts.discounts,
      reprints: parts.reprints,
      cashTie: parts.cashTie,
      ordersEditedAfterPaymentAttempt: edited,
    })
  }

  /**
   * A line adjusted after the till had already tried to take the money.
   *
   * Read from `order_events`, which migration 16 made immutable: an adjustment after a refused payment is the shape of
   * somebody bringing a total down to a figure the customer would approve, or to one their own permission allows. The
   * refusal itself is an event in the same log, so the two are compared where neither can be edited.
   */
  private readOrdersEditedAfterPaymentAttempt(
    businessDate: string,
    accountId: string | null,
  ): Array<{ orderNumber: string; summary: string }> {
    const rows = this.database.prepare(`
      SELECT o.order_number, adj.created_at AS adjusted_at, att.created_at AS attempted_at,
        COALESCE(NULLIF(adj.detail, ''), 'line adjusted') AS adjustment,
        COALESCE(NULLIF(att.detail, ''), 'payment refused') AS attempt
      FROM order_events adj
        JOIN order_events att ON att.order_id = adj.order_id AND att.event = 'order.payment_refused'
        JOIN orders o ON o.id = adj.order_id
      WHERE adj.event = 'order.line_adjusted' AND att.created_at <= adj.created_at
        AND date(adj.created_at, 'localtime') = ? AND (? IS NULL OR o.created_by = ?)
      ORDER BY adj.created_at, adj.id
    `).all(businessDate, accountId, accountId) as Array<{
      order_number: string; adjusted_at: string; attempted_at: string; adjustment: string; attempt: string
    }>
    return rows.map((row) => ({
      orderNumber: row.order_number,
      summary: `payment attempt at ${row.attempted_at} (${row.attempt}), then adjusted at ${row.adjusted_at}`
        + ` (${row.adjustment})`,
    }))
  }

  private severityOf(
    code: AuditCheckCode,
    businessDate: string,
    accountId: string | null,
    actor: AuditActor,
    edition: Edition,
  ): AuditFlagSeverity {
    const finding = this.getDayAudit({ businessDate, accountId }, actor, edition)
      .findings.find((candidate) => candidate.code === code)
    return finding?.severity ?? 'NOTE'
  }

  // ------------------------------------------------------------------- flags

  private writeFlag(parts: {
    businessDate: string
    accountId: string | null
    actor: AuditActor
    source: 'MANUAL' | 'AUTOMATIC'
    checkCode: AuditCheckCode | ''
    severity: AuditFlagSeverity
    detail: string
  }): AuditFlagRow {
    return this.database.transaction(() => {
      const existing = parts.source === 'AUTOMATIC'
        ? this.database.prepare(`
            SELECT id, detail FROM audit_flags
            WHERE subject_kind = ? AND subject_id = ? AND source = 'AUTOMATIC' AND check_code = ?
              AND resolved_at IS NULL
              AND ((? IS NULL AND scope_account_id IS NULL) OR scope_account_id = ?)
          `).get(DAY_CLOSE_SUBJECT, parts.businessDate, parts.checkCode, parts.accountId, parts.accountId) as
            { id: string; detail: string } | undefined
        : undefined
      const stamp = `[${this.personName(parts.actor.id)} · ${new Date(this.now()).toISOString()}] ${parts.detail}`
      if (existing) {
        const grown = `${existing.detail}\n${stamp}`
        if (grown.length > FLAG_DETAIL_MAX * 4) {
          throw new Error('This flag has too many notes. Raise a new flag for anything further.')
        }
        this.database.prepare('UPDATE audit_flags SET detail = ?, severity = ? WHERE id = ?')
          .run(grown, parts.severity, existing.id)
        this.audit(parts.actor, 'audit.flag.noted', {
          flagId: existing.id, businessDate: parts.businessDate, checkCode: parts.checkCode,
        })
        return this.readFlagView(existing.id) ?? (() => { throw new Error('The flag could not be read back.') })()
      }
      const id = this.newId()
      this.database.prepare(`
        INSERT INTO audit_flags (id, subject_kind, subject_id, scope_account_id, raised_by, severity, detail,
          source, check_code, business_date, raised_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, DAY_CLOSE_SUBJECT, parts.businessDate, parts.accountId, parts.actor.id, parts.severity, stamp,
        parts.source, parts.checkCode, parts.businessDate, new Date(this.now()).toISOString())
      this.audit(parts.actor, parts.source === 'AUTOMATIC' ? 'audit.check.noted' : 'audit.flag.raised', {
        flagId: id, businessDate: parts.businessDate, checkCode: parts.checkCode, severity: parts.severity,
      })
      return this.readFlagView(id) ?? (() => { throw new Error('The flag could not be read back.') })()
    }).immediate()
  }

  private readFlags(businessDate: string, accountId: string | null): AuditFlagRow[] {
    const rows = this.database.prepare(`
      SELECT f.id FROM audit_flags f
      WHERE f.business_date = ? AND (f.scope_account_id IS NULL OR (? IS NOT NULL AND f.scope_account_id = ?))
      ORDER BY f.raised_at DESC, f.id DESC
    `).all(businessDate, accountId, accountId) as Array<{ id: string }>
    return rows.map((row) => this.readFlagView(row.id)).filter((row): row is AuditFlagRow => row !== null)
  }

  private readFlagRow(flagId: string): {
    id: string; detail: string; business_date: string; check_code: string; resolved_at: string | null
  } | null {
    const row = this.database.prepare(`
      SELECT id, detail, business_date, check_code, resolved_at FROM audit_flags WHERE id = ?
    `).get(flagId) as {
      id: string; detail: string; business_date: string; check_code: string; resolved_at: string | null
    } | undefined
    return row ?? null
  }

  private readFlagView(flagId: string): AuditFlagRow | null {
    const row = this.database.prepare(`
      SELECT f.id, f.source, f.check_code, f.severity, f.detail, f.raised_at, f.resolved_at, f.resolution_note,
        COALESCE(NULLIF(raised.full_name, ''), raised.username, '') AS raised_by_name,
        COALESCE(NULLIF(resolved.full_name, ''), resolved.username, '') AS resolved_by_name
      FROM audit_flags f
        LEFT JOIN users raised ON raised.id = f.raised_by
        LEFT JOIN users resolved ON resolved.id = f.resolved_by
      WHERE f.id = ?
    `).get(flagId) as {
      id: string; source: 'MANUAL' | 'AUTOMATIC'; check_code: string; severity: AuditFlagSeverity; detail: string
      raised_at: string; resolved_at: string | null; resolution_note: string | null
      raised_by_name: string; resolved_by_name: string
    } | undefined
    if (!row) return null
    return {
      id: row.id,
      source: row.source,
      checkCode: (AUDIT_CHECK_CODES as readonly string[]).includes(row.check_code)
        ? row.check_code as AuditCheckCode
        : '',
      severity: row.severity,
      detail: row.detail,
      raisedByName: row.raised_by_name,
      raisedAt: row.raised_at,
      resolvedByName: row.resolved_by_name,
      resolvedAt: row.resolved_at ?? '',
      resolutionNote: row.resolution_note ?? '',
    }
  }

  private readSignOff(businessDate: string, accountId: string | null): AuditSignOffRow | null {
    const row = this.database.prepare(`
      SELECT a.id, a.outcome, a.note, a.signed_at, a.subject_digest,
        COALESCE(NULLIF(u.full_name, ''), u.username, '') AS signed_by_name
      FROM audit_signoffs a LEFT JOIN users u ON u.id = a.signed_by
      WHERE a.subject_kind = ? AND a.subject_id = ?
        AND ((? IS NULL AND a.scope_account_id IS NULL) OR a.scope_account_id = ?)
      ORDER BY a.signed_at DESC, a.id DESC LIMIT 1
    `).get(DAY_CLOSE_SUBJECT, businessDate, accountId, accountId) as {
      id: string; outcome: AuditSignOffOutcome; note: string; signed_at: string; subject_digest: string
      signed_by_name: string
    } | undefined
    if (!row) return null
    return {
      id: row.id,
      outcome: row.outcome,
      note: row.note,
      signedByName: row.signed_by_name,
      signedAt: row.signed_at,
      subjectDigest: row.subject_digest,
      // Overwritten by `getDayAudit`, which is the only caller that has read the day and can therefore say whether the
      // signer was shown this one. The day cannot change — a completed sale cannot be changed and a sign-off cannot be
      // edited — so a mismatch means something outside both of those guarantees moved, and that is worth a sentence on
      // the screen.
      digestMatches: false,
    }
  }

  private digestFor(
    businessDate: string,
    accountId: string | null,
    actor: AuditActor,
    edition: Edition,
  ): string {
    const report = this.getDayAudit({ businessDate, accountId }, actor, edition)
    return auditDigest(report)
  }

  // ------------------------------------------------------------------ plumbing

  private normalizeAccount(accountId: unknown): string | null {
    if (accountId === undefined || accountId === null || accountId === '') return null
    if (typeof accountId !== 'string' || !accountId.trim()) throw new Error('Choose a valid Account to audit.')
    const row = this.database.prepare('SELECT id FROM users WHERE id = ?').get(accountId.trim()) as
      { id: string } | undefined
    if (!row) throw new Error('That Account does not exist.')
    return row.id
  }

  private describeAccount(accountId: string): { id: string; name: string; username: string } {
    return { id: accountId, name: this.personName(accountId), username: this.personUsername(accountId) }
  }

  private personName(userId: string): string {
    const row = this.database.prepare('SELECT full_name, username FROM users WHERE id = ?').get(userId) as
      { full_name: string; username: string } | undefined
    return row?.full_name?.trim() || row?.username || ''
  }

  private personUsername(userId: string): string {
    const row = this.database.prepare('SELECT username FROM users WHERE id = ?').get(userId) as
      { username: string } | undefined
    return row?.username ?? ''
  }

  private returnWindowDays(): number {
    const settings = this.shop.readSettings()
    const days = settings.returnWindowDays
    return typeof days === 'number' && Number.isInteger(days) && days >= 0 ? days : 7
  }

  private refuseFutureDate(businessDate: string): void {
    if (businessDate > localDateString(this.now())) {
      throw new Error('A day that has not happened yet cannot be audited.')
    }
  }

  private audit(actor: AuditActor, action: string, metadata: Record<string, unknown>): void {
    this.shop.appendAudit({
      actor: actor.username,
      action,
      metadata,
      deviceName: '',
      ipAddress: null,
      createdAt: new Date(this.now()).toISOString(),
    })
  }
}

interface PriceChange {
  at: string
  /** Minor units as text, exactly as the audit log recorded them; null when the entry predates this shape. */
  retailOld: string | null
  wholesaleOld: string | null
}

interface LedgerTotals {
  transactions: number
  grossMinor: bigint
  discountsMinor: bigint
  salesMinor: bigint
  paymentsMinor: bigint
  returnsMinor: bigint
  refundsMinor: bigint
}

/**
 * The reconciliation, as a pure function.
 *
 * Exported and pure for one reason: a guard that cannot be tested by taking it away is a guard nobody has proved is
 * doing anything. A test can hand this function two sides that disagree and assert that it says so, which is the only
 * way to know the comparison is real rather than decorative.
 */
export function reconcileAuditTotals(
  rows: {
    sales: Array<{ total_text: string; subtotal_text: string }>
    payments: Array<{ amount_text: string }>
    returns: Array<{ totalMinor: bigint }>
    refunds: Array<{ amount_text: string }>
    discounts: bigint
  },
  ledger: LedgerTotals,
): AuditReconciliation {
  const grossFromRowsMinor = rows.sales.reduce((sum, row) => sum + BigInt(row.subtotal_text), 0n)
  const salesFromRowsMinor = rows.sales.reduce((sum, row) => sum + BigInt(row.total_text), 0n)
  const paymentsFromRowsMinor = rows.payments.reduce((sum, row) => sum + BigInt(row.amount_text), 0n)
  const returnsFromRowsMinor = rows.returns.reduce((sum, row) => sum + row.totalMinor, 0n)
  const refundsFromRowsMinor = rows.refunds.reduce((sum, row) => sum + BigInt(row.amount_text), 0n)
  const pairs: Array<[string, bigint, bigint]> = [
    ['gross sales', grossFromRowsMinor, ledger.grossMinor],
    ['sales', salesFromRowsMinor, ledger.salesMinor],
    ['payments', paymentsFromRowsMinor, ledger.paymentsMinor],
    ['returns', returnsFromRowsMinor, ledger.returnsMinor],
    ['refunds', refundsFromRowsMinor, ledger.refundsMinor],
    ['discounts', rows.discounts, ledger.discountsMinor],
  ]
  const differences: string[] = []
  for (const [name, fromRows, fromLedger] of pairs) {
    if (fromRows !== fromLedger) {
      differences.push(`${name}: the audit shows ${fromRows} and the ledger shows ${fromLedger}`)
    }
  }
  if (rows.sales.length !== ledger.transactions) {
    differences.push(`transactions: the audit shows ${rows.sales.length} and the ledger shows ${ledger.transactions}`)
  }
  return {
    grossFromRowsMinor,
    grossFromLedgerMinor: ledger.grossMinor,
    salesFromRowsMinor,
    salesFromLedgerMinor: ledger.salesMinor,
    transactionsFromRows: rows.sales.length,
    transactionsFromLedger: ledger.transactions,
    paymentsFromRowsMinor,
    paymentsFromLedgerMinor: ledger.paymentsMinor,
    returnsFromRowsMinor,
    returnsFromLedgerMinor: ledger.returnsMinor,
    refundsFromRowsMinor,
    refundsFromLedgerMinor: ledger.refundsMinor,
    discountsFromRowsMinor: rows.discounts,
    discountsFromLedgerMinor: ledger.discountsMinor,
    matches: differences.length === 0,
    differences,
  }
}

/**
 * A hash of the day the signer was shown.
 *
 * Built from the totals and the reconciliation rather than from the rows: a digest over every receipt number would
 * change when a name was spelled differently, and the point of the digest is to notice when the *money* moves. The
 * currency code is part of it, because the same digits in two currencies are two different days.
 */
/**
 * The stored fingerprint of a day.
 *
 * Which figures count as "the same day" is decided in `audit-digest.ts`, where the browser preview can use the very same
 * list; hashing it is this service's business alone, because the value is written to `audit_signoffs` and compared on
 * every later read.
 */
export function auditDigest(report: DailyAuditReport): string {
  return createHash('sha256').update(auditDigestKey(report)).digest('hex')
}

/**
 * The actor's real role, or a refusal.
 *
 * `resolveRole` is the product's one alias rule: a legacy CASHIER row, which upgrades leave in the database on purpose,
 * becomes USER here rather than being rejected as nonsense or, worse, being treated as its own fifth role with
 * capabilities nobody decided on. An actor with no id or no username is not a person and is refused the same way.
 */
function roleOf(actor: AuditActor): 'ADMIN' | 'ACCOUNT' | 'USER' | 'SUPERVISOR' {
  if (!actor || typeof actor.id !== 'string' || !actor.id.trim()
    || typeof actor.username !== 'string' || !actor.username.trim()) {
    throw new Error('A valid signed-in audit user is required.')
  }
  const role = resolveRole(actor.role)
  if (!role) throw new Error('A valid signed-in audit user is required.')
  return role
}

function mayWrite(actor: AuditActor): boolean {
  return can(roleOf(actor), 'write_audit_note')
}

/**
 * Whether this actor may take the audit off the machine.
 *
 * `export_audit` and nothing else. It used to also accept `view_reports`, which reads like a widening but is not one —
 * every caller has already passed `requireAuditor`, so the roles that reach here are ADMIN and SUPERVISOR and both hold
 * `export_audit`. The extra branch could only ever matter if the gate order changed, and then it would matter by letting
 * an ACCOUNT, who may see their own takings but not the shop's audit, export this document.
 */
function mayExport(actor: AuditActor): boolean {
  return can(roleOf(actor), 'export_audit')
}

function requireAuditor(actor: AuditActor): void {
  if (!can(roleOf(actor), 'view_audit')) {
    throw new AuditRefusedError('You do not have permission to audit the day.')
  }
}

function requireNoteWriter(actor: AuditActor): void {
  if (!can(roleOf(actor), 'write_audit_note')) {
    throw new AuditRefusedError('Only a Supervisor or the Admin can write audit notes and sign-offs.')
  }
}

function validateEdition(edition: Edition): void {
  if (!isEdition(edition)) throw new Error('A valid licensed edition is required for the audit.')
}

function normalizeOutcome(value: unknown): AuditSignOffOutcome {
  if (value === 'AUDITED' || value === 'AUDITED_WITH_ISSUES') return value
  throw new Error('Choose either Audited or Audited with issues.')
}

function normalizeSeverity(value: unknown): AuditFlagSeverity {
  if (value === 'NOTE' || value === 'CONCERN' || value === 'SERIOUS') return value
  throw new Error('Choose how serious this flag is.')
}

function normalizeBusinessDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    throw new Error('Choose the day to audit.')
  }
  const trimmed = value.trim()
  const [year, month, day] = trimmed.split('-').map(Number)
  const check = new Date(0)
  check.setUTCHours(0, 0, 0, 0)
  check.setUTCFullYear(year!, month! - 1, day!)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month! - 1 || check.getUTCDate() !== day) {
    throw new Error('Choose a valid day to audit.')
  }
  return trimmed
}

function requiredText(value: unknown, maxLength: number, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Enter ${label} text.`)
  const cleaned = value.trim()
  if (cleaned.length > maxLength) throw new Error(`${capitalize(label)} must be ${maxLength} characters or fewer.`)
  return cleaned
}

function optionalText(value: unknown, maxLength: number, label: string): string {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string') throw new Error(`Enter a valid ${label}.`)
  const cleaned = value.trim()
  if (cleaned.length > maxLength) throw new Error(`${capitalize(label)} must be ${maxLength} characters or fewer.`)
  return cleaned
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function localDateString(timestamp: number): string {
  const date = new Date(timestamp)
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function addDays(value: string, amount: number): string {
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(0)
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCFullYear(year!, month! - 1, day! + amount)
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

/** A JSON object out of a column that may hold anything at all, because it was written by whichever build was running. */
function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** A file-name-safe fragment of a username. Anything unexpected becomes a hyphen rather than a path separator. */
function slugOf(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 40) || 'account'
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(fromIso)
  const to = Date.parse(toIso)
  if (Number.isNaN(from) || Number.isNaN(to)) return 0
  return Math.floor((to - from) / 86_400_000)
}

/** Guard against a total that SQLite could not store, before it is stored. */
export function assertAuditInteger(value: bigint, label: string): void {
  if (value > MAX_SQLITE_INTEGER || value < -MAX_SQLITE_INTEGER) {
    throw new Error(`${label} exceeds the supported integer range.`)
  }
}
