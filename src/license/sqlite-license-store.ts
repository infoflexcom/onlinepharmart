import type Database from 'better-sqlite3'
import type { LicenseClaims } from '../shared/license/types'

export interface StoredLicenseState {
  licenseId: string
  token: string
  machineId: string
  edition: LicenseClaims['edition']
  startsAt: string
  endsAt: string
  status: LicenseClaims['status']
  source: LicenseClaims['source']
  defaultCurrencyCode: string | null
  lockCurrency: boolean
  lastOnlineCheck: string | null
  reportedToPortal: boolean
  features: LicenseClaims['features']
  adminPhoneLimit: number
  graceDays: number
  history: readonly unknown[]
  dataCorrupt: boolean
}

export interface LicenseRuntimeRecord {
  currentLicenseId: string | null
  lastTrustedTime: string | null
  integrityTag: string | null
}

export interface LicenseVendorConfig {
  masterPasswordHash: string | null
  maximumOnsitePeriodYears: number | null
  trustedEd25519Keys: Record<string, string>
  licenseServerUrl: string | null
  /** `wss://relay.example.com` when the vendor's licence server offers an internet relay, else null. */
  relayUrl: string | null
  policyIntegrityTag: string | null
  passwordFailures: number
  passwordBlockedUntil: number | null
  keyFailures: number
  keyBlockedUntil: number | null
}

export interface LicenseHistoryEvent {
  licenseId: string | null
  eventType: string
  occurredAt: string
  machineId: string | null
  source: LicenseClaims['source'] | null
  claims: Partial<LicenseClaims> | Record<string, unknown>
  token: string | null
  detail: Record<string, unknown>
}

interface LicenseRow {
  license_id: string
  token: string
  machine_id: string
  edition: LicenseClaims['edition']
  start: string
  end: string
  status: LicenseClaims['status']
  source: LicenseClaims['source']
  default_currency: string | null
  lock_currency: number
  last_online_check: string | null
  reported_to_portal: number
  features_json: string
  admin_phone_limit: number
  grace_days: number
  history: string
}

interface RuntimeRow {
  current_license_id: string | null
  last_trusted_time: string | null
  integrity_tag: string | null
}

interface VendorConfigRow {
  master_password_hash: string | null
  maximum_onsite_period_years: number | null
  trusted_ed25519_keys_json: string
  license_server_url: string | null
  relay_url: string | null
  policy_integrity_tag: string | null
  password_failures: number
  password_blocked_until: number | null
  key_failures: number
  key_blocked_until: number | null
}

export class SQLiteLicenseStore {
  constructor(private readonly database: Database.Database) {}

  getCurrent(): StoredLicenseState | null {
    const row = this.database.prepare(`
      SELECT license_id, token, machine_id, edition, start, end, status, source,
        default_currency, lock_currency, last_online_check, reported_to_portal,
        features_json, admin_phone_limit, grace_days, history
      FROM license_state WHERE is_current = 1 LIMIT 1
    `).get() as LicenseRow | undefined
    if (!row) return null
    let features: LicenseClaims['features'] = { mobileLan: false, mobileInternet: false }
    let history: unknown[] = []
    let dataCorrupt = false
    try {
      const parsedFeatures = JSON.parse(row.features_json) as unknown
      const parsedHistory = JSON.parse(row.history) as unknown
      if (!parsedFeatures || typeof parsedFeatures !== 'object' || Array.isArray(parsedFeatures)
        || typeof (parsedFeatures as Record<string, unknown>).mobileLan !== 'boolean'
        || typeof (parsedFeatures as Record<string, unknown>).mobileInternet !== 'boolean'
        || !Array.isArray(parsedHistory)) {
        dataCorrupt = true
      } else {
        features = {
          mobileLan: (parsedFeatures as LicenseClaims['features']).mobileLan,
          mobileInternet: (parsedFeatures as LicenseClaims['features']).mobileInternet,
        }
        history = parsedHistory
      }
    } catch {
      dataCorrupt = true
    }
    return {
      licenseId: row.license_id,
      token: row.token,
      machineId: row.machine_id,
      edition: row.edition,
      startsAt: row.start,
      endsAt: row.end,
      status: row.status,
      source: row.source,
      defaultCurrencyCode: row.default_currency,
      lockCurrency: row.lock_currency === 1,
      lastOnlineCheck: row.last_online_check,
      reportedToPortal: row.reported_to_portal === 1,
      features,
      adminPhoneLimit: row.admin_phone_limit,
      graceDays: row.grace_days,
      history,
      dataCorrupt,
    }
  }

