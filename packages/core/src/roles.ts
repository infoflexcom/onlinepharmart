/**
 * The four roles the product now recognises.
 *
 * The vocabulary changed with the move from a single-PC point of sale to a client/server shop system:
 *
 * - `ADMIN` is unchanged in authority. It is the only role with an approval PIN, and the only role that may
 *   open the server's settings, manage users, or act on the licence.
 * - `ACCOUNT` and `USER` together replace the old `CASHIER`. A cashier in the old design was one thing: a person
 *   at the till who could ring up a sale. In a client/server shop those separate into "a login that may exist"
 *   and "a person who may take an order and a payment", so the old role is deliberately split in two rather
 *   than renamed. **Both inherit the till capabilities the old `CASHIER` had** — the split does not take
 *   anything away from anyone — and the difference between them is organisational: `ACCOUNT` is a named login
 *   that may be signed in, `USER` is a person who may take orders and payments.
 * - `SUPERVISOR` is now **audit-only**. It may read the audit trail, sign off a session, and raise a flag. It
 *   holds no authority over money, stock, returns, discounts or voids; those powers were removed on purpose and
 *   are not merely hidden in the interface.
 *
 * `CASHIER` still exists as a **deprecated alias** and is resolved to `USER` wherever a role is read. A shop that
 * upgrades keeps every account and nobody is reclassified by surprise. New rows never store it.
 */
export const ROLES = ['ADMIN', 'SUPERVISOR', 'ACCOUNT', 'USER'] as const

export type Role = (typeof ROLES)[number]

/** Stored in the database by shops that have not yet upgraded. Read-only: never written by new code. */
export const LEGACY_ROLE_ALIASES = { CASHIER: 'USER' } as const

export type LegacyRole = keyof typeof LEGACY_ROLE_ALIASES

/** Every value the `users.role` column may legally hold, including the deprecated one. */
export const STORED_ROLES = ['ADMIN', 'SUPERVISOR', 'ACCOUNT', 'USER', 'CASHIER'] as const

export type StoredRole = (typeof STORED_ROLES)[number]

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}

/**
 * Resolve anything the database or an old client may hand us into one of the four real roles.
 *
 * Returns `null` for a role nobody recognises, so a caller must decide what an unknown role means rather than
 * silently receiving the least or most privileged one. Refusing is the only safe answer: an unrecognised role
 * must never fall through to a default that happens to be permissive.
 */
export function resolveRole(value: unknown): Role | null {
  if (isRole(value)) return value
  if (typeof value === 'string') {
    const alias = (LEGACY_ROLE_ALIASES as Record<string, Role>)[value]
    if (alias) return alias
  }
  return null
}

/** True for the roles that may operate a till: take an order and a payment. */
export function isTillRole(role: Role): boolean {
  return role === 'ACCOUNT' || role === 'USER'
}

/** True for the one role that may change the shop's configuration, users, or licence. */
export function isAdminRole(role: Role): boolean {
  return role === 'ADMIN'
}

/** True for the audit-only role. Sign-off and review, never a money movement. */
export function isAuditRole(role: Role): boolean {
  return role === 'SUPERVISOR'
}
