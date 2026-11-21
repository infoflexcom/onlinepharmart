import type Database from 'better-sqlite3'

/** Binds rotating refresh credentials to paired devices and expires short-lived access credentials. */
export function migrateMobileSessions(database: Database.Database): void {
  database.exec(`
    ALTER TABLE devices ADD COLUMN access_token_expires_at TEXT;
    ALTER TABLE refresh_tokens ADD COLUMN device_id TEXT REFERENCES devices(id);
    CREATE INDEX idx_devices_admin_active ON devices(admin_user_id, revoked, created_at);
    CREATE INDEX idx_refresh_tokens_device_active ON refresh_tokens(device_id, revoked_at, expires_at);
  `)
}
