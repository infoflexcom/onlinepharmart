import type { CurrencyDefinition } from '../currency/catalog'
import type { MoneyDisplayOptions } from '../currency/money'
import type { ShopProfile } from '../shop/types'

export type SaleType = 'RETAIL' | 'WHOLESALE'
export type PosPaymentMethod = 'CASH' | 'TRANSFER' | 'CARD' | 'CREDIT'
export type ReceiptLayout = 'THERMAL_80' | 'THERMAL_58' | 'A4_RECEIPT' | 'A4_INVOICE'

export interface PosSaleLineInput {
  productId: string
  /** Quantity or weight, in unit/1000th-unit increments (up to 3 decimal places). */
  quantity: string
  /** Optional cashier-entered line discount in the current shop currency. */
  manualDiscount?: string
}

export interface PosPaymentInput {
  method: PosPaymentMethod
  /** Cash means tendered; transfer/card mean the amount applied. Credit amount is host-derived. */
  amount: string
  reference?: string
}

export interface CompletePosSaleInput {
  idempotencyKey: string
  saleType: SaleType
  items: PosSaleLineInput[]
  payments: PosPaymentInput[]
  customerId?: string | null
  loyaltyPointsToRedeem?: number
  prescriptionAcknowledged?: boolean
  heldCartId?: string | null
}

export interface PosQuoteInput {
  saleType: SaleType
  items: PosSaleLineInput[]
  customerId?: string | null
  loyaltyPointsToRedeem?: number
}

export interface PosQuoteItemRecord {
  productId: string
  sku: string
  description: string
  unit: string
  quantityMilli: bigint
  priceTier: SaleType
  unitPriceMinor: bigint
  grossTotalMinor: bigint
  manualDiscountMinor: bigint
  promotionDiscountMinor: bigint
  loyaltyDiscountMinor: bigint
  lineTotalMinor: bigint
  prescriptionRequired: boolean
}

export interface PosQuoteRecord {
  saleType: SaleType
  currencyCode: string
  items: PosQuoteItemRecord[]
  subtotalMinor: bigint
  promotionName: string
  promotionDiscountMinor: bigint
  manualDiscountMinor: bigint
  loyaltyDiscountMinor: bigint
  loyaltyPointsToRedeem: number
  loyaltyPointsEarned: number
  totalMinor: bigint
  creditBalanceMinor: bigint
  creditLimitMinor: bigint
  warnings: string[]
}

export interface PosCustomerDraft {
  name: string
  phone?: string
  email?: string
  address?: string
  creditLimit: string
  enrolLoyalty?: boolean
}

export interface PosCustomerRecord {
  id: string
  name: string
  phone: string
  email: string
  address: string
  creditLimitMinor: bigint
  balanceMinor: bigint
  rowVersion: number
  loyaltyMemberId: string | null
  loyaltyMemberNumber: string | null
  loyaltyPointsBalance: number
}

export interface HeldPosCartData {
  saleType: SaleType
  items: PosSaleLineInput[]
  customerId: string | null
  loyaltyPointsToRedeem: number
}

export interface HeldPosCartRecord {
  id: string
  saleType: SaleType
  data: HeldPosCartData
  createdAt: string
  updatedAt: string
}

export interface SaleItemBatchRecord {
  batchId: string
  batchNumber: string
  expiryDate: string
  quantityMilli: bigint
}

export interface PosSaleItemRecord {
  id: string
  productId: string
  sku: string
  description: string
  unit: string
  quantityMilli: bigint
  priceTier: SaleType
  unitPriceMinor: bigint
  grossTotalMinor: bigint
  manualDiscountMinor: bigint
  promotionDiscountMinor: bigint
  loyaltyDiscountMinor: bigint
  discountMinor: bigint
  taxMinor: bigint
  lineTotalMinor: bigint
  prescriptionRequired: boolean
  batches: SaleItemBatchRecord[]
}

export interface PosPaymentRecord {
  id: string
  method: PosPaymentMethod
  amountMinor: bigint
  tenderedMinor: bigint
  changeMinor: bigint
  currencyCode: string
  reference: string
}

export interface PosReceiptRecord {
  id: number
  receiptNumber: string
  status: 'COMPLETED'
  saleType: SaleType
  createdAt: string
  currency: CurrencyDefinition
  display: MoneyDisplayOptions
  store: ShopProfile
  customer: {
    id: string | null
    name: string
    phone: string
    email: string
    address: string
  } | null
  cashier: string
  workstation: string
  items: PosSaleItemRecord[]
  payments: PosPaymentRecord[]
  subtotalMinor: bigint
  promotionDiscountMinor: bigint
  promotionName: string
  manualDiscountMinor: bigint
  loyaltyDiscountMinor: bigint
  loyaltyPointsEarned: number
  loyaltyPointsRedeemed: number
  discountMinor: bigint
  taxMinor: bigint
  totalMinor: bigint
  paidMinor: bigint
  creditMinor: bigint
  tenderedMinor: bigint
  changeMinor: bigint
  prescriptionAcknowledged: boolean
  warnings: string[]
  /** True for any print after the first; the source sale itself is never changed. */
  duplicate: boolean
  printCount: number
  /** "Powered by Infoflex" line, from the shop's receipt settings at the time of the sale. */
  showPoweredBy?: boolean
}

export interface PosRecentSaleRecord {
  id: number
  receiptNumber: string
  saleType: SaleType
  createdAt: string
  customerName: string
  cashier: string
  totalMinor: bigint
  currencyCode: string
  currency: CurrencyDefinition
  display: MoneyDisplayOptions
  duplicate: boolean
  printCount: number
}

export interface CompletePosSaleResult {
  receipt: PosReceiptRecord
  idempotentReplay: boolean
}
