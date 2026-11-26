import { Workbook } from 'exceljs'
import PDFDocument from 'pdfkit'
import type {
  AccountingReport,
  AdminReportData,
  ReportSectionId,
} from '../shared/reports/types'

// The vocabulary and the CSV writer live in `export-csv.ts`, which has no heavy imports at all; this module keeps the
// Excel and PDF writers, and re-exports the shared names so nothing that imported them from here has to move.
export type { ExportColumn, ExportColumnKind, ExportDocument, ExportTable, ExportValue } from './export-csv'
import type { ExportColumnKind, ExportDocument, ExportTable, ExportValue } from './export-csv'
import { createDocumentCsv, minorToMajor, quantityMajor } from './export-csv'
export { createDocumentCsv }

function documentOf(report: AccountingReport, subject: string, tables: ExportTable[]): ExportDocument {
  return {
    storeName: report.header.storeName,
    storeAddress: report.header.storeAddress,
    periodLabel: report.header.period.label,
    currency: { code: report.header.currency.code, decimalPlaces: report.header.currency.decimalPlaces },
    scopeLabel: report.header.scope === 'STORE' ? 'Store-wide' : `Personal · ${report.header.viewerName}`,
    generatedAt: report.header.generatedAt,
    subject,
    tables,
  }
}

export function buildReportExportTables(report: AccountingReport, section: ReportSectionId): ExportTable[] {
  if (section === 'summary') return summaryTables(report)
  // Before the Admin check, because this one is not an Admin section: a customer balance carries no cost, and the
  // ACCOUNT is the role that settles it. Exporting it is exporting what the same caller was just shown, which is the
  // rule every other section follows.
  if (section === 'debtors') return [debtorsTable(report.debtors)]
  const admin = report.adminReports
  if (!admin) throw new Error('Detailed report exports are restricted to the Admin.')
  switch (section) {
    case 'top-sellers': return [productSalesTable('top-sellers', 'Top sellers', admin.topSellers, false)]
    case 'slow-movers': return [productSalesTable('slow-movers', 'Slow movers', admin.slowMovers, true)]
    case 'valuation': return [valuationTable(admin)]
    case 'low-stock': return [lowStockTable(admin)]
    case 'purchases': return purchasesTables(admin)
    case 'user-performance': return [userPerformanceTable(admin)]
    case 'audit-log': return [auditTable(admin)]
    case 'stocktake': return [stocktakeTable(admin)]
    case 'pharmacy':
      if (!admin.pharmacy) throw new Error('Pharmacy reports are not included in this licensed edition.')
      return pharmacyTables(admin)
    case 'supermarket':
      if (!admin.supermarket) throw new Error('Supermarket reports are not included in this licensed edition.')
      return supermarketTables(report, admin)
    default: throw new Error('Choose a supported report to export.')
  }
}

export function createReportCsv(report: AccountingReport, section: ReportSectionId): string {
  return createDocumentCsv(documentOf(report, section, buildReportExportTables(report, section)))
}

/** Any document as an Excel workbook, base64-encoded so it crosses the IPC boundary as a string. */
export async function createDocumentWorkbookBase64(document: ExportDocument): Promise<string> {
  const workbook = new Workbook()
  workbook.creator = 'Infoflex'
  workbook.subject = `${document.periodLabel} · ${document.subject}`
  workbook.title = `${document.storeName || 'Store'} · ${document.periodLabel} ${document.subject}`
  workbook.created = new Date(document.generatedAt)
  workbook.modified = workbook.created
  for (const table of document.tables) addWorksheet(workbook, table, document)
  const bytes = await workbook.xlsx.writeBuffer()
  return Buffer.from(bytes).toString('base64')
}

export async function createReportWorkbookBase64(report: AccountingReport, section: ReportSectionId): Promise<string> {
  return createDocumentWorkbookBase64(documentOf(report, section, buildReportExportTables(report, section)))
}

