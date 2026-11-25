import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { migrateDatabase } from '../db/migrate'
import { TeamService, assertPasswordStrength } from './team-service'

/**
 * Team size and seats.
 *
 * Each test drives the real service against a real migrated database, because the rules here are about rows: a cap is
 * a number in `role_seats`, a seat is a row in `users`, and a refusal that only exists in a form would pass a mocked
 * test and fail a shop.
 */

function fresh(): { database: Database.Database; team: TeamService } {
  const database = new Database(':memory:')
  migrateDatabase(database)
  // Migration 1 already seeds the single settings row (`INSERT INTO settings (id) VALUES (1)`), and migration 17 adds
  // the four columns this screen reads. Writing a second insert here only invited the test to guess at column names
  // the real schema does not have, which is exactly what the first draft of this file did.
  database.prepare("UPDATE settings SET store_name = 'Harbor Health', address = '12 Dock Road' WHERE id = 1").run()
  // An Admin, so audit rows and the `updated_by` column have a real actor to point at.
  database.prepare(`
    INSERT INTO users (id, username, password_hash, role, is_active, full_name, password_set_at)
    VALUES ('admin-1', 'admin', 'hash', 'ADMIN', 1, 'Ada Admin', '2026-01-01T00:00:00.000Z')
  `).run()
  return { database, team: new TeamService(database, () => new Date('2026-11-17T10:00:00.000Z')) }
}

describe('the seat counts start from the licence', () => {
  it('starts with one Admin and no sized seats, as the brief requires', () => {
    const { team } = fresh()
    const counts = team.readCounts()
    const byRole = Object.fromEntries(counts.map((entry) => [entry.role, entry]))
    expect(byRole.ADMIN!.seats).toBe(1)
    expect(byRole.ACCOUNT!.seats).toBe(0)
    expect(byRole.USER!.seats).toBe(0)
    expect(byRole.SUPERVISOR!.seats).toBe(0)
  })

  it('reports no licence cap as null rather than zero, so it does not forbid the role', () => {
    const { team } = fresh()
    expect(team.readCounts().every((entry) => entry.licenceCap === null)).toBe(true)
  })
})

describe('raising a seat count creates real seats that need passwords', () => {
  it('creates one row per seat, numbered, named, and unable to sign in', () => {
    const { database, team } = fresh()
    team.setSeatCount({ role: 'ACCOUNT', seats: 2 }, 'admin')
    const rows = database.prepare("SELECT username, full_name, seat_no, password_set_at, is_active FROM users WHERE role = 'ACCOUNT' ORDER BY seat_no")
      .all() as Array<{ username: string; full_name: string; seat_no: number; password_set_at: string | null; is_active: number }>
    expect(rows.map((row) => row.username)).toEqual(['account1', 'account2'])
    expect(rows.map((row) => row.seat_no)).toEqual([1, 2])
    for (const row of rows) {
      expect(row.password_set_at, 'a new seat has no password').toBeNull()
      expect(row.is_active, 'a seat with no password is not active').toBe(0)
    }
    const snapshot = team.getSnapshot()
    expect(snapshot.seats.filter((seat) => seat.role === 'ACCOUNT').every((seat) => seat.needsPassword)).toBe(true)
  })

  it('does not duplicate seats when the count is raised again', () => {
    const { database, team } = fresh()
    team.setSeatCount({ role: 'USER', seats: 3 }, 'admin')
    team.setSeatCount({ role: 'USER', seats: 3 }, 'admin')
    const count = database.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'USER'").get() as { n: number }
    expect(count.n).toBe(3)
  })

  it('audits the change', () => {
    const { database, team } = fresh()
    team.setSeatCount({ role: 'SUPERVISOR', seats: 1 }, 'admin')
    const row = database.prepare("SELECT metadata_json AS metadata FROM audit_log WHERE action = 'team.seats.changed'").get() as { metadata: string } | undefined
    expect(row).toBeDefined()
    expect(JSON.parse(row!.metadata)).toMatchObject({ role: 'SUPERVISOR', from: 0, to: 1 })
  })
})

