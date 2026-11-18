# Delivery phases

Status legend: **DONE (software)** means the phase's software scope is built, reviewed, and covered by the
automated suite in `npm run check:phase7` (typecheck, tests, desktop web build, PWA build, Electron bundle).
It does not mean "shipped to a customer". Anything that can only be proven on real hardware is tracked
separately in [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md) and is never marked done from a Linux build agent.

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Foundation: Electron + React + TypeScript shell, SQLite persistence and ordered migrations, settings/currency catalog, first-run setup, Admin/Supervisor/Cashier authentication, locked-currency rules, audit log, legacy import | DONE (software) |
| 2 | Editions and product data: Pharmacy/Supermarket fields, batches/expiry, barcodes, variants, promotions, loyalty, shifts, cash drawer, schema guards and indexes | DONE (software) |
| 3 | Product and inventory workspace: product CRUD, CSV/XLSX import-export, stock receive/adjust/stocktake, purchase orders and goods receipt, FEFO consumption, low-stock and expiry alerts | DONE (software) |
| 4 | Licensing: vendor policy (Build Studio), online activation, vendor-signed `.lic` import, offline on-site activation, machine binding, clock-rollback and tamper handling, check-in/reporting, local mock service | DONE (software) |
| 5 | Point of sale: retail/wholesale, split tender, customer credit, promotion/manual/loyalty discounts, prescription acknowledgement, FEFO batch snapshots, held carts, idempotent checkout, receipt printing and reprints | DONE (software) |
| 6 | Returns and accounting: return requests/approvals, return window, store credit/exchange, batch-aware restock or write-off, end-of-day cash close, cashier shifts, daily/monthly reports, CSV/Excel/PDF exports with store name and currency | DONE (software) |
| 7 | Mobile access: Admin-only LAN HTTPS PWA, TLS root/leaf lifecycle in `safeStorage`, pairing, 15-minute access tokens with rotating 90-day refresh tokens, device revocation, mobile accounting summary/PDF, mobile return approvals, LAN-only enforcement, static-only service-worker caching | **DONE (software); 3 hardware gates owed** |
| 8–10 | Settings/backup/security review; Admin-only mobile host with device approval, two-factor login and firewall repair; the Admin phone app as a served PWA | DONE (software) |
| 11 | Vendor Cloud: licence server API (two builds — Node with the internet relay, PHP+MySQL without), vendor portal with mandatory TOTP and full licence lifecycle, the internet relay and the desktop's half of it, deployment/privacy/relay-limit documents | **DONE (software); 2 hardware gates owed** |

### Report surface delivered in Phases 6–7 (and re-verified at Phase 7 close-out)

The report scope requested at close-out — daily summary, monthly summary, end-of-day close, other reports,
print/PDF/Excel exports carrying store name and currency, phone-friendly summaries, and integer minor-unit
totals — is built and covered. Export coverage for **every** Admin report section (not just the summary) was
added at close-out in `src/services/report-export-sections.test.ts`.

| Report item | Delivered where | Automated evidence |
| --- | --- | --- |
| Daily summary (sales, retail/wholesale, discounts, returns, refunds, net, COGS, gross profit) | `AccountingReportService.getDashboard` period `DAY` | `accounting-report-service.test.ts` hand-calculation assertions |
| Monthly summary with day-by-day rows and chart | period `MONTH` (30/31 day rows) | `accounting-report-service.test.ts` monthly block |
| End-of-day cash close (expected vs counted, variance, closed-by, note) | `closeDay`, `cashPosition`, `cash-close` export sheet | day-close assertions + Excel `cash-close` sheet checks |
| Other reports: top sellers, slow movers, valuation, low stock, debtors, purchases, user performance, audit log, stocktake, pharmacy, supermarket | `AdminReportData` + `buildReportExportTables` | `report-export-sections.test.ts` (all 12 sections, NGN/JPY/KWD) |
| Print / PDF export | `createReportPdf`, desktop print; phone share/download | PDF text assertions (store name + currency) per section |
| Excel export with numeric, correctly formatted money columns | `createReportWorkbookBase64` | numeric cell + `numFmt` assertions incl. 0-decimal JPY and 3-decimal KWD |
| CSV export (exact minor-unit precision) | `createReportCsv` | exact-value assertion incl. beyond-Excel-precision case |
| Store name and currency on every export | header rows in CSV/XLSX/PDF | asserted per section per currency |
| Phone-friendly summary | PWA `renderReportPage`, cards/chart/panels | `mobile-shell.test.ts`, HTTPS integration test |
| Minor-unit integer totals end to end | `bigint` minor units, decimal strings over JSON | hand calculations in NGN, JPY, KWD |


