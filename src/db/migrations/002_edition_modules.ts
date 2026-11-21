import type Database from 'better-sqlite3'

export function migrateEditionModules(db: Database.Database): void {
  db.exec(`
    CREATE TABLE departments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE products ADD COLUMN department_id TEXT REFERENCES departments(id);
    ALTER TABLE products ADD COLUMN generic_name TEXT NOT NULL DEFAULT '';
    ALTER TABLE products ADD COLUMN prescription_required INTEGER NOT NULL DEFAULT 0 CHECK (prescription_required IN (0, 1));
    ALTER TABLE products ADD COLUMN shelf_location TEXT NOT NULL DEFAULT '';
    ALTER TABLE products ADD COLUMN weighed_item INTEGER NOT NULL DEFAULT 0 CHECK (weighed_item IN (0, 1));
    ALTER TABLE products ADD COLUMN plu_code TEXT;
    ALTER TABLE products ADD COLUMN price_per_kg INTEGER CHECK (price_per_kg IS NULL OR (typeof(price_per_kg) = 'integer' AND price_per_kg >= 0));

    CREATE TABLE product_batches (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id),
      batch_no TEXT NOT NULL,
      expiry_date TEXT NOT NULL,
      quantity_milli INTEGER NOT NULL DEFAULT 0 CHECK (typeof(quantity_milli) = 'integer' AND quantity_milli >= 0),
      cost INTEGER NOT NULL DEFAULT 0 CHECK (typeof(cost) = 'integer' AND cost >= 0),
      row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (product_id, batch_no)
    );

    CREATE TABLE product_barcodes (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id),
      barcode TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE product_variants (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id),
      variant_code TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      attributes_json TEXT NOT NULL DEFAULT '{}',
      sale_price INTEGER CHECK (sale_price IS NULL OR (typeof(sale_price) = 'integer' AND sale_price >= 0)),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE promotions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      promotion_type TEXT NOT NULL CHECK (promotion_type IN ('FIXED', 'PERCENT')),
      amount_minor INTEGER CHECK (amount_minor IS NULL OR (typeof(amount_minor) = 'integer' AND amount_minor >= 0)),
      discount_basis_points INTEGER CHECK (discount_basis_points IS NULL OR discount_basis_points BETWEEN 0 AND 10000),
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      CHECK ((promotion_type = 'FIXED' AND amount_minor IS NOT NULL AND discount_basis_points IS NULL)
          OR (promotion_type = 'PERCENT' AND amount_minor IS NULL AND discount_basis_points IS NOT NULL))
    );

    CREATE TABLE price_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      product_id TEXT REFERENCES products(id),
      department_id TEXT REFERENCES departments(id),
      minimum_price INTEGER CHECK (minimum_price IS NULL OR (typeof(minimum_price) = 'integer' AND minimum_price >= 0)),
      maximum_price INTEGER CHECK (maximum_price IS NULL OR (typeof(maximum_price) = 'integer' AND maximum_price >= 0)),
      starts_at TEXT,
      ends_at TEXT,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      CHECK (product_id IS NOT NULL OR department_id IS NOT NULL)
    );

    CREATE TABLE loyalty_members (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL UNIQUE REFERENCES customers(id),
      member_number TEXT NOT NULL UNIQUE,
      points_balance INTEGER NOT NULL DEFAULT 0 CHECK (points_balance >= 0),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE loyalty_transactions (
      id TEXT PRIMARY KEY,
      loyalty_member_id TEXT NOT NULL REFERENCES loyalty_members(id),
      sale_id INTEGER REFERENCES sales(id),
      points_delta INTEGER NOT NULL CHECK (points_delta <> 0),
      transaction_type TEXT NOT NULL CHECK (transaction_type IN ('EARN', 'REDEEM', 'ADJUST')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE cashier_shifts (
      id TEXT PRIMARY KEY,
      cashier_id TEXT NOT NULL REFERENCES users(id),
      currency_code TEXT NOT NULL REFERENCES currencies(code),
      opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      closed_at TEXT,
      opening_float INTEGER NOT NULL DEFAULT 0 CHECK (typeof(opening_float) = 'integer' AND opening_float >= 0),
      expected_cash INTEGER CHECK (expected_cash IS NULL OR (typeof(expected_cash) = 'integer' AND expected_cash >= 0)),
      counted_cash INTEGER CHECK (counted_cash IS NULL OR (typeof(counted_cash) = 'integer' AND counted_cash >= 0)),
      variance INTEGER CHECK (variance IS NULL OR typeof(variance) = 'integer'),
      status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED'))
    );

    CREATE TABLE cash_drawer_events (
      id TEXT PRIMARY KEY,
      shift_id TEXT NOT NULL REFERENCES cashier_shifts(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      event_type TEXT NOT NULL CHECK (event_type IN ('PAID_IN', 'PAID_OUT', 'FLOAT', 'SAFE_DROP')),
      amount INTEGER NOT NULL CHECK (typeof(amount) = 'integer' AND amount >= 0),
      currency_code TEXT NOT NULL REFERENCES currencies(code),
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)
}
