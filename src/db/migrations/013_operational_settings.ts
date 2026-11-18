import type Database from 'better-sqlite3'

/**
 * Adds the operational settings that are not part of the printed store identity (document layout,
 * optional VAT, discount ceiling, printer, payment methods, edition options) plus the local record of
 * backups and restores. The backup log lives in the shop database on purpose: it is shop-operator
 * history, not licence state, so a restore deliberately keeps the current log rather than the
 * restored one.
 */
export function migrateOperationalSettings(database: Database.Database): void {
  database.exec(`
    ALTER TABLE settings ADD COLUMN document_layout TEXT NOT NULL DEFAULT 'THERMAL_80'
      CHECK (document_layout IN ('THERMAL_80', 'THERMAL_58', 'A4_RECEIPT'));
    ALTER TABLE settings ADD COLUMN vat_enabled INTEGER NOT NULL DEFAULT 0
      CHECK (vat_enabled IN (0, 1));
    ALTER TABLE settings ADD COLUMN vat_rate_basis_points INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(vat_rate_basis_points) = 'integer' AND vat_rate_basis_points BETWEEN 0 AND 10000);
    ALTER TABLE settings ADD COLUMN vat_inclusive INTEGER NOT NULL DEFAULT 0
      CHECK (vat_inclusive IN (0, 1));
    ALTER TABLE settings ADD COLUMN discount_limit_basis_points INTEGER NOT NULL DEFAULT 10000
      CHECK (typeof(discount_limit_basis_points) = 'integer' AND discount_limit_basis_points BETWEEN 0 AND 10000);
    ALTER TABLE settings ADD COLUMN printer_name TEXT NOT NULL DEFAULT '';
    ALTER TABLE settings ADD COLUMN enabled_payment_methods TEXT NOT NULL
      DEFAULT '["CASH","TRANSFER","CARD","CREDIT"]';
    ALTER TABLE settings ADD COLUMN expiry_alert_days INTEGER NOT NULL DEFAULT 90
      CHECK (typeof(expiry_alert_days) = 'integer' AND expiry_alert_days BETWEEN 1 AND 3650);
    ALTER TABLE settings ADD COLUMN loyalty_rate_basis_points INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(loyalty_rate_basis_points) = 'integer' AND loyalty_rate_basis_points BETWEEN 0 AND 10000);
    ALTER TABLE settings ADD COLUMN supervisor_pin_required INTEGER NOT NULL DEFAULT 1
      CHECK (supervisor_pin_required IN (0, 1));
    ALTER TABLE settings ADD COLUMN supervisor_pin_length INTEGER NOT NULL DEFAULT 4
      CHECK (typeof(supervisor_pin_length) = 'integer' AND supervisor_pin_length BETWEEN 4 AND 8);
    ALTER TABLE settings ADD COLUMN scale_enabled INTEGER NOT NULL DEFAULT 0
      CHECK (scale_enabled IN (0, 1));
    ALTER TABLE settings ADD COLUMN scale_port TEXT NOT NULL DEFAULT '';

    ALTER TABLE sales ADD COLUMN show_powered_by_snapshot INTEGER NOT NULL DEFAULT 1
      CHECK (show_powered_by_snapshot IN (0, 1));

    CREATE TABLE backup_log (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('AUTOMATIC', 'MANUAL', 'RESTORE')),
      file_name TEXT NOT NULL,
      location TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (typeof(size_bytes) = 'integer' AND size_bytes >= 0),
      currency_code TEXT NOT NULL DEFAULT '',
      app_version TEXT NOT NULL DEFAULT '',
      checksum_sha256 TEXT NOT NULL DEFAULT '',
      actor TEXT NOT NULL DEFAULT 'SYSTEM',
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_backup_log_created ON backup_log(created_at DESC);
  `)
}
