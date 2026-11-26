import type { UserRole } from '../auth/types'
import type { CurrencyDefinition } from '../currency/catalog'
import type { MoneyDisplayOptions } from '../currency/money'
import type { Edition } from '../../editions'

export type ReportPeriod = 'DAY' | 'MONTH'
export type ReportSectionId =
  | 'summary'
  | 'top-sellers'
  | 'slow-movers'
  | 'valuation'
  | 'low-stock'
  | 'debtors'
  | 'purchases'
  | 'user-performance'
  | 'audit-log'
  | 'stocktake'
  | 'pharmacy'
  | 'supermarket'

export interface ReportPeriodInput {
  period: ReportPeriod
  /** YYYY-MM-DD for DAY and YYYY-MM for MONTH. */
  date: string
}

export interface ReportHeader {
  storeName: string
  storeAddress: string
  currency: CurrencyDefinition
  display: MoneyDisplayOptions
  period: {
    type: ReportPeriod
    startDate: string
    endDate: string
    label: string
  }
  generatedAt: string
  scope: 'STORE' | 'PERSONAL'
  viewerName: string
  edition: Edition
}

export interface SalesSplit {
  totalMinor: bigint
  transactions: number
}

export interface AccountingSummary {
  grossSalesMinor: bigint
  totalSalesMinor: bigint
  transactions: number
  retail: SalesSplit
  wholesale: SalesSplit
  discountsMinor: bigint
  returnsMinor: bigint
  refundsMinor: bigint
  netSalesMinor: bigint
  /** Cost and gross profit are intentionally withheld from non-Admin reports. */
  cogsMinor: bigint | null
  grossProfitMinor: bigint | null
  returnTransactions: number
}

export interface DailyAccountingSummary {
  date: string
  totalSalesMinor: bigint
  transactions: number
  retailSalesMinor: bigint
  retailTransactions: number
  wholesaleSalesMinor: bigint
  wholesaleTransactions: number
  discountsMinor: bigint
  returnsMinor: bigint
  refundsMinor: bigint
  netSalesMinor: bigint
  cogsMinor: bigint | null
  grossProfitMinor: bigint | null
}

export interface PaymentMethodSummary {
  method: 'CASH' | 'TRANSFER' | 'CARD' | 'CREDIT'
  totalMinor: bigint
  transactions: number
}

export interface RefundMethodSummary {
  method: 'CASH' | 'TRANSFER' | 'CARD' | 'STORE_CREDIT' | 'EXCHANGE_CREDIT'
  totalMinor: bigint
  transactions: number
}

export interface UserSalesSummary {
  userId: string | null
  userName: string
  username: string
  transactions: number
  retailSalesMinor: bigint
  wholesaleSalesMinor: bigint
  totalSalesMinor: bigint
  discountsMinor: bigint
  returnsMinor: bigint
  netSalesMinor: bigint
  cogsMinor: bigint | null
  grossProfitMinor: bigint | null
}

export interface CashPositionSummary {
  businessDate: string
  currencyCode: string
  openingFloatMinor: bigint
  cashSalesMinor: bigint
  cashRefundsMinor: bigint
  drawerAdjustmentsMinor: bigint
  /** Cash taken from customers settling an old credit balance. In the drawer, but not a sale. */
  debtorCashMinor: bigint
  expectedCashMinor: bigint
}

export interface DayCloseRecord {
  id: number
  closeNumber: string
  businessDate: string
  openedAt: string
  closedAt: string
  closedBy: string
  currencyCode: string
  salesTotalMinor: bigint
  returnsTotalMinor: bigint
  expectedCashMinor: bigint
  countedCashMinor: bigint
  varianceMinor: bigint
  note: string
  storeName: string
  storeAddress: string
}

export interface CashierShiftReportRow {
  id: string
  cashierId: string
  cashierName: string
  openedAt: string
  closedAt: string | null
  status: 'OPEN' | 'CLOSED'
  currencyCode: string
  openingFloatMinor: bigint
  cashSalesMinor: bigint
  cashRefundsMinor: bigint
  drawerAdjustmentsMinor: bigint
  /** Cash collected against an old credit balance during the shift. In the drawer, but not a sale. */
  debtorCashMinor: bigint
  expectedCashMinor: bigint
  countedCashMinor: bigint | null
  varianceMinor: bigint | null
  closedBy: string
  closeNote: string
}

export interface ProductSalesReportRow {
  productId: string | null
  sku: string
  productName: string
  unit: string
  quantitySoldMilli: bigint
  salesMinor: bigint
  transactions: number
  onHandQuantityMilli?: bigint
}

export interface InventoryValuationRow {
  productId: string
  sku: string
  productName: string
  unit: string
  quantityMilli: bigint
  reservedMilli: bigint
  costPerUnitMinor: bigint
  valueMinor: bigint
}

export interface InventoryValuationReport {
  totalQuantityMilli: bigint
  totalValueMinor: bigint
  items: InventoryValuationRow[]
}

