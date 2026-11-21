import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { WebSocket } from 'ws'
import type Database from 'better-sqlite3'
import type { LicenseService } from '../license-service'
import {
  FRAME, FRAME_HEADER_BYTES, LIMITS, TokenBucket, decodeFrame, encodeFrame, filterRequestHeaders, filterResponseHeaders,
  type StreamHeaders,
} from './protocol'
import { RelayVerifier, shopSlugFor } from './verify'

/**
 * The internet relay: the shop's PC holds one outbound WebSocket, and phones reach the shop through it.
 *
 * Routing is by hostname. `GET /…` on `<shop-id>.<relay-domain>` is a phone's request; `GET /relay/tunnel` is the
 * host's socket. Both paths are on one port so a single HTTPS certificate with a wildcard covers the whole relay,
 * which is what makes `https://acme3f1c9a.<relay-domain>` show a real padlock on a phone with no per-shop
 * certificate and no per-shop DNS record.
 *
 * Only the tunnel is trusted: a phone's request never reaches the shop PC without a grant signed by that shop's
 * host, and the host itself still enforces the Admin-only rule, device approval and TOTP. The relay is a pipe,
 * not an authentication shortcut.
 */
export interface RelayOptions {
  service: LicenseService
  database: Database.Database
  verifier: RelayVerifier
  relayDomain: string
  /** Set when the process runs behind a proxy that terminates TLS. */
  trustProxy: boolean
  now?: () => number
  log?: (message: string) => void
}

interface PendingStream {
  resolve: (value: StreamResult) => void
  reject: (error: Error) => void
  status: number | null
  headers: Record<string, string>
  chunks: Buffer[]
  bytes: number
  timer: NodeJS.Timeout
}

interface StreamResult {
  status: number
  headers: Record<string, string>
  body: Buffer
}

interface HostTunnel {
  socket: WebSocket
  shopId: string
  licenseId: string
  machineId: string
  displayName: string
  streams: Map<number, PendingStream>
  bucket: TokenBucket
  bytesBucket: TokenBucket
  lastSeen: number
  peer: string | null
  closed: boolean
}

interface ShopState {
  tunnel: HostTunnel | null
  waiting: Array<{ headers: StreamHeaders; body: Buffer; reply: FastifyReply }>
}

const MAX_WAITING_PER_SHOP = 8
/** How long a link the till shows stays usable. Long enough to scan, short enough to be useless if leaked. */
export const GRANT_LIFETIME_SECONDS = 10 * 60

export class RelayHub {
  private readonly shops = new Map<string, ShopState>()
  private readonly socketsByAddress = new Map<string, number>()
  private readonly now: () => number
  private readonly log: (message: string) => void
  /** Set while shutting down, so a closing socket does not write to a database that is about to close. */
  private stopping = false

  constructor(private readonly options: RelayOptions) {
    this.now = options.now ?? Date.now
    this.log = options.log ?? ((message: string) => process.stdout.write(`${message}\n`))
  }

  // ------------------------------------------------------------------ startup

  register(app: FastifyInstance): void {
    app.get('/relay/tunnel', { websocket: true }, (socket, request) => {
      void this.acceptHost(socket, request)
    })

    // The catch-all is last so /relay/tunnel and /api/license/* win the routing race.
    app.all('/*', async (request, reply) => this.handlePhoneRequest(request, reply))
  }

  // ------------------------------------------------------------------ host side

  private async acceptHost(socket: WebSocket, request: FastifyRequest): Promise<void> {
    const peer = this.peerAddress(request)
    if (!this.trackSocket(peer, 1)) {
      socket.close(4429, 'Too many connections from this address.')
      return
    }
    let tunnel: HostTunnel | null = null
    const release = () => this.trackSocket(peer, -1)

    socket.on('message', (data: Buffer) => {
      try {
        const frame = decodeFrame(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer))
        if (!frame) return
        if (!tunnel) {
          if (frame.type !== FRAME.hello) {
            socket.close(4400, 'Say hello first.')
            return
          }
          tunnel = this.openTunnel(socket, frame.payload, peer)
          return
        }
        this.handleHostFrame(tunnel, frame.type, frame.streamId, frame.payload)
      } catch {
        // A malformed frame closes the tunnel rather than leaving it half-open.
        socket.close(4400, 'Malformed frame.')
      }
    })

