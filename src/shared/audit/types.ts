import type { UserRole } from '../auth/types'
import type { CurrencyDefinition } from '../currency/catalog'
import type { MoneyDisplayOptions } from '../currency/money'
import type { Edition } from '../../editions'
import type { CashierShiftReportRow, DayCloseRecord, ReportHeader } from '../reports/types'

/**
 * The Supervisor's daily audit.
 *
 * Two rules shaped this file more than any other:
 *
 * 1. **Everything here is derived.** Not one figure on the audit screen is stored anywhere: every row is a query over
 *    `sales`, `sale_items`, `payments`, `returns`, `print_log`, `orders`, `order_events`, `day_closings`,
 *    `cashier_shifts` and `debtor_payments`. The only rows this surface writes are the Supervisor's own notes and
 *    sign-off. A second copy of a total is a second chance for it to disagree with the ledger, and the brief requires
 *    the audit to reconcile with the sales ledger to the last unit.
 * 2. **Cost cannot be expressed here.** `AuditTotals` has no cost and no profit field. The brief gives cost and gross
 *    profit to the Admin alone, and a field that is merely `null` for a Supervisor is a field a later change can start
 *    filling in; a field that does not exist cannot leak. The accounting report, where cost is legitimate, keeps it
 *    behind the `see_cost` capability instead.
 */

/**
 * The automatic checks. One list, read by the checks themselves, by the notes that attach to a finding, and by the
 * tests that seed bad data — so a check cannot be renamed here and leave orphaned notes in `audit_flags.check_code`.
 */
export const AUDIT_CHECK_CODES = [
  'CASH_DIFFERENCE',
  'MANY_REPRINTS',
  'MANY_VOIDS',
  'DISCOUNT_ABOVE_THRESHOLD',
  'SALES_AFTER_MIDNIGHT',
  'ORDER_EDITED_AFTER_PAYMENT_ATTEMPT',
] as const

export type AuditCheckCode = (typeof AUDIT_CHECK_CODES)[number]

/** Mirrors the CHECK on `audit_flags.severity`. */
export type AuditFlagSeverity = 'NOTE' | 'CONCERN' | 'SERIOUS'

/** Mirrors the CHECK on `audit_signoffs.outcome` added by migration 19. */
export type AuditSignOffOutcome = 'AUDITED' | 'AUDITED_WITH_ISSUES'

export interface AuditActor {
  id: string
  username: string
  role: UserRole
  fullName?: string
}

export interface DayAuditInput {
  /** YYYY-MM-DD, in the shop's own local time — the same key the reports and the day close use. */
  businessDate: string
  /** Omit to audit the whole store for the day; pass one Account to audit that till. */
  accountId?: string | null
}

/** An Account the Supervisor can pick. Derived from the users who actually appear in the day, never from a list. */
export interface AuditAccountOption {
  id: string
  name: string
  username: string
  transactions: number
  salesMinor: bigint
}

export interface AuditSaleRow {
  saleId: number
  receiptNumber: string
  /** Local clock time, HH:MM:SS — the audit's job includes seeing *when*. */
  time: string
  cashierName: string
  saleType: 'RETAIL' | 'WHOLESALE'
  grossMinor: bigint
  discountMinor: bigint
  totalMinor: bigint
  /** Derived from this sale's own `payments` rows, in the order they were taken. */
  paymentMethods: string
  creditMinor: bigint
  customerName: string
  orderNumber: string
}

/**
 * A sale in VOIDED status.
 *
 * Nothing in this product writes that status: migration 3's `completed_sales_cannot_be_changed` trigger refuses any
 * UPDATE to a COMPLETED sale, so a finished sale is reversed by a *return*, never by a void, and the status exists in
 * the CHECK constraint for a DRAFT that was abandoned. The section is read anyway and is expected to be empty — an
 * audit screen that cannot show a void is an audit screen that would hide one if a future build ever allowed it.
 */
export interface AuditVoidRow {
  saleId: number
  receiptNumber: string
  cashierName: string
  status: string
  totalMinor: bigint
  at: string
}