export async function createReportPdf(report: AccountingReport, section: ReportSectionId): Promise<Uint8Array> {
  const tables = buildReportExportTables(report, section)
  const landscape = report.header.period.type === 'MONTH' || tables.some((table) => table.columns.length > 6)
  return new Promise<Uint8Array>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: landscape ? 'landscape' : 'portrait',
      margins: { top: 38, bottom: 38, left: 40, right: 40 },
      info: {
        Title: `${report.header.storeName || 'Store'} · ${report.header.period.label} report`,
        Author: 'Infoflex',
        Subject: `${section} · ${report.header.currency.code}`,
      },
    })
    const chunks: Buffer[] = []
    doc.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
    doc.on('error', reject)
    doc.on('end', () => resolve(Buffer.concat(chunks)))

    const title = titleForSection(section)
    doc.font('Helvetica-Bold').fontSize(17).fillColor('#17345f').text(pdfText(report.header.storeName || 'Store'))
    doc.font('Helvetica').fontSize(9).fillColor('#344155')
    if (report.header.storeAddress.trim()) doc.text(pdfText(report.header.storeAddress))
    doc.moveDown(0.3)
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#172235').text(pdfText(title))
    doc.font('Helvetica').fontSize(9).fillColor('#596779')
      .text(`Period: ${pdfText(report.header.period.label)}    Currency: ${report.header.currency.code}`)
      .text(`Scope: ${report.header.scope === 'STORE' ? 'Store-wide' : `Personal · ${pdfText(report.header.viewerName)}`}`)
      .text(`Generated: ${pdfText(report.header.generatedAt)}`)
    doc.moveDown(0.8)

    for (const table of tables) {
      ensurePdfSpace(doc, 34)
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#17345f').text(pdfText(table.title))
      doc.moveDown(0.25)
      if (table.name === 'daily' && table.columns.length > 6) {
        writeDailyRows(doc, table, report)
      } else {
        writeTableRows(doc, table, report)
      }
      doc.moveDown(0.7)
      if (table.name === 'daily' && report.header.period.type === 'MONTH') {
        drawMonthlyChart(doc, report)
      }
    }
    doc.end()
  })
}

