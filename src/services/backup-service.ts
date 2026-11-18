import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { openShopDatabase } from '../db'
import type { BackupManifest, BackupStatus, BackupSummary, RestoreResult } from '../shared/shop/types'
import { DEFAULT_OPERATIONAL_SETTINGS } from '../shared/shop/types'
import type { ShopRepository } from './contracts/shop-repository'

const BACKUP_PREFIX = 'infoflex-backup-'
const BACKUP_EXTENSION = '.infoflexbackup'
const MANIFEST_SUFFIX = '.manifest.json'
const DAY_MS = 86_400_000
const STALE_AFTER_DAYS = 7
const MAX_RECENT = 20
const MAX_RESTORE_BYTES = 4 * 1024 * 1024 * 1024

/** Tables that never travel inside a restore: licence state, paired devices, and live credentials. */
export const RESTORE_PROTECTED_TABLES = [
  'license_state',
  'license_history',
  'license_runtime',
  'license_vendor_config',
  'devices',
  'refresh_tokens',
] as const

/**
 * Tables whose contents are carried over from the running install instead of the backup: the licence
 * guards above plus the rolling audit/backup journals, so a restore can never erase the evidence of
 * itself or quietly re-enable an access decision the operator has since revoked.
 */
const RESTORE_LIVE_TABLES = new Set<string>([...RESTORE_PROTECTED_TABLES, 'backup_log'])

/** Rows written after the backup was taken would be lost; the restore refuses rather than surprise. */
const RESTORE_BLOCKING_TABLES = ['sales', 'payments', 'returns', 'purchases'] as const

/** Rows that make the shop's stored amounts real; used for the "currency already in use" test. */
const TRANSACTION_TABLES = ['sales', 'payments', 'purchases', 'returns', 'business_entries'] as const

export interface BackupServiceOptions {
  /** Absolute path of the live shop database. */
  databasePath: string
  /** Folder the automatic daily backup is written to. */
  automaticFolder: string
  appVersion: string
  productName?: string
  now?: () => Date
  newId?: () => string
  /**
   * Reopens the shop repository on the restored file and returns it. A restore replaces the file under
   * every open connection, so the host must hand back a fresh repository; without it a restore is
   * refused rather than half-applied.
   */
  reopen?: () => ShopRepository
}

interface RestoreRequest {
  folder: string
  fileName: string
  actor: string
  confirmed: boolean
}

/**
 * Local, file-based backup and restore. Everything is a full SQLite snapshot plus a JSON manifest; the
 * customer never runs a command, only presses buttons. A restore swaps data in place while preserving
 * the licence guards, the paired-device list, and the audit/backup journals.
 */
export class BackupService {
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly productName: string