## Phase 7 close-out

Phase 7 is closed on automated coverage. The three remaining gates require physical hardware and are
carried as release-time tasks in [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md), each tagged
**needs manual check on real hardware**:

1. Windows x64: build and inspect the graphical NSIS installer; confirm DPAPI `safeStorage` in the packaged app.
2. Physical iOS/Android: certificate fingerprint comparison, root-CA trust, Add to Home Screen, update after rebuild.
3. Live LAN Wi-Fi/router/firewall behaviour: LAN-only, no port forwarding.

Phase 8 was opened on the user's request after this close-out; see below.

## Phase 8 — Settings, backup/restore and security hardening

Phase 8 delivers the Admin Settings surface, local backup and restore, and a machine-checked security
review. Completed by `npm run check:phase8` (typecheck, full suite, web/PWA/Electron builds).

| Area | What was delivered | Evidence |
| --- | --- | --- |
| Store profile | Name, address, phone, email, licence number, tax number, **logo upload** (PNG/JPEG/WebP ≤ 1 MB, validated as a data URL), footer, thank-you note; store name still required | `shop-service.test.ts`, `settings-phase8.test.ts` ("saves a valid logo…", "rejects a logo larger than…") |
| Live receipt preview | One preview built from the same receipt renderer the till prints, following the profile, VAT, paper size, footer and Infoflex toggle as you type | `SettingsPreview.test.tsx` (14 tests, including the rename-then-preview flow and both currency-lock explanations) |
| Receipt/edition options | Paper size (80 mm, 58 mm, A4), optional VAT with inclusive/exclusive pricing, discount ceiling, printer, accepted payment methods, expiry-alert days, loyalty rate, supervisor PIN rules, scale settings, "Powered by Infoflex" | `settings-phase8.test.ts`, migration 13 |
| Settings enforced | Tender refused for a method the shop switched off; the shop-wide discount ceiling is the stricter limit even for an Admin | `point-of-sale-service.test.ts` ("settings enforcement") |
| Currency | Searchable currency list + custom currency with live preview; read-only when locked with the two distinct explanations; display options always editable and display-only | `settings-phase8.test.ts` ("reports a vendor lock…", "keeps display options editable…") |
| Licence panel | Read-only: edition, period, days remaining, source, online status, last check, and "Check online now" | `LicensePanel` in `SettingsPanels.tsx`; licence behaviour already covered by `license-manager.test.ts` |
| Mobile access | Linked panel that opens the existing Mobile Access workspace | `SettingsScreen.tsx` |
| Backup | Daily automatic snapshot + on-demand manual copy to any folder/USB, single file with checksummed manifest, thirty-snapshot retention, warning when the newest backup is over 7 days old | `backup-service.test.ts` (11 tests) |
| Restore | Confirmed restore of a verified backup; safety copy first; licence state, paired devices and journals preserved; currency mismatch refused when transactions exist and adopted+locked on a fresh install; newer data refused | `backup-service.test.ts` |
| Security review | Every IPC channel guarded, sub-frame senders rejected, preload/main channel parity, Admin-only settings/backup, every API route authorised, fixed error replies, no interpolated SQL values, no secrets in logs, master password only as a salted hash | `security-review.test.ts` (14 tests) |
| Permissions on the new surface | Cashier refused on every settings and backup action | `settings-host-controller.test.ts` (4 tests) |

