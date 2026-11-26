/**
 * The daily audit as a document that can leave the shop.
 *
 * Two rules shape this file, and neither is about formatting:
 *
 * 1. **It exports what the caller was shown, and nothing else.** The tables are built from a `DailyAuditReport` that has
 *    already been through the service's own permission gate, so there is no second opinion here about who may see what.
 *    A Supervisor's export has no cost column in it because the report it was built from has no cost in it — not because
 *    this file remembered to leave one out.
 * 2. **It is a file, never a print.** There is deliberately no path from an audit to a printer: an audit is not a
 *    document to hand to a customer, and the one thing that must be impossible from this screen is producing something
 *    that looks like a receipt. The print gate refuses an audit subject independently of anything written here.
 *
 * Money crosses as minor units with a `money` column kind, so Excel holds real numbers in the shop's own decimals and
 * CSV holds the same figures as text with the currency's decimal places — never a float that has already lost a kobo.
 */
import type {
  AuditCheckCode,
  AuditFinding,
  DailyAuditReport,
} from '../shared/audit/types'
import { AUDIT_CHECK_CODES } from '../shared/audit/types'
import type { ExportDocument, ExportTable, ExportValue } from './export-csv'
// The pure half only. `report-export.ts` is reached by a dynamic import inside the Excel writer below, because it pulls
// in `exceljs` and `pdfkit` — and this module is imported by the browser preview, which renders the audit screen and its
// CSV export and has no use for either library. A top-level import here would put both into the renderer's bundle.
import { createDocumentCsv } from './export-csv'

/** What a check is called on paper. The screen shows the same words. */
export const AUDIT_CHECK_TITLES: Readonly<Record<AuditCheckCode, string>> = {
  CASH_DIFFERENCE: 'Counted cash against the day\'s payments',
  MANY_REPRINTS: 'Duplicate prints',
  MANY_VOIDS: 'Sales that were not completed',
  DISCOUNT_ABOVE_THRESHOLD: 'Discounts near or past the cap',
  SALES_AFTER_MIDNIGHT: 'Sales rung up in the small hours',
  ORDER_EDITED_AFTER_PAYMENT_ATTEMPT: 'Orders changed after a payment attempt',
}

/**
 * Every table in the export, in the order a reader wants them.
 *
 * The attestation tables come last and are always present, even when they say "not signed off yet": an export whose
 * length changes with the day would let somebody tell a signed-off day from an unsigned one by its file size, and more
 * importantly would let an empty file pass as a clean audit. A section is omitted only when it would have been an empty
 * table with a heading — the ledger sections — never when its absence could be mistaken for an answer.
 */
export function buildAuditExportTables(report: DailyAuditReport): ExportTable[] {
  const tables: ExportTable[] = [
    daySummaryTable(report),
    paymentMethodsTable(report),
    cashTieTable(report),
  ]
  if (report.sales.length > 0) tables.push(salesTable(report))
  if (report.overrides.length > 0) tables.push(overridesTable(report))
  if (report.discounts.length > 0) tables.push(discountsTable(report))
  if (report.returns.length > 0) tables.push(returnsTable(report))
  if (report.creditSales.length > 0) tables.push(creditSalesTable(report))
  if (report.debtorPayments.length > 0) tables.push(debtorPaymentsTable(report))
  if (report.reprints.length > 0) tables.push(reprintsTable(report))
  if (report.orders.length > 0) tables.push(ordersTable(report))
  if (report.shifts.length > 0) tables.push(shiftsTable(report))
  if (report.voids.length > 0) tables.push(voidsTable(report))
  tables.push(checksTable(report), flagsTable(report), attestationTable(report))
  return tables
}

/** The document the writers render: the audit's own header, in the words the report already carries. */
export function auditExportDocument(report: DailyAuditReport, subject: string): ExportDocument {
  return {
    storeName: report.header.storeName,
    storeAddress: report.header.storeAddress,
    periodLabel: `Daily audit · ${report.businessDate}`,
    currency: { code: report.header.currency.code, decimalPlaces: report.header.currency.decimalPlaces },
    scopeLabel: report.account
      ? `One Account · ${report.account.name}`
      : report.header.scope === 'STORE' ? 'Store-wide' : `Personal · ${report.header.viewerName}`,
    generatedAt: report.header.generatedAt,
    subject,
    tables: buildAuditExportTables(report),
  }
}

export function createAuditCsv(report: DailyAuditReport): string {
  return createDocumentCsv(auditExportDocument(report, 'daily audit'))
}