export interface LowStockReportRow {
  productId: string
  sku: string
  productName: string
  unit: string
  quantityMilli: bigint
  reservedMilli: bigint
  reorderLevelMilli: bigint
}

export interface DebtorReportRow {
  customerId: string
  customerName: string
  phone: string
  balanceMinor: bigint
  creditLimitMinor: bigint
}

export interface PurchasesReportRow {
  purchaseId: number
  purchaseNumber: string
  supplierName: string
  receivedBy: string
  createdAt: string
  totalMinor: bigint
  currencyCode: string
}

export interface SupplierPurchaseSummary {
  supplierName: string
  transactions: number
  totalMinor: bigint
}

export interface UserPerformanceReportRow extends UserSalesSummary {
  returnsProcessed: number
}

export interface AuditLogReportRow {
  actor: string
  action: string
  deviceName: string
  ipAddress: string | null
  createdAt: string
  metadata: Record<string, unknown>
}

export interface StocktakeReportRow {
  productId: string
  sku: string
  productName: string
  expectedQuantityMilli: bigint
  countedQuantityMilli: bigint
  varianceMilli: bigint
  reason: string
  actor: string
  deviceName: string
  createdAt: string
}

export interface PharmacyExpiryReportRow {
  productId: string
  sku: string
  productName: string
  batchNumber: string
  expiryDate: string
  quantityMilli: bigint
  unit: string
  unitCostMinor: bigint
  valueMinor: bigint
  state: 'EXPIRED' | 'EXPIRING'
}

export interface PharmacyPrescriptionReportRow extends ProductSalesReportRow {
  genericName: string
}

export interface PharmacyWriteOffReportRow {
  reason: string
  items: number
  quantityMilli: bigint
  returnedValueMinor: bigint
}

export interface DepartmentSalesReportRow {
  department: string
  transactions: number
  quantitySoldMilli: bigint
  salesMinor: bigint
  discountsMinor: bigint
}

export interface PromotionSalesReportRow {
  promotion: string
  transactions: number
  discountsMinor: bigint
  salesMinor: bigint
}

export interface SupermarketLoyaltyReport {
  transactions: number
  pointsRedeemed: bigint
  discountsMinor: bigint
}

export interface AdminReportData {
  topSellers: ProductSalesReportRow[]
  slowMovers: ProductSalesReportRow[]
  valuation: InventoryValuationReport
  lowStock: LowStockReportRow[]
  debtors: { totalBalanceMinor: bigint; items: DebtorReportRow[] }
  purchases: {
    totalMinor: bigint
    transactions: number
    items: PurchasesReportRow[]
    bySupplier: SupplierPurchaseSummary[]
  }
  userPerformance: UserPerformanceReportRow[]
  auditLog: AuditLogReportRow[]
  stocktakes: StocktakeReportRow[]
  pharmacy: {
    expiryLots: PharmacyExpiryReportRow[]
    prescriptionSales: PharmacyPrescriptionReportRow[]
    writeOffs: PharmacyWriteOffReportRow[]
  } | null
  supermarket: {
    departments: DepartmentSalesReportRow[]
    promotions: PromotionSalesReportRow[]
    loyalty: SupermarketLoyaltyReport
  } | null
}

export interface AccountingReport {
  header: ReportHeader
  summary: AccountingSummary
  daily: DailyAccountingSummary[]
  paymentMethods: PaymentMethodSummary[]
  refundMethods: RefundMethodSummary[]
  salesByUser: UserSalesSummary[]
  cashPosition: CashPositionSummary | null
  dayClose: DayCloseRecord | null
  shifts: CashierShiftReportRow[]
  adminReports: AdminReportData | null
}

export interface CloseDayInput {
  businessDate: string
  countedCash: string
  note?: string
}

export interface OpenCashierShiftInput {
  openingFloat: string
}

export interface CloseCashierShiftInput {
  shiftId: string
  countedCash: string
  note?: string
}

export interface RecordDebtorPaymentInput {
  customerId: string
  /** In the shop's currency, as the till types it. */
  amount: string
  /** Cash is the only method that changes what should be in the drawer at the day close. */
  method: 'CASH' | 'TRANSFER' | 'CARD'
  reference?: string
  note?: string
}

export interface CashDrawerEventInput {
  shiftId: string
  type: 'PAID_IN' | 'PAID_OUT' | 'FLOAT' | 'SAFE_DROP'
  amount: string
  note: string
}

export interface ReportExportInput extends ReportPeriodInput {
  section: ReportSectionId
}

export interface MobileAccountingSummary {
  header: Pick<ReportHeader, 'storeName' | 'storeAddress' | 'currency' | 'period' | 'generatedAt'>
  summary: AccountingSummary
  daily: DailyAccountingSummary[]
  paymentMethods: PaymentMethodSummary[]
  refundMethods: RefundMethodSummary[]
  /** "Sales by cashier today" on the phone's dashboard; Admin-scoped, so it may carry cost and profit. */
  salesByUser: UserSalesSummary[]
}

export interface ReportActor {
  id: string
  username: string
  role: UserRole
  fullName?: string
}
