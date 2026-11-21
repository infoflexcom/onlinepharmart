import './style.css'
import type { MobileLoginResult, MobileSessionCredentials } from '../../src/shared/mobile/types'
import type { MobileAccountingSummary } from '../../src/shared/reports/types'
import type {
  MobileApprovals, MobileCashierPermissionRow, MobileCashierPermissions, MobileDashboard, MobileDeviceList,
  MobileDeviceRow, MobileProductDetail, MobileProductSearch, MobileSaleDetail, MobileSaleList,
} from '../../src/shared/mobile/admin-types'
import { MobileAdminClient, StaleScreenError } from './admin-client'
import { openBarcodeScanner } from './scan-sheet'
import {
  fileSafeName, renderApprovals, renderDashboard, renderDevices, renderMore, renderNewProduct, renderProduct,
  renderSaleDetail, renderSales, renderReports, renderStockLanding, skeleton,
} from './admin-screens'
import { buildSaleImage, buildSalePdf } from './receipt-document'
import { base64ToBlob } from './admin-screens'
import { clearDeviceToken, clearSession, readDeviceToken, readSession, verifySessionStorage, writeDeviceToken, writeSession } from './session-store'
import { singleFlight } from './single-flight'

type JsonValue<T> = T extends bigint ? string
  : T extends readonly (infer Item)[] ? JsonValue<Item>[]
    : T extends object ? { [Key in keyof T]: JsonValue<T[Key]> }
      : T

type MobileSummary = JsonValue<MobileAccountingSummary>

type ReportPeriod = 'DAY' | 'MONTH'

const appRootElement = document.querySelector<HTMLDivElement>('#app')
if (!appRootElement) throw new Error('Mobile app root is missing.')
const appRoot: HTMLDivElement = appRootElement

let session: MobileSessionCredentials | null = null
let sessionStorageAvailable = false
let report: MobileSummary | null = null
export type AdminTab = 'dashboard' | 'stock' | 'sales' | 'approvals' | 'reports' | 'more'
let activeTab: AdminTab = 'dashboard'
/** Per-tab caches, cleared on sign-out so nothing lingers on a phone that changes hands. */
let dashboard: MobileDashboard | null = null
let approvals: MobileApprovals | null = null
let cashiers: MobileCashierPermissions | null = null
let sales: MobileSaleList | null = null
let stockSearch = ''
let stockResults: MobileProductSearch | null = null
let openProduct: MobileProductDetail | null = null
/** Set while the Admin is adding a product that was scanned but is not on file yet. */
let newProductBarcode: string | null = null
let devices: MobileDeviceList | null = null
let showingDevices = false
let openSale: MobileSaleDetail | null = null
let staleNotice = ''
let period: ReportPeriod = 'DAY'
let reportDate = localDate()
let errorMessage = ''
let statusMessage = ''
let loading = false
let signOutRequested = false
type RefreshOutcome = 'ok' | 'invalid' | 'unavailable' | 'storage-error' | 'storage-error-unrevoked'

void boot()

async function boot(): Promise<void> {
  if ('serviceWorker' in navigator) {
    void navigator.serviceWorker.register('/service-worker.js').catch(() => undefined)
  }
  // Stores do not offer a manual refresh, so returning to the installed app re-reads the current period.
  const refreshWhenVisible = () => {
    if (session && !signOutRequested && document.visibilityState === 'visible') void refreshCurrentView()
  }
  window.addEventListener('pageshow', refreshWhenVisible)
  document.addEventListener('visibilitychange', refreshWhenVisible)
  let storedSession: MobileSessionCredentials | null = null
  try {
    storedSession = await readSession()
    await verifySessionStorage()
    session = storedSession
    sessionStorageAvailable = true
  } catch {
    session = null
    sessionStorageAvailable = false
    if (storedSession) void revokeUnstoredSession(storedSession.accessToken)
    errorMessage = 'Phone browser storage is unavailable. Enable site storage in a current browser, then reload this page before pairing.'
  }
  if (!session) {
    // A phone that is already approved only needs the Admin to sign in; otherwise it must pair first.
    let deviceToken: string | null = null
    try {
      deviceToken = await readDeviceToken()
    } catch {
      deviceToken = null
    }
    if (deviceToken) {
      void renderLogin(deviceToken)
      return
    }
    renderPairing()
    return
  }
  await refreshCurrentView()
}

