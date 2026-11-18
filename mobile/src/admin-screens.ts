import type {
  MobileApprovals, MobileApproval, MobileCashierPermissions, MobileCashierPermissionRow, MobileDashboard,
  MobileDeviceList, MobileDeviceRow, MobileProductDetail, MobileProductSearch, MobileProductSummary,
  MobileSaleDetail, MobileSaleList, MobileSaleSummary, MobileShopHeader, MobileStockMovement,
} from '../../src/shared/mobile/admin-types'
import type { CurrencyDefinition } from '../../src/currency/catalog'
import { defaultDisplayOptions, type MoneyDisplayOptions } from '../../src/currency/money'
import {
  formatMobileMoney, formatMobileMoneyIn, formatMobileMoneySigned, formatPercent, formatQuantity,
  parseMoneyInput, shopCurrencyContext, type MobileCurrencyContext,
} from './money'

/**
 * The Admin phone's screens, as plain DOM builders.
 *
 * Every builder is a pure function of data it is handed, so the same markup can be rendered in a test without
 * a browser. Nothing here formats money itself: it always asks `money.ts`, which uses the shop's currency
 * definition received from the host — the phone has no currency setting of its own.
 */

export interface CurrencyContext {
  currency: CurrencyDefinition
  display: MoneyDisplayOptions
}

export function currencyOf(header: MobileShopHeader): CurrencyContext {
  return { currency: header.currency, display: header.display }
}

export function money(minor: string | bigint | null | undefined, header: MobileShopHeader | CurrencyContext | ReportHeaderLike): string {
  const context = 'edition' in header ? currencyOf(header as MobileShopHeader) : header
  return formatMobileMoney(toMinor(minor), shopCurrencyContext(context.currency, context.display))
}

interface ReportHeaderLike {
  currency: CurrencyDefinition
  display: MoneyDisplayOptions
}

function toMinor(value: string | bigint | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return typeof value === 'bigint' ? value.toString() : value
}

// ------------------------------------------------------------------ shared pieces

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

export function button(label: string, variant: 'primary' | 'quiet' | 'danger' | 'plain', onClick: () => void): HTMLButtonElement {
  const node = el('button', `button button--${variant}`, label)
  node.type = 'button'
  node.addEventListener('click', onClick)
  return node
}

/** Skeleton rows rather than a spinner: the layout does not jump when the real data arrives. */
export function skeleton(rows = 3, className = 'skeleton'): HTMLElement {
  const wrap = el('div', 'skeleton-stack')
  wrap.setAttribute('aria-hidden', 'true')
  for (let index = 0; index < rows; index += 1) wrap.append(el('div', className))
  return wrap
}

export function emptyState(title: string, detail: string, action?: HTMLButtonElement): HTMLElement {
  const card = el('div', 'empty')
  card.append(el('strong', '', title), el('p', '', detail))
  if (action) card.append(action)
  return card
}

export function card(title?: string): HTMLElement {
  const node = el('section', 'card')
  if (title) node.append(el('h2', 'card__title', title))
  return node
}

export function notice(message: string, tone: 'error' | 'status' | 'stale' = 'status'): HTMLElement {
  const node = el('div', `notice notice--${tone}`, message)
  node.setAttribute('role', tone === 'error' ? 'alert' : 'status')
  return node
}

