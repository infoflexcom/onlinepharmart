# What the relay can and cannot see

The internet relay is the feature that lets an Admin's phone reach a shop's PC over mobile data. It is the only
part of Infoflex Cloud that carries a shop's own traffic, so its limits are written down here, repeated on the
portal's **Relay** page, and asserted in `cloud/tests/relay.test.ts`.

## The short answer

**The relay is a trusted pass-through, not an end-to-end encrypted channel.** It sees the traffic it forwards, in
the same way any HTTPS server sees a request it terminates. There is no Noise or libsodium layer between the
phone and the shop PC in this build.

What protects the shop's data instead:

1. **The shop PC still requires everything it always did.** The relay forwards to the PC's own mobile API, which
   enforces Admin-only login, device approval and TOTP itself. The relay cannot approve a device, mint a session
   or skip a password, because it does not understand the API — it copies bytes.
2. **A phone must hold a link minted by that shop's till.** Requests without a valid, unexpired grant are refused
   at the relay with 401 before the shop PC is even contacted, so an unauthenticated scanner cannot reach the
   PC's login page through the relay.
3. **Both hops are TLS.** Phone → relay is HTTPS with a real certificate for the shop's subdomain; relay → PC is
   an outbound WebSocket the PC opened, itself over TLS to the relay. Nothing is sent in clear over the internet.
4. **Nothing is stored.** The relay keeps counters (frames, bytes) and a connection row for the portal's on/off
   indicator. It does not write request bodies, response bodies, cookies or headers to disk or to a log, and it
   does not keep a copy of a receipt, a report or a product after forwarding it.
5. **The licence gate is checked on every connection and re-checked against the live database.** A suspended or
   expired licence cannot open a tunnel, an internet-disabled licence cannot open one, and `disconnectShop()` drops
   an already-open tunnel when a vendor suspends it.

## What the relay can technically do

| Capability | Status |
| --- | --- |
| Read the plaintext of a request it forwards | **Yes** — it terminates TLS |
| Modify a request or a response | **Yes** in principle; the code does not, and the frame format copies payloads byte for byte |
| Learn which screens an Admin opens, and when | **Yes** — it must, to route them |
| Read a password sent from the phone to the shop PC | **Yes**, unless the shop PC's own login is the only path — which it is, and that login is over this hop |
| Store shop data | **No** — no shop data is written anywhere, by design and by test |
| Reach a shop whose licence is off, suspended or expired | **No** — refused at the handshake |
| Be reached without a valid shop-issued grant | **No** — 401 before the PC is contacted |
| Survive a flood from one address | **No** — per-address socket cap, per-shop request and byte buckets, per-shop stream cap |

## Why not end-to-end encryption

A real end-to-end channel needs a key exchange between the phone and the PC's own crypto, a library on both ends
(this repository has neither libsodium nor a Noise implementation available), and a way to get the phone's key to
the PC that does not itself trust the relay — normally a QR code scanned at the till. That design is coherent and
is the right next step, but it cannot be built and tested honestly in this environment: there is no browser and no
phone here, so a handshake that only ever ran in a unit test would be presented as working when nobody had
produced a single encrypted frame end to end. Shipping a half-implemented handshake would be worse than shipping
a documented limit.

So the limit is stated instead:

> **The vendor's relay server can read traffic between the Admin's phone and the shop's PC.** It forwards it over
> TLS on both hops and stores none of it. The shop's own Admin login, device approval and TOTP are still required.
> A vendor who does not accept this trade-off should leave the relay's internet access switched off; the phone
> still works on the shop's own network, which never leaves the building.

That paragraph is also in the privacy notice, in the portal, and in the customer-facing licence wording, so a
shop owner can decide before they tick "allow over the internet".

## Caps and limits, in numbers

| Limit | Value | Where |
| --- | --- | --- |
| Concurrent tunnelled requests per shop | 16 | `LIMITS.maxStreamsPerShop` |
| Largest request body a phone may send | 8 MiB | `LIMITS.maxRequestBodyBytes` |
| Largest single frame | 64 KiB | `LIMITS.maxFrameBytes` |
| Requests per minute per shop | 600 | `LIMITS.requestsPerMinutePerShop` |
| Data copied per minute per shop | 24 MiB | `LIMITS.maxBytesPerMinutePerShop` |
| Sockets per source address | 12 | `LIMITS.maxSocketsPerAddress` |
| Wait for a disconnected PC before answering 503 | 5 s | `LIMITS.queueWaitMs` |
| Wait for the PC to answer a request | 20 s | `LIMITS.requestTimeoutMs` |
| Host idle timeout | 45 s of silence | `LIMITS.hostIdleMs` |
| Grant lifetime | minted by the till, typically minutes | `RelayVerifier.verifyPhoneGrant` |
| Licence re-check cache | 30 s on success, 15 s on failure | `RelayVerifier` |

A suspended licence also has its open tunnel closed immediately, so the cache only matters for a rejection.

## What is forwarded

Only these request headers survive the hop: `accept`, `accept-language`, `authorization`, `content-type`,
`cookie`, `origin`, `referer`, `user-agent`, `x-infoflex-device`, `x-infoflex-signature`, `x-requested-with`,
`if-none-match`. Everything else — `host`, `content-length`, `transfer-encoding`, `x-forwarded-for` — is dropped,
because the bytes the relay delivers must be the bytes it announces, and because a phone must not be able to forge
a header the shop PC would trust.

Only these response headers travel back: `content-type`, `content-disposition`, `cache-control`, `etag`,
`last-modified`, `www-authenticate`, `x-infoflex-device-status`, `retry-after`. A `set-cookie` from the shop PC
does not cross the relay; the phone's session is its own.

## Running the relay safely

- Keep `INFOFLEX_CLOUD_RELAY_SECRET` a fresh random value; it signs the links the till shows.
- Do not put the relay's wildcard domain on any name other than `*.<relay-domain>`.
- If you ever need to stop relaying for everybody at once, clear `INFOFLEX_CLOUD_RELAY_DOMAIN` and redeploy: the
  tunnel route disappears and every phone gets a 404 rather than reaching a shop.
- Per-licence, the vendor's own switch is the licence's **Mobile over the internet** tick. Turning it off is
  immediate for new connections, and `disconnectShop()` is called when a licence is suspended.
