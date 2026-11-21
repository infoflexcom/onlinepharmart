import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../src/database'
import { VendorAuth, assertStrongPassword, csrfMatches, hashToken } from '../src/auth'
import { generateTotp } from '../../src/services/totp'

/**
 * The portal is the one place in the product where a human password reaches a server, so its rules are tested
 * rather than assumed: two factors or no entry, lockout after repeated failures, single-use codes, and sessions
 * that die on their own.
 */
const PASSWORD = 'correct-horse-battery-staple'
const NOW = Date.parse('2026-05-01T10:00:00.000Z')

function build(nowRef: { now: number }) {
  const database = openDatabase(':memory:')
  const auth = new VendorAuth(database, { now: () => nowRef.now, sessionMinutes: 30 })
  return { database, auth }
}

async function enrolledOwner(auth: VendorAuth) {
  const user = await auth.createUser({ email: 'owner@example.com', displayName: 'Ada', password: PASSWORD, role: 'OWNER' }, 'test')
  auth.confirmTotpSetup(user.id, generateTotp(user.totp_secret, NOW))
  return user
}

describe('vendor authentication', () => {
  const nowRef = { now: NOW }
  let env: ReturnType<typeof build>

  beforeEach(() => {
    nowRef.now = NOW
    env = build(nowRef)
  })

  it('stores an argon2id hash, never the password', async () => {
    const user = await enrolledOwner(env.auth)
    expect(user.password_hash.startsWith('$argon2id$')).toBe(true)
    expect(user.password_hash).not.toContain(PASSWORD)
    const stored = env.database.prepare('SELECT password_hash FROM vendor_users WHERE id = ?').get(user.id) as { password_hash: string }
    expect(stored.password_hash).toBe(user.password_hash)
  })

  it('refuses sign-in until two-factor setup is confirmed', async () => {
    const user = await env.auth.createUser({ email: 'owner@example.com', displayName: 'Ada', password: PASSWORD, role: 'OWNER' }, 'test')
    const result = await env.auth.login({
      email: 'owner@example.com', password: PASSWORD, code: generateTotp(user.totp_secret, NOW),
      ipAddress: '127.0.0.1', userAgent: 'test',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('totp_required')
  })

  it('requires a valid code as well as the password', async () => {
    const user = await enrolledOwner(env.auth)
    const wrongCode = await env.auth.login({
      email: 'owner@example.com', password: PASSWORD, code: '000000', ipAddress: null, userAgent: 'test',
    })
    expect(wrongCode.ok).toBe(false)
    const right = await env.auth.login({
      email: 'owner@example.com', password: PASSWORD, code: generateTotp(user.totp_secret, NOW + 30_000), ipAddress: null, userAgent: 'test',
    })
    expect(right.ok).toBe(true)
  })

  it('rejects a replayed code inside the same time step', async () => {
    const user = await enrolledOwner(env.auth)
    const code = generateTotp(user.totp_secret, NOW + 30_000)
    expect((await env.auth.login({ email: 'owner@example.com', password: PASSWORD, code, ipAddress: null, userAgent: 't' })).ok).toBe(true)
    const replay = await env.auth.login({ email: 'owner@example.com', password: PASSWORD, code, ipAddress: null, userAgent: 't' })
    expect(replay.ok).toBe(false)
  })

  it('locks the account after eight failures and unlocks after fifteen minutes', async () => {
    await enrolledOwner(env.auth)
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await env.auth.login({ email: 'owner@example.com', password: 'wrong-password-entirely', code: '123456', ipAddress: null, userAgent: 't' })
    }
    const locked = await env.auth.login({ email: 'owner@example.com', password: PASSWORD, code: '123456', ipAddress: null, userAgent: 't' })
    expect(locked.ok).toBe(false)
    if (!locked.ok) expect(locked.reason).toBe('locked')

    nowRef.now = NOW + 16 * 60_000
    const user = env.database.prepare('SELECT totp_secret FROM vendor_users').get() as { totp_secret: string }
    const recovered = await env.auth.login({
      email: 'owner@example.com', password: PASSWORD, code: generateTotp(user.totp_secret, nowRef.now), ipAddress: null, userAgent: 't',
    })
    expect(recovered.ok).toBe(true)
  })

  it('treats an unknown email exactly like a wrong password', async () => {
    await enrolledOwner(env.auth)
    const unknown = await env.auth.login({ email: 'nobody@example.com', password: PASSWORD, code: '123456', ipAddress: null, userAgent: 't' })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.message).toBe('That email or password is not correct.')
  })

  it('expires a session after the idle window and slides it while in use', async () => {
    const user = await enrolledOwner(env.auth)
    const login = await env.auth.login({
      email: 'owner@example.com', password: PASSWORD, code: generateTotp(user.totp_secret, NOW + 30_000), ipAddress: null, userAgent: 't',
    })
    if (!login.ok) throw new Error('login failed')
    expect(env.auth.authenticate(login.token)).not.toBeNull()

    nowRef.now = NOW + 29 * 60_000
    expect(env.auth.authenticate(login.token)).not.toBeNull()
    nowRef.now = NOW + 45 * 60_000
    expect(env.auth.authenticate(login.token)).not.toBeNull()

    nowRef.now = NOW + 46 * 60_000 + 30 * 60_000
    expect(env.auth.authenticate(login.token)).toBeNull()
  })

  it('stores only the hash of a session token', async () => {
    const user = await enrolledOwner(env.auth)
    const login = await env.auth.login({
      email: 'owner@example.com', password: PASSWORD, code: generateTotp(user.totp_secret, NOW + 30_000), ipAddress: null, userAgent: 't',
    })
    if (!login.ok) throw new Error('login failed')
    const rows = env.database.prepare('SELECT token_hash FROM sessions').all() as Array<{ token_hash: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.token_hash).toBe(hashToken(login.token))
    expect(rows[0]!.token_hash).not.toBe(login.token)
  })

  it('drops a session on sign-out and when the account is disabled', async () => {
    const user = await enrolledOwner(env.auth)
    const first = await env.auth.login({
      email: 'owner@example.com', password: PASSWORD, code: generateTotp(user.totp_secret, NOW + 30_000), ipAddress: null, userAgent: 't',
    })
    if (!first.ok) throw new Error('login failed')
    env.auth.logout(first.token)
    expect(env.auth.authenticate(first.token)).toBeNull()

    // Half a minute later the next code is valid; the one already used is not.
    nowRef.now = NOW + 30_000
    const second = await env.auth.login({
      email: 'owner@example.com', password: PASSWORD, code: generateTotp(user.totp_secret, nowRef.now + 30_000), ipAddress: null, userAgent: 't',
    })
    if (!second.ok) throw new Error('login failed')
    env.auth.setActive(user.id, false, 'owner@example.com')
    expect(env.auth.authenticate(second.token)).toBeNull()
  })

  it('refuses a disabled account at the password stage', async () => {
    const user = await enrolledOwner(env.auth)
    env.auth.setActive(user.id, false, 'owner@example.com')
    const result = await env.auth.login({
      email: 'owner@example.com', password: PASSWORD, code: generateTotp(user.totp_secret, NOW + 30_000), ipAddress: null, userAgent: 't',
    })
    expect(result.ok).toBe(false)
  })

  it('resets two-factor and issues a fresh secret', async () => {
    const user = await enrolledOwner(env.auth)
    const secret = env.auth.resetTotp(user.id, 'owner@example.com')
    expect(secret).not.toBe(user.totp_secret)
    const updated = env.auth.getUser(user.id)
    expect(updated.totp_confirmed_at).toBeNull()
    const result = await env.auth.login({
      email: 'owner@example.com', password: PASSWORD, code: generateTotp(secret, NOW), ipAddress: null, userAgent: 't',
    })
    expect(result.ok).toBe(false)
  })

  it('writes every sign-in attempt to the audit log', async () => {
    const user = await enrolledOwner(env.auth)
    await env.auth.login({ email: 'owner@example.com', password: 'nope-nope-nope', code: '1', ipAddress: '10.0.0.9', userAgent: 't' })
    await env.auth.login({
      email: 'owner@example.com', password: PASSWORD, code: generateTotp(user.totp_secret, NOW + 30_000), ipAddress: '10.0.0.9', userAgent: 't',
    })
    const actions = (env.database.prepare('SELECT action, ip_address FROM audit_log ORDER BY id').all() as Array<{ action: string; ip_address: string | null }>)
    expect(actions.map((row) => row.action)).toEqual(expect.arrayContaining([
      'vendor.login.failed', 'vendor.login.succeeded', 'vendor_user.created', 'vendor_user.totp_confirmed',
    ]))
    expect(actions.filter((row) => row.action.startsWith('vendor.login')).every((row) => row.ip_address === '10.0.0.9')).toBe(true)
  })
})

describe('password and CSRF rules', () => {
  it('accepts a long passphrase and a mixed 12-character password', () => {
    expect(() => assertStrongPassword('correct-horse-battery-staple')).not.toThrow()
    expect(() => assertStrongPassword('Sup3r!secret')).not.toThrow()
  })

  it('rejects short, single-class and trivially repeatable passwords', () => {
    for (const weak of ['short', 'alllowercase', '123456789012', 'aaaaaaaaaaaaaaaaaaaa']) {
      expect(() => assertStrongPassword(weak)).toThrow()
    }
  })

  it('compares CSRF tokens without short-circuiting on length', () => {
    expect(csrfMatches('abc123', 'abc123')).toBe(true)
    expect(csrfMatches('abc123', 'abc124')).toBe(false)
    expect(csrfMatches('', 'abc')).toBe(false)
    expect(csrfMatches('abc', undefined)).toBe(false)
    expect(csrfMatches('abc', 'abcd')).toBe(false)
  })
})
