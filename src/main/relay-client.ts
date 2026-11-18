import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import WebSocket from 'ws'
import {
  FRAME,
  LIMITS,
  decodeFrame,
  encodeFrame,
  filterResponseHeaders,
  mintPhoneGrant,
  RELAY_ARRIVAL_HEADER,
  type StreamHeaders,
} from '../shared/relay/protocol'

/**
 * The shop PC's half of the internet relay.
 *
 * The relay (the vendor's server) cannot reach into a shop's network, so the shop's computer dials **out**: one
 * long-lived WebSocket to the vendor, which the relay turns back into HTTP requests arriving from an Admin's
 * phone. No port is opened, no router rule is needed, and a shop behind a mobile dongle works exactly like one
 * behind fibre.
 *
 * What this file is careful about, because it is the trusted end:
 *
 * - **It talks only to its own local listener.** A frame names a path and a method; the host and port are fixed
 *   when the client is constructed, so a frame cannot make the shop's computer fetch an arbitrary URL, and there
 *   is no proxy loop to wander into.
 * - **Only the relay's own arrival marker is added, and only for one thing:** telling the local listener that
 *   this request came from the internet, so it picks the `mobileInternet` licence feature and insists on the
 *   authenticator code. Every other header is the phone's own, after the shared allowlist has been applied.
 * - **The shop's own rules still run.** The Admin login, device approval, TOTP and the Admin-only rule belong to
 *   the listener, untouched. A relay that lied about a machine, or a phone holding a stolen grant, still faces an
 *   unapproved device and a password prompt.
 * - **The link the till shows is minted here, not at the vendor.** The relay hands this computer a key derived
 *   from its own shop address (the `welcome` frame), so the till can print a fresh QR code as often as it likes
 *   while the vendor holds nothing that could mint a link for another shop.
 */
export interface RelayClientOptions {
  /** `wss://relay.example.com` — the vendor's relay, from the licence configuration. */
  relayUrl: string
  /** This computer's shop address label, derived from the licence id. */
  shopId: string
  /** The signed licence token this installation already holds; the relay verifies it before anything else. */
  licenseToken: () => string | null
  machineId: string
  appVersion: string
  /**
   * Where to send a phone's request locally. Fixed by the host, never by a frame, so the relay cannot make this
   * computer call anything but its own listener.
   */
  localTarget: () => { host: string; port: number; secure: boolean; ca?: string } | null
  /**
   * Called with the shop's public address and the key used to mint phone links. The key is this shop's alone;
   * the screen that shows the QR code uses it and the Admin never sees it.
   */
  onWelcome?: (info: RelayWelcome) => void
  onStatus?: (status: RelayStatus) => void
  log?: (message: string) => void
  now?: () => number
  /** Injected by the tests so the tunnel can be driven against a plain-`ws` listener. */
  createSocket?: (url: string) => WebSocket
  /** How long to wait before reconnecting, growing to `maxReconnectMs`. */
  reconnectMs?: number
  maxReconnectMs?: number
}

export interface RelayWelcome {
  shopId: string
  grantKey: string
  publicUrl: string
  grantLifetimeSeconds: number
  receivedAt: string
}

export interface RelayStatus {
  state: 'stopped' | 'connecting' | 'connected' | 'waiting' | 'refused'
  /** Plain words for the Mobile access screen. */
  message: string
  publicUrl: string | null
  connectedAt: string | null
  lastFrameAt: string | null
  /** Why the relay refused the tunnel, when it did. */
  reason: string | null
}

export class RelayClient {
  private socket: WebSocket | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay: number
  private stopped = true
  private welcome: RelayWelcome | null = null
  private status: RelayStatus = {
    state: 'stopped', message: 'Internet access for the Admin phone is switched off on this computer.',
    publicUrl: null, connectedAt: null, lastFrameAt: null, reason: null,
  }

  constructor(private readonly options: RelayClientOptions) {
    this.reconnectDelay = options.reconnectMs ?? 2_000
  }