function summaryTables(report: AccountingReport): ExportTable[] {
  const summary = report.summary
  const financial: ExportTable = {
    name: 'financial-summary',
    title: 'Financial summary',
    columns: [
      { label: 'Metric', kind: 'text' },
      { label: 'Amount', kind: 'money' },
      { label: 'Transactions', kind: 'integer' },
    ],
    rows: [
      ['Gross sales before discounts', summary.grossSalesMinor, null],
      ['Total sales after discounts', summary.totalSalesMinor, summary.transactions],
      ['Retail sales', summary.retail.totalMinor, summary.retail.transactions],
      ['Wholesale sales', summary.wholesale.totalMinor, summary.wholesale.transactions],
      ['Discounts', summary.discountsMinor, null],
      ['Returns', summary.returnsMinor, summary.returnTransactions],
      ['Refunds', summary.refundsMinor, null],
      ['Net sales', summary.netSalesMinor, null],
      ['Cost of goods sold', summary.cogsMinor, null],
      ['Gross profit', summary.grossProfitMinor, null],
    ],
  }
  const daily: ExportTable = {
    name: 'daily',
    title: report.header.period.type === 'MONTH' ? 'Day-by-day sales' : 'Daily totals',
    columns: [
      { label: 'Business date', kind: 'text' },
      { label: 'Sales', kind: 'money' },
      { label: 'Transactions', kind: 'integer' },
      { label: 'Retail sales', kind: 'money' },
      { label: 'Retail transactions', kind: 'integer' },
      { label: 'Wholesale sales', kind: 'money' },
      { label: 'Wholesale transactions', kind: 'integer' },
      { label: 'Discounts', kind: 'money' },
      { label: 'Returns', kind: 'money' },
      { label: 'Refunds', kind: 'money' },
      { label: 'Net sales', kind: 'money' },
      { label: 'COGS', kind: 'money' },
      { label: 'Gross profit', kind: 'money' },
    ],
    rows: report.daily.map((row) => [
      row.date, row.totalSalesMinor, row.transactions, row.retailSalesMinor, row.retailTransactions,
      row.wholesaleSalesMinor, row.wholesaleTransactions, row.discountsMinor, row.returnsMinor,
      row.refundsMinor, row.netSalesMinor, row.cogsMinor, row.grossProfitMinor,
    ]),
  }
  const paymentMethods: ExportTable = {
    name: 'payment-methods', title: 'Sales payment methods',
    columns: [{ label: 'Method', kind: 'text' }, { label: 'Amount', kind: 'money' }, { label: 'Transactions', kind: 'integer' }],
    rows: report.paymentMethods.map((row) => [row.method, row.totalMinor, row.transactions]),
  }
  const refundMethods: ExportTable = {
    name: 'refund-methods', title: 'Return and refund methods',
    columns: [{ label: 'Method', kind: 'text' }, { label: 'Amount', kind: 'money' }, { label: 'Returns', kind: 'integer' }],
    rows: report.refundMethods.map((row) => [row.method, row.totalMinor, row.transactions]),
  }
  const users: ExportTable = {
    name: 'sales-by-user', title: report.header.scope === 'STORE' ? 'Sales by user' : 'My sales',
    columns: [
      { label: 'User', kind: 'text' }, { label: 'Username', kind: 'text' },
      { label: 'Transactions', kind: 'integer' }, { label: 'Retail sales', kind: 'money' },
      { label: 'Wholesale sales', kind: 'money' }, { label: 'Discounts', kind: 'money' },
      { label: 'Returns', kind: 'money' }, { label: 'Net sales', kind: 'money' },
      { label: 'COGS', kind: 'money' }, { label: 'Gross profit', kind: 'money' },
    ],
    rows: report.salesByUser.map((row) => [
      row.userName, row.username, row.transactions, row.retailSalesMinor, row.wholesaleSalesMinor,
      row.discountsMinor, row.returnsMinor, row.netSalesMinor, row.cogsMinor, row.grossProfitMinor,
    ]),
  }
  const cashClose: ExportTable[] = report.cashPosition ? [{
    name: 'cash-close',
    title: report.dayClose ? 'Saved end-of-day cash close' : 'Cash drawer position',
    columns: [
      { label: 'Business date', kind: 'text' }, { label: 'Currency', kind: 'text' },
      { label: 'Opening float', kind: 'money' }, { label: 'Cash sales', kind: 'money' },
      { label: 'Cash refunds', kind: 'money' }, { label: 'Drawer adjustments', kind: 'money' },
      { label: 'Expected cash', kind: 'money' }, { label: 'Counted cash', kind: 'money' },
      { label: 'Difference', kind: 'money' }, { label: 'Closed by', kind: 'text' }, { label: 'Note', kind: 'text' },
    ],
    rows: [[
      report.cashPosition.businessDate, report.cashPosition.currencyCode, report.cashPosition.openingFloatMinor,
      report.cashPosition.cashSalesMinor, report.cashPosition.cashRefundsMinor, report.cashPosition.drawerAdjustmentsMinor,
      report.cashPosition.expectedCashMinor, report.dayClose?.countedCashMinor ?? null,
      report.dayClose?.varianceMinor ?? null, report.dayClose?.closedBy ?? '', report.dayClose?.note ?? '',
    ]],
  }] : []
  const shifts: ExportTable[] = report.shifts.length > 0 ? [{
    name: 'cashier-shifts', title: 'Cashier shifts · expected, counted, and over / short',
    columns: [
      { label: 'Cashier', kind: 'text' }, { label: 'Status', kind: 'text' }, { label: 'Opened', kind: 'text' },
      { label: 'Opening float', kind: 'money' }, { label: 'Cash sales', kind: 'money' },
      { label: 'Cash refunds', kind: 'money' }, { label: 'Drawer adjustments', kind: 'money' },
      { label: 'Expected cash', kind: 'money' }, { label: 'Counted cash', kind: 'money' },
      { label: 'Over / short', kind: 'money' }, { label: 'Closed by', kind: 'text' }, { label: 'Close note', kind: 'text' },
    ],
    rows: report.shifts.map((shift) => [
      shift.cashierName, shift.status, shift.openedAt, shift.openingFloatMinor, shift.cashSalesMinor,
      shift.cashRefundsMinor, shift.drawerAdjustmentsMinor, shift.expectedCashMinor,
      shift.countedCashMinor, shift.varianceMinor, shift.closedBy, shift.closeNote,
    ]),
  }] : []
  // A personal view is *shown* the balances on the same screen - the debtor panel sits in the day summary for a caller
  // who has no section selector - and the policy rows for these channels promise the file carries whatever the same
  // caller was just shown. So the balances travel with a personal summary, and the table's own title states the total,
  // which means an empty one says "nobody owes anything" rather than looking like a document that stopped early.
  //
  // A store-wide summary does not carry them: an Admin sees the balances under Debtors, where the same panel is rendered
  // from the same member of the same report, and putting a second copy in the summary file would place a table in the
  // export that was not on the screen the export was taken from.
  const debtors = report.header.scope === 'PERSONAL' ? [debtorsTable(report.debtors)] : []
  return [financial, daily, paymentMethods, refundMethods, users, ...cashClose, ...shifts, ...debtors]
}

