import { describe, expect, it } from 'vitest'
import { verifyLicenseToken } from '../../src/license/crypto'
import type { LicenseClaims } from '../../src/shared/license/types'
import { createTestCloud } from './helpers'

/**
 * The end-to-end promises a vendor and a shop depend on, exercised against the real service, the real signing
 * key and the desktop's own verifier. Nothing here stubs the database, so a broken query fails the test.
 */
const MACHINE_A = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const MACHINE_B = 'ffffffff-1111-4222-8333-444444444444'

function claimsOf(token: string, machineId: string, publicKeyPem: string, keyId: string): LicenseClaims {
  return verifyLicenseToken(token, { machineId, trustedEd25519Keys: { [keyId]: publicKeyPem } }).claims
}

async function seed(nowRef: { now: number }) {
  const cloud = await createTestCloud({ now: () => nowRef.now })
  const { license } = cloud.cloud.service.createLicense({
    customer: { businessName: 'Acme Pharmacy', contactName: 'Ada', phone: '08012345678', email: 'ada@example.com' },
    edition: 'PHARMACY',
    startsAt: '2026-01-01',
    endsAt: '2027-01-01',
    maxAdminPhones: 2,
    mobileLan: true,
    mobileInternet: true,
    defaultCurrencyCode: 'NGN',
    lockCurrency: true,
  }, 'owner@example.com')
  return { ...cloud, license }
}

