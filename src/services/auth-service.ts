import { randomUUID } from 'node:crypto'
import { compare as bcryptCompare, hash as bcryptHash } from 'bcryptjs'
import type { LoginInput, PublicUser } from '../shared/auth/types'
import type { AuditContext } from './shop-service'
import type { ShopRepository } from './contracts/shop-repository'
import type { StoredUser, UserRepository } from './contracts/user-repository'
import { normalizeUsername } from './setup-service'
import { rememberRateLimitState } from './rate-limit-state'

const BCRYPT_ROUNDS = 12
const FAILURE_LIMIT = 5
const FAILURE_WINDOW_MS = 15 * 60_000
const BLOCK_DURATION_MS = 15 * 60_000
const INVALID_LOGIN = 'Unable to sign in. Check your username and password or contact the Admin.'

/**
 * Which application this process is.
 *
 * The brief splits sign-in by app: the Server accepts only the Admin, a client PC accepts only the staff roles. The
 * host passes its own identity in rather than the service guessing from a setting, because a setting is something a
 * client could be pointed at.
 */
export type HostApp = 'server' | 'client'

/**
 * The refusal a person sees when they signed in correctly on the wrong application.
 *
 * It is deliberately **the same string** as every other failure and is recorded through the same failed-attempt path.
 * A distinct "the Admin cannot sign in here" message would confirm that the username exists and that it is an Admin —
 * exactly the leak the brief forbids. The reason is written to the audit log instead, where only the Admin can read it.
 */
const WRONG_APP = INVALID_LOGIN

interface FailureState {
  windowStartedAt: number
  attempts: number
  blockedUntil: number
}

export class AuthService {
  private readonly failures = new Map<string, FailureState>()
  private readonly dummyHash = bcryptHash(randomUUID(), BCRYPT_ROUNDS)

  constructor(
    private readonly users: UserRepository,
    private readonly shop: ShopRepository,
    private readonly auditContext: AuditContext = { deviceName: 'LOCAL', ipAddress: null },
    private readonly now: () => Date = () => new Date(),
    private readonly nowMs: () => number = Date.now,
    /**
     * Which application this is, and whether the Admin may sign in on a client PC.
     *
     * Supplied as functions so the answer can change while the process runs: the Admin may switch "Allow Admin sign-in
     * on client PCs" on, and the next attempt must honour it without a restart.
     */
    private readonly host: { app: HostApp; allowAdminOnClients: () => boolean } = {
      app: 'server',
      allowAdminOnClients: () => false,
    },
  ) {}

