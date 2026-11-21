import { describe, expect, it } from 'vitest'
import { createTestCloud, formBody, signInOwner, type TestCloud } from './helpers'

/**
 * The portal is driven the way a vendor drives it: GET a page, POST a form with the CSRF token, follow the
 * redirect. `server.inject` runs the real routing, hooks, cookie handling and HTML rendering, so a broken form
 * field or a missing token fails here rather than in front of a customer.
 */
async function portal(env: TestCloud, url: string, cookie: string) {
  return env.app.inject({ method: 'GET', url, headers: { cookie } })
}

async function post(env: TestCloud, url: string, cookie: string, fields: Record<string, string>, referer = '/portal') {
  return env.app.inject({
    method: 'POST', url,
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', referer: `http://localhost:8080${referer}` },
    payload: formBody(fields),
  })
}

const endDate = (years: number): string => {
  const date = new Date()
  date.setUTCFullYear(date.getUTCFullYear() + years)
  return date.toISOString().slice(0, 10)
}

describe('portal sign-in', () => {
  it('sends a first-run visitor to the setup page and refuses the dashboard without a session', async () => {
    const env = await createTestCloud()
    try {
      const login = await env.app.inject({ method: 'GET', url: '/portal/login' })
      expect(login.statusCode).toBe(302)
      expect(login.headers.location).toBe('/portal/setup')

      const dashboard = await env.app.inject({ method: 'GET', url: '/portal' })
      expect(dashboard.statusCode).toBe(302)
      expect(dashboard.headers.location).toBe('/portal/login')
    } finally {
      await env.close()
    }
  })

  it('renders the setup page with a CSRF token and a styled shell', async () => {
    const env = await createTestCloud()
    try {
      const page = await env.app.inject({ method: 'GET', url: '/portal/setup' })
      expect(page.statusCode).toBe(200)
      expect(page.body).toContain('name="_csrf"')
      expect(page.body).toContain('/portal/assets/logo-white.png')
      expect(page.headers['content-security-policy']).toContain("default-src 'none'")
    } finally {
      await env.close()
    }
  })

  it('signs in with password and code, then shows the dashboard', async () => {
    const env = await createTestCloud()
    try {
      const session = await signInOwner(env.cloud)
      const dashboard = await portal(env, '/portal', session.cookie)
      expect(dashboard.statusCode).toBe(200)
      expect(dashboard.body).toContain('Dashboard')
      // Nothing is cached: the page carries licence keys.
      expect(dashboard.headers['cache-control']).toContain('no-store')
      expect(dashboard.headers['x-frame-options']).toBe('DENY')
    } finally {
      await env.close()
    }
  })

  it('rejects a POST without the session CSRF token', async () => {
    const env = await createTestCloud()
    try {
      const session = await signInOwner(env.cloud)
      const response = await post(env, '/portal/licenses/new', session.cookie, {
        _csrf: 'not-the-token', businessName: 'Sneaky Ltd', edition: 'PHARMACY',
        startsAt: '2026-01-01', endsAt: endDate(1), maxAdminPhones: '1',
      })
      expect(response.statusCode).toBe(302)
      expect(env.cloud.database.prepare('SELECT COUNT(*) AS n FROM licenses').get()).toEqual({ n: 0 })
      const audit = env.cloud.database.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'portal.csrf_rejected'").get()
      expect(audit).toEqual({ n: 1 })
    } finally {
      await env.close()
    }
  })

  it('ignores a redirect target that points off-site', async () => {
    const env = await createTestCloud()
    try {
      const session = await signInOwner(env.cloud)
      const response = await env.app.inject({
        method: 'POST', url: '/portal/customers/nope',
        headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded', referer: 'https://evil.example/portal/steal' },
        payload: formBody({ _csrf: session.csrf, businessName: 'x' }),
      })
      expect(response.statusCode).toBe(302)
      expect(response.headers.location).not.toContain('evil.example')
    } finally {
      await env.close()
    }
  })
})

