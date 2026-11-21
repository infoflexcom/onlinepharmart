import Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { getCurrency } from '../currency/catalog'
import { defaultDisplayOptions } from '../currency/money'
import { migrateDatabase } from '../db/migrate'
import { SQLiteShopRepository } from '../db/sqlite-shop-repository'
import { SQLiteUserRepository } from '../db/sqlite-user-repository'
import { ShopService } from '../services/shop-service'
import { SetupService } from '../services/setup-service'
import { AuthService } from '../services/auth-service'
import { UserService } from '../services/user-service'
import { ProductInventoryService } from '../services/product-inventory-service'
import { PointOfSaleService } from '../services/point-of-sale-service'
import { ReturnService } from '../services/return-service'
import { AccountingReportService } from '../services/accounting-report-service'
import { DesktopHostController } from '../main/desktop-host-controller'
import { registerDesktopIpc } from '../main/ipc'
import { createHostApi } from './server'
import type { LicenseManager } from '../license/license-manager'
import type { LicenseSummary } from '../shared/license/types'
import type { FirstRunInput } from '../shared/shop/types'

/**
 * The currency lock has to hold on every channel a determined caller could try, not just on the Settings screen.
 *
 * Three are tested here, because they are three genuinely different code paths:
 *
 * 1. **The desktop IPC channel** — what the renderer calls. Passing raw values through `ipcRenderer.invoke` is
 *    exactly what a compromised or scripted renderer would do, so the handler's own guard must refuse.
 * 2. **The host controller directly** — the layer under the IPC, in case a future caller bypasses the channel.
 * 3. **The mobile HTTP API** — the phone has no currency route at all, and this test asserts that, rather than
 *    assuming it because the route table happens not to list one today. A route added later fails here.
 *
 * The lock is created the honest way: by recording the first sale. Nothing is poked into the database to
 * pretend a shop is busy.
 */

const PASSWORD = 'Harbor-Admin-Pass-9'
const NOW = Date.parse('2026-11-17T12:00:00.000Z')

const LICENCE: LicenseSummary = {
  status: 'active', canUse: true, licenseId: 'locked-currency', source: 'online', edition: 'BOTH',
  startsAt: null, endsAt: null, defaultCurrencyCode: null, lockCurrency: false,
  features: { mobileLan: true, mobileInternet: false }, adminPhoneLimit: 2, graceDays: 0,
  lastOnlineCheck: null, reportedToPortal: true, vendorConfigured: false,
  maximumOnsitePeriodYears: null, licenseServerUrl: null, message: 'active',
}

function firstRun(): FirstRunInput {
  const currency = getCurrency('NGN')!
  return {
    admin: { fullName: 'Ada Obi', username: 'shopadmin', password: PASSWORD, confirmPassword: PASSWORD },
    profile: { name: 'Harbor Health Pharmacy', address: '14 Marina Road', phone: '+234 800 111 2222' },
    currency, display: defaultDisplayOptions(currency), currencyConfirmed: true,
  }
}

async function createShop() {
  const database = new Database(':memory:')
  migrateDatabase(database)
  const repository = new SQLiteShopRepository(database, false)
  const users = new SQLiteUserRepository(database)
  const policy = { getVerifiedPolicy: () => ({ licenseId: 'locked', edition: 'BOTH' as const, defaultCurrencyCode: null, lockCurrency: false }) }
  let ids = 0
  const setup = new SetupService(repository, users, repository, policy, () => new Date(NOW), () => `lc-${++ids}`)
  const auth = new AuthService(users, repository, { deviceName: 'LOCK-PC', ipAddress: null }, () => new Date(NOW), () => NOW)
  const shopService = new ShopService(repository, { deviceName: 'LOCK-PC', ipAddress: null }, () => new Date(NOW), () => `lc-audit-${++ids}`)
  const userService = new UserService(users, repository, () => new Date(NOW), () => `lc-user-${++ids}`)
  const inventory = new ProductInventoryService(database, repository, { deviceName: 'LOCK-PC', now: () => NOW })
  const pos = new PointOfSaleService(database, repository, { workstation: 'LOCK-PC', now: () => NOW })
  const returns = new ReturnService(database, repository, { workstation: 'LOCK-PC', now: () => NOW })
  const reports = new AccountingReportService(database, repository, { now: () => NOW })
  const host = new DesktopHostController(
    repository, users, setup, auth, userService, shopService, () => NOW, '0.1.0',
    undefined, inventory, pos, returns, reports,
  )
  await host.initialize()
  await host.completeFirstRun(firstRun())
  await host.login(1, { username: 'shopadmin', password: PASSWORD })

  // One real sale, which is what locks the currency in production.
  const product = host.saveProduct(1, {
    sku: 'LOCK-001', name: 'First sale item', brand: '', description: '', barcode: '', additionalBarcodes: [],
    category: 'General', subCategory: '', department: '', shelfLocation: '', unit: 'each', packSizeUnits: 1,
    cost: '1.00', retailPrice: '2.00', wholesalePrice: '1.80', wholesaleMinimumQuantity: '1', reorderLevel: '1',
    genericName: '', prescriptionRequired: false, weighedItem: false, pluCode: '', pricePerKg: '',
    expiryTracking: false, variants: [], isActive: true,
  })
  host.receiveStock(1, {
    productId: product.id, expectedProductVersion: product.rowVersion, expectedStockVersion: product.stockVersion,
    quantity: '5', quantityUnit: 'unit', unitCost: '1.00', supplierName: 'Coastal Supplies',
    supplierReference: 'LOCK-SALE', note: 'Locks the currency', batchNumber: '', expiryDate: '',
  })
  host.completePosSale(1, {
    idempotencyKey: 'locked-currency-sale-0001', saleType: 'RETAIL',
    items: [{ productId: product.id, quantity: '1' }], payments: [{ method: 'CASH', amount: '2.00' }],
  })
  return { database, repository, host, close: () => database.close() }
}