  /** The address to show on the Mobile access screen and in the QR code, once the relay has introduced itself. */
  get publicUrl(): string | null {
    return this.welcome?.publicUrl ?? null
  }

  get currentStatus(): RelayStatus {
    return { ...this.status }
  }

  /**
   * A fresh link for the phone. Called every time the QR code is drawn, so a screenshot of an old code is
   * worthless: the code on the screen is re-minted as it is shown.
   */
  createLink(nowMs = this.now()): { url: string; expiresAt: string } | null {
    if (!this.welcome) return null
    const expiresAt = nowMs + this.welcome.grantLifetimeSeconds * 1_000
    const grant = mintPhoneGrant(this.welcome.grantKey, {
      shopId: this.welcome.shopId,
      machineId: this.options.machineId,
      expiresAt,
    })
    return { url: `${this.welcome.publicUrl}/?g=${grant}`, expiresAt: new Date(expiresAt).toISOString() }
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const socket = this.socket
    this.socket = null
    if (socket) {
      try {
        socket.close(1000, 'Internet access switched off on this computer.')
      } catch {
        // A socket already closing needs no help.
      }
    }
    this.welcome = null
    this.setStatus('stopped', 'Internet access for the Admin phone is switched off on this computer.')
  }

  /**
   * Called when the licence changes — suspended, expired, or the internet entitlement withdrawn. The relay
   * decides for itself and would refuse the next connection; this makes the screen say so at once instead of
   * leaving a socket up that is about to be refused.
   */
  disconnect(reason: string): void {
    const socket = this.socket
    this.socket = null
    if (socket) {
      try {
        socket.close(4403, reason.slice(0, 120))
      } catch {
        // Ignore: the socket may already be closing.
      }
    }
    this.welcome = null
    this.setStatus('refused', reason, reason)
  }

  // ---------------------------------------------------------------- connection

  private now(): number {
    return this.options.now ? this.options.now() : Date.now()
  }

