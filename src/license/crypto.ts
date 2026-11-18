import { createHmac, timingSafeEqual, verify as verifySignature } from 'node:crypto'
import { isEdition } from '../editions'
import type { Edition } from '../editions'
import type { LicenseClaims, LicenseSource, SignedLicenseStatus } from '../shared/license/types'

export type LicenseSigningAlgorithm = 'Ed25519' | 'HMAC-SHA256'

export interface LicenseEnvelope {
  format: 'infoflex-license'
  version: 1
  algorithm: LicenseSigningAlgorithm
  keyId: string
  payload: string
  signature: string
}

export interface LicenseVerificationOptions {
  machineId: string
  trustedEd25519Keys: Readonly<Record<string, string>>
  localHmacKey?: Buffer | null
}

export interface VerifiedLicenseToken {
  envelope: LicenseEnvelope
  claims: LicenseClaims
}

const SOURCES = new Set<LicenseSource>(['online', 'file', 'onsite'])
const STATUSES = new Set<SignedLicenseStatus>(['active', 'suspended', 'revoked'])
const MAX_TOKEN_BYTES = 32_768

export function verifyLicenseToken(token: string, options: LicenseVerificationOptions): VerifiedLicenseToken {
  if (typeof token !== 'string' || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) {
    throw new Error('The licence token is missing or too large.')
  }
  let envelopeValue: unknown
  try {
    envelopeValue = JSON.parse(token)
  } catch {
    throw new Error('The licence token is not valid JSON.')
  }
  const envelope = validateEnvelope(envelopeValue)
  const payloadBytes = decodeBase64Url(envelope.payload)
  const signature = decodeBase64Url(envelope.signature)
  let payloadValue: unknown
  try {
    payloadValue = JSON.parse(payloadBytes.toString('utf8'))
  } catch {
    throw new Error('The licence token payload is invalid.')
  }
  const claims = validateClaims(payloadValue)
  const canonicalPayload = Buffer.from(canonicalize(claims), 'utf8')
  if (!canonicalPayload.equals(payloadBytes)) throw new Error('The licence token payload is not canonical.')

  if (envelope.algorithm === 'Ed25519') {
    const publicKey = options.trustedEd25519Keys[envelope.keyId]
    if (!publicKey) throw new Error('The licence signing key is not trusted on this installation.')
    let valid = false
    try {
      valid = verifySignature(null, payloadBytes, publicKey, signature)
    } catch {
      valid = false
    }
    if (!valid) throw new Error('The licence signature is invalid.')
  } else {
    const key = options.localHmacKey
    if (!key || envelope.keyId !== 'local-install') throw new Error('The local licence authenticator is unavailable.')
    const expected = createHmac('sha256', key).update(payloadBytes).digest()
    if (expected.length !== signature.length || !timingSafeEqual(expected, signature)) {
      throw new Error('The local licence authenticator is invalid.')
    }
  }

  if (claims.machineId !== options.machineId) throw new Error('This licence is bound to a different machine.')
  return { envelope, claims }
}

export function parseLicenseTokenClaims(token: string): LicenseClaims {
  if (typeof token !== 'string' || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) throw new Error('The licence token is missing or too large.')
  let envelopeValue: unknown
  try {
    envelopeValue = JSON.parse(token)
  } catch {
    throw new Error('The licence token is invalid.')
  }
  const envelope = validateEnvelope(envelopeValue)
  return validateClaims(JSON.parse(decodeBase64Url(envelope.payload).toString('utf8')))
}

export function toLicenseEnvelope(token: string): LicenseEnvelope {
  let value: unknown
  try {
    value = JSON.parse(token)
  } catch {
    throw new Error('The licence token is invalid.')
  }
  return validateEnvelope(value)
}

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b, 'en'))
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`).join(',')}}`
}

export function canonicalLicenseClaims(claims: LicenseClaims): Buffer {
  return Buffer.from(canonicalize(claims), 'utf8')
}

/** On-site HMACs use a per-installation secret kept by OS-protected Electron safeStorage. */
export function createLocalHmacLicenseToken(claims: LicenseClaims, key: Buffer): string {
  const payload = canonicalLicenseClaims(claims)
  const envelope: LicenseEnvelope = {
    format: 'infoflex-license',
    version: 1,
    algorithm: 'HMAC-SHA256',
    keyId: 'local-install',
    payload: payload.toString('base64url'),
    signature: createHmac('sha256', key).update(payload).digest('base64url'),
  }
  return JSON.stringify(envelope)
}