describe('a seat count cannot rise above the licence cap', () => {
  it('refuses, and names the cap that stopped it', () => {
    const { team } = fresh()
    team.applyLicenceCaps({ ACCOUNT: 2 }, 'admin')
    expect(() => team.setSeatCount({ role: 'ACCOUNT', seats: 3 }, 'admin'))
      .toThrow(/licence allows 2 Account accounts/u)
  })

  it('allows exactly the cap', () => {
    const { team } = fresh()
    team.applyLicenceCaps({ USER: 3 }, 'admin')
    expect(() => team.setSeatCount({ role: 'USER', seats: 3 }, 'admin')).not.toThrow()
    expect(team.readCounts().find((entry) => entry.role === 'USER')!.seats).toBe(3)
  })

  it('treats a cap of zero as forbidding the role, which is different from no cap', () => {
    const { team } = fresh()
    team.applyLicenceCaps({ SUPERVISOR: 0 }, 'admin')
    expect(() => team.setSeatCount({ role: 'SUPERVISOR', seats: 1 }, 'admin')).toThrow(/licence allows 0 Supervisor accounts/u)
    // A role with no cap named at all is unlimited.
    expect(() => team.setSeatCount({ role: 'ACCOUNT', seats: 10 }, 'admin')).not.toThrow()
  })
})

describe('a seat count cannot drop below the active accounts in that role', () => {
  it('refuses, and names how many accounts are in the way', async () => {
    const { database, team } = fresh()
    team.setSeatCount({ role: 'ACCOUNT', seats: 2 }, 'admin')
    const seat = database.prepare("SELECT id FROM users WHERE role = 'ACCOUNT' AND seat_no = 1").get() as { id: string }
    await team.setSeatPassword(seat.id, 'harbour-light-7', 'harbour-light-7', 'admin')

    expect(() => team.setSeatCount({ role: 'ACCOUNT', seats: 0 }, 'admin'))
      .toThrow(/1 active Account account uses a seat/u)
  })

  it('allows the drop once the account is deactivated', async () => {
    const { database, team } = fresh()
    team.setSeatCount({ role: 'ACCOUNT', seats: 1 }, 'admin')
    const seat = database.prepare("SELECT id FROM users WHERE role = 'ACCOUNT'").get() as { id: string }
    await team.setSeatPassword(seat.id, 'harbour-light-7', 'harbour-light-7', 'admin')
    // Deactivating is the Admin's other lever, and the only one that makes lowering the count honest.
    database.prepare("UPDATE users SET is_active = 0 WHERE id = ?").run(seat.id)
    expect(() => team.setSeatCount({ role: 'ACCOUNT', seats: 0 }, 'admin')).not.toThrow()
  })

  it('counts a legacy CASHIER row against USER, because that is the role it resolves to', () => {
    const { database, team } = fresh()
    database.prepare(`
      INSERT INTO users (id, username, password_hash, role, is_active, full_name, password_set_at)
      VALUES ('legacy-1', 'oldcashier', 'hash', 'CASHIER', 1, 'Old Cashier', '2026-01-01T00:00:00.000Z')
    `).run()
    expect(() => team.setSeatCount({ role: 'USER', seats: 0 }, 'admin'))
      .toThrow(/1 active User account uses a seat/u)
  })
})

describe('the Admin role is not sized', () => {
  it('refuses to size ADMIN, because the brief says one Admin exists by default', () => {
    const { team } = fresh()
    expect(() => team.setSeatCount({ role: 'ADMIN' as never, seats: 3 }, 'admin'))
      .toThrow(/Only ACCOUNT, USER and SUPERVISOR seats can be sized/u)
  })
})

describe('a seat without a password cannot sign in', () => {
  it('reports canSignIn false for a new seat and true after a password is set', async () => {
    const { database, team } = fresh()
    team.setSeatCount({ role: 'USER', seats: 1 }, 'admin')
    const seat = database.prepare("SELECT id FROM users WHERE role = 'USER'").get() as { id: string }
    expect(team.canSignIn(seat.id)).toBe(false)
    await team.setSeatPassword(seat.id, 'counter-light-4', 'counter-light-4', 'admin')
    expect(team.canSignIn(seat.id)).toBe(true)
    const row = database.prepare('SELECT password_set_at, is_active FROM users WHERE id = ?').get(seat.id) as { password_set_at: string | null; is_active: number }
    expect(row.password_set_at).not.toBeNull()
    expect(row.is_active).toBe(1)
  })

  it('clears a lockout when a password is set, so a reset is a way back in', async () => {
    const { database, team } = fresh()
    team.setSeatCount({ role: 'ACCOUNT', seats: 1 }, 'admin')
    const seat = database.prepare("SELECT id FROM users WHERE role = 'ACCOUNT'").get() as { id: string }
    database.prepare('UPDATE users SET failed_login_count = 5, locked_until = ? WHERE id = ?').run('2026-11-17T23:00:00.000Z', seat.id)
    await team.setSeatPassword(seat.id, 'counter-light-4', 'counter-light-4', 'admin')
    const row = database.prepare('SELECT failed_login_count, locked_until FROM users WHERE id = ?').get(seat.id)
    expect(row).toEqual({ failed_login_count: 0, locked_until: null })
  })

  it('never stores a bcrypt-shaped hash for a seat that has no password', () => {
    const { database, team } = fresh()
    team.setSeatCount({ role: 'USER', seats: 1 }, 'admin')
    const row = database.prepare("SELECT password_hash FROM users WHERE role = 'USER'").get() as { password_hash: string }
    // Not a bcrypt hash, so no comparison can ever succeed against it even if the active flag were flipped by mistake.
    expect(row.password_hash.startsWith('$2')).toBe(false)
    expect(row.password_hash).toContain('!no-password!')
  })
})

