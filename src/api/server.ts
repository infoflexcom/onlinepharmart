import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { isIP } from 'node:net'
import websocket from '@fastify/websocket'
import type { ServerOptions as TlsOptions } from 'node:https'
import type { ShopService } from '../services/shop-service'
import type { LicenseSummary } from '../shared/license/types'
import type { ReturnApprovalDecision, ReturnRecord } from '../shared/returns/types'
import type { ReturnService } from '../services/return-service'
import { AccountingReportService, buildMobileAccountingSummary } from '../services/accounting-report-service'
import type { AccountingReport, MobileAccountingSummary, ReportPeriodInput } from '../shared/reports/types'
import { serializeBigInts } from './serialize-money'
import type { Edition } from '../editions'
import { registerMobileClientRoutes } from './mobile-client'
import { registerMobileAdminRoutes } from './mobile-admin-routes'
import { requireAdmin, type AdminPrincipal, type AuthenticatedPrincipal } from '../services/permissions'
import type { MobileLoginInput, MobileLoginResult, MobilePairInput, MobilePushEvent, MobileSessionCredentials } from '../shared/mobile/types'
import { rememberRateLimitState } from '../services/rate-limit-state'
import { RELAY_ARRIVAL_HEADER } from '../shared/relay/protocol'
import { authorize, hasPolicy, httpKey, resolveRole } from '../../packages/core/src/index'

export type AdminAuthenticator = (request: FastifyRequest) => Promise<AuthenticatedPrincipal | null>

