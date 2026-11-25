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
import { PointOfSaleService } from '../services/point-of-sale-service'
import { ReturnService } from '../services/return-service'
import type {
  RequestReturnInput,
  ReturnApprovalDecision,
  ReturnDocumentLayout,
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
    return this.requirePointOfSaleService().completeSale(input, actor, edition)
  }

  listRecentPosSales(senderId: number) {
    const { actor } = this.requirePosAccess(senderId)
    return this.requirePointOfSaleService().listRecentSales(actor)
  }

  getPosReceipt(senderId: number, saleId: string | number): PosReceiptRecord {
    const { actor } = this.requirePosAccess(senderId)
    return this.requirePointOfSaleService().recordReceiptViewed(saleId, actor)
  }

  recordPosReceiptPrint(senderId: number, saleId: string | number, layout: ReceiptLayout): PosReceiptRecord {
    const { actor } = this.requirePosAccess(senderId)
    return this.requirePointOfSaleService().recordReceiptPrint(saleId, layout, actor)
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

  recordReturnPrint(senderId: number, returnId: string | number, layout: ReturnDocumentLayout) {
    const { actor } = this.requireReturnAccess(senderId)
    return this.requireReturnService().recordReturnPrint(returnId, layout, actor)
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
