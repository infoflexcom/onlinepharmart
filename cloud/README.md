# Vendor Cloud

The licence server and vendor portal for Infoflex: the part that decides whether a shop's copy of the software
may run, and the screens the vendor uses to sell, renew and suspend licences.

Two builds ship here. They speak the **same licence API**, so the desktop app cannot tell them apart, and they
enforce the **same rules**.

| | `cloud/src` (Node) | `cloud/php` (PHP + MySQL) |
| --- | --- | --- |
| Licence API (activate, check-in, offline file, public key) | yes | yes |
| Vendor portal (customers, licences, renewals, suspension, audit) | yes | yes |
| Internet relay for Admin phones | yes | **no** — deliberately absent |
| Automatic daily database snapshots | yes | use the host's own backup |
| Expiry e-mail reminders | yes (three stages, once each) | portal only |
| Runs on | a small VPS with Docker, or a managed Node host | ordinary shared hosting |
| Tests | `npm run cloud:test` | `npm run php:test` (32 checks), also run inside `npm run cloud:test` |

**Which to deploy:** [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) opens with the decision table.

## What the cloud holds

Licence and contact data only. There is no column anywhere that could hold a sale, a price, a stock level or an
amount, and the public API **refuses** a body carrying one. Both are asserted on every build:

- `cloud/tests/schema.test.ts` enumerates every table and column and fails on anything unrecognised.
- `cloud/src/license-api.ts` answers `400 business_data_not_permitted` for any of twenty shop-data keys.
- `cloud/php/tests/run.php` does the same for the PHP schema.

Currency travels as a **code** (`NGN`) plus a lock flag. Never a symbol, a rate or an amount.

## The licence API the desktop already speaks

```
GET  /api/license/config      → { mode, keyId, publicKey }
POST /api/license/activate    ← { activationKey, machineId, appVersion, platform }
                              → { token, serverNow, licenseId }       401/403 rejected
POST /api/license/check-in    ← { licenseId, machineId, appVersion, platform, checkedAt,
                                  source, online, onsiteLicense? }
                              → { updated, reported, token, serverNow }  409 machine conflict
GET  /api/license/public-key  → { mode, keyId, publicKey }
```

`token` is the same Ed25519-signed envelope `src/license/crypto.ts` verifies: a JSON envelope whose payload is the
canonical claims JSON. Nothing here invents a second format — the tests sign with this code and verify with the
desktop's own verifier.

A portal-created licence therefore reaches a shop like this:

1. The vendor creates the licence with a default currency and, optionally, "lock currency".
2. The shop types the key; activation returns a token whose claims carry `defaultCurrencyCode` and `lockCurrency`.
3. Setup preselects that currency; a locked currency cannot be changed. (DONE WHEN 1 and 2.)
4. Every 24 hours the till checks in. A renewal, suspension or entitlement change bumps a revision counter, and
   the next check-in hands back a freshly signed token — no password typed at the till. (DONE WHEN 4.)

## Running it

### Node build

```bash
cp cloud/.env.example cloud/.env      # fill in the secrets; see DEPLOYMENT.md
npm install
npm run cloud:dev                     # http://localhost:8080/portal
```

Docker:

```bash
docker compose -f cloud/docker-compose.yml --env-file cloud/.env up -d --build
```

The image contains no secret. The signing key is mounted read-only from the host, the session secret and SMTP
password arrive from the environment or from `*_FILE` paths.

### PHP build

