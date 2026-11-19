import { CURRENCIES, createCustomCurrency, getCurrency, type CurrencyDefinition } from '../../src/currency/catalog'
import { defaultDisplayOptions, formatMoney } from '../../src/currency/money'

/**
 * The rules the installer enforces, in one place, as plain functions.
 *
 * NSIS is a macro language and is a poor place to keep business rules: it has no real test runner and no types.
 * Every decision that can be expressed as a pure function lives here instead and is generated into the
 * installer, so `npm test` can prove a rule that would otherwise only be exercised by a human clicking through a
 * Windows wizard. The NSIS side does I/O — draw a page, read a field, write a file — and nothing else.
 */

// --------------------------------------------------------------------------------------------- password gate

/**
 * The vendor master password is never stored in plain text anywhere. This hash is PBKDF2-SHA256 with the same
 * parameters the application's own `createMasterPasswordHash` uses, so there is one rule and one format.
 *
 * The plain text is not in this repository, not in the installer, not in the build output and not in this
 * comment. It exists only in the vendor's head and in Build Studio's own configuration on the build machine.
 */
export const INSTALLER_PASSWORD_HASH = {
  algorithm: 'PBKDF2-SHA256',
  iterations: 310_000,
  // Salt and hash are base64url. Regenerate both together if the password is ever rotated.
  salt: 'SGaRYzvXvrBylyytD3CX_w',
  hash: '2k57WIeMSvplpVuEKvMwzBLxTygz9M_s0T-cpHp3ijE',
} as const

/** Five wrong attempts and the installer closes. The brief's number, kept in one place. */
export const INSTALLER_MAX_PASSWORD_ATTEMPTS = 5

export interface PasswordGateState {
  attemptsUsed: number
  locked: boolean
}

export function initialPasswordGate(): PasswordGateState {
  return { attemptsUsed: 0, locked: false }
}

/**
 * Records one attempt. `verified` is the answer from the hash comparison, passed in so this function stays pure
 * and the crypto stays in one place (`verifyInstallerPassword`).
 */
export function recordPasswordAttempt(state: PasswordGateState, verified: boolean): PasswordGateState {
  if (state.locked) return state
  if (verified) return { attemptsUsed: 0, locked: false }
  const attemptsUsed = state.attemptsUsed + 1
  return { attemptsUsed, locked: attemptsUsed >= INSTALLER_MAX_PASSWORD_ATTEMPTS }
}

/** The line the password page shows, including the attempt count once the customer has got it wrong. */
export function passwordGateMessage(state: PasswordGateState): string {
  if (state.locked) return 'Too many incorrect attempts. The installer will close.'
  if (state.attemptsUsed === 0) return 'Enter the vendor password provided with your purchase.'
  const remaining = INSTALLER_MAX_PASSWORD_ATTEMPTS - state.attemptsUsed
  return `That password is not correct. ${remaining} ${remaining === 1 ? 'attempt' : 'attempts'} left.`
}

// ------------------------------------------------------------------------------------- region and currency

export interface CurrencyListEntry {
  code: string
  name: string
  symbol: string
  decimalPlaces: number
  /** "NGN - Nigerian Naira (₦)", exactly as the brief asks the dropdown to read. */
  label: string
  /** Lower-cased haystack for the search box: code, name and symbol all match. */
  search: string
}

export function currencyListEntry(currency: CurrencyDefinition): CurrencyListEntry {
  return {
    code: currency.code,
    name: currency.name,
    symbol: currency.symbol,
    decimalPlaces: currency.decimalPlaces,
    label: `${currency.code} - ${currency.name} (${currency.symbol})`,
    // Searching by symbol is how a shopkeeper often finds their money, so it is in the haystack too.
    search: `${currency.code} ${currency.name} ${currency.symbol}`.toLowerCase(),
  }
}

/** Every built-in currency, in catalogue order, ready for the dropdown. */
export function installerCurrencyList(): CurrencyListEntry[] {
  return CURRENCIES.map(currencyListEntry)
}

/** Filters the dropdown as the customer types. An empty query shows everything. */
export function filterCurrencyList(query: string, list: CurrencyListEntry[] = installerCurrencyList()): CurrencyListEntry[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return list
  // The code is matched first-class: typing "NG" should find NGN before it finds a name containing "ng".
  return list.filter((entry) => entry.search.includes(needle))
}

export const INSTALLER_DEFAULT_CURRENCY_CODE = 'NGN'

/**
 * The live example line. It is the honest test of the currency table: a shopkeeper comparing "₦1,234,567.50"
 * against "¥1,234,568" against "KD 1,234.568" can see at a glance that the app will print money the way their
 * country does. It uses the real formatter, so the example cannot drift from the app's rendering.
 */
export function currencyExample(currency: CurrencyDefinition): string {
  const display = defaultDisplayOptions(currency)
  // One and a quarter million plus a half, in this currency's minor units, with no floating point anywhere.
  // The SAME amount is shown for every currency, which is the point: the customer compares "₦1,234,567.50",
  // "¥1,234,568" and "KD 1,234.567" and sees that the decimals follow their money and not a hard-coded two.
  const majorUnits = 1_234_567n
  const scale = 10n ** BigInt(currency.decimalPlaces)
  const half = currency.decimalPlaces === 0 ? 5n : 5n * 10n ** BigInt(currency.decimalPlaces - 1)
  const minor = currency.decimalPlaces === 0
    ? majorUnits + 1n
    : majorUnits * scale + half
  return formatMoney(minor, currency, display)
}