function productSalesTable(name: string, title: string, rows: AdminReportData['topSellers'], includeOnHand: boolean): ExportTable {
  return {
    name,
    title,
    columns: [
      { label: 'SKU', kind: 'text' }, { label: 'Product', kind: 'text' }, { label: 'Unit', kind: 'text' },
      { label: 'Quantity sold', kind: 'quantity' }, { label: 'Sales', kind: 'money' },
      { label: 'Transactions', kind: 'integer' },
      ...(includeOnHand ? [{ label: 'On hand', kind: 'quantity' as const }] : []),
    ],
    rows: rows.map((row) => [
      row.sku, row.productName, row.unit, row.quantitySoldMilli, row.salesMinor, row.transactions,
      ...(includeOnHand ? [row.onHandQuantityMilli ?? 0n] : []),
    ]),
  }
}

function valuationTable(admin: AdminReportData): ExportTable {
  return {
    name: 'valuation', title: `Inventory valuation · total ${admin.valuation.totalValueMinor.toString()} minor units`,
    columns: [
      { label: 'SKU', kind: 'text' }, { label: 'Product', kind: 'text' }, { label: 'Unit', kind: 'text' },
      { label: 'On hand', kind: 'quantity' }, { label: 'Reserved', kind: 'quantity' },
      { label: 'Unit cost', kind: 'money' }, { label: 'Stock value', kind: 'money' },
    ],
    rows: admin.valuation.items.map((row) => [
      row.sku, row.productName, row.unit, row.quantityMilli, row.reservedMilli, row.costPerUnitMinor, row.valueMinor,
    ]),
  }
}

function lowStockTable(admin: AdminReportData): ExportTable {
  return {
    name: 'low-stock', title: 'Low-stock products',
    columns: [
      { label: 'SKU', kind: 'text' }, { label: 'Product', kind: 'text' }, { label: 'Unit', kind: 'text' },
      { label: 'On hand', kind: 'quantity' }, { label: 'Reserved', kind: 'quantity' }, { label: 'Reorder level', kind: 'quantity' },
    ],
    rows: admin.lowStock.map((row) => [row.sku, row.productName, row.unit, row.quantityMilli, row.reservedMilli, row.reorderLevelMilli]),
  }
}

/** The type is read off the report rather than written again here, so the two cannot drift. */
function debtorsTable(debtors: AccountingReport['debtors']): ExportTable {
  return {
    name: 'debtors', title: `Debtors · total balance ${debtors.totalBalanceMinor.toString()} minor units`,
    columns: [
      { label: 'Customer', kind: 'text' }, { label: 'Phone', kind: 'text' },
      { label: 'Balance', kind: 'money' }, { label: 'Credit limit', kind: 'money' },
    ],
    rows: debtors.items.map((row) => [row.customerName, row.phone, row.balanceMinor, row.creditLimitMinor]),
  }
}

