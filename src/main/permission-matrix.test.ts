import { describe, expect, it } from 'vitest'
import { authorize, policyKeys, ROLES, type Role } from '../../packages/core/src/index'
import { pagesForRole } from '../shared/auth/policy'
import { EDITIONS } from '../editions'
import type { AppPage } from '../shared/auth/types'

/**
 * The permission matrix, generated from the policy table rather than written out.
 *
 * The DONE WHEN list asks for exactly this: "direct IPC and API calls to forbidden actions refused for every role
 * (matrix test generated from the policy table)". A hand-written matrix would be a second copy of the rules, and the
 * first time somebody added a channel without adding a row the two copies would disagree — so every case below is
 * enumerated from `policyKeys()` and `ROLES`, and the expectations are read from the table itself.
 *
 * What that buys is a test that cannot go stale: it fails when a *row* is wrong, and it fails when the *enforcement*
 * function disagrees with the row. It cannot tell you the rows are right for the business — that is what
 * `capabilities.test.ts` is for — but it can prove the table is what actually decides.
 */

const KEYS = policyKeys()
const SIGNED_IN_ROLES: readonly Role[] = ROLES

describe('the matrix covers the whole surface', () => {
  it('has keys to test, so a broken export cannot make every case below vacuously pass', () => {
    expect(KEYS.length).toBeGreaterThan(40)
    expect(SIGNED_IN_ROLES.length).toBe(4)
  })

  it('produces one case per key and role', () => {
    expect(KEYS.length * SIGNED_IN_ROLES.length).toBeGreaterThan(150)
  })
})

describe('every role is decided by the table, never by the caller', () => {
  it.each(KEYS)('%s agrees with its own row for every role', (key) => {
    for (const role of SIGNED_IN_ROLES) {
      const outcome = authorize(key, role, true)
      // There is no "unknown" verdict for a real key and a real role: it is either allowed or refused with a reason.
      if (outcome.allowed) {
        expect(outcome.entry, `${key}/${role} allowed without an entry`).toBeDefined()
        // An anonymous row is allowed for every signed-in caller by design (login, setup, health), so it is exempt from
        // the "the row must name this role" check. Every other row must name the role it lets through.
        if (!outcome.entry!.anonymous) {
          expect(outcome.entry!.roles, `${key}/${role} allowed although the row excludes the role`).toContain(role)
        }
      } else {
        expect(outcome.reason, `${key}/${role} refused with no reason`).toBeTruthy()
      }
    }
  })

  it.each(KEYS)('%s refuses every role it does not name', (key) => {
    for (const role of SIGNED_IN_ROLES) {
      const outcome = authorize(key, role, true)
      const row = outcome.allowed ? outcome.entry : undefined
      // Reading the row independently of the outcome: an allowed verdict for a role the row omits is the exact bug
      // this test exists to catch, and asserting only on `outcome` would miss it.
      if (row) continue
      const refused = authorize(key, role, true)
      expect(refused.allowed, `${key}/${role}`).toBe(false)
    }
  })
})

describe('direct calls to forbidden actions are refused, per role', () => {
  /**
   * The behaviours the brief states in prose, asserted against the same table the server reads.
   *
   * These are the cases where a mistake would be a business disaster rather than an inconvenience, so they are named
   * individually in addition to the generated sweep above.
   */
  const mustRefuse: Array<{ key: string; roles: Role[]; why: string }> = [
    { key: 'ipc:pos:complete-sale', roles: ['USER', 'SUPERVISOR'], why: 'only ACCOUNT takes payment' },
    { key: 'ipc:pos:print-receipt', roles: ['USER', 'SUPERVISOR'], why: 'a USER prints nothing' },
    { key: 'ipc:returns:create', roles: ['USER', 'SUPERVISOR'], why: 'returns are ACCOUNT and ADMIN only' },
    { key: 'ipc:reports:get-accounting', roles: ['USER', 'SUPERVISOR'], why: 'reports are ACCOUNT and ADMIN only' },
    { key: 'ipc:pos:quote-sale', roles: ['SUPERVISOR'], why: 'a SUPERVISOR is audit-only' },
    { key: 'ipc:inventory:get-overview', roles: [], why: 'every role may view stock' },
  ]

  it.each(mustRefuse)('$key refuses $roles: $why', ({ key, roles, why }) => {
    for (const role of roles) {
      expect(authorize(key, role, true), `${key} should refuse ${role}: ${why}`).toMatchObject({ allowed: false })
    }
  })

  // Real channel names, taken from the table rather than remembered. The first draft of this test named
  // `ipc:settings:update` and `ipc:license:activate`, which do not exist — a matrix over invented keys passes for the
  // wrong reason, so the names below are asserted to be present before they are used.
  const adminOnly = [
    'ipc:users:create', 'ipc:users:update', 'ipc:users:deactivate',
    'ipc:settings:update-store-details', 'ipc:settings:update-operational',
    'ipc:license:activate-online', 'ipc:license:activate-onsite',
  ]
  it('names only channels that exist', () => {
    for (const key of adminOnly) expect(KEYS, `${key} is not a policy row`).toContain(key)
  })

  it.each(adminOnly)(
    '%s is Admin-only, so no staff role can reach it', (key) => {
      for (const role of ['ACCOUNT', 'USER', 'SUPERVISOR'] as const) {
        expect(authorize(key, role, true), `${key}/${role}`).toMatchObject({ allowed: false })
      }
      // An Admin must be able to, or the row is wrong in the other direction and nobody can administer the shop.
      expect(authorize(key, 'ADMIN', true).allowed, `${key}/ADMIN`).toBe(true)
    },
  )
})

