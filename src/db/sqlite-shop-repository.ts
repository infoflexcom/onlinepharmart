import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { createCustomCurrency, getCurrency, type CurrencyDefinition } from '../currency/catalog'
import {
  PAYMENT_METHOD_SETTINGS,
  type AuditEvent,
  type BackupSummary,
  type BusinessEntry,
  type PaymentMethodSetting,
  type ShopSettings,
} from '../shared/shop/types'
import type { ShopRepository } from '../services/contracts/shop-repository'
import { migrateDatabase } from './migrate'

interface SettingsRow {
  store_name: string
  address: string
  phone: string
  email: string
  licence_number: string
  tax_number: string
  store_logo: string | null
  receipt_footer: string
  thank_you_note: string
  idle_timeout_minutes: number
  return_window_days: number
  currency_code: string
  currency_name: string
  currency_symbol: string
  currency_decimals: number
  currency_is_custom: number
  currency_default_position: 'before' | 'after'
  currency_default_thousand: string
  currency_default_decimal: string
  display_mode: 'symbol' | 'code'
  symbol_position: 'before' | 'after'
  thousand_sep: string
  decimal_sep: string
  currency_confirmed: number
  setup_complete: number
  currency_locked: number
  currency_locked_by_vendor: number
  show_powered_by: number
  document_layout: 'THERMAL_80' | 'THERMAL_58' | 'A4_RECEIPT'
  vat_enabled: number
  vat_rate_basis_points: number
  vat_inclusive: number
  discount_limit_basis_points: number
  printer_name: string
  enabled_payment_methods: string
  expiry_alert_days: number
  loyalty_rate_basis_points: number
  supervisor_pin_required: number
  supervisor_pin_length: number
  scale_enabled: number
  scale_port: string
}

export class SQLiteShopRepository implements ShopRepository {
  constructor(private readonly database: Database.Database, runMigrations = true) {
    if (runMigrations) migrateDatabase(database)
  }

  readSettings(): ShopSettings {
    const row = this.database.prepare(`
      SELECT s.store_name, s.address, s.phone, s.email, s.licence_number, s.tax_number,
        s.store_logo, s.receipt_footer, s.thank_you_note, s.idle_timeout_minutes, s.return_window_days,
        s.currency_code, s.display_mode, s.symbol_position, s.thousand_sep, s.decimal_sep,
        s.currency_confirmed, s.setup_complete, s.currency_locked, s.currency_locked_by_vendor,
        s.show_powered_by, s.document_layout, s.vat_enabled, s.vat_rate_basis_points, s.vat_inclusive,
        s.discount_limit_basis_points, s.printer_name, s.enabled_payment_methods, s.expiry_alert_days,
        s.loyalty_rate_basis_points, s.supervisor_pin_required, s.supervisor_pin_length,
        s.scale_enabled, s.scale_port,
        c.name AS currency_name, c.symbol AS currency_symbol, c.decimals AS currency_decimals,
        c.is_custom AS currency_is_custom, c.symbol_position AS currency_default_position,
        c.thousand_sep AS currency_default_thousand, c.decimal_sep AS currency_default_decimal
      FROM settings s
      JOIN currencies c ON c.code = s.currency_code
      WHERE s.id = 1
    `).get() as SettingsRow

    const currency: CurrencyDefinition = {
      code: row.currency_code,
      name: row.currency_name,
      symbol: row.currency_symbol,
      decimalPlaces: row.currency_decimals,
      kind: row.currency_is_custom === 1 ? 'custom' : 'iso',
      symbolPosition: row.currency_default_position,
      thousandsSeparator: row.currency_default_thousand,
      decimalSeparator: row.currency_default_decimal,
    }
    return {
      profile: {
        name: row.store_name,
        address: row.address,
        phone: row.phone,
        email: row.email,
        licenceNumber: row.licence_number,
        taxNumber: row.tax_number,
        storeLogo: row.store_logo,
        receiptFooter: row.receipt_footer,
        thankYouNote: row.thank_you_note,
      },
      currency,
      display: {
        amountDisplay: row.display_mode,
        symbolPosition: row.symbol_position,
        thousandsSeparator: row.thousand_sep,
        decimalSeparator: row.decimal_sep,
      },
      currencyConfirmed: row.currency_confirmed === 1,
      setupComplete: row.setup_complete === 1,
      currencyLocked: row.currency_locked === 1,
      currencyLockedByVendor: row.currency_locked_by_vendor === 1,
      idleTimeoutMinutes: row.idle_timeout_minutes,
      returnWindowDays: row.return_window_days,
      operational: readOperationalSettings(row),
    }
  }

