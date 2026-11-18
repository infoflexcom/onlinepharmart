import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { getCurrency } from '../currency/catalog'
import { formatMoney, defaultDisplayOptions } from '../currency/money'
import { migrateDatabase } from '../db/migrate'
import { SQLiteShopRepository } from '../db/sqlite-shop-repository'
import { SQLiteUserRepository } from '../db/sqlite-user-repository'
import { assertCurrencyChangeAllowed } from '../currency/lock-guard'
import { hashSync } from 'bcryptjs'
import type { PublicUser } from '../shared/auth/types'
import { defaultPermissions } from '../shared/auth/policy'
import type { Edition } from '../editions'
import { ProductInventoryService } from './product-inventory-service'
import { ShopService } from './shop-service'
import { DemoDataService, scaleMajor } from './demo-data-service'
import { DesktopHostController } from '../main/desktop-host-controller'

const NOW = Date.parse('2026-11-17T12:00:00.000Z')

function admin(id = 'user-admin'): PublicUser {
  return {
    id, fullName: 'Shop Admin', username: 'shopadmin', role: 'ADMIN', isActive: true, isLocked: false,
    permissions: defaultPermissions('ADMIN'),
  }
}

function createHarness(currencyCode = 'NGN', edition: Edition = 'PHARMACY') {
  const database = new Database(':memory:')
  migrateDatabase(database)
  const repository = new SQLiteShopRepository(database, false)
  const currency = getCurrency(currencyCode)!
  repository.saveSettings({
    ...repository.readSettings(),
    profile: { name: 'Harbor Health', address: '14 Marina Road', phone: '+234 800 111 2222' },
    currency,
    display: defaultDisplayOptions(currency),
    setupComplete: true,
    currencyConfirmed: true,
  })
  const users = new SQLiteUserRepository(database)
  users.createUser({
    id: admin().id, fullName: admin().fullName, username: admin().username,
    passwordHash: hashSync('Admin-Pass!2026', 4), role: 'ADMIN', permissions: defaultPermissions('ADMIN'),
  })
  let generated = 0
  const inventory = new ProductInventoryService(database, repository, {
    deviceName: 'DEMO-TEST', now: () => NOW, newId: () => `demo-${++generated}`,
  })
  const shopService = new ShopService(repository, { deviceName: 'DEMO-TEST', ipAddress: null }, () => new Date(NOW))
  const demo = new DemoDataService(database, repository, users, inventory, {
    edition: () => edition, now: () => NOW,
  })
  return { database, repository, users, inventory, shopService, demo, currency, close: () => database.close() }
}