Upload `cloud/php/public/*` to the web root, `cloud/php/lib/*` beside it, and `cloud/php/config.example.php` to
`config.php` one level above the web root with the database and key path filled in. Full clicking instructions in
[DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Layout

```
cloud/
  src/
    config.ts          environment-only configuration; refuses to start half-configured
    signing.ts         Ed25519 envelopes, shared with the desktop's verifier
    database.ts        schema, migrations and the ALLOWED_COLUMNS privacy contract
    auth.ts            vendor accounts: argon2id, mandatory TOTP, lockout, sessions, CSRF
    license-service.ts the licensing rules (activation, check-in, renew, suspend, rebind, offline file)
    license-api.ts     the four public calls, and the business-data refusal
    mailer.ts          a small SMTP sender for expiry reminders
    reminders.ts       the 30/14/7-day reminder job, once per stage per term
    backups.ts         daily consistent snapshots with pruning and a verified restore
    server.ts          Fastify bootstrap: config, db, portal, licence API, relay, headers
    portal/            styles.ts, html.ts, pages.ts, router.ts — the vendor's screens
    relay/             protocol.ts, verify.ts, server.ts — the Admin phone's internet path
  assets/              brand images served at /portal/assets/*
  php/
    lib/               licence.php, database.php, service.php, auth.php, views.php, pages.php, api.php, bootstrap.php
    public/            one file per page, plus api.php — the PHP build's entry points
    tests/run.php      the PHP build's own suite (32 checks)
    config.example.php
  tests/               Node/vitest suites for the cloud, and the runner for the PHP suite
  docs/                DEPLOYMENT, RELAY-LIMITS, PRIVACY-NOTICE, COSTS
  mock/server.ts       the older mock licence server, kept working for the desktop's own tests
```

## Tests

```bash
npm run cloud:test        # 8 files: schema, auth, licence flow, portal, relay, maintenance, secrets, php build
npx vitest run src/main/relay-client.test.ts   # the shop PC's half: real relay + real client + real listener
npm run php:test          # the PHP suite directly, if you have a php binary
```

What the suites prove, in the language of the brief's acceptance criteria:

| Criterion | Where |
| --- | --- |
| A portal-created licence activates and preselects its currency | `license-flow.test.ts` "activates a portal-created licence and preselects the default currency" |
| A locked currency cannot change | `license-flow.test.ts` (claims carry `lockCurrency`); `portal.test.ts` "refuses a locked currency without a currency code" |
| The licence end date locks the app | `license-flow.test.ts` "signs an expired licence so the app locks at the end date" (the desktop's own runtime check is the lock) |
| A vendor extends from a phone and the app unlocks by itself | `license-flow.test.ts` "delivers a renewal on the next check-in with no customer password" |
| Suspend/unsuspend with grace, including a reported on-site licence | `license-flow.test.ts` (two tests, one on-site) |
| A licence file for another machine is refused | `license-flow.test.ts` "refuses a licence file issued for a different machine" |
| Rebind only from the portal | `license-flow.test.ts` "rejects a second machine until the vendor rebinds"; `portal.test.ts` |
| The relay reaches the shop with correct login, device approval and TOTP; cashier refused | `relay.test.ts` (tunnel, grant, licence gates, offline); the login/approval/TOTP half is the host's own suite, unchanged (`src/api/mobile-*`) |
| The relay cannot read traffic, or the limit is documented | [docs/RELAY-LIMITS.md](docs/RELAY-LIMITS.md), repeated in the portal and the privacy notice |
| No private key or master password in plain text | `secrets.test.ts` scans the whole repository and the example environment file, and drives the config guard |

The relay's shop-side half lives in the desktop build (`src/main/relay-client.ts`) and is proved there against this
real relay: an Admin request reaches the shop's own listener, a request with no Admin credential is refused, and a
cashier is refused over the relay exactly as on the LAN.

Honest gaps, listed rather than hidden: there is no browser or phone in this environment, so the portal's pages are
proved through Fastify's `app.inject` (real routing, real HTML, real CSRF) and not by a screenshot, and the "phone"
in the relay test is an HTTP request rather than a handset on mobile data; the PHP build's MySQL-specific DDL is
exercised against SQLite, because no MySQL server is reachable here, and its Ed25519 signing is proved through a
test-only signer seam because the WebAssembly PHP here has no Ed25519 in its OpenSSL. The manual checks for the real
domain, the real phone and the real MySQL host are in `docs/RELEASE-CHECKLIST.md`.
