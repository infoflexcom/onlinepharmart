import Database from 'better-sqlite3'
import { Workbook } from 'exceljs'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { getCurrency } from '../currency/catalog'
import { defaultDisplayOptions } from '../currency/money'
import { fromMinor } from '../currency/parse'
import { migrateDatabase } from '../db/migrate'
import { SQLiteShopRepository } from '../db/sqlite-shop-repository'
import type { ProductDraft } from '../shared/inventory/types'
import type { PublicUser } from '../shared/auth/types'
import { buildReportExportTables, createReportCsv, createReportPdf, createReportWorkbookBase64 } from './report-export'
import { AccountingReportService } from './accounting-report-service'
import { PointOfSaleService } from './point-of-sale-service'
import { ProductInventoryService } from './product-inventory-service'
import { ReturnService } from './return-service'
import type { AccountingReport, ReportSectionId } from '../shared/reports/types'

const NOW = Date.parse('2026-11-17T12:00:00.000Z')
const ADMIN: PublicUser = {
  id: 'export-admin', fullName: 'Export Admin', username: 'exportadmin', role: 'ADMIN', isActive: true, isLocked: false,
  permissions: { allowWholesale: true, maxDiscountBasisPoints: 10_000, allowCreditSales: true, returnLimitMinor: 9_223_372_036_854_775_807n },
}

/**
 * The till role, for reading a personal report. Spelled out rather than reusing `ADMIN` with a different role, because
 * the whole point of the case below is that the *scope* changes what the file carries.
 */
const ACCOUNT: PublicUser = {
  id: 'export-account', fullName: 'Till Person', username: 'exportaccount', role: 'ACCOUNT', isActive: true, isLocked: false,
  permissions: { allowWholesale: true, maxDiscountBasisPoints: 10_000, allowCreditSales: true, returnLimitMinor: 9_223_372_036_854_775_807n },
}

const SECTIONS: ReportSectionId[] = [
  'summary', 'top-sellers', 'slow-movers', 'valuation', 'low-stock', 'debtors',
  'purchases', 'user-performance', 'audit-log', 'stocktake', 'pharmacy', 'supermarket',
]

function createHarness(currencyCode: string) {
  const database = new Database(':memory:')
  migrateDatabase(database)
  const repository = new SQLiteShopRepository(database, false)
  const currency = getCurrency(currencyCode)!
  repository.saveSettings({
    ...repository.readSettings(),
    profile: { name: 'Harbor Health', address: '12 Dock Road, Lagos', phone: '+234 1 555 0100' },
    currency,
    display: defaultDisplayOptions(currency),
    setupComplete: true,
    currencyConfirmed: true,
  })
  database.prepare('INSERT INTO users (id, username, password_hash, role, full_name) VALUES (?, ?, ?, ?, ?)')
    .run(ADMIN.id, ADMIN.username, 'test-hash', ADMIN.role, ADMIN.fullName)
  database.prepare(`INSERT INTO user_permissions (user_id, allow_wholesale, max_discount_pct, allow_credit_sales, return_limit)
    VALUES (?, ?, ?, ?, ?)`).run(ADMIN.id, 1, 10_000, 1, ADMIN.permissions.returnLimitMinor)

  let generatedId = 0
  const options = { now: () => NOW, newId: () => `export-seed-${++generatedId}` }
  const inventory = new ProductInventoryService(database, repository, { ...options, deviceName: 'EXPORT-TEST' })
  const pointOfSale = new PointOfSaleService(database, repository, { ...options, workstation: 'EXPORT-TEST' })
  const returns = new ReturnService(database, repository, { ...options, workstation: 'EXPORT-TEST' })
  const reports = new AccountingReportService(database, repository, options)
  return { database, repository, currency, inventory, pointOfSale, returns, reports, close: () => database.close() }
}

function productDraft(currency: ReturnType<typeof getCurrency> & object): ProductDraft {
  return {
    sku: 'EXPORT-001', name: 'Paracetamol 500mg', brand: 'Harbor', description: 'Export test item',
    barcode: '', additionalBarcodes: [], category: 'Analgesics', subCategory: 'Tablets', department: 'Health',
    shelfLocation: 'A-01', unit: 'each', packSizeUnits: 1,
    cost: fromMinor(100n * 10n ** BigInt(currency.decimalPlaces - 2 + 2) / 100n, currency),
    retailPrice: fromMinor(200n, currency), wholesalePrice: fromMinor(180n, currency),
    wholesaleMinimumQuantity: '5', reorderLevel: '2', genericName: 'Paracetamol', prescriptionRequired: true,
    weighedItem: false, pluCode: '', pricePerKg: '', expiryTracking: true, variants: [], isActive: true,
  }
}

