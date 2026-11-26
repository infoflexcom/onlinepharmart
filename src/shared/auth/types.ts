/**
 * The roles the product recognises, in the brief's vocabulary.
 *
 * `CASHIER` is retained deliberately: rows written before the client/server change still store it, and refusing to
 * read them would strand a live shop's accounts. It is a **deprecated stored value**, never a role a new account is
 * created with, and `resolveRole()` in `packages/core` maps it to `USER` at every read. New code should not mention
 * it; `isAssignableRole()` is the check the user screens use to keep it out of the creation form.
 */
export type UserRole = 'ADMIN' | 'SUPERVISOR' | 'ACCOUNT' | 'USER' | 'CASHIER'

/** Roles an account may be created with. The deprecated alias is excluded on purpose. */
export const ASSIGNABLE_ROLES = ['ADMIN', 'SUPERVISOR', 'ACCOUNT', 'USER'] as const

export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number]

export function isAssignableRole(role: unknown): role is AssignableRole {
  return typeof role === 'string' && (ASSIGNABLE_ROLES as readonly string[]).includes(role)
}

/** Monetary limits use integer minor units; no permission amount is a float. */
export interface UserPermissions {
  allowWholesale: boolean
  maxDiscountBasisPoints: number
  allowCreditSales: boolean
  returnLimitMinor: bigint
}

export interface PublicUser {
  id: string
  fullName: string
  username: string
  role: UserRole
  isActive: boolean
  isLocked: boolean
  permissions: UserPermissions
}

export interface AdminAccountInput {
  fullName: string
  username: string
  password: string
  confirmPassword: string
}

export interface CreateUserInput {
  fullName: string
  username: string
  password: string
  confirmPassword: string
  role: UserRole
  permissions: UserPermissions
}

export interface UpdateUserInput {
  fullName: string
  username: string
  role: UserRole
  permissions: UserPermissions
  isActive: boolean
}

export interface ResetPasswordInput {
  password: string
  confirmPassword: string
}

export interface LoginInput {
  username: string
  password: string
}

export type AppPage =
  | 'dashboard'
  | 'pos'
  | 'orders'
  | 'products'
  | 'stock'
  | 'returns'
  | 'customers'
  | 'reports'
  | 'audit'
  | 'users'
  | 'mobile'
  | 'settings'
  | 'departments'
  | 'promotions'
  | 'loyalty'
  | 'shifts'
  | 'batches'
  | 'approvals'

export interface NavigationItem {
  id: AppPage
  label: string
}
