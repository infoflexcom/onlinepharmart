import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { LicenseError, type LicenseService } from './license-service'
import type { SigningIdentity } from './signing'

/**
 * The public licence API — the only part of the cloud a customer's PC ever talks to. It exposes four things
 * and nothing else: the trusted public key, activation, check-in, and a signed offline `.lic` file.
 *
 * There is no endpoint here that accepts business data. The check-in shape is parsed field by field and a
 * body carrying any shop-data key is refused outright, so a compromised or buggy client cannot start
 * shipping sales into the licence server.
 */
export interface LicenseApiOptions {
  service: LicenseService
  identity: SigningIdentity
  /** "https://licence.example.com" — used for the download link the portal shows the vendor. */
  publicBaseUrl: string
  /**
   * `wss://relay.example.com` when this deployment runs the internet relay, else null.
   *
   * Published here rather than typed into the shop's computer: the address arrives over the same verified
   * HTTPS connection that activation already uses, so a shop cannot be pointed at somebody else's relay by a
   * typo or a phishing e-mail. The desktop stores it and reuses it for every reconnect.
   */
  relayWebSocketUrl?: string | null
}

const BUSINESS_DATA_KEYS = new Set([
  'sales', 'sale', 'stock', 'inventory', 'products', 'customers', 'users', 'payments', 'transactions',
  'revenue', 'prices', 'amounts', 'currencyAmounts', 'receipts', 'returns', 'employees', 'cashiers',
])

export function registerLicenseApi(app: FastifyInstance, options: LicenseApiOptions): void {
  const { service, identity } = options

  /** The desktop fetches this to learn which Ed25519 key to trust. Public by design; a public key is not a secret. */
  app.get('/api/license/config', async (_request, reply) => {
    reply.header('cache-control', 'public, max-age=300')
    return {
      mode: 'infoflex-cloud',
      keyId: identity.keyId,
      publicKey: identity.publicKeyPem,
      // Absent when no relay is configured, so an old client behaves exactly as before.
      ...(options.relayWebSocketUrl ? { relayUrl: options.relayWebSocketUrl } : {}),
    }
  })

  app.post('/api/license/activate', async (request, reply) => {
    try {
      const body = objectBody(request.body)
      refuseBusinessData(body)
      const result = service.activate({
        licenseKey: stringOrDefault(body.activationKey, ''),
        machineId: stringOrDefault(body.machineId, ''),
        appVersion: stringOrDefault(body.appVersion, ''),
        platform: stringOrDefault(body.platform, ''),
        ipAddress: clientIp(request),
      })
      return { token: result.token, serverNow: result.serverNow, licenseId: result.licenseId }
    } catch (error) {
      return sendLicenseError(reply, error)
    }
  })

  app.post('/api/license/check-in', async (request, reply) => {
    try {
      const body = objectBody(request.body)
      refuseBusinessData(body)
      const onsite = body.onsiteLicense === undefined || body.onsiteLicense === null ? undefined : objectBody(body.onsiteLicense)
      const result = service.checkIn({
        licenseId: stringOrDefault(body.licenseId, ''),
        machineId: stringOrDefault(body.machineId, ''),
        appVersion: stringOrDefault(body.appVersion, ''),
        platform: stringOrDefault(body.platform, ''),
        checkedAt: stringOrDefault(body.checkedAt, new Date().toISOString()),
        source: sourceField(body.source),
        ipAddress: clientIp(request),
        ...(onsite ? { onsiteLicense: parseOnsite(onsite) } : {}),
      })
      return result
    } catch (error) {
      return sendLicenseError(reply, error)
    }
  })

  /**
   * The public key a PC pins, in the same shape as the desktop's Build Studio policy expects, so an offline
   * build can trust the same key the online service signs with.
   */
  app.get('/api/license/public-key', async (_request, reply) => {
    reply.header('cache-control', 'public, max-age=300')
    return { keyId: identity.keyId, publicKey: identity.publicKeyPem, algorithm: 'Ed25519', format: 'spki-pem' }
  })
}

/**
 * Offline licence downloads are vendor-only and therefore registered by the portal router, which owns the
 * session. It lives here so the file format sits next to the token it wraps.
 */
export function licenceFileResponse(reply: FastifyReply, input: { token: string; fileName: string }) {
  return reply
    .header('content-type', 'application/octet-stream')
    .header('content-disposition', `attachment; filename="${input.fileName.replace(/[^A-Za-z0-9._-]/gu, '_')}"`)
    .header('cache-control', 'no-store')
    .send(Buffer.from(input.token, 'utf8'))
}