export function hmacSha256(key: Buffer, value: string | Buffer): Buffer {
  return createHmac('sha256', key).update(value).digest()
}

export function constantTimeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right)
}

function validateEnvelope(value: unknown): LicenseEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The licence envelope is invalid.')
  const record = value as Record<string, unknown>
  if (record.format !== 'infoflex-license' || record.version !== 1
    || (record.algorithm !== 'Ed25519' && record.algorithm !== 'HMAC-SHA256')
    || typeof record.keyId !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/u.test(record.keyId)
    || typeof record.payload !== 'string' || typeof record.signature !== 'string') {
    throw new Error('The licence envelope is invalid.')
  }
  return {
    format: 'infoflex-license',
    version: 1,
    algorithm: record.algorithm,
    keyId: record.keyId,
    payload: record.payload,
    signature: record.signature,
  }
}

function validateClaims(value: unknown): LicenseClaims {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The licence claims are invalid.')
  const record = value as Record<string, unknown>
  if (typeof record.licenseId !== 'string' || !/^[a-zA-Z0-9._:-]{1,160}$/u.test(record.licenseId)) throw new Error('The licence ID is invalid.')
  if (typeof record.machineId !== 'string' || !/^[a-fA-F0-9-]{16,128}$/u.test(record.machineId)) throw new Error('The licence machine binding is invalid.')
  if (!isEdition(record.edition)) throw new Error('The licence edition is invalid.')
  if (!isCanonicalIsoDate(record.startsAt) || !isCanonicalIsoDate(record.endsAt) || !isCanonicalIsoDate(record.issuedAt)) {
    throw new Error('The licence dates are invalid.')
  }
  if (Date.parse(record.endsAt) < Date.parse(record.startsAt)) throw new Error('The licence end date is before its start date.')
  if (!STATUSES.has(record.status as SignedLicenseStatus)) throw new Error('The licence status is invalid.')
  if (!SOURCES.has(record.source as LicenseSource)) throw new Error('The licence source is invalid.')
  if (record.defaultCurrencyCode !== null && (typeof record.defaultCurrencyCode !== 'string' || !/^[A-Z0-9]{3,8}$/u.test(record.defaultCurrencyCode))) {
    throw new Error('The licence default currency is invalid.')
  }
  if (typeof record.lockCurrency !== 'boolean' || (record.lockCurrency && !record.defaultCurrencyCode)) {
    throw new Error('The licence currency lock is invalid.')
  }
  if (!record.features || typeof record.features !== 'object' || Array.isArray(record.features)) throw new Error('The licence feature policy is invalid.')
  const features = record.features as Record<string, unknown>
  if (typeof features.mobileLan !== 'boolean' || typeof features.mobileInternet !== 'boolean') throw new Error('The licence feature policy is invalid.')
  if (!Number.isInteger(record.adminPhoneLimit) || (record.adminPhoneLimit as number) < 1 || (record.adminPhoneLimit as number) > 100) {
    throw new Error('The Admin-phone limit is invalid.')
  }
  if (!Number.isInteger(record.graceDays) || (record.graceDays as number) < 0 || (record.graceDays as number) > 30) {
    throw new Error('The licence grace period is invalid.')
  }

  return {
    licenseId: record.licenseId,
    machineId: record.machineId,
    edition: record.edition as Edition,
    startsAt: record.startsAt,
    endsAt: record.endsAt,
    issuedAt: record.issuedAt,
    status: record.status as SignedLicenseStatus,
    source: record.source as LicenseSource,
    defaultCurrencyCode: record.defaultCurrencyCode as string | null,
    lockCurrency: record.lockCurrency,
    features: { mobileLan: features.mobileLan, mobileInternet: features.mobileInternet },
    adminPhoneLimit: record.adminPhoneLimit as number,
    graceDays: record.graceDays as number,
  }
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('The licence token encoding is invalid.')
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.toString('base64url') !== value) throw new Error('The licence token encoding is invalid.')
  return decoded
}
