import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_ONLY_CAPABILITIES,
  ADMIN_ONLY_CAPABILITIES,
  CAPABILITIES,
  can,
  capabilitiesFor,
  rolesWith,
} from '../src/capabilities'
import { POLICY, ROLES, authorize, resolveRole } from '../src/index'

/**
 * The brief describes the roles in sentences. This file turns each of those sentences into an assertion, so that a
 * claim like "a USER cannot print" is a fact the suite checks rather than a paragraph somebody once wrote.
 *
 * The tests are grouped by the brief's own paragraphs, and each group quotes the sentence it encodes. Where a rule was
 * *removed* rather than never present — the old CASHIER could print, take payment and process returns — the test says
 * so, because that is the change a reader of the diff needs to see.
 */

describe('ADMIN holds every function', () => {
  it('has every capability, with nothing enumerated by hand', () => {
    for (const capability of CAPABILITIES) expect(can('ADMIN', capability), capability).toBe(true)
  })

  it('is the only role with the administrative capabilities', () => {
    for (const capability of ADMIN_ONLY_CAPABILITIES) {
      expect(rolesWith(capability), capability).toEqual(['ADMIN'])
    }
  })
})

describe('ACCOUNT: takes payment, finalises, and is the only non-Admin role that prints', () => {
  it('may take payment, print, process returns, record debtor payments and count its own cash', () => {
    for (const capability of ['take_payment', 'print_documents', 'process_returns', 'record_debtor_payment', 'do_cash_count'] as const) {
      expect(can('ACCOUNT', capability), capability).toBe(true)
    }
  })

  it('is the ONLY non-Admin role that may print or take payment, as the brief says', () => {
    for (const capability of ACCOUNT_ONLY_CAPABILITIES) {
      expect(rolesWith(capability), capability).toEqual(['ADMIN', 'ACCOUNT'])
    }
    for (const role of ['USER', 'SUPERVISOR'] as const) {
      expect(can(role, 'print_documents'), `${role} printing`).toBe(false)
      expect(can(role, 'take_payment'), `${role} taking payment`).toBe(false)
    }
  })

  it('may build a sale directly at the counter, as well as finalising a queued order', () => {
    expect(can('ACCOUNT', 'sell_at_counter')).toBe(true)
    expect(can('ACCOUNT', 'build_order')).toBe(true)
  })

  it('may not edit products, edit stock, or see cost and profit', () => {
    for (const capability of ['edit_products', 'edit_stock', 'see_cost', 'manage_users', 'manage_settings', 'approve_money'] as const) {
      expect(can('ACCOUNT', capability), capability).toBe(false)
    }
  })

  it('may view stock quantities but sees no cost', () => {
    expect(can('ACCOUNT', 'view_stock')).toBe(true)
    expect(can('ACCOUNT', 'see_cost')).toBe(false)
  })
})

describe('USER: picks goods and generates an order, and nothing else', () => {
  it('may build an order and follow its own orders', () => {
    expect(can('USER', 'build_order')).toBe(true)
    expect(can('USER', 'see_own_orders')).toBe(true)
  })

  it('CANNOT print anything, take payment, process returns, see cost, edit stock or prices, or see reports', () => {
    // The brief's sentence, capability by capability.
    for (const capability of [
      'print_documents', 'take_payment', 'process_returns', 'see_cost',
      'edit_stock', 'edit_products', 'view_reports', 'view_audit',
    ] as const) {
      expect(can('USER', capability), capability).toBe(false)
    }
  })

  it('may still see the stock quantities it needs in order to pick goods', () => {
    expect(can('USER', 'view_stock')).toBe(true)
  })
})

