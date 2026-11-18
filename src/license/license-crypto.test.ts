import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { isEdition, isEditionEnabled } from '../editions'
import type { LicenseClaims } from '../shared/license/types'
import { addYearsToDateInput, assertLicensePeriod, dateInputToUtc, isLicenseDateActive } from './dates'
import { canonicalLicenseClaims, createLocalHmacLicenseToken, verifyLicenseToken } from './crypto'

const MACHINE_ID = 'a'.repeat(64)

function claims(overrides: Partial<LicenseClaims> = {}): LicenseClaims {
  return {
    licenseId: 'license-test-1',
    machineId: MACHINE_ID,
    edition: 'PHARMACY',
    startsAt: '2026-11-17T00:00:00.000Z',
    endsAt: '2027-11-17T00:00:00.000Z',
    issuedAt: '2026-11-17T12:00:00.000Z',
    status: 'active',
    source: 'file',
    defaultCurrencyCode: 'NGN',
    lockCurrency: false,
    features: { mobileLan: true, mobileInternet: false },
    adminPhoneLimit: 2,
    graceDays: 0,
    ...overrides,
  }
}

function signedToken(value: LicenseClaims, keyId: string, privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']): string {
  const payload = canonicalLicenseClaims(value)
  return JSON.stringify({
    format: 'infoflex-license',
    version: 1,
    algorithm: 'Ed25519',
    keyId,
    payload: payload.toString('base64url'),
    signature: sign(null, payload, privateKey).toString('base64url'),
  })
}

describe('license dates, editions, and token verification', () => {
  it('supports calendar-year shortcuts, clamps leap days, and leaves the period uncapped unless configured', () => {
    expect(addYearsToDateInput('2024-02-29', 1)).toBe('2025-02-28')
    expect(addYearsToDateInput('2026-11-17', 1)).toBe('2027-11-17')
    expect(addYearsToDateInput('2026-11-17', 3)).toBe('2029-11-17')
    expect(addYearsToDateInput('2026-11-17', 5)).toBe('2031-11-17')
    expect(() => assertLicensePeriod('2026-11-17', '2031-11-17', null)).not.toThrow()
    expect(() => assertLicensePeriod('2026-11-17', '2031-11-17', 5)).not.toThrow()
    expect(() => assertLicensePeriod('2026-11-17', '2031-11-17', 3)).toThrow(/maximum on-site period is 3 years/i)
  })

  it('treats an end date of today as expired at its exclusive UTC midnight', () => {
    const endsAt = dateInputToUtc('2026-11-17')
    expect(isLicenseDateActive('2026-01-01T00:00:00.000Z', endsAt, Date.parse('2026-11-17T00:00:00.000Z'))).toBe('expired')
    expect(isLicenseDateActive('2026-01-01T00:00:00.000Z', endsAt, Date.parse('2026-11-16T23:59:59.999Z'))).toBe('active')
  })

  it('accepts only defined editions and gates modules using the verified edition', () => {
    expect(isEdition('PHARMACY')).toBe(true)
    expect(isEdition('BOTH')).toBe(true)
    expect(isEdition('MART')).toBe(false)
    expect(isEditionEnabled('PHARMACY', 'pharmacy')).toBe(true)
    expect(isEditionEnabled('PHARMACY', 'supermarket')).toBe(false)
    expect(isEditionEnabled('BOTH', 'supermarket')).toBe(true)
  })

  it('verifies Ed25519 signatures and rejects altered payloads, untrusted keys, and another machine', () => {
    const pair = generateKeyPairSync('ed25519')
    const keyId = 'vendor-key-test'
    const token = signedToken(claims(), keyId, pair.privateKey)
    const trusted = { [keyId]: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }
    expect(verifyLicenseToken(token, { machineId: MACHINE_ID, trustedEd25519Keys: trusted }).claims.licenseId).toBe('license-test-1')
    expect(() => verifyLicenseToken(token, { machineId: 'b'.repeat(64), trustedEd25519Keys: trusted })).toThrow(/different machine/i)
    expect(() => verifyLicenseToken(token, { machineId: MACHINE_ID, trustedEd25519Keys: {} })).toThrow(/not trusted/i)

    const envelope = JSON.parse(token) as { payload: string; signature: string }
    const altered = JSON.stringify({ ...JSON.parse(token), payload: Buffer.from('tampered').toString('base64url') })
    expect(() => verifyLicenseToken(altered, { machineId: MACHINE_ID, trustedEd25519Keys: trusted })).toThrow()
    const badSignature = JSON.stringify({ ...JSON.parse(token), signature: Buffer.from(envelope.signature, 'base64url').fill(0).toString('base64url') })
    expect(() => verifyLicenseToken(badSignature, { machineId: MACHINE_ID, trustedEd25519Keys: trusted })).toThrow(/signature/i)
  })

  it('verifies an on-site HMAC token only with the local installation secret', () => {
    const key = Buffer.alloc(32, 13)
    const token = createLocalHmacLicenseToken(claims({ source: 'onsite' }), key)
    expect(verifyLicenseToken(token, { machineId: MACHINE_ID, trustedEd25519Keys: {}, localHmacKey: key }).claims.source).toBe('onsite')
    expect(() => verifyLicenseToken(token, { machineId: MACHINE_ID, trustedEd25519Keys: {}, localHmacKey: Buffer.alloc(32, 17) })).toThrow(/authenticator is invalid/i)
  })
})
