import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { formatMoney } from '@shared/currency/money'
import { fromMinor, parseMoneyExact } from '@shared/currency'
import type { AppPage, PublicUser } from '@shared/auth/types'
import type { InfoflexBridge } from '@shared/bridge'
import type { BootstrapData } from '@shared/shop/types'
import type { ProductRecord } from '@shared/inventory/types'
import type {
  HeldPosCartRecord,
  PosCustomerDraft,
  PosCustomerRecord,
  PosPaymentInput,
  PosPaymentMethod,
  PosQuoteRecord,
  PosReceiptRecord,
  PosRecentSaleRecord,
  ReceiptLayout,
  SaleType,
} from '@shared/pos/types'
import { formatPosQuantity } from '@shared/pos/receipt-format'
import { actorDiscountBasisPoints, resolveDiscountCap, shopDiscountLimit } from '../../../services/discount-cap'
import { PosReceiptDocument } from './PosReceiptDocument'

interface Props {
  bridge: InfoflexBridge
  bootstrap: BootstrapData
  user: PublicUser
  onNavigate: (page: AppPage) => void
}

interface CartLine {
  productId: string
  quantity: string
  manualDiscount: string
}

interface PaymentLine {
  method: PosPaymentMethod
  amount: string
  reference: string
}

const EMPTY_PAYMENT: PaymentLine = { method: 'CASH', amount: '', reference: '' }
const LAYOUT_OPTIONS: Array<{ value: ReceiptLayout; label: string }> = [
  { value: 'THERMAL_80', label: '80 mm thermal' },
  { value: 'THERMAL_58', label: '58 mm thermal' },
  { value: 'A4_RECEIPT', label: 'A4 receipt' },
  { value: 'A4_INVOICE', label: 'Wholesale A4 invoice' },
]

/**
 * The ceiling in words, for the line above the cart and for the discount field's own hover text.
 *
 * It says what happens above the ceiling rather than forbidding it, because that is what the Server does: an Admin is
 * asked. Naming the shop limit only when it is the tighter of the two follows `resolveDiscountCap`, which does not blame
 * a setting that is not stopping anything.
 */
export function discountCeilingSentence(cap: { limitBasisPoints: number; limitPercent: number; setBy: 'USER_PERMISSION' | 'SHOP_SETTINGS' }): string {
  const above = cap.limitBasisPoints === 0
    ? 'Every manual discount asks the Admin first.'
    : `Manual discounts up to ${cap.limitPercent}% go through; above that the Admin is asked.`
  return cap.setBy === 'SHOP_SETTINGS' ? `${above} The shop limit in Settings is the tighter of the two.` : above
}