export function sendLicenseError(reply: FastifyReply, error: unknown) {
  if (error instanceof BusinessDataError) {
    return reply.code(400).send({ error: error.code, message: error.message })
  }
  if (error instanceof LicenseError) {
    const status = error.code === 'rate_limited' ? 429
      : error.code === 'conflict' ? 409
        : error.code === 'not_found' ? 404
          : error.code === 'invalid' || error.code === 'invalid_key' ? 400
            : 403
    return reply.code(status).send({ error: error.code, message: error.message })
  }
  // An unexpected failure gets a generic body: a stack trace here would leak the schema to the internet.
  reply.log?.error?.(error)
  return reply.code(500).send({ error: 'server_error', message: 'The licence service could not complete that request.' })
}

/**
 * The promise this server makes to customers is "licence and contact data only". A client that sends a sale
 * row is therefore refused with its own code, not quietly ignored: silently dropping it would leave caller and
 * vendor both believing the data had arrived somewhere.
 */
export class BusinessDataError extends Error {
  readonly statusCode = 400
  readonly code = 'business_data_not_permitted'

  constructor() {
    super('This service stores licence data only and does not accept shop business data.')
    this.name = 'BusinessDataError'
  }
}

function refuseBusinessData(body: Record<string, unknown>): void {
  const lower = new Set(Object.keys(body).map((key) => key.toLowerCase()))
  for (const key of BUSINESS_DATA_KEYS) {
    if (lower.has(key.toLowerCase())) throw new BusinessDataError()
  }
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LicenseError('invalid', 'The request body is not valid.')
  }
  return value as Record<string, unknown>
}

function stringOrDefault(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  return value.length > 4_096 ? value.slice(0, 4_096) : value
}

function sourceField(value: unknown): 'online' | 'file' | 'onsite' {
  if (value === 'online' || value === 'file' || value === 'onsite') return value
  throw new LicenseError('invalid', 'The licence source is not valid.')
}

function parseOnsite(details: Record<string, unknown>) {
  const features = objectBody(details.features)
  const edition = details.edition
  const status = details.status
  if (edition !== 'PHARMACY' && edition !== 'SUPERMARKET' && edition !== 'BOTH') throw new LicenseError('invalid', 'The on-site edition is not valid.')
  if (status !== 'active' && status !== 'suspended' && status !== 'revoked') throw new LicenseError('invalid', 'The on-site status is not valid.')
  const checkedEdition = edition as 'PHARMACY' | 'SUPERMARKET' | 'BOTH'
  const checkedStatus = status as 'active' | 'suspended' | 'revoked'
  if (typeof features.mobileLan !== 'boolean' || typeof features.mobileInternet !== 'boolean') {
    throw new LicenseError('invalid', 'The on-site mobile features are not valid.')
  }
  if (!Number.isInteger(details.adminPhoneLimit) || !Number.isInteger(details.graceDays)) {
    throw new LicenseError('invalid', 'The on-site phone limit or grace period is not valid.')
  }
  const currency = details.defaultCurrencyCode
  return {
    edition: checkedEdition,
    status: checkedStatus,
    startsAt: requiredDate(details.startsAt, 'start'),
    endsAt: requiredDate(details.endsAt, 'end'),
    issuedAt: requiredDate(details.issuedAt, 'issue'),
    defaultCurrencyCode: typeof currency === 'string' ? currency : null,
    lockCurrency: details.lockCurrency === true,
    features: { mobileLan: features.mobileLan, mobileInternet: features.mobileInternet },
    adminPhoneLimit: details.adminPhoneLimit as number,
    graceDays: details.graceDays as number,
  }
}

function requiredDate(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new LicenseError('invalid', `The on-site ${label} date is not valid.`)
  // Normalised to the canonical instant the token format requires: a bare date becomes midnight UTC, and a
  // full timestamp is re-serialised so two spellings of the same instant cannot produce two different tokens.
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) ? new Date(`${value}T00:00:00.000Z`).toISOString() : new Date(value).toISOString()
}

/**
 * The client's address, taken from the socket by default. Behind the documented reverse proxy the
 * `trustProxy` setting has already populated `request.ip` from the forwarded header; that value is only
 * trusted because the deployment guide requires the proxy to overwrite it.
 */
export function clientIp(request: FastifyRequest): string | null {
  const ip = request.ip
  return typeof ip === 'string' && ip ? ip : null
}
