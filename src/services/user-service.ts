import { randomUUID } from 'node:crypto'
import { hash as bcryptHash } from 'bcryptjs'
import type { AppPage, CreateUserInput, PublicUser, UpdateUserInput, UserPermissions, UserRole } from '../shared/auth/types'
import { MAX_SQLITE_MINOR_UNITS } from '../shared/auth/policy'
import type { Edition } from '../editions'
import type { AuditEvent } from '../shared/shop/types'
import { normalizeUsername, validatePasswordPair } from './setup-service'
import { isAssignableRole } from '../shared/auth/types'
import type { ShopRepository } from './contracts/shop-repository'
import type { UserRepository } from './contracts/user-repository'
import { canAccessPageForRole } from './permissions'

const BCRYPT_ROUNDS = 12

export class UserService {
  constructor(
    private readonly users: UserRepository,
    private readonly shop: ShopRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {}

  listUsers(actor: PublicUser | null): PublicUser[] {
    requireActiveAdmin(actor)
    return this.users.listUsers()
  }

  /** One row, still Admin-only: used by the phone surface, which needs a PublicUser for POS read calls. */
  getPublicUser(id: string): PublicUser | null {
    return this.users.listUsers().find((user) => user.id === id) ?? null
  }

  async createUser(actor: PublicUser | null, input: CreateUserInput, edition: Edition): Promise<PublicUser> {
    requireActiveAdmin(actor)
    assertCreateUserInput(input)
    const user = normalizeUserInput(input)
    validateRoleForEdition(user.role, edition)
    validatePermissions(user.permissions)
    if (this.users.getUserByUsername(user.username)) throw new Error('That username is already in use.')
    const passwordHash = await bcryptHash(input.password, BCRYPT_ROUNDS)
    const created: PublicUser = {
      id: this.newId(),
      fullName: user.fullName,
      username: user.username,
      role: user.role,
      isActive: true,
      isLocked: false,
      permissions: user.permissions,
    }
    this.shop.withTransaction(() => {
      this.users.createUser({ ...created, passwordHash })
      this.shop.appendAudit(this.audit(actor.username, 'user.created', {
        userId: created.id,
        username: created.username,
        role: created.role,
        permissions: auditPermissions(created.permissions),
      }))
    })
    return created
  }

  updateUser(actor: PublicUser | null, id: string, input: UpdateUserInput, edition: Edition): PublicUser {
    requireActiveAdmin(actor)
    assertUserId(id)
    assertUpdateUserInput(input)
    const current = this.users.getUserById(id)
    if (!current) throw new Error('The selected user no longer exists.')
    const next: UpdateUserInput = {
      fullName: normalizeFullName(input.fullName),
      username: normalizeUsername(input.username),
      role: input.role,
      permissions: input.permissions,
      isActive: input.isActive,
    }
    validateRoleForEdition(next.role, edition)
    validatePermissions(next.permissions)
    const duplicate = this.users.getUserByUsername(next.username)
    if (duplicate && duplicate.id !== id) throw new Error('That username is already in use.')
    this.assertAdminNotRemoved(current.role, current.isActive, next.role, next.isActive)

    this.shop.withTransaction(() => {
      this.users.updateUser(id, next)
      this.shop.appendAudit(this.audit(actor.username, 'user.updated', {
        userId: id,
        username: next.username,
        role: next.role,
        isActive: next.isActive,
        permissions: auditPermissions(next.permissions),
      }))
    })
    return { id, ...next, isLocked: current.isLocked }
  }

  deactivateUser(actor: PublicUser | null, id: string): void {
    requireActiveAdmin(actor)
    assertUserId(id)
    const user = this.users.getUserById(id)
    if (!user) throw new Error('The selected user no longer exists.')
    this.assertAdminNotRemoved(user.role, user.isActive, user.role, false)
    this.shop.withTransaction(() => {
      this.users.setActive(id, false)
      this.shop.appendAudit(this.audit(actor.username, 'user.deactivated', { userId: id, username: user.username }))
    })
  }

  async resetPassword(actor: PublicUser | null, id: string, password: string, confirmPassword: string): Promise<void> {
    requireActiveAdmin(actor)
    assertUserId(id)
    const user = this.users.getUserById(id)
    if (!user) throw new Error('The selected user no longer exists.')
    validatePasswordPair(password, confirmPassword)
    const passwordHash = await bcryptHash(password, BCRYPT_ROUNDS)
    this.shop.withTransaction(() => {
      this.users.setPassword(id, passwordHash)
      this.shop.appendAudit(this.audit(actor.username, 'user.password.reset', { userId: id, username: user.username }))
    })
  }

  unlockUser(actor: PublicUser | null, id: string): PublicUser {
    requireActiveAdmin(actor)
    assertUserId(id)
    const user = this.users.getUserById(id)
    if (!user) throw new Error('The selected user no longer exists.')
    this.shop.withTransaction(() => {
      this.users.unlockUser(id)
      this.shop.appendAudit(this.audit(actor.username, 'user.unlocked', { userId: id, username: user.username }))
    })
    return { ...toPublic(user), isLocked: false }
  }

  canAccessPage(user: PublicUser | null, page: AppPage, edition: Edition | null): boolean {
    return canAccessPageForRole(user, page, edition)
  }

  requirePageAccess(user: PublicUser | null, page: AppPage, edition: Edition | null): PublicUser {
    if (!this.canAccessPage(user, page, edition)) throw new Error('You do not have permission to open this page.')
    return user!
  }

  canMakeWholesaleSale(user: PublicUser | null): boolean {
    if (!user || !user.isActive || user.isLocked) return false
    return user.role === 'ADMIN' || user.permissions.allowWholesale
  }

  private assertAdminNotRemoved(currentRole: UserRole, currentActive: boolean, nextRole: UserRole, nextActive: boolean): void {
    if (currentRole === 'ADMIN' && currentActive && (nextRole !== 'ADMIN' || !nextActive) && this.users.countActiveAdmins() <= 1) {
      throw new Error('At least one active Admin account must remain.')
    }
  }

  private audit(actor: string, action: string, metadata: Record<string, unknown>): AuditEvent {
    return {
      actor,
      action,
      metadata,
      deviceName: 'LOCAL',
      ipAddress: null,
      createdAt: this.now().toISOString(),
    }
  }
}

export function validatePermissions(permissions: UserPermissions): void {
  if (!permissions || typeof permissions !== 'object') throw new Error('Set valid user permissions.')
  if (typeof permissions.allowWholesale !== 'boolean' || typeof permissions.allowCreditSales !== 'boolean') {
    throw new Error('Set valid user permissions.')
  }
  if (!Number.isInteger(permissions.maxDiscountBasisPoints) || permissions.maxDiscountBasisPoints < 0 || permissions.maxDiscountBasisPoints > 10_000) {
    throw new Error('Maximum discount must be between 0% and 100%.')
  }
  if (typeof permissions.returnLimitMinor !== 'bigint' || permissions.returnLimitMinor < 0n || permissions.returnLimitMinor > MAX_SQLITE_MINOR_UNITS) {
    throw new Error('Return limit must be a non-negative amount in the shop currency.')
  }
}

function assertCreateUserInput(input: CreateUserInput): void {
  if (!input || typeof input !== 'object'
    || typeof input.fullName !== 'string'
    || typeof input.username !== 'string'
    || typeof input.password !== 'string'
    || typeof input.confirmPassword !== 'string'
    || !input.permissions || typeof input.permissions !== 'object') {
    throw new Error('Enter the required user details and permissions.')
  }
}

function assertUpdateUserInput(input: UpdateUserInput): void {
  if (!input || typeof input !== 'object'
    || typeof input.fullName !== 'string'
    || typeof input.username !== 'string'
    || typeof input.isActive !== 'boolean'
    || !input.permissions || typeof input.permissions !== 'object') {
    throw new Error('Enter the required user details and permissions.')
  }
}

function normalizeUserInput(input: CreateUserInput): CreateUserInput {
  return {
    ...input,
    fullName: normalizeFullName(input.fullName),
    username: normalizeUsername(input.username),
  }
}

function normalizeFullName(value: string): string {
  const name = value.trim().replace(/\s+/gu, ' ')
  if (!name) throw new Error('Enter the user’s full name.')
  if (name.length > 120) throw new Error('Full name must be 120 characters or fewer.')
  return name
}

function validateRoleForEdition(role: UserRole, edition: Edition): void {
  // The four roles the brief names. `CASHIER` is still accepted so an existing shop can re-save an untouched account,
  // but no screen offers it — `ASSIGNABLE_ROLES` is what the creation form reads, and it omits the alias.
  if (!isAssignableRole(role) && role !== 'CASHIER') throw new Error('Choose a valid user role.')
  if (role === 'SUPERVISOR' && !editionSupportsSupervisor(edition)) {
    throw new Error('Supervisor accounts are only available in the supermarket edition.')
  }
}

function editionSupportsSupervisor(edition: Edition): boolean {
  return edition === 'SUPERMARKET' || edition === 'BOTH'
}

function assertUserId(id: string): void {
  if (typeof id !== 'string' || !id.trim() || id.length > 128) throw new Error('Choose a valid user account.')
}

function requireActiveAdmin(user: PublicUser | null): asserts user is PublicUser {
  if (!user || !user.isActive || user.isLocked || user.role !== 'ADMIN') {
    throw new Error('This action is restricted to the Admin.')
  }
}

function toPublic(user: { id: string; fullName: string; username: string; role: UserRole; isActive: boolean; isLocked: boolean; permissions: UserPermissions }): PublicUser {
  return {
    id: user.id,
    fullName: user.fullName,
    username: user.username,
    role: user.role,
    isActive: user.isActive,
    isLocked: user.isLocked,
    permissions: user.permissions,
  }
}

function auditPermissions(permissions: UserPermissions): Record<string, unknown> {
  return {
    allowWholesale: permissions.allowWholesale,
    maxDiscountBasisPoints: permissions.maxDiscountBasisPoints,
    allowCreditSales: permissions.allowCreditSales,
    returnLimitMinor: permissions.returnLimitMinor.toString(),
  }
}
