import type { MobileSaleDetail } from '../../src/shared/mobile/admin-types'
import { defaultDisplayOptions, formatMoney } from '../../src/currency/money'

/**
 * Builds a shareable document for a sale, on the phone, from the data the host sent.
 *
 * Two formats, because phones fail differently: a PDF opens everywhere and prints at the counter, and a PNG
 * goes straight into WhatsApp. Both are laid out here (not by the host) so the host never has to render
 * anything for a share, and both format money with the *sale's own* currency, using the same `formatMoney`
 * the desktop uses. A Naira invoice shared in a shop that has since re-locked the currency still reads in
 * Naira, because the sale stores the currency it was made in.
 */

const NAVY = '#1f3f73'
const GOLD = '#c9a24b'
const INK = '#1d2b3a'
const MUTED = '#6b7a8c'

function amount(minor: string, sale: MobileSaleDetail): string {
  return formatMoney(BigInt(minor), sale.currency, defaultDisplayOptions(sale.currency))
}

interface DocumentLine {
  text: string
  size: number
  bold?: boolean
  /** Extra space before this line, in points. */
  gap?: number
  /** Line advance, when a line needs more (or less) than the default. */
  height?: number
}

function documentLines(sale: MobileSaleDetail): DocumentLine[] {
  const lines: DocumentLine[] = []
  const title = sale.saleType === 'WHOLESALE' ? 'WHOLESALE INVOICE' : 'SALES RECEIPT'
  lines.push({ text: sale.header.storeName, size: 16, bold: true })
  if (sale.header.storeAddress) lines.push({ text: sale.header.storeAddress, size: 9 })
  if (sale.header.storePhone) lines.push({ text: sale.header.storePhone, size: 9 })
  lines.push({ text: '', size: 6 })
  lines.push({ text: title, size: 11, bold: true })
  lines.push({ text: `${sale.receiptNumber} · ${new Date(sale.createdAt).toLocaleString()}`, size: 9 })
  lines.push({ text: `Served by ${sale.cashier} at ${sale.workstation}`, size: 9, gap: 8 })
  if (sale.customer) {
    lines.push({ text: `Customer: ${sale.customer.name}`, size: 9 })
    if (sale.customer.phone) lines.push({ text: sale.customer.phone, size: 9 })
    if (sale.customer.address) lines.push({ text: sale.customer.address, size: 9 })
  }
  lines.push({ text: '', size: 6 })
  for (const line of sale.lines) {
    const quantity = formatQuantityForDocument(line.quantityMilli)
    lines.push({ text: `${line.description}`, size: 10, bold: true })
    lines.push({ text: `${quantity} ${line.unit} × ${amount(line.unitPriceMinor, sale)}   ${amount(line.lineTotalMinor, sale)}`, size: 9 })
  }
  lines.push({ text: '', size: 6 })
  lines.push({ text: `Subtotal                    ${amount(sale.subtotalMinor, sale)}`, size: 10 })
  if (sale.discountMinor !== '0') lines.push({ text: `Discount                   −${amount(sale.discountMinor, sale)}`, size: 10 })
  if (sale.taxMinor !== '0') lines.push({ text: `VAT                         ${amount(sale.taxMinor, sale)}`, size: 10 })
  lines.push({ text: `TOTAL                       ${amount(sale.totalMinor, sale)}`, size: 12, bold: true })
  lines.push({ text: `Paid                        ${amount(sale.paidMinor, sale)}`, size: 10 })
  if (sale.creditMinor !== '0') lines.push({ text: `On credit                   ${amount(sale.creditMinor, sale)}`, size: 10 })
  for (const payment of sale.payments) lines.push({ text: `${payment.method}   ${amount(payment.amountMinor, sale)}`, size: 9 })
  lines.push({ text: '', size: 10 })
  lines.push({ text: 'This copy was shared from the Admin phone.', size: 8 })
  return lines
}

function formatQuantityForDocument(quantityMilli: string): string {
  const value = BigInt(quantityMilli)
  const whole = value / 1_000n
  const fraction = (value % 1_000n).toString().padStart(3, '0').replace(/0+$/u, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

/** A minimal, valid PDF (no dependency on the desktop's pdfkit, which does not belong in a phone bundle). */
export function buildSalePdf(sale: MobileSaleDetail): Blob {
  const pageWidth = 595 // A4 at 72 dpi
  const pageHeight = 842
  const margin = 48
  const lineHeight = 15
  const operations: string[] = []
  let y = pageHeight - margin

  operations.push(`0.12 0.25 0.45 rg`)
  operations.push(`0 ${pageHeight - 6} ${pageWidth} 6 re f`)
  operations.push(`0.79 0.64 0.29 rg`)
  operations.push(`0 ${pageHeight - 10} ${pageWidth} 4 re f`)

  for (const line of documentLines(sale)) {
    if (line.gap) y -= line.gap
    if (line.text) {
      const escaped = line.text.replace(/\\/gu, '\\\\').replace(/\(/gu, '\\(').replace(/\)/gu, '\\)')
      const font = line.bold ? '/F2' : '/F1'
      const [red, green, blue] = hexToPdfRgb(line.bold ? NAVY : line.size <= 8 ? MUTED : INK)
      operations.push(`${red} ${green} ${blue} rg`)
      operations.push(`BT ${font} ${line.size} Tf ${margin} ${y} Td (${escaped}) Tj ET`)
    }
    y -= line.height ?? lineHeight
    if (y < margin) break
  }

  const content = operations.join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
  ]

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xrefStart = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
  return new Blob([pdf], { type: 'application/pdf' })
}

function hexToPdfRgb(hex: string): [string, string, string] {
  const value = hex.replace('#', '')
  return [
    (parseInt(value.slice(0, 2), 16) / 255).toFixed(3),
    (parseInt(value.slice(2, 4), 16) / 255).toFixed(3),
    (parseInt(value.slice(4, 6), 16) / 255).toFixed(3),
  ]
}

/**
 * A PNG of the same document, drawn on a canvas. Used for WhatsApp, where a photo is what people send.
 * `createImageBitmap`/`canvas.toBlob` are the only browser APIs needed, both present on iOS 16.4+ Safari.
 */
export async function buildSaleImage(sale: MobileSaleDetail): Promise<Blob> {
  const scale = 2
  const width = 720
  const lines = documentLines(sale)
  const height = Math.max(900, 160 + lines.reduce((total, line) => total + (line.height ?? 15) * 1.2 + (line.gap ?? 0), 0))

  const canvas = document.createElement('canvas')
  canvas.width = width * scale
  canvas.height = height * scale
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This phone could not draw the receipt image.')
  context.scale(scale, scale)
  context.fillStyle = '#fffdf8'
  context.fillRect(0, 0, width, height)
  context.fillStyle = NAVY
  context.fillRect(0, 0, width, 8)
  context.fillStyle = GOLD
  context.fillRect(0, 8, width, 4)

  let y = 60
  const x = 44
  for (const line of lines) {
    y += line.gap ?? 0
    if (line.text) {
      context.fillStyle = line.bold ? NAVY : line.size <= 8 ? MUTED : INK
      context.font = `${line.bold ? '700' : '400'} ${line.size + 4}px -apple-system, "Segoe UI", Roboto, sans-serif`
      context.fillText(line.text, x, y)
    }
    y += (line.height ?? 15) * 1.2
  }

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('This phone could not make the image.'))
    }, 'image/png')
  })
}