/**
 * The audit as an Excel workbook, base64-encoded.
 *
 * Loaded on demand for the reason given at the import above: the workbook writer is the heavy half of the export code,
 * and only the licensed desktop host ever asks for it.
 */
export async function createAuditWorkbookBase64(report: DailyAuditReport): Promise<string> {
  const { createDocumentWorkbookBase64 } = await import('./report-export')
  return createDocumentWorkbookBase64(auditExportDocument(report, 'daily audit'))
}

function daySummaryTable(report: DailyAuditReport): ExportTable {
  const totals = report.totals
  return {
    name: 'day-summary',
    title: 'The day in figures',
    columns: [
      { label: 'Gross sales', kind: 'money' },
      { label: 'Discounts', kind: 'money' },
      { label: 'Sales taken', kind: 'money' },
      { label: 'Returns', kind: 'money' },
      { label: 'Refunds paid', kind: 'money' },
      { label: 'Net sales', kind: 'money' },
      { label: 'Retail', kind: 'money' },
      { label: 'Wholesale', kind: 'money' },
      { label: 'Credit sales', kind: 'money' },
      { label: 'Debtor payments', kind: 'money' },
      { label: 'Transactions', kind: 'integer' },
      { label: 'Retail txns', kind: 'integer' },
      { label: 'Wholesale txns', kind: 'integer' },
      { label: 'Returns', kind: 'integer' },
      { label: 'Credit txns', kind: 'integer' },
      { label: 'Not completed', kind: 'integer' },
      { label: 'Price overrides', kind: 'integer' },
      { label: 'Duplicate prints', kind: 'integer' },
      { label: 'Cancelled orders', kind: 'integer' },
      { label: 'Expired orders', kind: 'integer' },
    ],
    rows: [[
      totals.grossSalesMinor, totals.discountsMinor, totals.totalSalesMinor, totals.returnsMinor, totals.refundsMinor,
      totals.netSalesMinor, totals.retailMinor, totals.wholesaleMinor, totals.creditSalesMinor,
      totals.debtorPaymentsMinor, totals.transactions, totals.retailTransactions, totals.wholesaleTransactions,
      totals.returnTransactions, totals.creditTransactions, totals.voids, totals.overrides, totals.reprints,
      totals.cancelledOrders, totals.expiredOrders,
    ]],
  }
}

function paymentMethodsTable(report: DailyAuditReport): ExportTable {
  return {
    name: 'payment-methods',
    title: 'How the day was paid for',
    columns: [
      { label: 'Method', kind: 'text' },
      { label: 'Transactions', kind: 'integer' },
      { label: 'Sales', kind: 'money' },
      { label: 'Refunds', kind: 'money' },
      { label: 'Net', kind: 'money' },
    ],
    // Already in a stable order out of the service; repeated here rather than re-sorted so the file matches the screen.
    rows: report.paymentMethods.map((row) => [
      row.method, row.transactions, row.salesMinor, row.refundsMinor, row.netMinor,
    ]),
  }
}

function cashTieTable(report: DailyAuditReport): ExportTable {
  const tie = report.cashTie
  // Vertical on purpose. The tie is an argument — these figures add up to that one — and an argument reads down a
  // column, not across twenty of them.
  const rows: Array<[string, bigint | null]> = [
    ['Opening float', tie.openingFloatMinor],
    ['Cash sales', tie.cashSalesMinor],
    ['Cash refunds paid out', tie.cashRefundsMinor],
    ['Drawer paid in and paid out', tie.drawerAdjustmentsMinor],
    ['Cash taken against customer balances', tie.debtorCashMinor],
    ['Expected in the drawer', tie.expectedCashMinor],
    ['Counted in the drawer', tie.countedCashMinor],
    ['Difference', tie.differenceMinor],
  ]
  return {
    name: 'cash-tie',
    title: 'The drawer tied to the day',
    columns: [{ label: 'Step', kind: 'text' }, { label: `Amount (${tie.currencyCode})`, kind: 'money' }],
    rows: rows.map(([label, amount]) => [label, amount]),
  }
}

