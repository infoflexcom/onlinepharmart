import type { AppPage, PublicUser, UserPermissions, UserRole } from './types'
import type { Edition } from '../../editions'
import { can, type Capability } from '../../../packages/core/src/capabilities'
import type { Role } from '../../../packages/core/src/roles'

export const MAX_SQLITE_MINOR_UNITS = 9_223_372_036_854_775_807n

/**
 * Which pages each page requires a capability for.
 *
 * This table is what makes the menus and the server agree. It was previously a hand-written list of pages per role,
 * and it had drifted from the brief in both directions: a SUPERVISOR could open almost every page, and a USER could
 * open Returns and Reports even though a USER may not process a return or read a report. Now each page names the
 * capability that unlocks it, and the roles come from the same capability sets the policy table uses.
 *
 * `null` in the capability column means "Admin only", for pages where no named staff capability applies — users,
 * settings, licence, backup, mobile access, approvals.
 */
const PAGE_CAPABILITY: Partial<Record<AppPage, Capability | null>> = {
  dashboard: 'view_dashboard',
  pos: 'build_order',
  // The order-to-receipt workflow. The same capability as the till, because picking goods is the first half of
  // selling them: a USER builds the order, an ACCOUNT takes payment on the same screen and sees the queue.
  orders: 'build_order',
  products: 'edit_products',
  stock: 'view_stock',
  batches: 'view_stock_detail',
  returns: 'process_returns',
  customers: 'take_payment',
  suppliers: 'edit_products',
  reports: 'view_reports',
  users: null,
  mobile: null,
  settings: null,
  license: null,
  backup: null,
  license_activation: null,
  approvals: 'approve_money',
  audit: 'view_audit',
  expenses: 'edit_stock',
  purchases: 'edit_stock',
  departments: 'edit_products',
  promotions: 'edit_products',
  loyalty: 'edit_products',
  shifts: 'do_cash_count',
} as Partial<Record<AppPage, Capability | null>>

/**
 * Whether a role may open a page, derived from the same capability sets the server enforces.
 *
 * A page with no row in `PAGE_CAPABILITY` is refused rather than allowed, for the same reason an IPC channel with no
 * policy row is refused: a new page must be given a capability deliberately.
 */
export function canAccessPageForRole(user: PublicUser | null, page: AppPage, edition: Edition | null): boolean {
  if (!user || !user.isActive || user.isLocked || !edition || !isEnabledInEdition(page, edition)) return false
  if (!Object.prototype.hasOwnProperty.call(PAGE_CAPABILITY, page)) return false
  const capability = PAGE_CAPABILITY[page]
  if (capability === null || capability === undefined) return user.role === 'ADMIN'
  // The legacy `CASHIER` row resolves to USER everywhere else; do the same here rather than granting it the till.
  const role = user.role === 'CASHIER' ? 'USER' : user.role
  return can(role as Role, capability)
}

/** Every page a role may open in an edition, for the navigation and for the tests that compare the two. */
export function pagesForRole(role: UserRole, edition: Edition): AppPage[] {
  return (Object.keys(PAGE_CAPABILITY) as AppPage[])
    .filter((page) => canAccessPageForRole({ role, isActive: true, isLocked: false } as PublicUser, page, edition))
    .sort()
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