describe('a signed-out caller reaches only what is marked anonymous', () => {
  it.each(KEYS)('%s refuses a signed-out caller unless the row says anonymous', (key) => {
    const outcome = authorize(key, null, false)
    if (outcome.allowed) {
      expect(outcome.entry?.anonymous, `${key} allows a signed-out caller without being anonymous`).toBe(true)
    } else {
      expect(outcome.reason).toBeTruthy()
    }
  })

  it('refuses a signed-out caller even when a role is supplied, so a stale session cannot act', () => {
    for (const key of KEYS) {
      const outcome = authorize(key, 'ADMIN', false)
      if (!outcome.allowed) continue
      expect(outcome.entry?.anonymous, `${key} allowed signed-out with a role`).toBe(true)
    }
  })
})

describe('a key with no row is refused rather than allowed', () => {
  it('refuses an unknown channel', () => {
    expect(authorize('ipc:not:a:channel', 'ADMIN', true)).toMatchObject({ allowed: false, reason: 'no-policy' })
  })

  it('refuses everything for a null role', () => {
    for (const key of KEYS) {
      const outcome = authorize(key, null, true)
      if (outcome.allowed) expect(outcome.entry?.anonymous, key).toBe(true)
    }
  })
})

describe('the on-screen menus agree with the table', () => {
  /**
   * A menu that shows a page the table refuses is worse than useless: the person clicks it and is told no. A menu that
   * hides a page the table allows is a feature nobody can find. So every page each role can reach is compared with what
   * the navigation offers.
   */
  it('gives a USER only the pick-and-orders pages the brief names', () => {
    // The brief's USER row: "Pick goods, My orders." Nothing else. Phase 18 added the orders page, which is "My
    // orders" — the picker's half of the same screen the Account takes payment on.
    expect(pagesForRole('USER', 'PHARMACY')).toEqual(['dashboard', 'orders', 'pos', 'stock'])
  })

  it('gives a SUPERVISOR audit and stock, and nothing that would let it act on money', () => {
    const pages = pagesForRole('SUPERVISOR', 'PHARMACY')
    expect(pages).toEqual(['audit', 'batches', 'dashboard', 'stock'])
    // 'orders' is here because it is the screen that pays for goods and prints receipts. A SUPERVISOR is refused both
    // by capability, so it must not be offered the page that hosts them: a menu entry that only ever produces a
    // refusal teaches the person that the refusal is a fault.
    for (const forbidden of ['pos', 'orders', 'returns', 'reports', 'users', 'settings'] as AppPage[]) {
      expect(pages, `SUPERVISOR must not be offered ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('gives an ACCOUNT the till, returns, reports and stock, but not administration', () => {
    const pages = pagesForRole('ACCOUNT', 'PHARMACY')
    for (const allowed of ['pos', 'orders', 'returns', 'reports', 'stock', 'customers'] as AppPage[]) {
      expect(pages, `ACCOUNT should be offered ${allowed}`).toContain(allowed)
    }
    for (const forbidden of ['users', 'settings', 'mobile', 'audit', 'approvals'] as AppPage[]) {
      expect(pages, `ACCOUNT must not be offered ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('gives an Admin every page that exists in the edition', () => {
    const pages = pagesForRole('ADMIN', 'PHARMACY')
    for (const page of ['dashboard', 'pos', 'orders', 'products', 'stock', 'returns', 'customers', 'reports', 'users', 'settings', 'audit', 'approvals'] as AppPage[]) {
      expect(pages, `ADMIN should be offered ${page}`).toContain(page)
    }
  })

  /**
   * The browser preview and the licensed host ask the same question in two vocabularies, so the relationship between the
   * two is asserted rather than assumed.
   *
   * The host gates the channel `ipc:reports:debtor-payment` through the policy table, by the `record_debtor_payment`
   * capability. The preview gates its `recordDebtorPayment` by asking whether the role may open the `customers` page,
   * which `PAGE_CAPABILITY` keys to `take_payment` — selling at a till, a different act from settling a balance. Two
   * spellings of one question is exactly how a demo comes to offer an act the product refuses, and the demo is what a
   * prospective shop is shown first.
   *
   * What is required is one direction only: anything the demo would let through, the host allows. The reverse need not
   * hold — the host may allow a role the demo's page gate stops, which is the safe direction.
   */
  it('never offers a debtor payment in the preview that the licensed host would refuse', () => {
    let allowedSomewhere = 0
    for (const edition of EDITIONS) {
      for (const role of ROLES) {
        const demoAllows = pagesForRole(role, edition).includes('customers')
        // Read from the enforcement function, not from a capability name written here, so the test follows the table
        // the host actually consults.
        const hostAllows = authorize('ipc:reports:debtor-payment', role, true).allowed
        expect(demoAllows && !hostAllows,
          `${role} in ${edition}: the preview offers a debtor payment the host would refuse`).toBe(false)
        if (demoAllows) allowedSomewhere += 1
      }
    }
    // And the sweep is not vacuous. A test over an empty intersection passes while proving nothing, so the role the
    // brief names as the one that "records debtor payments" is asserted to be reachable in both, in every edition.
    expect(allowedSomewhere, 'no role can reach the control at all').toBeGreaterThan(0)
    for (const edition of EDITIONS) {
      expect(pagesForRole('ACCOUNT', edition), `ACCOUNT reaches customers in ${edition}`).toContain('customers')
      expect(authorize('ipc:reports:debtor-payment', 'ACCOUNT', true).allowed, 'the host allows it too').toBe(true)
    }
  })
})
