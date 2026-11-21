import type Database from 'better-sqlite3'

/** Identity fields and safe first-run hints. Password hashes use bcrypt's embedded salts. */
export function migrateAuthentication(db: Database.Database): void {
  db.exec(`
    ALTER TABLE users ADD COLUMN full_name TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN locked_at TEXT;
    ALTER TABLE users ADD COLUMN last_login_at TEXT;
    ALTER TABLE users ADD COLUMN row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0);

    ALTER TABLE settings ADD COLUMN installer_currency_code TEXT REFERENCES currencies(code);
    ALTER TABLE settings ADD COLUMN idle_timeout_minutes INTEGER NOT NULL DEFAULT 15
      CHECK (idle_timeout_minutes BETWEEN 1 AND 240);

    ALTER TABLE user_permissions ADD COLUMN row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0);

    CREATE INDEX idx_users_active_lock ON users(is_active, locked_at);
  `)
}
