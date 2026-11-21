import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrateDatabase } from '../db/migrate'
import { SQLiteShopRepository } from '../db/sqlite-shop-repository'
import { SQLiteUserRepository } from '../db/sqlite-user-repository'
import { SetupService } from './setup-service'
import { defaultDisplayOptions } from '../currency/money'
import { getCurrency } from '../currency/catalog'
import { defaultBuildProfile, type BuildProfile } from '../../installer/src/build-profile'
import { readBuildProfile, resolveResourcesPath } from '../main/install-config-reader'
import type { LicensePolicyProvider, VerifiedLicensePolicy } from '../license/setup-policy'
import type { FirstRunInput } from '../shared/shop/types'

/**
 * A build whose vendor locked the currency must stay locked on the first-run screen.
 *
 * The installer refusing to show the list is only half the promise. If the setup screen still let the customer
 * pick, the lock would be theatre: a shop could get a different currency simply by being handed the app folder
 * instead of the installer, or by reinstalling. This is the other half.
 *
 * The licence is deliberately absent in most of these tests, because that is the case the build lock exists for —
 * a vendor shipping one build per country, before any licence has been sold.
 */

/** First-run setup requires an activated licence; the licence here is ordinary and says nothing about currency. */
const plainLicence: VerifiedLicensePolicy = {
  licenseId: 'build-lock-e2e', edition: 'PHARMACY', defaultCurrencyCode: null, lockCurrency: false,
} as VerifiedLicensePolicy
const licence: LicensePolicyProvider = { getVerifiedPolicy: () => plainLicence }

function createShop(buildProfile: BuildProfile | null) {
  const database = new Database(':memory:')
  migrateDatabase(database)
  const shop = new SQLiteShopRepository(database, false)
  const users = new SQLiteUserRepository(database)
  let generated = 0
  const setup = new SetupService(
    shop, users, shop, licence,
    () => new Date('2026-11-20T09:00:00.000Z'), () => `id-${++generated}`, buildProfile,
  )
  return { database, shop, setup, close: () => database.close() }
}

function lockedBuild(code: string): BuildProfile {
  return { ...defaultBuildProfile(), defaultCurrencyCode: code, lockCurrency: true }
}

function firstRun(currencyCode: string): FirstRunInput {
  const currency = getCurrency(currencyCode)!
  const password = 'Harbor-Admin-Pass-9'
  return {
    admin: { fullName: 'Ada Obi', username: 'shopadmin', password, confirmPassword: password },
    profile: { name: 'Harbor Health Pharmacy', address: '14 Marina Road', phone: '+234 800 111 2222' },
    currency,
    display: defaultDisplayOptions(currency),
    currencyConfirmed: true,
  }
}

describe('a build with the currency locked', () => {
  it('preselects the build currency on the setup screen', async () => {
    const shop = createShop(lockedBuild('GHS'))
    try {
      const context = await shop.setup.getSetupContext()
      expect(context.initialCurrency.code).toBe('GHS')
      expect(context.currencyLocked).toBe(true)
      expect(context.vendorCurrencyLocked).toBe(true)
    } finally {
      shop.close()
    }
  })

  it('refuses to complete setup in a different currency', async () => {
    const shop = createShop(lockedBuild('GHS'))
    try {
      // The screen would show this read-only, but the rule must hold in the service, not only in the view.
      await expect(shop.setup.completeFirstRun(firstRun('NGN'))).rejects.toThrow(/locked this currency/iu)
    } finally {
      shop.close()
    }
  })

  it('completes setup in the build currency and records the lock', async () => {
    const shop = createShop(lockedBuild('KWD'))
    try {
      await shop.setup.completeFirstRun(firstRun('KWD'))
      const settings = shop.shop.readSettings()
      expect(settings.currency.code).toBe('KWD')
      expect(settings.currency.decimalPlaces).toBe(3)
      expect(settings.currencyLocked).toBe(true)
      expect(settings.setupComplete).toBe(true)
    } finally {
      shop.close()
    }
  })

  it('leaves an unlocked build free to choose, which is the normal case', async () => {
    const shop = createShop({ ...defaultBuildProfile(), defaultCurrencyCode: 'GHS' })
    try {
      const context = await shop.setup.getSetupContext()
      // Preselected but not locked: the customer may still change it.
      expect(context.initialCurrency.code).toBe('GHS')
      expect(context.currencyLocked).toBe(false)
      await shop.setup.completeFirstRun(firstRun('NGN'))
      expect(shop.shop.readSettings().currency.code).toBe('NGN')
    } finally {
      shop.close()
    }
  })

  it('behaves exactly as before when a build has no profile at all', async () => {
    const shop = createShop(null)
    try {
      const context = await shop.setup.getSetupContext()
      expect(context.initialCurrency.code).toBe('NGN')
      expect(context.currencyLocked).toBe(false)
    } finally {
      shop.close()
    }
  })

  it('lets the installer file still preselect on an unlocked build', async () => {
    const shop = createShop({ ...defaultBuildProfile(), defaultCurrencyCode: 'GHS' })
    try {
      shop.shop.setInstallerCurrencyCode('KES')
      const context = await shop.setup.getSetupContext()
      // The installer recorded what the customer chose on the machine; that outranks the build's suggestion.
      expect(context.initialCurrency.code).toBe('KES')
      expect(context.currencyLocked).toBe(false)
    } finally {
      shop.close()
    }
  })
})

describe('finding the build profile', () => {
  it('looks beside the packaged app, and at the project root in development', () => {
    expect(resolveResourcesPath({ isPackaged: true, resourcesPath: 'C:\\App\\resources', projectRoot: 'C:\\src' }))
      .toBe('C:\\App\\resources')
    expect(resolveResourcesPath({ isPackaged: false, resourcesPath: 'C:\\App\\resources', projectRoot: 'C:\\src' }))
      .toBe('C:\\src')
  })

  it('reads a valid profile and treats a missing one as none', () => {
    const valid = JSON.stringify({ ...defaultBuildProfile(), defaultCurrencyCode: 'GHS', lockCurrency: true })
    expect(readBuildProfile({
      resourcesPath: 'C:\\App\\resources',
      readFile: (path) => {
        expect(path).toBe('C:\\App\\resources\\build-profile.json')
        return valid
      },
    })).toMatchObject({ defaultCurrencyCode: 'GHS', lockCurrency: true })

    expect(readBuildProfile({
      resourcesPath: 'C:\\App\\resources',
      readFile: () => { throw new Error('ENOENT') },
    })).toBeNull()
  })

  it('treats a corrupt or invalid profile as no profile, never as a locked one', () => {
    // A pharmacy must still be able to open. "I cannot tell what the vendor wanted" must fall back to the ordinary
    // unlocked default, not to a locked screen whose currency nobody can satisfy.
    for (const contents of ['not json', '{}', JSON.stringify({ ...defaultBuildProfile(), defaultCurrencyCode: 'ZZZ' })]) {
      expect(readBuildProfile({ resourcesPath: 'C:\\App\\resources', readFile: () => contents }), contents).toBeNull()
    }
  })

  it('reads nothing when there is no resources path to look in', () => {
    expect(readBuildProfile({ resourcesPath: null, readFile: () => 'anything' })).toBeNull()
  })
})