  getRuntime(): LicenseRuntimeRecord {
    const row = this.database.prepare(`
      SELECT current_license_id, last_trusted_time, integrity_tag FROM license_runtime WHERE id = 1
    `).get() as RuntimeRow
    return {
      currentLicenseId: row.current_license_id,
      lastTrustedTime: row.last_trusted_time,
      integrityTag: row.integrity_tag,
    }
  }

  getVendorConfig(): LicenseVendorConfig {
    const row = this.database.prepare(`
      SELECT master_password_hash, maximum_onsite_period_years, trusted_ed25519_keys_json,
        license_server_url, relay_url, policy_integrity_tag, password_failures, password_blocked_until,
        key_failures, key_blocked_until
      FROM license_vendor_config WHERE id = 1
    `).get() as VendorConfigRow
    let trustedEd25519Keys: Record<string, string> = {}
    try {
      const parsed = JSON.parse(row.trusted_ed25519_keys_json) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) trustedEd25519Keys = parsed as Record<string, string>
    } catch {
      trustedEd25519Keys = {}
    }
    return {
      masterPasswordHash: row.master_password_hash,
      maximumOnsitePeriodYears: row.maximum_onsite_period_years,
      trustedEd25519Keys,
      licenseServerUrl: row.license_server_url,
      relayUrl: row.relay_url ?? null,
      policyIntegrityTag: row.policy_integrity_tag,
      passwordFailures: row.password_failures,
      passwordBlockedUntil: row.password_blocked_until,
      keyFailures: row.key_failures,
      keyBlockedUntil: row.key_blocked_until,
    }
  }

  saveVendorConfig(input: {
    masterPasswordHash: string | null
    maximumOnsitePeriodYears: number | null
    trustedEd25519Keys: Record<string, string>
    licenseServerUrl: string | null
    relayUrl?: string | null
    policyIntegrityTag: string | null
  }): void {
    this.database.prepare(`
      UPDATE license_vendor_config SET
        master_password_hash = @masterPasswordHash,
        maximum_onsite_period_years = @maximumOnsitePeriodYears,
        trusted_ed25519_keys_json = @trustedEd25519Keys,
        license_server_url = @licenseServerUrl,
        relay_url = @relayUrl,
        policy_integrity_tag = @policyIntegrityTag,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `).run({
      masterPasswordHash: input.masterPasswordHash,
      maximumOnsitePeriodYears: input.maximumOnsitePeriodYears,
      trustedEd25519Keys: JSON.stringify(input.trustedEd25519Keys),
      licenseServerUrl: input.licenseServerUrl,
      relayUrl: input.relayUrl ?? null,
      policyIntegrityTag: input.policyIntegrityTag,
    })
  }

  /**
   * Remembers the vendor's relay address, if the licence server published one. Called after a successful
   * activation or check-in, which is the only place the desktop ever learns it — there is no field for a shop to
   * mistype and no default that would silently point at somebody else's relay.
   */
  setRelayUrl(relayUrl: string | null): void {
    this.database.prepare('UPDATE license_vendor_config SET relay_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1')
      .run(relayUrl)
  }

  saveLicense(input: {
    claims: LicenseClaims
    token: string
    lastOnlineCheck: string | null
    reportedToPortal: boolean
    lastTrustedTime: string
    integrityTag: string
    event: LicenseHistoryEvent
  }): void {
    const transaction = this.database.transaction(() => {
      const oldCurrent = this.getCurrent()
      const history = oldCurrent?.licenseId === input.claims.licenseId ? [...oldCurrent.history] : []
      history.push({
        eventType: input.event.eventType,
        occurredAt: input.event.occurredAt,
        claims: input.claims,
        token: input.token,
      })
      this.database.prepare('UPDATE license_state SET is_current = 0 WHERE is_current = 1').run()
      this.database.prepare(`
        INSERT INTO license_state (
          license_id, token, machine_id, edition, start, end, status, source,
          default_currency, lock_currency, last_online_check, reported_to_portal,
          history, is_current, features_json, admin_phone_limit, grace_days
        ) VALUES (
          @licenseId, @token, @machineId, @edition, @startsAt, @endsAt, @status, @source,
          @defaultCurrencyCode, @lockCurrency, @lastOnlineCheck, @reportedToPortal,
          @history, 1, @features, @adminPhoneLimit, @graceDays
        )
        ON CONFLICT(license_id) DO UPDATE SET
          token = excluded.token,
          machine_id = excluded.machine_id,
          edition = excluded.edition,
          start = excluded.start,
          end = excluded.end,
          status = excluded.status,
          source = excluded.source,
          default_currency = excluded.default_currency,
          lock_currency = excluded.lock_currency,
          last_online_check = excluded.last_online_check,
          reported_to_portal = excluded.reported_to_portal,
          history = excluded.history,
          is_current = 1,
          features_json = excluded.features_json,
          admin_phone_limit = excluded.admin_phone_limit,
          grace_days = excluded.grace_days
      `).run({
        licenseId: input.claims.licenseId,
        token: input.token,
        machineId: input.claims.machineId,
        edition: input.claims.edition,
        startsAt: input.claims.startsAt,
        endsAt: input.claims.endsAt,
        status: input.claims.status,
        source: input.claims.source,
        defaultCurrencyCode: input.claims.defaultCurrencyCode,
        lockCurrency: input.claims.lockCurrency ? 1 : 0,
        lastOnlineCheck: input.lastOnlineCheck,
        reportedToPortal: input.reportedToPortal ? 1 : 0,
        history: JSON.stringify(history),
        features: JSON.stringify(input.claims.features),
        adminPhoneLimit: input.claims.adminPhoneLimit,
        graceDays: input.claims.graceDays,
      })
      this.database.prepare(`
        UPDATE license_runtime SET current_license_id = ?, last_trusted_time = ?, integrity_tag = ? WHERE id = 1
      `).run(input.claims.licenseId, input.lastTrustedTime, input.integrityTag)
      this.insertHistory(input.event)
    })
    transaction.immediate()
  }

  updateRuntime(lastTrustedTime: string, integrityTag: string): void {
    this.database.prepare(`
      UPDATE license_runtime SET last_trusted_time = ?, integrity_tag = ? WHERE id = 1
    `).run(lastTrustedTime, integrityTag)
  }

  clearCurrentLicense(): void {
    const transaction = this.database.transaction(() => {
      this.database.prepare('UPDATE license_state SET is_current = 0 WHERE is_current = 1').run()
      this.database.prepare(`
        UPDATE license_runtime SET current_license_id = NULL, last_trusted_time = NULL, integrity_tag = NULL WHERE id = 1
      `).run()
    })
    transaction.immediate()
  }

  saveFailureState(kind: 'password' | 'key', failures: number, blockedUntil: number | null): void {
    if (kind === 'password') {
      this.database.prepare(`
        UPDATE license_vendor_config SET password_failures = ?, password_blocked_until = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1
      `).run(failures, blockedUntil)
    } else {
      this.database.prepare(`
        UPDATE license_vendor_config SET key_failures = ?, key_blocked_until = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1
      `).run(failures, blockedUntil)
    }
  }

  getHistory(limit = 500): LicenseHistoryEvent[] {
    const safeLimit = Math.max(1, Math.min(2_000, Math.floor(limit)))
    const rows = this.database.prepare(`
      SELECT license_id, event_type, occurred_at, machine_id, source, claims_json, token, detail_json
      FROM license_history ORDER BY id DESC LIMIT ?
    `).all(safeLimit) as Array<{
      license_id: string | null; event_type: string; occurred_at: string; machine_id: string | null
      source: LicenseClaims['source'] | null; claims_json: string; token: string | null; detail_json: string
    }>
    return rows.map((row) => ({
      licenseId: row.license_id,
      eventType: row.event_type,
      occurredAt: row.occurred_at,
      machineId: row.machine_id,
      source: row.source,
      claims: parseJsonObject(row.claims_json),
      token: row.token,
      detail: parseJsonObject(row.detail_json),
    }))
  }

  private insertHistory(event: LicenseHistoryEvent): void {
    const insertEvent = this.database.prepare(`
      INSERT INTO license_history (license_id, event_type, occurred_at, machine_id, source, claims_json, token, detail_json)
      VALUES (@licenseId, @eventType, @occurredAt, @machineId, @source, @claims, @token, @detail)
    `)
    insertEvent.run({
      licenseId: event.licenseId,
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      machineId: event.machineId,
      source: event.source,
      claims: JSON.stringify(event.claims),
      token: event.token,
      detail: JSON.stringify(event.detail),
    })

    this.database.prepare(`
      INSERT INTO audit_log (id, actor, action, metadata_json, device_name, ip_address, created_at)
      VALUES (@id, 'LICENSE_HOST', @action, @metadata, 'LOCAL_DESKTOP', NULL, @occurredAt)
    `).run({
      id: `license-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      action: event.eventType,
      metadata: JSON.stringify({ licenseId: event.licenseId, source: event.source, ...event.detail }),
      occurredAt: event.occurredAt,
    })
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}