Verification for this phase: `npm run check:phase8` — 30 test files, 201 tests, all passing. Manual hardware
gates carried over from Phase 7 are unchanged and remain in [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md).

## Phase 9 — The Admin's phone as a secure host (Admin-only mobile access)

Phase 9 turns the LAN listener from a reporting page that a pairing code could open into a host that only a
current Admin can use. Completed by `npm run check:phase9` (typecheck, full suite, web/PWA/Electron builds).

| Requirement | What was delivered | Evidence |
| --- | --- | --- |
| Host server | HTTPS + WebSocket in the Electron main process on a configurable port; serves the PWA and `/api/v1`; every route goes through the same service/permission layer; 32 KB body limit, per-IP rate limiting, security headers, `no-store` on API replies | `admin-only-enforcement.test.ts`, `mobile-access-integration.test.ts`, `security-review.test.ts` |
| Admin-only (a) login | Only `ADMIN` may log in. A Cashier or Supervisor gets the identical body and status as a wrong password, after the same bcrypt work, and is audited with username, device, IP and time | `admin-only-enforcement.test.ts` ("refuses a Cashier with the same message…", "refuses a Supervisor…", "gives an unknown username the same answer…") |
| Admin-only (b) every request | `authenticateBearer` re-reads the user row on each call, so demotion/deactivation/lock cuts the phone off immediately; refresh re-checks too | `admin-only-enforcement.test.ts` ("cuts the phone off immediately when the Admin is demoted…") |
| Admin-only (c) pairing | A device can only be owned by an Admin; a Cashier account pointed at a device is still refused | `admin-only-enforcement.test.ts` ("never lets a Cashier become a device owner…") |
| Admin-only (d) auto-revoke | Demoting, deactivating, deleting or resetting an Admin revokes all its devices and refresh tokens | `mobile-device-service.test.ts`, `admin-only-enforcement.test.ts` |
| Admin-only (e) raw API tests | Cashier and Supervisor are refused on every `/api/v1` route with a valid device token, via raw `inject` calls; refusals never mention a role or permission | `admin-only-enforcement.test.ts` ("never reaches a service for a Cashier or Supervisor, on any route…") |
| Mobile Access screen | On/off toggle (off by default), all LAN addresses plus the friendly name, pairing code with a countdown and a scannable QR code, paired list (name, type, owner, last seen, IP, status, connected), Rename / Revoke / Revoke all, live connected count, master kill switch, licence phone limit, Test connection, a fixed Admin-only note, and a Keep running section | `MobileAccessPreview.test.tsx` (24 tests) |
| Pairing and approval | Phone scans/types → short code → Admin pop-up naming the phone, type, code and address → approve → device token activated; unapproved devices reach only the pairing page; revoked devices are rejected at once | `mobile-device-service.test.ts`, `admin-only-enforcement.test.ts`, `MobileAccessPreview.test.tsx` |
| Phone login | Admin username + password + device token; 15-minute access tokens with rotating single-use refresh; 30-minute idle timeout; 5-failure phone lockout and per-IP limit; TOTP required off-LAN, optional on-LAN; every action audited with device name and IP | `admin-only-enforcement.test.ts`, `mobile-device-service.test.ts` |
| TOTP | RFC 6238 (SHA-1, 6 digits, 30 s) verified against the published vectors; secret sealed by OS safe storage; single-use codes; a scannable QR code of the `otpauth` URI plus a typeable grouped key | `totp.test.ts` (9), `totp-service.test.ts` (9), `qr-code.test.ts` (10) |
| HTTPS on LAN | Local CA + server certificate for the current addresses, auto-renewed when the PC's address changes; onboarding steps for Android and iPhone full trust; plain HTTP is never offered | `mobile-access-integration.test.ts`, `MobileAccessPreview.test.tsx` |
| Network fallbacks | All LAN addresses, friendly `infoflex-<name>.local` name, hotspot guidance, and the documented reason Bluetooth is not used for mobile access | `MobileAccessPreview.test.tsx`, `keep-running.test.ts` (host-name tests) |
| Firewall | Detects a missing/blocking rule on the Private profile, explains it in plain words, and repairs with a one-click, private-profile-only rule; a failed query never fakes "blocked" | `keep-running.test.ts` (8 firewall tests) |
| Keep running | Tray icon with live phone count and Quit, close-hides-while-mobile-is-on, start with Windows (default on), sleep blocker held only while a phone is connected, and a written warning about sleep | `keep-running.test.ts` (7 keep-running tests) |
| Approvals queue | DISCOUNT / CREDIT / RETURN / VOID in one queue; Admin or Supervisor decisions with conditional writes so a double decision is impossible; credit is Admin-only; live WebSocket broadcast plus polling; amounts in shop currency | `approval-queue-service.test.ts` (7), `ApprovalsPanel.test.tsx` (7) |
| Concurrency | Optimistic locking on product/stock/purchase rows (existing) plus idempotency keys on stock adjustments and stocktakes, reusing the existing `idempotency_keys` table | `idempotency.test.ts` (8), `product-inventory-service.test.ts` |
| Licence | An expired or suspended licence refuses every mobile login and route except the licence-status route, which answers with a licence-specific message | `admin-only-enforcement.test.ts` ("refuses every login when the licence has expired…", "reports an expired licence to the phone…") |
| Money on the phone | Integer minor units plus the currency definition from the API; formatted on the phone, never a hard-coded symbol | `money-format.test.ts` (6) |

