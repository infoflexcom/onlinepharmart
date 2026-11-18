/**
 * The relay's wire protocol.
 *
 * A shop PC opens one outbound WebSocket to the relay and keeps it open. Phones never touch the PC: they reach
 * `https://<shop-id>.<relay-domain>/…`, the relay turns each HTTP request into frames on that WebSocket, and the
 * PC's local server answers. Nothing is dialled inwards and no port is opened on the shop's network, which is
 * why this works behind a router or a mobile dongle without port forwarding.
 *
 * Frames are deliberately simple: a one-byte type, a four-byte stream id, then the payload. Header frames carry
 * UTF-8 JSON, body frames carry raw bytes, so a receipt PDF or a photo of a product moves as binary rather than
 * being base64-inflated by a third.
 *
 * **What the relay can and cannot see.** The relay matches a request to a stream and copies bytes; it does not
 * parse, cache or log bodies, and it keeps no copy of a response. It does terminate TLS, so it is a trusted
 * pass-through rather than a cryptographically end-to-end channel — the same trust a customer already places in
 * the vendor's HTTPS certificate. `cloud/docs/RELAY-LIMITS.md` states this plainly, and the portal repeats it.
 *
 * This file lives under `src/shared` because **two programs** speak it: the cloud relay (which turns HTTP into
 * frames) and the desktop host (`src/main/relay-client.ts`, which turns frames back into an HTTP request against
 * the shop's own Admin listener). One copy of the frame types and the header allowlists means the two ends cannot
 * drift apart, and a change to what is forwarded is a change both ends see at compile time.
 */
export const FRAME = {
  hello: 0x01,
  requestHeaders: 0x02,
  requestBody: 0x03,
  requestEnd: 0x04,
  responseHeaders: 0x05,
  responseBody: 0x06,
  responseEnd: 0x07,
  error: 0x08,
  ping: 0x09,
  pong: 0x0a,
  /**
   * Relay → host, once, straight after a successful `hello`. It carries the per-shop key the host uses to mint
   * the short-lived links it shows as a QR code.
   */
  welcome: 0x0b,
} as const

export const FRAME_HEADER_BYTES = 5

/**
 * The one header the shop PC adds to a relayed request. The local listener reads it — and only from a loopback
 * peer — to know the request arrived from the internet rather than from the shop's own Wi-Fi, which is what
 * chooses the `mobileInternet` entitlement and forces the authenticator code.
 */
export const RELAY_ARRIVAL_HEADER = 'x-infoflex-relay'

export const LIMITS = {
  /** Concurrent requests a single shop may have in flight. A cheap cap on a runaway client. */
  maxStreamsPerShop: 16,
  /** Largest request body a phone may send. The admin app posts JSON; 8 MiB is generous. */
  maxRequestBodyBytes: 8 * 1024 * 1024,
  /** Largest single frame. Bigger bodies arrive as several frames. */
  maxFrameBytes: 64 * 1024,
  /** Requests per minute per shop; the admin app needs a handful per screen. */
  requestsPerMinutePerShop: 600,
  /** Connections per source address, so one misbehaving phone cannot hold every slot. */
  maxSocketsPerAddress: 12,
  /** A host that sends nothing for this long is dropped and the shop shows offline. */
  hostIdleMs: 45_000,
  /** How long a phone waits for the shop PC to answer before the relay gives up. */
  requestTimeoutMs: 20_000,
  /** Bytes copied per shop per minute to the PC; 0 disables. Protects a metered connection. */
  maxBytesPerMinutePerShop: 24 * 1024 * 1024,
  /** Longest a request may sit in the queue waiting for a free stream. */
  queueWaitMs: 5_000,
}

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export interface StreamHeaders {
  method: string
  path: string
  /** Only these survive the hop; hop-by-hop and cookie-stripping headers are dropped deliberately. */
  headers: Record<string, string>
  /** Set by the relay, never by the phone: the address the request really came from. */
  clientAddress: string | null
}

export interface ResponseHeaders {
  status: number
  headers: Record<string, string>
}

const FORWARDED_HEADERS = new Set([
  'accept', 'accept-language', 'authorization', 'content-type', 'cookie', 'origin', 'referer', 'user-agent',
  'x-infoflex-device', 'x-infoflex-signature', 'x-requested-with', 'if-none-match',
])

const RETURNED_HEADERS = new Set([
  'content-type', 'content-disposition', 'cache-control', 'etag', 'last-modified', 'www-authenticate',
  'x-infoflex-device-status', 'retry-after',
])

export function encodeFrame(type: number, streamId: number, payload: Buffer): Buffer {
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.length)
  frame.writeUInt8(type, 0)
  frame.writeUInt32BE(streamId >>> 0, 1)
  payload.copy(frame, FRAME_HEADER_BYTES)
  return frame
}

export interface DecodedFrame {
  type: number
  streamId: number
  payload: Buffer
}

export function decodeFrame(data: Buffer): DecodedFrame | null {
  if (data.length < FRAME_HEADER_BYTES) return null
  return { type: data.readUInt8(0), streamId: data.readUInt32BE(1), payload: data.subarray(FRAME_HEADER_BYTES) }
}

/**
 * Copies only the headers worth sending across. Dropping everything else keeps `host`, `content-length`,
 * `transfer-encoding` and friends from contradicting the bytes the relay actually delivers, and stops a phone
 * from smuggling a header the shop PC never expected.
 */
