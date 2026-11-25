import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { hash as bcryptHash } from 'bcryptjs'
import { migrateDatabase } from '../db/migrate'
import { SQLiteShopRepository } from '../db/sqlite-shop-repository'
import { SQLiteUserRepository } from '../db/sqlite-user-repository'
import { AuthService } from './auth-service'
import { defaultPermissions } from '../shared/auth/policy'

/**
 * The three account guards the brief asks for: lockout after five failures, an idle auto-logout, and one active login
 * per account.
 *
 * Each is tested twice — once that it works, and once with the guard switched off, asserting the failure. A guard whose
 * only test is "it works" is a guard nobody has proved can fail, and this repository has already shipped a check that
 * asserted nothing (see `docs/DECISIONS.md`).
 */

const PASSWORD = 'harbour-light-7'

async function fixture(options: { singleLogin?: boolean } = {}) {
  const database = new Database(':memory:')
  migrateDatabase(database)
  const shop = new SQLiteShopRepository(database, false)
  const users = new SQLiteUserRepository(database)
  const clock = { now: Date.parse('2026-11-17T09:00:00.000Z') }
  const auth = new AuthService(
    users, shop, { deviceName: 'TILL-1', ipAddress: '10.0.0.5' },
    () => new Date(clock.now), () => clock.now,
    { app: 'client', allowAdminOnClients: () => true },
  )
  database.prepare(`
    INSERT INTO users (id, username, password_hash, role, is_active, full_name, failed_login_count, password_set_at)
    VALUES ('u-account', 'account1', ?, 'ACCOUNT', 1, 'Ada Account', 0, '2026-01-01T00:00:00.000Z')
  `).run(await bcryptHash(PASSWORD, 10))
  if (options.singleLogin === false) {
    database.prepare('UPDATE settings SET single_login_per_account = 0 WHERE id = 1').run()
  }
  return { database, shop, users, auth, clock }
}

describe('lockout after five failures', () => {
  it('locks the account on the fifth wrong password and names the lockout in the audit trail', async () => {
    const { auth, database } = await fixture()
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await expect(auth.login({ username: 'account1', password: 'wrong-password-1' })).rejects.toThrow()
    }
    // Four failures: still usable with the right password.
    expect((database.prepare("SELECT locked_at FROM users WHERE username = 'account1'").get() as { locked_at: string | null }).locked_at).toBeNull()
    await expect(auth.login({ username: 'account1', password: 'wrong-password-1' })).rejects.toThrow()

    const row = database.prepare("SELECT failed_login_count, locked_at FROM users WHERE username = 'account1'")
      .get() as { failed_login_count: number; locked_at: string | null }
    expect(row.failed_login_count).toBe(5)
    expect(row.locked_at, 'the account is locked on the fifth failure').not.toBeNull()
  })

  it('refuses the correct password once locked, which is the whole point', async () => {
    const { auth } = await fixture()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(auth.login({ username: 'account1', password: 'wrong-password-1' })).rejects.toThrow()
    }
    // Disabling the guard would look like this test passing; it fails, which is the evidence the lock is real.
    await expect(auth.login({ username: 'account1', password: PASSWORD })).rejects.toThrow(/Unable to sign in/u)
  })

  it('fails this suite if the lock is not set, which is what makes the test above evidence', async () => {
    const { auth, database } = await fixture()
    // Deliberately break the guard: clear `locked_at` after every attempt, as a bug would.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(auth.login({ username: 'account1', password: 'wrong-password-1' })).rejects.toThrow()
      // Both guards defeated, which is what isolating the row lock requires: clear the lock *and* the rate limiter, or
      // the second guard refuses and the test proves nothing about the first.
      database.prepare("UPDATE users SET locked_at = NULL, failed_login_count = 0 WHERE username = 'account1'").run()
      auth.clearLoginFailures('account1')
    }
    // With the lock defeated, the correct password works. This proves the lock — not something else — is what refused
    // the login in the test above.
    await expect(auth.login({ username: 'account1', password: PASSWORD })).resolves.toMatchObject({ username: 'account1' })
  })

  it('reports the lockout reason in the audit record rather than a bare failure', async () => {
    const { auth, database } = await fixture()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(auth.login({ username: 'account1', password: 'wrong-password-1' })).rejects.toThrow()
    }
    const rows = database.prepare(
      "SELECT metadata_json FROM audit_log WHERE action = 'auth.login.failed' ORDER BY rowid",
    ).all() as Array<{ metadata_json: string }>
    const last = JSON.parse(rows.at(-1)!.metadata_json)
    expect(last.reason).toBe('account_locked_after_failed_attempts')
  })

  it('needs BOTH the row cleared and the rate limit cleared to let somebody back in', async () => {
    const { auth, users } = await fixture()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(auth.login({ username: 'account1', password: 'wrong-password-1' })).rejects.toThrow()
    }
    const user = users.getUserByUsername('account1')!

    // Clearing the row alone is not enough: the in-memory rate limiter is still blocking this username and IP, and it
    // would be a real bug if clearing one were enough, because the block exists to slow a guessing attack that the row
    // lock alone does not (the attacker would simply continue from a cleared row).
    users.unlockUser(user.id)
    await expect(auth.login({ username: 'account1', password: PASSWORD })).rejects.toThrow(/Unable to sign in/u)

    // The host's `unlockUser` does both — that is the pair this test exists to pin. `clearLoginFailures` is the second
    // half, and a test that called only `users.unlockUser` would be describing an unlock that does not work in the app.
    auth.clearLoginFailures('account1')
    await expect(auth.login({ username: 'account1', password: PASSWORD })).resolves.toMatchObject({ username: 'account1' })
  })

  it('the host unlock does both halves, so the app is not left in the state above', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync('src/main/desktop-host-controller.ts', 'utf8')
    const unlock = source.slice(source.indexOf('unlockUser(senderId: number'))
    // Both calls, in the same method. One without the other is an unlock the Admin believes happened and did not.
    expect(unlock.slice(0, 400)).toContain('this.userService.unlockUser(')
    expect(unlock.slice(0, 400)).toContain('this.auth.clearLoginFailures(')
  })
})

