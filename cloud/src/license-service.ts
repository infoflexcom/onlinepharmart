import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Edition } from '../../src/editions'
import type { LicenseClaims, SignedLicenseStatus } from '../../src/shared/license/types'
import { signLicenseToken, type SigningIdentity } from './signing'

/**
 * The vendor's licensing rules, in one place, away from HTTP and away from the HTML. Every portal action and
 * every public API call goes through a method here, so "suspend", "renew" and "rebind" mean exactly one thing
 * and are audited exactly once.
 *
 * The three invariants this file exists to protect:
 *   1. Only this module produces a licence token, and it always signs current database state.
 *   2. A licence change increments `revision`; a check-in only hands out a new token when the stored revision
 *      is newer than the revision the PC already has. That is what makes "renew from the portal" reach the
 *      shop on its next poll with no password typed at the customer.
 *   3. Currency is a CODE and two flags. No amount is ever accepted, stored, or returned here.
 */

export const LICENSE_KEY_PREFIX = 'IFX'

export type LicenseStatus = 'active' | 'suspended' | 'expired' | 'revoked'
export type LicenseSource = 'online' | 'file' | 'onsite'

export interface CustomerRow {
  id: string
  business_name: string
  contact_name: string
  phone: string
  email: string
  notes: string
  default_currency: string | null
  lock_currency: number
  created_at: string
  updated_at: string
}

export interface LicenseRow {
  id: string
  license_key: string
  customer_id: string
  edition: Edition
  starts_at: string
  ends_at: string
  status: LicenseStatus
  max_admin_phones: number
  mobile_lan: number
  mobile_internet: number
  default_currency: string | null
  lock_currency: number
  grace_days: number
  machine_id: string | null
  machine_bound_at: string | null
  source: LicenseSource
  onsite_reported_at: string | null
  onsite_owner_machine: string | null
  revision: number
  delivered_revision: number
  last_checkin_at: string | null
  last_app_version: string | null
  last_platform: string | null
  notify_now_at: string | null
  created_at: string
  updated_at: string
}

export interface LicenseView extends LicenseRow {
  customer_name: string
  /** Computed for the portal's filters; the stored status is the vendor's decision, not the calendar's. */
  effective_status: 'active' | 'expiring' | 'expired' | 'suspended' | 'revoked'
  days_remaining: number
  online_now: boolean
  last_checkin_label: string | null
  relay_status: 'online' | 'offline' | 'unknown'
}

export interface CreateLicenseInput {
  customer: {
    businessName: string
    contactName?: string
    phone?: string
    email?: string
    notes?: string
  }
  edition: Edition
  startsAt: string
  endsAt: string
  maxAdminPhones: number
  mobileLan: boolean
  mobileInternet: boolean
  defaultCurrencyCode: string | null
  lockCurrency: boolean
  graceDays?: number
}

export interface CheckInInput {
  licenseId: string
  machineId: string
  appVersion: string
  platform: string
  checkedAt: string
  source: LicenseSource
  ipAddress: string | null
  onsiteLicense?: {
    edition: Edition
    startsAt: string
    endsAt: string
    issuedAt: string
    status: 'active' | 'suspended' | 'revoked'
    defaultCurrencyCode: string | null
    lockCurrency: boolean
    features: { mobileLan: boolean; mobileInternet: boolean }
    adminPhoneLimit: number
    graceDays: number
  }
}

export interface LicenseHistoryEntry {
  actor: string
  action: string
  detail: Record<string, unknown>
  created_at: string
}

export interface CheckInResult {
  updated: boolean
  reported: boolean
  token: string | null
  serverNow: string
}

export interface ActivationResult {
  token: string
  serverNow: string
  licenseId: string
}

export type ActivationRejection =
  | 'unknown_key'
  | 'invalid_key'
  | 'suspended'
  | 'revoked'
  | 'not_yet_valid'
  | 'expired'
  | 'machine_conflict'
  | 'rate_limited'

export class LicenseError extends Error {
  constructor(public readonly code: ActivationRejection | 'not_found' | 'invalid' | 'conflict', message: string) {
    super(message)
    this.name = 'LicenseError'
  }
}

const EXPIRING_WINDOW_DAYS = 30
const ONLINE_WINDOW_MINUTES = 5
const ACTIVATION_WINDOW_MINUTES = 15
const ACTIVATION_LIMIT_PER_IP = 12
const ACTIVATION_LIMIT_PER_KEY = 10
const DAY_MS = 24 * 60 * 60 * 1_000

export interface ServiceOptions {
  now?: () => number
  /** Test-only override of the activation rate limits, so the limit itself can be exercised quickly. */
  activationLimits?: { perIp: number; perKey: number; windowMinutes: number }
}

export class LicenseService {
  private readonly now: () => number
  private readonly limits: { perIp: number; perKey: number; windowMinutes: number }

  constructor(
    private readonly database: Database.Database,
    private readonly identity: SigningIdentity,
    options: ServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.limits = {
      perIp: options.activationLimits?.perIp ?? ACTIVATION_LIMIT_PER_IP,
      perKey: options.activationLimits?.perKey ?? ACTIVATION_LIMIT_PER_KEY,
      windowMinutes: options.activationLimits?.windowMinutes ?? ACTIVATION_WINDOW_MINUTES,
    }
  }

  // ------------------------------------------------------------------ customers

