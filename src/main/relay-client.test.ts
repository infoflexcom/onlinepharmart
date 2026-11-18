import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generate as generateCertificate } from 'selfsigned'
import { describe, expect, it, vi } from 'vitest'
import { createTestCloud } from '../../cloud/tests/helpers'
import { shopSlugFor } from '../../cloud/src/relay/verify'
import { RelayClient } from './relay-client'
import { createHostApi } from '../api/server'
import { getCurrency } from '../currency/catalog'
import { defaultDisplayOptions } from '../currency/money'
import { DEFAULT_OPERATIONAL_SETTINGS, type ShopSettings } from '../shared/shop/types'
import type { LicenseSummary } from '../shared/license/types'

/**
 * The full internet path, end to end: a real cloud relay, the real desktop `RelayClient`, and the real host
 * listener that answers a phone.
 *
 * The cloud half is the vendor's server from `cloud/tests`; the desktop half is this repository's own client and
 * this repository's own mobile API. Nothing is faked except the phone, which is an HTTP request — and that is the
 * point: what is proved is that a request arriving "from the internet" is answered by the shop's own listener,
 * with the shop's own rules, and that a shop PC cannot be talked into calling anything else.
 */
const RELAY_DOMAIN = 'relay.test'
const GRANT_SECRET = 'b'.repeat(64)
const MACHINE = 'abc12345-6789-4abc-8def-0123456789ab'

const currency = getCurrency('NGN')!
const settings: ShopSettings = {
  profile: { name: 'Harbor Health', address: '', phone: '' },
  currency,
  display: defaultDisplayOptions(currency),
  setupComplete: true,
  currencyConfirmed: true,
  currencyLocked: false,
  operational: { ...DEFAULT_OPERATIONAL_SETTINGS },
}

function licenseSummary(overrides: Partial<LicenseSummary> = {}): LicenseSummary {
  return {
    status: 'active', canUse: true, licenseId: 'relay-e2e', source: 'online', edition: 'BOTH',
    startsAt: null, endsAt: null, defaultCurrencyCode: null, lockCurrency: false,
    features: { mobileLan: true, mobileInternet: true }, adminPhoneLimit: 2, graceDays: 0,
    lastOnlineCheck: null, reportedToPortal: true, vendorConfigured: false,
    maximumOnsitePeriodYears: null, licenseServerUrl: null, message: 'active',
    ...overrides,
  }
}

/** Boots the vendor cloud with one internet-enabled licence and returns everything the desktop needs. */
async function bootCloud(customerName: string) {
  const env = await createTestCloud({ relayDomain: RELAY_DOMAIN, config: { relaySharedSecret: GRANT_SECRET } })
  const { license } = env.cloud.service.createLicense({
    customer: { businessName: customerName }, edition: 'PHARMACY', startsAt: '2026-01-01', endsAt: '2099-01-01',
    maxAdminPhones: 2, mobileLan: true, mobileInternet: true, defaultCurrencyCode: 'NGN', lockCurrency: true,
  }, 'owner@example.com')
  await env.app.listen({ port: 0, host: '127.0.0.1' })
  const port = (env.app.server.address() as { port: number }).port
  const activation = await env.app.inject({
    method: 'POST', url: '/api/license/activate',
    payload: { activationKey: license.license_key, machineId: MACHINE, appVersion: '1.0.0', platform: 'win32' },
  })
  return { env, license, port, token: activation.json().token as string, shopId: shopSlugFor(license.id) }
}

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
}

