import type {
  AppPage, AssignableRole, CreateUserInput, LoginInput, NavigationItem, PublicUser, UpdateUserInput, UserPermissions,
} from '../shared/auth/types'
import type {
  BackupResult,
  BackupStatus,
  BackupSummary,
  FirstRunInput,
  OperationalSettings,
  RestoreBackupInput,
  RestoreResult,
  ShopProfile,
  ShopSettings,
} from '../shared/shop/types'
import type { CurrencyDefinition } from '../currency/catalog'
import type { Edition } from '../editions'
import { AuthService, toPublicUser } from '../services/auth-service'
import { ShopService } from '../services/shop-service'
import { SetupService } from '../services/setup-service'
import type {
  RoleSeatCount, SeatCountChange, TeamService, TeamSettingsInput, TeamSnapshot,
} from '../services/team-service'
import type { AppRole } from '../../installer/src/install-config'
import { UserService } from '../services/user-service'
import type { UserRepository } from '../services/contracts/user-repository'
import type { ShopRepository } from '../services/contracts/shop-repository'
import type { LicenseCheckInResult, LicenseFeatures, LicenseSummary } from '../shared/license/types'
import type { LicenseManager } from '../license/license-manager'
import { ProductInventoryService } from '../services/product-inventory-service'
import { PointOfSaleService, SaleApprovalRequired } from '../services/point-of-sale-service'
import { ReturnService } from '../services/return-service'
import type { OrderService } from '../services/order-service'
import type { PrintContext, PrintGateService, PrintLogEntry } from '../services/print-gate-service'
import type {
  CreateOrderInput, FinalizeOrderInput, FinalizeOrderResult, OrderView,
} from '../shared/orders/types'
import type {
  RequestReturnInput,
  ReturnApprovalDecision,
  ReturnDocumentLayout,
  ReturnRecord,
} from '../shared/returns/types'
import type {
  AccountingReport,
  CashDrawerEventInput,
  CashierShiftReportRow,
  CloseCashierShiftInput,
  CloseDayInput,
  DayCloseRecord,
  OpenCashierShiftInput,
  ReportActor,
  ReportExportInput,
  ReportPeriodInput,
} from '../shared/reports/types'
import { AccountingReportService } from '../services/accounting-report-service'
import type { MobileAccessService } from '../services/mobile-access-service'
import type { ApprovalQueueService } from '../services/approval-queue-service'
import type { BackupService } from '../services/backup-service'
import type { MobileAccessStatus, MobilePairingInfo, PairedMobileDevice } from '../shared/mobile/types'
import type {
  CompletePosSaleInput,
  HeldPosCartData,
  PosCustomerDraft,
  PosQuoteInput,
  PosReceiptRecord,
  ReceiptLayout,
} from '../shared/pos/types'
import type {
  ConsumeStockInput,
  InventoryActor,
  InventoryOverview,
  ProductDraft,
  ProductImportReport,
  ProductRecord,
  PurchaseOrderDraft,
  PurchaseOrderRecord,
  PurchaseOrderReceiptInput,
  ReceiveStockInput,
  SellableBatch,
  StockAdjustmentInput,
  StockMutationResult,
  StocktakeInput,
  StocktakeVarianceRecord,
  WeighedPriceResult,
} from '../shared/inventory/types'
import type { DemoDataService } from '../services/demo-data-service'
import type { DemoDatasetState, DemoLoadResult } from '../shared/demo/types'
import { fallbackLicenseSummary } from './license-summary-fallback'

const PAGE_LABELS: readonly NavigationItem[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'pos', label: 'POS' },
  { id: 'products', label: 'Products' },
  { id: 'stock', label: 'Stock / Purchases' },
  { id: 'returns', label: 'Returns' },
  { id: 'customers', label: 'Customers' },
  { id: 'reports', label: 'Reports' },
  { id: 'users', label: 'Users' },
  { id: 'mobile', label: 'Mobile Access' },
  { id: 'settings', label: 'Settings' },
  { id: 'departments', label: 'Departments' },
  { id: 'promotions', label: 'Promotions' },
  { id: 'loyalty', label: 'Loyalty' },
  { id: 'shifts', label: 'Shifts' },
  { id: 'batches', label: 'Batches / Expiry' },
  { id: 'approvals', label: 'Approvals' },
]

interface DesktopSession {
  userId: string
  lastActivityAt: number
  /**
   * The approved client device this session belongs to, when it came over the network rather than from the Server's own
   * window. Recorded at sign-in from the device row the Admin approved — never from a name the client sent, because a
   * client that could name itself could name itself after somebody else's PC.
   */
  clientDeviceId?: string | null
  /** The machine's name as the Admin approved it, for the print log and the audit trail. */
  pcName?: string | null
}

export class DesktopHostController {
  private readonly sessions = new Map<number, DesktopSession>()

  constructor(
    private readonly shop: ShopRepository,
    private readonly users: UserRepository,
    private readonly setup: SetupService,
    private readonly auth: AuthService,
    private readonly userService: UserService,
    private readonly shopService: ShopService,
    private readonly now: () => number = Date.now,
    private readonly appVersion = '0.1.0',
    private readonly licensing?: LicenseManager,
    private readonly inventory?: ProductInventoryService,
    private readonly pointOfSale?: PointOfSaleService,
    private readonly returns?: ReturnService,
    private readonly reports?: AccountingReportService,
    private readonly mobileAccess?: MobileAccessService,
    private readonly backup?: BackupService,
    private readonly approvals?: ApprovalQueueService,
    private readonly demoData?: DemoDataService,
    /**
     * Team size and seats. Optional so every existing fixture keeps constructing the host unchanged; a host without it
     * reports the seat channels as unavailable rather than silently pretending there are no seats.
     */
    private readonly team?: TeamService,
    /** Which application this is. A client refuses the Admin at login unless the shop allows it. */
    private readonly appRole: AppRole = 'server',
    /**
     * The order-to-receipt workflow, and the single route to a printer.
     *
     * Both optional for the same reason as `team`: every existing fixture keeps constructing the host unchanged, and a
     * host without them reports the channels as unavailable rather than pretending there is nothing to print.
     * Appended after `appRole` rather than inserted beside the other services, because inserting would shift the
     * position of every argument that follows and silently re-bind callers that pass them positionally.
     */
    private readonly orders?: OrderService,
    private readonly printGate?: PrintGateService,
  ) {}

