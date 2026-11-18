import type { CurrencyDefinition } from '../currency/catalog'
import type { MoneyDisplayOptions } from '../currency/money'
import type { ShopProfile } from '../shop/types'

export type ReturnReason = 'WRONG_ITEM' | 'DAMAGED' | 'EXPIRED' | 'CUSTOMER_CHANGED_MIND' | 'OTHER'
export type ReturnType = 'REFUND' | 'STORE_CREDIT' | 'EXCHANGE'
export type ReturnStatus = 'PENDING' | 'COMPLETED' | 'REJECTED'
export type ReturnItemCondition = 'RESELLABLE' | 'OPENED' | 'EXPIRED' | 'DAMAGED' | 'OTHER_NON_RESELLABLE'
export type ReturnStockDisposition = 'RESTOCKED' | 'WRITTEN_OFF' | 'NO_STOCK'
export type ReturnApprovalDecision = 'APPROVE' | 'REJECT'
export type ReturnApprovalChannel = 'DESKTOP' | 'MOBILE'
export type ReturnPaymentMethod = 'CASH' | 'TRANSFER' | 'CARD'
export type ReturnDocumentLayout = 'THERMAL_80' | 'THERMAL_58' | 'A4_RECEIPT' | 'A4_INVOICE'

export interface ReturnSaleBatchRecord {
  batchId: string
  batchNumber: string
  expiryDate: string
  quantityMilli: bigint
}

export interface ReturnSaleItemRecord {
  saleItemId: string
  productId: string | null
  sku: string
  description: string
  unit: string
  quantityMilli: bigint
  returnedQuantityMilli: bigint
  returnableQuantityMilli: bigint
  unitPriceMinor: bigint
  grossTotalMinor: bigint
  manualDiscountMinor: bigint
  promotionDiscountMinor: bigint
  loyaltyDiscountMinor: bigint
  lineTotalMinor: bigint
  expiryTracked: boolean
  batches: ReturnSaleBatchRecord[]
}

export interface ReturnSaleRecord {
  saleId: number
  receiptNumber: string
  createdAt: string
  cashier: string
  currency: CurrencyDefinition
  display: MoneyDisplayOptions
  store: ShopProfile
  customer: { id: string | null; name: string; phone: string; email: string; address: string } | null
  totalMinor: bigint
  promotionDiscountMinor: bigint
  loyaltyDiscountMinor: bigint
  loyaltyPointsEarned: number
  loyaltyPointsRedeemed: number
  items: ReturnSaleItemRecord[]
  returnWindowDays: number
  withinReturnWindow: boolean
  remainingWindowMilliseconds: number
}

export interface RequestReturnItemInput {
  saleItemId: string
  /** Quantity/weight, in product units and up to three decimal places. */
  quantity: string
  condition: ReturnItemCondition
}

export interface RequestReturnInput {
  receiptNumber: string
  reason: ReturnReason
  reasonNote?: string
  type: ReturnType
  refundMethod?: ReturnPaymentMethod
  paymentReference?: string
  items: RequestReturnItemInput[]
  /** Only an Admin may set this, and a written reason is mandatory. */
  overrideReturnWindow?: boolean
  windowOverrideReason?: string
  /** Retry-safe desktop/UI action key, not an authorization credential. */
  idempotencyKey?: string
}

export interface ReturnItemRecord {
  id: string
  saleItemId: string
  productId: string | null
  sku: string
  description: string
  unit: string
  quantityMilli: bigint
  condition: ReturnItemCondition
  stockDisposition: ReturnStockDisposition
  writeoffReason: string
  sourceBatchId: string | null
  sourceBatchNumber: string
  sourceExpiryDate: string
  grossAmountMinor: bigint
  manualDiscountMinor: bigint
  promotionDiscountMinor: bigint
  loyaltyDiscountMinor: bigint
  lineTotalMinor: bigint
}

export interface ReturnCreditRecord {
  creditNumber: string
  type: 'STORE_CREDIT' | 'EXCHANGE'
  amountMinor: bigint
  remainingMinor: bigint
  customerId: string | null
  createdAt: string
}

/** Immutable historical return/credit document with original sale store and currency snapshots. */
export interface ReturnRecord {
  id: number
  returnNumber: string
  saleId: number
  receiptNumber: string
  status: ReturnStatus
  reason: ReturnReason
  reasonNote: string
  type: ReturnType
  refundMethod: ReturnPaymentMethod | null
  paymentReference: string
  createdAt: string
  cashierId: string | null
  cashier: string
  approverId: string | null
  approvedBy: string
  approvedAt: string | null
  approvalChannel: ReturnApprovalChannel | null
  approvalRequestId: string | null
  returnWindowDays: number
  returnWindowOverride: boolean
  returnWindowOverrideReason: string
  currency: CurrencyDefinition
  display: MoneyDisplayOptions
  store: ShopProfile
  customer: { id: string | null; name: string; phone: string; email: string; address: string } | null
  subtotalMinor: bigint
  totalMinor: bigint
  promotionAmountReversedMinor: bigint
  loyaltyDiscountReversedMinor: bigint
  loyaltyPointsReversed: number
  loyaltyPointsRestored: number
  items: ReturnItemRecord[]
  credit: ReturnCreditRecord | null
  duplicate: boolean
  printCount: number
}

export interface ResolveReturnApprovalResult {
  decision: ReturnApprovalDecision
  returnRecord: ReturnRecord
}
