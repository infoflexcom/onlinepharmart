import { randomUUID } from 'node:crypto'
import { createCustomCurrency, getCurrency, type CurrencyDefinition } from '../currency/catalog'
import { assertCurrencyChangeAllowed } from '../currency/lock-guard'
import type {
  AuditEvent,
  BusinessEntry,
  BusinessEntryKind,
  OperationalSettings,
  ShopProfile,
  ShopSettings,
} from '../shared/shop/types'
import { normalizeOperationalSettings, normalizeShopProfile, validateMoneyDisplay } from '../shared/shop/validation'
import { CURRENCY_LOCKING_ENTRY_KINDS, type ShopRepository } from './contracts/shop-repository'

const MAX_SQLITE_INTEGER = 9_223_372_036_854_775_807n

export interface AuditContext {
  deviceName: string
  ipAddress: string | null
}

export type AccessDenialReason = 'unauthenticated' | 'non_admin' | 'authentication_error' | 'rate_limited' | 'license_feature' | 'license_inactive'

export interface DeniedAccessAuditInput {
  reason: AccessDenialReason
  ipAddress: string | null
  userAgent?: string
  actor?: string
  feature?: 'mobileLan' | 'mobileInternet'
}

export class ShopService {
  constructor(
    private readonly repository: ShopRepository,
    private readonly auditContext: AuditContext = { deviceName: 'LOCAL', ipAddress: null },
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {}

  getSettings(): ShopSettings {
    return this.repository.readSettings()
  }

  /** Admin-only wrapper in the host controller; persists a store-profile edit and audit atomically. */
  updateStoreDetails(profileInput: ShopProfile, actor: string): ShopSettings {
    const current = this.repository.readSettings()
    if (!current.setupComplete) throw new Error('Complete first-run setup before editing store details.')
    const profile = normalizeShopProfile(profileInput)
    const actorName = normalizeActor(actor)
    const next = { ...current, profile }
    this.repository.withTransaction(() => {
      this.repository.saveSettings(next)
      this.repository.appendAudit(this.audit('shop.profile.updated', { storeName: profile.name }, actorName))
    })
    return next
  }

  /** Display preferences are Admin-managed but never alter the selected currency or stored amounts. */
  updateDisplaySettings(display: ShopSettings['display'], actor: string): ShopSettings {
    const current = this.repository.readSettings()
    if (!current.setupComplete) throw new Error('Complete first-run setup before editing currency display.')
    const actorName = normalizeActor(actor)
    validateMoneyDisplay(display)
    const next = { ...current, display: { ...display } }
    this.repository.withTransaction(() => {
      this.repository.saveSettings(next)
      this.repository.appendAudit(this.audit('currency.display.updated', {
        currencyCode: current.currency.code,
        display,
      }, actorName))
    })
    return next
  }

  updateIdleTimeout(minutes: number, actor: string): ShopSettings {
    const current = this.repository.readSettings()
    if (!current.setupComplete) throw new Error('Complete first-run setup before changing session settings.')
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) {
      throw new Error('Idle timeout must be between 1 and 240 minutes.')
    }
    const actorName = normalizeActor(actor)
    this.repository.withTransaction(() => {
      this.repository.setIdleTimeoutMinutes(minutes)
      this.repository.appendAudit(this.audit('security.idle_timeout.updated', { minutes }, actorName))
    })
    return { ...current, idleTimeoutMinutes: minutes }
  }

