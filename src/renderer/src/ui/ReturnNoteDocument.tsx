import { formatMoney } from '@shared/currency/money'
import { formatPosQuantity } from '@shared/pos/receipt-format'
import type { ReturnRecord } from '@shared/returns/types'

interface Props {
  record: ReturnRecord
  layout: 'THERMAL_80' | 'THERMAL_58' | 'A4_RECEIPT' | 'A4_INVOICE'
}

const REASON_LABELS: Record<ReturnRecord['reason'], string> = {
  WRONG_ITEM: 'Wrong item',
  DAMAGED: 'Damaged',
  EXPIRED: 'Expired',
  CUSTOMER_CHANGED_MIND: 'Customer changed mind',
  OTHER: 'Other',
}

export function returnDocumentText(record: ReturnRecord): string {
  const amount = formatMoney(record.totalMinor, record.currency, record.display)
  const items = record.items.map((item) => `${formatPosQuantity(item.quantityMilli, item.unit)} ${item.description}`).join('\n')
  const credit = record.credit ? `\nCredit number: ${record.credit.creditNumber}` : ''
  return `${record.type === 'REFUND' ? 'Return note' : 'Credit note'} ${record.returnNumber}\nStore: ${record.store.name}\nOriginal receipt: ${record.receiptNumber}\nAmount: ${amount}\nReason: ${REASON_LABELS[record.reason]}${record.reasonNote ? ` — ${record.reasonNote}` : ''}${credit}\nItems:\n${items}`
}

export function ReturnNoteDocument({ record, layout }: Props) {
  const amount = (minor: bigint) => formatMoney(minor, record.currency, record.display)
  const isCredit = record.type !== 'REFUND'
  const title = isCredit ? 'CREDIT NOTE' : 'RETURN NOTE'
  return (
    <article className={`return-note-document return-note-document--${layout.toLowerCase()}`}>
      {record.duplicate && <div className="return-note-duplicate">DUPLICATE</div>}
      <header className="return-note-header">
        {record.store.storeLogo && <img src={record.store.storeLogo} alt="Store logo" />}
        <h2>{record.store.name}</h2>
        {record.store.address && <p>{record.store.address}</p>}
        {record.store.phone && <p>{record.store.phone}</p>}
        {record.store.email && <p>{record.store.email}</p>}
        {record.store.licenceNumber && <p>Licence: {record.store.licenceNumber}</p>}
        {record.store.taxNumber && <p>Tax ID: {record.store.taxNumber}</p>}
        <strong>{title}</strong>
      </header>

      <section className="return-note-meta">
        <div><span>Return number</span><strong>{record.returnNumber}</strong></div>
        <div><span>Original receipt</span><strong>{record.receiptNumber}</strong></div>
        <div><span>Date</span><strong>{new Date(record.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</strong></div>
        <div><span>Processed by</span><strong>{record.cashier || '—'}</strong></div>
        <div><span>Return type</span><strong>{record.type === 'REFUND' ? 'Refund' : record.type === 'STORE_CREDIT' ? 'Store credit' : 'Exchange'}</strong></div>
        {record.type === 'REFUND' && record.refundMethod && <div><span>Refund method</span><strong>{record.refundMethod === 'TRANSFER' ? 'Bank transfer' : record.refundMethod === 'CARD' ? 'Card / POS' : 'Cash'}</strong>{record.paymentReference && <small>Reference: {record.paymentReference}</small>}</div>}
        <div><span>Reason</span><strong>{REASON_LABELS[record.reason]}{record.reasonNote ? ` — ${record.reasonNote}` : ''}</strong></div>
        {record.customer && <div className="return-note-meta__customer"><span>Customer</span><strong>{record.customer.name}</strong>{record.customer.phone && <small>{record.customer.phone}</small>}</div>}
      </section>

      <table className="return-note-items">
        <thead><tr><th>Item</th><th>Qty</th><th>Disposition</th><th>Value</th></tr></thead>
        <tbody>{record.items.map((item) => <tr key={item.id}>
          <td><strong>{item.description}</strong><small>{item.sku}{item.sourceBatchNumber ? ` · Batch ${item.sourceBatchNumber}${item.sourceExpiryDate ? ` · exp ${item.sourceExpiryDate}` : ''}` : ''}</small></td>
          <td><bdi dir="ltr">{formatPosQuantity(item.quantityMilli, item.unit)}</bdi></td>
          <td>{item.stockDisposition === 'RESTOCKED' ? 'Returned to stock' : item.stockDisposition === 'WRITTEN_OFF' ? `Written off${item.writeoffReason ? ` · ${item.writeoffReason}` : ''}` : 'No stock item'}</td>
          <td><bdi dir="ltr">{amount(item.lineTotalMinor)}</bdi></td>
        </tr>)}</tbody>
      </table>

      <section className="return-note-totals">
        {record.promotionAmountReversedMinor > 0n && <div><span>Promotion value reversed</span><bdi dir="ltr">{amount(record.promotionAmountReversedMinor)}</bdi></div>}
        {record.loyaltyDiscountReversedMinor > 0n && <div><span>Loyalty discount reversed</span><bdi dir="ltr">{amount(record.loyaltyDiscountReversedMinor)}</bdi></div>}
        <div className="return-note-total"><strong>{isCredit ? 'Credit value' : 'Refund amount'}</strong><strong><bdi dir="ltr">{amount(record.totalMinor)}</bdi></strong></div>
      </section>

      {record.credit && <section className="return-note-credit"><strong>{record.type === 'EXCHANGE' ? 'Exchange credit' : 'Store credit'}</strong><span>Credit number: {record.credit.creditNumber}</span><bdi dir="ltr">{amount(record.credit.remainingMinor)} available</bdi></section>}
      {record.approvedBy && <p className="return-note-approval">Approved by {record.approvedBy}{record.approvalChannel === 'MOBILE' ? ' · Admin phone' : ''}</p>}
      {record.returnWindowOverride && <p className="return-note-approval">Admin return-window override: {record.returnWindowOverrideReason}</p>}
      {record.store.receiptFooter && <p className="return-note-footer">{record.store.receiptFooter}</p>}
      {record.store.thankYouNote && <p className="return-note-thanks">{record.store.thankYouNote}</p>}
      <footer className="return-note-footline">{record.currency.code} · Original sale {record.receiptNumber}</footer>
    </article>
  )
}
