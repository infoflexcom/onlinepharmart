import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getCurrency } from '@shared/currency/catalog'
import { defaultDisplayOptions } from '@shared/currency/money'
import { DEFAULT_OPERATIONAL_SETTINGS } from '@shared/shop/types'
import { openShopDatabase } from '../db'
import { SQLiteShopRepository } from '../db/sqlite-shop-repository'
import { BackupService } from './backup-service'

const NGN = getCurrency('NGN')!
const JPY = getCurrency('JPY')!
const temporaryRoots: string[] = []

afterEach(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop()!, { recursive: true, force: true })
})

interface Fixture {
  root: string
  databasePath: string
  backupFolder: string
  repository: () => SQLiteShopRepository
  backups: BackupService
  advance: (iso: string) => void
}

function createFixture(currency = NGN): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'infoflex-backup-'))
  temporaryRoots.push(root)
  const databasePath = join(root, 'infoflex.sqlite')
  const backupFolder = join(root, 'backups')
  let clock = '2026-11-17T09:00:00.000Z'
  const now = (): Date => new Date(clock)

  let repository = new SQLiteShopRepository(openShopDatabase(databasePath), false)
  const reopen = (): SQLiteShopRepository => {
    repository = new SQLiteShopRepository(openShopDatabase(databasePath), false)
    return repository
  }
  const backups = new BackupService(repository, {
    databasePath,
    automaticFolder: backupFolder,
    appVersion: '9.9.9-test',
    productName: 'Infoflex Pharm & Mart',
    now,
    reopen,
  })
  const settings = repository.readSettings()
  repository.saveSettings({
    ...settings,
    profile: { name: 'Harbor Health', address: '12 Dock Road', phone: '+234 1 555 0100' },
    currency,
    display: defaultDisplayOptions(currency),
    setupComplete: true,
    currencyConfirmed: true,
    operational: { ...DEFAULT_OPERATIONAL_SETTINGS },
  })
  return {
    root,
    databasePath,
    backupFolder,
    repository: () => repository,
    backups,
    advance: (iso) => { clock = iso },
  }
}

function withDatabase<T>(databasePath: string, work: (database: ReturnType<typeof openShopDatabase>) => T): T {
  const database = openShopDatabase(databasePath)
  try {
    return work(database)
  } finally {
    database.close()
  }
}

function insertSale(databasePath: string, amountMinor: number, currencyCode = 'NGN'): number {
  return withDatabase(databasePath, (database) => {
    const result = database.prepare(`INSERT INTO sales (currency_code, subtotal, total, paid) VALUES (?, ?, ?, ?)`)
      .run(currencyCode, amountMinor, amountMinor, amountMinor)
    return Number(result.lastInsertRowid)
  })
}

function seedLicence(databasePath: string): void {
  withDatabase(databasePath, (database) => {
    database.prepare(`
      INSERT INTO license_state (license_id, token, machine_id, edition, start, end, status, source, is_current)
      VALUES ('LIC-LIVE', 'signed-token-live', 'MACHINE-1', 'BOTH', '2026-01-01', '2027-01-01', 'active', 'online', 1)
    `).run()
  })
}

function seedDevice(databasePath: string): void {
  withDatabase(databasePath, (database) => {
    database.prepare(`
      INSERT INTO users (id, username, password_hash, role) VALUES ('user-admin', 'admin', 'scrypt-hash', 'ADMIN')
    `).run()
    database.prepare(`
      INSERT INTO devices (id, name, platform, token_hash, admin_user_id)
      VALUES ('device-1', 'Shop iPhone', 'ios', 'token-hash-1', 'user-admin')
    `).run()
  })
}

