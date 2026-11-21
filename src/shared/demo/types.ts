/**
 * The optional demonstration dataset. Shared so the desktop IPC, the preload bridge and the Settings screen all
 * describe it the same way: what is loaded, what would be removed, and whether real work now depends on it.
 */
export interface DemoDatasetState {
  /** True when any demo product or demo account is still present. */
  loaded: boolean
  products: number
  users: number
  /** The demo accounts by username, so the Admin sees exactly which logins will disappear. */
  demoUsers: Array<{ username: string; fullName: string; role: string }>
  /** True when a sale, return, purchase or real stock movement references a demo row, so removal refuses. */
  inUse: boolean
  /** Plain-words explanation of `inUse`, safe to show as-is. */
  inUseReason: string | null
  /** The shop's currency code; demo prices are scaled to it, never hard-coded. */
  currency: string
}

export interface DemoLoadResult {
  products: number
  users: number
  promotions: number
  currencyCode: string
  /** One formatted example price, printed in the shop's own currency so the Admin can sanity-check the scale. */
  samplePrice: string
}
