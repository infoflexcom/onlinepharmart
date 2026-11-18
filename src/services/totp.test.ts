import { describe, expect, it } from 'vitest'
import {
  buildTotpUri,
  createTotpSecret,
  decodeBase32,
  encodeBase32,
  generateTotp,
  TOTP_PERIOD_SECONDS,
  verifyTotp,
} from './totp'

// RFC 6238 Appendix B test vectors use the ASCII secret "12345678901234567890".
const RFC_SECRET_ASCII = '12345678901234567890'
const RFC_SECRET = encodeBase32(Buffer.from(RFC_SECRET_ASCII))
const RFC_SECRET_SHA1 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

describe('TOTP (RFC 6238)', () => {
  it('derives the RFC 4226 base32 form of the standard secret', () => {
    expect(RFC_SECRET).toBe(RFC_SECRET_SHA1)
    expect(decodeBase32(RFC_SECRET_SHA1).toString()).toBe(RFC_SECRET_ASCII)
  })

  it('matches the published RFC 6238 SHA-1 vectors truncated to six digits', () => {
    // RFC vectors are 8 digits; the last six of each are the app's 6-digit codes.
    const vectors: Array<[number, string]> = [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
    ]
    for (const [seconds, expected] of vectors) {
      const full = generateTotp(RFC_SECRET, seconds * 1000, 8)
      expect(full.slice(-6), `step at ${seconds}s`).toBe(expected)
    }
  })

  it('accepts the current code, one step either side, and rejects anything further away', () => {
    const now = 1_700_000_000_000
    const code = generateTotp(RFC_SECRET, now)
    expect(verifyTotp({ secret: RFC_SECRET, code, atMs: now }).valid).toBe(true)
    expect(verifyTotp({ secret: RFC_SECRET, code, atMs: now + TOTP_PERIOD_SECONDS * 1000 }).valid).toBe(true)
    expect(verifyTotp({ secret: RFC_SECRET, code, atMs: now - TOTP_PERIOD_SECONDS * 1000 }).valid).toBe(true)
    expect(verifyTotp({ secret: RFC_SECRET, code, atMs: now + TOTP_PERIOD_SECONDS * 3000 }).valid).toBe(false)
  })

  it('is single-use: the same code cannot be replayed within its drift window', () => {
    const now = 1_700_000_000_000
    const code = generateTotp(RFC_SECRET, now)
    const first = verifyTotp({ secret: RFC_SECRET, code, atMs: now })
    expect(first.valid).toBe(true)
    expect(first.step).not.toBeNull()
    const replay = verifyTotp({ secret: RFC_SECRET, code, atMs: now + 1000, lastUsedStep: first.step })
    expect(replay.valid).toBe(false)
  })

  it('rejects malformed input without throwing', () => {
    for (const code of ['', '12345', '1234567', 'abcdef', '!!!!!!', undefined as unknown as string]) {
      expect(verifyTotp({ secret: RFC_SECRET, code, atMs: Date.now() }).valid).toBe(false)
    }
    expect(() => verifyTotp({ secret: 'not-base32-1!', code: '123456', atMs: Date.now() })).toThrow(/base32/i)
  })

  it('tolerates spaces and dashes the way a person types a code', () => {
    const now = 1_700_000_000_000
    const code = generateTotp(RFC_SECRET, now)
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`
    expect(verifyTotp({ secret: RFC_SECRET, code: spaced, atMs: now }).valid).toBe(true)
  })

  it('creates 160-bit secrets in upper-case base32 with no padding', () => {
    const secret = createTotpSecret()
    expect(secret).toMatch(/^[A-Z2-7]{32}$/u)
    expect(decodeBase32(secret)).toHaveLength(20)
    expect(createTotpSecret()).not.toBe(secret)
  })

  it('builds an otpauth URI an authenticator app can scan', () => {
    const uri = buildTotpUri({ secret: RFC_SECRET, account: 'admin', issuer: 'Infoflex Pharm' })
    expect(uri.startsWith('otpauth://totp/')).toBe(true)
    const parsed = new URL(uri)
    expect(parsed.searchParams.get('secret')).toBe(RFC_SECRET)
    expect(parsed.searchParams.get('issuer')).toBe('Infoflex Pharm')
    expect(parsed.searchParams.get('digits')).toBe('6')
    expect(parsed.searchParams.get('period')).toBe('30')
    expect(decodeURIComponent(parsed.pathname)).toContain('Infoflex Pharm:admin')
  })

  it('sanitises labels that would break the URI', () => {
    const uri = buildTotpUri({ secret: RFC_SECRET, account: 'ad:min\\x', issuer: 'Shop: One' })
    expect(uri).not.toContain('ad:min')
    const parsed = new URL(uri)
    expect(parsed.searchParams.get('issuer')).toBe('Shop One')
  })
})
