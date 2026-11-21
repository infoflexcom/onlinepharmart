import type { AppPage, PublicUser, UserPermissions, UserRole } from './types'
import type { Edition } from '../../editions'

export const MAX_SQLITE_MINOR_UNITS = 9_223_372_036_854_775_807n

export function canAccessPageForRole(user: PublicUser | null, page: AppPage, edition: Edition | null): boolean {
  if (!user || !user.isActive || user.isLocked || !edition || !isEnabledInEdition(page, edition)) return false
  if (user.role === 'ADMIN') return true
  if (user.role === 'SUPERVISOR') {
    if (page === 'reports') return true
    return edition === 'SUPERMARKET' || edition === 'BOTH'
      ? !['users', 'mobile', 'settings'].includes(page)
      : false
  }
  return ['dashboard', 'pos', 'products', 'stock', 'batches', 'returns', 'customers', 'reports'].includes(page)
}

function isEnabledInEdition(page: AppPage, edition: Edition): boolean {
  if (['departments', 'promotions', 'loyalty', 'shifts'].includes(page)) return edition === 'SUPERMARKET' || edition === 'BOTH'
  if (page === 'batches') return edition === 'PHARMACY' || edition === 'BOTH'
  return true
}

export function defaultPermissions(role: UserRole): UserPermissions {
  if (role === 'ADMIN') {
    return {
      allowWholesale: true,
      maxDiscountBasisPoints: 10_000,
      allowCreditSales: true,
      returnLimitMinor: MAX_SQLITE_MINOR_UNITS,
    }
  }
  return {
    allowWholesale: role === 'CASHIER',
    maxDiscountBasisPoints: 0,
    allowCreditSales: false,
    returnLimitMinor: 0n,
  }
}
