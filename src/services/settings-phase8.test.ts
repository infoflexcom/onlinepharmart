import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { getCurrency } from '@shared/currency/catalog'
import { defaultDisplayOptions } from '@shared/currency/money'
import {
  DEFAULT_OPERATIONAL_SETTINGS,
  type AuditEvent,
  type OperationalSettings,
} from '@shared/shop/types'
import { normalizeOperationalSettings, normalizeShopProfile } from '@shared/shop/validation'
import { SQLiteShopRepository } from '../db/sqlite-shop-repository'
import { ShopService } from './shop-service'

const NGN = getCurrency('NGN')!

function createShop(): { repository: SQLiteShopRepository; database: Database.Database; service: ShopService; audits: () => AuditEvent[] } {
  const database = new Database(':memory:')
  const repository = new SQLiteShopRepository(database)
  const service = new ShopService(repository, { deviceName: 'TILL-PC', ipAddress: null }, () => new Date('2026-11-17T10:00:00.000Z'))
  repository.saveSettings({
    ...repository.readSettings(),
    profile: { name: 'Harbor Health', address: '12 Dock Road', phone: '+234 1 555 0100' },
    currency: NGN,
    display: defaultDisplayOptions(NGN),
    setupComplete: true,
    currencyConfirmed: true,
  })
  const audits = (): AuditEvent[] =>
    (database.prepare('SELECT actor, action, metadata_json FROM audit_log ORDER BY rowid').all() as Array<{
      actor: string; action: string; metadata_json: string
    }>).map((row) => ({ actor: row.actor, action: row.action, metadata: JSON.parse(row.metadata_json), deviceName: 'TILL-PC', ipAddress: null, createdAt: '' }))
  return { repository, database, service, audits }
}

describe('operational settings', () => {
  it('defaults to an 80 mm receipt with every payment method and VAT off', () => {
    const { repository } = createShop()
    const operational = repository.readSettings().operational
    expect(operational.documentLayout).toBe('THERMAL_80')
    expect(operational.enabledPaymentMethods).toEqual(['CASH', 'TRANSFER', 'CARD', 'CREDIT'])
    expect(operational.vatEnabled).toBe(false)
    expect(operational.vatRateBasisPoints).toBe(0)
    expect(operational.discountLimitBasisPoints).toBe(10_000)
    expect(operational.showPoweredBy).toBe(true)
    expect(operational.expiryAlertDays).toBe(90)
    expect(operational.supervisorPinLength).toBe(4)
  })

  it('round-trips every receipt and edition option through the database', () => {
    const { repository, service, audits } = createShop()
    const next: OperationalSettings = {
      ...DEFAULT_OPERATIONAL_SETTINGS,
      showPoweredBy: false,
      documentLayout: 'THERMAL_58',
      vatEnabled: true,
      vatRateBasisPoints: 750,
      vatInclusive: true,
      discountLimitBasisPoints: 1_500,
      printerName: 'EPSON TM-T20',
      enabledPaymentMethods: ['CASH', 'TRANSFER'],
      expiryAlertDays: 45,
      loyaltyRateBasisPoints: 3,
      supervisorPinRequired: false,
      supervisorPinLength: 6,
      scaleEnabled: true,
      scalePort: 'COM3',
    }
    service.updateOperationalSettings(next, 'admin.jane')

    const stored = repository.readSettings().operational
    expect(stored).toEqual(next)
    const audit = audits().find((event) => event.action === 'settings.operational.updated')
    expect(audit).toBeDefined()
    expect(audit!.actor).toBe('admin.jane')
    expect(audit!.metadata).toMatchObject({ documentLayout: 'THERMAL_58', vatRateBasisPoints: 750, enabledPaymentMethods: ['CASH', 'TRANSFER'] })
    // The monetary columns are untouched: these options never rewrite a stored amount or currency.
    const row = repository.readSettings()
    expect(row.currency.code).toBe('NGN')
  })

  it('rejects an empty store name, a bad layout, an empty payment list, and out-of-range numbers', () => {
    const { service } = createShop()
    expect(() => service.updateStoreDetails({ name: '   ', address: '', phone: '' }, 'admin.jane')).toThrow(/store name/i)
    expect(() => service.updateOperationalSettings({ ...DEFAULT_OPERATIONAL_SETTINGS, documentLayout: 'A3_SCROLL' as never }, 'admin.jane')).toThrow(/paper size/i)
    expect(() => service.updateOperationalSettings({ ...DEFAULT_OPERATIONAL_SETTINGS, enabledPaymentMethods: [] }, 'admin.jane')).toThrow(/at least one payment method/i)
    expect(() => service.updateOperationalSettings({ ...DEFAULT_OPERATIONAL_SETTINGS, vatRateBasisPoints: 20_000 }, 'admin.jane')).toThrow(/VAT rate/i)
    expect(() => service.updateOperationalSettings({ ...DEFAULT_OPERATIONAL_SETTINGS, vatRateBasisPoints: 7.5 as never }, 'admin.jane')).toThrow(/VAT rate/i)
    expect(() => service.updateOperationalSettings({ ...DEFAULT_OPERATIONAL_SETTINGS, supervisorPinLength: 3 }, 'admin.jane')).toThrow(/PIN length/i)
    expect(() => service.updateOperationalSettings({ ...DEFAULT_OPERATIONAL_SETTINGS, expiryAlertDays: 0 }, 'admin.jane')).toThrow(/expiry alert/i)
  })

  it('stores the "Powered by Infoflex" choice and logs the change', () => {
    const { repository, service, audits } = createShop()
    service.updateOperationalSettings({ ...DEFAULT_OPERATIONAL_SETTINGS, showPoweredBy: false }, 'admin.jane')
    expect(repository.readSettings().operational.showPoweredBy).toBe(false)
    expect(audits().some((event) => event.action === 'settings.operational.updated')).toBe(true)
  })

  it('saves a valid logo and rejects anything that is not an approved image', () => {
    const { service } = createShop()
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const saved = service.updateStoreDetails({ name: 'Harbor Health', address: '', phone: '', storeLogo: png }, 'admin.jane')
    expect(saved.profile.storeLogo).toBe(png)
    expect(() => normalizeShopProfile({ name: 'Harbor Health', address: '', phone: '', storeLogo: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }))
      .toThrow(/PNG, JPEG, or WebP/i)
  })

  it('rejects a logo larger than the storage budget', () => {
    const huge = `data:image/png;base64,${'A'.repeat(1_500_000)}`
    expect(() => normalizeShopProfile({ name: 'Harbor Health', address: '', phone: '', storeLogo: huge })).toThrow(/smaller than 1 MB/i)
  })
})

