import { Workbook } from 'exceljs'
import { describe, expect, it } from 'vitest'
import { getCurrency } from '../currency/catalog'
import { defaultDisplayOptions } from '../currency/money'
import type {
  AuditCashTie,
  AuditFinding,
  AuditReconciliation,
  AuditTotals,
  DailyAuditReport,
} from '../shared/audit/types'
import { AUDIT_CHECK_CODES } from '../shared/audit/types'
import type { ReportHeader } from '../shared/reports/types'
import {
  AUDIT_CHECK_TITLES, buildAuditExportTables, createAuditCsv, createAuditWorkbookBase64,
} from './audit-export'

/**
 * Read from the module rather than written out again here, so renaming a check's title fails the test that lists them
 * instead of quietly passing it.
 */
const AUDIT_CHECK_TITLES_LIST: string[] = Object.values(AUDIT_CHECK_TITLES)

/**
 * The daily audit as a file.
 *
 * What is asserted here is not the layout — it is the four promises the export makes, each of which has a way of failing
 * quietly:
 *
 * 1. **Money leaves in the shop's own decimals.** A figure that has been through a float on the way to a spreadsheet
 *    comes back a kobo short, and nobody can find the kobo again. So the CSV holds text and the workbook holds numbers
 *    with the currency's own number format, and both are checked in a 0-decimal currency as well as a 2-decimal one.
 * 2. **A cell cannot become a formula.** A receipt number of `=HYPERLINK(...)` pasted into Excel is not a receipt number.
 * 3. **Nothing the caller was not shown appears.** In particular no cost and no margin: the Supervisor audits the money,
 *    and the gross profit is the Admin's.
 * 4. **An empty section never reads as an unchecked one.** The checks table lists all six with "Nothing found" beside the
 *    quiet ones, and the flags table says in words that none were raised. A heading with nothing under it is the shape of
 *    a document that stopped early.
 */

const NGN = getCurrency('NGN')!
const JPY = getCurrency('JPY')!
const TODAY = '2026-11-17'

function header(currency = NGN, overrides: Partial<ReportHeader> = {}): ReportHeader {
  return {
    storeName: 'Harbor Health',
    storeAddress: '12 Dock Road, Lagos',
    currency,
    display: defaultDisplayOptions(currency),
    period: { type: 'DAY', startDate: TODAY, endDate: TODAY, label: TODAY },
    generatedAt: '2026-11-17T19:30:00.000Z',
    scope: 'STORE',
    viewerName: 'Sam Supervisor',
    edition: 'BOTH',
    ...overrides,
  }
}

function totals(overrides: Partial<AuditTotals> = {}): AuditTotals {
  return {
    grossSalesMinor: 13_000n, totalSalesMinor: 12_300n, netSalesMinor: 10_400n, transactions: 2,
    retailMinor: 3_800n, retailTransactions: 1, wholesaleMinor: 8_500n, wholesaleTransactions: 1,
    discountsMinor: 700n, returnsMinor: 1_900n, returnTransactions: 1, refundsMinor: 1_900n,
    creditSalesMinor: 500n, creditTransactions: 1, debtorPaymentsMinor: 500n, debtorPaymentTransactions: 1,
    voids: 0, overrides: 1, reprints: 0, cancelledOrders: 0, expiredOrders: 0,
    ...overrides,
  }
}

function cashTie(currency = NGN, overrides: Partial<AuditCashTie> = {}): AuditCashTie {
  return {
    currencyCode: currency.code, openingFloatMinor: 10_000n, cashSalesMinor: 10_000n, cashRefundsMinor: -1_900n,
    drawerAdjustmentsMinor: -200n, debtorCashMinor: 500n, expectedCashMinor: 18_400n, countedCashMinor: 18_400n,
    differenceMinor: 0n, counted: true, closedByName: 'Ada Admin', closedAt: '2026-11-17T19:00:00.000Z',
    differs: false, ...overrides,
  }
}

function reconciliation(overrides: Partial<AuditReconciliation> = {}): AuditReconciliation {
  return {
    grossFromRowsMinor: 13_000n, grossFromLedgerMinor: 13_000n, salesFromRowsMinor: 12_300n,
    salesFromLedgerMinor: 12_300n, transactionsFromRows: 2, transactionsFromLedger: 2,
    paymentsFromRowsMinor: 12_300n, paymentsFromLedgerMinor: 12_300n, returnsFromRowsMinor: 1_900n,
    returnsFromLedgerMinor: 1_900n, refundsFromRowsMinor: 1_900n, refundsFromLedgerMinor: 1_900n,
    discountsFromRowsMinor: 700n, discountsFromLedgerMinor: 700n, matches: true, differences: [],
    ...overrides,
  }
}

