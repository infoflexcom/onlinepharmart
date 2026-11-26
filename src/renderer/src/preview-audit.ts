/**
 * The browser preview's copy of the daily audit.
 *
 * In memory, like everything else in `preview-bridge.ts`, and built to the same shapes the licensed Server returns so
 * that the audit screen can be looked at — clicked through, signed off, flagged — without a licence and without a
 * database. Three rules kept this honest rather than approximate:
 *
 * 1. **The checks are the product's checks.** `runAuditChecks` is imported from the service layer, not re-spelled here,
 *    so a threshold moved in one place moves the preview too. Same for the discount cap (`resolveDiscountCap`) and the
 *    drawer expectation (`expectedDrawerCash`).
 * 2. **The refusals use the service's own words.** A preview that said "not allowed in the demo" would teach the wrong
 *    thing about who may audit a day; it says what the Server says.
 * 3. **It does not pretend to have data it does not.** There is no print log with reasons, no order-event history and no
 *    product-price audit log in a tab, so the sections that need them are built from what the preview does keep and the
 *    gaps are named in comments rather than papered over with invented rows.
 *
 * The one place this file knowingly differs from the Server is the sign-off fingerprint: the Server stores a sha256 of
 * `auditDigestKey(report)`, and the preview compares the key itself. Same fields, same meaning, no hashing — the
 * renderer has no synchronous sha256 and a hash would buy nothing in a demo that never leaves the tab.
 */
import type { PublicUser } from '@shared/auth/types'
import type { ShopSettings } from '@shared/shop/types'
import type { CurrencyDefinition } from '@shared/currency/catalog'
import type { Edition } from '../../editions'
import { isEditionEnabled } from '../../editions'
import { can, resolveRole } from '../../../packages/core/src/index'
import type {
  AuditAccountOption,
  AuditCashTie,
  AuditCheckCode,
  AuditDayStatus,
  AuditDebtorPaymentRow,
  AuditDiscountRow,
  AuditFlagRow,
  AuditFlagSeverity,
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
  UnauditedDay,
} from '@shared/audit/types'
import { AUDIT_CHECK_CODES, DISCOUNT_NEAR_CAP_BASIS_POINTS } from '@shared/audit/types'
import type { PosCustomerRecord, PosReceiptRecord } from '@shared/pos/types'
import type { ReturnRecord } from '@shared/returns/types'
import type { CashierShiftReportRow, DayCloseRecord, ReportHeader } from '@shared/reports/types'
import type { ProductRecord } from '@shared/inventory/types'
import { runAuditChecks } from '../../services/audit-checks'
import { auditDigestKey } from '../../services/audit-digest'
import { expectedDrawerCash } from '../../services/cash-drawer'
import { actorDiscountBasisPoints, resolveDiscountCap, shopDiscountLimit } from '../../services/discount-cap'

/** What the preview needs from the bridge's own state, read lazily so the audit always sees the day as it now stands. */
export interface PreviewAuditSources {
  receipts(): PosReceiptRecord[]
  returns(): ReturnRecord[]
  shifts(): CashierShiftReportRow[]
  /** Keyed `businessDate:currencyCode`, exactly as the bridge stores them. */
  dayCloses(): Map<string, DayCloseRecord>
  customers(): PosCustomerRecord[]
  products(): ProductRecord[]
  /** Cancelled and expired orders, already in the audit's own shape. */
  orders(): AuditOrderRow[]
  users(): PublicUser[]
  settings(): ShopSettings
  edition(): Edition
}

interface PreviewSignOff extends AuditSignOffRow {
  businessDate: string
  accountId: string | null
  /** The preview's fingerprint: the digest key itself, not a hash of it. */
  key: string
}

interface PreviewFlag extends AuditFlagRow {
  businessDate: string
  accountId: string | null
}

export interface PreviewAudit {
  getDayAudit(input: DayAuditInput, viewer: PublicUser): DailyAuditReport
  dayStatuses(viewer: PublicUser): AuditDayStatus[]
  listUnauditedDays(viewer: PublicUser): UnauditedDay[]
  summaryForPhone(viewer: PublicUser): AuditSummaryForPhone
  signOffDay(input: DayAuditInput & { outcome: AuditSignOffOutcome; note?: string }, viewer: PublicUser): AuditSignOffRow
  noteFinding(input: DayAuditInput & { code: AuditCheckCode; detail: string }, viewer: PublicUser): AuditFlagRow
  raiseFlag(input: DayAuditInput & { severity: AuditFlagSeverity; detail: string }, viewer: PublicUser): AuditFlagRow
  addFlagNote(flagId: string, detail: string, viewer: PublicUser): AuditFlagRow
  resolveFlag(flagId: string, resolutionNote: string, viewer: PublicUser): AuditFlagRow
  /**
   * Called by the preview's own product edit, so that "the catalogue changed after this sale" can be demonstrated at
   * all. Without it the mark would always read No, and the one behaviour that keeps the override section from being an
   * accusation would be invisible in the demo.
   */
  notePriceChange(productId: string, retailOldMinor: bigint, wholesaleOldMinor: bigint): void
  recordDebtorPayment(input: {
    customerId: string
    amountMinor: bigint
    method: 'CASH' | 'TRANSFER' | 'CARD'
    reference?: string
    note?: string
  }, viewer: PublicUser): AuditDebtorPaymentRow
}

