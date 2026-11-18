import { describe, expect, it } from 'vitest'
import { ALLOWED_COLUMNS, openDatabase } from '../src/database'

/**
 * The promise made to customers is that the licence server holds licence and contact data only. That promise is
 * only worth something if it is checked mechanically, so this test enumerates every table and every column and
 * fails on anything it does not recognise — including a column somebody adds later without thinking.
 */
describe('cloud database schema', () => {
  const database = openDatabase(':memory:')
  const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>)
    .map((row) => row.name)
    .sort()

  it('has exactly the tables the cloud is allowed to have', () => {
    expect(tables).toEqual(Object.keys(ALLOWED_COLUMNS).sort())
  })

  it.each(Object.keys(ALLOWED_COLUMNS))('table %s has only the allowed columns', (table) => {
    const columns = (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name)
    expect(columns.sort()).toEqual([...(ALLOWED_COLUMNS[table] ?? [])].sort())
  })

  it('holds no column that could store a sale, a price, a stock level or an amount', () => {
    const forbidden = /(sale|price|amount|stock|inventory|product|revenue|payment|receipt|total|cost|quantity|margin)/iu
    const offenders: string[] = []
    for (const table of tables) {
      for (const column of ALLOWED_COLUMNS[table] ?? []) {
        // `max_admin_phones` is a phone count and `lock_currency` a flag; neither is money. The pattern above is
        // tight enough that those pass, and anything genuinely financial would not.
        if (forbidden.test(column)) offenders.push(`${table}.${column}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('keeps currency as a code only, with no numeric companion', () => {
    const currencyColumns = tables.flatMap((table) =>
      (ALLOWED_COLUMNS[table] ?? []).filter((column) => /curr/iu.test(column)).map((column) => `${table}.${column}`))
    // A currency CODE plus a lock flag. There is no `currency_amount`, `symbol`, `rate` or `decimals` column,
    // because the cloud has no business storing anything about money.
    expect(currencyColumns.sort()).toEqual([
      'customers.default_currency', 'customers.lock_currency', 'licenses.default_currency', 'licenses.lock_currency',
    ])
  })

  it('never stores a licence key in plain text outside the licences table', () => {
    const tablesWithKey = tables.filter((table) => (ALLOWED_COLUMNS[table] ?? []).includes('license_key'))
    expect(tablesWithKey).toEqual(['licenses'])
    // Activation attempts keep a hash, so a leaked attempts table cannot be replayed as keys.
    expect(ALLOWED_COLUMNS.activation_attempts).toContain('license_key_hash')
  })

  it('records a password hash and a TOTP secret without an email-only recovery path', () => {
    expect(ALLOWED_COLUMNS.vendor_users).toContain('password_hash')
    expect(ALLOWED_COLUMNS.vendor_users).toContain('totp_secret')
    expect(ALLOWED_COLUMNS.vendor_users).not.toContain('password')
    expect(ALLOWED_COLUMNS.vendor_users).not.toContain('reset_token')
  })
})