  createCustomer(input: {
    businessName: string
    contactName?: string
    phone?: string
    email?: string
    notes?: string
    defaultCurrencyCode?: string | null
    lockCurrency?: boolean
  }, actor: string): CustomerRow {
    const nowIso = this.isoNow()
    const row: CustomerRow = {
      id: randomUUID(),
      business_name: requireText(input.businessName, 'Business name', 160),
      contact_name: clean(input.contactName, 120),
      phone: clean(input.phone, 40),
      email: clean(input.email, 160),
      notes: clean(input.notes, 2_000),
      default_currency: normaliseCurrencyCode(input.defaultCurrencyCode),
      lock_currency: input.lockCurrency ? 1 : 0,
      created_at: nowIso,
      updated_at: nowIso,
    }
    if (row.lock_currency && !row.default_currency) {
      throw new LicenseError('invalid', 'Choose a default currency before locking the currency for this customer.')
    }
    this.database.prepare(`
      INSERT INTO customers (id, business_name, contact_name, phone, email, notes, default_currency, lock_currency, created_at, updated_at)
      VALUES (@id, @business_name, @contact_name, @phone, @email, @notes, @default_currency, @lock_currency, @created_at, @updated_at)
    `).run(row)
    this.audit(actor, 'customer.created', row.id, { businessName: row.business_name })
    return row
  }

  updateCustomer(id: string, input: Partial<{
    businessName: string
    contactName: string
    phone: string
    email: string
    notes: string
  }>, actor: string): CustomerRow {
    const existing = this.getCustomer(id)
    const row: CustomerRow = {
      ...existing,
      business_name: input.businessName === undefined ? existing.business_name : requireText(input.businessName, 'Business name', 160),
      contact_name: input.contactName === undefined ? existing.contact_name : clean(input.contactName, 120),
      phone: input.phone === undefined ? existing.phone : clean(input.phone, 40),
      email: input.email === undefined ? existing.email : clean(input.email, 160),
      notes: input.notes === undefined ? existing.notes : clean(input.notes, 2_000),
      updated_at: this.isoNow(),
    }
    this.database.prepare(`
      UPDATE customers SET business_name = @business_name, contact_name = @contact_name, phone = @phone,
        email = @email, notes = @notes, updated_at = @updated_at WHERE id = @id
    `).run(row)
    this.audit(actor, 'customer.updated', id, { businessName: row.business_name })
    return row
  }

  getCustomer(id: string): CustomerRow {
    const row = this.database.prepare('SELECT * FROM customers WHERE id = ?').get(id) as CustomerRow | undefined
    if (!row) throw new LicenseError('not_found', 'That customer no longer exists.')
    return row
  }

  listCustomers(search = ''): Array<CustomerRow & { license_count: number; active_count: number }> {
    const term = `%${search.trim().replace(/[%_]/gu, '')}%`
    return this.database.prepare(`
      SELECT c.*,
        (SELECT COUNT(*) FROM licenses l WHERE l.customer_id = c.id) AS license_count,
        (SELECT COUNT(*) FROM licenses l WHERE l.customer_id = c.id AND l.status = 'active' AND l.ends_at > ?) AS active_count
      FROM customers c
      WHERE ? = '%%' OR c.business_name LIKE ? COLLATE NOCASE OR c.contact_name LIKE ? COLLATE NOCASE
        OR c.email LIKE ? COLLATE NOCASE OR c.phone LIKE ? COLLATE NOCASE
      ORDER BY c.business_name COLLATE NOCASE
    `).all(this.isoNow(), term, term, term, term, term) as Array<CustomerRow & { license_count: number; active_count: number }>
  }

  // ------------------------------------------------------------------ licences

  createLicense(input: CreateLicenseInput, actor: string): { customer: CustomerRow; license: LicenseRow } {
    const start = requireDate(input.startsAt, 'Start date')
    const end = requireDate(input.endsAt, 'End date')
    if (end <= start) throw new LicenseError('invalid', 'The end date must be after the start date.')
    const currency = normaliseCurrencyCode(input.defaultCurrencyCode)
    if (input.lockCurrency && !currency) throw new LicenseError('invalid', 'Choose a default currency before locking the currency.')
    const phones = input.maxAdminPhones
    if (!Number.isInteger(phones) || phones < 1 || phones > 100) throw new LicenseError('invalid', 'The Admin phone limit must be a whole number from 1 to 100.')

    return this.database.transaction(() => {
      const customer = this.createCustomer({
        ...input.customer,
        defaultCurrencyCode: currency,
        lockCurrency: input.lockCurrency,
      }, actor)
      const license = this.insertLicense({
        customerId: customer.id,
        edition: input.edition,
        startsAt: start,
        endsAt: end,
        status: 'active',
        maxAdminPhones: phones,
        mobileLan: input.mobileLan,
        mobileInternet: input.mobileInternet,
        defaultCurrencyCode: currency,
        lockCurrency: input.lockCurrency,
        graceDays: input.graceDays ?? 0,
        source: 'online',
      }, actor, 'license.created')
      return { customer, license }
    })()
  }

