import type Database from 'better-sqlite3'

export function migrateIndexesAndGuards(db: Database.Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_users_role_active ON users(role, is_active);
    CREATE INDEX IF NOT EXISTS idx_products_category_active ON products(category_id, is_active);
    CREATE INDEX IF NOT EXISTS idx_products_department_active ON products(department_id, is_active);
    CREATE INDEX IF NOT EXISTS idx_stock_movements_product_created ON stock_movements(product_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
    CREATE INDEX IF NOT EXISTS idx_sales_customer_created ON sales(customer_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
    CREATE INDEX IF NOT EXISTS idx_returns_sale_created ON returns(sale_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_purchases_created ON purchases(created_at);
    CREATE INDEX IF NOT EXISTS idx_day_closings_closed ON day_closings(closed_at);
    CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_approval_requests_status_created ON approval_requests(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_product_batches_expiry ON product_batches(expiry_date);
    CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_member_created ON loyalty_transactions(loyalty_member_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_cash_drawer_events_shift_created ON cash_drawer_events(shift_id, created_at);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_products_plu_code_unique ON products(plu_code) WHERE plu_code IS NOT NULL;

    CREATE TRIGGER IF NOT EXISTS lock_currency_after_business_entry
    AFTER INSERT ON business_entries
    WHEN NEW.kind IN ('sale', 'purchase', 'return', 'stock_valuation')
    BEGIN
      UPDATE settings SET currency_locked = 1, currency_locked_by_transaction = 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS lock_currency_after_sale
    AFTER INSERT ON sales
    WHEN NEW.status = 'COMPLETED'
    BEGIN
      UPDATE settings SET currency_locked = 1, currency_locked_by_transaction = 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS lock_currency_when_sale_completes
    AFTER UPDATE OF status ON sales
    WHEN OLD.status <> 'COMPLETED' AND NEW.status = 'COMPLETED'
    BEGIN
      UPDATE settings SET currency_locked = 1, currency_locked_by_transaction = 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS lock_currency_after_purchase
    AFTER INSERT ON purchases
    WHEN NEW.status = 'COMPLETED'
    BEGIN
      UPDATE settings SET currency_locked = 1, currency_locked_by_transaction = 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS lock_currency_when_purchase_completes
    AFTER UPDATE OF status ON purchases
    WHEN OLD.status <> 'COMPLETED' AND NEW.status = 'COMPLETED'
    BEGIN
      UPDATE settings SET currency_locked = 1, currency_locked_by_transaction = 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS lock_currency_after_return
    AFTER INSERT ON returns
    WHEN NEW.status = 'COMPLETED'
    BEGIN
      UPDATE settings SET currency_locked = 1, currency_locked_by_transaction = 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS lock_currency_when_return_completes
    AFTER UPDATE OF status ON returns
    WHEN OLD.status <> 'COMPLETED' AND NEW.status = 'COMPLETED'
    BEGIN
      UPDATE settings SET currency_locked = 1, currency_locked_by_transaction = 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS lock_currency_after_valuation
    AFTER INSERT ON stock_movements
    WHEN NEW.movement_type = 'STOCK_VALUATION'
    BEGIN
      UPDATE settings SET currency_locked = 1, currency_locked_by_transaction = 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS lock_flag_follows_vendor_lock
    AFTER UPDATE OF currency_locked_by_vendor ON settings
    WHEN NEW.currency_locked_by_vendor = 1 AND NEW.currency_locked = 0
    BEGIN
      UPDATE settings SET currency_locked = 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS transaction_currency_lock_is_permanent
    BEFORE UPDATE OF currency_locked_by_transaction ON settings
    WHEN OLD.currency_locked_by_transaction = 1 AND NEW.currency_locked_by_transaction = 0
    BEGIN
      SELECT RAISE(ABORT, 'Transaction currency lock cannot be cleared');
    END;

    CREATE TRIGGER IF NOT EXISTS currency_lock_cannot_be_cleared
    BEFORE UPDATE OF currency_locked ON settings
    WHEN NEW.currency_locked = 0 AND (OLD.currency_locked_by_vendor = 1 OR OLD.currency_locked_by_transaction = 1)
    BEGIN
      SELECT RAISE(ABORT, 'Currency lock cannot be cleared while a lock source is active');
    END;

    CREATE TRIGGER IF NOT EXISTS currency_cannot_change_after_lock
    BEFORE UPDATE OF currency_code ON settings
    WHEN OLD.currency_locked = 1 AND NEW.currency_code <> OLD.currency_code
    BEGIN
      SELECT RAISE(ABORT, 'Currency cannot be changed after it is locked');
    END;

    CREATE TRIGGER IF NOT EXISTS completed_entries_are_immutable
    BEFORE DELETE ON business_entries
    BEGIN
      SELECT RAISE(ABORT, 'Completed business entries cannot be deleted');
    END;

    CREATE TRIGGER IF NOT EXISTS completed_entries_cannot_be_changed
    BEFORE UPDATE ON business_entries
    BEGIN
      SELECT RAISE(ABORT, 'Completed business entries cannot be changed');
    END;

    CREATE TRIGGER IF NOT EXISTS completed_sales_cannot_be_deleted
    BEFORE DELETE ON sales
    WHEN OLD.status = 'COMPLETED'
    BEGIN
      SELECT RAISE(ABORT, 'Completed sales cannot be deleted');
    END;

    CREATE TRIGGER IF NOT EXISTS completed_sales_cannot_be_changed
    BEFORE UPDATE ON sales
    WHEN OLD.status = 'COMPLETED'
    BEGIN
      SELECT RAISE(ABORT, 'Completed sales cannot be changed');
    END;
  `)
}
