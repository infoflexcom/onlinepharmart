import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { generateCurrencyUiInclude, generateInstallerHeader } from './generate-installer-script'

/**
 * Writes the generated NSIS header to disk for the build.
 *
 * Kept separate from the generator so the generator stays pure and testable, and so this file is the only one
 * that touches the filesystem.
 */
export function writeInstallerHeader(target: string): { path: string; bytes: number } {
  const header = generateInstallerHeader()
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, header, 'utf8')
  return { path: target, bytes: Buffer.byteLength(header, 'utf8') }
}

/** Writes both generated includes next to each other, which is where `installer.nsi` expects them. */
export function writeGeneratedIncludes(directory: string): Array<{ path: string; bytes: number }> {
  const header = writeInstallerHeader(`${directory}/generated.nsh`)
  const currency = `${directory}/currency-ui.nsh`
  const ui = generateCurrencyUiInclude()
  mkdirSync(dirname(currency), { recursive: true })
  writeFileSync(currency, ui, 'utf8')
  return [header, { path: currency, bytes: Buffer.byteLength(ui, 'utf8') }]
}