const FLAG_DETAIL_MAX = 1_000
const SIGN_OFF_NOTE_MAX = 2_000
const AUDIT_LOOKBACK_DAYS = 30

export function createPreviewAudit(sources: PreviewAuditSources): PreviewAudit {
  const signOffs: PreviewSignOff[] = []
  const flags: PreviewFlag[] = []
  const debtorPayments: AuditDebtorPaymentRow[] = []
  const priceChanges: Array<{ productId: string; at: string; retailOldMinor: bigint; wholesaleOldMinor: bigint }> = []
  let flagSequence = 0
  let paymentSequence = 0

  function requireAuditor(viewer: PublicUser): void {
    if (!can(roleOf(viewer), 'view_audit')) {
      throw new Error('You do not have permission to audit the day.')
    }
  }

  function requireNoteWriter(viewer: PublicUser): void {
    if (!can(roleOf(viewer), 'write_audit_note')) {
      throw new Error('Only a Supervisor or the Admin can write audit notes and sign-offs.')
    }
  }

  function roleOf(viewer: PublicUser) {
    const role = resolveRole(viewer.role)
    if (!role) throw new Error('A valid signed-in audit user is required.')
    return role
  }

  return {
    getDayAudit(input, viewer) {
      requireAuditor(viewer)
      const settings = sources.settings()
      const businessDate = normalizeBusinessDate(input?.businessDate)
      const accountId = normalizeAccount(input?.accountId, sources.users())
      const report = buildReport(businessDate, accountId, viewer, settings, sources, {
        signOffs, flags, debtorPayments, priceChanges,
      })
      // Filled in last, exactly as the Server does: the fingerprint compares the stored one with the day as it reads now.
      const stored = signOffs.find((row) => row.businessDate === businessDate && row.accountId === accountId)
      if (stored) {
        report.signOff = { ...stored, digestMatches: stored.key === auditDigestKey(report) }
      }
      return report
    },

    dayStatuses(viewer) {
      requireAuditor(viewer)
      return statuses(sources, signOffs, flags, AUDIT_LOOKBACK_DAYS)
    },

    listUnauditedDays(viewer) {
      requireAuditor(viewer)
      return statuses(sources, signOffs, flags, AUDIT_LOOKBACK_DAYS)
        .filter((day) => !day.audited)
        .map((day) => ({
          businessDate: day.businessDate,
          accountId: day.accountId,
          accountName: day.accountName,
          transactions: day.transactions,
          salesMinor: day.salesMinor,
          currencyCode: day.currencyCode,
          openFlags: day.openFlags,
          dayClosed: day.dayClosed,
        }))
    },

    summaryForPhone(viewer) {
      requireAuditor(viewer)
      const all = statuses(sources, signOffs, flags, AUDIT_LOOKBACK_DAYS)
      return {
        unauditedDays: all.filter((day) => !day.audited).map((day) => ({
          businessDate: day.businessDate,
          accountId: day.accountId,
          accountName: day.accountName,
          transactions: day.transactions,
          salesMinor: day.salesMinor,
          currencyCode: day.currencyCode,
          openFlags: day.openFlags,
          dayClosed: day.dayClosed,
        })),
        openFlags: flags.filter((flag) => flag.resolvedAt === '').map((flag) => ({
          id: flag.id,
          businessDate: flag.businessDate,
          severity: flag.severity,
          detail: flag.detail,
          raisedByName: flag.raisedByName,
          raisedAt: flag.raisedAt,
        })),
        auditedDays: all.filter((day) => day.audited),
      }
    },

    signOffDay(input, viewer) {
      requireAuditor(viewer)
      requireNoteWriter(viewer)
      const settings = sources.settings()
      const businessDate = normalizeBusinessDate(input?.businessDate)
      const accountId = normalizeAccount(input?.accountId, sources.users())
      const outcome = input?.outcome === 'AUDITED' || input?.outcome === 'AUDITED_WITH_ISSUES'
        ? input.outcome
        : (() => { throw new Error('Choose either Audited or Audited with issues.') })()
      const note = optionalText(input?.note, SIGN_OFF_NOTE_MAX, 'note')
      const existing = signOffs.find((row) => row.businessDate === businessDate && row.accountId === accountId)
      if (existing) {
        throw new Error(`${businessDate} has already been signed off by ${existing.signedByName}. A sign-off cannot be changed.`)
      }
      const report = buildReport(businessDate, accountId, viewer, settings, sources, {
        signOffs, flags, debtorPayments, priceChanges,
      })
      if (outcome === 'AUDITED' && report.findings.length > 0) {
        const headlines = report.findings.map((finding) => finding.headline).join('; ')
        throw new Error(
          `This day has ${report.findings.length} finding${report.findings.length === 1 ? '' : 's'}: ${headlines}.`
          + ' Write a note explaining the verdict, or sign the day off as audited with issues.',
        )
      }
      const row: PreviewSignOff = {
        id: `preview-signoff-${signOffs.length + 1}`,
        outcome,
        note,
        signedByName: viewer.fullName,
        signedAt: new Date().toISOString(),
        subjectDigest: '',
        digestMatches: true,
        businessDate,
        accountId,
        key: auditDigestKey(report),
      }
      // The Server stores a sha256; the preview stores the key it would have hashed, so the field is not left blank.
      row.subjectDigest = row.key
      signOffs.push(row)
      return publicSignOff(row, auditDigestKey(report))
    },

    noteFinding(input, viewer) {
      requireAuditor(viewer)
      requireNoteWriter(viewer)
      const businessDate = normalizeBusinessDate(input?.businessDate)
      const accountId = normalizeAccount(input?.accountId, sources.users())
      if (!(AUDIT_CHECK_CODES as readonly string[]).includes(input?.code as string)) {
        throw new Error('Choose one of the audit checks to note.')
      }
      const detail = requiredText(input?.detail, FLAG_DETAIL_MAX, 'note')
      const severity = severityOf(input.code, businessDate, accountId, viewer, sources, {
        signOffs, flags, debtorPayments, priceChanges,
      })
      return appendToOpenFlag({
        businessDate, accountId, viewer, source: 'AUTOMATIC', checkCode: input.code, severity, detail,
      })
    },

    raiseFlag(input, viewer) {
      requireAuditor(viewer)
      requireNoteWriter(viewer)
      const businessDate = normalizeBusinessDate(input?.businessDate)
      const accountId = normalizeAccount(input?.accountId, sources.users())
      const severity = normalizeSeverity(input?.severity)
      const detail = requiredText(input?.detail, FLAG_DETAIL_MAX, 'flag')
      return appendToOpenFlag({
        businessDate, accountId, viewer, source: 'MANUAL', checkCode: '', severity, detail,
      })
    },

    addFlagNote(flagId, detail, viewer) {
      requireAuditor(viewer)
      requireNoteWriter(viewer)
      const flag = flags.find((candidate) => candidate.id === flagId)
      if (!flag) throw new Error('That flag no longer exists.')
      if (flag.resolvedAt !== '') throw new Error('That flag has already been resolved.')
      const text = requiredText(detail, FLAG_DETAIL_MAX, 'note')
      flag.detail = appendNote(flag.detail, text, viewer.fullName)
      return publicFlag(flag)
    },

    resolveFlag(flagId, resolutionNote, viewer) {
      requireAuditor(viewer)
      requireNoteWriter(viewer)
      const flag = flags.find((candidate) => candidate.id === flagId)
      if (!flag) throw new Error('That flag no longer exists.')
      if (flag.resolvedAt !== '') throw new Error('That flag has already been resolved.')
      flag.resolvedAt = new Date().toISOString()
      flag.resolvedByName = viewer.fullName
      flag.resolutionNote = optionalText(resolutionNote, FLAG_DETAIL_MAX, 'resolution note')
      return publicFlag(flag)
    },

    notePriceChange(productId, retailOldMinor, wholesaleOldMinor) {
      priceChanges.push({ productId, at: new Date().toISOString(), retailOldMinor, wholesaleOldMinor })
    },

    recordDebtorPayment(input, viewer) {
      if (!can(roleOf(viewer), 'record_debtor_payment')) {
        throw new Error('You do not have permission to take a payment against a customer balance.')
      }
      const customer = sources.customers().find((candidate) => candidate.id === input?.customerId)
      if (!customer) throw new Error('That customer no longer exists.')
      const amount = input?.amountMinor ?? 0n
      if (amount <= 0n) throw new Error('A payment must be more than zero.')
      if (customer.balanceMinor <= 0n) {
        throw new Error(`${customer.name} owes nothing, so there is no payment to take.`)
      }
      if (amount > customer.balanceMinor) {
        throw new Error(
          `${customer.name} owes ${previewMoneyText(customer.balanceMinor, sources.settings().currency)}.`
          + ' Taking more than that would leave them in credit, which this product does not do.',
        )
      }
      if (input.method !== 'CASH' && input.method !== 'TRANSFER' && input.method !== 'CARD') {
        throw new Error('Choose how the customer paid.')
      }
      const balanceBefore = customer.balanceMinor
      // The customer record is the bridge's own object, so moving the balance here moves it everywhere the preview shows
      // it — the same single-writer guarantee the Server gets from a transaction and a row version.
      customer.balanceMinor = balanceBefore - amount
      customer.rowVersion += 1
      const row: AuditDebtorPaymentRow = {
        paymentNumber: `DP-${String(++paymentSequence).padStart(8, '0')}`,
        customerName: customer.name,
        receivedByName: viewer.fullName,
        paymentMethod: input.method,
        amountMinor: amount,
        balanceBeforeMinor: balanceBefore,
        balanceAfterMinor: customer.balanceMinor,
        reference: input.reference?.trim() ?? '',
        at: new Date().toISOString(),
      }
      debtorPayments.push(row)
      return structuredClone(row)
    },
  }

  /**
   * One open flag per check, per day, per till — appended to rather than duplicated.
   *
   * The Server expresses this with a partial unique index; the preview expresses it with this lookup, and both exist for
   * the same reason: opening a day six times to look at the same short drawer must not produce six notes.
   */
  function appendToOpenFlag(parts: {
    businessDate: string
    accountId: string | null
    viewer: PublicUser
    source: 'MANUAL' | 'AUTOMATIC'
    checkCode: AuditCheckCode | ''
    severity: AuditFlagSeverity
    detail: string
  }): AuditFlagRow {
    const open = flags.find((flag) => flag.businessDate === parts.businessDate
      && flag.accountId === parts.accountId
      && flag.source === parts.source
      && flag.checkCode === parts.checkCode
      && flag.resolvedAt === '')
    const stamped = appendNote('', parts.detail, parts.viewer.fullName)
    if (open) {
      open.detail = open.detail === '' ? stamped : appendNote(open.detail, parts.detail, parts.viewer.fullName)
      return publicFlag(open)
    }
    const flag: PreviewFlag = {
      id: `preview-flag-${++flagSequence}`,
      source: parts.source,
      checkCode: parts.checkCode,
      severity: parts.severity,
      detail: stamped,
      raisedByName: parts.viewer.fullName,
      raisedAt: new Date().toISOString(),
      resolvedByName: '',
      resolvedAt: '',
      resolutionNote: '',
      businessDate: parts.businessDate,
      accountId: parts.accountId,
    }
    flags.push(flag)
    return publicFlag(flag)
  }
}