const servers: FastifyInstance[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

describe('a locked shop currency cannot be moved on any channel', () => {
  it('refuses the change through the real IPC channel and names the reason', async () => {
    const shop = await createShop()
    try {
      expect(shop.repository.isCurrencyLocked()).toBe(true)
      // A stand-in for Electron's ipcMain: it records the handler so the test can invoke it exactly as a
      // renderer would, with whatever arguments a hostile renderer decided to send.
      const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
      registerDesktopIpc(
        { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => { handlers.set(channel, handler) } } as never,
        shop.host,
      )
      const event = { sender: { id: 1 }, senderFrame: undefined }
      const changeCurrency = handlers.get('settings:change-currency')
      expect(changeCurrency, 'the IPC channel must exist, or this test proves nothing').toBeDefined()
      for (const target of ['USD', 'EUR', 'JPY', 'KWD']) {
        const attempt = () => changeCurrency!(event, getCurrency(target)!, true)
        expect(attempt, `changing to ${target} through IPC`).toThrow(/locked/iu)
      }
      // A custom currency is refused by the same guard, not by a separate branch.
      expect(() => changeCurrency!(event, {
        code: 'ZZZ', name: 'Made up', symbol: 'Z', decimalPlaces: 2, symbolPosition: 'before',
        thousandsSeparator: ',', decimalSeparator: '.', kind: 'custom',
      }, true)).toThrow(/locked/iu)
      // The stored currency and every stored amount are untouched.
      expect(shop.repository.readSettings().currency.code).toBe('NGN')
      expect(shop.database.prepare('SELECT currency_code FROM sales').get()).toEqual({ currency_code: 'NGN' })
    } finally {
      shop.close()
    }
  })

  it('refuses the change at the host controller even when the IPC layer is skipped', async () => {
    const shop = await createShop()
    try {
      for (const target of ['USD', 'GHS', 'XOF']) {
        expect(() => shop.host.changeCurrency(1, getCurrency(target)!, true)).toThrow(/locked/iu)
      }
      // An unconfirmed change is refused too, so a client cannot dodge the confirmation step.
      expect(() => shop.host.changeCurrency(1, getCurrency('USD')!, false)).toThrow(/confirm/iu)
    } finally {
      shop.close()
    }
  })

  it('has no currency route on the phone API at all, and refuses every guess', async () => {
    const shop = await createShop()
    try {
      const server = await createHostApi({
        service: { getSettings: () => shop.repository.readSettings(), recordDeniedAccess: () => undefined },
        license: { getSnapshot: () => LICENCE } as unknown as LicenseManager,
        authenticate: async () => ({ userId: 'user-admin', username: 'shopadmin', role: 'ADMIN' }),
        localNetworkOnly: false,
        tls: {},
        now: () => NOW,
      })
      servers.push(server)
      // Every plausible spelling of "change the currency" that a phone client might try. Each must be a 404
      // (no such route) rather than anything that reaches a service.
      const guesses: Array<[string, string]> = [
        ['POST', '/api/v1/admin/settings/currency'],
        ['PATCH', '/api/v1/admin/settings'],
        ['PUT', '/api/v1/admin/settings'],
        ['POST', '/api/v1/admin/currency'],
        ['POST', '/api/v1/mobile/admin/settings/currency'],
        ['POST', '/api/v1/mobile/admin/currency'],
        ['PATCH', '/api/v1/mobile/admin/settings'],
      ]
      for (const [method, url] of guesses) {
        const response = await server.inject({ method: method as 'POST', url, payload: { currencyCode: 'USD' }, headers: { authorization: 'Bearer whatever' } })
        expect([404, 405], `${method} ${url} answered ${response.statusCode}`).toContain(response.statusCode)
        expect(JSON.stringify(response.body)).not.toMatch(/USD/u)
      }
      expect(shop.repository.readSettings().currency.code).toBe('NGN')
    } finally {
      shop.close()
    }
  })

  it('still allows the harmless display preferences to change after the lock', async () => {
    const shop = await createShop()
    try {
      // The brief locks the currency, not the formatting: an Admin may switch to ISO codes or change separators
      // at any time, because that changes how amounts are labelled, never what they mean.
      const saved = shop.host.updateDisplaySettings(1, {
        amountDisplay: 'code', symbolPosition: 'after', thousandsSeparator: ' ', decimalSeparator: '.',
      })
      expect(saved.display.amountDisplay).toBe('code')
      expect(saved.currency.code).toBe('NGN')
      expect(shop.repository.isCurrencyLocked()).toBe(true)
    } finally {
      shop.close()
    }
  })
})
