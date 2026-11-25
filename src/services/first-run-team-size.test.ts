import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrateDatabase } from '../db/migrate'
import type { LicensePolicyProvider, VerifiedLicensePolicy } from '../license/setup-policy'
import { SQLiteShopRepository } from '../db/sqlite-shop-repository'
import { SQLiteUserRepository } from '../db/sqlite-user-repository'
import { SetupService } from './setup-service'
import { TeamService } from './team-service'
import { defaultDisplayOptions } from '../currency/money'
import { getCurrency } from '../currency/catalog'

/**
 * First-run setup with a team size.
 *
 * The brief puts the team size on the setup form and requires it to happen in **one** transaction with the Admin, the
 * store details and the currency. That is the property these tests exist for: a setup that created an Admin and then
 * failed to create the seats would leave a shop unable to match the team it chose, and worse, would look finished.
 *
 * The licence is stubbed rather than minted. Minting needs the vendor's Ed25519 private key, which is deliberately not
 * in this repository, so a test that needed one could not run here at all. What matters for the transaction is that
 * the service believes a licence is active — see `LICENCE-BOUNDARY` in `docs/DECISIONS.md` for what that leaves
 * unproven.
 */

// Taken from the catalogue rather than written out: a hand-written object with an ISO code trips the service's own
// "that code is already an ISO currency" guard, which is a real guard doing its job.
const CURRENCY = getCurrency('NGN')!

function harness(options: { caps?: { account?: number | null; user?: number | null; supervisor?: number | null } } = {}) {
  const database = new Database(':memory:')
  migrateDatabase(database)
  const shop = new SQLiteShopRepository(database)
  const users = new SQLiteUserRepository(database)
  const policy: VerifiedLicensePolicy = {
    licenseId: 'test-policy', edition: 'PHARMACY', defaultCurrencyCode: null, lockCurrency: false,
  }
  const license: LicensePolicyProvider = { getVerifiedPolicy: () => policy }
  const team = new TeamService(database)
  if (options.caps) {
    team.applyLicenceCaps(
      { ACCOUNT: options.caps.account ?? null, USER: options.caps.user ?? null, SUPERVISOR: options.caps.supervisor ?? null },
      'system',
    )
  }
  const setup = new SetupService(shop, users, shop, license, undefined, undefined, null, {
    readCaps: () => {
      const counts = team.readCounts()
      const read = (role: 'ACCOUNT' | 'USER' | 'SUPERVISOR') => counts.find((entry) => entry.role === role)?.licenceCap ?? null
      return { account: read('ACCOUNT'), user: read('USER'), supervisor: read('SUPERVISOR') }
    },
    createSeats: (input, actor) => {
      team.setSeatCount({ role: 'ACCOUNT', seats: input.account }, actor)
      team.setSeatCount({ role: 'USER', seats: input.user }, actor)
      team.setSeatCount({ role: 'SUPERVISOR', seats: input.supervisor }, actor)
    },
  })
  return { database, shop, users, setup, team }
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    admin: { fullName: 'Ada Okonkwo', username: 'ada', password: 'harbour-light-7', confirmPassword: 'harbour-light-7' },
    profile: {
      name: 'Harbor Health Pharmacy', address: '12 Dock Road, Lagos', phone: '+234 1 555 0100',
      email: 'ada@harbor.test', licenceNumber: 'PCN-12345', taxNumber: 'TIN-9',
      receiptFooter: 'Thank you', thankYouNote: 'Get well soon', storeLogo: null,
    },
    currency: CURRENCY,
    display: defaultDisplayOptions(CURRENCY),
    currencyConfirmed: true,
    ...overrides,
  } as never
}

