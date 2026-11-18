import type Database from 'better-sqlite3'

/** Atomic return requests, approvals, historical documents, credits, and loyalty reversals. */
export function migrateReturnsWorkflow(database: Database.Database): void {
  database.exec(`
    ALTER TABLE settings ADD COLUMN return_window_days INTEGER NOT NULL DEFAULT 7
      CHECK (typeof(return_window_days) = 'integer' AND return_window_days BETWEEN 1 AND 365);

    ALTER TABLE sale_items ADD COLUMN expiry_tracking_snapshot INTEGER NOT NULL DEFAULT 0
      CHECK (expiry_tracking_snapshot IN (0, 1));

    ALTER TABLE returns ADD COLUMN reason TEXT NOT NULL DEFAULT 'OTHER'
      CHECK (reason IN ('WRONG_ITEM', 'DAMAGED', 'EXPIRED', 'CUSTOMER_CHANGED_MIND', 'OTHER'));
    ALTER TABLE returns ADD COLUMN return_type TEXT NOT NULL DEFAULT 'REFUND'
      CHECK (return_type IN ('REFUND', 'STORE_CREDIT', 'EXCHANGE'));
    ALTER TABLE returns ADD COLUMN refund_method TEXT CHECK (refund_method IS NULL OR refund_method IN ('CASH', 'TRANSFER', 'CARD'));
    ALTER TABLE returns ADD COLUMN payment_reference TEXT NOT NULL DEFAULT '';
    ALTER TABLE returns ADD COLUMN reason_note TEXT NOT NULL DEFAULT '';
    ALTER TABLE returns ADD COLUMN request_hash TEXT NOT NULL DEFAULT '';
    ALTER TABLE returns ADD COLUMN idempotency_key TEXT;
    ALTER TABLE returns ADD COLUMN original_receipt_number TEXT NOT NULL DEFAULT '';
    ALTER TABLE returns ADD COLUMN cashier_name_snapshot TEXT NOT NULL DEFAULT '';
    ALTER TABLE returns ADD COLUMN approved_name_snapshot TEXT NOT NULL DEFAULT '';
    ALTER TABLE returns ADD COLUMN approved_at TEXT;
    ALTER TABLE returns ADD COLUMN workstation_snapshot TEXT NOT NULL DEFAULT '';
    ALTER TABLE returns ADD COLUMN approval_channel TEXT CHECK (approval_channel IS NULL OR approval_channel IN ('DESKTOP', 'MOBILE'));
    ALTER TABLE returns ADD COLUMN approval_request_id TEXT REFERENCES approval_requests(id);
    ALTER TABLE returns ADD COLUMN return_window_days_snapshot INTEGER NOT NULL DEFAULT 7
      CHECK (return_window_days_snapshot BETWEEN 1 AND 365);
    ALTER TABLE returns ADD COLUMN return_window_override INTEGER NOT NULL DEFAULT 0
      CHECK (return_window_override IN (0, 1));
    ALTER TABLE returns ADD COLUMN return_window_override_reason TEXT NOT NULL DEFAULT '';
    ALTER TABLE returns ADD COLUMN return_limit_minor INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(return_limit_minor) = 'integer' AND return_limit_minor >= 0);
    ALTER TABLE returns ADD COLUMN store_email TEXT NOT NULL DEFAULT '';
    ALTER TABLE returns ADD COLUMN store_licence_number TEXT NOT NULL DEFAULT '';
    ALTER TABLE returns ADD COLUMN store_tax_number TEXT NOT NULL DEFAULT '';
    ALTER TABLE returns ADD COLUMN store_logo TEXT;
    ALTER TABLE returns ADD COLUMN store_receipt_footer TEXT NOT NULL DEFAULT '';
    ALTER TABLE returns ADD COLUMN store_thank_you_note TEXT NOT NULL DEFAULT '';
    ALTER TABLE returns ADD COLUMN currency_name_snapshot TEXT NOT NULL DEFAULT '';
    ALTER TABLE returns ADD COLUMN currency_symbol_snapshot TEXT NOT NULL DEFAULT '';
    ALTER TABLE returns ADD COLUMN currency_decimals_snapshot INTEGER NOT NULL DEFAULT 2
      CHECK (currency_decimals_snapshot BETWEEN 0 AND 4);
    ALTER TABLE returns ADD COLUMN currency_is_custom_snapshot INTEGER NOT NULL DEFAULT 0
      CHECK (currency_is_custom_snapshot IN (0, 1));
    ALTER TABLE returns ADD COLUMN display_mode_snapshot TEXT NOT NULL DEFAULT 'code'
      CHECK (display_mode_snapshot IN ('symbol', 'code'));
    ALTER TABLE returns ADD COLUMN symbol_position_snapshot TEXT NOT NULL DEFAULT 'before'
      CHECK (symbol_position_snapshot IN ('before', 'after'));
    ALTER TABLE returns ADD COLUMN thousand_sep_snapshot TEXT NOT NULL DEFAULT ',';
    ALTER TABLE returns ADD COLUMN decimal_sep_snapshot TEXT NOT NULL DEFAULT '.';
    ALTER TABLE returns ADD COLUMN customer_id TEXT REFERENCES customers(id);
    ALTER TABLE returns ADD COLUMN customer_name_snapshot TEXT NOT NULL DEFAULT '';
    ALTER TABLE returns ADD COLUMN customer_phone_snapshot TEXT NOT NULL DEFAULT '';
    ALTER TABLE returns ADD COLUMN customer_email_snapshot TEXT NOT NULL DEFAULT '';
    ALTER TABLE returns ADD COLUMN customer_address_snapshot TEXT NOT NULL DEFAULT '';
    ALTER TABLE returns ADD COLUMN promotion_amount_reversed INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(promotion_amount_reversed) = 'integer' AND promotion_amount_reversed >= 0);
    ALTER TABLE returns ADD COLUMN loyalty_discount_reversed INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(loyalty_discount_reversed) = 'integer' AND loyalty_discount_reversed >= 0);
    ALTER TABLE returns ADD COLUMN loyalty_points_reversed INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(loyalty_points_reversed) = 'integer' AND loyalty_points_reversed >= 0);
    ALTER TABLE returns ADD COLUMN loyalty_points_restored INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(loyalty_points_restored) = 'integer' AND loyalty_points_restored >= 0);

    ALTER TABLE return_items ADD COLUMN gross_amount INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(gross_amount) = 'integer' AND gross_amount >= 0);
    ALTER TABLE return_items ADD COLUMN manual_discount INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(manual_discount) = 'integer' AND manual_discount >= 0);
    ALTER TABLE return_items ADD COLUMN promotion_discount INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(promotion_discount) = 'integer' AND promotion_discount >= 0);
    ALTER TABLE return_items ADD COLUMN loyalty_discount INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(loyalty_discount) = 'integer' AND loyalty_discount >= 0);
    ALTER TABLE return_items ADD COLUMN item_condition TEXT NOT NULL DEFAULT 'RESELLABLE'
      CHECK (item_condition IN ('RESELLABLE', 'OPENED', 'EXPIRED', 'DAMAGED', 'OTHER_NON_RESELLABLE'));
    ALTER TABLE return_items ADD COLUMN stock_disposition TEXT NOT NULL DEFAULT 'NO_STOCK'
      CHECK (stock_disposition IN ('RESTOCKED', 'WRITTEN_OFF', 'NO_STOCK'));
    ALTER TABLE return_items ADD COLUMN expiry_tracking_snapshot INTEGER NOT NULL DEFAULT 0
      CHECK (expiry_tracking_snapshot IN (0, 1));
    ALTER TABLE return_items ADD COLUMN source_batch_id TEXT;
    ALTER TABLE return_items ADD COLUMN source_batch_number_snapshot TEXT NOT NULL DEFAULT '';
    ALTER TABLE return_items ADD COLUMN source_expiry_date_snapshot TEXT NOT NULL DEFAULT '';
    ALTER TABLE return_items ADD COLUMN writeoff_reason TEXT NOT NULL DEFAULT '';

    ALTER TABLE loyalty_members ADD COLUMN points_debt INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(points_debt) = 'integer' AND points_debt >= 0);
    ALTER TABLE loyalty_transactions ADD COLUMN return_id INTEGER REFERENCES returns(id);

    CREATE TABLE return_credits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      credit_number TEXT GENERATED ALWAYS AS ('SC-' || printf('%010d', id)) STORED UNIQUE,
      return_id INTEGER NOT NULL UNIQUE REFERENCES returns(id),
      customer_id TEXT REFERENCES customers(id),
      currency_code TEXT NOT NULL REFERENCES currencies(code),
      credit_type TEXT NOT NULL CHECK (credit_type IN ('STORE_CREDIT', 'EXCHANGE')),
      amount_minor INTEGER NOT NULL CHECK (typeof(amount_minor) = 'integer' AND amount_minor >= 0),
      remaining_minor INTEGER NOT NULL CHECK (typeof(remaining_minor) = 'integer' AND remaining_minor >= 0 AND remaining_minor <= amount_minor),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE return_print_events (
      id TEXT PRIMARY KEY,
      return_id INTEGER NOT NULL REFERENCES returns(id),
      printed_by TEXT NOT NULL REFERENCES users(id),
      workstation TEXT NOT NULL,
      document_layout TEXT NOT NULL CHECK (document_layout IN ('THERMAL_80', 'THERMAL_58', 'A4_RECEIPT', 'A4_INVOICE')),
      is_duplicate INTEGER NOT NULL CHECK (is_duplicate IN (0, 1)),
      printed_at TEXT NOT NULL
    );

    CREATE INDEX idx_returns_status_created ON returns(status, created_at DESC);
    CREATE UNIQUE INDEX idx_returns_idempotency ON returns(idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX idx_return_items_sale_item ON return_items(sale_item_id, return_id);
    CREATE INDEX idx_return_credits_customer_created ON return_credits(customer_id, created_at DESC);
    CREATE INDEX idx_loyalty_return_transactions ON loyalty_transactions(return_id) WHERE return_id IS NOT NULL;
    CREATE INDEX idx_return_print_events_return ON return_print_events(return_id, printed_at DESC);

    CREATE TRIGGER completed_returns_cannot_be_changed
    BEFORE UPDATE ON returns
    WHEN OLD.status = 'COMPLETED'
    BEGIN
      SELECT RAISE(ABORT, 'Completed returns cannot be changed');
    END;

    CREATE TRIGGER completed_returns_cannot_be_deleted
    BEFORE DELETE ON returns
    WHEN OLD.status = 'COMPLETED'
    BEGIN
      SELECT RAISE(ABORT, 'Completed returns cannot be deleted');
    END;

    CREATE TRIGGER completed_return_items_cannot_be_changed
    BEFORE UPDATE ON return_items
    WHEN EXISTS (SELECT 1 FROM returns WHERE id = OLD.return_id AND status = 'COMPLETED')
    BEGIN
      SELECT RAISE(ABORT, 'Items on completed returns cannot be changed');
    END;

    CREATE TRIGGER completed_return_items_cannot_be_deleted
    BEFORE DELETE ON return_items
    WHEN EXISTS (SELECT 1 FROM returns WHERE id = OLD.return_id AND status = 'COMPLETED')
    BEGIN
      SELECT RAISE(ABORT, 'Items on completed returns cannot be deleted');
    END;

    CREATE TRIGGER completed_return_payments_cannot_be_changed
    BEFORE UPDATE ON payments
    WHEN OLD.return_id IS NOT NULL AND EXISTS (SELECT 1 FROM returns WHERE id = OLD.return_id AND status = 'COMPLETED')
    BEGIN
      SELECT RAISE(ABORT, 'Payments on completed returns cannot be changed');
    END;

    CREATE TRIGGER completed_return_payments_cannot_be_deleted
    BEFORE DELETE ON payments
    WHEN OLD.return_id IS NOT NULL AND EXISTS (SELECT 1 FROM returns WHERE id = OLD.return_id AND status = 'COMPLETED')
    BEGIN
      SELECT RAISE(ABORT, 'Payments on completed returns cannot be deleted');
    END;

    CREATE TRIGGER return_print_events_are_immutable_update
    BEFORE UPDATE ON return_print_events
    BEGIN
      SELECT RAISE(ABORT, 'Return print audit events are immutable');
    END;

    CREATE TRIGGER return_print_events_are_immutable_delete
    BEFORE DELETE ON return_print_events
    BEGIN
      SELECT RAISE(ABORT, 'Return print audit events are immutable');
    END;
  `)
}
