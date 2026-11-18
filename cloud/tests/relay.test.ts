import { afterEach, describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import { WebSocket } from 'ws'
import { createTestCloud, type TestCloud } from './helpers'
import { FRAME, decodeFrame, encodeFrame, filterRequestHeaders, filterResponseHeaders, TokenBucket } from '../src/relay/protocol'
import { shopSlugFor } from '../src/relay/verify'
import { deriveGrantKey } from '../../src/shared/relay/protocol'

/**
 * The relay is tested with a real WebSocket, a real listening port and a stand-in for the shop's PC. That is the
 * only way to prove the path a phone actually takes: the relay's HTTP side, the frames, and the host's answer
 * travelling back. The shop PC is faked here because the host client belongs to the desktop build; what is
 * proven is the relay's half of the contract — which is where the security decisions live.
 */
const RELAY_DOMAIN = 'relay.test'
const GRANT_SECRET = 'a'.repeat(64)
const MACHINE = 'abc12345-6789-4abc-8def-0123456789ab'

const open: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of open.splice(0)) await close()
})

interface Harness {
  env: TestCloud
  licenseId: string
  token: string
  shopId: string
  baseUrl: string
  port: number
  host: WebSocket
  stop: () => Promise<void>
}

/** A shop PC: answers every request frame with a small JSON body naming the path it received. */
async function connectHost(url: string, hello: Record<string, string>): Promise<{ socket: WebSocket; seen: string[] }> {
  const socket = new WebSocket(url)
  const seen: string[] = []
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
  socket.send(encodeFrame(FRAME.hello, 0, Buffer.from(JSON.stringify(hello), 'utf8')))
  socket.on('message', (data: Buffer) => {
    const frame = decodeFrame(Buffer.from(data))
    if (!frame) return
    if (frame.type === FRAME.requestHeaders) {
      const headers = JSON.parse(frame.payload.toString('utf8')) as { method: string; path: string }
      seen.push(`${headers.method} ${headers.path}`)
      socket.send(encodeFrame(FRAME.responseHeaders, frame.streamId, Buffer.from(JSON.stringify({
        status: 200, headers: { 'content-type': 'application/json' },
      }), 'utf8')))
      socket.send(encodeFrame(FRAME.responseBody, frame.streamId, Buffer.from(JSON.stringify({ path: headers.path }), 'utf8')))
      socket.send(encodeFrame(FRAME.responseEnd, frame.streamId, Buffer.alloc(0)))
    }
  })
  return { socket, seen }
}

async function startRelay(options: { mobileInternet?: boolean; active?: boolean } = {}): Promise<Harness> {
  const env = await createTestCloud({ relayDomain: RELAY_DOMAIN, config: { relaySharedSecret: GRANT_SECRET } })
  const { license } = env.cloud.service.createLicense({
    customer: { businessName: 'Relay Pharmacy' }, edition: 'PHARMACY', startsAt: '2026-01-01', endsAt: '2099-01-01',
    maxAdminPhones: 2, mobileLan: true, mobileInternet: options.mobileInternet ?? true,
    defaultCurrencyCode: 'NGN', lockCurrency: true,
  }, 'owner@example.com')
  if (options.active === false) env.cloud.service.setStatus(license.id, 'suspended', 'owner@example.com')

  const address = await env.app.listen({ port: 0, host: '127.0.0.1' })
  const port = Number(new URL(address).port)
  const activation = await env.app.inject({
    method: 'POST', url: '/api/license/activate',
    payload: { activationKey: license.license_key, machineId: MACHINE, appVersion: '1.0.0', platform: 'win32' },
  })
  const token = activation.json().token as string
  const shopId = shopSlugFor(license.id)
  const { socket } = await connectHost(`ws://127.0.0.1:${port}/relay/tunnel`, {
    shopId, token, machineId: MACHINE, appVersion: '1.0.0',
  })
  const stop = async () => {
    socket.close()
    await env.close()
  }
  open.push(stop)
  return { env, licenseId: license.id, token, shopId, baseUrl: address, port, host: socket, stop }
}

/**
 * The grant is what the till puts in the QR code. The test mints it exactly as a shop PC would, with the *derived*
 * per-shop key the relay hands out in its `welcome` frame — not with the vendor's master secret, which no shop
 * ever holds.
 */
