import type Database from 'better-sqlite3'
import { DEFAULT_CURRENCY_CODE, getCurrency } from '../../currency/catalog'

interface LegacySettings {
  store_name: string
  store_address: string
  store_phone: string
  currency_code: string
  currency_name: string
  currency_symbol: string
  currency_decimals: number
  currency_kind: 'iso' | 'custom'
  amount_display: 'symbol' | 'code'
  symbol_position: 'before' | 'after'
  thousands_separator: string
  decimal_separator: string
  currency_confirmed: number
  setup_complete: number
}

export function migrateLegacyShopSettings(db: Database.Database): void {
  if (!tableExists(db, 'shop_settings')) return
  const legacy = db.prepare('SELECT * FROM shop_settings WHERE id = 1').get() as LegacySettings | undefined
  if (!legacy) return

  const code = legacy.currency_code?.trim().toUpperCase() || DEFAULT_CURRENCY_CODE
  if (legacy.currency_kind === 'custom' && !getCurrency(code) && legacy.currency_name && legacy.currency_symbol) {
    db.prepare(`
      INSERT OR IGNORE INTO currencies
        (code, name, symbol, decimals, symbol_position, thousand_sep, decimal_sep, is_custom)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      code,
      legacy.currency_name,
      legacy.currency_symbol,
      legacy.currency_decimals,
      legacy.symbol_position,
      legacy.thousands_separator,
      legacy.decimal_separator,
    )
  }
  const currencyExists = db.prepare('SELECT 1 AS exists_flag FROM currencies WHERE code = ?').get(code)
  const currencyCode = currencyExists ? code : DEFAULT_CURRENCY_CODE
  const hasLockedEntry = db.prepare(`
    SELECT EXISTS(
      SELECT 1 FROM business_entries
      WHERE kind IN ('sale', 'purchase', 'return', 'stock_valuation')
    ) AS locked
  `).get() as { locked: number }
  const currencyLocked = hasLockedEntry.locked === 1 ? 1 : 0

  db.prepare(`
    UPDATE settings SET
      store_name = ?, address = ?, phone = ?, currency_code = ?,
      display_mode = ?, symbol_position = ?, thousand_sep = ?, decimal_sep = ?,
      currency_locked = ?, currency_locked_by_transaction = ?,
      currency_confirmed = ?, setup_complete = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `).run(
    legacy.store_name,
    legacy.store_address,
    legacy.store_phone,
    currencyCode,
    legacy.amount_display,
    legacy.symbol_position,
    legacy.thousands_separator,
    legacy.decimal_separator,
    currencyLocked,
    currencyLocked,
    legacy.currency_confirmed,
    legacy.setup_complete,
  )
}

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))
}
