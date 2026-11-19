import { resolve } from 'node:path'
import { CURRENCIES } from '../../src/currency/catalog'
import {
  currencyExample, INSTALLER_MAX_PASSWORD_ATTEMPTS, INSTALLER_PASSWORD_HASH,
} from './installer-policy'
import {
  buildDefaultCurrency, defaultBuildProfile, installerDefaultCurrencyIndex, validateBuildProfile, type BuildProfile,
} from './build-profile'
import { ALLOWED_DOWNLOAD_HOSTS, ALLOWLISTED_COMPONENTS, type AllowlistedComponent } from './download-allowlist'
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

/**
 * @param profile The vendor's build settings. Defaulted so every existing caller and test keeps working, and so a
 * plain `npm run` build behaves exactly as before: Naira, unlocked, no cap. Build Studio passes the real profile.
 */
/**
 * The component the header describes, with a release pin applied when the profile carries one.
 *
 * `download-allowlist.ts` keeps the all-zero digest on purpose: a development build must fail closed rather than run
 * an unverified binary. A release build knows the digest because its release job fetched and verified the file, and it
 * records that in the profile. So the profile wins when it has one, and the placeholder is what remains otherwise --
 * there is no third case, and never a case where a real pin is ignored in favour of the zeros.
 */
export function componentForProfile(profile: BuildProfile): AllowlistedComponent | undefined {
  // The installer describes ONE component today: `generated.nsh` emits a single `VCREDIST_*` family and
  // `installer.nsi` downloads, verifies and runs one file. A profile that pins more than one is not something this
  // build can honour, so it stops rather than bundling the first and quietly ignoring the rest -- a build that carries
  // two verified components and says it carries one is worse than a build that fails.
  const extra = (profile.prerequisites ?? []).filter((entry) => entry.id !== ALLOWLISTED_COMPONENTS[0]?.id)
  if (extra.length > 0) {
    throw new Error(
      `This build profile pins ${extra.map((entry) => entry.id).join(', ')}, but the installer can only carry ` +
        `${ALLOWLISTED_COMPONENTS[0]?.id ?? 'one component'} today. Remove the other pin(s), or extend ` +
        'generate-installer-script.ts and installer.nsi to emit one set of defines per component. Nothing was built.',
    )
  }
  const [component] = ALLOWLISTED_COMPONENTS
  if (!component) return undefined
  // Matched by ID, not by position. A pin for a component that is not the one this header describes must not be
  // applied to it -- the profile is a document a vendor can edit, and the first entry of a list is not a safe guess.
  const pin = profile.prerequisites?.find((entry) => entry.id === component.id)
  if (!pin) return component
  return { ...component, sha256: pin.sha256, sizeBytes: pin.sizeBytes }
}

export function generateInstallerHeader(profile: BuildProfile = defaultBuildProfile()): string {
  const component = componentForProfile(profile)
  // A profile that cannot be built must fail here rather than compile something half-valid into an installer.
  validateBuildProfile(profile)
  const defaultCurrency = profile.defaultCurrencyCode.toUpperCase()
  const defaultCurrencyDefinition = buildDefaultCurrency(profile)
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
!define INSTALLER_DEFAULT_CURRENCY ${nsisString(defaultCurrency)}
; A locked build shows one currency, read-only; the installer's currency page branches on this.
!define INSTALLER_CURRENCY_LOCKED ${profile.lockCurrency ? 1 : 0}
; The row the dropdown opens on, and the example the locked page shows, both from the same table the app uses.
!define INSTALLER_DEFAULT_INDEX ${installerDefaultCurrencyIndex(profile, CURRENCIES)}
; The vendor's build version, as entered in Build Studio. This is what install-config.json records as appVersion --
; what the vendor shipped -- and it is NOT electron-builder's packaging version, which is a different value. It was
; generated and read by nothing until this phase, so the file recorded the packaging version instead.
!define INSTALLER_APP_VERSION ${nsisString(profile.appVersion)}
!define CUR_DEFAULT_EXAMPLE ${nsisString(currencyExample(defaultCurrencyDefinition))}
!define INSTALLER_CONFIG_DIR ${nsisString(INSTALL_CONFIG_DIRECTORY)}
!define INSTALLER_CONFIG_FILE ${nsisString(INSTALL_CONFIG_FILENAME)}
!define MOBILE_PORT 43110

; The three ALLOWED_HOST_* values are not decoration: the installer refuses to download from any other host, and
; refuses a non-https URL, before NSISdl opens a socket. Until this phase they were generated and read by nothing.
!define VCREDIST_URL ${nsisString(component?.url ?? '')}
!define VCREDIST_PUBLISHER ${nsisString(component?.publisher ?? '')}
!define VCREDIST_SHA256 ${nsisString(component?.sha256 ?? '')}
!define ALLOWED_HOST_1 ${nsisString(ALLOWED_DOWNLOAD_HOSTS[0] ?? '')}
!define ALLOWED_HOST_2 ${nsisString(ALLOWED_DOWNLOAD_HOSTS[1] ?? '')}
!define ALLOWED_HOST_3 ${nsisString(ALLOWED_DOWNLOAD_HOSTS[2] ?? '')}

; One define per field per currency, indexed 0..${CURRENCIES.length - 1}.
${defines}

; ==========================================================================================
; ValidateCurrencyCode — used by silent installs to check a /CURRENCY= argument.
;
; Takes the code in $0. On a match, leaves the canonical code in $3 and its index in $2.
; On no match, leaves $3 empty so the caller can abort with a reason.
;
; This is GENERATED rather than hand-written on purpose. The first version of the silent check was a hand-written
; chain of nine ${'${If}'}s for nine popular currencies, so \`/CURRENCY=UGX\` -- a currency the app knows in full --
; aborted a legitimate install. Generating one branch per catalogue entry means the silent path and the wizard's
; dropdown can never disagree.
; ==========================================================================================
!macro ValidateCurrencyCode
  StrCpy $3 ""
${CURRENCIES.map((currency, index) => `  \${If} $0 == ${nsisString(currency.code)}
    StrCpy $2 "${index}"
    StrCpy $3 ${nsisString(currency.code)}
  \${EndIf}`).join('\n')}
!macroend
`
}