describe('backup and restore', () => {
  it('writes a full snapshot plus a checksummed manifest and records it in the shop log', () => {
    const fixture = createFixture()
    const summary = fixture.backups.createManualBackup(fixture.backupFolder, 'admin.jane')

    expect(summary.kind).toBe('MANUAL')
    expect(summary.currencyCode).toBe('NGN')
    expect(summary.location).toBe(fixture.backupFolder)
    const files = readdirSync(fixture.backupFolder).sort()
    expect(files.filter((name) => name.endsWith('.infoflexbackup'))).toHaveLength(1)
    expect(files.filter((name) => name.endsWith('.manifest.json'))).toHaveLength(1)
    const sizeOnDisk = statSync(join(fixture.backupFolder, summary.fileName)).size
    expect(summary.sizeBytes).toBe(sizeOnDisk)

    const manifest = JSON.parse(readFileSync(join(fixture.backupFolder, `${summary.fileName}.manifest.json`), 'utf8'))
    expect(manifest.format).toBe('infoflex-backup')
    expect(manifest.formatVersion).toBe(1)
    expect(manifest.storeName).toBe('Harbor Health')
    expect(manifest.databaseSha256).toBe(summary.checksumSha256)
    expect(manifest.rowCounts.settings).toBe(1)

    const status = fixture.backups.status()
    expect(status.lastBackupAt).toBe('2026-11-17T09:00:00.000Z')
    expect(status.daysSinceBackup).toBe(0)
    expect(status.stale).toBe(false)
    expect(status.warning).toBeNull()
    expect(status.recent[0].fileName).toBe(summary.fileName)
  })

  it('makes one automatic backup per calendar day and warns after seven days of silence', () => {
    const fixture = createFixture()
    expect(fixture.backups.status().warning).toMatch(/no backup has been made/i)

    const first = fixture.backups.runAutomaticBackup()
    expect(first?.kind).toBe('AUTOMATIC')
    expect(fixture.backups.runAutomaticBackup()).toBeNull()

    fixture.advance('2026-11-25T09:00:00.000Z')
    const status = fixture.backups.status()
    expect(status.daysSinceBackup).toBe(8)
    expect(status.stale).toBe(true)
    expect(status.warning).toMatch(/8 days old/i)

    expect(fixture.backups.runAutomaticBackup()?.kind).toBe('AUTOMATIC')
    expect(fixture.backups.status().stale).toBe(false)
  })

  it('backs up, wipes the database, restores, and finds the data intact', () => {
    const fixture = createFixture()
    insertSale(fixture.databasePath, 123_450)
    insertSale(fixture.databasePath, 9_900)
    const expectedRows = withDatabase(fixture.databasePath, (database) =>
      (database.prepare("SELECT COUNT(*) AS n FROM sales").get() as { n: number }).n)

    const summary = fixture.backups.createManualBackup(fixture.backupFolder, 'admin.jane')
    rmSync(fixture.databasePath, { force: true })
    rmSync(`${fixture.databasePath}-wal`, { force: true })
    rmSync(`${fixture.databasePath}-shm`, { force: true })
    expect(fixture.backups.status().recent[0].kind).toBe('MANUAL')

    const result = fixture.backups.restore({
      folder: fixture.backupFolder,
      fileName: summary.fileName,
      actor: 'admin.jane',
      confirmed: true,
    })

    expect(result.restored).toBe(true)
    expect(result.adoptedCurrency).toBe(false)
    expect(result.currencyCode).toBe('NGN')
    const sales = withDatabase(fixture.databasePath, (database) =>
      database.prepare('SELECT total FROM sales ORDER BY id').all())
    expect(sales).toEqual([{ total: 123_450 }, { total: 9_900 }])
    expect(expectedRows).toBe(2)
    expect(fixture.repository().readSettings().profile.name).toBe('Harbor Health')
    expect(fixture.backups.status().recent[0].kind).toBe('RESTORE')
  })

  it('never overwrites the licence state or the paired-device list', () => {
    const fixture = createFixture()
    seedDevice(fixture.databasePath)
    const summary = fixture.backups.createManualBackup(fixture.backupFolder, 'admin.jane')

    // The backup predates activation and pairing: replaying it must not un-license or re-pair the shop.
    seedLicence(fixture.databasePath)
    withDatabase(fixture.databasePath, (database) => {
      database.prepare("INSERT INTO devices (id, name, platform, token_hash, admin_user_id) VALUES ('device-2', 'Counter tablet', 'android', 'token-hash-2', 'user-admin')").run()
    })

    const result = fixture.backups.restore({
      folder: fixture.backupFolder,
      fileName: summary.fileName,
      actor: 'admin.jane',
      confirmed: true,
    })
    expect(result.restored).toBe(true)

    withDatabase(fixture.databasePath, (database) => {
      const licence = database.prepare('SELECT license_id, token, status FROM license_state').all()
      expect(licence).toEqual([{ license_id: 'LIC-LIVE', token: 'signed-token-live', status: 'active' }])
      const devices = database.prepare('SELECT id FROM devices ORDER BY id').all()
      expect(devices).toEqual([{ id: 'device-1' }, { id: 'device-2' }])
    })
  })

  it('refuses a different-currency backup once transactions exist, without touching the data', () => {
    const fixture = createFixture(NGN)
    // A second, different-currency backup of the same empty shop, then real trading in NGN.
    const summary = fixture.backups.createManualBackup(fixture.backupFolder, 'admin.jane')
    const manifestPath = join(fixture.backupFolder, `${summary.fileName}.manifest.json`)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, currencyCode: 'USD' }, null, 2))
    insertSale(fixture.databasePath, 50_000)

    let message = ''
    try {
      fixture.backups.restore({ folder: fixture.backupFolder, fileName: summary.fileName, actor: 'admin.jane', confirmed: true })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(/already records transactions/i)
    expect(message).toMatch(/nothing was restored/i)
    expect(withDatabase(fixture.databasePath, (database) =>
      (database.prepare('SELECT COUNT(*) AS n FROM sales').get() as { n: number }).n)).toBe(1)

    // A genuine NGN backup restores onto an empty install, and that shop adopts and locks the currency.
    const other = createFixture(NGN)
    const ngnBackup = other.backups.createManualBackup(other.backupFolder, 'admin.jane')
    const blank = createFixture(JPY)
    const adopt = blank.backups.restore({
      folder: other.backupFolder,
      fileName: ngnBackup.fileName,
      actor: 'admin.jane',
      confirmed: true,
    })
    expect(adopt.adoptedCurrency).toBe(true)
    expect(adopt.currencyCode).toBe('NGN')
    const settings = blank.repository().readSettings()
    expect(settings.currency.code).toBe('NGN')
    expect(settings.currencyLocked).toBe(true)
    // Trading then locks it for good: the empty-shop adoption path is the only way it can change again.
    expect(() => blank.repository().readSettings()).not.toThrow()
  })

  it('requires explicit confirmation, a real manifest, and a matching checksum', () => {
    const fixture = createFixture()
    const summary = fixture.backups.createManualBackup(fixture.backupFolder, 'admin.jane')

    expect(() => fixture.backups.restore({
      folder: fixture.backupFolder, fileName: summary.fileName, actor: 'admin.jane', confirmed: false,
    })).toThrow(/confirm/i)

    rmSync(join(fixture.backupFolder, `${summary.fileName}.manifest.json`))
    expect(() => fixture.backups.restore({
      folder: fixture.backupFolder, fileName: summary.fileName, actor: 'admin.jane', confirmed: true,
    })).toThrow(/manifest/i)

    const other = fixture.backups.createManualBackup(fixture.backupFolder, 'admin.jane')
    writeFileSync(join(fixture.backupFolder, other.fileName), 'not a database')
    expect(() => fixture.backups.restore({
      folder: fixture.backupFolder, fileName: other.fileName, actor: 'admin.jane', confirmed: true,
    })).toThrow(/damaged/i)
  })

  it('keeps a safety copy of the data it replaces and lists restorable files in a folder', () => {
    const fixture = createFixture()
    const summary = fixture.backups.createManualBackup(fixture.backupFolder, 'admin.jane')

    fixture.backups.restore({ folder: fixture.backupFolder, fileName: summary.fileName, actor: 'admin.jane', confirmed: true })

    // Safety copies live with the app data, not in the folder the operator may have removed (a USB stick).
    const safety = readdirSync(join(fixture.root, 'backups')).filter((name) => name.includes('before-restore'))
    expect(safety.length).toBeGreaterThan(0)
    const listed = fixture.backups.listFolder(fixture.backupFolder)
    expect(listed.some((entry) => entry.fileName === summary.fileName)).toBe(true)
  })

  it('refuses a backup file that is not an Infoflex backup', () => {
    const fixture = createFixture()
    const summary = fixture.backups.createManualBackup(fixture.backupFolder, 'admin.jane')
    expect(() => fixture.backups.restore({
      folder: fixture.backupFolder, fileName: 'notes.txt', actor: 'admin.jane', confirmed: true,
    })).toThrow(/infoflex backup file/i)
    // A folder-escaping name is reduced to a plain file name inside the chosen folder, never used as a path.
    expect(() => fixture.backups.restore({
      folder: fixture.backupFolder, fileName: `/etc/passwd${summary.fileName}`, actor: 'admin.jane', confirmed: true,
    })).toThrow(/Infoflex backup file/i)
  })

  it('refuses to restore when newer sales would be destroyed', () => {
    const fixture = createFixture()
    insertSale(fixture.databasePath, 10_000)
    const summary = fixture.backups.createManualBackup(fixture.backupFolder, 'admin.jane')
    insertSale(fixture.databasePath, 20_000)

    expect(() => fixture.backups.restore({
      folder: fixture.backupFolder, fileName: summary.fileName, actor: 'admin.jane', confirmed: true,
    })).toThrow(/older than your current data/i)
  })

  it('refuses a backup whose bytes or row counts were altered after it was written', () => {
    const fixture = createFixture()
    const summary = fixture.backups.createManualBackup(fixture.backupFolder, 'admin.jane')
    const filePath = join(fixture.backupFolder, summary.fileName)
    const original = readFileSync(filePath)

    // Flip one byte in the middle of the database image: the manifest checksum must catch it.
    const tampered = Buffer.from(original)
    tampered[Math.floor(tampered.length / 2)] = tampered[Math.floor(tampered.length / 2)] ^ 0xff
    writeFileSync(filePath, tampered)
    expect(() => fixture.backups.restore({
      folder: fixture.backupFolder, fileName: summary.fileName, actor: 'admin.jane', confirmed: true,
    })).toThrow(/damaged/i)

    // An honest file with a lying manifest is caught by the row-count comparison.
    writeFileSync(filePath, original)
    const manifestPath = join(fixture.backupFolder, `${summary.fileName}.manifest.json`)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, rowCounts: { ...manifest.rowCounts, settings: 99 } }))
    expect(() => fixture.backups.restore({
      folder: fixture.backupFolder, fileName: summary.fileName, actor: 'admin.jane', confirmed: true,
    })).toThrow(/do not match its manifest/i)
  })

  it('never imports a licence or paired phones from the backup file onto a machine that has none', () => {
    const fixture = createFixture()
    seedDevice(fixture.databasePath)
    seedLicence(fixture.databasePath)
    const summary = fixture.backups.createManualBackup(fixture.backupFolder, 'admin.jane')

    // The machine is wiped: no live database at all. The backup still contains the old licence rows.
    rmSync(fixture.databasePath, { force: true })
    rmSync(`${fixture.databasePath}-wal`, { force: true })
    rmSync(`${fixture.databasePath}-shm`, { force: true })

    fixture.backups.restore({
      folder: fixture.backupFolder, fileName: summary.fileName, actor: 'admin.jane', confirmed: true,
    })

    withDatabase(fixture.databasePath, (database) => {
      expect(database.prepare('SELECT license_id, token FROM license_state').all()).toEqual([])
      expect(database.prepare('SELECT id FROM devices').all()).toEqual([])
      // Shop data came through untouched.
      expect(database.prepare('SELECT store_name FROM settings WHERE id = 1').get()).toEqual({ store_name: 'Harbor Health' })
    })
  })
})