// --------------------------------------------------------------------- building the day

interface PreviewAuditState {
  signOffs: PreviewSignOff[]
  flags: PreviewFlag[]
  debtorPayments: AuditDebtorPaymentRow[]
  priceChanges: Array<{ productId: string; at: string; retailOldMinor: bigint; wholesaleOldMinor: bigint }>
}

function buildReport(
  businessDate: string,
  accountId: string | null,
  viewer: PublicUser,
  settings: ShopSettings,
  sources: PreviewAuditSources,
  state: PreviewAuditState,
): DailyAuditReport {
  const edition = sources.edition()
  const currency = settings.currency
  const display = settings.display
  const users = sources.users()
  const userByName = new Map(users.map((user) => [user.fullName, user]))
  const inScope = (cashierName: string): boolean => {
    if (accountId === null) return true
    const cashier = userByName.get(cashierName)
    return cashier?.id === accountId
  }

  const receipts = sources.receipts()
    .filter((receipt) => localDateOf(receipt.createdAt) === businessDate)
    .filter((receipt) => receipt.currency.code === currency.code)
    .filter((receipt) => inScope(receipt.cashier))
  const dayReturns = sources.returns()
    .filter((record) => localDateOf(record.createdAt) === businessDate)
    .filter((record) => record.currency.code === currency.code)
    .filter((record) => inScope(record.cashier))
  const dayShifts = edition !== 'PHARMACY' && isEditionEnabled(edition, 'supermarket')
    ? sources.shifts().filter((shift) => shiftDayOf(shift) === businessDate)
      .filter((shift) => accountId === null || shift.cashierId === accountId)
    : []
  // One close per business date per currency, shop-wide: the Server's day close is an Admin act over the whole store,
  // so scoping to one Account narrows the sales and the drawer but not the close that was counted.
  const dayClose = sources.dayCloses().get(`${businessDate}:${currency.code}`) ?? null
  const dayDebtorPayments = state.debtorPayments
    .filter((payment) => localDateOf(payment.at) === businessDate)
    .filter((payment) => inScope(payment.receivedByName))
  const dayOrders = sources.orders().filter((order) => localDateOf(order.at) === businessDate)
    .filter((order) => accountId === null || inScope(order.pickedByName))

  const sales: AuditSaleRow[] = receipts.map((receipt) => ({
    saleId: receipt.id,
    receiptNumber: receipt.receiptNumber,
    time: localTimeOf(receipt.createdAt),
    cashierName: receipt.cashier,
    saleType: receipt.saleType === 'WHOLESALE' ? 'WHOLESALE' : 'RETAIL',
    grossMinor: receipt.subtotalMinor,
    discountMinor: receipt.discountMinor,
    totalMinor: receipt.totalMinor,
    paymentMethods: paymentMethodsOf(receipt),
    creditMinor: receipt.creditMinor,
    customerName: receipt.customer?.name ?? '',
    orderNumber: '',
  }))

  const products = new Map(sources.products().map((product) => [product.id, product]))
  const overrides = findOverrides(receipts, products, state.priceChanges, businessDate)
  const discounts = findDiscounts(receipts, userByName, settings)
  const reprints = findReprints(receipts)
  const returns = dayReturns.map((record): AuditReturnRow => ({
    returnId: record.id,
    returnNumber: record.returnNumber,
    saleReceiptNumber: record.receiptNumber,
    cashierName: record.cashier,
    approvedByName: record.approvedBy,
    totalMinor: record.totalMinor,
    refundMethods: record.refundMethod ?? '',
    at: localTimeOf(record.createdAt),
    // The preview's return rows carry the window they were judged against and whether it was overridden.
    outsideWindow: record.returnWindowOverride,
  }))
  const creditSales = receipts.filter((receipt) => receipt.creditMinor > 0n).map((receipt) => {
    const customer = receipt.customer?.id
      ? sources.customers().find((candidate) => candidate.id === receipt.customer?.id)
      : undefined
    return {
      saleId: receipt.id,
      receiptNumber: receipt.receiptNumber,
      customerName: receipt.customer?.name ?? '',
      cashierName: receipt.cashier,
      creditMinor: receipt.creditMinor,
      customerBalanceMinor: customer?.balanceMinor ?? 0n,
      creditLimitMinor: customer?.creditLimitMinor ?? 0n,
      at: localTimeOf(receipt.createdAt),
    }
  })
  const voids: AuditVoidRow[] = []

  const paymentMethods = summarizeMethods(receipts, dayReturns)
  const cashTie = tieCash(currency.code, dayShifts, dayClose, dayDebtorPayments)

  const totals: AuditTotals = {
    grossSalesMinor: receipts.reduce((sum, receipt) => sum + receipt.subtotalMinor, 0n),
    totalSalesMinor: receipts.reduce((sum, receipt) => sum + receipt.totalMinor, 0n),
    netSalesMinor: receipts.reduce((sum, receipt) => sum + receipt.totalMinor, 0n)
      - dayReturns.reduce((sum, record) => sum + record.totalMinor, 0n),
    transactions: receipts.length,
    retailMinor: receipts.filter((receipt) => receipt.saleType !== 'WHOLESALE')
      .reduce((sum, receipt) => sum + receipt.totalMinor, 0n),
    retailTransactions: receipts.filter((receipt) => receipt.saleType !== 'WHOLESALE').length,
    wholesaleMinor: receipts.filter((receipt) => receipt.saleType === 'WHOLESALE')
      .reduce((sum, receipt) => sum + receipt.totalMinor, 0n),
    wholesaleTransactions: receipts.filter((receipt) => receipt.saleType === 'WHOLESALE').length,
    discountsMinor: receipts.reduce((sum, receipt) => sum + receipt.discountMinor, 0n),
    returnsMinor: dayReturns.reduce((sum, record) => sum + record.totalMinor, 0n),
    returnTransactions: dayReturns.length,
    refundsMinor: dayReturns.reduce((sum, record) => sum + record.totalMinor, 0n),
    creditSalesMinor: receipts.reduce((sum, receipt) => sum + receipt.creditMinor, 0n),
    creditTransactions: creditSales.length,
    debtorPaymentsMinor: dayDebtorPayments.reduce((sum, payment) => sum + payment.amountMinor, 0n),
    debtorPaymentTransactions: dayDebtorPayments.length,
    voids: voids.length,
    overrides: overrides.length,
    reprints: reprints.length,
    cancelledOrders: dayOrders.filter((order) => order.status === 'CANCELLED').length,
    expiredOrders: dayOrders.filter((order) => order.status === 'EXPIRED').length,
  }

  // Both sides of the tie come from the same in-memory arrays, so this always matches in the preview. That is a property
  // of having one source of truth in a tab, not a claim about the Server, which sums the rows it is about to show and
  // compares them with an independent aggregate over the ledger tables.
  const reconciliation: AuditReconciliation = {
    grossFromRowsMinor: totals.grossSalesMinor,
    grossFromLedgerMinor: totals.grossSalesMinor,
    salesFromRowsMinor: totals.totalSalesMinor,
    salesFromLedgerMinor: totals.totalSalesMinor,
    transactionsFromRows: totals.transactions,
    transactionsFromLedger: totals.transactions,
    paymentsFromRowsMinor: paymentMethods.reduce((sum, row) => sum + (row.netMinor > 0n ? row.netMinor : 0n), 0n),
    paymentsFromLedgerMinor: totals.totalSalesMinor,
    returnsFromRowsMinor: totals.returnsMinor,
    returnsFromLedgerMinor: totals.returnsMinor,
    refundsFromRowsMinor: totals.refundsMinor,
    refundsFromLedgerMinor: totals.refundsMinor,
    discountsFromRowsMinor: totals.discountsMinor,
    discountsFromLedgerMinor: totals.discountsMinor,
    matches: true,
    differences: [],
  }

  const findings = runAuditChecks({
    currency,
    display,
    sales: receipts.map((receipt) => ({
      receiptNumber: receipt.receiptNumber,
      clockTime: localTimeOf(receipt.createdAt),
      totalMinor: receipt.totalMinor,
    })),
    voids,
    discounts,
    reprints,
    cashTie,
    // The preview keeps no order-event history, so this check has nothing to judge. Passing an empty list is the honest
    // version of that; inventing rows would demo a finding the preview cannot actually produce.
    ordersEditedAfterPaymentAttempt: [],
  })

  const accounts: AuditAccountOption[] = users
    .filter((user) => user.role === 'ADMIN' || user.role === 'ACCOUNT' || user.role === 'SUPERVISOR')
    .map((user) => {
      const own = receipts.filter((receipt) => userByName.get(receipt.cashier)?.id === user.id)
      return {
        id: user.id,
        name: user.fullName,
        username: user.username,
        transactions: own.length,
        salesMinor: own.reduce((sum, receipt) => sum + receipt.totalMinor, 0n),
      }
    })
    .filter((account) => accountId === null || account.id === accountId)

  const dayFlags = state.flags
    .filter((flag) => flag.businessDate === businessDate && (accountId === null || flag.accountId === accountId))
    .map((flag) => publicFlag(flag))

  const header: ReportHeader = {
    storeName: settings.profile.name,
    storeAddress: settings.profile.address,
    currency,
    display,
    period: { type: 'DAY', startDate: businessDate, endDate: businessDate, label: businessDate },
    generatedAt: new Date().toISOString(),
    scope: accountId === null ? 'STORE' : 'PERSONAL',
    viewerName: viewer.fullName,
    edition,
  }

  return {
    header,
    businessDate,
    currencyCode: currency.code,
    edition,
    account: accountId === null
      ? null
      : (() => {
        const user = users.find((candidate) => candidate.id === accountId)
        return user ? { id: user.id, name: user.fullName, username: user.username } : null
      })(),
    accounts,
    totals,
    sales,
    voids,
    overrides,
    discounts,
    reprints,
    returns,
    creditSales,
    debtorPayments: dayDebtorPayments.map((payment) => structuredClone(payment)),
    orders: dayOrders.map((order) => structuredClone(order)),
    paymentMethods,
    cashTie,
    dayClose,
    shifts: dayShifts.map((shift) => structuredClone(shift)),
    findings,
    checksRun: [...AUDIT_CHECK_CODES],
    flags: dayFlags,
    signOff: null,
    reconciliation,
    canSignOff: can(roleOfUser(viewer), 'write_audit_note'),
    canNote: can(roleOfUser(viewer), 'write_audit_note'),
    canExport: can(roleOfUser(viewer), 'export_audit'),
  }
}

