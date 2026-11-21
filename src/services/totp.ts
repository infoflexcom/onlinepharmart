import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * RFC 6238 TOTP over SHA-1 with the 6-digit/30-second parameters every authenticator app supports,
 * and RFC 4648 base32 for the shared secret. Verification accepts one step either side to absorb clock
 * drift, and rejects a code that has already been used so a shoulder-surfed code is single-use.
 */
export const TOTP_DIGITS = 6
export const TOTP_PERIOD_SECONDS = 30
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export interface TotpVerification {
  valid: boolean
  /** The time step the code matched, used to reject replay of the same code. */
  step: number | null
}

/** Creates a new 160-bit base32 secret (the size RFC 4226 recommends for HMAC-SHA1). */
export function createTotpSecret(newBytes: (size: number) => Buffer = randomBytes): string {
  return base32Encode(newBytes(20))
}

export function encodeBase32(buffer: Buffer): string {
  return base32Encode(buffer)
}

export function decodeBase32(value: string): Buffer {
  return base32Decode(value)
}

/** The otpauth:// URI an authenticator app scans as a QR code. */
export function buildTotpUri(input: { secret: string; account: string; issuer: string }): string {
  const issuer = sanitizeLabel(input.issuer || 'Infoflex')
  const account = sanitizeLabel(input.account || 'admin')
  const label = encodeURIComponent(`${issuer}:${account}`)
  const params = new URLSearchParams({
    secret: input.secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  })
  return `otpauth://totp/${label}?${params.toString()}`
}

export function generateTotp(secret: string, atMs: number, digits = TOTP_DIGITS): string {
  const counter = Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS)
  const key = base32Decode(secret)
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', key).update(message).digest()
  const offset = digest[digest.length - 1]! & 0x0f
  const binary = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!
  return String(binary % 10 ** digits).padStart(digits, '0')
}

/**
 * Verifies a submitted code. `lastUsedStep` is the highest step already accepted for this account, so a
 * replayed code inside the drift window fails.
 */
export function verifyTotp(input: {
  secret: string
  code: string
  atMs: number
  lastUsedStep?: number | null
  window?: number
}): TotpVerification {
  const code = typeof input.code === 'string' ? input.code.replace(/[\s-]/gu, '') : ''
  if (!/^\d{6}$/u.test(code)) return { valid: false, step: null }
  const window = input.window ?? 1
  const currentStep = Math.floor(input.atMs / 1000 / TOTP_PERIOD_SECONDS)
  const expected = Buffer.from(code)
  for (let offset = -window; offset <= window; offset += 1) {
    const step = currentStep + offset
    if (step < 0) continue
    if (input.lastUsedStep !== null && input.lastUsedStep !== undefined && step <= input.lastUsedStep) continue
    const candidate = Buffer.from(generateTotp(input.secret, step * TOTP_PERIOD_SECONDS * 1000))
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return { valid: true, step }
  }
  return { valid: false, step: null }
}

/** Strips the characters an authenticator label cannot carry, and bounds the length. */
function sanitizeLabel(value: string): string {
  return value
    .replace(/[:\\]/gu, ' ')
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 64) || 'Infoflex'
}

function base32Encode(buffer: Buffer): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of buffer) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return output
}

function base32Decode(value: string): Buffer {
  const clean = value.toUpperCase().replace(/=+$/u, '').replace(/[\s-]/gu, '')
  let bits = 0
  let accumulator = 0
  const bytes: number[] = []
  for (const character of clean) {
    const index = BASE32_ALPHABET.indexOf(character)
    if (index === -1) throw new Error('The authenticator secret is not valid base32.')
    accumulator = (accumulator << 5) | index
    bits += 5
    if (bits >= 8) {
      bytes.push((accumulator >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}
