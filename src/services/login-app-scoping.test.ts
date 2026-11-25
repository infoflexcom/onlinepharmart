import Database from 'better-sqlite3'
import { hash as bcryptHash } from 'bcryptjs'
import { describe, expect, it } from 'vitest'
import { migrateDatabase } from '../db/migrate'
import { SQLiteShopRepository } from '../db/sqlite-shop-repository'
import { SQLiteUserRepository } from '../db/sqlite-user-repository'
import { AuthService, type HostApp } from './auth-service'

/**
 * Which application accepts which role.
 *
 * The brief is unusually specific here, so each sentence gets its own assertion:
 *
 * - "The Server login accepts only the Admin. Other roles get a generic message directing them to the client app."
 * - "Client login accepts only ACCOUNT, USER and SUPERVISOR."
 * - "Admin is refused on a client unless 'Allow Admin sign-in on client PCs' is on."
 * - "The refusal never reveals whether a username exists."
 *
 * That last one is the property worth testing hardest, because it is the one a well-meaning screen most easily breaks
 * by being helpful.
 */

const PASSWORD = 'harbour-light-7'
const SAME_MESSAGE = /Unable to sign in\. Check your username and password or contact the Admin\./u

function fixture(app: HostApp, allowAdminOnClients = false) {
  const database = new Database(':memory:')
  migrateDatabase(database)
  const shop = new SQLiteShopRepository(database, false)
  const users = new SQLiteUserRepository(database)
  let allow = allowAdminOnClients
  const auth = new AuthService(
    users, shop, { deviceName: 'TEST-DESKTOP', ipAddress: null }, () => new Date('2026-11-17T12:00:00.000Z'),
    Date.now, { app, allowAdminOnClients: () => allow },
  )
  return {
    database, auth,
    setAllowAdminOnClients: (next: boolean) => { allow = next },
  }
}

async function createUser(database: Database.Database, role: string, username: string, options: { activated?: boolean } = {}) {
  const activated = options.activated ?? true
  const hash = activated ? await bcryptHash(PASSWORD, 12) : `!no-password!placeholder`
  database.prepare(`
    INSERT INTO users (id, username, password_hash, role, is_active, full_name, failed_login_count, password_set_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  `).run(`id-${username}`, username, hash, role, activated ? 1 : 0, `${username} Person`, activated ? '2026-01-01T00:00:00.000Z' : null)
}

describe('the Server accepts only the Admin', () => {
  it('lets the Admin in', async () => {
    const { database, auth } = fixture('server')
    await createUser(database, 'ADMIN', 'ada')
    const user = await auth.login({ username: 'ada', password: PASSWORD })
    expect(user.role).toBe('ADMIN')
  })

  it.each(['ACCOUNT', 'USER', 'SUPERVISOR'])('refuses %s with the generic message', async (role) => {
    const { database, auth } = fixture('server')
    await createUser(database, role, 'staff')
    await expect(auth.login({ username: 'staff', password: PASSWORD })).rejects.toThrow(SAME_MESSAGE)
  })

  it('records that the password was right and the application was wrong, so the Admin can tell the difference', async () => {
    const { database, auth } = fixture('server')
    await createUser(database, 'ACCOUNT', 'account1')
    await expect(auth.login({ username: 'account1', password: PASSWORD })).rejects.toThrow()
    const row = database.prepare("SELECT metadata_json FROM audit_log WHERE action = 'auth.login.failed'").get() as { metadata_json: string }
    expect(JSON.parse(row.metadata_json)).toMatchObject({ reason: 'wrong_application', passwordVerified: true, role: 'ACCOUNT' })
  })

  it('does not sign the person in — no success row is written', async () => {
    const { database, auth } = fixture('server')
    await createUser(database, 'USER', 'user1')
    await expect(auth.login({ username: 'user1', password: PASSWORD })).rejects.toThrow()
    expect(database.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.login.succeeded'").get()).toEqual({ n: 0 })
  })
})

describe('the Client accepts the staff roles and refuses the Admin by default', () => {
  it.each(['ACCOUNT', 'USER', 'SUPERVISOR'])('lets %s in', async (role) => {
    const { database, auth } = fixture('client')
    await createUser(database, role, 'staff')
    const user = await auth.login({ username: 'staff', password: PASSWORD })
    expect(user.role).toBe(role)
  })

  it('refuses the Admin, with the same generic message', async () => {
    const { database, auth } = fixture('client', false)
    await createUser(database, 'ADMIN', 'ada')
    await expect(auth.login({ username: 'ada', password: PASSWORD })).rejects.toThrow(SAME_MESSAGE)
  })

  it('lets the Admin in once the shop has allowed it, without a restart', async () => {
    const { database, auth, setAllowAdminOnClients } = fixture('client', false)
    await createUser(database, 'ADMIN', 'ada')
    await expect(auth.login({ username: 'ada', password: PASSWORD })).rejects.toThrow()
    setAllowAdminOnClients(true)
    const user = await auth.login({ username: 'ada', password: PASSWORD })
    expect(user.role).toBe('ADMIN')
  })

  it('refuses the Admin with the *same* message as a non-existent username', async () => {
    const { database, auth } = fixture('client', false)
    await createUser(database, 'ADMIN', 'ada')
    const adminError = await auth.login({ username: 'ada', password: PASSWORD }).catch((error: Error) => error.message)
    const unknownError = await auth.login({ username: 'nobody', password: PASSWORD }).catch((error: Error) => error.message)
    expect(adminError).toBe(unknownError)
  })

  it('refuses an Admin whose password is wrong with the same message too, so the three cases are one', async () => {
    const { database, auth } = fixture('client', false)
    await createUser(database, 'ADMIN', 'ada')
    const wrongPassword = await auth.login({ username: 'ada', password: 'not-the-password-1' }).catch((error: Error) => error.message)
    const rightPassword = await auth.login({ username: 'ada', password: PASSWORD }).catch((error: Error) => error.message)
    expect(wrongPassword).toBe(rightPassword)
  })
})

describe('a seat with no password cannot sign in on either application', () => {
  it.each<HostApp>(['server', 'client'])('refuses on the %s', async (app) => {
    const { database, auth } = fixture(app)
    // A seat as first-run setup creates it: an inactive row with a non-bcrypt placeholder hash.
    await createUser(database, 'USER', 'user1', { activated: false })
    await expect(auth.login({ username: 'user1', password: PASSWORD })).rejects.toThrow(SAME_MESSAGE)
    const row = database.prepare("SELECT metadata_json FROM audit_log WHERE action = 'auth.login.failed'").get() as { metadata_json: string }
    // The reason names the real cause for the Admin's benefit; the person still sees the generic sentence.
    expect(JSON.parse(row.metadata_json).reason).toBe('no_password_set')
  })
})

describe('a legacy CASHIER row signs in where a USER may', () => {
  it('is refused on the Server and allowed on the Client', async () => {
    const server = fixture('server')
    await createUser(server.database, 'CASHIER', 'oldcashier')
    await expect(server.auth.login({ username: 'oldcashier', password: PASSWORD })).rejects.toThrow()

    const client = fixture('client')
    await createUser(client.database, 'CASHIER', 'oldcashier')
    const user = await client.auth.login({ username: 'oldcashier', password: PASSWORD })
    expect(user.role).toBe('CASHIER')
  })
})