function severityOf(
  code: AuditCheckCode,
  businessDate: string,
  accountId: string | null,
  viewer: PublicUser,
  sources: PreviewAuditSources,
  state: PreviewAuditState,
): AuditFlagSeverity {
  const report = buildReport(businessDate, accountId, viewer, sources.settings(), sources, state)
  return report.findings.find((finding) => finding.code === code)?.severity ?? 'NOTE'
}

/**
 * Which days exist, and which of them have been attested to.
 *
 * Derived the same way the Server derives it: a day exists if something happened on it, and it is audited if a sign-off
 * covers it. A whole-store sign-off covers every till, which is why the lookup below accepts either.
 */
function statuses(
  sources: PreviewAuditSources,
  signOffs: PreviewSignOff[],
  flags: PreviewFlag[],
  lookbackDays: number,
): AuditDayStatus[] {
  const settings = sources.settings()
  const users = sources.users()
  const userByName = new Map(users.map((user) => [user.fullName, user]))
  const today = localDateOf(new Date().toISOString())
  const days = new Set<string>()
  for (const receipt of sources.receipts()) {
    const date = localDateOf(receipt.createdAt)
    if (date <= today) days.add(date)
  }
  for (const close of sources.dayCloses().values()) days.add(close.businessDate)
  for (const shift of sources.shifts()) {
    const date = shiftDayOf(shift)
    if (date && date <= today) days.add(date)
  }
  const withinLookback = [...days]
    .filter((date) => daysBetween(date, today) <= lookbackDays)
    .sort((left, right) => (left < right ? 1 : left > right ? -1 : 0))

  const rows: AuditDayStatus[] = []
  for (const businessDate of withinLookback) {
    const receipts = sources.receipts().filter((receipt) => localDateOf(receipt.createdAt) === businessDate)
    const byAccount = new Map<string | null, typeof receipts>()
    for (const receipt of receipts) {
      const key = userByName.get(receipt.cashier)?.id ?? null
      const list = byAccount.get(key) ?? []
      list.push(receipt)
      byAccount.set(key, list)
    }
    if (byAccount.size === 0) byAccount.set(null, [])
    for (const [key, own] of byAccount) {
      const account = key === null ? null : users.find((user) => user.id === key) ?? null
      const signOff = signOffs.find((row) => row.businessDate === businessDate
        && (row.accountId === null || row.accountId === key))
      rows.push({
        businessDate,
        accountId: account?.id ?? null,
        accountName: account?.fullName ?? 'Whole store',
        audited: signOff !== undefined,
        outcome: signOff?.outcome ?? null,
        signedByName: signOff?.signedByName ?? '',
        signedAt: signOff?.signedAt ?? '',
        openFlags: flags.filter((flag) => flag.businessDate === businessDate
          && (flag.accountId === null || flag.accountId === key) && flag.resolvedAt === '').length,
        transactions: own.length,
        salesMinor: own.reduce((sum, receipt) => sum + receipt.totalMinor, 0n),
        currencyCode: settings.currency.code,
        dayClosed: sources.dayCloses().has(`${businessDate}:${settings.currency.code}`),
      })
    }
  }
  return rows
}

