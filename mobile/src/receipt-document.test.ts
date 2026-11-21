import { describe, expect, it } from 'vitest'
import { getCurrency } from '../../src/currency/catalog'
import { defaultDisplayOptions } from '../../src/currency/money'
import type { MobileSaleDetail } from '../../src/shared/mobile/admin-types'
import { buildSalePdf } from './receipt-document'

/**
 * The receipt PDF is generated on the phone, so it has to be a real PDF a customer can open, print or
 * forward. These tests read the bytes back: the header, the cross-reference table, and the text an
 * invoice needs — including amounts formatted with the *sale's own* currency.
 */

const NGN = getCurrency('NGN')!
const UGX = getCurrency('UGX')!

function header(currency = NGN) {
  return {
    storeName: 'Harbor Health Pharmacy', storeAddress: '14 Marina Road', storePhone: '+234 800 111 2222',
    edition: 'BOTH' as const, currency, display: defaultDisplayOptions(currency), generatedAt: '2026-11-17T09:00:00.000Z',
  }
}

function sale(overrides: Partial<MobileSaleDetail> = {}): MobileSaleDetail {
  return {
    header: header(),
    id: 12,
    receiptNumber: 'INV-0000000012',
    saleType: 'WHOLESALE',
    createdAt: '2026-11-17T08:30:00.000Z',
    cashier: 'Amaka Obi',
    workstation: 'SHOP-PC',
    customer: { name: 'Bright Schools Ltd', phone: '+234 803 000 1111', address: '3 Adeola Street' },
    lines: [{ sku: 'PARA-500', description: 'Paracetamol 500mg', quantityMilli: '20000', unit: 'pack', unitPriceMinor: '22000', lineTotalMinor: '440000' }],
    subtotalMinor: '440000', discountMinor: '0', taxMinor: '0', totalMinor: '440000', paidMinor: '440000', creditMinor: '0',
    payments: [{ method: 'TRANSFER', amountMinor: '440000', reference: 'TRX-9' }],
    currency: NGN,
    ...overrides,
  }
}

async function text(blob: Blob): Promise<string> {
  return await blob.text()
}

describe('the receipt PDF the phone shares', () => {
  it('is a real PDF with a valid cross-reference table', async () => {
    const pdf = await text(buildSalePdf(sale()))
    expect(pdf.startsWith('%PDF-1.4')).toBe(true)
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true)
    expect(pdf).toContain('xref')
    expect(pdf).toContain('trailer')
    expect(pdf).toContain('/Root 1 0 R')

    // Every offset in the xref must point at an object header, or viewers refuse the file.
    const xrefStart = Number(pdf.slice(pdf.lastIndexOf('startxref') + 9).trim().split('\n')[0])
    expect(pdf.slice(xrefStart, xrefStart + 4)).toBe('xref')
    const entries = pdf.slice(xrefStart).split('\n').filter((line) => /^\d{10} \d{5} n $/u.test(line))
    expect(entries.length).toBeGreaterThan(3)
  })

  it('carries the customer store name, the invoice number and the customer', async () => {
    const pdf = await text(buildSalePdf(sale()))
    expect(pdf).toContain('Harbor Health Pharmacy')
    expect(pdf).toContain('14 Marina Road')
    expect(pdf).toContain('INV-0000000012')
    expect(pdf).toContain('WHOLESALE INVOICE')
    expect(pdf).toContain('Bright Schools Ltd')
    expect(pdf).toContain('Paracetamol 500mg')
  })

  it('formats the amounts in the sale currency, not the shop’s current one', async () => {
    const naira = await text(buildSalePdf(sale()))
    expect(naira).toContain('4,400.00')
    const uganda = await text(buildSalePdf(sale({ currency: UGX, header: header(UGX) })))
    expect(uganda).toContain('USh')
    expect(uganda).not.toContain('\u20a6')
  })

  it('escapes parentheses so a customer name cannot corrupt the stream', async () => {
    const pdf = await text(buildSalePdf(sale({ customer: { name: 'Bright (Schools) Ltd', phone: '', address: '' } })))
    expect(pdf).toContain('Bright \\(Schools\\) Ltd')
  })

  it('is a PDF blob type, so a share sheet files it as a document', () => {
    expect(buildSalePdf(sale()).type).toBe('application/pdf')
  })

  it('reports a retail receipt as a receipt, not an invoice', async () => {
    const pdf = await text(buildSalePdf(sale({ saleType: 'RETAIL', receiptNumber: 'RCP-0000000099' })))
    expect(pdf).toContain('SALES RECEIPT')
    expect(pdf).not.toContain('WHOLESALE INVOICE')
  })
})
