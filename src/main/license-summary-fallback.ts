import type { Edition } from '../editions'
import type { LicenseSummary } from '../shared/license/types'

export function fallbackLicenseSummary(active: boolean, edition: Edition | null = null): LicenseSummary {
  return {
    status: active ? 'active' : 'unactivated',
    canUse: active,
    licenseId: active ? 'test-policy' : null,
    source: active ? 'online' : null,
    edition: active ? edition : null,
    startsAt: null,
    endsAt: null,
    defaultCurrencyCode: null,
    lockCurrency: false,
    features: { mobileLan: true, mobileInternet: true },
    adminPhoneLimit: 100,
    graceDays: 0,
    lastOnlineCheck: null,
    reportedToPortal: false,
    vendorConfigured: false,
    maximumOnsitePeriodYears: null,
    licenseServerUrl: null,
    message: active ? 'License is active.' : 'Activate a valid Infoflex license before setup or sign-in.',
  }
}