describe('first-run setup creates the team size it was given', () => {
  it('creates the seats, numbered and needing passwords, in the same transaction as the Admin', async () => {
    const { database, setup } = harness()
    await setup.completeFirstRun(input({ teamSize: { account: 2, user: 3, supervisor: 1 } }))

    const rows = database.prepare(
      "SELECT role, seat_no, password_set_at, is_active FROM users WHERE role != 'ADMIN' ORDER BY role, seat_no",
    ).all() as Array<{ role: string; seat_no: number; password_set_at: string | null; is_active: number }>
    expect(rows.filter((row) => row.role === 'ACCOUNT').map((row) => row.seat_no)).toEqual([1, 2])
    expect(rows.filter((row) => row.role === 'USER').map((row) => row.seat_no)).toEqual([1, 2, 3])
    expect(rows.filter((row) => row.role === 'SUPERVISOR').map((row) => row.seat_no)).toEqual([1])
    for (const row of rows) {
      expect(row.password_set_at, `${row.role} ${row.seat_no} must need a password`).toBeNull()
      expect(row.is_active).toBe(0)
    }
  })

  it('creates exactly one Admin, whatever the team size', async () => {
    const { database, setup } = harness()
    await setup.completeFirstRun(input({ teamSize: { account: 1, user: 1, supervisor: 0 } }))
    const admins = database.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'ADMIN'").get() as { n: number }
    expect(admins.n).toBe(1)
  })

  it('treats an absent team size as no extra seats, so an older caller still works', async () => {
    const { database, setup } = harness()
    await setup.completeFirstRun(input())
    const others = database.prepare("SELECT COUNT(*) AS n FROM users WHERE role != 'ADMIN'").get() as { n: number }
    expect(others.n).toBe(0)
  })
})

describe('a seat count over the licence cap is refused', () => {
  it('refuses during setup and says which cap stopped it', async () => {
    const { setup } = harness({ caps: { account: 1 } })
    await expect(setup.completeFirstRun(input({ teamSize: { account: 2, user: 0, supervisor: 0 } })))
      .rejects.toThrow(/licence allows 1 Account account/u)
  })

  it('writes nothing at all when the seat count is refused, which is what one transaction buys', async () => {
    const { database, setup } = harness({ caps: { account: 1 } })
    // The fixture's licence-cap call writes its own audit rows, so the comparison is against what existed before the
    // refused setup rather than against zero. Counting from zero here would have hidden a real leak.
    const auditBefore = (database.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n
    await expect(setup.completeFirstRun(input({ teamSize: { account: 2, user: 0, supervisor: 0 } }))).rejects.toThrow()
    // No Admin, no settings, no seats. A partially completed first run would be worse than a refusal, because the
    // customer would be told setup failed while an Admin existed and could sign in.
    expect((database.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(0)
    expect((database.prepare('SELECT setup_complete FROM settings WHERE id = 1').get() as { setup_complete: number }).setup_complete).toBe(0)
    expect((database.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n).toBe(auditBefore)
  })

  it('refuses a fractional or negative seat count before touching the database', async () => {
    const { database, setup } = harness()
    await expect(setup.completeFirstRun(input({ teamSize: { account: 1.5, user: 0, supervisor: 0 } })))
      .rejects.toThrow(/whole number of Account seats/u)
    expect((database.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(0)
  })
})

describe('the empty store name is still refused with a team size present', () => {
  it('refuses, because a team size does not excuse a blank shop', async () => {
    const { database, setup } = harness()
    await expect(setup.completeFirstRun(input({
      teamSize: { account: 1, user: 0, supervisor: 0 },
      profile: { ...(input() as { profile: Record<string, unknown> }).profile, name: '   ' },
    }))).rejects.toThrow(/store name/i)
    expect((database.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(0)
  })
})

describe('the setup context carries the caps and the starting team size', () => {
  it('reports the licence caps as data the form can enforce before submitting', async () => {
    const { setup } = harness({ caps: { account: 3, user: null, supervisor: 1 } })
    const context = await setup.getSetupContext()
    expect(context.seatCaps).toEqual({ account: 3, user: null, supervisor: 1 })
  })

  it('starts a fresh shop at one Account and one User, and no Supervisor', async () => {
    const { setup } = harness()
    const context = await setup.getSetupContext()
    expect(context.seatDefaults).toEqual({ account: 1, user: 1, supervisor: 0 })
  })
})