async function renderPairing(): Promise<void> {
  const shell = element('main', 'pair-screen')
  const logo = element('div', 'pair-brand')
  const brandMark = element('div', 'brand-mark', 'I')
  const brandText = element('div', 'brand-name')
  brandText.append(element('strong', '', 'INFOFLEX'), element('span', '', 'ADMIN MOBILE'))
  logo.append(brandMark, brandText)
  shell.append(logo)

  const panel = element('section', 'pair-card')
  panel.append(element('span', 'eyebrow', 'PRIVATE ADMIN ACCESS'))
  panel.append(element('h1', '', 'Pair this phone'))
  panel.append(element('p', 'muted', 'Enter the short-lived code from Mobile Access on the shop computer. After this, the Admin approves this phone on that computer, and you sign in with the Admin account.'))
  const form = element('form', 'pair-form')
  const nameLabel = element('label', 'form-field')
  nameLabel.append(element('span', '', 'Phone name'))
  const nameInput = element('input')
  nameInput.name = 'deviceName'
  nameInput.maxLength = 80
  nameInput.required = true
  nameInput.autocomplete = 'off'
  nameInput.value = suggestedDeviceName()
  nameLabel.append(nameInput)
  const platformLabel = element('label', 'form-field')
  platformLabel.append(element('span', '', 'Platform'))
  const platformInput = element('input')
  platformInput.name = 'platform'
  platformInput.maxLength = 40
  platformInput.required = true
  platformInput.autocomplete = 'off'
  platformInput.value = suggestedPlatform()
  platformLabel.append(platformInput)
  const codeLabel = element('label', 'form-field')
  codeLabel.append(element('span', '', 'Eight-digit pairing code'))
  const codeInput = element('input')
  codeInput.name = 'code'
  codeInput.type = 'text'
  codeInput.inputMode = 'numeric'
  codeInput.pattern = '[0-9]{8}'
  codeInput.maxLength = 8
  codeInput.autocomplete = 'one-time-code'
  codeInput.required = true
  codeInput.setAttribute('aria-label', 'Eight-digit pairing code')
  codeLabel.append(codeInput)
  const submit = element('button', 'button button--primary', 'Pair Admin phone')
  submit.type = 'submit'
  const alert = element('p', 'inline-message', errorMessage)
  alert.setAttribute('role', 'alert')
  const info = element('p', 'inline-message inline-message--success', statusMessage)
  info.setAttribute('role', 'status')
  if (!sessionStorageAvailable) {
    nameInput.disabled = true
    platformInput.disabled = true
    codeInput.disabled = true
    submit.disabled = true
  }
  form.append(nameLabel, platformLabel, codeLabel, submit, alert, info)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void pairPhone(form, submit, alert, info)
  })
  panel.append(form)
  const security = element('aside', 'security-note')
  security.append(element('strong', '', 'Before pairing'))
  security.append(element('p', '', 'Install and trust the host certificate on this phone first. Never send your pairing code to anyone; the desktop Admin approves the short pairing window.'))
  shell.append(panel, security, element('footer', 'app-foot', 'Infoflex Mobile · Reports and return approvals only'))
  appRoot.replaceChildren(shell)
}

/**
 * Step 1 of pairing. The host answers 202 Accepted with a request token and *no* session; this phone then
 * waits for the Admin to approve it on the desktop. Nothing here can read shop data.
 */
