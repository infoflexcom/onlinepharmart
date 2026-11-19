import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { getCurrency } from '../currency/catalog'
import { migrateDatabase } from '../db/migrate'
import { SQLiteShopRepository } from '../db/sqlite-shop-repository'
import { SQLiteUserRepository } from '../db/sqlite-user-repository'
import { SetupService } from './setup-service'
import { createInstallConfig, serializeInstallConfig } from '../../installer/src/install-config'
import { resolveInstallerCurrency } from '../main/install-config-reader'
import type { CurrencyDefinition } from '../currency/catalog'
import type { LicensePolicyProvider, VerifiedLicensePolicy } from '../license/setup-policy'
import type { FirstRunInput } from '../shared/shop/types'
import { defaultDisplayOptions } from '../currency/money'

/**
 * The whole promise of DONE WHEN item 4, from the file on disk to the number the setup screen opens with.
 *
 * Three programs are involved — the NSIS installer writes `install-config.json`, the main process reads it and
 * calls `setInstallerCurrencyCode`, and `SetupService` ranks that below a vendor policy but above the default.
 * Each piece is tested on its own elsewhere; this test joins them, because the failure a shopkeeper would see
 * ("the installer ignored my currency") is a *seam* failure and would pass every one of those unit tests.
 */

const POLICY: VerifiedLicensePolicy = {
  licenseId: 'installer-e2e', edition: 'PHARMACY', defaultCurrencyCode: null, lockCurrency: false,
} as VerifiedLicensePolicy

function createShop(policy: VerifiedLicensePolicy | null = POLICY) {
  const database = new Database(':memory:')
  migrateDatabase(database)
  const shop = new SQLiteShopRepository(database, false)
  const users = new SQLiteUserRepository(database)
  const license: LicensePolicyProvider = { getVerifiedPolicy: () => policy }
  let generated = 0
  const setup = new SetupService(shop, users, shop, license, () => new Date('2026-11-19T09:00:00.000Z'), () => `id-${++generated}`)
  return { database, shop, setup, close: () => database.close() }
}

/** Writes the file the way the installer does, then lets the app's reader find it. */
function applyInstallerChoice(
  shop: SQLiteShopRepository,
  currency: CurrencyDefinition,
  options: { installerKind?: 'online' | 'offline' } = {},
): { code: string | null; source: string } {
  const file = serializeInstallConfig(createInstallConfig({
    currency,
    writtenAt: '2026-11-19T09:00:00.000Z',
    installerKind: options.installerKind ?? 'online',
    appVersion: '0.1.0',
  }))
  const resolution = resolveInstallerCurrency({
    environmentOverride: null,
    programData: 'C:\\ProgramData',
    readFile: (path) => {
      expect(path).toBe('C:\\ProgramData\\Infoflex\\install-config.json')
      return file
    },
  })
  if (resolution.code) shop.setInstallerCurrencyCode(resolution.code, resolution.customCurrency)
  return { code: resolution.code, source: resolution.source }
}

describe('the currency chosen in the installer reaches the setup screen', () => {
  it.each(['GHS', 'KWD', 'JPY', 'EUR'])('preselects %s from the installer file', async (code) => {
    const shop = createShop()
    try {
      const applied = applyInstallerChoice(shop.shop, getCurrency(code)!)
      expect(applied).toEqual({ code, source: 'install-config' })

      const context = await shop.setup.getSetupContext()
      expect(context.installerCurrencyCode).toBe(code)
      expect(context.initialCurrency.code).toBe(code)
      // The setup screen shows the right number of decimals for that currency, not a hard-coded two.
      expect(context.initialCurrency.decimalPlaces).toBe(getCurrency(code)!.decimalPlaces)
    } finally {
      shop.close()
    }
  })

  it('preselects an offline installer\'s custom currency', async () => {
    const shop = createShop()
    try {
      // A custom currency is written by the offline installer exactly like a built-in one.
      const custom: CurrencyDefinition = {
        code: 'WBC', name: 'West Bank Coin', symbol: 'W', decimalPlaces: 3,
        symbolPosition: 'before', thousandsSeparator: ',', decimalSeparator: '.', kind: 'custom',
      }
      const applied = applyInstallerChoice(shop.shop, custom, { installerKind: 'offline' })
      expect(applied.code).toBe('WBC')

      const context = await shop.setup.getSetupContext()
      expect(context.initialCurrency).toMatchObject({ code: 'WBC', decimalPlaces: 3, kind: 'custom' })
    } finally {
      shop.close()
    }
  })

  it('lets the vendor policy outrank the installer, because the vendor sold the currency', async () => {
    const shop = createShop({ ...POLICY, defaultCurrencyCode: 'KES' } as VerifiedLicensePolicy)
    try {
      applyInstallerChoice(shop.shop, getCurrency('GHS')!)
      const context = await shop.setup.getSetupContext()
      expect(context.installerCurrencyCode).toBe('GHS')
      // The licence wins, and the screen can explain why.
      expect(context.initialCurrency.code).toBe('KES')
      expect(context.licenseDefaultCurrencyCode).toBe('KES')
    } finally {
      shop.close()
    }
  })

  it('falls back to Naira when there is no installer file at all', async () => {
    const shop = createShop()
    try {
      const resolution = resolveInstallerCurrency({
        environmentOverride: null,
        programData: 'C:\\ProgramData',
        readFile: () => { throw new Error('ENOENT') },
      })
      expect(resolution.code).toBeNull()
      const context = await shop.setup.getSetupContext()
      expect(context.installerCurrencyCode).toBeNull()
      expect(context.initialCurrency.code).toBe('NGN')
    } finally {
      shop.close()
    }
  })

  it('completes first run in the installer\'s currency and stores it with its own decimals', async () => {
    const shop = createShop()
    try {
      applyInstallerChoice(shop.shop, getCurrency('KWD')!)
      const context = await shop.setup.getSetupContext()
      const currency = context.initialCurrency
      const password = 'Harbor-Admin-Pass-9'
      const input: FirstRunInput = {
        admin: { fullName: 'Ada Obi', username: 'shopadmin', password, confirmPassword: password },
        profile: { name: 'Harbor Health Pharmacy', address: '14 Marina Road', phone: '+234 800 111 2222' },
        currency,
        display: defaultDisplayOptions(currency),
        currencyConfirmed: true,
      }
      await shop.setup.completeFirstRun(input)
      const stored = shop.shop.readSettings()
      expect(stored.currency.code).toBe('KWD')
      expect(stored.currency.decimalPlaces).toBe(3)
      expect(stored.setupComplete).toBe(true)
    } finally {
      shop.close()
    }
  })
})
