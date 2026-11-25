import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getCurrency } from '../currency/catalog'
import { defaultDisplayOptions } from '../currency/money'
import type { FirstRunInput } from '../shared/shop/types'
import { ShopService } from '../services/shop-service'
import { SQLiteShopRepository } from './sqlite-shop-repository'
import { migrateDatabase } from './migrate'
import { openShopDatabase } from './index'
import { MIGRATIONS } from './migrations'

const NGN = getCurrency('NGN')!
const USD = getCurrency('USD')!
const setupInput: FirstRunInput = {
  admin: { fullName: 'Test Admin', username: 'testadmin', password: 'T3st-Admin!2026', confirmPassword: 'T3st-Admin!2026' },
  profile: { name: 'Harbor Health', address: '12 Dock Road', phone: '+234 1 555 0100' },
  currency: NGN,
  display: defaultDisplayOptions(NGN),
  currencyConfirmed: true,
}

const EXPECTED_TABLES = [
  'schema_migrations', 'currencies', 'users', 'user_permissions', 'products', 'categories', 'suppliers', 'customers',
  'sales', 'sale_items', 'payments', 'returns', 'return_items', 'stock_movements', 'purchases', 'purchase_items',
  'day_closings', 'settings', 'audit_log', 'license_state', 'license_history', 'license_runtime', 'license_vendor_config', 'devices', 'refresh_tokens', 'idempotency_keys',
  'approval_requests', 'stock', 'business_entries', 'departments', 'product_batches', 'product_barcodes', 'backup_log',
  'product_variants', 'promotions', 'price_rules', 'loyalty_members', 'loyalty_transactions', 'cashier_shifts',
  'cash_drawer_events', 'sync_state', 'sync_operations', 'held_carts', 'sale_item_batches', 'sale_print_events',
  'return_credits', 'return_print_events',
  // Migration 16: the client/server foundations.
  'role_seats', 'client_devices', 'sessions', 'orders', 'order_items', 'order_events', 'reservations',
  'print_log', 'audit_signoffs', 'audit_flags', 'document_sequences',
] as const

function migratedDatabase(): Database.Database {
  const database = new Database(':memory:')
  migrateDatabase(database)
  return database
}

