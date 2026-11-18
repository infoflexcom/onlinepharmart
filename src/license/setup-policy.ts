import type { Edition } from '../editions'

/** Only an active or grace-valid token verified by the main-process LicenseManager may supply this policy. */
export interface VerifiedLicensePolicy {
  licenseId: string
  edition: Edition
  defaultCurrencyCode: string | null
  lockCurrency: boolean
}

export interface LicensePolicyProvider {
  getVerifiedPolicy(): VerifiedLicensePolicy | null | Promise<VerifiedLicensePolicy | null>
}