  /** Adds a second licence to an existing customer, which is how a shop renews into a new term later. */
  addLicenseToCustomer(customerId: string, input: Omit<CreateLicenseInput, 'customer'>, actor: string): LicenseRow {
    const start = requireDate(input.startsAt, 'Start date')
    const end = requireDate(input.endsAt, 'End date')
    if (end <= start) throw new LicenseError('invalid', 'The end date must be after the start date.')
    this.getCustomer(customerId)
    return this.insertLicense({
      customerId,
      edition: input.edition,
      startsAt: start,
      endsAt: end,
      status: 'active',
      maxAdminPhones: input.maxAdminPhones,
      mobileLan: input.mobileLan,
      mobileInternet: input.mobileInternet,
      defaultCurrencyCode: normaliseCurrencyCode(input.defaultCurrencyCode),
      lockCurrency: input.lockCurrency,
      graceDays: input.graceDays ?? 0,
      source: 'online',
    }, actor, 'license.created')
  }

  private insertLicense(input: {
    customerId: string
    edition: Edition
    startsAt: string
    endsAt: string
    status: LicenseStatus
    maxAdminPhones: number
    mobileLan: boolean
    mobileInternet: boolean
    defaultCurrencyCode: string | null
    lockCurrency: boolean
    graceDays: number
    source: LicenseSource
  }, actor: string, action: string): LicenseRow {
    const nowIso = this.isoNow()
    const row: LicenseRow = {
      id: randomUUID(),
      license_key: this.generateUniqueKey(),
      customer_id: input.customerId,
      edition: input.edition,
      starts_at: input.startsAt,
      ends_at: input.endsAt,
      status: input.status,
      max_admin_phones: input.maxAdminPhones,
      mobile_lan: input.mobileLan ? 1 : 0,
      mobile_internet: input.mobileInternet ? 1 : 0,
      default_currency: input.defaultCurrencyCode,
      lock_currency: input.lockCurrency ? 1 : 0,
      grace_days: input.graceDays,
      machine_id: null,
      machine_bound_at: null,
      source: input.source,
      onsite_reported_at: null,
      onsite_owner_machine: null,
      // Revision 0 means "never delivered". The first successful check-in or activation hands out revision 0.
      revision: 0,
      delivered_revision: -1,
      last_checkin_at: null,
      last_app_version: null,
      last_platform: null,
      notify_now_at: null,
      created_at: nowIso,
      updated_at: nowIso,
    }
    this.database.prepare(`
      INSERT INTO licenses (id, license_key, customer_id, edition, starts_at, ends_at, status, max_admin_phones,
        mobile_lan, mobile_internet, default_currency, lock_currency, grace_days, machine_id, machine_bound_at, source,
        onsite_reported_at, onsite_owner_machine, revision, delivered_revision, last_checkin_at, last_app_version,
        last_platform, notify_now_at, created_at, updated_at)
      VALUES (@id, @license_key, @customer_id, @edition, @starts_at, @ends_at, @status, @max_admin_phones,
        @mobile_lan, @mobile_internet, @default_currency, @lock_currency, @grace_days, @machine_id, @machine_bound_at, @source,
        @onsite_reported_at, @onsite_owner_machine, @revision, @delivered_revision, @last_checkin_at, @last_app_version,
        @last_platform, @notify_now_at, @created_at, @updated_at)
    `).run(row)
    this.history(row.id, actor, action, {
      edition: row.edition, startsAt: row.starts_at, endsAt: row.ends_at,
      defaultCurrency: row.default_currency, lockCurrency: row.lock_currency === 1,
    })
    this.audit(actor, action, row.id, { customerId: row.customer_id, edition: row.edition })
    return row
  }

