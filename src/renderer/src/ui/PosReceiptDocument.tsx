import { formatReceiptMoney, formatPosQuantity, usesIsoCodeFallback } from '@shared/pos/receipt-format'
import type { PosReceiptRecord, ReceiptLayout } from '@shared/pos/types'

interface Props {
  receipt: PosReceiptRecord
  layout: ReceiptLayout
}

const PAYMENT_LABELS = { CASH: 'Cash', TRANSFER: 'Transfer', CARD: 'POS / Card', CREDIT: 'Credit' } as const

export function PosReceiptDocument({ receipt, layout }: Props) {
  const thermalFallback = usesIsoCodeFallback(receipt, layout)
  const amount = (minor: bigint) => formatReceiptMoney(receipt, minor, layout)
  const date = new Date(receipt.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const isInvoice = layout === 'A4_INVOICE'
  const documentTitle = isInvoice ? 'WHOLESALE INVOICE' : 'SALES RECEIPT'

  return (
    <article className={`pos-receipt-document pos-receipt-document--${layout.toLowerCase()}`}>
      {receipt.duplicate && <div className="pos-receipt-duplicate">DUPLICATE</div>}
      <header className="pos-receipt-header">
        {receipt.store.storeLogo && <img className="pos-receipt-logo" src={receipt.store.storeLogo} alt="Store logo" />}
        <h2>{receipt.store.name}</h2>
        {receipt.store.address && <p>{receipt.store.address}</p>}
        {receipt.store.phone && <p>{receipt.store.phone}</p>}
        {receipt.store.email && <p>{receipt.store.email}</p>}
        {receipt.store.licenceNumber && <p>Licence: {receipt.store.licenceNumber}</p>}
        {receipt.store.taxNumber && <p>Tax ID: {receipt.store.taxNumber}</p>}
        <strong className="pos-receipt-title">{documentTitle}</strong>
      </header>

      <div className="pos-receipt-meta">
        <div><span>Receipt</span><strong>{receipt.receiptNumber}</strong></div>
        <div><span>Date</span><strong>{date}</strong></div>
        <div><span>Cashier</span><strong>{receipt.cashier || '—'}</strong></div>
        <div><span>Workstation</span><strong>{receipt.workstation || '—'}</strong></div>
        <div><span>Price tier</span><strong>{receipt.saleType === 'WHOLESALE' ? 'Wholesale' : 'Retail'}</strong></div>
        {receipt.customer && <div className="pos-receipt-meta__customer"><span>Customer</span><strong>{receipt.customer.name}</strong>
          {receipt.customer.phone && <small>{receipt.customer.phone}</small>}
          {receipt.customer.address && <small>{receipt.customer.address}</small>}
        </div>}
      </div>

      {thermalFallback && <p className="pos-receipt-currency-note">Currency symbol unavailable on this thermal layout; amounts use {receipt.currency.code}.</p>}

      <table className="pos-receipt-items">
        <thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead>
        <tbody>
          {receipt.items.map((item) => <tr key={item.id}>
            <td className="pos-receipt-item-name"><strong>{item.description}</strong><small>{item.sku}{item.priceTier === 'WHOLESALE' ? ' · Wholesale' : ''}</small>
              {item.batches.length > 0 && <small className="pos-receipt-batches">Batch {item.batches.map((batch) => `${batch.batchNumber} · exp ${batch.expiryDate}`).join(', ')}</small>}
            </td>
            <td><bdi dir="ltr">{formatPosQuantity(item.quantityMilli, item.unit)}</bdi></td>
            <td><bdi dir="ltr">{amount(item.unitPriceMinor)}</bdi></td>
            <td><bdi dir="ltr">{amount(item.lineTotalMinor)}</bdi></td>
          </tr>)}
        </tbody>
      </table>

      <section className="pos-receipt-totals" aria-label="Sale totals">
        <div><span>Subtotal</span><bdi dir="ltr">{amount(receipt.subtotalMinor)}</bdi></div>
        {receipt.promotionDiscountMinor > 0n && <div><span>Promotion{receipt.promotionName ? ` · ${receipt.promotionName}` : ''}</span><bdi dir="ltr">−{amount(receipt.promotionDiscountMinor)}</bdi></div>}
        {receipt.manualDiscountMinor > 0n && <div><span>Discount</span><bdi dir="ltr">−{amount(receipt.manualDiscountMinor)}</bdi></div>}
        {receipt.loyaltyDiscountMinor > 0n && <div><span>Loyalty reward ({receipt.loyaltyPointsRedeemed} pts)</span><bdi dir="ltr">−{amount(receipt.loyaltyDiscountMinor)}</bdi></div>}
        {receipt.taxMinor > 0n && <div><span>Tax</span><bdi dir="ltr">{amount(receipt.taxMinor)}</bdi></div>}
        <div className="pos-receipt-total"><strong>Total</strong><strong><bdi dir="ltr">{amount(receipt.totalMinor)}</bdi></strong></div>
      </section>

      <section className="pos-receipt-payments" aria-label="Payments">
        <h3>Payment</h3>
        {receipt.payments.map((payment) => <div key={payment.id}>
          <span>{PAYMENT_LABELS[payment.method]}{payment.reference ? ` · ${payment.reference}` : ''}</span>
          <bdi dir="ltr">{amount(payment.amountMinor)}</bdi>
        </div>)}
        {receipt.tenderedMinor > 0n && <div><span>Tendered</span><bdi dir="ltr">{amount(receipt.tenderedMinor)}</bdi></div>}
        {receipt.changeMinor > 0n && <div><span>Change</span><bdi dir="ltr">{amount(receipt.changeMinor)}</bdi></div>}
        {receipt.creditMinor > 0n && <div className="pos-receipt-credit"><span>Balance on account</span><bdi dir="ltr">{amount(receipt.creditMinor)}</bdi></div>}
      </section>

      {receipt.loyaltyPointsEarned > 0 && <p className="pos-receipt-loyalty">Loyalty points earned: {receipt.loyaltyPointsEarned}</p>}
      {receipt.warnings.length > 0 && <div className="pos-receipt-warning"><strong>Pharmacy notice</strong><span>Prescription-required items were sold after cashier confirmation.</span></div>}
      {receipt.store.receiptFooter && <p className="pos-receipt-footer">{receipt.store.receiptFooter}</p>}
      {receipt.store.thankYouNote && <p className="pos-receipt-thanks">{receipt.store.thankYouNote}</p>}
      {receipt.showPoweredBy !== false && <p className="pos-receipt-powered-by">Powered by Infoflex</p>}
      <footer className="pos-receipt-footline">{receipt.currency.code} · {receipt.receiptNumber}</footer>
    </article>
  )
}