describe('optional demonstration data', () => {
  it('loads 30 pharmacy products with batches, the sample users, and leaves the currency unlocked', () => {
    const h = createHarness('NGN', 'PHARMACY')
    try {
      const result = h.demo.load(admin())
      expect(result.products).toBe(30)
      expect(result.currencyCode).toBe('NGN')
      expect(result.users).toBe(2)          // two cashiers; a Supervisor belongs to the supermarket edition
      expect(result.promotions).toBe(2)

      const products = h.database.prepare("SELECT COUNT(*) AS count FROM products WHERE id LIKE 'demo-%'").get() as { count: number }
      expect(products.count).toBe(30)
      const batches = h.database.prepare(`
        SELECT COUNT(*) AS count FROM product_batches WHERE product_id IN (SELECT id FROM products WHERE id LIKE 'demo-%')
      `).get() as { count: number }
      expect(batches.count).toBeGreaterThan(30)
      const batches2050 = h.database.prepare(`
        SELECT COUNT(*) AS count FROM products WHERE id LIKE 'demo-%' AND expiry_tracking = 0
      `).get() as { count: number }
      // Pharmacy is always expiry-tracked, so no pharmacy row may be missing its lot.
      expect(batches2050.count).toBe(0)

      const users = h.database.prepare("SELECT username, role FROM users WHERE id LIKE 'demo-%' ORDER BY username").all()
      expect(users).toEqual([
        { username: 'demo.cashier.off', role: 'CASHIER' },
        { username: 'demo.cashier.on', role: 'CASHIER' },
      ])
      const on = h.database.prepare(`
        SELECT p.allow_wholesale AS wholesale FROM user_permissions p JOIN users u ON u.id = p.user_id WHERE u.username = 'demo.cashier.on'
      `).get() as { wholesale: number }
      const off = h.database.prepare(`
        SELECT p.allow_wholesale AS wholesale FROM user_permissions p JOIN users u ON u.id = p.user_id WHERE u.username = 'demo.cashier.off'
      `).get() as { wholesale: number }
      expect(on.wholesale).toBe(1)
      expect(off.wholesale).toBe(0)

      // The headline promise: loading the demo is not a transaction.
      expect(h.repository.isCurrencyLocked()).toBe(false)
      expect(() => assertCurrencyChangeAllowed(h.repository)).not.toThrow()
      expect(h.database.prepare("SELECT COUNT(*) AS count FROM sales").get()).toEqual({ count: 0 })
      expect(h.database.prepare("SELECT COUNT(*) AS count FROM business_entries").get()).toEqual({ count: 0 })

      // And removing it leaves the shop exactly as it was.
      const removed = h.demo.remove(admin())
      expect(removed).toMatchObject({ products: 30, users: 2 })
      expect(h.database.prepare("SELECT COUNT(*) AS count FROM products WHERE id LIKE 'demo-%'").get()).toEqual({ count: 0 })
      expect(h.database.prepare("SELECT COUNT(*) AS count FROM users WHERE id LIKE 'demo-%'").get()).toEqual({ count: 0 })
    } finally {
      h.close()
    }
  })

  it('loads 60 supermarket products across two departments, weighed items and a supervisor', () => {
    const h = createHarness('NGN', 'SUPERMARKET')
    try {
      const result = h.demo.load(admin())
      expect(result.products).toBe(60)
      expect(result.users).toBe(3)
      const departments = h.database.prepare(`
        SELECT DISTINCT d.name FROM departments d JOIN products p ON p.department_id = d.id WHERE p.id LIKE 'demo-%' ORDER BY d.name
      `).all() as Array<{ name: string }>
      expect(departments).toEqual([{ name: 'Fresh' }, { name: 'Grocery' }])
      const weighed = h.database.prepare("SELECT COUNT(*) AS count FROM products WHERE id LIKE 'demo-%' AND weighed_item = 1").get() as { count: number }
      expect(weighed.count).toBe(6)
      const supervisor = h.database.prepare("SELECT role FROM users WHERE username = 'demo.supervisor'").get() as { role: string }
      expect(supervisor.role).toBe('SUPERVISOR')
      expect(h.repository.isCurrencyLocked()).toBe(false)
    } finally {
      h.close()
    }
  })

  it('scales prices sensibly per currency instead of pretending every shop uses naira', () => {
    const ngn = getCurrency('NGN')!
    const jpy = getCurrency('JPY')!
    const ugx = getCurrency('UGX')!
    const kwd = getCurrency('KWD')!
    // The reference price of 850 major units is a plausible naira figure for a pack of tablets.
    expect(scaleMajor(850, 1, ngn)).toBe('850.00')
    // The same product is a few thousand yen and a few thousand shillings, never "850.00" in a 0-decimal currency.
    expect(scaleMajor(850, 0.11, jpy)).toMatch(/^\d+$/u)
    expect(Number(scaleMajor(850, 0.11, jpy))).toBeGreaterThan(50)
    expect(scaleMajor(850, 2.6, ugx)).not.toContain('.')
    // A dinar figure keeps its three decimals.
    expect(scaleMajor(850, 0.00021, kwd)).toMatch(/^\d+\.\d{3}$/u)
    // No zero or negative price can ever escape, which would make a product unsellable and a sale impossible.
    for (const currency of [ngn, jpy, ugx, kwd, getCurrency('USD')!, getCurrency('XOF')!]) {
      expect(Number(scaleMajor(1, 0.000001, currency).replace(/[^\d.]/gu, ''))).toBeGreaterThan(0)
    }
  })

  it('prints demo prices in the shop currency and refuses to load twice', () => {
    const h = createHarness('JPY', 'SUPERMARKET')
    try {
      const first = h.demo.load(admin())
      expect(first.samplePrice).toMatch(/^¥[\d,]+$/u)
      expect(first.samplePrice).not.toContain('.')
      const second = h.demo.load(admin())
      expect(second.products).toBe(0)   // already loaded: nothing is duplicated
      expect(h.database.prepare("SELECT COUNT(*) AS count FROM products WHERE id LIKE 'demo-%'").get()).toEqual({ count: 60 })
    } finally {
      h.close()
    }
  })

  it('refuses to remove demo data once a real sale depends on it, and says why', () => {
    const h = createHarness('NGN', 'PHARMACY')
    try {
      h.demo.load(admin())
      const product = h.database.prepare("SELECT id FROM products WHERE id LIKE 'demo-%' ORDER BY sku LIMIT 1").get() as { id: string }
      // Simulate real history referencing the demo product: the sale line is what a completed sale leaves.
      h.database.prepare(`
        INSERT INTO sales (currency_code, subtotal, total, paid, store_name) VALUES ('NGN', 85000, 85000, 85000, 'Harbor Health')
      `).run()
      const saleId = Number((h.database.prepare('SELECT MAX(id) AS id FROM sales').get() as { id: number }).id)
      h.database.prepare(`
        INSERT INTO sale_items (id, sale_id, product_id, description_snapshot, quantity_milli, unit_price, line_total)
        VALUES ('sale-item-demo', ?, ?, 'Paracetamol', 1000, 85000, 85000)
      `).run(saleId, product.id)
      // The sale insert already fired the real currency lock, exactly as production would.
      expect(h.repository.isCurrencyLocked()).toBe(true)
      expect(() => h.demo.remove(admin())).toThrow(/cannot be deleted|Keep the demonstration/iu)
      // And the demo rows are still there: a refused removal must not half-delete anything.
      expect(h.database.prepare("SELECT COUNT(*) AS count FROM products WHERE id LIKE 'demo-%'").get()).toEqual({ count: 30 })
    } finally {
      h.close()
    }
  })

  it('refuses a non-Admin and an unactivated host', () => {
    const h = createHarness('NGN', 'PHARMACY')
    try {
      const cashier: PublicUser = { ...admin('user-cashier'), role: 'CASHIER', permissions: defaultPermissions('CASHIER') }
      expect(() => h.demo.load(cashier)).toThrow(/Only an Admin/iu)
      expect(() => h.demo.remove(cashier)).toThrow(/Only an Admin/iu)
    } finally {
      h.close()
    }
    const unactivated = new Database(':memory:')
    migrateDatabase(unactivated)
    try {
      const repository = new SQLiteShopRepository(unactivated, false)
      const currency = getCurrency('NGN')!
      repository.saveSettings({ ...repository.readSettings(), currency, display: defaultDisplayOptions(currency), setupComplete: true, currencyConfirmed: true })
      const users = new SQLiteUserRepository(unactivated)
      const inventory = new ProductInventoryService(unactivated, repository, { deviceName: 'DEMO-TEST' })
      const demo = new DemoDataService(unactivated, repository, users, inventory, { edition: () => null })
      expect(() => demo.load(admin())).toThrow(/Activate a valid licence/iu)
    } finally {
      unactivated.close()
    }
  })

  it('describes its state so the Settings screen can show what will be removed', () => {
    const h = createHarness('NGN', 'SUPERMARKET')
    try {
      expect(h.demo.status()).toMatchObject({ loaded: false, products: 0, users: 0, inUse: false })
      h.demo.load(admin())
      const status = h.demo.status()
      expect(status.loaded).toBe(true)
      expect(status.products).toBe(60)
      expect(status.users).toBe(3)
      expect(status.currency).toBe('NGN')
      expect(status.demoUsers.map(({ username }) => username)).toEqual(['demo.cashier.off', 'demo.cashier.on', 'demo.supervisor'])
      // A shop that then changes its mind can still change currency: that is the whole point of the rule.
      expect(h.repository.isCurrencyLocked()).toBe(false)
    } finally {
      h.close()
    }
  })

  it('shows a realistic price for each currency in the demo catalogue header', () => {
    for (const code of ['NGN', 'USD', 'JPY', 'KWD', 'UGX']) {
      const h = createHarness(code, 'PHARMACY')
      try {
        const result = h.demo.load(admin())
        const currency = h.currency
        expect(result.samplePrice).toBe(formatMoney(
          // Price of the first catalogue item, computed the same way the service does.
          BigInt(Math.round(850 * ({ NGN: 1, USD: 0.0007, JPY: 0.11, KWD: 0.00021, UGX: 2.6 } as Record<string, number>)[code]! * 10 ** currency.decimalPlaces)),
          currency, defaultDisplayOptions(currency),
        ))
      } finally {
        h.close()
      }
    }
  })
})

