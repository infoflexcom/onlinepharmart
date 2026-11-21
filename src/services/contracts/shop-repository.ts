import type { AuditEvent, BackupSummary, BusinessEntry, BusinessEntryKind, ShopSettings } from '@shared/shop/types'

export interface ShopRepository {
  readSettings(): ShopSettings
  saveSettings(settings: ShopSettings): void
  isCurrencyLocked(): boolean
  setIdleTimeoutMinutes(minutes: number): void
  isCurrencyLockedByVendor(): boolean
  readBackupLog(limit?: number): BackupSummary[]
  appendBackup(entry: BackupSummary): void
  appendAudit(event: AuditEvent): void
  insertBusinessEntry(entry: BusinessEntry): void
  withTransaction<T>(work: () => T): T
}

export const CURRENCY_LOCKING_ENTRY_KINDS: readonly BusinessEntryKind[] = [
  'sale',
  'purchase',
  'return',
  'stock_valuation',
]