/**
 * A line charged at something other than the catalogue price for its tier.
 *
 * Derived by comparing `sale_items.unit_price` with the product's own price at the tier the line was sold on. There is
 * no override column to read, and adding one would only describe sales made after this phase: comparing the two prices
 * finds every override that has ever been recorded, including the ones made before the audit existed.
 */
export interface AuditOverrideRow {
  saleId: number
  receiptNumber: string
  cashierName: string
  productName: string
  sku: string
  priceTier: string
  cataloguePriceMinor: bigint
  chargedPriceMinor: bigint
  differenceMinor: bigint
  direction: 'BELOW_CATALOGUE' | 'ABOVE_CATALOGUE'
  quantityMilli: bigint
  /**
   * True when this product's price was changed after the sale was rung up.
   *
   * The comparison can only be against the catalogue as it stands today, because nothing in this product keeps a
   * product's price history as a table. What it does keep is the audit log, which records every `product.updated` with
   * the price before and the price after — so this mark is derived from an actual price change and not from
   * `products.updated_at`, a column that moves when somebody corrects a spelling and would excuse an override that
   * nobody caused. Saying so on the row is what keeps the section an audit rather than an accusation.
   */
  catalogueChangedSince: boolean
}

export interface AuditDiscountRow {
  saleId: number
  receiptNumber: string
  cashierName: string
  grossMinor: bigint
  discountMinor: bigint
  /** The discount as basis points of the line's own gross, so a cap can be compared with it. */
  basisPoints: bigint
  /** The cap that applied to this sale: the tighter of the cashier's permission and the shop setting. */
  capBasisPoints: bigint
  capSource: 'USER_PERMISSION' | 'SHOP_SETTINGS'
  /** At or above `DISCOUNT_NEAR_CAP_BASIS_POINTS` of the cap — worth a look, not yet a finding. */
  nearCap: boolean
  aboveCap: boolean
}

export interface AuditReprintRow {
  documentKind: 'SALE' | 'ORDER' | 'RETURN' | 'REPORT'
  documentId: string
  receiptNumber: string
  copyNo: number
  printedByName: string
  printedAt: string
  reason: string
  clientDeviceName: string
}

export interface AuditReturnRow {
  returnId: number
  returnNumber: string
  saleReceiptNumber: string
  cashierName: string
  approvedByName: string
  totalMinor: bigint
  refundMethods: string
  at: string
  /** Past the shop's own return window — a return the Supervisor should read twice. */
  outsideWindow: boolean
}

export interface AuditCreditSaleRow {
  saleId: number
  receiptNumber: string
  customerName: string
  cashierName: string
  creditMinor: bigint
  customerBalanceMinor: bigint
  creditLimitMinor: bigint
  at: string
}

export interface AuditDebtorPaymentRow {
  paymentNumber: string
  customerName: string
  receivedByName: string
  paymentMethod: 'CASH' | 'TRANSFER' | 'CARD'
  amountMinor: bigint
  balanceBeforeMinor: bigint
  balanceAfterMinor: bigint
  reference: string
  at: string
}

export interface AuditOrderRow {
  orderId: string
  orderNumber: string
  status: 'CANCELLED' | 'EXPIRED'
  pickedByName: string
  totalMinor: bigint
  at: string
  reason: string
}

export interface AuditPaymentMethodTotal {
  method: string
  transactions: number
  salesMinor: bigint
  refundsMinor: bigint
  netMinor: bigint
}

/**
 * The day's payment totals tied to the cash that was counted.
 *
 * `expectedCashMinor` is built the same way the day close builds it, plus anything the close does not know about — a
 * debtor payment taken in cash is money in the drawer that is not a sale, and leaving it out would make an honest
 * Account look short by exactly what they collected for the shop.
 */
export interface AuditCashTie {
  currencyCode: string
  openingFloatMinor: bigint
  cashSalesMinor: bigint
  cashRefundsMinor: bigint
  drawerAdjustmentsMinor: bigint
  debtorCashMinor: bigint
  expectedCashMinor: bigint
  countedCashMinor: bigint | null
  differenceMinor: bigint | null
  counted: boolean
  closedByName: string
  closedAt: string
  /** True when a counted figure exists and does not equal the expectation. This is what raises CASH_DIFFERENCE. */
  differs: boolean
}