function salesTable(report: DailyAuditReport): ExportTable {
  return {
    name: 'sales',
    title: 'Every sale of the day',
    columns: [
      { label: 'Receipt', kind: 'text' },
      { label: 'Time', kind: 'text' },
      { label: 'Cashier', kind: 'text' },
      { label: 'Type', kind: 'text' },
      { label: 'Paid by', kind: 'text' },
      { label: 'Customer', kind: 'text' },
      { label: 'Order', kind: 'text' },
      { label: 'Gross', kind: 'money' },
      { label: 'Discount', kind: 'money' },
      { label: 'Total', kind: 'money' },
      { label: 'Credit', kind: 'money' },
    ],
    rows: report.sales.map((row) => [
      row.receiptNumber, row.time, row.cashierName, row.saleType === 'WHOLESALE' ? 'Wholesale' : 'Retail',
      row.paymentMethods, row.customerName, row.orderNumber, row.grossMinor, row.discountMinor, row.totalMinor,
      row.creditMinor,
    ]),
  }
}

function overridesTable(report: DailyAuditReport): ExportTable {
  return {
    name: 'price-overrides',
    title: 'Lines charged at something other than the catalogue price',
    columns: [
      { label: 'Receipt', kind: 'text' },
      { label: 'Cashier', kind: 'text' },
      { label: 'Product', kind: 'text' },
      { label: 'SKU', kind: 'text' },
      { label: 'Tier', kind: 'text' },
      { label: 'Quantity', kind: 'quantity' },
      { label: 'Catalogue price', kind: 'money' },
      { label: 'Charged', kind: 'money' },
      { label: 'Difference', kind: 'money' },
      { label: 'Direction', kind: 'text' },
      { label: 'Catalogue changed since', kind: 'text' },
    ],
    rows: report.overrides.map((row) => [
      row.receiptNumber, row.cashierName, row.productName, row.sku,
      row.priceTier === 'WHOLESALE' ? 'Wholesale' : 'Retail', row.quantityMilli, row.cataloguePriceMinor,
      row.chargedPriceMinor, row.differenceMinor,
      row.direction === 'BELOW_CATALOGUE' ? 'Charged below catalogue' : 'Charged above catalogue',
      // The honest wording of a derived mark: the catalogue moved after this sale, which explains a difference and is
      // not the same as saying the cashier caused it.
      row.catalogueChangedSince ? 'Yes — the price was changed after this sale' : 'No',
    ]),
  }
}

function discountsTable(report: DailyAuditReport): ExportTable {
  return {
    name: 'discounts',
    title: 'Discounts, against the cap that applied',
    columns: [
      { label: 'Receipt', kind: 'text' },
      { label: 'Cashier', kind: 'text' },
      { label: 'Gross', kind: 'money' },
      { label: 'Discount', kind: 'money' },
      { label: 'Discount %', kind: 'text' },
      { label: 'Cap %', kind: 'text' },
      { label: 'Cap set by', kind: 'text' },
      { label: 'Past the cap', kind: 'text' },
    ],
    rows: report.discounts.map((row) => [
      row.receiptNumber, row.cashierName, row.grossMinor, row.discountMinor, basisPointsAsPercent(row.basisPoints),
      basisPointsAsPercent(row.capBasisPoints),
      row.capSource === 'USER_PERMISSION' ? 'The cashier\'s own permission' : 'Shop settings',
      row.aboveCap ? 'Yes' : row.nearCap ? 'Close to it' : 'No',
    ]),
  }
}

function returnsTable(report: DailyAuditReport): ExportTable {
  return {
    name: 'returns',
    title: 'Returns and refunds',
    columns: [
      { label: 'Return', kind: 'text' },
      { label: 'Original receipt', kind: 'text' },
      { label: 'Taken by', kind: 'text' },
      { label: 'Approved by', kind: 'text' },
      { label: 'At', kind: 'text' },
      { label: 'Refunded by', kind: 'text' },
      { label: 'Amount', kind: 'money' },
      { label: 'Outside the return window', kind: 'text' },
    ],
    rows: report.returns.map((row) => [
      row.returnNumber, row.saleReceiptNumber, row.cashierName, row.approvedByName, row.at, row.refundMethods,
      row.totalMinor, row.outsideWindow ? 'Yes' : 'No',
    ]),
  }
}

function creditSalesTable(report: DailyAuditReport): ExportTable {
  return {
    name: 'credit-sales',
    title: 'Sales left on a customer\'s account',
    columns: [
      { label: 'Receipt', kind: 'text' },
      { label: 'At', kind: 'text' },
      { label: 'Customer', kind: 'text' },
      { label: 'Cashier', kind: 'text' },
      { label: 'Credit', kind: 'money' },
      { label: 'Balance now', kind: 'money' },
      { label: 'Credit limit', kind: 'money' },
    ],
    rows: report.creditSales.map((row) => [
      row.receiptNumber, row.at, row.customerName, row.cashierName, row.creditMinor, row.customerBalanceMinor,
      row.creditLimitMinor,
    ]),
  }
}

