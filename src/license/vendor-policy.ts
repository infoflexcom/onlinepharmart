import { createPublicKey, pbkdf2Sync, randomBytes } from 'node:crypto'
import type { VendorPolicyFile } from '../shared/license/types'
import { MAX_CONFIGURABLE_PERIOD_YEARS } from './dates'

export const MASTER_PASSWORD_HASH_ITERATIONS = 310_000
const MIN_MASTER_PASSWORD_LENGTH = 12
const MAX_MASTER_PASSWORD_BYTES = 1_024
const MAX_HASH_ITERATIONS = 2_000_000

export function createMasterPasswordHash(password: string): VendorPolicyFile['masterPasswordHash'] {
  validateMasterPassword(password)
  const salt = randomBytes(16)
  const hash = pbkdf2Sync(password, salt, MASTER_PASSWORD_HASH_ITERATIONS, 32, 'sha256')
  return {
    algorithm: 'PBKDF2-SHA256',
    iterations: MASTER_PASSWORD_HASH_ITERATIONS,
    salt: salt.toString('base64url'),
    hash: hash.toString('base64url'),
  }
}

export function verifyMasterPassword(password: string, value: unknown): boolean {
  if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > MAX_MASTER_PASSWORD_BYTES) return false
  const parsed = validatePasswordHash(value)
  const salt = Buffer.from(parsed.salt, 'base64url')
  const expected = Buffer.from(parsed.hash, 'base64url')
  const actual = pbkdf2Sync(password, salt, parsed.iterations, expected.length, 'sha256')
  return actual.length === expected.length && actual.reduce((difference, byte, index) => difference | (byte ^ expected[index]!), 0) === 0
}

export function validateMasterPassword(password: string): void {
  if (typeof password !== 'string' || password.length < MIN_MASTER_PASSWORD_LENGTH) {
    throw new Error(`Use at least ${MIN_MASTER_PASSWORD_LENGTH} characters for the vendor master password.`)
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_MASTER_PASSWORD_BYTES) {
    throw new Error('The vendor master password is too long.')
  }
}

export function validateVendorPolicyFile(value: unknown): VendorPolicyFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The vendor policy file is invalid.')
  const record = value as Record<string, unknown>
  if (record.format !== 'infoflex-vendor-license-policy' || record.version !== 1) throw new Error('The vendor policy file is not a supported Infoflex policy.')
  const masterPasswordHash = validatePasswordHash(record.masterPasswordHash)
  const maximumOnsitePeriodYears = record.maximumOnsitePeriodYears
  if (maximumOnsitePeriodYears !== null && (!Number.isInteger(maximumOnsitePeriodYears)
    || (maximumOnsitePeriodYears as number) < 1 || (maximumOnsitePeriodYears as number) > MAX_CONFIGURABLE_PERIOD_YEARS)) {
    throw new Error(`Maximum on-site period must be blank or between 1 and ${MAX_CONFIGURABLE_PERIOD_YEARS} years.`)
  }
  const licenseServerUrl = normalizeOptionalServerUrl(record.licenseServerUrl)
  const trustedEd25519Keys = validateTrustedKeys(record.trustedEd25519Keys)
  return {
    format: 'infoflex-vendor-license-policy',
    version: 1,
    masterPasswordHash,
    maximumOnsitePeriodYears: maximumOnsitePeriodYears as number | null,
    licenseServerUrl,
    trustedEd25519Keys,
  }
}

export function parseVendorPolicyFile(json: string): VendorPolicyFile {
  if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > 64_000) throw new Error('The vendor policy file is too large.')
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    throw new Error('The vendor policy file is not valid JSON.')
  }
  return validateVendorPolicyFile(value)
}

export function validatePasswordHash(value: unknown): VendorPolicyFile['masterPasswordHash'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The vendor policy has no salted master-password hash.')
  const record = value as Record<string, unknown>
  if (record.algorithm !== 'PBKDF2-SHA256' || !Number.isInteger(record.iterations)
    || (record.iterations as number) < 100_000 || (record.iterations as number) > MAX_HASH_ITERATIONS
    || typeof record.salt !== 'string' || typeof record.hash !== 'string') {
    throw new Error('The vendor master-password hash is invalid.')
  }
  const salt = decodeBase64Url(record.salt, 'salt')
  const hash = decodeBase64Url(record.hash, 'hash')
  if (salt.length < 16 || salt.length > 64 || hash.length < 32 || hash.length > 64) {
    throw new Error('The vendor master-password hash has invalid dimensions.')
  }
  return {
    algorithm: 'PBKDF2-SHA256',
    iterations: record.iterations as number,
    salt: record.salt,
    hash: record.hash,
  }
}

export function normalizeOptionalServerUrl(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || value.length > 2_000) throw new Error('The license server URL is invalid.')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Enter a valid license server URL.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The license server URL must use HTTPS.')
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) throw new Error('Non-local license servers must use HTTPS.')
  if (url.username || url.password || url.search || url.hash) throw new Error('The license server URL cannot contain credentials, a query, or a fragment.')
  return url.toString().replace(/\/$/u, '')
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  return host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.startsWith('127.')
}

function validateTrustedKeys(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Trusted signing keys must be a JSON object.')
  const keys: Record<string, string> = {}
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > 50) throw new Error('A maximum of 50 trusted signing keys may be configured.')
  for (const [id, pem] of entries) {
    if (!/^[a-zA-Z0-9._-]{1,100}$/u.test(id) || typeof pem !== 'string' || pem.length > 8_000) {
      throw new Error('A trusted Ed25519 signing key is invalid.')
    }
    let key
    try {
      key = createPublicKey(pem)
    } catch {
      throw new Error(`The public key “${id}” could not be read.`)
    }
    if (key.asymmetricKeyType !== 'ed25519') throw new Error(`The public key “${id}” must be Ed25519.`)
    keys[id] = key.export({ type: 'spki', format: 'pem' }).toString()
  }
  return keys
}

function decodeBase64Url(value: string, field: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error(`The master-password ${field} encoding is invalid.`)
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.toString('base64url') !== value) throw new Error(`The master-password ${field} encoding is invalid.`)
  return decoded
}
