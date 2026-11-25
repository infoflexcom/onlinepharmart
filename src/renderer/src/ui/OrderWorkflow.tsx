import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { formatMoney } from '@shared/currency/money'
import type { PublicUser } from '@shared/auth/types'
import type { InfoflexBridge } from '@shared/bridge'
import type { BootstrapData } from '@shared/shop/types'
import type { ProductRecord } from '@shared/inventory/types'
import type { PosCustomerRecord, ReceiptLayout, SaleType } from '@shared/pos/types'
import {
  ORDER_SLIP_NOT_A_RECEIPT,
  type FinalizeOrderResult, type OrderLineView, type OrderPriceChange, type OrderView,
} from '@shared/orders/types'
import type { PrintLogEntry } from '../../../services/print-gate-service'
import { can } from '../../../../packages/core/src/capabilities'
import { PosReceiptDocument } from './PosReceiptDocument'
import './orders.css'

/**
 * The order-to-receipt workflow, on one screen, for the two halves of a sale.
 *
 * A picker (USER) builds an order and generates a slip. An Account (ACCOUNT, or the Admin on the Server) watches the
 * queue those slips land in, takes the money, and finalizes the order into a receipt. Both halves are the same screen
 * because they are the same conversation: what the picker handed over is what the Account is paid for, and a second
 * screen would be a second idea of what an order is.
 *
 * ## The two things this screen must never do
 *
 * **It must not show a picker a print button.** Printing is gated on the Server by role, so a button here could not
 * print anyway — but a button that fails is worse than no button, because it teaches the person at the till that the
 * refusal is a malfunction. The controls are enforced server-side and the interface does not advertise what it cannot
 * do. What a picker gets instead is a slip marked, in the words the brief chose, NOT PAID - NOT A RECEIPT.
 *
 * **It must not let a sale be finalized twice.** Every finalize carries an idempotency key generated once per attempt
 * and reused by a retry, so a double-click, a frozen screen or two Accounts reaching for the same order produce one
 * sale and one stock deduction. The second Account is told the order is already completed rather than being shown an
 * error that invites them to try again.
 */

interface Props {
  bridge: InfoflexBridge
  bootstrap: BootstrapData
  user: PublicUser
}

interface BasketLine {
  productId: string
  name: string
  unit: string
  quantity: string
  manualDiscount: string
  prescriptionRequired: boolean
}

interface PaymentLine {
  method: string
  amount: string
  reference: string
}

/** How often the queue and a picker's own orders are refreshed, so a status change shows up without a reload. */
const POLL_MS = 4000

const LAYOUTS: Array<{ value: ReceiptLayout; label: string }> = [
  { value: 'THERMAL_80', label: '80 mm thermal' },
  { value: 'THERMAL_58', label: '58 mm thermal' },
  { value: 'A4_RECEIPT', label: 'A4 receipt' },
  { value: 'A4_INVOICE', label: 'A4 wholesale invoice' },
]

function newKey(prefix: string): string {
  // A fresh key per attempt is what makes a retry safe. Reusing one across different baskets would make the second
  // basket replay the first one's sale.
  try {
    return `${prefix}-${globalThis.crypto.randomUUID()}`
  } catch {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }
}

function message(caught: unknown): string {
  return caught instanceof Error ? caught.message : 'That action could not be completed.'
}