  async initialize(): Promise<void> {
    this.licensing?.initialize()
    const context = await this.setup.getSetupContext()
    this.editionCache = this.isLicenseUsable() ? context.edition : null
  }

  async getBootstrap(senderId: number) {
    const settings = this.shop.readSettings()
    const setupContext = await this.setup.getSetupContext()
    const license = this.getLicenseSummary(setupContext)
    this.editionCache = license.canUse ? setupContext.edition : null
    const hasUsers = this.users.countUsers() > 0
    const currentUser = license.canUse ? this.resolveCurrentUser(senderId, false) : null
    const visibleSettings = !license.canUse
      ? { ...settings, profile: { name: '', address: '', phone: '', email: '', licenceNumber: '', taxNumber: '', storeLogo: null, receiptFooter: '', thankYouNote: '' } }
      : hasUsers && !currentUser
        ? { ...settings, profile: { name: settings.profile.name, address: '', phone: '' } }
        : settings
    return {
      appInfo: {
        appName: setupContext.productName,
        productName: setupContext.productName,
        appVersion: this.appVersion,
        edition: setupContext.edition,
        runtime: 'desktop' as const,
        appRole: this.appRole,
      },
      settings: visibleSettings,
      setupContext,
      license,
      hasUsers,
      currentUser,
    }
  }

  getLicenseStatus(): LicenseSummary {
    const summary = this.licensing?.getSnapshot() ?? fallbackLicenseSummary(false)
    // A licence that was suspended, that expired, or whose internet entitlement was withdrawn must drop an open
    // relay tunnel now rather than at the phone's next request.
    this.mobileAccess?.applyLicenseChange()
    return summary
  }

  async importVendorPolicyFile(contents: string): Promise<void> {
    await this.requireLicenseManager().importVendorPolicyFile(contents)
  }

  async activateOnline(input: Parameters<LicenseManager['activateOnline']>[0]): Promise<LicenseSummary> {
    return this.requireLicenseManager().activateOnline(input)
  }

  async importLicenseFile(contents: string): Promise<LicenseSummary> {
    return this.requireLicenseManager().importLicenseFile(contents)
  }

  async activateOnsite(input: Parameters<LicenseManager['activateOnsite']>[0]): Promise<LicenseSummary> {
    return this.requireLicenseManager().activateOnsite(input)
  }

  async checkInLicense(): Promise<LicenseCheckInResult> {
    const result = await this.requireLicenseManager().checkInNow()
    // A check-in is where a renewal arrives, so it is also where the relay must notice it can start (or stop).
    this.mobileAccess?.applyLicenseChange()
    return result
  }

  async completeFirstRun(input: FirstRunInput) {
    this.assertLicenseUsable()
    const result = await this.setup.completeFirstRun(input)
    this.editionCache = (await this.setup.getSetupContext()).edition
    return result.settings
  }

  async login(senderId: number, input: LoginInput): Promise<PublicUser> {
    this.assertLicenseUsable()
    const context = await this.setup.getSetupContext()
    if (!context.licenseActivated || !context.edition) throw new Error('Activate a valid Infoflex licence before signing in.')
    this.editionCache = context.edition
    if (this.users.countUsers() === 0) throw new Error('Complete first-run setup before signing in.')
    const user = await this.auth.login(input)
    // "One active login per account", on by default. Applying it *after* a successful sign-in, not before, means a
    // failed attempt never evicts somebody else's working session — otherwise anybody who typed a colleague's username
    // wrongly would log them out.
    if (this.singleLoginPerAccount()) this.invalidateSessions(user.id, senderId)
    this.sessions.set(senderId, { userId: user.id, lastActivityAt: this.now() })
    return user
  }

  logout(senderId: number): void {
    const user = this.resolveCurrentUser(senderId, false)
    this.sessions.delete(senderId)
    if (user) this.auth.auditLogout(user)
  }

  getCurrentUser(senderId: number): PublicUser | null {
    if (!this.isLicenseUsable()) return null
    return this.resolveCurrentUser(senderId, false)
  }

  touchSession(senderId: number): boolean {
    if (!this.isLicenseUsable()) return false
    const user = this.resolveCurrentUser(senderId, false)
    if (!user) return false
    const session = this.sessions.get(senderId)
    if (!session) return false
    session.lastActivityAt = this.now()
    return true
  }

  getShopSettings(senderId: number): ShopSettings {
    this.assertLicenseUsable()
    if (this.users.countUsers() > 0) this.requireSignedIn(senderId)
    return this.shop.readSettings()
  }

  getNavigation(senderId: number): NavigationItem[] {
    this.assertLicenseUsable()
    const user = this.requireSignedIn(senderId)
    const edition = this.currentEdition()
    const features = this.licensing?.getSnapshot().features
    return PAGE_LABELS.filter(({ id }) => {
      if (id === 'mobile' && features && !features.mobileLan && !features.mobileInternet) return false
      return this.userService.canAccessPage(user, id, edition)
    })
  }

  openPage(senderId: number, page: AppPage): { page: AppPage } {
    this.assertLicenseUsable()
    const user = this.requireSignedIn(senderId)
    if (!PAGE_LABELS.some((item) => item.id === page)) throw new Error('This page is not available.')
    if (page === 'mobile' && this.licensing) {
      const features = this.licensing.getSnapshot().features
      if (!features.mobileLan && !features.mobileInternet) throw new Error('This license does not include mobile access.')
    }
    this.userService.requirePageAccess(user, page, this.currentEdition())
    return { page }
  }

  listUsers(senderId: number): PublicUser[] {
    return this.userService.listUsers(this.requireSignedIn(senderId))
  }

  // ─── Team size and seats ─────────────────────────────────────────────────────────────────────────────────────
  // Every method here is Admin-only, matching the policy rows. The check is `requireAdmin`, so a direct call from a
  // client or an IPC frame that skipped the policy table is still refused.

  getTeamSnapshot(senderId: number): TeamSnapshot {
    this.requireAdmin(senderId)
    return this.requireTeam().getSnapshot()
  }

  setSeatCount(senderId: number, change: SeatCountChange): RoleSeatCount[] {
    const admin = this.requireAdmin(senderId)
    return this.requireTeam().setSeatCount(change, admin.username)
  }