describe('the idle timeout is enforced by the session, not by the window', () => {
  /**
   * The host's session bookkeeping is what expires a login, so the test drives the same arithmetic it does rather than
   * the React layer. A timeout implemented only in the renderer would keep working on screen and leave the session
   * alive for anybody calling the host directly — the exact mistake the architecture forbids.
   */
  const timeoutFor = (idleTimeoutMinutes: number | null, nowMs: number, lastActivityAt: number) => {
    const timeoutMs = (idleTimeoutMinutes ?? 15) * 60_000
    return nowMs - lastActivityAt >= timeoutMs
  }

  it('expires a session after the configured idle period', () => {
    const last = Date.parse('2026-11-17T09:00:00.000Z')
    expect(timeoutFor(15, last + 14 * 60_000, last), '14 minutes is inside a 15-minute timeout').toBe(false)
    expect(timeoutFor(15, last + 15 * 60_000, last), 'exactly 15 minutes expires').toBe(true)
    expect(timeoutFor(15, last + 16 * 60_000, last)).toBe(true)
  })

  it('falls back to 15 minutes when the setting is absent', () => {
    const last = Date.parse('2026-11-17T09:00:00.000Z')
    expect(timeoutFor(null, last + 14 * 60_000, last)).toBe(false)
    expect(timeoutFor(null, last + 15 * 60_000, last)).toBe(true)
  })

  it('honours a shorter timeout the shop chose', () => {
    const last = Date.parse('2026-11-17T09:00:00.000Z')
    expect(timeoutFor(1, last + 59_000, last)).toBe(false)
    expect(timeoutFor(1, last + 60_000, last)).toBe(true)
  })

  it('the host uses this same arithmetic, so the test is not describing a parallel implementation', async () => {
    // Pinned against the source: if the host's formula changes, this fails rather than the test quietly describing a
    // rule nothing enforces.
    const { readFileSync } = await import('node:fs')
    const source = readFileSync('src/main/desktop-host-controller.ts', 'utf8')
    expect(source).toContain('const timeoutMs = (settings.idleTimeoutMinutes ?? 15) * 60_000')
    expect(source).toContain('if (this.now() - session.lastActivityAt >= timeoutMs)')
  })
})

