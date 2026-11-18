import Fastify, { type FastifyInstance } from 'fastify'
import websocketPlugin from '@fastify/websocket'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, type CloudConfig } from './config'
import { loadSigningIdentity, type SigningIdentity } from './signing'
import { openDatabase } from './database'
import { VendorAuth } from './auth'
import { LicenseService } from './license-service'
import { registerLicenseApi } from './license-api'
import { registerPortal, registerAssets } from './portal/router'
import { createMailer, type Mailer } from './mailer'
import { RelayHub } from './relay/server'
import { RelayVerifier } from './relay/verify'
import { scheduleBackups } from './backups'
import { scheduleReminders } from './reminders'

/**
 * The whole cloud server: one process, one SQLite file, one port.
 *
 * Everything public lives under `/api/license` (the desktop's four calls), `/portal` (the vendor's screens),
 * `/relay/tunnel` (the shop PC's WebSocket) and the relay's wildcard host route. There is no admin API and no
 * unauthenticated list endpoint, so the only way to read a customer's details is to sign in to the portal.
 */
export interface CloudServerOptions {
  config?: CloudConfig
  /** Tests pass `:memory:`; production uses the configured file path. */
  databasePath?: string
  identity?: SigningIdentity
  mailer?: Mailer | null
  now?: () => number
  /** Turn the background timers off in tests, which drive the jobs directly. */
  background?: boolean
  logger?: boolean
}

export interface CloudServer {
  app: FastifyInstance
  config: CloudConfig
  identity: SigningIdentity
  service: LicenseService
  auth: VendorAuth
  mailer: Mailer | null
  relay: RelayHub | null
  database: ReturnType<typeof openDatabase>
  stop: () => Promise<void>
}

const HERE = dirname(fileURLToPath(import.meta.url))
const ASSET_ROOT = resolve(HERE, '..', 'assets')

export async function createCloudServer(options: CloudServerOptions = {}): Promise<CloudServer> {
  const config = options.config ?? loadConfig()
  const databasePath = options.databasePath ?? config.databasePath
  if (databasePath !== ':memory:') mkdirSync(dirname(resolve(databasePath)), { recursive: true })

  const database = openDatabase(databasePath)
  const identity = options.identity ?? loadSigningIdentity(config.signingPrivateKeyPem, config.signingKeyId)
  if (!config.signingPublicKeyPem) config.signingPublicKeyPem = identity.publicKeyPem
  const service = new LicenseService(database, identity, { now: options.now })
  const auth = new VendorAuth(database, { now: options.now, sessionMinutes: config.portalSessionMinutes })
  const mailer = options.mailer !== undefined ? options.mailer : config.smtp ? createMailer(config.smtp) : null

  const app = Fastify({
    // The relay carries a shop's own HTML; Fastify's request logging would put licence keys and paths in a file.
    logger: options.logger === true ? { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] } : false,
    trustProxy: config.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
    genReqId: () => `r-${Math.random().toString(36).slice(2, 10)}`,
  })

  await app.register(websocketPlugin, { options: { maxPayload: 64 * 1024, clientTracking: false } })

  /**
   * The portal's forms are ordinary HTML `application/x-www-form-urlencoded` posts, which Fastify does not parse
   * out of the box. Only that content type is added: the licence API keeps JSON, so a form-encoded body hitting
   * an API route is still refused with 415.
   */
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8')
    if (text.length > 64 * 1024) {
      done(Object.assign(new Error('That form is too large.'), { statusCode: 413 }), undefined)
      return
    }
    const output: Record<string, string> = {}
    for (const [key, value] of new URLSearchParams(text)) {
      // Fastify's default parser keeps repeated keys as arrays; the portal has no multi-value field, so the
      // last value wins deliberately and no handler has to guess.
      output[key] = value
    }
    done(null, output)
  })

  // ---------------------------------------------------------------- hardened headers
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff')
    reply.header('x-frame-options', 'DENY')
    reply.header('referrer-policy', 'no-referrer')
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()')
    reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains')
    if (request.url.startsWith('/portal')) {
      // The portal ships its CSS inline in one file and loads no third-party asset, so the policy can be strict.
      reply.header('content-security-policy',
        "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; form-action 'self'; "
        + "base-uri 'none'; frame-ancestors 'none'; script-src 'none'")
    }
    return payload
  })

  // A phone's request to a shop subdomain is HTML from the shop's own server; the relay must not add a CSP.
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/relay') || request.url.startsWith('/api/') || request.url.startsWith('/portal')) return
    if (request.headers.host && config.relayDomain && String(request.headers.host).toLowerCase().endsWith(`.${config.relayDomain.toLowerCase()}`)) {
      reply.header('x-infoflex-relay', '1')
    }
  })

  // ---------------------------------------------------------------- routes
  registerAssets((name: string) => {
    const path = join(ASSET_ROOT, name)
    return existsSync(path) ? readFileSync(path) : null
  })
  registerLicenseApi(app, {
    service,
    identity,
    publicBaseUrl: config.publicBaseUrl,
    // The desktop learns the relay's address here, over the connection it already trusts, and nowhere else.
    relayWebSocketUrl: config.relayDomain ? `wss://${config.relayDomain}` : null,
  })
  registerPortal(app, {
    auth, service, database, identity,
    secureCookies: config.environment === 'production',
    sessionMinutes: config.portalSessionMinutes,
    relayDomain: config.relayDomain,
    relayLinkSizeLimit: config.relayDomain ? 16 * 1024 : 0,
    mailer,
    emailBootstrapOwner: config.bootstrapOwnerEmail,
    now: options.now,
  })

  // ---------------------------------------------------------------- relay
  let relay: RelayHub | null = null
  if (config.relayDomain) {
    const verifier = new RelayVerifier({
      service,
      publicKeyPem: identity.publicKeyPem,
      keyId: identity.keyId,
      grantSecret: config.relaySharedSecret,
      now: options.now,
    })
    relay = new RelayHub({ service, database, verifier, relayDomain: config.relayDomain, trustProxy: config.trustProxy, now: options.now })
    relay.register(app)
  }

  // ---------------------------------------------------------------- health
  app.get('/health', async () => ({ status: 'ok', version: 1 }))

  // ---------------------------------------------------------------- background work
  const stops: Array<() => void> = []
  if (options.background !== false) {
    stops.push(scheduleBackups({
      database,
      directory: config.backupDirectory,
      keep: config.backupKeep,
      now: options.now,
    }))
    stops.push(scheduleReminders({
      database,
      service,
      mailer,
      vendorRecipient: config.smtp?.vendorRecipient ?? null,
      now: options.now,
    }))
  }

  let stopped = false
  const stop = async (): Promise<void> => {
    // Signalled twice (Ctrl-C then a container stop) must not close an already-closed database.
    if (stopped) return
    stopped = true
    for (const cancel of stops) cancel()
    relay?.closeAll()
    await app.close()
    database.close()
  }

  return { app, config, identity, service, auth, mailer, relay, database, stop }
}

/** `tsx cloud/src/server.ts` starts the real thing. */
const isDirectRun = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) {
  const port = Number(process.env.PORT ?? 8080)
  const created = await createCloudServer({ logger: true })
  try {
    await created.app.listen({ port, host: '0.0.0.0' })
    process.stdout.write(`Infoflex Cloud listening on ${port}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void created.stop().then(() => process.exit(0))
    })
  }
}