// --------------------------------------------------------------------- the derived sections

function findOverrides(
  receipts: PosReceiptRecord[],
  products: Map<string, ProductRecord>,
  priceChanges: Array<{ productId: string; at: string; retailOldMinor: bigint; wholesaleOldMinor: bigint }>,
  businessDate: string,
): AuditOverrideRow[] {
  const rows: AuditOverrideRow[] = []
  for (const receipt of receipts) {
    for (const item of receipt.items) {
      const product = products.get(item.productId)
      if (!product) continue
      const wholesale = item.priceTier === 'WHOLESALE'
      const catalogueNow = wholesale ? product.wholesalePriceMinor : product.retailPriceMinor
      // Walked back through the price changes recorded since, exactly as the Server walks back through its audit log: the
      // price on the day is what matters, and an edit that happens to land on the figure the cashier charged must not
      // make the difference disappear.
      let catalogue = catalogueNow
      let changed = false
      for (const change of priceChanges.filter((entry) => entry.productId === item.productId)) {
        if (localDateOf(change.at) < businessDate) continue
        catalogue = wholesale ? change.wholesaleOldMinor : change.retailOldMinor
        changed = true
        break
      }
      const charged = item.unitPriceMinor
      // A promotion is a price the shop set, not one the cashier typed, and it is recorded in its own column.
      if (charged === catalogue || item.promotionDiscountMinor > 0n) continue
      rows.push({
        saleId: receipt.id,
        receiptNumber: receipt.receiptNumber,
        cashierName: receipt.cashier,
        productName: item.description,
        sku: item.sku,
        priceTier: wholesale ? 'WHOLESALE' : 'RETAIL',
        cataloguePriceMinor: catalogue,
        chargedPriceMinor: charged,
        differenceMinor: charged - catalogue,
        direction: charged < catalogue ? 'BELOW_CATALOGUE' : 'ABOVE_CATALOGUE',
        quantityMilli: item.quantityMilli,
        catalogueChangedSince: changed || catalogue !== catalogueNow,
      })
    }
  }
  return rows
}

