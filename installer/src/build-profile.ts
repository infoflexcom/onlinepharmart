import { getCurrency, type CurrencyDefinition } from '../../src/currency/catalog'
import { ALLOWLISTED_COMPONENTS } from './download-allowlist'

/**
 * The vendor's per-build settings, as Build Studio writes them and the installer and app read them.
 *
 * Until now the installer's default currency was a constant (`NGN`) and the currency page was always editable.
 * The brief needs both to be a property of the *build*: a vendor selling into Ghana ships a build that preselects
 * Cedis, and a vendor selling one build per country can lock the currency so the customer cannot change it at all.
 *
 * This file is the contract between three programs that never run together:
 *
 *   - **Build Studio** writes the file (a vendor clicking buttons on a Windows machine);
 *   - **the installer** compiles the values in through the generated header, so the currency page opens on the
 *     right row and, when locked, cannot be edited;
 *   - **the app** reads the same values at first run, so a build whose currency is locked shows it read-only on the
 *     first-run setup screen too — the lock is not an installer-only gesture that the customer can ignore by
 *     reinstalling the app separately.
 *
 * Everything here is deliberately plain data with no I/O. The validation lives here rather than in Build Studio's
 * UI because these values are compiled into a distributable: a bad one must be impossible to write, not merely
 * awkward to type.
 */

export const BUILD_PROFILE_FORMAT = 'infoflex-build-profile'
export const BUILD_PROFILE_VERSION = 1
export const BUILD_PROFILE_FILENAME = 'build-profile.json'

/** The period choices Build Studio offers. `null` means no limit, which is the default. */
export const ONSITE_PERIOD_CHOICES: readonly (number | null)[] = [null, 1, 2, 3, 5, 10]

export interface BuildProfile {
  format: typeof BUILD_PROFILE_FORMAT
  version: typeof BUILD_PROFILE_VERSION
  /** The build's version string, shown in the installer's welcome page and the app's About box. */
  appVersion: string
  /** The currency the installer's list opens on, and the app's first-run default when nothing else applies. */
  defaultCurrencyCode: string
  /**
   * When true the customer cannot change the currency: the installer shows it read-only and the setup screen
   * refuses to change it. False leaves the choice with the customer, which is the normal case.
   */
  lockCurrency: boolean
  /** No limit (null) unless the vendor sets one. Enforced by the app's on-site activation, not by the installer. */
  maximumOnsitePeriodYears: number | null
  /** The Vendor Cloud address embedded in the app; null for a build with no cloud. */
  licenseServerUrl: string | null
  /**
   * What the build can supply at release time, as distinct from what the vendor typed.
   *
   * Only the release tooling writes this, and only for a build that is meant to be shipped: the verified SHA-256 of
   * the VC++ redistributable it fetched and checked, plus a note of where it came from. Absent (or the all-zero
   * placeholder) means "a development build", which may exist but may never be released -- see
   * `installer/src/prerequisite-release.ts` and the release script's `assertReleasePin`.
   *
   * It lives in the profile rather than in `download-allowlist.ts` so that pinning a release does not edit a source
   * file: the digest travels with the build that used it, and two builds of different ages cannot disagree about which
   * binary they carry.
   */
  /**
   * The verified components this build carries. Absent or empty means a development build; see
   * `installer/src/prerequisite-release.ts`.
   */
  prerequisites?: BuildPrerequisitePin[]
}

/**
 * One verified component, recorded as the release record of what the build carries.
 *
 * This was a single optional field (`prerequisite?:`) until it became clear what the shape costs: `download-allowlist.ts`
 * is written as a table so a second component is an entry, not a refactor, and a single-value field would have made the
 * installer build silently carry the first one only. It is now a list, so adding a component to the allowlist cannot
 * lose its pin without something having to be deleted.
 */
export interface BuildPrerequisitePin {
  /** Which allowlisted component this pins. `id` was previously the literal 'vcredist-x64', which made the pin unable
   *  to describe anything else. */
  id: string
  sha256: string
  sizeBytes: number
  /** The Microsoft version string, as read from the file, for a person to compare on a real PC. */
  microsoftVersion: string
  /** The official URL it came from. */
  url: string
  /** ISO timestamp of the fetch, so a stale pin is visible rather than mysterious. */
  fetchedAt: string
}

export interface BuildProfileProblem {
  field: keyof BuildProfile | 'format' | 'version' | 'prerequisite'
  message: string
}

