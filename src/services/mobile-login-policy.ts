import { createHash, timingSafeEqual } from 'node:crypto'
import type { AuthenticatedPrincipal } from './permissions'

/**
 * One message for every failure — wrong password, unknown account, wrong role, locked account, missing
 * code. The phone therefore cannot tell whether an account exists or what role it has.
 */
export const MOBILE_LOGIN_DENIED = 'Unable to sign in. Check the username and password, or ask the desktop Admin.'

export interface MobileAccountRow {
  id: string
  username: string
  full_name: string
  role: string
  is_active: number
  locked_at: string | null
  password_hash: string
}

export type MobileEligibility =
  | { eligible: true; account: MobileAccountRow }
  | { eligible: false; reason: 'unknown_account' | 'inactive_account' | 'account_locked' | 'non_admin_role' }

/**
 * Decides whether a database row may use the mobile app. Non-Admin roles are a first-class rejection
 * reason so they can be audited, but the caller must answer with MOBILE_LOGIN_DENIED exactly as it would
 * for a bad password.
 */
export function assessMobileEligibility(row: MobileAccountRow | null | undefined): MobileEligibility {
  if (!row) return { eligible: false, reason: 'unknown_account' }
  if (row.role !== 'ADMIN') return { eligible: false, reason: 'non_admin_role' }
  if (row.is_active !== 1) return { eligible: false, reason: 'inactive_account' }
  if (row.locked_at !== null) return { eligible: false, reason: 'account_locked' }
  return { eligible: true, account: row }
}

/** Turns an eligible Admin row into the same principal shape the desktop IPC layer uses. */
export function toMobilePrincipal(account: MobileAccountRow): AuthenticatedPrincipal {
  return { userId: account.id, username: account.username, role: 'ADMIN', isActive: true, isLocked: false }
}

/**
 * A locally-trusted LAN connection may skip the authenticator, but an Internet connection never may, and
 * an Admin may require it locally as well. Pairing never substitutes for a code.
 */
export function totpRequiredFor(input: {
  isLocalNetwork: boolean
  totpEnrolled: boolean
  requireTotpOnLan: boolean
}): boolean {
  if (!input.totpEnrolled) return false
  if (!input.isLocalNetwork) return true
  return input.requireTotpOnLan
}

const PASSWORD_HASH_PREFIXES = ['$2a$', '$2b$', '$2y$']

/**
 * A bcrypt hash that no password matches, used to keep the failed-login path doing the same bcrypt work
 * for unknown accounts. Generated once per process by the caller.
 */
export function isBcryptHash(value: string): boolean {
  return PASSWORD_HASH_PREFIXES.some((prefix) => value.startsWith(prefix))
}

/**
 * Audit metadata for a refused mobile login. The username is recorded because the spec requires the
 * attempt to be traceable; the password and authenticator code never are.
 */
export function mobileLoginAuditMetadata(input: {
  reason: string
  role: string | null
  ipAddress: string | null
  deviceName: string
  userAgent: string
  totpSupplied: boolean
}): Record<string, unknown> {
  return {
    reason: input.reason,
    role: input.role,
    ipAddress: input.ipAddress,
    deviceName: input.deviceName.slice(0, 80),
    userAgent: input.userAgent.replace(/[\r\n\t\p{C}]+/gu, ' ').slice(0, 160),
    totpSupplied: input.totpSupplied,
  }
}

/** Constant-time comparison for short tokens/codes we hold as hashes rather than secrets. */
export function hashEquals(left: string, right: string): boolean {
  const a = createHash('sha256').update(left).digest()
  const b = createHash('sha256').update(right).digest()
  return timingSafeEqual(a, b)
}
