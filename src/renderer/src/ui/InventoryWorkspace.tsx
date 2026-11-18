import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import JsBarcode from 'jsbarcode'
import type { Edition } from '../../../editions'
import type { AppPage, PublicUser } from '@shared/auth/types'
import type { InfoflexBridge } from '@shared/bridge'
import { formatMoney } from '@shared/currency/money'
import type {
  InventoryAlert,
  InventoryOverview,
  ProductDraft,
  ProductImportReport,
  ProductRecord,
  PurchaseOrderRecord,
  StockMutationResult,
  StocktakeVarianceRecord,
} from '@shared/inventory/types'
import type { BootstrapData } from '@shared/shop/types'

type WorkspaceMode = 'products' | 'stock'
type InventoryAction = 'receive' | 'adjust' | 'stocktake' | null

interface Props {
  bridge: InfoflexBridge
  bootstrap: BootstrapData
  user: PublicUser
  mode: WorkspaceMode
  onNavigate: (page: AppPage) => void
}

export function InventoryWorkspace({ bridge, bootstrap, user, mode, onNavigate }: Props) {
  const edition = (bootstrap.setupContext.edition ?? bootstrap.appInfo.edition ?? 'PHARMACY') as Edition
  const currency = bootstrap.settings.currency
  const display = bootstrap.settings.display
  const isAdmin = user.role === 'ADMIN'
  const pharmacy = edition === 'PHARMACY' || edition === 'BOTH'
  const supermarket = edition === 'SUPERMARKET' || edition === 'BOTH'
  const [overview, setOverview] = useState<InventoryOverview | null>(null)
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [showEditor, setShowEditor] = useState(false)
  const [editing, setEditing] = useState<ProductRecord | null>(null)
  const [draft, setDraft] = useState<ProductDraft>(() => emptyDraft())
  const [variantText, setVariantText] = useState('')
  const [action, setAction] = useState<InventoryAction>(null)
  const [selectedProductId, setSelectedProductId] = useState('')
  const [receive, setReceive] = useState({ quantity: '1', quantityUnit: 'unit' as 'unit' | 'pack', unitCost: '', supplierName: '', supplierReference: '', note: '', batchNumber: '', expiryDate: '' })
  const [adjust, setAdjust] = useState({ direction: 'decrease' as 'increase' | 'decrease', quantity: '1', reason: '', batchNumber: '', expiryDate: '' })
  const [stocktake, setStocktake] = useState({ countedQuantity: '0', reason: '', batchNumber: '', expiryDate: '' })
  const [importReport, setImportReport] = useState<ProductImportReport | null>(null)
  const [varianceReport, setVarianceReport] = useState<StocktakeVarianceRecord[]>([])
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrderRecord[]>([])
  const [showOrders, setShowOrders] = useState(false)
  const [orderSupplier, setOrderSupplier] = useState('')
  const [orderReference, setOrderReference] = useState('')
  const [orderNote, setOrderNote] = useState('')
  const [orderLines, setOrderLines] = useState<Array<{ productId: string; quantity: string; quantityUnit: 'unit' | 'pack'; unitCost: string }>>([
    { productId: '', quantity: '1', quantityUnit: 'unit', unitCost: '' },
  ])
  const [receivingOrder, setReceivingOrder] = useState<PurchaseOrderRecord | null>(null)
  const [receiptLines, setReceiptLines] = useState<Array<{ purchaseItemId: string; batchNumber: string; expiryDate: string }>>([])
  const fileInput = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      const result = await bridge.getInventoryOverview(search)
      setOverview(result)
      setError('')
      if (isAdmin && mode === 'stock') {
        const report = await bridge.getStocktakeVarianceReport()
        setVarianceReport(report)
        if (supermarket) setPurchaseOrders(await bridge.listPurchaseOrders())
      }
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }, [bridge, isAdmin, mode, search, supermarket])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const products = overview?.products ?? []
  const selectedProduct = products.find((product) => product.id === selectedProductId) ?? null
  const alerts = overview?.alerts ?? []
  const lowStockCount = alerts.filter((alert) => alert.type === 'low_stock').length
  const expiryCount = alerts.filter((alert) => alert.type !== 'low_stock').length
  const stocktakeCount = parseQuantityForUi(stocktake.countedQuantity)
  const stocktakeAddsQuantity = selectedProduct !== null && stocktakeCount !== null && stocktakeCount > selectedProduct.quantityMilli

  function startCreate(): void {
    setEditing(null)
    setDraft(emptyDraft())
    setVariantText('')
    setShowEditor(true)
    setMessage('')
    setError('')
  }

  function startEdit(product: ProductRecord): void {
    setEditing(product)
    setDraft(toDraft(product, currency, display))
    setVariantText(product.variants.map((variant) => `${variant.code} | ${variant.label} | ${variant.priceMinor === null ? '' : formatMoney(variant.priceMinor, currency, display)}`).join('\n'))
    setShowEditor(true)
    setMessage('')
    setError('')
  }

  async function saveProduct(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    try {
      const parsedVariants = supermarket ? parseVariantLines(variantText, draft.variants) : []
      const saved = await bridge.saveProduct({ ...draft, variants: parsedVariants })
      setSelectedProductId(saved.id)
      setShowEditor(false)
      setEditing(null)
      setMessage(editing ? 'Product changes saved.' : 'Product created.')
      await refresh()
    } catch (caught) {
      const saveError = errorMessage(caught)
      if (/changed|reload|stale/iu.test(saveError)) {
        await refresh()
        setError(`${saveError} The product list is refreshed; cancel and reopen this product to load the latest version.`)
      } else setError(saveError)
    }
  }

  async function chooseImport(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    setImportReport(null)
    setMessage('')
    setError('')
    try {
      let report: ProductImportReport
      if (file.name.toLowerCase().endsWith('.csv')) report = await bridge.importProductsCsv(await file.text())
      else if (file.name.toLowerCase().endsWith('.xlsx')) report = await bridge.importProductsExcel(new Uint8Array(await file.arrayBuffer()))
      else throw new Error('Choose a .csv or .xlsx product file.')
      setImportReport(report)
      setMessage(`${report.imported} product${report.imported === 1 ? '' : 's'} imported${report.errors.length ? `; ${report.errors.length} row${report.errors.length === 1 ? '' : 's'} need attention` : ''}.`)
      await refresh()
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  async function exportProducts(kind: 'csv' | 'xlsx'): Promise<void> {
    setError('')
    try {
      if (kind === 'csv') downloadBlob(await bridge.exportProductsCsv(), 'infoflex-products.csv', 'text/csv;charset=utf-8')
      else downloadBlob(base64ToBytes(await bridge.exportProductsExcel()), 'infoflex-products.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  function beginStockAction(next: InventoryAction, product?: ProductRecord): void {
    const choice = product ?? selectedProduct ?? products[0]
    if (!choice) {
      setError('Create or select a product first.')
      return
    }
    setSelectedProductId(choice.id)
    setAction(next)
    setError('')
    setMessage('')
    setReceive({ quantity: '1', quantityUnit: 'unit', unitCost: '', supplierName: '', supplierReference: '', note: '', batchNumber: '', expiryDate: '' })
    setAdjust({ direction: 'decrease', quantity: '1', reason: '', batchNumber: '', expiryDate: '' })
    setStocktake({ countedQuantity: formatQuantity(choice.quantityMilli), reason: '', batchNumber: '', expiryDate: '' })
  }

  async function submitStockAction(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!selectedProduct) return
    const versions = { productId: selectedProduct.id, expectedProductVersion: selectedProduct.rowVersion, expectedStockVersion: selectedProduct.stockVersion }
    try {
      let result: StockMutationResult
      if (action === 'receive') result = await bridge.receiveStock({
        ...versions, ...receive,
      })
      else if (action === 'adjust') result = await bridge.adjustStock({
        ...versions, ...adjust,
      })
      else if (action === 'stocktake') result = await bridge.recordStocktake({
        ...versions, ...stocktake,
      })
      else return
      setSelectedProductId(result.product.id)
      setMessage(stockActionMessage(action, result))
      setAction(null)
      await refresh()
    } catch (caught) {
      const conflictMessage = errorMessage(caught)
      if (/changed|reload|stale/iu.test(conflictMessage)) await refresh()
      setError(conflictMessage)
    }
  }

  async function createOrder(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    try {
      const order = await bridge.createPurchaseOrder({
        supplierName: orderSupplier,
        supplierReference: orderReference,
        note: orderNote,
        items: orderLines,
      })
      setPurchaseOrders((current) => [order, ...current])
      setOrderSupplier('')
      setOrderReference('')
      setOrderNote('')
      setOrderLines([{ productId: '', quantity: '1', quantityUnit: 'unit', unitCost: '' }])
      setMessage(`Purchase order ${order.reference} created.`)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  function startReceivingOrder(order: PurchaseOrderRecord): void {
    setReceivingOrder(order)
    setReceiptLines(order.items.map((item) => ({ purchaseItemId: item.id, batchNumber: '', expiryDate: '' })))
  }

  async function submitOrderReceipt(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!receivingOrder) return
    try {
      const received = await bridge.receivePurchaseOrder({
        purchaseId: receivingOrder.id,
        expectedVersion: receivingOrder.rowVersion,
        supplierReference: receivingOrder.supplierReference,
        receivedNote: receivingOrder.note,
        items: receiptLines,
      })
      setPurchaseOrders((current) => current.map((order) => order.id === received.id ? received : order))
      setReceivingOrder(null)
      setMessage(`Goods received for ${received.reference}.`)
      await refresh()
    } catch (caught) {
      setError(errorMessage(caught))
      if (/changed|reload|already received/iu.test(errorMessage(caught))) {
        try { setPurchaseOrders(await bridge.listPurchaseOrders()) } catch { /* Keep the original conflict visible. */ }
      }
    }
  }

  function changeDraft<K extends keyof ProductDraft>(key: K, value: ProductDraft[K]): void {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  const canShowBatch = (product: ProductRecord | null) => Boolean(product && (edition === 'PHARMACY' || product.expiryTracking))

  return (
    <section className="inventory-workspace">
      <div className="inventory-heading">
        <div>
          <span className="eyebrow eyebrow--gold">{mode === 'products' ? 'PRODUCT CATALOG' : 'INVENTORY CONTROL'}</span>
          <h2>{mode === 'products' ? 'Products' : 'Stock & purchasing'}</h2>
          <p>{mode === 'products'
            ? 'Search your catalog, manage product details, and move validated product lists in or out.'
            : 'Review active-edition alerts and manage stock receiving, adjustments, and stocktakes.'}</p>
        </div>
        <div className="inventory-heading__actions">
          {isAdmin && mode === 'products' && <button className="inventory-primary" type="button" onClick={startCreate}>＋ Add product</button>}
          {mode === 'stock' && supermarket && isAdmin && <button className="inventory-secondary" type="button" onClick={() => { setShowOrders((open) => !open); setAction(null) }}>Purchase orders</button>}
          <button className="inventory-secondary" type="button" onClick={() => onNavigate(mode === 'products' ? 'stock' : 'products')}>
            {mode === 'products' ? 'Open stock' : 'Open products'}
          </button>
        </div>
      </div>

      {(message || error) && <div className={error ? 'inventory-feedback is-error' : 'inventory-feedback'} role={error ? 'alert' : 'status'}>
        <span>{error ? '!' : '✓'}</span><div>{error || message}</div><button type="button" onClick={() => { setMessage(''); setError('') }} aria-label="Dismiss">×</button>
      </div>}

      <div className="inventory-alert-strip" aria-label="Inventory alert summary">
        <div><span className="alert-mark alert-mark--stock">!</span><div><strong>{lowStockCount}</strong><span>Low-stock alerts</span></div></div>
        {pharmacy && <div><span className="alert-mark alert-mark--expiry">⌁</span><div><strong>{expiryCount}</strong><span>Batch / expiry alerts</span></div></div>}
        <div className="inventory-alert-strip__note">{busy ? 'Refreshing inventory…' : 'Alerts update from the active shop edition.'}</div>
      </div>

      {mode === 'stock' && !showOrders && <section className="inventory-card inventory-alerts-card">
        <div className="inventory-section-heading"><div><span className="eyebrow eyebrow--gold">ATTENTION</span><h3>Active inventory alerts</h3></div><span className="inventory-count">{alerts.length} alerts</span></div>
        {alerts.length === 0 ? <p className="inventory-empty">No active stock or expiry alerts.</p> : <div className="inventory-alert-list">
          {alerts.map((alert, index) => <AlertRow key={`${alert.type}-${alert.productId}-${'batchId' in alert ? alert.batchId : index}`} alert={alert} />)}
        </div>}
      </section>}

      {mode === 'products' && <div className="inventory-toolbar">
        <label className="inventory-search"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search product name, SKU, brand or barcode" aria-label="Search products" /></label>
        <div className="inventory-toolbar__actions">
          {isAdmin && <>
            <input ref={fileInput} className="visually-hidden" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => void chooseImport(event)} />
            <button className="inventory-secondary" type="button" onClick={() => fileInput.current?.click()}>Import CSV / Excel</button>
          </>}
          <button className="inventory-secondary" type="button" onClick={() => void exportProducts('csv')}>Export CSV</button>
          <button className="inventory-secondary" type="button" onClick={() => void exportProducts('xlsx')}>Export Excel</button>
        </div>
      </div>}

      {importReport && <section className="inventory-card inventory-import-report">
        <div className="inventory-section-heading"><div><span className="eyebrow eyebrow--gold">IMPORT REPORT</span><h3>{importReport.imported} imported · {importReport.errors.length} row errors</h3></div>
          {importReport.errors.length > 0 && <button className="inventory-link-button" type="button" onClick={() => downloadBlob(importErrorCsv(importReport), 'infoflex-import-errors.csv', 'text/csv;charset=utf-8')}>Download error report</button>}
        </div>
        {importReport.errors.length > 0 && <div className="inventory-error-list">{importReport.errors.slice(0, 8).map((item) => <p key={`${item.row}-${item.message}`}><strong>Row {item.row}:</strong> {item.message}</p>)}{importReport.errors.length > 8 && <small>Showing the first 8 errors. Download the report for all rows.</small>}</div>}
      </section>}

      {showEditor && <section className="inventory-card inventory-editor-card">
        <div className="inventory-section-heading"><div><span className="eyebrow eyebrow--gold">{editing ? 'PRODUCT DETAILS' : 'NEW PRODUCT'}</span><h3>{editing ? `Edit ${editing.name}` : 'Add a product'}</h3><p>Prices and supplier costs are stored as exact minor-unit amounts in the shop currency.</p></div>
          <button type="button" className="inventory-icon-button" onClick={() => setShowEditor(false)} aria-label="Close product editor">×</button>
        </div>
        <form className="inventory-form" onSubmit={(event) => void saveProduct(event)}>
          <div className="inventory-form-grid">
            <TextField label="SKU" value={draft.sku} onChange={(value) => changeDraft('sku', value)} required />
            <TextField label="Product name" value={draft.name} onChange={(value) => changeDraft('name', value)} required />
            <TextField label="Brand" value={draft.brand} onChange={(value) => changeDraft('brand', value)} />
            <TextField label="Category" value={draft.category} onChange={(value) => changeDraft('category', value)} listId="inventory-categories" options={overview?.categories ?? []} />
            <TextField label="Sub-category" value={draft.subCategory} onChange={(value) => changeDraft('subCategory', value)} />
            <TextField label="Primary barcode / SKU" value={draft.barcode} onChange={(value) => changeDraft('barcode', value)} />
            <TextField label="Other barcodes" value={draft.additionalBarcodes.join(' | ')} onChange={(value) => changeDraft('additionalBarcodes', value.split(/[|;]/u).map((item) => item.trim()).filter(Boolean))} hint="Separate additional barcodes with |" />
            <TextField label="Stock unit" value={draft.unit} onChange={(value) => changeDraft('unit', value)} required />
            <TextField label="Units per pack" value={String(draft.packSizeUnits)} onChange={(value) => changeDraft('packSizeUnits', Number(value))} type="number" min="1" step="1" required />
            <TextField label="Wholesale minimum quantity" value={draft.wholesaleMinimumQuantity} onChange={(value) => changeDraft('wholesaleMinimumQuantity', value)} />
            <TextField label="Reorder level" value={draft.reorderLevel} onChange={(value) => changeDraft('reorderLevel', value)} />
            {isAdmin && <TextField label={`Cost (${currency.code})`} value={draft.cost} onChange={(value) => changeDraft('cost', value)} inputMode="decimal" required hint="Visible only to Admins." />}
            <TextField label={`Retail price (${currency.code})`} value={draft.retailPrice} onChange={(value) => changeDraft('retailPrice', value)} inputMode="decimal" required hint={`Enter using ${currency.code} separators, or a plain number.`} />
            <TextField label={`Wholesale price (${currency.code})`} value={draft.wholesalePrice} onChange={(value) => changeDraft('wholesalePrice', value)} inputMode="decimal" />
            {pharmacy && <TextField label="Generic name" value={draft.genericName} onChange={(value) => changeDraft('genericName', value)} />}
            {pharmacy && <label className="inventory-check-field"><input type="checkbox" checked={draft.prescriptionRequired} onChange={(event) => changeDraft('prescriptionRequired', event.target.checked)} /><span>Prescription required</span></label>}
            {supermarket && <TextField label="Department" value={draft.department} onChange={(value) => changeDraft('department', value)} listId="inventory-departments" options={overview?.departments ?? []} />}
            {supermarket && <TextField label="Shelf / aisle" value={draft.shelfLocation} onChange={(value) => changeDraft('shelfLocation', value)} />}
            {supermarket && <label className="inventory-check-field"><input type="checkbox" checked={draft.weighedItem} onChange={(event) => changeDraft('weighedItem', event.target.checked)} /><span>Weighed item (PLU / price per kg)</span></label>}
            {supermarket && <TextField label="PLU code" value={draft.pluCode} onChange={(value) => changeDraft('pluCode', value)} />}
            {supermarket && <TextField label={`Price per kg (${currency.code})`} value={draft.pricePerKg} onChange={(value) => changeDraft('pricePerKg', value)} inputMode="decimal" />}
            {supermarket && <label className="inventory-check-field"><input type="checkbox" checked={draft.expiryTracking} onChange={(event) => changeDraft('expiryTracking', event.target.checked)} /><span>Track perishables expiry</span></label>}
            {supermarket && <label className="inventory-field inventory-field--wide"><span>Variants <small>One per line: code | label | price</small></span><textarea rows={3} value={variantText} onChange={(event) => setVariantText(event.target.value)} placeholder={'SM | Small | 1,200.00\nLG | Large | 2,400.00'} /></label>}
            <label className="inventory-field inventory-field--wide"><span>Description</span><textarea rows={2} value={draft.description} onChange={(event) => changeDraft('description', event.target.value)} /></label>
            <label className="inventory-check-field"><input type="checkbox" checked={draft.isActive} onChange={(event) => changeDraft('isActive', event.target.checked)} /><span>Product is active</span></label>
          </div>
          <div className="inventory-form-actions"><button className="inventory-secondary" type="button" onClick={() => setShowEditor(false)}>Cancel</button><button className="inventory-primary" type="submit">{editing ? 'Save changes' : 'Create product'}</button></div>
        </form>
      </section>}

      {mode === 'stock' && showOrders && <section className="inventory-card">
        <div className="inventory-section-heading"><div><span className="eyebrow eyebrow--gold">PURCHASING</span><h3>Purchase orders & goods received</h3><p>Create a draft order, then receive it into stock with a goods-received note.</p></div><button type="button" className="inventory-secondary" onClick={() => setShowOrders(false)}>Back to stock</button></div>
        {isAdmin && <form className="inventory-form" onSubmit={(event) => void createOrder(event)}>
          <div className="inventory-form-grid">
            <TextField label="Supplier" value={orderSupplier} onChange={setOrderSupplier} required />
            <TextField label="Supplier reference" value={orderReference} onChange={setOrderReference} />
            <label className="inventory-field inventory-field--wide"><span>Order note</span><textarea rows={2} value={orderNote} onChange={(event) => setOrderNote(event.target.value)} /></label>
          </div>
          <div className="inventory-order-lines"><div className="inventory-order-lines__heading"><strong>Order lines</strong><button type="button" className="inventory-link-button" onClick={() => setOrderLines((lines) => [...lines, { productId: '', quantity: '1', quantityUnit: 'unit', unitCost: '' }])}>＋ Add line</button></div>
            {orderLines.map((line, index) => <div className="inventory-order-line" key={`po-line-${index}`}>
              <label className="inventory-field"><span>Product</span><select required value={line.productId} onChange={(event) => setOrderLines((lines) => lines.map((item, row) => row === index ? { ...item, productId: event.target.value } : item))}><option value="">Select product</option>{products.map((product) => <option key={product.id} value={product.id}>{product.sku} · {product.name}</option>)}</select></label>
              <label className="inventory-field"><span>Quantity</span><input required value={line.quantity} onChange={(event) => setOrderLines((lines) => lines.map((item, row) => row === index ? { ...item, quantity: event.target.value } : item))} /></label>
              <label className="inventory-field"><span>Unit</span><select value={line.quantityUnit} onChange={(event) => setOrderLines((lines) => lines.map((item, row) => row === index ? { ...item, quantityUnit: event.target.value as 'unit' | 'pack' } : item))}><option value="unit">Units</option><option value="pack">Packs</option></select></label>
              <label className="inventory-field"><span>Cost per stock unit · {currency.code}</span><input required value={line.unitCost} onChange={(event) => setOrderLines((lines) => lines.map((item, row) => row === index ? { ...item, unitCost: event.target.value } : item))} /></label>
              {orderLines.length > 1 && <button className="inventory-icon-button" type="button" aria-label="Remove order line" onClick={() => setOrderLines((lines) => lines.filter((_item, row) => row !== index))}>×</button>}
            </div>)}
          </div>
          <div className="inventory-form-actions"><button className="inventory-primary" type="submit">Create purchase order</button></div>
        </form>}
        {receivingOrder && <form className="inventory-receipt-form" onSubmit={(event) => void submitOrderReceipt(event)}>
          <h4>Receive {receivingOrder.reference}</h4>
          {receivingOrder.items.map((item, index) => {
            const product = products.find((entry) => entry.id === item.productId) ?? null
            return <div className="inventory-receipt-line" key={item.id}><strong>{item.sku} · {item.productName}<small>Ordered {formatQuantity(item.quantityMilli)} {item.unit}</small></strong>
              {canShowBatch(product) && <>
                <label className="inventory-field"><span>Batch / lot</span><input required value={receiptLines[index]?.batchNumber ?? ''} onChange={(event) => setReceiptLines((lines) => lines.map((line) => line.purchaseItemId === item.id ? { ...line, batchNumber: event.target.value } : line))} /></label>
                <label className="inventory-field"><span>Expiry date</span><input type="date" required value={receiptLines[index]?.expiryDate ?? ''} onChange={(event) => setReceiptLines((lines) => lines.map((line) => line.purchaseItemId === item.id ? { ...line, expiryDate: event.target.value } : line))} /></label>
              </>}
            </div>
          })}
          <label className="inventory-field"><span>Goods-received note</span><textarea rows={2} value={receivingOrder.note} onChange={(event) => setReceivingOrder({ ...receivingOrder, note: event.target.value })} /></label>
          <div className="inventory-form-actions"><button type="button" className="inventory-secondary" onClick={() => setReceivingOrder(null)}>Cancel</button><button type="submit" className="inventory-primary">Receive into stock</button></div>
        </form>}
        <div className="inventory-order-list"><h4>Recent purchase orders</h4>
          {purchaseOrders.length === 0 ? <p className="inventory-empty">No purchase orders yet.</p> : purchaseOrders.map((order) => <div className="inventory-order-card" key={order.id}>
            <div><strong>{order.reference} · {order.supplierName}</strong><span>{order.status} · {order.items.length} line(s) · {order.createdAt.slice(0, 10)}</span></div>
            <div>{order.totalMinor === null ? '' : formatMoney(order.totalMinor, currency, display)}</div>
            {order.status === 'DRAFT' && isAdmin && <button className="inventory-secondary" type="button" onClick={() => startReceivingOrder(order)}>Create goods-received note</button>}
          </div>)}
        </div>
      </section>}

      {mode === 'stock' && !showOrders && action && <section className="inventory-card inventory-action-card">
        <div className="inventory-section-heading"><div><span className="eyebrow eyebrow--gold">{actionLabel(action).toUpperCase()}</span><h3>{actionLabel(action)} · {selectedProduct?.name}</h3><p>Current on-hand stock: {selectedProduct ? formatQuantity(selectedProduct.quantityMilli) : '—'} {selectedProduct?.unit ?? ''}</p></div><button type="button" className="inventory-icon-button" onClick={() => setAction(null)} aria-label="Close stock workflow">×</button></div>
        <form className="inventory-form" onSubmit={(event) => void submitStockAction(event)}>
          <div className="inventory-form-grid">
            <label className="inventory-field inventory-field--wide"><span>Product</span><select value={selectedProductId} onChange={(event) => { setSelectedProductId(event.target.value); const product = products.find((item) => item.id === event.target.value); if (product) setStocktake((current) => ({ ...current, countedQuantity: formatQuantity(product.quantityMilli) })) }}><option value="">Select product</option>{products.map((product) => <option key={product.id} value={product.id}>{product.sku} · {product.name} · {formatQuantity(product.quantityMilli)} {product.unit}</option>)}</select></label>
            {action === 'receive' && <>
              <TextField label="Quantity received" value={receive.quantity} onChange={(value) => setReceive({ ...receive, quantity: value })} required />
              <label className="inventory-field"><span>Quantity is in</span><select value={receive.quantityUnit} onChange={(event) => setReceive({ ...receive, quantityUnit: event.target.value as 'unit' | 'pack' })}><option value="unit">Individual units</option><option value="pack">Packs</option></select></label>
              <TextField label={`Cost per stock unit · ${currency.code}`} value={receive.unitCost} onChange={(value) => setReceive({ ...receive, unitCost: value })} required inputMode="decimal" />
              <TextField label="Supplier" value={receive.supplierName} onChange={(value) => setReceive({ ...receive, supplierName: value })} required />
              <TextField label="Supplier reference" value={receive.supplierReference} onChange={(value) => setReceive({ ...receive, supplierReference: value })} />
              <TextField label="Receiving note" value={receive.note} onChange={(value) => setReceive({ ...receive, note: value })} />
              {canShowBatch(selectedProduct) && <TextField label="Batch / lot number" value={receive.batchNumber} onChange={(value) => setReceive({ ...receive, batchNumber: value })} required />}
              {canShowBatch(selectedProduct) && <TextField label="Expiry date" value={receive.expiryDate} onChange={(value) => setReceive({ ...receive, expiryDate: value })} type="date" required />}
            </>}
            {action === 'adjust' && <>
              <label className="inventory-field"><span>Adjustment</span><select value={adjust.direction} onChange={(event) => setAdjust({ ...adjust, direction: event.target.value as 'increase' | 'decrease' })}><option value="decrease">Remove stock</option><option value="increase">Add stock</option></select></label>
              <TextField label="Quantity" value={adjust.quantity} onChange={(value) => setAdjust({ ...adjust, quantity: value })} required />
              <TextField label="Reason (required)" value={adjust.reason} onChange={(value) => setAdjust({ ...adjust, reason: value })} required />
              {canShowBatch(selectedProduct) && <TextField label={adjust.direction === 'increase' ? 'Batch / lot number' : 'Batch / lot (optional for FEFO removal)'} value={adjust.batchNumber} onChange={(value) => setAdjust({ ...adjust, batchNumber: value })} required={adjust.direction === 'increase'} />}
              {canShowBatch(selectedProduct) && adjust.direction === 'increase' && <TextField label="Expiry date for added lot" value={adjust.expiryDate} onChange={(value) => setAdjust({ ...adjust, expiryDate: value })} type="date" required />}
            </>}
            {action === 'stocktake' && <>
              <TextField label="Counted quantity" value={stocktake.countedQuantity} onChange={(value) => setStocktake({ ...stocktake, countedQuantity: value })} required />
              <TextField label="Reason / stocktake note" value={stocktake.reason} onChange={(value) => setStocktake({ ...stocktake, reason: value })} required />
              {canShowBatch(selectedProduct) && <TextField label={stocktakeAddsQuantity ? 'Batch / lot for added stock' : 'Batch / lot (if stock is added)'} value={stocktake.batchNumber} onChange={(value) => setStocktake({ ...stocktake, batchNumber: value })} required={stocktakeAddsQuantity} />}
              {canShowBatch(selectedProduct) && <TextField label="Expiry date for added stock" value={stocktake.expiryDate} onChange={(value) => setStocktake({ ...stocktake, expiryDate: value })} type="date" required={stocktakeAddsQuantity} />}
            </>}
          </div>
          <div className="inventory-form-actions"><button type="button" className="inventory-secondary" onClick={() => setAction(null)}>Cancel</button><button type="submit" className="inventory-primary">{action === 'receive' ? 'Receive stock' : action === 'adjust' ? 'Save adjustment' : 'Complete stocktake'}</button></div>
        </form>
      </section>}

      {mode === 'stock' && !showOrders && <section className="inventory-card inventory-stocktake-report">
        <div className="inventory-section-heading"><div><span className="eyebrow eyebrow--gold">COUNT HISTORY</span><h3>Stocktake variance report</h3></div><span className="inventory-count">{varianceReport.length} records</span></div>
        {varianceReport.length === 0 ? <p className="inventory-empty">Completed stocktakes will appear here with expected, counted, and variance quantities.</p> : <div className="inventory-table-wrap"><table className="inventory-table"><thead><tr><th>Date</th><th>Product</th><th>Expected</th><th>Counted</th><th>Variance</th><th>Reason</th></tr></thead><tbody>
          {varianceReport.slice(0, 30).map((row, index) => <tr key={`${row.productId}-${row.createdAt}-${index}`}><td>{new Date(row.createdAt).toLocaleString()}</td><td><strong>{row.sku}</strong><span>{row.productName}</span></td><td>{formatQuantity(row.expectedQuantityMilli)}</td><td>{formatQuantity(row.countedQuantityMilli)}</td><td className={row.varianceMilli < 0n ? 'variance-negative' : row.varianceMilli > 0n ? 'variance-positive' : ''}>{row.varianceMilli > 0n ? '+' : ''}{formatQuantity(row.varianceMilli)}</td><td>{row.reason}</td></tr>)}
        </tbody></table></div>}
      </section>}

      {mode === 'stock' && !showOrders && isAdmin && !action && <section className="inventory-card inventory-shortcuts">
        <div className="inventory-section-heading"><div><span className="eyebrow eyebrow--gold">ADMIN WORKFLOWS</span><h3>Stock operations</h3><p>Choose an item below, or start with the first listed product.</p></div></div>
        <div className="inventory-shortcut-buttons">
          <button className="inventory-secondary" type="button" onClick={() => beginStockAction('receive')}>Receive supplier stock</button>
          <button className="inventory-secondary" type="button" onClick={() => beginStockAction('adjust')}>Adjust stock with reason</button>
          <button className="inventory-secondary" type="button" onClick={() => beginStockAction('stocktake')}>Record stocktake</button>
        </div>
      </section>}

      {!showOrders && <section className="inventory-card inventory-products-card">
        <div className="inventory-section-heading"><div><span className="eyebrow eyebrow--gold">{mode === 'products' ? 'CATALOG' : 'ON-HAND STOCK'}</span><h3>{mode === 'products' ? 'Product list' : 'Stock by product'}</h3></div><span className="inventory-count">{products.length} products</span></div>
        {products.length === 0 ? <div className="inventory-empty-state"><div className="inventory-empty-icon">◈</div><h4>{search ? 'No matching products' : 'No products yet'}</h4><p>{search ? 'Try another product name, SKU, or barcode.' : 'Add products manually or import a CSV / Excel product list.'}</p>{isAdmin && !search && mode === 'products' && <button className="inventory-primary" type="button" onClick={startCreate}>Add the first product</button>}</div> : <div className="inventory-table-wrap"><table className="inventory-table"><thead><tr><th>Product</th><th>Barcode / unit</th><th>On hand</th><th>Retail price</th>{isAdmin && <th>Cost</th>}<th>Status</th><th>Actions</th></tr></thead><tbody>
          {products.map((product) => <tr key={product.id} className={selectedProductId === product.id ? 'is-selected' : ''} onClick={() => setSelectedProductId(product.id)}>
            <td><strong>{product.name}</strong><span>{product.sku}{product.brand ? ` · ${product.brand}` : ''}</span></td>
            <td><span>{product.barcode || '—'}</span><small>{product.packSizeUnits > 1 ? `${product.packSizeUnits} ${product.unit} / pack` : product.unit}</small></td>
            <td><strong>{formatQuantity(product.quantityMilli)}</strong><small>{product.reorderLevelMilli > 0n ? `Reorder at ${formatQuantity(product.reorderLevelMilli)}` : ''}</small></td>
            <td>{formatMoney(product.retailPriceMinor, currency, display)}</td>
            {isAdmin && <td>{product.costMinor === null ? '—' : formatMoney(product.costMinor, currency, display)}</td>}
            <td><span className={product.isActive ? 'inventory-status is-active' : 'inventory-status'}>{product.isActive ? 'Active' : 'Inactive'}</span></td>
            <td className="inventory-row-actions" onClick={(event) => event.stopPropagation()}>
              {isAdmin && <><button type="button" onClick={() => startEdit(product)}>Edit</button>{mode === 'stock' && <button type="button" onClick={() => beginStockAction('receive', product)}>Receive</button>}</>}
              {supermarket && isAdmin && product.barcode && mode === 'products' && <button type="button" onClick={() => { setSelectedProductId(product.id); window.setTimeout(() => window.print(), 120) }}>Print label</button>}
            </td>
          </tr>)}
        </tbody></table></div>}
        {mode === 'products' && <p className="inventory-permission-note">{isAdmin ? 'Product prices and costs are Admin-managed. All edits are audited.' : 'View-only access. Costs are hidden and product price edits are restricted to the Admin.'}</p>}
      </section>}

      {mode === 'products' && supermarket && selectedProduct?.weighedItem && <WeighedItemCalculator bridge={bridge} product={selectedProduct} currency={currency} display={display} />}
      {mode === 'products' && supermarket && selectedProduct && selectedProduct.barcode && <BarcodePriceLabel product={selectedProduct} currency={currency} display={display} />}
    </section>
  )
}

function TextField({ label, value, onChange, required = false, type = 'text', min, step, inputMode, hint, listId, options }: {
  label: string; value: string; onChange: (value: string) => void; required?: boolean; type?: string; min?: string; step?: string
  inputMode?: 'decimal' | 'numeric' | 'text'; hint?: string; listId?: string; options?: string[]
}) {
  return <label className="inventory-field"><span>{label}</span><input type={type} min={min} step={step} inputMode={inputMode} value={value} required={required} list={listId} onChange={(event) => onChange(event.target.value)} />{hint && <small>{hint}</small>}{options && <datalist id={listId}>{options.map((option) => <option key={option} value={option} />)}</datalist>}</label>
}

function AlertRow({ alert }: { alert: InventoryAlert }) {
  if (alert.type === 'low_stock') return <div className="inventory-alert-row"><span className="alert-mark alert-mark--stock">!</span><div><strong>{alert.productName}</strong><small>{alert.sku} · {formatQuantity(alert.quantityMilli)} {alert.unit} on hand · reorder at {formatQuantity(alert.reorderLevelMilli)}</small></div><span className="alert-pill alert-pill--stock">Low stock</span></div>
  return <div className="inventory-alert-row"><span className={`alert-mark ${alert.type === 'expired' ? 'alert-mark--expired' : 'alert-mark--expiry'}`}>⌁</span><div><strong>{alert.productName}</strong><small>{alert.sku} · lot {alert.batchNumber} · {formatQuantity(alert.quantityMilli)} {alert.unit} · expires {alert.expiryDate}</small></div><span className={`alert-pill ${alert.type === 'expired' ? 'alert-pill--expired' : 'alert-pill--expiry'}`}>{alert.type === 'expired' ? 'Expired' : 'Near expiry'}</span></div>
}

function WeighedItemCalculator({ bridge, product, currency, display }: {
  bridge: InfoflexBridge; product: ProductRecord; currency: BootstrapData['settings']['currency']; display: BootstrapData['settings']['display']
}) {
  const [weight, setWeight] = useState('0.250')
  const [amountMinor, setAmountMinor] = useState<bigint | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setWeight('0.250')
    setAmountMinor(null)
    setError('')
  }, [product.id])

  async function calculate(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      const result = await bridge.getWeighedPrice(product.id, weight)
      setAmountMinor(result.priceMinor)
    } catch (caught) {
      setAmountMinor(null)
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  return <section className="inventory-card weighed-item-calculator">
    <div><span className="eyebrow eyebrow--gold">SCALE / MANUAL WEIGHT</span><h3>{product.name} · {product.pluCode || 'No PLU'}</h3><p>Enter a scale reading or weigh manually. Price uses the shop currency and exact integer minor units.</p></div>
    <label className="inventory-field"><span>Weight in kg</span><input inputMode="decimal" step="0.001" value={weight} onChange={(event) => { setWeight(event.target.value); setAmountMinor(null); setError('') }} aria-label="Weight in kilograms" /></label>
    <button className="inventory-primary" type="button" onClick={() => void calculate()} disabled={busy}>{busy ? 'Calculating…' : 'Calculate price'}</button>
    {amountMinor !== null && <strong className="weighed-item-calculator__price">{formatMoney(amountMinor, currency, display)}</strong>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>
}

function BarcodePriceLabel({ product, currency, display }: { product: ProductRecord; currency: BootstrapData['settings']['currency']; display: BootstrapData['settings']['display'] }) {
  const svg = useRef<SVGSVGElement>(null)
  useEffect(() => {
    if (!svg.current || !product.barcode) return
    try { JsBarcode(svg.current, product.barcode, { format: 'CODE128', displayValue: true, fontSize: 11, height: 42, margin: 1, lineColor: '#142d52' }) }
    catch { svg.current.replaceChildren() }
  }, [product.barcode])
  return <div className="barcode-label-print" aria-hidden="true"><div className="barcode-label"><strong>{product.name}</strong><span>{formatMoney(product.retailPriceMinor, currency, display)}</span><svg ref={svg} aria-label={`Barcode ${product.barcode}`} /></div></div>
}

function emptyDraft(): ProductDraft {
  return {
    sku: '', name: '', brand: '', description: '', barcode: '', additionalBarcodes: [], category: '', subCategory: '',
    department: '', shelfLocation: '', unit: 'each', packSizeUnits: 1, cost: '0', retailPrice: '', wholesalePrice: '0',
    wholesaleMinimumQuantity: '0', reorderLevel: '0', genericName: '', prescriptionRequired: false, weighedItem: false,
    pluCode: '', pricePerKg: '', expiryTracking: false, variants: [], isActive: true,
  }
}

function toDraft(product: ProductRecord, currency: BootstrapData['settings']['currency'], display: BootstrapData['settings']['display']): ProductDraft {
  return {
    id: product.id, expectedVersion: product.rowVersion, sku: product.sku, name: product.name, brand: product.brand,
    description: product.description, barcode: product.barcode, additionalBarcodes: [...product.additionalBarcodes],
    category: product.category, subCategory: product.subCategory, department: product.department,
    shelfLocation: product.shelfLocation, unit: product.unit, packSizeUnits: product.packSizeUnits,
    cost: product.costMinor === null ? '0' : formatMoney(product.costMinor, currency, display),
    retailPrice: formatMoney(product.retailPriceMinor, currency, display),
    wholesalePrice: formatMoney(product.wholesalePriceMinor, currency, display),
    wholesaleMinimumQuantity: formatQuantity(product.wholesaleMinimumQuantityMilli),
    reorderLevel: formatQuantity(product.reorderLevelMilli), genericName: product.genericName,
    prescriptionRequired: product.prescriptionRequired, weighedItem: product.weighedItem, pluCode: product.pluCode,
    pricePerKg: product.pricePerKgMinor === null ? '' : formatMoney(product.pricePerKgMinor, currency, display),
    expiryTracking: product.expiryTracking,
    variants: product.variants.map((variant) => ({ code: variant.code, label: variant.label,
      price: variant.priceMinor === null ? '' : formatMoney(variant.priceMinor, currency, display), attributes: variant.attributes })),
    isActive: product.isActive,
  }
}

function parseVariantLines(text: string, existingVariants: ProductDraft['variants'] = []): ProductDraft['variants'] {
  const attributesByCode = new Map(existingVariants.map((variant) => [variant.code.toLowerCase(), variant.attributes]))
  return text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [code, label, ...priceParts] = line.split('|').map((part) => part.trim())
    if (!code || !label) throw new Error('Each variant line must include a code and label separated by |.')
    const attributes = attributesByCode.get(code.toLowerCase())
    return { code, label, price: priceParts.join('|'), ...(attributes ? { attributes } : {}) }
  })
}

function parseQuantityForUi(value: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(value.trim())
  if (!match) return null
  return BigInt(match[1]!) * 1000n + BigInt((match[2] ?? '').padEnd(3, '0') || '0')
}

function formatQuantity(value: bigint): string {
  const negative = value < 0n
  const absolute = negative ? -value : value
  const whole = absolute / 1000n
  const fraction = (absolute % 1000n).toString().padStart(3, '0').replace(/0+$/u, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

function stockActionMessage(action: InventoryAction, result: StockMutationResult): string {
  if (action === 'receive') return `Stock received (${result.reference}). New stock: ${formatQuantity(result.product.quantityMilli)}.`
  if (action === 'adjust') return `Stock adjustment saved (${result.reference}). New stock: ${formatQuantity(result.product.quantityMilli)}.`
  return `Stocktake saved (${result.reference}). Variance: ${formatQuantity(result.varianceMilli ?? 0n)}.`
}

function actionLabel(action: InventoryAction): string {
  if (action === 'receive') return 'Receive stock'
  if (action === 'adjust') return 'Adjust stock'
  return 'Stocktake'
}

function importErrorCsv(report: ProductImportReport): string {
  const rows = [['row', 'error'], ...report.errors.map((item) => [String(item.row), item.message])]
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`
}

function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value
  return `"${safe.replace(/"/gu, '""')}"`
}

function downloadBlob(data: string | Uint8Array, filename: string, type: string): void {
  const part: BlobPart = typeof data === 'string' ? data : new Uint8Array(data).buffer as ArrayBuffer
  const blob = new Blob([part], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'This action could not be completed.'
}