function reportFixture(overrides: Partial<DailyAuditReport> = {}): DailyAuditReport {
  const currency = overrides.currencyCode ? getCurrency(overrides.currencyCode)! : NGN
  return {
    header: header(currency),
    businessDate: TODAY,
    currencyCode: currency.code,
    edition: 'BOTH',
    account: null,
    accounts: [{ id: 'a1', name: 'Amaka Account', username: 'account1', transactions: 1, salesMinor: 3_800n }],
    totals: totals(),
    sales: [{
      saleId: 1, receiptNumber: 'S-00000001', time: '12:00:00', cashierName: 'Amaka Account', saleType: 'RETAIL',
      grossMinor: 4_000n, discountMinor: 200n, totalMinor: 3_800n, paymentMethods: 'CASH + TRANSFER',
      creditMinor: 0n, customerName: '', orderNumber: '',
    }],
    voids: [],
    overrides: [{
      saleId: 1, receiptNumber: 'S-00000001', cashierName: 'Amaka Account', productName: 'Vitamin C 1000mg',
      sku: 'VC-1000', priceTier: 'RETAIL', cataloguePriceMinor: 2_000n, chargedPriceMinor: 1_500n,
      differenceMinor: -500n, direction: 'BELOW_CATALOGUE', quantityMilli: 2_000n, catalogueChangedSince: false,
    }],
    discounts: [{
      saleId: 1, receiptNumber: 'S-00000001', cashierName: 'Amaka Account', grossMinor: 4_000n, discountMinor: 200n,
      basisPoints: 500n, capBasisPoints: 2_000n, capSource: 'USER_PERMISSION', nearCap: false, aboveCap: false,
    }],
    reprints: [],
    returns: [{
      returnId: 1, returnNumber: 'R-00000001', saleReceiptNumber: 'S-00000001', cashierName: 'Amaka Account',
      approvedByName: 'Ada Admin', totalMinor: 1_900n, refundMethods: 'CASH', at: '13:10:00', outsideWindow: false,
    }],
    creditSales: [{
      saleId: 2, receiptNumber: 'S-00000002', customerName: 'Bode Stores', cashierName: 'Ada Admin',
      creditMinor: 500n, customerBalanceMinor: 500n, creditLimitMinor: 50_000n, at: '12:00:00',
    }],
    debtorPayments: [{
      paymentNumber: 'DP-00000001', customerName: 'Bode Stores', receivedByName: 'Amaka Account',
      paymentMethod: 'CASH', amountMinor: 500n, balanceBeforeMinor: 1_000n, balanceAfterMinor: 500n,
      reference: 'CHQ-99', at: '2026-11-17T14:00:00.000Z',
    }],
    orders: [],
    paymentMethods: [
      { method: 'CASH', transactions: 2, salesMinor: 10_000n, refundsMinor: -1_900n, netMinor: 8_100n },
      { method: 'TRANSFER', transactions: 1, salesMinor: 1_800n, refundsMinor: 0n, netMinor: 1_800n },
    ],
    cashTie: cashTie(currency),
    dayClose: null,
    shifts: [],
    findings: [],
    checksRun: [...AUDIT_CHECK_CODES],
    flags: [],
    signOff: null,
    reconciliation: reconciliation(),
    canSignOff: true,
    canNote: true,
    canExport: true,
    ...overrides,
  }
}

/** The CSV without its byte-order mark, split into rows of cells. */
function csvOf(report: DailyAuditReport): { text: string; rows: string[][] } {
  const text = createAuditCsv(report)
  const rows = text.replace(/^\uFEFF/u, '').split('\r\n').map((line) => line.split('","').map((cell) => cell.replace(/^"|"$/gu, '')))
  return { text, rows }
}