function purchasesTables(admin: AdminReportData): ExportTable[] {
  return [
    {
      name: 'purchases', title: 'Completed purchases',
      columns: [
        { label: 'Purchase', kind: 'text' }, { label: 'Supplier', kind: 'text' },
        { label: 'Received by', kind: 'text' }, { label: 'Date', kind: 'text' }, { label: 'Total', kind: 'money' },
      ],
      rows: admin.purchases.items.map((row) => [row.purchaseNumber, row.supplierName, row.receivedBy, row.createdAt, row.totalMinor]),
    },
    {
      name: 'purchases-by-supplier', title: 'Purchases by supplier',
      columns: [{ label: 'Supplier', kind: 'text' }, { label: 'Transactions', kind: 'integer' }, { label: 'Total', kind: 'money' }],
      rows: admin.purchases.bySupplier.map((row) => [row.supplierName, row.transactions, row.totalMinor]),
    },
  ]
}

function userPerformanceTable(admin: AdminReportData): ExportTable {
  return {
    name: 'user-performance', title: 'User performance',
    columns: [
      { label: 'User', kind: 'text' }, { label: 'Username', kind: 'text' },
      { label: 'Transactions', kind: 'integer' }, { label: 'Retail sales', kind: 'money' },
      { label: 'Wholesale sales', kind: 'money' }, { label: 'Discounts', kind: 'money' },
      { label: 'Returns processed', kind: 'integer' }, { label: 'Returns', kind: 'money' },
      { label: 'Net sales', kind: 'money' }, { label: 'COGS', kind: 'money' }, { label: 'Gross profit', kind: 'money' },
    ],
    rows: admin.userPerformance.map((row) => [
      row.userName, row.username, row.transactions, row.retailSalesMinor, row.wholesaleSalesMinor,
      row.discountsMinor, row.returnsProcessed, row.returnsMinor, row.netSalesMinor, row.cogsMinor, row.grossProfitMinor,
    ]),
  }
}

function auditTable(admin: AdminReportData): ExportTable {
  return {
    name: 'audit-log', title: 'Audit log',
    columns: [
      { label: 'Date', kind: 'text' }, { label: 'Actor', kind: 'text' }, { label: 'Action', kind: 'text' },
      { label: 'Device', kind: 'text' }, { label: 'IP address', kind: 'text' }, { label: 'Metadata', kind: 'text' },
    ],
    rows: admin.auditLog.map((row) => [row.createdAt, row.actor, row.action, row.deviceName, row.ipAddress ?? '', JSON.stringify(row.metadata)]),
  }
}

function stocktakeTable(admin: AdminReportData): ExportTable {
  return {
    name: 'stocktake', title: 'Stocktake variances',
    columns: [
      { label: 'Date', kind: 'text' }, { label: 'SKU', kind: 'text' }, { label: 'Product', kind: 'text' },
      { label: 'Expected', kind: 'quantity' }, { label: 'Counted', kind: 'quantity' },
      { label: 'Variance', kind: 'quantity' }, { label: 'Reason', kind: 'text' },
      { label: 'Actor', kind: 'text' }, { label: 'Device', kind: 'text' },
    ],
    rows: admin.stocktakes.map((row) => [
      row.createdAt, row.sku, row.productName, row.expectedQuantityMilli, row.countedQuantityMilli,
      row.varianceMilli, row.reason, row.actor, row.deviceName,
    ]),
  }
}