async function pairPhone(form: HTMLFormElement, submit: HTMLButtonElement, alert: HTMLElement, info: HTMLElement): Promise<void> {
  if (!sessionStorageAvailable) {
    alert.textContent = 'Phone browser storage is unavailable. Enable site storage and reload this page before pairing.'
    return
  }
  const values = new FormData(form)
  const payload = {
    code: String(values.get('code') ?? '').trim(),
    deviceName: String(values.get('deviceName') ?? '').trim(),
    platform: String(values.get('platform') ?? '').trim(),
  }
  if (!/^\d{8}$/u.test(payload.code)) {
    alert.textContent = 'Enter all eight digits from the desktop pairing card.'
    return
  }
  submit.disabled = true
  alert.textContent = ''
  info.textContent = 'Checking the one-time code…'
  try {
    const response = await fetch('/api/v1/mobile/pair', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await parseJson<{ requestToken?: string; message?: string }>(response)
    if (!response.ok || !body.requestToken) throw new Error(body.message || 'Phone pairing could not be completed.')
    await writeDeviceToken(body.requestToken)
    renderWaitingForApproval(body.requestToken, payload.deviceName)
  } catch (error) {
    info.textContent = ''
    alert.textContent = errorText(error)
    submit.disabled = !sessionStorageAvailable
  }
}

/**
 * Step 2: poll until the Admin approves (or rejects) on the desktop. The screen says what is happening and
 * what the Admin is looking at, so a five-minute wait is not a mystery.
 */
function renderWaitingForApproval(requestToken: string, deviceName: string): void {
  const shell = element('main', 'pair-screen')
  const panel = element('section', 'pair-card')
  panel.append(element('span', 'eyebrow', 'WAITING FOR APPROVAL'))
  panel.append(element('h1', '', 'Ask the Admin to approve this phone'))
  panel.append(element('p', 'muted', `“${deviceName}” is waiting. On the shop computer, the Admin will see a message asking to approve this phone, showing your phone name and a four-digit code.`))
  const status = element('p', 'inline-message', 'Looking for the Admin’s decision…')
  status.setAttribute('role', 'status')
  const alert = element('p', 'inline-message')
  alert.setAttribute('role', 'alert')
  const retry = element('button', 'button button--ghost', 'Start pairing again')
  retry.type = 'button'
  retry.addEventListener('click', () => { void clearDeviceToken().finally(() => renderPairing()) })
  panel.append(status, alert, retry)
  shell.append(panel, element('footer', 'app-foot', 'Infoflex Mobile · Admin only'))
  appRoot.replaceChildren(shell)

  let stopped = false
  const stop = (): void => { stopped = true }
  window.setTimeout(stop, 30 * 60_000)
  const poll = async (): Promise<void> => {
    if (stopped) return
    try {
      const response = await fetch(`/api/v1/mobile/pair/status?requestToken=${encodeURIComponent(requestToken)}`, {
        cache: 'no-store',
        headers: { accept: 'application/json' },
      })
      const body = await parseJson<{ status?: string; message?: string }>(response)
      if (!response.ok) {
        alert.textContent = body.message || 'This phone could not check its pairing.'
      } else if (body.status === 'APPROVED') {
        stop()
        void renderLogin(requestToken, 'This phone is approved. Sign in with the Admin account.')
        return
      } else if (body.status === 'REJECTED') {
        stop()
        alert.textContent = 'The Admin did not approve this phone. Ask the Admin for a new pairing code, then pair again.'
        return
      } else if (body.status === 'EXPIRED') {
        stop()
        alert.textContent = 'This pairing request expired. Ask the Admin for a new pairing code, then pair again.'
        return
      }
    } catch {
      alert.textContent = 'Waiting for the shop computer. Make sure this phone is still on the same network.'
    }
    window.setTimeout(() => { void poll() }, 2_000)
  }
  void poll()
}

/**
 * Step 3: Admin username + password, plus the six-digit authenticator code when the host asks for it.
 * A Cashier or Supervisor is refused here with exactly the same message as a wrong password.
 */
async function renderLogin(deviceToken: string, notice = ''): Promise<void> {
  const shell = element('main', 'pair-screen')
  const logo = element('div', 'pair-brand')
  const brandText = element('div', 'brand-name')
  brandText.append(element('strong', '', 'INFOFLEX'), element('span', '', 'ADMIN MOBILE'))
  logo.append(element('div', 'brand-mark', 'I'), brandText)
  const panel = element('section', 'pair-card')
  panel.append(logo)
  panel.append(element('span', 'eyebrow', 'ADMIN SIGN-IN'))
  // The brief asks the login screen to say plainly that it is for the Admin.
  panel.append(element('h1', '', 'Admin login'))
  panel.append(element('p', 'muted', 'Use the Admin account for this shop. Mobile access is for the Admin only; Cashier and Supervisor accounts cannot sign in here.'))
  if (notice) panel.append(element('p', 'inline-message inline-message--success', notice))

  const form = element('form', 'pair-form')
  const usernameField = labeledInput('Admin username', { name: 'username', autocomplete: 'username', required: true })
  const passwordField = labeledInput('Password', { name: 'password', type: 'password', autocomplete: 'current-password', required: true })
  const totpField = labeledInput('Authenticator code (only when asked)', {
    name: 'totpCode', inputMode: 'numeric', maxLength: 6, autocomplete: 'one-time-code',
  })
  totpField.label.hidden = true
  const submit = element('button', 'button button--primary', 'Sign in')
  submit.type = 'submit'
  const alert = element('p', 'inline-message')
  alert.setAttribute('role', 'alert')
  const info = element('p', 'inline-message')
  info.setAttribute('role', 'status')
  const unpair = element('button', 'button button--ghost', 'This is not my phone — start over')
  unpair.type = 'button'
  unpair.addEventListener('click', () => { void clearDeviceToken().finally(() => renderPairing()) })
  form.append(usernameField.label, passwordField.label, totpField.label, submit, alert, info, unpair)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void submitLogin(deviceToken, form, submit, alert, info, totpField.label)
  })
  panel.append(form)
  shell.append(panel, element('footer', 'app-foot', 'Infoflex Mobile · Admin only'))
  appRoot.replaceChildren(shell)
  usernameField.input.focus()
}

async function submitLogin(
  deviceToken: string,
  form: HTMLFormElement,
  submit: HTMLButtonElement,
  alert: HTMLElement,
  info: HTMLElement,
  totpLabel: HTMLLabelElement,
): Promise<void> {
  const values = new FormData(form)
  const payload: { username: string; password: string; totpCode?: string } = {
    username: String(values.get('username') ?? '').trim(),
    password: String(values.get('password') ?? ''),
  }
  const code = String(values.get('totpCode') ?? '').trim()
  if (code) payload.totpCode = code
  if (!payload.username || !payload.password) {
    alert.textContent = 'Enter the Admin username and password.'
    return
  }
  submit.disabled = true
  alert.textContent = ''
  info.textContent = 'Signing in…'
  try {
    const response = await fetch('/api/v1/mobile/session/login', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ ...payload, deviceToken }),
    })
    const body = await parseJson<MobileLoginResult & { message?: string }>(response)
    if (!response.ok) {
      // The host asks for a code only once it knows the account; showing the field on demand avoids telling a
      // stranger whether this shop uses an authenticator at all.
      if (/authenticator|six-digit|code/iu.test(body.message ?? '')) {
        totpLabel.hidden = false
        totpLabel.querySelector('input')?.focus()
      }
      throw new Error(body.message || 'Sign-in failed.')
    }
    // The login response is the session; the phone-side store keeps the shape it already understands.
    const stored: MobileSessionCredentials = { ...body, loginRequired: false }
    await writeSession(stored)
    session = stored
    errorMessage = ''
    statusMessage = ''
    await refreshCurrentView()
  } catch (error) {
    info.textContent = ''
    alert.textContent = errorText(error)
  } finally {
    submit.disabled = false
  }
}