describe('the audit export says whose document it is', () => {
  it('opens with the store, the day, the currency and the scope, so a loose sheet still says where it came from', () => {
    const { text, rows } = csvOf(reportFixture())
    expect(text.startsWith('\uFEFF'), 'a CSV Excel opens as UTF-8').toBe(true)
    expect(text).toContain('\r\n')
    expect(rows[0]).toEqual(['Store', 'Harbor Health'])
    expect(rows[1]).toEqual(['Address', '12 Dock Road, Lagos'])
    expect(rows[2]).toEqual(['Period', `Daily audit · ${TODAY}`])
    expect(rows[3]).toEqual(['Currency', 'NGN'])
    expect(rows[4]).toEqual(['Scope', 'Store-wide'])
  })

  it('names the till when one Account is being audited, rather than calling it store-wide', () => {
    const scoped = reportFixture({
      account: { id: 'a1', name: 'Amaka Account', username: 'account1' },
      header: header(NGN, { scope: 'PERSONAL', viewerName: 'Sam Supervisor' }),
    })
    expect(csvOf(scoped).rows[4]).toEqual(['Scope', 'One Account · Amaka Account'])
  })

  it('records who exported it and when, in the file itself', () => {
    const { text } = csvOf(reportFixture())
    expect(text).toContain('"Exported by","Sam Supervisor"')
    expect(text).toContain('"Exported at","2026-11-17T19:30:00.000Z"')
  })
})

describe('the audit export keeps money exact', () => {
  it('writes a two-decimal currency with two decimals, and a zero-decimal one with none', () => {
    expect(csvOf(reportFixture()).text).toContain('"130.00"')
    const japan = reportFixture({
      currencyCode: 'JPY',
      header: header(JPY),
      totals: totals({ grossSalesMinor: 13_000n, totalSalesMinor: 12_300n }),
      cashTie: cashTie(JPY),
    })
    const text = csvOf(japan).text
    expect(text).toContain('"13000"')
    expect(text).not.toContain('13000.00')
    expect(text).toContain('"Currency","JPY"')
  })

  it('keeps a negative figure negative rather than turning a refund into a sale', () => {
    const { text } = csvOf(reportFixture())
    // The cash refunds row of the drawer tie is money going back out.
    expect(text).toContain('"Cash refunds paid out","-19.00"')
  })

  it('holds quantities as units with the milli part, because that is what a weighed item is sold in', () => {
    const weighed = reportFixture({
      overrides: [
        {
          saleId: 1, receiptNumber: 'S-00000001', cashierName: 'Amaka Account', productName: 'Vitamin C 1000mg',
          sku: 'VC-1000', priceTier: 'RETAIL', cataloguePriceMinor: 2_000n, chargedPriceMinor: 1_500n,
          differenceMinor: -500n, direction: 'BELOW_CATALOGUE', quantityMilli: 2_000n, catalogueChangedSince: false,
        },
        {
          // 1.5 kg of something sold by weight: the milli part is the whole reason quantities are not integers here.
          saleId: 3, receiptNumber: 'S-00000003', cashierName: 'Ada Admin', productName: 'Rice, by weight',
          sku: 'RICE-KG', priceTier: 'RETAIL', cataloguePriceMinor: 900n, chargedPriceMinor: 800n,
          differenceMinor: -100n, direction: 'BELOW_CATALOGUE', quantityMilli: 1_500n, catalogueChangedSince: false,
        },
      ],
    })
    // Column 5 of that table is the quantity, counted from its own header rather than from a memory of the order.
    const { rows } = csvOf(weighed)
    const heading = rows.findIndex((row) => row[0] === 'Lines charged at something other than the catalogue price')
    expect(heading).toBeGreaterThan(-1)
    const labels = rows[heading + 1]!
    const quantityColumn = labels.indexOf('Quantity')
    expect(quantityColumn).toBeGreaterThan(-1)
    // Up to the blank line that separates one table from the next, so the assertion reads this table's rows and not
    // whatever the rest of the document happens to have in the same column.
    const body: string[][] = []
    for (const row of rows.slice(heading + 2)) {
      if (row.length === 0 || (row.length === 1 && row[0] === '')) break
      body.push(row)
    }
    expect(body.map((row) => row[quantityColumn])).toEqual(['2', '1.5'])
  })

  it('puts real numbers in the workbook, formatted in the shop currency, not text that looks like money', async () => {
    const workbook = new Workbook()
    const bytes = Buffer.from(await createAuditWorkbookBase64(reportFixture()), 'base64')
    await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0])

    const summary = workbook.getWorksheet('day-summary')
    expect(summary, 'a sheet for the day in figures').toBeDefined()
    const labels = summary!.getRow(8).values as unknown[]
    const grossColumn = (labels as string[]).indexOf('Gross sales')
    expect(grossColumn).toBeGreaterThan(0)
    const cell = summary!.getRow(9).getCell(grossColumn)
    expect(cell.value).toBe(130)
    expect(String(cell.numFmt)).toContain('NGN')

    // The drawer tie is vertical: the argument reads down a column, and each step is a real number rather than text.
    const tie = workbook.getWorksheet('cash-tie')
    expect(tie).toBeDefined()
    const tieLabels = tie!.getRow(8).values as string[]
    expect(tieLabels.slice(1)).toEqual(['Step', 'Amount (NGN)'])
    expect(tie!.getRow(9).getCell(1).value).toBe('Opening float')
    expect(tie!.getRow(9).getCell(2).value).toBe(100)
    const expectedRow = (tie!.getColumn(1).values as string[]).indexOf('Expected in the drawer')
    expect(tie!.getRow(expectedRow).getCell(2).value).toBe(184)
  })

  it('refuses to round an amount Excel cannot hold exactly, instead of writing a figure that is nearly right', async () => {
    const huge = reportFixture({
      totals: totals({ grossSalesMinor: 9_007_199_254_740_993n }),
      reconciliation: reconciliation({ salesFromLedgerMinor: 9_007_199_254_740_993n }),
    })
    await expect(createAuditWorkbookBase64(huge)).rejects.toThrow(/Excel numeric precision/u)
    // The CSV still holds it exactly, which is the alternative the refusal message offers.
    expect(csvOf(huge).text).toContain('"90071992547409.93"')
  })
})

