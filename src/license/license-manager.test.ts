import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createMockLicenseServer } from '../../cloud/mock/server'
import { HttpLicenseServerClient } from './server-client'
import { MemoryLicenseSecretStore } from './secret-store'
import { LicenseManager } from './license-manager'
import { migrateDatabase } from '../db/migrate'
import { SQLiteShopRepository } from '../db/sqlite-shop-repository'
import { SQLiteUserRepository } from '../db/sqlite-user-repository'
import { SetupService } from '../services/setup-service'
import { defaultDisplayOptions } from '../currency/money'
import { getCurrency } from '../currency/catalog'
import { addYearsToDateInput } from './dates'
import type { LicenseClaims, OnsiteActivationInput } from '../shared/license/types'
import { canonicalLicenseClaims } from './crypto'
import { generateKeyPairSync, sign } from 'node:crypto'
import { createMasterPasswordHash } from './vendor-policy'
import { assertCurrencyChangeAllowed } from '../currency/lock-guard'

const MACHINE_ID = 'a'.repeat(64)
const INITIAL_NOW = Date.parse('2026-11-17T12:00:00.000Z')
const liveManagers: LicenseManager[] = []
const liveDatabases: Database.Database[] = []
const liveMockServers: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  for (const manager of liveManagers.splice(0)) manager.stopBackgroundCheckIns()
  for (const server of liveMockServers.splice(0)) await server.close()
  for (const database of liveDatabases.splice(0)) database.close()
})

function createFixture(options: {
  now?: () => number
  machineId?: string
  serverClient?: HttpLicenseServerClient
  allowLocalMockTrust?: boolean
  delay?: (ms: number) => Promise<void>
  expiredCheckInIntervalMs?: number
  normalCheckInIntervalMs?: number
  schedulerTickMs?: number
} = {}) {
  const database = new Database(':memory:')
  migrateDatabase(database)
  const shop = new SQLiteShopRepository(database, false)
  const users = new SQLiteUserRepository(database)
  const secretStore = new MemoryLicenseSecretStore()
  const manager = new LicenseManager(database, {
    machineId: options.machineId ?? MACHINE_ID,
    appVersion: '0.1.0-test',
    platform: 'test',
    secretStore,
    now: options.now ?? (() => INITIAL_NOW),
    delay: options.delay ?? (async () => undefined),
    serverClient: options.serverClient,
    allowLocalMockTrust: options.allowLocalMockTrust,
    expiredCheckInIntervalMs: options.expiredCheckInIntervalMs,
    normalCheckInIntervalMs: options.normalCheckInIntervalMs,
    schedulerTickMs: options.schedulerTickMs,
  })
  liveDatabases.push(database)
  liveManagers.push(manager)
  return { database, shop, users, secretStore, manager }
}

function createRandomVendorPassword(): string {
  return randomBytes(24).toString('base64url')
}

function onsiteInput(password: string, overrides: Partial<OnsiteActivationInput> = {}): OnsiteActivationInput {
  return {
    masterPassword: password,
    edition: 'PHARMACY',
    startsOn: '2026-11-17',
    endsOn: '2027-11-17',
    defaultCurrencyCode: 'NGN',
    lockCurrency: false,
    features: { mobileLan: true, mobileInternet: false },
    adminPhoneLimit: 2,
    ...overrides,
  }
}

async function importVendorPolicy(
  manager: LicenseManager,
  password: string,
  maximumOnsitePeriodYears: number | null = null,
  licenseServerUrl: string | null = null,
): Promise<void> {
  await manager.importVendorPolicyFile(JSON.stringify({
    format: 'infoflex-vendor-license-policy',
    version: 1,
    masterPasswordHash: createMasterPasswordHash(password),
    maximumOnsitePeriodYears,
    licenseServerUrl,
    trustedEd25519Keys: {},
  }))
}

function signedFileToken(claims: LicenseClaims, keyId: string, privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']): string {
  const payload = canonicalLicenseClaims(claims)
  return JSON.stringify({
    format: 'infoflex-license', version: 1, algorithm: 'Ed25519', keyId,
    payload: payload.toString('base64url'), signature: sign(null, payload, privateKey).toString('base64url'),
  })
}