export function metric(label: string, value: string, detail?: string): HTMLElement {
  const node = el('div', 'metric')
  node.append(el('span', 'metric__label', label), el('strong', 'metric__value', value))
  if (detail) node.append(el('span', 'metric__detail', detail))
  return node
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function formatDay(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

// ------------------------------------------------------------------ dashboard

export interface DashboardHandlers {
  /** The Devices screen, so the connected count is one tap from the tile that shows it. */
  onOpenDevices(): void
  onOpenStock(): void
  onOpenApprovals(): void
  onOpenReports(): void
  onOpenSales(): void
}

export function renderDashboard(value: MobileDashboard, handlers: DashboardHandlers): HTMLElement {
  const page = el('div', 'page')
  const header = currencyOf(value.header)
  const today = el('section', 'hero-card')
  today.append(
    el('span', 'hero-card__eyebrow', 'TODAY'),
    el('strong', 'hero-card__amount', money(value.today.totalSalesMinor, header)),
    el('span', 'hero-card__detail', `${value.today.transactions} sale${value.today.transactions === 1 ? '' : 's'} · net ${money(value.today.netSalesMinor, header)}`),
  )
  page.append(today)

  const month = el('section', 'card card--inline')
  const monthRow = el('div', 'pair')
  monthRow.append(
    metric('This month', money(value.month.totalSalesMinor, header), `${value.month.transactions} sale${value.month.transactions === 1 ? '' : 's'}`),
    metric('Net this month', money(value.month.netSalesMinor, header), value.month.label),
  )
  month.append(monthRow)
  page.append(month)

  const counts = el('div', 'count-grid')
  counts.append(
    countTile('Low stock', value.counts.lowStock, 'Needs reordering', handlers.onOpenStock, value.counts.lowStock > 0 ? 'warn' : 'calm'),
    countTile('Near expiry', value.counts.nearExpiry, 'Expiring soon', handlers.onOpenStock, value.counts.nearExpiry > 0 ? 'warn' : 'calm'),
    countTile('Expired', value.counts.expired, 'Remove from shelf', handlers.onOpenStock, value.counts.expired > 0 ? 'bad' : 'calm'),
    countTile('Waiting for approval', value.counts.pendingApprovals, 'From the till', handlers.onOpenApprovals, value.counts.pendingApprovals > 0 ? 'warn' : 'calm'),
    countTile('Phones connected', value.counts.connectedDevices, 'Admin phones', handlers.onOpenDevices, 'calm'),
  )
  page.append(counts)

  const cashiers = card(`Sales by cashier · ${formatDay(value.today.date)}`)
  if (value.salesByCashierToday.length === 0) {
    cashiers.append(emptyState('No sales yet today', 'Sales appear here as soon as a cashier rings one up at the till.'))
  } else {
    const list = el('ul', 'row-list')
    for (const row of value.salesByCashierToday) {
      const item = el('li', 'row')
      const text = el('div', 'row__text')
      text.append(
        el('strong', 'row__title', row.userName || row.username),
        el('span', 'row__detail', `${row.transactions} sale${row.transactions === 1 ? '' : 's'} · net ${money(row.netSalesMinor, header)}`),
      )
      item.append(text, el('strong', 'row__amount', money(row.totalSalesMinor, header)))
      list.append(item)
    }
    cashiers.append(list)
  }
  page.append(cashiers)

  const quick = el('div', 'quick-grid')
  quick.append(
    button('Find a product', 'primary', handlers.onOpenStock),
    button('Sales and invoices', 'quiet', handlers.onOpenSales),
    button('Reports', 'quiet', handlers.onOpenReports),
  )
  page.append(quick)
  return page
}

function countTile(label: string, count: number, detail: string, action: () => void, tone: 'calm' | 'warn' | 'bad'): HTMLElement {
  const tile = el('button', `count-tile count-tile--${tone}`)
  tile.type = 'button'
  tile.addEventListener('click', action)
  tile.append(
    el('strong', 'count-tile__value', String(count)),
    el('span', 'count-tile__label', label),
    el('span', 'count-tile__detail', detail),
  )
  return tile
}

// ------------------------------------------------------------------ stock

export interface StockHandlers {
  search(term: string): void
  scan(): void
  open(productId: string): void
  back(): void
  /** Scan a barcode for a product the shop has never stocked, then fill in its prices. */
  scanToAdd(): void
}

export function renderStockLanding(query: string, results: MobileProductSearch | null, handlers: StockHandlers): HTMLElement {
  const page = el('div', 'page')
  const search = el('form', 'search-bar')
  const input = document.createElement('input')
  input.className = 'field__input'
  input.type = 'search'
  input.id = 'stock-search'
  input.placeholder = 'Product name, SKU or barcode'
  input.value = query
  input.setAttribute('enterkeyhint', 'search')
  input.autocomplete = 'off'
  const label = el('label', 'field__label', 'Find a product')
  label.htmlFor = 'stock-search'
  const submit = button('Search', 'primary', () => handlers.search(input.value))
  submit.type = 'submit'
  const actions = el('div', 'search-bar__actions')
  const scan = button('Scan barcode', 'quiet', handlers.scan)
  scan.classList.add('search-bar__scan')
  const add = button('Add a new product', 'quiet', handlers.scanToAdd)
  actions.append(scan, add)
  search.append(label, input, submit, actions)
  search.addEventListener('submit', (event) => {
    event.preventDefault()
    handlers.search(input.value)
  })
  page.append(search)

  if (!results) {
    page.append(skeleton(4, 'skeleton skeleton--row'))
    return page
  }
  if (results.products.length === 0) {
    page.append(emptyState('Nothing matched', query ? `No product matches “${query}”. Try a different word or scan the barcode.` : 'Type a name, SKU or barcode to start.'))
    return page
  }
  const context = results.header
  const list = el('ul', 'row-list row-list--products')
  for (const product of results.products) list.append(productRow(product, context, handlers.open))
  page.append(el('p', 'list-count', `${results.products.length} product${results.products.length === 1 ? '' : 's'}`), list)
  return page
}

function productRow(product: MobileProductSummary, header: MobileShopHeader, onOpen: (id: string) => void): HTMLElement {
  const item = el('li', 'row row--tap')
  const open = el('button', 'row__body')
  open.type = 'button'
  open.addEventListener('click', () => onOpen(product.id))
  const text = el('div', 'row__text')
  const tags = el('div', 'tag-row')
  if (!product.isActive) tags.append(el('span', 'tag tag--muted', 'Inactive'))
  if (quantityNumber(product.quantityMilli) <= 0) tags.append(el('span', 'tag tag--bad', 'Out of stock'))
  else if (quantityNumber(product.quantityMilli) <= quantityNumber(product.reorderLevelMilli)) tags.append(el('span', 'tag tag--warn', 'Low stock'))
  if (product.prescriptionRequired) tags.append(el('span', 'tag tag--muted', 'Prescription'))
  text.append(
    el('strong', 'row__title', product.name),
    el('span', 'row__detail', `${product.sku}${product.barcode ? ` · ${product.barcode}` : ''}`),
    tags,
  )
  const right = el('div', 'row__right')
  right.append(
    el('strong', 'row__amount', money(product.retailPriceMinor, header)),
    el('span', 'row__detail', `${formatQuantity(product.quantityMilli)} ${product.unit}`),
  )
  open.append(text, right)
  item.append(open)
  return item
}

function quantityNumber(quantityMilli: string): number {
  const value = Number(quantityMilli)
  return Number.isFinite(value) ? value : 0
}

export interface ProductHandlers {
  back(): void
  savePrice(form: { retailPrice: string; wholesalePrice: string; cost: string; adminPassword: string; name: string; brand: string; category: string; unit: string; barcode: string; reorderLevel: string }): void
  adjust(input: { direction: 'increase' | 'decrease'; quantity: string; reason: string; batchNumber: string; expiryDate: string }): void
  receive(input: { quantity: string; quantityUnit: 'unit' | 'pack'; unitCost: string; supplierName: string; supplierReference: string; note: string; batchNumber: string; expiryDate: string }): void
}

/** The product screen: stock and batches on top, then the three actions the brief asks for. */
/** What the Admin types (or scans) when a barcode belongs to a product the shop has never stocked. */
export interface NewProductHandlers {
  scan(): void
  save(input: {
    name: string; barcode: string; sku: string; unit: string; category: string
    retailPrice: string; wholesalePrice: string; cost: string; reorderLevel: string
    expiryTracking: boolean; prescriptionRequired: boolean
  }): void
  cancel(): void
}

/**
 * Adding a product from the phone. The barcode is the starting point, so a product scanned on the shelf can
 * be priced and put on file without going back to the desktop. Prices use the shop's own currency.
 */
export function renderNewProduct(header: MobileShopHeader, barcode: string, handlers: NewProductHandlers): HTMLElement {
  const context = shopCurrencyContext(header.currency, header.display)
  const page = el('div', 'page')
  const back = button('← Back to stock', 'plain', handlers.cancel)
  back.classList.add('back-link')
  page.append(back)

  const section = card('New product')
  section.append(el('p', 'muted', `Prices are in ${header.currency.code}. The shop's currency is set at installation and cannot be changed here.`))

  const scanned = el('div', 'field')
  const scannedLabel = el('label', 'field__label', 'Barcode')
  scannedLabel.htmlFor = 'new-barcode'
  const barcodeInput = document.createElement('input')
  barcodeInput.className = 'field__input'
  barcodeInput.id = 'new-barcode'
  barcodeInput.value = barcode
  barcodeInput.inputMode = 'numeric'
  barcodeInput.autocomplete = 'off'
  const scan = button('Scan again', 'quiet', handlers.scan)
  scanned.append(scannedLabel, barcodeInput, scan)

  const name = field('new-name', 'Product name', { placeholder: 'For example: Paracetamol 500mg' })
  const sku = field('new-sku', 'SKU (optional)', { placeholder: 'Left empty, the phone uses the barcode' })
  const unit = field('new-unit', 'Unit', { value: 'pack' })
  const category = field('new-category', 'Category (optional)')
  const retail = field('new-retail', `Retail price (${header.currency.code})`, { inputMode: 'decimal' })
  const wholesale = field('new-wholesale', `Wholesale price (${header.currency.code})`, { inputMode: 'decimal' })
  const cost = field('new-cost', `Cost price (optional, ${header.currency.code})`, { inputMode: 'decimal' })
  const reorder = field('new-reorder', 'Reorder level', { inputMode: 'decimal', value: '0' })

  const flags = el('div', 'switch-list')
  const expiry = checkbox('new-expiry', 'Track expiry dates for this product', false)
  const prescription = checkbox('new-prescription', 'Prescription required', false)
  flags.append(expiry.wrap, prescription.wrap)

  const error = notice('', 'error')
  error.hidden = true
  const save = button('Save this product', 'primary', () => {
    if (!name.input.value.trim()) {
      error.hidden = false
      error.textContent = 'Enter the product name.'
      name.input.focus()
      return
    }
    const prices = readPrices([
      ['retail', retail.input.value, false],
      ['wholesale', wholesale.input.value, false],
      ['cost', cost.input.value, true],
    ], context)
    if (!prices.ok) {
      error.hidden = false
      error.textContent = prices.message
      return
    }
    handlers.save({
      name: name.input.value.trim(),
      barcode: barcodeInput.value.trim(),
      sku: sku.input.value.trim(),
      unit: unit.input.value.trim() || 'unit',
      category: category.input.value.trim(),
      retailPrice: prices.prices.retail,
      wholesalePrice: prices.prices.wholesale,
      cost: prices.prices.cost || '0',
      reorderLevel: reorder.input.value.trim() || '0',
      expiryTracking: expiry.input.checked,
      prescriptionRequired: prescription.input.checked,
    })
  })
  save.classList.add('button--block')
  section.append(scanned, name.wrap, sku.wrap, unit.wrap, category.wrap, retail.wrap, wholesale.wrap, cost.wrap, reorder.wrap, flags, error, save)
  page.append(section)
  return page
}

/** A labelled checkbox row, big enough to tap with a thumb. */
function checkbox(id: string, label: string, checked: boolean): { wrap: HTMLElement; input: HTMLInputElement } {
  const wrap = el('label', 'switch-row')
  wrap.htmlFor = id
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.id = id
  input.className = 'switch-row__input'
  input.checked = checked
  wrap.append(input, el('span', 'switch-row__label', label))
  return { wrap, input }
}

export function renderProduct(detail: MobileProductDetail, header: MobileShopHeader, handlers: ProductHandlers): HTMLElement {
  const page = el('div', 'page')
  const back = button('← Back to stock', 'plain', handlers.back)
  back.classList.add('back-link')
  page.append(back)

  const product = detail.product
  const top = el('section', 'product-head')
  top.append(
    el('h1', 'product-head__name', product.name),
    el('p', 'product-head__meta', `${product.sku}${product.barcode ? ` · ${product.barcode}` : ''}${product.category ? ` · ${product.category}` : ''}`),
  )
  const numbers = el('div', 'pair')
  numbers.append(
    metric('In stock', `${formatQuantity(product.quantityMilli)} ${product.unit}`, `Reorder at ${formatQuantity(product.reorderLevelMilli)}`),
    metric('Retail', money(product.retailPriceMinor, header), 'per ' + product.unit),
  )
  top.append(numbers)
  const wholesale = el('div', 'pair')
  wholesale.append(
    metric('Wholesale', money(product.wholesalePriceMinor, header), 'per ' + product.unit),
    metric('Cost', product.costMinor === null ? 'Not set' : money(product.costMinor, header), 'paid to supplier'),
  )
  top.append(wholesale)
  page.append(top)

  page.append(renderBatches(detail.batches))
  page.append(renderEditForm(product, handlers, shopCurrencyContext(header.currency, header.display)))
  page.append(renderAdjustForm(product, handlers))
  page.append(renderReceiveForm(product, handlers, shopCurrencyContext(header.currency, header.display)))
  page.append(renderHistory(detail.history, product.unit))
  return page
}

function renderBatches(batches: MobileProductDetail['batches']): HTMLElement {
  const section = card('Batches and expiry')
  if (batches.length === 0 || batches.every((batch) => batch.quantityMilli === '0' && !batch.batchNumber)) {
    section.append(el('p', 'muted', 'No batches recorded yet. Receive stock below to add one.'))
    return section
  }
  const list = el('ul', 'row-list')
  for (const batch of batches) {
    const item = el('li', 'row')
    const text = el('div', 'row__text')
    text.append(
      el('strong', 'row__title', batch.batchNumber || 'No batch number'),
      el('span', 'row__detail', batch.expiryDate ? `Expires ${batch.expiryDate}` : 'No expiry date'),
    )
    const tags = el('div', 'tag-row')
    if (batch.expiryDate && isExpired(batch.expiryDate)) tags.append(el('span', 'tag tag--bad', 'Expired'))
    else if (batch.expiryDate && isNearExpiry(batch.expiryDate)) tags.append(el('span', 'tag tag--warn', 'Expiring'))
    text.append(tags)
    item.append(text, el('strong', 'row__amount', `${formatQuantity(batch.quantityMilli)}`))
    list.append(item)
  }
  section.append(list)
  return section
}

function isExpired(iso: string): boolean {
  const date = new Date(`${iso}T23:59:59`)
  return !Number.isNaN(date.getTime()) && date.getTime() < Date.now()
}

function isNearExpiry(iso: string): boolean {
  const date = new Date(`${iso}T23:59:59`)
  if (Number.isNaN(date.getTime())) return false
  const days = (date.getTime() - Date.now()) / 86_400_000
  return days >= 0 && days <= 90
}

function field(id: string, label: string, options: { type?: string; value?: string; inputMode?: string; placeholder?: string; step?: string } = {}): { wrap: HTMLElement; input: HTMLInputElement } {
  const wrap = el('div', 'field')
  const labelNode = el('label', 'field__label', label)
  labelNode.htmlFor = id
  const input = document.createElement('input')
  input.className = 'field__input'
  input.id = id
  input.type = options.type ?? 'text'
  if (options.value !== undefined) input.value = options.value
  if (options.inputMode) input.inputMode = options.inputMode
  if (options.placeholder) input.placeholder = options.placeholder
  if (options.step) input.step = options.step
  input.autocomplete = input.type === 'password' ? 'current-password' : 'off'
  wrap.append(labelNode, input)
  return { wrap, input }
}

function renderEditForm(product: MobileProductSummary, handlers: ProductHandlers, context: MobileCurrencyContext): HTMLElement {
  const section = card('Edit details and prices')
  section.append(el('p', 'muted', 'Changing a price or the product details asks for your Admin password again, so nobody at the counter can reprice an item on your phone.'))

  const name = field('edit-name', 'Product name', { value: product.name })
  const brand = field('edit-brand', 'Brand', { value: product.brand })
  const category = field('edit-category', 'Category', { value: product.category })
  const unit = field('edit-unit', 'Unit', { value: product.unit })
  const barcode = field('edit-barcode', 'Barcode', { value: product.barcode })
  const reorder = field('edit-reorder', 'Reorder level', { value: formatQuantity(product.reorderLevelMilli), inputMode: 'decimal' })
  const retail = field('edit-retail', `Retail price (${context.currency.code})`, { value: priceFieldValue(product.retailPriceMinor, context), inputMode: 'decimal' })
  const wholesale = field('edit-wholesale', `Wholesale price (${context.currency.code})`, { value: priceFieldValue(product.wholesalePriceMinor, context), inputMode: 'decimal' })
  const cost = field('edit-cost', `Cost price (${context.currency.code})`, { value: priceFieldValue(product.costMinor ?? '0', context), inputMode: 'decimal' })
  const password = field('edit-password', 'Your Admin password', { type: 'password' })

  const message = notice('')
  message.hidden = true
  const save = button('Save changes', 'primary', () => {
    message.hidden = true
    const check = readPrices([
      ['retail', retail.input.value, false],
      ['wholesale', wholesale.input.value, false],
      ['cost', cost.input.value, true],
    ], context)
    if (!check.ok) {
      message.hidden = false
      message.className = 'notice notice--error'
      message.textContent = check.message
      return
    }
    if (!password.input.value) {
      message.hidden = false
      message.className = 'notice notice--error'
      message.textContent = 'Enter your Admin password to confirm this change.'
      password.input.focus()
      return
    }
    handlers.savePrice({
      name: name.input.value.trim(),
      brand: brand.input.value.trim(),
      category: category.input.value.trim(),
      unit: unit.input.value.trim(),
      barcode: barcode.input.value.trim(),
      reorderLevel: reorder.input.value.trim() || '0',
      // Sent as plain decimals in the shop's own currency, never a second currency and never a float.
      retailPrice: check.prices.retail,
      wholesalePrice: check.prices.wholesale,
      cost: check.prices.cost || '0',
      adminPassword: password.input.value,
    })
  })
  save.classList.add('button--block')

  section.append(name.wrap, brand.wrap, category.wrap, unit.wrap, barcode.wrap, reorder.wrap, retail.wrap, wholesale.wrap, cost.wrap, password.wrap, message, save)
  return section
}

/**
 * A price as the Admin should type it on this phone: the shop's own decimal separator and no grouping, so a
 * Naira shop edits "1250.5" and a franc-zone shop edits "1250,5". It is only ever a starting value.
 */
function priceFieldValue(minor: string, context: MobileCurrencyContext): string {
  const plain = plainFromMinor(minor, context.currency.decimalPlaces)
  return context.currency.decimalSeparator === '.' ? plain : plain.replace('.', context.currency.decimalSeparator)
}

/** Turns integer minor units into the plain dot-decimal string the host's own parser expects. */
function plainFromMinor(minor: string, decimalPlaces: number): string {
  const value = /^-?\d+$/u.test(minor) ? BigInt(minor) : 0n
  const scale = 10n ** BigInt(decimalPlaces)
  const whole = value / scale
  if (decimalPlaces === 0) return whole.toString()
  const fraction = (value % scale).toString().padStart(decimalPlaces, '0').replace(/0+$/u, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

/**
 * Reads the price boxes with the shop's own rules: the shop's separators are understood, and more decimals
 * than the currency allows is an error rather than a silent rounding. The host still parses and validates
 * the value again; this exists so the Admin is told before the round trip.
 */
function readPrices(
  fields: Array<[string, string, boolean]>,
  context: MobileCurrencyContext,
): { ok: true; prices: Record<string, string> } | { ok: false; message: string } {
  const prices: Record<string, string> = {}
  for (const [label, value, optional] of fields) {
    if (value.trim() === '') {
      if (optional) { prices[label] = '0'; continue }
      return { ok: false, message: `Enter the ${label} price.` }
    }
    const parsed = parseMoneyInput(value, context)
    if (!parsed.ok) return { ok: false, message: `The ${label} price: ${parsed.message}` }
    prices[label] = plainFromMinor(parsed.minor, context.currency.decimalPlaces)
  }
  return { ok: true, prices }
}

function renderAdjustForm(product: MobileProductSummary, handlers: ProductHandlers): HTMLElement {
  const section = card('Adjust stock')
  section.append(el('p', 'muted', 'A reason is required. Every adjustment is written to the stock history with your name on it.'))
  const direction = el('div', 'segmented')
  let choice: 'decrease' | 'increase' = 'decrease'
  const down = button('− Remove stock', 'quiet', () => { choice = 'decrease'; paint() })
  const up = button('+ Add stock', 'quiet', () => { choice = 'increase'; paint() })
  const paint = () => {
    down.className = `button button--${choice === 'decrease' ? 'primary' : 'quiet'}`
    up.className = `button button--${choice === 'increase' ? 'primary' : 'quiet'}`
    down.setAttribute('aria-pressed', choice === 'decrease' ? 'true' : 'false')
    up.setAttribute('aria-pressed', choice === 'increase' ? 'true' : 'false')
  }
  direction.append(down, up)
  paint()

  const quantity = field('adjust-quantity', `Quantity (${product.unit})`, { inputMode: 'decimal' })
  const reason = el('div', 'field')
  const reasonLabel = el('label', 'field__label', 'Why is the stock changing?')
  reasonLabel.htmlFor = 'adjust-reason'
  const reasonInput = document.createElement('select')
  reasonInput.className = 'field__input'
  reasonInput.id = 'adjust-reason'
  for (const option of ['Damaged or broken', 'Expired — removed', 'Lost or stolen', 'Stock count correction', 'Returned to supplier', 'Other']) {
    const node = document.createElement('option')
    node.value = option
    node.textContent = option
    reasonInput.append(node)
  }
  const other = field('adjust-reason-other', 'Describe the reason', { placeholder: 'For example: dropped during restocking' })
  other.wrap.hidden = true
  reasonInput.addEventListener('change', () => {
    other.wrap.hidden = reasonInput.value !== 'Other'
    if (!other.wrap.hidden) other.input.focus()
  })
  reason.append(reasonLabel, reasonInput)

  const batch = field('adjust-batch', 'Batch number (optional)', { placeholder: 'Leave empty if not tracked' })
  const expiry = field('adjust-expiry', 'Expiry date (optional)', { type: 'date' })
  const error = notice('', 'error')
  error.hidden = true
  const submit = button('Save adjustment', 'primary', () => {
    const reasonText = reasonInput.value === 'Other' ? other.input.value.trim() : reasonInput.value
    if (!quantity.input.value.trim()) return fail('Enter how much stock is changing.')
    if (reasonText.length < 3) return fail('Say why the stock is changing.')
    handlers.adjust({
      direction: choice,
      quantity: quantity.input.value.trim(),
      reason: reasonText,
      batchNumber: batch.input.value.trim(),
      expiryDate: expiry.input.value,
    })
    function fail(text: string): void {
      error.hidden = false
      error.textContent = text
    }
  })
  submit.classList.add('button--block')
  section.append(direction, quantity.wrap, reason, other.wrap, batch.wrap, expiry.wrap, error, submit)
  return section
}

function renderReceiveForm(product: MobileProductSummary, handlers: ProductHandlers, context: MobileCurrencyContext): HTMLElement {
  const section = card('Receive stock from a supplier')
  const quantity = field('receive-quantity', 'Quantity received', { inputMode: 'decimal' })
  const unitRow = el('div', 'segmented')
  let unitChoice: 'unit' | 'pack' = 'unit'
  const asUnits = button('In units', 'primary', () => { unitChoice = 'unit'; paint() })
  const asPacks = button('In packs', 'quiet', () => { unitChoice = 'pack'; paint() })
  const paint = () => {
    asUnits.className = `button button--${unitChoice === 'unit' ? 'primary' : 'quiet'}`
    asPacks.className = `button button--${unitChoice === 'pack' ? 'primary' : 'quiet'}`
  }
  unitRow.append(asUnits, asPacks)
  const unitCost = field('receive-cost', `Unit cost per ${product.unit} (${context.currency.code})`, { inputMode: 'decimal' })
  const supplier = field('receive-supplier', 'Supplier name')
  const reference = field('receive-reference', 'Supplier invoice number')
  const batch = field('receive-batch', 'Batch number', { placeholder: 'Printed on the carton' })
  const expiry = field('receive-expiry', 'Expiry date', { type: 'date' })
  const note = field('receive-note', 'Note (optional)')
  const error = notice('', 'error')
  error.hidden = true
  const submit = button('Receive stock', 'primary', () => {
    if (!quantity.input.value.trim()) return fail('Enter the quantity received.')
    const cost = readPrices([['unit cost', unitCost.input.value, false]], context)
    if (!cost.ok) return fail(cost.message)
    handlers.receive({
      quantity: quantity.input.value.trim(),
      quantityUnit: unitChoice,
      unitCost: cost.prices['unit cost']!,
      supplierName: supplier.input.value.trim(),
      supplierReference: reference.input.value.trim(),
      note: note.input.value.trim(),
      batchNumber: batch.input.value.trim(),
      expiryDate: expiry.input.value,
    })
    function fail(text: string): void {
      error.hidden = false
      error.textContent = text
    }
  })
  submit.classList.add('button--block')
  section.append(quantity.wrap, unitRow, unitCost.wrap, supplier.wrap, reference.wrap, batch.wrap, expiry.wrap, note.wrap, error, submit)
  return section
}

export function renderHistory(history: MobileStockMovement[], unit: string): HTMLElement {
  const section = card('Stock history')
  if (history.length === 0) {
    section.append(el('p', 'muted', 'No stock movements recorded for this item yet.'))
    return section
  }
  const list = el('ul', 'row-list row-list--compact')
  for (const movement of history) {
    const item = el('li', 'row')
    const text = el('div', 'row__text')
    text.append(
      el('strong', 'row__title', humanise(movement.movementType)),
      el('span', 'row__detail', `${formatDateTime(movement.createdAt)} · ${movement.actor || 'unknown'}${movement.reason ? ` · ${movement.reason}` : ''}`),
    )
    item.append(text, el('strong', `row__amount ${movement.quantityDeltaMilli.startsWith('-') ? 'is-negative' : 'is-positive'}`, `${formatQuantity(movement.quantityDeltaMilli)} ${unit}`))
    list.append(item)
  }
  section.append(list)
  return section
}

function humanise(value: string): string {
  return value.toLowerCase().split(/[_\s]+/u).map((part) => part ? `${part[0]!.toUpperCase()}${part.slice(1)}` : '').join(' ')
}

// ------------------------------------------------------------------ reports

export interface ReportHandlers {
  setPeriod(period: 'DAY' | 'MONTH', date: string): void
  sharePdf(): void
}

/** The wire form: every bigint has already become an integer string. */
export type MobileReportJson = {
  header: { storeName: string; storeAddress: string; currency: CurrencyDefinition; display?: MoneyDisplayOptions; period: { type: 'DAY' | 'MONTH'; startDate: string; endDate: string; label: string }; generatedAt: string }
  summary: {
    grossSalesMinor: string; totalSalesMinor: string; transactions: number
    retail: { totalMinor: string; transactions: number }; wholesale: { totalMinor: string; transactions: number }
    discountsMinor: string; returnsMinor: string; refundsMinor: string; netSalesMinor: string
    cogsMinor: string | null; grossProfitMinor: string | null; returnTransactions: number
  }
  daily: Array<{ date: string; totalSalesMinor: string; transactions: number; retailSalesMinor: string; retailTransactions: number; wholesaleSalesMinor: string; wholesaleTransactions: number; discountsMinor: string; returnsMinor: string; refundsMinor: string; netSalesMinor: string; cogsMinor: string | null; grossProfitMinor: string | null }>
  paymentMethods: Array<{ method: string; totalMinor: string; transactions: number }>
  refundMethods: Array<{ method: string; totalMinor: string; transactions: number }>
}

export function renderReports(summary: MobileReportJson, handlers: ReportHandlers): HTMLElement {
  const page = el('div', 'page')
  const header = summary.header
  // Older hosts may not send the display options; the currency's own definition is the documented fallback.
  const context: CurrencyContext = {
    currency: header.currency,
    display: header.display ?? defaultDisplayOptions(header.currency),
  }

  const controls = el('form', 'period-bar')
  let period: 'DAY' | 'MONTH' = header.period.type
  const dayButton = button('Today', period === 'DAY' ? 'primary' : 'quiet', () => { period = 'DAY'; paint() })
  const monthButton = button('This month', period === 'MONTH' ? 'primary' : 'quiet', () => { period = 'MONTH'; paint() })
  const paint = () => {
    dayButton.className = `button button--${period === 'DAY' ? 'primary' : 'quiet'}`
    monthButton.className = `button button--${period === 'MONTH' ? 'primary' : 'quiet'}`
  }
  const dateInput = document.createElement('input')
  dateInput.className = 'field__input'
  dateInput.type = period === 'DAY' ? 'date' : 'month'
  dateInput.value = header.period.type === 'DAY' ? header.period.startDate : header.period.startDate.slice(0, 7)
  dateInput.setAttribute('aria-label', 'Report date')
  controls.append(dayButton, monthButton, dateInput)
  controls.addEventListener('submit', (event) => event.preventDefault())
  const apply = button('Show', 'quiet', () => handlers.setPeriod(period, dateInput.value))
  apply.type = 'button'
  controls.append(apply)
  page.append(controls)

  const summaryCard = el('section', 'hero-card')
  summaryCard.append(
    el('span', 'hero-card__eyebrow', header.period.label),
    el('strong', 'hero-card__amount', money(summary.summary.totalSalesMinor, context)),
    el('span', 'hero-card__detail', `${summary.summary.transactions} sale${summary.summary.transactions === 1 ? '' : 's'} · net ${money(summary.summary.netSalesMinor, context)}`),
  )
  page.append(summaryCard)

  const figures = el('div', 'pair')
  figures.append(
    metric('Retail', money(summary.summary.retail.totalMinor, context), `${summary.summary.retail.transactions} sales`),
    metric('Wholesale', money(summary.summary.wholesale.totalMinor, context), `${summary.summary.wholesale.transactions} invoices`),
  )
  page.append(figures)
  const figures2 = el('div', 'pair')
  figures2.append(
    metric('Discounts', money(summary.summary.discountsMinor, context), 'given at the till'),
    metric('Returns', money(summary.summary.returnsMinor, context), `${summary.summary.returnTransactions} returns`),
  )
  page.append(figures2)
  if (summary.summary.grossProfitMinor !== null) {
    const profit = el('div', 'pair')
    profit.append(
      metric('Cost of goods', money(summary.summary.cogsMinor, context), 'paid for what sold'),
      metric('Gross profit', money(summary.summary.grossProfitMinor, context), 'before expenses'),
    )
    page.append(profit)
  }

  page.append(renderDailyChart(summary.daily, context))
  page.append(renderMethodList('How customers paid', summary.paymentMethods, context))
  page.append(renderMethodList('How refunds were paid', summary.refundMethods, context))

  const share = button('Share as PDF', 'primary', handlers.sharePdf)
  share.classList.add('button--block')
  page.append(share)
  return page
}

function renderDailyChart(daily: MobileReportJson['daily'], context: CurrencyContext): HTMLElement {
  const section = card('Day by day')
  if (daily.length === 0) {
    section.append(el('p', 'muted', 'No sales in this period yet.'))
    return section
  }
  const values = daily.map((day) => ({ date: day.date, amount: BigInt(day.totalSalesMinor), transactions: day.transactions }))
  const peak = values.reduce((max, day) => (day.amount > max ? day.amount : max), 0n)
  const chart = el('div', 'chart')
  chart.setAttribute('role', 'img')
  chart.setAttribute('aria-label', `Sales by day, highest ${money(peak.toString(), context)}`)
  for (const day of values) {
    const column = el('div', 'chart__column')
    const height = peak === 0n ? 0 : Number((day.amount * 100n) / peak)
    const bar = el('div', 'chart__bar')
    bar.style.height = `${Math.max(2, height)}%`
    bar.title = `${day.date}: ${money(day.amount.toString(), context)}`
    column.append(el('span', 'chart__value', shortMoney(day.amount.toString(), context)), bar, el('span', 'chart__label', day.date.slice(-2)))
    chart.append(column)
  }
  section.append(chart, el('p', 'muted', 'The tallest bar is the best day in this period. Tap a bar for its exact total.'))
  return section
}

function shortMoney(minor: string, context: CurrencyContext): string {
  const value = /^-?\d+$/u.test(minor) ? BigInt(minor) : 0n
  const scale = 10n ** BigInt(context.currency.decimalPlaces)
  const whole = value / scale
  if (whole >= 1_000_000n) return `${(Number(whole / 1_000n) / 1_000).toFixed(1)}m`
  if (whole >= 1_000n) return `${Number(whole / 1_000n)}k`
  return whole.toString()
}

function renderMethodList(title: string, rows: Array<{ method: string; totalMinor: string; transactions: number }>, context: CurrencyContext): HTMLElement {
  const section = card(title)
  if (rows.length === 0) {
    section.append(el('p', 'muted', 'Nothing recorded in this period.'))
    return section
  }
  const list = el('ul', 'row-list row-list--compact')
  for (const row of rows) {
    const item = el('li', 'row')
    const text = el('div', 'row__text')
    text.append(el('strong', 'row__title', humanise(row.method)), el('span', 'row__detail', `${row.transactions} transaction${row.transactions === 1 ? '' : 's'}`))
    item.append(text, el('strong', 'row__amount', money(row.totalMinor, context)))
    list.append(item)
  }
  section.append(list)
  return section
}

// ------------------------------------------------------------------ sales (read only)

export function renderSales(list: MobileSaleList | null, query: string, handlers: { search(term: string): void; open(id: number): void }): HTMLElement {
  const page = el('div', 'page')
  const form = el('form', 'search-bar')
  const input = document.createElement('input')
  input.className = 'field__input'
  input.type = 'search'
  input.id = 'sales-search'
  input.placeholder = 'Receipt or invoice number, or customer'
  input.value = query
  const label = el('label', 'field__label', 'Find a sale')
  label.htmlFor = 'sales-search'
  const submit = button('Search', 'primary', () => handlers.search(input.value))
  submit.type = 'submit'
  form.append(label, input, submit)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    handlers.search(input.value)
  })
  page.append(form)
  if (!list) {
    page.append(skeleton(4, 'skeleton skeleton--row'))
    return page
  }
  if (list.sales.length === 0) {
    page.append(emptyState('No sales found', query ? `Nothing matches “${query}”.` : 'Sales appear here as soon as the till records one.'))
    return page
  }
  const rows = el('ul', 'row-list')
  for (const sale of list.sales) rows.append(saleRow(sale, list.header, handlers.open))
  page.append(el('p', 'list-count', `${list.sales.length} sale${list.sales.length === 1 ? '' : 's'} · newest first`), rows)
  return page
}

function saleRow(sale: MobileSaleSummary, header: MobileShopHeader, onOpen: (id: number) => void): HTMLElement {
  const item = el('li', 'row row--tap')
  const open = el('button', 'row__body')
  open.type = 'button'
  open.addEventListener('click', () => onOpen(sale.id))
  const text = el('div', 'row__text')
  const tags = el('div', 'tag-row')
  tags.append(el('span', `tag ${sale.saleType === 'WHOLESALE' ? 'tag--gold' : 'tag--muted'}`, sale.saleType === 'WHOLESALE' ? 'Wholesale invoice' : 'Retail receipt'))
  text.append(
    el('strong', 'row__title', sale.receiptNumber),
    el('span', 'row__detail', `${formatDateTime(sale.createdAt)} · ${sale.cashier}${sale.customerName ? ` · ${sale.customerName}` : ''}`),
    tags,
  )
  open.append(text, el('strong', 'row__amount', money(sale.totalMinor, header)))
  item.append(open)
  return item
}

export interface SaleDetailHandlers {
  back(): void
  sharePdf(): void
  shareImage(): void
  print(): void
}

export function renderSaleDetail(detail: MobileSaleDetail, handlers: SaleDetailHandlers): HTMLElement {
  const page = el('div', 'page')
  const back = button('← Back to sales', 'plain', handlers.back)
  back.classList.add('back-link')
  page.append(back)

  const head = el('section', 'card receipt')
  head.append(
    el('span', 'hero-card__eyebrow', detail.saleType === 'WHOLESALE' ? 'WHOLESALE INVOICE' : 'RETAIL RECEIPT'),
    el('h1', 'receipt__number', detail.receiptNumber),
    el('p', 'muted', `${formatDateTime(detail.createdAt)} · ${detail.cashier} at ${detail.workstation}`),
  )
  if (detail.customer) {
    const customer = el('div', 'receipt__customer')
    customer.append(el('strong', '', detail.customer.name))
    if (detail.customer.phone) customer.append(el('span', '', detail.customer.phone))
    if (detail.customer.address) customer.append(el('span', '', detail.customer.address))
    head.append(customer)
  }

  const lines = el('ul', 'line-list')
  for (const line of detail.lines) {
    const row = el('li', 'line')
    const text = el('div', 'line__text')
    text.append(
      el('strong', '', line.description),
      el('span', '', `${formatQuantity(line.quantityMilli)} × ${formatMobileMoneyIn(line.unitPriceMinor, detail.currency)}`),
    )
    row.append(text, el('strong', '', formatMobileMoneyIn(line.lineTotalMinor, detail.currency)))
    lines.append(row)
  }
  head.append(lines)

  const totals = el('dl', 'totals')
  appendTotal(totals, 'Subtotal', formatMobileMoneyIn(detail.subtotalMinor, detail.currency))
  if (detail.discountMinor !== '0') appendTotal(totals, 'Discount', `−${formatMobileMoneyIn(detail.discountMinor, detail.currency)}`)
  if (detail.taxMinor !== '0') appendTotal(totals, 'VAT', formatMobileMoneyIn(detail.taxMinor, detail.currency))
  const totalRow = el('div', 'totals__row totals__row--strong')
  totalRow.append(el('dt', '', 'Total'), el('dd', '', formatMobileMoneyIn(detail.totalMinor, detail.currency)))
  totals.append(totalRow)
  appendTotal(totals, 'Paid', formatMobileMoneyIn(detail.paidMinor, detail.currency))
  if (detail.creditMinor !== '0') appendTotal(totals, 'On credit', formatMobileMoneyIn(detail.creditMinor, detail.currency))
  for (const payment of detail.payments) appendTotal(totals, humanise(payment.method), formatMobileMoneyIn(payment.amountMinor, detail.currency))
  head.append(totals)
  page.append(head)

  const actions = el('div', 'stack')
  actions.append(
    button('Share as PDF', 'primary', handlers.sharePdf),
    button('Share as image', 'quiet', handlers.shareImage),
    button('Print at the counter', 'quiet', handlers.print),
  )
  page.append(actions)
  page.append(el('p', 'muted', 'This is a view-only copy. A completed sale can never be edited — correct it with a return at the desktop.'))
  return page
}

function appendTotal(list: HTMLElement, label: string, value: string): void {
  const row = el('div', 'totals__row')
  row.append(el('dt', '', label), el('dd', '', value))
  list.append(row)
}

// ------------------------------------------------------------------ approvals

export interface ApprovalHandlers {
  decide(id: string, decision: 'APPROVE' | 'REJECT'): void
  openSales?(): void
}

export function renderApprovals(value: MobileApprovals, handlers: ApprovalHandlers): HTMLElement {
  const page = el('div', 'page')
  if (value.pending.length === 0) {
    page.append(emptyState('Nothing is waiting for approval', 'Discount, credit, return and void requests from the till appear here the moment a cashier raises one.'))
  } else {
    const list = el('ul', 'row-list')
    for (const request of value.pending) list.append(approvalRow(request, value.header, handlers, true))
    page.append(el('h2', 'section-title', `${value.pending.length} waiting`), list)
  }
  if (value.recent.length > 0) {
    const recent = el('section', 'card')
    recent.append(el('h2', 'card__title', 'Recently decided'))
    const list = el('ul', 'row-list row-list--compact')
    for (const request of value.recent) list.append(approvalRow(request, value.header, handlers, false))
    recent.append(list)
    page.append(recent)
  }
  return page
}

function approvalRow(request: MobileApproval, header: MobileShopHeader, handlers: ApprovalHandlers, actionable: boolean): HTMLElement {
  const item = el('li', 'row row--stacked')
  const text = el('div', 'row__text')
  text.append(
    el('strong', 'row__title', request.label),
    el('span', 'row__detail', `${request.requester} · ${formatDateTime(request.createdAt)}`),
  )
  const line = el('div', 'approval__line')
  if (request.amountMinor) line.append(el('strong', 'row__amount', money(request.amountMinor, header)))
  line.append(el('span', `tag tag--${request.status === 'PENDING' ? 'warn' : request.status === 'APPROVED' ? 'ok' : 'bad'}`, statusLabel(request.status)))
  text.append(line)
  item.append(text)
  if (actionable) {
    const actions = el('div', 'approval__actions')
    actions.append(
      button('Approve', 'primary', () => handlers.decide(request.id, 'APPROVE')),
      button('Reject', 'danger', () => handlers.decide(request.id, 'REJECT')),
    )
    item.append(actions)
  }
  return item
}

function statusLabel(status: MobileApproval['status']): string {
  return status === 'PENDING' ? 'Waiting' : status === 'APPROVED' ? 'Approved' : 'Rejected'
}

// ------------------------------------------------------------------ more (cashiers, devices, install help)

export function renderMore(
  cashiers: MobileCashierPermissions | null,
  handlers: {
    toggleWholesale(row: MobileCashierPermissionRow, allow: boolean, password: string): void
    reloadCashiers(): void
    signOut(): void
    openDevices(): void
  },
): HTMLElement {
  const page = el('div', 'page')
  const cashierSection = card('Cashier permissions')
  cashierSection.append(el('p', 'muted', 'Turn wholesale selling on or off for a cashier. Adding users and setting passwords stay on the desktop.'))
  if (!cashiers) {
    cashierSection.append(skeleton(2, 'skeleton skeleton--row'))
  } else if (cashiers.cashiers.length === 0) {
    cashierSection.append(el('p', 'muted', 'No cashier accounts on this shop yet. Add them on the desktop.'))
  } else {
    for (const row of cashiers.cashiers) cashierSection.append(cashierRow(row, handlers.toggleWholesale))
    cashierSection.append(button('Reload the list', 'quiet', handlers.reloadCashiers))
  }
  page.append(cashierSection)

  const devices = card('Connected phones')
  devices.append(
    el('p', 'muted', 'See which phones can open this shop and revoke one you no longer trust. Revoking takes effect on that phone’s very next action.'),
  )
  devices.append(button('Manage connected phones', 'quiet', handlers.openDevices))
  page.append(devices)

  page.append(installGuide())
  const out = button('Sign out of this phone', 'danger', handlers.signOut)
  out.classList.add('button--block')
  page.append(out)
  return page
}

function cashierRow(row: MobileCashierPermissionRow, toggle: (row: MobileCashierPermissionRow, allow: boolean, password: string) => void): HTMLElement {
  const item = el('section', 'cashier')
  const head = el('div', 'cashier__head')
  const text = el('div', 'row__text')
  text.append(
    el('strong', 'row__title', row.fullName || row.username),
    el('span', 'row__detail', `${row.role === 'SUPERVISOR' ? 'Supervisor' : 'Cashier'} · ${row.username}${row.isActive ? '' : ' · inactive'}`),
  )
  head.append(text, el('span', `tag ${row.allowWholesale ? 'tag--ok' : 'tag--muted'}`, row.allowWholesale ? 'Wholesale on' : 'Wholesale off'))
  item.append(head)

  const detail = el('p', 'muted')
  detail.textContent = `Discount limit ${formatPercent(row.maxDiscountBasisPoints)} · ${row.allowCreditSales ? 'can sell on credit' : 'no credit sales'}`
  item.append(detail)

  const form = el('div', 'cashier__form')
  const password = field(`cashier-${row.id}-password`, 'Your Admin password', { type: 'password' })
  const flip = button(row.allowWholesale ? 'Turn wholesale off' : 'Turn wholesale on', row.allowWholesale ? 'danger' : 'primary', () => {
    if (!password.input.value) {
      password.input.focus()
      password.input.classList.add('is-invalid')
      return
    }
    password.input.classList.remove('is-invalid')
    toggle(row, !row.allowWholesale, password.input.value)
  })
  form.append(password.wrap, flip)
  item.append(form)
  return item
}

export interface DeviceHandlers {
  back(): void
  reload(): void
  revoke(device: MobileDeviceRow, password: string): void
}

/** The paired phones, each with its own password-protected revoke button. */
export function renderDevices(list: MobileDeviceList | null, handlers: DeviceHandlers): HTMLElement {
  const page = el('div', 'page')
  const back = button('← Back', 'plain', handlers.back)
  back.classList.add('back-link')
  page.append(back)

  const section = card('Connected phones')
  section.append(el('p', 'muted', 'Only an Admin phone can be paired with this shop. Revoking signs that phone out at once; it must be paired again from the desktop.'))
  if (!list) {
    section.append(skeleton(3, 'skeleton skeleton--row'))
    page.append(section)
    return page
  }
  if (list.devices.length === 0) {
    section.append(emptyState('No phones paired', 'Pair a phone from Mobile Access on the desktop.'))
    page.append(section)
    return page
  }
  const rows = el('ul', 'row-list')
  for (const device of list.devices) rows.append(deviceRow(device, handlers.revoke))
  section.append(rows)
  section.append(button('Reload the list', 'quiet', handlers.reload))
  page.append(section)
  return page
}

function deviceRow(device: MobileDeviceRow, revoke: DeviceHandlers['revoke']): HTMLElement {
  const item = el('li', 'row row--stacked')
  const text = el('div', 'row__text')
  const tags = el('div', 'tag-row')
  tags.append(el('span', `tag tag--${device.connected ? 'ok' : 'muted'}`, device.connected ? 'Signed in now' : 'Signed out'))
  text.append(
    el('strong', 'row__title', device.name),
    el('span', 'row__detail', `${device.platform} · ${device.lastSeen ? `last used ${formatDay(device.lastSeen.slice(0, 10))}` : `paired ${formatDay(device.createdAt.slice(0, 10))}`}`),
    tags,
  )
  item.append(text)

  const form = el('div', 'cashier__form')
  const password = field(`revoke-${device.id}-password`, 'Your Admin password', { type: 'password' })
  const go = button('Revoke this phone', 'danger', () => {
    if (!password.input.value) {
      password.input.focus()
      password.input.classList.add('is-invalid')
      return
    }
    password.input.classList.remove('is-invalid')
    revoke(device, password.input.value)
  })
  form.append(password.wrap, go)
  item.append(form)
  return item
}

export function installGuide(): HTMLElement {
  const section = card('Install this app on your phone')
  const android = el('div', 'guide')
  android.append(
    el('h3', '', 'Android (Chrome)'),
    el('p', '', 'Open this page in Chrome, tap the ⋮ menu, then tap “Add to Home screen” (sometimes shown as “Install app”).'),
  )
  const iphone = el('div', 'guide')
  iphone.append(
    el('h3', '', 'iPhone (Safari)'),
    el('p', '', 'You must use Safari. Tap the Share button (the square with an arrow), scroll down, then tap “Add to Home Screen”.'),
    el('p', 'muted', 'iOS 16.4 or later. Push notifications only work in the installed app, not in the browser tab.'),
  )
  section.append(android, iphone)
  return section
}

// ------------------------------------------------------------------ download / share helpers

export function base64ToBlob(base64: string, type: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type })
}

export function fileSafeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 80) || 'infoflex'
}

export { formatMobileMoneySigned, parseMoneyInput, formatQuantity }