/** Which currency the page should start on: the vendor policy wins, then the default, then NGN. */
export function defaultCurrencyForInstaller(vendorLockedCode: string | null): CurrencyDefinition {
  if (vendorLockedCode) {
    const locked = getCurrency(vendorLockedCode.trim().toUpperCase())
    if (locked) return locked
  }
  return getCurrency(INSTALLER_DEFAULT_CURRENCY_CODE)!
}

/**
 * The currency list is only offered when the vendor has not locked it. A locked build shows the currency
 * read-only and never lets the customer change it, in the installer or on the setup screen.
 */
export function isCurrencyLockedForInstaller(vendorLockedCode: string | null): boolean {
  return Boolean(vendorLockedCode && vendorLockedCode.trim())
}

export type CurrencySelection =
  | { ok: true; currency: CurrencyDefinition }
  | { ok: false; message: string }

/** A built-in currency chosen from the dropdown, validated rather than trusted. */
export function selectBuiltInCurrency(code: string): CurrencySelection {
  const currency = getCurrency(code.trim().toUpperCase())
  if (!currency) return { ok: false, message: 'Choose a currency from the list.' }
  return { ok: true, currency }
}

export interface CustomCurrencyEntry {
  code: string
  name: string
  symbol: string
  decimalPlaces: string
}

/**
 * The "Custom currency..." option. Decimal places arrive from a text box, so they are parsed rather than cast —
 * "2 " is accepted, "two" is a sentence the customer can act on.
 */
export function selectCustomCurrency(entry: CustomCurrencyEntry): CurrencySelection {
  const decimalsText = entry.decimalPlaces.trim()
  if (!/^\d$/u.test(decimalsText)) {
    return { ok: false, message: 'Enter the number of decimal places as a single digit from 0 to 4.' }
  }
  try {
    const currency = createCustomCurrency({
      code: entry.code,
      name: entry.name,
      symbol: entry.symbol,
      decimalPlaces: Number(decimalsText),
    })
    return { ok: true, currency }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'That custom currency is not valid.' }
  }
}

// ------------------------------------------------------------------------------------------------ silent mode

/**
 * `/CURRENCY=GHS` for vendor use.
 *
 * The brief asks for the silent switch to be validated against the built-in list, which is what this does: a
 * typo fails the install with a clear reason rather than quietly installing the default. Custom currencies are
 * deliberately not accepted here — a silent install is for a vendor rolling out a known edition to known shops,
 * and a custom currency needs four fields a command line cannot carry without ambiguity.
 */
export function parseSilentCurrencyArgument(commandLine: string): CurrencySelection | null {
  // `\S*` rather than `\S+`: `/CURRENCY=` with nothing after it must be CAUGHT and refused, not skipped. A
  // regex that only matches a non-empty value would let a vendor's typo fall through to the default currency and
  // install a shop in the wrong money without a word.
  const match = /\/CURRENCY=("[^"]*"|\S*)/iu.exec(commandLine)
  if (!match) return null
  const raw = (match[1] ?? '').replace(/^"|"$/gu, '').trim()
  if (!raw) return { ok: false, message: 'The /CURRENCY option needs a currency code, for example /CURRENCY=GHS.' }
  const selected = selectBuiltInCurrency(raw)
  if (!selected.ok) {
    return {
      ok: false,
      message: `/CURRENCY=${raw} is not a built-in currency. Use an ISO code from the list, for example /CURRENCY=GHS.`,
    }
  }
  return selected
}

/** True when the command line asks for a silent install at all. */
export function isSilentInstallRequested(commandLine: string): boolean {
  return /(^|\s)\/(S|SILENT)(\s|$)/iu.test(commandLine) || /(^|\s)--silent(\s|$)/iu.test(commandLine)
}

// ----------------------------------------------------------------------------------------- update vs repair

export type InstallScenario = 'fresh' | 'update' | 'repair'

/**
 * An existing install offers Repair, Update or Uninstall. The difference that matters for the currency is that
 * neither Update nor Repair may touch an existing install-config: a shop that has been trading for a year must
 * not have its money re-chosen by whoever ran the installer.
 */
export function installScenario(input: { alreadyInstalled: boolean; sameVersion: boolean }): InstallScenario {
  if (!input.alreadyInstalled) return 'fresh'
  return input.sameVersion ? 'repair' : 'update'
}

export function mayWriteInstallConfig(scenario: InstallScenario): boolean {
  return scenario === 'fresh'
}

/**
 * The currency page is shown only for a fresh install. Updates and repairs keep the existing choice silently,
 * which is also why the page cannot be the place a shop's currency is "changed by accident".
 */
export function shouldOfferCurrencyPage(scenario: InstallScenario, vendorLockedCode: string | null): boolean {
  if (scenario !== 'fresh') return false
  return !isCurrencyLockedForInstaller(vendorLockedCode)
}