export function PosWorkspace({ bridge, bootstrap, user, onNavigate }: Props) {
  const currency = bootstrap.settings.currency
  const display = bootstrap.settings.display
  const edition = bootstrap.setupContext.edition ?? bootstrap.appInfo.edition ?? 'PHARMACY'
  const supermarket = edition === 'SUPERMARKET' || edition === 'BOTH'
  const pharmacy = edition === 'PHARMACY' || edition === 'BOTH'
  // Wholesale and credit are switches on the Server - each is a flat refusal - so a boolean here mirrors them faithfully.
  const canWholesale = user.role === 'ADMIN' || user.permissions.allowWholesale
  const canCredit = user.role === 'ADMIN' || user.permissions.allowCreditSales

  /**
   * The discount ceiling, read from the module the till and the audit both read.
   *
   * This line used to be `user.role === 'ADMIN' || user.permissions.maxDiscountBasisPoints > 0`: a boolean made out of a
   * ceiling, with the shop-wide ceiling from Settings missing from it entirely. Two things followed. A cashier whose limit
   * the Admin set to 0 had the box disabled and so could not ask - and the Server would have asked for them, because
   * exceeding a ceiling raises an approval rather than refusing, which is what Phase 18 turned the flat refusal into. And
   * a cashier with 20% of their own in a shop capped at 5% saw an enabled box, typed 10%, and met the ceiling only when
   * Complete sale came back with it.
   *
   * So the screen no longer decides whether discounting is allowed. It states the ceiling and leaves what happens above it
   * to the Server, which is the division of labour the rest of this screen already follows.
   */
  const discountCap = resolveDiscountCap(
    actorDiscountBasisPoints(user.role, user.permissions.maxDiscountBasisPoints),
    shopDiscountLimit(bootstrap.settings),
  )
  const searchRef = useRef<HTMLInputElement>(null)
  const pendingSubmission = useRef<{ fingerprint: string; key: string } | null>(null)

  const [catalog, setCatalog] = useState<ProductRecord[]>([])
  const [cart, setCart] = useState<CartLine[]>([])
  const [search, setSearch] = useState('')
  const [customers, setCustomers] = useState<PosCustomerRecord[]>([])
  const [heldCarts, setHeldCarts] = useState<HeldPosCartRecord[]>([])
  const [recentSales, setRecentSales] = useState<PosRecentSaleRecord[]>([])
  const [saleType, setSaleType] = useState<SaleType>('RETAIL')
  const [customerId, setCustomerId] = useState('')
  const [loyaltyPoints, setLoyaltyPoints] = useState('0')
  const [heldCartId, setHeldCartId] = useState<string | null>(null)
  const [quote, setQuote] = useState<PosQuoteRecord | null>(null)
  const [quoteError, setQuoteError] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const [payments, setPayments] = useState<PaymentLine[]>([{ ...EMPTY_PAYMENT }])
  const [prescriptionAcknowledged, setPrescriptionAcknowledged] = useState(false)
  const [showHeldCarts, setShowHeldCarts] = useState(false)
  const [showCustomerForm, setShowCustomerForm] = useState(false)
  const [receipt, setReceipt] = useState<PosReceiptRecord | null>(null)
  const [receiptLayout, setReceiptLayout] = useState<ReceiptLayout>('THERMAL_80')
  const [receiptOpen, setReceiptOpen] = useState(false)
  const [printingReceipt, setPrintingReceipt] = useState(false)
  const [newCustomer, setNewCustomer] = useState<PosCustomerDraft>({ name: '', phone: '', email: '', address: '', creditLimit: '0', enrolLoyalty: false })

  const selectedCustomer = customers.find((customer) => customer.id === customerId) ?? null
  const quoteItems = useMemo(() => new Map((quote?.items ?? []).map((item) => [item.productId, item])), [quote])

  const refreshSalesData = useCallback(async () => {
    try {
      const [nextCustomers, nextHeld, nextSales] = await Promise.all([
        bridge.listPosCustomers(), bridge.listHeldPosCarts(), bridge.listRecentPosSales(),
      ])
      setCustomers(nextCustomers)
      setHeldCarts(nextHeld)
      setRecentSales(nextSales)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }, [bridge])

  useEffect(() => {
    let active = true
    void bridge.getInventoryOverview('').then((result) => {
      if (active) setCatalog(result.products)
    }).catch((caught: unknown) => {
      if (active) setError(errorMessage(caught))
    })
    void refreshSalesData()
    searchRef.current?.focus()
    return () => { active = false }
  }, [bridge, refreshSalesData])

  useEffect(() => {
    let active = true
    const timer = window.setTimeout(() => {
      void bridge.getInventoryOverview(search).then((result) => {
        if (active) setCatalog(result.products)
      }).catch((caught: unknown) => {
        if (active) setError(errorMessage(caught))
      })
    }, search ? 180 : 0)
    return () => { active = false; window.clearTimeout(timer) }
  }, [bridge, search])

  useEffect(() => {
    if (cart.length === 0) {
      setQuote(null)
      setQuoteError('')
      return
    }
    setQuote(null)
    setQuoteError('')
    let active = true
    const timer = window.setTimeout(() => {
      void bridge.quotePosSale({
        saleType,
        items: cart,
        customerId: customerId || null,
        loyaltyPointsToRedeem: parseWholeNumber(loyaltyPoints),
      }).then((nextQuote) => {
        if (!active) return
        setQuote(nextQuote)
        setQuoteError('')
      }).catch((caught: unknown) => {
        if (!active) return
        setQuote(null)
        setQuoteError(errorMessage(caught))
      })
    }, 120)
    return () => { active = false; window.clearTimeout(timer) }
  }, [bridge, cart, saleType, customerId, loyaltyPoints])

  useEffect(() => {
    if (!checkoutOpen || !quote) return
    if (quote.totalMinor === 0n) {
      if (payments.length > 0) setPayments([])
      return
    }
    if (payments.length !== 1 || payments[0]?.method !== 'CASH' || payments[0]?.amount) return
    setPayments([{ ...payments[0], amount: fromMinor(quote.totalMinor, currency) }])
  }, [checkoutOpen, quote, payments, currency])

  const updateLine = useCallback((productId: string, update: Partial<CartLine>) => {
    setCart((current) => current.map((line) => line.productId === productId ? { ...line, ...update } : line))
    pendingSubmission.current = null
  }, [])

  const addProduct = useCallback((product: ProductRecord) => {
    setError('')
    setMessage('')
    if (!product.isActive) {
      setError('Inactive products cannot be sold.')
      return
    }
    if (saleType === 'WHOLESALE' && !canWholesale) {
      setError('Your account does not have permission to make wholesale sales.')
      return
    }
    setCart((current) => {
      const existing = current.find((line) => line.productId === product.id)
      if (existing) {
        const next = safeAddQuantity(existing.quantity, '1')
        return current.map((line) => line.productId === product.id ? { ...line, quantity: next } : line)
      }
      return [...current, { productId: product.id, quantity: '1', manualDiscount: '0' }]
    })
    setSearch('')
    searchRef.current?.focus()
  }, [canWholesale, saleType])

  const tryScanOrSearch = useCallback(async () => {
    const term = search.trim().toLocaleLowerCase()
    if (!term) return
    setError('')
    try {
      const result = await bridge.getInventoryOverview(search.trim())
      const matches = result.products.filter((product) => product.isActive)
      const exact = matches.find((product) => [product.barcode, ...product.additionalBarcodes, product.sku, product.pluCode]
        .some((value) => value.trim().toLocaleLowerCase() === term))
      const match = exact ?? (matches.length === 1 ? matches[0] : undefined)
      if (match) addProduct(match)
      else if (matches.length === 0) setError('No matching product or barcode was found.')
      else setError('More than one product matches. Choose the correct item from the results before adding it.')
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }, [addProduct, bridge, search])

  const holdCart = useCallback(async () => {
    if (cart.length === 0) {
      setError('Add at least one item before holding a cart.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await bridge.holdPosCart({ saleType, items: cart, customerId: customerId || null, loyaltyPointsToRedeem: parseWholeNumber(loyaltyPoints) })
      setCart([])
      setCustomerId('')
      setLoyaltyPoints('0')
      setHeldCartId(null)
      pendingSubmission.current = null
      setMessage('Cart held for this cashier. Stock is not reserved until checkout.')
      await refreshSalesData()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }, [bridge, cart, customerId, loyaltyPoints, refreshSalesData, saleType])

  const recallCart = useCallback(async (id: string) => {
    setBusy(true)
    setError('')
    try {
      const held = await bridge.recallHeldPosCart(id)
      setSaleType(held.data.saleType)
      setCart(held.data.items.map((item) => ({ ...item, manualDiscount: item.manualDiscount ?? '0' })))
      setCustomerId(held.data.customerId ?? '')
      setLoyaltyPoints(String(held.data.loyaltyPointsToRedeem))
      setHeldCartId(held.id)
      setShowHeldCarts(false)
      setMessage('Held cart recalled. Current prices and stock will be checked at checkout.')
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }, [bridge])

  const discardCart = useCallback(async (id: string) => {
    try {
      await bridge.discardHeldPosCart(id)
      setHeldCarts((current) => current.filter((cart) => cart.id !== id))
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }, [bridge])

  const openCheckout = useCallback(() => {
    if (busy) return
    if (cart.length === 0) {
      setError('Add at least one item before checkout.')
      return
    }
    if (!quote) {
      setError(quoteError || 'Wait for the current sale total before checkout.')
      return
    }
    setError('')
    setMessage('')
    setPayments(quote?.totalMinor === 0n ? [] : [{ ...EMPTY_PAYMENT, amount: quote ? fromMinor(quote.totalMinor, currency) : '' }])
    setPrescriptionAcknowledged(false)
    setCheckoutOpen(true)
  }, [busy, cart.length, currency, quote, quoteError])

  function addPayment(method: PosPaymentMethod): void {
    if (method === 'CASH' && payments.some((line) => line.method === 'CASH')) return
    if (method === 'CREDIT' && payments.some((line) => line.method === 'CREDIT')) return
    setPayments((current) => [...current, { method, amount: method === 'CREDIT' ? '' : '', reference: '' }])
    pendingSubmission.current = null
  }

  function updatePayment(index: number, update: Partial<PaymentLine>): void {
    setPayments((current) => current.map((line, lineIndex) => lineIndex === index ? { ...line, ...update } : line))
    pendingSubmission.current = null
  }

  async function completeSale(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!quote) {
      setError(quoteError || 'Wait for the current sale total before completing checkout.')
      return
    }
    if (quote.warnings.length > 0 && !prescriptionAcknowledged) {
      const confirmed = window.confirm(`${quote.warnings.join('\n')}\n\nConfirm that the prescription requirement was checked before continuing.`)
      if (!confirmed) return
      setPrescriptionAcknowledged(true)
    }
    const salePayments = payments.map<PosPaymentInput>((payment) => ({
      method: payment.method,
      amount: payment.method === 'CREDIT' ? '' : payment.amount,
      reference: payment.reference,
    }))
    const draft = {
      saleType,
      items: cart,
      payments: salePayments,
      customerId: customerId || null,
      loyaltyPointsToRedeem: parseWholeNumber(loyaltyPoints),
      prescriptionAcknowledged: prescriptionAcknowledged || quote.warnings.length > 0,
      heldCartId,
    }
    const fingerprint = JSON.stringify(draft)
    if (!pendingSubmission.current || pendingSubmission.current.fingerprint !== fingerprint) {
      pendingSubmission.current = { fingerprint, key: makeIdempotencyKey() }
    }
    setBusy(true)
    setError('')
    try {
      const result = await bridge.completePosSale({ ...draft, idempotencyKey: pendingSubmission.current.key })
      setReceipt(result.receipt)
      setReceiptLayout(result.receipt.saleType === 'WHOLESALE' ? 'A4_INVOICE' : 'THERMAL_80')
      setReceiptOpen(true)
      setCheckoutOpen(false)
      setCart([])
      setCustomerId('')
      setLoyaltyPoints('0')
      setHeldCartId(null)
      setPayments([{ ...EMPTY_PAYMENT }])
      pendingSubmission.current = null
      setMessage(result.idempotentReplay ? 'The earlier sale completed successfully; no second sale or stock deduction was created.' : `Sale ${result.receipt.receiptNumber} completed.`)
      await refreshSalesData()
      void bridge.getInventoryOverview(search).then((result) => setCatalog(result.products)).catch(() => undefined)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  async function viewSale(saleId: number): Promise<void> {
    setError('')
    try {
      const next = await bridge.getPosReceipt(saleId)
      setReceipt(next)
      setReceiptLayout(next.saleType === 'WHOLESALE' ? 'A4_INVOICE' : 'THERMAL_80')
      setReceiptOpen(true)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  async function printReceipt(): Promise<void> {
    if (!receipt || printingReceipt) return
    setPrintingReceipt(true)
    setError('')
    try {
      const printRecord = await bridge.recordPosReceiptPrint(receipt.id, receiptLayout)
      setReceipt(printRecord)
      window.setTimeout(() => window.print(), 30)
      await refreshSalesData()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setPrintingReceipt(false)
    }
  }

  async function submitCustomer(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setError('')
    try {
      const created = await bridge.createPosCustomer(newCustomer)
      setCustomers((current) => [created, ...current])
      setCustomerId(created.id)
      setNewCustomer({ name: '', phone: '', email: '', address: '', creditLimit: '0', enrolLoyalty: false })
      setShowCustomerForm(false)
      setMessage('Customer account created.')
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (checkoutOpen || receiptOpen || showHeldCarts || showCustomerForm) return
      if (event.key === 'F2') {
        event.preventDefault()
        searchRef.current?.focus()
      } else if (event.key === 'F9') {
        event.preventDefault()
        void holdCart()
      } else if (event.key === 'F10') {
        event.preventDefault()
        openCheckout()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [checkoutOpen, receiptOpen, showHeldCarts, showCustomerForm, holdCart, openCheckout])

  const paymentTotals = useMemo(() => getPaymentPreview(payments, quote?.totalMinor ?? 0n, currency, display), [payments, quote, currency, display])

  const productRows = catalog.filter((product) => product.isActive)

  return (
    <section className="pos-workspace">
      <header className="pos-heading">
        <div>
          <span className="eyebrow eyebrow--gold">DESKTOP SALES TERMINAL</span>
          <h2>Point of Sale</h2>
          <p>Scan or search products, review the live host-validated total, take split payments, and print a saved-currency receipt.</p>
        </div>
        <div className="pos-heading__actions">
          <button type="button" className="inventory-secondary" onClick={() => onNavigate('products')}>Products</button>
          <button type="button" className="inventory-secondary" onClick={() => setShowHeldCarts(true)}>Held carts <b>{heldCarts.length}</b></button>
        </div>
      </header>

      {error && <div className="inventory-feedback is-error" role="alert"><span>!</span><div>{error}</div><button type="button" aria-label="Dismiss" onClick={() => setError('')}>×</button></div>}
      {message && <div className="inventory-feedback" role="status"><span>✓</span><div>{message}</div><button type="button" aria-label="Dismiss" onClick={() => setMessage('')}>×</button></div>}

      <div className="pos-shortcuts" aria-label="POS keyboard shortcuts">
        <span><kbd>F2</kbd> Search / scan</span><span><kbd>F9</kbd> Hold cart</span><span><kbd>F10</kbd> Checkout</span>
        <span className="pos-terminal-tag">{user.fullName} · {bootstrap.appInfo.runtime === 'desktop' ? 'Desktop terminal' : 'Browser preview'}</span>
      </div>

      <div className="pos-sale-type" role="group" aria-label="Price tier">
        <div><strong>Price tier</strong><small>Host rechecks permission and saved product prices at completion.</small></div>
        <div className="pos-segmented-control">
          <button type="button" className={saleType === 'RETAIL' ? 'is-active' : ''} onClick={() => { setSaleType('RETAIL'); pendingSubmission.current = null }}>Retail</button>
          <button type="button" className={saleType === 'WHOLESALE' ? 'is-active' : ''} disabled={!canWholesale} title={!canWholesale ? 'Wholesale permission is disabled for this cashier.' : ''}
            onClick={() => { setSaleType('WHOLESALE'); pendingSubmission.current = null }}>Wholesale {!canWholesale && <span className="pos-lock-mark">LOCKED</span>}</button>
        </div>
      </div>

      <div className="pos-layout">
        <div className="pos-left-column">
          <section className="pos-card pos-product-search">
            <div className="pos-card-heading"><div><span className="eyebrow">PRODUCT CATALOG</span><h3>Search or scan</h3></div><span className="pos-currency-chip">{currency.code}</span></div>
            <label className="pos-search-box"><span aria-hidden="true">⌕</span><input ref={searchRef} value={search} onChange={(event) => setSearch(event.currentTarget.value)}
              onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter') { event.preventDefault(); void tryScanOrSearch() } }}
              placeholder="Scan a barcode or search name, SKU, brand…" aria-label="Search products or scan barcode" /><kbd>F2</kbd></label>
            <div className="pos-product-results" aria-live="polite">
              {productRows.length === 0 ? <div className="pos-empty-products"><strong>No products found</strong><span>Try a different search, or add products in the Products workspace.</span></div>
                : productRows.slice(0, 24).map((product) => {
                  const wholesaleWeighed = supermarket && saleType === 'WHOLESALE' && product.weighedItem
                  const price = selectedUnitPrice(product, saleType, supermarket)
                  const available = product.quantityMilli - product.reservedMilli
                  return <button type="button" className="pos-product-row" key={product.id} disabled={wholesaleWeighed}
                    title={wholesaleWeighed ? 'Weighed items are sold at the retail per-kilogram price.' : ''} onClick={() => addProduct(product)}>
                    <span className="pos-product-initial">{product.name.slice(0, 1).toUpperCase()}</span>
                    <span className="pos-product-copy"><strong>{product.name}</strong><small>{product.sku}{product.barcode ? ` · ${product.barcode}` : ''}{product.weighedItem ? ' · Weighed' : ''}{product.prescriptionRequired && pharmacy ? ' · Prescription' : ''}</small></span>
                    <span className="pos-product-stock">{formatPosQuantity(available, product.unit)}<small>available</small></span>
                    <strong className="pos-product-price">{wholesaleWeighed ? 'Retail only' : price === null ? 'Price needed' : formatMoney(price, currency, display)}<small>{wholesaleWeighed ? 'not available wholesale' : saleType === 'WHOLESALE' ? 'wholesale' : product.weighedItem ? 'per kg' : 'each'}</small></strong>
                  </button>
                })}
            </div>
            {catalog.length > 24 && <p className="pos-result-note">Showing the first 24 matches. Refine your search to see more.</p>}
          </section>

          <section className="pos-card pos-recent-sales">
            <div className="pos-card-heading"><div><span className="eyebrow">COMPLETED TRANSACTIONS</span><h3>Recent receipts</h3></div><button type="button" className="pos-link-button" onClick={() => void refreshSalesData()}>Refresh</button></div>
            {recentSales.length === 0 ? <p className="pos-muted-copy">Completed sales will appear here for viewing and audited reprints.</p>
              : <div className="pos-recent-list">{recentSales.slice(0, 8).map((sale) => <div className="pos-recent-row" key={sale.id}>
                <div><strong>{sale.receiptNumber} {sale.duplicate && <em>DUPLICATE</em>}</strong><small>{new Date(sale.createdAt).toLocaleString()} · {sale.customerName || 'Walk-in'} · {sale.saleType.toLowerCase()}</small></div>
                <div className="pos-recent-total"><b>{formatMoney(sale.totalMinor, sale.currency, sale.display)}</b><button type="button" onClick={() => void viewSale(sale.id)}>View / print</button></div>
              </div>)}</div>}
          </section>
        </div>

        <section className="pos-card pos-cart-card">
          <div className="pos-card-heading"><div><span className="eyebrow">CURRENT ORDER</span><h3>Cart <span className="pos-count-pill">{cart.length}</span></h3></div>
            {cart.length > 0 && <button type="button" className="pos-link-button pos-link-button--danger" onClick={() => { setCart([]); setHeldCartId(null); pendingSubmission.current = null }}>Clear cart</button>}
          </div>

          <label className="pos-customer-select"><span>Customer <small>Optional</small></span>
            <select value={customerId} onChange={(event) => { setCustomerId(event.currentTarget.value); pendingSubmission.current = null }}>
              <option value="">Walk-in customer</option>
              {customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}{customer.phone ? ` · ${customer.phone}` : ''}</option>)}
            </select>
          </label>
          {selectedCustomer && <div className="pos-customer-credit"><span>Balance <b>{formatMoney(selectedCustomer.balanceMinor, currency, display)}</b></span><span>Credit limit <b>{formatMoney(selectedCustomer.creditLimitMinor, currency, display)}</b></span>
            {selectedCustomer.loyaltyMemberNumber && <span>Loyalty <b>{selectedCustomer.loyaltyPointsBalance} pts · {selectedCustomer.loyaltyMemberNumber}</b></span>}
          </div>}
          {user.role === 'ADMIN' && <button type="button" className="pos-link-button pos-add-customer" onClick={() => setShowCustomerForm(true)}>+ Add customer / set credit limit</button>}

          {supermarket && selectedCustomer?.loyaltyMemberId && <label className="pos-loyalty-entry"><span>Redeem loyalty points <small>100 points = 1 major currency unit</small></span>
            <input inputMode="numeric" type="number" min="0" step="1" max={selectedCustomer.loyaltyPointsBalance} value={loyaltyPoints} onChange={(event) => setLoyaltyPoints(event.currentTarget.value)} />
            <small>Available: {selectedCustomer.loyaltyPointsBalance} pts</small>
          </label>}

          <p className="pos-discount-ceiling">{discountCeilingSentence(discountCap)}</p>

          <div className="pos-cart-lines">
            {cart.length === 0 ? <div className="pos-empty-cart"><span className="pos-empty-cart-icon">▣</span><strong>Your cart is empty</strong><span>Scan a barcode or choose a product to start a sale.</span></div>
              : cart.map((line) => {
                const product = catalog.find((candidate) => candidate.id === line.productId)
                const quoteLine = quoteItems.get(line.productId)
                if (!product) return null
                return <div className="pos-cart-line" key={line.productId}>
                  <div className="pos-cart-line__top"><div><strong>{product.name}</strong><small>{product.sku} · {product.unit}{product.weighedItem && supermarket ? ' (weighed)' : ''}</small></div>
                    <button type="button" aria-label={`Remove ${product.name}`} title="Remove" onClick={() => { setCart((current) => current.filter((item) => item.productId !== line.productId)); pendingSubmission.current = null }}>×</button>
                  </div>
                  <div className="pos-cart-line__fields">
                    <label><span>Qty{product.weighedItem && supermarket ? ' / kg' : ''}</span><input type="number" inputMode="decimal" min="0.001" step="0.001" value={line.quantity} onChange={(event) => updateLine(line.productId, { quantity: event.currentTarget.value })} /></label>
                    <label><span>Discount</span><input type="text" inputMode="decimal" value={line.manualDiscount} title={discountCeilingSentence(discountCap)} onChange={(event) => updateLine(line.productId, { manualDiscount: event.currentTarget.value })} aria-label={`${product.name} manual discount`} /></label>
                    <div className="pos-cart-line__total"><span>Line total</span><strong>{quoteLine ? formatMoney(quoteLine.lineTotalMinor, currency, display) : '—'}</strong></div>
                  </div>
                  {quoteLine && (quoteLine.promotionDiscountMinor > 0n || quoteLine.loyaltyDiscountMinor > 0n) && <small className="pos-cart-line__deal">{quoteLine.promotionDiscountMinor > 0n ? 'Promotion applied' : ''}{quoteLine.loyaltyDiscountMinor > 0n ? ' Loyalty reward applied' : ''}</small>}
                </div>
              })}
          </div>

          {quoteError && cart.length > 0 && <div className="pos-quote-error" role="alert">{quoteError}</div>}
          {quote && <div className="pos-order-summary">
            <div><span>Subtotal</span><b>{formatMoney(quote.subtotalMinor, currency, display)}</b></div>
            {quote.promotionDiscountMinor > 0n && <div><span>Promotion{quote.promotionName ? ` · ${quote.promotionName}` : ''}</span><b>−{formatMoney(quote.promotionDiscountMinor, currency, display)}</b></div>}
            {quote.manualDiscountMinor > 0n && <div><span>Manual discount</span><b>−{formatMoney(quote.manualDiscountMinor, currency, display)}</b></div>}
            {quote.loyaltyDiscountMinor > 0n && <div><span>Loyalty reward</span><b>−{formatMoney(quote.loyaltyDiscountMinor, currency, display)}</b></div>}
            {quote.loyaltyPointsEarned > 0 && <div><span>Loyalty points earned</span><b>{quote.loyaltyPointsEarned} pts</b></div>}
            <div className="pos-order-summary__total"><strong>Estimated total</strong><strong>{formatMoney(quote.totalMinor, currency, display)}</strong></div>
          </div>}

          <div className="pos-cart-actions">
            <button type="button" className="inventory-secondary" disabled={cart.length === 0 || busy} onClick={() => void holdCart()}>Hold cart <kbd>F9</kbd></button>
            <button type="button" className="inventory-primary pos-checkout-button" disabled={cart.length === 0 || busy || !quote} onClick={openCheckout}>Checkout <kbd>F10</kbd></button>
          </div>
          {heldCartId && <p className="pos-held-note">Recalled cart · it will be removed from held carts only after the sale commits.</p>}
        </section>
      </div>

      {showHeldCarts && <div className="pos-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowHeldCarts(false) }}>
        <section className="pos-modal pos-held-modal" role="dialog" aria-modal="true" aria-labelledby="held-carts-title">
          <header className="pos-modal-header"><div><span className="eyebrow">CASHIER WORKSPACE</span><h3 id="held-carts-title">Held carts</h3><p>Held carts are private to the signed-in cashier and do not reserve stock.</p></div><button type="button" aria-label="Close held carts" onClick={() => setShowHeldCarts(false)}>×</button></header>
          {heldCarts.length === 0 ? <p className="pos-muted-copy">No held carts for this cashier.</p> : <div className="pos-held-list">{heldCarts.map((held) => <div className="pos-held-row" key={held.id}>
            <div><strong>{held.saleType} · {held.data.items.length} line{held.data.items.length === 1 ? '' : 's'}</strong><small>{new Date(held.updatedAt).toLocaleString()}</small></div>
            <div><button type="button" className="inventory-primary" disabled={busy} onClick={() => void recallCart(held.id)}>Recall</button><button type="button" className="inventory-secondary" onClick={() => void discardCart(held.id)}>Discard</button></div>
          </div>)}</div>}
        </section>
      </div>}

      {showCustomerForm && <div className="pos-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowCustomerForm(false) }}>
        <section className="pos-modal pos-customer-modal" role="dialog" aria-modal="true" aria-labelledby="customer-create-title">
          <header className="pos-modal-header"><div><span className="eyebrow">ADMIN CUSTOMER SETUP</span><h3 id="customer-create-title">Add a customer</h3><p>Credit limits are stored in the shop currency. New customer accounts start with a zero balance.</p></div><button type="button" aria-label="Close" onClick={() => setShowCustomerForm(false)}>×</button></header>
          <form className="pos-customer-form" onSubmit={(event) => void submitCustomer(event)}>
            <label className="inventory-field"><span>Customer name <b>*</b></span><input required maxLength={120} value={newCustomer.name} onChange={(event) => setNewCustomer((current) => ({ ...current, name: event.currentTarget.value }))} /></label>
            <div className="pos-customer-form-grid">
              <label className="inventory-field"><span>Phone</span><input value={newCustomer.phone} maxLength={80} onChange={(event) => setNewCustomer((current) => ({ ...current, phone: event.currentTarget.value }))} /></label>
              <label className="inventory-field"><span>Email</span><input type="email" value={newCustomer.email} maxLength={120} onChange={(event) => setNewCustomer((current) => ({ ...current, email: event.currentTarget.value }))} /></label>
              <label className="inventory-field"><span>Credit limit ({currency.code})</span><input inputMode="decimal" value={newCustomer.creditLimit} onChange={(event) => setNewCustomer((current) => ({ ...current, creditLimit: event.currentTarget.value }))} /></label>
              <label className="inventory-field pos-customer-address"><span>Address</span><input value={newCustomer.address} maxLength={240} onChange={(event) => setNewCustomer((current) => ({ ...current, address: event.currentTarget.value }))} /></label>
            </div>
            {supermarket && <label className="inventory-check-field"><input type="checkbox" checked={newCustomer.enrolLoyalty} onChange={(event) => setNewCustomer((current) => ({ ...current, enrolLoyalty: event.currentTarget.checked }))} /> Enrol in supermarket loyalty points</label>}
            <div className="pos-modal-actions"><button type="button" className="inventory-secondary" onClick={() => setShowCustomerForm(false)}>Cancel</button><button type="submit" className="inventory-primary">Save customer</button></div>
          </form>
        </section>
      </div>}

      {checkoutOpen && <div className="pos-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setCheckoutOpen(false) }}>
        <section className="pos-modal pos-checkout-modal" role="dialog" aria-modal="true" aria-labelledby="pos-checkout-title">
          <header className="pos-modal-header"><div><span className="eyebrow">{saleType} CHECKOUT</span><h3 id="pos-checkout-title">Take payment</h3><p>{selectedCustomer?.name ?? 'Walk-in customer'} · {quote?.items.length ?? cart.length} line(s)</p></div><button type="button" aria-label="Close checkout" disabled={busy} onClick={() => setCheckoutOpen(false)}>×</button></header>
          {quote && <div className="pos-payment-total"><span>Amount due</span><strong>{formatMoney(quote.totalMinor, currency, display)}</strong></div>}
          {quote?.totalMinor === 0n && <div className="pos-muted-copy">This sale is fully discounted. No payment method is required.</div>}
          {quoteError && <div className="pos-quote-error" role="alert">{quoteError}</div>}
          {quote?.warnings.map((warning) => <div key={warning} className="pos-prescription-alert"><strong>Prescription confirmation</strong><span>{warning}. Confirm the prescription requirement has been checked before completing this sale.</span></div>)}
          <form onSubmit={(event) => void completeSale(event)} className="pos-payment-form">
            <div className="pos-payment-list">
              {payments.map((payment, index) => <div className="pos-payment-line" key={`${payment.method}-${index}`}>
                <label><span>Method</span><select value={payment.method} onChange={(event) => updatePayment(index, { method: event.currentTarget.value as PosPaymentMethod, amount: event.currentTarget.value === 'CREDIT' ? '' : payment.amount })}>
                  <option value="CASH">Cash</option><option value="TRANSFER">Transfer</option><option value="CARD">POS / Card</option>{canCredit && <option value="CREDIT">Credit / on account</option>}
                </select></label>
                {payment.method === 'CREDIT' ? <div className="pos-credit-payment"><span>Unpaid balance</span><strong>{formatMoney(paymentTotals.credit, currency, display)}</strong></div>
                  : <label><span>{payment.method === 'CASH' ? 'Cash tendered' : 'Amount applied'}</span><input required inputMode="decimal" type="text" value={payment.amount} onChange={(event) => updatePayment(index, { amount: event.currentTarget.value })} />
                  </label>}
                {payment.method !== 'CASH' && payment.method !== 'CREDIT' && <label><span>Reference <small>Optional</small></span><input maxLength={120} value={payment.reference} onChange={(event) => updatePayment(index, { reference: event.currentTarget.value })} /></label>}
                {payments.length > 1 && <button type="button" aria-label={`Remove ${payment.method} payment`} className="pos-remove-payment" onClick={() => { setPayments((current) => current.filter((_, lineIndex) => lineIndex !== index)); pendingSubmission.current = null }}>×</button>}
              </div>)}
            </div>
            <div className="pos-add-payment-actions">
              <button type="button" className="pos-link-button" onClick={() => addPayment('CASH')} disabled={payments.some((payment) => payment.method === 'CASH')}>+ Cash</button>
              <button type="button" className="pos-link-button" onClick={() => addPayment('TRANSFER')}>+ Transfer</button>
              <button type="button" className="pos-link-button" onClick={() => addPayment('CARD')}>+ POS / Card</button>
              {canCredit && <button type="button" className="pos-link-button" onClick={() => addPayment('CREDIT')} disabled={payments.some((payment) => payment.method === 'CREDIT')}>+ Credit</button>}
            </div>
            <div className="pos-tender-summary">
              {payments.some((payment) => payment.method === 'CASH') && <div><span>Change due</span><strong>{formatMoney(paymentTotals.change, currency, display)}</strong></div>}
              <div><span>Still due</span><strong>{formatMoney(paymentTotals.credit, currency, display)}</strong></div>
              {paymentTotals.credit > 0n && !canCredit && <small>Your account cannot place this balance on credit. Add another payment method.</small>}
              {paymentTotals.credit > 0n && !customerId && <small>Select a customer before using a Credit payment.</small>}
            </div>
            {quote?.warnings.length ? <label className="pos-prescription-check"><input type="checkbox" checked={prescriptionAcknowledged} onChange={(event) => setPrescriptionAcknowledged(event.currentTarget.checked)} /> I confirm the prescription requirement has been checked for the listed items.</label> : null}
            <div className="pos-checkout-actions"><button type="button" className="inventory-secondary" disabled={busy} onClick={() => setCheckoutOpen(false)}>Back to cart</button>
              <button type="submit" className="inventory-primary pos-complete-button" disabled={busy || !quote || (quote.warnings.length > 0 && !prescriptionAcknowledged)}>{busy ? 'Completing…' : 'Complete sale'}</button>
            </div>
          </form>
        </section>
      </div>}

      {receiptOpen && receipt && <div className="pos-modal-backdrop pos-receipt-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setReceiptOpen(false) }}>
        <section className="pos-modal pos-receipt-modal" role="dialog" aria-modal="true" aria-labelledby="receipt-preview-title">
          <header className="pos-modal-header pos-receipt-modal-header"><div><span className="eyebrow">PRINT PREVIEW · {receipt.currency.code}</span><h3 id="receipt-preview-title">{receipt.saleType === 'WHOLESALE' ? 'Invoice' : 'Receipt'} {receipt.receiptNumber}{receipt.duplicate && <em className="pos-duplicate-pill">DUPLICATE</em>}</h3><p>{receipt.store.name || 'Missing store name — printing is blocked.'} · Saved sale currency and store details</p></div><button type="button" aria-label="Close receipt preview" onClick={() => setReceiptOpen(false)}>×</button></header>
          <div className="pos-print-controls"><label><span>Layout</span><select value={receiptLayout} onChange={(event) => setReceiptLayout(event.currentTarget.value as ReceiptLayout)}>
            {LAYOUT_OPTIONS.filter((option) => option.value !== 'A4_INVOICE' || receipt.saleType === 'WHOLESALE').map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select></label><small>Thermal layouts replace unsupported non-ASCII currency glyphs with the ISO code.</small><button type="button" className="inventory-primary" disabled={printingReceipt} onClick={() => void printReceipt()}>{printingReceipt ? 'Preparing…' : 'Print / reprint'}</button></div>
          <div className="pos-receipt-preview-scroll"><div className="pos-receipt-print-root"><PosReceiptDocument receipt={receipt} layout={receiptLayout} /></div></div>
        </section>
      </div>}
    </section>
  )
}

function selectedUnitPrice(product: ProductRecord, saleType: SaleType, supermarket: boolean): bigint | null {
  if (supermarket && product.weighedItem) return saleType === 'WHOLESALE' ? null : product.pricePerKgMinor
  return saleType === 'WHOLESALE' ? product.wholesalePriceMinor : product.retailPriceMinor
}

function getPaymentPreview(payments: PaymentLine[], total: bigint, currency: BootstrapData['settings']['currency'], display: BootstrapData['settings']['display']): { credit: bigint; change: bigint } {
  let nonCash = 0n
  let cash = 0n
  for (const payment of payments) {
    try {
      const amount = payment.amount.trim() ? parseMoneyExact(payment.amount, currency, display) : 0n
      if (amount < 0n) continue
      if (payment.method === 'CASH') cash += amount
      else if (payment.method === 'TRANSFER' || payment.method === 'CARD') nonCash += amount
    } catch { /* Partial input is being edited; the host validates exact amounts on completion. */ }
  }
  const remaining = total > nonCash ? total - nonCash : 0n
  const appliedCash = cash < remaining ? cash : remaining
  return { credit: remaining - appliedCash, change: cash - appliedCash }
}

function safeAddQuantity(value: string, increment: string): string {
  try {
    const current = parseQuantity(value)
    const next = current + parseQuantity(increment)
    return formatPosQuantity(next, '').replace(/\s/u, '')
  } catch { return increment }
}

function parseQuantity(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{0,3}))?$/.exec(value.trim())
  if (!match) throw new Error('Enter a valid quantity.')
  return BigInt(match[1]!) * 1000n + BigInt((match[2] ?? '').padEnd(3, '0') || '0')
}

function parseWholeNumber(value: string): number {
  if (!/^\d+$/u.test(value)) return 0
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : 0
}

function makeIdempotencyKey(): string {
  try { return globalThis.crypto.randomUUID() } catch { return `pos-${Date.now()}-${Math.random().toString(36).slice(2)}` }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'This POS action could not be completed.'
}
