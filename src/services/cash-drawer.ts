/**
 * What should be in the drawer, in one place.
 *
 * Three readers ask this question and they must all get the same number: the day close, which stores `expected_cash`
 * and the difference against what was counted; a cashier's shift, which stores the same pair for one till; and the
 * daily audit, which ties the day's payment totals to the cash count. Each of them used to spell the sum out itself.
 * A fourth spelling would be a fourth chance for an honest Account to be told they are short.
 */

export interface DrawerMovements {
  /** Cash the till started with. */
  openingFloatMinor: bigint
  /** Cash taken for sales. */
  cashSalesMinor: bigint
  /** Cash handed back on returns. */
  cashRefundsMinor: bigint
  /** Paid-outs and safe drops subtract, paid-ins add. Already signed by the caller. */
  drawerAdjustmentsMinor: bigint
  /**
   * Cash taken from a customer settling an old credit balance.
   *
   * Not a sale, and not in any sales report — but it is money in the drawer, and leaving it out would make every day
   * with a collected debt show an unexplained overage against the count.
   */
  debtorCashMinor: bigint
}

export function expectedDrawerCash(movements: DrawerMovements): bigint {
  return movements.openingFloatMinor
    + movements.cashSalesMinor
    - movements.cashRefundsMinor
    + movements.drawerAdjustmentsMinor
    + movements.debtorCashMinor
}

/**
 * Every drawer event the till can record, and which way each one moves the drawer.
 *
 * This is the list `recordCashDrawerEvent` validates against, so a new event type is added here once and both the
 * refusal and the arithmetic see it. An event type nobody has defined is treated as money coming in, which is the safe
 * reading: it makes the drawer's expectation *larger*, so a missing amount shows up as a shortage somebody has to
 * explain rather than as a surplus that looks like a good day.
 */
export const CASH_DRAWER_EVENT_TYPES = ['PAID_IN', 'PAID_OUT', 'FLOAT', 'SAFE_DROP'] as const

export type CashDrawerEventType = (typeof CASH_DRAWER_EVENT_TYPES)[number]

/** The event types that take money *out* of the drawer. `FLOAT` adds to it, like `PAID_IN`. */
const OUT_OF_DRAWER: ReadonlySet<string> = new Set(['PAID_OUT', 'SAFE_DROP'])

export function isDrawerEventType(value: unknown): value is CashDrawerEventType {
  return typeof value === 'string' && (CASH_DRAWER_EVENT_TYPES as readonly string[]).includes(value)
}

export function drawerAdjustmentSigned(eventType: string, amountMinor: bigint): bigint {
  return OUT_OF_DRAWER.has(eventType) ? -amountMinor : amountMinor
}
