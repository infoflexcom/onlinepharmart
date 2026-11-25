/**
 * What each role may do, stated once, in the customer's own words.
 *
 * This module exists because the brief describes the four roles as *capabilities in prose* — "ACCOUNT is the ONLY
 * role (besides Admin) that can PRINT or REPRINT receipts" — and a permission table that only lists route names makes
 * that sentence impossible to check. Every claim the brief makes about a role is written here as a named
 * `Capability`, and `policy.ts` derives its role lists from these sets rather than restating them.
 *
 * Two things follow, and both matter:
 *
 * 1. **The prose can be tested.** `capabilities.test.ts` asserts the exact sentences the brief uses — that a USER
 *    cannot print, cannot take payment, cannot process returns, cannot see cost; that a SUPERVISOR is read-only and
 *    may write nothing but notes and sign-offs; that an ACCOUNT may print but may not edit products.
 * 2. **The table cannot drift from the brief.** If a future edit grants a route to a role that has no matching
 *    capability, the coverage test fails, because each route maps to a capability and the capability names its roles.
 *
 * This is a deliberately narrow vocabulary. It is not a general RBAC engine: it is the shop's own rules, written down
 * where a shopkeeper's sentence can be compared against the code.
 */
import type { Role } from './roles'

/**
 * The operations the product distinguishes. Names are chosen to match the brief's paragraphs so that a reader can
 * go from a sentence to a capability without guessing.
 */
export const CAPABILITIES = [
  // Administration: the Admin's monopoly.
  'manage_users',        // create/edit accounts, seats, passwords, permissions
  'manage_seats',        // change how many accounts of each role exist
  'manage_clients',      // approve/revoke client PCs
  'manage_settings',     // shop details, currency, VAT, printer, return window
  'manage_backup',       // back up and restore
  'manage_licence',      // activate, import, check in, view licence actions
  'edit_products',       // create/edit products, prices and costs
  'edit_stock',          // receive, adjust, stocktake, purchase orders
  'see_cost',            // see cost and profit figures
  'approve_money',       // approve discounts, credit, returns above limit, voids, overrides
  'close_day',           // close the business day
  // The till.
  'take_payment',        // finalise an order, take money, record the sale
  'print_documents',     // print or reprint receipts, invoices, credit notes
  'process_returns',     // raise and process a return within the role's limit
  'record_debtor_payment', // record a payment against a customer's credit balance
  'do_cash_count',       // complete its own end-of-day cash count
  'view_stock',          // see stock quantities without cost
  'view_stock_detail',   // see batches, expiry, reorder level and reserved quantity
  'build_order',         // pick goods and generate an unpaid order
  'sell_at_counter',     // build a sale directly at the counter
  'see_own_orders',      // follow the status of its own orders
  // Audit: the Supervisor's only writes.
  'view_audit',          // read sales, voids, discounts, reprints, refunds, credit, cash counts
  'write_audit_note',    // sign off an audited day with notes, or raise a flag
  'export_audit',        // export audit reports as PDF or Excel
  // Shared read surfaces.
  'view_reports',
  'view_dashboard',
] as const

export type Capability = (typeof CAPABILITIES)[number]

/**
 * The capability sets, read straight off the brief's role paragraphs. Each entry quotes the sentence it encodes.
 *
 * Ordering note: `ADMIN` holds every capability, and that is asserted by a test rather than by listing them all
 * again here — a second list of everything would be the kind of hand-kept mirror this project keeps deleting.
 */
const NON_ADMIN_CAPABILITIES: Record<Exclude<Role, 'ADMIN'>, ReadonlySet<Capability>> = {
  // "takes payment and FINALIZES orders; the ONLY role (besides Admin) that can PRINT or REPRINT ...; processes
  // returns within their limit; records debtor payments; does their own end-of-day cash count; may also build a sale
  // directly at the counter; can view stock quantities (no cost)."
  ACCOUNT: new Set<Capability>([
    'take_payment',
    'print_documents',
    'process_returns',
    'record_debtor_payment',
    'do_cash_count',
    'sell_at_counter',
    'build_order',
    'view_stock',
    'view_stock_detail',
    'view_dashboard',
    'see_own_orders',
    // Added this phase. The brief gives an ACCOUNT the day close and a report of the day's takings — "Sales, Returns,
    // Debtors, Day close" — so reports are part of the role. Its absence was a real omission, not a deliberate
    // restriction: the policy rows for the report and its exports are written as `withCapability('view_reports')`, so
    // without this entry an ACCOUNT would have been refused the very screen the role exists to read.
    'view_reports',
    // `do_cash_count` above already covers "does their own end-of-day cash count" and the drawer events that go with
    // it. It was listed twice here; a Set hid the duplication, so nothing would have failed if the comment had been
    // the only record of why it was there.
  ]),

  // "picks goods and GENERATES a receipt, meaning creates an order that gets an order number and an on-screen order
  // slip clearly marked NOT PAID - NOT A RECEIPT ... CANNOT print anything, take payment, process returns, see cost,
  // edit stock or prices, or see reports."
  USER: new Set<Capability>([
    'build_order',
    'view_stock',
    'see_own_orders',
    'view_dashboard',
  ]),

  // "READ-ONLY. Audits the Accounts' day ... signs off each audited day with notes and flags, and views ALL stock
  // available (quantities, batches, expiry, reorder level, reserved quantity; cost only if the Admin enables it) ...
  // Can export audit reports (PDF/Excel) but cannot print receipts, sell, change stock, or approve anything. The only
  // thing a Supervisor can write is audit notes and sign-offs."
  SUPERVISOR: new Set<Capability>([
    'view_audit',
    'write_audit_note',
    'export_audit',
    'view_stock',
    'view_stock_detail',
    'view_dashboard',
  ]),
}

/**
 * Capabilities a role holds.
 *
 * The Admin is special-cased rather than enumerated: "ADMIN: every function". Enumerating them would mean an
 * Admin lost a capability every time somebody forgot to add it to a list in a second place.
 */
export function capabilitiesFor(role: Role): ReadonlySet<Capability> {
  if (role === 'ADMIN') return new Set(CAPABILITIES)
  return NON_ADMIN_CAPABILITIES[role]
}

/**
 * The roles (Admin always included) that hold a capability, in the canonical role order.
 *
 * `policy.ts` uses this to build its role lists. A route granted to a role that does not hold the capability is a
 * contradiction, and `policy-coverage.test.ts` fails on it.
 */
export function rolesWith(capability: Capability): readonly Role[] {
  const order: Role[] = ['ADMIN', 'SUPERVISOR', 'ACCOUNT', 'USER']
  return order.filter((role) => capabilitiesFor(role).has(capability))
}

/** True when the role holds the capability. The single decision point for capability questions. */
export function can(role: Role, capability: Capability): boolean {
  return capabilitiesFor(role).has(capability)
}

/**
 * Capabilities that are **Admin-only by construction** — the ones the brief singles out as "the only role", or as
 * being removed from a role on purpose. The tests use this to prove the removal happened.
 */
export const ADMIN_ONLY_CAPABILITIES: readonly Capability[] = [
  'manage_users', 'manage_seats', 'manage_clients', 'manage_settings', 'manage_backup', 'manage_licence',
  'edit_products', 'edit_stock', 'see_cost', 'approve_money', 'close_day',
]

/** Capabilities only ACCOUNT (and Admin) hold — the brief's "the ONLY role (besides Admin)" claim. */
export const ACCOUNT_ONLY_CAPABILITIES: readonly Capability[] = [
  'take_payment', 'print_documents', 'process_returns', 'record_debtor_payment',
]