function migrateThroughVersion(database: Database.Database, maxVersion: number): void {
  database.pragma('foreign_keys = ON')
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`)
  const recordMigration = database.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)')
  for (const migration of MIGRATIONS.filter(({ version }) => version <= maxVersion)) {
    database.transaction(() => {
      migration.up(database)
      recordMigration.run(migration.version, migration.name)
    }).immediate()
  }
}

function configureShop(repository: SQLiteShopRepository): void {
  repository.saveSettings({
    ...repository.readSettings(),
    profile: setupInput.profile,
    currency: setupInput.currency,
    display: setupInput.display,
    setupComplete: true,
    currencyConfirmed: true,
  })
}

describe('database migrations and schema', () => {
  it('creates all requested tables, seeds currencies, and can be migrated repeatedly', () => {
    const database = migratedDatabase()
    const tables = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(({ name }) => name))
    for (const table of EXPECTED_TABLES) expect(tables.has(table), table).toBe(true)
    // Derived from the registry rather than typed out. A hand-kept list of migration numbers has to be edited every
    // time a migration is added, which means the day somebody forgets, this assertion quietly describes an older
    // schema than the one under test.
    expect(database.prepare('SELECT version FROM schema_migrations ORDER BY version').all())
      .toEqual(MIGRATIONS.map((migration) => ({ version: migration.version })))
    expect(database.prepare('SELECT COUNT(*) AS count FROM currencies').get()).toEqual({ count: 54 })
    migrateDatabase(database)
    expect(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: MIGRATIONS.length })
    database.close()
  })

  it('adds short-lived device access and device-bound refresh sessions without losing legacy rows', () => {
    const database = new Database(':memory:')
    migrateThroughVersion(database, 11)
    database.prepare(`
      INSERT INTO users (id, full_name, username, password_hash, role)
      VALUES ('mobile-admin', 'Mobile Admin', 'mobileadmin', 'hash', 'ADMIN')
    `).run()
    database.prepare(`
      INSERT INTO devices (id, name, platform, token_hash, admin_user_id)
      VALUES ('legacy-device', 'Old phone', 'Browser', 'legacy-token-hash', 'mobile-admin')
    `).run()
    database.prepare(`
      INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
      VALUES ('legacy-refresh', 'mobile-admin', 'legacy-refresh-hash', '2027-01-01T00:00:00.000Z')
    `).run()

    migrateDatabase(database)

    expect(database.prepare('SELECT access_token_expires_at FROM devices WHERE id = ?').get('legacy-device'))
      .toEqual({ access_token_expires_at: null })
    expect(database.prepare('SELECT device_id FROM refresh_tokens WHERE id = ?').get('legacy-refresh'))
      .toEqual({ device_id: null })
    database.prepare(`
      INSERT INTO devices (id, name, platform, token_hash, admin_user_id, access_token_expires_at)
      VALUES ('current-device', 'Current phone', 'iOS', 'current-token-hash', 'mobile-admin', '2026-11-17T12:15:00.000Z')
    `).run()
    database.prepare(`
      INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, device_id)
      VALUES ('current-refresh', 'mobile-admin', 'current-refresh-hash', '2027-02-15T12:00:00.000Z', 'current-device')
    `).run()
    expect(database.prepare('SELECT device_id, expires_at FROM refresh_tokens WHERE id = ?').get('current-refresh'))
      .toEqual({ device_id: 'current-device', expires_at: '2027-02-15T12:00:00.000Z' })
    expect(() => database.prepare(`
      INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, device_id)
      VALUES ('orphan-refresh', 'mobile-admin', 'orphan-refresh-hash', '2027-02-15T12:00:00.000Z', 'missing-device')
    `).run()).toThrow(/FOREIGN KEY/u)
    database.close()
  })

  it('upgrades version 7 product and purchase data safely with migration 8', () => {
    const database = new Database(':memory:')
    migrateThroughVersion(database, 7)
    database.prepare('INSERT INTO products (id, sku, name) VALUES (?, ?, ?)').run('v7-product', 'OLD-001', 'Legacy product')
    const purchase = database.prepare("INSERT INTO purchases (status, currency_code, subtotal, total) VALUES ('COMPLETED', 'NGN', 5000, 5000)").run()
    database.prepare(`
      INSERT INTO purchase_items (id, purchase_id, product_id, description_snapshot, quantity_milli, unit_cost, line_total)
      VALUES ('v7-item', ?, 'v7-product', 'Legacy product', 2000, 2500, 5000)
    `).run(Number(purchase.lastInsertRowid))
    database.prepare('INSERT INTO product_barcodes (id, product_id, barcode) VALUES (?, ?, ?)')
      .run('v7-barcode', 'v7-product', '0012345678905')

    migrateDatabase(database)

    expect(database.prepare('SELECT quantity_milli, reserved_milli, row_version FROM stock WHERE product_id = ?').get('v7-product')).toEqual({
      quantity_milli: 0, reserved_milli: 0, row_version: 1,
    })
    expect(database.prepare('SELECT received_quantity_milli, batch_number, expiry_date FROM purchase_items WHERE id = ?').get('v7-item')).toEqual({
      received_quantity_milli: 2000, batch_number: '', expiry_date: '',
    })
    expect(database.prepare('SELECT is_primary, sort_order FROM product_barcodes WHERE id = ?').get('v7-barcode')).toEqual({ is_primary: 0, sort_order: 0 })
    expect(() => database.prepare('UPDATE stock SET quantity_milli = -1 WHERE product_id = ?').run('v7-product')).toThrow(/Stock quantity cannot be negative/u)

    database.prepare(`
      INSERT INTO stock_movements (id, product_id, movement_type, reference_type, reference_id, quantity_delta_milli, unit_cost, currency_code)
      VALUES ('immutable-test', 'v7-product', 'ADJUSTMENT', 'TEST', 'TEST-1', 0, 0, 'NGN')
    `).run()
    expect(() => database.prepare('UPDATE stock_movements SET adjustment_reason = ? WHERE id = ?').run('rewrite', 'immutable-test')).toThrow(/Stock movements are immutable/u)
    expect(() => database.prepare('DELETE FROM stock_movements WHERE id = ?').run('immutable-test')).toThrow(/Stock movements are immutable/u)
    database.close()
  })

  it('upgrades populated version 9 POS and return rows in place with migration 10 defaults', () => {
    const database = new Database(':memory:')
    migrateThroughVersion(database, 9)
    const sale = database.prepare(`
      INSERT INTO sales (currency_code, subtotal, total, paid, store_name, store_address, store_phone)
      VALUES ('NGN', 2500, 2500, 2500, 'Legacy Harbor', '1 Old Road', '+234 800 000 0000')
    `).run()
    const saleId = Number(sale.lastInsertRowid)
    database.prepare(`
      INSERT INTO sale_items (id, sale_id, description_snapshot, quantity_milli, unit_price, line_total, gross_total)
      VALUES ('v9-sale-item', ?, 'Legacy item', 1000, 2500, 2500, 2500)
    `).run(saleId)
    const returned = database.prepare(`
      INSERT INTO returns (sale_id, currency_code, subtotal, total, store_name, store_address, store_phone)
      VALUES (?, 'NGN', 500, 500, 'Legacy Harbor', '1 Old Road', '+234 800 000 0000')
    `).run(saleId)
    const returnId = Number(returned.lastInsertRowid)
    database.prepare(`
      INSERT INTO return_items (id, return_id, sale_item_id, description_snapshot, quantity_milli, unit_price, line_total)
      VALUES ('v9-return-item', ?, 'v9-sale-item', 'Legacy item', 200, 2500, 500)
    `).run(returnId)

    migrateDatabase(database)

    expect(database.prepare('SELECT status, currency_code, total, store_name, reason, return_type, return_window_days_snapshot FROM returns WHERE id = ?')
      .get(returnId)).toEqual({
      status: 'COMPLETED', currency_code: 'NGN', total: 500, store_name: 'Legacy Harbor',
      reason: 'OTHER', return_type: 'REFUND', return_window_days_snapshot: 7,
    })
    expect(database.prepare('SELECT description_snapshot, quantity_milli, line_total, item_condition, stock_disposition FROM return_items WHERE id = ?')
      .get('v9-return-item')).toEqual({
      description_snapshot: 'Legacy item', quantity_milli: 200, line_total: 500,
      item_condition: 'RESELLABLE', stock_disposition: 'NO_STOCK',
    })
    expect(database.prepare('SELECT description_snapshot, expiry_tracking_snapshot FROM sale_items WHERE id = ?')
      .get('v9-sale-item')).toEqual({ description_snapshot: 'Legacy item', expiry_tracking_snapshot: 0 })
    expect(database.prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').get())
      .toEqual({ version: MIGRATIONS[MIGRATIONS.length - 1]!.version })
    database.close()
  })

  it('imports the prior shop setup and preserves the currency lock from legacy entries', () => {
    const database = new Database(':memory:')
    database.exec(`
      CREATE TABLE shop_settings (
        id INTEGER PRIMARY KEY, store_name TEXT NOT NULL, store_address TEXT NOT NULL, store_phone TEXT NOT NULL,
        currency_code TEXT NOT NULL, currency_name TEXT NOT NULL, currency_symbol TEXT NOT NULL,
        currency_decimals INTEGER NOT NULL, currency_kind TEXT NOT NULL, amount_display TEXT NOT NULL,
        symbol_position TEXT NOT NULL, thousands_separator TEXT NOT NULL, decimal_separator TEXT NOT NULL,
        currency_confirmed INTEGER NOT NULL, setup_complete INTEGER NOT NULL
      );
      INSERT INTO shop_settings VALUES (1, 'Legacy Shop', 'Old Road', '+234 000', 'NGN', 'Nigerian naira', 'unused test value', 2, 'iso', 'symbol', 'before', ',', '.', 1, 1);
      CREATE TABLE business_entries (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, currency_code TEXT NOT NULL, amount_minor INTEGER NOT NULL,
        store_name_snapshot TEXT NOT NULL, store_address_snapshot TEXT NOT NULL,
        store_phone_snapshot TEXT NOT NULL, created_at TEXT NOT NULL
      );
      INSERT INTO business_entries VALUES ('old-sale', 'sale', 'NGN', 100, 'Legacy Shop', 'Old Road', '+234 000', '2026-01-01T00:00:00.000Z');
      CREATE TRIGGER completed_entries_are_immutable BEFORE DELETE ON business_entries
      BEGIN SELECT RAISE(ABORT, 'Completed business entries cannot be deleted'); END;
      CREATE TRIGGER completed_entries_cannot_be_changed BEFORE UPDATE ON business_entries
      BEGIN SELECT RAISE(ABORT, 'Completed business entries cannot be changed'); END;
      CREATE TABLE audit_log (
        id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, metadata_json TEXT NOT NULL,
        device_name TEXT NOT NULL, ip_address TEXT, created_at TEXT NOT NULL
      );
    `)
    migrateDatabase(database)
    const repository = new SQLiteShopRepository(database)
    expect(repository.readSettings()).toMatchObject({
      profile: { name: 'Legacy Shop', address: 'Old Road', phone: '+234 000' },
      currency: { code: 'NGN' },
      currencyConfirmed: true,
      setupComplete: true,
      currencyLocked: true,
    })
    expect(repository.isCurrencyLocked()).toBe(true)
    repository.close()
  })

  it('creates the database file in the requested app-data folder', () => {
    const directory = mkdtempSync(join(tmpdir(), 'infoflex-data-'))
    const databasePath = join(directory, 'app-data', 'infoflex.sqlite')
    try {
      const database = openShopDatabase(databasePath)
      expect(database.prepare('SELECT COUNT(*) AS count FROM currencies').get()).toEqual({ count: 54 })
      database.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('inserts and reads a row from every domain table and keeps money columns INTEGER', () => {
    const database = migratedDatabase()
    database.pragma('foreign_keys = ON')

    database.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)')
      .run('user-admin', 'admin', 'test-only-hash', 'ADMIN')
    database.prepare('INSERT INTO user_permissions (user_id, allow_wholesale, max_discount_pct, allow_credit_sales, return_limit) VALUES (?, 1, 500, 1, 30000)')
      .run('user-admin')
    database.prepare('INSERT INTO categories (id, name) VALUES (?, ?)').run('cat-1', 'Health')
    database.prepare('INSERT INTO suppliers (id, name) VALUES (?, ?)').run('supplier-1', 'Northside Wholesale')
    database.prepare('INSERT INTO customers (id, name, credit_limit) VALUES (?, ?, ?)').run('customer-1', 'Amina Bello', 500000)
    database.prepare('INSERT INTO departments (id, name) VALUES (?, ?)').run('dept-1', 'Grocery')
    database.prepare(`
      INSERT INTO products (id, sku, name, category_id, preferred_supplier_id, department_id,
        sale_price, cost, generic_name, prescription_required, shelf_location, weighed_item, plu_code, price_per_kg)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('product-1', 'SKU-001', 'Vitamin C', 'cat-1', 'supplier-1', 'dept-1', 12500, 8000, 'Ascorbic acid', 0, 'A-04', 0, '4001', null)
    database.prepare('INSERT INTO stock (product_id, quantity_milli) VALUES (?, ?)').run('product-1', 12000)

    const firstSale = database.prepare(`
      INSERT INTO sales (customer_id, cashier_id, currency_code, subtotal, total, paid,
        store_name, store_address, store_phone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('customer-1', 'user-admin', 'NGN', 12500, 12500, 12500, 'Harbor Health', '12 Dock Road', '+234 1 555 0100')
    const saleId = Number(firstSale.lastInsertRowid)
    const saleItemId = 'sale-item-1'
    database.prepare(`
      INSERT INTO sale_items (id, sale_id, product_id, description_snapshot, quantity_milli, unit_price, line_total)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(saleItemId, saleId, 'product-1', 'Vitamin C', 1000, 12500, 12500)
    database.prepare(`
      INSERT INTO payments (id, sale_id, payment_method, amount, currency_code) VALUES (?, ?, ?, ?, ?)
    `).run('payment-1', saleId, 'CASH', 12500, 'NGN')

    const returnResult = database.prepare(`
      INSERT INTO returns (sale_id, cashier_id, currency_code, subtotal, total, store_name, store_address, store_phone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(saleId, 'user-admin', 'NGN', 2500, 2500, 'Harbor Health', '12 Dock Road', '+234 1 555 0100')
    const returnId = Number(returnResult.lastInsertRowid)
    database.prepare(`
      INSERT INTO return_items (id, return_id, sale_item_id, product_id, description_snapshot, quantity_milli, unit_price, line_total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('return-item-1', returnId, saleItemId, 'product-1', 'Vitamin C', 200, 12500, 2500)
    database.prepare(`
      INSERT INTO return_credits (return_id, customer_id, currency_code, credit_type, amount_minor, remaining_minor)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(returnId, 'customer-1', 'NGN', 'STORE_CREDIT', 2500, 2500)
    database.prepare(`
      INSERT INTO return_print_events (id, return_id, printed_by, workstation, document_layout, is_duplicate, printed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('return-print-1', returnId, 'user-admin', 'SHOP-PC', 'A4_RECEIPT', 0, '2026-11-17T00:00:00.000Z')

    const purchaseResult = database.prepare(`
      INSERT INTO purchases (supplier_id, received_by, currency_code, subtotal, total) VALUES (?, ?, ?, ?, ?)
    `).run('supplier-1', 'user-admin', 'NGN', 8000, 8000)
    const purchaseId = Number(purchaseResult.lastInsertRowid)
    database.prepare(`
      INSERT INTO purchase_items (id, purchase_id, product_id, description_snapshot, quantity_milli, unit_cost, line_total)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('purchase-item-1', purchaseId, 'product-1', 'Vitamin C', 1000, 8000, 8000)
    database.prepare(`
      INSERT INTO stock_movements (id, product_id, movement_type, quantity_delta_milli, unit_cost, currency_code, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('stock-move-1', 'product-1', 'PURCHASE', 1000, 8000, 'NGN', 'user-admin')
    const closeResult = database.prepare('INSERT INTO day_closings (closed_by, currency_code, sales_total, cash_total) VALUES (?, ?, ?, ?)')
      .run('user-admin', 'NGN', 12500, 12500)
    database.prepare(`
      INSERT INTO business_entries (id, kind, currency_code, amount_minor, store_name_snapshot, store_address_snapshot, store_phone_snapshot)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('entry-1', 'day_close', 'NGN', 12500, 'Harbor Health', '12 Dock Road', '+234 1 555 0100')
    database.prepare('INSERT INTO audit_log (id, actor, action, metadata_json, device_name, ip_address) VALUES (?, ?, ?, ?, ?, ?)')
      .run('audit-1', 'admin', 'test.record', '{}', 'SHOP-PC', '192.0.2.2')
    database.prepare(`
      INSERT INTO license_state (license_id, token, machine_id, edition, start, end, status, source, default_currency, history)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('lic-1', 'test-token', 'machine-1', 'BOTH', '2026-01-01', '2027-01-01', 'active', 'file', 'NGN', '[]')
    database.prepare(`
      INSERT INTO license_history (license_id, event_type, occurred_at, machine_id, source, claims_json, token, detail_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('lic-1', 'license.test', '2026-11-17T00:00:00.000Z', 'machine-1', 'file', '{}', 'test-token', '{}')
    database.prepare(`
      INSERT INTO devices (id, name, platform, token_hash, admin_user_id, approved_by, approved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('device-1', 'Admin phone', 'iOS', 'hash-only-test', 'user-admin', 'user-admin', '2026-11-17T00:00:00.000Z')
    database.prepare('INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)')
      .run('refresh-1', 'user-admin', 'refresh-hash', '2027-01-01T00:00:00.000Z')
    database.prepare('INSERT INTO idempotency_keys (key, user_id, route, request_hash, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run('idem-1', 'user-admin', '/api/v1/test', 'request-hash', '2027-01-01T00:00:00.000Z')
    database.prepare(`
      INSERT INTO sync_operations (id, device_id, idempotency_key, operation_type, status, request_hash, response_hash, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('sync-op-1', 'device-1', 'idem-1', 'ADMIN_QUERY', 'APPLIED', 'request-hash', 'response-hash', '2026-11-17T00:00:00.000Z')
    database.prepare('INSERT INTO approval_requests (id, request_type, requested_by, payload_json) VALUES (?, ?, ?, ?)')
      .run('approval-1', 'VOID', 'user-admin', '{}')
    database.prepare('INSERT INTO product_batches (id, product_id, batch_no, expiry_date, quantity_milli, cost) VALUES (?, ?, ?, ?, ?, ?)')
      .run('batch-1', 'product-1', 'LOT-001', '2027-12-31', 3000, 8000)
    database.prepare(`
      INSERT INTO sale_item_batches (sale_item_id, batch_id, batch_number_snapshot, expiry_date_snapshot, quantity_milli)
      VALUES (?, ?, ?, ?, ?)
    `).run(saleItemId, 'batch-1', 'LOT-001', '2027-12-31', 1000)
    database.prepare('INSERT INTO product_barcodes (id, product_id, barcode) VALUES (?, ?, ?)')
      .run('barcode-1', 'product-1', '4006381333931')
    database.prepare('INSERT INTO product_variants (id, product_id, variant_code, label, attributes_json) VALUES (?, ?, ?, ?, ?)')
      .run('variant-1', 'product-1', 'SKU-001-RED', 'Red pack', '{"color":"red"}')
    database.prepare(`
      INSERT INTO promotions (id, name, promotion_type, amount_minor, starts_at, ends_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('promo-1', 'Launch special', 'FIXED', 500, '2026-01-01', '2026-12-31')
    database.prepare('INSERT INTO price_rules (id, name, product_id, minimum_price, maximum_price) VALUES (?, ?, ?, ?, ?)')
      .run('price-rule-1', 'Approved range', 'product-1', 10000, 20000)
    database.prepare('INSERT INTO loyalty_members (id, customer_id, member_number) VALUES (?, ?, ?)')
      .run('loyalty-1', 'customer-1', 'MEM-001')
    database.prepare(`
      INSERT INTO loyalty_transactions (id, loyalty_member_id, sale_id, points_delta, transaction_type)
      VALUES (?, ?, ?, ?, ?)
    `).run('loyalty-tx-1', 'loyalty-1', saleId, 10, 'EARN')
    database.prepare('INSERT INTO cashier_shifts (id, cashier_id, currency_code, opening_float) VALUES (?, ?, ?, ?)')
      .run('shift-1', 'user-admin', 'NGN', 20000)
    database.prepare(`
      INSERT INTO cash_drawer_events (id, shift_id, user_id, event_type, amount, currency_code, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('drawer-1', 'shift-1', 'user-admin', 'PAID_IN', 1000, 'NGN', 'Opening adjustment')
    database.prepare(`
      INSERT INTO held_carts (id, user_id, sale_type, cart_json) VALUES (?, ?, ?, ?)
    `).run('held-1', 'user-admin', 'RETAIL', '{"saleType":"RETAIL","items":[],"customerId":null,"loyaltyPointsToRedeem":0}')
    database.prepare(`
      INSERT INTO sale_print_events (id, sale_id, printed_by, workstation, document_layout, is_duplicate, printed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('print-1', saleId, 'user-admin', 'SHOP-PC', 'THERMAL_80', 0, '2026-11-17T00:00:00.000Z')

    database.prepare(`
      INSERT INTO backup_log (id, kind, file_name, location, currency_code, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('backup-1', 'AUTOMATIC', 'infoflex-backup-2026-11-17.infoflexbackup', 'C:/infoflex/backups', 'NGN', '2026-11-17T00:00:00.000Z')

    // ── Migration 16: a row in each new table, so "the table exists" is not mistaken for "the table works" ──
    database.prepare(`
      INSERT INTO client_devices (id, name, os, token_hash, approved_by, approved_at)
      VALUES ('client-1', 'Counter till', 'Windows 11', 'hashed-token', 'user-admin', '2026-11-17T00:00:00.000Z')
    `).run()
    database.prepare(`
      INSERT INTO sessions (id, user_id, client_device_id, token_hash, pc_name)
      VALUES ('session-1', 'user-admin', 'client-1', 'session-token-hash', 'COUNTER-PC')
    `).run()
    database.prepare(`
      INSERT INTO orders (id, type, status, created_by, currency_code, subtotal, total, expires_at)
      VALUES ('order-1', 'WHOLESALE', 'PENDING', 'user-admin', 'NGN', 1500, 1500, '2026-11-18T00:00:00.000Z')
    `).run()
    database.prepare(`
      INSERT INTO order_items (id, order_id, product_id, description_snapshot, quantity_milli, unit_price, line_total)
      VALUES ('order-item-1', 'order-1', 'product-1', 'Paracetamol 500mg', 2000, 750, 1500)
    `).run()
    database.prepare(`
      INSERT INTO order_events (order_id, event, from_status, to_status, actor_id)
      VALUES ('order-1', 'CREATED', NULL, 'DRAFT', 'user-admin')
    `).run()
    database.prepare(`
      INSERT INTO reservations (id, order_id, product_id, quantity_milli)
      VALUES ('reservation-1', 'order-1', 'product-1', 2000)
    `).run()
    database.prepare(`
      INSERT INTO print_log (document_kind, document_id, copy_no, duplicate, printed_by)
      VALUES ('SALE', ?, 2, 1, 'user-admin')
    `).run(String(saleId))
    database.prepare(`
      INSERT INTO audit_signoffs (id, subject_kind, subject_id, signed_by, subject_digest, note)
      VALUES ('signoff-1', 'DAY_CLOSE', '1', 'user-admin', 'digest-of-what-was-shown', 'Reviewed at close')
    `).run()
    database.prepare(`
      INSERT INTO audit_flags (id, subject_kind, subject_id, raised_by, severity, detail)
      VALUES ('flag-1', 'RETURN', ?, 'user-admin', 'CONCERN', 'Refund exceeded the receipt total')
    `).run(String(returnId))

    const rowChecks: Array<[string, string, string | number]> = [
      ['schema_migrations', 'version', 13], ['currencies', 'code', 'NGN'], ['settings', 'id', 1], ['sync_state', 'id', 1],
      ['users', 'id', 'user-admin'], ['user_permissions', 'user_id', 'user-admin'], ['categories', 'id', 'cat-1'],
      ['suppliers', 'id', 'supplier-1'], ['customers', 'id', 'customer-1'], ['products', 'id', 'product-1'],
      ['stock', 'product_id', 'product-1'], ['sales', 'id', saleId], ['sale_items', 'id', saleItemId],
      ['sale_item_batches', 'sale_item_id', saleItemId], ['sale_print_events', 'id', 'print-1'], ['held_carts', 'id', 'held-1'],
      ['payments', 'id', 'payment-1'], ['returns', 'id', returnId], ['return_items', 'id', 'return-item-1'],
      ['return_credits', 'return_id', returnId], ['return_print_events', 'id', 'return-print-1'],
      ['stock_movements', 'id', 'stock-move-1'], ['purchases', 'id', purchaseId], ['purchase_items', 'id', 'purchase-item-1'],
      ['day_closings', 'id', Number(closeResult.lastInsertRowid)], ['business_entries', 'id', 'entry-1'],
      ['audit_log', 'id', 'audit-1'], ['license_state', 'license_id', 'lic-1'], ['license_history', 'id', 1],
      ['license_runtime', 'id', 1], ['license_vendor_config', 'id', 1], ['devices', 'id', 'device-1'],
      ['refresh_tokens', 'id', 'refresh-1'], ['idempotency_keys', 'key', 'idem-1'], ['sync_operations', 'id', 'sync-op-1'],
      ['approval_requests', 'id', 'approval-1'],
      ['departments', 'id', 'dept-1'], ['product_batches', 'id', 'batch-1'], ['product_barcodes', 'id', 'barcode-1'],
      ['product_variants', 'id', 'variant-1'], ['promotions', 'id', 'promo-1'], ['price_rules', 'id', 'price-rule-1'],
      ['loyalty_members', 'id', 'loyalty-1'], ['loyalty_transactions', 'id', 'loyalty-tx-1'],
      ['cashier_shifts', 'id', 'shift-1'], ['cash_drawer_events', 'id', 'drawer-1'],
      ['backup_log', 'id', 'backup-1'],
      // Migration 16.
      ['role_seats', 'role', 'ADMIN'], ['client_devices', 'id', 'client-1'], ['sessions', 'id', 'session-1'],
      ['orders', 'id', 'order-1'], ['order_items', 'id', 'order-item-1'],
      ['order_events', 'order_id', 'order-1'], ['reservations', 'id', 'reservation-1'],
      ['print_log', 'document_kind', 'SALE'], ['audit_signoffs', 'id', 'signoff-1'], ['audit_flags', 'id', 'flag-1'],
      ['document_sequences', 'kind', 'SALE'],
    ]
    for (const [table, column, value] of rowChecks) {
      const row = database.prepare(`SELECT * FROM "${table}" WHERE "${column}" = ?`).get(value)
      expect(row, `${table} row should be readable`).toBeDefined()
    }
    expect(rowChecks.map(([table]) => table).sort()).toEqual([...EXPECTED_TABLES].sort())
    expect(database.prepare('SELECT currency_code, store_name, store_address, store_phone FROM sales WHERE id = ?').get(saleId)).toMatchObject({
      currency_code: 'NGN', store_name: 'Harbor Health', store_address: '12 Dock Road', store_phone: '+234 1 555 0100',
    })
    expect(database.prepare('SELECT currency_code, store_name, store_address, store_phone FROM returns WHERE id = ?').get(returnId)).toMatchObject({
      currency_code: 'NGN', store_name: 'Harbor Health', store_address: '12 Dock Road', store_phone: '+234 1 555 0100',
    })
    const permissionColumns = database.prepare('PRAGMA table_info(user_permissions)').all() as Array<{ name: string }>
    expect(permissionColumns.map(({ name }) => name)).toEqual([
      'user_id', 'allow_wholesale', 'max_discount_pct', 'allow_credit_sales', 'return_limit', 'row_version',
    ])

    const sales = database.prepare('SELECT receipt_number FROM sales ORDER BY id').all() as Array<{ receipt_number: string }>
    expect(sales.map(({ receipt_number }) => receipt_number)).toEqual(['R-0000000001'])
    const nextSale = database.prepare('INSERT INTO sales (currency_code) VALUES (?)').run('NGN')
    const nextReceipt = database.prepare('SELECT receipt_number FROM sales WHERE id = ?').get(Number(nextSale.lastInsertRowid)) as { receipt_number: string }
    expect(nextReceipt.receipt_number).toBe('R-0000000002')

    const moneyTypeColumns = new Set([
      'credit_limit', 'balance', 'sale_price', 'cost', 'price_per_kg', 'amount_minor', 'subtotal', 'discount',
      'tax', 'total', 'paid', 'change_amount', 'unit_price', 'line_total', 'amount', 'unit_cost', 'sales_total',
      'returns_total', 'cash_total', 'minimum_price', 'maximum_price', 'amount_minor', 'opening_float',
      'expected_cash', 'counted_cash', 'variance', 'return_limit', 'price',
    ])
    for (const table of EXPECTED_TABLES) {
      const columns = database.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string; type: string }>
      for (const column of columns) {
        if (moneyTypeColumns.has(column.name)) expect(column.type.toUpperCase(), `${table}.${column.name}`).toBe('INTEGER')
      }
    }
    expect(database.pragma('foreign_key_check')).toEqual([])
    database.close()
  })

  it('locks currency when a pending sale, purchase, or return is completed, not when drafted', () => {
    const cases = [
      { table: 'sales', initialStatus: 'DRAFT' },
      { table: 'purchases', initialStatus: 'DRAFT' },
      { table: 'returns', initialStatus: 'PENDING' },
    ] as const
    for (const { table, initialStatus } of cases) {
      const database = migratedDatabase()
      const repository = new SQLiteShopRepository(database)
      configureShop(repository)
      const result = database.prepare(`INSERT INTO "${table}" (status, currency_code) VALUES (?, ?)`).run(initialStatus, 'NGN')
      expect(repository.isCurrencyLocked(), `${table} draft`).toBe(false)
      database.prepare(`UPDATE "${table}" SET status = 'COMPLETED' WHERE id = ?`).run(Number(result.lastInsertRowid))
      expect(repository.isCurrencyLocked(), `${table} completion`).toBe(true)
      repository.close()
    }

    const database = migratedDatabase()
    const repository = new SQLiteShopRepository(database)
    configureShop(repository)
    const result = database.prepare("INSERT INTO sales (currency_code) VALUES ('NGN')").run()
    const saleId = Number(result.lastInsertRowid)
    expect(() => database.prepare('UPDATE sales SET total = 100 WHERE id = ?').run(saleId)).toThrow(/cannot be changed/i)
    expect(() => database.prepare('DELETE FROM sales WHERE id = ?').run(saleId)).toThrow(/cannot be deleted/i)
    repository.close()
  })

  it('locks the host currency automatically on the first sale/purchase/return/stock valuation, but not day close', () => {
    const transactionTypes: Array<'sale' | 'purchase' | 'return' | 'stock_valuation'> = ['sale', 'purchase', 'return', 'stock_valuation']
    for (const kind of transactionTypes) {
      const database = migratedDatabase()
      const repository = new SQLiteShopRepository(database)
      const service = new ShopService(repository)
      configureShop(repository)
      if (kind === 'sale') database.prepare('INSERT INTO sales (currency_code) VALUES (?)').run('NGN')
      if (kind === 'purchase') database.prepare('INSERT INTO purchases (currency_code) VALUES (?)').run('NGN')
      if (kind === 'return') database.prepare('INSERT INTO returns (currency_code) VALUES (?)').run('NGN')
      if (kind === 'stock_valuation') {
        database.prepare('INSERT INTO products (id, sku, name) VALUES (?, ?, ?)').run('p-1', 'p-1', 'Item')
        database.prepare(`
          INSERT INTO stock_movements (id, product_id, movement_type, quantity_delta_milli, currency_code)
          VALUES (?, ?, 'STOCK_VALUATION', ?, ?)
        `).run('valuation-1', 'p-1', 0, 'NGN')
      }
      expect(repository.isCurrencyLocked(), kind).toBe(true)
      expect(() => service.changeCurrency(USD, true, 'admin.test'), kind).toThrow(/locked/i)
      repository.close()
    }

    const database = migratedDatabase()
    const repository = new SQLiteShopRepository(database)
    const service = new ShopService(repository)
    configureShop(repository)
    database.prepare('INSERT INTO day_closings (currency_code) VALUES (?)').run('NGN')
    expect(repository.isCurrencyLocked()).toBe(false)
    expect(service.changeCurrency(USD, true, 'admin.test').currency.code).toBe('USD')
    repository.close()
  })
})