describe('password strength is a rule the service applies, not a hint on a form', () => {
  it('refuses short, mismatched and trivially guessable passwords', () => {
    expect(() => assertPasswordStrength('short1', 'short1')).toThrow(/at least 8 characters/u)
    expect(() => assertPasswordStrength('longenough1', 'longenough2')).toThrow(/do not match/u)
    expect(() => assertPasswordStrength('password123', 'password123')).toThrow(/too common/u)
    // One character repeated. Not `11111111`: that trips the letter-and-number rule first, so asserting the repeat
    // rule against it would be testing an order of checks rather than the rule. A repeated letter plus one digit reaches
    // the repeat check, which is the rule this assertion is about.
    expect(() => assertPasswordStrength('aaaaaaaaaa1', 'aaaaaaaaaa1')).toThrow(/repeat one character/u)
    expect(() => assertPasswordStrength('onlyletters', 'onlyletters')).toThrow(/letter and one number/u)
  })

  it('accepts a passphrase of a few words, which is what the hint recommends', () => {
    expect(() => assertPasswordStrength('harbour light 7', 'harbour light 7')).not.toThrow()
  })
})

describe('the global toggles this screen owns', () => {
  it('defaults to no supervisor cost, one login per account, no Admin on clients, and a two-hour expiry', () => {
    const { team } = fresh()
    const snapshot = team.getSnapshot()
    expect(snapshot.supervisorSeesCost).toBe(false)
    expect(snapshot.singleLoginPerAccount).toBe(true)
    expect(snapshot.allowAdminOnClients).toBe(false)
    expect(snapshot.orderExpiryMinutes).toBe(120)
  })

  it('refuses an expiry outside one minute to seven days', () => {
    const { team } = fresh()
    expect(() => team.updateSettings({ orderExpiryMinutes: 0 }, 'admin')).toThrow(/between 1 minute and 7 days/u)
    expect(() => team.updateSettings({ orderExpiryMinutes: 10_081 }, 'admin')).toThrow(/between 1 minute and 7 days/u)
  })

  it('persists a change and audits it', () => {
    const { database, team } = fresh()
    team.updateSettings({ supervisorSeesCost: true, orderExpiryMinutes: 240 }, 'admin')
    expect(team.getSnapshot().supervisorSeesCost).toBe(true)
    expect(team.getSnapshot().orderExpiryMinutes).toBe(240)
    const row = database.prepare("SELECT metadata_json AS metadata FROM audit_log WHERE action = 'team.settings.updated'").get() as { metadata: string }
    expect(JSON.parse(row.metadata)).toMatchObject({ supervisorSeesCost: true, orderExpiryMinutes: 240 })
  })
})

describe('the role summary the screen shows is the rule the server enforces', () => {
  it('describes every assignable role and says what each cannot do', () => {
    const { team } = fresh()
    const summary = team.roleSummary()
    expect(summary.map((entry) => entry.role)).toEqual(['ACCOUNT', 'USER', 'SUPERVISOR', 'ADMIN'])
    // The USER's summary must carry the brief's own prohibition, because that is what the Admin reads.
    expect(summary.find((entry) => entry.role === 'USER')!.summary).toMatch(/Cannot print, take payment, process returns/u)
    expect(summary.find((entry) => entry.role === 'SUPERVISOR')!.summary).toMatch(/Read-only/u)
  })
})

