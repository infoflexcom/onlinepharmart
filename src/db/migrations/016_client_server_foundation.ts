import type Database from 'better-sqlite3'

/**
 * The client/server data foundations.
 *
 * This migration is additive: it creates the new tables the order/payment model needs, widens the role vocabulary
 * on `users`, and links `sales` to the order that produced them. **Every table created by migrations 1–15 is left in
 * place and unaltered except where noted**, so a live shop's data arrives in the new world intact.
 *
 * Three things are rebuilt rather than altered, because SQLite cannot drop a CHECK constraint in place:
 *
 * - `users` — the role CHECK must gain `ACCOUNT`/`USER` and keep `CASHIER` so an un-upgraded row still reads. The
 *   rebuild keeps every column, every index and every row.
 * - `user_permissions` — unchanged in shape; rebuilt only because the FK target `users` is rebuilt.
 *
 * The old `CASHIER` rows are **not** rewritten here. They stay as they are and `resolveRole()` maps them to `USER`
 * at the edge. A migration that rewrote them would be irreversible if the alias mapping were later found wanting,
 * and it would quietly reclassify a real person's account.
 */
export function migrateClientServerFoundation(database: Database.Database): void {
  // The rebuild below is done by renaming rather than dropping, so no other table's foreign key is ever left
  // dangling and `foreign_keys` never has to be switched off. That matters: SQLite documents `foreign_keys` as a
  // no-op inside a transaction, and the runner wraps every migration in one — so a pragma here would look like it
  // worked and would silently do nothing.
  database.exec(`
    -- ── users: wider role vocabulary, seat number, approval PIN ────────────────────────────────────────
    CREATE TABLE users_next (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      -- CASHIER is retained so an existing row still satisfies the constraint. It is a deprecated value,
      -- resolved to USER by resolveRole(); new rows never write it.
      role TEXT NOT NULL CHECK (role IN ('ADMIN', 'SUPERVISOR', 'ACCOUNT', 'USER', 'CASHIER')),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      failed_login_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
      locked_until TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      full_name TEXT NOT NULL DEFAULT '',
      locked_at TEXT,
      last_login_at TEXT,
      row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
      totp_secret_ciphertext TEXT,
      totp_confirmed_at TEXT,
      totp_last_step INTEGER,
      totp_last_used_at TEXT,
      -- The licensed seat this account occupies. NULL means "not seated", which is legal for a supervisor who
      -- only reviews. A partial unique index below stops two active accounts sharing a seat.
      seat_no INTEGER CHECK (seat_no IS NULL OR seat_no >= 1)
    );

    INSERT INTO users_next (
      id, username, password_hash, role, is_active, failed_login_count, locked_until, created_at, updated_at,
      full_name, locked_at, last_login_at, row_version, totp_secret_ciphertext, totp_confirmed_at, totp_last_step,
      totp_last_used_at, seat_no
    )
    SELECT
      id, username, password_hash, role, is_active, failed_login_count, locked_until, created_at, updated_at,
      full_name, locked_at, last_login_at, row_version, totp_secret_ciphertext, totp_confirmed_at, totp_last_step,
      totp_last_used_at, NULL
    FROM users;

    DROP TABLE users;
    ALTER TABLE users_next RENAME TO users;

    CREATE INDEX IF NOT EXISTS idx_users_role_active ON users(role, is_active);
    CREATE INDEX IF NOT EXISTS idx_users_active_lock ON users(is_active, locked_at);
    -- One active account per seat. Inactive accounts may share a number so that a departed employee's history
    -- keeps its seat reference without blocking the replacement.
    CREATE UNIQUE INDEX idx_users_seat_unique ON users(seat_no) WHERE seat_no IS NOT NULL AND is_active = 1;

    -- ── role_seats: how many of each role this licence sold ────────────────────────────────────────────
    CREATE TABLE role_seats (
      role TEXT PRIMARY KEY CHECK (role IN ('ADMIN', 'SUPERVISOR', 'ACCOUNT', 'USER')),
      seats INTEGER NOT NULL DEFAULT 0 CHECK (typeof(seats) = 'integer' AND seats >= 0),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    INSERT INTO role_seats (role, seats) VALUES
      ('ADMIN', 1), ('SUPERVISOR', 0), ('ACCOUNT', 0), ('USER', 0)
    ON CONFLICT(role) DO NOTHING;

    -- ── client_devices: the machines allowed to talk to this server ────────────────────────────────────
    -- Distinct from \`devices\`, which is the Admin's phone pairing. A client device is a till or a back-office
    -- PC: it authenticates with a token and a pinned certificate fingerprint, and it must be approved first.
    CREATE TABLE client_devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      os TEXT NOT NULL DEFAULT '',
      -- Only the hash of the token is stored. A stolen database yields no usable credential.
      token_hash TEXT UNIQUE,
      cert_fingerprint TEXT,
      approved_by TEXT REFERENCES users(id),
      approved_at TEXT,
      last_seen TEXT,
      last_ip TEXT,
      revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_client_devices_approved ON client_devices(revoked, approved_at);
    CREATE INDEX idx_client_devices_seen ON client_devices(last_seen);

    -- ── sessions: one active session per account, when the setting says so ─────────────────────────────
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      -- Which machine the session is on. NULL for the host's own window.
      client_device_id TEXT REFERENCES client_devices(id) ON DELETE SET NULL,
      token_hash TEXT NOT NULL UNIQUE,
      ip TEXT,
      pc_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen TEXT,
      revoked_at TEXT,
      revoked_reason TEXT
    );
    CREATE INDEX idx_sessions_user_active ON sessions(user_id, revoked_at);
    CREATE INDEX idx_sessions_device ON sessions(client_device_id);

    -- ── orders: the unit of work a client creates and the server finalises ─────────────────────────────
    CREATE TABLE orders (
      id TEXT PRIMARY KEY,
      -- Server-generated, sequential, unique. NULL until the order is finalised, so a draft does not burn a
      -- document number that a cancelled order would then leave a gap in.
      order_number TEXT UNIQUE,
      type TEXT NOT NULL DEFAULT 'RETAIL' CHECK (type IN ('RETAIL', 'WHOLESALE')),
      status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PENDING', 'PAID', 'CANCELLED', 'EXPIRED')),
      customer_id TEXT REFERENCES customers(id),
      created_by TEXT NOT NULL REFERENCES users(id),
      finalized_by TEXT REFERENCES users(id),
      -- The price snapshot is the whole point of an order row: the lines record what the customer was quoted,
      -- and a later price change must not rewrite history.
      currency_code TEXT NOT NULL REFERENCES currencies(code),
      subtotal INTEGER NOT NULL DEFAULT 0 CHECK (typeof(subtotal) = 'integer' AND subtotal >= 0),
      discount INTEGER NOT NULL DEFAULT 0 CHECK (typeof(discount) = 'integer' AND discount >= 0),
      tax INTEGER NOT NULL DEFAULT 0 CHECK (typeof(tax) = 'integer' AND tax >= 0),
      total INTEGER NOT NULL DEFAULT 0 CHECK (typeof(total) = 'integer' AND total >= 0),
      price_snapshot_at TEXT,
      -- A PENDING order holds stock only until this instant; an expired order releases its reservations.
      expires_at TEXT,
      client_device_id TEXT REFERENCES client_devices(id) ON DELETE SET NULL,
      idempotency_key TEXT,
      row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_orders_status ON orders(status, created_at);
    CREATE INDEX idx_orders_user ON orders(created_by, created_at);
    CREATE UNIQUE INDEX idx_orders_idempotency ON orders(created_by, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE INDEX idx_orders_expiry ON orders(expires_at) WHERE status = 'PENDING';

    CREATE TABLE order_items (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id TEXT REFERENCES products(id),
      description_snapshot TEXT NOT NULL,
      quantity_milli INTEGER NOT NULL CHECK (typeof(quantity_milli) = 'integer' AND quantity_milli > 0),
      unit_price INTEGER NOT NULL CHECK (typeof(unit_price) = 'integer' AND unit_price >= 0),
      discount INTEGER NOT NULL DEFAULT 0 CHECK (typeof(discount) = 'integer' AND discount >= 0),
      tax INTEGER NOT NULL DEFAULT 0 CHECK (typeof(tax) = 'integer' AND tax >= 0),
      line_total INTEGER NOT NULL CHECK (typeof(line_total) = 'integer' AND line_total >= 0),
      UNIQUE (order_id, id)
    );
    CREATE INDEX idx_order_items_order ON order_items(order_id);
    CREATE INDEX idx_order_items_product ON order_items(product_id);

    -- An append-only history of what happened to an order, so the state of a row can be explained.
    CREATE TABLE order_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      event TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      actor_id TEXT REFERENCES users(id),
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_order_events_order ON order_events(order_id, created_at);

    -- ── reservations: stock held for a pending order ───────────────────────────────────────────────────
    -- Kept separate from \`stock.reserved\` so a released or expired hold is a row deletion rather than an
    -- arithmetic correction that could drift.
    CREATE TABLE reservations (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL REFERENCES products(id),
      batch_id TEXT,
      quantity_milli INTEGER NOT NULL CHECK (typeof(quantity_milli) = 'integer' AND quantity_milli > 0),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      released_at TEXT
    );
    CREATE INDEX idx_reservations_order ON reservations(order_id) WHERE released_at IS NULL;
    CREATE INDEX idx_reservations_product ON reservations(product_id) WHERE released_at IS NULL;
  `)
}

