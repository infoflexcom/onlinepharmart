import type Database from 'better-sqlite3'

/** Desktop POS, durable receipt snapshots, idempotency, held carts, and audited reprints. */
export function migratePointOfSale(database: Database.Database): void {
  database.exec(`
    ALTER TABLE sales ADD COLUMN sale_type TEXT NOT NULL DEFAULT 'RETAIL'
      CHECK (sale_type IN ('RETAIL', 'WHOLESALE'));
    ALTER TABLE sales ADD COLUMN idempotency_key TEXT;
    ALTER TABLE sales ADD COLUMN request_hash TEXT NOT NULL DEFAULT '';
    ALTER TABLE sales ADD COLUMN cashier_name_snapshot TEXT NOT NULL DEFAULT '';
    ALTER TABLE sales ADD COLUMN workstation_snapshot TEXT NOT NULL DEFAULT '';
    ALTER TABLE sales ADD COLUMN store_email TEXT NOT NULL DEFAULT '';
    ALTER TABLE sales ADD COLUMN store_licence_number TEXT NOT NULL DEFAULT '';
    ALTER TABLE sales ADD COLUMN store_tax_number TEXT NOT NULL DEFAULT '';
    ALTER TABLE sales ADD COLUMN store_logo TEXT;
    ALTER TABLE sales ADD COLUMN store_receipt_footer TEXT NOT NULL DEFAULT '';
    ALTER TABLE sales ADD COLUMN store_thank_you_note TEXT NOT NULL DEFAULT '';
    ALTER TABLE sales ADD COLUMN customer_name_snapshot TEXT NOT NULL DEFAULT '';
    ALTER TABLE sales ADD COLUMN customer_phone_snapshot TEXT NOT NULL DEFAULT '';
    ALTER TABLE sales ADD COLUMN customer_email_snapshot TEXT NOT NULL DEFAULT '';
    ALTER TABLE sales ADD COLUMN customer_address_snapshot TEXT NOT NULL DEFAULT '';
    ALTER TABLE sales ADD COLUMN currency_name_snapshot TEXT NOT NULL DEFAULT '';
    ALTER TABLE sales ADD COLUMN currency_symbol_snapshot TEXT NOT NULL DEFAULT '';
    ALTER TABLE sales ADD COLUMN currency_decimals_snapshot INTEGER NOT NULL DEFAULT 2
      CHECK (currency_decimals_snapshot BETWEEN 0 AND 4);
    ALTER TABLE sales ADD COLUMN currency_is_custom_snapshot INTEGER NOT NULL DEFAULT 0
      CHECK (currency_is_custom_snapshot IN (0, 1));
    ALTER TABLE sales ADD COLUMN display_mode_snapshot TEXT NOT NULL DEFAULT 'code'
      CHECK (display_mode_snapshot IN ('symbol', 'code'));
    ALTER TABLE sales ADD COLUMN symbol_position_snapshot TEXT NOT NULL DEFAULT 'before'
      CHECK (symbol_position_snapshot IN ('before', 'after'));
    ALTER TABLE sales ADD COLUMN thousand_sep_snapshot TEXT NOT NULL DEFAULT ',';
    ALTER TABLE sales ADD COLUMN decimal_sep_snapshot TEXT NOT NULL DEFAULT '.';
    ALTER TABLE sales ADD COLUMN promotion_id TEXT;
    ALTER TABLE sales ADD COLUMN promotion_name_snapshot TEXT NOT NULL DEFAULT '';
    ALTER TABLE sales ADD COLUMN promotion_discount INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(promotion_discount) = 'integer' AND promotion_discount >= 0);
    ALTER TABLE sales ADD COLUMN manual_discount INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(manual_discount) = 'integer' AND manual_discount >= 0);
    ALTER TABLE sales ADD COLUMN loyalty_member_id TEXT;
    ALTER TABLE sales ADD COLUMN loyalty_member_number_snapshot TEXT NOT NULL DEFAULT '';
    ALTER TABLE sales ADD COLUMN loyalty_points_earned INTEGER NOT NULL DEFAULT 0 CHECK (loyalty_points_earned >= 0);
    ALTER TABLE sales ADD COLUMN loyalty_points_redeemed INTEGER NOT NULL DEFAULT 0 CHECK (loyalty_points_redeemed >= 0);
    ALTER TABLE sales ADD COLUMN loyalty_discount INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(loyalty_discount) = 'integer' AND loyalty_discount >= 0);
    ALTER TABLE sales ADD COLUMN credit_amount INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(credit_amount) = 'integer' AND credit_amount >= 0);
    ALTER TABLE sales ADD COLUMN total_tendered INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(total_tendered) = 'integer' AND total_tendered >= 0);
    ALTER TABLE sales ADD COLUMN prescription_acknowledged INTEGER NOT NULL DEFAULT 0
      CHECK (prescription_acknowledged IN (0, 1));
    ALTER TABLE sales ADD COLUMN shift_id TEXT;

    ALTER TABLE sale_items ADD COLUMN price_tier TEXT NOT NULL DEFAULT 'RETAIL'
      CHECK (price_tier IN ('RETAIL', 'WHOLESALE'));
    ALTER TABLE sale_items ADD COLUMN gross_total INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(gross_total) = 'integer' AND gross_total >= 0);
    ALTER TABLE sale_items ADD COLUMN manual_discount INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(manual_discount) = 'integer' AND manual_discount >= 0);
    ALTER TABLE sale_items ADD COLUMN promotion_discount INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(promotion_discount) = 'integer' AND promotion_discount >= 0);
    ALTER TABLE sale_items ADD COLUMN loyalty_discount INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(loyalty_discount) = 'integer' AND loyalty_discount >= 0);
    ALTER TABLE sale_items ADD COLUMN product_sku_snapshot TEXT NOT NULL DEFAULT '';
    ALTER TABLE sale_items ADD COLUMN unit_snapshot TEXT NOT NULL DEFAULT '';
    ALTER TABLE sale_items ADD COLUMN prescription_required INTEGER NOT NULL DEFAULT 0
      CHECK (prescription_required IN (0, 1));

    ALTER TABLE payments ADD COLUMN tendered_amount INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(tendered_amount) = 'integer' AND tendered_amount >= 0);
    ALTER TABLE payments ADD COLUMN change_amount INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(change_amount) = 'integer' AND change_amount >= 0);

    ALTER TABLE promotions ADD COLUMN product_id TEXT REFERENCES products(id);
    ALTER TABLE promotions ADD COLUMN department_id TEXT REFERENCES departments(id);
    ALTER TABLE promotions ADD COLUMN minimum_quantity_milli INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(minimum_quantity_milli) = 'integer' AND minimum_quantity_milli >= 0);
    ALTER TABLE promotions ADD COLUMN minimum_subtotal INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(minimum_subtotal) = 'integer' AND minimum_subtotal >= 0);

    CREATE UNIQUE INDEX idx_sales_idempotency_key ON sales(idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_sales_customer_created ON sales(customer_id, created_at DESC);
    CREATE INDEX idx_sales_cashier_created ON sales(cashier_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sale_items_sale_order ON sale_items(sale_id);
    CREATE INDEX idx_promotions_active_window ON promotions(is_active, starts_at, ends_at);

    CREATE TABLE sale_item_batches (
      sale_item_id TEXT NOT NULL REFERENCES sale_items(id),
      batch_id TEXT NOT NULL,
      batch_number_snapshot TEXT NOT NULL,
      expiry_date_snapshot TEXT NOT NULL,
      quantity_milli INTEGER NOT NULL CHECK (typeof(quantity_milli) = 'integer' AND quantity_milli > 0),
      PRIMARY KEY (sale_item_id, batch_id)
    );

    CREATE TABLE held_carts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      sale_type TEXT NOT NULL CHECK (sale_type IN ('RETAIL', 'WHOLESALE')),
      cart_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_held_carts_user_updated ON held_carts(user_id, updated_at DESC);

    CREATE TABLE sale_print_events (
      id TEXT PRIMARY KEY,
      sale_id INTEGER NOT NULL REFERENCES sales(id),
      printed_by TEXT NOT NULL REFERENCES users(id),
      workstation TEXT NOT NULL,
      document_layout TEXT NOT NULL CHECK (document_layout IN ('THERMAL_80', 'THERMAL_58', 'A4_RECEIPT', 'A4_INVOICE')),
      is_duplicate INTEGER NOT NULL CHECK (is_duplicate IN (0, 1)),
      printed_at TEXT NOT NULL
    );
    CREATE INDEX idx_sale_print_events_sale ON sale_print_events(sale_id, printed_at DESC);

    CREATE TRIGGER sale_print_events_are_immutable_update
    BEFORE UPDATE ON sale_print_events
    BEGIN
      SELECT RAISE(ABORT, 'Receipt print audit events are immutable');
    END;

    CREATE TRIGGER sale_print_events_are_immutable_delete
    BEFORE DELETE ON sale_print_events
    BEGIN
      SELECT RAISE(ABORT, 'Receipt print audit events are immutable');
    END;
  `)
}
