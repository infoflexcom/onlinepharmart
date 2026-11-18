import Database from 'better-sqlite3'

/**
 * The Vendor Cloud's schema. It stores licence and customer-contact metadata and nothing else: there is no
 * table here that could hold a sale, a price, a stock level or a cashier. The privacy test in
 * `cloud/tests/schema.test.ts` enumerates the tables and columns so a future change that added one would fail
 * the build rather than quietly turn the licence server into a place to keep shop data.
 *
 * The schema is a set of idempotent migrations so an existing deployment upgrades in place on restart, which
 * is what makes the "one-click deploy" instructions honest.
 */
export interface Migration {
  id: number
  name: string
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'core licence and vendor tables',
    sql: `
      CREATE TABLE IF NOT EXISTS vendor_users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('OWNER', 'STAFF')),
        password_hash TEXT NOT NULL,
        password_updated_at TEXT NOT NULL,
        totp_secret TEXT NOT NULL,
        totp_confirmed_at TEXT,
        totp_last_step INTEGER,
        failed_logins INTEGER NOT NULL DEFAULT 0,
        locked_until TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        last_login_at TEXT
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        vendor_user_id TEXT NOT NULL REFERENCES vendor_users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        csrf_token TEXT NOT NULL,
        ip_address TEXT,
        user_agent TEXT,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      -- Customer contact details only. No shop data, no amounts, no users, no stock.
      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        business_name TEXT NOT NULL,
        contact_name TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        default_currency TEXT,
        lock_currency INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS licenses (
        id TEXT PRIMARY KEY,
        license_key TEXT NOT NULL UNIQUE,
        customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        edition TEXT NOT NULL CHECK (edition IN ('PHARMACY', 'SUPERMARKET', 'BOTH')),
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'expired', 'revoked')),
        max_admin_phones INTEGER NOT NULL DEFAULT 1,
        mobile_lan INTEGER NOT NULL DEFAULT 1,
        mobile_internet INTEGER NOT NULL DEFAULT 0,
        default_currency TEXT,
        lock_currency INTEGER NOT NULL DEFAULT 0,
        grace_days INTEGER NOT NULL DEFAULT 0,
        machine_id TEXT,
        machine_bound_at TEXT,
        source TEXT NOT NULL DEFAULT 'online' CHECK (source IN ('online', 'file', 'onsite')),
        onsite_reported_at TEXT,
        onsite_owner_machine TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        delivered_revision INTEGER NOT NULL DEFAULT -1,
        last_checkin_at TEXT,
        last_app_version TEXT,
        last_platform TEXT,
        notify_now_at TEXT,
        reminder_stage INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS licenses_customer ON licenses(customer_id);
      CREATE INDEX IF NOT EXISTS licenses_ends ON licenses(ends_at);

      CREATE TABLE IF NOT EXISTS license_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        license_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS license_history_license ON license_history(license_id, created_at);

      CREATE TABLE IF NOT EXISTS checkins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        license_id TEXT NOT NULL,
        machine_id TEXT NOT NULL,
        app_version TEXT NOT NULL DEFAULT '',
        platform TEXT NOT NULL DEFAULT '',
        checked_at TEXT NOT NULL,
        online INTEGER NOT NULL DEFAULT 1,
        ip_address TEXT
      );

      CREATE INDEX IF NOT EXISTS checkins_license ON checkins(license_id, checked_at);

      CREATE TABLE IF NOT EXISTS relay_connections (
        shop_id TEXT PRIMARY KEY,
        license_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('online', 'offline')),
        connected_at TEXT,
        disconnected_at TEXT,
        bytes_in INTEGER NOT NULL DEFAULT 0,
        bytes_out INTEGER NOT NULL DEFAULT 0,
        frames INTEGER NOT NULL DEFAULT 0,
        last_seen_at TEXT,
        peer_address TEXT
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        ip_address TEXT,
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS audit_created ON audit_log(created_at);

      -- Activation attempts are recorded before the key is even looked up, so a flood is visible and
      -- rate limiting has something durable to count.
      CREATE TABLE IF NOT EXISTS activation_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        license_key_hash TEXT NOT NULL,
        ip_address TEXT,
        outcome TEXT NOT NULL,
        machine_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS activation_attempts_key ON activation_attempts(license_key_hash, created_at);
      CREATE INDEX IF NOT EXISTS activation_attempts_ip ON activation_attempts(ip_address, created_at);

      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `,
  },
]

export interface OpenDatabaseOptions {
  migrate?: boolean
}

export function openDatabase(path: string, options: OpenDatabaseOptions = {}): Database.Database {
  const database = new Database(path)
  // Foreign keys and WAL are what make the portal's cascades and the backup routine behave as documented.
  database.pragma('foreign_keys = ON')
  if (path !== ':memory:') database.pragma('journal_mode = WAL')
  database.pragma('synchronous = NORMAL')
  if (options.migrate !== false) migrateCloudDatabase(database)
  return database
}

export function migrateCloudDatabase(database: Database.Database): number {
  database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)')
  const applied = new Set((database.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: number }>).map((row) => row.id))
  let highest = 0
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) {
      highest = Math.max(highest, migration.id)
      continue
    }
    database.transaction(() => {
      database.exec(migration.sql)
      database.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.id, migration.name, new Date().toISOString())
    })()
    highest = migration.id
  }
  return highest
}

/** Every table and column the cloud is allowed to have. The privacy test asserts this exactly. */
export const ALLOWED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  vendor_users: ['id', 'email', 'display_name', 'role', 'password_hash', 'password_updated_at', 'totp_secret', 'totp_confirmed_at', 'totp_last_step', 'failed_logins', 'locked_until', 'is_active', 'created_at', 'last_login_at'],
  sessions: ['id', 'vendor_user_id', 'token_hash', 'csrf_token', 'ip_address', 'user_agent', 'created_at', 'last_seen_at', 'expires_at'],
  customers: ['id', 'business_name', 'contact_name', 'phone', 'email', 'notes', 'default_currency', 'lock_currency', 'created_at', 'updated_at'],
  licenses: ['id', 'license_key', 'customer_id', 'edition', 'starts_at', 'ends_at', 'status', 'max_admin_phones', 'mobile_lan', 'mobile_internet', 'default_currency', 'lock_currency', 'grace_days', 'machine_id', 'machine_bound_at', 'source', 'onsite_reported_at', 'onsite_owner_machine', 'revision', 'delivered_revision', 'last_checkin_at', 'last_app_version', 'last_platform', 'notify_now_at', 'reminder_stage', 'created_at', 'updated_at'],
  license_history: ['id', 'license_id', 'actor', 'action', 'detail_json', 'created_at'],
  checkins: ['id', 'license_id', 'machine_id', 'app_version', 'platform', 'checked_at', 'online', 'ip_address'],
  relay_connections: ['shop_id', 'license_id', 'status', 'connected_at', 'disconnected_at', 'bytes_in', 'bytes_out', 'frames', 'last_seen_at', 'peer_address'],
  audit_log: ['id', 'actor', 'action', 'target', 'ip_address', 'detail_json', 'created_at'],
  activation_attempts: ['id', 'license_key_hash', 'ip_address', 'outcome', 'machine_id', 'created_at'],
  schema_migrations: ['id', 'name', 'applied_at'],
}
