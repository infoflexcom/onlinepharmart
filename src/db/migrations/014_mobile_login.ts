import type Database from 'better-sqlite3'

/**
 * Adds Authenticator (TOTP) enrolment for the two-factor phone login, device approval for the PC pop-up,
 * and the "keep running" preferences.
 *
 * `devices` is rebuilt rather than altered: a device that is waiting for approval has no access token, so
 * `token_hash` must become nullable. SQLite cannot drop a NOT NULL constraint in place, so this follows the
 * documented rebuild procedure (create, copy, drop, rename) inside the migration transaction. Existing
 * pairs keep their token hashes and become approved, so a shop upgrading does not have to re-pair.
 */
export function migrateMobileLogin(database: Database.Database): void {
  // `refresh_tokens.device_id` references `devices`, so the documented rebuild needs the FK checks paused
  // for the duration. The migration runner wraps this in a transaction, which restores them on commit.
  database.pragma('foreign_keys = OFF')
  database.exec(`
    ALTER TABLE users ADD COLUMN totp_secret_ciphertext TEXT;
    ALTER TABLE users ADD COLUMN totp_confirmed_at TEXT;
    ALTER TABLE users ADD COLUMN totp_last_step INTEGER;
    ALTER TABLE users ADD COLUMN totp_last_used_at TEXT;

    CREATE TABLE devices_next (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      platform TEXT NOT NULL,
      -- NULL while the device waits for the Admin to approve it on the PC.
      token_hash TEXT UNIQUE,
      -- The secret the phone holds from pairing; approval activates it as the login device token.
      device_token_hash TEXT UNIQUE,
      request_token_hash TEXT UNIQUE,
      admin_user_id TEXT NOT NULL REFERENCES users(id),
      approved_by TEXT REFERENCES users(id),
      approved_at TEXT,
      last_seen TEXT,
      last_ip TEXT,
      first_ip TEXT,
      login_failure_count INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      access_token_expires_at TEXT
    );

    INSERT INTO devices_next (
      id, name, platform, token_hash, device_token_hash, request_token_hash, admin_user_id, approved_by,
      approved_at, last_seen, last_ip, first_ip, login_failure_count, locked_until, revoked, created_at,
      access_token_expires_at
    )
    SELECT id, name, platform, token_hash, token_hash, NULL, admin_user_id, approved_by,
      COALESCE(approved_at, created_at), last_seen, last_ip, last_ip, 0, NULL, revoked, created_at,
      access_token_expires_at
    FROM devices;

    DROP TABLE devices;
    ALTER TABLE devices_next RENAME TO devices;

    CREATE INDEX idx_devices_admin_active ON devices(admin_user_id, revoked, created_at);
    CREATE INDEX idx_devices_last_seen ON devices(last_seen DESC);

    ALTER TABLE settings ADD COLUMN keep_running INTEGER NOT NULL DEFAULT 1
      CHECK (keep_running IN (0, 1));
    ALTER TABLE settings ADD COLUMN prevent_sleep INTEGER NOT NULL DEFAULT 1
      CHECK (prevent_sleep IN (0, 1));
    ALTER TABLE settings ADD COLUMN start_with_windows INTEGER NOT NULL DEFAULT 1
      CHECK (start_with_windows IN (0, 1));

    -- The vendor's relay, learned from the licence server's own configuration. Both are nullable because most
    -- shops never use the internet relay, and nothing is guessed: an empty domain means "no relay".
    ALTER TABLE license_vendor_config ADD COLUMN relay_url TEXT;
    ALTER TABLE license_vendor_config ADD COLUMN relay_shared_secret TEXT;
  `)
  database.pragma('foreign_keys = ON')
  const violations = database.prepare('PRAGMA foreign_key_check').all()
  if (violations.length > 0) throw new Error('The mobile device table rebuild left invalid references; the upgrade was cancelled.')
}