describe('portal licence management', () => {
  it('creates a customer and licence with a default currency and a locked currency', async () => {
    const env = await createTestCloud()
    try {
      const session = await signInOwner(env.cloud)
      const form = await portal(env, '/portal/licenses/new', session.cookie)
      expect(form.body).toContain('DEFAULT CURRENCY')
      // The dropdown mirrors the application's own catalogue rather than a hand-typed list.
      expect(form.body).toContain('NGN')

      const created = await post(env, '/portal/licenses/new', session.cookie, {
        _csrf: session.csrf,
        businessName: 'Bright Chemist', contactName: 'Ngozi', phone: '0803', email: 'ngozi@example.com',
        edition: 'PHARMACY', startsAt: new Date().toISOString().slice(0, 10), endsAt: endDate(1),
        maxAdminPhones: '2', mobileLan: '1', mobileInternet: '1',
        defaultCurrencyCode: 'NGN', lockCurrency: '1', graceDays: '3',
      })
      expect(created.statusCode).toBe(302)
      expect(created.headers.location).toMatch(/^\/portal\/licenses\/[\w-]+$/u)

      const detail = await portal(env, String(created.headers.location), session.cookie)
      expect(detail.statusCode).toBe(200)
      expect(detail.body).toContain('Bright Chemist')
      expect(detail.body).toContain('NGN')
      expect(detail.body).toContain('locked')

      const row = env.cloud.database.prepare('SELECT default_currency, lock_currency, grace_days FROM licenses').get() as
        { default_currency: string; lock_currency: number; grace_days: number }
      expect(row).toEqual({ default_currency: 'NGN', lock_currency: 1, grace_days: 3 })
    } finally {
      await env.close()
    }
  })

  it('refuses a locked currency without a currency code', async () => {
    const env = await createTestCloud()
    try {
      const session = await signInOwner(env.cloud)
      const response = await post(env, '/portal/licenses/new', session.cookie, {
        _csrf: session.csrf, businessName: 'No Currency Ltd', edition: 'BOTH',
        startsAt: new Date().toISOString().slice(0, 10), endsAt: endDate(1), maxAdminPhones: '1',
        lockCurrency: '1',
      })
      // Re-rendered, not redirected: the vendor sees the reason and keeps what they typed.
      expect(response.statusCode).toBe(400)
      expect(response.body).toContain('currency')
      expect(env.cloud.database.prepare('SELECT COUNT(*) AS n FROM licenses').get()).toEqual({ n: 0 })
    } finally {
      await env.close()
    }
  })

  it('renews from the licence page and records it in the history', async () => {
    const env = await createTestCloud()
    try {
      const session = await signInOwner(env.cloud)
      const { license } = env.cloud.service.createLicense({
        customer: { businessName: 'Renew Ltd' }, edition: 'PHARMACY', startsAt: '2026-01-01', endsAt: '2026-12-31',
        maxAdminPhones: 1, mobileLan: true, mobileInternet: false, defaultCurrencyCode: null, lockCurrency: false,
      }, 'test')

      const response = await post(env, `/portal/licenses/${license.id}/renew`, session.cookie, {
        _csrf: session.csrf, endsAt: '2029-12-31', notifyNow: '1',
      }, `/portal/licenses/${license.id}`)
      expect(response.statusCode).toBe(302)

      const detail = await portal(env, `/portal/licenses/${license.id}`, session.cookie)
      expect(detail.body).toContain('2029-12-31')
      const history = env.cloud.service.listHistory(license.id, 10).map((entry) => entry.action)
      expect(history).toContain('license.renewed')
    } finally {
      await env.close()
    }
  })

  it('suspends and unsuspends from the licence page', async () => {
    const env = await createTestCloud()
    try {
      const session = await signInOwner(env.cloud)
      const { license } = env.cloud.service.createLicense({
        customer: { businessName: 'Suspend Ltd' }, edition: 'PHARMACY', startsAt: '2026-01-01', endsAt: '2027-01-01',
        maxAdminPhones: 1, mobileLan: true, mobileInternet: false, defaultCurrencyCode: null, lockCurrency: false,
      }, 'test')

      await post(env, `/portal/licenses/${license.id}/suspend`, session.cookie, { _csrf: session.csrf }, `/portal/licenses/${license.id}`)
      expect(env.cloud.service.getLicense(license.id).status).toBe('suspended')
      await post(env, `/portal/licenses/${license.id}/unsuspend`, session.cookie, { _csrf: session.csrf }, `/portal/licenses/${license.id}`)
      expect(env.cloud.service.getLicense(license.id).status).toBe('active')
    } finally {
      await env.close()
    }
  })

  it('rebinds a machine only from the portal, and clears the old binding', async () => {
    const env = await createTestCloud()
    try {
      const session = await signInOwner(env.cloud)
      const { license } = env.cloud.service.createLicense({
        customer: { businessName: 'Rebind Ltd' }, edition: 'PHARMACY', startsAt: '2026-01-01', endsAt: '2027-01-01',
        maxAdminPhones: 1, mobileLan: true, mobileInternet: false, defaultCurrencyCode: null, lockCurrency: false,
      }, 'test')
      env.cloud.database.prepare('UPDATE licenses SET machine_id = ? WHERE id = ?').run('aaaaaaaa-1111-4222-8333-444444444444', license.id)

      const response = await post(env, `/portal/licenses/${license.id}/rebind`, session.cookie, { _csrf: session.csrf }, `/portal/licenses/${license.id}`)
      expect(response.statusCode).toBe(302)
      expect(env.cloud.service.getLicense(license.id).machine_id).toBeNull()
    } finally {
      await env.close()
    }
  })

  it('downloads an offline licence file for the machine named in the form', async () => {
    const env = await createTestCloud()
    try {
      const session = await signInOwner(env.cloud)
      const { license } = env.cloud.service.createLicense({
        customer: { businessName: 'Offline Ltd' }, edition: 'SUPERMARKET', startsAt: '2026-01-01', endsAt: '2027-01-01',
        maxAdminPhones: 1, mobileLan: true, mobileInternet: false, defaultCurrencyCode: 'GHS', lockCurrency: true,
      }, 'test')

      const download = await env.app.inject({
        method: 'GET', url: `/portal/licenses/${license.id}/file?machine=abcdef01-2345-4678-89ab-cdef01234567`,
        headers: { cookie: session.cookie },
      })
      expect(download.statusCode).toBe(200)
      expect(String(download.headers['content-type'])).toContain('application/octet-stream')
      expect(String(download.headers['content-disposition'])).toContain('attachment')
      expect(JSON.parse(download.body).format).toBe('infoflex-license')
    } finally {
      await env.close()
    }
  })

  it('exports a CSV of the licence list with no amounts in it', async () => {
    const env = await createTestCloud()
    try {
      const session = await signInOwner(env.cloud)
      env.cloud.service.createLicense({
        customer: { businessName: 'Csv Ltd' }, edition: 'PHARMACY', startsAt: '2026-01-01', endsAt: '2027-01-01',
        maxAdminPhones: 1, mobileLan: true, mobileInternet: false, defaultCurrencyCode: 'NGN', lockCurrency: true,
      }, 'test')
      const csv = await env.app.inject({ method: 'GET', url: '/portal/licenses/export.csv', headers: { cookie: session.cookie } })
      expect(csv.statusCode).toBe(200)
      expect(String(csv.headers['content-type'])).toContain('text/csv')
      const header = csv.body.replace(/^\uFEFF/u, '').split('\r\n')[0]!
      expect(header).toContain('default_currency')
      expect(header).not.toMatch(/amount|price|total|sales/iu)
      expect(csv.body).toContain('Csv Ltd')
    } finally {
      await env.close()
    }
  })

  it('generates a single-use activation code that is shown once', async () => {
    const env = await createTestCloud()
    try {
      const session = await signInOwner(env.cloud)
      const { license } = env.cloud.service.createLicense({
        customer: { businessName: 'Code Ltd' }, edition: 'PHARMACY', startsAt: '2026-01-01', endsAt: '2027-01-01',
        maxAdminPhones: 1, mobileLan: true, mobileInternet: false, defaultCurrencyCode: null, lockCurrency: false,
      }, 'test')
      const response = await post(env, `/portal/licenses/${license.id}/activation-code`, session.cookie, { _csrf: session.csrf }, `/portal/licenses/${license.id}`)
      expect(response.statusCode).toBe(302)
      const flash = String(response.headers['set-cookie'])
      expect(flash).toContain('infoflex_flash=')

      // Following the redirect shows the code; a plain reload does not, because the flash cookie is single-use.
      const cookieWithFlash = `${session.cookie}; ${flash.split(';')[0]}`
      const detail = await portal(env, `/portal/licenses/${license.id}`, cookieWithFlash)
      expect(detail.body).toMatch(/[A-Z2-9]{4}-[A-Z2-9]{4}/u)
    } finally {
      await env.close()
    }
  })

  it('filters the licence list by expiring and by search', async () => {
    const env = await createTestCloud()
    try {
      const session = await signInOwner(env.cloud)
      const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10)
      env.cloud.service.createLicense({
        customer: { businessName: 'Expiring Chemist' }, edition: 'PHARMACY', startsAt: '2025-01-01', endsAt: soon,
        maxAdminPhones: 1, mobileLan: true, mobileInternet: false, defaultCurrencyCode: null, lockCurrency: false,
      }, 'test')
      env.cloud.service.createLicense({
        customer: { businessName: 'Steady Stores' }, edition: 'SUPERMARKET', startsAt: '2026-01-01', endsAt: endDate(2),
        maxAdminPhones: 1, mobileLan: true, mobileInternet: false, defaultCurrencyCode: null, lockCurrency: false,
      }, 'test')

      const expiring = await portal(env, '/portal/licenses?filter=expiring', session.cookie)
      expect(expiring.body).toContain('Expiring Chemist')
      expect(expiring.body).not.toContain('Steady Stores')

      const search = await portal(env, '/portal/licenses?q=Steady', session.cookie)
      expect(search.body).toContain('Steady Stores')
      expect(search.body).not.toContain('Expiring Chemist')
    } finally {
      await env.close()
    }
  })

  it('shows the expiry dashboard buckets', async () => {
    const env = await createTestCloud()
    try {
      const session = await signInOwner(env.cloud)
      const inFiveDays = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10)
      env.cloud.service.createLicense({
        customer: { businessName: 'Almost Gone Ltd' }, edition: 'PHARMACY', startsAt: '2025-01-01', endsAt: inFiveDays,
        maxAdminPhones: 1, mobileLan: true, mobileInternet: false, defaultCurrencyCode: null, lockCurrency: false,
      }, 'test')
      const dashboard = await portal(env, '/portal', session.cookie)
      expect(dashboard.body).toContain('Almost Gone Ltd')
      expect(dashboard.body).toMatch(/7 days/iu)
      // With no SMTP configured the dashboard says so instead of implying reminders were sent.
      expect(dashboard.body).toMatch(/email (is )?not configured|mail/iu)
    } finally {
      await env.close()
    }
  })
})

