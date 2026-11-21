import type Database from 'better-sqlite3'

/** Adds host-owned activation history, integrity metadata, and vendor policy storage. */
export function migrateLicenseSystem(db: Database.Database): void {
  db.exec(`
    ALTER TABLE license_state ADD COLUMN is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1));
    ALTER TABLE license_state ADD COLUMN features_json TEXT NOT NULL DEFAULT '{"mobileLan":false,"mobileInternet":false}';
    ALTER TABLE license_state ADD COLUMN admin_phone_limit INTEGER NOT NULL DEFAULT 1
      CHECK (admin_phone_limit BETWEEN 1 AND 100);
    ALTER TABLE license_state ADD COLUMN grace_days INTEGER NOT NULL DEFAULT 0 CHECK (grace_days BETWEEN 0 AND 30);

    CREATE UNIQUE INDEX idx_license_state_single_current ON license_state(is_current) WHERE is_current = 1;

    CREATE TABLE license_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      license_id TEXT,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      machine_id TEXT,
      source TEXT CHECK (source IS NULL OR source IN ('online', 'file', 'onsite')),
      claims_json TEXT NOT NULL DEFAULT '{}',
      token TEXT,
      detail_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX idx_license_history_license_time ON license_history(license_id, occurred_at);

    CREATE TABLE license_runtime (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      current_license_id TEXT,
      last_trusted_time TEXT,
      integrity_tag TEXT
    );
    INSERT INTO license_runtime (id) VALUES (1);

    CREATE TABLE license_vendor_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      master_password_hash TEXT,
      maximum_onsite_period_years INTEGER
        CHECK (maximum_onsite_period_years IS NULL OR maximum_onsite_period_years BETWEEN 1 AND 50),
      trusted_ed25519_keys_json TEXT NOT NULL DEFAULT '{}',
      license_server_url TEXT,
      policy_integrity_tag TEXT,
      password_failures INTEGER NOT NULL DEFAULT 0 CHECK (password_failures >= 0),
      password_blocked_until INTEGER,
      key_failures INTEGER NOT NULL DEFAULT 0 CHECK (key_failures >= 0),
      key_blocked_until INTEGER,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO license_vendor_config (id) VALUES (1);
  `)

  // The legacy schema allowed several historical rows; make the most recent one the current row.
  const legacy = db.prepare(`SELECT license_id FROM license_state ORDER BY rowid DESC LIMIT 1`).get() as { license_id: string } | undefined
  if (legacy) db.prepare('UPDATE license_state SET is_current = 1 WHERE license_id = ?').run(legacy.license_id)
}
