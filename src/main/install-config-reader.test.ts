import { describe, expect, it } from 'vitest'
import { getCurrency } from '../currency/catalog'
import { createInstallConfig, serializeInstallConfig } from '../../installer/src/install-config'
import { resolveInstallerCurrency } from './install-config-reader'

/**
 * What the app does with the file the installer wrote.
 *
 * DONE WHEN item 4 is "the chosen currency is preselected on the app's first-run setup screen". The setup screen
 * is driven by the code that comes out of here, so this is where that promise is actually kept — and the ways it
 * can go wrong (no file, a corrupt file, an override) are all worth a test, because a broken read at startup
 * looks to a shopkeeper like "the installer ignored my choice".
 */

const GHS_FILE = serializeInstallConfig(createInstallConfig({
  currency: getCurrency('GHS')!,
  writtenAt: '2026-11-19T05:00:00.000Z',
  installerKind: 'offline',
  appVersion: '0.1.0',
}))

describe('the app reads the installer\'s currency choice at startup', () => {
  it('finds the file under ProgramData and returns its currency', () => {
    const seen: string[] = []
    const result = resolveInstallerCurrency({
      environmentOverride: null,
      programData: 'C:\\ProgramData',
      readFile: (path) => { seen.push(path); return GHS_FILE },
    })
    expect(seen).toEqual(['C:\\ProgramData\\Infoflex\\install-config.json'])
    expect(result.code).toBe('GHS')
    expect(result.source).toBe('install-config')
    expect(result.config?.installerKind).toBe('offline')
    expect(result.problem).toBeNull()
  })

  it('lets an explicit environment override win over the file', () => {
    const result = resolveInstallerCurrency({
      environmentOverride: ' kwd ',
      programData: 'C:\\ProgramData',
      readFile: () => GHS_FILE,
    })
    expect(result.code).toBe('KWD')
    expect(result.source).toBe('environment')
  })

  it('does not care where Windows put ProgramData', () => {
    const result = resolveInstallerCurrency({
      environmentOverride: null,
      programData: 'D:\\Corp Data',
      readFile: (path) => {
        expect(path).toBe('D:\\Corp Data\\Infoflex\\install-config.json')
        return GHS_FILE
      },
    })
    expect(result.code).toBe('GHS')
  })

  it('treats a missing file as "no choice" without an error', () => {
    const result = resolveInstallerCurrency({
      environmentOverride: null,
      programData: 'C:\\ProgramData',
      readFile: () => { throw new Error('ENOENT') },
    })
    expect(result).toMatchObject({ code: null, source: 'none', problem: null })
  })

  it('survives a corrupt file and says so in plain words', () => {
    const result = resolveInstallerCurrency({
      environmentOverride: null,
      programData: 'C:\\ProgramData',
      readFile: () => '{ this is not json',
    })
    expect(result.code).toBeNull()
    expect(result.source).toBe('none')
    expect(result.problem).toMatch(/chosen during setup/u)
  })

  it('returns nothing at all when Windows gives no ProgramData', () => {
    expect(resolveInstallerCurrency({ environmentOverride: null, programData: null }))
      .toMatchObject({ code: null, source: 'none' })
  })
})