export function OrderWorkflow({ bridge, bootstrap, user }: Props) {
  const currency = bootstrap.settings.currency
  const display = bootstrap.settings.display
  const role = user.role === 'CASHIER' ? 'USER' : user.role
  // Every one of these is derived from the same capability sets the Server enforces, so the screen cannot offer
  // something the Server would refuse, and cannot hide something the Server would allow.
  const canBuild = can(role, 'build_order')
  const canPay = can(role, 'take_payment')
  const canPrint = can(role, 'print_documents')
  const canAudit = can(role, 'view_audit')

  const [catalog, setCatalog] = useState<ProductRecord[]>([])
  const [search, setSearch] = useState('')
  const [basket, setBasket] = useState<BasketLine[]>([])
  const [saleType, setSaleType] = useState<SaleType>('RETAIL')
  const [wholesaleAllowed, setWholesaleAllowed] = useState(false)
  const [customers, setCustomers] = useState<PosCustomerRecord[]>([])
  const [customerId, setCustomerId] = useState<string>('')
  const [quickName, setQuickName] = useState('')

  const [queue, setQueue] = useState<OrderView[]>([])
  const [myOrders, setMyOrders] = useState<OrderView[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [payments, setPayments] = useState<PaymentLine[]>([{ method: 'CASH', amount: '', reference: '' }])
  const [prescriptionAck, setPrescriptionAck] = useState(false)
  const [priceChanges, setPriceChanges] = useState<OrderPriceChange[] | null>(null)
  // Held for the whole time one attempt is in flight, and replaced only when a genuinely new attempt starts.
  const finalizeKey = useRef<string>(newKey('finalize'))

  const [slip, setSlip] = useState<OrderView | null>(null)
  const [receipt, setReceipt] = useState<{ record: Awaited<ReturnType<InfoflexBridge['getPosReceipt']>>; layout: ReceiptLayout; duplicate: boolean } | null>(null)
  const [printLog, setPrintLog] = useState<PrintLogEntry[]>([])
  const [reprintReason, setReprintReason] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  const selected = useMemo(
    () => queue.find((order) => order.id === selectedId) ?? myOrders.find((order) => order.id === selectedId) ?? null,
    [queue, myOrders, selectedId],
  )

  const loadCatalog = useCallback((term: string) => {
    void bridge.getInventoryOverview(term).then((result) => setCatalog(result.products)).catch(() => undefined)
  }, [bridge])

  const refresh = useCallback(async () => {
    const results: Array<Promise<unknown>> = []
    if (canPay) results.push(bridge.listOrderQueue().then(setQueue).catch(() => undefined))
    if (canBuild) results.push(bridge.listMyOrders().then(setMyOrders).catch(() => undefined))
    if (canPrint || canAudit) results.push(bridge.listPrintLog(50).then(setPrintLog).catch(() => undefined))
    await Promise.all(results)
  }, [bridge, canPay, canBuild, canPrint, canAudit])

  useEffect(() => {
    void bridge.listPosCustomers().then(setCustomers).catch(() => undefined)
    void bridge.canMakeWholesaleSale().then(setWholesaleAllowed).catch(() => setWholesaleAllowed(false))
    loadCatalog('')
    void refresh()
  }, [bridge, loadCatalog, refresh])

  // Liveness. A picker watching their order go from PENDING to PAID, and an Account watching the queue fill, are both
  // reading the same poll; without it the screen would only ever show the moment it was opened.
  useEffect(() => {
    const timer = window.setInterval(() => { void refresh().catch(() => undefined) }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    if (search.trim()) loadCatalog(search.trim())
  }, [search, loadCatalog])

  function unitPriceOf(product: ProductRecord): bigint | null {
    if (product.weighedItem) return product.pricePerKgMinor
    return saleType === 'WHOLESALE' ? product.wholesalePriceMinor : product.retailPriceMinor
  }

  function addToBasket(product: ProductRecord) {
    setError('')
    const existing = basket.find((line) => line.productId === product.id)
    if (existing) {
      setBasket(basket.map((line) => (line.productId === product.id ? { ...line, quantity: bump(line.quantity) } : line)))
      return
    }
    setBasket([...basket, {
      productId: product.id, name: product.name, unit: product.unit, quantity: '1', manualDiscount: '',
      prescriptionRequired: product.prescriptionRequired,
    }])
    void unitPriceOf(product)
  }

  function bump(quantity: string): string {
    const match = /^(\d+)(?:\.(\d{0,3}))?$/u.exec(quantity.trim())
    if (!match) return '1'
    const milli = BigInt(match[1]!) * 1000n + BigInt((match[2] ?? '').padEnd(3, '0') || '0') + 1000n
    const whole = milli / 1000n
    const fraction = (milli % 1000n).toString().padStart(3, '0').replace(/0+$/u, '')
    return `${whole}${fraction ? `.${fraction}` : ''}`
  }

  const basketTotals = useMemo(() => {
    let subtotal = 0n
    let discount = 0n
    for (const line of basket) {
      const product = catalog.find((candidate) => candidate.id === line.productId)
      const price = product ? unitPriceOf(product) : null
      if (price === null) continue
      const match = /^(\d+)(?:\.(\d{0,3}))?$/u.exec(line.quantity.trim())
      const quantityMilli = match ? BigInt(match[1]!) * 1000n + BigInt((match[2] ?? '').padEnd(3, '0') || '0') : 0n
      subtotal += (price * quantityMilli) / 1000n
      try {
        discount += line.manualDiscount.trim() ? parseMinor(line.manualDiscount) : 0n
      } catch {
        // An unparsable discount is ignored in the on-screen total and caught properly by the Server on submit.
        // Guessing a number here would show a total the Server then disagrees with.
      }
    }
    return { subtotal, discount, total: subtotal - discount }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basket, catalog, saleType])

  function parseMinor(value: string): bigint {
    const match = /^(\d+)(?:\.(\d+))?$/u.exec(value.trim())
    if (!match) throw new Error('Enter a valid amount.')
    const decimals = currency.decimalPlaces
    const fraction = (match[2] ?? '').slice(0, decimals).padEnd(decimals, '0')
    return BigInt(match[1]!) * 10n ** BigInt(decimals) + (decimals > 0 ? BigInt(fraction) : 0n)
  }

  async function generateOrder(event: FormEvent) {
    event.preventDefault()
    setError('')
    setNotice('')
    if (basket.length === 0) { setError('Add at least one item before generating the order.'); return }
    setBusy(true)
    try {
      const order = await bridge.createOrder({
        saleType,
        items: basket.map((line) => ({
          productId: line.productId, quantity: line.quantity,
          ...(line.manualDiscount.trim() ? { manualDiscount: line.manualDiscount.trim() } : {}),
        })),
        customerId: customerId || null,
        idempotencyKey: newKey('create'),
      })
      setSlip(order)
      setBasket([])
      setNotice(`Order ${order.orderNumber} is waiting for payment. It appears on the Account's screen now.`)
      await refresh()
    } catch (caught) {
      setError(message(caught))
    } finally {
      setBusy(false)
    }
  }

  async function addCustomer(event: FormEvent) {
    event.preventDefault()
    setError('')
    try {
      const created = await bridge.createPosCustomer({ name: quickName, phone: '', email: '', address: '', creditLimit: '0', enrolLoyalty: false })
      setCustomers([created, ...customers])
      setCustomerId(created.id)
      setQuickName('')
    } catch (caught) {
      setError(message(caught))
    }
  }

  async function cancelOrder(order: OrderView) {
    const reason = window.prompt(`Why is order ${order.orderNumber} being cancelled? The reason is recorded.`, '')
    if (reason === null) return
    if (!reason.trim()) { setError('Give a reason for cancelling. It is recorded on the audit trail.'); return }
    setError('')
    try {
      await bridge.cancelOrder(order.id, reason.trim())
      setSlip((current) => (current?.id === order.id ? null : current))
      setNotice(`Order ${order.orderNumber} was cancelled and its stock released.`)
      await refresh()
    } catch (caught) {
      setError(message(caught))
    }
  }

  async function adjustLine(order: OrderView, line: OrderLineView) {
    const next = window.prompt(
      `New quantity for ${line.description}. The change is recorded with your name and the quantity before it.`,
      String(Number(line.quantityMilli) / 1000),
    )
    if (next === null || next.trim() === '') return
    setError('')
    try {
      await bridge.adjustOrderLine(order.id, line.id, next.trim())
      setNotice(`Quantity on ${line.description} updated.`)
      await refresh()
    } catch (caught) {
      setError(message(caught))
    }
  }

  const tender = useMemo(() => {
    if (!selected) return { paid: 0n, change: 0n, due: 0n }
    let cash = 0n
    let other = 0n
    for (const line of payments) {
      if (!line.amount.trim()) continue
      let amount: bigint
      try {
        amount = parseMinor(line.amount)
      } catch {
        continue
      }
      if (line.method === 'CASH') cash += amount
      else other += amount
    }
    const due = selected.totalMinor - other > 0n ? selected.totalMinor - other : 0n
    const applied = cash < due ? cash : due
    return { paid: other + applied, change: cash - applied, due: due - applied }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payments, selected])

  async function finalize(acceptPriceChange: boolean) {
    if (!selected) return
    setError('')
    setNotice('')
    setBusy(true)
    try {
      const result: FinalizeOrderResult = await bridge.finalizeOrder(selected.id, {
        idempotencyKey: finalizeKey.current,
        payments: payments.filter((line) => line.amount.trim())
          .map((line) => ({ method: line.method, amount: line.amount.trim(), reference: line.reference.trim() || undefined })),
        customerId: selected.customerId,
        prescriptionAcknowledged: selected.needsPrescriptionAck ? prescriptionAck : undefined,
        acceptPriceChange,
      })
      setPriceChanges(null)
      setSelectedId(null)
      setPayments([{ method: 'CASH', amount: '', reference: '' }])
      setPrescriptionAck(false)
      setNotice(result.idempotentReplay
        ? `Order ${result.order.orderNumber} was already completed — this is the same receipt, not a second sale.`
        : `Order ${result.order.orderNumber} is paid. Receipt ${result.receiptNumber}.`)
      await refresh()
      // A new attempt starts here, so the next finalize gets a new key. Reusing a spent key would replay this sale.
      finalizeKey.current = newKey('finalize')
      if (canPrint) await openReceipt(result.saleId, receipt?.layout ?? 'THERMAL_80')
    } catch (caught) {
      const text = message(caught)
      // A price that moved since the picker generated the order is shown as a difference and needs an explicit yes.
      // Repricing silently would print a receipt the customer was never quoted.
      if (/price/iu.test(text) && /chang/iu.test(text)) {
        try {
          const fresh = await bridge.getOrder(selected.id)
          setPriceChanges(await detectChanges(fresh))
          setError(text)
        } catch {
          setError(text)
        }
      } else {
        setError(text)
        await refresh()
      }
    } finally {
      setBusy(false)
    }
  }

  /**
   * What moved between the order's snapshot and the price list as it stands now.
   *
   * Computed here only to show the Account the difference. The Server makes the same comparison itself and refuses the
   * finalize until it is accepted, so this display being wrong could never let a wrong price through.
   */
  async function detectChanges(order: OrderView): Promise<OrderPriceChange[]> {
    const overview = await bridge.getInventoryOverview('')
    return order.lines.flatMap((line) => {
      // A snapshot line keeps its description even if the product behind it is gone; with nothing to compare it to, it
      // is not a price change, and inventing one would ask the Account to accept a difference nobody can see.
      if (!line.productId) return []
      const product = overview.products.find((candidate) => candidate.id === line.productId)
      if (!product) return []
      const now = order.type === 'WHOLESALE' ? product.wholesalePriceMinor : product.retailPriceMinor
      return now === line.unitPriceMinor ? [] : [{
        productId: line.productId, description: line.description, wasMinor: line.unitPriceMinor, nowMinor: now,
      }]
    })
  }

  async function openReceipt(saleId: number, layout: ReceiptLayout, reason?: string) {
    setError('')
    try {
      const record = reason === undefined
        ? await bridge.recordPosReceiptPrint(saleId, layout)
        : await bridge.recordPosReceiptPrint(saleId, layout, reason)
      setReceipt({ record, layout, duplicate: record.duplicate })
      setReprintReason('')
      window.setTimeout(() => window.print(), 30)
    } catch (caught) {
      setError(message(caught))
    }
  }

  async function reprint() {
    if (!receipt) return
    if (!reprintReason.trim()) {
      setError('Give a reason for printing this document again. It is recorded beside the copy.')
      return
    }
    await openReceipt(receipt.record.id, receipt.layout, reprintReason.trim())
    await refresh()
  }

  const queueForDisplay = canPay ? queue : []
  const mineForDisplay = canBuild ? myOrders : []

  return (
    <section className="orders-workspace" aria-labelledby="orders-title">
      <header className="orders-header">
        <div>
          <span className="eyebrow">ORDER TO RECEIPT</span>
          <h2 id="orders-title">Orders and receipts</h2>
          <p>
            {canPay
              ? 'Take payment for the orders pickers have generated, or finalize one into a printed receipt.'
              : 'Pick the goods, then generate the order. An Account takes payment and prints the receipt.'}
          </p>
        </div>
        {/* Stated plainly rather than left to be inferred from an absent button: a picker who cannot print should know
            that is a rule, not a broken screen. */}
        {!canPrint && <p className="orders-no-print">Printing is available to Accounts and the Admin only.</p>}
      </header>

      {error && <div className="form-error" role="alert">{error}</div>}
      {notice && <div className="mobile-access__notice is-success" role="status">{notice}</div>}

      <div className="orders-columns">
        {canBuild && (
          <div className="orders-pane">
            <h3>{canPay ? 'Build an order' : 'Pick the goods'}</h3>

            <div className="orders-search">
              <label>
                <span>Search or scan</span>
                <input
                  value={search}
                  placeholder="Name, SKU or barcode"
                  onChange={(event) => setSearch(event.currentTarget.value)}
                />
              </label>
              {wholesaleAllowed && (
                <label className="orders-sale-type">
                  <span>Sale type</span>
                  <select value={saleType} onChange={(event) => setSaleType(event.currentTarget.value as SaleType)}>
                    <option value="RETAIL">Retail</option>
                    <option value="WHOLESALE">Wholesale</option>
                  </select>
                </label>
              )}
            </div>

            <ul className="orders-catalog">
              {catalog.slice(0, 12).map((product) => (
                <li key={product.id}>
                  <button type="button" onClick={() => addToBasket(product)}>
                    <strong>{product.name}</strong>
                    <small>{product.sku}{product.prescriptionRequired ? ' · prescription' : ''}</small>
                    <span>{unitPriceOf(product) === null ? 'Price needed' : formatMoney(unitPriceOf(product)!, currency, display)}</span>
                  </button>
                </li>
              ))}
              {catalog.length === 0 && <li className="orders-empty">Nothing matches that search.</li>}
            </ul>

            <form className="orders-basket" onSubmit={generateOrder}>
              <h4>Basket</h4>
              {basket.length === 0 && <p className="orders-empty">No items yet.</p>}
              {basket.map((line) => (
                <div className="orders-basket-line" key={line.productId}>
                  <span>{line.name}{line.prescriptionRequired && <em> prescription</em>}</span>
                  <label>
                    <span>Qty</span>
                    <input
                      value={line.quantity} inputMode="decimal"
                      onChange={(event) => setBasket(basket.map((candidate) => (
                        candidate.productId === line.productId ? { ...candidate, quantity: event.currentTarget.value } : candidate
                      )))}
                    />
                  </label>
                  <label>
                    <span>Discount</span>
                    <input
                      value={line.manualDiscount} inputMode="decimal" placeholder="0.00"
                      onChange={(event) => setBasket(basket.map((candidate) => (
                        candidate.productId === line.productId ? { ...candidate, manualDiscount: event.currentTarget.value } : candidate
                      )))}
                    />
                  </label>
                  <button
                    type="button" aria-label={`Remove ${line.name}`}
                    onClick={() => setBasket(basket.filter((candidate) => candidate.productId !== line.productId))}
                  >
                    ×
                  </button>
                </div>
              ))}

              <div className="orders-totals">
                <div><span>Subtotal</span><strong>{formatMoney(basketTotals.subtotal, currency, display)}</strong></div>
                <div><span>Discount</span><strong>{formatMoney(basketTotals.discount, currency, display)}</strong></div>
                <div><span>Total</span><strong>{formatMoney(basketTotals.total, currency, display)}</strong></div>
              </div>

              <div className="orders-customer">
                <label>
                  <span>Customer (optional)</span>
                  <select value={customerId} onChange={(event) => setCustomerId(event.currentTarget.value)}>
                    <option value="">Walk-in</option>
                    {customers.map((customer) => (
                      <option key={customer.id} value={customer.id}>{customer.name}</option>
                    ))}
                  </select>
                </label>
                <div className="orders-quick-add">
                  <input
                    value={quickName} placeholder="New customer name" aria-label="New customer name"
                    onChange={(event) => setQuickName(event.currentTarget.value)}
                  />
                  <button type="button" className="pos-link-button" onClick={(event) => void addCustomer(event as unknown as FormEvent)}>
                    Add
                  </button>
                </div>
              </div>

              <button type="submit" className="inventory-primary" disabled={busy || basket.length === 0}>
                {busy ? 'Working…' : 'Generate receipt'}
              </button>
              <p className="orders-muted">
                Generating an order reserves the stock and snapshots the prices. Nothing is paid and no receipt is printed.
              </p>
            </form>

            {slip && (
              <div className="orders-slip" role="status">
                {/* The slip says what it is on its face. A picker who hands this to a customer as a receipt has been
                    given every chance to be wrong about it. */}
                <div className="orders-slip-banner">{ORDER_SLIP_NOT_A_RECEIPT}</div>
                <h4>Order {slip.orderNumber}</h4>
                <p>Status: <strong className={`orders-status is-${slip.status.toLowerCase()}`}>{slip.status}</strong></p>
                <ul>
                  {slip.lines.map((line) => (
                    <li key={line.id}>
                      <span>{line.description}</span>
                      <span>{Number(line.quantityMilli) / 1000} {line.unit}</span>
                      <span>{formatMoney(line.lineTotalMinor, currency, display)}</span>
                    </li>
                  ))}
                </ul>
                <div className="orders-totals">
                  <div><span>Subtotal</span><strong>{formatMoney(slip.subtotalMinor, currency, display)}</strong></div>
                  <div><span>Discount</span><strong>{formatMoney(slip.discountMinor, currency, display)}</strong></div>
                  <div><span>Total due</span><strong>{formatMoney(slip.totalMinor, currency, display)}</strong></div>
                </div>
                {/* Deliberately no print control here, for any role that reaches this pane without `print_documents`. */}
                <button type="button" className="inventory-secondary" onClick={() => void cancelOrder(slip)}>
                  Cancel this order
                </button>
              </div>
            )}

            <h4>Your orders</h4>
            <ul className="orders-list">
              {mineForDisplay.map((order) => (
                <li key={order.id}>
                  <strong>{order.orderNumber}</strong>
                  <span className={`orders-status is-${order.status.toLowerCase()}`}>{order.status}</span>
                  <span>{formatMoney(order.totalMinor, currency, display)}</span>
                  <span>{order.receiptNumber ? `Receipt ${order.receiptNumber}` : 'Awaiting payment'}</span>
                  {order.status === 'PENDING' && (
                    <button type="button" onClick={() => void cancelOrder(order)}>Cancel</button>
                  )}
                </li>
              ))}
              {mineForDisplay.length === 0 && <li className="orders-empty">No orders yet.</li>}
            </ul>
          </div>
        )}

        {canPay && (
          <div className="orders-pane">
            <h3>Payment queue</h3>
            <ul className="orders-list orders-queue">
              {queueForDisplay.map((order) => (
                <li key={order.id} className={order.id === selectedId ? 'is-selected' : undefined}>
                  <button type="button" onClick={() => { setSelectedId(order.id); setPriceChanges(null) }}>
                    <strong>{order.orderNumber}</strong>
                    <small>{order.createdByName}{order.customerName ? ` · ${order.customerName}` : ''}</small>
                    <span>{formatMoney(order.totalMinor, currency, display)}</span>
                  </button>
                </li>
              ))}
              {queueForDisplay.length === 0 && <li className="orders-empty">No unpaid orders waiting.</li>}
            </ul>

            {selected && (
              <div className="orders-payment">
                <h4>Order {selected.orderNumber}</h4>
                <ul className="orders-lines">
                  {selected.lines.map((line) => (
                    <li key={line.id}>
                      <span>{line.description}</span>
                      <span>{Number(line.quantityMilli) / 1000} {line.unit}</span>
                      <span>{formatMoney(line.unitPriceMinor, currency, display)} each</span>
                      <strong>{formatMoney(line.lineTotalMinor, currency, display)}</strong>
                      {/* An Account may correct a quantity at the till, and the correction is recorded with their name
                          and the quantity before it. */}
                      <button type="button" onClick={() => void adjustLine(selected, line)}>Adjust</button>
                    </li>
                  ))}
                </ul>

                {priceChanges && (
                  <div className="orders-price-change" role="alert">
                    <strong>Prices changed since this order was generated</strong>
                    <ul>
                      {priceChanges.map((change) => (
                        <li key={change.productId}>
                          {change.description}: was {formatMoney(change.wasMinor, currency, display)}, now{' '}
                          {formatMoney(change.nowMinor, currency, display)}
                        </li>
                      ))}
                    </ul>
                    <button type="button" className="inventory-primary" disabled={busy} onClick={() => void finalize(true)}>
                      Accept the new prices and finalize
                    </button>
                  </div>
                )}

                <div className="orders-totals">
                  <div><span>Subtotal</span><strong>{formatMoney(selected.subtotalMinor, currency, display)}</strong></div>
                  <div><span>Discount</span><strong>{formatMoney(selected.discountMinor, currency, display)}</strong></div>
                  <div><span>Total due</span><strong>{formatMoney(selected.totalMinor, currency, display)}</strong></div>
                </div>

                <div className="orders-payments">
                  {payments.map((line, index) => (
                    <div className="pos-payment-line" key={`${line.method}-${index}`}>
                      <label>
                        <span>Method</span>
                        <select
                          value={line.method}
                          onChange={(event) => setPayments(payments.map((candidate, at) => (
                            at === index ? { ...candidate, method: event.currentTarget.value } : candidate
                          )))}
                        >
                          <option value="CASH">Cash</option>
                          <option value="TRANSFER">Transfer</option>
                          <option value="CARD">POS / Card</option>
                          <option value="CREDIT">Credit / on account</option>
                        </select>
                      </label>
                      <label>
                        <span>{line.method === 'CASH' ? 'Cash tendered' : 'Amount applied'}</span>
                        <input
                          value={line.amount} inputMode="decimal"
                          onChange={(event) => setPayments(payments.map((candidate, at) => (
                            at === index ? { ...candidate, amount: event.currentTarget.value } : candidate
                          )))}
                        />
                      </label>
                      <label>
                        <span>Reference <small>optional</small></span>
                        <input
                          value={line.reference} maxLength={120}
                          onChange={(event) => setPayments(payments.map((candidate, at) => (
                            at === index ? { ...candidate, reference: event.currentTarget.value } : candidate
                          )))}
                        />
                      </label>
                      {payments.length > 1 && (
                        <button
                          type="button" aria-label={`Remove ${line.method} payment`}
                          onClick={() => setPayments(payments.filter((_candidate, at) => at !== index))}
                        >
                          ×
                        </button>
                      )}
                    </div>
                  ))}
                  <div className="pos-add-payment-actions">
                    {/* Split tender: a customer paying part cash and part by card is ordinary, and forcing one method
                        would push the till towards recording a payment that did not happen. */}
                    <button type="button" className="pos-link-button" onClick={() => setPayments([...payments, { method: 'TRANSFER', amount: '', reference: '' }])}>
                      + Transfer
                    </button>
                    <button type="button" className="pos-link-button" onClick={() => setPayments([...payments, { method: 'CARD', amount: '', reference: '' }])}>
                      + POS / Card
                    </button>
                    <button type="button" className="pos-link-button" onClick={() => setPayments([...payments, { method: 'CREDIT', amount: '', reference: '' }])}>
                      + Credit
                    </button>
                  </div>
                </div>

                <div className="pos-tender-summary">
                  <div><span>Paid</span><strong>{formatMoney(tender.paid, currency, display)}</strong></div>
                  <div><span>Change due</span><strong>{formatMoney(tender.change, currency, display)}</strong></div>
                  <div><span>Still due</span><strong>{formatMoney(tender.due, currency, display)}</strong></div>
                  {!selected.customerId && payments.some((line) => line.method === 'CREDIT') && (
                    <small>Credit needs a customer. Add one to the order first.</small>
                  )}
                </div>

                {selected.needsPrescriptionAck && (
                  <label className="pos-prescription-check">
                    <input type="checkbox" checked={prescriptionAck} onChange={(event) => setPrescriptionAck(event.currentTarget.checked)} />
                    {' '}I confirm the prescription requirement has been checked for the listed items.
                  </label>
                )}

                <div className="pos-checkout-actions">
                  <button
                    type="button" className="inventory-primary" disabled={busy || (selected.needsPrescriptionAck && !prescriptionAck)}
                    onClick={() => void finalize(false)}
                  >
                    {busy ? 'Finalizing…' : 'Finalize and print'}
                  </button>
                  <button type="button" className="inventory-secondary" onClick={() => void cancelOrder(selected)}>
                    Cancel order
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {receipt && (
        <div className="pos-modal-backdrop orders-receipt-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setReceipt(null) }}>
          <section className="pos-modal pos-receipt-modal" role="dialog" aria-modal="true" aria-labelledby="orders-receipt-title">
            <header className="pos-modal-header pos-receipt-modal-header">
              <div>
                <span className="eyebrow">PRINT PREVIEW · {receipt.record.currency.code}</span>
                <h3 id="orders-receipt-title">
                  Receipt {receipt.record.receiptNumber}
                  {receipt.duplicate && <em className="pos-duplicate-pill">DUPLICATE</em>}
                </h3>
                <p>{receipt.record.store.name || 'Missing store name — printing is blocked.'}</p>
              </div>
              <button type="button" aria-label="Close receipt preview" onClick={() => setReceipt(null)}>×</button>
            </header>
            <div className="pos-print-controls">
              <label>
                <span>Layout</span>
                <select
                  value={receipt.layout}
                  onChange={(event) => setReceipt({ ...receipt, layout: event.currentTarget.value as ReceiptLayout })}
                >
                  {LAYOUTS.map((layout) => (
                    <option key={layout.value} value={layout.value}>{layout.label}</option>
                  ))}
                </select>
              </label>
              <input
                value={reprintReason} placeholder="Reason for printing again (required)" aria-label="Reason for printing again"
                maxLength={300} onChange={(event) => setReprintReason(event.currentTarget.value)}
              />
              <button type="button" className="inventory-primary" onClick={() => void reprint()}>Print / reprint</button>
              <small>A copy after the first is marked DUPLICATE and the reason is recorded in the print log.</small>
            </div>
            <div className="pos-receipt-preview-scroll">
              <div className="pos-receipt-print-root">
                <PosReceiptDocument receipt={receipt.record} layout={receipt.layout} />
              </div>
            </div>
          </section>
        </div>
      )}

      {canAudit && (
        <details className="orders-print-log">
          <summary>Print log ({printLog.length})</summary>
          <table>
            <thead>
              <tr><th>When</th><th>Document</th><th>Copy</th><th>Printed by</th><th>Machine</th><th>Reason</th></tr>
            </thead>
            <tbody>
              {printLog.map((entry) => (
                <tr key={entry.id}>
                  <td>{new Date(entry.printedAt).toLocaleString()}</td>
                  <td>{entry.receiptNumber ?? `${entry.kind} ${entry.documentId}`}</td>
                  <td>{entry.copyNumber}{entry.duplicate && <strong> DUPLICATE</strong>}</td>
                  <td>{entry.printedByName || entry.printedBy}</td>
                  <td>{entry.workstation || '—'}</td>
                  <td>{entry.reprintReason || '—'}</td>
                </tr>
              ))}
              {printLog.length === 0 && <tr><td colSpan={6}>Nothing has been printed yet.</td></tr>}
            </tbody>
          </table>
        </details>
      )}
    </section>
  )
}
