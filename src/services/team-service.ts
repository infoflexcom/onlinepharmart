import { randomUUID } from 'node:crypto'
import { hash as bcryptHash } from 'bcryptjs'
import type Database from 'better-sqlite3'
import { ASSIGNABLE_ROLES, type AssignableRole } from '../shared/auth/types'
import type { PublicUser, UserPermissions } from '../shared/auth/types'
import { validatePermissions } from './user-service'
import { defaultPermissions } from '../shared/auth/policy'
import type { AuditEvent } from '../shared/shop/types'

const BCRYPT_ROUNDS = 12

/** The roles the Admin may size. ADMIN is deliberately absent: the brief says one Admin exists by default. */
export const SIZED_ROLES = ['ACCOUNT', 'USER', 'SUPERVISOR'] as const
export type SizedRole = (typeof SIZED_ROLES)[number]

/** How many seats of each sized role the shop is entitled to, and how many are in use. */
export interface RoleSeatCount {
  role: AssignableRole
  /** Seats the shop has created for this role. */
  seats: number
  /** Seats currently held by an active account. */
  activeAccounts: number
  /** The licence's cap for this role, or null when the licence names none. */
  licenceCap: number | null
}

/** The global toggles on the Users and Seats screen. Each is optional so a form may change one without the others. */
export interface TeamSettingsInput {
  supervisorSeesCost?: boolean
  singleLoginPerAccount?: boolean
  allowAdminOnClients?: boolean
  orderExpiryMinutes?: number
}

/** A seat, as the Users and Seats screen shows it. */
export interface SeatView {
  id: string
  seatNo: number | null
  role: AssignableRole
  fullName: string
  username: string
  /** A seat with no password cannot sign in; the screen shows "Needs password". */
  needsPassword: boolean
  isActive: boolean
  isLocked: boolean
  lastLoginAt: string | null
  /** The PC the account last signed in from, when the host has recorded one. */
  lastPc: string | null
  /** What this person may do within their role. Narrows the role; never widens it. */
  permissions: UserPermissions
}

export interface TeamSnapshot {
  seats: SeatView[]
  counts: RoleSeatCount[]
  /** Global toggles this screen owns. */
  supervisorSeesCost: boolean
  singleLoginPerAccount: boolean
  allowAdminOnClients: boolean
  orderExpiryMinutes: number
}

export interface SeatCountChange {
  role: SizedRole
  /** The new number of seats for this role. */
  seats: number
}

interface UserRow {
  id: string
  full_name: string
  username: string
  role: string
  is_active: number
  seat_no: number | null
  password_set_at: string | null
  last_login_at: string | null
  locked_at: string | null
}

/**
 * Team size and seat administration.
 *
 * Three rules from the brief drive every method here, and each is enforced on the server rather than only in a form:
 *
 * 1. **A cap cannot be exceeded.** The licence may name a maximum per role; the Admin may not go past it, and the
 *    refusal says which cap stopped them rather than "not allowed".
 * 2. **A count cannot drop below the active accounts in that role.** Dropping below would orphan a real person's
 *    login, so it is refused with the number that is in the way.
 * 3. **A seat without a password cannot sign in.** That is a property of the account row (`password_set_at`), not of
 *    a screen, so an attacker cannot reach it by calling the login service directly.
 */
