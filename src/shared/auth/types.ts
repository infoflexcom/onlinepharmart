export type UserRole = 'ADMIN' | 'SUPERVISOR' | 'CASHIER'

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
  | 'products'
  | 'stock'
  | 'returns'
  | 'customers'
  | 'reports'
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