function findDiscounts(
  receipts: PosReceiptRecord[],
  userByName: Map<string, PublicUser>,
  settings: ShopSettings,
): AuditDiscountRow[] {
  const shopLimit = shopDiscountLimit(settings)
  const rows: AuditDiscountRow[] = []
  for (const receipt of receipts) {
    if (receipt.discountMinor <= 0n || receipt.subtotalMinor <= 0n) continue
    const cashier = userByName.get(receipt.cashier)
    // The cap that applied to the person who gave it, from the same rule module the till refuses against.
    const cap = resolveDiscountCap(
      actorDiscountBasisPoints(cashier?.role ?? 'USER', cashier?.permissions.maxDiscountBasisPoints ?? 0),
      shopLimit,
    )
    const basisPoints = receipt.discountMinor * 10_000n / receipt.subtotalMinor
    const capBasisPoints = BigInt(cap.limitBasisPoints)
    rows.push({
      saleId: receipt.id,
      receiptNumber: receipt.receiptNumber,
      cashierName: receipt.cashier,
      grossMinor: receipt.subtotalMinor,
      discountMinor: receipt.discountMinor,
      basisPoints,
      capBasisPoints,
      capSource: cap.setBy,
      nearCap: basisPoints * 10_000n >= capBasisPoints * DISCOUNT_NEAR_CAP_BASIS_POINTS,
      aboveCap: basisPoints > capBasisPoints,
    })
  }
  return rows
}

