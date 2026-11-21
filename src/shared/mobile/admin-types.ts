import type { CurrencyDefinition } from '../../currency/catalog'
import type { MoneyDisplayOptions } from '../../currency/money'
import type { ApprovalRequestView } from '../approvals/types'

/**
 * The wire contract between the phone and the desktop host. Every amount crosses the wire as an integer
 * string in minor units, and the currency definition travels with the shop so the phone formats exactly
 * as the desktop does. Nothing here is pre-formatted or floating point.
 *
 * Codes are ISO 4217 strings. Quantities are integer strings in thousandths ("milli"), matching the rest
 * of the host, so a 0-decimal currency can never be confused with a fractional quantity.
 */

export interface MobileShopCurrency {
  currency: CurrencyDefinition
  display: MoneyDisplayOptions
}

/** The header block every mobile screen shows; the store name is the customer's own, never Infoflex. */
export interface MobileShopHeader {
  storeName: string
  storeAddress: string
  storePhone: string
  edition: 'PHARMACY' | 'SUPERMARKET' | 'BOTH'
  currency: CurrencyDefinition
  display: MoneyDisplayOptions
  generatedAt: string
}

export interface MobileDashboardCashier {
  userId: string | null
  userName: string
  username: string
  transactions: number
  /** Integer minor units as strings. */
  totalSalesMinor: string
  netSalesMinor: string
}

export interface MobileDashboardStockAlert {
  productId: string
  sku: string
  productName: string
  /** null for low-stock rows (they carry a quantity) — kept explicit for the phone's list layout. */
  batchNumber: string | null
  expiryDate: string | null
  quantityMilli: string
  unit: string
}

export interface MobileDashboard {
  header: MobileShopHeader
  today: { date: string; totalSalesMinor: string; transactions: number; netSalesMinor: string }
  month: { label: string; totalSalesMinor: string; transactions: number; netSalesMinor: string }
  counts: {
    lowStock: number
    nearExpiry: number
    expired: number
    pendingApprovals: number
    connectedDevices: number
  }
  salesByCashierToday: MobileDashboardCashier[]
}

export interface MobileProductSummary {
  id: string
  sku: string
  name: string
  brand: string
  barcode: string
  category: string
  unit: string
  quantityMilli: string
  reorderLevelMilli: string
  retailPriceMinor: string
  wholesalePriceMinor: string
  costMinor: string | null
  rowVersion: number
  stockVersion: number
  isActive: boolean
  prescriptionRequired: boolean
  expiryTracking: boolean
}

export interface MobileBatch {
  batchNumber: string
  expiryDate: string | null
  quantityMilli: string
  unitCostMinor: string | null
}

export interface MobileStockMovement {
  reference: string
  movementType: string
  quantityDeltaMilli: string
  reason: string
  batchNumber: string
  actor: string
  createdAt: string
}

export interface MobileProductDetail {
  product: MobileProductSummary
  batches: MobileBatch[]
  history: MobileStockMovement[]
}

export interface MobileProductSearch {
  header: MobileShopHeader
  products: MobileProductSummary[]
  /** True when the search ended on a single product, so the phone can open it straight away. */
  exactMatchProductId: string | null
}

/** Every write carries the versions the phone last saw, so a stale screen can never overwrite newer data. */
export interface MobileProductUpdateInput {
  productId: string
  expectedRowVersion: number
  /** The Admin's password, re-entered to confirm a price change. */
  adminPassword: string
  name: string
  brand: string
  category: string
  unit: string
  barcode: string
  reorderLevel: string
  retailPrice: string
  wholesalePrice: string
  cost: string
}

export interface MobileProductCreateInput {
  sku: string
  name: string
  barcode: string
  unit: string
  category: string
  retailPrice: string
  wholesalePrice: string
  cost: string
  reorderLevel: string
  expiryTracking: boolean
  prescriptionRequired: boolean
}

export interface MobileStockAdjustmentInput {
  productId: string
  expectedProductVersion: number
  expectedStockVersion: number
  direction: 'increase' | 'decrease'
  quantity: string
  reason: string
  batchNumber: string
  expiryDate: string
  idempotencyKey: string
}

export interface MobileStockReceiptInput {
  productId: string
  expectedProductVersion: number
  expectedStockVersion: number
  quantity: string
  quantityUnit: 'unit' | 'pack'
  unitCost: string
  supplierName: string
  supplierReference: string
  note: string
  batchNumber: string
  expiryDate: string
}

export interface MobileSaleSummary {
  id: number
  receiptNumber: string
  saleType: 'RETAIL' | 'WHOLESALE'
  createdAt: string
  customerName: string
  cashier: string
  totalMinor: string
  currencyCode: string
}

export interface MobileSaleList {
  header: MobileShopHeader
  sales: MobileSaleSummary[]
}

export interface MobileSaleLine {
  sku: string
  description: string
  quantityMilli: string
  unit: string
  unitPriceMinor: string
  lineTotalMinor: string
}

export interface MobileSaleDetail {
  header: MobileShopHeader
  id: number
  receiptNumber: string
  saleType: 'RETAIL' | 'WHOLESALE'
  createdAt: string
  cashier: string
  workstation: string
  customer: { name: string; phone: string; address: string } | null
  lines: MobileSaleLine[]
  subtotalMinor: string
  discountMinor: string
  taxMinor: string
  totalMinor: string
  paidMinor: string
  creditMinor: string
  payments: Array<{ method: string; amountMinor: string; reference: string }>
  /** The currency the sale was actually made in, which can differ from today's after a locked change. */
  currency: CurrencyDefinition
}

export interface MobileCashierPermissionRow {
  id: string
  fullName: string
  username: string
  role: 'CASHIER' | 'SUPERVISOR'
  isActive: boolean
  /** The host's own field names, so nothing is renamed in flight and no value is reinterpreted. */
  allowWholesale: boolean
  maxDiscountBasisPoints: number
  allowCreditSales: boolean
}

export interface MobileDeviceRow {
  id: string
  name: string
  platform: string
  lastSeen: string | null
  lastIp: string | null
  createdAt: string
  /** True when the phone holds a live session, i.e. it can open the app right now. */
  connected: boolean
}

export interface MobileDeviceList {
  header: MobileShopHeader
  devices: MobileDeviceRow[]
}

export interface MobileCashierPermissions {
  cashiers: MobileCashierPermissionRow[]
}

export interface MobileCashierPermissionInput {
  userId: string
  allowWholesale: boolean
  adminPassword: string
}

/** Approval rows reuse the desktop view so both screens can never disagree about a decision's meaning. */
export type MobileApproval = ApprovalRequestView

export interface MobileApprovals {
  header: MobileShopHeader
  pending: MobileApproval[]
  recent: MobileApproval[]
  pendingCount: number
}

export interface MobileApiError {
  message: string
  /** Present when the screen must be reloaded instead of retried (a stale version or a decided request). */
  reloadRequired?: boolean
  /** Machine-readable form of the version conflict, so the phone can show the "changed, reload" note. */
  code?: 'STALE_VERSION' | 'ALREADY_DECIDED' | 'ADMIN_PASSWORD_REQUIRED' | 'OFFLINE_WRITES_BLOCKED'
}
