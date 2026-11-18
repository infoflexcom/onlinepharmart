import type { AppPage, PublicUser, UserRole } from '../shared/auth/types'
import { canAccessPageForRole } from '../shared/auth/policy'

export type { UserRole } from '../shared/auth/types'
export { canAccessPageForRole } from '../shared/auth/policy'

export interface AuthenticatedPrincipal {
  userId: string
  username: string
  role: UserRole
  isActive?: boolean
  isLocked?: boolean
}

export interface AdminPrincipal extends AuthenticatedPrincipal {
  role: 'ADMIN'
}

/** Mobile and relay authorization is hard-coded in the host; client flags are never trusted. */
export function requireAdmin(principal: AuthenticatedPrincipal | null | undefined): AdminPrincipal {
  if (!principal || principal.role !== 'ADMIN' || principal.isActive === false || principal.isLocked === true) {
    throw new Error('This account cannot use the mobile app')
  }
  return { userId: principal.userId, username: principal.username, role: 'ADMIN', isActive: true, isLocked: false }
}

export function canOpenPage(user: PublicUser | null, page: AppPage, edition: import('../editions').Edition | null): boolean {
  return canAccessPageForRole(user, page, edition)
}
