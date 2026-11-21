import type { AppPage, CreateUserInput, LoginInput, NavigationItem, PublicUser, UpdateUserInput } from './auth/types'
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
  recordPosReceiptPrint(saleId: string | number, layout: ReceiptLayout): Promise<PosReceiptRecord>
  holdPosCart(data: HeldPosCartData): Promise<HeldPosCartRecord>
  listHeldPosCarts(): Promise<HeldPosCartRecord[]>
  recallHeldPosCart(id: string): Promise<HeldPosCartRecord>
  discardHeldPosCart(id: string): Promise<void>
  findSaleForReturn(receiptNumber: string): Promise<ReturnSaleRecord>
  createReturn(input: RequestReturnInput): Promise<ReturnRecord>
  listReturns(): Promise<ReturnRecord[]>
  getReturnDocument(returnId: string | number): Promise<ReturnRecord>
  resolveReturnApproval(returnId: string | number, decision: ReturnApprovalDecision): Promise<ResolveReturnApprovalResult>
  recordReturnPrint(returnId: string | number, layout: ReturnDocumentLayout): Promise<ReturnRecord>
  getAccountingReport(input: ReportPeriodInput): Promise<AccountingReport>
  exportReportCsv(input: ReportExportInput): Promise<string>
  exportReportExcel(input: ReportExportInput): Promise<string>
  exportReportPdf(input: ReportExportInput): Promise<string>
  closeReportingDay(input: CloseDayInput): Promise<DayCloseRecord>
  openCashierShift(input: OpenCashierShiftInput): Promise<CashierShiftReportRow>
  closeCashierShift(input: CloseCashierShiftInput): Promise<CashierShiftReportRow>
  recordCashDrawerEvent(input: CashDrawerEventInput): Promise<void>
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
