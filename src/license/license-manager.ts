import { createPublicKey, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { LicensePolicyProvider, VerifiedLicensePolicy } from './setup-policy'
import { isEdition } from '../editions'
import { getCurrency } from '../currency/catalog'
import { isLicenseDateActive, assertLicensePeriod, dateInputToUtc } from './dates'
import {
  canonicalize,
  constantTimeEqual,
  createLocalHmacLicenseToken,
  hmacSha256,
  toLicenseEnvelope,
  verifyLicenseToken,
} from './crypto'
import { SQLiteLicenseStore, type LicenseHistoryEvent, type LicenseVendorConfig, type StoredLicenseState } from './sqlite-license-store'
import type { LicenseSecretStore } from './secret-store'
import { HttpLicenseServerClient, type LicenseCheckInRequest, type LicenseServerClient } from './server-client'
import {
  normalizeOptionalServerUrl,
  parseVendorPolicyFile,
  verifyMasterPassword,
} from './vendor-policy'
import type {
  LicenseClaims,
  LicenseCheckInResult,
  LicenseRuntimeStatus,
  LicenseSummary,
  OnsiteActivationInput,
  OnlineActivationInput,
} from '../shared/license/types'

const DAY_MS = 24 * 60 * 60 * 1_000
const CLOCK_ROLLBACK_TOLERANCE_MS = 2 * 60 * 1_000
const TRUSTED_TIME_PERSIST_INTERVAL_MS = 60 * 1_000
const FAILURE_DELAY_BASE_MS = 250
const FAILURE_DELAY_MAX_MS = 30_000
const DEFAULT_DAILY_CHECKIN_MS = 24 * 60 * 60 * 1_000
const DEFAULT_EXPIRED_POLL_MS = 60 * 1_000
const DEFAULT_SCHEDULER_TICK_MS = 15 * 1_000

export interface LicenseManagerOptions {
  machineId: string
  appVersion: string
  platform: string
  secretStore: LicenseSecretStore
  allowLocalMockTrust?: boolean
  serverClient?: LicenseServerClient
  now?: () => number
  delay?: (milliseconds: number) => Promise<void>
  normalCheckInIntervalMs?: number
  expiredCheckInIntervalMs?: number
  schedulerTickMs?: number
}

interface LicenseMaterial {
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
  lastTrustedTime: string
}

interface PolicyMaterial {
  masterPasswordHash: string | null
  maximumOnsitePeriodYears: number | null
  trustedEd25519Keys: Record<string, string>
  licenseServerUrl: string | null
  /** Published by the vendor's licence server; the desktop cannot type its own. */
  relayUrl: string | null
}

export class LicenseManager implements LicensePolicyProvider {
  private readonly store: SQLiteLicenseStore
  private readonly now: () => number
  private readonly delay: (milliseconds: number) => Promise<void>
  private readonly serverClient: LicenseServerClient
  private readonly normalCheckInIntervalMs: number
  private readonly expiredCheckInIntervalMs: number
  private readonly schedulerTickMs: number
  private readonly allowLocalMockTrust: boolean
  private backgroundTimer: ReturnType<typeof setInterval> | null = null
  private backgroundCheckInRunning = false
  private lastCheckInAttemptAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly database: Database.Database,
    private readonly options: LicenseManagerOptions,
  ) {
    this.store = new SQLiteLicenseStore(database)
    this.now = options.now ?? Date.now
    this.delay = options.delay ?? sleep
    this.serverClient = options.serverClient ?? new HttpLicenseServerClient()
    this.normalCheckInIntervalMs = options.normalCheckInIntervalMs ?? DEFAULT_DAILY_CHECKIN_MS
    this.expiredCheckInIntervalMs = options.expiredCheckInIntervalMs ?? DEFAULT_EXPIRED_POLL_MS
    this.schedulerTickMs = options.schedulerTickMs ?? DEFAULT_SCHEDULER_TICK_MS
    this.allowLocalMockTrust = options.allowLocalMockTrust === true
    if (!/^[a-fA-F0-9-]{16,128}$/u.test(options.machineId)) throw new Error('A stable operating-system machine ID is required.')
  }

  initialize(): LicenseSummary {
    return this.getSnapshot()
  }

  async getVerifiedPolicy(): Promise<VerifiedLicensePolicy | null> {
    const snapshot = this.getSnapshot()
    if (!snapshot.canUse || !snapshot.licenseId || !snapshot.edition) return null
    const current = this.store.getCurrent()
    const secret = this.options.secretStore.readExisting()
    if (!current || !secret) return null
    try {
      const { claims } = verifyLicenseToken(current.token, {
        machineId: this.options.machineId,
        trustedEd25519Keys: this.store.getVendorConfig().trustedEd25519Keys,
        localHmacKey: secret,
      })
      return {
        licenseId: claims.licenseId,
        edition: claims.edition,
        defaultCurrencyCode: claims.defaultCurrencyCode,
        lockCurrency: claims.lockCurrency,
      }
    } catch {
      return null
    }
  }

  getSnapshot(): LicenseSummary {
    const config = this.store.getVendorConfig()
    const initial = emptySummary(config)
    const configIntegrity = this.verifyPolicyIntegrity(config)
    if (!configIntegrity) return { ...initial, status: 'tampered', message: 'Vendor license policy is missing or has been changed. Reimport the authorized policy file.' }

    const current = this.store.getCurrent()
    const runtime = this.store.getRuntime()
    if (!current) {
      if (runtime.currentLicenseId || runtime.lastTrustedTime || runtime.integrityTag) {
        return { ...initial, status: 'tampered', message: 'License data is missing or incomplete. Reimport a valid license or contact the vendor.' }
      }
      return initial
    }
    if (current.dataCorrupt) return summaryFromStored(current, config, 'tampered', false, 'Saved license history or feature data is damaged.')
    if (!runtime.currentLicenseId || runtime.currentLicenseId !== current.licenseId || !runtime.lastTrustedTime || !runtime.integrityTag) {
      return summaryFromStored(current, config, 'tampered', false, 'License integrity information is missing. The saved license cannot be trusted.')
    }
    const secret = this.readExistingSecret()
    if (!secret) return summaryFromStored(current, config, 'tampered', false, 'The local secure license authenticator is missing or unavailable.')
    const expectedTag = this.licenseIntegrityTag(current, runtime.lastTrustedTime, secret)
    if (!safeTagMatches(runtime.integrityTag, expectedTag)) {
      return summaryFromStored(current, config, 'tampered', false, 'Saved license data was changed or copied. The license is locked for safety.')
    }

    let claims: LicenseClaims
    try {
      const trustedKeys = this.trustedKeysFor(config)
      claims = verifyLicenseToken(current.token, {
        machineId: this.options.machineId,
        trustedEd25519Keys: trustedKeys,
        localHmacKey: secret,
      }).claims
    } catch (error) {
      const message = safeLicenseVerificationMessage(error)
      const status = message === 'machine_mismatch' ? 'machine_mismatch' : message === 'hmac_key_missing' ? 'tampered' : 'invalid'
      return summaryFromStored(current, config, status, false, statusMessage(status))
    }
    if (!sameStoredClaims(current, claims)) {
      return summaryFromStored(current, config, 'tampered', false, 'The saved license fields do not match the signed token.')
    }

    const lastTrustedMs = Date.parse(runtime.lastTrustedTime)
    const now = this.now()
    if (!Number.isFinite(lastTrustedMs)) return summaryFromStored(current, config, 'tampered', false, 'The saved trusted-clock marker is invalid.')
    if (now + CLOCK_ROLLBACK_TOLERANCE_MS < lastTrustedMs) {
      return summaryFromStored(current, config, 'clock_rollback', false, 'The system clock moved backwards. Correct the clock and check in online or contact the vendor.')
    }
    if (now - lastTrustedMs >= TRUSTED_TIME_PERSIST_INTERVAL_MS) {
      const nextTime = new Date(now).toISOString()
      this.store.updateRuntime(nextTime, this.licenseIntegrityTag(current, nextTime, secret))
    }

    if (claims.status === 'suspended') return summaryFromClaims(current, config, claims, 'suspended', false, statusMessage('suspended'))
    if (claims.status === 'revoked') return summaryFromClaims(current, config, claims, 'revoked', false, statusMessage('revoked'))
    const dateStatus = isLicenseDateActive(claims.startsAt, claims.endsAt, now)
    if (dateStatus === 'not_yet_valid') return summaryFromClaims(current, config, claims, 'not_yet_valid', false, statusMessage('not_yet_valid'))
    if (dateStatus === 'expired') {
      const graceEnd = Date.parse(claims.endsAt) + claims.graceDays * DAY_MS
      if (claims.graceDays > 0 && now < graceEnd) return summaryFromClaims(current, config, claims, 'grace', true, statusMessage('grace'))
      return summaryFromClaims(current, config, claims, 'expired', false, statusMessage('expired'))
    }
    return summaryFromClaims(current, config, claims, 'active', true, statusMessage('active'))
  }

  /**
   * The signed token this installation currently holds, or null when nothing usable is stored. The relay client
   * presents it to the vendor's relay, which checks the signature and the live licence itself.
   */
  getSignedToken(): string | null {
    const current = this.store.getCurrent()
    if (!current?.token) return null
    return this.getSnapshot().canUse ? current.token : null
  }

  /** The vendor's relay address, learned from the licence server. Null when no relay is offered. */
  getRelayUrl(): string | null {
    return this.store.getVendorConfig().relayUrl
  }

  /**
   * Remembers the relay address the licence server published. Only ever called with a value the server itself
   * sent, and only over the verified licence connection, so a shop cannot point its own computer at an
   * attacker's relay by mistyping something.
   */
  setRelayUrl(relayUrl: string | null): void {
    this.store.setRelayUrl(relayUrl)
  }

  getVerifiedClaims(): LicenseClaims | null {
    const summary = this.getSnapshot()
    if (!summary.canUse) return null
    const current = this.store.getCurrent()
    const secret = this.readExistingSecret()
    if (!current || !secret) return null
    try {
      return verifyLicenseToken(current.token, {
        machineId: this.options.machineId,
        trustedEd25519Keys: this.trustedKeysFor(this.store.getVendorConfig()),
        localHmacKey: secret,
      }).claims
    } catch {
      return null
    }
  }

  assertFeature(feature: keyof LicenseClaims['features']): void {
    const claims = this.getVerifiedClaims()
    if (!claims) throw new Error('A valid Infoflex license is required for this action.')
    if (!claims.features[feature]) throw new Error(`This license does not include ${feature === 'mobileLan' ? 'local network' : 'Internet'} mobile access.`)
  }

  assertCanAddAdminPhone(registeredAdminPhones: number): void {
    const claims = this.getVerifiedClaims()
    if (!claims) throw new Error('A valid Infoflex license is required for this action.')
    if (!claims.features.mobileLan && !claims.features.mobileInternet) throw new Error('This license does not include mobile access.')
    if (!Number.isInteger(registeredAdminPhones) || registeredAdminPhones < 0) throw new Error('The registered Admin-phone count is invalid.')
    if (registeredAdminPhones >= claims.adminPhoneLimit) throw new Error('The licensed Admin-phone limit has been reached.')
  }

  assertAdminPhoneCapacityForUser(adminUserId: string): void {
    if (typeof adminUserId !== 'string' || !adminUserId.trim()) throw new Error('An authenticated Admin account is required.')
    // Only approved phones consume a licence slot; a device still waiting for approval has no token and
    // must not be able to block the very approval that would let the shop use its licensed phone.
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM devices
      WHERE admin_user_id = ? AND revoked = 0 AND approved_at IS NOT NULL
    `).get(adminUserId) as { count: number }
    this.assertCanAddAdminPhone(row.count)
  }

  async importVendorPolicyFile(json: string): Promise<void> {
    let policy: ReturnType<typeof parseVendorPolicyFile>
    try {
      policy = parseVendorPolicyFile(json)
    } catch {
      this.recordPolicyImportFailure('invalid_policy')
      throw new Error('The Build Studio policy file is invalid or unsupported.')
    }
    const old = this.store.getVendorConfig()
    const oldPolicyIsIntact = this.verifyPolicyIntegrity(old)
    const current = this.store.getCurrent()
    const incomingPasswordHash = JSON.stringify(policy.masterPasswordHash)

    if (old.masterPasswordHash && oldPolicyIsIntact) {
      this.recordPolicyImportFailure('already_configured')
      throw new Error('A vendor policy is already configured. Use the installed vendor policy or contact Build Studio support.')
    }
    if (old.masterPasswordHash && old.masterPasswordHash !== incomingPasswordHash) {
      this.recordPolicyImportFailure('password_hash_mismatch')
      throw new Error('The imported policy does not match this installation’s master-password hash. Rebinding was refused.')
    }

    let resetLocalSecret = !oldPolicyIsIntact
    if (!resetLocalSecret) {
      try {
        this.options.secretStore.getOrCreate()
      } catch {
        resetLocalSecret = true
      }
    }
    if (resetLocalSecret) {
      this.store.clearCurrentLicense()
      this.options.secretStore.reset()
    }

    const material: PolicyMaterial = {
      masterPasswordHash: incomingPasswordHash,
      maximumOnsitePeriodYears: policy.maximumOnsitePeriodYears,
      trustedEd25519Keys: policy.trustedEd25519Keys,
      licenseServerUrl: policy.licenseServerUrl,
      relayUrl: null,
    }
    this.persistPolicy(material)
    this.recordEvent({
      licenseId: null,
      eventType: resetLocalSecret && current ? 'license.vendor_policy.rebound' : 'license.vendor_policy.imported',
      occurredAt: this.isoNow(),
      machineId: this.options.machineId,
      source: null,
      claims: {},
      token: null,
      detail: {
        maximumOnsitePeriodYears: policy.maximumOnsitePeriodYears,
        trustedKeyCount: Object.keys(policy.trustedEd25519Keys).length,
        serverConfigured: Boolean(policy.licenseServerUrl),
        rebound: resetLocalSecret && current !== null,
      },
    })
  }

  async activateOnsite(input: OnsiteActivationInput): Promise<LicenseSummary> {
    this.assertNoClockRollbackForReplacement()
    const config = this.store.getVendorConfig()
    if (!config.masterPasswordHash || !this.verifyPolicyIntegrity(config)) {
      throw new Error('Configure on-site vendor access or import the authorized Build Studio policy first.')
    }
    this.assertNotBlocked('password', config)
    let correctPassword = false
    try {
      correctPassword = verifyMasterPassword(input.masterPassword, JSON.parse(config.masterPasswordHash))
    } catch {
      correctPassword = false
    }
    if (!correctPassword) {
      await this.recordFailedAttempt('password', 'license.onsite.password.failed', 'invalid_password')
      throw new Error('The vendor master password was not accepted.')
    }
    this.store.saveFailureState('password', 0, null)

    if (!isEdition(input.edition)) throw new Error('Choose a supported Infoflex edition.')
    validateLicenseFeatures(input.features)
    validateAdminPhoneLimit(input.adminPhoneLimit)
    const startsOn = input.startsOn
    const endsOn = input.endsOn
    assertLicensePeriod(startsOn, endsOn, config.maximumOnsitePeriodYears)
    let defaultCurrencyCode = validateDefaultCurrency(input.defaultCurrencyCode)
    if (input.lockCurrency && !defaultCurrencyCode) throw new Error('Choose a default currency before locking the shop currency.')

    const currencyPolicy = this.database.prepare(`
      SELECT currency_code, currency_locked_by_transaction, currency_locked_by_vendor
      FROM settings WHERE id = 1
    `).get() as { currency_code: string; currency_locked_by_transaction: number; currency_locked_by_vendor: number } | undefined
    let lockCurrency = input.lockCurrency
    if (currencyPolicy?.currency_locked_by_transaction === 1) {
      const existingShopCurrency = currencyPolicy.currency_code
      if (defaultCurrencyCode && defaultCurrencyCode !== existingShopCurrency) {
        throw new Error('The shop currency cannot be changed after its first transaction.')
      }
      defaultCurrencyCode = existingShopCurrency
      lockCurrency = lockCurrency || currencyPolicy.currency_locked_by_vendor === 1
    }
    if (lockCurrency && !defaultCurrencyCode) throw new Error('Choose a default currency before locking the shop currency.')

    const now = this.now()
    const claims: LicenseClaims = {
      licenseId: randomUUID(),
      machineId: this.options.machineId,
      edition: input.edition,
      startsAt: dateInputToUtc(startsOn),
      endsAt: dateInputToUtc(endsOn),
      issuedAt: new Date(now).toISOString(),
      status: 'active',
      source: 'onsite',
      defaultCurrencyCode,
      lockCurrency,
      features: { ...input.features },
      adminPhoneLimit: input.adminPhoneLimit,
      graceDays: 0,
    }
    const secret = this.options.secretStore.getOrCreate()
    const token = createLocalHmacLicenseToken(claims, secret)
    this.writeLicense(claims, token, null, false, 'license.onsite.activated', {
      periodYears: elapsedCalendarYears(startsOn, endsOn),
      maximumOnsitePeriodYears: config.maximumOnsitePeriodYears,
      rebound: this.store.getCurrent() !== null,
    })
    if (claims.lockCurrency) this.applyVendorCurrencyLock()
    return this.getSnapshot()
  }

  async activateOnline(input: OnlineActivationInput): Promise<LicenseSummary> {
    this.assertNoClockRollbackForReplacement()
    const activationKey = typeof input.activationKey === 'string' ? input.activationKey.trim() : ''
    if (!activationKey || activationKey.length > 120) throw new Error('Enter a valid activation key.')
    const config = this.store.getVendorConfig()
    if (!this.verifyPolicyIntegrity(config)) throw new Error('Vendor license policy was changed. Reimport the authorized policy before activating.')
    const serverUrl = this.validateServerUrl(input.serverUrl)
    if (config.licenseServerUrl && serverUrl !== config.licenseServerUrl) {
      throw new Error('The license service URL does not match the endpoint configured by the vendor policy.')
    }
    this.assertNotBlocked('key', config)
    let token: string
    let relayUrl: string | null = null
    try {
      await this.loadMockTrustIfAvailable(serverUrl)
      const response = await this.serverClient.activate(serverUrl, {
        activationKey,
        machineId: this.options.machineId,
        appVersion: this.options.appVersion,
        platform: this.options.platform,
      })
      token = response.token
      // The relay address is published by the licence server itself; reading it here is the only way the
      // desktop ever learns it, so a shop cannot be pointed at a relay of somebody else's choosing.
      relayUrl = await this.readPublishedRelayUrl(serverUrl)
    } catch (error) {
      if (isActivationRejected(error)) {
        await this.recordFailedAttempt('key', 'license.activation.online.failed', 'key_rejected')
        throw new Error('The activation key was not accepted.')
      }
      this.recordEvent({
        licenseId: null,
        eventType: 'license.activation.online.failed',
        occurredAt: this.isoNow(),
        machineId: this.options.machineId,
        source: 'online',
        claims: {},
        token: null,
        detail: { reason: 'service_unavailable' },
      })
      throw new Error('Could not contact the license service. Check the connection and try again.')
    }
    let claims: LicenseClaims
    try {
      claims = this.verifyNewToken(token, 'online')
    } catch {
      await this.recordFailedAttempt('key', 'license.activation.online.failed', 'invalid_signed_response')
      throw new Error('The license service returned an invalid or untrusted license.')
    }
    const material = this.currentPolicyMaterial()
    material.licenseServerUrl = serverUrl
    material.relayUrl = relayUrl ?? material.relayUrl
    this.persistPolicy(material)
    this.store.saveFailureState('key', 0, null)
    this.writeLicense(claims, token, null, false, 'license.activation.online.succeeded', { serverUrl })
    if (claims.lockCurrency) this.applyVendorCurrencyLock()
    return this.getSnapshot()
  }

  async importLicenseFile(contents: string): Promise<LicenseSummary> {
    this.assertNoClockRollbackForReplacement()
    let token = ''
    try {
      if (typeof contents !== 'string' || Buffer.byteLength(contents, 'utf8') > 32_768) throw new Error('invalid_file')
      const parsed = JSON.parse(contents) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) token = JSON.stringify(parsed)
      else if (typeof parsed === 'string') token = parsed
      else throw new Error('invalid_file')
      const envelope = toLicenseEnvelope(token)
      if (envelope.algorithm !== 'Ed25519') throw new Error('invalid_file')
      const claims = this.verifyNewToken(token, 'file')
      this.writeLicense(claims, token, null, false, 'license.activation.file.succeeded', { fileType: 'signed_lic' })
      if (claims.lockCurrency) this.applyVendorCurrencyLock()
      return this.getSnapshot()
    } catch {
      this.recordEvent({
        licenseId: null,
        eventType: 'license.activation.file.failed',
        occurredAt: this.isoNow(),
        machineId: this.options.machineId,
        source: 'file',
        claims: {},
        token: null,
        detail: { reason: 'invalid_or_untrusted_file' },
      })
      throw new Error('The .lic file is invalid, expired, for another machine, or not trusted by this installation.')
    }
  }

  async checkInNow(): Promise<LicenseCheckInResult> {
    const checkedAt = this.isoNow()
    try {
      const updated = await this.performCheckIn('manual')
      const summary = this.getSnapshot()
      const terminalStatuses: LicenseRuntimeStatus[] = ['expired', 'suspended', 'revoked', 'tampered', 'invalid', 'machine_mismatch', 'clock_rollback', 'not_yet_valid']
      return {
        checkedAt,
        updated,
        status: summary.status,
        message: terminalStatuses.includes(summary.status)
          ? summary.message
          : updated ? 'License check-in completed and updates were applied.' : 'License check-in completed. No license changes were waiting.',
      }
    } catch (error) {
      const summary = this.getSnapshot()
      const message = error instanceof Error && error.message === 'license_server_not_configured'
        ? 'No license service is configured. Import a Build Studio policy with the service URL or contact your vendor.'
        : error instanceof Error && error.message.startsWith('license_update_')
          ? 'The license service returned an invalid update. The saved license and shop data were not changed.'
          : 'The license service could not be reached. The saved license and shop data were not changed.'
      return {
        checkedAt,
        updated: false,
        status: summary.status,
        message,
      }
    }
  }

  startBackgroundCheckIns(): void {
    if (this.backgroundTimer) return
    void this.performScheduledCheckIn('startup')
    this.backgroundTimer = setInterval(() => void this.performScheduledCheckIn('poll'), this.schedulerTickMs)
    this.backgroundTimer.unref?.()
  }

  stopBackgroundCheckIns(): void {
    if (!this.backgroundTimer) return
    clearInterval(this.backgroundTimer)
    this.backgroundTimer = null
  }

  /** Exposed for deterministic host tests; production invokes this from the scheduler and at launch. */
  async pollCheckInIfDue(): Promise<boolean> {
    const summary = this.getSnapshot()
    if (!summary.licenseId || ['tampered', 'invalid', 'machine_mismatch', 'clock_rollback', 'not_yet_valid'].includes(summary.status)) return false
    const current = this.store.getCurrent()
    if (!current) return false
    const now = this.now()
    const interval = ['expired', 'suspended'].includes(summary.status) ? this.expiredCheckInIntervalMs : this.normalCheckInIntervalMs
    const lastSuccess = current.lastOnlineCheck ? Date.parse(current.lastOnlineCheck) : Number.NEGATIVE_INFINITY
    const last = Math.max(lastSuccess, this.lastCheckInAttemptAt)
    if (now - last < interval) return false
    return this.performCheckIn('poll')
  }

  getLicenseHistory(limit = 500): LicenseHistoryEvent[] {
    return this.store.getHistory(limit)
  }

  private async performScheduledCheckIn(trigger: 'startup' | 'poll'): Promise<void> {
    if (this.backgroundCheckInRunning) return
    this.backgroundCheckInRunning = true
    try {
      const summary = this.getSnapshot()
      const current = this.store.getCurrent()
      if (!current) return
      const interval = ['expired', 'suspended'].includes(summary.status) ? this.expiredCheckInIntervalMs : this.normalCheckInIntervalMs
      const lastSuccess = current.lastOnlineCheck ? Date.parse(current.lastOnlineCheck) : Number.NEGATIVE_INFINITY
      const last = Math.max(lastSuccess, this.lastCheckInAttemptAt)
      if (trigger === 'startup' || this.now() - last >= interval) await this.performCheckIn(trigger)
    } catch {
      // The app remains locked/available according to the last verified local token; retries are scheduled.
    } finally {
      this.backgroundCheckInRunning = false
    }
  }

  private async performCheckIn(trigger: 'startup' | 'poll' | 'manual'): Promise<boolean> {
    const current = this.store.getCurrent()
    if (!current) return false
    const snapshot = this.getSnapshot()
    if (['tampered', 'invalid', 'machine_mismatch', 'clock_rollback', 'not_yet_valid'].includes(snapshot.status)) {
      return false
    }
    this.lastCheckInAttemptAt = this.now()
    const config = this.store.getVendorConfig()
    const serverUrl = config.licenseServerUrl
    if (!serverUrl) throw new Error('license_server_not_configured')
    const secret = this.readExistingSecret()
    if (!secret) throw new Error('license_secret_missing')
    const trustedKeys = this.trustedKeysFor(config)
    const { claims } = verifyLicenseToken(current.token, {
      machineId: this.options.machineId,
      trustedEd25519Keys: trustedKeys,
      localHmacKey: secret,
    })
    const payload: LicenseCheckInRequest = {
      licenseId: claims.licenseId,
      machineId: claims.machineId,
      appVersion: this.options.appVersion,
      platform: this.options.platform,
      checkedAt: this.isoNow(),
      source: claims.source,
      online: true,
      ...(claims.source === 'onsite' ? { onsiteLicense: onsiteReport(claims) } : {}),
    }
    let response
    try {
      response = await this.serverClient.checkIn(serverUrl, payload)
    } catch (error) {
      this.recordEvent({
        licenseId: claims.licenseId,
        eventType: 'license.checkin.failed',
        occurredAt: this.isoNow(),
        machineId: claims.machineId,
        source: claims.source,
        claims: {},
        token: null,
        detail: { trigger, reason: isMachineConflict(error) ? 'machine_conflict' : 'service_unavailable' },
      })
      throw error
    }

    let nextClaims = claims
    let nextToken = current.token
    let wasUpdated = false
    if (response.token) {
      await this.loadMockTrustIfAvailable(serverUrl)
      let candidate: LicenseClaims
      try {
        candidate = this.verifyNewToken(response.token, null)
      } catch {
        this.recordEvent({
          licenseId: claims.licenseId,
          eventType: 'license.checkin.response_rejected',
          occurredAt: this.isoNow(),
          machineId: claims.machineId,
          source: claims.source,
          claims: {},
          token: null,
          detail: { trigger, reason: 'invalid_or_untrusted_update' },
        })
        throw new Error('license_update_untrusted')
      }
      if (candidate.licenseId !== claims.licenseId || candidate.machineId !== this.options.machineId) {
        this.recordEvent({
          licenseId: claims.licenseId,
          eventType: 'license.checkin.response_rejected',
          occurredAt: this.isoNow(),
          machineId: claims.machineId,
          source: claims.source,
          claims: {},
          token: null,
          detail: { trigger, reason: 'binding_mismatch' },
        })
        throw new Error('license_update_binding_invalid')
      }
      nextClaims = candidate
      nextToken = response.token
      wasUpdated = true
    }
    // A vendor who switches the relay on (or off) after activation is picked up here, on the next check-in,
    // without the shop touching anything: the server's latest published address wins.
    if (config.licenseServerUrl) {
      const published = await this.readPublishedRelayUrl(config.licenseServerUrl)
      if (published !== config.relayUrl) this.store.setRelayUrl(published)
    }
    const reported = current.reportedToPortal || response.reported === true
    this.writeLicense(nextClaims, nextToken, this.isoNow(), reported, wasUpdated ? 'license.renewed' : 'license.checkin.succeeded', {
      trigger,
      updated: wasUpdated,
      reportedToPortal: reported,
    })
    if (nextClaims.lockCurrency) this.applyVendorCurrencyLock()
    return wasUpdated
  }

  private verifyNewToken(token: string, expectedSource: LicenseClaims['source'] | null): LicenseClaims {
    const secret = this.options.secretStore.getOrCreate()
    const config = this.store.getVendorConfig()
    const verified = verifyLicenseToken(token, {
      machineId: this.options.machineId,
      trustedEd25519Keys: this.trustedKeysFor(config),
      localHmacKey: secret,
    })
    if (expectedSource && verified.claims.source !== expectedSource) throw new Error('license_source_invalid')
    validateDefaultCurrency(verified.claims.defaultCurrencyCode)
    return verified.claims
  }

  private writeLicense(
    claims: LicenseClaims,
    token: string,
    lastOnlineCheck: string | null,
    reportedToPortal: boolean,
    eventType: string,
    detail: Record<string, unknown>,
  ): void {
    const secret = this.options.secretStore.getOrCreate()
    const trustedTime = this.isoNow()
    const material: LicenseMaterial = {
      licenseId: claims.licenseId,
      token,
      machineId: claims.machineId,
      edition: claims.edition,
      startsAt: claims.startsAt,
      endsAt: claims.endsAt,
      status: claims.status,
      source: claims.source,
      defaultCurrencyCode: claims.defaultCurrencyCode,
      lockCurrency: claims.lockCurrency,
      lastOnlineCheck,
      reportedToPortal,
      features: { ...claims.features },
      adminPhoneLimit: claims.adminPhoneLimit,
      graceDays: claims.graceDays,
      lastTrustedTime: trustedTime,
    }
    const integrityTag = hmacSha256(secret, canonicalize(material)).toString('base64url')
    const event: LicenseHistoryEvent = {
      licenseId: claims.licenseId,
      eventType,
      occurredAt: trustedTime,
      machineId: claims.machineId,
      source: claims.source,
      claims,
      token,
      detail,
    }
    this.store.saveLicense({
      claims,
      token,
      lastOnlineCheck,
      reportedToPortal,
      lastTrustedTime: trustedTime,
      integrityTag,
      event,
    })
  }

  private licenseIntegrityTag(current: StoredLicenseState, lastTrustedTime: string, secret: Buffer): string {
    const material: LicenseMaterial = {
      licenseId: current.licenseId,
      token: current.token,
      machineId: current.machineId,
      edition: current.edition,
      startsAt: current.startsAt,
      endsAt: current.endsAt,
      status: current.status,
      source: current.source,
      defaultCurrencyCode: current.defaultCurrencyCode,
      lockCurrency: current.lockCurrency,
      lastOnlineCheck: current.lastOnlineCheck,
      reportedToPortal: current.reportedToPortal,
      features: current.features,
      adminPhoneLimit: current.adminPhoneLimit,
      graceDays: current.graceDays,
      lastTrustedTime,
    }
    return hmacSha256(secret, canonicalize(material)).toString('base64url')
  }

  private verifyPolicyIntegrity(config: LicenseVendorConfig): boolean {
    const policyConfigured = config.masterPasswordHash !== null
      || config.maximumOnsitePeriodYears !== null
      || Object.keys(config.trustedEd25519Keys).length > 0
      || config.licenseServerUrl !== null
    if (!policyConfigured && !config.policyIntegrityTag) return true
    if (!config.policyIntegrityTag) return false
    const secret = this.readExistingSecret()
    if (!secret) return false
    const expected = hmacSha256(secret, canonicalize(policyMaterial(config))).toString('base64url')
    return safeTagMatches(config.policyIntegrityTag, expected)
  }

  private persistPolicy(material: PolicyMaterial): void {
    const secret = this.options.secretStore.getOrCreate()
    const policyIntegrityTag = hmacSha256(secret, canonicalize(material)).toString('base64url')
    this.store.saveVendorConfig({ ...material, policyIntegrityTag })
  }

  private currentPolicyMaterial(): PolicyMaterial {
    const config = this.store.getVendorConfig()
    return policyMaterial(config)
  }

  private trustedKeysFor(config: LicenseVendorConfig): Record<string, string> {
    return config.trustedEd25519Keys
  }

  private async loadMockTrustIfAvailable(serverUrl: string): Promise<void> {
    const url = new URL(serverUrl)
    if (!this.allowLocalMockTrust || url.protocol !== 'http:' || !isLoopback(url.hostname)) return
    let metadata
    try {
      metadata = await this.serverClient.getMetadata(serverUrl)
    } catch {
      return
    }
    if (metadata.mode !== 'infoflex-mock' || typeof metadata.keyId !== 'string' || typeof metadata.publicKey !== 'string') return
    const material = this.currentPolicyMaterial()
    material.trustedEd25519Keys = { ...material.trustedEd25519Keys, [metadata.keyId]: normalizeEd25519PublicKey(metadata.publicKey) }
    material.licenseServerUrl = serverUrl
    this.persistPolicy(material)
  }

  /**
   * Reads the relay address the licence server publishes, and accepts it only after checking that it is an
   * `wss://` address on a host that is not an IP literal or a private name. A missing or unusable value simply
   * means no internet relay, which is the safe default: the phone still works on the shop's own network.
   */
  private async readPublishedRelayUrl(serverUrl: string): Promise<string | null> {
    try {
      const metadata = await this.serverClient.getMetadata(serverUrl)
      const candidate = typeof metadata.relayUrl === 'string' ? metadata.relayUrl.trim() : ''
      if (!candidate) return null
      let url: URL
      try {
        url = new URL(candidate)
      } catch {
        return null
      }
      if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash) return null
      const host = url.hostname.toLowerCase()
      if (!host.includes('.') || /^\d{1,3}(\.\d{1,3}){3}$/u.test(host)) return null
      return `${url.origin}${url.pathname.replace(/\/$/u, '')}`
    } catch {
      return null
    }
  }

  private validateServerUrl(value: string): string {
    const serverUrl = normalizeOptionalServerUrl(value)
    if (!serverUrl) throw new Error('Enter the license service URL.')
    const parsed = new URL(serverUrl)
    if (parsed.protocol !== 'https:' && !(this.allowLocalMockTrust && parsed.protocol === 'http:' && isLoopback(parsed.hostname))) {
      throw new Error('The license service must use HTTPS. Plain HTTP is permitted only for the local development mock.')
    }
    return serverUrl
  }

  private applyVendorCurrencyLock(): void {
    this.database.prepare(`
      UPDATE settings SET currency_locked_by_vendor = 1, currency_locked = 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = 1 AND setup_complete = 1
    `).run()
  }

  private readExistingSecret(): Buffer | null {
    try {
      return this.options.secretStore.readExisting()
    } catch {
      return null
    }
  }

  private assertNoClockRollbackForReplacement(): void {
    if (this.store.getCurrent() && this.getSnapshot().status === 'clock_rollback') {
      throw new Error('The system clock moved backwards. Correct the clock before renewing or replacing this license.')
    }
  }

  private assertNotBlocked(kind: 'password' | 'key', config: LicenseVendorConfig): void {
    const blockedUntil = kind === 'password' ? config.passwordBlockedUntil : config.keyBlockedUntil
    if (blockedUntil && blockedUntil > this.now()) {
      const seconds = Math.max(1, Math.ceil((blockedUntil - this.now()) / 1_000))
      throw new Error(`Too many attempts. Try again in ${seconds} seconds.`)
    }
  }

  private async recordFailedAttempt(kind: 'password' | 'key', eventType: string, reason: string): Promise<void> {
    const config = this.store.getVendorConfig()
    const failures = (kind === 'password' ? config.passwordFailures : config.keyFailures) + 1
    const delayMs = Math.min(FAILURE_DELAY_MAX_MS, FAILURE_DELAY_BASE_MS * (2 ** Math.min(failures - 1, 7)))
    const blockedUntil = this.now() + delayMs
    this.store.saveFailureState(kind, failures, blockedUntil)
    this.recordEvent({
      licenseId: null,
      eventType,
      occurredAt: this.isoNow(),
      machineId: this.options.machineId,
      source: kind === 'key' ? 'online' : 'onsite',
      claims: {},
      token: null,
      detail: { reason, failures, delayMs },
    })
    await this.delay(delayMs)
  }

  private recordPolicyImportFailure(reason: string): void {
    this.recordEvent({
      licenseId: null,
      eventType: 'license.vendor_policy.rejected',
      occurredAt: this.isoNow(),
      machineId: this.options.machineId,
      source: null,
      claims: {},
      token: null,
      detail: { reason },
    })
  }

  private recordEvent(event: LicenseHistoryEvent): void {
    const database = this.database
    const insert = database.prepare(`
      INSERT INTO license_history (license_id, event_type, occurred_at, machine_id, source, claims_json, token, detail_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const audit = database.prepare(`
      INSERT INTO audit_log (id, actor, action, metadata_json, device_name, ip_address, created_at)
      VALUES (?, 'LICENSE_HOST', ?, ?, 'LOCAL_DESKTOP', NULL, ?)
    `)
    database.transaction(() => {
      insert.run(event.licenseId, event.eventType, event.occurredAt, event.machineId, event.source, JSON.stringify(event.claims), event.token, JSON.stringify(event.detail))
      audit.run(randomUUID(), event.eventType, JSON.stringify({ licenseId: event.licenseId, source: event.source, ...event.detail }), event.occurredAt)
    }).immediate()
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString()
  }
}

function emptySummary(config: LicenseVendorConfig): LicenseSummary {
  return {
    status: 'unactivated',
    canUse: false,
    licenseId: null,
    source: null,
    edition: null,
    startsAt: null,
    endsAt: null,
    defaultCurrencyCode: null,
    lockCurrency: false,
    features: { mobileLan: false, mobileInternet: false },
    adminPhoneLimit: 1,
    graceDays: 0,
    lastOnlineCheck: null,
    reportedToPortal: false,
    vendorConfigured: Boolean(config.masterPasswordHash),
    maximumOnsitePeriodYears: config.maximumOnsitePeriodYears,
    licenseServerUrl: config.licenseServerUrl,
    message: 'Activate a valid Infoflex license before setup or sign-in.',
  }
}

function summaryFromStored(
  current: StoredLicenseState,
  config: LicenseVendorConfig,
  status: LicenseRuntimeStatus,
  canUse: boolean,
  message: string,
): LicenseSummary {
  return {
    ...emptySummary(config),
    status,
    canUse,
    licenseId: current.licenseId,
    source: current.source,
    edition: current.edition,
    startsAt: current.startsAt,
    endsAt: current.endsAt,
    defaultCurrencyCode: current.defaultCurrencyCode,
    lockCurrency: current.lockCurrency,
    features: current.features,
    adminPhoneLimit: current.adminPhoneLimit,
    graceDays: current.graceDays,
    lastOnlineCheck: current.lastOnlineCheck,
    reportedToPortal: current.reportedToPortal,
    message,
  }
}

function summaryFromClaims(
  current: StoredLicenseState,
  config: LicenseVendorConfig,
  claims: LicenseClaims,
  status: LicenseRuntimeStatus,
  canUse: boolean,
  message: string,
): LicenseSummary {
  return {
    ...summaryFromStored(current, config, status, canUse, message),
    edition: claims.edition,
    startsAt: claims.startsAt,
    endsAt: claims.endsAt,
    defaultCurrencyCode: claims.defaultCurrencyCode,
    lockCurrency: claims.lockCurrency,
    features: { ...claims.features },
    adminPhoneLimit: claims.adminPhoneLimit,
    graceDays: claims.graceDays,
  }
}

function sameStoredClaims(record: StoredLicenseState, claims: LicenseClaims): boolean {
  return record.licenseId === claims.licenseId
    && record.machineId === claims.machineId
    && record.edition === claims.edition
    && record.startsAt === claims.startsAt
    && record.endsAt === claims.endsAt
    && record.status === claims.status
    && record.source === claims.source
    && record.defaultCurrencyCode === claims.defaultCurrencyCode
    && record.lockCurrency === claims.lockCurrency
    && record.features.mobileLan === claims.features.mobileLan
    && record.features.mobileInternet === claims.features.mobileInternet
    && record.adminPhoneLimit === claims.adminPhoneLimit
    && record.graceDays === claims.graceDays
}

function policyMaterial(config: LicenseVendorConfig): PolicyMaterial {
  return {
    masterPasswordHash: config.masterPasswordHash,
    maximumOnsitePeriodYears: config.maximumOnsitePeriodYears,
    trustedEd25519Keys: config.trustedEd25519Keys,
    licenseServerUrl: config.licenseServerUrl,
    relayUrl: config.relayUrl,
  }
}

function safeTagMatches(left: string, right: string): boolean {
  try {
    return constantTimeEqual(Buffer.from(left, 'base64url'), Buffer.from(right, 'base64url'))
  } catch {
    return false
  }
}

function validateLicenseFeatures(features: unknown): asserts features is LicenseClaims['features'] {
  if (!features || typeof features !== 'object' || Array.isArray(features)) throw new Error('Choose the mobile access features for this license.')
  const record = features as Record<string, unknown>
  if (typeof record.mobileLan !== 'boolean' || typeof record.mobileInternet !== 'boolean') {
    throw new Error('Choose the mobile access features for this license.')
  }
}

function validateAdminPhoneLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Admin-phone limit must be between 1 and 100.')
}

function validateDefaultCurrency(code: string | null): string | null {
  if (code === null) return null
  if (typeof code !== 'string' || !getCurrency(code)) throw new Error('Choose a supported default currency.')
  return code
}

function onsiteReport(claims: LicenseClaims): NonNullable<LicenseCheckInRequest['onsiteLicense']> {
  return {
    licenseId: claims.licenseId,
    machineId: claims.machineId,
    source: 'onsite',
    edition: claims.edition,
    startsAt: claims.startsAt,
    endsAt: claims.endsAt,
    issuedAt: claims.issuedAt,
    status: claims.status,
    defaultCurrencyCode: claims.defaultCurrencyCode,
    lockCurrency: claims.lockCurrency,
    features: { ...claims.features },
    adminPhoneLimit: claims.adminPhoneLimit,
    graceDays: claims.graceDays,
  }
}

function safeLicenseVerificationMessage(error: unknown): string {
  if (error instanceof Error && error.message.includes('different machine')) return 'machine_mismatch'
  if (error instanceof Error && error.message.includes('authenticator is unavailable')) return 'hmac_key_missing'
  return 'invalid'
}

function statusMessage(status: LicenseRuntimeStatus): string {
  const messages: Record<LicenseRuntimeStatus, string> = {
    unactivated: 'Activate a valid Infoflex license before setup or sign-in.',
    active: 'License is active.',
    grace: 'The license has expired. Limited offline grace is active while the app retries check-in.',
    expired: 'The license has expired. App and mobile access are locked; shop data is unchanged.',
    not_yet_valid: 'This license is not valid yet. Check the start date or contact the vendor.',
    suspended: 'This license has been suspended. Shop data is unchanged; contact the vendor to restore access.',
    revoked: 'This license has been revoked. Shop data is unchanged; contact the vendor.',
    machine_mismatch: 'This license belongs to another machine. Rebind it with the on-site vendor flow or import the correct file.',
    clock_rollback: 'The system clock moved backwards. Correct the clock and check in online or contact the vendor.',
    tampered: 'License data is missing or was changed. Reimport or reactivate the license; shop data is unchanged.',
    invalid: 'The license signature or saved data is invalid. Import a trusted license or contact the vendor.',
  }
  return messages[status]
}

function isActivationRejected(error: unknown): boolean {
  return error instanceof Error && error.message === 'activation_rejected'
}

function isMachineConflict(error: unknown): boolean {
  return error instanceof Error && error.message === 'license_machine_conflict'
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  return host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.startsWith('127.')
}

function normalizeEd25519PublicKey(value: string): string {
  try {
    const key = createPublicKey(value.trim())
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('wrong_key_type')
    return key.export({ type: 'spki', format: 'pem' }).toString()
  } catch {
    throw new Error('The local mock returned an invalid Ed25519 public key.')
  }
}

function elapsedCalendarYears(startsOn: string, endsOn: string): number {
  const startYear = Number(startsOn.slice(0, 4))
  const endYear = Number(endsOn.slice(0, 4))
  return Math.max(0, endYear - startYear)
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