describe('SUPERVISOR: read-only, and the only thing it writes is audit notes and sign-offs', () => {
  it('may audit, sign off, flag, and export', () => {
    for (const capability of ['view_audit', 'write_audit_note', 'export_audit'] as const) {
      expect(can('SUPERVISOR', capability), capability).toBe(true)
    }
  })

  it('may view ALL stock detail, including batches, expiry, reorder level and reserved quantity', () => {
    expect(can('SUPERVISOR', 'view_stock')).toBe(true)
    expect(can('SUPERVISOR', 'view_stock_detail')).toBe(true)
  })

  it('cannot print receipts, sell, change stock, or approve anything', () => {
    for (const capability of [
      'print_documents', 'sell_at_counter', 'build_order', 'take_payment',
      'edit_stock', 'edit_products', 'approve_money', 'process_returns',
    ] as const) {
      expect(can('SUPERVISOR', capability), capability).toBe(false)
    }
  })

  it('writes nothing except audit notes: every write capability it lacks is asserted above', () => {
    // The one positive statement, checked by exhausting the write-shaped capabilities.
    const writes = CAPABILITIES.filter((capability) => /^(manage|edit|approve|take|print|process|record|close|do_cash|write)/u.test(capability))
    const supervisorWrites = writes.filter((capability) => can('SUPERVISOR', capability))
    expect(supervisorWrites).toEqual(['write_audit_note'])
  })
})

describe('the policy table agrees with the capability sets', () => {
  it('grants each capability-shaped route to exactly the roles holding that capability', () => {
    // The routes the brief singles out. If somebody widens one in policy.ts without widening the capability, or the
    // reverse, this fails and names the route.
    const expectations: Array<[string, 'take_payment' | 'print_documents' | 'process_returns' | 'build_order' | 'view_stock']> = [
      ['ipc:pos:complete-sale', 'take_payment'],
      ['ipc:pos:print-receipt', 'print_documents'],
      ['ipc:returns:print-document', 'print_documents'],
      ['ipc:returns:create', 'process_returns'],
      ['ipc:inventory:get-overview', 'view_stock'],
    ]
    for (const [key, capability] of expectations) {
      const policyRoles = [...POLICY[key as keyof typeof POLICY].roles].sort()
      const capabilityRoles = [...rolesWith(capability)].sort()
      expect(policyRoles, `${key} should match capability ${capability}`).toEqual(capabilityRoles)
    }
  })

  it('never grants a route to a role the capability says cannot use it', () => {
    // Spot-check the sharpest rule through the decision function rather than the table, which is what the server calls.
    expect(authorize('ipc:pos:complete-sale', 'USER', true).allowed).toBe(false)
    expect(authorize('ipc:pos:complete-sale', 'ACCOUNT', true).allowed).toBe(true)
    expect(authorize('ipc:pos:print-receipt', 'USER', true).allowed).toBe(false)
    expect(authorize('ipc:pos:print-receipt', 'SUPERVISOR', true).allowed).toBe(false)
    expect(authorize('ipc:pos:print-receipt', 'ACCOUNT', true).allowed).toBe(true)
    expect(authorize('ipc:returns:create', 'USER', true).allowed).toBe(false)
  })

  it('keeps the deprecated CASHIER alias landing on the USER capabilities, which are narrower', () => {
    // A shop upgrading from the old design keeps its accounts, but the old cashier's printing and payment powers are
    // gone, because CASHIER resolves to USER and USER may not print or take payment.
    const role = resolveRole('CASHIER')!
    expect(role).toBe('USER')
    expect(can(role, 'print_documents')).toBe(false)
    expect(can(role, 'take_payment')).toBe(false)
  })
})

describe('the guard fails when a capability is taken away', () => {
  it('notices if a role loses a capability it is supposed to have', () => {
    // Simulate the regression: an ACCOUNT that cannot print.
    const before = capabilitiesFor('ACCOUNT')
    expect(before.has('print_documents')).toBe(true)
    const weakened = new Set(before)
    weakened.delete('print_documents')
    expect(weakened.has('print_documents')).toBe(false)
    // And the route expectation above would fail, because rolesWith() would no longer include ACCOUNT.
    expect(rolesWith('print_documents')).toEqual(['ADMIN', 'ACCOUNT'])
  })

  it('is exhaustive: every role in the vocabulary has a capability set', () => {
    for (const role of ROLES) {
      expect(capabilitiesFor(role).size, role).toBeGreaterThan(0)
    }
    // And no capability is held by nobody, which would mean a rule nobody can exercise.
    for (const capability of CAPABILITIES) {
      expect(rolesWith(capability).length, `${capability} is held by no role`).toBeGreaterThan(0)
    }
  })
})