function debtorPaymentsTable(report: DailyAuditReport): ExportTable {
  return {
    name: 'debtor-payments',
    title: 'Customers settling what they owed',
    columns: [
      { label: 'Payment', kind: 'text' },
      { label: 'At', kind: 'text' },
      { label: 'Customer', kind: 'text' },
      { label: 'Taken by', kind: 'text' },
      { label: 'Method', kind: 'text' },
      { label: 'Reference', kind: 'text' },
      { label: 'Balance before', kind: 'money' },
      { label: 'Paid', kind: 'money' },
      { label: 'Balance after', kind: 'money' },
    ],
    rows: report.debtorPayments.map((row) => [
      row.paymentNumber, row.at, row.customerName, row.receivedByName, row.paymentMethod, row.reference,
      row.balanceBeforeMinor, row.amountMinor, row.balanceAfterMinor,
    ]),
  }
}

function reprintsTable(report: DailyAuditReport): ExportTable {
  return {
    name: 'duplicate-prints',
    title: 'Documents printed more than once',
    columns: [
      { label: 'Document', kind: 'text' },
      { label: 'Receipt', kind: 'text' },
      { label: 'Copy', kind: 'integer' },
      { label: 'Printed by', kind: 'text' },
      { label: 'At', kind: 'text' },
      { label: 'From', kind: 'text' },
      { label: 'Reason given', kind: 'text' },
    ],
    rows: report.reprints.map((row) => [
      row.documentKind, row.receiptNumber, row.copyNo, row.printedByName, row.printedAt, row.clientDeviceName,
      row.reason,
    ]),
  }
}

function ordersTable(report: DailyAuditReport): ExportTable {
  return {
    name: 'orders-not-completed',
    title: 'Orders cancelled or expired',
    columns: [
      { label: 'Order', kind: 'text' },
      { label: 'At', kind: 'text' },
      { label: 'Picked by', kind: 'text' },
      { label: 'Status', kind: 'text' },
      { label: 'Amount', kind: 'money' },
      { label: 'Reason', kind: 'text' },
    ],
    rows: report.orders.map((row) => [
      row.orderNumber, row.at, row.pickedByName, row.status === 'EXPIRED' ? 'Expired' : 'Cancelled', row.totalMinor,
      row.reason,
    ]),
  }
}

function shiftsTable(report: DailyAuditReport): ExportTable {
  return {
    name: 'shifts',
    title: 'Each till\'s own count',
    columns: [
      { label: 'Cashier', kind: 'text' },
      { label: 'Opened', kind: 'text' },
      { label: 'Closed', kind: 'text' },
      { label: 'Status', kind: 'text' },
      { label: 'Float', kind: 'money' },
      { label: 'Expected', kind: 'money' },
      { label: 'Counted', kind: 'money' },
      { label: 'Over or short', kind: 'money' },
    ],
    rows: report.shifts.map((row) => [
      row.cashierName, row.openedAt, row.closedAt, row.status, row.openingFloatMinor, row.expectedCashMinor,
      row.countedCashMinor, row.varianceMinor,
    ]),
  }
}

function voidsTable(report: DailyAuditReport): ExportTable {
  return {
    name: 'not-completed',
    title: 'Sales that were not completed',
    columns: [
      { label: 'Receipt', kind: 'text' },
      { label: 'Cashier', kind: 'text' },
      { label: 'Status', kind: 'text' },
      { label: 'At', kind: 'text' },
      { label: 'Amount', kind: 'money' },
    ],
    rows: report.voids.map((row) => [
      row.receiptNumber, row.cashierName, row.status, row.at, row.totalMinor,
    ]),
  }
}

function checksTable(report: DailyAuditReport): ExportTable {
  const findingByCode = new Map<string, AuditFinding>(report.findings.map((finding) => [finding.code, finding]))
  return {
    name: 'checks',
    title: 'What was checked, and what it found',
    columns: [
      { label: 'Check', kind: 'text' },
      { label: 'Result', kind: 'text' },
      { label: 'Count', kind: 'integer' },
      { label: 'Amount', kind: 'money' },
      { label: 'Detail', kind: 'text' },
    ],
    // Every check that exists, not only the ones that fired. An export that listed findings alone could not tell a
    // clean day from a day nobody looked at, and that difference is the whole subject.
    rows: AUDIT_CHECK_CODES.map((code) => {
      const finding = findingByCode.get(code)
      const ran = (report.checksRun as readonly string[]).includes(code)
      return [
        AUDIT_CHECK_TITLES[code],
        finding ? `Found — ${finding.severity}` : ran ? 'Nothing found' : 'Not run for this day',
        finding ? finding.count : null,
        finding ? finding.amountMinor : null,
        finding ? `${finding.headline}${finding.detail ? ` · ${finding.detail}` : ''}` : '',
      ] as ExportValue[]
    }),
  }
}