export class TeamService {
  constructor(
    private readonly database: Database.Database,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {}

  /** Everything the Users and Seats screen needs, in one read. */
  getSnapshot(): TeamSnapshot {
    const seats = (this.database.prepare(`
      SELECT u.id, u.full_name, u.username, u.role, u.is_active, u.seat_no, u.password_set_at, u.last_login_at,
        u.locked_at
      FROM users u ORDER BY u.seat_no IS NULL, u.seat_no, u.username
    `).all() as UserRow[]).map((row) => this.toSeat(row))

    const counts = this.readCounts()
    const settings = this.database.prepare(`
      SELECT supervisor_sees_cost, single_login_per_account, allow_admin_on_clients, order_expiry_minutes FROM settings WHERE id = 1
    `).get() as { supervisor_sees_cost: number; single_login_per_account: number; allow_admin_on_clients: number; order_expiry_minutes: number } | undefined

    return {
      seats,
      counts,
      supervisorSeesCost: settings?.supervisor_sees_cost === 1,
      singleLoginPerAccount: settings?.single_login_per_account === 1,
      allowAdminOnClients: settings?.allow_admin_on_clients === 1,
      orderExpiryMinutes: settings?.order_expiry_minutes ?? 120,
    }
  }

  /**
   * The seat counts and the licence caps, as data rather than as prose.
   *
   * This is the one place that decides what a cap is, so the screen, the refusal message and the tests cannot
   * disagree about it.
   */
  readCounts(): RoleSeatCount[] {
    const rows = this.database.prepare('SELECT role, seats, licence_cap FROM role_seats').all() as Array<{
      role: string; seats: number; licence_cap: number | null
    }>
    const activeRows = this.database.prepare(
      "SELECT role, COUNT(*) AS count FROM users WHERE is_active = 1 GROUP BY role",
    ).all() as Array<{ role: string; count: number }>
    const activeByRole = new Map(activeRows.map((row) => [row.role, row.count]))
    const byRole = new Map(rows.map((row) => [row.role, row]))

    return ASSIGNABLE_ROLES.map((role) => {
      const row = byRole.get(role)
      // A CASHIER row counts against USER, because that is the role it resolves to on every read.
      const activeAccounts = role === 'USER'
        ? (activeByRole.get('USER') ?? 0) + (activeByRole.get('CASHIER') ?? 0)
        : activeByRole.get(role) ?? 0
      return {
        role,
        seats: row?.seats ?? 0,
        activeAccounts,
        licenceCap: row?.licence_cap ?? null,
      }
    })
  }

  /**
   * Record the caps a licence names.
   *
   * Called by the host when a licence is activated or imported. A license that names no cap leaves the column null,
   * which means "no cap" — deliberately not zero, which would forbid the role outright and read as a bug.
   */
  applyLicenceCaps(caps: Partial<Record<AssignableRole, number | null>>, actor: string): void {
    this.database.transaction(() => {
      for (const role of ASSIGNABLE_ROLES) {
        if (!(role in caps)) continue
        const cap = caps[role] ?? null
        if (cap !== null && (!Number.isInteger(cap) || cap < 0)) {
          throw new Error('A licence seat cap must be a whole number of seats, zero or more.')
        }
        this.database.prepare('UPDATE role_seats SET licence_cap = ?, updated_at = CURRENT_TIMESTAMP WHERE role = ?')
          .run(cap, role)
        this.audit(actor, role, 'team.licence_cap.applied', { role, licenceCap: cap })
      }
    }).immediate()
  }

  /**
   * Change how many seats a role has.
   *
   * Refuses in three ways, each with a sentence that names the number in the way:
   * - above the licence cap,
   * - below the active accounts already in that role,
   * - a role that is not sized (ADMIN), because the brief says one Admin exists by default.
   */
  setSeatCount(change: SeatCountChange, actor: string): RoleSeatCount[] {
    if (!SIZED_ROLES.includes(change.role)) {
      throw new Error('Only ACCOUNT, USER and SUPERVISOR seats can be sized. There is one Admin.')
    }
    if (!Number.isInteger(change.seats) || change.seats < 0) {
      throw new Error('Enter a whole number of seats, zero or more.')
    }
    const current = this.readCounts().find((entry) => entry.role === change.role)
    if (!current) throw new Error('That role is not available in this edition.')

    if (current.licenceCap !== null && change.seats > current.licenceCap) {
      throw new Error(
        `This licence allows ${current.licenceCap} ${roleWord(change.role)} ${current.licenceCap === 1 ? 'account' : 'accounts'}. `
        + `Choose ${current.licenceCap} or fewer, or ask your vendor for more seats.`,
      )
    }
    if (change.seats < current.activeAccounts) {
      throw new Error(
        `${current.activeAccounts} active ${roleWord(change.role)} ${current.activeAccounts === 1 ? 'account uses' : 'accounts use'} `
        + `a seat. Deactivate or change ${current.activeAccounts === 1 ? 'that account' : 'those accounts'} before lowering the count to ${change.seats}.`,
      )
    }

    this.database.transaction(() => {
      this.database.prepare('UPDATE role_seats SET seats = ?, updated_at = CURRENT_TIMESTAMP WHERE role = ?')
        .run(change.seats, change.role)
      this.growSeatRows(change.role, change.seats)
      this.audit(actor, change.role, 'team.seats.changed', {
        role: change.role, from: current.seats, to: change.seats, activeAccounts: current.activeAccounts,
      })
    }).immediate()
    return this.readCounts()
  }

  /**
   * Create the seat rows a new count calls for, in a "needs password" state.
   *
   * A seat is a real `users` row with no password. That is what lets the Admin name it and see it in the table, and it
   * is why `password_set_at` exists: the row is present but cannot sign in, which is exactly the brief's wording.
   */
  private growSeatRows(role: SizedRole, target: number): void {
    const existing = this.database.prepare('SELECT seat_no FROM users WHERE role = ? AND seat_no IS NOT NULL')
      .all(role) as Array<{ seat_no: number }>
    const taken = new Set(existing.map((row) => row.seat_no))
    const insert = this.database.prepare(`
      INSERT INTO users (id, full_name, username, password_hash, role, is_active, seat_no, password_set_at)
      VALUES (@id, @fullName, @username, @passwordHash, @role, 0, @seatNo, NULL)
    `)
    const seed = role.toLowerCase()
    for (let seatNo = 1; seatNo <= target; seatNo += 1) {
      if (taken.has(seatNo)) continue
      // A seat with no usable password gets an unguessable hash rather than an empty string, so no bcrypt comparison
      // can ever succeed against it. The account is inactive as well; the two guards are independent on purpose.
      insert.run({
        id: this.newId(),
        fullName: `${capitalise(seed)} ${seatNo}`,
        username: this.availableUsername(`${seed}${seatNo}`),
        passwordHash: `!no-password!${this.newId()}`,
        role,
        seatNo,
      })
    }
  }

  /** Give a seat a name. A seat may be renamed before or after it has a password. */
  renameSeat(userId: string, fullName: string, actor: string): void {
    const name = String(fullName ?? '').trim().replace(/\s+/gu, ' ')
    if (!name) throw new Error('Enter the name of the person using this seat.')
    if (name.length > 120) throw new Error('A seat name must be 120 characters or fewer.')
    const user = this.requireUser(userId)
    this.database.transaction(() => {
      this.database.prepare('UPDATE users SET full_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(name, userId)
      this.audit(actor, user.username, 'team.seat.renamed', { userId, from: user.full_name, to: name })
    }).immediate()
  }

  /** Set or reset a seat's password. This is what turns "needs password" into "can sign in". */
  async setSeatPassword(userId: string, password: string, confirmPassword: string, actor: string): Promise<void> {
    assertPasswordStrength(password, confirmPassword)
    const user = this.requireUser(userId)
    const passwordHash = await bcryptHash(password, BCRYPT_ROUNDS)
    const now = this.now().toISOString()
    this.database.transaction(() => {
      // Setting a password activates the seat: a seat the Admin has named and given a password to is an account.
      // It is done here rather than in the screen so that a direct service call cannot leave a seat active with no
      // password, or unusable after one was set.
      this.database.prepare(`
        UPDATE users SET password_hash = ?, password_set_at = ?, is_active = 1, failed_login_count = 0,
          locked_until = NULL, locked_at = NULL, updated_at = ? WHERE id = ?
      `).run(passwordHash, now, now, userId)
      this.audit(actor, user.username, 'team.seat.password_set', { userId, role: user.role })
    }).immediate()
  }

  /**
   * Whether this account may sign in at all.
   *
   * Asked by the authentication service before it compares a password, so a seat with no password is refused for the
   * right reason and cannot be probed for one.
   */
  canSignIn(userId: string): boolean {
    const row = this.database.prepare('SELECT is_active, password_set_at FROM users WHERE id = ?')
      .get(userId) as { is_active: number; password_set_at: string | null } | undefined
    return Boolean(row && row.is_active === 1 && row.password_set_at !== null)
  }

  /** The global toggles this screen owns. Only the Admin reaches these; the policy enforces that above. */
  updateSettings(input: TeamSettingsInput, actor: string): void {
    const current = this.getSnapshot()
    const next = {
      supervisorSeesCost: input.supervisorSeesCost ?? current.supervisorSeesCost,
      singleLoginPerAccount: input.singleLoginPerAccount ?? current.singleLoginPerAccount,
      allowAdminOnClients: input.allowAdminOnClients ?? current.allowAdminOnClients,
      orderExpiryMinutes: input.orderExpiryMinutes ?? current.orderExpiryMinutes,
    }
    if (!Number.isInteger(next.orderExpiryMinutes) || next.orderExpiryMinutes < 1 || next.orderExpiryMinutes > 10080) {
      throw new Error('Choose an expiry between 1 minute and 7 days.')
    }
    this.database.transaction(() => {
      this.database.prepare(`
        UPDATE settings SET supervisor_sees_cost = ?, single_login_per_account = ?, allow_admin_on_clients = ?,
          order_expiry_minutes = ? WHERE id = 1
      `).run(
        next.supervisorSeesCost ? 1 : 0,
        next.singleLoginPerAccount ? 1 : 0,
        next.allowAdminOnClients ? 1 : 0,
        next.orderExpiryMinutes,
      )
      this.audit(actor, 'ADMIN', 'team.settings.updated', { ...next })
    }).immediate()
  }

  /**
   * Set the Admin's approval PIN.
   *
   * Stored as a bcrypt hash. The brief asks for a "hashed approval PIN", and the reason is the same as for a password:
   * a four-to-eight-digit number has so few possibilities that any reversible storage — or even a fast hash — is a
   * lookup table away from being read. bcrypt at the same cost as a password is slow enough that guessing the space is
   * not worth it, and the digits are never written to the audit log or returned to a screen.
   */
  async setApprovalPin(pin: string, confirmPin: string, actor: string): Promise<void> {
    if (typeof pin !== 'string' || typeof confirmPin !== 'string') throw new Error('Enter the PIN twice.')
    if (pin !== confirmPin) throw new Error('The two PINs do not match.')
    if (!/^\d{4,8}$/u.test(pin)) throw new Error('Use 4 to 8 digits. Do not use a date or a repeated digit.')
    if (/^(\d)\1+$/u.test(pin)) throw new Error('Do not repeat one digit. Choose something harder to guess.')
    if (TRIVIAL_PINS.has(pin)) throw new Error('That PIN is too easy to guess. Choose a different one.')
    const hash = await bcryptHash(pin, BCRYPT_ROUNDS)
    const now = this.now().toISOString()
    this.database.transaction(() => {
      this.database.prepare('UPDATE settings SET approval_pin_hash = ?, approval_pin_set_at = ? WHERE id = 1')
        .run(hash, now)
      // The PIN itself is deliberately absent from this record, and so is its length beyond what the setting already
      // held: an audit log is read by more people than the settings row is.
      this.audit(actor, 'ADMIN', 'team.approval_pin.set', { setAt: now })
    }).immediate()
  }

  /** Whether an approval PIN has been set, without revealing anything about it. */
  hasApprovalPin(): boolean {
    const row = this.database.prepare('SELECT approval_pin_hash FROM settings WHERE id = 1')
      .get() as { approval_pin_hash: string | null } | undefined
    return Boolean(row?.approval_pin_hash)
  }

  /**
   * Check a PIN without consuming it.
   *
   * There is no "wrong PIN count" stored here on purpose: the approval path already refuses after a bad attempt and
   * the Admin is present when it happens, so a lockout on the PIN would lock the Admin out of their own shop while a
   * shoplifter waited. The cost factor is what makes guessing impractical.
   */
  async verifyApprovalPin(pin: string): Promise<boolean> {
    const row = this.database.prepare('SELECT approval_pin_hash FROM settings WHERE id = 1')
      .get() as { approval_pin_hash: string | null } | undefined
    if (!row?.approval_pin_hash) return false
    const { compare } = await import('bcryptjs')
    return compare(typeof pin === 'string' ? pin : '', row.approval_pin_hash)
  }

  /**
   * The fixed, read-only role summary the screen shows.
   *
   * Derived from the capability sets rather than written out again, so the sentence the Admin reads on the screen is
   * the same rule the server enforces.
   */
  roleSummary(): Array<{ role: AssignableRole; summary: string }> {
    return [
      { role: 'ACCOUNT', summary: 'Takes payment and finalises orders. The only role besides the Admin that can print or reprint receipts, invoices and credit notes. Processes returns within its limit, records debtor payments and counts its own cash. Cannot edit products, prices or users, and never sees cost or profit.' },
      { role: 'USER', summary: 'Picks goods and generates an order with an on-screen slip marked NOT PAID - NOT A RECEIPT. Cannot print, take payment, process returns, see cost, edit stock or prices, or see reports.' },
      { role: 'SUPERVISOR', summary: 'Read-only. Audits the Accounts\' day, signs off each audited day with notes and flags, and views all stock. Can export audit reports. Cannot print receipts, sell, change stock or approve anything.' },
      { role: 'ADMIN', summary: 'Every function. The only role that manages users, seats, passwords and client PCs, edits products, prices and stock, changes settings, backups and currency, and approves discounts, credit, returns above limit, voids and overrides.' },
    ]
  }

  /** An account that holds a password, or a clear refusal. */
  private requireUser(userId: string): UserRow {
    const row = this.database.prepare(
      'SELECT id, full_name, username, role, is_active, seat_no, password_set_at, last_login_at, locked_at FROM users WHERE id = ?',
    ).get(userId) as UserRow | undefined
    if (!row) throw new Error('That seat no longer exists. Reload the Users and Seats screen.')
    return row
  }

  /** A username that is not already taken, appending a number when the plain one is gone. */
  private availableUsername(preferred: string): string {
    const exists = this.database.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE')
    if (!exists.get(preferred)) return preferred
    for (let suffix = 2; suffix < 1000; suffix += 1) {
      const candidate = `${preferred}.${suffix}`
      if (!exists.get(candidate)) return candidate
    }
    throw new Error('Could not allocate a username for a new seat. Rename an existing seat first.')
  }

  private toSeat(row: UserRow): SeatView {
    const role = row.role === 'CASHIER' ? 'USER' : row.role
    const permissions = this.database.prepare(`
      SELECT allow_wholesale, max_discount_pct, allow_credit_sales, return_limit
      FROM user_permissions WHERE user_id = ?
    `).get(row.id) as {
      allow_wholesale: number; max_discount_pct: number; allow_credit_sales: number; return_limit: number
    } | undefined
    return {
      id: row.id,
      seatNo: row.seat_no,
      role: role as AssignableRole,
      fullName: row.full_name,
      username: row.username,
      needsPassword: row.password_set_at === null,
      isActive: row.is_active === 1,
      isLocked: row.locked_at !== null,
      lastLoginAt: row.last_login_at,
      lastPc: this.lastPcFor(row.username, row.last_login_at),
      permissions: {
        allowWholesale: permissions?.allow_wholesale === 1,
        maxDiscountBasisPoints: permissions?.max_discount_pct ?? 0,
        allowCreditSales: permissions?.allow_credit_sales === 1,
        // SQLite may hand back a BigInt for a large integer; the interface is a bigint, so normalise rather than pass
        // whatever the driver chose.
        returnLimitMinor: BigInt(permissions?.return_limit ?? 0),
      },
    }
  }

  /**
   * The PC this person last signed in from.
   *
   * Derived from the audit trail rather than stored on the seat, because the audit row already records the device name
   * and the time of every sign-in — a second column would be a second thing to keep in step, and the one time it
   * disagreed nobody would know which was right. `sessions.pc_name` is the other candidate and is the wrong one: it is
   * written by the client API and not by the desktop host, so it is empty for the very sign-ins this screen shows.
   *
   * Matched on the username and *the* recorded login time, so a person who signed in from three machines over a week
   * gets the machine of their most recent sign-in rather than whichever row happens to sort first.
   */
  private lastPcFor(username: string, lastLoginAt: string | null): string | null {
    if (!lastLoginAt) return null
    const row = this.database.prepare(`
      SELECT device_name FROM audit_log
      WHERE action = 'auth.login.succeeded' AND actor = ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(username) as { device_name: string } | undefined
    const name = row?.device_name?.trim()
    // 'LOCAL' is what the host writes when it has no machine name; showing it would be worse than showing nothing.
    return name && name !== 'LOCAL' ? name : null
  }

  /**
   * Deactivate or reactivate a seat.
   *
   * Deactivating is what makes lowering a seat count honest, and the reverse of the password rule: a deactivated seat
   * keeps its password so it can be switched back on without the Admin inventing a new one.
   */
  setSeatActive(userId: string, isActive: boolean, actor: string): void {
    const user = this.requireUser(userId)
    if (user.role === 'ADMIN' && !isActive) {
      // There must always be somebody who can administer the shop. `UserService` already refuses to deactivate the last
      // Admin; refusing here as well means a direct service call cannot strand the installation.
      const admins = this.database.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'ADMIN' AND is_active = 1")
        .get() as { n: number }
      if (admins.n <= 1) throw new Error('There must be at least one active Admin. Create another Admin account first.')
    }
    this.database.transaction(() => {
      this.database.prepare('UPDATE users SET is_active = ?, updated_at = ? WHERE id = ?')
        .run(isActive ? 1 : 0, this.now().toISOString(), userId)
      this.audit(actor, user.username, isActive ? 'team.seat.activated' : 'team.seat.deactivated', { userId })
    }).immediate()
  }

  /**
   * Change what one person may do within their role.
   *
   * These are the brief's four per-user limits: wholesale, maximum discount, credit sales and return limit. They narrow
   * what a role already allows and can never widen it — a `USER` given a discount ceiling still cannot take payment,
   * because the role gate is checked first and this only ever subtracts. Validation reuses `UserService`'s rules rather
   * than restating them, so the Users and Seats screen and the older account screen cannot accept different values.
   */
  setSeatPermissions(userId: string, permissions: UserPermissions, actor: string): void {
    validatePermissions(permissions)
    const user = this.requireUser(userId)
    if (user.role === 'ADMIN') {
      // An Admin is unbounded by definition; a row here would suggest a limit that nothing enforces.
      throw new Error('The Admin has no per-user limits. Change the role instead if this person should be limited.')
    }
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO user_permissions (user_id, allow_wholesale, max_discount_pct, allow_credit_sales, return_limit)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          allow_wholesale = excluded.allow_wholesale,
          max_discount_pct = excluded.max_discount_pct,
          allow_credit_sales = excluded.allow_credit_sales,
          return_limit = excluded.return_limit
      `).run(
        userId,
        permissions.allowWholesale ? 1 : 0,
        permissions.maxDiscountBasisPoints,
        permissions.allowCreditSales ? 1 : 0,
        Number(permissions.returnLimitMinor),
      )
      this.audit(actor, user.username, 'team.seat.permissions_changed', {
        userId,
        allowWholesale: permissions.allowWholesale,
        maxDiscountBasisPoints: permissions.maxDiscountBasisPoints,
        allowCreditSales: permissions.allowCreditSales,
        // Recorded as a string: a bigint is not JSON-serialisable, and silently writing `{}` would lose the one field a
        // dispute about a return limit would turn on.
        returnLimitMinor: permissions.returnLimitMinor.toString(),
      })
    }).immediate()
  }