/**
 * The currency dropdown, as its own include.
 *
 * `FillCurrencyList` adds one row per currency; `SetCurrencyFromIndex` maps the selected row back to the fields
 * the install-config needs. Resolving by *index* rather than by parsing the visible label means a translated or
 * re-formatted label cannot change which currency gets installed.
 */
export function generateCurrencyUiInclude(profile: BuildProfile = defaultBuildProfile()): string {
  validateBuildProfile(profile)
  const defaultCurrency = profile.defaultCurrencyCode.toUpperCase()
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
    StrCpy $CurrencyCodeOut "${defaultCurrency}"
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


/**
 * The offline build's prerequisite path, as a generated include.
 *
 * electron-builder offers no way to pass a `-D` define through to makensis, so the path has to arrive as a header the
 * script `!include`s — the same route the currency table and the digest already take. Generating it rather than defining
 * it in the script keeps all three in one place: whatever `build-profile.json` says is what the installer is built with,
 * and there is no second copy to drift.
 *
 * Two shapes, and the difference is the whole point:
 *
 *   - No pin, or the all-zeros placeholder: `PREREQUISITE_INCLUDE` is left undefined. `installer.nsi` guards its `File`
 *     on that define, so a development offline build compiles and simply carries no runtime (which the offline arm then
 *     refuses to install, loudly — see the rollback in InstallPrerequisites).
 *   - A real digest: the define names the cached file, so the offline build bundles it.
 */
export function generatePrerequisiteInclude(
  profile: BuildProfile,
  cacheDirectory = resolve('installer/cache'),
): string {
  const [component] = ALLOWLISTED_COMPONENTS
  const pin = component ? profile.prerequisites?.find((entry) => entry.id === component.id) : undefined
  const pinned = pin !== undefined && /^[0-9a-f]{64}$/u.test(pin.sha256) && pin.sha256 !== '0'.repeat(64)
  const lines = [
    '; Generated by generate-installer-script.ts. Do not edit: the next build overwrites it.',
    ';',
    pinned
      ? `; Release build. The offline installer bundles vc_redist.x64.exe, ${pin.sizeBytes.toLocaleString('en-GB')} bytes,`
      : '; Development build: no verified prerequisite, so the offline installer carries none.',
    pinned ? `; version ${pin.microsoftVersion}, SHA-256 ${pin.sha256}.` : '; The digest in generated.nsh is the all-zero placeholder on purpose.',
  ]
  if (pinned) {
    // ABSOLUTE, and that is not pedantry. `makensis` resolves a `File` path relative to its own working directory, which
    // electron-builder sets to its templates folder -- so a relative path here compiles in the harness and fails in the
    // real offline build with "no files found", the exact class of harness-versus-build divergence this project has
    // been bitten by twice. Resolving at generation time removes the question.
    const absolute = resolve(cacheDirectory, 'vc_redist.x64.exe').replace(/\\/gu, '/')
    lines.push(`!define PREREQUISITE_INCLUDE "${absolute}"`)
  } else {
    lines.push('; PREREQUISITE_INCLUDE is deliberately undefined.')
  }
  return `${lines.join('\n')}\n`
}