function pharmacyTables(admin: AdminReportData): ExportTable[] {
  const pharmacy = admin.pharmacy!
  return [
    {
      name: 'pharmacy-expiry', title: 'Expired and near-expiry batches',
      columns: [
        { label: 'State', kind: 'text' }, { label: 'SKU', kind: 'text' }, { label: 'Product', kind: 'text' },
        { label: 'Batch', kind: 'text' }, { label: 'Expiry date', kind: 'text' }, { label: 'Quantity', kind: 'quantity' },
        { label: 'Unit cost', kind: 'money' }, { label: 'Stock value', kind: 'money' },
      ],
      rows: pharmacy.expiryLots.map((row) => [
        row.state, row.sku, row.productName, row.batchNumber, row.expiryDate, row.quantityMilli, row.unitCostMinor, row.valueMinor,
      ]),
    },
    {
      name: 'pharmacy-prescription', title: 'Prescription-required sales',
      columns: [
        { label: 'SKU', kind: 'text' }, { label: 'Product', kind: 'text' }, { label: 'Generic name', kind: 'text' },
        { label: 'Quantity', kind: 'quantity' }, { label: 'Sales', kind: 'money' }, { label: 'Transactions', kind: 'integer' },
      ],
      rows: pharmacy.prescriptionSales.map((row) => [row.sku, row.productName, row.genericName, row.quantitySoldMilli, row.salesMinor, row.transactions]),
    },
    {
      name: 'pharmacy-writeoffs', title: 'Return write-offs',
      columns: [
        { label: 'Reason', kind: 'text' }, { label: 'Items', kind: 'integer' },
        { label: 'Quantity', kind: 'quantity' }, { label: 'Returned value', kind: 'money' },
      ],
      rows: pharmacy.writeOffs.map((row) => [row.reason, row.items, row.quantityMilli, row.returnedValueMinor]),
    },
  ]
}

function supermarketTables(report: AccountingReport, admin: AdminReportData): ExportTable[] {
  const supermarket = admin.supermarket!
  return [
    {
      name: 'supermarket-shifts', title: 'Cashier shifts · over / short',
      columns: [
        { label: 'Cashier', kind: 'text' }, { label: 'Status', kind: 'text' }, { label: 'Opened', kind: 'text' },
        { label: 'Closed', kind: 'text' }, { label: 'Opening float', kind: 'money' },
        { label: 'Cash sales', kind: 'money' }, { label: 'Cash refunds', kind: 'money' },
        { label: 'Drawer events', kind: 'money' }, { label: 'Expected cash', kind: 'money' },
        { label: 'Counted cash', kind: 'money' }, { label: 'Over / short', kind: 'money' },
      ],
      rows: report.shifts.map((row) => [
        row.cashierName, row.status, row.openedAt, row.closedAt ?? '', row.openingFloatMinor,
        row.cashSalesMinor, row.cashRefundsMinor, row.drawerAdjustmentsMinor, row.expectedCashMinor,
        row.countedCashMinor, row.varianceMinor,
      ]),
    },
    {
      name: 'supermarket-departments', title: 'Department sales',
      columns: [
        { label: 'Department', kind: 'text' }, { label: 'Transactions', kind: 'integer' },
        { label: 'Quantity', kind: 'quantity' }, { label: 'Sales', kind: 'money' }, { label: 'Discounts', kind: 'money' },
      ],
      rows: supermarket.departments.map((row) => [row.department, row.transactions, row.quantitySoldMilli, row.salesMinor, row.discountsMinor]),
    },
    {
      name: 'supermarket-promotions', title: 'Promotion performance',
      columns: [
        { label: 'Promotion', kind: 'text' }, { label: 'Transactions', kind: 'integer' },
        { label: 'Discounts', kind: 'money' }, { label: 'Sales', kind: 'money' },
      ],
      rows: supermarket.promotions.map((row) => [row.promotion, row.transactions, row.discountsMinor, row.salesMinor]),
    },
    {
      name: 'supermarket-loyalty', title: 'Loyalty redemptions',
      columns: [
        { label: 'Transactions', kind: 'integer' }, { label: 'Points redeemed', kind: 'integer' },
        { label: 'Loyalty discounts', kind: 'money' },
      ],
      rows: [[supermarket.loyalty.transactions, supermarket.loyalty.pointsRedeemed, supermarket.loyalty.discountsMinor]],
    },
  ]
}

