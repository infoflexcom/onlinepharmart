import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getCurrency } from '../currency/catalog'
import { defaultDisplayOptions } from '../currency/money'
import { openShopDatabase } from '../db'
import { SQLiteShopRepository } from '../db/sqlite-shop-repository'
import { SQLiteUserRepository } from '../db/sqlite-user-repository'
import { AuthService } from '../services/auth-service'
import { SetupService } from '../services/setup-service'
import { ShopService } from '../services/shop-service'
import { UserService } from '../services/user-service'
import { BackupService } from '../services/backup-service'
import { DEFAULT_OPERATIONAL_SETTINGS, type FirstRunInput } from '../shared/shop/types'
import type { LicensePolicyProvider, VerifiedLicensePolicy } from '../license/setup-policy'
import { defaultPermissions } from '../shared/auth/policy'
import { DesktopHostController } from './desktop-host-controller'

const ADMIN = 'Admin-Pass!2026'
const CASHIER = 'Cashier-Pass!2026'
const POLICY: VerifiedLicensePolicy = { licenseId: 'lic-1', edition: 'BOTH', defaultCurrencyCode: null, lockCurrency: false }

function firstRun(): FirstRunInput {
  return {
    admin: { fullName: 'Jane Admin', username: 'admin', password: ADMIN, confirmPassword: ADMIN },
    profile: { name: 'Harbor Health', address: '12 Dock Road', phone: '+234 1 555 0100' },
    currency: getCurrency('NGN')!,
    display: defaultDisplayOptions(getCurrency('NGN')!),
    currencyConfirmed: true,
  }
}

async function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'infoflex-host-'))
  const databasePath = join(root, 'infoflex.sqlite')
  const database = openShopDatabase(databasePath)
  const shop = new SQLiteShopRepository(database, false)
  const users = new SQLiteUserRepository(database)
  const license: LicensePolicyProvider = { getVerifiedPolicy: () => POLICY }
  const now = () => new Date('2026-11-17T12:00:00.000Z')
  const setup = new SetupService(shop, users, shop, license, now)
  const auth = new AuthService(users, shop, { deviceName: 'PC', ipAddress: null }, now, () => 1_000_000)
  const shopService = new ShopService(shop, { deviceName: 'PC', ipAddress: null }, now)
  const userService = new UserService(users, shop, now)
  const backup = new BackupService(shop, {
    databasePath,
    automaticFolder: join(root, 'backups'),
    appVersion: '0.1.0-test',
    now,
    reopen: () => new SQLiteShopRepository(openShopDatabase(databasePath), false),
  })
  const host = new DesktopHostController(
    shop, users, setup, auth, userService, shopService,
    () => 1_000_000, '0.1.0-test', undefined, undefined, undefined, undefined, undefined, undefined, backup,
  )
  await host.initialize()
  await host.completeFirstRun(firstRun())
  await host.login(1, { username: 'admin', password: ADMIN })
  await host.createUser(1, {
    fullName: 'Cassie Cashier', username: 'cashier', password: CASHIER, confirmPassword: CASHIER, role: 'CASHIER',
    permissions: defaultPermissions('CASHIER'),
  })
  await host.login(2, { username: 'cashier', password: CASHIER })
  return {
    host,
    root,
    close(): void {
      database.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

describe('settings and backup permissions on the host', () => {
  it('lets the Admin save receipt settings, and pushes them through to the stored shop', async () => {
    const fixture = await createFixture()
    try {
      const saved = fixture.host.updateOperationalSettings(1, {
        ...DEFAULT_OPERATIONAL_SETTINGS,
        documentLayout: 'A4_RECEIPT',
        showPoweredBy: false,
        vatEnabled: true,
        vatRateBasisPoints: 750,
      })
      expect(saved.operational.documentLayout).toBe('A4_RECEIPT')
      expect(saved.operational.showPoweredBy).toBe(false)
      const bootstrap = await fixture.host.getBootstrap(1)
      expect(bootstrap.settings.operational.vatRateBasisPoints).toBe(750)
    } finally {
      fixture.close()
    }
  })

  it('refuses every settings and backup action for a Cashier', async () => {
    const fixture = await createFixture()
    try {
      const attempts: Array<[string, () => unknown]> = [
        ['updateOperationalSettings', () => fixture.host.updateOperationalSettings(2, DEFAULT_OPERATIONAL_SETTINGS)],
        ['updateStoreDetails', () => fixture.host.updateStoreDetails(2, { name: 'Hijacked', address: '', phone: '' })],
        ['changeCurrency', () => fixture.host.changeCurrency(2, getCurrency('USD')!, true)],
        ['getBackupStatus', () => fixture.host.getBackupStatus(2)],
        ['createManualBackup', () => fixture.host.createManualBackup(2, '/tmp')],
        ['listBackupFiles', () => fixture.host.listBackupFiles(2, '/tmp')],
        ['restoreBackup', () => fixture.host.restoreBackup(2, { folder: '/tmp', fileName: 'x', confirmed: true })],
      ]
      for (const [name, run] of attempts) {
        expect(run, `${name} must be Admin-only`).toThrow(/restricted to the admin/i)
      }
    } finally {
      fixture.close()
    }
  })

  it('refuses a signed-out caller and a restored-in-place database without a repository to reopen', async () => {
    const fixture = await createFixture()
    try {
      expect(() => fixture.host.getBackupStatus(99)).toThrow(/session has expired|sign in/i)
      const status = fixture.host.getBackupStatus(1)
      expect(status.automaticEnabled).toBe(true)
      expect(status.recent).toEqual([])
      expect(status.stale).toBe(true)
      expect(status.warning).toMatch(/no backup/i)
    } finally {
      fixture.close()
    }
  })

  it('backs up on demand and reports it in the shop status, by button only', async () => {
    const fixture = await createFixture()
    try {
      const result = fixture.host.createManualBackup(1, join(fixture.root, 'usb-stick'))
      expect(result.backup.fileName).toMatch(/^infoflex-backup-.*\.infoflexbackup$/)
      expect(result.backup.currencyCode).toBe('NGN')
      expect(result.backup.actor).toBe('admin')
      expect(result.status.stale).toBe(false)
      expect(result.status.recent[0].fileName).toBe(result.backup.fileName)
      expect(fixture.host.listBackupFiles(1, join(fixture.root, 'usb-stick')).map((file) => file.fileName))
        .toEqual([result.backup.fileName])
    } finally {
      fixture.close()
    }
  })
})
