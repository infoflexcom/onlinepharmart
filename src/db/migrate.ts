import type Database from 'better-sqlite3'
import { MIGRATIONS } from './migrations'

export const MIGRATION_TABLE = 'schema_migrations'

/**
 * Apply each schema migration once, atomically, and in version order.
 *
 * ## Why foreign keys are switched off around the transaction, not inside it
 *
 * A migration that rebuilds a table (create, copy, drop, rename) has to pause foreign-key enforcement, because the
 * intermediate state genuinely has a missing parent. The obvious place to put `PRAGMA foreign_keys = OFF` is at the
 * top of the `up()` function — and it does nothing there. SQLite documents the pragma as **a no-op within a
 * transaction**, and this runner wraps every migration in one, so a pragma inside `up()` is silently ignored. That
 * is exactly the class of defect this project keeps finding: code that runs, produces a plausible result, and is
 * not doing what it says.
 *
 * So the pause happens here, outside the transaction, and it is **per migration**: `setsForeignKeysOff` is declared
 * by the migration that needs it, and enforcement is restored — and verified — immediately afterwards. A migration
 * that does not declare it runs with foreign keys exactly as before, so a mistake in one migration cannot weaken
 * the others.
 *
 * The integrity check after a rebuild is not decoration either. `PRAGMA foreign_key_check` run *before* enforcement
 * is restored is what catches a rebuild that dropped a parent row and left a child pointing at nothing.
 */
export function migrateDatabase(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)

  const appliedVersions = new Set(
    (database.prepare(`SELECT version FROM ${MIGRATION_TABLE}`).all() as Array<{ version: number }>).map(({ version }) => version),
  )
  const recordMigration = database.prepare(`INSERT INTO ${MIGRATION_TABLE} (version, name) VALUES (?, ?)`)
  for (const migration of MIGRATIONS) {
    if (appliedVersions.has(migration.version)) continue
    if (migration.setsForeignKeysOff) {
      applyWithForeignKeysPaused(database, migration, recordMigration)
      continue
    }
    database.pragma('foreign_keys = ON')
    const apply = database.transaction(() => {
      migration.up(database)
      recordMigration.run(migration.version, migration.name)
    })
    apply.immediate()
  }
  // Whatever the last migration did, the connection leaves this function enforcing foreign keys.
  database.pragma('foreign_keys = ON')
}

function applyWithForeignKeysPaused(
  database: Database.Database,
  migration: (typeof MIGRATIONS)[number],
  record: { run: (version: number, name: string) => unknown },
): void {
  database.pragma('foreign_keys = OFF')
  try {
    const apply = database.transaction(() => {
      migration.up(database)
      record.run(migration.version, migration.name)
    })
    apply.immediate()
    // With enforcement still paused, prove the rebuild left no orphan behind. A violation here is a broken
    // migration, and committing enforcement back on would only surface it on the next write, far from the cause.
    const violations = database.pragma('foreign_key_check') as unknown[]
    if (Array.isArray(violations) && violations.length > 0) {
      throw new Error(
        `Migration ${migration.version} (${migration.name}) left ${violations.length} foreign-key violation(s): ${JSON.stringify(violations.slice(0, 5))}`,
      )
    }
  } finally {
    database.pragma('foreign_keys = ON')
  }
}
