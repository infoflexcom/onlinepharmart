import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AuthenticatedPrincipal } from '../services/permissions'
import type { ReportPeriodInput } from '../shared/reports/types'
import type {
  MobileCashierPermissionInput,
  MobileProductCreateInput,
  MobileProductUpdateInput,
  MobileStockAdjustmentInput,
  MobileStockReceiptInput,
} from '../shared/mobile/admin-types'
import { MobileAdminService, MobileReloadRequiredError, MobileStaleVersionError } from './mobile-admin-service'
import { serializeBigInts } from './serialize-money'

const GENERIC_DENIAL = 'This account cannot use the mobile app'

export interface MobileAdminRouteOptions {
  service: MobileAdminService
  /** Re-verifies the bearer token and returns the Admin, or null. Supplied by the host API. */
  authenticate: (request: FastifyRequest) => Promise<AuthenticatedPrincipal | null>
  /** Runs after authentication: LAN/Internet licence gating, identical to the other mobile routes. */
  authorizeTransport: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  recordDeniedAccess: (input: {
    reason: import('../services/shop-service').AccessDenialReason
    ipAddress: string | null
    userAgent?: string
    actor?: string
  }) => void
  now?: () => number
}

/**
 * The Admin phone's whole surface, in one place.
 *
 * Every route here is wrapped so that a non-Admin token is refused with the same sentence as everywhere
 * else and can never reach the service. The writes all go through `MobileAdminService`, which delegates to
 * the very same host services the desktop calls, so a rule that holds on the PC holds on the phone.
 */