function makeGrant(shopId: string, options: { expiresInSeconds?: number } = {}): string {
  const expires = Math.floor(Date.now() / 1000) + (options.expiresInSeconds ?? 300)
  const payload = Buffer.from(JSON.stringify({ shopId, machineId: MACHINE }), 'utf8').toString('base64url')
  const signature = createHmac('sha256', deriveGrantKey(GRANT_SECRET, shopId)).update(`v1.${payload}.${expires}`).digest('base64url')
  return `v1.${payload}.${expires}.${signature}`
}

function phoneRequest(harness: Harness, path: string, grant: string | null = makeGrant(harness.shopId)) {
  return harness.env.app.inject({
    method: 'GET',
    url: grant ? `${path}${path.includes('?') ? '&' : '?'}g=${grant}` : path,
    headers: { host: `${harness.shopId}.${RELAY_DOMAIN}` },
  })
}

describe('relay tunnel', () => {
  it('carries a phone request to the shop PC and returns its answer', async () => {
    const harness = await startRelay()
    try {
      const response = await phoneRequest(harness, '/api/mobile/sales/today')
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ path: '/api/mobile/sales/today' })
      // The grant is stripped before the shop sees the path, and the host is told which machine it is talking to.
      const connection = harness.env.cloud.database.prepare('SELECT status, license_id FROM relay_connections WHERE shop_id = ?')
        .get(harness.shopId) as { status: string; license_id: string }
      expect(connection).toEqual({ status: 'online', license_id: harness.licenseId })
    } finally {
      await harness.stop()
    }
  })

  it('refuses a phone that has no valid link', async () => {
    const harness = await startRelay()
    try {
      expect((await phoneRequest(harness, '/api/mobile/sales/today', null)).statusCode).toBe(401)
      expect((await phoneRequest(harness, '/api/mobile/sales/today', 'v1.forged.1.signature')).statusCode).toBe(401)
      const expired = makeGrant(harness.shopId, { expiresInSeconds: -30 })
      expect((await phoneRequest(harness, '/api/mobile/sales/today', expired)).statusCode).toBe(401)
    } finally {
      await harness.stop()
    }
  })

  it('refuses a link minted for another shop', async () => {
    const harness = await startRelay()
    try {
      const otherShop = makeGrant('someoneelse1234')
      expect((await phoneRequest(harness, '/api/mobile/sales/today', otherShop)).statusCode).toBe(401)
    } finally {
      await harness.stop()
    }
  })

  it('refuses a tunnel when the licence has internet access switched off', async () => {
    const env = await createTestCloud({ relayDomain: RELAY_DOMAIN, config: { relaySharedSecret: GRANT_SECRET } })
    try {
      const { license } = env.cloud.service.createLicense({
        customer: { businessName: 'No Internet Ltd' }, edition: 'PHARMACY', startsAt: '2026-01-01', endsAt: '2099-01-01',
        maxAdminPhones: 1, mobileLan: true, mobileInternet: false, defaultCurrencyCode: null, lockCurrency: false,
      }, 'owner@example.com')
      const address = await env.app.listen({ port: 0, host: '127.0.0.1' })
      const port = Number(new URL(address).port)
      const activation = await env.app.inject({
        method: 'POST', url: '/api/license/activate',
        payload: { activationKey: license.license_key, machineId: MACHINE, appVersion: '1.0.0', platform: 'win32' },
      })
      const socket = new WebSocket(`ws://127.0.0.1:${port}/relay/tunnel`)
      await new Promise<void>((resolve) => socket.once('open', () => resolve()))
      const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)))
      socket.send(encodeFrame(FRAME.hello, 0, Buffer.from(JSON.stringify({
        shopId: shopSlugFor(license.id), token: activation.json().token, machineId: MACHINE, appVersion: '1.0.0',
      }), 'utf8')))
      expect(await closed).toBe(4403)
    } finally {
      await env.close()
    }
  })

  it('refuses a tunnel for a suspended licence', async () => {
    const env = await createTestCloud({ relayDomain: RELAY_DOMAIN, config: { relaySharedSecret: GRANT_SECRET } })
    try {
      const { license } = env.cloud.service.createLicense({
        customer: { businessName: 'Suspended Ltd' }, edition: 'PHARMACY', startsAt: '2026-01-01', endsAt: '2099-01-01',
        maxAdminPhones: 1, mobileLan: true, mobileInternet: true, defaultCurrencyCode: null, lockCurrency: false,
      }, 'owner@example.com')
      const address = await env.app.listen({ port: 0, host: '127.0.0.1' })
      const port = Number(new URL(address).port)
      const activation = await env.app.inject({
        method: 'POST', url: '/api/license/activate',
        payload: { activationKey: license.license_key, machineId: MACHINE, appVersion: '1.0.0', platform: 'win32' },
      })
      env.cloud.service.setStatus(license.id, 'suspended', 'owner@example.com')
      const socket = new WebSocket(`ws://127.0.0.1:${port}/relay/tunnel`)
      await new Promise<void>((resolve) => socket.once('open', () => resolve()))
      const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)))
      socket.send(encodeFrame(FRAME.hello, 0, Buffer.from(JSON.stringify({
        shopId: shopSlugFor(license.id), token: activation.json().token, machineId: MACHINE, appVersion: '1.0.0',
      }), 'utf8')))
      expect(await closed).toBe(4403)
    } finally {
      await env.close()
    }
  })

  it('says the shop is offline rather than hanging when no PC is connected', async () => {
    const env = await createTestCloud({ relayDomain: RELAY_DOMAIN, config: { relaySharedSecret: GRANT_SECRET } })
    try {
      // No host has connected, so the request waits briefly and then explains itself.
      const response = await env.app.inject({
        method: 'GET',
        url: `/api/mobile/sales/today?g=${makeGrant('abcdef123456')}`,
        headers: { host: `abcdef123456.${RELAY_DOMAIN}` },
      })
      expect(response.statusCode).toBe(503)
      expect(response.body).toMatch(/offline/iu)
    } finally {
      await env.close()
    }
  })

  it('shows a landing page for a hostname that is not a shop', async () => {
    const harness = await startRelay()
    try {
      const response = await harness.env.app.inject({
        method: 'GET', url: '/', headers: { host: `www.${RELAY_DOMAIN}` },
      })
      expect(response.statusCode).toBe(404)
      expect(response.body).toMatch(/Remote access/iu)
    } finally {
      await harness.stop()
    }
  })

  it('marks the shop offline when the PC disconnects', async () => {
    const harness = await startRelay()
    try {
      await phoneRequest(harness, '/api/mobile/ping')
      harness.host.close()
      const deadline = Date.now() + 3_000
      let status = 'online'
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        const row = harness.env.cloud.database.prepare('SELECT status FROM relay_connections WHERE shop_id = ?').get(harness.shopId) as { status: string }
        status = row.status
        if (status === 'offline') break
      }
      expect(status).toBe('offline')
    } finally {
      await harness.stop()
    }
  })
})