/** The profile a plain `npm run` build produces: Naira, unlocked, no period cap, no cloud. */
export function defaultBuildProfile(): BuildProfile {
  return {
    format: BUILD_PROFILE_FORMAT,
    version: BUILD_PROFILE_VERSION,
    appVersion: '0.1.0',
    defaultCurrencyCode: 'NGN',
    lockCurrency: false,
    maximumOnsitePeriodYears: null,
    licenseServerUrl: null,
  }
}

/**
 * Why a profile cannot be built, or an empty list if it can.
 *
 * Returned as a list rather than thrown one-at-a-time so Build Studio can show every problem at once — a vendor
 * fixing a form one error per build attempt is a bad way to spend an afternoon.
 */
export function buildProfileProblems(profile: BuildProfile): BuildProfileProblem[] {
  const problems: BuildProfileProblem[] = []
  if (profile.format !== BUILD_PROFILE_FORMAT) {
    problems.push({ field: 'format', message: `Unknown profile format "${String(profile.format)}".` })
  }
  if (profile.version !== BUILD_PROFILE_VERSION) {
    problems.push({ field: 'version', message: `This build profile is version ${String(profile.version)}; this version of the tools reads version ${BUILD_PROFILE_VERSION}.` })
  }
  if (typeof profile.appVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(profile.appVersion)) {
    problems.push({ field: 'appVersion', message: 'The version must look like 1.4.2 (numbers separated by dots).' })
  }
  if (profile.prerequisites !== undefined) {
    if (!Array.isArray(profile.prerequisites)) {
      problems.push({ field: 'prerequisite', message: 'The release prerequisite record must be a list.' })
    } else {
      const seen = new Set<string>()
      for (const pin of profile.prerequisites) {
        if (pin === null || typeof pin !== 'object') {
          problems.push({ field: 'prerequisite', message: 'The release prerequisite record is not an object.' })
        } else if (typeof pin.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(pin.sha256)) {
          problems.push({
            field: 'prerequisite',
            message: 'The release prerequisite checksum must be 64 lowercase hexadecimal characters.',
          })
        } else if (!ALLOWLISTED_COMPONENTS.some((component) => component.id === pin.id)) {
          // Checked against the allowlist rather than a literal, so a component added to the table cannot be pinned
          // without this validation knowing about it -- and a pin for something that is not on the allowlist is
          // refused rather than carried into a build.
          problems.push({ field: 'prerequisite', message: `Unknown prerequisite "${String(pin.id)}".` })
        } else if (seen.has(pin.id)) {
          problems.push({ field: 'prerequisite', message: `"${pin.id}" is pinned twice.` })
        }
        seen.add(String((pin as { id?: unknown }).id))
      }
    }
  }
  const currency = getCurrency(profile.defaultCurrencyCode)
  if (!currency) {
    problems.push({
      field: 'defaultCurrencyCode',
      message: `"${profile.defaultCurrencyCode}" is not a currency in the built-in list. Choose one from the list.`,
    })
  }
  if (profile.maximumOnsitePeriodYears !== null) {
    if (!ONSITE_PERIOD_CHOICES.includes(profile.maximumOnsitePeriodYears)) {
      problems.push({
        field: 'maximumOnsitePeriodYears',
        message: 'The maximum on-site licence period must be No limit, 1, 2, 3, 5 or 10 years.',
      })
    }
  }
  if (profile.licenseServerUrl !== null) {
    const problem = serverUrlProblem(profile.licenseServerUrl)
    if (problem) problems.push({ field: 'licenseServerUrl', message: problem })
  }
  return problems
}

export function validateBuildProfile(profile: BuildProfile): BuildProfile {
  const problems = buildProfileProblems(profile)
  if (problems.length > 0) throw new Error(problems.map((problem) => problem.message).join(' '))
  return profile
}

/**
 * The cloud address rule: HTTPS, or plain HTTP only on the machine itself.
 *
 * A build embeds this address and sends licence check-ins to it. Plain HTTP to a real host would send a licence
 * key over the open internet, which is exactly the sort of mistake a vendor clicking through a form could make, so
 * the only exceptions are the loopback addresses used for a local test run.
 */
export function serverUrlProblem(value: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return 'Enter the Vendor Cloud address, or leave it blank for no cloud.'
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    return 'That does not look like an address. It should start with https://'
  }
  if (parsed.username || parsed.password) return 'Do not put a username or password in the address.'
  if (parsed.search || parsed.hash) return 'Do not include a query string or # in the address.'
  if (parsed.protocol === 'https:') return null
  if (parsed.protocol === 'http:') {
    const host = parsed.hostname.replace(/^\[|\]$/gu, '')
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return null
    return 'Use https:// for a real address. Plain http:// is only allowed for a test server on this computer.'
  }
  return 'The address must start with https://'
}