Verification for this phase: `npm run check:phase9` — 40 test files, 317 tests, all passing.

**Not tested here, and honestly marked untestable in this environment:** no real Android or iPhone was used, so
certificate trust, Add to Home Screen, a real phone camera scanning the on-screen QR code, and a real
authenticator app are unproven (this harness uses the loopback interface with generated certificates). What
*is* proven here is that the two QR images the desktop draws decode back to the exact address and the exact
`otpauth` URI with an independent decoder (`jsQR`, via `npx tsx scripts/verify-qr-code.ts`), including the
version-7 and version-9 symbols the longer authenticator URIs need. No clean Windows machine was available,
so the tray icon, minimise-to-tray, start-with-Windows, the `powerSaveBlocker`, firewall detection and repair,
and DPAPI-backed `safeStorage` in a packaged build are exercised only through injected fakes. The manual
checklist for these is in [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md).

## Phase 10 — The Admin's phone app (Admin-only React PWA)

Phase 10 turns the served mobile shell into the full Admin phone app: a React-free, plain-DOM PWA served by the
host, with dashboard, stock, sales, approvals, reports and phone management. It is Admin-only by construction:
there is no cashier mode and no selling screen anywhere in it. Completed by `npm run check:phase10`.

| Requirement | What was delivered | Evidence |
| --- | --- | --- |
| Served by the host | The host serves the built `out/mobile` app at `/` with hashed assets, `manifest.webmanifest`, icons and `service-worker.js`; hashed assets are immutable, the worker is `no-store`, and the API is `cache-control: no-store` | `served-mobile-app.test.ts` (3 tests, drives the real `createHostApi` against the real build) |
| App shell only is cached | The worker pre-caches `/`, the manifest, the icons and the hashed entry assets, never `/api/`; an offline asset request fails instead of receiving the HTML shell; the cache name is derived from the shell content so a rebuild replaces it | `mobile-shell.test.ts`, `service-worker.js` (stamped by `scripts/stamp-mobile-shell-cache.ts`) |
| Splash, logo and install guide | A navy/gold splash paints before any script runs; manifest icons at 180/192/512 plus a maskable icon; the More screen carries the Android "Add to Home screen" and the "iPhone (Safari) → Share → Add to Home Screen" steps, with the Safari requirement stated | `admin-screens.test.ts`, `mobile-shell.test.ts`, `served-mobile-app.test.ts` |
| Header shows the store name | The header reads the store name from the host's shop settings on every load, never a hard-coded name | `served-mobile-app.test.ts` ("the store name"), `admin-screens.test.ts` |
| Admin login, no cashier mode | The login screen is labelled "Admin login"; a non-Admin gets the one generic sentence, audited; every Admin API call re-reads the user row, so demotion or a lock bites on the next request. No selling screen or cashier mode exists | `mobile-admin-service.test.ts` ("refuses every route for a Cashier or Supervisor", "cuts the phone off the moment the Admin is demoted"), `mobile-admin-routes.test.ts`, `served-mobile-app.test.ts` (Cashier → 403 on the served API) |
| Offline behaviour | "Connecting to shop…" while a screen loads, "Offline — … Nothing new can be saved until you reconnect" when the phone is offline; every write is refused on the phone before the network is touched, so a financial or stock write is never queued | `admin-client.test.ts` (OfflineError with `fetch` never called), `mobile/src/main.ts` banners |
| Barcode scanning | Camera scanning through a lazily imported ZXing chunk (~380 kB, only fetched when the scanner opens), a torch toggle that explains itself when the phone has no torch, and manual entry as the always-available fallback | `scan-sheet.ts`, `barcode-scanner.ts`, `served-mobile-app.test.ts` (a separate `barcode-scanner` chunk in the build) |
| Dashboard | Today's and this month's sales and net, low stock, near expiry, expired, pending approvals, connected phones and sales by cashier today, each in the shop's currency | `admin-screens.test.ts` (dashboard, 0-decimal shop), `mobile-admin-service.test.ts` |
| Stock | Search or scan, stock, batches and expiry, product edit, add a product by scanning an unknown barcode, price changes with Admin password re-entry, stock adjustment with a mandatory reason, receiving stock with batches and expiry, stock history, and a "changed, reload" 409 on a stale screen | `mobile-admin-service.test.ts` (5 stock tests), `admin-screens.test.ts` (6 stock tests), `mobile-admin-routes.test.ts` (409 `reloadRequired`), `served-mobile-app.test.ts` |
| Reports | Daily and monthly summary, sales by cashier, a daily chart, and a PDF share produced by the host's own report exporter and handed to the phone's share sheet | `admin-screens.test.ts`, `mobile-admin-routes.test.ts` (PDF as base64), `mobile-admin-service.test.ts` |
| Sales (view only) | Browse and search receipts and wholesale invoices, open one, share it as a PDF (built on the phone) or as an image, print at the counter; a completed sale is described as view-only and can never be edited | `admin-screens.test.ts`, `receipt-document.test.ts`, `mobile-admin-service.test.ts` ("never exposes a way to create one") |
| Approvals | Discount, credit, return and void requests raised at the desktop appear on the phone and are approved or rejected there, exactly once, with "already decided" on a stale screen; credit stays Admin-only | `mobile-admin-service.test.ts` (3 approval tests), `admin-screens.test.ts` |
| Cashier permissions | The wholesale toggle, with the Admin password, copying the rest of the cashier's permissions unchanged; user creation and password setting stay on the desktop | `mobile-admin-service.test.ts` ("lets the Admin switch a cashier's wholesale permission…"), `admin-screens.test.ts` |
| Devices | The paired phones are listed with platform, last use and connected state, and each one can be revoked with the Admin password; a revoked phone fails on its next call | `mobile-admin-service.test.ts` (2 devices tests), `mobile-admin-routes.test.ts` ("lists the Admin's paired phones and revokes one only with the Admin password"), `admin-screens.test.ts` (2 device tests) |
| Currency | Amounts arrive as integer minor units plus the shop's currency definition and are formatted by `mobile/src/money.ts` with the desktop's own formatter; price boxes accept the shop's separators, prefill in the shop's decimal places, refuse more decimals than the currency allows, and send a plain decimal; there is no currency switch and no hard-coded symbol in the shell | `money.test.ts` (18), `admin-screens.test.ts` ("prefills price boxes…", "refuses a price with more decimals…"), `mobile-admin-service.test.ts` (0-decimal shop), `served-mobile-app.test.ts` (only the currency table may spell a symbol) |
| Weak connection / mid-range phones | The shell is one ~68 kB entry bundle (20 kB gzipped) plus the CSS; the scanner is the only large chunk and is loaded on demand; skeleton loaders on every screen before data arrives; no layout jumps in the fixed tab bar | build output, `admin-screens.test.ts` (skeleton tests) |
| Web Push | **Not delivered.** In-app badges (the approvals tab count and the dashboard tiles) are the fallback, as the brief allows; see DECISIONS.md | — |