function labeledInput(labelText: string, options: {
  name: string
  type?: string
  autocomplete?: string
  inputMode?: string
  maxLength?: number
  required?: boolean
}): { label: HTMLLabelElement; input: HTMLInputElement } {
  const label = element('label', 'form-field')
  label.append(element('span', '', labelText))
  const input = element('input')
  input.name = options.name
  if (options.type) input.type = options.type
  if (options.autocomplete) input.setAttribute('autocomplete', options.autocomplete)
  if (options.inputMode) input.inputMode = options.inputMode as 'numeric'
  if (options.maxLength) input.maxLength = options.maxLength
  if (options.required) input.required = true
  label.append(input)
  return { label, input }
}

/**
 * Loads whatever the current tab shows. Reads only — nothing here can change a sale or stock, so a dropped
 * connection can safely retry a read and never queues a write.
 */
const refreshCurrentView = singleFlight(async (): Promise<void> => {
  if (!session) {
    await renderPairing()
    return
  }
  loading = true
  try {
    if (activeTab === 'dashboard') await loadDashboard()
    else if (activeTab === 'stock') {
      if (!stockResults) await searchStock('')
    } else if (activeTab === 'sales') await loadSales(salesQuery)
    else if (activeTab === 'approvals') await loadApprovals()
    else if (activeTab === 'reports') await loadReport()
    else if (activeTab === 'more') await loadCashiers()
    errorMessage = ''
  } catch (error) {
    handleScreenError(error)
  } finally {
    loading = false
  }
  if (session) renderApp()
  else await renderPairing()
})

/**
 * Reads the accounting report through the same Admin endpoint the phone's own dashboard uses, so the phone
 * has exactly one report contract to satisfy. `setPeriod` comes from the buttons on the reports screen.
 */
async function loadReport(nextPeriod: 'DAY' | 'MONTH' = period, nextDate = reportDate): Promise<void> {
  period = nextPeriod
  reportDate = nextDate
  loading = true
  errorMessage = ''
  try {
    const query = new URLSearchParams({ period, date: reportDate })
    report = await client().get<MobileSummary>(`/reports?${query}`)
    statusMessage = `Updated ${report.header.period.label} · ${report.header.currency.code}`
  } catch (error) {
    handleScreenError(error)
  } finally {
    loading = false
    renderApp()
  }
}

function renderApp(): void {
  if (!session) {
    void renderPairing()
    return
  }
  const shell = element('main', 'app-shell')
  const header = element('header', 'app-header')
  const brand = element('div', 'app-brand')
  brand.append(element('div', 'brand-mark', 'I'))
  const name = element('div', 'brand-name')
  // The customer's own store name, never a hard-coded shop name.
  name.append(element('strong', '', (dashboard?.header.storeName ?? 'INFOFLEX').toUpperCase()), element('span', '', 'ADMIN MOBILE'))
  brand.append(name)
  const signOut = element('button', 'button button--quiet button--small', 'Sign out')
  signOut.type = 'button'
  signOut.addEventListener('click', () => void signOutPhone())
  header.append(brand, signOut)

  const banners = element('div', 'banners')
  if (!navigator.onLine) {
    const offline = element('div', 'banner banner--offline', 'Offline — showing the last data loaded on this phone. Nothing new can be saved until you reconnect.')
    offline.setAttribute('role', 'status')
    banners.append(offline)
  }
  if (staleNotice) {
    const stale = element('div', 'banner banner--stale', staleNotice)
    stale.setAttribute('role', 'status')
    const dismiss = element('button', 'button button--plain button--small', 'Dismiss')
    dismiss.type = 'button'
    dismiss.addEventListener('click', () => { staleNotice = ''; renderApp() })
    stale.append(dismiss)
    banners.append(stale)
  }
  if (errorMessage) {
    const error = element('div', 'banner banner--error', errorMessage)
    error.setAttribute('role', 'alert')
    banners.append(error)
  } else if (statusMessage) {
    const status = element('div', 'banner banner--status', statusMessage)
    status.setAttribute('role', 'status')
    banners.append(status)
  }
  if (loading) banners.append(element('div', 'banner banner--status', 'Connecting to shop…'))

  const content = element('section', 'content')
  if (activeTab === 'dashboard') content.append(renderDashboardTab())
  else if (activeTab === 'stock') content.append(renderStockTab())
  else if (activeTab === 'sales') content.append(renderSalesTab())
  else if (activeTab === 'approvals') content.append(renderApprovalsTab())
  else if (activeTab === 'reports') content.append(renderReportsTab())
  else content.append(renderMoreTab())

  shell.append(header, banners, content, renderTabBar())
  appRoot.replaceChildren(shell)
}