  /** Licence keys are shown to a human once and typed by hand, so they avoid look-alike characters. */
  private generateUniqueKey(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const blocks: string[] = []
      for (let block = 0; block < 4; block += 1) {
        let text = ''
        for (let index = 0; index < 4; index += 1) text += alphabet[randomBytes(1)[0]! % alphabet.length]
        blocks.push(text)
      }
      const key = `${LICENSE_KEY_PREFIX}-${blocks.join('-')}`
      const exists = this.database.prepare('SELECT 1 FROM licenses WHERE license_key = ?').get(key)
      if (!exists) return key
    }
    throw new Error('Could not generate a unique licence key. Try again.')
  }

  getLicense(id: string): LicenseRow {
    const row = this.database.prepare('SELECT * FROM licenses WHERE id = ?').get(id) as LicenseRow | undefined
    if (!row) throw new LicenseError('not_found', 'That licence no longer exists.')
    return row
  }

  /**
   * Looks a licence up by its opaque id (what a token carries) or by its printed key. Used by the relay, which
   * only ever has the id, and by the portal's search.
   */
  findLicenseByKeyOrId(value: string): LicenseView | undefined {
    const text = String(value ?? '').trim()
    if (!text) return undefined
    const row = this.database.prepare(`
      SELECT l.*, c.business_name AS customer_name FROM licenses l JOIN customers c ON c.id = l.customer_id
      WHERE l.id = ? OR l.license_key = ? COLLATE NOCASE
    `).get(text, text) as (LicenseRow & { customer_name: string }) | undefined
    if (!row) return undefined
    const relay = this.database.prepare('SELECT status, last_seen_at FROM relay_connections WHERE shop_id = ?').get(row.id) as
      { status: string; last_seen_at: string | null } | undefined
    const live = relay?.status === 'online' && relay.last_seen_at !== null && this.now() - Date.parse(relay.last_seen_at) < 60_000
    return this.toView(row, row.customer_name, this.now(), live ? 'online' : 'offline')
  }

  findLicenseByKey(key: string): LicenseRow | undefined {
    return this.database.prepare('SELECT * FROM licenses WHERE license_key = ? COLLATE NOCASE').get(key.trim()) as LicenseRow | undefined
  }

  /**
   * The portal's list. `filter` is a small closed set so a stale bookmark cannot ask for an arbitrary query.
   */
  listLicenses(input: { search?: string; filter?: string; customerId?: string } = {}): LicenseView[] {
    const nowMs = this.now()
    const term = `%${(input.search ?? '').trim().replace(/[%_]/gu, '')}%`
    const rows = this.database.prepare(`
      SELECT l.*, c.business_name AS customer_name
      FROM licenses l JOIN customers c ON c.id = l.customer_id
      WHERE (? IS NULL OR l.customer_id = ?)
        AND (? = '%%' OR c.business_name LIKE ? COLLATE NOCASE OR l.license_key LIKE ? COLLATE NOCASE
             OR c.contact_name LIKE ? COLLATE NOCASE OR c.email LIKE ? COLLATE NOCASE)
      ORDER BY l.ends_at, c.business_name COLLATE NOCASE
    `).all(input.customerId ?? null, input.customerId ?? null, term, term, term, term, term) as Array<LicenseRow & { customer_name: string }>
    const relayRows = this.database.prepare('SELECT shop_id, status, last_seen_at FROM relay_connections').all() as Array<{ shop_id: string; status: string; last_seen_at: string | null }>
    const relayByLicense = new Map<string, 'online' | 'offline' | 'unknown'>()
    for (const relay of relayRows) {
      const live = relay.status === 'online' && relay.last_seen_at !== null && nowMs - Date.parse(relay.last_seen_at) < 60_000
      relayByLicense.set(relay.shop_id, live ? 'online' : 'offline')
    }
    const views = rows.map((row) => this.toView(row, row.customer_name, nowMs, relayByLicense.get(row.id) ?? 'unknown'))
    return views.filter((view) => matchesFilter(view, input.filter))
  }

  getLicenseView(id: string): LicenseView {
    const row = this.database.prepare(`
      SELECT l.*, c.business_name AS customer_name FROM licenses l JOIN customers c ON c.id = l.customer_id WHERE l.id = ?
    `).get(id) as (LicenseRow & { customer_name: string }) | undefined
    if (!row) throw new LicenseError('not_found', 'That licence no longer exists.')
    return this.toView(row, row.customer_name, this.now(), 'unknown')
  }

  private toView(row: LicenseRow & { customer_name?: string }, customerName: string, nowMs: number, relay: 'online' | 'offline' | 'unknown'): LicenseView {
    const endMs = Date.parse(row.ends_at)
    const daysRemaining = Math.ceil((endMs - nowMs) / DAY_MS)
    const expired = endMs <= nowMs
    let effective: LicenseView['effective_status']
    if (row.status === 'suspended') effective = 'suspended'
    else if (row.status === 'revoked') effective = 'revoked'
    else if (expired) effective = 'expired'
    else if (daysRemaining <= EXPIRING_WINDOW_DAYS) effective = 'expiring'
    else effective = 'active'
    return {
      ...row,
      customer_name: customerName,
      effective_status: effective,
      days_remaining: daysRemaining,
      online_now: row.last_checkin_at !== null && nowMs - Date.parse(row.last_checkin_at) < ONLINE_WINDOW_MINUTES * 60_000,
      last_checkin_label: row.last_checkin_at,
      relay_status: relay,
    }
  }

  /** Renewal changes only the term; it bumps the revision so the shop's next poll picks it up by itself. */
  renewLicense(id: string, input: { startsAt?: string; endsAt: string; notifyNow?: boolean }, actor: string): LicenseRow {
    const existing = this.getLicense(id)
    const end = requireDate(input.endsAt, 'End date')
    const start = input.startsAt ? requireDate(input.startsAt, 'Start date') : existing.starts_at
    if (end <= start) throw new LicenseError('invalid', 'The end date must be after the start date.')
    const nowIso = this.isoNow()
    const row: LicenseRow = {
      ...existing,
      starts_at: start,
      ends_at: end,
      // Renewing a suspended or expired licence reactivates it; revoking is a deliberate separate action.
      status: existing.status === 'revoked' ? 'revoked' : 'active',
      notify_now_at: input.notifyNow ? nowIso : existing.notify_now_at,
      revision: existing.revision + 1,
      updated_at: nowIso,
    }
    this.updateRow(row)
    // A new term starts its reminders fresh; the previous stage would otherwise silence the next term's warnings.
    this.database.prepare('UPDATE licenses SET reminder_stage = NULL WHERE id = ?').run(id)
    this.history(id, actor, 'license.renewed', { startsAt: start, endsAt: end, previousEnd: existing.ends_at, notifyNow: input.notifyNow === true })
    this.audit(actor, 'license.renewed', id, { endsAt: end })
    return row
  }

  /** Revoking is permanent; a revoked licence keeps its history and is never reactivated. */
  revoke(id: string, actor: string): LicenseRow {
    const existing = this.getLicense(id)
    const nowIso = this.isoNow()
    const row: LicenseRow = {
      ...existing,
      status: 'revoked',
      notify_now_at: nowIso,
      revision: existing.revision + 1,
      updated_at: nowIso,
    }
    this.updateRow(row)
    this.history(id, actor, 'license.revoked', {})
    this.audit(actor, 'license.revoked', id, {})
    return row
  }

  /**
   * A short, single-use code for reading the activation key over the phone. It is stored only with its
   * expiry in the licence history, is shown once in the portal, and authenticates nothing by itself.
   */
  generateActivationCode(id: string, actor: string): string {
    this.getLicense(id)
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    const bytes = randomBytes(8)
    let code = ''
    for (const byte of bytes) code += alphabet[byte % alphabet.length]
    const shown = `${code.slice(0, 4)}-${code.slice(4, 8)}`
    const expiresAt = new Date(this.now() + 15 * 60_000).toISOString()
    this.history(id, actor, 'license.activation_code', { code: shown, expiresAt })
    this.audit(actor, 'license.activation_code', id, { expiresAt })
    return shown
  }

  setStatus(id: string, status: 'active' | 'suspended', actor: string): LicenseRow {
    const existing = this.getLicense(id)
    if (existing.status === 'revoked') throw new LicenseError('invalid', 'A revoked licence cannot be changed. Issue a new licence instead.')
    const nowIso = this.isoNow()
    const row: LicenseRow = {
      ...existing,
      status,
      notify_now_at: nowIso,
      revision: existing.revision + 1,
      updated_at: nowIso,
    }
    this.updateRow(row)
    this.history(id, actor, status === 'suspended' ? 'license.suspended' : 'license.unsuspended', {})
    this.audit(actor, status === 'suspended' ? 'license.suspended' : 'license.unsuspended', id, {})
    return row
  }

  setEdition(id: string, edition: Edition, actor: string): LicenseRow {
    const existing = this.getLicense(id)
    const row: LicenseRow = { ...existing, edition, notify_now_at: this.isoNow(), revision: existing.revision + 1, updated_at: this.isoNow() }
    this.updateRow(row)
    this.history(id, actor, 'license.edition_changed', { edition, previous: existing.edition })
    this.audit(actor, 'license.edition_changed', id, { edition })
    return row
  }

  setEntitlements(id: string, input: {
    maxAdminPhones?: number
    mobileLan?: boolean
    mobileInternet?: boolean
    graceDays?: number
    defaultCurrencyCode?: string | null
    lockCurrency?: boolean
  }, actor: string): LicenseRow {
    const existing = this.getLicense(id)
    const phones = input.maxAdminPhones ?? existing.max_admin_phones
    if (!Number.isInteger(phones) || phones < 1 || phones > 100) throw new LicenseError('invalid', 'The Admin phone limit must be a whole number from 1 to 100.')
    const currency = input.defaultCurrencyCode === undefined ? existing.default_currency : normaliseCurrencyCode(input.defaultCurrencyCode)
    const lockCurrency = input.lockCurrency ?? existing.lock_currency === 1
    if (lockCurrency && !currency) throw new LicenseError('invalid', 'Choose a default currency before locking the currency.')
    const graceDays = input.graceDays ?? existing.grace_days
    if (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > 30) throw new LicenseError('invalid', 'The grace period must be 0 to 30 days.')
    const row: LicenseRow = {
      ...existing,
      max_admin_phones: phones,
      mobile_lan: (input.mobileLan ?? existing.mobile_lan === 1) ? 1 : 0,
      mobile_internet: (input.mobileInternet ?? existing.mobile_internet === 1) ? 1 : 0,
      grace_days: graceDays,
      default_currency: currency,
      lock_currency: lockCurrency ? 1 : 0,
      notify_now_at: this.isoNow(),
      revision: existing.revision + 1,
      updated_at: this.isoNow(),
    }
    this.updateRow(row)
    this.history(id, actor, 'license.entitlements_changed', {
      maxAdminPhones: phones, mobileLan: row.mobile_lan === 1, mobileInternet: row.mobile_internet === 1,
      graceDays, defaultCurrency: currency, lockCurrency,
    })
    this.audit(actor, 'license.entitlements_changed', id, {})
    return row
  }

  /**
   * Rebinding is the vendor's decision alone. It clears the machine binding **and** the delivered revision so
   * the new PC is not silently given the old machine's token on the next poll.
   */
  rebindMachine(id: string, actor: string): LicenseRow {
    const existing = this.getLicense(id)
    const row: LicenseRow = {
      ...existing,
      machine_id: null,
      machine_bound_at: null,
      delivered_revision: -1,
      notify_now_at: this.isoNow(),
      revision: existing.revision + 1,
      updated_at: this.isoNow(),
    }
    this.updateRow(row)
    this.history(id, actor, 'license.machine_rebound', { previousMachine: existing.machine_id })
    this.audit(actor, 'license.machine_rebound', id, {})
    return row
  }

  private updateRow(row: LicenseRow): void {
    this.database.prepare(`
      UPDATE licenses SET edition = @edition, starts_at = @starts_at, ends_at = @ends_at, status = @status,
        max_admin_phones = @max_admin_phones, mobile_lan = @mobile_lan, mobile_internet = @mobile_internet,
        default_currency = @default_currency, lock_currency = @lock_currency, grace_days = @grace_days,
        machine_id = @machine_id, machine_bound_at = @machine_bound_at, source = @source,
        onsite_reported_at = @onsite_reported_at, onsite_owner_machine = @onsite_owner_machine,
        revision = @revision, delivered_revision = @delivered_revision, last_checkin_at = @last_checkin_at,
        last_app_version = @last_app_version, last_platform = @last_platform, notify_now_at = @notify_now_at,
        updated_at = @updated_at
      WHERE id = @id
    `).run(row)
  }

  // ------------------------------------------------------------------ activation

  /**
   * Activation: key + machine in, signed token out. The key is checked against the licence row and the machine
   * binding is applied on first use only; a second machine is refused until the vendor rebinds.
   */
  activate(input: { licenseKey: string; machineId: string; appVersion: string; platform: string; ipAddress: string | null }): ActivationResult {
    const nowIso = this.isoNow()
    const key = normaliseKey(input.licenseKey)
    const machineId = requireMachineId(input.machineId)
    if (!key) {
      this.recordAttempt(hashKey(input.licenseKey), 'invalid_format', machineId, input.ipAddress)
      throw new LicenseError('invalid_key', 'Enter a valid activation key.')
    }
    this.assertWithinActivationLimits(key, input.ipAddress)

    const license = this.findLicenseByKey(key)
    if (!license) {
      this.recordAttempt(hashKey(key), 'unknown_key', machineId, input.ipAddress)
      throw new LicenseError('unknown_key', 'The activation key was not accepted.')
    }
    const failure = this.bindingFailure(license, machineId)
    if (failure) {
      this.recordAttempt(hashKey(key), failure, machineId, input.ipAddress)
      throw new LicenseError(failure, activationMessage(failure))
    }

    return this.database.transaction(() => {
      // Re-read inside the transaction: two activations racing on the same key must not both bind.
      const fresh = this.getLicense(license.id)
      if (!fresh.machine_id) {
        fresh.machine_id = machineId
        fresh.machine_bound_at = nowIso
      }
      fresh.last_checkin_at = nowIso
      fresh.last_app_version = clean(input.appVersion, 64)
      fresh.last_platform = clean(input.platform, 80)
      fresh.updated_at = nowIso
      if (fresh.source !== 'onsite') fresh.source = 'online'
      this.updateRow(fresh)
      this.recordCheckin(fresh.id, machineId, fresh.last_app_version ?? '', fresh.last_platform ?? '', nowIso, input.ipAddress)
      const token = signLicenseToken(this.identity, this.claimsFor(fresh, nowIso))
      fresh.delivered_revision = fresh.revision
      this.updateRow(fresh)
      this.history(fresh.id, 'device', 'license.activated', { machineId })
      this.recordAttempt(hashKey(key), 'activated', machineId, input.ipAddress)
      this.audit('device', 'license.activated', fresh.id, { machineId })
      return { token, serverNow: nowIso, licenseId: fresh.id }
    })()
  }

  /**
   * Check-in: refresh the delivery watermark, record the visit, and hand back a freshly signed token only when
   * the vendor changed something. On-site licences are reported here too, which is how a licence issued
   * offline on the PC becomes visible (and suspendable) in the portal.
   */
  checkIn(input: CheckInInput): CheckInResult {
    const nowIso = this.isoNow()
    const machineId = requireMachineId(input.machineId)
    let license = this.getLicense(input.licenseId)

    if (input.source === 'onsite') {
      license = this.reconcileOnsiteReport(license, machineId, input, nowIso)
    }

    if (license.machine_id && license.machine_id !== machineId) {
      throw new LicenseError('conflict', 'This licence is bound to a different machine. Ask the vendor to rebind it.')
    }
    if (!license.machine_id) {
      license = { ...license, machine_id: machineId, machine_bound_at: nowIso }
    }
    license.last_checkin_at = nowIso
    license.last_app_version = clean(input.appVersion, 64)
    license.last_platform = clean(input.platform, 80)
    license.updated_at = nowIso
    this.updateRow(license)
    this.recordCheckin(license.id, machineId, license.last_app_version ?? '', license.last_platform ?? '', nowIso, input.ipAddress)

    // Nothing to deliver: the PC already holds this revision.
    if (license.delivered_revision >= license.revision) {
      return { updated: false, reported: true, token: null, serverNow: nowIso }
    }
    const token = signLicenseToken(this.identity, this.claimsFor(license, nowIso))
    this.database.prepare('UPDATE licenses SET delivered_revision = revision, notify_now_at = NULL WHERE id = ?').run(license.id)
    return { updated: true, reported: true, token, serverNow: nowIso }
  }

  /**
   * An on-site licence was issued with the vendor master password on the PC itself. Recording it here means the
   * vendor can see it, suspend it and replace it — but the PC's own token never overwrites a vendor decision.
   */
  private reconcileOnsiteReport(license: LicenseRow, machineId: string, input: CheckInInput, nowIso: string): LicenseRow {
    const reported = input.onsiteLicense
    if (!reported) throw new LicenseError('invalid', 'The on-site licence report is incomplete.')
    if (license.source === 'onsite' && license.status === 'revoked') {
      throw new LicenseError('revoked', 'This licence has been revoked by the vendor.')
    }
    if (license.machine_id && license.machine_id !== machineId) {
      throw new LicenseError('conflict', 'This on-site licence was reported from a different machine.')
    }
    if (license.source !== 'onsite') {
      throw new LicenseError('invalid', 'This licence is not an on-site licence.')
    }
    // The vendor's term and status win once the licence has been reported and then edited. A first report
    // records what the PC actually issued, so the portal shows the truth rather than an empty licence.
    if (license.onsite_reported_at === null) {
      license = {
        ...license,
        starts_at: reported.startsAt,
        ends_at: reported.endsAt,
        edition: reported.edition,
        grace_days: reported.graceDays,
        max_admin_phones: reported.adminPhoneLimit,
        mobile_lan: reported.features.mobileLan ? 1 : 0,
        mobile_internet: reported.features.mobileInternet ? 1 : 0,
        onsite_reported_at: nowIso,
        onsite_owner_machine: machineId,
      }
    }
    license = { ...license, last_checkin_at: nowIso }
    this.history(license.id, 'device', 'license.onsite_reported', { machineId, endsAt: reported.endsAt })
    this.audit('device', 'license.onsite_reported', license.id, { machineId })
    return license
  }

  /** The token claims, always derived from the licence row so a portal edit is the only way to change them. */
  claimsFor(license: LicenseRow, issuedAt: string): LicenseClaims {
    return {
      licenseId: license.id,
      machineId: license.machine_id ?? '',
      edition: license.edition,
      startsAt: license.starts_at,
      endsAt: license.ends_at,
      issuedAt,
      status: tokenStatus(license.status),
      source: license.source,
      defaultCurrencyCode: license.default_currency,
      lockCurrency: license.lock_currency === 1,
      features: { mobileLan: license.mobile_lan === 1, mobileInternet: license.mobile_internet === 1 },
      adminPhoneLimit: license.max_admin_phones,
      graceDays: license.grace_days,
    }
  }

  /** An offline licence file is the same signed token, for a machine the vendor names in advance. */
  offlineFile(id: string, machineId: string, actor: string): { token: string; fileName: string; license: LicenseRow } {
    const machine = requireMachineId(machineId)
    const license = this.getLicense(id)
    if (license.status === 'revoked') throw new LicenseError('invalid', 'A revoked licence cannot be downloaded.')
    this.database.transaction(() => {
      const row: LicenseRow = { ...license, machine_id: machine, machine_bound_at: this.isoNow(), updated_at: this.isoNow() }
      this.updateRow(row)
      this.history(id, actor, 'license.file_downloaded', { machineId: machine })
      this.audit(actor, 'license.file_downloaded', id, { machineId: machine })
    })()
    const fresh = this.getLicense(id)
    const token = signLicenseToken(this.identity, this.claimsFor(fresh, this.isoNow()))
    const label = fresh.license_key.replace(/[^A-Z0-9-]/gu, '')
    return { token, fileName: `infoflex-${label}-${machine.slice(0, 8)}.lic`, license: fresh }
  }

  private bindingFailure(license: LicenseRow, machineId: string): ActivationRejection | null {
    if (license.status === 'revoked') return 'revoked'
    if (license.status === 'suspended') return 'suspended'
    const nowMs = this.now()
    if (Date.parse(license.starts_at) > nowMs) return 'not_yet_valid'
    // An expired licence still activates: the PC must be able to activate and then show the renewal screen
    // rather than failing with "key not accepted". The token itself carries the end date, and the desktop
    // refuses to run once it passes.
    if (license.machine_id && license.machine_id !== machineId) return 'machine_conflict'
    return null
  }

  private assertWithinActivationLimits(key: string, ipAddress: string | null): void {
    const since = new Date(this.now() - this.limits.windowMinutes * 60_000).toISOString()
    const keyCount = (this.database.prepare(
      'SELECT COUNT(*) AS count FROM activation_attempts WHERE license_key_hash = ? AND created_at >= ?',
    ).get(hashKey(key), since) as { count: number }).count
    const ipCount = ipAddress
      ? (this.database.prepare(
          'SELECT COUNT(*) AS count FROM activation_attempts WHERE ip_address = ? AND created_at >= ?',
        ).get(ipAddress, since) as { count: number }).count
      : 0
    if (keyCount >= this.limits.perKey || ipCount >= this.limits.perIp) {
      this.recordAttempt(hashKey(key), 'rate_limited', null, ipAddress)
      throw new LicenseError('rate_limited', 'Too many activation attempts. Wait a few minutes and try again.')
    }
  }

  private recordAttempt(keyHash: string, outcome: string, machineId: string | null, ipAddress: string | null): void {
    this.database.prepare(
      'INSERT INTO activation_attempts (license_key_hash, ip_address, outcome, machine_id, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(keyHash, ipAddress, outcome, machineId, this.isoNow())
  }

  private recordCheckin(licenseId: string, machineId: string, appVersion: string, platform: string, at: string, ip: string | null): void {
    this.database.prepare(
      'INSERT INTO checkins (license_id, machine_id, app_version, platform, checked_at, online, ip_address) VALUES (?, ?, ?, ?, ?, 1, ?)',
    ).run(licenseId, machineId, appVersion, platform, at, ip)
  }

  // ------------------------------------------------------------------ history & audit

  listCheckIns(licenseId: string, limit = 50): Array<{ machine_id: string; app_version: string; platform: string; checked_at: string; ip_address: string | null }> {
    return this.database.prepare(`
      SELECT machine_id, app_version, platform, checked_at, ip_address FROM checkins
      WHERE license_id = ? ORDER BY checked_at DESC, id DESC LIMIT ?
    `).all(licenseId, Math.min(Math.max(limit, 1), 500)) as Array<{ machine_id: string; app_version: string; platform: string; checked_at: string; ip_address: string | null }>
  }

  listHistory(licenseId: string, limit = 100): LicenseHistoryEntry[] {
    const rows = this.database.prepare(
      'SELECT actor, action, detail_json, created_at FROM license_history WHERE license_id = ? ORDER BY id DESC LIMIT ?',
    ).all(licenseId, Math.min(Math.max(limit, 1), 500)) as Array<{ actor: string; action: string; detail_json: string; created_at: string }>
    return rows.map((row) => ({ actor: row.actor, action: row.action, detail: safeJson(row.detail_json), created_at: row.created_at }))
  }

  private history(licenseId: string, actor: string, action: string, detail: Record<string, unknown>): void {
    this.database.prepare(
      'INSERT INTO license_history (license_id, actor, action, detail_json, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(licenseId, actor, action, JSON.stringify(detail), this.isoNow())
  }

  audit(actor: string, action: string, target: string | null, detail: Record<string, unknown>, ipAddress: string | null = null): void {
    this.database.prepare(
      'INSERT INTO audit_log (actor, action, target, ip_address, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(actor, action, target, ipAddress, JSON.stringify(detail), this.isoNow())
  }

  listAudit(limit = 200): Array<{ actor: string; action: string; target: string | null; ip_address: string | null; detail: Record<string, unknown>; created_at: string }> {
    const rows = this.database.prepare(
      'SELECT actor, action, target, ip_address, detail_json, created_at FROM audit_log ORDER BY id DESC LIMIT ?',
    ).all(Math.min(Math.max(limit, 1), 1_000)) as Array<{ actor: string; action: string; target: string | null; ip_address: string | null; detail_json: string; created_at: string }>
    return rows.map((row) => ({ ...row, detail: safeJson(row.detail_json) }))
  }

  /** The dashboard's expiry buckets. */
  expiringSoon(): { in7: LicenseView[]; in14: LicenseView[]; in30: LicenseView[] } {
    const all = this.listLicenses().filter((license) => license.effective_status === 'active' || license.effective_status === 'expiring')
    return {
      in7: all.filter((license) => license.days_remaining <= 7),
      in14: all.filter((license) => license.days_remaining <= 14),
      in30: all.filter((license) => license.days_remaining <= 30),
    }
  }

  isoNow(): string {
    return new Date(this.now()).toISOString()
  }
}

// -------------------------------------------------------------------- helpers

function matchesFilter(view: LicenseView, filter: string | undefined): boolean {
  switch (filter) {
    case 'active': return view.effective_status === 'active'
    case 'expiring': return view.effective_status === 'expiring'
    case 'expired': return view.effective_status === 'expired'
    case 'suspended': return view.effective_status === 'suspended'
    case 'revoked': return view.effective_status === 'revoked'
    case 'online': return view.online_now
    case 'onsite': return view.source === 'onsite'
    case 'relay': return view.relay_status === 'online'
    default: return true
  }
}

function tokenStatus(status: LicenseStatus): SignedLicenseStatus {
  if (status === 'suspended') return 'suspended'
  if (status === 'revoked') return 'revoked'
  // 'expired' is a calendar fact the desktop evaluates against the signed end date; the vendor's own
  // decision is only ever active/suspended/revoked, so an expired-but-not-suspended licence stays 'active'
  // in the token and the desktop applies the date itself. This keeps "renew" working without a re-issue.
  return 'active'
}

function activationMessage(reason: ActivationRejection): string {
  switch (reason) {
    case 'unknown_key': return 'The activation key was not accepted.'
    case 'suspended': return 'This licence is suspended. Contact your vendor.'
    case 'revoked': return 'This licence has been revoked. Contact your vendor.'
    case 'not_yet_valid': return 'This licence has not started yet. Check the start date in the portal.'
    case 'expired': return 'This licence has expired. Renew it in the portal, then activate again.'
    case 'machine_conflict': return 'This licence is already in use on another computer. Ask the vendor to rebind it.'
    case 'rate_limited': return 'Too many activation attempts. Wait a few minutes and try again.'
    default: return 'The activation key was not accepted.'
  }
}

function hashCode(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Activation attempts are keyed by a hash, never by the key itself: the audit trail must not leak keys. */
function hashKey(value: string): string {
  return hashCode(`activation:${(value ?? '').trim().toUpperCase()}`)
}

function normaliseKey(value: string): string | null {
  const key = String(value ?? '').trim().toUpperCase().replace(/\s+/gu, '')
  return /^IFX-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/u.test(key) ? key : null
}

export function requireMachineId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-fA-F0-9-]{16,128}$/u.test(value)) {
    throw new LicenseError('invalid', 'The machine ID is missing or not valid.')
  }
  return value
}

function normaliseCurrencyCode(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null
  const code = String(value).trim().toUpperCase()
  if (!/^[A-Z0-9]{3,8}$/u.test(code)) throw new LicenseError('invalid', 'The currency code looks wrong. Use the ISO code, for example NGN.')
  return code
}

function requireText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new LicenseError('invalid', `Enter the ${label.toLowerCase()}.`)
  const text = value.trim()
  if (text.length > maxLength) throw new LicenseError('invalid', `The ${label.toLowerCase()} is too long.`)
  return text
}

function clean(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '').trim().slice(0, maxLength) : ''
}

/** Dates are calendar days in the portal and exclusive UTC instants in the token, exactly as the desktop expects. */
function requireDate(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new LicenseError('invalid', `${label} must be a date.`)
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime())) throw new LicenseError('invalid', `${label} must be a real date.`)
  return parsed.toISOString()
}

function safeJson(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}
