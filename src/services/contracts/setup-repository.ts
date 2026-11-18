import type { CurrencyDefinition } from '../../currency/catalog'

export interface SetupPreferencesRepository {
  getInstallerCurrencyCode(): string | null
  isCurrencyLockedByVendor(): boolean
  getCurrencyDefinition(code: string): CurrencyDefinition | null
  setVendorCurrencyLock(): void
}