export interface HostApiOptions {
  service: Pick<ShopService, 'getSettings' | 'recordDeniedAccess'>
  license: { getSnapshot(): LicenseSummary }
  authenticate: AdminAuthenticator
  /** Shared host service adapter; it must re-verify the Admin against current SQLite identity. */
  returnApprovals?: {
    listPendingMobileApprovals(admin: AuthenticatedPrincipal): ReturnRecord[]
    resolveMobileApproval(returnId: string, decision: ReturnApprovalDecision, admin: AuthenticatedPrincipal): {
      decision: ReturnApprovalDecision
      returnRecord: ReturnRecord
    }
  }
  mobileReports?: MobileReportAdapter
  mobileSessions?: {
    /** Creates a PENDING device; returns no credentials at all. */
    startPairRequest(input: MobilePairInput, metadata: { ipAddress: string | null }):
      { requestId: string; requestToken: string; deviceName: string; platform: string; code: string; expiresAt: string }
    pairStatus(requestToken: string): { status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED'; deviceId?: string }
    /** The only route to an access token, and it is Admin-only by construction. */
    login(credentials: MobileLoginInput, metadata: {
      ipAddress: string | null
      deviceToken: string
      userAgent: string
      deviceName: string
      /** True when the request arrived through the vendor relay, so the Internet rules apply. */
      relayed?: boolean
    }): Promise<MobileLoginResult>
    refreshSession(refreshToken: string, ipAddress: string | null): MobileSessionCredentials | null
    logout(authorization: string | undefined): void
    isLocalNetwork?(address: string | null): boolean
  }
  /** The Admin phone's dashboard/stock/reports/sales/permissions/approvals surface. */
  mobileAdmin?: {
    service: import('./mobile-admin-service').MobileAdminService
  }
  /** Live push for stock changes, device events and approvals; the desktop and the phone both subscribe. */
  mobileEvents?: {
    subscribe(listener: (event: MobilePushEvent) => void): () => void
  }
  /** Built PWA files served on the same HTTPS origin as the Admin API. */
  mobileClientDirectory?: string
  /** Electron's bundled server is LAN-only even when a license also has an Internet entitlement. */
  localNetworkOnly?: boolean
  /**
   * Trust the relay's arrival marker (`x-infoflex-relay: 1`) **from a loopback peer only**. A relayed request is
   * then treated exactly like one from the open internet: the `mobileInternet` entitlement is required and the
   * authenticator code is mandatory, even though the socket address looks like the shop's own computer.
   *
   * Off unless the desktop turns it on, and it can never be set by a phone: the marker counts only from
   * 127.0.0.1, where the shop's own relay client connects from.
   */
  allowRelayArrival?: boolean
  /** Required so this factory cannot accidentally create a plaintext listening server. */
  tls: TlsOptions
  now?: () => number
}

/** Binds the mobile routes to the existing Returns service without trusting renderer/API identity claims. */
export function createReturnApprovalAdapter(
  service: Pick<ReturnService, 'listPendingMobileApprovals' | 'resolveMobileApproval'>,
): NonNullable<HostApiOptions['returnApprovals']> {
  return {
    listPendingMobileApprovals(admin) {
      return service.listPendingMobileApprovals(toReturnActor(admin))
    },
    resolveMobileApproval(returnId, decision, admin) {
      return service.resolveMobileApproval(returnId, decision, toReturnActor(admin))
    },
  }
}

export interface MobileReportAdapter {
  getSummary(input: ReportPeriodInput, admin: AuthenticatedPrincipal): MobileAccountingSummary
  exportPdf(input: ReportPeriodInput, admin: AuthenticatedPrincipal): Promise<Uint8Array>
}

/** Adapts the same SQLite-backed reporting service for verified Admin phone requests. */
export function createMobileReportAdapter(
  service: Pick<AccountingReportService, 'getDashboard' | 'exportPdf'>,
  getEdition: () => Edition | null,
): MobileReportAdapter {
  function report(input: ReportPeriodInput, principal: AuthenticatedPrincipal): AccountingReport {
    const edition = getEdition()
    if (!edition) throw new Error('Activate a valid Infoflex license before opening mobile reports.')
    return service.getDashboard(input, toReportActor(principal), edition)
  }
  return {
    getSummary(input, admin) {
      return buildMobileAccountingSummary(report(input, admin))
    },
    async exportPdf(input, admin) {
      const value = report(input, admin)
      return service.exportPdf({ ...input, section: 'summary' }, toReportActor(admin), value.header.edition)
    },
  }
}

function toReportActor(principal: AuthenticatedPrincipal) {
  return { id: principal.userId, username: principal.username, role: principal.role }
}

function toReturnActor(principal: AuthenticatedPrincipal) {
  return {
    id: principal.userId,
    username: principal.username,
    role: principal.role,
  }
}

const GENERIC_DENIAL = 'This account cannot use the mobile app'
const MOBILE_LOGIN_DENIED = 'Unable to sign in. Check the username and password, or ask the desktop Admin.'
const LICENCE_EXPIRED_DENIAL = "This shop's Infoflex licence has expired or been suspended. Mobile access is unavailable until the Admin renews it on the desktop."
const FAILURE_WINDOW_MS = 60_000
const FAILURE_LIMIT = 5
const BLOCK_DURATION_MS = 60_000

interface FailureState {
  windowStartedAt: number
  count: number
  blockedUntil: number
}

/** Creates the host API without listening. Main must provide TLS and auth before binding a port. */
export async function createHostApi(options: HostApiOptions): Promise<FastifyInstance> {
  // A mobile API never needs a megabyte of JSON; a small limit blunts oversized-body attacks.
  const server = Fastify({ https: options.tls, logger: false, bodyLimit: 32_768 })
  await server.register(websocket)
  const now = options.now ?? Date.now
  const failuresByIp = new Map<string, FailureState>()
  const verifiedAdmins = new WeakMap<FastifyRequest, AdminPrincipal>()

  if (options.localNetworkOnly) {
    server.addHook('onRequest', async (request, reply) => {
      const ipAddress = request.ip || null
      if (arrivalFor(request) !== 'public') return
      options.service.recordDeniedAccess({
        reason: 'license_feature', ipAddress, userAgent: request.headers['user-agent'], feature: 'mobileInternet',
      })
      await reply.code(403).send({ message: GENERIC_DENIAL })
    })
  }

  /**
   * Where a request really came from.
   *
   * `lan` — the shop's own Wi-Fi or a loopback caller that is not the relay.
   * `internet` — the vendor relay, which dials this listener from loopback. Treating that as `lan` would let a
   * phone on mobile data use the local-network entitlement and skip the authenticator, which is exactly the
   * shortcut this whole design exists to prevent.
   * `public` — anything else; refused outright by a LAN-only listener.
   */
  const arrivalFor = (request: FastifyRequest): 'lan' | 'internet' | 'public' => {
    const ipAddress = request.ip || null
    const relayed = options.allowRelayArrival === true
      && String(request.headers[RELAY_ARRIVAL_HEADER] ?? '') === '1'
      && (ipAddress === null || isLoopbackAddress(ipAddress))
    if (relayed) return 'internet'
    return isLocalNetworkAddress(ipAddress) ? 'lan' : 'public'
  }
  const featureFor = (arrival: 'lan' | 'internet' | 'public'): keyof LicenseSummary['features'] =>
    (arrival === 'lan' ? 'mobileLan' : 'mobileInternet')

  const authorizeAdmin = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const ipAddress = request.ip || null
    const key = ipAddress ?? 'unknown'
    const timestamp = now()
    const existing = failuresByIp.get(key)
    if (existing?.blockedUntil && timestamp < existing.blockedUntil) {
      options.service.recordDeniedAccess({
        reason: 'rate_limited', ipAddress, userAgent: request.headers['user-agent'],
      })
      await reply.code(429).send({ message: GENERIC_DENIAL })
      return
    }

    let principal: AuthenticatedPrincipal | null
    try {
      principal = await options.authenticate(request)
    } catch {
      recordFailure(key, timestamp, failuresByIp)
      options.service.recordDeniedAccess({
        reason: 'authentication_error', ipAddress, userAgent: request.headers['user-agent'],
      })
      await reply.code(403).send({ message: GENERIC_DENIAL })
      return
    }

    let admin: AdminPrincipal
    try {
      admin = requireAdmin(principal)
      failuresByIp.delete(key)
    } catch {
      recordFailure(key, timestamp, failuresByIp)
      options.service.recordDeniedAccess({
        reason: principal ? 'non_admin' : 'unauthenticated',
        ipAddress,
        userAgent: request.headers['user-agent'],
        actor: principal?.username,
      })
      await reply.code(principal ? 403 : 401).send({ message: GENERIC_DENIAL })
      return
    }

    let license: LicenseSummary
    try {
      license = options.license.getSnapshot()
    } catch {
      options.service.recordDeniedAccess({
        reason: 'license_inactive', ipAddress, userAgent: request.headers['user-agent'], actor: principal?.username,
      })
      await reply.code(403).send({ message: GENERIC_DENIAL })
      return
    }
    const arrival = arrivalFor(request)
    if (options.localNetworkOnly && arrival === 'public') {
      options.service.recordDeniedAccess({
        reason: license.canUse ? 'license_feature' : 'license_inactive',
        ipAddress,
        userAgent: request.headers['user-agent'],
        actor: principal?.username,
        feature: 'mobileInternet',
      })
      await reply.code(403).send({ message: GENERIC_DENIAL })
      return
    }
    const requiredFeature = featureFor(arrival)
    if (!license.canUse || !license.features[requiredFeature]) {
      options.service.recordDeniedAccess({
        reason: license.canUse ? 'license_feature' : 'license_inactive',
        ipAddress,
        userAgent: request.headers['user-agent'],
        actor: principal?.username,
        feature: requiredFeature,
      })
      await reply.code(403).send({ message: license.canUse ? GENERIC_DENIAL : LICENCE_EXPIRED_DENIAL })
      return
    }
    verifiedAdmins.set(request, admin)
  }