Verification for this phase: `npm run check:phase10` — 47 test files, 398 tests, all passing.

**Not tested here, and honestly marked untestable in this environment:** no real Android or iPhone was available,
so "Install this app" / Add to Home Screen, the installed-app splash and theme colours, a real camera scanning a
real barcode, the torch on a real device, the OS share sheet receiving the generated PDF and image, print at the
counter, iOS 16.4 push-gating and Safari-only behaviour are **unproven** — and browser automation could not be
installed here at all (`npx playwright install chromium` fails with `ECONNRESET`, and there is no system browser).
What *is* proven is the served build itself (the real `out/mobile` through the real host, including the Cashier
refusal on the served API), every screen's markup through a small DOM shim, the client's offline and 409
handling, and the receipt/PDF bytes. No Web Push subscription exists, so no push notification was delivered. The
manual checklist for the device work is in [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md).

## Phase 11 — Vendor Cloud (licence server, vendor portal and internet relay)

Phase 11 builds the vendor's side of the product: the cloud a shop's copy of Infoflex talks to, the portal the
vendor sells and renews from, and — for shops whose licence grants it — the relay that lets the Admin's phone reach
the till over mobile data. It ships as **two builds that speak one contract**: `cloud/src` (Node, includes the
relay) and `cloud/php` (PHP 8.1 + MySQL, no relay), so a vendor on a US$3 shared host and a vendor on a VPS give
their customers the same licensing behaviour.

