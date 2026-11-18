import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { buildTotpUri } from '../../../src/services/totp'
import { encodeQr, type QrMatrix } from '../../../src/shared/qr/qr-code'
import { csrfMatches, type AuthenticatedVendor, type VendorAuth } from '../auth'
import { LicenseError, type LicenseService } from '../license-service'
import { licenceFileResponse } from '../license-api'
import type { SigningIdentity } from '../signing'
import { renderPage } from './html'
import {
  auditPage, customerPage, customersPage, dashboardPage, editionLabel, licenseDetailPage, licensesPage,
  loginPage, newLicensePage, onsitePage, relayPage, setupPage, setupTotpPage, teamPage,
} from './pages'
import { PORTAL_CSS } from './styles'

/**
 * The portal's HTTP surface. Everything state-changing is a POST carrying the session's CSRF token, and every
 * successful POST redirects, so a refresh cannot repeat an action (renewing a licence twice by accident would
 * extend a shop's term by two years).
 *
 * Sessions live in a cookie that is HttpOnly, SameSite=Strict and Secure in production. The CSRF token lives in
 * the session row, not in a readable cookie, so a cross-site form cannot obtain it.
 */
export interface Mailer {
  send(to: string, subject: string, body: string): Promise<boolean>
}

export interface PortalOptions {
  auth: VendorAuth
  service: LicenseService
  database: Database.Database
  identity: SigningIdentity
  secureCookies: boolean
  sessionMinutes: number
  relayDomain: string
  relayLinkSizeLimit: number
  /** Null when SMTP is not configured; the portal then says so instead of pretending to send. */
  mailer: Mailer | null
  /** When set, the first-run page may only create this address as Owner. */
  emailBootstrapOwner: string | null
  now?: () => number
}

const SESSION_COOKIE = 'infoflex_portal'
const FLASH_COOKIE = 'infoflex_flash'
const LIST_LIMIT = 200
const HTML = 'text/html; charset=utf-8'

interface PageContext {
  request: FastifyRequest
  reply: FastifyReply
  vendor: AuthenticatedVendor
  csrf: string
}