export function filterRequestHeaders(input: NodeJS.Dict<string | string[]>): Record<string, string> {
  const output: Record<string, string> = {}
  for (const [name, value] of Object.entries(input)) {
    const key = name.toLowerCase()
    if (!FORWARDED_HEADERS.has(key) || value === undefined) continue
    const text = Array.isArray(value) ? value.join(', ') : value
    if (text.length <= 4_096) output[key] = text
  }
  return output
}

export function filterResponseHeaders(input: Record<string, string | string[] | number | undefined>): Record<string, string> {
  const output: Record<string, string> = {}
  for (const [name, value] of Object.entries(input)) {
    const key = name.toLowerCase()
    if (!RETURNED_HEADERS.has(key) || value === undefined) continue
    output[key] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  return output
}

/** A per-shop token bucket. Time is passed in so the tests can drive it without a sleep. */
export class TokenBucket {
  private tokens: number
  private lastRefill: number

  constructor(private readonly perMinute: number, nowMs: number) {
    this.tokens = perMinute
    this.lastRefill = nowMs
  }

  take(count: number, nowMs: number): boolean {
    const elapsedMinutes = (nowMs - this.lastRefill) / 60_000
    if (elapsedMinutes > 0) {
      this.tokens = Math.min(this.perMinute, this.tokens + elapsedMinutes * this.perMinute)
      this.lastRefill = nowMs
    }
    if (count > this.tokens) return false
    this.tokens -= count
    return true
  }

  get remaining(): number {
    return Math.max(0, Math.floor(this.tokens))
  }
}

export interface RelayDecision {
  ok: boolean
  reason: string
  shopId: string | null
}

/**
 * A phone grant: the short-lived permission slip the till puts inside the QR code and the link it copies.
 *
 * It is an HMAC over `shopId`, `machineId` and an expiry, keyed with the relay shared secret the vendor
 * configured. That is deliberately *not* an end-to-end channel: it proves the phone was handed a link by this
 * shop's own computer, which is what stops an unauthenticated stranger from even reaching the shop's login page
 * through the relay. It does not encrypt anything.
 */
export interface PhoneGrantPayload {
  shopId: string
  machineId: string
  /** Unix seconds. A grant is short-lived by design; the till re-mints on every screen. */
  expiresAt: number
}

const GRANT_PREFIX = 'v1'

/**
 * The shop's public address label. Derived from the licence id so the vendor never invents or remembers one and
 * one shop cannot claim another's name; short and lowercase because it is typed on a phone. The cloud relay and
 * the desktop host must derive exactly this, so it lives here rather than in either of them.
 */
export function shopSlug(licenseId: string): string {
  return createHash('sha256').update(`infoflex-relay-shop:${licenseId}`).digest('hex').slice(0, 12)
}

/**
 * The key a shop's phone links are signed with. Derived from the vendor's relay secret **and the shop's own
 * address**, so a compromised or curious shop PC can mint links for itself and for nothing else: it never holds
 * the vendor master secret, and the key it receives cannot be used against a neighbour.
 */
export function deriveGrantKey(masterSecret: string, shopId: string): string {
  return createHmac('sha256', masterSecret).update(`infoflex-relay-grant:${shopId}`).digest('base64url')
}

function grantSignature(secret: string, payloadText: string, expiresText: string): Buffer {
  return createHmac('sha256', secret).update(`${GRANT_PREFIX}.${payloadText}.${expiresText}`).digest()
}

/** Mints the string the till shows. Called by the shop PC only; the secret never reaches a phone. */
export function mintPhoneGrant(secret: string, payload: PhoneGrantPayload): string {
  if (!secret) throw new Error('The relay secret is not configured on this computer.')
  const body = Buffer.from(JSON.stringify({ shopId: payload.shopId, machineId: payload.machineId }), 'utf8')
  const payloadText = body.toString('base64url')
  const expiresText = String(Math.floor(payload.expiresAt))
  const signature = grantSignature(secret, payloadText, expiresText).toString('base64url')
  return `${GRANT_PREFIX}.${payloadText}.${expiresText}.${signature}`
}

/**
 * Verifies a grant. Every failure returns the same sentence, because a phone has no business learning which
 * part of a forged link was wrong.
 */
export function verifyPhoneGrant(
  secret: string,
  grant: string,
  shopId: string,
  nowMs: number,
): { ok: true; machineId: string; expiresAt: number } | { ok: false; reason: string } {
  const parts = String(grant ?? '').split('.')
  if (parts.length !== 4 || parts[0] !== GRANT_PREFIX) return { ok: false, reason: 'That link is not valid.' }
  const [, payloadText, expiresText, signatureText] = parts as [string, string, string, string]
  const expires = Number(expiresText)
  if (!Number.isInteger(expires)) return { ok: false, reason: 'That link is not valid.' }
  const expected = grantSignature(secret, payloadText, expiresText)
  const given = Buffer.from(signatureText, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'That link is not valid.' }
  }
  if (expires * 1_000 <= nowMs) return { ok: false, reason: 'That link has expired. Scan the code on the till again.' }
  let payload: { shopId?: string; machineId?: string }
  try {
    payload = JSON.parse(Buffer.from(payloadText, 'base64url').toString('utf8')) as { shopId?: string; machineId?: string }
  } catch {
    return { ok: false, reason: 'That link is not valid.' }
  }
  if (payload.shopId !== shopId) return { ok: false, reason: 'That link belongs to a different shop.' }
  return { ok: true, machineId: String(payload.machineId ?? ''), expiresAt: expires }
}
