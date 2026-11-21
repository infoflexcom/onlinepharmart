import type Database from 'better-sqlite3'
import { MIGRATIONS } from './migrations'

export const MIGRATION_TABLE = 'schema_migrations'

/** Apply each schema migration once, atomically, and in version order. */
export function migrateDatabase(database: Database.Database): void {
  database.pragma('foreign_keys = ON')
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
    const apply = database.transaction(() => {
      migration.up(database)
      recordMigration.run(migration.version, migration.name)
    })
    apply.immediate()
  }
}