describe('the audit export cannot be turned into a formula', () => {
  it('neutralises a cell that starts with a spreadsheet operator', () => {
    const hostile = reportFixture({
      sales: [{
        saleId: 9, receiptNumber: '=HYPERLINK("http://evil.example")', time: '12:00:00', cashierName: '+1 555 0100',
        saleType: 'RETAIL', grossMinor: 100n, discountMinor: 0n, totalMinor: 100n, paymentMethods: 'CASH',
        creditMinor: 0n, customerName: '@admin', orderNumber: '',
      }],
      totals: totals({ transactions: 1 }),
    })
    const { text } = csvOf(hostile)
    expect(text).toContain("\"'=HYPERLINK(\"\"http://evil.example\"\")\"")
    expect(text).toContain("\"'+1 555 0100\"")
    expect(text).toContain("\"'@admin\"")
    // Nothing in the file begins a cell with a bare operator.
    for (const line of text.split('\r\n')) {
      expect(line.startsWith('"=') || line.startsWith('"+') || line.startsWith('"@'), line).toBe(false)
    }
  })
})

describe('the audit export says what was checked, not only what was found', () => {
  it('lists every check, with "Nothing found" beside the quiet ones', () => {
    const { rows } = csvOf(reportFixture())
    const checkRows = rows.filter((row) => AUDIT_CHECK_TITLES_LIST.includes(row[0] ?? ''))
    expect(checkRows.map((row) => row[0])).toHaveLength(AUDIT_CHECK_CODES.length)
    for (const row of checkRows) {
      expect(row[1], row[0]).toBe('Nothing found')
    }
  })

  it('writes a finding with its severity, its count and its amount', () => {
    const finding: AuditFinding = {
      code: 'CASH_DIFFERENCE', severity: 'SERIOUS', headline: 'The drawer was short by ₦84.00',
      detail: 'Expected ₦184.00, counted ₦100.00.', count: 1, amountMinor: -8_400n,
    }
    const { rows } = csvOf(reportFixture({ findings: [finding] }))
    const row = rows.find((candidate) => candidate[0] === 'Counted cash against the day\'s payments')
    expect(row).toBeDefined()
    expect(row![1]).toBe('Found — SERIOUS')
    expect(row![2]).toBe('1')
    expect(row![3]).toBe('-84.00')
    expect(row![4]).toContain('The drawer was short by')
  })

  it('says in words when no flag was raised, rather than leaving a heading over nothing', () => {
    const { text } = csvOf(reportFixture())
    expect(text).toContain('No flags were raised on this day.')
  })

  it('omits a ledger section with no rows, but never the attestation', () => {
    const names = buildAuditExportTables(reportFixture({ reprints: [], orders: [], voids: [] }))
      .map((table) => table.name)
    expect(names).not.toContain('duplicate-prints')
    expect(names).not.toContain('orders-not-completed')
    expect(names).not.toContain('not-completed')
    expect(names).toContain('checks')
    expect(names).toContain('flags')
    expect(names).toContain('attestation')
    // And a section with rows is there.
    expect(names).toContain('sales')
    expect(names).toContain('price-overrides')
    expect(names).toContain('debtor-payments')
  })
})