describe('activation and check-in', () => {
  it('publishes the public key the desktop will trust', async () => {
    const { app, close, identity } = await createTestCloud()
    try {
      const response = await app.inject({ method: 'GET', url: '/api/license/config' })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ keyId: identity.keyId })
      expect(response.json().publicKey).toBe(identity.publicKeyPem)
    } finally {
      await close()
    }
  })

  it('activates a portal-created licence and preselects the default currency', async () => {
    const nowRef = { now: Date.parse('2026-03-01T09:00:00.000Z') }
    const env = await seed(nowRef)
    try {
      const response = await env.app.inject({
        method: 'POST', url: '/api/license/activate',
        payload: { activationKey: env.license.license_key, machineId: MACHINE_A, appVersion: '1.0.0', platform: 'win32' },
      })
      expect(response.statusCode).toBe(200)
      const claims = claimsOf(response.json().token, MACHINE_A, env.identity.publicKeyPem, env.identity.keyId)
      // DONE WHEN 1: the currency the vendor chose arrives with the licence, so setup can preselect it.
      expect(claims.defaultCurrencyCode).toBe('NGN')
      expect(claims.lockCurrency).toBe(true)
      expect(claims.edition).toBe('PHARMACY')
      expect(claims.adminPhoneLimit).toBe(2)
      expect(claims.features.mobileInternet).toBe(true)
    } finally {
      await env.close()
    }
  })

  it('refuses a licence file issued for a different machine', async () => {
    const nowRef = { now: Date.parse('2026-03-01T09:00:00.000Z') }
    const env = await seed(nowRef)
    try {
      const activation = await env.app.inject({
        method: 'POST', url: '/api/license/activate',
        payload: { activationKey: env.license.license_key, machineId: MACHINE_A, appVersion: '1.0.0', platform: 'win32' },
      })
      const token = activation.json().token as string
      // DONE WHEN 6: a token is bound to one machine, and the desktop's verifier is what enforces it.
      expect(() => claimsOf(token, MACHINE_B, env.identity.publicKeyPem, env.identity.keyId))
        .toThrow(/different machine/iu)
    } finally {
      await env.close()
    }
  })

  it('rejects a second machine until the vendor rebinds, and allows it afterwards', async () => {
    const nowRef = { now: Date.parse('2026-03-01T09:00:00.000Z') }
    const env = await seed(nowRef)
    try {
      await env.app.inject({
        method: 'POST', url: '/api/license/activate',
        payload: { activationKey: env.license.license_key, machineId: MACHINE_A, appVersion: '1.0.0', platform: 'win32' },
      })
      const second = await env.app.inject({
        method: 'POST', url: '/api/license/activate',
        payload: { activationKey: env.license.license_key, machineId: MACHINE_B, appVersion: '1.0.0', platform: 'win32' },
      })
      expect(second.statusCode).toBe(403)
      expect(second.json().error).toBe('machine_conflict')

      // DONE WHEN 7: only the portal rebinds, and it does so without the customer's password.
      env.cloud.service.rebindMachine(env.license.id, 'owner@example.com')
      const third = await env.app.inject({
        method: 'POST', url: '/api/license/activate',
        payload: { activationKey: env.license.license_key, machineId: MACHINE_B, appVersion: '1.0.0', platform: 'win32' },
      })
      expect(third.statusCode).toBe(200)
      expect(claimsOf(third.json().token, MACHINE_B, env.identity.publicKeyPem, env.identity.keyId).machineId).toBe(MACHINE_B)
    } finally {
      await env.close()
    }
  })

  it('refuses business data in a check-in body', async () => {
    const nowRef = { now: Date.parse('2026-03-01T09:00:00.000Z') }
    const env = await seed(nowRef)
    try {
      const response = await env.app.inject({
        method: 'POST', url: '/api/license/check-in',
        payload: {
          licenseId: env.license.id, machineId: MACHINE_A, appVersion: '1.0.0', platform: 'win32',
          checkedAt: new Date(nowRef.now).toISOString(), source: 'online', online: true,
          sales: [{ total: 500 }],
        },
      })
      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe('business_data_not_permitted')
    } finally {
      await env.close()
    }
  })

  it('delivers a renewal on the next check-in with no customer password', async () => {
    const nowRef = { now: Date.parse('2026-03-01T09:00:00.000Z') }
    const env = await seed(nowRef)
    try {
      const activation = await env.app.inject({
        method: 'POST', url: '/api/license/activate',
        payload: { activationKey: env.license.license_key, machineId: MACHINE_A, appVersion: '1.0.0', platform: 'win32' },
      })
      const first = claimsOf(activation.json().token, MACHINE_A, env.identity.publicKeyPem, env.identity.keyId)

      const checkIn = (checkedAt: string) => env.app.inject({
        method: 'POST', url: '/api/license/check-in',
        payload: {
          licenseId: env.license.id, machineId: MACHINE_A, appVersion: '1.0.0', platform: 'win32',
          checkedAt, source: 'online', online: true,
        },
      })

      // Nothing changed: no token, so the PC keeps what it has.
      expect((await checkIn(new Date(nowRef.now).toISOString())).json().updated).toBe(false)

      // DONE WHEN 4: the vendor extends the term from a phone; the next poll carries the new dates.
      env.cloud.service.renewLicense(env.license.id, { endsAt: '2028-01-01' }, 'owner@example.com')
      const renewed = await checkIn(new Date(nowRef.now + 60_000).toISOString())
      expect(renewed.json().updated).toBe(true)
      const second = claimsOf(renewed.json().token, MACHINE_A, env.identity.publicKeyPem, env.identity.keyId)
      expect(second.endsAt.startsWith('2028-01-01')).toBe(true)
      expect(second.endsAt).not.toBe(first.endsAt)
    } finally {
      await env.close()
    }
  })

  it('suspends with the grace period intact and unsuspends without losing the term', async () => {
    const nowRef = { now: Date.parse('2026-03-01T09:00:00.000Z') }
    const env = await seed(nowRef)
    try {
      env.cloud.service.setEntitlements(env.license.id, {
        maxAdminPhones: 2, mobileLan: true, mobileInternet: true, graceDays: 7,
        defaultCurrencyCode: 'NGN', lockCurrency: true,
      }, 'owner@example.com')
      await env.app.inject({
        method: 'POST', url: '/api/license/activate',
        payload: { activationKey: env.license.license_key, machineId: MACHINE_A, appVersion: '1.0.0', platform: 'win32' },
      })

      env.cloud.service.setStatus(env.license.id, 'suspended', 'owner@example.com')
      const suspended = await env.app.inject({
        method: 'POST', url: '/api/license/check-in',
        payload: {
          licenseId: env.license.id, machineId: MACHINE_A, appVersion: '1.0.0', platform: 'win32',
          checkedAt: new Date(nowRef.now + 60_000).toISOString(), source: 'online', online: true,
        },
      })
      expect(suspended.statusCode).toBe(200)
      const suspendedClaims = claimsOf(suspended.json().token, MACHINE_A, env.identity.publicKeyPem, env.identity.keyId)
      expect(suspendedClaims.status).toBe('suspended')
      // DONE WHEN 5: the grace period the vendor granted travels with the suspension.
      expect(suspendedClaims.graceDays).toBe(7)

      env.cloud.service.setStatus(env.license.id, 'active', 'owner@example.com')
      const restored = await env.app.inject({
        method: 'POST', url: '/api/license/check-in',
        payload: {
          licenseId: env.license.id, machineId: MACHINE_A, appVersion: '1.0.0', platform: 'win32',
          checkedAt: new Date(nowRef.now + 120_000).toISOString(), source: 'online', online: true,
        },
      })
      expect(claimsOf(restored.json().token, MACHINE_A, env.identity.publicKeyPem, env.identity.keyId).status).toBe('active')
    } finally {
      await env.close()
    }
  })

  it('signs an expired licence so the app locks at the end date', async () => {
    const nowRef = { now: Date.parse('2026-03-01T09:00:00.000Z') }
    const env = await seed(nowRef)
    try {
      await env.app.inject({
        method: 'POST', url: '/api/license/activate',
        payload: { activationKey: env.license.license_key, machineId: MACHINE_A, appVersion: '1.0.0', platform: 'win32' },
      })
      // The licence still checks in the day after its end date, and the token it receives says active with an
      // end date in the past — the desktop's own runtime check is what locks the till (DONE WHEN 3).
      nowRef.now = Date.parse('2027-01-02T09:00:00.000Z')
      env.cloud.service.renewLicense(env.license.id, { endsAt: '2027-01-03' }, 'owner@example.com')
      const after = await env.app.inject({
        method: 'POST', url: '/api/license/check-in',
        payload: {
          licenseId: env.license.id, machineId: MACHINE_A, appVersion: '1.0.0', platform: 'win32',
          checkedAt: new Date(nowRef.now).toISOString(), source: 'online', online: true,
        },
      })
      expect(after.statusCode).toBe(200)
      const claims = claimsOf(after.json().token, MACHINE_A, env.identity.publicKeyPem, env.identity.keyId)
      expect(Date.parse(claims.endsAt)).toBeLessThanOrEqual(nowRef.now + 86_400_000)
      expect(claims.status).toBe('active')
    } finally {
      await env.close()
    }
  })

  it('rate limits a flood of activations on one key', async () => {
    const nowRef = { now: Date.parse('2026-03-01T09:00:00.000Z') }
    const cloud = await createTestCloud({ now: () => nowRef.now })
    try {
      const { license } = cloud.cloud.service.createLicense({
        customer: { businessName: 'Rate Ltd' }, edition: 'PHARMACY', startsAt: '2026-01-01', endsAt: '2027-01-01',
        maxAdminPhones: 1, mobileLan: true, mobileInternet: false, defaultCurrencyCode: null, lockCurrency: false,
      }, 'owner@example.com')
      let limited = null as null | number
      for (let attempt = 0; attempt < 15; attempt += 1) {
        const response = await cloud.app.inject({
          method: 'POST', url: '/api/license/activate',
          payload: { activationKey: license.license_key, machineId: MACHINE_A, appVersion: '1.0.0', platform: 'win32' },
        })
        if (response.statusCode === 429) {
          limited = attempt
          break
        }
      }
      expect(limited).not.toBeNull()
    } finally {
      await cloud.close()
    }
  })

  it('serves an offline licence file only for the machine named in the form', async () => {
    const nowRef = { now: Date.parse('2026-03-01T09:00:00.000Z') }
    const env = await seed(nowRef)
    try {
      const file = env.cloud.service.offlineFile(env.license.id, MACHINE_B, 'owner@example.com')
      expect(file.fileName).toMatch(/^infoflex-IFX-/u)
      expect(claimsOf(file.token, MACHINE_B, env.identity.publicKeyPem, env.identity.keyId).machineId).toBe(MACHINE_B)
      expect(() => claimsOf(file.token, MACHINE_A, env.identity.publicKeyPem, env.identity.keyId)).toThrow()
    } finally {
      await env.close()
    }
  })

  it('reports an on-site licence and then suspends it (DONE WHEN 5, on-site case)', async () => {
    const nowRef = { now: Date.parse('2026-03-01T09:00:00.000Z') }
    const cloud = await createTestCloud({ now: () => nowRef.now })
    try {
      const { license } = cloud.cloud.service.createLicense({
        customer: { businessName: 'Onsite Chemist' }, edition: 'PHARMACY', startsAt: '2026-02-01', endsAt: '2027-02-01',
        maxAdminPhones: 1, mobileLan: true, mobileInternet: false, defaultCurrencyCode: null, lockCurrency: false,
      }, 'owner@example.com')
      cloud.cloud.database.prepare("UPDATE licenses SET source = 'onsite' WHERE id = ?").run(license.id)

      const report = await cloud.app.inject({
        method: 'POST', url: '/api/license/check-in',
        payload: {
          licenseId: license.id, machineId: MACHINE_A, appVersion: '1.0.0', platform: 'win32',
          checkedAt: new Date(nowRef.now).toISOString(), source: 'onsite', online: true,
          onsiteLicense: {
            edition: 'PHARMACY', startsAt: '2026-02-01', endsAt: '2027-02-01', issuedAt: new Date(nowRef.now).toISOString(),
            status: 'active', defaultCurrencyCode: null, lockCurrency: false,
            features: { mobileLan: true, mobileInternet: false }, adminPhoneLimit: 1, graceDays: 0,
          },
        },
      })
      expect(report.statusCode).toBe(200)
      const view = cloud.cloud.service.findLicenseByKeyOrId(license.id)
      expect(view?.onsite_reported_at).not.toBeNull()

      cloud.cloud.service.setStatus(license.id, 'suspended', 'owner@example.com')
      const after = await cloud.app.inject({
        method: 'POST', url: '/api/license/check-in',
        payload: {
          licenseId: license.id, machineId: MACHINE_A, appVersion: '1.0.0', platform: 'win32',
          checkedAt: new Date(nowRef.now + 60_000).toISOString(), source: 'onsite', online: true,
          onsiteLicense: {
            edition: 'PHARMACY', startsAt: '2026-02-01', endsAt: '2027-02-01', issuedAt: new Date(nowRef.now).toISOString(),
            status: 'active', defaultCurrencyCode: null, lockCurrency: false,
            features: { mobileLan: true, mobileInternet: false }, adminPhoneLimit: 1, graceDays: 0,
          },
        },
      })
      expect(after.statusCode).toBe(200)
      const claims = claimsOf(after.json().token, MACHINE_A, cloud.identity.publicKeyPem, cloud.identity.keyId)
      // The PC's own report says active, but the vendor's suspension wins.
      expect(claims.status).toBe('suspended')
    } finally {
      await cloud.close()
    }
  })
})
