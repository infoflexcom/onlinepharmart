import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { defaultBuildProfile, type BuildProfile } from './build-profile'
import { generateCurrencyUiInclude, generateInstallerHeader, generatePrerequisiteInclude } from './generate-installer-script'

/**
 * Writes the generated NSIS header to disk for the build.
 *
 * Kept separate from the generator so the generator stays pure and testable, and so this file is the only one
 * that touches the filesystem.
 */
export function writeInstallerHeader(target: string, profile: BuildProfile = defaultBuildProfile()): { path: string; bytes: number } {
  const header = generateInstallerHeader(profile)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, header, 'utf8')
  return { path: target, bytes: Buffer.byteLength(header, 'utf8') }
}

/**
 * Writes both generated includes next to each other, which is where `installer.nsi` expects them.
 *
 * The profile is passed in rather than read here: Build Studio writes it, the build script reads it, and this file
 * stays a pure writer with no opinion about where settings come from.
 */
export function writeGeneratedIncludes(
  directory: string,
  profile: BuildProfile = defaultBuildProfile(),
): Array<{ path: string; bytes: number }> {
  const header = writeInstallerHeader(`${directory}/generated.nsh`, profile)
  const currency = `${directory}/currency-ui.nsh`
  const ui = generateCurrencyUiInclude(profile)
  mkdirSync(dirname(currency), { recursive: true })
  writeFileSync(currency, ui, 'utf8')
  // The prerequisite path, for the same reason: electron-builder cannot pass a -D through to makensis, so the offline
  // build learns where the verified file is from a header like everything else.
  const prerequisite = `${directory}/prerequisite.nsh`
  const prerequisiteText = generatePrerequisiteInclude(profile)
  writeFileSync(prerequisite, prerequisiteText, 'utf8')
  return [
    header,
    { path: currency, bytes: Buffer.byteLength(ui, 'utf8') },
    { path: prerequisite, bytes: Buffer.byteLength(prerequisiteText, 'utf8') },
  ]
}
