import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getCurrency } from '@shared/currency/catalog'
import { defaultDisplayOptions } from '@shared/currency/money'
import type { FirstRunInput } from '@shared/shop/types'
import { SQLiteShopRepository } from './sqlite-shop-repository'
import { ShopService } from '../services/shop-service'

const NGN = getCurrency('NGN')!
const input: FirstRunInput = {
  admin: { fullName: 'Test Admin', username: 'testadmin', password: 'T3st-Admin!2026', confirmPassword: 'T3st-Admin!2026' },
  profile: { name: 'Harbor Health', address: '12 Dock Road', phone: '+234 1 555 0100' },
  currency: NGN,
  display: defaultDisplayOptions(NGN),
  currencyConfirmed: true,
}

function createRepository(): { repository: SQLiteShopRepository; database: Database.Database } {
  const database = new Database(':memory:')
  const repository = new SQLiteShopRepository(database)
  return { repository, database }
}

function configureShop(repository: SQLiteShopRepository): void {
  repository.saveSettings({
    ...repository.readSettings(),
    profile: input.profile,
    currency: input.currency,
    display: input.display,
    setupComplete: true,
    currencyConfirmed: true,
  })
}

describe('SQLite shop repository', () => {
  it('loads NGN as the initial currency from the currency catalog, not a hard-coded symbol', () => {
    const { repository } = createRepository()
    const settings = repository.readSettings()
    expect(settings.currency.code).toBe('NGN')
    expect(settings.currency.symbol).toBe(NGN.symbol)
    expect(settings.setupComplete).toBe(false)
    repository.close()
  })

  it('persists setup, integer amounts, currency, and immutable identity snapshots', () => {
    const { repository, database } = createRepository()
    const service = new ShopService(repository, { deviceName: 'TILL-PC', ipAddress: null }, () => new Date('2026-11-17T13:45:00.000Z'), () => 'sale-1')
    configureShop(repository)
    service.recordBusinessEntry('sale', 9007199254740993n, 'admin.test')

    const row = database.prepare(`
      SELECT currency_code, amount_minor, typeof(amount_minor) AS amount_type,
        store_name_snapshot, store_address_snapshot, store_phone_snapshot
      FROM business_entries WHERE id = 'sale-1'
    `).safeIntegers().get() as {
      currency_code: string
      amount_minor: bigint
      amount_type: string
      store_name_snapshot: string
      store_address_snapshot: string
      store_phone_snapshot: string
    }
    expect(row).toEqual({
      currency_code: 'NGN',
      amount_minor: 9007199254740993n,
      amount_type: 'integer',
      store_name_snapshot: 'Harbor Health',
      store_address_snapshot: '12 Dock Road',
      store_phone_snapshot: '+234 1 555 0100',
    })
    expect(repository.isCurrencyLocked()).toBe(true)
    expect(repository.readSettings().setupComplete).toBe(true)
    repository.close()
  })

  it('persists first-run settings when the shop database is reopened', () => {
    const directory = mkdtempSync(join(tmpdir(), 'infoflex-shop-'))
    const databasePath = join(directory, 'shop.sqlite')
    try {
      const firstRepository = new SQLiteShopRepository(new Database(databasePath))
      configureShop(firstRepository)
      firstRepository.close()

      const reopenedRepository = new SQLiteShopRepository(new Database(databasePath))
      expect(reopenedRepository.readSettings()).toMatchObject({
        profile: input.profile,
        currency: input.currency,
        setupComplete: true,
        currencyConfirmed: true,
      })
      reopenedRepository.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('persists the configurable return window in SQLite and audits updates', () => {
    const { repository, database } = createRepository()
    const service = new ShopService(repository, { deviceName: 'TILL-PC', ipAddress: null }, () => new Date('2026-11-17T13:45:00.000Z'), () => 'return-window-entry')
    configureShop(repository)
    expect(repository.readSettings().returnWindowDays).toBe(7)
    expect(service.updateReturnWindowDays(30, 'admin.test').returnWindowDays).toBe(30)
    expect(database.prepare('SELECT return_window_days FROM settings WHERE id = 1').get()).toEqual({ return_window_days: 30 })
    expect(database.prepare("SELECT action, metadata_json FROM audit_log WHERE action = 'returns.window.updated'").get()).toMatchObject({
      action: 'returns.window.updated', metadata_json: '{"days":30}',
    })
    expect(() => service.updateReturnWindowDays(0, 'admin.test')).toThrow(/whole number from 1 to 365/u)
    database.exec(`
      CREATE TRIGGER reject_return_window_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'returns.window.updated'
      BEGIN SELECT RAISE(ABORT, 'return-window audit unavailable'); END;
    `)
    expect(() => service.updateReturnWindowDays(60, 'admin.test')).toThrow(/return-window audit unavailable/u)
    expect(repository.readSettings().returnWindowDays).toBe(30)
    repository.close()
  })

  it('rolls back a business entry if its audit write fails', () => {
    const { repository, database } = createRepository()
    const service = new ShopService(repository)
    configureShop(repository)
    database.exec(`
      CREATE TRIGGER reject_audit_insert BEFORE INSERT ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;
    `)
    expect(() => service.recordBusinessEntry('sale', 100n, 'admin.test')).toThrow(/audit unavailable/i)
    const count = database.prepare('SELECT COUNT(*) AS count FROM business_entries').get() as { count: number }
    expect(count.count).toBe(0)
    repository.close()
  })

  it('prevents deletion of completed business records', () => {
    const { repository, database } = createRepository()
    const service = new ShopService(repository)
    configureShop(repository)
    const entry = service.recordBusinessEntry('sale', 10n, 'admin.test')
    expect(() => database.prepare('DELETE FROM business_entries WHERE id = ?').run(entry.id)).toThrow(/cannot be deleted/i)
    expect(() => database.prepare('UPDATE business_entries SET store_name_snapshot = ? WHERE id = ?').run('Changed name', entry.id)).toThrow(/cannot be changed/i)
    repository.close()
  })
})