  const authorizeMobileTransport = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const ipAddress = request.ip || null
    const arrival = arrivalFor(request)
    const requiredFeature = featureFor(arrival)
    if (options.localNetworkOnly && arrival === 'public') {
      options.service.recordDeniedAccess({
        reason: 'license_feature', ipAddress, userAgent: request.headers['user-agent'], feature: 'mobileInternet',
      })
      await reply.code(403).send({ message: GENERIC_DENIAL })
      return
    }
    let license: LicenseSummary
    try {
      license = options.license.getSnapshot()
    } catch {
      options.service.recordDeniedAccess({ reason: 'license_inactive', ipAddress, userAgent: request.headers['user-agent'], feature: requiredFeature })
      await reply.code(403).send({ message: GENERIC_DENIAL })
      return
    }
    if (!license.canUse || !license.features[requiredFeature]) {
      options.service.recordDeniedAccess({
        reason: license.canUse ? 'license_feature' : 'license_inactive',
        ipAddress,
        userAgent: request.headers['user-agent'],
        feature: requiredFeature,
      })
      // An expired or suspended licence answers with the licence sentence, which is what lets the phone
      // explain itself. A missing *feature* keeps the generic refusal, so the phone cannot probe which
      // features a shop bought.
      await reply.code(403).send({ message: license.canUse ? GENERIC_DENIAL : LICENCE_EXPIRED_DENIAL })
    }
  }

  /**
   * Pairing is the one step an unauthenticated phone may take, so it is limited by where the request came from:
   * on the shop's own network it is allowed with the local-network entitlement, and through the relay only with
   * the internet entitlement. Either way the device lands in the PC's approval pop-up and has no credentials until
   * an Admin accepts it there.
   */
  const authorizePairing = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const ipAddress = request.ip || null
    const arrival = arrivalFor(request)
    if (arrival === 'public') {
      options.service.recordDeniedAccess({
        reason: 'license_feature', ipAddress, userAgent: request.headers['user-agent'], feature: 'mobileLan',
      })
      await reply.code(403).send({ message: GENERIC_DENIAL })
      return
    }
    const pairingFeature = featureFor(arrival)
    let license: LicenseSummary
    try {
      license = options.license.getSnapshot()
    } catch {
      options.service.recordDeniedAccess({ reason: 'license_inactive', ipAddress, userAgent: request.headers['user-agent'], feature: 'mobileLan' })
      await reply.code(403).send({ message: GENERIC_DENIAL })
      return
    }
    if (!license.canUse || !license.features[pairingFeature]) {
      options.service.recordDeniedAccess({
        reason: license.canUse ? 'license_feature' : 'license_inactive',
        ipAddress,
        userAgent: request.headers['user-agent'],
        feature: pairingFeature,
      })
      await reply.code(403).send({ message: GENERIC_DENIAL })
    }
  }

  /**
   * The permission policy gate.
   *
   * This is the point at which a route becomes reachable at all. It runs **when the route is registered**, not when
   * a request arrives, and it wraps the handler in a check that consults the one declarative table in
   * `/packages/core`.
   *
   * Registering the check here rather than as a global hook is deliberate, and the reason is a defect this rewrite
   * fixed: a global `onRequest`/`preHandler` gate answers before the route's own pre-handler chain, so it returned
   * 403 to a caller the rate limiter was about to answer with a more accurate 429, and it turned Fastify's own 404
   * for an unknown URL into a 403 — which would tell an attacker that a path exists. A floor should refuse what
   * nothing else refuses; it should not pre-empt a check with more to say, and it must not paper over routing.
   *
   * Two properties follow:
   *
   * 1. **A route with no policy entry is refused at runtime** and, because the check is attached at registration, it
   *    is refused before it can ever be served. The coverage test fails the build over the same hole; this is the
   *    check that protects a shop whose build somebody skipped.
   * 2. **No handler is invoked for a refused caller.** The wrapper returns before calling through.
   *
   * `anonymous` rows are allowed without a role. Everything else requires an authenticated principal whose role
   * resolves to one of the four real roles: a legacy `CASHIER` resolves to `USER`, and a role nobody recognises is
   * refused rather than defaulted.
   *
   * The per-route pre-handlers still run afterwards and still do their own work — licence state, LAN-only arrival,
   * rate limits, the Admin-only rule. The gate is the floor, not the ceiling, so widening the table can never widen
   * the licence rules.
   */
  const policy = <T extends { preHandler?: unknown }>(route: T): T => {
    const original = route.preHandler
    const guarded = {
      ...route,
      preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
        // Fastify reports a HEAD as its own route; treat it as the GET policy so a probe cannot bypass the gate.
        const method = request.method === 'HEAD' ? 'GET' : request.method
        // The registered pattern is what the table names, and what Fastify routed on.
        const pattern = request.routeOptions?.url ?? request.url.split('?')[0] ?? request.url
        const key = httpKey(method, pattern)

        // Refuse first if the route is unpoliced at all. This is a defect in this server, and it must never be
        // papered over by a route's own pre-handler happening to refuse the caller for a different reason.
        if (!hasPolicy(key)) {
          options.service.recordDeniedAccess({
            reason: 'authentication_error',
            ipAddress: request.ip || null,
            userAgent: request.headers['user-agent'],
          })
          await reply.code(403).send({ message: GENERIC_DENIAL })
          return
        }

        // Then let the route's own pre-handler chain run. It owns rate limiting, licence state and LAN-only
        // arrival, and its answer is the more specific one: a caller locked out after five failures should see
        // 429, not the flatter 401 this gate would produce. If it refuses, it has already replied.
        if (Array.isArray(original)) {
          for (const step of original) await (step as (r: FastifyRequest, q: FastifyReply) => Promise<void>)(request, reply)
        } else if (typeof original === 'function') {
          await (original as (r: FastifyRequest, q: FastifyReply) => Promise<void>)(request, reply)
        }
        if (reply.sent) return

        // Finally, the policy itself. The pre-handler proves licence and transport; this proves the role may use
        // this route at all.
        let principal: AuthenticatedPrincipal | null = null
        try {
          principal = await options.authenticate(request)
        } catch {
          principal = null
        }
        const signedIn = principal !== null
        const outcome = authorize(key, principal ? resolveRole(principal.role) : null, signedIn)
        if (outcome.allowed) return
        if (outcome.reason === 'no-policy') {
          // A defect in this server, not a caller asking for something it may not have.
          options.service.recordDeniedAccess({
            reason: 'authentication_error',
            ipAddress: request.ip || null,
            userAgent: request.headers['user-agent'],
            actor: principal?.username,
          })
        } else {
          options.service.recordDeniedAccess({
            reason: signedIn ? 'non_admin' : 'unauthenticated',
            ipAddress: request.ip || null,
            userAgent: request.headers['user-agent'],
            actor: principal?.username,
          })
        }
        await reply.code(signedIn ? 403 : 401).send({ message: GENERIC_DENIAL })
      },
    }
    return guarded as T
  }

  server.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff')
    reply.header('referrer-policy', 'no-referrer')
    if (request.url.startsWith('/api/v1/')) reply.header('cache-control', 'no-store')
    return payload
  })

  server.get('/api/v1/health', policy({}), async () => ({ status: 'ok' }))
  /**
   * The one route that answers with a licence problem instead of a bare denial, so the phone can say
   * "the shop's licence has expired" rather than showing a broken screen. It reveals nothing else.
   */
  server.get('/api/v1/licence', policy({}), async (_request, reply) => {
    try {
      const license = options.license.getSnapshot()
      return reply.header('cache-control', 'no-store').send({
        usable: Boolean(license.canUse),
        status: license.status,
        message: license.canUse
          ? 'The shop licence is active.'
          : 'Mobile access is unavailable because this shop\'s Infoflex licence has expired or been suspended. Ask the shop Admin to renew it on the desktop.',
      })
    } catch {
      return reply.header('cache-control', 'no-store').send({
        usable: false,
        status: 'UNKNOWN',
        message: 'Mobile access is unavailable because this shop\'s Infoflex licence could not be checked. Ask the shop Admin to open Infoflex on the desktop.',
      })
    }
  })
  /**
   * Step 1 of pairing: the phone exchanges the eight-digit code for a PENDING device and a request token.
   * Nothing usable comes back — no access token, no session — until an Admin approves on the PC.
   */
  server.post('/api/v1/mobile/pair', policy({ preHandler: authorizePairing }), async (request, reply) => {
    if (!options.mobileSessions) return reply.code(503).send({ message: 'Mobile pairing is not configured on this host.' })
    const body = request.body as Partial<MobilePairInput> | null
    if (!body || typeof body !== 'object' || typeof body.code !== 'string'
      || typeof body.deviceName !== 'string' || typeof body.platform !== 'string') {
      return reply.code(400).send({ message: 'Enter the eight-digit pairing code and a phone name.' })
    }
    if (!/^\d{8}$/u.test(body.code.trim())) return reply.code(400).send({ message: 'Enter the eight-digit pairing code from the desktop.' })
    if (body.deviceName.trim().length === 0 || body.deviceName.length > 80) {
      return reply.code(400).send({ message: 'Enter a phone name of up to 80 characters.' })
    }
    if (body.platform.trim().length === 0 || body.platform.length > 40) {
      return reply.code(400).send({ message: 'Enter the phone type, for example Samsung Galaxy or iPhone.' })
    }
    try {
      const started = options.mobileSessions.startPairRequest(
        { code: body.code.trim(), deviceName: body.deviceName.trim(), platform: body.platform.trim() },
        { ipAddress: request.ip || null },
      )
      return reply.code(202).header('cache-control', 'no-store').send({
        requestId: started.requestId,
        requestToken: started.requestToken,
        deviceName: started.deviceName,
        platform: started.platform,
        expiresAt: started.expiresAt,
        status: 'PENDING',
      })
    } catch (error) {
      const message = safeErrorMessage(error)
      return reply.code(message.includes('temporarily blocked') ? 429 : 400).send({ message })
    }
  })
  /** Step 2: the phone polls this while it waits for the Admin. Safe to repeat; it never returns a secret. */
  server.get('/api/v1/mobile/pair/status', policy({ preHandler: authorizePairing }), async (request, reply) => {
    if (!options.mobileSessions) return reply.code(503).send({ message: 'Mobile pairing is not configured on this host.' })
    const query = request.query as { requestToken?: unknown } | null
    const token = typeof query?.requestToken === 'string' ? query.requestToken : ''
    if (!/^[A-Za-z0-9_-]{40,100}$/u.test(token)) {
      return reply.code(400).send({ message: 'Start pairing again from the desktop.' })
    }
    const status = options.mobileSessions.pairStatus(token)
    return reply.header('cache-control', 'no-store').send({
      status: status.status,
      ...(status.deviceId ? { deviceId: status.deviceId } : {}),
      // The phone must still prove it is the Admin with a username and password.
      loginRequired: status.status === 'APPROVED',
    })
  })
  /**
   * Step 3: Admin username + password (+ authenticator code off-LAN) + the device token. A Cashier or
   * Supervisor, a wrong password and an unknown account all receive the same body and status code.
   */
  server.post('/api/v1/mobile/session/login', policy({ preHandler: authorizeMobileTransport }), async (request, reply) => {
    if (!options.mobileSessions) return reply.code(503).send({ message: 'Mobile sign-in is not configured on this host.' })
    const body = request.body as Partial<MobileLoginInput> & { deviceToken?: unknown; deviceName?: unknown } | null
    if (!body || typeof body !== 'object' || typeof body.username !== 'string' || typeof body.password !== 'string'
      || typeof body.deviceToken !== 'string') {
      return reply.code(400).send({ message: 'Enter the Admin username, password, and this phone must be approved first.' })
    }
    if (body.username.length > 120 || body.password.length > 200 || typeof body.totpCode !== 'undefined'
      && typeof body.totpCode !== 'string') {
      return reply.code(400).send({ message: 'Enter the Admin username and password.' })
    }
    if (typeof body.totpCode === 'string' && body.totpCode.length > 12) {
      return reply.code(400).send({ message: 'Enter the six-digit code from the authenticator app.' })
    }
    try {
      const result = await options.mobileSessions.login(
        { username: body.username, password: body.password, ...(typeof body.totpCode === 'string' ? { totpCode: body.totpCode } : {}) },
        {
          ipAddress: request.ip || null,
          deviceToken: body.deviceToken,
          userAgent: String(request.headers['user-agent'] ?? '').slice(0, 160),
          deviceName: typeof body.deviceName === 'string' ? body.deviceName.slice(0, 80) : 'Admin phone',
          relayed: arrivalFor(request) === 'internet',
        },
      )
      return reply.header('cache-control', 'no-store').send(result)
    } catch (error) {
      const message = safeErrorMessage(error)
      // Never distinguish role, existence or lock state: the message is the constant MOBILE_LOGIN_DENIED.
      return reply.code(message === MOBILE_LOGIN_DENIED ? 401 : 429).send({ message: MOBILE_LOGIN_DENIED })
    }
  })
  server.post('/api/v1/mobile/session/refresh', policy({ preHandler: authorizeMobileTransport }), async (request, reply) => {
    if (!options.mobileSessions) return reply.code(503).send({ message: 'Mobile sessions are not configured on this host.' })
    const body = request.body as { refreshToken?: unknown } | null
    if (!body || typeof body.refreshToken !== 'string') return reply.code(400).send({ message: 'A refresh credential is required.' })
    try {
      const credentials = options.mobileSessions.refreshSession(body.refreshToken, request.ip || null)
      if (!credentials) return reply.code(401).send({ message: 'The phone session has ended. Pair this phone again.' })
      return reply.header('cache-control', 'no-store').send(credentials)
    } catch (error) {
      return reply.code(403).send({ message: safeErrorMessage(error) })
    }
  })
  /**
   * Logout ends the phone's own session. It is still gated on an Admin session so a non-Admin credential can
   * never make the host act, even harmlessly — the mobile surface has no non-Admin routes at all.
   */
  server.post('/api/v1/mobile/session/logout', policy({ preHandler: authorizeMobileTransport }), async (request, reply) => {
    if (!options.mobileSessions) return reply.code(503).send({ message: 'Mobile sessions are not configured on this host.' })
    const principal = await options.authenticate(request).catch(() => null)
    if (!principal || principal.role !== 'ADMIN' || principal.isActive === false || principal.isLocked === true) {
      options.service.recordDeniedAccess({
        reason: principal ? 'non_admin' : 'unauthenticated',
        ipAddress: request.ip || null,
        userAgent: request.headers['user-agent'],
        actor: principal?.username,
      })
      return reply.code(principal ? 403 : 401).send({ message: GENERIC_DENIAL })
    }
    options.mobileSessions.logout(request.headers.authorization)
    return reply.code(204).send()
  })
  server.get('/api/v1/admin/settings', policy({ preHandler: authorizeAdmin }), async () => options.service.getSettings())
  server.get('/api/v1/admin/returns/pending', policy({ preHandler: authorizeAdmin }), async (request, reply) => {
    if (!options.returnApprovals) return reply.code(503).send({ message: 'Return approvals are not configured on this host.' })
    const admin = verifiedAdmins.get(request)
    if (!admin) return reply.code(403).send({ message: GENERIC_DENIAL })
    try {
      const requests = options.returnApprovals.listPendingMobileApprovals(admin)
      return { requests: requests.map(toMobileReturnSummary) }
    } catch (error) {
      return reply.code(409).send({ message: safeErrorMessage(error) })
    }
  })
  server.post('/api/v1/admin/returns/:returnId/approval', policy({ preHandler: authorizeAdmin }), async (request, reply) => {
    if (!options.returnApprovals) return reply.code(503).send({ message: 'Return approvals are not configured on this host.' })
    const admin = verifiedAdmins.get(request)
    if (!admin) return reply.code(403).send({ message: GENERIC_DENIAL })
    const params = request.params as { returnId?: string }
    const body = request.body as { decision?: unknown } | null
    const decision = body?.decision
    if (decision !== 'APPROVE' && decision !== 'REJECT') {
      return reply.code(400).send({ message: 'Choose APPROVE or REJECT for this return request.' })
    }
    try {
      const result = options.returnApprovals.resolveMobileApproval(params.returnId ?? '', decision, admin)
      return { decision: result.decision, return: toMobileReturnSummary(result.returnRecord) }
    } catch (error) {
      return reply.code(409).send({ message: safeErrorMessage(error) })
    }
  })
  server.get('/api/v1/admin/reports/summary', policy({ preHandler: authorizeAdmin }), async (request, reply) => {
    if (!options.mobileReports) return reply.code(503).send({ message: 'Mobile reports are not configured on this host.' })
    const admin = verifiedAdmins.get(request)
    if (!admin) return reply.code(403).send({ message: GENERIC_DENIAL })
    try {
      const input = mobileReportInput(request.query, now())
      const summary = options.mobileReports.getSummary(input, admin)
      return reply.header('cache-control', 'no-store').send(serializeBigInts(summary))
    } catch (error) {
      return reply.code(400).send({ message: safeErrorMessage(error) })
    }
  })
  server.get('/api/v1/admin/reports/summary.pdf', policy({ preHandler: authorizeAdmin }), async (request, reply) => {
    if (!options.mobileReports) return reply.code(503).send({ message: 'Mobile reports are not configured on this host.' })
    const admin = verifiedAdmins.get(request)
    if (!admin) return reply.code(403).send({ message: GENERIC_DENIAL })
    try {
      const input = mobileReportInput(request.query, now())
      const pdf = await options.mobileReports.exportPdf(input, admin)
      const safeDate = input.date.replace(/[^0-9-]/gu, '')
      return reply
        .header('cache-control', 'no-store')
        .header('content-type', 'application/pdf')
        .header('content-disposition', `attachment; filename="infoflex-${input.period.toLowerCase()}-${safeDate}.pdf"`)
        .send(Buffer.from(pdf))
    } catch (error) {
      return reply.code(400).send({ message: safeErrorMessage(error) })
    }
  })
  server.get('/api/v1/admin/events', policy({ websocket: true, preHandler: authorizeAdmin }), (socket) => {
    socket.send(JSON.stringify({ type: 'connected', at: new Date(now()).toISOString() }))
    const unsubscribe = options.mobileEvents?.subscribe((event) => {
      // A closed socket throws; drop the subscription rather than surfacing an unhandled error.
      try {
        socket.send(JSON.stringify(event))
      } catch {
        unsubscribe?.()
      }
    }) ?? (() => undefined)
    socket.on('close', unsubscribe)
    socket.on('error', unsubscribe)
  })
  if (options.mobileAdmin) {
    registerMobileAdminRoutes(server, {
      service: options.mobileAdmin.service,
      authenticate: options.authenticate,
      authorizeTransport: authorizeMobileTransport,
      recordDeniedAccess: (input) => options.service.recordDeniedAccess(input),
      now,
    })
  }
  if (options.mobileClientDirectory) registerMobileClientRoutes(server, options.mobileClientDirectory)
  return server
}

