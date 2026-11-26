import type {
  AppPage, AssignableRole, CreateUserInput, LoginInput, NavigationItem, PublicUser, UpdateUserInput, UserPermissions,
} from './auth/types'
import type {
  CreateOrderInput, FinalizeOrderInput, FinalizeOrderResult, OrderView,
} from './orders/types'
import type { PrintLogEntry } from '../services/print-gate-service'
import type {
  AuditDayStatus,
  AuditDebtorPaymentRow,
  AuditExportInput,
  AuditExportResult,
  AuditFlagNoteInput,
  AuditFlagRow,
  AuditNoteFindingInput,
  AuditSignOffRow,
  AuditSummaryForPhone,
  DailyAuditReport,
  DayAuditInput,
  RaiseAuditFlagInput,
  ResolveAuditFlagInput,
  SignOffDayInput,
  UnauditedDay,
} from './audit/types'
import type { RoleSeatCount, SeatCountChange, TeamSettingsInput, TeamSnapshot } from '../services/team-service'

import type { CurrencyDefinition } from './currency/catalog'
import type { MoneyDisplayOptions } from './currency/money'
import type {
  BackupResult,
  BackupStatus,
  BackupSummary,
  BootstrapData,
  FirstRunInput,
  OperationalSettings,
  RestoreBackupInput,
  RestoreResult,
  ShopProfile,
  ShopSettings,
} from './shop/types'
import type { LicenseCheckInResult, LicenseFeatures, LicenseSummary, OnsiteActivationInput, OnlineActivationInput } from './license/types'
import type {
  CompletePosSaleInput,
  CompletePosSaleResult,
  HeldPosCartData,
  HeldPosCartRecord,
  PosCustomerDraft,
  PosCustomerRecord,
  PosQuoteInput,
  PosQuoteRecord,
  PosReceiptRecord,
  PosRecentSaleRecord,
  ReceiptLayout,
} from './pos/types'
import type {
  RequestReturnInput,
  ReturnApprovalDecision,
  ReturnDocumentLayout,
  ReturnRecord,
  ReturnSaleRecord,
  ResolveReturnApprovalResult,
} from './returns/types'
import type {
  ConsumeStockInput,
  FEFOSaleResult,
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
} from './inventory/types'
import type { ApprovalRequestView } from './approvals/types'
import type { DemoDatasetState, DemoLoadResult } from './demo/types'
import type {
  MobileAccessStatus, MobileConnectionTest, MobileKeepRunningSettings, MobilePairingInfo,
  MobileTotpEnrollment, PairedMobileDevice, PendingMobileApproval, TotpStatus,
} from './mobile/types'
import type {
  AccountingReport,
  CashDrawerEventInput,
  CashierShiftReportRow,
  CloseCashierShiftInput,
  CloseDayInput,
  DayCloseRecord,
  OpenCashierShiftInput,
  RecordDebtorPaymentInput,
  ReportExportInput,
  ReportPeriodInput,
} from './reports/types'

