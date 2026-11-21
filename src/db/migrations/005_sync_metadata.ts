import type Database from 'better-sqlite3'

/** Local synchronization checkpoints and operation receipts only; no replicated shop payloads. */
export function migrateSyncMetadata(db: Database.Database): void {
  db.exec(`
    CREATE TABLE sync_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_cursor TEXT,
      last_successful_sync_at TEXT,
      status TEXT NOT NULL DEFAULT 'IDLE' CHECK (status IN ('IDLE', 'RUNNING', 'ERROR')),
      row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO sync_state (id) VALUES (1);

    CREATE TABLE sync_operations (
      id TEXT PRIMARY KEY,
      device_id TEXT REFERENCES devices(id),
      idempotency_key TEXT NOT NULL UNIQUE REFERENCES idempotency_keys(key),
      operation_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED', 'APPLIED', 'REJECTED')),
      request_hash TEXT NOT NULL,
      response_hash TEXT,
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    );

    CREATE INDEX idx_sync_operations_device_received ON sync_operations(device_id, received_at);
  `)
}