function findReprints(receipts: PosReceiptRecord[]): AuditReprintRow[] {
  const rows: AuditReprintRow[] = []
  for (const receipt of receipts) {
    // The first copy is not a duplicate; every copy after it is, which is the rule the print log itself is written to.
    for (let copy = 2; copy <= receipt.printCount; copy += 1) {
      rows.push({
        documentKind: 'SALE',
        documentId: String(receipt.id),
        receiptNumber: receipt.receiptNumber,
        copyNo: copy,
        printedByName: receipt.cashier,
        printedAt: localTimeOf(receipt.createdAt),
        // The preview's receipts carry a copy count and no reason per copy; the Server's print log carries both.
        reason: '',
        clientDeviceName: receipt.workstation,
      })
    }
  }
  return rows
}

function summarizeMethods(receipts: PosReceiptRecord[], returns: ReturnRecord[]): AuditPaymentMethodTotal[] {
  const byMethod = new Map<string, AuditPaymentMethodTotal>()
  const touch = (method: string): AuditPaymentMethodTotal => {
    const existing = byMethod.get(method)
    if (existing) return existing
    const created: AuditPaymentMethodTotal = {
      method, transactions: 0, salesMinor: 0n, refundsMinor: 0n, netMinor: 0n,
    }
    byMethod.set(method, created)
    return created
  }
  for (const receipt of receipts) {
    for (const payment of receipt.payments) {
      const row = touch(payment.method)
      row.transactions += 1
      row.salesMinor += payment.amountMinor
      row.netMinor += payment.amountMinor
    }
    if (receipt.creditMinor > 0n) {
      const row = touch('CREDIT')
      row.transactions += 1
      row.salesMinor += receipt.creditMinor
      row.netMinor += receipt.creditMinor
    }
  }
  for (const record of returns) {
    if (!record.refundMethod || record.totalMinor <= 0n) continue
    const row = touch(`REFUND_${record.refundMethod}`)
    row.transactions += 1
    row.refundsMinor += record.totalMinor
    row.netMinor -= record.totalMinor
  }
  return [...byMethod.values()].sort((left, right) => (left.method < right.method ? -1 : 1))
}