describe('relay end to end: vendor relay → desktop client → shop listener', () => {
  it('carries an Admin request from the relay to the shop listener, and refuses a cashier there', async () => {
    const cloud = await bootCloud('Relay Pharmacy')
    const directory = mkdtempSync(join(tmpdir(), 'infoflex-relay-e2e-'))
    writeFileSync(join(directory, 'index.html'), '<!doctype html><title>Admin</title>')
    const recordDeniedAccess = vi.fn()
    // A real certificate for 127.0.0.1, so the shop PC's HTTPS hop is verified rather than skipped.
    const certificate = await generateCertificate([{ name: 'commonName', value: '127.0.0.1' }], {
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }],
    })
    const listener = await createHostApi({
      service: { getSettings: () => settings, recordDeniedAccess },
      license: { getSnapshot: () => licenseSummary() },
      authenticate: async (request) => {
        const header = request.headers.authorization
        if (header === 'Bearer admin-token') return { userId: 'admin-1', username: 'admin', role: 'ADMIN' as const }
        if (header === 'Bearer cashier-token') return { userId: 'cashier-1', username: 'cashier', role: 'CASHIER' as const }
        return null
      },
      mobileClientDirectory: directory,
      localNetworkOnly: true,
      allowRelayArrival: true,
      tls: { key: certificate.private, cert: certificate.cert, minVersion: 'TLSv1.2' },
    })
    await listener.listen({ port: 0, host: '127.0.0.1' })
    const listenerPort = (listener.server.address() as { port: number }).port

    const client = new RelayClient({
      relayUrl: `ws://127.0.0.1:${cloud.port}`,
      shopId: cloud.shopId,
      licenseToken: () => cloud.token,
      machineId: MACHINE,
      appVersion: '1.0.0',
      localTarget: () => ({ host: '127.0.0.1', port: listenerPort, secure: true, ca: certificate.cert }),
      reconnectMs: 50,
    })
    client.start()
    try {
      await until(() => client.publicUrl !== null)
      expect(client.publicUrl).toBe(`https://${cloud.shopId}.${RELAY_DOMAIN}`)
      expect(client.currentStatus.state).toBe('connected')

      // The link is minted by the shop's own client, exactly as the till's QR code is.
      const link = client.createLink()!
      expect(link.url).toContain(`https://${cloud.shopId}.${RELAY_DOMAIN}/?g=v1.`)
      const grant = new URL(link.url).searchParams.get('g')!

      const phone = (authorization?: string) => cloud.env.app.inject({
        method: 'GET',
        url: `/api/v1/admin/settings?g=${encodeURIComponent(grant)}`,
        headers: { host: `${cloud.shopId}.${RELAY_DOMAIN}`, ...(authorization ? { authorization } : {}) },
      })

      const admin = await phone('Bearer admin-token')
      expect(admin.statusCode).toBe(200)
      expect(admin.json().profile.name).toBe('Harbor Health')

      // A relayed request counts as the internet at the shop: no Admin credential, no data.
      const anonymous = await phone()
      expect(anonymous.statusCode).toBe(401)
      expect(anonymous.json()).toEqual({ message: 'This account cannot use the mobile app' })

      // A cashier is refused over the relay exactly as on the LAN: there is no cashier mode to reach.
      const cashier = await phone('Bearer cashier-token')
      expect(cashier.statusCode).toBe(403)
      expect(cashier.json()).toEqual({ message: 'This account cannot use the mobile app' })
      expect(recordDeniedAccess).toHaveBeenCalledWith(expect.objectContaining({ reason: 'non_admin' }))
    } finally {
      client.stop()
      await listener.close()
      await cloud.env.close()
    }
  }, 30_000)

  it('never calls an address a frame names: with no local listener it refuses instead of going elsewhere', async () => {
    const cloud = await bootCloud('Fixed Target Ltd')
    const target = vi.fn(() => null)
    const client = new RelayClient({
      relayUrl: `ws://127.0.0.1:${cloud.port}`,
      shopId: cloud.shopId,
      licenseToken: () => cloud.token,
      machineId: MACHINE,
      appVersion: '1.0.0',
      localTarget: target,
      reconnectMs: 50,
    })
    client.start()
    try {
      await until(() => client.publicUrl !== null)
      const grant = new URL(client.createLink()!.url).searchParams.get('g')!
      const response = await cloud.env.app.inject({
        method: 'GET',
        url: `/api/v1/admin/settings?g=${encodeURIComponent(grant)}`,
        headers: { host: `${cloud.shopId}.${RELAY_DOMAIN}` },
      })
      // The client answers with its own refusal rather than fetching anything at all.
      expect(response.statusCode).toBe(504)
      expect(target).toHaveBeenCalled()
    } finally {
      client.stop()
      await cloud.env.close()
    }
  }, 30_000)

  it('drops the tunnel when the vendor suspends the licence, and does not reconnect in a loop', async () => {
    const cloud = await bootCloud('Suspended Relay Ltd')
    const client = new RelayClient({
      relayUrl: `ws://127.0.0.1:${cloud.port}`,
      shopId: cloud.shopId,
      licenseToken: () => cloud.token,
      machineId: MACHINE,
      appVersion: '1.0.0',
      localTarget: () => null,
      reconnectMs: 50,
    })
    client.start()
    try {
      await until(() => client.publicUrl !== null)
      expect(client.currentStatus.state).toBe('connected')

      cloud.env.cloud.service.setStatus(cloud.license.id, 'suspended', 'owner@example.com')
      cloud.env.cloud.relay!.disconnectShop(cloud.license.id)
      await until(() => client.currentStatus.state !== 'connected')

      // 4403 is final: the client does not hammer a suspended licence.
      expect(client.currentStatus.state).toBe('refused')
    } finally {
      client.stop()
      await cloud.env.close()
    }
  }, 30_000)
})