| Requirement | What was delivered | Evidence |
| --- | --- | --- |
| Licence tables, no business data | `vendor_users, sessions, customers, licenses, license_history, checkins, relay_connections, audit_log, activation_attempts, schema_migrations`; `ALLOWED_COLUMNS` enumerates every column in both builds, and the public API refuses shop data with `400 business_data_not_permitted` | `cloud/tests/schema.test.ts`, `cloud/php/tests/run.php` |
| Activation, check-in, offline file, public key, admin API | The four calls the desktop already used (`/api/license/config`, `activate`, `check-in`, `public-key`) plus the portal's own admin actions | `cloud/tests/license-flow.test.ts`, `cloud/tests/portal.test.ts` |
| Rate limiting and logged activations | 12 per address and 10 per key per 15 minutes, keyed by a SHA-256 of the key; every attempt audited | `cloud/tests/license-flow.test.ts`, `cloud/php/lib/service.php` |
| Vendor-approved rebind | A licence binds to one machine; a second machine is a 409 until the vendor presses **Reset machine binding**, which is audited | `license-flow.test.ts` ("rejects a second machine until the vendor rebinds"), `portal.test.ts` |
| Currency code only, never amounts | `default_currency` is an ISO code plus a lock flag; a schema test refuses any money-shaped column | `schema.test.ts`, `php-build.test.ts` (money-column scan) |
| Portal: argon2id, mandatory TOTP, Owner/Staff, timeout, audit | Passwords hashed with argon2id where available (bcrypt fallback), TOTP enrolment forced on first sign-in, 30-minute sliding session, 8 failures → 15-minute lock, every mutation audited with actor, address and time | `cloud/tests/auth.test.ts`, `php/tests/run.php` |
| Customers and licences with search and filters | Active, expiring in 30 days, expired, suspended, online now, and on-site reported | `portal.test.ts`, `cloud/src/portal/pages.ts` |
| Create customer and licence | Edition (Pharmacy/Supermarket/Both), date pickers with 1/2/3/5-year quick selects, mobile LAN and internet toggles, Admin-phone limit, a **default currency dropdown from the full currency list**, and a **Lock currency** checkbox | `portal.test.ts` ("creates a customer and licence…"), `php/tests/run.php` |
| Renew/reactivate, notify now, edit edition, suspend/unsuspend, rebind, offline licence, check-in history, on-site management, activation code, CSV export | All present as portal actions; the till picks a renewal or suspension up on its own polling, with no customer password. The check-in table carries the app version and platform the desktop reported | `license-flow.test.ts` (renewal, suspension, on-site), `portal.test.ts` |
| Expiry reminder dashboard (30/14/7) with optional e-mail | A single job marks each stage once per term and sends one message per stage when SMTP is configured; the dashboard shows the same list when it is not | `cloud/tests/maintenance.test.ts` |
| Navy/gold branding, phone-friendly | Portal CSS is one inline stylesheet with the brand palette and the logo; every page is a single column under 720 px | `cloud/src/portal/styles.ts`, `cloud/tests/portal.test.ts` |
| Relay: outbound WebSocket, real certificate, licence-gated | The shop PC dials `wss://relay/…`; phones reach `https://<shop>.<relay-domain>` under one wildcard certificate; a tunnel needs an active licence with `mobileInternet`, and `disconnectShop()` drops an open tunnel on suspend | `cloud/tests/relay.test.ts`, `src/main/relay-client.test.ts` |
| Relay: end-to-end or documented | **Documented.** The relay terminates TLS and can read what it forwards; `cloud/docs/RELAY-LIMITS.md` states the limit with numbers, the portal repeats it, and the screen where the Admin enables it repeats it again | `cloud/docs/RELAY-LIMITS.md`, `MobileAccessPreview.test.tsx` |
| Relay: caps and rate limits | 16 concurrent streams per shop, 8 MiB request bodies, 64 KiB frames, 600 requests and 24 MiB per shop per minute, 12 sockets per address, 20 s request and 45 s idle timeouts | `cloud/tests/relay.test.ts` |
| Relay: online/offline-only status in the portal | `relay_connections` carries status, timestamps, frames and byte counts, surfaced on the licence page | `cloud/tests/relay.test.ts` ("marks the shop offline when the PC disconnects") |
| Security: HTTPS, hardened headers, CSRF, validation, env-only secrets, backups, NDPA privacy notice | HSTS, `nosniff`, `DENY`, `no-referrer`, a strict CSP on `/portal` and `script-src 'none'`; CSRF token on every form; secrets only from the environment or a mounted file; a daily verified snapshot keeping 14; a publishable NDPA 2023 template | `cloud/tests/secrets.test.ts`, `cloud/tests/maintenance.test.ts`, `cloud/docs/PRIVACY-NOTICE.md` |
| Terminal-free deployment, costs, and an honest list of what needs a developer | `cloud/docs/DEPLOYMENT.md` is click-by-click for both builds; `cloud/docs/COSTS.md` gives monthly figures for each; Part 10 names the two steps that genuinely need a command line | `cloud/docs/DEPLOYMENT.md` |
| Desktop half of the relay | `src/main/relay-client.ts` dials out, answers with the shop's own listener, and mints the phone's link from a per-shop key; the Admin's switch lives on the Mobile Access screen and is off by default | `src/main/relay-client.test.ts` (real relay, real client, real listener) |