describe('the audit export says whether the day still reads as it did when signed', () => {
  it('reports an unsigned day as unsigned', () => {
    const { text } = csvOf(reportFixture())
    expect(text).toContain('"Signed off","Not yet"')
    expect(text).toContain('"Day closed","Not yet"')
    expect(text).toContain('"Totals agree with the sales ledger","Yes"')
  })

  it('reports a sign-off, and says so when the day has moved since', () => {
    const signed = reportFixture({
      signOff: {
        id: 'so-1', outcome: 'AUDITED', note: 'Counted with the Account present.', signedByName: 'Sam Supervisor',
        signedAt: '2026-11-17T19:10:00.000Z', subjectDigest: 'abc', digestMatches: true,
      },
    })
    const clean = csvOf(signed).text
    expect(clean).toContain('"Signed off","Yes"')
    expect(clean).toContain('"Verdict","Audited"')
    expect(clean).toContain('"Signed by","Sam Supervisor"')
    expect(clean).toContain('"The day still reads as it did when signed","Yes"')

    const moved = csvOf(reportFixture({
      signOff: { ...signed.signOff!, digestMatches: false },
    })).text
    expect(moved).toContain('"The day still reads as it did when signed","No — sales have moved since"')
  })

  it('writes a reconciliation failure into the file rather than dropping it', () => {
    const { text } = csvOf(reportFixture({
      reconciliation: reconciliation({
        matches: false, salesFromLedgerMinor: 12_400n, differences: ['sales taken'],
      }),
    }))
    expect(text).toContain('"Totals agree with the sales ledger","No — sales taken"')
  })

  it('words an audited-with-issues verdict as such', () => {
    const { text } = csvOf(reportFixture({
      signOff: {
        id: 'so-2', outcome: 'AUDITED_WITH_ISSUES', note: '', signedByName: 'Sam Supervisor',
        signedAt: '2026-11-17T19:10:00.000Z', subjectDigest: 'abc', digestMatches: true,
      },
    }))
    expect(text).toContain('"Verdict","Audited with issues"')
  })
})

describe('the audit export withholds what the caller was not shown', () => {
  it('contains no cost and no margin anywhere, because the Supervisor audits money and not profit', () => {
    const { text } = csvOf(reportFixture())
    const lowered = text.toLowerCase()
    for (const forbidden of ['cost of goods', 'cogs', 'gross profit', 'margin', 'unit cost']) {
      expect(lowered, `${forbidden} appears in a Supervisor's export`).not.toContain(forbidden)
    }
    // "Cost" on its own is too blunt a needle: an address or a product name could carry it. The tables are the check.
    for (const table of buildAuditExportTables(reportFixture())) {
      for (const column of table.columns) {
        expect(column.label.toLowerCase()).not.toContain('cost')
        expect(column.label.toLowerCase()).not.toContain('profit')
      }
    }
  })

  it('explains a price override in words that do not accuse the cashier', () => {
    const { text } = csvOf(reportFixture({
      overrides: [{
        saleId: 1, receiptNumber: 'S-00000001', cashierName: 'Amaka Account', productName: 'Vitamin C 1000mg',
        sku: 'VC-1000', priceTier: 'RETAIL', cataloguePriceMinor: 2_000n, chargedPriceMinor: 1_500n,
        differenceMinor: -500n, direction: 'BELOW_CATALOGUE', quantityMilli: 2_000n,
        // The catalogue moved after the sale, which explains the difference without blaming anybody for it.
        catalogueChangedSince: true,
      }],
    }))
    expect(text).toContain('Yes — the price was changed after this sale')
    expect(text).toContain('Charged below catalogue')
  })

  it('says which ceiling a discount was measured against', () => {
    const { text } = csvOf(reportFixture())
    expect(text).toContain('"The cashier\'s own permission"')
    expect(csvOf(reportFixture({
      discounts: [{
        saleId: 1, receiptNumber: 'S-00000001', cashierName: 'Amaka Account', grossMinor: 4_000n,
        discountMinor: 400n, basisPoints: 1_000n, capBasisPoints: 500n, capSource: 'SHOP_SETTINGS',
        nearCap: false, aboveCap: true,
      }],
    })).text).toContain('"Shop settings","Yes"')
  })
})