function addWorksheet(workbook: Workbook, table: ExportTable, document: ExportDocument): void {
  const worksheet = workbook.addWorksheet(safeSheetName(table.name, workbook))
  const columnCount = Math.max(1, table.columns.length)
  worksheet.mergeCells(1, 1, 1, columnCount)
  worksheet.getCell(1, 1).value = document.storeName || 'Store'
  worksheet.getCell(1, 1).font = { bold: true, size: 16, color: { argb: 'FF17345F' } }
  worksheet.mergeCells(2, 1, 2, columnCount)
  worksheet.getCell(2, 1).value = document.storeAddress
  worksheet.getCell(3, 1).value = 'Period'
  worksheet.getCell(3, 2).value = document.periodLabel
  worksheet.getCell(4, 1).value = 'Currency'
  worksheet.getCell(4, 2).value = document.currency.code
  worksheet.getCell(5, 1).value = 'Document'
  worksheet.getCell(5, 2).value = table.title
  worksheet.getCell(6, 1).value = 'Scope'
  worksheet.getCell(6, 2).value = document.scopeLabel
  const headerRow = worksheet.addRow([])
  const labels = worksheet.addRow(table.columns.map((column) => column.label))
  labels.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  labels.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3F73' } }
  table.rows.forEach((values) => {
    const excelRow = worksheet.addRow(values.map((value, index) => excelValue(value, table.columns[index]?.kind ?? 'text', document)))
    excelRow.eachCell((cell, columnNumber) => {
      const column = table.columns[columnNumber - 1]
      if (!column) return
      if (column.kind === 'money') cell.numFmt = moneyNumberFormat(document.currency.code, document.currency.decimalPlaces)
      else if (column.kind === 'quantity') cell.numFmt = '#,##0.000'
      else if (column.kind === 'integer') cell.numFmt = '#,##0'
    })
  })
  if (table.rows.length > 0) {
    worksheet.autoFilter = { from: { row: labels.number, column: 1 }, to: { row: worksheet.rowCount, column: columnCount } }
  }
  worksheet.columns = table.columns.map((column) => ({
    width: Math.min(42, Math.max(13, column.label.length + 3)),
  }))
  worksheet.views = [{ state: 'frozen', ySplit: labels.number }]
  void headerRow
}

function excelValue(
  value: ExportValue,
  kind: ExportColumnKind,
  document: ExportDocument,
): string | number | boolean | null {
  if (value === null) return null
  if (kind === 'money' && typeof value === 'bigint') {
    const scale = 10 ** document.currency.decimalPlaces
    const numeric = Number(value) / scale
    if (!Number.isFinite(numeric) || BigInt(Math.round(numeric * scale)) !== value) {
      throw new Error('An amount exceeds Excel numeric precision; export this report as CSV or PDF to preserve it exactly.')
    }
    return numeric
  }
  if (kind === 'quantity' && typeof value === 'bigint') return Number(value) / 1_000
  if (typeof value === 'bigint') return Number(value)
  return value
}

function moneyNumberFormat(code: string, decimalPlaces: number): string {
  const decimals = decimalPlaces > 0 ? `.${'0'.repeat(decimalPlaces)}` : ''
  const pattern = `"${code}" #,##0${decimals}`
  return `${pattern};[Red]-${pattern};${pattern}`
}

