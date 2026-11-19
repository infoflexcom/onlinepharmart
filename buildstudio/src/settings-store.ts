import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defaultBuildProfile, type BuildProfile } from '../../installer/src/build-profile'

/**
 * Build Studio's own remembered settings.
 *
 * Kept as one small JSON file rather than the Windows registry, so a vendor can move Build Studio to another machine
 * by copying a folder — which is what people actually do — and so a support call can ask for one file.
 *
 * The two rules this file enforces:
 *
 *   - **No secret is ever written.** The vendor's master password is checked, then discarded; what is stored is the
 *     salted hash the app already uses. The private signing key is never stored here at all: it is written once, to
 *     a file the vendor chooses, and only the public half comes back.
 *   - **A corrupt file is not fatal.** Losing the remembered output folder must not stop Build Studio opening.
 */

export const BUILD_STUDIO_SETTINGS_FILENAME = 'build-studio-settings.json'

export interface BuildStudioSettings {
  format: 'infoflex-build-studio-settings'
  version: 1
  /** The project folder last used. Null means "not chosen yet". */
  projectPath: string | null
  /** Where the built files are written. Relative to the project unless absolute. */
  outputPath: string | null
  /** The code-signing certificate, if the vendor signed up for one. Path only — never the password. */
  certificatePath: string | null
  /** The build settings embedded into the products. */
  buildProfile: BuildProfile
  /** Auto-increment the patch number on each build. */
  autoIncrementVersion: boolean
  /**
   * Release notes for the version being built, as the vendor typed them.
   *
   * Plain text the vendor writes for their own records and for the customer's "What's new". Never a secret, so it is
   * stored here rather than in a separate file.
   */
  releaseNotes: string
  /**
   * The salted hash of the vendor master password, as the app stores it.
   *
   * This is the one thing here that looks like a secret and is not: it is the PBKDF2 hash in the same shape the
   * installer and the vendor policy file already use. Storing it lets Build Studio check the password without the
   * password ever being written down.
   */
  masterPasswordHash: { algorithm: 'PBKDF2-SHA256'; iterations: number; salt: string; hash: string } | null
}

export function defaultSettings(): BuildStudioSettings {
  return {
    format: 'infoflex-build-studio-settings',
    version: 1,
    projectPath: null,
    outputPath: 'dist',
    certificatePath: null,
    buildProfile: defaultBuildProfile(),
    autoIncrementVersion: false,
    releaseNotes: '',
    masterPasswordHash: null,
  }
}

export function settingsPath(directory: string): string {
  return join(directory, BUILD_STUDIO_SETTINGS_FILENAME)
}

/** Reads settings, falling back to defaults field by field so one bad value does not lose the rest. */
export function readSettings(directory: string): BuildStudioSettings {
  const path = settingsPath(directory)
  if (!existsSync(path)) return defaultSettings()
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return defaultSettings()
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaultSettings()
  const record = parsed as Record<string, unknown>
  const defaults = defaultSettings()
  if (record.format !== defaults.format || record.version !== defaults.version) return defaults
  return {
    format: defaults.format,
    version: defaults.version,
    projectPath: typeof record.projectPath === 'string' ? record.projectPath : null,
    outputPath: typeof record.outputPath === 'string' ? record.outputPath : defaults.outputPath,
    certificatePath: typeof record.certificatePath === 'string' ? record.certificatePath : null,
    buildProfile: isProfile(record.buildProfile) ? record.buildProfile : defaults.buildProfile,
    autoIncrementVersion: record.autoIncrementVersion === true,
    releaseNotes: typeof record.releaseNotes === 'string' ? record.releaseNotes : defaults.releaseNotes,
    masterPasswordHash: isPasswordHash(record.masterPasswordHash) ? record.masterPasswordHash : null,
  }
}

export function writeSettings(directory: string, settings: BuildStudioSettings): void {
  // Refuse rather than write something a later version cannot read.
  const text = JSON.stringify(settings, null, 2)
  if (/PRIVATE KEY/u.test(text)) {
    throw new Error('Build Studio will not write a private key to its settings file.')
  }
  mkdirSync(dirname(settingsPath(directory)), { recursive: true })
  writeFileSync(settingsPath(directory), `${text}\n`, 'utf8')
}

function isProfile(value: unknown): value is BuildProfile {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record.format === 'infoflex-build-profile' && record.version === 1
}

function isPasswordHash(value: unknown): value is BuildStudioSettings['masterPasswordHash'] {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record.algorithm === 'PBKDF2-SHA256'
    && typeof record.iterations === 'number'
    && typeof record.salt === 'string'
    && typeof record.hash === 'string'
}

/** Bumps the patch number: 1.4.2 becomes 1.4.3. Used when "auto-increment" is on. */
export function incrementVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/u.exec(version)
  if (!match) throw new Error(`"${version}" is not a version number, so it cannot be incremented.`)
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}${match[4] ?? ''}`
}