export function registerPortal(app: FastifyInstance, options: PortalOptions): void {
  const { auth, service, database } = options

  // ------------------------------------------------------------------ assets

  app.get('/portal/assets/portal.css', async (_request, reply) =>
    reply.header('content-type', 'text/css; charset=utf-8').header('cache-control', 'public, max-age=3600').send(PORTAL_CSS))

  app.get<{ Params: { name: string } }>('/portal/assets/:name', async (request, reply) => {
    const asset = ASSETS[request.params.name]
    if (!asset) return reply.code(404).send({ message: 'Not found' })
    return reply.header('content-type', asset.type).header('cache-control', 'public, max-age=86400').send(asset.body)
  })

  // ------------------------------------------------------------------ sign-in and first run

  app.get('/portal/login', async (request, reply) => {
    if (auth.countUsers() === 0) return reply.redirect('/portal/setup')
    return sendPage(reply, renderPage({
      title: 'Sign in', bare: true, body: loginPage({ error: flashMessage(request), notice: null }),
    }))
  })

  app.post<{ Body: Record<string, unknown> }>('/portal/login', async (request, reply) => {
    const body = bodyOf(request)
    const result = await auth.login({
      email: body.email ?? '',
      password: body.password ?? '',
      code: body.code ?? '',
      ipAddress: request.ip || null,
      userAgent: String(request.headers['user-agent'] ?? ''),
    })
    if (!result.ok) {
      // The same page and a short delay for every failure: nothing hints at which factor was wrong.
      await new Promise((resolve) => setTimeout(resolve, 200))
      return sendPage(reply.code(401), renderPage({ title: 'Sign in', bare: true, body: loginPage({ error: result.message, notice: null }) }))
    }
    reply.header('set-cookie', sessionCookie(result.token, options.sessionMinutes, options.secureCookies))
    return reply.redirect('/portal')
  })

  app.post('/portal/logout', async (request, reply) => {
    auth.logout(cookie(request, SESSION_COOKIE))
    reply.header('set-cookie', expiredCookie(SESSION_COOKIE, options.secureCookies))
    return reply.redirect('/portal/login')
  })

  app.get('/portal/setup', async (request, reply) => {
    if (auth.countUsers() > 0) return reply.redirect('/portal/login')
    return sendPage(reply, renderPage({
      title: 'Set up the portal', bare: true, body: setupPage({ error: flashMessage(request), csrf: setupCsrf() }),
    }))
  })

  app.post<{ Body: Record<string, unknown> }>('/portal/setup', async (request, reply) => {
    if (auth.countUsers() > 0) return reply.redirect('/portal/login')
    const body = bodyOf(request)
    if (!csrfMatches(setupCsrf(), body._csrf)) return reply.code(403).redirect('/portal/setup')
    if (body.password !== body.confirm) {
      return redirectWithFlash(reply, '/portal/setup', 'The two passwords do not match.', options, 'error')
    }
    if (options.emailBootstrapOwner && (body.email ?? '').toLowerCase() !== options.emailBootstrapOwner.toLowerCase()) {
      return redirectWithFlash(reply, '/portal/setup', 'This deployment only allows the pre-configured Owner e-mail here.', options, 'error')
    }
    try {
      const user = await auth.createUser({
        email: body.email ?? '', displayName: body.displayName ?? '', password: body.password ?? '', role: 'OWNER',
      }, 'setup')
      service.audit('setup', 'portal.first_owner_created', user.id, { email: user.email }, request.ip || null)
      // The Owner must enrol 2FA before the account can sign in, so the next page is the enrolment page.
      // The secret travels in the short-lived flash, never in a URL the browser would keep in history.
      setFlash(reply, {
        userId: user.id, totpSecret: user.totp_secret, email: user.email,
        notice: 'Owner created. Scan the QR code to finish two-factor setup.',
      }, options)
      return reply.redirect('/portal/setup/totp')
    } catch (error) {
      return redirectWithFlash(reply, '/portal/setup', messageOf(error), options, 'error')
    }
  })

  app.get('/portal/setup/totp', async (request, reply) => {
    if (auth.countUsers() === 0) return reply.redirect('/portal/setup')
    const flash = readFlash(request)
    if (!flash?.userId || !flash.totpSecret) return reply.redirect('/portal/login')
    const uri = buildTotpUri({ secret: flash.totpSecret, account: flash.email ?? 'owner', issuer: 'Infoflex Vendor' })
    return sendPage(reply, renderPage({
      title: 'Two-factor setup', bare: true,
      body: setupTotpPage({ csrf: setupCsrf(), userId: flash.userId, secret: flash.totpSecret, qr: qrDataUrl(encodeQr(uri), 8), error: flashMessage(request) }),
    }))
  })

  app.post<{ Body: Record<string, unknown> }>('/portal/setup/totp', async (request, reply) => {
    const body = bodyOf(request)
    if (!csrfMatches(setupCsrf(), body._csrf)) return reply.code(403).redirect('/portal/login')
    // The secret comes back from the flash rather than the form, so a tampered userId cannot enrol another row.
    const flash = readFlash(request)
    if (!flash?.userId) return reply.redirect('/portal/setup')
    try {
      auth.confirmTotpSetup(flash.userId, body.code ?? '')
      return redirectWithFlash(reply, '/portal/login', 'Two-factor is active. Sign in to continue.', options)
    } catch (error) {
      setFlash(reply, { ...flash, error: messageOf(error) }, options)
      return reply.redirect('/portal/setup/totp')
    }
  })

  // ------------------------------------------------------------------ pages

  /**
   * One wrapper for every signed-in page. The handler returns a full HTML document; failures become a message
   * on the page the vendor came from rather than a stack trace.
   */
  const page = (handler: (context: PageContext) => string | Promise<string>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const vendor = auth.authenticate(cookie(request, SESSION_COOKIE))
      if (!vendor) {
        reply.header('set-cookie', expiredCookie(SESSION_COOKIE, options.secureCookies))
        return reply.redirect('/portal/login')
      }
      try {
        return sendPage(reply, await handler({ request, reply, vendor, csrf: vendor.session.csrf_token }))
      } catch (error) {
        if (error instanceof LicenseError) {
          return redirectWithFlash(reply, safeBack(request), error.message, options, 'error')
        }
        throw error
      }
    }

  /** Downloads (CSV, .lic) are not HTML, so they get their own session check and answer with a reply. */
  function pageCsv(handler: (context: PageContext) => FastifyReply | Promise<FastifyReply>) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const vendor = auth.authenticate(cookie(request, SESSION_COOKIE))
      if (!vendor) return reply.redirect('/portal/login')
      return handler({ request, reply, vendor, csrf: vendor.session.csrf_token })
    }
  }

  app.get('/portal', page(({ vendor, csrf }) => {
    const licenses = service.listLicenses()
    return renderPage({
      title: 'Dashboard', active: 'dashboard', csrf, vendor: label(vendor),
      body: dashboardPage({
        csrf,
        licenses,
        buckets: service.expiringSoon(),
        relayOnline: licenses.filter((license) => license.relay_status === 'online').length,
        onSiteCount: licenses.filter((license) => license.source === 'onsite').length,
        mailConfigured: options.mailer !== null,
      }),
    })
  }))

  app.get<{ Querystring: { q?: string } }>('/portal/customers', page(({ vendor, csrf, request }) => {
    const search = (request.query as { q?: string }).q ?? ''
    return renderPage({
      title: 'Customers', active: 'customers', csrf, vendor: label(vendor),
      body: customersPage({ csrf, customers: service.listCustomers(search), search }),
    })
  }))

  app.get<{ Params: { customerId: string } }>('/portal/customers/:customerId', page(({ vendor, csrf, request }) => {
    const customer = service.getCustomer((request.params as { customerId: string }).customerId)
    return renderPage({
      title: customer.business_name, active: 'customers', csrf, vendor: label(vendor),
      body: customerPage({ csrf, customer, licenses: service.listLicenses({ customerId: customer.id }) }),
    })
  }))

  app.get<{ Querystring: { q?: string; filter?: string } }>('/portal/licenses', page(({ vendor, csrf, request }) => {
    const query = request.query as { q?: string; filter?: string }
    const search = query.q ?? ''
    const filter = query.filter ?? ''
    return renderPage({
      title: 'Licences', active: 'licenses', csrf, vendor: label(vendor),
      body: licensesPage({ csrf, licenses: service.listLicenses({ search, filter }), search, filter }),
    })
  }))

  app.get<{ Querystring: { q?: string; filter?: string } }>('/portal/licenses/export.csv', pageCsv(({ vendor, request, reply }) => {
    const query = request.query as { q?: string; filter?: string }
    const rows = service.listLicenses({ search: query.q ?? '', filter: query.filter ?? '' })
    service.audit(vendor.user.email, 'licence.csv_exported', null, { count: rows.length }, request.ip || null)
    const header = ['customer', 'licence_key', 'edition', 'status', 'starts', 'ends', 'days_remaining', 'admin_phones', 'mobile_lan', 'mobile_internet', 'default_currency', 'lock_currency', 'machine_id', 'source', 'last_checkin']
    const lines = [header.join(',')]
    for (const row of rows) {
      lines.push([
        row.customer_name, row.license_key, row.edition, row.effective_status, row.starts_at.slice(0, 10), row.ends_at.slice(0, 10),
        String(row.days_remaining), String(row.max_admin_phones), row.mobile_lan ? 'yes' : 'no', row.mobile_internet ? 'yes' : 'no',
        row.default_currency ?? '', row.lock_currency ? 'yes' : 'no', row.machine_id ?? '', row.source, row.last_checkin_at ?? '',
      ].map(csvCell).join(','))
    }
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="infoflex-licences-${today()}.csv"`)
      .header('cache-control', 'no-store')
      .send(Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8'))
  }))

  app.get('/portal/licenses/new', page(({ vendor, csrf, request }) =>
    renderPage({
      title: 'New licence', active: 'licenses', csrf, vendor: label(vendor),
      body: newLicensePage({ csrf, customers: service.listCustomers(''), today: today(), oneYear: addYears(today(), 1), preselectedCustomerId: null, error: flashMessage(request) }),
    })))

  app.get<{ Params: { licenseId: string }; Querystring: { machine?: string } }>('/portal/licenses/:licenseId', page(({ vendor, csrf, request }) => {
    const params = request.params as { licenseId: string }
    const query = request.query as { machine?: string }
    const license = service.getLicenseView(params.licenseId)
    const customer = service.getCustomer(license.customer_id)
    const relay = database.prepare('SELECT status, last_seen_at, connected_at FROM relay_connections WHERE shop_id = ?').get(license.id) as
      { status: string; last_seen_at: string | null; connected_at: string | null } | undefined
    const flash = readFlash(request)
    return renderPage({
      title: customer.business_name, active: 'licenses', csrf, vendor: label(vendor),
      body: licenseDetailPage({
        csrf,
        license,
        customer,
        history: service.listHistory(license.id, LIST_LIMIT),
        checkIns: service.listCheckIns(license.id, 25),
        relay: relay ?? null,
        activationCode: flash?.activationCode ?? null,
        offlineMachine: query.machine ?? '',
      }),
    })
  }))

  app.get<{ Params: { licenseId: string }; Querystring: { machine?: string } }>('/portal/licenses/:licenseId/file', pageCsv(({ vendor, request, reply }) => {
    const params = request.params as { licenseId: string }
    const query = request.query as { machine?: string }
    const result = service.offlineFile(params.licenseId, (query.machine ?? '').trim(), vendor.user.email)
    return licenceFileResponse(reply, { token: result.token, fileName: result.fileName })
  }))

  app.get('/portal/onsite', page(({ vendor, csrf }) =>
    renderPage({
      title: 'On-site licences', active: 'onsite', csrf, vendor: label(vendor),
      body: onsitePage({ licenses: service.listLicenses({ filter: 'onsite' }) }),
    })))

  app.get('/portal/relay', page(({ vendor, csrf }) => {
    const connections = database.prepare(
      'SELECT shop_id, license_id, status, connected_at, last_seen_at, frames, bytes_in, bytes_out, peer_address FROM relay_connections ORDER BY last_seen_at DESC',
    ).all() as Array<{ shop_id: string; license_id: string | null; status: string; connected_at: string | null; last_seen_at: string | null; frames: number; bytes_in: number; bytes_out: number; peer_address: string | null }>
    return renderPage({
      title: 'Relay', active: 'relay', csrf, vendor: label(vendor),
      body: relayPage({
        connections, relayConfigured: Boolean(options.relayDomain),
        relayDomain: options.relayDomain || '(not configured)', linkSizeLimit: options.relayLinkSizeLimit,
      }),
    })
  }))

  app.get('/portal/team', page(({ vendor, csrf, request }) => {
    const flash = readFlash(request)
    const pending = flash?.userId && flash.totpSecret
      ? {
          secret: flash.totpSecret,
          uri: buildTotpUri({ secret: flash.totpSecret, account: vendor.user.email, issuer: 'Infoflex Vendor' }),
          qr: '',
        }
      : null
    if (pending) pending.qr = qrDataUrl(encodeQr(pending.uri), 8)
    return renderPage({
      title: 'Team', active: 'team', csrf, vendor: label(vendor),
      body: teamPage({
        csrf, users: auth.listUsers(), isOwner: vendor.user.role === 'OWNER',
        totpSetup: pending, newUserId: flash?.userId ?? null,
        notice: flash?.notice ?? flash?.error ?? null,
      }),
    })
  }))

  app.get('/portal/audit', page(({ vendor, csrf }) =>
    renderPage({ title: 'Audit log', active: 'audit', csrf, vendor: label(vendor), body: auditPage({ entries: service.listAudit(300) }) })))

  // ------------------------------------------------------------------ actions

  /**
   * A CSRF-checked POST. `redirect` returns where to land afterwards. Anything thrown becomes a flash message
   * on the referring page, so a vendor on a phone never sees a stack trace.
   */
  const action = (
    path: string,
    handler: (context: PageContext, body: Record<string, string>, params: Record<string, string>) => void | Promise<void>,
    redirect: (params: Record<string, string>) => string,
  ) => {
    app.post<{ Body: Record<string, unknown>; Params: Record<string, string> }>(path, async (request, reply) => {
      const vendor = auth.authenticate(cookie(request, SESSION_COOKIE))
      if (!vendor) return reply.redirect('/portal/login')
      const body = bodyOf(request)
      const params = (request.params ?? {}) as Record<string, string>
      if (!csrfMatches(vendor.session.csrf_token, body._csrf)) {
        service.audit(vendor.user.email, 'portal.csrf_rejected', path, {}, request.ip || null)
        return redirectWithFlash(reply, safeBack(request), 'That form expired. Reload the page and try again.', options, 'error')
      }
      try {
        await handler({ request, reply, vendor, csrf: vendor.session.csrf_token }, body, params)
      } catch (error) {
        return redirectWithFlash(reply, safeBack(request), messageOf(error), options, 'error')
      }
      return reply.redirect(redirect(params))
    })
  }

  action('/portal/customers/:customerId', ({ vendor }, body, params) => {
    service.updateCustomer(params.customerId!, {
      businessName: body.businessName,
      contactName: body.contactName ?? '',
      email: body.email ?? '',
      phone: body.phone ?? '',
      notes: body.notes ?? '',
    }, vendor.user.email)
  }, (params) => `/portal/customers/${params.customerId}`)

  /** Creating a licence must land on the new licence, so it is handled directly rather than via `action`. */
  app.post<{ Body: Record<string, unknown> }>('/portal/licenses/new', async (request, reply) => {
    const vendor = auth.authenticate(cookie(request, SESSION_COOKIE))
    if (!vendor) return reply.redirect('/portal/login')
    const body = bodyOf(request)
    if (!csrfMatches(vendor.session.csrf_token, body._csrf)) {
      service.audit(vendor.user.email, 'portal.csrf_rejected', '/portal/licenses/new', {}, request.ip || null)
      return redirectWithFlash(reply, '/portal/licenses/new', 'That form expired. Reload the page and try again.', options, 'error')
    }
    try {
      const result = service.createLicense({
        customer: { businessName: body.businessName ?? '', contactName: body.contactName, phone: body.phone, email: body.email, notes: body.notes },
        edition: editionField(body.edition),
        startsAt: body.startsAt ?? '',
        endsAt: body.endsAt ?? '',
        maxAdminPhones: numberField(body.maxAdminPhones, 1),
        mobileLan: body.mobileLan === '1',
        mobileInternet: body.mobileInternet === '1',
        defaultCurrencyCode: body.defaultCurrencyCode ? body.defaultCurrencyCode : null,
        lockCurrency: body.lockCurrency === '1',
        graceDays: numberField(body.graceDays, 0),
      }, vendor.user.email)
      if (body.sendWelcome === '1' && options.mailer && result.customer.email) {
        await options.mailer.send(
          result.customer.email,
          'Your Infoflex licence',
          `Hello ${result.customer.contact_name || result.customer.business_name},\n\n`
          + `Your Infoflex ${editionLabel(result.license.edition)} licence is ready.\n\n`
          + `Activation key: ${result.license.license_key}\n`
          + `Term: ${result.license.starts_at.slice(0, 10)} to ${result.license.ends_at.slice(0, 10)}\n\n`
          + 'Open Infoflex, choose Activate, and type this key. Your store name and currency are set on the next screen.\n',
        ).catch(() => false)
      }
      return reply.redirect(`/portal/licenses/${result.license.id}`)
    } catch (error) {
      return sendPage(reply.code(400), renderPage({
        title: 'New licence', active: 'licenses', csrf: vendor.session.csrf_token, vendor: label(vendor),
        body: newLicensePage({
          csrf: vendor.session.csrf_token, customers: service.listCustomers(''), today: today(),
          oneYear: addYears(today(), 1), preselectedCustomerId: null, error: messageOf(error),
        }),
      }))
    }
  })

  action('/portal/licenses/:licenseId/renew', ({ vendor }, body, params) => {
    const endsAt = body.quickYears
      ? addYears(body.startsAt ? body.startsAt.slice(0, 10) : today(), numberField(body.quickYears, 1))
      : (body.endsAt ?? '')
    service.renewLicense(params.licenseId!, {
      endsAt,
      startsAt: body.startsAt ? body.startsAt.slice(0, 10) : undefined,
      notifyNow: body.notifyNow === '1',
    }, vendor.user.email)
  }, (params) => `/portal/licenses/${params.licenseId}`)

  action('/portal/licenses/:licenseId/entitlements', ({ vendor }, body, params) => {
    service.setEntitlements(params.licenseId!, {
      maxAdminPhones: numberField(body.maxAdminPhones, 1),
      mobileLan: body.mobileLan === '1',
      mobileInternet: body.mobileInternet === '1',
      graceDays: numberField(body.graceDays, 0),
      defaultCurrencyCode: body.defaultCurrencyCode ? body.defaultCurrencyCode : null,
      lockCurrency: body.lockCurrency === '1',
    }, vendor.user.email)
    if (body.edition) service.setEdition(params.licenseId!, editionField(body.edition), vendor.user.email)
  }, (params) => `/portal/licenses/${params.licenseId}`)

  action('/portal/licenses/:licenseId/suspend', ({ vendor }, _body, params) => {
    service.setStatus(params.licenseId!, 'suspended', vendor.user.email)
  }, (params) => `/portal/licenses/${params.licenseId}`)

  action('/portal/licenses/:licenseId/unsuspend', ({ vendor }, _body, params) => {
    service.setStatus(params.licenseId!, 'active', vendor.user.email)
  }, (params) => `/portal/licenses/${params.licenseId}`)

  action('/portal/licenses/:licenseId/revoke', ({ vendor }, _body, params) => {
    service.revoke(params.licenseId!, vendor.user.email)
  }, (params) => `/portal/licenses/${params.licenseId}`)

  action('/portal/licenses/:licenseId/rebind', ({ vendor }, _body, params) => {
    service.rebindMachine(params.licenseId!, vendor.user.email)
  }, (params) => `/portal/licenses/${params.licenseId}`)

  /** The code is shown once, on the licence page after the redirect, and is never rendered again. */
  app.post<{ Body: Record<string, unknown> }>('/portal/licenses/:licenseId/activation-code', async (request, reply) => {
    const vendor = auth.authenticate(cookie(request, SESSION_COOKIE))
    if (!vendor) return reply.redirect('/portal/login')
    const body = bodyOf(request)
    const params = request.params as { licenseId: string }
    if (!csrfMatches(vendor.session.csrf_token, body._csrf)) return redirectWithFlash(reply, safeBack(request), 'That form expired. Reload the page and try again.', options, 'error')
    try {
      const code = service.generateActivationCode(params.licenseId, vendor.user.email)
      setFlash(reply, { activationCode: code }, options)
    } catch (error) {
      return redirectWithFlash(reply, `/portal/licenses/${params.licenseId}`, messageOf(error), options, 'error')
    }
    return reply.redirect(`/portal/licenses/${params.licenseId}`)
  })

  action('/portal/team/:userId/reset-totp', ({ vendor }, _body, params) => {
    if (vendor.user.role !== 'OWNER') throw new Error('Only an Owner can reset two-factor.')
    auth.resetTotp(params.userId!, vendor.user.email)
  }, () => '/portal/team')

  action('/portal/team/:userId/toggle', ({ vendor }, _body, params) => {
    if (vendor.user.role !== 'OWNER') throw new Error('Only an Owner can enable or disable accounts.')
    if (params.userId === vendor.user.id) throw new Error('You cannot disable your own account.')
    const target = auth.getUser(params.userId!)
    auth.setActive(target.id, target.is_active !== 1, vendor.user.email)
  }, () => '/portal/team')

  app.post<{ Body: Record<string, unknown> }>('/portal/team/new', async (request, reply) => {
    const vendor = auth.authenticate(cookie(request, SESSION_COOKIE))
    if (!vendor) return reply.redirect('/portal/login')
    const body = bodyOf(request)
    if (!csrfMatches(vendor.session.csrf_token, body._csrf)) {
      service.audit(vendor.user.email, 'portal.csrf_rejected', '/portal/team', {}, request.ip || null)
      return redirectWithFlash(reply, '/portal/team', 'That form expired. Reload the page and try again.', options, 'error')
    }
    if (vendor.user.role !== 'OWNER') return redirectWithFlash(reply, '/portal/team', 'Only an Owner can create accounts.', options, 'error')
    try {
      const user = await auth.createUser({
        email: body.email ?? '', displayName: body.displayName ?? '', password: body.password ?? '',
        role: body.role === 'OWNER' ? 'OWNER' : 'STAFF',
      }, vendor.user.email)
      setFlash(reply, { userId: user.id, totpSecret: user.totp_secret, notice: 'Scan the QR code to finish setting up two-factor for the new account.' }, options)
      return reply.redirect('/portal/team')
    } catch (error) {
      return redirectWithFlash(reply, '/portal/team', messageOf(error), options, 'error')
    }
  })

  app.post<{ Body: Record<string, unknown> }>('/portal/team/totp', async (request, reply) => {
    const vendor = auth.authenticate(cookie(request, SESSION_COOKIE))
    if (!vendor) return reply.redirect('/portal/login')
    const body = bodyOf(request)
    if (!csrfMatches(vendor.session.csrf_token, body._csrf)) {
      service.audit(vendor.user.email, 'portal.csrf_rejected', '/portal/team', {}, request.ip || null)
      return redirectWithFlash(reply, '/portal/team', 'That form expired. Reload the page and try again.', options, 'error')
    }
    try {
      auth.confirmTotpSetup(body.userId || vendor.user.id, body.code ?? '')
      return redirectWithFlash(reply, '/portal/team', 'Two-factor is active for that account.', options)
    } catch (error) {
      return redirectWithFlash(reply, '/portal/team', messageOf(error), options, 'error')
    }
  })
}

// -------------------------------------------------------------------- assets

/** The brand images, resolved once at start-up so a missing file fails loudly in the deploy check. */
export const ASSETS: Record<string, { type: string; body: Buffer }> = {}

export function registerAssets(load: (name: string) => Buffer | null): void {
  for (const name of ['logo.png', 'logo-white.png', 'favicon.png']) {
    const body = load(name)
    if (body) ASSETS[name] = { type: 'image/png', body }
  }
}

// -------------------------------------------------------------------- helpers

function sendPage(reply: FastifyReply, body: string): FastifyReply {
  return reply
    .header('content-type', HTML)
    // A portal page must never be cached: it holds a licence key and a CSRF token.
    .header('cache-control', 'no-store, private')
    .header('x-frame-options', 'DENY')
    .header('referrer-policy', 'same-origin')
    .send(body)
}

function bodyOf(request: FastifyRequest): Record<string, string> {
  const value = request.body
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const output: Record<string, string> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (typeof child === 'string') output[key] = child
    else if (typeof child === 'number' || typeof child === 'boolean') output[key] = String(child)
  }
  return output
}

function cookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie
  if (typeof header !== 'string') return undefined
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim())
  }
  return undefined
}

function sessionCookie(token: string, minutes: number, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${minutes * 60}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ')
}

function expiredCookie(name: string, secure: boolean): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`
}

interface Flash { notice?: string; error?: string; userId?: string; totpSecret?: string; email?: string; activationCode?: string }

function setFlash(reply: FastifyReply, flash: Flash, options: PortalOptions): void {
  const encoded = Buffer.from(JSON.stringify(flash), 'utf8').toString('base64url')
  // The flash rides in its own short-lived cookie so a redirect can carry a message without server state.
  const value = `${FLASH_COOKIE}=${encodeURIComponent(encoded)}; Path=/portal; HttpOnly; SameSite=Strict; Max-Age=120${options.secureCookies ? '; Secure' : ''}`
  const existing = reply.getHeader('set-cookie')
  reply.header('set-cookie', existing ? [existing, value].flat() : value)
}

function readFlash(request: FastifyRequest): Flash | null {
  const value = cookie(request, FLASH_COOKIE)
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    return parsed && typeof parsed === 'object' ? parsed as Flash : null
  } catch {
    return null
  }
}

function flashMessage(request: FastifyRequest): string {
  const flash = readFlash(request)
  return flash?.error ?? flash?.notice ?? ''
}

function redirectWithFlash(reply: FastifyReply, location: string, message: string, options: PortalOptions, kind: 'notice' | 'error' = 'notice'): FastifyReply {
  setFlash(reply, kind === 'error' ? { error: message } : { notice: message }, options)
  return reply.redirect(location)
}

/** Only a path inside the portal is ever accepted, so a crafted Referer cannot bounce the vendor off-site. */
function safeBack(request: FastifyRequest): string {
  const referer = request.headers.referer
  if (typeof referer === 'string') {
    try {
      const url = new URL(referer)
      if (url.pathname.startsWith('/portal')) return `${url.pathname}${url.search}`
    } catch {
      // fall through to the dashboard
    }
  }
  return '/portal'
}

function label(vendor: AuthenticatedVendor): { displayName: string; role: string; email: string } {
  return { displayName: vendor.user.display_name, role: vendor.user.role, email: vendor.user.email }
}

let setupCsrfToken = randomBytes(24).toString('base64url')

/** The first-run token is process-wide and rotates on restart; the setup pages run before any session exists. */
function setupCsrf(): string {
  return setupCsrfToken
}

export function rotateSetupCsrf(): string {
  setupCsrfToken = randomBytes(24).toString('base64url')
  return setupCsrfToken
}

function editionField(value: string | undefined): 'PHARMACY' | 'SUPERMARKET' | 'BOTH' {
  if (value === 'SUPERMARKET') return 'SUPERMARKET'
  if (value === 'BOTH') return 'BOTH'
  return 'PHARMACY'
}

function numberField(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : fallback
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'That action could not be completed.'
}

function csvCell(value: string): string {
  const text = String(value ?? '')
  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function addYears(dateText: string, years: number): string {
  const date = new Date(`${dateText}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) return dateText
  const target = new Date(Date.UTC(date.getUTCFullYear() + years, date.getUTCMonth(), date.getUTCDate()))
  if (target.getUTCMonth() !== date.getUTCMonth()) target.setUTCDate(0)
  return target.toISOString().slice(0, 10)
}

/**
 * A QR code as an inline PNG data URL, so two-factor enrolment needs no image endpoint and no network call.
 * The encoder writes a valid PNG (IHDR/IDAT/IEND) with zlib's stored-block mode: no compression, no dependency.
 */
export function qrDataUrl(matrix: QrMatrix, scale: number): string {
  const size = matrix.size
  const border = 4
  const dimension = (size + border * 2) * scale
  const raw: number[] = []
  for (let y = 0; y < dimension; y += 1) {
    raw.push(0)
    for (let x = 0; x < dimension; x += 1) {
      const mx = Math.floor(x / scale) - border
      const my = Math.floor(y / scale) - border
      const dark = mx >= 0 && my >= 0 && mx < size && my < size && matrix.modules[my]?.[mx] === true
      raw.push(dark ? 0 : 255, dark ? 0 : 255, dark ? 0 : 255)
    }
  }
  const bytes = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...pngChunk('IHDR', [...u32(dimension), ...u32(dimension), 8, 2, 0, 0, 0]),
    ...pngChunk('IDAT', zlibStored(raw)),
    ...pngChunk('IEND', []),
  ]
  return `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
}

function pngChunk(type: string, data: number[]): number[] {
  const body = [...[...type].map((character) => character.charCodeAt(0)), ...data]
  return [...u32(data.length), ...body, ...u32(crc32(body))]
}

function zlibStored(data: number[]): number[] {
  const out = [0x78, 0x01]
  const max = 65_535
  for (let offset = 0; offset < data.length; offset += max) {
    const block = data.slice(offset, offset + max)
    const final = offset + max >= data.length ? 1 : 0
    out.push(final, block.length & 0xff, (block.length >>> 8) & 0xff, ~block.length & 0xff, (~block.length >>> 8) & 0xff, ...block)
  }
  let a = 1
  let b = 0
  for (const byte of data) {
    a = (a + byte) % 65_521
    b = (b + a) % 65_521
  }
  out.push((b >>> 8) & 0xff, b & 0xff, (a >>> 8) & 0xff, a & 0xff)
  return out
}

function crc32(data: number[]): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}