  private connect(): void {
    if (this.stopped) return
    const token = this.options.licenseToken()
    if (!token) {
      this.setStatus('waiting', 'This computer has no usable licence, so internet access cannot start.')
      this.scheduleReconnect()
      return
    }
    this.setStatus('connecting', 'Connecting to the Infoflex relay…')
    let socket: WebSocket
    try {
      socket = this.options.createSocket
        ? this.options.createSocket(`${this.options.relayUrl}/relay/tunnel`)
        : new WebSocket(`${this.options.relayUrl}/relay/tunnel`, {
          handshakeTimeout: 15_000,
          maxPayload: LIMITS.maxFrameBytes,
        })
    } catch (error) {
      this.setStatus('waiting', `Could not reach the Infoflex relay: ${describe(error)}`)
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    this.reconnectDelay = this.options.reconnectMs ?? 2_000

    socket.on('open', () => {
      socket.send(encodeFrame(FRAME.hello, 0, Buffer.from(JSON.stringify({
        shopId: this.options.shopId,
        token,
        machineId: this.options.machineId,
        appVersion: this.options.appVersion,
      }), 'utf8')))
    })

    socket.on('message', (data: Buffer) => {
      const frame = decodeFrame(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer))
      if (!frame) return
      void this.handleFrame(socket, frame.type, frame.streamId, frame.payload)
    })

    socket.on('close', (code: number, reason: Buffer) => {
      if (this.socket === socket) this.socket = null
      this.welcome = null
      const text = reason?.toString('utf8')?.trim() ?? ''
      if (code === 4403) {
        // The relay checked the live licence and refused. Reconnecting would only repeat the refusal.
        const message = text || 'The Infoflex relay refused this computer. Check the licence on the Licence screen.'
        this.setStatus('refused', message, text || null)
        return
      }
      if (this.stopped) return
      this.setStatus('waiting', 'The connection to the Infoflex relay dropped. Reconnecting…')
      this.scheduleReconnect()
    })

    // A close event always follows an error, and its reason names the relay's internals, which the shop does not
    // need. Nothing useful to add here.
    socket.on('error', () => undefined)
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer) return
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(this.options.maxReconnectMs ?? 60_000, Math.round(this.reconnectDelay * 1.7))
    this.timer = setTimeout(() => {
      this.timer = null
      this.connect()
    }, delay)
    this.timer.unref?.()
  }

  private setStatus(state: RelayStatus['state'], message: string, reason: string | null = null): void {
    const stamp = new Date(this.now()).toISOString()
    this.status = {
      state,
      message,
      publicUrl: this.welcome?.publicUrl ?? this.status.publicUrl,
      connectedAt: state === 'connected' ? (this.status.connectedAt ?? stamp) : this.status.connectedAt,
      lastFrameAt: this.status.lastFrameAt,
      reason,
    }
    this.options.onStatus?.({ ...this.status })
    this.options.log?.(`[relay] ${state}: ${message}`)
  }

  // ---------------------------------------------------------------- frames

  private async handleFrame(socket: WebSocket, type: number, streamId: number, payload: Buffer): Promise<void> {
    if (type === FRAME.welcome) {
      this.handleWelcome(socket, payload)
      return
    }

    this.status = { ...this.status, lastFrameAt: new Date(this.now()).toISOString() }
    if (type === FRAME.ping) {
      socket.send(encodeFrame(FRAME.pong, streamId, Buffer.alloc(0)))
      return
    }
    if (type !== FRAME.requestHeaders) return

    let headers: StreamHeaders
    try {
      headers = JSON.parse(payload.toString('utf8')) as StreamHeaders
    } catch {
      this.fail(socket, streamId, 'The request headers could not be read.')
      return
    }
    const target = this.options.localTarget()
    if (!target) {
      this.fail(socket, streamId, 'Mobile access is not switched on in Infoflex on this computer.')
      return
    }
    // A frame names a method and a path, and nothing else: the destination is the one this computer chose.
    if (typeof headers.method !== 'string' || typeof headers.path !== 'string'
      || !/^[A-Z]{3,7}$/u.test(headers.method) || headers.path.length > 4_096
      || (!headers.path.startsWith('/') || headers.path.startsWith('//'))) {
      this.fail(socket, streamId, 'The request was not valid.')
      return
    }

    const body = await this.collectBody(socket, streamId)
    if (body === null) {
      this.fail(socket, streamId, 'The request was too large.')
      return
    }
    this.forward(socket, streamId, headers, body, target)
  }

  private handleWelcome(socket: WebSocket, payload: Buffer): void {
    let parsed: Partial<RelayWelcome>
    try {
      parsed = JSON.parse(payload.toString('utf8')) as Partial<RelayWelcome>
    } catch {
      socket.close(4400, 'Welcome was not readable.')
      return
    }
    if (typeof parsed.shopId !== 'string' || typeof parsed.grantKey !== 'string'
      || typeof parsed.publicUrl !== 'string' || !parsed.publicUrl.startsWith('https://')
      || !Number.isInteger(parsed.grantLifetimeSeconds)) {
      socket.close(4400, 'Welcome was incomplete.')
      return
    }
    const stamp = new Date(this.now()).toISOString()
    this.welcome = {
      shopId: parsed.shopId,
      grantKey: parsed.grantKey,
      publicUrl: parsed.publicUrl.replace(/\/$/u, ''),
      grantLifetimeSeconds: Math.max(30, Math.min(3_600, parsed.grantLifetimeSeconds as number)),
      receivedAt: stamp,
    }
    this.status = { ...this.status, publicUrl: this.welcome.publicUrl, connectedAt: stamp, lastFrameAt: stamp }
    this.setStatus('connected', `The Admin phone can reach this computer at ${this.welcome.publicUrl.replace(/^https:\/\//u, '')}.`)
    this.options.onWelcome?.({ ...this.welcome })
  }

  /**
   * Waits for the body frames that follow the headers. Frames arrive in order on a single socket, so a stream's
   * body is always contiguous and there is nothing to reassemble out of order.
   */
  private collectBody(socket: WebSocket, streamId: number): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      let size = 0
      let settled = false
      const finish = (value: Buffer | null): void => {
        if (settled) return
        settled = true
        socket.off('message', listener)
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => finish(null), 15_000)
      timer.unref?.()
      const listener = (data: Buffer): void => {
        const frame = decodeFrame(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer))
        if (!frame || frame.streamId !== streamId) return
        if (frame.type === FRAME.requestBody) {
          size += frame.payload.length
          if (size > LIMITS.maxRequestBodyBytes) finish(null)
          else chunks.push(Buffer.from(frame.payload))
          return
        }
        if (frame.type === FRAME.requestEnd) finish(Buffer.concat(chunks))
      }
      socket.on('message', listener)
    })
  }

  private forward(
    socket: WebSocket,
    streamId: number,
    headers: StreamHeaders,
    body: Buffer,
    target: { host: string; port: number; secure: boolean; ca?: string },
  ): void {
    const outgoing: Record<string, string> = {}
    for (const [name, value] of Object.entries(headers.headers ?? {})) outgoing[name.toLowerCase()] = value
    outgoing[RELAY_ARRIVAL_HEADER] = '1'
    if (body.length > 0) outgoing['content-length'] = String(body.length)

    const request = (target.secure ? httpsRequest : httpRequest)({
      host: target.host,
      port: target.port,
      method: headers.method,
      path: headers.path,
      headers: outgoing,
      ...(target.secure && target.ca ? { ca: target.ca, rejectUnauthorized: true } : {}),
      timeout: LIMITS.requestTimeoutMs,
    }, (response) => {
      socket.send(encodeFrame(FRAME.responseHeaders, streamId, Buffer.from(JSON.stringify({
        status: response.statusCode ?? 502,
        headers: filterResponseHeaders(response.headers as Record<string, string | string[] | number | undefined>),
      }), 'utf8')))
      let sent = 0
      response.on('data', (chunk: Buffer) => {
        sent += chunk.length
        if (sent > LIMITS.maxRequestBodyBytes) {
          response.destroy()
          this.fail(socket, streamId, 'The reply was too large to send over the relay.')
          return
        }
        for (let offset = 0; offset < chunk.length; offset += LIMITS.maxFrameBytes) {
          socket.send(encodeFrame(FRAME.responseBody, streamId, chunk.subarray(offset, offset + LIMITS.maxFrameBytes)))
        }
      })
      response.on('end', () => {
        socket.send(encodeFrame(FRAME.responseEnd, streamId, Buffer.alloc(0)))
      })
      response.on('error', (error: unknown) => this.fail(socket, streamId, describe(error)))
    })
    request.on('timeout', () => {
      request.destroy()
      this.fail(socket, streamId, 'Infoflex on this computer took too long to answer.')
    })
    request.on('error', (error: unknown) => this.fail(socket, streamId, describe(error)))
    if (body.length > 0) request.write(body)
    request.end()
  }

  private fail(socket: WebSocket, streamId: number, message: string): void {
    try {
      socket.send(encodeFrame(FRAME.error, streamId, Buffer.from(message.slice(0, 200), 'utf8')))
    } catch {
      // The socket is gone; the relay times the stream out on its own.
    }
  }
}

/**
 * A stable, non-reversible shop address. Re-exported so the desktop never re-implements the rule the relay
 * indexes by.
 */
export { shopSlug, RELAY_ARRIVAL_HEADER } from '../shared/relay/protocol'

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  // A bare "ECONNREFUSED" tells an owner nothing; this does.
  if (/ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|ETIMEDOUT|socket hang up/u.test(message)) {
    return 'Infoflex on this computer is not answering. Check that mobile access is switched on.'
  }
  return message.slice(0, 200) || 'The request failed.'
}