function mobileReportInput(queryValue: unknown, now: number): ReportPeriodInput {
  const query = queryValue && typeof queryValue === 'object' ? queryValue as Record<string, unknown> : {}
  const period = query.period === undefined ? 'DAY' : query.period
  if (period !== 'DAY' && period !== 'MONTH') throw new Error('Choose DAY or MONTH for a report period.')
  const currentDate = localDateString(now)
  const date = query.date === undefined ? (period === 'MONTH' ? currentDate.slice(0, 7) : currentDate) : query.date
  if (typeof date !== 'string') throw new Error('Choose a valid report date.')
  return { period, date }
}

function localDateString(timestamp: number): string {
  const date = new Date(timestamp)
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function toMobileReturnSummary(record: ReturnRecord) {
  return {
    id: record.id,
    returnNumber: record.returnNumber,
    receiptNumber: record.receiptNumber,
    status: record.status,
    reason: record.reason,
    reasonNote: record.reasonNote,
    type: record.type,
    createdAt: record.createdAt,
    requester: record.cashier,
    amountMinor: record.totalMinor.toString(),
    currency: {
      code: record.currency.code,
      name: record.currency.name,
      symbol: record.currency.symbol,
      decimalPlaces: record.currency.decimalPlaces,
    },
    storeName: record.store.name,
    items: record.items.map((item) => ({
      description: item.description,
      sku: item.sku,
      quantityMilli: item.quantityMilli.toString(),
      condition: item.condition,
      stockDisposition: item.stockDisposition,
    })),
  }
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.slice(0, 240)
  return 'This return approval could not be completed.'
}

/** True for private/loopback IPv4 and IPv6 addresses, i.e. the shop's own local network. */
/** Loopback only: the address the shop's own relay client connects from, and nothing else. */
export function isLoopbackAddress(value: string | null): boolean {
  if (!value) return false
  const address = value.split('%', 1)[0]!.toLowerCase()
  const mappedIpv4 = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u)
  if (mappedIpv4) return isLoopbackAddress(mappedIpv4[1]!)
  return address === 'localhost' || address === '::1' || /^127\./u.test(address)
}

