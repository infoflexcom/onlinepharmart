import type { SaleType } from '../pos/types'

/**
 * The order-to-receipt workflow's vocabulary.
 *
 * An **order** is what a USER builds: stock reserved, prices snapshotted, nothing paid. A **sale** is what an ACCOUNT
 * produces by finalizing one: stock deducted, receipt number assigned, money recorded. The two are different rows in
 * different tables, and keeping the words apart is what makes the audit trail readable — "who picked it" and "who took
 * the money" are different people and different questions.
 */

export type OrderStatus = 'PENDING' | 'PAID' | 'CANCELLED' | 'EXPIRED'

/** One line of an order, as the customer was quoted when the order was created. */
export interface OrderLineView {
  id: string
  productId: string | null
  /** The description as it read at order time. Renaming the product later must not rewrite this slip. */
  description: string
  unit: string
  quantityMilli: bigint
  unitPriceMinor: bigint
  discountMinor: bigint
  lineTotalMinor: bigint
  prescriptionRequired: boolean
}

/** A price that moved between the order and the finalize. The Account is shown this and must accept it. */
export interface OrderPriceChange {
  productId: string
  description: string
  wasMinor: bigint
  nowMinor: bigint
}

export interface OrderView {
  id: string
  /** Assigned when the order is created, so the picker and the Account can both refer to it out loud. */
  orderNumber: string
  type: SaleType
  status: OrderStatus
  customerName: string | null
  customerId: string | null
  createdById: string
  createdByName: string
  finalizedById: string | null
  finalizedByName: string | null
  currencyCode: string
  subtotalMinor: bigint
  discountMinor: bigint
  /** Mirrors `sales.tax`: VAT is included in prices, so this is 0 unless the shop's pricing changes. */
  taxMinor: bigint
  totalMinor: bigint
  lines: OrderLineView[]
  expiresAt: string | null
  createdAt: string
  /** Set once finalized: the sale this order became. */
  saleId: number | null
  receiptNumber: string | null
  /** True when a prescription line is on the order and the Account must acknowledge it at finalize. */
  needsPrescriptionAck: boolean
  /** Every state change, oldest first, so a disputed order can be explained without guessing. */
  events: OrderEventView[]
}

export interface OrderEventView {
  event: string
  fromStatus: OrderStatus | null
  toStatus: OrderStatus | null
  actorName: string | null
  detail: string
  createdAt: string
}

/**
 * Where an order came from, filled in by the Server from the authenticated connection.
 *
 * Deliberately not part of `CreateOrderInput`: a picker's machine is identified by the Server that accepted its
 * connection, never by a name the client sent. Both fields are optional because an order picked on the Server's own
 * window has no client device at all.
 */
export interface OrderOrigin {
  /** The machine's name as the Admin approved it. Falls back to the Server's own window name when absent. */
  pcName?: string | null
  clientDeviceId?: string | null
}

export interface CreateOrderInput {
  saleType: SaleType
  items: Array<{ productId: string; quantity: string; manualDiscount?: string }>
  customerId?: string | null
  loyaltyPointsToRedeem?: number
  /** Retrying a create with the same key returns the first order rather than reserving the stock twice. */
  idempotencyKey?: string | null
}

export interface FinalizeOrderInput {
  payments: Array<{ method: string; amount: string; reference?: string }>
  /** Required, and required to be new per attempt. A double-click reuses it and yields one sale. */
  idempotencyKey: string
  customerId?: string | null
  loyaltyPointsToRedeem?: number
  /** The Account confirms the prescription warning was shown and accepted. */
  prescriptionAcknowledged?: boolean
  /** Must be true once a price change has been shown; without it the finalize is refused, not silently repriced. */
  acceptPriceChange?: boolean
}

/** What a finalize returns: the order as it now stands, and the receipt it produced. */
export interface FinalizeOrderResult {
  order: OrderView
  saleId: number
  receiptNumber: string
  /** True when this call replayed an earlier finalize with the same idempotency key. */
  idempotentReplay: boolean
  /** The price differences the Account accepted, recorded so the audit trail shows what moved. */
  priceChangesAccepted: OrderPriceChange[]
}

/** The order slip a USER sees. It is deliberately not a receipt and says so on its face. */
export const ORDER_SLIP_NOT_A_RECEIPT = 'NOT PAID - NOT A RECEIPT'