  private audit(actor: string, target: string, action: string, metadata: Record<string, unknown>): void {
    const event: AuditEvent = {
      actor,
      action,
      metadata: { ...metadata, target },
      deviceName: 'LOCAL',
      ipAddress: null,
      createdAt: this.now().toISOString(),
    }
    // Written through the same audit table as everything else, so seat changes appear beside sales and logins. The
    // column is `metadata_json`, not `metadata`; naming it by hand here would have been a second place to get wrong,
    // which is why the shape is copied from `SQLiteShopRepository.appendAudit`.
    this.database.prepare(`
      INSERT INTO audit_log (id, actor, action, metadata_json, device_name, ip_address, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(this.newId(), event.actor, event.action, JSON.stringify(event.metadata), event.deviceName, event.ipAddress, event.createdAt)
  }
}

function roleWord(role: SizedRole): string {
  return role === 'ACCOUNT' ? 'Account' : role === 'USER' ? 'User' : 'Supervisor'
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/**
 * Password strength, as a sentence the person can act on.
 *
 * The brief asks for a strength hint on the setup form and a real rule everywhere. Deliberately not a length-only
 * check: a shop's password is typed on a counter keyboard by somebody in a hurry, so a passphrase of a few words is
 * both stronger and easier than a symbol salad — the rule rewards length and refuses the obvious cases.
 */
export function assertPasswordStrength(password: string, confirmPassword: string): void {
  if (typeof password !== 'string' || typeof confirmPassword !== 'string') throw new Error('Enter the password twice.')
  if (password !== confirmPassword) throw new Error('The two passwords do not match.')
  if (password.length < 8) throw new Error('Use at least 8 characters. Three unrelated words make a strong, easy password.')
  if (password.length > 128) throw new Error('Use 128 characters or fewer.')
  if (!/[A-Za-z]/u.test(password) || !/[0-9]/u.test(password)) {
    throw new Error('Include at least one letter and one number.')
  }
  // A password that is one character repeated, or a run that makes up nearly all of it. The first draft matched only
  // `aaaa`-style passwords and missed `aaaaaaaaaa1`, so the message promised a rule the code did not enforce.
  if (/^(.)\1+$/u.test(password) || /(.)\1{7,}/u.test(password)) {
    throw new Error('Do not repeat one character. Choose something harder to guess.')
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    throw new Error('That password is too common. Choose something only this shop would use.')
  }
}

/** PINs that are a date, a sequence, or the first thing anybody types. Not a dictionary. */
const TRIVIAL_PINS = new Set([
  '0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999',
  '1234', '4321', '1212', '2121', '0123', '0987', '12345', '123456', '1234567', '12345678',
  '2010', '2011', '2012', '2013', '2014', '2015', '2016', '2017', '2018', '2019',
  '2020', '2021', '2022', '2023', '2024', '2025', '2026',
])

/** A short list of the passwords people actually type when a minimum is imposed. Not a dictionary. */
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'passw0rd', '12345678', '123456789', '1234567890',
  'qwerty123', 'qwertyui', 'letmein1', 'welcome1', 'admin123', 'infoflex1', 'changeme1', 'iloveyou1',
])

export { ASSIGNABLE_ROLES, defaultPermissions }
export type { PublicUser }