  renameSeat(senderId: number, userId: string, fullName: string): void {
    const admin = this.requireAdmin(senderId)
    this.requireTeam().renameSeat(userId, fullName, admin.username)
  }

  async setSeatPassword(senderId: number, userId: string, password: string, confirmPassword: string): Promise<void> {
    const admin = this.requireAdmin(senderId)
    await this.requireTeam().setSeatPassword(userId, password, confirmPassword, admin.username)
  }

  setSeatActive(senderId: number, userId: string, isActive: boolean): void {
    const admin = this.requireAdmin(senderId)
    this.requireTeam().setSeatActive(userId, isActive, admin.username)
    // Two guards, and it matters which does what. `resolveCurrentUser` already refuses an inactive user on every call,
    // so a deactivated person cannot keep working whether or not this line runs — that is the guard that protects the
    // till. This line is the other half: it *deletes* the session rather than leaving it in the map being refused. A
    // session left in the map resurrects the moment the seat is switched back on, signing somebody in who never
    // re-authenticated. Verified by disabling this line: the deactivation tests still pass and the reactivation test
    // fails, which is precisely the distinction.
    if (!isActive) this.invalidateSessions(userId)
  }

  setSeatPermissions(senderId: number, userId: string, permissions: UserPermissions): void {
    const admin = this.requireAdmin(senderId)
    this.requireTeam().setSeatPermissions(userId, permissions, admin.username)
  }

  updateTeamSettings(senderId: number, input: TeamSettingsInput): void {
    const admin = this.requireAdmin(senderId)
    this.requireTeam().updateSettings(input, admin.username)
  }

  getRoleSummary(senderId: number): Array<{ role: AssignableRole; summary: string }> {
    this.requireAdmin(senderId)
    return this.requireTeam().roleSummary()
  }

  /** The application this process is, so the login screen can show the right rule and the right refusal. */
  getHostAppRole(): AppRole {
    return this.appRole
  }

  private requireTeam(): TeamService {
    if (!this.team) throw new Error('Team management is not available in this build.')
    return this.team
  }

  async createUser(senderId: number, input: CreateUserInput): Promise<PublicUser> {
    const actor = this.requireSignedIn(senderId)
    return this.userService.createUser(actor, input, this.requireEdition())
  }

  updateUser(senderId: number, id: string, input: UpdateUserInput): PublicUser {
    const actor = this.requireSignedIn(senderId)
    const updated = this.userService.updateUser(actor, id, input, this.requireEdition())
    if (updated.role !== 'ADMIN' || !updated.isActive) this.mobileAccess?.revokeSessionsForUser(id, actor.username)
    return updated
  }

  deactivateUser(senderId: number, id: string): void {
    const actor = this.requireSignedIn(senderId)
    this.userService.deactivateUser(actor, id)
    this.mobileAccess?.revokeSessionsForUser(id, actor.username)
  }

  async resetPassword(senderId: number, id: string, password: string, confirmPassword: string): Promise<void> {
    const actor = this.requireSignedIn(senderId)
    await this.userService.resetPassword(actor, id, password, confirmPassword)
    this.invalidateSessions(id)
    this.mobileAccess?.revokeSessionsForUser(id, actor.username)
  }

  unlockUser(senderId: number, id: string): PublicUser {
    const unlocked = this.userService.unlockUser(this.requireSignedIn(senderId), id)
    this.auth.clearLoginFailures(unlocked.username)
    return unlocked
  }

  getInventoryOverview(senderId: number, search = ''): InventoryOverview {
    // Reading stock, not editing products. The brief gives every shop role "Stock (view)" — an ACCOUNT and a USER may
    // see quantities, and a SUPERVISOR may see all stock including batches. Gating this on the products page meant
    // "may edit products", which would have withheld stock from the two roles that exist to look at it.
    const { actor, edition } = this.requireInventoryAccess(senderId, 'stock')
    return this.requireInventoryService().getOverview(actor, edition, search)
  }

  saveProduct(senderId: number, draft: ProductDraft): ProductRecord {
    const actor = this.requireAdmin(senderId)
    const edition = this.requireEdition()
    return draft?.id
      ? this.requireInventoryService().updateProduct(draft, toInventoryActor(actor), edition)
      : this.requireInventoryService().createProduct(draft, toInventoryActor(actor), edition)
  }

  importProductsCsv(senderId: number, contents: string): ProductImportReport {
    const { actor, edition } = this.requireInventoryAccess(senderId, 'products')
    if (actor.role !== 'ADMIN') throw new Error('Only the Admin can import products.')
    return this.requireInventoryService().importProductsCsv(contents, actor, edition)
  }

  importProductsExcel(senderId: number, contents: Uint8Array): Promise<ProductImportReport> {
    const { actor, edition } = this.requireInventoryAccess(senderId, 'products')
    if (actor.role !== 'ADMIN') throw new Error('Only the Admin can import products.')
    return this.requireInventoryService().importProductsExcel(contents, actor, edition)
  }

  exportProductsCsv(senderId: number): string {
    // Deliberately on 'products' (edit rights) rather than 'stock' (view): the export includes supplier cost columns,
    // which a USER and an ACCOUNT must never see. This is the one inventory read that is not a plain view.
    const { actor, edition } = this.requireInventoryAccess(senderId, 'products')
    return this.requireInventoryService().exportProductsCsv(actor, edition)
  }

  exportProductsExcel(senderId: number): Promise<string> {
    const { actor, edition } = this.requireInventoryAccess(senderId, 'products')
    return this.requireInventoryService().exportProductsExcel(actor, edition)
  }

  receiveStock(senderId: number, input: ReceiveStockInput): StockMutationResult {
    const { actor, edition } = this.requireInventoryAccess(senderId, 'stock')
    if (actor.role !== 'ADMIN') throw new Error('Only the Admin can receive stock because receiving records include supplier costs.')
    return this.requireInventoryService().receiveStock(input, actor, edition)
  }

  adjustStock(senderId: number, input: StockAdjustmentInput): StockMutationResult {
    const { actor, edition } = this.requireInventoryAccess(senderId, 'stock')
    if (actor.role !== 'ADMIN') throw new Error('Only the Admin can adjust stock.')
    return this.requireInventoryService().adjustStock(input, actor, edition)
  }

  recordStocktake(senderId: number, input: StocktakeInput): StockMutationResult {
    const { actor, edition } = this.requireInventoryAccess(senderId, 'stock')
    if (actor.role !== 'ADMIN') throw new Error('Only the Admin can complete a stocktake.')
    return this.requireInventoryService().recordStocktake(input, actor, edition)
  }