describe('currency lock explanations', () => {
  it('reports a vendor lock separately from a transaction lock', () => {
    const { repository, database, service } = createShop()
    database.prepare('UPDATE settings SET currency_locked = 1, currency_locked_by_vendor = 1 WHERE id = 1').run()
    const settings = repository.readSettings()
    expect(settings.currencyLocked).toBe(true)
    expect(settings.currencyLockedByVendor).toBe(true)
    // A vendor lock is final: the change is refused with the vendor wording.
    expect(() => service.changeCurrency(getCurrency('USD')!, true, 'admin.jane')).toThrow(/vendor/i)
  })

  it('allows a currency change before the first transaction and refuses it afterwards', () => {
    const { repository, service } = createShop()
    const changed = service.changeCurrency(getCurrency('JPY')!, true, 'admin.jane')
    expect(changed.currency.code).toBe('JPY')
    expect(repository.readSettings().currencyLocked).toBe(false)

    service.recordBusinessEntry('sale', 5_000n, 'admin.jane')
    expect(() => service.changeCurrency(getCurrency('NGN')!, true, 'admin.jane'))
      .toThrow(/transactions|first transaction/i)
  })

  it('keeps display options editable after the currency is locked, without touching amounts', () => {
    const { repository, service } = createShop()
    service.recordBusinessEntry('sale', 5_000n, 'admin.jane')
    const before = repository.readSettings()
    const updated = service.updateDisplaySettings({
      amountDisplay: 'code',
      symbolPosition: 'after',
      thousandsSeparator: '.',
      decimalSeparator: ',',
    }, 'admin.jane')
    expect(updated.display.amountDisplay).toBe('code')
    expect(updated.currency.code).toBe(before.currency.code)
    const entry = repository.readSettings()
    expect(entry.currency.code).toBe('NGN')
  })
})

describe('operational settings validation rules', () => {
  it('returns payment methods in the canonical order with duplicates removed', () => {
    const normalized = normalizeOperationalSettings({
      ...DEFAULT_OPERATIONAL_SETTINGS,
      enabledPaymentMethods: ['CREDIT', 'CASH', 'CREDIT'] as never,
    })
    expect(normalized.enabledPaymentMethods).toEqual(['CASH', 'CREDIT'])
  })

  it('rejects unknown payment methods outright', () => {
    expect(() => normalizeOperationalSettings({
      ...DEFAULT_OPERATIONAL_SETTINGS,
      enabledPaymentMethods: ['CASH', 'BITCOIN'] as never,
    })).toThrow(/valid payment method/i)
  })

  it('accepts a 100% VAT ceiling and a zero discount limit', () => {
    const normalized = normalizeOperationalSettings({
      ...DEFAULT_OPERATIONAL_SETTINGS,
      vatEnabled: true,
      vatRateBasisPoints: 10_000,
      discountLimitBasisPoints: 0,
    })
    expect(normalized.vatRateBasisPoints).toBe(10_000)
    expect(normalized.discountLimitBasisPoints).toBe(0)
  })
})