    socket.on('close', () => {
      release()
      if (tunnel) this.closeTunnel(tunnel)
    })
    socket.on('error', () => {
      if (tunnel) this.closeTunnel(tunnel)
    })
  }

  private openTunnel(socket: WebSocket, payload: Buffer, peer: string | null): HostTunnel | null {
    let hello: { shopId?: string; token?: string; machineId?: string; appVersion?: string }
    try {
      hello = JSON.parse(payload.toString('utf8')) as typeof hello
    } catch {
      socket.close(4400, 'Hello was not JSON.')
      return null
    }
    const decision = this.options.verifier.authorise({
      shopId: String(hello.shopId ?? ''),
      token: String(hello.token ?? ''),
      machineId: String(hello.machineId ?? ''),
      appVersion: String(hello.appVersion ?? ''),
    })
    if (!decision.ok) {
      socket.send(encodeFrame(FRAME.error, 0, Buffer.from(decision.reason, 'utf8')))
      // 4403: the licence is not entitled to relay right now. The host shows this reason in its own log.
      socket.close(4403, decision.reason.slice(0, 120))
      return null
    }
    const current = this.shopState(decision.value.shopId)
    if (current.tunnel) {
      // One tunnel per shop: a second PC on the same licence would split the phone's requests unpredictably.
      current.tunnel.socket.close(4409, 'Another computer signed in with this licence.')
      this.closeTunnel(current.tunnel)
    }
    const tunnel: HostTunnel = {
      socket,
      shopId: decision.value.shopId,
      licenseId: decision.value.licenseId,
      machineId: decision.value.machineId,
      displayName: decision.value.displayName,
      streams: new Map(),
      bucket: new TokenBucket(LIMITS.requestsPerMinutePerShop, this.now()),
      bytesBucket: new TokenBucket(LIMITS.maxBytesPerMinutePerShop, this.now()),
      lastSeen: this.now(),
      peer,
      closed: false,
    }
    current.tunnel = tunnel
    /**
     * The per-shop link key. A shop PC never receives the vendor's relay secret: it receives a key derived for
     * its own address, which mints links for this shop and no other.
     */
    socket.send(encodeFrame(FRAME.welcome, 0, Buffer.from(JSON.stringify({
      shopId: tunnel.shopId,
      grantKey: this.options.verifier.grantKeyFor(tunnel.shopId),
      publicUrl: `https://${tunnel.shopId}.${this.options.relayDomain}`,
      grantLifetimeSeconds: GRANT_LIFETIME_SECONDS,
    }), 'utf8')))
    this.markOnline(tunnel)
    this.log(`[relay] ${tunnel.shopId} connected`)
    this.flushWaiting(current)
    return tunnel
  }

  private handleHostFrame(tunnel: HostTunnel, type: number, streamId: number, payload: Buffer): void {
    tunnel.lastSeen = this.now()
    const stream = tunnel.streams.get(streamId)
    if (type === FRAME.ping) {
      tunnel.socket.send(encodeFrame(FRAME.pong, streamId, Buffer.alloc(0)))
      return
    }
    if (!stream) return
    switch (type) {
      case FRAME.responseHeaders: {
        let parsed: { status?: number; headers?: Record<string, string | string[] | number> } = {}
        try {
          parsed = JSON.parse(payload.toString('utf8')) as typeof parsed
        } catch {
          this.finishStream(tunnel, streamId, null, new Error('The shop sent unreadable response headers.'))
          return
        }
        stream.status = Number.isInteger(parsed.status) && parsed.status! >= 100 && parsed.status! <= 599 ? parsed.status! : 502
        stream.headers = filterResponseHeaders(parsed.headers ?? {})
        return
      }
      case FRAME.responseBody: {
        stream.bytes += payload.length
        if (stream.bytes > LIMITS.maxRequestBodyBytes) {
          this.finishStream(tunnel, streamId, null, new Error('The shop sent too much data.'))
          return
        }
        stream.chunks.push(Buffer.from(payload))
        return
      }
      case FRAME.responseEnd: {
        this.finishStream(tunnel, streamId, {
          status: stream.status ?? 502,
          headers: stream.headers,
          body: Buffer.concat(stream.chunks),
        }, null)
        return
      }
      case FRAME.error: {
        this.finishStream(tunnel, streamId, null, new Error(payload.toString('utf8').slice(0, 200) || 'The shop refused the request.'))
        return
      }
      default:
        return
    }
  }

  private finishStream(tunnel: HostTunnel, streamId: number, result: StreamResult | null, error: Error | null): void {
    const stream = tunnel.streams.get(streamId)
    if (!stream) return
    tunnel.streams.delete(streamId)
    clearTimeout(stream.timer)
    if (result) stream.resolve(result)
    else stream.reject(error ?? new Error('The request failed.'))
  }

  private closeTunnel(tunnel: HostTunnel): void {
    if (tunnel.closed) return
    tunnel.closed = true
    const state = this.shops.get(tunnel.shopId)
    if (state?.tunnel === tunnel) state.tunnel = null
    for (const [, stream] of tunnel.streams) {
      clearTimeout(stream.timer)
      stream.reject(new Error('The shop PC disconnected.'))
    }
    tunnel.streams.clear()
    this.markOffline(tunnel)
    this.log(`[relay] ${tunnel.shopId} disconnected`)
  }

  // ------------------------------------------------------------------ phone side

  private async handlePhoneRequest(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const shopId = this.shopIdFromHost(request)
    if (!shopId) {
      return reply.code(404).type('text/html; charset=utf-8').send(relayLandingPage())
    }
    const state = this.shopState(shopId)

    // The phone proves it was given a link by this shop, so an unauthenticated scanner cannot even reach the
    // host's login page through the relay.
    const grant = (request.query as { g?: string } | undefined)?.g ?? (request.headers['x-infoflex-grant'] as string | undefined) ?? ''
    const verified = this.options.verifier.verifyPhoneGrant(grant, shopId)
    if (!verified.ok) {
      return reply.code(401).type('text/html; charset=utf-8').send(relayLinkExpiredPage(verified.reason))
    }
    if (state.tunnel === null) {
      if (state.waiting.length >= MAX_WAITING_PER_SHOP) {
        return reply.code(503).type('text/html; charset=utf-8').send(relayOfflinePage(shopId))
      }
      // The PC may be mid-reconnect; a short wait turns that into a slow page rather than an error.
      const body = rawBody(request)
      return new Promise<FastifyReply>((resolve) => {
        const entry = { headers: this.streamHeaders(request, verified.machineId), body, reply }
        state.waiting.push(entry)
        setTimeout(() => {
          const index = state.waiting.indexOf(entry)
          if (index === -1) return
          state.waiting.splice(index, 1)
          resolve(reply.code(503).type('text/html; charset=utf-8').send(relayOfflinePage(shopId)))
        }, LIMITS.queueWaitMs).unref()
      })
    }
    return this.forward(state.tunnel, this.streamHeaders(request, verified.machineId), rawBody(request), reply)
  }

  private flushWaiting(state: ShopState): void {
    const tunnel = state.tunnel
    if (!tunnel) return
    const waiting = state.waiting.splice(0, state.waiting.length)
    for (const entry of waiting) {
      void this.forward(tunnel, entry.headers, entry.body, entry.reply)
    }
  }

  private async forward(tunnel: HostTunnel, headers: StreamHeaders, body: Buffer, reply: FastifyReply): Promise<FastifyReply> {
    if (!tunnel.bucket.take(1, this.now())) {
      return reply.code(429).header('retry-after', '5').send({ message: 'Too many requests for this shop. Wait a moment.' })
    }
    if (!tunnel.bytesBucket.take(body.length + 1, this.now())) {
      return reply.code(429).header('retry-after', '10').send({ message: 'This shop’s connection is at its data limit for now.' })
    }
    if (tunnel.streams.size >= LIMITS.maxStreamsPerShop) {
      return reply.code(429).header('retry-after', '2').send({ message: 'The shop is handling too many requests. Try again.' })
    }
    const streamId = nextStreamId()
    const settled = await new Promise<StreamResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        tunnel.streams.delete(streamId)
        reject(new Error('The shop did not answer in time.'))
      }, LIMITS.requestTimeoutMs)
      tunnel.streams.set(streamId, { resolve, reject, status: null, headers: {}, chunks: [], bytes: 0, timer })
      tunnel.socket.send(encodeFrame(FRAME.requestHeaders, streamId, Buffer.from(JSON.stringify(headers), 'utf8')))
      if (body.length > 0) {
        for (let offset = 0; offset < body.length; offset += LIMITS.maxFrameBytes) {
          tunnel.socket.send(encodeFrame(FRAME.requestBody, streamId, body.subarray(offset, offset + LIMITS.maxFrameBytes)))
        }
      }
      tunnel.socket.send(encodeFrame(FRAME.requestEnd, streamId, Buffer.alloc(0)))
    }).then((value) => ({ ok: true as const, value })).catch((error: unknown) => ({ ok: false as const, error }))
    if (!settled.ok) {
      return reply.code(504).type('text/plain; charset=utf-8').send(settled.error instanceof Error ? settled.error.message : 'The shop did not answer.')
    }
    const response = settled.value
    this.recordTraffic(tunnel, body.length, response.body.length)
    reply.code(response.status)
    for (const [name, value] of Object.entries(response.headers)) reply.header(name, value)
    return reply.send(response.body)
  }

  private streamHeaders(request: FastifyRequest, machineId: string): StreamHeaders {
    const headers = filterRequestHeaders(request.headers as NodeJS.Dict<string | string[]>)
    // The host re-checks the licence itself, so it is told which machine the relay believes it is talking to.
    headers['x-infoflex-relay-machine'] = machineId
    return {
      method: request.method.toUpperCase(),
      // The grant must not reach the host's own routing, which validates its Origin and its paths.
      path: stripGrant(request.url || '/'),
      headers,
      clientAddress: this.peerAddress(request),
    }
  }

  // ------------------------------------------------------------------ state helpers

  private shopState(shopId: string): ShopState {
    let state = this.shops.get(shopId)
    if (!state) {
      state = { tunnel: null, waiting: [] }
      this.shops.set(shopId, state)
    }
    return state
  }

  private shopIdFromHost(request: FastifyRequest): string | null {
    const host = String(request.headers.host ?? '').toLowerCase().split(':')[0] ?? ''
    const domain = this.options.relayDomain.toLowerCase()
    if (!domain || !host.endsWith(`.${domain}`)) return null
    const label = host.slice(0, -(domain.length + 1))
    if (!/^[a-z0-9]{6,40}$/u.test(label) || label.includes('.')) return null
    return label
  }

  private peerAddress(request: FastifyRequest): string | null {
    if (this.options.trustProxy) {
      const forwarded = request.headers['x-forwarded-for']
      const text = Array.isArray(forwarded) ? forwarded[0] : forwarded
      if (typeof text === 'string' && text.trim()) return text.split(',')[0]!.trim()
    }
    return request.ip || null
  }

  private trackSocket(address: string | null, delta: number): boolean {
    const key = address ?? 'unknown'
    const count = (this.socketsByAddress.get(key) ?? 0) + delta
    if (count > LIMITS.maxSocketsPerAddress) {
      this.socketsByAddress.set(key, count - delta)
      return false
    }
    if (count <= 0) this.socketsByAddress.delete(key)
    else this.socketsByAddress.set(key, count)
    return true
  }

  private markOnline(tunnel: HostTunnel): void {
    this.writeConnection(tunnel.shopId, tunnel.licenseId, 'online', tunnel.peer)
    const existing = this.options.database.prepare('SELECT connected_at FROM relay_connections WHERE shop_id = ?').get(tunnel.shopId) as { connected_at: string | null } | undefined
    this.options.database.prepare('UPDATE relay_connections SET connected_at = ?, last_seen_at = ?, frames = 0, bytes_in = 0, bytes_out = 0 WHERE shop_id = ?')
      .run(existing?.connected_at ?? new Date(this.now()).toISOString(), new Date(this.now()).toISOString(), tunnel.shopId)
  }

  private markOffline(tunnel: HostTunnel): void {
    // A shutdown closes sockets after the database has gone; the row is already being replaced on reconnect.
    if (this.stopping) return
    this.options.database.prepare('UPDATE relay_connections SET status = ?, disconnected_at = ?, last_seen_at = ? WHERE shop_id = ?')
      .run('offline', new Date(this.now()).toISOString(), new Date(this.now()).toISOString(), tunnel.shopId)
  }

  private writeConnection(shopId: string, licenseId: string, status: 'online' | 'offline', peer: string | null): void {
    this.options.database.prepare(`
      INSERT INTO relay_connections (shop_id, license_id, status, connected_at, last_seen_at, peer_address)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop_id) DO UPDATE SET license_id = excluded.license_id, status = excluded.status,
        last_seen_at = excluded.last_seen_at, peer_address = excluded.peer_address
    `).run(shopId, licenseId, status, new Date(this.now()).toISOString(), new Date(this.now()).toISOString(), peer)
  }

  private recordTraffic(tunnel: HostTunnel, inBytes: number, outBytes: number): void {
    this.options.database.prepare('UPDATE relay_connections SET frames = frames + 1, bytes_in = bytes_in + ?, bytes_out = bytes_out + ?, last_seen_at = ? WHERE shop_id = ?')
      .run(inBytes, outBytes, new Date(this.now()).toISOString(), tunnel.shopId)
  }

  /** Called by the portal after a suspend so an open tunnel is dropped, not merely refused at the next reconnect. */
  disconnectShop(licenseId: string): boolean {
    this.options.verifier.forget(licenseId)
    for (const state of this.shops.values()) {
      if (state.tunnel?.licenseId === licenseId) {
        state.tunnel.socket.close(4403, 'This licence is suspended.')
        this.closeTunnel(state.tunnel)
        return true
      }
    }
    return false
  }

  /** Closes every tunnel; used on shutdown so shops reconnect to the new process. */
  closeAll(): void {
    this.stopping = true
    for (const state of this.shops.values()) {
      for (const entry of state.waiting.splice(0)) {
        entry.reply.code(503).type('text/html; charset=utf-8').send(relayOfflinePage('this shop'))
      }
      if (state.tunnel) {
        state.tunnel.socket.close(1001, 'The relay is restarting.')
        this.closeTunnel(state.tunnel)
      }
    }
  }

  onlineShops(): string[] {
    return [...this.shops.values()].filter((state) => state.tunnel !== null).map((state) => state.tunnel!.shopId)
  }
}

