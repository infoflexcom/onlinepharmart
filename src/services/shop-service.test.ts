import { describe, expect, it } from 'vitest'
import { createCustomCurrency, getCurrency } from '@shared/currency/catalog'
import { defaultDisplayOptions } from '@shared/currency/money'
import { DEFAULT_OPERATIONAL_SETTINGS, type AuditEvent, type BackupSummary, type BusinessEntry, type ShopProfile, type ShopSettings } from '@shared/shop/types'
import { ShopService } from './shop-service'
import type { ShopRepository } from './contracts/shop-repository'

const NGN = getCurrency('NGN')!

class MemoryShopRepository implements ShopRepository {
  settings: ShopSettings = {
    profile: { name: '', address: '', phone: '' },
    currency: NGN,
    display: defaultDisplayOptions(NGN),
    setupComplete: false,
    currencyConfirmed: false,
    currencyLocked: false,
    idleTimeoutMinutes: 15,
    operational: { ...DEFAULT_OPERATIONAL_SETTINGS },
  }
  entries: BusinessEntry[] = []
  audits: AuditEvent[] = []
  failAudit = false

  readSettings(): ShopSettings { return structuredClone(this.settings) }
  saveSettings(settings: ShopSettings): void { this.settings = structuredClone(settings) }
  isCurrencyLocked(): boolean { return this.settings.currencyLocked || this.entries.some(({ kind }) => ['sale', 'purchase', 'return', 'stock_valuation'].includes(kind)) }
  setIdleTimeoutMinutes(minutes: number): void { this.settings.idleTimeoutMinutes = minutes }
  isCurrencyLockedByVendor(): boolean { return this.settings.currencyLockedByVendor === true }
  backups: BackupSummary[] = []
  readBackupLog(limit = 20): BackupSummary[] { return structuredClone(this.backups.slice(0, limit)) }
  appendBackup(entry: BackupSummary): void { this.backups.unshift(structuredClone(entry)) }
  appendAudit(event: AuditEvent): void {
    if (this.failAudit) throw new Error('audit storage failed')
    this.audits.push(structuredClone(event))
  }
  insertBusinessEntry(entry: BusinessEntry): void { this.entries.push(structuredClone(entry)) }
  withTransaction<T>(work: () => T): T {
    const before = structuredClone({ settings: this.settings, entries: this.entries, audits: this.audits })
    try { return work() } catch (error) {
      this.settings = before.settings
      this.entries = before.entries
      this.audits = before.audits
      throw error
    }
  }
}

function configuredService(repository = new MemoryShopRepository()): { service: ShopService; repository: MemoryShopRepository } {
  repository.settings = {
    ...repository.settings,
    profile: { name: 'Greenfield Pharmacy', address: '4 Market Road', phone: '+234 800 000 0000' },
    setupComplete: true,
    currencyConfirmed: true,
  }
  const service = new ShopService(repository, { deviceName: 'SHOP-PC', ipAddress: null }, () => new Date('2026-11-17T12:00:00.000Z'), () => 'entry-1')
  return { service, repository }
}