const TABS: Array<{ id: AdminTab; label: string }> = [
  { id: 'dashboard', label: 'Home' },
  { id: 'stock', label: 'Stock' },
  { id: 'sales', label: 'Sales' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'reports', label: 'Reports' },
  { id: 'more', label: 'More' },
]

function renderTabBar(): HTMLElement {
  const nav = element('nav', 'tabbar')
  nav.setAttribute('aria-label', 'Admin sections')
  const badge = approvals?.pendingCount ?? dashboard?.counts.pendingApprovals ?? 0
  for (const tab of TABS) {
    const node = tabButton(tab.label, activeTab === tab.id, () => {
      activeTab = tab.id
      errorMessage = ''
      statusMessage = ''
      void refreshCurrentView()
    })
    node.classList.add('tabbar__tab')
    if (tab.id === 'approvals' && badge > 0) {
      const count = element('span', 'tabbar__badge', String(badge))
      count.setAttribute('aria-label', `${badge} waiting for approval`)
      node.append(count)
    }
    nav.append(node)
  }
  return nav
}

function client(): MobileAdminClient {
  return new MobileAdminClient()
}

function handleScreenError(error: unknown): void {
  if (error instanceof StaleScreenError || (error instanceof Error && /reload/iu.test(error.message) && /changed|decided/iu.test(error.message))) {
    staleNotice = error.message.includes('decided')
      ? 'This request was already decided. Reloading the list.'
      : 'This item was changed, reload.'
    return
  }
  errorMessage = errorText(error)
}

function renderDashboardTab(): HTMLElement {
  if (!dashboard) return skeletonPage()
  return renderDashboard(dashboard, {
    onOpenStock: () => { activeTab = 'stock'; void refreshCurrentView() },
    onOpenApprovals: () => { activeTab = 'approvals'; void refreshCurrentView() },
    onOpenReports: () => { activeTab = 'reports'; void refreshCurrentView() },
    onOpenSales: () => { activeTab = 'sales'; void refreshCurrentView() },
    onOpenDevices: () => { activeTab = 'more'; showingDevices = true; devices = null; void loadDevices() },
  })
}

function renderStockTab(): HTMLElement {
  if (newProductBarcode !== null) {
    return renderNewProduct(dashboard!.header, newProductBarcode, {
      scan: () => void scanToAdd(),
      cancel: () => { newProductBarcode = null; renderApp() },
      save: (input) => void createProduct(input),
    })
  }
  if (openProduct) {
    return renderProduct(openProduct, dashboard!.header, {
      back: () => { openProduct = null; renderApp() },
      savePrice: (form) => void saveProduct(openProduct!.product.id, form),
      adjust: (input) => void adjustStock(openProduct!.product.id, input),
      receive: (input) => void receiveStock(openProduct!.product.id, input),
    })
  }
  return renderStockLanding(stockSearch, stockResults, {
    search: (term) => void searchStock(term),
    scan: () => void scanStock(),
    open: (id) => void openStockProduct(id),
    back: () => { openProduct = null; renderApp() },
    scanToAdd: () => void scanToAdd(),
  })
}

function renderSalesTab(): HTMLElement {
  if (openSale) {
    return renderSaleDetail(openSale, {
      back: () => { openSale = null; renderApp() },
      sharePdf: () => void shareSalePdf(),
      shareImage: () => void shareSaleImage(),
      print: () => window.print(),
    })
  }
  return renderSales(sales, salesQuery, {
    search: (term) => void loadSales(term),
    open: (id) => void openSaleDetail(id),
  })
}

function renderApprovalsTab(): HTMLElement {
  if (!approvals) return skeletonPage()
  return renderApprovals(approvals, {
    decide: (id, decision) => void decideApproval(id, decision),
  })
}

function renderMoreTab(): HTMLElement {
  if (showingDevices) {
    return renderDevices(devices, {
      back: () => { showingDevices = false; renderApp() },
      reload: () => void loadDevices(),
      revoke: (device, password) => void revokeDevice(device, password),
    })
  }
  return renderMore(cashiers, {
    toggleWholesale: (row, allow, password) => void toggleWholesale(row, allow, password),
    reloadCashiers: () => void loadCashiers(),
    signOut: () => void signOutPhone(),
    openDevices: () => { showingDevices = true; devices = null; void loadDevices() },
  })
}