function seed(currencyCode: string) {
  const harness = createHarness(currencyCode)
  const currency = harness.currency
  const scale = 10n ** BigInt(currency.decimalPlaces)
  const actor = { id: ADMIN.id, username: ADMIN.username, role: ADMIN.role, fullName: ADMIN.fullName }
  const draft: ProductDraft = {
    ...productDraft(currency as never),
    cost: fromMinor(100n * scale, currency),
    retailPrice: fromMinor(200n * scale, currency),
    wholesalePrice: fromMinor(180n * scale, currency),
  }
  let product = harness.inventory.createProduct(draft, actor, 'BOTH')
  product = harness.inventory.receiveStock({
    productId: product.id, expectedProductVersion: product.rowVersion, expectedStockVersion: product.stockVersion,
    quantity: '10', quantityUnit: 'unit', unitCost: fromMinor(100n * scale, currency),
    supplierName: 'Coastal Medical Supplies', supplierReference: 'INV-EXPORT-1',
    note: 'Export seed', batchNumber: 'BATCH-EXP', expiryDate: '2027-06-30',
  }, actor, 'BOTH').product
  const receipt = harness.pointOfSale.completeSale({
    idempotencyKey: `export-sale-${currencyCode}`, saleType: 'RETAIL',
    items: [{ productId: product.id, quantity: '2' }],
    prescriptionAcknowledged: true,
    payments: [{ method: 'CASH', amount: fromMinor(400n * scale, currency) }],
  }, ADMIN, 'BOTH').receipt
  const returned = harness.returns.createReturn({
    receiptNumber: receipt.receiptNumber, reason: 'DAMAGED', reasonNote: 'Broken seal', type: 'REFUND',
    refundMethod: 'CASH', items: [{ saleItemId: receipt.items[0]!.id, quantity: '1', condition: 'DAMAGED' }],
    idempotencyKey: `export-return-${currencyCode}`,
  }, ADMIN, 'BOTH')
  // Stock moved during the sale and return, so re-read versions before counting.
  const current = harness.inventory.listProducts(actor, 'BOTH').find((item) => item.id === product.id)!
  harness.inventory.recordStocktake({
    productId: current.id, expectedProductVersion: current.rowVersion, expectedStockVersion: current.stockVersion,
    countedQuantity: '8', reason: 'Cycle count', batchNumber: '', expiryDate: '',
  }, actor, 'BOTH')
  const report = harness.reports.getDashboard({ period: 'DAY', date: '2026-11-17' }, actor, 'BOTH')
  return { harness, actor, report, receipt, returned }
}

/** Inflates PDFKit's compressed content streams so assertions can read the rendered text. */
function inflatePdfStreams(buffer: Buffer): string {
  const parts: string[] = []
  let index = 0
  while (index < buffer.length) {
    const start = buffer.indexOf('stream', index)
    if (start < 0) break
    const end = buffer.indexOf('endstream', start)
    if (end < 0) break
    let body = buffer.subarray(start + 'stream'.length, end)
    if (body[0] === 0x0d) body = body.subarray(1)
    if (body[0] === 0x0a) body = body.subarray(1)
    try {
      parts.push(inflateSync(body).toString('latin1'))
    } catch {
      parts.push(body.toString('latin1'))
    }
    index = end + 'endstream'.length
  }
  // PDFKit writes text as hex strings inside TJ arrays; decode them into readable text.
  const joined = parts.join('\n')
  // PDFKit splits strings across several hex segments with kerning numbers between them.
  return joined.replace(/\[([^\]]*)\] TJ/gu, (_match, body: string) =>
    body.replace(/<([0-9a-fA-F]*)>/gu, (_segment, hex: string) => Buffer.from(hex, 'hex').toString('latin1')))
}

/** Renders the export PDF and returns its decompressed text operators. */
async function pdfText(report: AccountingReport, section: ReportSectionId): Promise<string> {
  const bytes = await createReportPdf(report, section)
  const buffer = Buffer.from(bytes)
  expect(buffer.subarray(0, 5).toString()).toBe('%PDF-')
  return inflatePdfStreams(buffer)
}

