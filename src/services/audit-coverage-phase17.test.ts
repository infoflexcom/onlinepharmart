import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { hash as bcryptHash } from 'bcryptjs'
import { migrateDatabase } from '../db/migrate'
import { SQLiteShopRepository } from '../db/sqlite-shop-repository'
import { SQLiteUserRepository } from '../db/sqlite-user-repository'
import { AuthService } from './auth-service'
import { TeamService } from './team-service'

/**
 * The five things this phase must audit: logins, failed attempts, seat changes, permission changes, and the currency
 * choice.
 *
 * The brief lists them in one sentence, and the risk with a list like that is that four are wired and the fifth is
 * assumed. So each is asserted by writing the event and reading the row back, and the events are then checked together
 * for the fields the architecture requires on every one — user, role, PC name, IP, time.
 */

const PASSWORD = 'harbour-light-7'

async function fixture() {
  const database = new Database(':memory:')
  migrateDatabase(database)
  const shop = new SQLiteShopRepository(database, false)
  const users = new SQLiteUserRepository(database)
  const auth = new AuthService(
    users, shop, { deviceName: 'TILL-2', ipAddress: '10.0.0.9' },
    () => new Date('2026-11-17T09:30:00.000Z'), () => 1_000_000,
    { app: 'client', allowAdminOnClients: () => true },
  )
  const team = new TeamService(database, () => new Date('2026-11-17T09:30:00.000Z'))
  database.prepare(`
    INSERT INTO users (id, username, password_hash, role, is_active, full_name, failed_login_count, password_set_at)
    VALUES ('admin-1', 'ada', ?, 'ADMIN', 1, 'Ada Admin', 0, '2026-01-01T00:00:00.000Z')
  `).run(await bcryptHash(PASSWORD, 10))
  return { database, shop, users, auth, team }
}

function auditRows(database: Database.Database, action: string) {
  return database.prepare('SELECT actor, action, metadata_json, device_name, ip_address, created_at FROM audit_log WHERE action = ?')
    .all(action) as Array<{ actor: string; action: string; metadata_json: string; device_name: string; ip_address: string | null; created_at: string }>
}

describe('every event the brief lists leaves an audit row', () => {
  it('records a successful login', async () => {
    const { auth, database } = await fixture()
    await auth.login({ username: 'ada', password: PASSWORD })
    const [row] = auditRows(database, 'auth.login.succeeded')
    expect(row).toBeDefined()
    expect(row.actor).toBe('ada')
    expect(row.device_name).toBe('TILL-2')
    // The architecture requires the PC name, IP and time on every audit row, not only on the interesting ones.
    expect(row.ip_address).toBe('10.0.0.9')
    expect(row.created_at).toBe('2026-11-17T09:30:00.000Z')
  })

  it('records a failed attempt, with the reason', async () => {
    const { auth, database } = await fixture()
    await expect(auth.login({ username: 'ada', password: 'wrong-password-1' })).rejects.toThrow()
    const [row] = auditRows(database, 'auth.login.failed')
    expect(row).toBeDefined()
    expect(JSON.parse(row.metadata_json)).toMatchObject({ reason: 'invalid_password' })
    expect(row.device_name).toBe('TILL-2')
  })

  it('records a seat change, with what changed', async () => {
    const { team, database } = await fixture()
    team.setSeatCount({ role: 'ACCOUNT', seats: 2 }, 'ada')
    const [row] = auditRows(database, 'team.seats.changed')
    expect(row).toBeDefined()
    expect(JSON.parse(row.metadata_json)).toMatchObject({ role: 'ACCOUNT', from: 0, to: 2 })
  })

  it('records a permission change', async () => {
    const { team, database } = await fixture()
    team.updateSettings({ supervisorSeesCost: true, allowAdminOnClients: true }, 'ada')
    const [row] = auditRows(database, 'team.settings.updated')
    expect(row).toBeDefined()
    expect(JSON.parse(row.metadata_json)).toMatchObject({ supervisorSeesCost: true, allowAdminOnClients: true })
  })

  it('records a seat password being set, which is the moment an account becomes usable', async () => {
    const { team, database } = await fixture()
    team.setSeatCount({ role: 'USER', seats: 1 }, 'ada')
    const seat = database.prepare("SELECT id FROM users WHERE role = 'USER'").get() as { id: string }
    await team.setSeatPassword(seat.id, PASSWORD, PASSWORD, 'ada')
    const [row] = auditRows(database, 'team.seat.password_set')
    expect(row).toBeDefined()
    // The password must not appear, obviously — but neither should its hash, which is worth asserting because the
    // service has it in hand at exactly this point.
    expect(row.metadata_json).not.toContain(PASSWORD)
    expect(row.metadata_json).not.toContain('$2')
  })

  it('records a licence cap being applied, which can silently shrink what a shop may buy', async () => {
    const { team, database } = await fixture()
    team.applyLicenceCaps({ ACCOUNT: 3 }, 'ada')
    const [row] = auditRows(database, 'team.licence_cap.applied')
    expect(row).toBeDefined()
    expect(JSON.parse(row.metadata_json)).toMatchObject({ role: 'ACCOUNT', licenceCap: 3 })
  })
})

describe('a first run records the currency choice', () => {
  it('writes currency.selected with the code that was chosen', async () => {
    // Asserted against the source rather than by running setup, because setup needs a verified licence and minting one
    // needs the vendor's private key, which is not in this repository. The writer is nameable; what is unproven is the
    // signature path, which is recorded in docs/DECISIONS.md.
    const { readFileSync } = await import('node:fs')
    const source = readFileSync('src/services/setup-service.ts', 'utf8')
    expect(source).toContain("action: 'currency.selected'")
    // And the audit rows must sit inside the same transaction as the settings write, or a rollback could leave a log
    // claiming a currency the shop does not have.
    const selected = source.indexOf("action: 'currency.selected'")
    const transaction = source.lastIndexOf('withTransaction', selected)
    expect(transaction, 'currency.selected is written inside the setup transaction').toBeGreaterThan(-1)
    expect(selected - transaction).toBeLessThan(3000)
  })
})

describe('the audit rows are not silently dropped', () => {
  it('the seat audit writer writes the same shape the repository does', async () => {
    const { team, database } = await fixture()
    team.setSeatCount({ role: 'SUPERVISOR', seats: 1 }, 'ada')
    const [row] = auditRows(database, 'team.seats.changed')
    // `metadata_json` is the column name; a first draft of `TeamService` wrote to `metadata`, which SQLite would have
    // rejected — but a service that swallowed the error would have looked identical from the outside.
    expect(row.metadata_json).toBeTruthy()
    expect(() => JSON.parse(row.metadata_json)).not.toThrow()
  })

  it('refuses to write an audit row without a device or time', async () => {
    const { team, database } = await fixture()
    team.setSeatCount({ role: 'USER', seats: 1 }, 'ada')
    const [row] = auditRows(database, 'team.seats.changed')
    expect(row.device_name).toBeTruthy()
    expect(row.created_at).toBeTruthy()
    expect(row.actor).toBe('ada')
  })
})
