/**
 * The vocabulary every exported document shares, and the writer that turns it into CSV.
 *
 * Split out of `report-export.ts` for one concrete reason: that module imports `exceljs` and `pdfkit`, so anything that
 * imports it drags both into its own bundle. The browser preview needs the *tables* and the *CSV* — it has no filesystem
 * to write a workbook to and no printer to hand a PDF to — and a renderer that loaded pdfkit to render a CSV would be
 * paying for a feature it cannot use. So the pure half lives here, with no imports at all beyond types, and the heavy
 * half stays where it was.
 *
 * The formatting rules in here are not decoration and are not free to drift per caller:
 *
 * - Money crosses as minor units and leaves as text in the currency's own decimal places. Never a float: a kobo that
 *   has been through IEEE 754 on the way to a spreadsheet is a kobo nobody can find again.
 * - Quantities are milli-units, so three decimal places, with trailing zeros trimmed.
 * - Every cell is quoted, and a cell starting with `=`, `+`, `-`, `@`, tab or CR is prefixed with an apostrophe. That is
 *   CSV injection: a receipt number of `=HYPERLINK(...)` pasted into Excel must not become a formula.
 * - The file starts with a byte-order mark and ends lines with CRLF, which is what makes Excel open it as UTF-8 rather
 *   than in the machine's own code page — the shop's own product names are not ASCII.
 */

export type ExportValue = string | bigint | number | null
export type ExportColumnKind = 'text' | 'money' | 'quantity' | 'integer'

export interface ExportColumn {
  label: string
  kind: ExportColumnKind
}

export interface ExportTable {
  /** The worksheet name, and the identity of the section within a document. */
  name: string
  /** The heading a reader sees, in words. */
  title: string
  columns: ExportColumn[]
  rows: ExportValue[][]
}

/**
 * What every exported document says about itself, whichever feature produced it.
 *
 * The accounting reports and the daily audit are different documents with different tables, and they used to be welded
 * to one type: the worksheet writer took a whole `AccountingReport` and read four fields off its header. That is what
 * stopped the audit from having an export at all, and the fix is not a second copy of the writer — it is naming the
 * things a sheet actually needs.
 */
export interface ExportDocument {
  storeName: string
  storeAddress: string
  /** The period as it should read on paper, already worded by the caller. */
  periodLabel: string
  currency: { code: string; decimalPlaces: number }
  /** 'Store-wide', or 'Personal · Amaka', or 'One Account · Amaka Account' — again, already worded. */
  scopeLabel: string
  generatedAt: string
  /** The workbook's subject line and the file's own description, e.g. 'daily audit' or 'summary'. */
  subject: string
  tables: ExportTable[]
}

/**
 * Any document as CSV.
 *
 * The byte-order mark is what makes Excel open the file in UTF-8 rather than the machine's own code page, and the
 * CRLF line endings are what the RFC asks for; both were already true of the accounting export and both are true here,
 * because it is now the same function.
 */
export function createDocumentCsv(document: ExportDocument): string {
  const lines: string[] = [
    csvRow(['Store', document.storeName]),
    csvRow(['Address', document.storeAddress]),
    csvRow(['Period', document.periodLabel]),
    csvRow(['Currency', document.currency.code]),
    csvRow(['Scope', document.scopeLabel]),
  ]
  for (const table of document.tables) {
    lines.push('', csvRow([table.title]), csvRow(table.columns.map((column) => column.label)))
    for (const row of table.rows) {
      const cells = row.map((value, index) => csvCell(
        csvValue(value, table.columns[index]?.kind ?? 'text', document.currency.decimalPlaces),
        (table.columns[index]?.kind ?? 'text') === 'text',
      ))
      lines.push(cells.join(','))
    }
  }
  return `\uFEFF${lines.join('\r\n')}`
}

export function csvRow(values: unknown[]): string {
  return values.map((value) => csvCell(value === null || value === undefined ? '' : String(value), true)).join(',')
}

function csvCell(value: string, formulaSafe: boolean): string {
  const safe = formulaSafe && /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value
  return `"${safe.replace(/"/gu, '""')}"`
}

function csvValue(value: ExportValue, kind: ExportColumnKind, decimalPlaces: number): string {
  if (value === null) return ''
  if (typeof value === 'bigint') {
    if (kind === 'money') return minorToMajor(value, decimalPlaces)
    if (kind === 'quantity') return quantityMajor(value)
  }
  return String(value)
}

export function quantityMajor(value: bigint): string {
  const negative = value < 0n
  const magnitude = negative ? -value : value
  const whole = magnitude / 1_000n
  const fraction = (magnitude % 1_000n).toString().padStart(3, '0').replace(/0+$/u, '')
  const formatted = fraction ? `${whole}.${fraction}` : whole.toString()
  return negative ? `-${formatted}` : formatted
}

export function minorToMajor(value: bigint, decimalPlaces: number): string {
  const negative = value < 0n
  const magnitude = negative ? -value : value
  const scale = 10n ** BigInt(decimalPlaces)
  const whole = magnitude / scale
  const fraction = magnitude % scale
  const formatted = decimalPlaces === 0 ? whole.toString() : `${whole}.${fraction.toString().padStart(decimalPlaces, '0')}`
  return negative ? `-${formatted}` : formatted
}

