import {
  closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, statSync, unlinkSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import type Database from 'better-sqlite3'

/**
 * Automatic database backups.
 *
 * The portal's whole value is the licence table: if the SQLite file is lost, every customer's licence key,
 * term and machine binding is lost with it, and the vendor has to re-issue hundreds of licences by hand. So a
 * backup runs on a timer without anyone remembering to press a button.
 *
 * The copy is made with `VACUUM INTO`, which writes a consistent single-file snapshot even while the server is
 * running (a plain `cp` of a WAL database can miss the write-ahead log and produce a corrupt file). Each
 * snapshot is named with its UTC timestamp, and the oldest are pruned to the configured keep count.
 *
 * A backup that cannot be written is logged and retried on the next tick; it never stops the server, because
 * refusing to serve licences would be worse than one missed snapshot.
 */
export interface BackupOptions {
  database: Database.Database
  directory: string
  keep: number
  /** How often to take a snapshot. Daily is the default; tests pass a short interval. */
  intervalMs?: number
  now?: () => number
  log?: (message: string) => void
}

export interface BackupResult {
  path: string
  bytes: number
  takenAt: string
}

const FILE_PATTERN = /^infoflex-cloud-\d{8}T\d{6}Z\.sqlite$/u

export function takeBackup(options: BackupOptions): BackupResult {
  const now = (options.now ?? Date.now)()
  const stamp = new Date(now).toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')
  mkdirSync(options.directory, { recursive: true })
  const target = join(options.directory, `infoflex-cloud-${stamp}.sqlite`)
  // VACUUM INTO refuses to overwrite, which is a useful guard against two backups in the same second.
  if (existsSync(target)) unlinkSync(target)
  options.database.prepare('VACUUM INTO ?').run(target)
  const handle = openSync(target, 'r+')
  try {
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  const bytes = readFileSync(target).byteLength
  pruneBackups(options.directory, options.keep)
  return { path: target, bytes, takenAt: new Date(now).toISOString() }
}

/** Keeps the newest `keep` snapshots. Anything not matching our own filename pattern is left alone. */
export function pruneBackups(directory: string, keep: number): string[] {
  if (!existsSync(directory)) return []
  const files = readdirSync(directory).filter((name) => FILE_PATTERN.test(name)).sort()
  const excess = files.slice(0, Math.max(0, files.length - keep))
  for (const name of excess) {
    try {
      unlinkSync(join(directory, name))
    } catch {
      // A snapshot that cannot be deleted is harmless; it just delays the next prune.
    }
  }
  return excess
}

export function listBackups(directory: string): Array<{ name: string; bytes: number; takenAt: string }> {
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .filter((name) => FILE_PATTERN.test(name))
    .sort()
    .reverse()
    .map((name) => {
      const path = join(directory, name)
      // 20260601T030405Z → 2026-06-01T03:04:05Z, so the portal can show a readable time.
      const stamp = name.slice('infoflex-cloud-'.length, -'.sqlite'.length)
      const takenAt = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`
      return { name, bytes: statSize(path), takenAt }
    })
}

/**
 * Starts the daily snapshot timer. Returns a stop function so tests (and a graceful shutdown) can clear it.
 */
export function scheduleBackups(options: BackupOptions): () => void {
  const log = options.log ?? ((message: string) => process.stdout.write(`${message}\n`))
  const interval = options.intervalMs ?? 24 * 60 * 60 * 1_000
  const run = () => {
    try {
      const result = takeBackup(options)
      log(`[backup] ${result.path} (${Math.round(result.bytes / 1024)} KB)`)
    } catch (error) {
      log(`[backup] failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // One snapshot at start-up means a fresh install has a restore point before the first licence is sold.
  run()
  const timer = setInterval(run, interval)
  timer.unref()
  return () => clearInterval(timer)
}

/**
 * Restores a snapshot next to the live database and refuses to touch a running server's file: the caller stops
 * the service, drops the snapshot in place, and starts it again. The copy is verified to be a SQLite file first.
 */
export function restoreBackup(input: { backupPath: string; databasePath: string }): { restored: string; previous: string | null } {
  if (!existsSync(input.backupPath)) throw new Error('That snapshot does not exist.')
  const header = Buffer.alloc(16)
  const handle = openSync(input.backupPath, 'r')
  try {
    if (readSync(handle, header, 0, header.length, 0) < 15) throw new Error('That snapshot is too short to be a database.')
  } finally {
    closeSync(handle)
  }
  if (header.toString('utf8', 0, 15) !== 'SQLite format 3') {
    throw new Error('That file is not an Infoflex Cloud database snapshot.')
  }
  const target = resolve(input.databasePath)
  let previous: string | null = null
  if (existsSync(target)) {
    previous = `${target}.before-restore-${Date.now()}`
    copyFileSync(target, previous)
  }
  copyFileSync(input.backupPath, target)
  // A stale WAL beside a restored file would replay unrelated pages into it.
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${target}${suffix}`
    if (existsSync(sidecar)) unlinkSync(sidecar)
  }
  return { restored: target, previous }
}

function statSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}
