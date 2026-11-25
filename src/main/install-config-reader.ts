import { readFileSync } from 'node:fs'
import { join, win32 } from 'node:path'
import {
  appRoleFromInstallConfig, installConfigPath, parseInstallConfig, type AppRole, type InstallConfig,
} from '../../installer/src/install-config'
import type { CurrencyDefinition } from '../currency/catalog'
import {
  BUILD_PROFILE_FILENAME, parseBuildProfile, type BuildProfile,
} from '../../installer/src/build-profile'

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
  /**
   * The vendor's build settings, when this build carries them.
   *
   * A locked *build* is not the same thing as a locked *licence*: the vendor who ships one build per country locks
   * the currency at build time, before any licence exists. Without this the first-run screen would happily let the
   * customer change a currency the installer refused to let them touch, which would make the lock theatre.
   */
  buildProfile: BuildProfile | null
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

export interface BuildProfileSources {
  /**
   * The folder the build profile is embedded in — `process.resourcesPath` in the packaged app, or the project root
   * in development. Null when it cannot be determined, which means "this build has no profile".
   */
  resourcesPath: string | null
  /** Injected file read, so this is testable without a packaged app. */
  readFile?: (path: string) => string
}

/**
 * Reads the profile Build Studio embedded in this build.
 *
 * A missing or unreadable file is normal: every build made before Build Studio, and every `npm run` build, has
 * none, and those must behave exactly as they always have. A file that exists but is invalid is also treated as
 * absent — a corrupt build setting must not stop a pharmacy from opening, and the safe reading of "I cannot tell
 * what the vendor wanted" is the ordinary unlocked default, not a locked screen nobody can satisfy.
 */
/**
 * Where the build profile lives for this run.
 *
 * Packaged, electron-builder's `extraResources` puts it beside the app in `resources/`. In development the project
 * root is used, so a developer can drop a profile in and see the same behaviour without packaging.
 */
/**
 * Joins a base folder and a file name using the separator the base already uses.
 *
 * On Windows the base is `C:\App\resources` and either join works. But this module is also exercised by tests on a
 * Linux build machine with Windows-shaped paths, where `join` would produce `C:\App\resources/build-profile.json`
 * — a path that is wrong on Windows and would have been invisible until the packaged app failed to find its own
 * settings. Picking the implementation from the base avoids depending on the host that happens to run the code.
 */
export function joinPath(base: string, name: string): string {
  return base.includes('\\') ? win32.join(base, name) : join(base, name)
}

export function resolveResourcesPath(input: {
  isPackaged: boolean
  resourcesPath: string
  projectRoot: string
}): string {
  return input.isPackaged ? input.resourcesPath : input.projectRoot
}

export function readBuildProfile(sources: BuildProfileSources): BuildProfile | null {
  if (!sources.resourcesPath) return null
  const read = sources.readFile ?? ((target: string) => readFileSync(target, 'utf8'))
  try {
    return parseBuildProfile(read(joinPath(sources.resourcesPath, BUILD_PROFILE_FILENAME)))
  } catch {
    return null
  }
}

export function resolveInstallerCurrency(sources: InstallConfigSources): InstallerCurrencyResolution {
  const override = sources.environmentOverride?.trim()
  if (override) {
    // Validated by the repository when it is applied; reported here as-is so the failure is visible.
    return { code: override.toUpperCase(), source: 'environment', config: null, problem: null, customCurrency: null, buildProfile: null }
  }
  if (!sources.programData) {
    return { code: null, source: 'none', config: null, problem: null, customCurrency: null, buildProfile: null }
  }
  const path = installConfigPath(sources.programData)
  const read = sources.readFile ?? ((target: string) => readFileSync(target, 'utf8'))
  let text: string
  try {
    text = read(path)
  } catch {
    // No file is the normal case for a machine that was never installed, or for a portable copy.
    return { code: null, source: 'none', config: null, problem: null, customCurrency: null, buildProfile: null }
  }
  const config = parseInstallConfig(text)
  if (!config) {
    return {
      code: null,
      source: 'none',
      config: null,
      problem: 'The installer settings file could not be read, so the currency will be chosen during setup.',
      customCurrency: null,
      buildProfile: null,
    }
  }
  return {
    code: config.currency.code,
    source: 'install-config',
    config,
    problem: null,
    customCurrency: customCurrencyFromConfig(config),
    buildProfile: null,
  }
}

/**
 * Which application this installation is, read from the installer's file.
 *
 * Deliberately a separate read from the currency one rather than another field on `InstallerCurrencyResolution`: the
 * currency may legitimately be overridden by an environment variable during a support call, but the application role
 * may not be. A server temporarily pretending to be a client would refuse its own Admin; a client pretending to be a
 * server would open the database, which is the one thing the architecture forbids. So the role comes from the file the
 * installer wrote, and nowhere else.
 *
 * A missing or unreadable file means `server`, which is what every build before the split was, and which cannot leave a
 * shop without a working Admin login.
 */
export function readAppRole(sources: Pick<InstallConfigSources, 'programData' | 'readFile'>): AppRole {
  if (!sources.programData) return 'server'
  const read = sources.readFile ?? ((target: string) => readFileSync(target, 'utf8'))
  let text: string
  try {
    text = read(installConfigPath(sources.programData))
  } catch {
    return 'server'
  }
  return appRoleFromInstallConfig(parseInstallConfig(text))
}