/** Reports tab: the daily/monthly summary, drawn by `admin-screens`, from the host's own report service. */
function renderReportsTab(): HTMLElement {
  if (!report) return skeletonPage()
  return renderReports(report, {
    setPeriod: (nextPeriod, date) => void loadReport(nextPeriod, date),
    sharePdf: () => void shareReportPdf(),
  })
}

async function shareReportPdf(): Promise<void> {
  if (!report) return
  try {
    const period = report.header.period.type
    const date = report.header.period.startDate.slice(0, period === 'MONTH' ? 7 : 10)
    const result = await client().get<{ pdf: string; fileName: string }>(
      `/reports.pdf?period=${period}&date=${encodeURIComponent(date)}`,
    )
    await shareBlob(base64ToBlob(result.pdf, 'application/pdf'), result.fileName, `${report.header.storeName} report`)
  } catch (error) {
    handleScreenError(error)
    renderApp()
  }
}

function skeletonPage(): HTMLElement {
  const page = element('div', 'page')
  page.append(skeleton(3, 'skeleton'), skeleton(4, 'skeleton skeleton--row'))
  return page
}

let salesQuery = ''

async function loadDashboard(): Promise<void> {
  dashboard = await client().get<MobileDashboard>('/dashboard')
}

async function searchStock(term: string): Promise<void> {
  stockSearch = term
  loading = true
  renderApp()
  try {
    const results = await client().get<MobileProductSearch>(`/products?search=${encodeURIComponent(term)}`)
    stockResults = results
    // A scan that lands on exactly one product opens it, so the Admin does not have to tap again.
    if (results.exactMatchProductId) {
      openProduct = await client().get<MobileProductDetail>(`/products/${encodeURIComponent(results.exactMatchProductId)}`)
    }
    errorMessage = ''
  } catch (error) {
    handleScreenError(error)
  } finally {
    loading = false
    renderApp()
  }
}

async function scanStock(): Promise<void> {
  const barcode = await openBarcodeScanner({ title: 'Scan a barcode', hint: 'Point the camera at the barcode on the item.' })
  if (barcode) await searchStock(barcode)
}

/**
 * A scan that finds nothing is the start of adding a product: the host's create route takes the barcode, so
 * the Admin scans the item on the shelf and prices it without walking back to the desktop.
 */
async function scanToAdd(): Promise<void> {
  const barcode = await openBarcodeScanner({ title: 'Scan a new product', hint: 'Point the camera at the barcode on the carton.' })
  if (!barcode) return
  newProductBarcode = barcode
  openProduct = null
  renderApp()
}

async function createProduct(input: {
  name: string; barcode: string; sku: string; unit: string; category: string
  retailPrice: string; wholesalePrice: string; cost: string; reorderLevel: string
  expiryTracking: boolean; prescriptionRequired: boolean
}): Promise<void> {
  loading = true
  renderApp()
  try {
    openProduct = await client().post<MobileProductDetail>('/products', input)
    newProductBarcode = null
    statusMessage = 'The product was added. Receive its stock to put it on the shelf.'
    errorMessage = ''
  } catch (error) {
    handleScreenError(error)
  } finally {
    loading = false
    renderApp()
  }
}

async function loadDevices(): Promise<void> {
  devices = null
  renderApp()
  try {
    devices = await client().get<MobileDeviceList>('/devices')
    errorMessage = ''
  } catch (error) {
    handleScreenError(error)
  } finally {
    renderApp()
  }
}

async function revokeDevice(device: MobileDeviceRow, password: string): Promise<void> {
  try {
    devices = await client().post<MobileDeviceList>(`/devices/${encodeURIComponent(device.id)}/revoke`, { adminPassword: password })
    statusMessage = `“${device.name}” can no longer open this shop.`
    errorMessage = ''
  } catch (error) {
    handleScreenError(error)
  } finally {
    renderApp()
  }
}

async function openStockProduct(productId: string): Promise<void> {
  loading = true
  renderApp()
  try {
    openProduct = await client().get<MobileProductDetail>(`/products/${encodeURIComponent(productId)}`)
    errorMessage = ''
  } catch (error) {
    handleScreenError(error)
  } finally {
    loading = false
    renderApp()
  }
}

async function saveProduct(productId: string, form: Record<string, string>): Promise<void> {
  const product = openProduct!.product
  loading = true
  renderApp()
  try {
    openProduct = await client().post<MobileProductDetail>(`/products/${encodeURIComponent(productId)}`, {
      ...form,
      expectedRowVersion: product.rowVersion,
    })
    statusMessage = 'The product was saved.'
    errorMessage = ''
  } catch (error) {
    handleScreenError(error)
  } finally {
    loading = false
    renderApp()
  }
}

async function adjustStock(productId: string, input: { direction: 'increase' | 'decrease'; quantity: string; reason: string; batchNumber: string; expiryDate: string }): Promise<void> {
  const product = openProduct!.product
  loading = true
  renderApp()
  try {
    openProduct = await client().post<MobileProductDetail>(`/products/${encodeURIComponent(productId)}/stock`, {
      ...input,
      expectedProductVersion: product.rowVersion,
      expectedStockVersion: product.stockVersion,
      // Generated once per submission: a retry after a dropped connection cannot move stock twice.
      idempotencyKey: `mobile-adjust:${productId}:${crypto.randomUUID()}`,
    })
    statusMessage = 'Stock was adjusted.'
    errorMessage = ''
  } catch (error) {
    handleScreenError(error)
  } finally {
    loading = false
    renderApp()
  }
}