  saveSettings(settings: ShopSettings): void {
    this.ensureCurrency(settings.currency)
    this.database.prepare(`
      UPDATE settings SET
        store_name = @storeName,
        address = @address,
        phone = @phone,
        email = @email,
        licence_number = @licenceNumber,
        tax_number = @taxNumber,
        store_logo = @storeLogo,
        receipt_footer = @receiptFooter,
        thank_you_note = @thankYouNote,
        currency_code = @currencyCode,
        display_mode = @displayMode,
        symbol_position = @symbolPosition,
        thousand_sep = @thousandSep,
        decimal_sep = @decimalSep,
        currency_locked = MAX(currency_locked, @currencyLocked),
        currency_confirmed = @currencyConfirmed,
        setup_complete = @setupComplete,
        idle_timeout_minutes = @idleTimeoutMinutes,
        return_window_days = @returnWindowDays,
        show_powered_by = @showPoweredBy,
        document_layout = @documentLayout,
        vat_enabled = @vatEnabled,
        vat_rate_basis_points = @vatRateBasisPoints,
        vat_inclusive = @vatInclusive,
        discount_limit_basis_points = @discountLimitBasisPoints,
        printer_name = @printerName,
        enabled_payment_methods = @enabledPaymentMethods,
        expiry_alert_days = @expiryAlertDays,
        loyalty_rate_basis_points = @loyaltyRateBasisPoints,
        supervisor_pin_required = @supervisorPinRequired,
        supervisor_pin_length = @supervisorPinLength,
        scale_enabled = @scaleEnabled,
        scale_port = @scalePort,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `).run({
      storeName: settings.profile.name,
      address: settings.profile.address,
      phone: settings.profile.phone,
      email: settings.profile.email ?? '',
      licenceNumber: settings.profile.licenceNumber ?? '',
      taxNumber: settings.profile.taxNumber ?? '',
      storeLogo: settings.profile.storeLogo ?? null,
      receiptFooter: settings.profile.receiptFooter ?? '',
      thankYouNote: settings.profile.thankYouNote ?? '',
      currencyCode: settings.currency.code,
      displayMode: settings.display.amountDisplay,
      symbolPosition: settings.display.symbolPosition,
      thousandSep: settings.display.thousandsSeparator,
      decimalSep: settings.display.decimalSeparator,
      currencyLocked: settings.currencyLocked ? 1 : 0,
      currencyConfirmed: settings.currencyConfirmed ? 1 : 0,
      setupComplete: settings.setupComplete ? 1 : 0,
      idleTimeoutMinutes: settings.idleTimeoutMinutes ?? 15,
      returnWindowDays: settings.returnWindowDays ?? 7,
      showPoweredBy: settings.operational.showPoweredBy ? 1 : 0,
      documentLayout: settings.operational.documentLayout,
      vatEnabled: settings.operational.vatEnabled ? 1 : 0,
      vatRateBasisPoints: settings.operational.vatRateBasisPoints,
      vatInclusive: settings.operational.vatInclusive ? 1 : 0,
      discountLimitBasisPoints: settings.operational.discountLimitBasisPoints,
      printerName: settings.operational.printerName,
      enabledPaymentMethods: JSON.stringify(settings.operational.enabledPaymentMethods),
      expiryAlertDays: settings.operational.expiryAlertDays,
      loyaltyRateBasisPoints: settings.operational.loyaltyRateBasisPoints,
      supervisorPinRequired: settings.operational.supervisorPinRequired ? 1 : 0,
      supervisorPinLength: settings.operational.supervisorPinLength,
      scaleEnabled: settings.operational.scaleEnabled ? 1 : 0,
      scalePort: settings.operational.scalePort,
    })
  }

