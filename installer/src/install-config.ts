import type { CurrencyDefinition } from '../../src/currency/catalog'

/**
 * The small file the installer leaves behind for the app's first run.
 *
 * It lives at `%ProgramData%\Infoflex\install-config.json`, is written once by the installer, and answers exactly
 * one question: "which currency did the customer choose during installation?" It deliberately contains no
 * secret, no licence, no password and no database path — anything more would be a second source of truth about
 * a shop, and this file is machine-wide and world-readable by design.
 *
 * The contract matters because three separate programs have to agree on it: the NSIS installer writes it, the
 * Electron main process reads it at startup, and the update and repair paths must refuse to overwrite it.
 */

export const INSTALL_CONFIG_DIRECTORY = 'Infoflex'
export const INSTALL_CONFIG_FILENAME = 'install-config.json'
export const INSTALL_CONFIG_VERSION = 1
/** The Windows environment variable an installed app expands to `%ProgramData%`. */
export const PROGRAM_DATA_ENVIRONMENT_VARIABLE = 'ProgramData'

export interface InstallerCurrencyChoice {
  code: string
  name: string
  symbol: string
  decimalPlaces: number
  symbolPosition: 'before' | 'after'
  thousandsSeparator: string
  decimalSeparator: string
  /** True when the customer typed their own currency rather than picking an ISO one. */
  isCustom: boolean
}

export interface InstallConfig {
  format: 'infoflex-install-config'
  version: number
  /** ISO 8601, so a support call can tell when the shop was installed. */
  writtenAt: string
  currency: InstallerCurrencyChoice
  /** Which installer produced it: the online one still needs the network at first run for nothing, but it is useful. */
  installerKind: 'online' | 'offline'
  /** The app version the installer carried, for the "your data is newer than this build" warning. */
  appVersion: string
}

export function toInstallerCurrencyChoice(currency: CurrencyDefinition): InstallerCurrencyChoice {
  return {
    code: currency.code,
    name: currency.name,
    symbol: currency.symbol,
    decimalPlaces: currency.decimalPlaces,
    symbolPosition: currency.symbolPosition,
    thousandsSeparator: currency.thousandsSeparator,
    decimalSeparator: currency.decimalSeparator,
    isCustom: currency.kind === 'custom',
  }
}

/**
 * Builds the file's contents. `writtenAt` and `appVersion` are passed in rather than read from the clock so the
 * output is deterministic and can be asserted byte for byte.
 */
export function createInstallConfig(input: {
  currency: CurrencyDefinition
  writtenAt: string
  installerKind: 'online' | 'offline'
  appVersion: string
}): InstallConfig {
  return {
    format: 'infoflex-install-config',
    version: INSTALL_CONFIG_VERSION,
    writtenAt: input.writtenAt,
    currency: toInstallerCurrencyChoice(input.currency),
    installerKind: input.installerKind,
    appVersion: input.appVersion,
  }
}

export function serializeInstallConfig(config: InstallConfig): string {
  // Two-space indent: a support engineer may open this file in Notepad on the shop PC.
  return `${JSON.stringify(config, null, 2)}\n`
}

/**
 * Reads the file back, returning null for "there is no usable choice" rather than throwing.
 *
 * A corrupt or hand-edited file must never stop the app from starting — the worst it may do is leave the
 * customer on the default currency and free to choose again on the setup screen, which is exactly what a shop
 * with no install-config does. The return type says so: `null` means "behave as if the installer said nothing".
 */
export function parseInstallConfig(text: string): InstallConfig | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (record.format !== 'infoflex-install-config') return null
  if (record.version !== INSTALL_CONFIG_VERSION) return null
  if (record.installerKind !== 'online' && record.installerKind !== 'offline') return null
  const currency = record.currency
  if (!currency || typeof currency !== 'object' || Array.isArray(currency)) return null
  const choice = currency as Record<string, unknown>
  if (typeof choice.code !== 'string' || !/^[A-Z][A-Z0-9]{1,7}$/u.test(choice.code)) return null
  if (typeof choice.name !== 'string' || !choice.name.trim()) return null
  if (typeof choice.symbol !== 'string' || !choice.symbol.trim()) return null
  if (typeof choice.decimalPlaces !== 'number' || !Number.isInteger(choice.decimalPlaces)) return null
  if (choice.decimalPlaces < 0 || choice.decimalPlaces > 4) return null
  if (choice.symbolPosition !== 'before' && choice.symbolPosition !== 'after') return null
  if (typeof choice.thousandsSeparator !== 'string' || typeof choice.decimalSeparator !== 'string') return null
  if (typeof record.writtenAt !== 'string') return null
  if (typeof record.appVersion !== 'string') return null
  return {
    format: 'infoflex-install-config',
    version: INSTALL_CONFIG_VERSION,
    writtenAt: record.writtenAt,
    installerKind: record.installerKind,
    appVersion: record.appVersion,
    currency: {
      code: choice.code,
      name: choice.name,
      symbol: choice.symbol,
      decimalPlaces: choice.decimalPlaces,
      symbolPosition: choice.symbolPosition,
      thousandsSeparator: choice.thousandsSeparator,
      decimalSeparator: choice.decimalSeparator,
      isCustom: choice.isCustom === true,
    },
  }
}

/** The full path, given the value of `%ProgramData%`. Kept pure so it can be asserted per machine. */
export function installConfigPath(programData: string): string {
  const base = programData.replace(/[\\/]+$/u, '')
  return `${base}\\${INSTALL_CONFIG_DIRECTORY}\\${INSTALL_CONFIG_FILENAME}`
}