async function receiveStock(productId: string, input: { quantity: string; quantityUnit: 'unit' | 'pack'; unitCost: string; supplierName: string; supplierReference: string; note: string; batchNumber: string; expiryDate: string }): Promise<void> {
  const product = openProduct!.product
  loading = true
  renderApp()
  try {
    openProduct = await client().post<MobileProductDetail>(`/products/${encodeURIComponent(productId)}/receive`, {
      ...input,
      expectedProductVersion: product.rowVersion,
      expectedStockVersion: product.stockVersion,
    })
    statusMessage = 'Stock was received.'
    errorMessage = ''
  } catch (error) {
    handleScreenError(error)
  } finally {
    loading = false
    renderApp()
  }
}

async function loadSales(query: string): Promise<void> {
  salesQuery = query
  loading = true
  renderApp()
  try {
    sales = await client().get<MobileSaleList>(`/sales?search=${encodeURIComponent(query)}`)
    errorMessage = ''
  } catch (error) {
    handleScreenError(error)
  } finally {
    loading = false
    renderApp()
  }
}

async function openSaleDetail(saleId: number): Promise<void> {
  loading = true
  renderApp()
  try {
    openSale = await client().get<MobileSaleDetail>(`/sales/${saleId}`)
    errorMessage = ''
  } catch (error) {
    handleScreenError(error)
  } finally {
    loading = false
    renderApp()
  }
}

async function shareBlob(blob: Blob, fileName: string, title: string): Promise<void> {
  const file = new File([blob], fileName, { type: blob.type })
  const nav = navigator as Navigator & { canShare?: (data: { files: File[] }) => boolean }
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title })
      return
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
    }
  }
  // No share sheet (or it refused the file): download instead, which every mobile browser supports.
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.rel = 'noopener'
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

async function shareSalePdf(): Promise<void> {
  if (!openSale) return
  try {
    const receipt = openSale
    const blob = buildSalePdf(receipt)
    await shareBlob(blob, `${fileSafeName(receipt.receiptNumber)}.pdf`, `Receipt ${receipt.receiptNumber}`)
  } catch (error) {
    handleScreenError(error)
    renderApp()
  }
}

async function shareSaleImage(): Promise<void> {
  if (!openSale) return
  try {
    const blob = await buildSaleImage(openSale)
    await shareBlob(blob, `${fileSafeName(openSale.receiptNumber)}.png`, `Receipt ${openSale.receiptNumber}`)
  } catch {
    errorMessage = 'This phone could not make the image. Share as PDF instead.'
    renderApp()
  }
}

async function loadApprovals(): Promise<void> {
  approvals = await client().get<MobileApprovals>('/approvals')
}

async function decideApproval(id: string, decision: 'APPROVE' | 'REJECT'): Promise<void> {
  loading = true
  renderApp()
  try {
    approvals = await client().post<MobileApprovals>(`/approvals/${encodeURIComponent(id)}`, { decision })
    statusMessage = decision === 'APPROVE' ? 'Approved. The cashier sees your decision immediately.' : 'Rejected. The cashier sees your decision immediately.'
    staleNotice = ''
    errorMessage = ''
  } catch (error) {
    handleScreenError(error)
  } finally {
    loading = false
    renderApp()
  }
}

async function loadCashiers(): Promise<void> {
  try {
    cashiers = await client().get<MobileCashierPermissions>('/cashiers')
    errorMessage = ''
  } catch (error) {
    handleScreenError(error)
  }
  renderApp()
}

async function toggleWholesale(row: MobileCashierPermissionRow, allow: boolean, password: string): Promise<void> {
  loading = true
  renderApp()
  try {
    cashiers = await client().post<MobileCashierPermissions>(`/cashiers/${encodeURIComponent(row.id)}/wholesale`, {
      allowWholesale: allow,
      adminPassword: password,
    })
    statusMessage = `${row.fullName || row.username} can ${allow ? 'now' : 'no longer'} make wholesale sales.`
    errorMessage = ''
  } catch (error) {
    handleScreenError(error)
  } finally {
    loading = false
    renderApp()
  }
}

