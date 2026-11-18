import type { Edition } from '../../editions'
import type { UserRole } from '../auth/types'
export interface InventoryActor {
  id: string
  username: string
  role: UserRole
}

export interface ProductVariantDraft {
  code: string
  label: string
  price: string
  attributes?: Record<string, string>
}

export interface ProductVariantRecord {
  id: string
  code: string
  label: string
  priceMinor: bigint | null
  attributes: Record<string, string>
  rowVersion: number
}

/** Price fields remain strings across IPC so the host can parse them exactly for shop currency. */
export interface ProductDraft {
  id?: string
  expectedVersion?: number
  sku: string
  name: string
  brand: string
  description: string
  barcode: string
  additionalBarcodes: string[]
  category: string
  subCategory: string
  department: string
  shelfLocation: string
  unit: string
  packSizeUnits: number
  cost: string
  retailPrice: string
  wholesalePrice: string
  wholesaleMinimumQuantity: string
  reorderLevel: string
  genericName: string
  prescriptionRequired: boolean
  weighedItem: boolean
  pluCode: string
  pricePerKg: string
  expiryTracking: boolean
  variants: ProductVariantDraft[]
  isActive: boolean
}

export interface ProductRecord {
  id: string
  sku: string
  name: string
  brand: string
  description: string
  barcode: string
  additionalBarcodes: string[]
  category: string
  subCategory: string
  department: string
  shelfLocation: string
  unit: string
  packSizeUnits: number
  costMinor: bigint | null
  retailPriceMinor: bigint
  wholesalePriceMinor: bigint
  wholesaleMinimumQuantityMilli: bigint
  reorderLevelMilli: bigint
  quantityMilli: bigint
  reservedMilli: bigint
  rowVersion: number
  stockVersion: number
  genericName: string
  prescriptionRequired: boolean
  weighedItem: boolean
  pluCode: string
  pricePerKgMinor: bigint | null
  expiryTracking: boolean
  isActive: boolean
  variants: ProductVariantRecord[]
}

export interface SupplierOption {
  id: string
  name: string
  phone: string
  email: string
}

export type InventoryAlert =
  | {
      type: 'low_stock'
      productId: string
      sku: string
      productName: string
      quantityMilli: bigint
      reorderLevelMilli: bigint
      unit: string
    }
  | {
      type: 'near_expiry' | 'expired'
      productId: string
      sku: string
      productName: string
      batchId: string
      batchNumber: string
      expiryDate: string
      quantityMilli: bigint
      unit: string
    }

export interface ImportRowError {
  row: number
  message: string
}

export interface ProductImportReport {
  imported: number
  errors: ImportRowError[]
}

export interface InventoryOverview {
  edition: Edition
  products: ProductRecord[]
  alerts: InventoryAlert[]
  suppliers: SupplierOption[]
  categories: string[]
  departments: string[]
}

export interface ReceiveStockInput {
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

export interface StockAdjustmentInput {
  /**
   * Opaque key that makes retrying this change safe. The desktop generates one per form submission, so a
   * double click or a dropped connection can never apply the same adjustment twice.
   */
  idempotencyKey?: string
  productId: string
  expectedProductVersion: number
  expectedStockVersion: number
  direction: 'increase' | 'decrease'
  quantity: string
  reason: string
  batchNumber: string
  expiryDate: string
}

export interface StocktakeInput {
  /** See StockAdjustmentInput.idempotencyKey. */
  idempotencyKey?: string
  productId: string
  expectedProductVersion: number
  expectedStockVersion: number
  countedQuantity: string
  reason: string
  batchNumber: string
  expiryDate: string
}

export interface PurchaseOrderLineDraft {
  productId: string
  quantity: string
  quantityUnit: 'unit' | 'pack'
  unitCost: string
}

export interface PurchaseOrderDraft {
  supplierName: string
  supplierReference: string
  note: string
  items: PurchaseOrderLineDraft[]
}

export interface PurchaseOrderReceiptInput {
  purchaseId: string
  expectedVersion: number
  supplierReference: string
  receivedNote: string
  items: Array<{ purchaseItemId: string; batchNumber: string; expiryDate: string }>
}

export interface PurchaseOrderItemRecord {
  id: string
  productId: string
  sku: string
  productName: string
  quantityMilli: bigint
  unitCostMinor: bigint | null
  lineTotalMinor: bigint | null
  receivedQuantityMilli: bigint
  unit: string
  packSizeUnits: number
  batchNumber: string
  expiryDate: string
}

export interface PurchaseOrderRecord {
  id: string
  reference: string
  supplierName: string
  supplierReference: string
  note: string
  status: 'DRAFT' | 'COMPLETED' | 'CANCELLED'
  rowVersion: number
  currencyCode: string
  totalMinor: bigint | null
  createdAt: string
  receivedAt: string | null
  items: PurchaseOrderItemRecord[]
}

export interface ConsumeStockInput {
  productId: string
  expectedProductVersion: number
  expectedStockVersion: number
  quantity: string
  reference: string
}

export interface StocktakeVarianceRecord {
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

export interface WeighedPriceResult {
  productId: string
  weightMilli: bigint
  priceMinor: bigint
  currencyCode: string
}

export interface StockMutationResult {
  product: ProductRecord
  reference: string
  quantityDeltaMilli: bigint
  varianceMilli?: bigint
}

export interface SellableBatch {
  batchId: string | null
  batchNumber: string | null
  expiryDate: string | null
  quantityMilli: bigint
  unitCostMinor: bigint
}

export interface FEFOSaleAllocation {
  batchId: string | null
  batchNumber: string | null
  expiryDate: string | null
  quantityMilli: bigint
}

export interface FEFOSaleResult {
  product: ProductRecord
  reference: string
  quantityDeltaMilli: bigint
  allocations: FEFOSaleAllocation[]
}