  updateReturnWindowDays(days: number, actor: string): ShopSettings {
    const current = this.repository.readSettings()
    if (!current.setupComplete) throw new Error('Complete first-run setup before changing return settings.')
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      throw new Error('The return window must be a whole number from 1 to 365 days.')
    }
    const actorName = normalizeActor(actor)
    const next = { ...current, returnWindowDays: days }
    this.repository.withTransaction(() => {
      this.repository.saveSettings(next)
      this.repository.appendAudit(this.audit('returns.window.updated', { days }, actorName))
    })
    return next
  }

  /**
   * Receipt layout, optional VAT, discount ceiling, printer, accepted payment methods and edition
   * options. Display-only or workflow-only: none of these rewrite a stored amount or currency.
   */
  updateOperationalSettings(input: OperationalSettings, actor: string): ShopSettings {
    const current = this.repository.readSettings()
    if (!current.setupComplete) throw new Error('Complete first-run setup before changing receipt settings.')
    const operational = normalizeOperationalSettings(input)
    const actorName = normalizeActor(actor)
    const next: ShopSettings = { ...current, operational }
    this.repository.withTransaction(() => {
      this.repository.saveSettings(next)
      this.repository.appendAudit(this.audit('settings.operational.updated', {
        documentLayout: operational.documentLayout,
        vatEnabled: operational.vatEnabled,
        vatRateBasisPoints: operational.vatRateBasisPoints,
        discountLimitBasisPoints: operational.discountLimitBasisPoints,
        enabledPaymentMethods: operational.enabledPaymentMethods,
        expiryAlertDays: operational.expiryAlertDays,
        loyaltyRateBasisPoints: operational.loyaltyRateBasisPoints,
        supervisorPinRequired: operational.supervisorPinRequired,
        supervisorPinLength: operational.supervisorPinLength,
        scaleEnabled: operational.scaleEnabled,
      }, actorName))
    })
    return next
  }

  /** The shop currency is mutable only until a sale, purchase, return, or stock valuation exists. */
  changeCurrency(currencyInput: CurrencyDefinition, confirmed: boolean, actor: string): ShopSettings {
    const current = this.repository.readSettings()
    if (!current.setupComplete) throw new Error('Complete first-run setup before changing currency.')
    if (!confirmed) throw new Error('Confirm the shop currency before saving it.')
    const actorName = normalizeActor(actor)
    assertCurrencyChangeAllowed(this.repository)

    const currency = canonicalCurrency(currencyInput)
    const next: ShopSettings = {
      ...current,
      currency,
      display: {
        ...current.display,
        symbolPosition: currency.symbolPosition,
        thousandsSeparator: currency.thousandsSeparator,
        decimalSeparator: currency.decimalSeparator,
      },
      currencyConfirmed: true,
    }
    this.repository.withTransaction(() => {
      this.repository.saveSettings(next)
      this.repository.appendAudit(this.audit('currency.changed', {
        previousCode: current.currency.code,
        currencyCode: currency.code,
      }, actorName))
    })
    return next
  }

  /** Shared host-side entry point for later sales, purchasing, returns and day close. */
  recordBusinessEntry(kind: BusinessEntryKind, amountMinor: bigint, actor: string): BusinessEntry {
    const settings = this.repository.readSettings()
    if (!settings.setupComplete) throw new Error('Complete shop setup before recording transactions.')
    const actorName = normalizeActor(actor)
    if (amountMinor < 0n) throw new Error('Entry amounts must be non-negative minor units.')
    if (amountMinor > MAX_SQLITE_INTEGER) {
      throw new Error('The amount exceeds the supported SQLite integer range.')
    }

    const entry: BusinessEntry = {
      id: this.newId(),
      kind,
      currencyCode: settings.currency.code,
      amountMinor,
      storeNameSnapshot: settings.profile.name,
      storeAddressSnapshot: settings.profile.address,
      storePhoneSnapshot: settings.profile.phone,
      createdAt: this.now().toISOString(),
    }
    this.repository.withTransaction(() => {
      this.repository.insertBusinessEntry(entry)
      this.repository.appendAudit(this.audit('business.entry.recorded', {
        entryId: entry.id,
        kind,
        currencyCode: entry.currencyCode,
        amountMinor: amountMinor.toString(),
      }, actorName))
    })
    return entry
  }

  /** Audits unauthorized remote access without revealing authorization details to the caller. */
  recordDeniedAccess(input: DeniedAccessAuditInput): void {
    const userAgent = input.userAgent?.replace(/[\r\n\t\p{C}]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 160) ?? ''
    this.repository.appendAudit({
      actor: input.actor?.replace(/[\p{C}]+/gu, ' ').trim().slice(0, 120) || 'UNAUTHENTICATED',
      action: input.reason === 'rate_limited' ? 'host.access.rate_limited' : 'host.access.denied',
      metadata: { reason: input.reason, feature: input.feature ?? null, userAgent },
      deviceName: userAgent || 'REMOTE API CLIENT',
      ipAddress: input.ipAddress?.slice(0, 100) ?? null,
      createdAt: this.now().toISOString(),
    })
  }

  private audit(action: string, metadata: Record<string, unknown>, actor: string): AuditEvent {
    return {
      actor,
      action,
      metadata,
      deviceName: this.auditContext.deviceName,
      ipAddress: this.auditContext.ipAddress,
      createdAt: this.now().toISOString(),
    }
  }
}

export { normalizeOperationalSettings, normalizeShopProfile, validateMoneyDisplay } from '../shared/shop/validation'

function normalizeActor(actor: string): string {
  const normalized = actor.trim()
  if (!normalized) throw new Error('An authenticated host user is required for this action.')
  if (normalized.length > 120) throw new Error('Audit username must be 120 characters or fewer.')
  return normalized
}

function canonicalCurrency(input: CurrencyDefinition): CurrencyDefinition {
  if (input.kind === 'iso') {
    const currency = getCurrency(input.code)
    if (!currency) throw new Error('Choose a supported ISO currency.')
    return currency
  }
  return createCustomCurrency(input)
}

export { CURRENCY_LOCKING_ENTRY_KINDS }