function safeSheetName(value: string, workbook: Workbook): string {
  const normalized = value.replace(/[\\/*?:\[\]]/gu, '-').slice(0, 31) || 'Report'
  let name = normalized
  let suffix = 2
  while (workbook.getWorksheet(name)) {
    const ending = ` ${suffix}`
    name = `${normalized.slice(0, 31 - ending.length)}${ending}`
    suffix += 1
  }
  return name
}

function writeTableRows(doc: InstanceType<typeof PDFDocument>, table: ExportTable, report: AccountingReport): void {
  doc.font('Helvetica-Bold').fontSize(7.6).fillColor('#344155')
    .text(pdfText(table.columns.map((column) => column.label).join('  |  ')), { width: doc.page.width - 80 })
  doc.moveDown(0.25)
  doc.font('Helvetica').fontSize(7.4).fillColor('#273447')
  for (const row of table.rows) {
    ensurePdfSpace(doc, 18)
    const text = row.map((value, index) => pdfCell(value, table.columns[index]?.kind ?? 'text', report)).join('  |  ')
    doc.text(pdfText(text), { width: doc.page.width - 80, lineGap: 1 })
  }
}

function writeDailyRows(doc: InstanceType<typeof PDFDocument>, table: ExportTable, report: AccountingReport): void {
  doc.font('Helvetica').fontSize(7.5).fillColor('#273447')
  const daily = report.daily
  for (const row of daily) {
    ensurePdfSpace(doc, 16)
    const parts = [
      row.date,
      `Sales ${pdfCell(row.totalSalesMinor, 'money', report)}`,
      `Tx ${pdfCell(row.transactions, 'integer', report)}`,
      `Discount ${pdfCell(row.discountsMinor, 'money', report)}`,
      `Returns ${pdfCell(row.returnsMinor, 'money', report)}`,
      `Net ${pdfCell(row.netSalesMinor, 'money', report)}`,
    ]
    if (report.header.scope === 'STORE') {
      parts.push(`COGS ${pdfCell(row.cogsMinor, 'money', report)}`, `Profit ${pdfCell(row.grossProfitMinor, 'money', report)}`)
    }
    doc.text(pdfText(parts.join('   ·   ')), { width: doc.page.width - 80 })
  }
  void table
}

function drawMonthlyChart(doc: InstanceType<typeof PDFDocument>, report: AccountingReport): void {
  ensurePdfSpace(doc, 160)
  doc.moveDown(0.45)
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#17345f').text('Daily net sales chart')
  const x = 42
  const y = doc.y + 8
  const width = doc.page.width - 84
  const height = 110
  const max = report.daily.reduce((largest, row) => {
    const value = row.netSalesMinor < 0n ? -row.netSalesMinor : row.netSalesMinor
    return value > largest ? value : largest
  }, 0n)
  doc.save()
  doc.rect(x, y, width, height).fill('#f6f8fb')
  doc.strokeColor('#d9e1ec').lineWidth(0.5).moveTo(x, y + height - 18).lineTo(x + width, y + height - 18).stroke()
  const slot = width / Math.max(report.daily.length, 1)
  for (let index = 0; index < report.daily.length; index += 1) {
    const row = report.daily[index]!
    const magnitude = row.netSalesMinor < 0n ? -row.netSalesMinor : row.netSalesMinor
    const scaled = max === 0n ? 0 : Number((magnitude * 1_000n) / max)
    const barHeight = Math.max(0, (height - 32) * scaled / 1_000)
    const barWidth = Math.max(1, Math.min(12, slot * 0.62))
    const barX = x + index * slot + (slot - barWidth) / 2
    doc.rect(barX, y + height - 19 - barHeight, barWidth, barHeight).fill('#c9a24b')
    if (index % Math.max(1, Math.ceil(report.daily.length / 15)) === 0) {
      doc.font('Helvetica').fontSize(5.5).fillColor('#596779')
        .text(row.date.slice(8), barX - 2, y + height - 15, { width: barWidth + 4, align: 'center' })
    }
  }
  doc.restore()
  doc.y = y + height + 9
}

function pdfCell(value: ExportValue, kind: ExportColumnKind, report: AccountingReport): string {
  if (value === null) return '—'
  if (typeof value === 'bigint') {
    if (kind === 'money') return `${report.header.currency.code} ${minorToMajor(value, report.header.currency.decimalPlaces)}`
    if (kind === 'quantity') return quantityMajor(value)
  }
  return String(value)
}

function pdfText(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').replace(/[^\x20-\x7E]/gu, '?')
}

function ensurePdfSpace(doc: InstanceType<typeof PDFDocument>, needed: number): void {
  if (doc.y + needed > doc.page.height - 36) doc.addPage()
}

function titleForSection(section: ReportSectionId): string {
  const labels: Record<ReportSectionId, string> = {
    summary: 'Daily and monthly accounting',
    'top-sellers': 'Top sellers',
    'slow-movers': 'Slow movers',
    valuation: 'Inventory valuation',
    'low-stock': 'Low stock',
    debtors: 'Debtors and customer credit',
    purchases: 'Purchases',
    'user-performance': 'User performance',
    'audit-log': 'Audit log',
    stocktake: 'Stocktake variances',
    pharmacy: 'Pharmacy reports',
    supermarket: 'Supermarket reports',
  }
  return labels[section]
}