export function isLocalNetworkAddress(value: string | null): boolean {
  if (!value) return false
  const address = value.split('%', 1)[0]!.toLowerCase()
  if (address === 'localhost') return true
  const mappedIpv4 = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u)
  if (mappedIpv4) return isLocalNetworkAddress(mappedIpv4[1]!)
  if (isIP(address) === 4) {
    const octets = address.split('.').map(Number)
    const [first, second] = octets
    return first === 10
      || first === 127
      || (first === 172 && second! >= 16 && second! <= 31)
      || (first === 192 && second === 168)
      || (first === 169 && second === 254)
  }
  if (isIP(address) === 6) {
    return address === '::1'
      || address.startsWith('fc')
      || address.startsWith('fd')
      || /^fe[89ab]/u.test(address)
  }
  return false
}

function recordFailure(key: string, timestamp: number, states: Map<string, FailureState>): void {
  const current = states.get(key)
  const state = !current || timestamp - current.windowStartedAt >= FAILURE_WINDOW_MS
    ? { windowStartedAt: timestamp, count: 0, blockedUntil: 0 }
    : current
  state.count += 1
  if (state.count >= FAILURE_LIMIT) state.blockedUntil = timestamp + BLOCK_DURATION_MS
  rememberRateLimitState(states, key, state, timestamp, FAILURE_WINDOW_MS)
}