export function registerMobileAdminRoutes(server: FastifyInstance, options: MobileAdminRouteOptions): void {
  const now = options.now ?? Date.now

  /** Authenticates, applies the same licence/network gate as login, and stores the verified Admin. */
  const guard = async (request: FastifyRequest, reply: FastifyReply): Promise<AuthenticatedPrincipal | null> => {
    let principal: AuthenticatedPrincipal | null = null
    try {
      principal = await options.authenticate(request)
    } catch {
      principal = null
    }
    if (!principal) {
      await reply.code(401).send({ message: GENERIC_DENIAL })
      return null
    }
    if (principal.role !== 'ADMIN') {
      options.recordDeniedAccess({
        reason: 'non_admin',
        ipAddress: request.ip || null,
        userAgent: String(request.headers['user-agent'] ?? ''),
        actor: principal.username,
      })
      await reply.code(403).send({ message: GENERIC_DENIAL })
      return null
    }
    await options.authorizeTransport(request, reply)
    // `reply.sent` is not reliable inside a route handler, so ask the reply directly: has the licence
    // gate already answered? If so the handler must not run and must not send a second body.
    if (reply.raw.headersSent) return null
    return principal
  }

  type Handler = (principal: AuthenticatedPrincipal, request: FastifyRequest) => unknown | Promise<unknown>

  /**
   * One wrapper so no route can forget the order that matters: prove the token is an Admin first (so a
   * non-Admin never even learns the host's licence state), then apply the same LAN/Internet gate as login,
   * then run the handler with a verified Admin.
   */
  const route = (method: 'GET' | 'POST', url: string, handler: Handler): void => {
    const wrapped = async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = await guard(request, reply)
      if (!principal) return reply
      try {
        const result = await handler(principal, request)
        // A late refusal (the licence expired between the gate and the call) is still a refusal.
        if (reply.raw.headersSent) return reply
        // Every figure below came out of a host service as `bigint` minor units, and `JSON.stringify` throws on
        // a BigInt. Converting here, once, is what stops a route from silently answering 500 the first time
        // somebody actually loads it with money in the shop.
        return reply.header('cache-control', 'no-store').send(serializeBigInts(result ?? { ok: true }))
      } catch (error) {
        if (reply.raw.headersSent) return reply
        return sendError(reply, error)
      }
    }
    if (method === 'GET') server.get(url, wrapped)
    else server.post(url, wrapped)
  }

  // ---------------------------------------------------------------- dashboard

  route('GET', '/api/v1/mobile/admin/dashboard', (principal) => options.service.dashboard(principal))

  // ---------------------------------------------------------------- stock

  route('GET', '/api/v1/mobile/admin/products', (principal, request) => {
    const query = request.query as { search?: unknown } | null
    const search = typeof query?.search === 'string' ? query.search : ''
    return options.service.searchProducts(principal, search)
  })

  route('GET', '/api/v1/mobile/admin/products/:productId', (principal, request) => {
    const params = request.params as { productId?: string }
    return options.service.productDetail(principal, requireId(params.productId))
  })

  route('POST', '/api/v1/mobile/admin/products/:productId', (principal, request) => {
    const params = request.params as { productId?: string }
    const body = asObject(request.body)
    const input: MobileProductUpdateInput = {
      productId: requireId(params.productId),
      expectedRowVersion: requireInteger(body.expectedRowVersion, 'Reload this item before saving.'),
      adminPassword: requireText(body.adminPassword, 'Enter your Admin password.'),
      name: requireText(body.name, 'Enter the product name.'),
      brand: optionalText(body.brand),
      category: optionalText(body.category),
      unit: optionalText(body.unit) || 'unit',
      barcode: optionalText(body.barcode),
      reorderLevel: optionalText(body.reorderLevel) || '0',
      retailPrice: requireText(body.retailPrice, 'Enter the retail price.'),
      wholesalePrice: requireText(body.wholesalePrice, 'Enter the wholesale price.'),
      cost: optionalText(body.cost) || '0',
    }
    return options.service.updateProduct(principal, input)
  })

  route('POST', '/api/v1/mobile/admin/products', (principal, request) => {
    const body = asObject(request.body)
    const input: MobileProductCreateInput = {
      sku: optionalText(body.sku),
      name: requireText(body.name, 'Enter the product name.'),
      barcode: optionalText(body.barcode),
      unit: optionalText(body.unit) || 'unit',
      category: optionalText(body.category),
      retailPrice: requireText(body.retailPrice, 'Enter the retail price.'),
      wholesalePrice: requireText(body.wholesalePrice, 'Enter the wholesale price.'),
      cost: optionalText(body.cost) || '0',
      reorderLevel: optionalText(body.reorderLevel) || '0',
      expiryTracking: Boolean(body.expiryTracking),
      prescriptionRequired: Boolean(body.prescriptionRequired),
    }
    return options.service.createProduct(principal, input)
  })

  route('POST', '/api/v1/mobile/admin/products/:productId/stock', (principal, request) => {
    const params = request.params as { productId?: string }
    const body = asObject(request.body)
    const input: MobileStockAdjustmentInput = {
      productId: requireId(params.productId),
      expectedProductVersion: requireInteger(body.expectedProductVersion, 'Reload this item before saving.'),
      expectedStockVersion: requireInteger(body.expectedStockVersion, 'Reload this item before saving.'),
      direction: body.direction === 'decrease' ? 'decrease' : 'increase',
      quantity: requireText(body.quantity, 'Enter how much stock is changing.'),
      reason: requireText(body.reason, 'Say why the stock is changing.'),
      batchNumber: optionalText(body.batchNumber),
      expiryDate: optionalText(body.expiryDate),
      // Required, not optional: a retry after a dropped connection must not move stock twice.
      idempotencyKey: requireText(body.idempotencyKey, 'Reload this item and try again.'),
    }
    return options.service.adjustStock(principal, input)
  })

  route('POST', '/api/v1/mobile/admin/products/:productId/receive', (principal, request) => {
    const params = request.params as { productId?: string }
    const body = asObject(request.body)
    const input: MobileStockReceiptInput = {
      productId: requireId(params.productId),
      expectedProductVersion: requireInteger(body.expectedProductVersion, 'Reload this item before saving.'),
      expectedStockVersion: requireInteger(body.expectedStockVersion, 'Reload this item before saving.'),
      quantity: requireText(body.quantity, 'Enter the quantity received.'),
      quantityUnit: body.quantityUnit === 'pack' ? 'pack' : 'unit',
      unitCost: requireText(body.unitCost, 'Enter the unit cost.'),
      supplierName: optionalText(body.supplierName),
      supplierReference: optionalText(body.supplierReference),
      note: optionalText(body.note),
      batchNumber: optionalText(body.batchNumber),
      expiryDate: optionalText(body.expiryDate),
    }
    return options.service.receiveStock(principal, input)
  })

  // ---------------------------------------------------------------- reports

  route('GET', '/api/v1/mobile/admin/reports', (principal, request) => {
    return options.service.report(principal, reportInput(request.query, now()))
  })

  route('GET', '/api/v1/mobile/admin/reports.pdf', async (principal, request) => {
    const input = reportInput(request.query, now())
    const pdf = await options.service.reportPdf(principal, input)
    return { pdf: Buffer.from(pdf).toString('base64'), fileName: pdfFileName(input) }
  })

  // ---------------------------------------------------------------- sales (read only)

  route('GET', '/api/v1/mobile/admin/sales', (principal, request) => {
    const query = request.query as { search?: unknown } | null
    return options.service.sales(principal, typeof query?.search === 'string' ? query.search : '')
  })

  route('GET', '/api/v1/mobile/admin/sales/:saleId', (principal, request) => {
    const params = request.params as { saleId?: string }
    return options.service.saleDetail(principal, requireId(params.saleId))
  })

  // ---------------------------------------------------------------- cashier permissions

  route('GET', '/api/v1/mobile/admin/cashiers', (principal) => options.service.cashierPermissions(principal))

  route('POST', '/api/v1/mobile/admin/cashiers/:userId/wholesale', (principal, request) => {
    const params = request.params as { userId?: string }
    const body = asObject(request.body)
    const input: MobileCashierPermissionInput = {
      userId: requireId(params.userId),
      allowWholesale: Boolean(body.allowWholesale),
      adminPassword: requireText(body.adminPassword, 'Enter your Admin password.'),
    }
    return options.service.setCashierWholesale(principal, input)
  })

  // ---------------------------------------------------------------- paired phones

  route('GET', '/api/v1/mobile/admin/devices', (principal) => options.service.devices(principal))

  route('POST', '/api/v1/mobile/admin/devices/:deviceId/revoke', (principal, request) => {
    const params = request.params as { deviceId?: string }
    const body = asObject(request.body)
    return options.service.revokeDevice(principal, requireId(params.deviceId), requireText(body.adminPassword, 'Enter your Admin password.'))
  })

  // ---------------------------------------------------------------- approvals

  route('GET', '/api/v1/mobile/admin/approvals', (principal) => options.service.approvals(principal))

  route('POST', '/api/v1/mobile/admin/approvals/:requestId', (principal, request) => {
    const params = request.params as { requestId?: string }
    const body = asObject(request.body)
    if (body.decision !== 'APPROVE' && body.decision !== 'REJECT') {
      throw new Error('Choose Approve or Reject for this request.')
    }
    return options.service.resolveApproval(principal, requireId(params.requestId), body.decision)
  })
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof MobileStaleVersionError) {
    return reply.code(409).send({ message: error.message, reloadRequired: true, code: 'STALE_VERSION' })
  }
  if (error instanceof MobileReloadRequiredError) {
    return reply.code(409).send({ message: error.message, reloadRequired: true, code: 'ALREADY_DECIDED' })
  }
  const message = error instanceof Error && error.message.trim() ? error.message.slice(0, 240) : 'That change could not be saved.'
  if (message === GENERIC_DENIAL) return reply.code(403).send({ message })
  // A refused password re-entry is a 400 the screen can show inline, not a server fault.
  if (/Admin password|Enter your Admin password/iu.test(message)) {
    return reply.code(400).send({ message, code: 'ADMIN_PASSWORD_REQUIRED' })
  }
  // Anything the host rejected because the data has moved on is a reload, not a retry.
  if (/changed.*reload|no longer|already decided|could not be found/iu.test(message)) {
    return reply.code(409).send({ message, reloadRequired: true, code: 'STALE_VERSION' })
  }
  return reply.code(400).send({ message })
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function requireId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 120) {
    throw new Error('Reload the screen and try again.')
  }
  return value.trim()
}