async function signOutPhone(): Promise<void> {
  signOutRequested = true
  try {
    await authenticatedFetch('/api/v1/mobile/session/logout', { method: 'POST' })
  } catch {
    // Local sign-out still clears the browser credential if the host is currently offline.
  }
  const cleared = await clearSession()
  session = null
  // Every cached screen is dropped, so a phone that changes hands shows nothing from the previous session.
  report = null
  dashboard = null
  approvals = null
  cashiers = null
  sales = null
  stockResults = null
  openProduct = null
  openSale = null
  staleNotice = ''
  if (cleared) {
    errorMessage = ''
    statusMessage = 'This phone was signed out.'
  } else {
    sessionStorageAvailable = false
    statusMessage = ''
    errorMessage = 'The host was signed out, but browser storage could not be cleared. Clear this site’s data before sharing the phone.'
  }
  // Signing out keeps the approval: the Admin can sign straight back in without re-pairing.
  const deviceToken = cleared ? await readDeviceToken().catch(() => null) : null
  if (deviceToken) {
    await renderLogin(deviceToken, 'This phone was signed out.')
  } else {
    await renderPairing()
  }
  signOutRequested = false
}


async function authenticatedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const first = await fetchWithToken(url, init)
  if (first.status !== 401 || !session?.refreshToken || url.endsWith('/session/refresh')) {
    if (!first.ok) throw await responseError(first)
    return first
  }
  const refreshResult = await refreshSession()
  if (refreshResult === 'invalid') {
    const cleared = await clearSession()
    if (!cleared) sessionStorageAvailable = false
    session = null
    errorMessage = cleared
      ? 'This phone session ended. Sign in again, or ask the desktop Admin to approve this phone again.'
      : 'This phone session ended, but browser storage could not be cleared. Clear this site’s data before signing in again.'
    // The approval normally survives a signed-out session; only a revoked phone has to pair again.
    const deviceToken = cleared ? await readDeviceToken().catch(() => null) : null
    if (deviceToken) void renderLogin(deviceToken, '')
    else void renderPairing()
    throw new Error(errorMessage)
  }
  if (refreshResult === 'storage-error' || refreshResult === 'storage-error-unrevoked') {
    await clearSession()
    session = null
    sessionStorageAvailable = false
    errorMessage = refreshResult === 'storage-error'
      ? 'Phone browser storage failed. The refreshed session was revoked; enable site storage and reload before pairing again.'
      : 'Phone browser storage failed and the refreshed session could not be revoked. Ask the desktop Admin to revoke this phone before pairing again.'
    void renderPairing()
    throw new Error(errorMessage)
  }
  if (refreshResult === 'unavailable') throw new Error('The phone session could not refresh. Reconnect to the local network and try again.')
  const retried = await fetchWithToken(url, init)
  if (!retried.ok) throw await responseError(retried)
  return retried
}

async function fetchWithToken(url: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('accept', headers.get('accept') ?? 'application/json')
  if (session?.accessToken) headers.set('authorization', `Bearer ${session.accessToken}`)
  return await fetch(url, { ...init, headers, cache: 'no-store', credentials: 'same-origin', redirect: 'error' })
}

async function rotateSession(): Promise<RefreshOutcome> {
  if (!session?.refreshToken) return 'invalid'
  try {
    const response = await fetch('/api/v1/mobile/session/refresh', {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    })
    if (response.status === 401) return 'invalid'
    if (!response.ok) return 'unavailable'
    const next = await response.json() as MobileSessionCredentials
    try {
      await writeSession(next)
    } catch {
      sessionStorageAvailable = false
      session = null
      const revoked = await revokeUnstoredSession(next.accessToken)
      return revoked ? 'storage-error' : 'storage-error-unrevoked'
    }
    session = next
    return 'ok'
  } catch {
    return 'unavailable'
  }
}

const refreshSession = singleFlight(rotateSession)

async function revokeUnstoredSession(accessToken: string): Promise<boolean> {
  try {
    const response = await fetch('/api/v1/mobile/session/logout', {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
      headers: { authorization: `Bearer ${accessToken}` },
    })
    return response.ok
  } catch {
    // The host may already be unreachable; the Admin can revoke this device from desktop settings.
    return false
  }
}

async function responseError(response: Response): Promise<Error> {
  const body = await parseJson<{ message?: string }>(response).catch((): { message?: string } => ({}))
  return new Error(body.message || `The host returned ${response.status}.`)
}

async function parseJson<T>(response: Response): Promise<T> {
  return await response.json() as T
}

function tabButton(label: string, active: boolean, action: () => void): HTMLButtonElement {
  const button = element('button', active ? 'tab is-active' : 'tab', label)
  button.type = 'button'
  button.setAttribute('aria-current', active ? 'page' : 'false')
  button.addEventListener('click', action)
  return button
}


function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}




function localDate(): string {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}



function suggestedDeviceName(): string {
  const platform = suggestedPlatform()
  return `${platform} phone`.slice(0, 80)
}

function suggestedPlatform(): string {
  const agent = navigator.userAgent
  if (/iPhone|iPad|iPod/iu.test(agent)) return 'iPhone Safari'
  if (/Android/iu.test(agent)) return 'Android browser'
  return 'Mobile browser'
}

function errorText(value: unknown): string {
  if (value instanceof TypeError && !navigator.onLine) return 'The phone is offline. Connect to the same local network as the desktop host and try again.'
  return value instanceof Error ? value.message : 'The request could not be completed.'
}
