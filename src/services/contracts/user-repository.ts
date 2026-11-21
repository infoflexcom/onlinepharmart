import type { PublicUser, UpdateUserInput, UserPermissions, UserRole } from '@shared/auth/types'

export interface StoredUser extends PublicUser {
  passwordHash: string
  failedLoginCount: number
  lockedAt: string | null
}

export interface NewStoredUser {
  id: string
  fullName: string
  username: string
  passwordHash: string
  role: UserRole
  permissions: UserPermissions
}

export interface UserRepository {
  countUsers(): number
  getUserByUsername(username: string): StoredUser | null
  getUserById(id: string): StoredUser | null
  listUsers(): PublicUser[]
  createUser(user: NewStoredUser): void
  updateUser(id: string, user: UpdateUserInput): void
  setPassword(id: string, passwordHash: string): void
  setActive(id: string, isActive: boolean): void
  recordFailedLogin(id: string): StoredUser
  recordSuccessfulLogin(id: string): void
  unlockUser(id: string): void
  countActiveAdmins(): number
}