function requireText(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(message)
  return value.trim()
}

function optionalText(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 240) : ''
}

function requireInteger(value: unknown, message: string): number {
  const number = typeof value === 'number' ? value : Number.NaN
  if (!Number.isInteger(number) || number < 0) throw new Error(message)
  return number
}

export function reportInput(queryValue: unknown, nowMs: number): ReportPeriodInput {
  const query = queryValue && typeof queryValue === 'object' ? queryValue as Record<string, unknown> : {}
  const period = query.period === undefined ? 'DAY' : query.period
  if (period !== 'DAY' && period !== 'MONTH') throw new Error('Choose DAY or MONTH for a report period.')
  const today = localDateString(nowMs)
  const date = query.date === undefined ? (period === 'MONTH' ? today.slice(0, 7) : today) : query.date
  if (typeof date !== 'string') throw new Error('Choose a valid report date.')
  if (period === 'MONTH' ? !/^\d{4}-\d{2}$/u.test(date) : !/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    throw new Error('Choose a valid report date.')
  }
  return { period, date }
}

function pdfFileName(input: ReportPeriodInput): string {
  return `infoflex-${input.period.toLowerCase()}-${input.date.replace(/[^0-9-]/gu, '')}.pdf`
}

function localDateString(nowMs: number): string {
  const date = new Date(nowMs)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