export interface InfoflexBridge {
  getBootstrap(): Promise<BootstrapData>
  getLicenseStatus(): Promise<LicenseSummary>
  importVendorPolicyFile(contents: string): Promise<void>
  activateOnline(input: OnlineActivationInput): Promise<LicenseSummary>
  importLicenseFile(contents: string): Promise<LicenseSummary>
  activateOnsite(input: OnsiteActivationInput): Promise<LicenseSummary>
  checkInLicense(): Promise<LicenseCheckInResult>
  getShopSettings(): Promise<ShopSettings>
  completeFirstRun(input: FirstRunInput): Promise<ShopSettings>
  login(input: LoginInput): Promise<PublicUser>
  logout(): Promise<void>
  getCurrentUser(): Promise<PublicUser | null>
  touchSession(): Promise<boolean>
  getNavigation(): Promise<NavigationItem[]>
  openPage(page: AppPage): Promise<{ page: AppPage }>
  canMakeWholesaleSale(): Promise<boolean>
  assertMobileFeature(feature: keyof LicenseFeatures): Promise<void>
  assertAdminPhoneCapacity(): Promise<void>
  getMobileAccessStatus(): Promise<MobileAccessStatus>
  startMobileAccess(): Promise<MobileAccessStatus>
  stopMobileAccess(): Promise<MobileAccessStatus>
  beginMobilePairing(): Promise<MobilePairingInfo>
  listMobileDevices(): Promise<PairedMobileDevice[]>
  revokeMobileDevice(id: string): Promise<PairedMobileDevice[]>
  getMobileTrustCertificate(): Promise<string>
  acknowledgeMobileCertificateInstalled(): Promise<MobileAccessStatus>
  regenerateMobileCertificate(): Promise<MobileAccessStatus>
  /** Devices waiting for this Admin to approve them on the PC. */
  listPendingMobileApprovals(): Promise<PendingMobileApproval[]>
  approveMobileDevice(requestId: string): Promise<PendingMobileApproval[]>
  rejectMobileDevice(requestId: string): Promise<PendingMobileApproval[]>
  renameMobileDevice(id: string, name: string): Promise<PairedMobileDevice[]>
  revokeAllMobileDevices(): Promise<PairedMobileDevice[]>
  turnOffAllMobileAccess(): Promise<MobileAccessStatus>
  repairMobileFirewall(): Promise<MobileAccessStatus>
  testMobileConnection(): Promise<MobileConnectionTest>
  startMobileTotpEnrollment(): Promise<MobileTotpEnrollment>
  confirmMobileTotp(code: string): Promise<TotpStatus>
  getMobileTotpStatus(): Promise<TotpStatus>
  disableMobileTotp(): Promise<TotpStatus>
  /** The Admin's own switch for mobile access over the internet; refused unless the licence grants it. */
  setMobileInternetAccess(enabled: boolean): Promise<MobileAccessStatus>
  getKeepRunningSettings(): Promise<MobileKeepRunningSettings>
  setKeepRunningSettings(settings: MobileKeepRunningSettings): Promise<MobileKeepRunningSettings>
  /** The shared approvals queue: discounts, credit, returns above limits, and voids. */
  listPendingApprovals(): Promise<ApprovalRequestView[]>
  listRecentApprovals(): Promise<ApprovalRequestView[]>
  pendingApprovalCount(): Promise<number>
  resolveApproval(requestId: string, decision: 'APPROVE' | 'REJECT'): Promise<ApprovalRequestView>
  listUsers(): Promise<PublicUser[]>
  createUser(input: CreateUserInput): Promise<PublicUser>
  updateUser(id: string, input: UpdateUserInput): Promise<PublicUser>
  deactivateUser(id: string): Promise<void>
  resetPassword(id: string, password: string, confirmPassword: string): Promise<void>
  unlockUser(id: string): Promise<PublicUser>
  // ─── Team size and seats ──────────────────────────────────────────────────────────────────────────────────────
  // Every one of these is Admin-only on the server. They are on the bridge because the Users and Seats screen is the
  // Admin's; nothing else calls them.
  getTeamSnapshot(): Promise<TeamSnapshot>
  /** Change how many seats a role has. Refused above the licence cap and below the active accounts. */
  setSeatCount(change: SeatCountChange): Promise<RoleSeatCount[]>
  renameSeat(userId: string, fullName: string): Promise<void>
  /** Set or reset a seat's password. This is what turns "Needs password" into a sign-in. */
  setSeatPassword(userId: string, password: string, confirmPassword: string): Promise<void>
  updateTeamSettings(input: TeamSettingsInput): Promise<void>
  /** Deactivate or reactivate a seat. Deactivating ends any open session for that person. */
  setSeatActive(userId: string, isActive: boolean): Promise<void>
  /** The four per-user limits. They narrow a role; they can never widen it. */
  setSeatPermissions(userId: string, permissions: UserPermissions): Promise<void>
  /** The fixed, read-only description of each role, derived from the capability table. */
  getRoleSummary(): Promise<Array<{ role: AssignableRole; summary: string }>>

  getInventoryOverview(search?: string): Promise<InventoryOverview>
  saveProduct(draft: ProductDraft): Promise<ProductRecord>
  importProductsCsv(contents: string): Promise<ProductImportReport>
  importProductsExcel(contents: Uint8Array): Promise<ProductImportReport>
  exportProductsCsv(): Promise<string>
  exportProductsExcel(): Promise<string>
  receiveStock(input: ReceiveStockInput): Promise<StockMutationResult>
  adjustStock(input: StockAdjustmentInput): Promise<StockMutationResult>
  recordStocktake(input: StocktakeInput): Promise<StockMutationResult>
  getStocktakeVarianceReport(): Promise<StocktakeVarianceRecord[]>
  listPurchaseOrders(): Promise<PurchaseOrderRecord[]>
  createPurchaseOrder(draft: PurchaseOrderDraft): Promise<PurchaseOrderRecord>
  receivePurchaseOrder(input: PurchaseOrderReceiptInput): Promise<PurchaseOrderRecord>
  getSellableBatches(productId: string): Promise<SellableBatch[]>
  consumeStockFEFO(input: ConsumeStockInput): Promise<FEFOSaleResult>
  getWeighedPrice(productId: string, weight: string): Promise<WeighedPriceResult>
  listPosCustomers(): Promise<PosCustomerRecord[]>
  createPosCustomer(input: PosCustomerDraft): Promise<PosCustomerRecord>
  quotePosSale(input: PosQuoteInput): Promise<PosQuoteRecord>
  completePosSale(input: CompletePosSaleInput): Promise<CompletePosSaleResult>
  listRecentPosSales(): Promise<PosRecentSaleRecord[]>
  getPosReceipt(saleId: string | number): Promise<PosReceiptRecord>
  /**
   * Print a receipt. The reason is required for any copy after the first, and every copy is written to the print log
   * with the machine it was asked for on.
   */
  recordPosReceiptPrint(saleId: string | number, layout: ReceiptLayout, reason?: string): Promise<PosReceiptRecord>