  getStocktakeVarianceReport(senderId: number): StocktakeVarianceRecord[] {
    const { actor, edition } = this.requireInventoryAccess(senderId, 'stock')
    return this.requireInventoryService().getStocktakeVarianceReport(actor, edition)
  }

  listPurchaseOrders(senderId: number): PurchaseOrderRecord[] {
    const { actor, edition } = this.requireInventoryAccess(senderId, 'stock')
    if (actor.role !== 'ADMIN') throw new Error('Only the Admin can view purchase orders and supplier costs.')
    return this.requireInventoryService().listPurchaseOrders(actor, edition)
  }

  createPurchaseOrder(senderId: number, draft: PurchaseOrderDraft): PurchaseOrderRecord {
    const { actor, edition } = this.requireInventoryAccess(senderId, 'stock')
    if (actor.role !== 'ADMIN') throw new Error('Only the Admin can create purchase orders.')
    return this.requireInventoryService().createPurchaseOrder(draft, actor, edition)
  }

  receivePurchaseOrder(senderId: number, input: PurchaseOrderReceiptInput): PurchaseOrderRecord {
    const { actor, edition } = this.requireInventoryAccess(senderId, 'stock')
    if (actor.role !== 'ADMIN') throw new Error('Only the Admin can receive a purchase order.')
    return this.requireInventoryService().receivePurchaseOrder(input, actor, edition)
  }

  getSellableBatches(senderId: number, productId: string): SellableBatch[] {
    const { edition } = this.requireInventoryAccess(senderId, 'pos')
    return this.requireInventoryService().getSellableBatches(productId, edition)
  }

  consumeStockFEFO(senderId: number, input: ConsumeStockInput) {
    const { actor, edition } = this.requireInventoryAccess(senderId, 'pos')
    return this.requireInventoryService().consumeStockFEFO(input, actor, edition)
  }

  getWeighedPrice(senderId: number, productId: string, weight: string): WeighedPriceResult {
    const { edition } = this.requireInventoryAccess(senderId, 'pos')
    return this.requireInventoryService().getWeighedPrice(productId, weight, edition)
  }

  listPosCustomers(senderId: number) {
    const { actor } = this.requirePosAccess(senderId)
    return this.requirePointOfSaleService().listCustomers(actor)
  }

  createPosCustomer(senderId: number, input: PosCustomerDraft) {
    const { actor, edition } = this.requirePosAccess(senderId)
    return this.requirePointOfSaleService().createCustomer(input, actor, edition)
  }

  quotePosSale(senderId: number, input: PosQuoteInput) {
    const { actor, edition } = this.requirePosAccess(senderId)
    return this.requirePointOfSaleService().quoteSale(input, actor, edition)
  }

  completePosSale(senderId: number, input: CompletePosSaleInput) {
    const { actor, edition } = this.requirePosAccess(senderId)
    return this.withSaleApproval(() => (
      this.requirePointOfSaleService().completeSale(input, actor, edition)
    ), actor, input.idempotencyKey)
  }

  /**
   * Runs a sale, and if it crosses a limit an Admin can lift, files the request instead of failing quietly.
   *
   * The point of separating this from the sale itself is what the cashier sees next. A refusal with no way forward
   * ends the interaction — the discount comes off and the customer is overcharged, or the sale is abandoned. A request
   * gives the till something to wait for: the Admin accepts it on the Server or from the phone, the cashier presses
   * Complete again, and the same key now goes through because an approval exists for exactly this excess.
   *
   * The request is raised after the sale's transaction has rolled back, never inside it. Raising it inside would mean
   * the throw that abandons the sale also erased the request, and the cashier would be told to wait for an approval
   * nobody had ever been asked for.
   */
  private withSaleApproval<T>(run: () => T, actor: PublicUser, idempotencyKey: string): T {
    let signal: SaleApprovalRequired
    try {
      return run()
    } catch (error) {
      if (!(error instanceof SaleApprovalRequired)) throw error
      signal = error
    }
    const settings = this.shop.readSettings()
    const request = this.requireApprovalsService().raise({
      kind: signal.kind,
      actor,
      // The key and the excess are what authorize the retry: without both, one approval would cover every later
      // attempt on this key, or an Admin who authorized a small overage would be recorded as authorizing a large one.
      payload: {
        ...signal.detail,
        idempotencyKey,
        excessMinor: signal.excessMinor.toString(),
        explanation: signal.explanation,
      },
      amountMinor: signal.excessMinor,
      currencyCode: settings.currency.code,
    })
    throw new Error(
      `${signal.explanation} An approval request has been sent to the Admin (${request.id.slice(0, 8)}). `
      + 'Once it is accepted, complete this sale again — nothing has been charged and no stock has moved.',
    )
  }

  listRecentPosSales(senderId: number) {
    const { actor } = this.requirePosAccess(senderId)
    return this.requirePointOfSaleService().listRecentSales(actor)
  }

  getPosReceipt(senderId: number, saleId: string | number): PosReceiptRecord {
    const { actor } = this.requirePosAccess(senderId)
    return this.requirePointOfSaleService().recordReceiptViewed(saleId, actor)
  }

  /**
   * Print a receipt — through the gate, which is the only route to a printer.
   *
   * This used to call the POS service's own printer directly. Routing it through `PrintGateService` instead is what
   * makes "the only print path is a Server print endpoint that checks the role and writes a print log entry" true
   * rather than aspirational: the gate checks the role, numbers the copy, demands a reason for a reprint, and only
   * then asks the POS service for the document.
   */
  recordPosReceiptPrint(senderId: number, saleId: string | number, layout: ReceiptLayout, reason?: string): PosReceiptRecord {
    const { actor } = this.requirePosAccess(senderId)
    const ticket = this.requirePrintGate().print(
      { kind: 'SALE', documentId: saleId, layout, reason },
      actor,
      this.printContextFor(senderId),
    )
    // Returned in the shape the till already renders — the receipt with `duplicate` and `printCount` beside it — rather
    // than as the gate's ticket. The ticket carries the log entry; the screen wants the document. Changing the return
    // type here would have meant changing every caller to reach into `ticket.document` for no benefit to anybody.
    return { ...(ticket.document as PosReceiptRecord), duplicate: ticket.duplicate, printCount: ticket.copyNumber }
  }