describe('relay protocol', () => {
  it('round-trips a frame through its five-byte header', () => {
    const frame = encodeFrame(FRAME.requestBody, 4242, Buffer.from('hello'))
    const decoded = decodeFrame(frame)!
    expect(decoded.type).toBe(FRAME.requestBody)
    expect(decoded.streamId).toBe(4242)
    expect(decoded.payload.toString('utf8')).toBe('hello')
    expect(decodeFrame(Buffer.alloc(3))).toBeNull()
  })

  it('forwards only the headers the shop PC can safely use', () => {
    const forwarded = filterRequestHeaders({
      accept: 'application/json',
      cookie: 'infoflex=abc',
      host: 'evil.example',
      'content-length': '999',
      'transfer-encoding': 'chunked',
      'x-forwarded-for': '1.2.3.4',
    })
    expect(forwarded).toEqual({ accept: 'application/json', cookie: 'infoflex=abc' })
  })

  it('returns only the headers a phone needs', () => {
    const returned = filterResponseHeaders({ 'content-type': 'application/json', 'set-cookie': 'steal=1', 'x-secret': 'nope' })
    expect(returned).toEqual({ 'content-type': 'application/json' })
  })

  it('refills a token bucket over time and stops at the cap', () => {
    const bucket = new TokenBucket(10, 0)
    expect(bucket.take(10, 0)).toBe(true)
    expect(bucket.take(1, 0)).toBe(false)
    expect(bucket.take(5, 30_000)).toBe(true)
    expect(bucket.take(100, 30_000)).toBe(false)
  })
})