describe('shop service', () => {
  it('audits remote access denials with device/IP context and strips control characters', () => {
    const repository = new MemoryShopRepository()
    const service = new ShopService(repository, { deviceName: 'SHOP-PC', ipAddress: null }, () => new Date('2026-11-17T12:00:00.000Z'))
    service.recordDeniedAccess({
      reason: 'non_admin',
      actor: 'cashier.test',
      ipAddress: '203.0.113.7',
      userAgent: 'Admin PWA\r\nmobile',
    })
    expect(repository.audits[0]).toMatchObject({
      actor: 'cashier.test',
      action: 'host.access.denied',
      deviceName: 'Admin PWA mobile',
      ipAddress: '203.0.113.7',
      metadata: { reason: 'non_admin', userAgent: 'Admin PWA mobile' },
      createdAt: '2026-11-17T12:00:00.000Z',
    })
  })

  it('requires a customer-entered store name and audits later profile changes', () => {
    const { service, repository } = configuredService()
    const invalid: ShopProfile = { name: ' ', address: '', phone: '' }
    expect(() => service.updateStoreDetails(invalid, 'admin.test')).toThrow(/store name/i)
    const updated = service.updateStoreDetails({
      name: '  Greenfield Pharmacy  ', address: '  9 New Road ', phone: ' +234 900 000 0000 ',
      email: 'shop@example.com', licenceNumber: 'PCN-42', taxNumber: 'TIN-3', receiptFooter: 'Thank you',
    }, 'admin.test')
    expect(updated.profile).toMatchObject({
      name: 'Greenfield Pharmacy', address: '9 New Road', phone: '+234 900 000 0000',
      email: 'shop@example.com', licenceNumber: 'PCN-42', taxNumber: 'TIN-3', receiptFooter: 'Thank you',
    })
    expect(repository.audits.at(-1)?.action).toBe('shop.profile.updated')
  })

  it('accepts a validated custom currency and rejects an ISO code disguised as custom', () => {
    const custom = createCustomCurrency({ code: 'CRD', name: 'Store credits', symbol: 'cr', decimalPlaces: 0 })
    const { service } = configuredService()
    expect(service.changeCurrency(custom, true, 'admin.test').currency).toEqual(custom)
    expect(() => createCustomCurrency({ code: 'NGN', name: 'Fake naira', symbol: 'N', decimalPlaces: 2 })).toThrow(/ISO currency/i)
    expect(() => createCustomCurrency({ code: 'X', name: 'Invalid', symbol: 'x', decimalPlaces: 2 })).toThrow(/currency code/i)
  })

  it('snapshots shop identity and currency in each integer-minor-unit business record', () => {
    const { service, repository } = configuredService()
    const entry = service.recordBusinessEntry('sale', 987654321n, 'cashier.test')
    expect(entry).toMatchObject({
      kind: 'sale', currencyCode: 'NGN', amountMinor: 987654321n,
      storeNameSnapshot: 'Greenfield Pharmacy', storeAddressSnapshot: '4 Market Road',
      storePhoneSnapshot: '+234 800 000 0000', createdAt: '2026-11-17T12:00:00.000Z',
    })
    expect(repository.entries).toHaveLength(1)
    expect(repository.audits.at(-1)?.metadata).toMatchObject({ amountMinor: '987654321', currencyCode: 'NGN' })
  })

  it.each(['sale', 'purchase', 'return', 'stock_valuation'] as const)('locks currency after a %s entry', (kind) => {
    const { service } = configuredService()
    service.recordBusinessEntry(kind, 1n, 'cashier.test')
    expect(() => service.changeCurrency(getCurrency('USD')!, true, 'admin.test')).toThrow(/locked/i)
  })

  it('does not use day close alone as the currency lock trigger', () => {
    const { service } = configuredService()
    const dayClose = service.recordBusinessEntry('day_close', 0n, 'admin.test')
    expect(dayClose.currencyCode).toBe('NGN')
    expect(service.changeCurrency(getCurrency('USD')!, true, 'admin.test').currency.code).toBe('USD')
  })

  it('rejects invalid amounts and rolls back entry plus audit atomically', () => {
    const { service, repository } = configuredService()
    expect(() => service.recordBusinessEntry('sale', -1n, 'cashier.test')).toThrow(/non-negative/i)
    expect(() => service.recordBusinessEntry('sale', 9_223_372_036_854_775_808n, 'cashier.test')).toThrow(/SQLite integer/i)
    repository.failAudit = true
    expect(() => service.recordBusinessEntry('sale', 1n, 'cashier.test')).toThrow(/audit storage failed/i)
    expect(repository.entries).toHaveLength(0)
  })

  it('changes display preferences and idle timeout through the host service', () => {
    const { service, repository } = configuredService()
    const next = service.updateDisplaySettings({
      amountDisplay: 'code', symbolPosition: 'after', thousandsSeparator: ' ', decimalSeparator: ',',
    }, 'admin.test')
    expect(next.currency.code).toBe('NGN')
    expect(next.display.amountDisplay).toBe('code')
    expect(service.updateIdleTimeout(30, 'admin.test').idleTimeoutMinutes).toBe(30)
    expect(repository.audits.at(-1)?.action).toBe('security.idle_timeout.updated')
    expect(() => service.updateIdleTimeout(0, 'admin.test')).toThrow(/between 1 and 240/i)
  })
})