/**
 * What a check found. Findings are computed on every read and are not stored, so they cannot go stale; the Supervisor's
 * *note* on a finding is stored in `audit_flags` with `source = 'AUTOMATIC'` and the finding's `code`.
 */
export interface AuditFinding {
  code: AuditCheckCode
  severity: AuditFlagSeverity
  headline: string
  detail: string
  /** How many things triggered it — one sale after midnight, or forty reprints. */
  count: number
  amountMinor: bigint | null
}

export interface AuditFlagRow {
  id: string
  source: 'MANUAL' | 'AUTOMATIC'
  checkCode: AuditCheckCode | ''
  severity: AuditFlagSeverity
  detail: string
  raisedByName: string
  raisedAt: string
  resolvedByName: string
  resolvedAt: string
  resolutionNote: string
}

export interface AuditSignOffRow {
  id: string
  outcome: AuditSignOffOutcome
  note: string
  signedByName: string
  signedAt: string
  subjectDigest: string
  /**
   * False when the day the signer was shown is not the day that is there now. A sign-off cannot be edited and neither
   * can a completed sale, so this should never be false — which is exactly why it is reported rather than assumed.
   */
  digestMatches: boolean
}

/**
 * The reconciliation the brief demands: "audit totals reconcile with the sales ledger … to the last unit".
 *
 * The two sides are computed by different routes on purpose — one by summing the rows the audit is about to show, one
 * by an aggregate over the ledger tables — because comparing a total with itself proves nothing.
 */
export interface AuditReconciliation {
  grossFromRowsMinor: bigint
  grossFromLedgerMinor: bigint
  salesFromRowsMinor: bigint
  salesFromLedgerMinor: bigint
  transactionsFromRows: number
  transactionsFromLedger: number
  paymentsFromRowsMinor: bigint
  paymentsFromLedgerMinor: bigint
  returnsFromRowsMinor: bigint
  returnsFromLedgerMinor: bigint
  refundsFromRowsMinor: bigint
  refundsFromLedgerMinor: bigint
  discountsFromRowsMinor: bigint
  discountsFromLedgerMinor: bigint
  matches: boolean
  /** Which of the pairs disagreed, in words, so a failure says what to look at rather than only that it failed. */
  differences: string[]
}

export interface AuditTotals {
  grossSalesMinor: bigint
  totalSalesMinor: bigint
  netSalesMinor: bigint
  transactions: number
  retailMinor: bigint
  retailTransactions: number
  wholesaleMinor: bigint
  wholesaleTransactions: number
  discountsMinor: bigint
  returnsMinor: bigint
  returnTransactions: number
  refundsMinor: bigint
  creditSalesMinor: bigint
  creditTransactions: number
  debtorPaymentsMinor: bigint
  debtorPaymentTransactions: number
  voids: number
  overrides: number
  reprints: number
  cancelledOrders: number
  expiredOrders: number
}

export interface DailyAuditReport {
  header: ReportHeader
  businessDate: string
  currencyCode: string
  edition: Edition
  /** Null when the whole store is being audited. */
  account: { id: string; name: string; username: string } | null
  accounts: AuditAccountOption[]
  totals: AuditTotals
  sales: AuditSaleRow[]
  voids: AuditVoidRow[]
  overrides: AuditOverrideRow[]
  discounts: AuditDiscountRow[]
  reprints: AuditReprintRow[]
  returns: AuditReturnRow[]
  creditSales: AuditCreditSaleRow[]
  debtorPayments: AuditDebtorPaymentRow[]
  orders: AuditOrderRow[]
  paymentMethods: AuditPaymentMethodTotal[]
  cashTie: AuditCashTie
  dayClose: DayCloseRecord | null
  /** Supermarket shifts for the day, each with its own over/short. Empty where the licence has no supermarket. */
  shifts: CashierShiftReportRow[]
  findings: AuditFinding[]
  /** Every check that ran, so a clean day can say "six checks, nothing found" rather than showing nothing at all. */
  checksRun: AuditCheckCode[]
  flags: AuditFlagRow[]
  signOff: AuditSignOffRow | null
  reconciliation: AuditReconciliation
  /** Derived from the actor's capabilities, so the screen offers nothing the server would refuse. */
  canSignOff: boolean
  canNote: boolean
  canExport: boolean
}