  readBackupLog(limit = 20): BackupSummary[] {
    const rows = this.database.prepare(`
      SELECT id, kind, file_name, location, size_bytes, currency_code, app_version,
        checksum_sha256, actor, detail, created_at
      FROM backup_log ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(limit) as Array<{
      id: string; kind: BackupSummary['kind']; file_name: string; location: string; size_bytes: number
      currency_code: string; app_version: string; checksum_sha256: string; actor: string
      detail: string; created_at: string
    }>
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      fileName: row.file_name,
      location: row.location,
      sizeBytes: row.size_bytes,
      currencyCode: row.currency_code,
      appVersion: row.app_version,
      checksumSha256: row.checksum_sha256,
      actor: row.actor,
      detail: row.detail,
      createdAt: row.created_at,
    }))
  }

  appendBackup(entry: BackupSummary): void {
    this.database.prepare(`
      INSERT INTO backup_log (id, kind, file_name, location, size_bytes, currency_code, app_version,
        checksum_sha256, actor, detail, created_at)
      VALUES (@id, @kind, @fileName, @location, @sizeBytes, @currencyCode, @appVersion,
        @checksumSha256, @actor, @detail, @createdAt)
    `).run(entry)
  }

  isCurrencyLocked(): boolean {
    const row = this.database.prepare('SELECT currency_locked FROM settings WHERE id = 1').get() as { currency_locked: number }
    return row.currency_locked === 1
  }

  getInstallerCurrencyCode(): string | null {
    const row = this.database.prepare('SELECT installer_currency_code FROM settings WHERE id = 1').get() as { installer_currency_code: string | null }
    return row.installer_currency_code
  }

  isCurrencyLockedByVendor(): boolean {
    const row = this.database.prepare('SELECT currency_locked_by_vendor FROM settings WHERE id = 1').get() as { currency_locked_by_vendor: number }
    return row.currency_locked_by_vendor === 1
  }

  /**
   * Records the currency the installer's Region and Currency page wrote.
   *
   * A built-in ISO currency is stored by code. A **custom** currency cannot be: it exists only in the installer's
   * file, so it must be registered in the currency table here or the setup screen would have no definition to
   * show and a shop that chose its own money would silently fall back to the default. That was a real gap — the
   * installer offers "Custom currency..." and the app used to drop it at first run.
   */
  setInstallerCurrencyCode(code: string, custom?: CurrencyDefinition | null): void {
    if (typeof code !== 'string') throw new Error('Installer currency must be a supported currency.')
    const trimmed = code.trim().toUpperCase()
    const builtIn = getCurrency(trimmed)
    if (builtIn) {
      this.database.prepare('UPDATE settings SET installer_currency_code = ? WHERE id = 1').run(builtIn.code)
      return
    }
    if (custom && custom.code.trim().toUpperCase() === trimmed) {
      // `ensureCurrency` validates the definition with the same rules the setup screen uses, then registers it.
      this.ensureCurrency(custom)
      this.database.prepare('UPDATE settings SET installer_currency_code = ? WHERE id = 1').run(trimmed)
      return
    }
    throw new Error('Installer currency must be a supported built-in currency or a complete custom currency.')
  }

  getCurrencyDefinition(code: string): CurrencyDefinition | null {
    const row = this.database.prepare(`
      SELECT code, name, symbol, decimals, symbol_position, thousand_sep, decimal_sep, is_custom
      FROM currencies WHERE code = ? COLLATE NOCASE
    `).get(code) as {
      code: string; name: string; symbol: string; decimals: number; symbol_position: 'before' | 'after'
      thousand_sep: string; decimal_sep: string; is_custom: number
    } | undefined
    return row ? {
      code: row.code,
      name: row.name,
      symbol: row.symbol,
      decimalPlaces: row.decimals,
      symbolPosition: row.symbol_position,
      thousandsSeparator: row.thousand_sep,
      decimalSeparator: row.decimal_sep,
      kind: row.is_custom === 1 ? 'custom' : 'iso',
    } : null
  }

  setVendorCurrencyLock(): void {
    this.database.prepare(`
      UPDATE settings SET currency_locked_by_vendor = 1, currency_locked = 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `).run()
  }

  setIdleTimeoutMinutes(minutes: number): void {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) {
      throw new Error('Idle timeout must be between 1 and 240 minutes.')
    }
    this.database.prepare('UPDATE settings SET idle_timeout_minutes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(minutes)
  }

  appendAudit(event: AuditEvent): void {
    this.database.prepare(`
      INSERT INTO audit_log (id, actor, action, metadata_json, device_name, ip_address, created_at)
      VALUES (@id, @actor, @action, @metadata, @deviceName, @ipAddress, @createdAt)
    `).run({
      id: randomUUID(),
      actor: event.actor,
      action: event.action,
      metadata: JSON.stringify(event.metadata),
      deviceName: event.deviceName,
      ipAddress: event.ipAddress,
      createdAt: event.createdAt,
    })
  }

  insertBusinessEntry(entry: BusinessEntry): void {
    this.database.prepare(`
      INSERT INTO business_entries (
        id, kind, currency_code, amount_minor, store_name_snapshot,
        store_address_snapshot, store_phone_snapshot, created_at
      ) VALUES (
        @id, @kind, @currencyCode, @amountMinor, @storeNameSnapshot,
        @storeAddressSnapshot, @storePhoneSnapshot, @createdAt
      )
    `).run({
      id: entry.id,
      kind: entry.kind,
      currencyCode: entry.currencyCode,
      amountMinor: entry.amountMinor,
      storeNameSnapshot: entry.storeNameSnapshot,
      storeAddressSnapshot: entry.storeAddressSnapshot,
      storePhoneSnapshot: entry.storePhoneSnapshot,
      createdAt: entry.createdAt,
    })
  }

  withTransaction<T>(work: () => T): T {
    return this.database.transaction(work).immediate()
  }

  close(): void {
    this.database.close()
  }

  private ensureCurrency(currencyInput: CurrencyDefinition): void {
    const currency = currencyInput.kind === 'iso'
      ? getCurrency(currencyInput.code)
      : createCustomCurrency(currencyInput)
    if (!currency) throw new Error('Choose a supported ISO currency.')

    if (currency.kind === 'iso') {
      const stored = this.database.prepare('SELECT 1 AS found FROM currencies WHERE code = ? AND is_custom = 0').get(currency.code)
      if (!stored) throw new Error('The ISO currency is missing from the migrated currency table.')
      return
    }

    const existing = this.database.prepare('SELECT is_custom FROM currencies WHERE code = ?').get(currency.code) as { is_custom: number } | undefined
    if (existing && existing.is_custom !== 1) {
      throw new Error('A built-in ISO currency cannot be overwritten by a custom currency.')
    }
    if (existing) {
      this.database.prepare(`
        UPDATE currencies SET name = ?, symbol = ?, decimals = ?, symbol_position = ?, thousand_sep = ?, decimal_sep = ?
        WHERE code = ? AND is_custom = 1
      `).run(currency.name, currency.symbol, currency.decimalPlaces, currency.symbolPosition, currency.thousandsSeparator, currency.decimalSeparator, currency.code)
    } else {
      this.database.prepare(`
        INSERT INTO currencies (code, name, symbol, decimals, symbol_position, thousand_sep, decimal_sep, is_custom)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      `).run(currency.code, currency.name, currency.symbol, currency.decimalPlaces, currency.symbolPosition, currency.thousandsSeparator, currency.decimalSeparator)
    }
  }
}

function readOperationalSettings(row: SettingsRow): ShopSettings['operational'] {
  return {
    showPoweredBy: row.show_powered_by === 1,
    documentLayout: row.document_layout,
    vatEnabled: row.vat_enabled === 1,
    vatRateBasisPoints: row.vat_rate_basis_points,
    vatInclusive: row.vat_inclusive === 1,
    discountLimitBasisPoints: row.discount_limit_basis_points,
    printerName: row.printer_name,
    enabledPaymentMethods: parsePaymentMethods(row.enabled_payment_methods),
    expiryAlertDays: row.expiry_alert_days,
    loyaltyRateBasisPoints: row.loyalty_rate_basis_points,
    supervisorPinRequired: row.supervisor_pin_required === 1,
    supervisorPinLength: row.supervisor_pin_length,
    scaleEnabled: row.scale_enabled === 1,
    scalePort: row.scale_port,
  }
}

/** Falls back to cash-only rather than an empty list if the stored JSON is ever unreadable. */
function parsePaymentMethods(raw: string): PaymentMethodSetting[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      const kept = parsed.filter((value): value is PaymentMethodSetting =>
        typeof value === 'string' && (PAYMENT_METHOD_SETTINGS as readonly string[]).includes(value))
      if (kept.length > 0) return PAYMENT_METHOD_SETTINGS.filter((method) => kept.includes(method))
    }
  } catch {
    // fall through to the safe default
  }
  return [...PAYMENT_METHOD_SETTINGS]
}
