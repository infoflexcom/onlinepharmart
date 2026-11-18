import Database from 'better-sqlite3'
import type { PublicUser, UpdateUserInput, UserPermissions } from '../shared/auth/types'
import type { NewStoredUser, StoredUser, UserRepository } from '../services/contracts/user-repository'

interface UserRow {
  id: string
  full_name: string
  username: string
  password_hash: string
  role: StoredUser['role']
  is_active: number | bigint
  failed_login_count: number | bigint
  locked_at: string | null
  allow_wholesale: number | bigint
  max_discount_pct: number | bigint
  allow_credit_sales: number | bigint
  return_limit: number | bigint
}

const USER_SELECT = `
  SELECT u.id, u.full_name, u.username, u.password_hash, u.role, u.is_active,
    u.failed_login_count, u.locked_at,
    COALESCE(p.allow_wholesale, 1) AS allow_wholesale,
    COALESCE(p.max_discount_pct, 0) AS max_discount_pct,
    COALESCE(p.allow_credit_sales, 0) AS allow_credit_sales,
    COALESCE(p.return_limit, 0) AS return_limit
  FROM users u
  LEFT JOIN user_permissions p ON p.user_id = u.id
`

export class SQLiteUserRepository implements UserRepository {
  constructor(private readonly database: Database.Database) {}

  countUsers(): number {
    return (this.database.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count
  }

  getUserByUsername(username: string): StoredUser | null {
    const row = this.database.prepare(`${USER_SELECT} WHERE u.username = ? COLLATE NOCASE`).safeIntegers().get(username) as UserRow | undefined
    return row ? mapStoredUser(row) : null
  }

  getUserById(id: string): StoredUser | null {
    const row = this.database.prepare(`${USER_SELECT} WHERE u.id = ?`).safeIntegers().get(id) as UserRow | undefined
    return row ? mapStoredUser(row) : null
  }

  listUsers(): PublicUser[] {
    const rows = this.database.prepare(`${USER_SELECT} ORDER BY CASE u.role WHEN 'ADMIN' THEN 0 WHEN 'SUPERVISOR' THEN 1 ELSE 2 END, u.full_name COLLATE NOCASE`)
      .safeIntegers().all() as UserRow[]
    return rows.map((row) => {
      const user = mapStoredUser(row)
      return {
        id: user.id,
        fullName: user.fullName,
        username: user.username,
        role: user.role,
        isActive: user.isActive,
        isLocked: user.isLocked,
        permissions: user.permissions,
      }
    })
  }

  createUser(user: NewStoredUser): void {
    this.database.prepare(`
      INSERT INTO users (id, full_name, username, password_hash, role)
      VALUES (@id, @fullName, @username, @passwordHash, @role)
    `).run({
      id: user.id,
      fullName: user.fullName,
      username: user.username,
      passwordHash: user.passwordHash,
      role: user.role,
    })
    this.writePermissions(user.id, user.permissions)
  }

  updateUser(id: string, user: UpdateUserInput): void {
    this.database.prepare(`
      UPDATE users SET full_name = ?, username = ?, role = ?, is_active = ?,
        updated_at = CURRENT_TIMESTAMP, row_version = row_version + 1
      WHERE id = ?
    `).run(user.fullName, user.username, user.role, user.isActive ? 1 : 0, id)
    this.writePermissions(id, user.permissions)
  }

  setPassword(id: string, passwordHash: string): void {
    this.database.prepare(`
      UPDATE users SET password_hash = ?, failed_login_count = 0, locked_at = NULL,
        updated_at = CURRENT_TIMESTAMP, row_version = row_version + 1
      WHERE id = ?
    `).run(passwordHash, id)
  }

  setActive(id: string, isActive: boolean): void {
    this.database.prepare(`
      UPDATE users SET is_active = ?, updated_at = CURRENT_TIMESTAMP, row_version = row_version + 1
      WHERE id = ?
    `).run(isActive ? 1 : 0, id)
  }

  recordFailedLogin(id: string): StoredUser {
    this.database.prepare(`
      UPDATE users SET
        failed_login_count = MIN(failed_login_count + 1, 5),
        locked_at = CASE WHEN failed_login_count + 1 >= 5 THEN COALESCE(locked_at, CURRENT_TIMESTAMP) ELSE locked_at END,
        updated_at = CURRENT_TIMESTAMP,
        row_version = row_version + 1
      WHERE id = ?
    `).run(id)
    const user = this.getUserById(id)
    if (!user) throw new Error('The user account no longer exists.')
    return user
  }

  recordSuccessfulLogin(id: string): void {
    this.database.prepare(`
      UPDATE users SET failed_login_count = 0, last_login_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP, row_version = row_version + 1
      WHERE id = ?
    `).run(id)
  }

  unlockUser(id: string): void {
    this.database.prepare(`
      UPDATE users SET failed_login_count = 0, locked_at = NULL, locked_until = NULL,
        updated_at = CURRENT_TIMESTAMP, row_version = row_version + 1
      WHERE id = ?
    `).run(id)
  }

  countActiveAdmins(): number {
    return (this.database.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'ADMIN' AND is_active = 1").get() as { count: number }).count
  }

  private writePermissions(userId: string, permissions: UserPermissions): void {
    this.database.prepare(`
      INSERT INTO user_permissions (user_id, allow_wholesale, max_discount_pct, allow_credit_sales, return_limit)
      VALUES (@userId, @allowWholesale, @maxDiscount, @allowCreditSales, @returnLimit)
      ON CONFLICT(user_id) DO UPDATE SET
        allow_wholesale = excluded.allow_wholesale,
        max_discount_pct = excluded.max_discount_pct,
        allow_credit_sales = excluded.allow_credit_sales,
        return_limit = excluded.return_limit,
        row_version = user_permissions.row_version + 1
    `).run({
      userId,
      allowWholesale: permissions.allowWholesale ? 1 : 0,
      maxDiscount: permissions.maxDiscountBasisPoints,
      allowCreditSales: permissions.allowCreditSales ? 1 : 0,
      returnLimit: permissions.returnLimitMinor,
    })
  }
}

function mapStoredUser(row: UserRow): StoredUser {
  const permissions: UserPermissions = {
    allowWholesale: Number(row.allow_wholesale) === 1,
    maxDiscountBasisPoints: Number(row.max_discount_pct),
    allowCreditSales: Number(row.allow_credit_sales) === 1,
    returnLimitMinor: BigInt(row.return_limit),
  }
  return {
    id: row.id,
    fullName: row.full_name,
    username: row.username,
    role: row.role,
    isActive: Number(row.is_active) === 1,
    isLocked: row.locked_at !== null,
    permissions,
    passwordHash: row.password_hash,
    failedLoginCount: Number(row.failed_login_count),
    lockedAt: row.locked_at,
  }
}