  /** The Admin's print log: every copy of every document, with the machine and the reason. */
  listPrintLog(senderId: number, limit = 200): PrintLogEntry[] {
    const { actor } = this.requirePosAccess(senderId)
    return this.requirePrintGate().listPrintLog(actor, limit)
  }

  /**
   * Which machine asked for this print.
   *
   * The gate runs on the Server and serves every till, so it cannot learn the caller's PC from its own construction —
   * a name captured there would be the Server's on every entry, and the log would say one machine printed every
   * receipt in the shop. Where the session belongs to an approved client device, that device's name is used; otherwise
   * the request came from the Server's own window and the gate's own workstation is correct.
   */
  private printContextFor(senderId: number): PrintContext {
    const session = this.sessions.get(senderId)
    return { pcName: session?.pcName ?? null, clientDeviceId: session?.clientDeviceId ?? null }
  }

  private requirePrintGate(): PrintGateService {
    if (!this.printGate) throw new Error('Printing is not available on this installation.')
    return this.printGate
  }

  private requireOrders(): OrderService {
    if (!this.orders) throw new Error('Orders are not available on this installation.')
    return this.orders
  }

  // ── the order-to-receipt workflow ────────────────────────────────────────────────────────────────────────

  createOrder(senderId: number, input: CreateOrderInput): OrderView {
    const { actor, edition } = this.requirePosAccess(senderId)
    const key = input.idempotencyKey?.trim() || null
    const create = (): OrderView => this.requireOrders().createOrder(
      input,
      actor,
      edition,
      // The order records which machine picked the goods, and that comes from the session the Server authenticated —
      // the same source the print log uses — not from the renderer's own say-so.
      this.printContextFor(senderId),
      // With a key, an Admin's earlier decision about this exact basket can be found again, so a picker whose discount
      // is over the cap gets a request rather than a dead end. Without one there is nothing to correlate a retry to.
      key
        ? (kind, excess) => this.requirePointOfSaleService().hasApprovedOverride(kind, excess, key, actor)
        : undefined,
    )
    // No key means no request is filed, and that is deliberate rather than an oversight: an approval nobody can match
    // to a later attempt is worse than a refusal, because the cashier is told to wait for a decision that can never
    // unlock anything. The picker is simply told the ceiling, as the till is.
    return key ? this.withSaleApproval(create, actor, key) : create()
  }

  listOrderQueue(senderId: number): OrderView[] {
    const { actor } = this.requirePosAccess(senderId)
    return this.requireOrders().listQueue(actor)
  }

  listMyOrders(senderId: number): OrderView[] {
    const { actor } = this.requirePosAccess(senderId)
    return this.requireOrders().listMyOrders(actor)
  }

  getOrder(senderId: number, orderId: string): OrderView {
    const { actor } = this.requirePosAccess(senderId)
    return this.requireOrders().getOrder(orderId, actor)
  }

  adjustOrderLine(senderId: number, orderId: string, itemId: string, quantity: string): OrderView {
    const { actor } = this.requirePosAccess(senderId)
    return this.requireOrders().adjustLineQuantity(orderId, itemId, quantity, actor)
  }

  cancelOrder(senderId: number, orderId: string, reason: string): OrderView {
    const { actor } = this.requirePosAccess(senderId)
    return this.requireOrders().cancelOrder(orderId, reason, actor)
  }

  finalizeOrder(senderId: number, orderId: string, input: FinalizeOrderInput): FinalizeOrderResult {
    const { actor, edition } = this.requirePosAccess(senderId)
    // Finalizing an order is completing a sale, so it crosses the same two limits and files the same request. Routing
    // it anywhere else would give an Account two ways to sell — one that asks the Admin and one that does not — and
    // the one that does not ask would be the one used for every order a picker brought to the till.
    //
    // The order's own transaction rolls back with the sale, so the stock the order was holding stays held: an order
    // awaiting an Admin's decision must not quietly lose its reservation and let the goods be sold to somebody else.
    return this.withSaleApproval(() => (
      this.requireOrders().finalizeOrder(orderId, input, actor, edition)
    ), actor, input.idempotencyKey)
  }

  holdPosCart(senderId: number, data: HeldPosCartData) {
    const { actor } = this.requirePosAccess(senderId)
    return this.requirePointOfSaleService().holdCart(data, actor)
  }

  listHeldPosCarts(senderId: number) {
    const { actor } = this.requirePosAccess(senderId)
    return this.requirePointOfSaleService().listHeldCarts(actor)
  }

  recallHeldPosCart(senderId: number, id: string) {
    const { actor } = this.requirePosAccess(senderId)
    return this.requirePointOfSaleService().recallHeldCart(id, actor)
  }

  discardHeldPosCart(senderId: number, id: string): void {
    const { actor } = this.requirePosAccess(senderId)
    this.requirePointOfSaleService().discardHeldCart(id, actor)
  }

  findSaleForReturn(senderId: number, receiptNumber: string) {
    const { actor, edition } = this.requireReturnAccess(senderId)
    return this.requireReturnService().findSaleForReturn(receiptNumber, actor, edition)
  }

  createReturn(senderId: number, input: RequestReturnInput) {
    const { actor, edition } = this.requireReturnAccess(senderId)
    return this.requireReturnService().createReturn(input, actor, edition)
  }

  listReturns(senderId: number) {
    const { actor } = this.requireReturnAccess(senderId)
    return this.requireReturnService().listReturns(actor)
  }

  getReturnDocument(senderId: number, returnId: string | number) {
    const { actor } = this.requireReturnAccess(senderId)
    return this.requireReturnService().getReturnDocument(returnId, actor)
  }

  resolveReturnApproval(senderId: number, returnId: string | number, decision: ReturnApprovalDecision) {
    const { actor } = this.requireReturnAccess(senderId)
    return this.requireReturnService().resolveApproval(returnId, decision, actor, 'DESKTOP')
  }