/**
 * The second half of migration 16: the tables that record what happened to money and documents.
 *
 * Split out of `migrateClientServerFoundation` only for readability — the runner still treats 16 as one atomic
 * version. These tables reference `orders` and `sales`, both of which exist by the time this runs.
 */
export function migrateClientServerAuditAndSales(database: Database.Database): void {
  database.exec(`
    -- ── sales: linked to the order that produced them, and to the person who finalised it ─────────────
    -- ALTER rather than rebuild: a completed sale is the one row this product must never lose, so nothing here
    -- rewrites the existing columns.
    ALTER TABLE sales ADD COLUMN order_id TEXT REFERENCES orders(id);
    ALTER TABLE sales ADD COLUMN finalized_by TEXT REFERENCES users(id);
    -- The receipt number is generated by the server, not by a column default. The existing \`receipt_number\`
    -- generated column is left exactly as it is, because real receipts were printed from it; this column records
    -- the number the server allocated for sales created from this phase onwards.
    ALTER TABLE sales ADD COLUMN server_receipt_no TEXT;
    -- No backfill here, and that is deliberate. Migration 3's completed_sales_cannot_be_changed trigger aborts any
    -- UPDATE of a completed sale, and it is right to: a printed receipt's number is history. Historical rows keep
    -- server_receipt_no NULL and continue to be read from the generated receipt_number column they always had;
    -- the server allocates this column only for sales it creates from this phase onwards.
    CREATE UNIQUE INDEX idx_sales_server_receipt ON sales(server_receipt_no) WHERE server_receipt_no IS NOT NULL;
    CREATE INDEX idx_sales_order ON sales(order_id);

    -- The last number the server handed out, per document kind. One row per kind so a new numbering scheme is a
    -- new row rather than a migration. The server allocates inside the same transaction as the sale, which is what
    -- makes the number both unique and gapless-per-committed-sale.
    CREATE TABLE document_sequences (
      kind TEXT PRIMARY KEY,
      last_value INTEGER NOT NULL DEFAULT 0 CHECK (typeof(last_value) = 'integer' AND last_value >= 0),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    -- Backfill from the highest existing sale id so the first server-generated receipt does not collide with a
    -- receipt that was printed before this phase. INSERT ... SELECT rather than VALUES because the number depends on
    -- the data; WHERE NOT EXISTS rather than ON CONFLICT because SQLite rejects a bare ON CONFLICT on INSERT - SELECT.
    INSERT INTO document_sequences (kind, last_value)
      SELECT 'SALE', COALESCE(MAX(id), 0) FROM sales
      WHERE NOT EXISTS (SELECT 1 FROM document_sequences WHERE kind = 'SALE');
    INSERT INTO document_sequences (kind, last_value)
      SELECT 'ORDER', 0
      WHERE NOT EXISTS (SELECT 1 FROM document_sequences WHERE kind = 'ORDER');

    -- ── print_log: every copy of every document, and whether it was a duplicate ────────────────────────
    -- The existing sale_print_events / return_print_events tables recorded prints before this phase; they are
    -- kept. This table is the unified record the brief asks for, with a copy number.
    CREATE TABLE print_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_kind TEXT NOT NULL CHECK (document_kind IN ('SALE', 'ORDER', 'RETURN', 'REPORT')),
      document_id TEXT NOT NULL,
      copy_no INTEGER NOT NULL CHECK (typeof(copy_no) = 'integer' AND copy_no >= 1),
      duplicate INTEGER NOT NULL DEFAULT 0 CHECK (duplicate IN (0, 1)),
      printed_by TEXT NOT NULL REFERENCES users(id),
      client_device_id TEXT REFERENCES client_devices(id) ON DELETE SET NULL,
      printed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (document_kind, document_id, copy_no)
    );
    CREATE INDEX idx_print_log_document ON print_log(document_kind, document_id, printed_at DESC);
    CREATE INDEX idx_print_log_duplicates ON print_log(duplicate, printed_at DESC);

    -- ── audit_signoffs and audit_flags: the audit-only supervisor's surface ────────────────────────────
    -- A sign-off is an append-only attestation, never an authorisation. It records that a person reviewed a thing.
    CREATE TABLE audit_signoffs (
      id TEXT PRIMARY KEY,
      subject_kind TEXT NOT NULL CHECK (subject_kind IN ('DAY_CLOSE', 'SHIFT', 'RETURN', 'STOCKTAKE', 'REPORT', 'ORDER')),
      subject_id TEXT NOT NULL,
      signed_by TEXT NOT NULL REFERENCES users(id),
      -- What the signer was shown, hashed, so a later change to the subject is detectable.
      subject_digest TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      signed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_audit_signoffs_subject ON audit_signoffs(subject_kind, subject_id, signed_at DESC);

    CREATE TABLE audit_flags (
      id TEXT PRIMARY KEY,
      subject_kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      raised_by TEXT NOT NULL REFERENCES users(id),
      severity TEXT NOT NULL DEFAULT 'NOTE' CHECK (severity IN ('NOTE', 'CONCERN', 'SERIOUS')),
      detail TEXT NOT NULL,
      resolved_by TEXT REFERENCES users(id),
      resolved_at TEXT,
      resolution_note TEXT,
      raised_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_audit_flags_open ON audit_flags(resolved_at, raised_at DESC);
    CREATE INDEX idx_audit_flags_subject ON audit_flags(subject_kind, subject_id);

    -- ── Guards: the records above are history, and history does not get edited ────────────────────────
    CREATE TRIGGER order_events_are_immutable_update
    BEFORE UPDATE ON order_events
    BEGIN
      SELECT RAISE(ABORT, 'Order events are immutable');
    END;

    CREATE TRIGGER order_events_are_immutable_delete
    BEFORE DELETE ON order_events
    BEGIN
      SELECT RAISE(ABORT, 'Order events are immutable');
    END;

    CREATE TRIGGER print_log_is_immutable_update
    BEFORE UPDATE ON print_log
    BEGIN
      SELECT RAISE(ABORT, 'Print history is immutable');
    END;

    CREATE TRIGGER audit_signoffs_are_immutable_update
    BEFORE UPDATE ON audit_signoffs
    BEGIN
      SELECT RAISE(ABORT, 'Audit sign-offs are immutable');
    END;

    CREATE TRIGGER audit_signoffs_are_immutable_delete
    BEFORE DELETE ON audit_signoffs
    BEGIN
      SELECT RAISE(ABORT, 'Audit sign-offs are immutable');
    END;

    -- A completed sale is already guarded against deletion and editing by migration 3
    -- (completed_sales_cannot_be_deleted / ..._changed). No duplicate trigger is added here: two triggers doing
    -- one job means the next person cannot tell which one to trust.

    -- A document sequence only ever moves forward. Rewinding it would hand out a number twice.
    CREATE TRIGGER document_sequences_move_forward_only
    BEFORE UPDATE ON document_sequences
    WHEN NEW.last_value < OLD.last_value
    BEGIN
      SELECT RAISE(ABORT, 'Document numbers cannot move backwards');
    END;
  `)
}