describe('host license manager', () => {
  it('keeps fresh installs unactivated and rejects wrong on-site passwords without storing them', async () => {
    const fixture = createFixture()
    const password = createRandomVendorPassword()
    await importVendorPolicy(fixture.manager, password)
    expect(fixture.manager.getSnapshot().status).toBe('unactivated')
    const badPassword = createRandomVendorPassword()
    await expect(fixture.manager.activateOnsite(onsiteInput(badPassword))).rejects.toThrow(/master password was not accepted/i)
    expect(fixture.manager.getSnapshot().status).toBe('unactivated')
    const stored = fixture.database.prepare('SELECT master_password_hash FROM license_vendor_config WHERE id = 1').get() as { master_password_hash: string }
    expect(stored.master_password_hash).not.toContain(password)
    expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM license_state').get()).toEqual({ count: 0 })
    const logs = fixture.database.prepare('SELECT metadata_json FROM audit_log').all() as Array<{ metadata_json: string }>
    expect(JSON.stringify(logs)).not.toContain(password)
    expect(JSON.stringify(logs)).not.toContain(badPassword)
    const history = JSON.stringify(fixture.manager.getLicenseHistory())
    expect(history).not.toContain(password)
    expect(history).not.toContain(badPassword)
  })

  it('applies progressive delays after repeated master-password failures', async () => {
    let now = INITIAL_NOW
    const delays: number[] = []
    const fixture = createFixture({
      now: () => now,
      delay: async (ms) => { delays.push(ms); now += ms },
    })
    const password = createRandomVendorPassword()
    await importVendorPolicy(fixture.manager, password)
    await expect(fixture.manager.activateOnsite(onsiteInput(createRandomVendorPassword()))).rejects.toThrow(/not accepted/i)
    await expect(fixture.manager.activateOnsite(onsiteInput(createRandomVendorPassword()))).rejects.toThrow(/not accepted/i)
    expect(delays).toEqual([250, 500])
    expect((fixture.database.prepare('SELECT password_failures FROM license_vendor_config WHERE id = 1').get() as { password_failures: number }).password_failures).toBe(2)
  })

  it('retries an expired license check-in at the configured interval after a service failure', async () => {
    let now = INITIAL_NOW
    let networkAttempts = 0
    const serverClient = new HttpLicenseServerClient(async () => {
      networkAttempts += 1
      throw new Error('network unavailable')
    })
    const fixture = createFixture({ now: () => now, serverClient, expiredCheckInIntervalMs: 1_000 })
    const password = createRandomVendorPassword()
    await importVendorPolicy(fixture.manager, password, null, 'https://licenses.example.test')
    await fixture.manager.activateOnsite(onsiteInput(password, { endsOn: '2026-11-17' }))
    expect(fixture.manager.getSnapshot().status).toBe('expired')

    await expect(fixture.manager.pollCheckInIfDue()).rejects.toThrow()
    expect(networkAttempts).toBe(1)
    expect(await fixture.manager.pollCheckInIfDue()).toBe(false)
    expect(networkAttempts).toBe(1)
    now += 1_001
    await expect(fixture.manager.pollCheckInIfDue()).rejects.toThrow()
    expect(networkAttempts).toBe(2)
  })

  it('issues offline on-site licenses for 1, 3, and 5 years when no maximum is configured', async () => {
    const fixture = createFixture()
    const password = createRandomVendorPassword()
    await importVendorPolicy(fixture.manager, password, null)
    for (const years of [1, 3, 5]) {
      const summary = await fixture.manager.activateOnsite(onsiteInput(password, {
        endsOn: addYearsToDateInput('2026-11-17', years),
      }))
      expect(summary.status).toBe('active')
      expect(summary.source).toBe('onsite')
      expect(summary.endsAt).toBe(`${addYearsToDateInput('2026-11-17', years)}T00:00:00.000Z`)
    }
    expect(fixture.manager.getLicenseHistory().filter(({ eventType }) => eventType === 'license.onsite.activated')).toHaveLength(3)
  })

  it('enforces an optional Build Studio maximum period on the host', async () => {
    const fixture = createFixture()
    const password = createRandomVendorPassword()
    await importVendorPolicy(fixture.manager, password, 3)
    await expect(fixture.manager.activateOnsite(onsiteInput(password, { endsOn: '2031-11-17' }))).rejects.toThrow(/maximum on-site period/i)
    expect(fixture.manager.getSnapshot().status).toBe('unactivated')
  })

  it('preselects and locks the license default currency, then preserves currency after a transaction', async () => {
    const fixture = createFixture()
    const password = createRandomVendorPassword()
    await importVendorPolicy(fixture.manager, password)
    const firstLicense = await fixture.manager.activateOnsite(onsiteInput(password, {
      defaultCurrencyCode: 'USD', lockCurrency: true,
    }))
    expect(firstLicense.canUse).toBe(true)
    const setup = new SetupService(fixture.shop, fixture.users, fixture.shop, fixture.manager)
    const context = await setup.getSetupContext()
    expect(context.initialCurrency.code).toBe('USD')
    expect(context.currencyLocked).toBe(true)
    expect(context.vendorCurrencyLocked).toBe(true)

    fixture.shop.saveSettings({
      ...fixture.shop.readSettings(),
      currency: getCurrency('USD')!,
      display: defaultDisplayOptions(getCurrency('USD')!),
      currencyConfirmed: true,
      setupComplete: true,
    })
    fixture.database.prepare('UPDATE settings SET currency_locked_by_transaction = 1, currency_locked = 1 WHERE id = 1').run()
    await expect(fixture.manager.activateOnsite(onsiteInput(password, { defaultCurrencyCode: 'NGN' }))).rejects.toThrow(/cannot be changed after its first transaction/i)
    const renewed = await fixture.manager.activateOnsite(onsiteInput(password, { defaultCurrencyCode: null, lockCurrency: false }))
    expect(renewed.defaultCurrencyCode).toBe('USD')
    expect(fixture.shop.readSettings().currency.code).toBe('USD')
    const renewedContext = await setup.getSetupContext()
    expect(renewedContext.initialCurrency.code).toBe('USD')
    expect(renewedContext.currencyLocked).toBe(true)
  })

  it('enforces mobile features and the Admin-phone capacity at the host device-count boundary', async () => {
    const fixture = createFixture()
    const password = createRandomVendorPassword()
    await importVendorPolicy(fixture.manager, password)
    await fixture.manager.activateOnsite(onsiteInput(password, {
      adminPhoneLimit: 2,
      features: { mobileLan: true, mobileInternet: false },
    }))
    fixture.database.prepare("INSERT INTO users (id, username, password_hash, role) VALUES ('user-admin', 'deviceadmin', 'test-hash', 'ADMIN')").run()
    expect(() => fixture.manager.assertFeature('mobileLan')).not.toThrow()
    expect(() => fixture.manager.assertFeature('mobileInternet')).toThrow(/does not include Internet mobile access/i)
    expect(() => fixture.manager.assertAdminPhoneCapacityForUser('user-admin')).not.toThrow()

    // Only an approved phone consumes a licence slot; a device awaiting approval does not.
    const registerDevice = (id: string) => fixture.database.prepare(`
      INSERT INTO devices (id, name, platform, token_hash, admin_user_id, approved_at)
      VALUES (?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')
    `).run(id, `Admin phone ${id}`, 'iOS', `token-hash-${id}`, 'user-admin')
    registerDevice('phone-1')
    expect(() => fixture.manager.assertAdminPhoneCapacityForUser('user-admin')).not.toThrow()
    registerDevice('phone-2')
    expect(() => fixture.manager.assertAdminPhoneCapacityForUser('user-admin')).toThrow(/limit has been reached/i)
    fixture.database.prepare("UPDATE devices SET revoked = 1 WHERE id = 'phone-1'").run()
    expect(() => fixture.manager.assertAdminPhoneCapacityForUser('user-admin')).not.toThrow()
  })

  it('locks a license whose exclusive end date is today and detects clock rollback and copied machine binding', async () => {
    let now = INITIAL_NOW
    const fixture = createFixture({ now: () => now })
    const password = createRandomVendorPassword()
    await importVendorPolicy(fixture.manager, password)
    await fixture.manager.activateOnsite(onsiteInput(password, { endsOn: '2026-11-17' }))
    expect(fixture.manager.getSnapshot().status).toBe('expired')
    now = INITIAL_NOW - 60 * 60_000
    expect(fixture.manager.getSnapshot().status).toBe('clock_rollback')
    await expect(fixture.manager.activateOnsite(onsiteInput(password))).rejects.toThrow(/correct the clock/i)

    now = INITIAL_NOW
    const copiedMachine = new LicenseManager(fixture.database, {
      machineId: 'b'.repeat(64), appVersion: '0.1.0-test', platform: 'test', secretStore: fixture.secretStore,
      now: () => now, delay: async () => undefined,
    })
    expect(copiedMachine.getSnapshot().status).toBe('machine_mismatch')
  })

  it('rebinds an offline on-site license after moving to another machine with the same policy and preserves shop data and history', async () => {
    const original = createFixture()
    const password = createRandomVendorPassword()
    await importVendorPolicy(original.manager, password)
    await original.manager.activateOnsite(onsiteInput(password, { adminPhoneLimit: 1 }))
    original.database.prepare(`
      INSERT INTO business_entries (id, kind, currency_code, amount_minor, store_name_snapshot, store_address_snapshot, store_phone_snapshot)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('rebind-preserved-sale', 'sale', 'NGN', 8500, 'Harbor Health', '12 Dock Road', '+234 1 555 0100')
    const storedPolicy = original.database.prepare('SELECT master_password_hash, maximum_onsite_period_years, trusted_ed25519_keys_json, license_server_url FROM license_vendor_config WHERE id = 1').get() as {
      master_password_hash: string; maximum_onsite_period_years: number | null; trusted_ed25519_keys_json: string; license_server_url: string | null
    }
    const policy = {
      format: 'infoflex-vendor-license-policy', version: 1,
      masterPasswordHash: JSON.parse(storedPolicy.master_password_hash),
      maximumOnsitePeriodYears: storedPolicy.maximum_onsite_period_years,
      trustedEd25519Keys: JSON.parse(storedPolicy.trusted_ed25519_keys_json),
      licenseServerUrl: storedPolicy.license_server_url,
    }
    const moved = new LicenseManager(original.database, {
      machineId: 'b'.repeat(64), appVersion: '0.1.0-test', platform: 'test',
      secretStore: new MemoryLicenseSecretStore(), now: () => INITIAL_NOW,
    })
    liveManagers.push(moved)
    expect(moved.getSnapshot().status).toBe('tampered')
    await moved.importVendorPolicyFile(JSON.stringify(policy))
    expect(moved.getSnapshot().status).toBe('unactivated')
    expect(original.database.prepare('SELECT COUNT(*) AS count FROM license_history WHERE event_type = ?').get('license.onsite.activated')).toEqual({ count: 1 })
    expect(original.database.prepare("SELECT amount_minor FROM business_entries WHERE id = 'rebind-preserved-sale'").get()).toEqual({ amount_minor: 8500 })

    const rebound = await moved.activateOnsite(onsiteInput(password, { adminPhoneLimit: 1 }))
    expect(rebound.status).toBe('active')
    expect(moved.getVerifiedClaims()?.machineId).toBe('b'.repeat(64))
    expect(original.database.prepare("SELECT amount_minor FROM business_entries WHERE id = 'rebind-preserved-sale'").get()).toEqual({ amount_minor: 8500 })
    expect(moved.getLicenseHistory().some(({ eventType }) => eventType === 'license.vendor_policy.rebound')).toBe(true)
  })

  it('rebinds an intact local license after a machine mismatch through authorized on-site activation', async () => {
    const original = createFixture()
    const password = createRandomVendorPassword()
    await importVendorPolicy(original.manager, password)
    const originalLicense = await original.manager.activateOnsite(onsiteInput(password, { adminPhoneLimit: 1 }))
    original.database.prepare(`
      INSERT INTO business_entries (id, kind, currency_code, amount_minor, store_name_snapshot, store_address_snapshot, store_phone_snapshot)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('intact-mismatch-sale', 'sale', 'NGN', 12_500, 'Harbor Health', '12 Dock Road', '+234 1 555 0100')

    const storedPolicy = original.database.prepare(`
      SELECT master_password_hash, maximum_onsite_period_years, trusted_ed25519_keys_json, license_server_url
      FROM license_vendor_config WHERE id = 1
    `).get() as {
      master_password_hash: string
      maximum_onsite_period_years: number | null
      trusted_ed25519_keys_json: string
      license_server_url: string | null
    }
    const existingPolicy = {
      format: 'infoflex-vendor-license-policy',
      version: 1,
      masterPasswordHash: JSON.parse(storedPolicy.master_password_hash),
      maximumOnsitePeriodYears: storedPolicy.maximum_onsite_period_years,
      licenseServerUrl: storedPolicy.license_server_url,
      trustedEd25519Keys: JSON.parse(storedPolicy.trusted_ed25519_keys_json),
    }
    const moved = new LicenseManager(original.database, {
      machineId: 'b'.repeat(64),
      appVersion: '0.1.0-test',
      platform: 'test',
      secretStore: original.secretStore,
      now: () => INITIAL_NOW,
    })
    liveManagers.push(moved)

    expect(moved.getSnapshot().status).toBe('machine_mismatch')
    await expect(moved.importVendorPolicyFile(JSON.stringify(existingPolicy))).rejects.toThrow(/already configured/i)
    expect(moved.getSnapshot().status).toBe('machine_mismatch')

    const rebound = await moved.activateOnsite(onsiteInput(password, { adminPhoneLimit: 1 }))
    expect(rebound.status).toBe('active')
    expect(rebound.licenseId).not.toBe(originalLicense.licenseId)
    expect(moved.getVerifiedClaims()?.machineId).toBe('b'.repeat(64))
    expect(original.database.prepare("SELECT amount_minor FROM business_entries WHERE id = 'intact-mismatch-sale'").get()).toEqual({ amount_minor: 12_500 })

    const history = moved.getLicenseHistory()
    expect(history.filter(({ eventType }) => eventType === 'license.onsite.activated')).toHaveLength(2)
    expect(history.find(({ licenseId }) => licenseId === originalLicense.licenseId)?.eventType).toBe('license.onsite.activated')
    expect(history.find(({ licenseId }) => licenseId === rebound.licenseId)?.detail.rebound).toBe(true)
  })

  it('accepts a signed file only for its bound machine and detects database tampering', async () => {
    const fixture = createFixture()
    const password = createRandomVendorPassword()
    const pair = generateKeyPairSync('ed25519')
    const keyId = 'test-file-key'
    const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const hash = createMasterPasswordHash(password)
    const policy = {
      format: 'infoflex-vendor-license-policy', version: 1, masterPasswordHash: hash,
      maximumOnsitePeriodYears: null, licenseServerUrl: null, trustedEd25519Keys: { [keyId]: publicKey },
    }
    await fixture.manager.importVendorPolicyFile(JSON.stringify(policy))
    const claims: LicenseClaims = {
      licenseId: 'file-license', machineId: MACHINE_ID, edition: 'SUPERMARKET',
      startsAt: '2026-11-17T00:00:00.000Z', endsAt: '2027-11-17T00:00:00.000Z',
      issuedAt: '2026-11-17T12:00:00.000Z', status: 'active', source: 'file',
      defaultCurrencyCode: 'GHS', lockCurrency: false, features: { mobileLan: false, mobileInternet: true },
      adminPhoneLimit: 3, graceDays: 2,
    }
    await expect(fixture.manager.importLicenseFile(signedFileToken({ ...claims, machineId: 'c'.repeat(64) }, keyId, pair.privateKey)))
      .rejects.toThrow(/invalid, expired, for another machine/i)
    const summary = await fixture.manager.importLicenseFile(signedFileToken(claims, keyId, pair.privateKey))
    expect(summary.status).toBe('active')
    expect(summary.edition).toBe('SUPERMARKET')
    fixture.database.prepare("UPDATE license_state SET end = '2031-11-17T00:00:00.000Z' WHERE is_current = 1").run()
    expect(fixture.manager.getSnapshot().status).toBe('tampered')
  })

  it('allows grace only for signed grace terms and keeps data intact across expiry', async () => {
    const fixture = createFixture()
    const password = createRandomVendorPassword()
    const pair = generateKeyPairSync('ed25519')
    const keyId = 'grace-file-key'
    const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    await fixture.manager.importVendorPolicyFile(JSON.stringify({
      format: 'infoflex-vendor-license-policy', version: 1, masterPasswordHash: createMasterPasswordHash(password),
      maximumOnsitePeriodYears: null, licenseServerUrl: null, trustedEd25519Keys: { [keyId]: publicKey },
    }))
    const currencyCode = 'NGN'
    fixture.database.prepare(`INSERT INTO business_entries (id, kind, currency_code, amount_minor, store_name_snapshot, store_address_snapshot, store_phone_snapshot)
      VALUES ('saved-sale', 'sale', ?, 12345, 'Shop', '', '')`).run(currencyCode)
    let now = Date.parse('2026-11-18T12:00:00.000Z')
    const claims: LicenseClaims = {
      licenseId: 'grace-license', machineId: MACHINE_ID, edition: 'PHARMACY',
      startsAt: '2026-11-16T00:00:00.000Z', endsAt: '2026-11-17T00:00:00.000Z',
      issuedAt: '2026-11-16T12:00:00.000Z', status: 'active', source: 'file',
      defaultCurrencyCode: null, lockCurrency: false, features: { mobileLan: false, mobileInternet: false },
      adminPhoneLimit: 1, graceDays: 2,
    }
    const manager = new LicenseManager(fixture.database, {
      machineId: MACHINE_ID, appVersion: '0.1.0-test', platform: 'test', secretStore: fixture.secretStore,
      now: () => now, delay: async () => undefined,
    })
    liveManagers.push(manager)
    await manager.importLicenseFile(signedFileToken(claims, keyId, pair.privateKey))
    expect(manager.getSnapshot().status).toBe('grace')
    expect(manager.getSnapshot().canUse).toBe(true)
    now = Date.parse('2026-11-20T00:00:00.000Z')
    expect(manager.getSnapshot().status).toBe('expired')
    expect(fixture.database.prepare("SELECT id, amount_minor FROM business_entries WHERE id = 'saved-sale'").get()).toEqual({ id: 'saved-sale', amount_minor: 12345 })
  })

  it('never sends an activation key to a service URL that conflicts with the vendor policy', async () => {
    let fetchCalls = 0
    const serverClient = new HttpLicenseServerClient(async () => {
      fetchCalls += 1
      return new Response(null, { status: 401 })
    })
    const fixture = createFixture({ serverClient })
    const password = createRandomVendorPassword()
    const activationKey = createRandomVendorPassword()
    await importVendorPolicy(fixture.manager, password, null, 'https://licenses.vendor.example')

    await expect(fixture.manager.activateOnline({
      activationKey,
      serverUrl: 'https://attacker.example',
    })).rejects.toThrow(/does not match the endpoint configured by the vendor policy/i)

    expect(fetchCalls).toBe(0)
    expect((fixture.database.prepare('SELECT key_failures FROM license_vendor_config WHERE id = 1').get() as { key_failures: number }).key_failures).toBe(0)
    expect(JSON.stringify(fixture.manager.getLicenseHistory())).not.toContain(activationKey)
    const audit = fixture.database.prepare('SELECT metadata_json FROM audit_log').all() as Array<{ metadata_json: string }>
    expect(JSON.stringify(audit)).not.toContain(activationKey)
  })

  it('activates online through the mock server and polls a renewal to unlock automatically', async () => {
    let now = INITIAL_NOW
    const mock = createMockLicenseServer({ now: () => new Date(now) })
    liveMockServers.push({ close: () => mock.close() })
    const serverAddress = await mock.app.listen({ host: '127.0.0.1', port: 0 })
    const fixture = createFixture({
      now: () => now,
      serverClient: new HttpLicenseServerClient(),
      allowLocalMockTrust: true,
      expiredCheckInIntervalMs: 10,
      normalCheckInIntervalMs: 1_000,
      schedulerTickMs: 5,
    })
    await expect(fixture.manager.activateOnline({ activationKey: 'NOT-A-KEY', serverUrl: serverAddress })).rejects.toThrow(/not accepted/i)
    now += 1_000
    const active = await fixture.manager.activateOnline({ activationKey: 'MOCK-PHARMACY-1D', serverUrl: serverAddress })
    expect(active.status).toBe('active')
    expect(active.edition).toBe('PHARMACY')
    fixture.database.prepare(`INSERT INTO business_entries (id, kind, currency_code, amount_minor, store_name_snapshot, store_address_snapshot, store_phone_snapshot)
      VALUES ('preserved-entry', 'sale', 'NGN', 9000, 'Shop', '', '')`).run()

    fixture.manager.startBackgroundCheckIns()
    await waitUntil(() => Boolean(fixture.manager.getSnapshot().lastOnlineCheck))
    const licenseId = fixture.manager.getSnapshot().licenseId!
    const initialEnd = fixture.manager.getSnapshot().endsAt!
    const endedAt = Date.parse(initialEnd)
    now = endedAt
    expect(fixture.manager.getSnapshot().status).toBe('expired')
    const extension = await mock.app.inject({ method: 'POST', url: `/api/mock/licenses/${licenseId}/extend`, payload: { years: 1 } })
    expect(extension.statusCode).toBe(200)
    await waitUntil(() => fixture.manager.getSnapshot().canUse)
    expect(fixture.manager.getSnapshot().status).toBe('active')
    expect(fixture.manager.getSnapshot().endsAt).not.toBe(initialEnd)
    expect(fixture.database.prepare("SELECT amount_minor FROM business_entries WHERE id = 'preserved-entry'").get()).toEqual({ amount_minor: 9000 })
  })

  it('reports offline on-site license details at the first successful check-in without sending shop data', async () => {
    const mock = createMockLicenseServer({ now: () => new Date(INITIAL_NOW) })
    liveMockServers.push({ close: () => mock.close() })
    const serverAddress = await mock.app.listen({ host: '127.0.0.1', port: 0 })
    const fixture = createFixture({ serverClient: new HttpLicenseServerClient(), allowLocalMockTrust: true })
    const password = createRandomVendorPassword()
    await importVendorPolicy(fixture.manager, password, null, serverAddress)
    const license = await fixture.manager.activateOnsite(onsiteInput(password, {
      edition: 'BOTH', defaultCurrencyCode: 'NGN', lockCurrency: true, adminPhoneLimit: 3,
      features: { mobileLan: true, mobileInternet: true },
    }))
    expect(license.reportedToPortal).toBe(false)
    const suspendBeforeReport = await mock.app.inject({
      method: 'POST', url: `/api/mock/licenses/${license.licenseId}/status`, payload: { status: 'suspended' },
    })
    expect(suspendBeforeReport.statusCode).toBe(404)
    const checked = await fixture.manager.checkInNow()
    expect(checked.status).toBe('active')
    expect(fixture.manager.getSnapshot().reportedToPortal).toBe(true)
    const listed = await mock.app.inject({ method: 'GET', url: '/api/mock/licenses' })
    const result = listed.json() as { licenses: Array<Record<string, unknown>> }
    expect(result.licenses).toHaveLength(1)
    expect(result.licenses[0]).toMatchObject({ edition: 'BOTH', source: 'onsite', adminPhoneLimit: 3, reportCount: 1 })
    expect(JSON.stringify(result)).not.toMatch(/preserved-entry|customer|stock|sales/i)

    const suspendAfterReport = await mock.app.inject({
      method: 'POST', url: `/api/mock/licenses/${license.licenseId}/status`, payload: { status: 'suspended' },
    })
    expect(suspendAfterReport.statusCode).toBe(200)
    const suspended = await fixture.manager.checkInNow()
    expect(suspended.status).toBe('suspended')
  })
})

async function waitUntil(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for the license poll.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('a licence sold in the vendor portal, on the real desktop', () => {
  /**
   * The whole commercial path, with nothing stubbed: a licence created through the cloud's own portal service,
   * activated by this repository's real `LicenseManager` against the real cloud HTTP API, then driven through the
   * vendor's real portal mutations (extend, suspend, unsuspend) and observed through the desktop's own snapshot.
   *
   * This is the closest thing to a customer signing up that can run without a Windows PC, a domain and a phone —
   * the three things `docs/RELEASE-CHECKLIST.md` still asks a human to tick off.
   */
  it('activates from a portal-created licence, preselects the currency, and unlocks after a vendor renewal', async () => {
    const { createTestCloud } = await import('../../cloud/tests/helpers')
    const cloud = await createTestCloud()
    let now = Date.parse('2026-03-01T09:00:00.000Z')
    try {
      const vendorEmail = 'owner@example.com'
      const created = cloud.cloud.service.createLicense({
        customer: { businessName: 'Portal Pharmacy', contactName: 'Ada', phone: '08012345678', email: 'ada@example.com' },
        edition: 'PHARMACY', startsAt: '2026-03-01', endsAt: '2027-03-01',
        maxAdminPhones: 2, mobileLan: true, mobileInternet: true,
        defaultCurrencyCode: 'GHS', lockCurrency: true,
      }, vendorEmail)
      expect(created.license.license_key).toMatch(/^[A-Z0-9-]{8,}$/u)

      // The cloud listens on loopback over plain HTTP here — the one case `validateServerUrl` permits, and the same
      // arrangement the licence-server tests use. Production refuses HTTP for anything but loopback.
      const address = await cloud.app.listen({ port: 0, host: '127.0.0.1' })
      // Exactly what the deployment guide tells the vendor to pin, fetched from the cloud's own endpoint.
      const published = (await cloud.app.inject({ method: 'GET', url: '/api/license/public-key' })).json() as
        { keyId: string; publicKey: string }

      // ---- the desktop: a real manager, a real shop database, the cloud's real HTTP API.
      const fixture = createFixture({
        now: () => now, machineId: MACHINE_ID,
        serverClient: new HttpLicenseServerClient(), allowLocalMockTrust: true,
      })
      await fixture.manager.importVendorPolicyFile(JSON.stringify({
        format: 'infoflex-vendor-license-policy',
        version: 1,
        masterPasswordHash: createMasterPasswordHash(createRandomVendorPassword()),
        maximumOnsitePeriodYears: null,
        licenseServerUrl: address,
        // A fresh install pins the key the vendor publishes; the guide tells the vendor to copy it from
        // /api/license/public-key, which is what this reads.
        trustedEd25519Keys: { [published.keyId]: published.publicKey },
      }))

      // DONE WHEN 1: the licence the vendor sold activates, and setup preselects the currency the vendor locked.
      const activated = await fixture.manager.activateOnline({ activationKey: created.license.license_key, serverUrl: address })
      expect(activated.status).toBe('active')
      expect(activated.edition).toBe('PHARMACY')
      const setup = new SetupService(fixture.shop, fixture.users, fixture.shop, fixture.manager)
      const context = await setup.getSetupContext()
      expect(context.initialCurrency.code).toBe('GHS')
      expect(context.currencyLocked).toBe(true)
      expect(context.vendorCurrencyLocked).toBe(true)

      // Finish setup on the currency the vendor locked, then confirm the shop cannot move it afterwards. The
      // guard is the very one the Settings screen calls, and the lock is marked as the vendor's.
      const completed = await setup.completeFirstRun({
        admin: { fullName: 'Ada Obi', username: 'shopadmin', password: 'Harbor-Admin-Pass-9', confirmPassword: 'Harbor-Admin-Pass-9' },
        profile: { name: 'Portal Pharmacy', address: '', phone: '' },
        currency: getCurrency('GHS')!,
        display: defaultDisplayOptions(getCurrency('GHS')!),
        currencyConfirmed: true,
      })
      expect(completed.settings.currency.code).toBe('GHS')
      expect(fixture.shop.isCurrencyLockedByVendor()).toBe(true)
      // DONE WHEN 2: a locked currency cannot be moved by the shop.
      expect(() => assertCurrencyChangeAllowed(fixture.shop)).toThrow(/vendor|lock/i)

      // DONE WHEN 4: the vendor extends from their phone; the desktop unlocks on its own next check-in, with no
      // customer password and no customer action.
      now = Date.parse('2027-03-02T09:00:00.000Z')
      expect(fixture.manager.getSnapshot().status).toBe('expired')
      expect(fixture.manager.getSnapshot().canUse).toBe(false)
      cloud.cloud.service.renewLicense(created.license.id, { endsAt: '2028-03-01', notifyNow: true }, vendorEmail)
      await fixture.manager.checkInNow()
      const renewed = fixture.manager.getSnapshot()
      expect(renewed.status).toBe('active')
      expect(renewed.canUse).toBe(true)
      expect(renewed.endsAt!.startsWith('2028-03-01')).toBe(true)

      // DONE WHEN 5: a suspension from the vendor reaches the shop, and unsuspending restores it.
      cloud.cloud.service.setStatus(created.license.id, 'suspended', vendorEmail)
      await fixture.manager.checkInNow()
      expect(fixture.manager.getSnapshot().status).toBe('suspended')
      expect(fixture.manager.getSnapshot().canUse).toBe(false)
      cloud.cloud.service.setStatus(created.license.id, 'active', vendorEmail)
      await fixture.manager.checkInNow()
      expect(fixture.manager.getSnapshot().status).toBe('active')

      // DONE WHEN 7: the same key on a second computer is refused until the vendor rebinds from the portal.
      const other = createFixture({
        now: () => now, machineId: 'b'.repeat(64),
        serverClient: new HttpLicenseServerClient(), allowLocalMockTrust: true,
      })
      await other.manager.importVendorPolicyFile(JSON.stringify({
        format: 'infoflex-vendor-license-policy', version: 1,
        masterPasswordHash: createMasterPasswordHash(createRandomVendorPassword()),
        maximumOnsitePeriodYears: null, licenseServerUrl: address,
        trustedEd25519Keys: { [published.keyId]: published.publicKey },
      }))
      await expect(other.manager.activateOnline({ activationKey: created.license.license_key, serverUrl: address }))
        .rejects.toThrow(/not accepted/i)
    } finally {
      await cloud.close()
    }
  }, 30_000)
})