  /**
   * Print a credit note, through the same gate and under the same rules as a receipt.
   *
   * Routed through `PrintGateService` rather than the return service's own printer so that "the only print path is a
   * Server print endpoint" is literally true: one place checks the role, numbers the copy and demands a reason for a
   * reprint, whichever document is being printed.
   */
  recordReturnPrint(senderId: number, returnId: string | number, layout: ReturnDocumentLayout, reason?: string): ReturnRecord {
    const { actor } = this.requireReturnAccess(senderId)
    const ticket = this.requirePrintGate().print(
      { kind: 'RETURN', documentId: returnId, layout, reason },
      actor,
      this.printContextFor(senderId),
    )
    // Same reasoning as the receipt above: the credit-note screen renders the document, not the log entry.
    return { ...(ticket.document as ReturnRecord), duplicate: ticket.duplicate, printCount: ticket.copyNumber }
  }

  getAccountingReport(senderId: number, input: ReportPeriodInput): AccountingReport {
    const { actor, edition } = this.requireReportsAccess(senderId)
    return this.requireAccountingReportService().getDashboard(input, toReportActor(actor), edition)
  }

  exportReportCsv(senderId: number, input: ReportExportInput): string {
    const { actor, edition } = this.requireReportsAccess(senderId)
    return this.requireAccountingReportService().exportCsv(input, toReportActor(actor), edition)
  }

  exportReportExcel(senderId: number, input: ReportExportInput): Promise<string> {
    const { actor, edition } = this.requireReportsAccess(senderId)
    return this.requireAccountingReportService().exportExcel(input, toReportActor(actor), edition)
  }

  async exportReportPdf(senderId: number, input: ReportExportInput): Promise<string> {
    const { actor, edition } = this.requireReportsAccess(senderId)
    const bytes = await this.requireAccountingReportService().exportPdf(input, toReportActor(actor), edition)
    return Buffer.from(bytes).toString('base64')
  }

  closeReportingDay(senderId: number, input: CloseDayInput): DayCloseRecord {
    const { actor, edition } = this.requireReportsAccess(senderId)
    return this.requireAccountingReportService().closeDay(input, toReportActor(actor), edition)
  }

  openCashierShift(senderId: number, input: OpenCashierShiftInput): CashierShiftReportRow {
    const { actor, edition } = this.requireReportsAccess(senderId)
    return this.requireAccountingReportService().openCashierShift(input, toReportActor(actor), edition)
  }

  closeCashierShift(senderId: number, input: CloseCashierShiftInput): CashierShiftReportRow {
    const { actor, edition } = this.requireReportsAccess(senderId)
    return this.requireAccountingReportService().closeCashierShift(input, toReportActor(actor), edition)
  }

  recordCashDrawerEvent(senderId: number, input: CashDrawerEventInput): void {
    const { actor, edition } = this.requireReportsAccess(senderId)
    this.requireAccountingReportService().recordCashDrawerEvent(input, toReportActor(actor), edition)
  }

  updateStoreDetails(senderId: number, profile: ShopProfile): ShopSettings {
    this.requireAdmin(senderId)
    return this.shopService.updateStoreDetails(profile, this.requireSignedIn(senderId)!.username)
  }

  updateDisplaySettings(senderId: number, display: ShopSettings['display']): ShopSettings {
    this.requireAdmin(senderId)
    return this.shopService.updateDisplaySettings(display, this.requireSignedIn(senderId)!.username)
  }

  changeCurrency(senderId: number, currency: CurrencyDefinition, confirmed: boolean): ShopSettings {
    this.requireAdmin(senderId)
    return this.shopService.changeCurrency(currency, confirmed, this.requireSignedIn(senderId)!.username)
  }

  updateIdleTimeout(senderId: number, minutes: number): ShopSettings {
    this.requireAdmin(senderId)
    const settings = this.shopService.updateIdleTimeout(minutes, this.requireSignedIn(senderId)!.username)
    return settings
  }

  updateReturnWindowDays(senderId: number, days: number): ShopSettings {
    this.requireAdmin(senderId)
    return this.shopService.updateReturnWindowDays(days, this.requireSignedIn(senderId)!.username)
  }

  updateOperationalSettings(senderId: number, input: OperationalSettings): ShopSettings {
    this.requireAdmin(senderId)
    return this.shopService.updateOperationalSettings(input, this.requireSignedIn(senderId)!.username)
  }

  getBackupStatus(senderId: number): BackupStatus {
    this.requireAdmin(senderId)
    return this.requireBackupService().status()
  }

  createManualBackup(senderId: number, folder: string): BackupResult {
    const admin = this.requireAdmin(senderId)
    const backup = this.requireBackupService().createManualBackup(folder, admin.username)
    return { backup, status: this.requireBackupService().status() }
  }

  listBackupFiles(senderId: number, folder: string): BackupSummary[] {
    this.requireAdmin(senderId)
    return this.requireBackupService().listFolder(folder)
  }

  /** Restoring rewrites every shop table, so it stays Admin-only and re-checks the licence afterwards. */
  restoreBackup(senderId: number, input: RestoreBackupInput): RestoreResult {
    const admin = this.requireAdmin(senderId)
    const result = this.requireBackupService().restore({
      folder: input.folder,
      fileName: input.fileName,
      confirmed: input.confirmed === true,
      actor: admin.username,
    })
    return result
  }

  canMakeWholesaleSale(senderId: number): boolean {
    this.assertLicenseUsable()
    return this.userService.canMakeWholesaleSale(this.resolveCurrentUser(senderId, true))
  }

  assertMobileFeature(senderId: number, feature: keyof LicenseFeatures): void {
    this.requireAdmin(senderId)
    this.requireLicenseManager().assertFeature(feature)
  }

  assertAdminPhoneCapacity(senderId: number): void {
    const admin = this.requireAdmin(senderId)
    this.requireLicenseManager().assertAdminPhoneCapacityForUser(admin.id)
  }

  getMobileAccessStatus(senderId: number): Promise<MobileAccessStatus> {
    const admin = this.requireMobileAdmin(senderId)
    return this.requireMobileAccessService().status(admin.id)
  }

  startMobileAccess(senderId: number): Promise<MobileAccessStatus> {
    const admin = this.requireMobileAdmin(senderId)
    return this.requireMobileAccessService().start(admin.id)
  }

  /**
   * The Admin's switch for mobile access over the internet. Licence-gated: the service refuses unless the signed
   * licence carries `mobileInternet`, and the entitlement can only come from the vendor.
   */
  setMobileInternetAccess(senderId: number, enabled: boolean): Promise<MobileAccessStatus> {
    const admin = this.requireMobileAdmin(senderId)
    return this.requireMobileAccessService().setInternetAccess(admin.id, enabled === true)
  }