  async login(input: LoginInput): Promise<PublicUser> {
    const credentials = input && typeof input === 'object' ? input : { username: '', password: '' }
    const password = typeof credentials.password === 'string' ? credentials.password : ''
    const username = safeUsername(credentials.username)
    const rateKey = `${username.toLowerCase()}|${this.auditContext.ipAddress ?? this.auditContext.deviceName}`
    const timestamp = this.nowMs()
    if (this.isRateLimited(rateKey, timestamp)) {
      this.audit('auth.login.failed', username, { reason: 'rate_limited' })
      throw new Error(INVALID_LOGIN)
    }

    const user = username ? this.users.getUserByUsername(username) : null
    const hash = user?.passwordHash ?? await this.dummyHash
    const passwordWithinBcryptLimit = password.length <= 72 && new TextEncoder().encode(password).length <= 72
    // bcrypt ignores bytes after 72; reject overlong login input so an appended suffix never authenticates.
    const passwordMatches = (await bcryptCompare(passwordWithinBcryptLimit ? password : '', hash)) && passwordWithinBcryptLimit
    if (!user || !user.isActive || user.isLocked || !passwordMatches) {
      // A seat that has no password yet is stored inactive with a non-bcrypt placeholder hash, so it already fails here.
      // It is named separately in the audit reason because the Admin needs to be able to tell "this person has not been
      // given a password" from "this person is deactivated", and the two look identical to the database otherwise.
      const noPassword = Boolean(user && !user.passwordHash.startsWith('$2'))
      const reason = !user
        ? 'unknown_user'
        : noPassword ? 'no_password_set'
          : !user.isActive ? 'inactive_account'
            : user.isLocked ? 'account_locked'
              : 'invalid_password'
      let updatedFailedAttempts = user?.failedLoginCount ?? null
      let lockedByFailureCount = false
      if (user?.isActive && !user.isLocked && !passwordMatches) {
        const updatedUser = this.users.recordFailedLogin(user.id)
        updatedFailedAttempts = updatedUser.failedLoginCount
        lockedByFailureCount = updatedUser.isLocked
      }
      this.recordFailure(rateKey, timestamp)
      this.audit('auth.login.failed', username || 'UNKNOWN', {
        reason: lockedByFailureCount ? 'account_locked_after_failed_attempts' : reason,
        failedAttempts: updatedFailedAttempts,
      })
      throw new Error(INVALID_LOGIN)
    }

    // The password and the account are both correct. Now the application must be the one this person may use. This
    // check sits *after* the password comparison on purpose: refusing before it would let somebody learn that an Admin
    // username exists on a client PC without knowing the password, and the timing would differ from a wrong password.
    if (!this.maySignInOnThisApp(user.role)) {
      this.recordFailure(rateKey, timestamp)
      this.audit('auth.login.failed', user.username, {
        reason: 'wrong_application',
        role: user.role,
        app: this.host.app,
        // Recorded so the Admin can prove the refusal was the host rule and not a mistyped password.
        passwordVerified: true,
      })
      throw new Error(WRONG_APP)
    }

    this.failures.delete(rateKey)
    this.users.recordSuccessfulLogin(user.id)
    const refreshedUser = this.users.getUserById(user.id)
    if (!refreshedUser || !refreshedUser.isActive || refreshedUser.isLocked) throw new Error(INVALID_LOGIN)
    this.audit('auth.login.succeeded', refreshedUser.username, { userId: refreshedUser.id, role: refreshedUser.role })
    return toPublicUser(refreshedUser)
  }

  /**
   * Whether a role may sign in on this application.
   *
   * Server: the Admin, and only the Admin. Every other role is told — generically — to use the client app.
   * Client: the staff roles. The Admin is refused unless the shop has switched that on, which the brief defaults to off.
   */
  private maySignInOnThisApp(role: string): boolean {
    // A legacy `CASHIER` row resolves to USER everywhere else, so it signs in wherever a User may.
    const effective = role === 'CASHIER' ? 'USER' : role
    if (this.host.app === 'server') return effective === 'ADMIN'
    if (effective === 'ADMIN') return this.host.allowAdminOnClients()
    return true
  }

  clearLoginFailures(username: string): void {
    const prefix = `${username.toLowerCase()}|`
    for (const key of this.failures.keys()) {
      if (key.startsWith(prefix)) this.failures.delete(key)
    }
  }

  /** Use on explicit desktop logout; sessions themselves are held by the Electron host in memory. */
  auditLogout(user: PublicUser): void {
    this.audit('auth.logout', user.username, { userId: user.id, role: user.role })
  }

  private isRateLimited(key: string, timestamp: number): boolean {
    const state = this.failures.get(key)
    return Boolean(state?.blockedUntil && timestamp < state.blockedUntil)
  }

  private recordFailure(key: string, timestamp: number): void {
    const current = this.failures.get(key)
    const state = !current || timestamp - current.windowStartedAt >= FAILURE_WINDOW_MS
      ? { windowStartedAt: timestamp, attempts: 0, blockedUntil: 0 }
      : current
    state.attempts += 1
    if (state.attempts >= FAILURE_LIMIT) state.blockedUntil = timestamp + BLOCK_DURATION_MS
    // Bound memory if a desktop host receives many distinct usernames/devices.
    rememberRateLimitState(this.failures, key, state, timestamp, FAILURE_WINDOW_MS)
  }

  private audit(action: string, actor: string, metadata: Record<string, unknown>): void {
    this.shop.appendAudit({
      actor: actor.slice(0, 120) || 'UNKNOWN',
      action,
      metadata,
      deviceName: this.auditContext.deviceName,
      ipAddress: this.auditContext.ipAddress,
      createdAt: this.now().toISOString(),
    })
  }
}

export function toPublicUser(user: StoredUser): PublicUser {
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

function safeUsername(value: string): string {
  try {
    return normalizeUsername(value)
  } catch {
    return ''
  }
}
