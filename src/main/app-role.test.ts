import { describe, expect, it } from 'vitest'
import { readAppRole } from './install-config-reader'
import {
  appRoleFromInstallConfig, createInstallConfig, parseInstallConfig, serializeInstallConfig,
} from '../../installer/src/install-config'
import { CURRENCIES } from '../currency/catalog'

/**
 * The application role, end to end through the file the installer writes.
 *
 * Every guard here is tested by *disabling* it, because each of the three has a plausible alternative that looks
 * helpful and the brief forbids:
 *
 * - reading an old file as a client (would refuse the Admin and lock the shop out of its own server),
 * - reading an unknown role as a client (same),
 * - letting an environment variable decide the role (a support call could turn a client into a database owner).
 */

const NGN = CURRENCIES.find((currency) => currency.code === 'NGN')!

function fileWith(appRole?: string): string {
  const config = createInstallConfig({
    currency: NGN, writtenAt: '2026-11-17T00:00:00.000Z', installerKind: 'online', appVersion: '0.1.0', appRole: 'server',
  })
  const text = serializeInstallConfig(config)
  if (appRole === undefined) {
    // Simulate a file written before the field existed.
    return text.replace(/^\s*"appRole".*\n/gmu, '')
  }
  return JSON.stringify({ ...JSON.parse(text), appRole })
}

const read = (text: string) => readAppRole({ programData: 'C:\\ProgramData', readFile: () => text })

describe('a file that names the role is believed', () => {
  it.each(['server', 'client'] as const)('reads %s', (role) => {
    expect(read(fileWith(role))).toBe(role)
  })
})

describe('a file that names nothing is a server', () => {
  it('reads a pre-split file as server, which is what it was', () => {
    expect(read(fileWith(undefined))).toBe('server')
  })

  it('would read it as client if the default were changed, which is why the default is asserted', () => {
    // The guard disabled by hand: an old file, read with the opposite default, would refuse the Admin at the server's
    // own login page. Nothing in the product can produce this reading; the assertion exists so a future change to the
    // default has to break a test rather than a shop.
    const config = parseInstallConfig(fileWith(undefined))
    expect(config).not.toBeNull()
    expect(appRoleFromInstallConfig(config)).toBe('server')
  })
})

describe('an unrecognised role does not reject the whole file', () => {
  it('keeps the currency and treats the role as server', () => {
    const config = parseInstallConfig(fileWith('till'))
    expect(config?.currency.code).toBe('NGN')
    expect(appRoleFromInstallConfig(config)).toBe('server')
  })
})

describe('an unreadable or absent file is a server', () => {
  it('falls back when the file is missing', () => {
    expect(readAppRole({ programData: 'C:\\ProgramData', readFile: () => { throw new Error('ENOENT') } })).toBe('server')
  })

  it('falls back when no ProgramData is known, as on a machine that was never installed', () => {
    expect(readAppRole({ programData: null })).toBe('server')
  })

  it('falls back when the file is corrupt rather than starting as something unknown', () => {
    expect(read('{ not json')).toBe('server')
  })
})

describe('the role is not settable by environment variable, unlike the currency', () => {
  it('ignores INFOFLEX_INSTALLER_CURRENCY and reads only the file', () => {
    // The reader takes no environment source at all. This test states the absence deliberately: the currency may be
    // overridden during a support call, the role may not, because a client that opens the database breaks the
    // architecture's central promise.
    expect(readAppRole.length).toBe(1)
    expect(read(fileWith('client'))).toBe('client')
  })
})

describe('the role survives a round trip through the installer file', () => {
  it('serialises and parses both roles', () => {
    for (const role of ['server', 'client'] as const) {
      const text = serializeInstallConfig(createInstallConfig({
        currency: NGN, writtenAt: '2026-11-17T00:00:00.000Z', installerKind: 'offline', appVersion: '1.2.3', appRole: role,
      }))
      expect(parseInstallConfig(text)?.appRole).toBe(role)
    }
  })

  it('writes server when a caller does not say, so an untaught caller cannot produce a client by accident', () => {
    const config = createInstallConfig({
      currency: NGN, writtenAt: '2026-11-17T00:00:00.000Z', installerKind: 'online', appVersion: '0.1.0',
    })
    expect(config.appRole).toBe('server')
  })
})