  stopMobileAccess(senderId: number): Promise<MobileAccessStatus> {
    const admin = this.requireMobileAdmin(senderId)
    return this.requireMobileAccessService().stop(admin.id)
  }

  beginMobilePairing(senderId: number): MobilePairingInfo {
    const admin = this.requireMobileAdmin(senderId)
    return this.requireMobileAccessService().beginPairing(admin.id)
  }

  listMobileDevices(senderId: number): PairedMobileDevice[] {
    const admin = this.requireMobileAdmin(senderId)
    return this.requireMobileAccessService().listDevices(admin.id)
  }

  revokeMobileDevice(senderId: number, deviceId: string): PairedMobileDevice[] {
    const admin = this.requireMobileAdmin(senderId)
    return this.requireMobileAccessService().revokeDevice(admin.id, deviceId)
  }

  getMobileTrustCertificate(senderId: number): Promise<string> {
    const admin = this.requireMobileAdmin(senderId)
    return this.requireMobileAccessService().exportCertificate(admin.id)
  }

  acknowledgeMobileCertificateInstalled(senderId: number): Promise<MobileAccessStatus> {
    const admin = this.requireMobileAdmin(senderId)
    return this.requireMobileAccessService().acknowledgeCertificateInstalled(admin.id)
  }

  regenerateMobileCertificate(senderId: number): Promise<MobileAccessStatus> {
    const admin = this.requireMobileAdmin(senderId)
    return this.requireMobileAccessService().regenerateCertificate(admin.id)
  }

  // ------------------------------------------------------------------ Admin approval and phone controls

  /** The pop-up list: devices waiting for this Admin to approve them on the PC. */
  listPendingMobileApprovals(senderId: number) {
    const admin = this.requireMobileAdmin(senderId)
    return this.requireMobileAccessService().listPendingApprovals(admin.id)
  }

  approveMobileDevice(senderId: number, requestId: string): Promise<unknown[]> {
    const admin = this.requireMobileAdmin(senderId)
    return Promise.resolve(this.requireMobileAccessService().approveDevice(admin.id, requestId))
  }

  rejectMobileDevice(senderId: number, requestId: string): Promise<unknown[]> {
    const admin = this.requireMobileAdmin(senderId)
    return Promise.resolve(this.requireMobileAccessService().rejectDevice(admin.id, requestId))
  }

  renameMobileDevice(senderId: number, deviceId: string, name: string): PairedMobileDevice[] {
    const admin = this.requireMobileAdmin(senderId)
    return this.requireMobileAccessService().renameDevice(admin.id, deviceId, name)
  }

  revokeAllMobileDevices(senderId: number): PairedMobileDevice[] {
    const admin = this.requireMobileAdmin(senderId)
    return this.requireMobileAccessService().revokeAllDevices(admin.id)
  }

  /** The master kill switch: stop the host and revoke every phone in one action. */
  turnOffAllMobileAccess(senderId: number): Promise<MobileAccessStatus> {
    const admin = this.requireMobileAdmin(senderId)
    return this.requireMobileAccessService().shutDownEverything(admin.id)
  }

  repairMobileFirewall(senderId: number): Promise<MobileAccessStatus> {
    const admin = this.requireMobileAdmin(senderId)
    return this.requireMobileAccessService().repairFirewall(admin.id)
  }

  testMobileConnection(senderId: number): Promise<unknown> {
    const admin = this.requireMobileAdmin(senderId)
    return this.requireMobileAccessService().testConnection(admin.id)
  }

  startMobileTotpEnrollment(senderId: number) {
    const admin = this.requireMobileAdmin(senderId)
    const service = this.requireMobileAccessService()
    const shopName = this.shopService.getSettings().profile.name || 'Infoflex'
    const enrollment = service.totp.beginEnrollment({ userId: admin.id, accountName: admin.username, issuer: shopName })
    return Promise.resolve(enrollment)
  }

  confirmMobileTotp(senderId: number, code: string) {
    const admin = this.requireMobileAdmin(senderId)
    return Promise.resolve(this.requireMobileAccessService().totp.confirmEnrollment(admin.id, code))
  }

  getMobileTotpStatus(senderId: number) {
    const admin = this.requireMobileAdmin(senderId)
    return Promise.resolve(this.requireMobileAccessService().totp.status(admin.id))
  }

  disableMobileTotp(senderId: number) {
    const admin = this.requireMobileAdmin(senderId)
    this.requireMobileAccessService().totp.disable(admin.id)
    return Promise.resolve(this.requireMobileAccessService().totp.status(admin.id))
  }

  // ------------------------------------------------------------------ demonstration data

  getDemoDataStatus(senderId: number): DemoDatasetState {
    this.requireAdmin(senderId)
    return this.requireDemoData().status()
  }

  /** Loading and removing are Admin-only and audited; the service enforces both, this only names the caller. */
  loadDemoData(senderId: number): DemoLoadResult {
    return this.requireDemoData().load(this.requireSignedIn(senderId)!)
  }

  removeDemoData(senderId: number): { products: number; users: number; promotions: number } {
    return this.requireDemoData().remove(this.requireSignedIn(senderId)!)
  }

  private requireDemoData(): DemoDataService {
    if (!this.demoData) throw new Error('The demonstration catalogue is only available in the installed desktop app.')
    return this.demoData
  }

  // ------------------------------------------------------------------ the approvals queue

  /** Every cashier request the signed-in user may decide: the badge count and the list. */
  listPendingApprovals(senderId: number) {
    const actor = this.requireSignedIn(senderId)!
    return this.requireApprovalsService().listPending(actor)
  }

  listRecentApprovals(senderId: number) {
    const actor = this.requireSignedIn(senderId)!
    return this.requireApprovalsService().listRecent(actor)
  }

  pendingApprovalCount(senderId: number): number {
    const actor = this.requireSignedIn(senderId)!
    return this.requireApprovalsService().pendingCount(actor)
  }

  resolveApproval(senderId: number, requestId: string, decision: 'APPROVE' | 'REJECT') {
    const actor = this.requireSignedIn(senderId)!
    if (typeof requestId !== 'string' || !requestId.trim()) throw new Error('Choose a request to decide.')
    return this.requireApprovalsService().resolve(requestId.trim(), decision, actor)
  }

  private requireApprovalsService(): ApprovalQueueService {
    if (!this.approvals) throw new Error('The approvals queue is unavailable.')
    return this.approvals
  }

