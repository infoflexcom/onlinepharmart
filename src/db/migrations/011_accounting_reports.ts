import type Database from 'better-sqlite3'

/** Integer-minor-unit report snapshots, till settlement links, and historical supermarket dimensions. */
export function migrateAccountingReports(database: Database.Database): void {
  database.exec(`
    ALTER TABLE day_closings ADD COLUMN business_date TEXT NOT NULL DEFAULT '';
    ALTER TABLE day_closings ADD COLUMN expected_cash INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(expected_cash) = 'integer' AND expected_cash >= 0);
    ALTER TABLE day_closings ADD COLUMN counted_cash INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(counted_cash) = 'integer' AND counted_cash >= 0);
    ALTER TABLE day_closings ADD COLUMN variance INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(variance) = 'integer');
    ALTER TABLE day_closings ADD COLUMN store_name_snapshot TEXT NOT NULL DEFAULT '';
    ALTER TABLE day_closings ADD COLUMN store_address_snapshot TEXT NOT NULL DEFAULT '';

    ALTER TABLE cashier_shifts ADD COLUMN closed_by TEXT REFERENCES users(id);
    ALTER TABLE cashier_shifts ADD COLUMN close_note TEXT NOT NULL DEFAULT '';

    ALTER TABLE payments ADD COLUMN shift_id TEXT REFERENCES cashier_shifts(id);
    ALTER TABLE sale_items ADD COLUMN department_snapshot TEXT NOT NULL DEFAULT '';
    ALTER TABLE sale_items ADD COLUMN category_snapshot TEXT NOT NULL DEFAULT '';
    ALTER TABLE sale_items ADD COLUMN generic_name_snapshot TEXT NOT NULL DEFAULT '';

    UPDATE day_closings
    SET business_date = COALESCE(NULLIF(date(closed_at, 'localtime'), ''), date(opened_at, 'localtime')),
        expected_cash = cash_total,
        counted_cash = cash_total,
        variance = 0
    WHERE business_date = '';

    CREATE INDEX IF NOT EXISTS idx_sales_report_period ON sales(currency_code, status, created_at, cashier_id);
    CREATE INDEX IF NOT EXISTS idx_returns_report_period ON returns(currency_code, status, created_at, cashier_id);
    CREATE INDEX IF NOT EXISTS idx_payments_report_method ON payments(currency_code, payment_method, created_at);
    CREATE INDEX IF NOT EXISTS idx_payments_shift ON payments(shift_id, payment_method);
    CREATE INDEX IF NOT EXISTS idx_stock_movements_report_period ON stock_movements(currency_code, movement_type, created_at);
    CREATE INDEX IF NOT EXISTS idx_sale_items_product_report ON sale_items(product_id, sale_id);
    CREATE INDEX IF NOT EXISTS idx_purchases_report_period ON purchases(currency_code, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_cashier_shifts_report_period ON cashier_shifts(currency_code, status, opened_at, closed_at);
    CREATE INDEX IF NOT EXISTS idx_cash_drawer_events_user_created ON cash_drawer_events(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_day_closings_business_date ON day_closings(business_date, currency_code);
  `)
}