let streamCounter = 1

function nextStreamId(): number {
  streamCounter = (streamCounter + 1) % 0xffffffff
  return streamCounter
}

function rawBody(request: FastifyRequest): Buffer {
  const body = request.body
  if (body === null || body === undefined) return Buffer.alloc(0)
  if (Buffer.isBuffer(body)) return body
  if (typeof body === 'string') return Buffer.from(body, 'utf8')
  return Buffer.from(JSON.stringify(body), 'utf8')
}

function stripGrant(url: string): string {
  const index = url.indexOf('?')
  if (index === -1) return url
  const params = new URLSearchParams(url.slice(index + 1))
  params.delete('g')
  const rest = params.toString()
  return rest ? `${url.slice(0, index)}?${rest}` : url.slice(0, index)
}

export function relayShopUrl(relayDomain: string, licenseId: string): string {
  return `https://${shopSlugFor(licenseId)}.${relayDomain}`
}

function pageShell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
:root{color-scheme:light}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#FBF9F4;color:#1a2433;
font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:24px}
.card{max-width:420px;background:#fff;border:1px solid #e6e0d2;border-radius:16px;padding:28px;box-shadow:0 10px 30px rgba(31,63,115,.09)}
h1{margin:0 0 .5rem;font-size:1.3rem;color:#1F3F73}p{margin:.5rem 0;line-height:1.55}
.badge{display:inline-block;background:#1F3F73;color:#FBF9F4;border-radius:999px;padding:.2rem .7rem;font-size:.75rem;letter-spacing:.06em;text-transform:uppercase}
.hint{margin-top:1rem;padding:.75rem;background:#FBF9F4;border-radius:10px;font-size:.85rem;color:#4a5568}
</style></head><body><main class="card"><span class="badge">Infoflex</span>${body}</main></body></html>`
}

function relayLandingPage(): string {
  return pageShell('Infoflex', '<h1>Remote access</h1><p>This address belongs to an Infoflex shop, but the exact shop was not recognised. Open the link or scan the code shown on the till.</p>')
}

function relayLinkExpiredPage(reason: string): string {
  return pageShell('Infoflex', `<h1>This link has expired</h1><p>${escapeText(reason)}</p><div class="hint">On the till, open <strong>Settings → Mobile access</strong> and scan the QR code again. The code on the till changes every minute.</div>`)
}

function relayOfflinePage(shopId: string): string {
  return pageShell('Infoflex', `<h1>The shop’s computer is offline</h1><p>The till at <strong>${escapeText(shopId)}</strong> is not connected to the internet right now, so its admin pages cannot be reached.</p><div class="hint">Mobile access over the internet only works while the shop PC is switched on, connected, and the licence is active.</div>`)
}

function escapeText(value: string): string {
  return String(value).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
}

/** Exposed for the relay tests, which need the derived address without a live server. */
export function relayFingerprint(licenseId: string): string {
  return createHash('sha256').update(licenseId).digest('hex').slice(0, 12)
}

/** A frame header is five bytes; kept exported so the host client and the tests agree on the size. */
export { FRAME_HEADER_BYTES }