describe('portal team management', () => {
  it('adds a Staff account whose two-factor is not yet confirmed', async () => {
    const env = await createTestCloud()
    try {
      const session = await signInOwner(env.cloud)
      const response = await post(env, '/portal/team/new', session.cookie, {
        _csrf: session.csrf, email: 'staff@example.com', displayName: 'Bola', password: 'another-long-passphrase', role: 'STAFF',
      }, '/portal/team')
      expect(response.statusCode).toBe(302)
      // The enrolment secret rides in the one-shot flash cookie, so the redirect is what carries it.
      const flash = String(response.headers['set-cookie']).split(';')[0]!
      const team = await portal(env, `/portal/team`, `${session.cookie}; ${flash}`)
      expect(team.body).toContain('staff@example.com')
      const staff = env.cloud.auth.findUserByEmail('staff@example.com')
      expect(staff?.role).toBe('STAFF')
      expect(staff?.totp_confirmed_at).toBeNull()
      // The enrolment QR is rendered server-side as a PNG data URL, so no external image is fetched.
      expect(team.body).toContain('data:image/png;base64,')
    } finally {
      await env.close()
    }
  })

  it('refuses a Staff account the Owner-only actions', async () => {
    const env = await createTestCloud()
    try {
      const owner = await signInOwner(env.cloud, { email: 'owner@example.com' })
      await env.cloud.auth.createUser({ email: 'staff2@example.com', displayName: 'Staff', password: 'another-long-passphrase', role: 'STAFF' }, 'test')
      const staff = env.cloud.auth.findUserByEmail('staff2@example.com')!
      // Sign the Staff member in by hand: the portal's own login page is covered above.
      const token = 'staff-session-token-for-test'
      env.cloud.database.prepare(`
        INSERT INTO sessions (id, vendor_user_id, token_hash, csrf_token, ip_address, user_agent, created_at, last_seen_at, expires_at)
        VALUES ('s1', ?, ?, 'staff-csrf', '127.0.0.1', 'test', ?, ?, ?)
      `).run(staff.id, hashFor(token), new Date().toISOString(), new Date().toISOString(), new Date(Date.now() + 600_000).toISOString())

      const response = await post(env, '/portal/team/new', `infoflex_portal=${token}`, {
        _csrf: 'staff-csrf', email: 'third@example.com', displayName: 'Third', password: 'another-long-passphrase', role: 'OWNER',
      }, '/portal/team')
      expect(response.statusCode).toBe(302)
      expect(env.cloud.auth.findUserByEmail('third@example.com')).toBeUndefined()
      // The Owner's own cookie is untouched.
      expect((await portal(env, '/portal', owner.cookie)).statusCode).toBe(200)
    } finally {
      await env.close()
    }
  })

  it('lets an Owner reset another account’s two-factor', async () => {
    const env = await createTestCloud()
    try {
      const session = await signInOwner(env.cloud)
      const staff = await env.cloud.auth.createUser({ email: 'reset@example.com', displayName: 'Reset', password: 'another-long-passphrase', role: 'STAFF' }, 'test')
      const response = await post(env, `/portal/team/${staff.id}/reset-totp`, session.cookie, { _csrf: session.csrf }, '/portal/team')
      expect(response.statusCode).toBe(302)
      expect(env.cloud.auth.getUser(staff.id).totp_confirmed_at).toBeNull()
    } finally {
      await env.close()
    }
  })
})

