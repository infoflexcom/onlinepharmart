import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { migrateDatabase } from './migrate'

export { migrateDatabase, MIGRATION_TABLE } from './migrate'
export { MIGRATIONS } from './migrations'

/** Open the one authoritative shop database in the desktop app's user-data folder. */
export function openShopDatabase(databasePath: string): Database.Database {
  mkdirSync(dirname(databasePath), { recursive: true })
  const database = new Database(databasePath)
  try {
    database.pragma('journal_mode = WAL')
    database.pragma('foreign_keys = ON')
    database.pragma('busy_timeout = 5000')
    migrateDatabase(database)
    return database
  } catch (error) {
    database.close()
    throw error
  }
}