describe('report exports for every Admin report section', () => {
  it.each(['NGN', 'JPY', 'KWD'])('exports every section with the store name and currency in %s', async (currencyCode) => {
    const { harness, actor, report } = seed(currencyCode)
    try {
      expect(report.adminReports).not.toBeNull()
      for (const section of SECTIONS) {
        const tables = buildReportExportTables(report, section)
        expect(tables.length, `${section} must produce at least one table`).toBeGreaterThan(0)
        for (const table of tables) {
          expect(table.columns.length).toBeGreaterThan(0)
          for (const row of table.rows) expect(row).toHaveLength(table.columns.length)
        }

        const csv = createReportCsv(report, section)
        expect(csv, `${section} CSV store name`).toContain('Harbor Health')
        expect(csv, `${section} CSV currency`).toContain(currencyCode)
        expect(csv.startsWith('\uFEFF')).toBe(true)

        const workbook = new Workbook()
        const bytes = Buffer.from(await createReportWorkbookBase64(report, section), 'base64')
        await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0])
        const sheet = workbook.getWorksheet(tables[0]!.name)
        expect(sheet, `${section} primary sheet`).toBeDefined()
        expect(sheet!.getCell('A1').value).toBe('Harbor Health')
        expect(sheet!.getCell('B4').value).toBe(currencyCode)
        // Money cells must be real numbers with a currency-formatted number format, not text.
        tables[0]!.columns.forEach((column, index) => {
          if (column.kind !== 'money' || tables[0]!.rows.length === 0) return
          const cell = sheet!.getCell(9, index + 1)
          if (cell.value === null || cell.value === undefined) return
          expect(typeof cell.value, `${section}.${column.label} should be numeric`).toBe('number')
          expect(cell.numFmt, `${section}.${column.label} format`).toContain(currencyCode)
        })

        const pdf = await pdfText(report, section)
        expect(pdf, `${section} PDF store`).toContain('Harbor Health')
        expect(pdf, `${section} PDF currency`).toContain(currencyCode)
      }

      // The renderer must be able to export each listed section against the same report.
      expect(harness.reports.exportCsv({ period: 'DAY', date: '2026-11-17', section: 'debtors' }, actor, 'BOTH'))
        .toContain('Debtors')
    } finally {
      harness.close()
    }
  })

  /**
   * The policy row for these channels says the file carries "whatever the same caller was just shown, scoped by the
   * host". Since the balances moved onto the report, an ACCOUNT is *shown* them in the day summary - they have no
   * section selector, so the summary is the whole of their view - which makes a summary file without them a file that
   * does not match the screen it was taken from.
   */
  it('carries the balances in a personal summary, and leaves them out of a store-wide one', () => {
    const seeded = seed('NGN')
    const { harness, actor } = seeded
    try {
      const currency = harness.currency
      const scale = 10n ** BigInt(currency.decimalPlaces)

      // The Admin's summary is taken from a screen where the balances live under Debtors rather than in the summary, so
      // the file does not carry a table that was not on the screen.
      expect(buildReportExportTables(seeded.report, 'summary').map((table) => table.name)).not.toContain('debtors')

      // Give the shop somebody who owes it money, so this is about a real balance rather than an empty table that would
      // pass either way.
      const product = harness.inventory.listProducts(actor, 'BOTH')[0]!
      const customer = harness.pointOfSale.createCustomer({
        name: 'Bode Stores', phone: '+234 800 222 3333', email: 'bode@example.test', address: '9 Marina Road',
        creditLimit: fromMinor(1_000n * scale, currency), enrolLoyalty: false,
      }, ADMIN, 'BOTH')
      harness.pointOfSale.completeSale({
        idempotencyKey: 'export-credit-NGN', saleType: 'WHOLESALE', customerId: customer.id,
        // Five, not one: the seeded product carries a wholesale minimum, and a sale refused for a quantity rule would
        // leave this test proving nothing about balances.
        items: [{ productId: product.id, quantity: '5' }], prescriptionAcknowledged: true,
        payments: [{ method: 'CREDIT', amount: fromMinor(900n * scale, currency) }],
      }, ADMIN, 'BOTH')

      // Read through the service as the till role, so the scope is the one the host would really produce rather than a
      // header edited by hand.
      const accountActor = { id: ACCOUNT.id, username: ACCOUNT.username, role: ACCOUNT.role, fullName: ACCOUNT.fullName }
      const personal = harness.reports.getDashboard({ period: 'DAY', date: '2026-11-17' }, accountActor, 'BOTH')
      expect(personal.header.scope).toBe('PERSONAL')
      expect(personal.adminReports).toBeNull()
      expect(personal.debtors.items.map((row) => row.customerName)).toEqual(['Bode Stores'])

      const tables = buildReportExportTables(personal, 'summary')
      const debtors = tables.find((table) => table.name === 'debtors')
      expect(debtors, 'the balances the screen showed are in the file').toBeDefined()
      // Compared with the section's own table rather than described: one spelling, so the summary file and the Debtors
      // file cannot disagree about what a customer owes.
      expect(debtors).toEqual(buildReportExportTables(personal, 'debtors')[0])
      expect(debtors!.rows[0]![0]).toBe('Bode Stores')
      expect(debtors!.rows[0]![2]).toBe(900n * scale)
      // And nothing in it is a cost, derived from the columns themselves.
      for (const column of debtors!.columns) {
        expect(column.label.toLowerCase(), `${column.label} has no place in a personal export`).not.toMatch(/cost|profit|margin/u)
      }

      // The summary keeps its cost and gross-profit lines and puts nothing against them. The lines are the shape of the
      // summary, the figures are what the scope withholds, and a personal file that dropped the lines would look like a
      // different report rather than the same one with cost removed.
      const financial = tables.find((table) => table.name === 'financial-summary')
      expect(financial, 'the summary itself is still there').toBeDefined()
      const costRow = financial!.rows.find((row) => row[0] === 'Cost of goods sold')
      const profitRow = financial!.rows.find((row) => row[0] === 'Gross profit')
      expect(costRow?.[1], 'cost is withheld from a personal report').toBeNull()
      expect(profitRow?.[1], 'and so is the margin it would give away').toBeNull()

      // End to end through the writer, because a table the builder returns is not yet a table in the file.
      const csv = createReportCsv(personal, 'summary')
      expect(csv).toContain('Debtors')
      expect(csv).toContain('Bode Stores')
      // And no figure the scope withholds reaches the file: the words may appear as labels, a number may not.
      const costLine = csv.split('\n').find((line) => line.includes('Cost of goods sold'))
      expect(costLine, 'the line is in the file').toBeDefined()
      expect(costLine).not.toMatch(/\d/u)
    } finally {
      harness.close()
    }
  })

  it('refuses restricted detail exports for a non-Admin scope', () => {
    const { harness, report } = seed('NGN')
    try {
      const personal: AccountingReport = {
        ...report,
        header: { ...report.header, scope: 'PERSONAL', viewerName: 'Export Admin' },
        adminReports: null,
      }
      expect(buildReportExportTables(personal, 'summary').length).toBeGreaterThan(0)
      // Debtors is the one detail section a personal view may export, and the reason is a fact about its columns rather
      // than a judgement about the role: a customer balance carries no cost and no margin, and settling one is the
      // ACCOUNT's own capability. Refusing it would leave `record_debtor_payment` with nothing to act on.
      for (const section of SECTIONS.filter((id) => id !== 'summary' && id !== 'debtors')) {
        expect(() => buildReportExportTables(personal, section), `${section} is an Admin section`).toThrow(/restricted to the Admin/u)
      }

      const debtors = buildReportExportTables(personal, 'debtors')
      expect(debtors).toHaveLength(1)
      // Derived from the table it would actually write, not from a list of words remembered here: if a cost column is
      // ever added to the debtors table, this fails and the exemption has to be reconsidered rather than inherited.
      for (const column of debtors[0]!.columns) {
        expect(column.label.toLowerCase(), `${column.label} has no place in a personal export`).not.toContain('cost')
        expect(column.label.toLowerCase()).not.toContain('profit')
        expect(column.label.toLowerCase()).not.toContain('margin')
      }
    } finally {
      harness.close()
    }
  })

  it('keeps exact minor-unit values in CSV even where Excel would lose precision', async () => {
    const { harness, report } = seed('NGN')
    try {
      const huge: AccountingReport = {
        ...report,
        summary: { ...report.summary, totalSalesMinor: 9_007_199_254_740_993n },
      }
      // CSV is the precision-safe export; it must carry the exact minor-unit amount.
      expect(createReportCsv(huge, 'summary')).toContain('90071992547409.93')
      await expect(createReportWorkbookBase64(huge, 'summary')).rejects.toThrow(/Excel numeric precision/u)
    } finally {
      harness.close()
    }
  })
})