export interface SignOffDayInput {
  businessDate: string
  accountId?: string | null
  outcome: AuditSignOffOutcome
  note?: string
}

export interface RaiseAuditFlagInput {
  businessDate: string
  accountId?: string | null
  severity: AuditFlagSeverity
  detail: string
}

/**
 * A note against one of the automatic checks.
 *
 * The check itself is not stored and cannot be edited: this records the human response to it, keyed by the check's code,
 * which is why the same check on the same day and the same till appends to one open flag rather than starting a second.
 */
export interface AuditNoteFindingInput {
  businessDate: string
  accountId?: string | null
  code: AuditCheckCode
  /** Omit to take the severity the check itself gave the finding. */
  severity?: AuditFlagSeverity
  detail: string
}

export interface AuditFlagNoteInput {
  flagId: string
  detail: string
}

export interface ResolveAuditFlagInput {
  flagId: string
  resolutionNote: string
}

export interface UnauditedDay {
  businessDate: string
  /** Null when the day has activity that belongs to no one Account. */
  accountId: string | null
  accountName: string
  transactions: number
  salesMinor: bigint
  currencyCode: string
  openFlags: number
  /** True once somebody has counted the cash, which is normally what makes a day ready to audit. */
  dayClosed: boolean
}

export interface AuditDayStatus {
  businessDate: string
  accountId: string | null
  accountName: string
  audited: boolean
  outcome: AuditSignOffOutcome | null
  signedByName: string
  signedAt: string
  openFlags: number
  /** What happened on the day, so a list of unaudited days says which of them matters. */
  transactions: number
  salesMinor: bigint
  currencyCode: string
  dayClosed: boolean
}

export interface AuditSummaryForPhone {
  unauditedDays: UnauditedDay[]
  openFlags: Array<{
    id: string
    businessDate: string
    severity: AuditFlagSeverity
    detail: string
    raisedByName: string
    raisedAt: string
  }>
  auditedDays: AuditDayStatus[]
}

/**
 * The audit as a file.
 *
 * There is deliberately no PDF. A PDF is a document — something to be printed, signed and handed over — and an audit is
 * neither a receipt nor a certificate: the attestation is the immutable `audit_signoffs` row in the database, and a
 * picture of it could be edited without the row changing. CSV and Excel are data the Admin keeps and can re-check, which
 * is what this export is for.
 */
export interface AuditExportInput {
  businessDate: string
  accountId?: string | null
  format: 'CSV' | 'EXCEL'
}

/** What an export hands back. Both formats arrive base64-encoded, so the renderer has one decoding path. */
export interface AuditExportResult {
  format: 'CSV' | 'EXCEL'
  contentBase64: string
  fileName: string
  mimeType: string
  storeName: string
  currencyCode: string
}

/**
 * How close to its cap a discount has to be to be called "near" it.
 *
 * Basis points of the cap itself, not of the sale: a cashier allowed 5% who gives 4.75% is as worth a look as one
 * allowed 20% who gives 19%, and a flat money figure would call the first trivial and the second enormous. Exported so
 * a test derives the threshold from here instead of restating it — a restated threshold is one that keeps passing after
 * the real one has moved.
 */
export const DISCOUNT_NEAR_CAP_BASIS_POINTS = 9_000n

/** How many reprints in one day, for one Account, stop being normal and become a finding. */
export const REPRINT_FINDING_THRESHOLD = 3

/** How many voided sales in one day stop being normal and become a finding. */
export const VOID_FINDING_THRESHOLD = 1

/**
 * The end of the "after midnight" band, as an hour of the local clock.
 *
 * The shop's trading hours are not a setting anywhere in this product, so there is no source to derive a closing time
 * from. What the check is really asking is "was this rung up in the small hours, when nobody was supposed to be
 * selling?", and a sale before 5am answers that in every shop this product is sold to. One constant, in one place, and
 * the tests read it from here.
 */
export const AFTER_MIDNIGHT_CUTOFF_HOUR = 5

export interface AuditHeaderParts {
  storeName: string
  storeAddress: string
  currency: CurrencyDefinition
  display: MoneyDisplayOptions
}