describe('the refusals fail for the stated reason, not incidentally', () => {
  let database: Database.Database
  let team: TeamService
  beforeEach(() => {
    const harness = fresh()
    database = harness.database
    team = harness.team
  })

  it('refuses a negative or fractional seat count', () => {
    expect(() => team.setSeatCount({ role: 'ACCOUNT', seats: -1 }, 'admin')).toThrow(/whole number of seats/u)
    expect(() => team.setSeatCount({ role: 'ACCOUNT', seats: 1.5 }, 'admin')).toThrow(/whole number of seats/u)
  })

  it('leaves the count untouched when a change is refused', () => {
    team.applyLicenceCaps({ ACCOUNT: 1 }, 'admin')
    expect(() => team.setSeatCount({ role: 'ACCOUNT', seats: 5 }, 'admin')).toThrow()
    expect(team.readCounts().find((entry) => entry.role === 'ACCOUNT')!.seats).toBe(0)
    expect(database.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'ACCOUNT'").get()).toEqual({ n: 0 })
  })
})

describe('the Admin approval PIN is stored hashed and never in the clear', () => {
  it('stores a bcrypt hash, not the digits', async () => {
    const { database, team } = fresh()
    await team.setApprovalPin('482913', '482913', 'admin')
    const row = database.prepare('SELECT approval_pin_hash, approval_pin_set_at FROM settings WHERE id = 1')
      .get() as { approval_pin_hash: string | null; approval_pin_set_at: string | null }
    expect(row.approval_pin_hash).not.toBeNull()
    // The digits must appear nowhere in the stored value. A reversible encoding or a fast hash of a six-digit number is
    // recoverable in milliseconds, so the assertion is about the shape as well as the absence of the literal.
    expect(row.approval_pin_hash).not.toContain('482913')
    expect(row.approval_pin_hash!.startsWith('$2')).toBe(true)
    expect(row.approval_pin_set_at).not.toBeNull()
  })

  it('never writes the PIN to the audit log', async () => {
    const { database, team } = fresh()
    await team.setApprovalPin('482913', '482913', 'admin')
    // Both columns: the action names what happened, the metadata carries the detail. A PIN could leak into either.
    const rows = database.prepare('SELECT action, metadata_json FROM audit_log').all() as Array<{ action: string; metadata_json: string }>
    const everything = rows.map((row) => `${row.action} ${row.metadata_json}`).join(' ')
    expect(everything).toContain('team.approval_pin.set')
    expect(everything).not.toContain('482913')
  })

  it('verifies the right PIN and refuses the wrong one', async () => {
    const { team } = fresh()
    await team.setApprovalPin('482913', '482913', 'admin')
    expect(await team.verifyApprovalPin('482913')).toBe(true)
    expect(await team.verifyApprovalPin('482914')).toBe(false)
    expect(await team.verifyApprovalPin('')).toBe(false)
  })

  it('refuses when no PIN is set rather than accepting the empty string', async () => {
    const { team } = fresh()
    expect(team.hasApprovalPin()).toBe(false)
    expect(await team.verifyApprovalPin('')).toBe(false)
    expect(await team.verifyApprovalPin('123456')).toBe(false)
  })

  it('reports whether a PIN is set without revealing it', async () => {
    const { team } = fresh()
    await team.setApprovalPin('482913', '482913', 'admin')
    expect(team.hasApprovalPin()).toBe(true)
  })

  it('refuses a mismatched pair, a short PIN, a repeated digit and a guessable one', async () => {
    const { team } = fresh()
    await expect(team.setApprovalPin('482913', '482914', 'admin')).rejects.toThrow(/do not match/u)
    await expect(team.setApprovalPin('123', '123', 'admin')).rejects.toThrow(/4 to 8 digits/u)
    await expect(team.setApprovalPin('123456789', '123456789', 'admin')).rejects.toThrow(/4 to 8 digits/u)
    await expect(team.setApprovalPin('aaaa', 'aaaa', 'admin')).rejects.toThrow(/4 to 8 digits/u)
    // `9999` is caught by the repeated-digit rule before the trivial list; `1111` likewise. `1234` reaches the list.
    await expect(team.setApprovalPin('9999', '9999', 'admin')).rejects.toThrow(/repeat one digit/u)
    await expect(team.setApprovalPin('1234', '1234', 'admin')).rejects.toThrow(/too easy/u)
    // A year is the commonest four-digit PIN there is.
    await expect(team.setApprovalPin('2026', '2026', 'admin')).rejects.toThrow(/too easy/u)
  })

  it('accepts a PIN that is not in the trivial list', async () => {
    const { team } = fresh()
    await expect(team.setApprovalPin('482913', '482913', 'admin')).resolves.toBeUndefined()
  })
})