function tieCash(
  currencyCode: string,
  shifts: CashierShiftReportRow[],
  dayClose: DayCloseRecord | null,
  debtorPayments: AuditDebtorPaymentRow[],
): AuditCashTie {
  const openingFloatMinor = shifts.reduce((sum, shift) => sum + shift.openingFloatMinor, 0n)
  const cashSalesMinor = shifts.reduce((sum, shift) => sum + shift.cashSalesMinor, 0n)
  const cashRefundsMinor = shifts.reduce((sum, shift) => sum + shift.cashRefundsMinor, 0n)
  const drawerAdjustmentsMinor = shifts.reduce((sum, shift) => sum + shift.drawerAdjustmentsMinor, 0n)
  const debtorCashMinor = debtorPayments
    .filter((payment) => payment.paymentMethod === 'CASH')
    .reduce((sum, payment) => sum + payment.amountMinor, 0n)
  // The shared formula, not a fourth spelling of the same sum.
  const expectedCashMinor = expectedDrawerCash({
    openingFloatMinor, cashSalesMinor, cashRefundsMinor, drawerAdjustmentsMinor, debtorCashMinor,
  })
  const countedCashMinor = dayClose?.countedCashMinor ?? null
  return {
    currencyCode,
    openingFloatMinor,
    cashSalesMinor,
    cashRefundsMinor,
    drawerAdjustmentsMinor,
    debtorCashMinor,
    expectedCashMinor,
    countedCashMinor,
    differenceMinor: countedCashMinor === null ? null : countedCashMinor - expectedCashMinor,
    counted: countedCashMinor !== null,
    closedByName: dayClose?.closedBy ?? '',
    closedAt: dayClose?.closedAt ?? '',
    differs: countedCashMinor !== null && countedCashMinor !== expectedCashMinor,
  }
}

// --------------------------------------------------------------------- small shared pieces

function roleOfUser(viewer: PublicUser) {
  const role = resolveRole(viewer.role)
  if (!role) throw new Error('A valid signed-in audit user is required.')
  return role
}

function publicSignOff(row: PreviewSignOff, key: string): AuditSignOffRow {
  return {
    id: row.id,
    outcome: row.outcome,
    note: row.note,
    signedByName: row.signedByName,
    signedAt: row.signedAt,
    subjectDigest: row.subjectDigest,
    digestMatches: row.key === key,
  }
}

function publicFlag(flag: PreviewFlag): AuditFlagRow {
  const { businessDate: _businessDate, accountId: _accountId, ...rest } = flag
  void _businessDate
  void _accountId
  return structuredClone(rest)
}

function appendNote(existing: string, detail: string, name: string): string {
  const stamp = `${detail.trim()}\n[${name} · ${new Date().toISOString()}]`
  if (existing === '') return stamp
  const joined = `${existing}\n${stamp}`
  // Capped for the same reason the Server caps it: a flag is a note, not a document, and an unbounded string in a
  // column that a phone renders is how a screen gets pushed off its own footer.
  return joined.length > FLAG_DETAIL_MAX * 4 ? joined.slice(joined.length - FLAG_DETAIL_MAX * 4) : joined
}

function paymentMethodsOf(receipt: PosReceiptRecord): string {
  const methods = new Set<string>(receipt.payments.map((payment) => payment.method))
  if (receipt.creditMinor > 0n) methods.add('CREDIT')
  // Sorted, so the same sale reads the same way twice: a Set's iteration order is insertion order, and "CASH + TRANSFER"
  // must not become "TRANSFER + CASH" because a payment was taken in a different sequence.
  return [...methods].sort().join(' + ')
}

function normalizeBusinessDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error('Choose a business date to audit.')
  }
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) throw new Error('Choose a business date to audit.')
  if (localDateOf(new Date().toISOString()) < value) {
    throw new Error('A day that has not happened yet cannot be audited.')
  }
  return value
}

function normalizeAccount(value: unknown, users: PublicUser[]): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') throw new Error('Choose an Account to audit, or audit the whole store.')
  const user = users.find((candidate) => candidate.id === value)
  if (!user) throw new Error('That Account no longer exists.')
  return user.id
}

function normalizeSeverity(value: unknown): AuditFlagSeverity {
  if (value === 'NOTE' || value === 'CONCERN' || value === 'SERIOUS') return value
  throw new Error('Choose how serious this flag is.')
}

function requiredText(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Enter ${label} text.`)
  const clean = value.trim()
  if (clean.length > max) throw new Error(`${capitalize(label)} must be ${max} characters or fewer.`)
  return clean
}

function optionalText(value: unknown, max: number, label: string): string {
  if (value === undefined || value === null) return ''
  return requiredText(value, max, label)
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function localDateOf(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function localTimeOf(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** A shift belongs to the day it was opened on, which is the day the Server's own queries group it by. */
function shiftDayOf(shift: CashierShiftReportRow): string {
  return localDateOf(shift.openedAt)
}

function daysBetween(fromDate: string, toDate: string): number {
  const from = Date.parse(`${fromDate}T00:00:00`)
  const to = Date.parse(`${toDate}T00:00:00`)
  if (Number.isNaN(from) || Number.isNaN(to)) return 0
  return Math.round((to - from) / 86_400_000)
}

function previewMoneyText(amountMinor: bigint, currency: CurrencyDefinition): string {
  const scale = 10n ** BigInt(currency.decimalPlaces)
  const negative = amountMinor < 0n
  const magnitude = negative ? -amountMinor : amountMinor
  const fraction = currency.decimalPlaces > 0
    ? `.${(magnitude % scale).toString().padStart(currency.decimalPlaces, '0')}`
    : ''
  return `${negative ? '-' : ''}${magnitude / scale}${fraction}`
}
