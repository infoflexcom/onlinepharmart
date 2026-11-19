import { readFileSync } from 'node:fs'
import { installConfigPath, parseInstallConfig, type InstallConfig } from '../../installer/src/install-config'
import type { CurrencyDefinition } from '../currency/catalog'

/**
 * How the installed app learns what the installer was told.
 *
 * Two sources exist, and the order between them matters: an explicit `INFOFLEX_INSTALLER_CURRENCY` environment
 * variable is a deliberate override somebody typed, so it wins; the `install-config.json` the installer wrote is
 * the normal path. `%ProgramData%` is read through the environment rather than a hard-coded `C:\ProgramData`
 * because Windows may have been installed elsewhere, and a shop with a relocated ProgramData would otherwise be
 * silently ignored.
 *
 * Everything about this module is defensive on purpose. It runs at startup, before any window exists, on a
 * machine that may have been upgraded, hand-edited or half-installed. A missing, unreadable or corrupt file must
 * never stop the app opening — the worst outcome allowed is "the customer picks the currency on the setup screen
 * themselves", which is what a shop with no installer config does anyway.
 */

export interface InstallConfigSources {
  /** `process.env.INFOFLEX_INSTALLER_CURRENCY`, if set. */
  environmentOverride: string | null
  /** `process.env.ProgramData`, if set. */
  programData: string | null
  /** Injected file read so this module can be tested without a Windows machine. */
  readFile?: (path: string) => string
}

export interface InstallerCurrencyResolution {
  /** The currency code to preselect, or null when nothing usable was found. */
  code: string | null
  /** Where the answer came from, for the startup log and for support calls. */
  source: 'environment' | 'install-config' | 'none'
  /** The parsed file, when there was one, so a caller can show when it was written. */
  config: InstallConfig | null
  /** Plain-words note when a file existed but could not be used. */
  problem: string | null
  /** The full definition when the installer recorded a custom currency, which must be registered. */
  customCurrency: CurrencyDefinition | null
}

/** Turns the file's custom-currency record into the shape the repository registers. */
export function customCurrencyFromConfig(config: InstallConfig): CurrencyDefinition | null {
  if (!config.currency.isCustom) return null
  return {
    code: config.currency.code,
    name: config.currency.name,
    symbol: config.currency.symbol,
    decimalPlaces: config.currency.decimalPlaces,
    symbolPosition: config.currency.symbolPosition,
    thousandsSeparator: config.currency.thousandsSeparator,
    decimalSeparator: config.currency.decimalSeparator,
    kind: 'custom',
  }
}

export function resolveInstallerCurrency(sources: InstallConfigSources): InstallerCurrencyResolution {
  const override = sources.environmentOverride?.trim()
  if (override) {
    // Validated by the repository when it is applied; reported here as-is so the failure is visible.
    return { code: override.toUpperCase(), source: 'environment', config: null, problem: null, customCurrency: null }
  }
  if (!sources.programData) {
    return { code: null, source: 'none', config: null, problem: null, customCurrency: null }
  }
  const path = installConfigPath(sources.programData)
  const read = sources.readFile ?? ((target: string) => readFileSync(target, 'utf8'))
  let text: string
  try {
    text = read(path)
  } catch {
    // No file is the normal case for a machine that was never installed, or for a portable copy.
    return { code: null, source: 'none', config: null, problem: null, customCurrency: null }
  }
  const config = parseInstallConfig(text)
  if (!config) {
    return {
      code: null,
      source: 'none',
      config: null,
      problem: 'The installer settings file could not be read, so the currency will be chosen during setup.',
      customCurrency: null,
    }
  }
  return {
    code: config.currency.code,
    source: 'install-config',
    config,
    problem: null,
    customCurrency: customCurrencyFromConfig(config),
  }
}