/** Parses a profile file, returning null for anything unusable rather than throwing at the vendor. */
export function parseBuildProfile(text: string): BuildProfile | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (record.format !== BUILD_PROFILE_FORMAT || record.version !== BUILD_PROFILE_VERSION) return null
  const profile: BuildProfile = {
    format: BUILD_PROFILE_FORMAT,
    version: BUILD_PROFILE_VERSION,
    appVersion: typeof record.appVersion === 'string' ? record.appVersion : '',
    defaultCurrencyCode: typeof record.defaultCurrencyCode === 'string' ? record.defaultCurrencyCode.toUpperCase() : '',
    lockCurrency: record.lockCurrency === true,
    maximumOnsitePeriodYears: typeof record.maximumOnsitePeriodYears === 'number' ? record.maximumOnsitePeriodYears : null,
    licenseServerUrl: typeof record.licenseServerUrl === 'string' && record.licenseServerUrl.trim() ? record.licenseServerUrl.trim() : null,
  }
  // The release prerequisite pin, when the file carries one. Parsed explicitly rather than spread: a profile is a
  // document a vendor can edit, so an unknown field must not become a value the release trusts.
  const pins = record.prerequisites
  if (Array.isArray(pins)) {
    const parsed: BuildPrerequisitePin[] = []
    for (const entry of pins) {
      if (!entry || typeof entry !== 'object') continue
      const fields = entry as Record<string, unknown>
      if (
        typeof fields.id === 'string' &&
        typeof fields.sha256 === 'string' &&
        typeof fields.sizeBytes === 'number' &&
        typeof fields.microsoftVersion === 'string' &&
        typeof fields.url === 'string' &&
        typeof fields.fetchedAt === 'string'
      ) {
        parsed.push({
          id: fields.id,
          sha256: fields.sha256,
          sizeBytes: fields.sizeBytes,
          microsoftVersion: fields.microsoftVersion,
          url: fields.url,
          fetchedAt: fields.fetchedAt,
        })
      }
    }
    if (parsed.length > 0) profile.prerequisites = parsed
  }
  return buildProfileProblems(profile).length === 0 ? profile : null
}

export function serializeBuildProfile(profile: BuildProfile): string {
  const ordered: BuildProfile = {
    format: BUILD_PROFILE_FORMAT,
    version: BUILD_PROFILE_VERSION,
    appVersion: profile.appVersion,
    defaultCurrencyCode: profile.defaultCurrencyCode.toUpperCase(),
    lockCurrency: profile.lockCurrency,
    maximumOnsitePeriodYears: profile.maximumOnsitePeriodYears,
    licenseServerUrl: profile.licenseServerUrl,
  }
  // Carried through when present. A profile written by Build Studio has no pin; the release step adds one, and
  // `installer:script` re-serialises the profile into `installer/nsis/`, so dropping it here would lose the pin
  // between generating the header and building the offline installer.
  if (profile.prerequisites && profile.prerequisites.length > 0) ordered.prerequisites = profile.prerequisites
  return `${JSON.stringify(ordered, null, 2)}\n`
}

/**
 * Reads the build profile embedded beside the app, returning null when there is none.
 *
 * A build made before Build Studio existed has no profile file, which is the ordinary "npm run" build; that must
 * keep working exactly as it did, so a missing file is not an error.
 */
export function parseBuildProfileOrNull(text: string): BuildProfile | null {
  return parseBuildProfile(text)
}

/** The currency a build preselects, resolved to its full definition for the pages that need to display it. */
export function buildDefaultCurrency(profile: BuildProfile): CurrencyDefinition {
  const currency = getCurrency(profile.defaultCurrencyCode)
  if (!currency) throw new Error(`The build's currency "${profile.defaultCurrencyCode}" is not in the currency list.`)
  return currency
}

/**
 * What the installer's currency page should do for a given build.
 *
 * - a locked build shows one currency, read-only, with no list and no "Custom currency" link;
 * - an unlocked build opens the list on the build's default and lets the customer change it.
 */
export function installerCurrencyPageMode(profile: BuildProfile): 'locked' | 'editable' {
  return profile.lockCurrency ? 'locked' : 'editable'
}

/** The row the dropdown should select on opening: the build's default currency, never row 0 by accident. */
export function installerDefaultCurrencyIndex(profile: BuildProfile, currencies: readonly { code: string }[]): number {
  const index = currencies.findIndex((currency) => currency.code === profile.defaultCurrencyCode.toUpperCase())
  return index < 0 ? 0 : index
}