Verification for this phase: `npm run check:phase11` — 56 test files, 510 tests, all passing, plus typecheck, the web/PWA builds and the Electron bundle.

### The DONE WHEN list, as proved by the suite

| Criterion | Where it is proved |
| --- | --- |
| 1. Portal-created licence activates and preselects its currency | `cloud/tests/license-flow.test.ts`, and end to end on the real desktop in `src/license/license-manager.test.ts` ("a licence sold in the vendor portal, on the real desktop"): the real `LicenseManager` activates against the cloud's real API and `SetupService` preselects the locked currency |
| 2. A locked currency cannot be changed by the customer | the same desktop test completes setup on the locked currency and then fails the very guard Settings calls (`assertCurrencyChangeAllowed`); the claims carry `lockCurrency` and the lock is re-applied on every check-in |
| 3. The end date locks the app | `license-flow.test.ts` signs an expired licence; `src/license` runtime tests cover the lock, and a lock never deletes data |
| 4. Vendor extends from a phone and the app unlocks by itself | the desktop test extends at the portal on an expired licence and the real manager's next check-in makes it usable again, with no customer password; polling is 24 h active / 60 s expired, ticking every 15 s |
| 5. Suspend/unsuspend with grace, including a reported on-site licence | two `license-flow.test.ts` cases, one of them on-site, plus suspend → unsuspend observed on the real desktop manager; the relay additionally drops the tunnel (`relay.test.ts`, `relay-client.test.ts`) |
| 6. A licence file for another machine is rejected | `license-flow.test.ts` "refuses a licence file issued for a different machine" |
| 7. Rebind only from the portal | `license-flow.test.ts` "rejects a second machine until the vendor rebinds", and the real desktop's second machine is refused in `license-manager.test.ts`; the desktop has no rebind command |
| 8. Admin phone on mobile data reaches the PC; cashier refused | `src/main/relay-client.test.ts` (real cloud relay + real client + real listener: Admin 200, no credential 401, cashier 403) |
| 9. The relay cannot read traffic, or the limitation is documented | **Documented** — `cloud/docs/RELAY-LIMITS.md`, repeated in the portal and on the screen where the Admin enables it. `cloud/tests/portal.test.ts` fails the build if any portal page drifts back to claiming end-to-end encryption or an unreadable relay: an earlier draft of that page did exactly that, said in good faith, and was wrong |
| 10. No private key or master password in plain text | `cloud/tests/secrets.test.ts` walks the repository, the example environment file and the installers' inputs |

