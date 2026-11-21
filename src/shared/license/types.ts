import type { Edition } from '../../editions'

export type LicenseSource = 'online' | 'file' | 'onsite'
export type SignedLicenseStatus = 'active' | 'suspended' | 'revoked'
export type LicenseRuntimeStatus =
  | 'unactivated'
  | 'active'
  | 'grace'
  | 'expired'
  | 'not_yet_valid'
  | 'suspended'
  | 'revoked'
  | 'machine_mismatch'
  | 'clock_rollback'
  | 'tampered'
  | 'invalid'

export interface LicenseFeatures {
  mobileLan: boolean
  mobileInternet: boolean
}

/** The signed, machine-bound entitlement. End dates are exclusive UTC instants. */
export interface LicenseClaims {
  licenseId: string
  machineId: string
  edition: Edition
  startsAt: string
  endsAt: string
  issuedAt: string
  status: SignedLicenseStatus
  source: LicenseSource
  defaultCurrencyCode: string | null
  lockCurrency: boolean
  features: LicenseFeatures
  adminPhoneLimit: number
  graceDays: number
}

export interface LicenseSummary {
  status: LicenseRuntimeStatus
  canUse: boolean
  licenseId: string | null
  source: LicenseSource | null
  edition: Edition | null
  startsAt: string | null
  endsAt: string | null
  defaultCurrencyCode: string | null
  lockCurrency: boolean
  features: LicenseFeatures
  adminPhoneLimit: number
  graceDays: number
  lastOnlineCheck: string | null
  reportedToPortal: boolean
  vendorConfigured: boolean
  maximumOnsitePeriodYears: number | null
  licenseServerUrl: string | null
  message: string
}

export interface OnsiteActivationInput {
  masterPassword: string
  edition: Edition
  startsOn: string
  endsOn: string
  defaultCurrencyCode: string | null
  lockCurrency: boolean
  features: LicenseFeatures
  adminPhoneLimit: number
}

export interface OnlineActivationInput {
  activationKey: string
  serverUrl: string
}

export interface LicenseCheckInResult {
  checkedAt: string
  updated: boolean
  status: LicenseRuntimeStatus
  message: string
}

export interface VendorPolicyFile {
  format: 'infoflex-vendor-license-policy'
  version: 1
  masterPasswordHash: {
    algorithm: 'PBKDF2-SHA256'
    iterations: number
    salt: string
    hash: string
  }
  maximumOnsitePeriodYears: number | null
  licenseServerUrl: string | null
  trustedEd25519Keys: Record<string, string>
}