  constructor(
    private repository: ShopRepository,
    private readonly options: BackupServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date())
    this.newId = options.newId ?? randomUUID
    this.productName = options.productName ?? 'Infoflex'
  }

  status(): BackupStatus {
    const recent = this.repository.readBackupLog(MAX_RECENT)
    return this.buildStatus(recent)
  }

  /** Runs at most one automatic backup per calendar day; returns null when today's already exists. */
  runAutomaticBackup(actor = 'SYSTEM'): BackupSummary | null {
    const today = this.localDateKey(this.now())
    const doneToday = this.repository.readBackupLog(MAX_RECENT)
      .some((entry) => entry.kind === 'AUTOMATIC' && this.localDateKey(new Date(entry.createdAt)) === today)
    if (doneToday) return null
    return this.createBackup(this.options.automaticFolder, 'AUTOMATIC', actor)
  }

  /** Manual backup into a folder the operator picked (a USB stick, a shared folder, or the default). */
  createManualBackup(folder: string, actor: string): BackupSummary {
    return this.createBackup(this.resolveFolder(folder), 'MANUAL', actor)
  }

  /**
   * Restores a backup into the live database.
   *
   * Guards, in order: Admin confirmation, a manifest that matches its own checksum, a currency that
   * either matches the shop or can still be adopted (no transactions yet), and no rows written since
   * the backup was taken (those would be silently destroyed).
   */
  restore(input: RestoreRequest): RestoreResult {
    const reopen = this.options.reopen
    if (!reopen) throw new Error('Restoring is only available in the desktop app.')
    if (!input.confirmed) throw new Error('Confirm that you want to replace the shop data before restoring.')
    const folder = this.resolveFolder(input.folder)
    const fileName = this.safeFileName(input.fileName)
    const backupPath = join(folder, fileName)
    const manifestPath = join(folder, `${fileName}${MANIFEST_SUFFIX}`)

    const manifest = this.readManifest(manifestPath)
    if (!existsSync(backupPath)) throw new Error('The selected backup file is missing from that folder.')
    const size = statSync(backupPath).size
    if (size > MAX_RESTORE_BYTES) throw new Error('That backup file is larger than this app can restore.')
    const checksum = sha256File(backupPath)
    if (checksum !== manifest.databaseSha256) {
      throw new Error('This backup file is damaged: its contents do not match its manifest. Nothing was restored.')
    }

    const current = this.repository.readSettings()
    const transactionsExist = this.hasTransactions(this.options.databasePath)
    const adoptCurrency = manifest.currencyCode !== current.currency.code
    if (adoptCurrency && transactionsExist) {
      throw new Error(
        `This backup uses ${manifest.currencyCode} but the shop already records transactions in `
        + `${current.currency.code}. Restoring it would mix currencies, so nothing was restored.`,
      )
    }
    const newerRows = this.newerDataSummary(manifest)
    if (newerRows) {
      throw new Error(
        `This backup is older than your current data (${newerRows}). Take a fresh backup first, then `
        + 'restore only if you are sure the newer records can be discarded.',
      )
    }

    const stagingPath = `${backupPath}.restore-${process.pid}-${Date.now()}.sqlite`
    try {
      copyFileSync(backupPath, stagingPath)
      this.prepareRestoredDatabase(stagingPath, manifest)
    } catch (error) {
      rmSync(stagingPath, { force: true })
      throw new Error(`${messageOf(error)} Nothing was restored.`)
    }

    const safetyCopy = this.writePreRestoreSafetyCopy()
    this.swapDatabaseFile(stagingPath)
    // Every earlier connection now points at a deleted file; keep only the reopened repository.
    this.repository = reopen()
    this.normaliseRestoredSettings(adoptCurrency)

    const entry: BackupSummary = {
      id: this.newId(),
      kind: 'RESTORE',
      fileName,
      location: folder,
      sizeBytes: size,
      currencyCode: manifest.currencyCode,
      appVersion: manifest.appVersion,
      checksumSha256: checksum,
      actor: input.actor,
      detail: adoptCurrency
        ? `Restored from ${manifest.createdAt}; this empty shop adopted ${manifest.currencyCode}.`
        : `Restored from ${manifest.createdAt}.${safetyCopy ? ` Safety copy kept: ${basename(safetyCopy)}.` : ''}`,
      createdAt: this.now().toISOString(),
    }
    this.repository.appendBackup(entry)
    this.repository.appendAudit({
      actor: input.actor,
      action: 'backup.restored',
      metadata: { fileName, currencyCode: manifest.currencyCode, adoptedCurrency: adoptCurrency },
      deviceName: 'LOCAL',
      ipAddress: null,
      createdAt: entry.createdAt,
    })

    return {
      restored: true,
      backup: entry,
      adoptedCurrency: adoptCurrency,
      currencyCode: manifest.currencyCode,
      status: this.status(),
    }
  }

  /** Lists backup files the operator can pick, newest first, for the graphical restore picker. */
  listFolder(folder: string): BackupSummary[] {
    const resolved = this.resolveFolder(folder)
    if (!existsSync(resolved)) return []
    return readdirSync(resolved)
      .filter((name) => name.startsWith(BACKUP_PREFIX) && name.endsWith(BACKUP_EXTENSION))
      .map((name) => {
        const full = join(resolved, name)
        let size = 0
        let createdAt = ''
        let currencyCode = ''
        try {
          size = statSync(full).size
          const manifestPath = `${full}${MANIFEST_SUFFIX}`
          if (existsSync(manifestPath)) {
            const manifest = this.readManifest(manifestPath)
            createdAt = manifest.createdAt
            currencyCode = manifest.currencyCode
          }
        } catch {
          // An unreadable pair is still offered; the restore itself re-validates before touching data.
        }
        return {
          id: name,
          kind: 'MANUAL' as const,
          fileName: name,
          location: resolved,
          sizeBytes: size,
          currencyCode,
          appVersion: '',
          checksumSha256: '',
          actor: '',
          detail: 'Found in the selected folder.',
          createdAt,
        }
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  private createBackup(folder: string, kind: 'AUTOMATIC' | 'MANUAL', actor: string): BackupSummary {
    if (!actor.trim()) throw new Error('An authenticated host user is required for this action.')
    mkdirSync(folder, { recursive: true })
    const createdAt = this.now()
    const stamp = createdAt.toISOString().replace(/[:.]/g, '-')
    const fileName = `${BACKUP_PREFIX}${stamp}${BACKUP_EXTENSION}`
    const backupPath = join(folder, fileName)

    const settings = this.repository.readSettings()
    this.snapshotDatabase(backupPath)
    const databaseSha256 = sha256File(backupPath)
    const manifest: BackupManifest = {
      format: 'infoflex-backup',
      formatVersion: 1,
      createdAt: createdAt.toISOString(),
      appVersion: this.options.appVersion,
      productName: this.productName,
      edition: null,
      currencyCode: settings.currency.code,
      storeName: settings.profile.name,
      databaseBytes: statSync(backupPath).size,
      databaseSha256,
      rowCounts: countRows(backupPath),
    }
    writeFileSync(`${backupPath}${MANIFEST_SUFFIX}`, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    this.pruneAutomatic(folder)

    const entry: BackupSummary = {
      id: this.newId(),
      kind,
      fileName,
      location: folder,
      sizeBytes: manifest.databaseBytes,
      currencyCode: manifest.currencyCode,
      appVersion: this.options.appVersion,
      checksumSha256: databaseSha256,
      actor: actor.trim().slice(0, 120),
      detail: kind === 'AUTOMATIC' ? 'Daily automatic backup.' : 'Manual backup.',
      createdAt: createdAt.toISOString(),
    }
    this.repository.appendBackup(entry)
    return entry
  }

  /**
   * VACUUM INTO writes one consistent copy, safe while the app is running: the result is a single file
   * with the write-ahead log already folded in, unlike copying the database and its -wal at two moments.
   */
  private snapshotDatabase(destination: string): void {
    rmSync(destination, { force: true })
    const source = this.openReadOnly()
    try {
      source.prepare('VACUUM INTO ?').run(destination)
    } finally {
      source.close()
    }
  }

  private openReadOnly(): Database.Database {
    if (!existsSync(this.options.databasePath)) throw new Error('The shop database has not been created yet.')
    return new Database(this.options.databasePath, { readonly: true, fileMustExist: true })
  }

  private readManifest(path: string): BackupManifest {
    if (!existsSync(path)) throw new Error('This folder does not contain an Infoflex backup manifest next to the file.')
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      throw new Error('This backup manifest is unreadable. Choose another backup.')
    }
    const manifest = parsed as Partial<BackupManifest>
    if (manifest?.format !== 'infoflex-backup' || manifest.formatVersion !== 1) {
      throw new Error('This file was not created by Infoflex, so it cannot be restored.')
    }
    if (typeof manifest.currencyCode !== 'string' || !/^[A-Z0-9]{2,8}$/.test(manifest.currencyCode)) {
      throw new Error('This backup does not name a usable currency. Choose another backup.')
    }
    if (typeof manifest.databaseSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.databaseSha256)) {
      throw new Error('This backup manifest has no valid checksum. Choose another backup.')
    }
    return manifest as BackupManifest
  }

  /**
   * Validates the copy against its manifest, brings an older backup up to the current schema, and
   * carries the licence, paired-device, and journal tables over from the running install so a restore
   * cannot rewind them. A missing live database (a wiped or brand-new machine) simply means there is
   * nothing to carry over.
   */
  private prepareRestoredDatabase(stagingPath: string, manifest: BackupManifest): void {
    const probe = new Database(stagingPath, { readonly: true, fileMustExist: true })
    try {
      const integrity = probe.pragma('integrity_check', { simple: true })
      if (integrity !== 'ok') throw new Error('The backup database failed its integrity check.')
      for (const [table, expected] of Object.entries(manifest.rowCounts ?? {})) {
        if (!isSafeIdentifier(table)) continue
        const row = probe.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }
        if (row.n !== expected) throw new Error(`The backup rows in ${table} do not match its manifest.`)
      }
    } finally {
      probe.close()
    }

    const liveExists = existsSync(this.options.databasePath)
    const staged = openShopDatabase(stagingPath)
    try {
      if (!liveExists) {
        // No live database to carry over (a wiped or brand-new machine). The licence and paired-device rows
        // inside the backup belong to whatever machine wrote it, so they are cleared rather than adopted:
        // a restore file may never grant a licence or a trusted phone.
        for (const table of RESTORE_LIVE_TABLES) {
          if (isSafeIdentifier(table)) staged.prepare(`DELETE FROM main."${table}"`).run()
        }
        return
      }
      staged.prepare('ATTACH DATABASE ? AS live').run(this.options.databasePath)
      staged.transaction(() => {
        const liveTables = new Set(
          (staged.prepare("SELECT name FROM live.sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
            .map((row) => row.name),
        )
        for (const table of RESTORE_LIVE_TABLES) {
          if (!isSafeIdentifier(table) || !liveTables.has(table)) continue
          staged.prepare(`DELETE FROM main."${table}"`).run()
          staged.prepare(`INSERT INTO main."${table}" SELECT * FROM live."${table}"`).run()
        }
        // The audit journal is a union: nothing the shop did before the restore is erased.
        staged.prepare('INSERT OR IGNORE INTO main.audit_log SELECT * FROM live.audit_log').run()
      })()
      staged.prepare('DETACH DATABASE live').run()
    } finally {
      staged.close()
    }
  }

  /** Returns a human summary of rows that exist now but not in the backup, or null when there are none. */
  private newerDataSummary(manifest: BackupManifest): string | null {
    if (!existsSync(this.options.databasePath)) return null
    const live = this.openReadOnly()
    try {
      // A backup whose table counts already match the live database is the newest state; nothing to lose.
      const stale: string[] = []
      for (const table of RESTORE_BLOCKING_TABLES) {
        const today = countTable(live, table)
        const inBackup = manifest.rowCounts?.[table] ?? 0
        if (today > inBackup) stale.push(`${table}: ${today} now vs ${inBackup} in the backup`)
      }
      return stale.length > 0 ? stale.join(', ') : null
    } finally {
      live.close()
    }
  }

  private writePreRestoreSafetyCopy(): string | null {
    if (!existsSync(this.options.databasePath)) return null
    try {
      const folder = join(dirname(this.options.databasePath), 'backups')
      mkdirSync(folder, { recursive: true })
      const stamp = this.now().toISOString().replace(/[:.]/g, '-')
      const target = join(folder, `${BACKUP_PREFIX}${stamp}-before-restore${BACKUP_EXTENSION}`)
      this.snapshotDatabase(target)
      return target
    } catch {
      // A missing safety copy must not block an explicit, confirmed restore.
      return null
    }
  }

  /**
   * Swaps the prepared copy in for the live database. The live file is deleted (not merely overwritten)
   * and its -wal/-shm side files removed, so no stale write-ahead log can be replayed over the restored
   * data. The copy is renamed in place, which is atomic on one filesystem.
   */
  private swapDatabaseFile(stagingPath: string): void {
    const live = this.options.databasePath
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${live}${suffix}`, { force: true })
    renameSync(stagingPath, live)
  }

  /**
   * Restored data decides its own currency state: transactions in the backup mean the currency is
   * locked from that point on, an adopted currency is locked because the restored shop was already
   * keeping its books in it, and optional settings an older backup predates get the current defaults.
   */
  private normaliseRestoredSettings(adoptedCurrency: boolean): void {
    const restored = this.repository.readSettings()
    const transactionsExist = this.hasTransactions(this.options.databasePath)
    const vendorLocked = this.repository.isCurrencyLockedByVendor()
    this.repository.saveSettings({
      ...restored,
      operational: { ...DEFAULT_OPERATIONAL_SETTINGS, ...(restored.operational ?? {}) },
      setupComplete: true,
      currencyConfirmed: true,
      currencyLocked: restored.currencyLocked || vendorLocked || transactionsExist || adoptedCurrency,
    })
  }

  private hasTransactions(databasePath: string): boolean {
    if (!existsSync(databasePath)) return false
    const live = new Database(databasePath, { readonly: true, fileMustExist: true })
    try {
      return TRANSACTION_TABLES.some((table) => countTable(live, table) > 0)
    } catch {
      // An unreadable table list is treated as "has transactions": refusing is the safe branch.
      return true
    } finally {
      live.close()
    }
  }

  private buildStatus(recent: BackupSummary[]): BackupStatus {
    const lastBackup = recent.find((entry) => entry.kind !== 'RESTORE') ?? null
    const lastBackupAt = lastBackup?.createdAt ?? null
    const age = lastBackupAt ? this.now().getTime() - new Date(lastBackupAt).getTime() : null
    const daysSinceBackup = age === null ? null : Math.max(0, Math.floor(age / DAY_MS))
    const stale = daysSinceBackup === null || daysSinceBackup >= STALE_AFTER_DAYS
    return {
      automaticEnabled: true,
      lastBackupAt,
      lastBackupFile: lastBackup?.fileName ?? null,
      automaticFolder: this.options.automaticFolder,
      daysSinceBackup,
      stale,
      warning: !stale
        ? null
        : daysSinceBackup === null
          ? 'No backup has been made on this computer yet. Press "Back up now" to create one.'
          : `The newest backup is ${daysSinceBackup} days old. Back up now, ideally to a USB stick.`,
      recent,
    }
  }

  /** Keeps the thirty newest automatic snapshots so a small shop PC disk cannot fill up silently. */
  private pruneAutomatic(folder: string): void {
    try {
      const automatic = readdirSync(folder)
        .filter((name) => name.startsWith(`${BACKUP_PREFIX}`) && name.endsWith(BACKUP_EXTENSION) && !name.includes('before-restore'))
        .sort()
        .reverse()
      for (const name of automatic.slice(30)) {
        rmSync(join(folder, name), { force: true })
        rmSync(join(folder, `${name}${MANIFEST_SUFFIX}`), { force: true })
      }
    } catch {
      // Pruning is housekeeping; never fail a good backup because an old file could not be removed.
    }
  }

  private resolveFolder(folder: string): string {
    const trimmed = typeof folder === 'string' ? folder.trim() : ''
    if (!trimmed) return this.options.automaticFolder
    if (trimmed.length > 500) throw new Error('Choose a shorter backup folder path.')
    if (trimmed.includes('\0')) throw new Error('Choose a valid backup folder.')
    return trimmed
  }

  private safeFileName(fileName: string): string {
    const name = basename(typeof fileName === 'string' ? fileName.trim() : '')
    if (!name.startsWith(BACKUP_PREFIX) || !name.endsWith(BACKUP_EXTENSION) || name.length > 200) {
      throw new Error('Choose an Infoflex backup file from the folder.')
    }
    return name
  }

  private localDateKey(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  }
}

function countRows(databasePath: string): Record<string, number> {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true })
  try {
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>
    const counts: Record<string, number> = {}
    for (const { name } of tables) {
      if (!isSafeIdentifier(name)) continue
      counts[name] = countTable(database, name)
    }
    return counts
  } finally {
    database.close()
  }
}

function countTable(database: Database.Database, table: string): number {
  if (!isSafeIdentifier(table)) return 0
  try {
    const row = database.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }
    return row.n
  } catch {
    return 0
  }
}

/** Table names come from sqlite_master or a signed manifest; still refuse anything that is not plain. */
function isSafeIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

export { openShopDatabase }