**Not tested here, and honestly marked untestable in this environment:** there is no browser and no phone, so the
portal's pages are proved through Fastify's `app.inject` (real routing, real HTML, real CSRF) rather than a
screenshot, and the "phone" in the relay test is an HTTP request rather than a handset — a real iPhone or Android on
real mobile data is a hardware gate, carried in [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md). No MySQL server is
reachable, so the PHP build's MySQL DDL is exercised against SQLite and its Ed25519 signing is proved through a
test-only signer seam, because the WebAssembly PHP available here has no Ed25519 in its OpenSSL; the production
`openssl_sign(..., 0)` path is asserted statically. The DNS and certificate steps in the deployment guide are
click-by-click instructions that no test can perform. The relay's documentation of its own limit is a deliberate
choice, not a gap papered over: nobody reading it is told the traffic is end-to-end encrypted.

## Verification commands

| Command | What it proves |
| --- | --- |
| `npm run typecheck` | No TypeScript errors across host, renderer, preload, PWA and tooling. |
| `npm test` | Full automated suite (reports, POS, returns, inventory, licensing, mobile API, PWA shell/worker, packaging contract). |
| `npm run build:web` | Browser preview bundle builds. |
| `npm run build:mobile` | PWA bundle builds and the service worker is stamped with the shell cache/asset list. |
| `npm run build` | Electron main/preload/renderer production bundle builds. |
| `npm run check:phase7` | All of the above in sequence (Phase 7 bundle). |
| `npm run check:phase8` | All of the above in sequence (Phase 8 bundle). |
| `npm run check:phase9` | All of the above in sequence. |
| `npm run check:phase10` | All of the above in sequence. |
| `npm run check:phase11` | All of the above in sequence, including the cloud and PHP suites (current phase bundle). |
| `npm run cloud:test` | The cloud suites only (8 files: schema, auth, licence flow, portal, relay, maintenance, secrets, PHP build). |
| `npm run php:test` | The PHP build's own 32-check suite, with a local PHP 8 binary. |
| `npx tsx scripts/verify-qr-code.ts` | The QR images decode with an independent decoder (needs `npm install --no-save jsqr`; not part of `npm test`). |
| `npm run dist:win` | Windows NSIS packaging entry point; run on Windows and complete the release checklist. |