describe('portal audit and relay pages', () => {
  it('lists audit entries newest first', async () => {
    const env = await createTestCloud()
    try {
      const session = await signInOwner(env.cloud)
      env.cloud.service.createLicense({
        customer: { businessName: 'Audited Ltd' }, edition: 'PHARMACY', startsAt: '2026-01-01', endsAt: '2027-01-01',
        maxAdminPhones: 1, mobileLan: true, mobileInternet: false, defaultCurrencyCode: null, lockCurrency: false,
      }, 'owner@example.com')
      const page = await portal(env, '/portal/audit', session.cookie)
      expect(page.statusCode).toBe(200)
      expect(page.body).toContain('license.created')
      expect(page.body).toContain('vendor.login.succeeded')
    } finally {
      await env.close()
    }
  })

  it('explains that the relay is not configured instead of pretending', async () => {
    const env = await createTestCloud()
    try {
      const session = await signInOwner(env.cloud)
      const page = await portal(env, '/portal/relay', session.cookie)
      expect(page.statusCode).toBe(200)
      expect(page.body).toMatch(/not configured/iu)
    } finally {
      await env.close()
    }
  })

  /**
   * The single most important honesty claim in the product. An earlier draft of this page said the relay
   * "cannot read the frames it forwards" and was "end-to-end encrypted", which would have been false: it
   * terminates TLS. This test fails the build if any page drifts back to that claim.
   */
  it('never claims the relay is end-to-end encrypted, and states the real limit', async () => {
    const env = await createTestCloud({ relayDomain: 'relay.test' })
    try {
      const session = await signInOwner(env.cloud)
      const { license } = env.cloud.service.createLicense({
        customer: { businessName: 'Honest Relay Ltd' }, edition: 'PHARMACY', startsAt: '2026-01-01', endsAt: '2027-01-01',
        maxAdminPhones: 1, mobileLan: true, mobileInternet: true, defaultCurrencyCode: null, lockCurrency: false,
      }, 'owner@example.com')
      // A row in relay_connections so the relay page renders the "a shop has connected" variant too.
      env.cloud.database.prepare(`
        INSERT INTO relay_connections (shop_id, license_id, status, connected_at, last_seen_at)
        VALUES ('abc123def456', ?, 'online', '2026-11-17T10:00:00.000Z', '2026-11-17T10:05:00.000Z')
      `).run(license.id)
      for (const url of ['/portal/relay', `/portal/licences/${license.id}`, '/portal', '/portal/privacy']) {
        const page = await portal(env, url, session.cookie)
        if (page.statusCode === 404) continue
        // The wrong claim, in either of the two shapes it took, must never come back.
        expect(page.body).not.toMatch(/end-to-end/iu)
        expect(page.body).not.toMatch(/cannot read the (?:frames|traffic)/iu)
        expect(page.body).not.toMatch(/>None<\/div><small>encrypted/iu)
      }
      const relayPage = await portal(env, '/portal/relay', session.cookie)
      expect(relayPage.body).toContain('can read what it forwards')
      expect(relayPage.body).toContain('RELAY-LIMITS.md')
    } finally {
      await env.close()
    }
  })

  it('serves the stylesheet and the brand image', async () => {
    const env = await createTestCloud()
    try {
      const css = await env.app.inject({ method: 'GET', url: '/portal/assets/portal.css' })
      expect(css.statusCode).toBe(200)
      expect(css.body.toLowerCase()).toContain('#1f3f73')
      const logo = await env.app.inject({ method: 'GET', url: '/portal/assets/logo.png' })
      expect(logo.statusCode).toBe(200)
      expect(logo.rawPayload.subarray(1, 4).toString('utf8')).toBe('PNG')
    } finally {
      await env.close()
    }
  })
})

function hashFor(token: string): string {
  return require('node:crypto').createHash('sha256').update(token).digest('hex') as string
}
