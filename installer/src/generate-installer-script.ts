import { CURRENCIES } from '../../src/currency/catalog'
import {
  currencyExample, INSTALLER_DEFAULT_CURRENCY_CODE, INSTALLER_MAX_PASSWORD_ATTEMPTS, INSTALLER_PASSWORD_HASH,
} from './installer-policy'
import { ALLOWED_DOWNLOAD_HOSTS, ALLOWLISTED_COMPONENTS } from './download-allowlist'
import { INSTALL_CONFIG_DIRECTORY, INSTALL_CONFIG_FILENAME } from './install-config'

/**
 * Generates the data the NSIS script compiles in.
 *
 * Two things make this worth having rather than hand-writing the values into the `.nsi`:
 *
 * 1. **The currency table cannot drift.** The dropdown, its search and the live example all come from the same
 *    `CURRENCIES` array the application uses, so a currency added to the app appears in the installer on the next
 *    build and a symbol edited in one place can never disagree with the other.
 * 2. **The password hash is generated, never typed.** The `.nsi` is a build artefact. The hash lives in source,
 *    where it is reviewed and tested, and `containsMasterPassword` is the release guard that fails the build if
 *    the plain text has somehow ended up in the tree.
 *
 * NSIS has no arrays, no loop over compile-time data and no switch, so the currency list is emitted as explicit
 * lines: one `!define` per field, one list-add per currency, and one comparison arm per currency. Verbose, but
 * every line is something a person — and `check-nsis-script.ts` — can read.
 */

/** NSIS strings are quoted; `$` is its variable sigil, so it must be doubled, and `"` escaped. */
export function nsisString(value: string): string {
  return `"${value.replace(/\$/gu, '$$$$').replace(/"/gu, '$\\"')}"`
}

function currencyFields(currency: (typeof CURRENCIES)[number]): Array<[string, string]> {
  return [
    ['CODE', currency.code],
    ['NAME', currency.name],
    ['SYMBOL', currency.symbol],
    ['DECIMALS', String(currency.decimalPlaces)],
    ['POSITION', currency.symbolPosition],
    ['THOUSANDS', currency.thousandsSeparator],
    ['DECIMAL', currency.decimalSeparator],
    ['EXAMPLE', currencyExample(currency)],
  ]
}

/** One tab-separated row per currency, kept for the tests and for the docs table. */
export function currencyTableBlock(): string {
  return CURRENCIES.map((currency) => currencyFields(currency).slice(0, 7).map(([, value]) => value).concat(currencyExample(currency)).join('\t')).join('\n')
}

export function generateInstallerHeader(): string {
  const [component] = ALLOWLISTED_COMPONENTS
  const defines = CURRENCIES
    .map((currency, index) => currencyFields(currency).map(([key, value]) => `!define CUR_${index}_${key} ${nsisString(value)}`).join('\n'))
    .join('\n')

  return `; ==========================================================================================
; GENERATED FILE — do not edit. Source: installer/src/generate-installer-script.ts
;
; Regenerate with: npm run installer:script
; ==========================================================================================

!define INSTALLER_PASSWORD_ITERATIONS ${INSTALLER_PASSWORD_HASH.iterations}
!define INSTALLER_PASSWORD_SALT ${nsisString(INSTALLER_PASSWORD_HASH.salt)}
!define INSTALLER_PASSWORD_HASH ${nsisString(INSTALLER_PASSWORD_HASH.hash)}
!define INSTALLER_MAX_ATTEMPTS ${INSTALLER_MAX_PASSWORD_ATTEMPTS}
!define INSTALLER_DEFAULT_CURRENCY ${nsisString(INSTALLER_DEFAULT_CURRENCY_CODE)}
!define INSTALLER_CONFIG_DIR ${nsisString(INSTALL_CONFIG_DIRECTORY)}
!define INSTALLER_CONFIG_FILE ${nsisString(INSTALL_CONFIG_FILENAME)}
!define MOBILE_PORT 43110

!define VCREDIST_URL ${nsisString(component?.url ?? '')}
!define VCREDIST_PUBLISHER ${nsisString(component?.publisher ?? '')}
!define VCREDIST_SHA256 ${nsisString(component?.sha256 ?? '')}
!define VCREDIST_SIZE ${component?.sizeBytes ?? 0}
!define ALLOWED_HOST_1 ${nsisString(ALLOWED_DOWNLOAD_HOSTS[0] ?? '')}
!define ALLOWED_HOST_2 ${nsisString(ALLOWED_DOWNLOAD_HOSTS[1] ?? '')}
!define ALLOWED_HOST_3 ${nsisString(ALLOWED_DOWNLOAD_HOSTS[2] ?? '')}

!define CURRENCY_COUNT ${CURRENCIES.length}${CURRENCIES.length === 0 ? '' : ''}

; One define per field per currency, indexed 0..${CURRENCIES.length - 1}.
${defines}
`
}

/**
 * The currency dropdown, as its own include.
 *
 * `FillCurrencyList` adds one row per currency; `SetCurrencyFromIndex` maps the selected row back to the fields
 * the install-config needs. Resolving by *index* rather than by parsing the visible label means a translated or
 * re-formatted label cannot change which currency gets installed.
 */
export function generateCurrencyUiInclude(): string {
  const adds = CURRENCIES.map((currency) => `  \${NSD_LB_AddString} $CurrencyList ${nsisString(`${currency.code} - ${currency.name} (${currency.symbol})`)}`).join('\n')
  const chain = CURRENCIES.map((currency, index) => {
    const guard = index === 0 ? '  ${If} $R0 == "0"' : `  \${ElseIf} $R0 == "${index}"`
    return [
      guard,
      `    StrCpy $CurrencyCodeOut ${nsisString(currency.code)}`,
      `    StrCpy $CurrencyNameOut ${nsisString(currency.name)}`,
      `    StrCpy $CurrencySymbolOut ${nsisString(currency.symbol)}`,
      `    StrCpy $CurrencyDecimalsOut "${currency.decimalPlaces}"`,
      `    StrCpy $CurrencyPositionOut ${nsisString(currency.symbolPosition)}`,
      `    StrCpy $CurrencyThousandsOut ${nsisString(currency.thousandsSeparator)}`,
      `    StrCpy $CurrencyDecimalOut ${nsisString(currency.decimalSeparator)}`,
    ].join('\n')
  }).join('\n')

  return `; GENERATED — the currency dropdown and the index-to-fields mapping.
!macro FillCurrencyList
${adds}
!macroend

; Copies the chosen row's fields into the variables the installer uses. $R0 is the selected index; an empty
; selection falls back to the default currency rather than to whichever row happened to be first.
!macro SetCurrencyFromIndex
${chain}
  \${EndIf}
  \${If} $CurrencyCodeOut == ""
    StrCpy $CurrencyCodeOut "${INSTALLER_DEFAULT_CURRENCY_CODE}"
  \${EndIf}
!macroend
`
}

/**
 * The release guard: the master password must not appear in any installer source or generated output.
 *
 * Checked in the test suite too; here because this is the last moment before the string would be compiled into a
 * distributable file.
 */
export function containsMasterPassword(text: string, masterPassword: string): boolean {
  if (masterPassword.length < 8) return false
  return text.toLowerCase().includes(masterPassword.toLowerCase())
}