  getCurrentEdition(): Edition | null {
    return this.currentEdition()
  }

  private currentEdition(): Edition | null {
    // Refresh from the host verifier on every protected call; renderer claims are never consulted.
    if (this.licensing) {
      const license = this.licensing.getSnapshot()
      this.editionCache = license.canUse ? license.edition : null
    }
    return this.editionCache
  }

  private editionCache: Edition | null = null

  private requireEdition(): Edition {
    const edition = this.currentEdition()
    if (!edition) throw new Error('Activate a valid Infoflex licence before using this feature.')
    return edition
  }

  private requireInventoryAccess(senderId: number, page: AppPage): { actor: InventoryActor; edition: Edition } {
    const edition = this.requireEdition()
    const user = this.userService.requirePageAccess(this.requireSignedIn(senderId), page, edition)
    return { actor: toInventoryActor(user), edition }
  }

  private requireReturnAccess(senderId: number): { actor: PublicUser; edition: Edition } {
    const edition = this.requireEdition()
    const actor = this.userService.requirePageAccess(this.requireSignedIn(senderId), 'returns', edition)
    return { actor, edition }
  }

  private requireReportsAccess(senderId: number): { actor: PublicUser; edition: Edition } {
    const edition = this.requireEdition()
    const actor = this.userService.requirePageAccess(this.requireSignedIn(senderId), 'reports', edition)
    return { actor, edition }
  }

  private requireAccountingReportService(): AccountingReportService {
    if (!this.reports) throw new Error('The desktop accounting and reports service is unavailable.')
    return this.reports
  }

  private requireMobileAccessService(): MobileAccessService {
    if (!this.mobileAccess) throw new Error('The secure mobile access service is unavailable.')
    return this.mobileAccess
  }

  private requireMobileAdmin(senderId: number): PublicUser {
    const admin = this.requireAdmin(senderId)
    return this.userService.requirePageAccess(admin, 'mobile', this.requireEdition())
  }

  private requireReturnService(): ReturnService {
    if (!this.returns) throw new Error('The desktop Returns service is unavailable.')
    return this.returns
  }

  private requirePosAccess(senderId: number): { actor: PublicUser; edition: Edition } {
    const edition = this.requireEdition()
    const actor = this.userService.requirePageAccess(this.requireSignedIn(senderId), 'pos', edition)
    return { actor, edition }
  }

  private requirePointOfSaleService(): PointOfSaleService {
    if (!this.pointOfSale) throw new Error('The desktop Point of Sale service is unavailable.')
    return this.pointOfSale
  }

  private requireInventoryService(): ProductInventoryService {
    if (!this.inventory) throw new Error('The desktop product and inventory service is unavailable.')
    return this.inventory
  }

  private requireBackupService(): BackupService {
    if (!this.backup) throw new Error('Backup and restore are only available in the desktop app.')
    return this.backup
  }

  private requireLicenseManager(): LicenseManager {
    if (!this.licensing) throw new Error('The desktop license service is unavailable.')
    return this.licensing
  }

  private isLicenseUsable(): boolean {
    return this.licensing ? this.licensing.getSnapshot().canUse : true
  }

  private assertLicenseUsable(): void {
    if (!this.licensing) return
    const license = this.licensing.getSnapshot()
    if (!license.canUse) throw new Error(license.message)
  }

  private getLicenseSummary(context: Awaited<ReturnType<SetupService['getSetupContext']>>): LicenseSummary {
    if (this.licensing) return this.licensing.getSnapshot()
    return fallbackLicenseSummary(context.licenseActivated, context.edition)
  }

  private requireSignedIn(senderId: number): PublicUser {
    this.assertLicenseUsable()
    const user = this.resolveCurrentUser(senderId, true)
    if (!user) throw new Error('Your session has expired. Sign in again.')
    return user
  }

  private requireAdmin(senderId: number): PublicUser {
    const user = this.requireSignedIn(senderId)
    if (user.role !== 'ADMIN') throw new Error('This action is restricted to the Admin.')
    return user
  }

  private resolveCurrentUser(senderId: number, touch: boolean): PublicUser | null {
    if (!this.editionCache) {
      this.sessions.delete(senderId)
      return null
    }
    const session = this.sessions.get(senderId)
    if (!session) return null
    const settings = this.shop.readSettings()
    const timeoutMs = (settings.idleTimeoutMinutes ?? 15) * 60_000
    if (this.now() - session.lastActivityAt >= timeoutMs) {
      const expiredUser = this.users.getUserById(session.userId)
      this.sessions.delete(senderId)
      if (expiredUser) this.auth.auditLogout(toPublicUser(expiredUser))
      return null
    }
    const current = this.users.getUserById(session.userId)
    if (!current || !current.isActive || current.isLocked) {
      this.sessions.delete(senderId)
      return null
    }
    if (touch) session.lastActivityAt = this.now()
    return toPublicUser(current)
  }

  /**
   * Whether the shop has asked for one active login per account.
   *
   * Read from the settings row on every call rather than captured, so turning the toggle off in the Users and Seats
   * screen takes effect at the next sign-in without a restart. A shop whose whole team works from one account across
   * two desks can switch this off; one that does not gets the protection by default.
   */
  private singleLoginPerAccount(): boolean {
    // Asked of the service that owns the setting, rather than reading the column here: a host that read its own copy
    // of a rule drifts from the service the Users and Seats screen writes through, and the customer sees a toggle that
    // does nothing. Absent `TeamService` (an older fixture) means the default, which is on.
    const settings = this.team?.getSnapshot()
    return settings ? settings.singleLoginPerAccount : true
  }

  /**
   * Drop every session for an account, optionally sparing one.
   *
   * `keep` is the sender that just signed in. Sparing it is what makes "log the other one out" possible without
   * logging out the person doing it, which would be a very confusing way to be told you may only have one session.
   */
  private invalidateSessions(userId: string, keep?: number): void {
    for (const [senderId, session] of this.sessions) {
      if (session.userId === userId && senderId !== keep) this.sessions.delete(senderId)
    }
  }
}

function toInventoryActor(user: PublicUser): InventoryActor {
  return { id: user.id, username: user.username, role: user.role }
}

function toReportActor(user: PublicUser): ReportActor {
  return { id: user.id, username: user.username, fullName: user.fullName, role: user.role }
}
