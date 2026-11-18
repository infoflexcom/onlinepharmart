export interface CurrencyLockReader {
  isCurrencyLocked(): boolean
  /** Optional so older callers and tests keep working; when absent the lock is treated as transactional. */
  isCurrencyLockedByVendor?(): boolean
}

import { TRANSACTION_CURRENCY_LOCK_MESSAGE, VENDOR_CURRENCY_LOCK_MESSAGE } from '../shared/currency/lock-messages'

export { TRANSACTION_CURRENCY_LOCK_MESSAGE, VENDOR_CURRENCY_LOCK_MESSAGE }

/** Host-side guard. The caller must check this before changing the shop's currency code. */
export function assertCurrencyChangeAllowed(state: CurrencyLockReader): void {
  if (!state.isCurrencyLocked()) return
  if (state.isCurrencyLockedByVendor?.()) throw new Error(VENDOR_CURRENCY_LOCK_MESSAGE)
  throw new Error(TRANSACTION_CURRENCY_LOCK_MESSAGE)
}