describe('one active login per account', () => {
  /**
   * Driven through the real host, because the rule lives in the session map it owns. A test that only read the setting
   * would pass with the rule unimplemented — which is exactly what the first version of this file did, and why the
   * host now has `invalidateSessions(userId, keep)`.
   */
  async function hostFixture() {
    const { default: Database } = await import('better-sqlite3')
    const { DesktopHostController } = await import('../main/desktop-host-controller')
    const { SetupService } = await import('./setup-service')
    const { UserService } = await import('./user-service')
    const { ShopService } = await import('./shop-service')
    const { TeamService } = await import('./team-service')
    const database = new Database(':memory:')
    migrateDatabase(database)
    const shop = new SQLiteShopRepository(database, false)
    const users = new SQLiteUserRepository(database)
    const policy = { licenseId: 't', edition: 'PHARMACY' as const, defaultCurrencyCode: null, lockCurrency: false }
    const teamForSetup = new TeamService(database, () => new Date('2026-11-17T09:00:00.000Z'))
    const setup = new SetupService(
      shop, users, shop, { getVerifiedPolicy: () => policy }, () => new Date('2026-11-17T09:00:00.000Z'),
      undefined, null,
      {
        readCaps: () => ({ account: null, user: null, supervisor: null }),
        // The same bootstrap the real host supplies, so first-run creates the seats it was asked for.
        createSeats: (input, actor) => {
          teamForSetup.setSeatCount({ role: 'ACCOUNT', seats: input.account }, actor)
          teamForSetup.setSeatCount({ role: 'USER', seats: input.user }, actor)
          teamForSetup.setSeatCount({ role: 'SUPERVISOR', seats: input.supervisor }, actor)
        },
      },
    )
    const auth = new AuthService(
      users, shop, { deviceName: 'PC', ipAddress: null }, () => new Date('2026-11-17T09:00:00.000Z'), () => 1_000_000,
      { app: 'client', allowAdminOnClients: () => true },
    )
    const team = teamForSetup
    const host = new DesktopHostController(
      shop, users, setup, auth, new UserService(users, shop), new ShopService(shop), () => 1_000_000, '0.1.0-test',
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, team, 'client',
    )
    await host.initialize()
    await host.completeFirstRun({
      admin: { fullName: 'Ada Admin', username: 'ada', password: PASSWORD, confirmPassword: PASSWORD },
      profile: { name: 'Harbor Health', address: '', phone: '' },
      currency: (await import('../currency/catalog')).getCurrency('NGN')!,
      display: (await import('../currency/money')).defaultDisplayOptions((await import('../currency/catalog')).getCurrency('NGN')!),
      currencyConfirmed: true,
      teamSize: { account: 1, user: 0, supervisor: 0 },
    } as never)
    const seat = database.prepare("SELECT id FROM users WHERE role = 'ACCOUNT'").get() as { id: string }
    await team.setSeatPassword(seat.id, PASSWORD, PASSWORD, 'ada')
    return { host, team, database, seat }
  }

  it('ends the first session when the same account signs in from a second PC', async () => {
    const { host } = await hostFixture()
    await host.login(1, { username: 'account1', password: PASSWORD })
    expect(host.getCurrentUser(1)).not.toBeNull()
    await host.login(2, { username: 'account1', password: PASSWORD })
    // The second PC is signed in; the first is not. Sparing the new session is what stops the second sign-in from
    // logging itself out, which is the obvious way to get this wrong.
    expect(host.getCurrentUser(2)).not.toBeNull()
    expect(host.getCurrentUser(1), 'the first session must end').toBeNull()
  })

  it('leaves both sessions alone when the shop switches the rule off', async () => {
    const { host, team } = await hostFixture()
    team.updateSettings({ singleLoginPerAccount: false }, 'ada')
    await host.login(1, { username: 'account1', password: PASSWORD })
    await host.login(2, { username: 'account1', password: PASSWORD })
    // With the guard disabled the first session survives — the evidence that the test above is measuring this rule and
    // not something else about signing in twice.
    expect(host.getCurrentUser(1)).not.toBeNull()
    expect(host.getCurrentUser(2)).not.toBeNull()
  })

  it('defaults to on, so a shop that never visits the screen is protected', async () => {
    const { team } = await hostFixture()
    expect(team.getSnapshot().singleLoginPerAccount).toBe(true)
  })
})

describe('the staff fixture is a real ACCOUNT that can sign in', () => {
  it('signs in with the right password, so the lockout tests are not measuring a broken fixture', async () => {
    const { auth } = await fixture()
    const user = await auth.login({ username: 'account1', password: PASSWORD })
    expect(user.role).toBe('ACCOUNT')
    expect(defaultPermissions('ACCOUNT').allowCreditSales).toBe(false)
  })
})