  // ── the order-to-receipt workflow ────────────────────────────────────────────────────────────────────────
  /** A picker generates an order: stock is reserved, prices snapshotted, nothing paid. */
  createOrder(input: CreateOrderInput): Promise<OrderView>
  /** The Account's queue of unpaid orders. */
  listOrderQueue(): Promise<OrderView[]>
  /** A picker's own orders, with their live status. */
  listMyOrders(): Promise<OrderView[]>
  getOrder(orderId: string): Promise<OrderView>
  /** An Account adjusts a quantity at the till. Logged, with the before and after. */
  adjustOrderLine(orderId: string, itemId: string, quantity: string): Promise<OrderView>
  /** Either side may cancel an unpaid order. The reason is mandatory and is recorded. */
  cancelOrder(orderId: string, reason: string): Promise<OrderView>
  /**
   * Take payment and finalize into a sale. The key makes a double-click produce one sale; a second Account finalizing
   * the same order is told it is already completed.
   */
  finalizeOrder(orderId: string, input: FinalizeOrderInput): Promise<FinalizeOrderResult>
  /** Every copy of every document: who, which machine, which copy number, and why it was printed again. */
  listPrintLog(limit?: number): Promise<PrintLogEntry[]>
  holdPosCart(data: HeldPosCartData): Promise<HeldPosCartRecord>
  listHeldPosCarts(): Promise<HeldPosCartRecord[]>
  recallHeldPosCart(id: string): Promise<HeldPosCartRecord>
  discardHeldPosCart(id: string): Promise<void>
  findSaleForReturn(receiptNumber: string): Promise<ReturnSaleRecord>
  createReturn(input: RequestReturnInput): Promise<ReturnRecord>
  listReturns(): Promise<ReturnRecord[]>
  getReturnDocument(returnId: string | number): Promise<ReturnRecord>
  resolveReturnApproval(returnId: string | number, decision: ReturnApprovalDecision): Promise<ResolveReturnApprovalResult>
  /** Print a credit note. The reason is required for any copy after the first. */
  recordReturnPrint(returnId: string | number, layout: ReturnDocumentLayout, reason?: string): Promise<ReturnRecord>
  getAccountingReport(input: ReportPeriodInput): Promise<AccountingReport>
  exportReportCsv(input: ReportExportInput): Promise<string>
  exportReportExcel(input: ReportExportInput): Promise<string>
  exportReportPdf(input: ReportExportInput): Promise<string>
  closeReportingDay(input: CloseDayInput): Promise<DayCloseRecord>
  openCashierShift(input: OpenCashierShiftInput): Promise<CashierShiftReportRow>
  closeCashierShift(input: CloseCashierShiftInput): Promise<CashierShiftReportRow>
  recordCashDrawerEvent(input: CashDrawerEventInput): Promise<void>
  /** Take money against what a customer owes. Moves the balance and the drawer in one transaction. */
  recordDebtorPayment(input: RecordDebtorPaymentInput): Promise<AuditDebtorPaymentRow>
  /** One business day, recomputed from the ledger. Omit `accountId` to audit the whole store. */
  getDayAudit(input: DayAuditInput): Promise<DailyAuditReport>
  listAuditDayStatuses(): Promise<AuditDayStatus[]>
  listUnauditedDays(days?: number): Promise<UnauditedDay[]>
  getAuditSummary(): Promise<AuditSummaryForPhone>
  signOffAuditDay(input: SignOffDayInput): Promise<AuditSignOffRow>
  noteAuditFinding(input: AuditNoteFindingInput): Promise<AuditFlagRow>
  raiseAuditFlag(input: RaiseAuditFlagInput): Promise<AuditFlagRow>
  addAuditFlagNote(input: AuditFlagNoteInput): Promise<AuditFlagRow>
  resolveAuditFlag(input: ResolveAuditFlagInput): Promise<AuditFlagRow>
  /** The day as a file. There is no print method beside it: an audit is never handed across a counter. */
  exportAudit(input: AuditExportInput): Promise<AuditExportResult>
  updateStoreDetails(profile: ShopProfile): Promise<ShopSettings>
  updateDisplaySettings(display: MoneyDisplayOptions): Promise<ShopSettings>
  changeCurrency(currency: CurrencyDefinition, confirmed: boolean): Promise<ShopSettings>
  updateIdleTimeout(minutes: number): Promise<ShopSettings>
  updateReturnWindowDays(days: number): Promise<ShopSettings>
  updateOperationalSettings(input: OperationalSettings): Promise<ShopSettings>
  getBackupStatus(): Promise<BackupStatus>
  createManualBackup(folder: string): Promise<BackupResult>
  listBackupFiles(folder: string): Promise<BackupSummary[]>
  restoreBackup(input: RestoreBackupInput): Promise<RestoreResult>
  chooseBackupFolder(): Promise<string | null>
  /** The optional demonstration catalogue: load it to try the app, remove it before real use. */
  getDemoDataStatus(): Promise<DemoDatasetState>
  loadDemoData(): Promise<DemoLoadResult>
  removeDemoData(): Promise<{ products: number; users: number; promotions: number }>
}

declare global {
  interface Window {
    infoflex?: InfoflexBridge
  }
}