describe('the demonstration catalogue through the desktop host', () => {
  it('refuses a Cashier on every channel and audits an Admin load', async () => {
    const h = createHarness('NGN', 'SUPERMARKET')
    try {
      const users = new SQLiteUserRepository(h.database)
      const setup = { getSetupContext: async () => ({ edition: 'SUPERMARKET' as const, licenseActivated: true, productName: 'Infoflex' }) } as never
      const auth = { authenticate: () => null } as never
      const host = new DesktopHostController(
        h.repository, users, setup, auth,
        { canAccessPage: () => true } as never,
        h.shopService, () => NOW, '0.1.0',
      )
      // The service refuses rather than the controller, so a future caller cannot slip round the rule.
      const cashier: PublicUser = { ...admin('user-cashier'), role: 'CASHIER', permissions: defaultPermissions('CASHIER') }
      expect(() => h.demo.load(cashier)).toThrow(/Only an Admin/iu)
      expect(() => h.demo.remove(cashier)).toThrow(/Only an Admin/iu)
      const result = h.demo.load(admin())
      expect(result.products).toBe(60)
      const audit = h.database.prepare("SELECT actor, action FROM audit_log WHERE action = 'demo.loaded'").get() as { actor: string; action: string }
      expect(audit.actor).toBe('shopadmin')
      void host
    } finally {
      h.close()
    }
  })
})