function flagsTable(report: DailyAuditReport): ExportTable {
  return {
    name: 'flags',
    title: 'Flags on the day, and what became of them',
    columns: [
      { label: 'Raised at', kind: 'text' },
      { label: 'Raised by', kind: 'text' },
      { label: 'Source', kind: 'text' },
      { label: 'Check', kind: 'text' },
      { label: 'Seriousness', kind: 'text' },
      { label: 'Note', kind: 'text' },
      { label: 'Resolved at', kind: 'text' },
      { label: 'Resolved by', kind: 'text' },
      { label: 'Resolution', kind: 'text' },
    ],
    rows: report.flags.length > 0
      ? report.flags.map((row) => [
        row.raisedAt, row.raisedByName, row.source === 'AUTOMATIC' ? 'Automatic check' : 'Raised by hand',
        row.checkCode === '' ? '' : AUDIT_CHECK_TITLES[row.checkCode], row.severity, row.detail, row.resolvedAt,
        row.resolvedByName, row.resolutionNote,
      ])
      // One row that says so, rather than a heading with nothing under it: an empty table in a filed document reads as
      // "this was not looked at", which is the opposite of what an audit without flags means.
      : [['', '', '', '', '', 'No flags were raised on this day.', '', '', ''] as ExportValue[]],
  }
}

function attestationTable(report: DailyAuditReport): ExportTable {
  const close = report.dayClose
  const signOff = report.signOff
  const rows: ExportValue[][] = [
    ['Day closed', close ? 'Yes' : 'Not yet'],
    ['Counted cash', close ? `${moneyOf(close.countedCashMinor, report)}` : ''],
    ['Counted by', close?.closedBy ?? ''],
    ['Signed off', signOff ? 'Yes' : 'Not yet'],
    ['Verdict', signOff ? outcomeInWords(signOff.outcome) : ''],
    ['Signed by', signOff?.signedByName ?? ''],
    ['Signed at', signOff?.signedAt ?? ''],
    ['Note', signOff?.note ?? ''],
    // The one line that makes this file trustworthy or not: whether the day the signer was shown is still the day there.
    ['The day still reads as it did when signed', signOff ? (signOff.digestMatches ? 'Yes' : 'No — sales have moved since') : ''],
    ['Totals agree with the sales ledger', report.reconciliation.matches ? 'Yes' : `No — ${report.reconciliation.differences.join('; ')}`],
    ['Exported by', report.header.viewerName],
    ['Exported at', report.header.generatedAt],
  ]
  return {
    name: 'attestation',
    title: 'Who closed the day, and who audited it',
    columns: [{ label: 'Item', kind: 'text' }, { label: 'Answer', kind: 'text' }],
    rows,
  }
}

function outcomeInWords(outcome: string): string {
  return outcome === 'AUDITED_WITH_ISSUES' ? 'Audited with issues' : 'Audited'
}

/**
 * Basis points as a percentage, in text.
 *
 * Text and not a number, because a percentage column next to money columns invites the reader to sum it, and the sum of
 * two percentages is meaningless. The figures behind them are in their own columns.
 */
function basisPointsAsPercent(basisPoints: bigint): string {
  const negative = basisPoints < 0n
  const magnitude = negative ? -basisPoints : basisPoints
  const whole = magnitude / 100n
  const hundredths = (magnitude % 100n).toString().padStart(2, '0')
  const trimmed = hundredths === '00' ? '' : `.${hundredths.replace(/0+$/u, '')}`
  return `${negative ? '-' : ''}${whole}${trimmed}%`
}

function moneyOf(value: bigint, report: DailyAuditReport): string {
  const decimalPlaces = report.header.currency.decimalPlaces
  const scale = 10n ** BigInt(decimalPlaces)
  const negative = value < 0n
  const magnitude = negative ? -value : value
  const fraction = decimalPlaces > 0 ? `.${(magnitude % scale).toString().padStart(decimalPlaces, '0')}` : ''
  return `${negative ? '-' : ''}${magnitude / scale}${fraction}`
}
