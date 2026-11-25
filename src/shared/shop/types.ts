import type { CurrencyDefinition } from '../currency/catalog'
import type { MoneyDisplayOptions } from '../currency/money'
import type { AdminAccountInput, PublicUser } from '../auth/types'
import type { Edition } from '../../editions'
import type { LicenseSummary } from '../license/types'

export interface ShopProfile {
  name: string
  address: string
  phone: string
  email?: string
  licenceNumber?: string
  taxNumber?: string
  storeLogo?: string | null
  receiptFooter?: string
  thankYouNote?: string
}

export type DocumentLayout = 'THERMAL_80' | 'THERMAL_58' | 'A4_RECEIPT'
export type PaymentMethodSetting = 'CASH' | 'TRANSFER' | 'CARD' | 'CREDIT'
export const PAYMENT_METHOD_SETTINGS: readonly PaymentMethodSetting[] = ['CASH', 'TRANSFER', 'CARD', 'CREDIT']

/** Receipt/VAT/discount/printer/payment/edition options; Admin-only and audit-logged. */
export interface OperationalSettings {
  /** Prints the "Powered by Infoflex" line on customer documents. */
  showPoweredBy: boolean
  documentLayout: DocumentLayout
  vatEnabled: boolean
  /** 0–10000 basis points, i.e. 0–100%. */
  vatRateBasisPoints: number
  /** VAT already contained in retail prices (true) or added on top (false). */
  vatInclusive: boolean
  /** Maximum line/order discount an Admin may configure, 0–10000 basis points. */
  discountLimitBasisPoints: number
  printerName: string
  enabledPaymentMethods: PaymentMethodSetting[]
  /** Days before expiry that stock is highlighted (Pharmacy edition). */
  expiryAlertDays: number
  /** Loyalty points earned per currency unit, in basis points. */
  loyaltyRateBasisPoints: number
  supervisorPinRequired: boolean
  supervisorPinLength: number
  scaleEnabled: boolean
  scalePort: string
}

/** Shop defaults used before first-run setup writes real values (and by the preview/test stubs). */
export const DEFAULT_OPERATIONAL_SETTINGS: OperationalSettings = {
  showPoweredBy: true,
  documentLayout: 'THERMAL_80',
  vatEnabled: false,
  vatRateBasisPoints: 0,
  vatInclusive: false,
  discountLimitBasisPoints: 10_000,
  printerName: '',
  enabledPaymentMethods: ['CASH', 'TRANSFER', 'CARD', 'CREDIT'],
  expiryAlertDays: 90,
  loyaltyRateBasisPoints: 0,
  supervisorPinRequired: true,
  supervisorPinLength: 4,
  scaleEnabled: false,
  scalePort: '',
}

export interface ShopSettings {
  profile: ShopProfile
  currency: CurrencyDefinition
  display: MoneyDisplayOptions
  setupComplete: boolean
  currencyConfirmed: boolean
  currencyLocked: boolean
  /** True when the vendor licence locked the currency, as opposed to a completed transaction. */
  currencyLockedByVendor?: boolean
  idleTimeoutMinutes?: number
  returnWindowDays?: number
  operational: OperationalSettings
}

export interface BackupSummary {
  id: string
  kind: 'AUTOMATIC' | 'MANUAL' | 'RESTORE'
  fileName: string
  /** Display path of the folder the file was written to (or read from, for a restore). */
  location: string
  sizeBytes: number
  currencyCode: string
  appVersion: string
  checksumSha256: string
  actor: string
  detail: string
  createdAt: string
}

export interface BackupStatus {
  automaticEnabled: boolean
  /** ISO timestamp of the most recent successful backup of any kind (null when never). */
  lastBackupAt: string | null
  lastBackupFile: string | null
  automaticFolder: string
  /** Days since the last backup; null when there has never been one. */
  daysSinceBackup: number | null
  /** True when there is no backup or the newest one is older than seven days. */
  stale: boolean
  warning: string | null
  recent: BackupSummary[]
}

export interface BackupResult {
  backup: BackupSummary
  status: BackupStatus
}

export interface RestoreBackupInput {
  folder: string
  fileName: string
  confirmed: boolean
}

export interface RestoreResult {
  restored: true
  backup: BackupSummary
  /** True when the restored database adopted the backup currency into an empty install. */
  adoptedCurrency: boolean
  currencyCode: string
  status: BackupStatus
}

export interface BackupManifest {
  format: 'infoflex-backup'
  formatVersion: 1
  createdAt: string
  appVersion: string
  productName: string
  edition: Edition | null
  currencyCode: string
  storeName: string
  databaseBytes: number
  databaseSha256: string
  /** Table row counts, used to verify a restore and to show what was recovered. */
  rowCounts: Record<string, number>
}

/**
 * How many accounts of each role the Admin wants at first run.
 *
 * ADMIN is absent on purpose: the brief says one Admin exists by default, and the Admin is the account being created
 * on this very form.
 */
export interface TeamSizeInput {
  account: number
  user: number
  supervisor: number
}

export interface FirstRunInput {
  admin: AdminAccountInput
  profile: ShopProfile
  currency: CurrencyDefinition
  display: MoneyDisplayOptions
  currencyConfirmed: boolean
  /** Optional so an older caller, and every existing test, keeps working: absent means no extra seats. */
  teamSize?: TeamSizeInput
}

export interface SetupContext {
  licenseActivated: boolean
  edition: Edition | null
  installerCurrencyCode: string | null
  licenseDefaultCurrencyCode: string | null
  currencyLocked: boolean
  vendorCurrencyLocked: boolean
  initialCurrency: CurrencyDefinition
  productName: string
  /**
   * The licence's seat caps, so the setup form can show them and refuse before the customer submits. `null` means the
   * licence names no cap, which is different from zero.
   */
  seatCaps: { account: number | null; user: number | null; supervisor: number | null }
  /** What the team-size steppers start at. */
  seatDefaults: TeamSizeInput
}

export interface AppInfo {
  appName: string
  productName: string
  appVersion: string
  edition: Edition | null
  runtime: 'desktop' | 'preview'
  /**
   * Which application this is. The login page shows a different rule on each: the Server accepts only the Admin and
   * tells everyone else to use the client app; a client accepts the staff roles. `preview` is a server, because the
   * browser preview has no client to hand over to.
   */
  appRole: 'server' | 'client'
}

export interface BootstrapData {
  appInfo: AppInfo
  settings: ShopSettings
  setupContext: SetupContext
  license: LicenseSummary
  hasUsers: boolean
  currentUser: PublicUser | null
}

export type BusinessEntryKind = 'sale' | 'purchase' | 'return' | 'stock_valuation' | 'day_close'

export interface BusinessEntry {
  id: string
  kind: BusinessEntryKind
  currencyCode: string
  amountMinor: bigint
  storeNameSnapshot: string
  storeAddressSnapshot: string
  storePhoneSnapshot: string
  createdAt: string
}

export interface AuditEvent {
  actor: string
  action: string
  metadata: Record<string, unknown>
  deviceName: string
  ipAddress: string | null
  createdAt: string
}
