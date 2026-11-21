import type Database from 'better-sqlite3'
import { CURRENCIES, DEFAULT_CURRENCY_CODE } from '../../currency/catalog'

export function migrateCore(db: Database.Database): void {
  db.exec(`
    CREATE TABLE currencies (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      symbol TEXT NOT NULL,
      decimals INTEGER NOT NULL CHECK (decimals BETWEEN 0 AND 4),
      symbol_position TEXT NOT NULL CHECK (symbol_position IN ('before', 'after')),
      thousand_sep TEXT NOT NULL,
      decimal_sep TEXT NOT NULL,
      is_custom INTEGER NOT NULL DEFAULT 0 CHECK (is_custom IN (0, 1))
    );
  `)
  const insertCurrency = db.prepare(`
    INSERT OR IGNORE INTO currencies
      (code, name, symbol, decimals, symbol_position, thousand_sep, decimal_sep, is_custom)
    VALUES (@code, @name, @symbol, @decimals, @position, @thousand, @decimal, 0)
  `)
  for (const currency of CURRENCIES) {
    insertCurrency.run({
      code: currency.code,
      name: currency.name,
      symbol: currency.symbol,
      decimals: currency.decimalPlaces,
      position: currency.symbolPosition,
      thousand: currency.thousandsSeparator,
      decimal: currency.decimalSeparator,
    })
  }

  db.exec(`
    CREATE TABLE settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      store_name TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      licence_number TEXT NOT NULL DEFAULT '',
      tax_number TEXT NOT NULL DEFAULT '',
      store_logo TEXT,
      receipt_footer TEXT NOT NULL DEFAULT '',
      thank_you_note TEXT NOT NULL DEFAULT '',
      show_powered_by INTEGER NOT NULL DEFAULT 1 CHECK (show_powered_by IN (0, 1)),
      mobile_lan_enabled INTEGER NOT NULL DEFAULT 0 CHECK (mobile_lan_enabled IN (0, 1)),
      mobile_internet_enabled INTEGER NOT NULL DEFAULT 0 CHECK (mobile_internet_enabled IN (0, 1)),
      currency_code TEXT NOT NULL DEFAULT '${DEFAULT_CURRENCY_CODE}' REFERENCES currencies(code),
      display_mode TEXT NOT NULL DEFAULT 'symbol' CHECK (display_mode IN ('symbol', 'code')),
      symbol_position TEXT NOT NULL DEFAULT 'before' CHECK (symbol_position IN ('before', 'after')),
      thousand_sep TEXT NOT NULL DEFAULT ',',
      decimal_sep TEXT NOT NULL DEFAULT '.',
      currency_locked INTEGER NOT NULL DEFAULT 0 CHECK (currency_locked IN (0, 1)),
      currency_locked_by_vendor INTEGER NOT NULL DEFAULT 0 CHECK (currency_locked_by_vendor IN (0, 1)),
      currency_locked_by_transaction INTEGER NOT NULL DEFAULT 0 CHECK (currency_locked_by_transaction IN (0, 1)),
      currency_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (currency_confirmed IN (0, 1)),
      setup_complete INTEGER NOT NULL DEFAULT 0 CHECK (setup_complete IN (0, 1)),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO settings (id) VALUES (1);

    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('ADMIN', 'SUPERVISOR', 'CASHIER')),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      failed_login_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
      locked_until TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE user_permissions (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      allow_wholesale INTEGER NOT NULL DEFAULT 1 CHECK (allow_wholesale IN (0, 1)),
      max_discount_pct INTEGER NOT NULL DEFAULT 0 CHECK (max_discount_pct BETWEEN 0 AND 10000),
      allow_credit_sales INTEGER NOT NULL DEFAULT 0 CHECK (allow_credit_sales IN (0, 1)),
      return_limit INTEGER NOT NULL DEFAULT 0 CHECK (typeof(return_limit) = 'integer' AND return_limit >= 0)
    );

    CREATE TABLE categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      parent_id TEXT REFERENCES categories(id),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE suppliers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      credit_limit INTEGER NOT NULL DEFAULT 0 CHECK (typeof(credit_limit) = 'integer' AND credit_limit >= 0),
      balance INTEGER NOT NULL DEFAULT 0 CHECK (typeof(balance) = 'integer'),
      row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE products (
      id TEXT PRIMARY KEY,
      sku TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category_id TEXT REFERENCES categories(id),
      preferred_supplier_id TEXT REFERENCES suppliers(id),
      unit TEXT NOT NULL DEFAULT 'each',
      sale_price INTEGER NOT NULL DEFAULT 0 CHECK (typeof(sale_price) = 'integer' AND sale_price >= 0),
      cost INTEGER NOT NULL DEFAULT 0 CHECK (typeof(cost) = 'integer' AND cost >= 0),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE stock (
      product_id TEXT PRIMARY KEY REFERENCES products(id),
      quantity_milli INTEGER NOT NULL DEFAULT 0 CHECK (typeof(quantity_milli) = 'integer'),
      reserved_milli INTEGER NOT NULL DEFAULT 0 CHECK (typeof(reserved_milli) = 'integer' AND reserved_milli >= 0),
      row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_number TEXT GENERATED ALWAYS AS ('R-' || printf('%010d', id)) STORED UNIQUE,
      customer_id TEXT REFERENCES customers(id),
      cashier_id TEXT REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('DRAFT', 'COMPLETED', 'VOIDED')),
      currency_code TEXT NOT NULL REFERENCES currencies(code),
      subtotal INTEGER NOT NULL DEFAULT 0 CHECK (typeof(subtotal) = 'integer' AND subtotal >= 0),
      discount INTEGER NOT NULL DEFAULT 0 CHECK (typeof(discount) = 'integer' AND discount >= 0),
      tax INTEGER NOT NULL DEFAULT 0 CHECK (typeof(tax) = 'integer' AND tax >= 0),
      total INTEGER NOT NULL DEFAULT 0 CHECK (typeof(total) = 'integer' AND total >= 0),
      paid INTEGER NOT NULL DEFAULT 0 CHECK (typeof(paid) = 'integer' AND paid >= 0),
      change_amount INTEGER NOT NULL DEFAULT 0 CHECK (typeof(change_amount) = 'integer' AND change_amount >= 0),
      store_name TEXT NOT NULL DEFAULT '',
      store_address TEXT NOT NULL DEFAULT '',
      store_phone TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE sale_items (
      id TEXT PRIMARY KEY,
      sale_id INTEGER NOT NULL REFERENCES sales(id),
      product_id TEXT REFERENCES products(id),
      description_snapshot TEXT NOT NULL,
      quantity_milli INTEGER NOT NULL CHECK (typeof(quantity_milli) = 'integer' AND quantity_milli > 0),
      unit_price INTEGER NOT NULL CHECK (typeof(unit_price) = 'integer' AND unit_price >= 0),
      discount INTEGER NOT NULL DEFAULT 0 CHECK (typeof(discount) = 'integer' AND discount >= 0),
      tax INTEGER NOT NULL DEFAULT 0 CHECK (typeof(tax) = 'integer' AND tax >= 0),
      line_total INTEGER NOT NULL CHECK (typeof(line_total) = 'integer' AND line_total >= 0)
    );

    CREATE TABLE returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      return_number TEXT GENERATED ALWAYS AS ('C-' || printf('%010d', id)) STORED UNIQUE,
      sale_id INTEGER REFERENCES sales(id),
      cashier_id TEXT REFERENCES users(id),
      approved_by TEXT REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('PENDING', 'COMPLETED', 'REJECTED')),
      currency_code TEXT NOT NULL REFERENCES currencies(code),
      subtotal INTEGER NOT NULL DEFAULT 0 CHECK (typeof(subtotal) = 'integer' AND subtotal >= 0),
      total INTEGER NOT NULL DEFAULT 0 CHECK (typeof(total) = 'integer' AND total >= 0),
      store_name TEXT NOT NULL DEFAULT '',
      store_address TEXT NOT NULL DEFAULT '',
      store_phone TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE return_items (
      id TEXT PRIMARY KEY,
      return_id INTEGER NOT NULL REFERENCES returns(id),
      sale_item_id TEXT REFERENCES sale_items(id),
      product_id TEXT REFERENCES products(id),
      description_snapshot TEXT NOT NULL,
      quantity_milli INTEGER NOT NULL CHECK (typeof(quantity_milli) = 'integer' AND quantity_milli > 0),
      unit_price INTEGER NOT NULL CHECK (typeof(unit_price) = 'integer' AND unit_price >= 0),
      line_total INTEGER NOT NULL CHECK (typeof(line_total) = 'integer' AND line_total >= 0)
    );

    CREATE TABLE payments (
      id TEXT PRIMARY KEY,
      sale_id INTEGER REFERENCES sales(id),
      return_id INTEGER REFERENCES returns(id),
      payment_method TEXT NOT NULL DEFAULT 'CASH',
      amount INTEGER NOT NULL CHECK (typeof(amount) = 'integer' AND amount >= 0),
      currency_code TEXT NOT NULL REFERENCES currencies(code),
      reference TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK ((sale_id IS NOT NULL AND return_id IS NULL) OR (sale_id IS NULL AND return_id IS NOT NULL))
    );

    CREATE TABLE purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_number TEXT GENERATED ALWAYS AS ('P-' || printf('%010d', id)) STORED UNIQUE,
      supplier_id TEXT REFERENCES suppliers(id),
      received_by TEXT REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('DRAFT', 'COMPLETED', 'CANCELLED')),
      currency_code TEXT NOT NULL REFERENCES currencies(code),
      subtotal INTEGER NOT NULL DEFAULT 0 CHECK (typeof(subtotal) = 'integer' AND subtotal >= 0),
      tax INTEGER NOT NULL DEFAULT 0 CHECK (typeof(tax) = 'integer' AND tax >= 0),
      total INTEGER NOT NULL DEFAULT 0 CHECK (typeof(total) = 'integer' AND total >= 0),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE purchase_items (
      id TEXT PRIMARY KEY,
      purchase_id INTEGER NOT NULL REFERENCES purchases(id),
      product_id TEXT REFERENCES products(id),
      description_snapshot TEXT NOT NULL,
      quantity_milli INTEGER NOT NULL CHECK (typeof(quantity_milli) = 'integer' AND quantity_milli > 0),
      unit_cost INTEGER NOT NULL CHECK (typeof(unit_cost) = 'integer' AND unit_cost >= 0),
      line_total INTEGER NOT NULL CHECK (typeof(line_total) = 'integer' AND line_total >= 0)
    );

    CREATE TABLE stock_movements (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id),
      movement_type TEXT NOT NULL CHECK (movement_type IN ('SALE', 'PURCHASE', 'RETURN', 'STOCK_VALUATION', 'ADJUSTMENT')),
      reference_type TEXT NOT NULL DEFAULT '',
      reference_id TEXT NOT NULL DEFAULT '',
      quantity_delta_milli INTEGER NOT NULL CHECK (typeof(quantity_delta_milli) = 'integer'),
      unit_cost INTEGER NOT NULL DEFAULT 0 CHECK (typeof(unit_cost) = 'integer' AND unit_cost >= 0),
      currency_code TEXT NOT NULL REFERENCES currencies(code),
      created_by TEXT REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE day_closings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      closing_number TEXT GENERATED ALWAYS AS ('D-' || printf('%010d', id)) STORED UNIQUE,
      closed_by TEXT REFERENCES users(id),
      opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      closed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      currency_code TEXT NOT NULL REFERENCES currencies(code),
      sales_total INTEGER NOT NULL DEFAULT 0 CHECK (typeof(sales_total) = 'integer' AND sales_total >= 0),
      returns_total INTEGER NOT NULL DEFAULT 0 CHECK (typeof(returns_total) = 'integer' AND returns_total >= 0),
      cash_total INTEGER NOT NULL DEFAULT 0 CHECK (typeof(cash_total) = 'integer' AND cash_total >= 0),
      note TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS business_entries (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('sale', 'purchase', 'return', 'stock_valuation', 'day_close')),
      currency_code TEXT NOT NULL REFERENCES currencies(code),
      amount_minor INTEGER NOT NULL CHECK (typeof(amount_minor) = 'integer' AND amount_minor >= 0),
      store_name_snapshot TEXT NOT NULL,
      store_address_snapshot TEXT NOT NULL,
      store_phone_snapshot TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      device_name TEXT NOT NULL DEFAULT 'LOCAL',
      ip_address TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE license_state (
      license_id TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      machine_id TEXT NOT NULL,
      edition TEXT NOT NULL CHECK (edition IN ('PHARMACY', 'SUPERMARKET', 'BOTH')),
      start TEXT NOT NULL,
      end TEXT NOT NULL,
      status TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('online', 'file', 'onsite')),
      default_currency TEXT REFERENCES currencies(code),
      lock_currency INTEGER NOT NULL DEFAULT 0 CHECK (lock_currency IN (0, 1)),
      last_online_check TEXT,
      reported_to_portal INTEGER NOT NULL DEFAULT 0 CHECK (reported_to_portal IN (0, 1)),
      history TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      platform TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      admin_user_id TEXT NOT NULL REFERENCES users(id),
      approved_by TEXT REFERENCES users(id),
      approved_at TEXT,
      last_seen TEXT,
      last_ip TEXT,
      revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE refresh_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE idempotency_keys (
      key TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      route TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response_json TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE approval_requests (
      id TEXT PRIMARY KEY,
      request_type TEXT NOT NULL,
      requested_by TEXT NOT NULL REFERENCES users(id),
      approved_by TEXT REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT
    );
  `)
}
