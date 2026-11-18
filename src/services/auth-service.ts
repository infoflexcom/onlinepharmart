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
      const reason = !user ? 'unknown_user' : !user.isActive ? 'inactive_account' : user.isLocked ? 'account_locked' : 'invalid_password'
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

    this.failures.delete(rateKey)
    this.users.recordSuccessfulLogin(user.id)
    const refreshedUser = this.users.getUserById(user.id)
    if (!refreshedUser || !refreshedUser.isActive || refreshedUser.isLocked) throw new Error(INVALID_LOGIN)
    this.audit('auth.login.succeeded', refreshedUser.username, { userId: refreshedUser.id, role: refreshedUser.role })
    return toPublicUser(refreshedUser)
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
