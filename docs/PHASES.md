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
| 12 | Polish and test everything: one navy/gold/off-white palette across desktop and phone, optional demonstration datasets the Admin can load or remove, and the full unit / API-security / end-to-end test sweep with an honest pass/fail matrix | **DONE (software); emulator and hardware gates owed — see the matrix below** |
| 13 | The graphical customer installer: `Infoflex Setup.exe` and `Infoflex Setup Offline.exe`, with a vendor password gate, a Region and Currency page, an accurate system check, verified downloads from an allowlist, offline install, and Repair/Update/Uninstall | **DONE (software); cannot be compiled or clicked in this environment — see the checklist below** |
| 14 | Build Studio, the vendor's graphical tool: prerequisites and one-click build with no terminal, artefacts with checksums, the licence key generator, the `.iflpolicy` policy page, and the per-build currency/limit settings that reach the installer and the app | **DONE (software); Windows gate 6 owed** |
| 16 | Client/server foundations: the four-role vocabulary and one declarative permission table enforced at both boundaries, migration 16's order/payment/device/audit tables, server-only database ownership proven by a static check | **DONE (software); 1 hardware gate owed** |

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
| 3. The end date locks the app | the desktop test moves its clock past the sold end date and the real manager reports `expired` with `canUse: false`; `license-flow.test.ts` signs an expired licence, `src/license` runtime tests cover the lock, and a lock never deletes data |
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

## Phase 12 — Polish and test everything

### What was built

| Item | Where |
| --- | --- |
| Demonstration dataset: 30 pharmacy SKUs with batches, 60 supermarket SKUs across `Fresh`/`Grocery` (6 weighed, priced per kg), 2 promotions, 3 sample accounts | `src/services/demo-data-service.ts`, types in `src/shared/demo/types.ts` |
| Load / remove, Admin-only, in one transaction, removable before real use | `DemoDataService`, migration `015_demo_data_removal.ts`, IPC `demo:get-status` / `demo:load` / `demo:remove` |
| The Admin's panel: counts, sample logins, in-use warning, confirm-gated load and remove | `DemoDataPanel` in `src/renderer/src/ui/SettingsPanels.tsx`, shown by `SettingsScreen.tsx` |
| Prices scaled to the shop's currency: integers for 0-decimal currencies, three places for 3-decimal, never zero or negative | `CURRENCY_SCALE` / `scaleMajor()` |
| One palette on every surface | `styles.css`, `mobile-access.css`, `mobile/src/style.css` |
| A currency-parsing bug found by the sweep and fixed | `stripCurrencyToken` in `src/currency/parse.ts` |

### Test matrix — the brief's checklist

Legend: **Pass** = an automated test asserts it here. **Emulator only** = no browser or phone exists in this
build environment (`npx playwright install` cannot fetch a browser), so it is proved at the API or DOM level and
the pixel-level step is carried to [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md). **Manual** = a physical step.

#### Unit tests (§3 of the brief)

| Requirement | Result | Evidence |
| --- | --- | --- |
| Retail vs wholesale pricing | Pass | `point-of-sale-service.test.ts`, `product-inventory-service.test.ts` |
| Wholesale permission enforcement | Pass | `point-of-sale-service.test.ts`; live round trip in `pos-currency-end-to-end.test.ts` (`canMakeWholesaleSale` true for the wholesale-on cashier, false for the off one) |
| FEFO | Pass | `point-of-sale-service.test.ts` (batch snapshots, expiry blocking), `product-inventory-service.test.ts` |
| Promotions and loyalty | Pass | `point-of-sale-service.test.ts` (percent/fixed promotions, loyalty earn and debt repayment) |
| Return limits | Pass | `return-service.test.ts` (over-limit pending, self-approval refused, window override) |
| Daily and monthly totals | Pass | `accounting-report-service.test.ts`, hand-calculated per currency incl. the 30/31-day monthly rows |
| Licence dates | Pass | `license-manager.test.ts` (exclusive end date, grace, expiry keeps data) |
| Signatures | Pass | `license-crypto.test.ts` (Ed25519, altered payload, untrusted key) |
| Machine binding | Pass | `license-crypto.test.ts`, `license-manager.test.ts` (copied binding, rebind paths) |
| Edition flags | Pass | `accounting-report-service.test.ts` (Pharmacy vs Supermarket report sections), `product-inventory-service.test.ts` |
| On-site licence periods: no cap by default, optional cap | Pass | `license-manager.test.ts` ("1, 3, and 5 years when no maximum is configured", "enforces an optional Build Studio maximum") |
| Store-name snapshot | Pass | `point-of-sale-service.test.ts` receipt snapshots, `return-service.test.ts`, `report-export-sections.test.ts` |
| Idempotency | Pass | `idempotency.test.ts`; replay in `cross-device-consistency.test.ts` |
| Optimistic locking | Pass | `product-inventory-service.test.ts` (stale writes), `cross-device-consistency.test.ts` (stale phone read refused, no partial write) |
| Currency module: formatting/parsing for **every** built-in currency, 0/2/3 decimals, symbol position, separators, round half up, minor-unit arithmetic, lock after first transaction, vendor-locked currency, custom currency | Pass | `currency.test.ts` — the per-currency sweep covers all 54 codes; lock rows in `settings-phase8.test.ts`, vendor lock in `first-run-authentication.test.ts` and `license-manager.test.ts`, custom currency in `currency.test.ts` + `database.test.ts` |

#### API security tests (§4)

| Requirement | Result | Evidence |
| --- | --- | --- |
| Unauthenticated caller | Pass | `admin-only-enforcement.test.ts`, `mobile-admin-routes.test.ts` |
| Unapproved device | Pass | `admin-only-enforcement.test.ts` |
| Revoked device | Pass | `admin-only-enforcement.test.ts`, `mobile-access-integration.test.ts` (refresh-token reuse revokes) |
| Cashier **and** Supervisor phone login refused at login, at refresh and on every route | Pass | `admin-only-enforcement.test.ts` (identical error, code and audit trail as a wrong password; seven routes swept) |
| Cashier's device-less raw API calls | Pass | `admin-only-enforcement.test.ts` |
| Demoting an Admin cuts the phone off | Pass | `admin-only-enforcement.test.ts` (sessions revoked, devices revoked) |
| Cashier without wholesale permission asking for wholesale on the desktop | Pass | `point-of-sale-service.test.ts`, `pos-currency-end-to-end.test.ts` |
| Expired licence | Pass | `admin-only-enforcement.test.ts`, `license-manager.test.ts` |
| Rate limiting and lockout | Pass | `admin-only-enforcement.test.ts` (five wrong passwords per phone), `rate-limit-state.test.ts` |
| Admin remote login without TOTP | Pass | `admin-only-enforcement.test.ts` (required over the internet, not on the LAN) |
| Changing a locked currency through IPC **and** the API | Pass | `locked-currency-channels.test.ts` — real IPC handler, host controller, and seven guessed phone routes |

#### End-to-end tests (§5)

No browser can be installed in this environment (`playwright install` fails; there is no system Chromium), so the
"desktop" end-to-end rows run the **real host** — real SQLite, real migrations, real services, the real
`DesktopHostController` that IPC and the mobile API both sit on — rather than a driver clicking pixels. That
proves the behaviour and the arithmetic; it does not prove layout.

| Scenario | Desktop result | iPhone / Android emulator |
| --- | --- | --- |
| Installer currency carried into first-run | Pass — `first-run-authentication.test.ts` | n/a (desktop) |
| Activation per edition: online | Pass — `license-manager.test.ts` | n/a |
| Activation per edition: file | Pass — `license-manager.test.ts` (bound to its machine) | n/a |
| Activation per edition: on-site with internet disabled, multi-year period | Pass — `license-manager.test.ts` (1/3/5 years, no network, optional cap) | n/a |
| First-run with store name + currency | Pass — `first-run-authentication.test.ts` | n/a |
| First-run rejects an empty store name | Pass — `first-run-authentication.test.ts`, `pos-currency-end-to-end.test.ts` | n/a |
| Desktop login per role | Pass — `first-run-authentication.test.ts` (Admin, Supervisor, Cashier) | n/a |
| A sale to receipt in NGN, USD, JPY, KWD | Pass — `pos-currency-end-to-end.test.ts` (sale → receipt → reprint → report, per currency) | Emulator only — receipt rendering is asserted as markup, not a screenshot |
| The phone draws and accepts those amounts in each currency | Pass — `mobile-currency-routes.test.ts`: a real sale in each currency, read back over the real admin routes (dashboard, product, sale, report), then formatted and re-parsed by the phone's own money module | Emulator only — layout unproven |
| The phone on a Pharmacy, Supermarket **and** Both licence | Pass — same file: the report and its money on each of the three editions, with the edition-specific panels following the licence | Emulator only |
| A wholesale sale by a cashier on desktop | Pass — `pos-currency-end-to-end.test.ts` | n/a |
| A return | Pass — `return-service.test.ts` | Emulator only |
| Reports and Excel export | Pass — `accounting-report-service.test.ts` (opened with `exceljs`, real cell values and formats), `report-export-sections.test.ts` | n/a |
| Expiry lock | Pass — `license-manager.test.ts` | n/a |
| Online renewal | Pass — `license-manager.test.ts` (vendor renews, next check-in unlocks, no customer password) | n/a |
| On-site renewal | Pass — `license-manager.test.ts` | n/a |
| Pairing and approval | Pass — `mobile-access-integration.test.ts` over a real HTTPS listener | Emulator only — a real camera scan and install prompt need a handset |
| Admin editing stock on the phone | Pass — `mobile-admin-service.test.ts` | Emulator only — touch layout unproven |
| Admin approving a cashier's request from the phone | Pass — `mobile-access-integration.test.ts`, `approval-queue-service.test.ts` | Emulator only |
| Cashier blocked from the phone | Pass — `admin-only-enforcement.test.ts` | Emulator only |

#### Cross-device scenario (§6)

| Scenario | Result | Evidence |
| --- | --- | --- |
| Admin adjusts stock on the phone while a cashier sells the same item on desktop; totals, stock and audit log stay consistent | Pass | `cross-device-consistency.test.ts` — the phone's stale read is refused rather than overwriting the sale, the refusal is a no-op, a retry succeeds, a replay is idempotent, stock reaches zero exactly, an over-sell is refused, and the report total and audit actors agree |

#### Per edition, per currency, per platform

| Edition | NGN | USD | JPY | KWD | Other built-ins |
| --- | --- | --- | --- | --- | --- |
| Pharmacy (desktop) | Pass | Pass | Pass | Pass | Pass (currency module sweep) |
| Supermarket (desktop) | Pass | Pass | Pass | Pass | Pass (currency module sweep) |
| Both (desktop) | Pass | Pass | Pass | Pass | Pass (currency module sweep) |
| Pharmacy / Supermarket / Both (phone API) | Pass | Pass² | Pass² | Pass² | Pass (currency module sweep) |

*² NGN is proven on all three editions; the other three currencies are proven on **Both**, and the edition
switches are proven in NGN. The two axes are tested separately rather than as a nine-cell product.*

*The phone-API row is backed by `src/api/mobile-currency-routes.test.ts`, which was written after the matrix
first claimed it: the route layer previously had no money test in ANY currency. Writing it found two
defects, both now fixed and both covered by tests that fail without the fix.*

*The whole matrix was then re-audited row by row — every cited file opened and the claimed scenario located in it
— because a matrix that was wrong once cannot be trusted on inspection. Every other row held. Two gaps were found
and closed: the phone-API row had only ever run the **Both** edition, and the store-name-snapshot row cited tests
that do prove it (by renaming the shop and reading an old receipt back) but whose names never mention it. The
edition gap is now covered by tests on all three licences; the snapshot row's citation is unchanged because the
assertions were always there, at `point-of-sale-service.test.ts:196` and `return-service.test.ts:444`.*

| Platform | Automated here | Owed to hardware/emulator |
| --- | --- | --- |
| Windows desktop (Electron) | Host, IPC, preload bridge and DOM tests | Installer, DPAPI `safeStorage`, tray, print output (Gate 1) |
| Desktop web preview | `build:web` succeeds; components render | Nothing functional |
| Admin PWA in Chromium (Android profile) | Served shell, cache and route tests | Install prompt, splash, camera scan, touch layout |
| Admin PWA in WebKit (iPhone profile) | Same served shell and cache tests | Safari install, certificate trust, safe-area layout |
| Physical iOS / Android phone | Not possible here | Gate 2 in the release checklist |

### Two defects found while closing this phase, and fixed

A test matrix is only worth the tests behind it. Checking my own claim that the phone API was proven in all four
currencies showed that **the claim was false** — `src/api/mobile-admin-routes.test.ts` only ever asserted refusals
(403) on the admin routes, never a successful response with money in it. Writing the missing test found:

1. **The phone's reports route answered 500 with money in the shop.** `GET /api/v1/mobile/admin/reports` returned
   `Do not know how to serialize a BigInt`, because the generic route wrapper sent the host's `bigint` minor units
   straight to `JSON.stringify`. Only one older route on the same server called `serializeBigInts`; every route
   added since did not. The refusal tests could never have caught it, because a refusal never reaches the send
   path. **Fixed** by moving the converter to `src/api/serialize-money.ts` and applying it once in the wrapper
   for every phone route. Proved by reverting the fix and watching
   `mobile-currency-routes.test.ts` fail with the exact 500, then restoring it.
2. **The phone refused its own formatted amounts.** `parseMoneyInput` rejected anything containing a currency
   symbol, so an Admin who copied `₦40.00` off the dashboard and pasted it into a price field was told "Enter an
   amount using digits only" — while the desktop's `parseMoney` accepted the same text. **Fixed** by stripping a
   leading or trailing symbol or ISO code (and a minus placed outside the symbol) before parsing, and by refusing
   a negative price with a sentence rather than a regex failure.

Both fixes are regression-covered: `src/api/wire-money.test.ts` tests the converter on nested objects, arrays,
null, a 64-bit amount and binary payloads, and drives a real report through a real Fastify send path in NGN, JPY
and KWD. `mobile/src/money.test.ts` gains the symbol round-trip.

### What could only be tested on emulators, or not at all

- **No browser exists in this build environment.** `npx playwright --version` reports 1.65.1 but
  `npx playwright install chromium` cannot download a browser, and there is no system Chromium. Every "emulator"
  row above is therefore proved at the level below the browser — real HTTP through Fastify's `inject` or a real
  HTTPS listener, real DOM through `mobile/src/test-dom.ts` and jsdom — and the pixel-level step is a manual
  checklist item, not a claim.
- **No phone, no Windows machine, no printer.** Camera scanning, install prompts, certificate trust, safe-area
  insets, printing and DPAPI are Gates 1–4 in [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md).
- **`npm run php:test` cannot run here** (no PHP binary); the identical suite runs through `php-wasm` inside
  `cloud:test` and reports 32 passed.

### Phase 13 — the graphical installer

### What was built

| Item | Where |
| --- | --- |
| The installer itself, one source for two builds | `installer/nsis/installer.nsi` (+ the generated `generated.nsh`, `currency-ui.nsh`) |
| Every rule the installer obeys, as tested pure functions | `installer/src/installer-policy.ts`, `install-config.ts`, `system-check.ts`, `download-allowlist.ts` |
| The PBKDF2 and SHA-256 helper NSIS cannot compute itself | `installer/src/password-check.ts` (+ `password-check-cli.ts`) |
| A static checker for the `.nsi`, because it cannot be compiled here | `installer/src/check-nsis-script.ts`, run by `npm run installer:check` |
| The app reading the installer's choice at first run | `src/main/install-config-reader.ts`, wired in `src/main/index.ts` |
| 24-bit BMP brand assets for MUI | `scripts/png-to-bmp.ts` → `build/installer-banner.bmp`, `build/installer-sidebar.bmp` |
| Both build configurations | `electron-builder.installer-online.json`, `electron-builder.installer-offline.json` |

### Why NSIS and not Inno Setup

Both can do everything the brief asks. NSIS was chosen because electron-builder already drives it, so the
installer and the packaged app come from one build with one version number and one icon set; adding Inno Setup
would mean a second toolchain to keep in step with the app it installs. The cost is that NSIS has no crypto and
a weak macro language — both worked around rather than tolerated: the crypto is a separate tested helper, and
every decision lives in TypeScript. Recorded in `docs/DECISIONS.md`.

### DONE WHEN — the brief's thirteen items

Legend: **Pass** = proved by an automated test or check in this repository. **Could not test** = needs a Windows
machine; the manual step is in `docs/RELEASE-CHECKLIST.md` Gate 5. Nothing here is claimed as clicked.

| # | Requirement | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Opens by double-click with no terminal | **Could not test** | The `.nsi` sets `RequestExecutionLevel admin`, defines no console and builds a MUI wizard; `check-nsis-script.test.ts` asserts there is no console. Launching it needs Windows. |
| 2 | Blocks without the password | **Pass (logic) / could not test (UI)** | `installer.test.ts`: wrong password counted, five attempts lock and stay locked even if the sixth is right, `password-check.test.ts` proves exit 0 only on a match. The page wiring is not clicked here. |
| 3 | Currency page lists the currencies, correct live example for 2-, 0- and 3-decimal, custom currency works | **Pass, per currency** | `installer.test.ts`: all 54 labelled `CODE - Name (symbol)`, searchable by code/name/symbol, custom currency at 0–4 decimals, bad fields refused in plain words. `currency-example-table.test.ts`: **all 54 live examples** transcribed by hand *and* re-derived by a second, independent renderer — the brief judged currency correctness per currency, so three representative examples and a non-empty check was not enough. Verified to fail when one currency's decimals are changed |
| 4 | The chosen currency is preselected on first-run setup | **Pass** | `install-config-reader.test.ts` (file → reader, corrupt file, override), `installer-to-setup.test.ts` (file → reader → repository → `SetupService` context, for GHS/KWD/JPY/EUR and a **custom** currency, policy correctly outranking) and **`install-config-writer.test.ts`**, which reconstructs the file from the installer's own `FileWrite` lines and parses it — the file NSIS emits had never been read by anything, and two escaping defects were hiding there |
| 5 | System Check is accurate | **Pass (rules) / could not test (real machine)** | `installer.test.ts` covers Windows 10/11/too-old/32-bit/unknown, the 1 GB floor, the VC++ runtime found/missing/unprobeable, and that firewall and printer are informational only. The registry probes themselves need Windows. |
| 6 | A missing prerequisite is downloaded from the official URL, verified and installed | **Pass (rules) / could not test (live download)** | `installer.test.ts`: only allowlisted ids resolve, HTTPS + allowlisted host, a mismatched checksum deletes the file, an unsigned or wrongly-signed file is refused, a "browse" pick is held to the same checksum. The actual download needs a network and Windows. |
| 7 | Failed download shows Retry / Browse / Use the Offline installer | **Pass (rules and controls) / could not test (UI)** | `installer.test.ts`: retry offered while attempts remain and withdrawn after the third, browse always offered, offline pointer only when an offline build exists, and a message that stops suggesting retry when retry would be dishonest. The download page draws the three buttons, hides them until a failure, disables Retry at three, and verifies a browsed file with the same checksum as a download. |
| 8 | Offline installer completes with no internet, then activates on-site | **Partial** | The offline build compiles out the download page entirely (`!if INFOPLEX_OFFLINE == 0`), and on-site activation with the master password is proved in `license-manager.test.ts`. Running the offline installer needs Windows. |
| 9 | The app launches and shows Activation | **Pass (app) / could not test (after install)** | `App.tsx` renders `LicenseScreen` whenever `bootstrap.license.canUse` is false, before setup or login; previously covered in the first-run suite |
| 10 | Firewall rule for private networks only; the Admin phone connects after pairing | **Pass (rule text) / could not test (behaviour)** | The `.nsi` adds exactly one rule with `profile=private`; the app's own repair path is covered in `mobile-firewall` tests and `mobile-access-integration.test.ts`. That Windows applies it needs a real machine. |
| 11 | Repair/Update/Uninstall behave, keep data, never change the currency | **Pass (logic) / could not test (UI)** | `installer.test.ts`: only a fresh install may write the currency file, updates and repairs must not, the currency page is hidden for both. The `.nsi` reads `InstallDir` to detect an existing install and skips the write. |
| 12 | Silent install with a valid and an invalid currency behaves correctly | **Pass (logic) / could not test (UI)** | `installer.test.ts`: `/CURRENCY=GHS` accepted with or without quotes and case-insensitively, `/CURRENCY=` empty and `/CURRENCY=NOTACODE` refused with a message naming the switch. **`/CURRENCY=` with an empty value was a bug found while writing this — it used to fall through to the default silently.** |
| 13 | The master password is nowhere in plain text | **Pass** | `installer.test.ts` (the shipped hash and salt are not the password), `check-nsis-script.test.ts` (the script contains no `Handywife`), and `npm run installer:check`, which scans every shipped installer file — verified by deliberately leaking the password into a generated file and watching the check fail |

### The install-config.json that NSIS hand-writes was invalid

The most consequential defect of this phase, because it would have silently discarded every shop's currency
choice on a real machine.

Nothing had ever parsed the file the installer emits. The reader had tests, the TypeScript writer had tests, and
the two were assumed to agree — but NSIS writes the file by hand, and hand-written JSON had two faults:

1. **Values were not escaped.** `"thousandsSeparator": ","` wrote a bare comma inside a string, which is not
   JSON. Every currency would have hit this, so the app would have read no file at all, fallen back to Naira, and
   shown no error anywhere.
2. **`"isCustom"` had no trailing comma** in some paths, and the block wrote `installerKind` twice — once from each
   branch of the `${If}`, because the conditional was malformed.

The fix is `installer/nsis/json-escaping.nsh` (`EscapeJson`, NSIS's JSON escaping by hand) plus a corrected
`FileWrite` block. It is proved by `install-config-writer.test.ts`, which reads the `.nsi`, evaluates its own
`FileWrite` statements and `${If}` branches, applies the companion `EscapeJson`, and hands the result to the real
`parseInstallConfig` — for **all 54 currencies**, both installers, and a custom currency containing a quote and a
backslash. Reverting either defect makes 57 of its 60 assertions fail.

**What could not be made safe, and is refused instead.** A custom currency containing a letter outside ASCII
(`৳`, `د.ك`) cannot be written safely: `\uXXXX` needs a code point, which NSIS cannot produce without a plugin,
and passing the raw characters through depends on the encoding a Unicode NSIS build saves — a guess that cannot be
tested here. `customCurrencyRecordingProblem` therefore refuses such a value *at the moment the customer types it*,
in words that say what to do. Built-in currencies are unaffected: the generator enforces that its table is ASCII.

### The generated installers' own data, tested as text

After the install-config defect the same question was asked of the other two generated files — what would `makensis`
actually read, and has anything ever checked it? Nothing had:

- **`currency-ui.nsh`** — 59 tests. The dropdown's 54 labels and the 54 index-to-fields arms are read out of the
  file and compared, row by row, with the catalogue: same order, same numbering, same seven values. This is the
  quiet failure the phase is most exposed to — row 7 listing Ugandan shillings while selecting it sets Kenyan ones
  would install a shop with the wrong money while every other test in the repository passed.
- **`generated.nsh`** — 62 tests. Every `CUR_n_*` define compared with the catalogue, the password define proven to
  be the hash and not a password (and the file proven to contain *only* the salt, hash and iteration defines), the
  download URL proven to come from the allowlist resolver rather than a typed string, and the unpinned checksum
  pinned as a deliberate fails-closed state.

Both also assert the committed file is byte-identical to what the generator produces, so a hand edit is caught
rather than silently reverted by the next `npm run installer:script`. Both were verified to fail when sabotaged:
swapping two dropdown rows and changing one currency's decimals each break exactly the right assertions.

### What this environment could not do, and what is owed

- **The installers cannot be compiled here.** `electron-builder --win nsis` fails downloading its Windows
  toolchain (`unable to verify the first certificate` — the sandbox intercepts TLS), `makensis` is not installed
  and cannot be installed (the npm `makensis` package is only a wrapper around a binary that is not there), and
  there is no Wine to run a Windows compiler. **So no `.exe` exists in this repository, and none was tested.**
  This is a hard environmental limit, not a shortcut.
- **Nothing was clicked.** No Windows machine, so pages, tab order, control layout, the UAC prompt and the
  firewall rule's real effect are all unproven by machine. `docs/RELEASE-CHECKLIST.md` Gate 5 is the click-by-click
  script for doing that.
- **The live prerequisite download was not performed.** Its allowlist, checksum and signature rules are tested;
  the network fetch is not.

### Two holes in the checker itself, found while closing item 7

The static checker matters more here than a linter normally would, because the script it checks can never be
compiled in this environment — whatever it misses ships unexamined. Writing the three-button page exposed two
things it had been missing:

1. **It stopped checking macros as soon as the script had an include.** The rule was "if a companion include is
   present, an unknown macro may come from it" — which is true, and also switched the check off for the most
   macro-dense file in the project. The checker now reads the companion files and accepts a name only if it is
   really defined there.
2. **It never validated `${Macro}` invocations at all** — only `!insertmacro`. That is how nearly every macro is
   actually used, so `${NSD_CreateButon}` would have reached the Windows build machine and failed there. It now
   checks them against the LogicLib set, the nsDialogs control and operation vocabulary, the standard-header
   macros *together with the header each needs*, the script's own `!define`s and its companions. A first attempt
   accepted any name starting `NSD_`, which would have waved the typo straight through — a test now pins the
   misspelling so it cannot come back.
3. A smaller one: a bare `Section` with no name was not recognised as a block opener, so its `SectionEnd` was
   reported as unmatched. The real script uses named sections, which is why it never showed.

## Verification commands

`npm run check:phase12` runs typecheck, the full suite, the web build, the PWA build and the Electron bundle.

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
| `npm run check:phase11` | All of the above in sequence, including the cloud and PHP suites. |
| `npm run check:phase12` | All of the above in sequence (current phase bundle). |
| `npm run check:phase13` | All of the above, plus generating the installer includes and running `installer:check`. |
| `npm run check:phase14` | Typecheck, the whole suite, and bundling the Build Studio window. |
| `npm run check:phase15` | Everything, plus the secret scan and assembling `/release`, `/tools` and `/cloud-package` (current phase bundle). |
| `npm run installer:compile` | **Builds makensis from source and compiles all four shapes for real** -- online, offline, offline wrapper, and the uninstaller pass. Proves every page, function, macro and instruction resolves. Stops at the final write because the stub is a placeholder -- see DECISIONS.md for what that does and does not prove. |
| `npm run release:scan` | Searches source, builds, cloud package and installer sources for the master password (plain, base64, hex, punctuation-stripped) and for private-key material. **Plants both first and refuses to report unless it finds them**, so a clean result means something. |
| `npm run release:assemble` | Copies the deliverables into `release/`, `tools/` and `cloud-package/`, writes `release/SHA256SUMS.txt`, and names every missing artefact with its reason in the release manifest. |
| `npm run studio` | Bundles and starts Build Studio. **Needs a display and an Electron runtime that can open a window.** |
| `npm run dist:studio` | Packages Build Studio for Windows. **Needs Windows; fails in this environment.** |
| `npm run cloud:package` | Writes `dist/cloud/infoflex-vendor-cloud.zip` — the cloud source, docs and PHP build, with no `.env` or key inside. |
| `npm run artefacts:verify` | Lists every artefact the build promised with its SHA-256, writes `dist/artefacts.json`, and **exits non-zero if one is missing**. |
| `npm run installer:check` | Generated includes present and current, `.nsi` structurally sound, no master password in any shipped installer file, brand bitmaps valid. |
| `npm run installer:online` / `installer:offline` | Build the two installers. **Needs a Windows machine or Wine; fails in this environment.** |
| `npm run cloud:test` | The cloud suites only (8 files: schema, auth, licence flow, portal, relay, maintenance, secrets, PHP build). |
| `npm run php:test` | The PHP build's own 32-check suite, needs a local PHP 8 binary (none exists in the environment this phase was built in, so here the identical suite runs inside `php-wasm` as part of `cloud:test` and reports `32 passed, 0 failed`). |
| `npx tsx scripts/verify-qr-code.ts` | The QR images decode with an independent decoder (needs `npm install --no-save jsqr`; not part of `npm test`). |
| `npm run dist:win` | Windows NSIS packaging entry point; run on Windows and complete the release checklist. |

---

## Phase 14 — Infoflex Build Studio

**Status: DONE (software); Windows gate 6 owed.**

The vendor's own tool: it takes the project folder and produces the customer's installers on a Windows machine,
with no terminal at any point. "DONE (software)" is meant in the house sense defined at the top of this file: built,
reviewed, and covered by the automated suite. It does not mean the window has been seen or the installers produced —
neither has happened, and both are owed to Gate 6 of `docs/RELEASE-CHECKLIST.md`.

### What was built

| Item | Where |
| --- | --- |
| The window: seven screens, brand palette, no framework | `buildstudio/index.html`, `buildstudio/ui.ts` |
| The Electron shell: window, dialogs, hidden processes, IPC | `buildstudio/main.ts`, `buildstudio/preload.ts` |
| The rules, as pure functions with tests that run anywhere | `buildstudio/src/`: `build-steps.ts`, `prerequisites.ts`, `runner.ts`, `system-check.ts`, `settings-store.ts`, `artefacts.ts`, `licence-keys.ts` |
| The per-build settings three programs share | `installer/src/build-profile.ts`, read by the installer generator and by the app at first run |
| One command to produce and start the tool | `scripts/build-studio.ts`, `npm run studio` |
| The Windows packaging config | `electron-builder.buildstudio.json`, `npm run dist:studio` |

### DONE WHEN — the brief's three items

Legend as before: **Pass** = proved by an automated check in this repository. **Could not test** = needs Windows or a
display; the manual step is in `docs/RELEASE-CHECKLIST.md` Gate 6. The tool's window has never been opened in
Electron, and no Build Studio installer has been produced.

Each item is tagged with what actually stands behind it. **Verified by tests** means an automated check in this
repository proves the behaviour. **Needs manual check on real hardware** means the software half is proved and the
clicking, the OS behaviour or the packaged run is not — the step is named, and lives in Gate 6.

| # | DONE WHEN | Verified by tests | Needs manual check on real hardware |
| --- | --- | --- | --- |
| 1 | One click builds everything | The twelve-step plan resolves and **every step names an npm script that exists** (`build-steps.test.ts` reads `package.json`); grouping, weights and failure explanations are covered; `ui.test.ts` presses *Build everything* in a real DOM and asserts the group runs and the window lands on Output; `main.test.ts` runs the handler that orchestrates it. | That the Electron window opens at all; that a **clean Windows PC with no Node, Git, Python or build tools** can be brought to two finished installers by pressing one button, with no terminal. Gate 6 → *The one-click build on a PC with no developer tools*. |
| 2 | The on-site licence cap is enforced | `license-manager.test.ts`: a 3-year build **refuses** an `endsOn` five years out with `/maximum on-site period is 3 years/i` and leaves the licence **unactivated**, while a `null`-limit build **accepts the identical input**; a second test walks nine term/limit combinations so the boundary is checked in both directions. | That the cap survives into a *packaged, installed* build and that the on-site screen behaves on a real machine — the 3-year-versus-no-limit comparison on one PC. Gate 6 → *The build profile reaching the customer*. |
| 3 | The build's default currency is preselected, and locked when the vendor locked it | `build-profile-wiring.test.ts` (6): a Ghana-locked profile reaches `generated.nsh` as `INSTALLER_DEFAULT_CURRENCY "GHS"`, `INSTALLER_CURRENCY_LOCKED 1`, and the row `INSTALLER_DEFAULT_INDEX` points at is **verified to be the cedi**; the same file is what `extraResources` packs for the app. `settings-store.test.ts` round-trips it through the shared parser; `install-config-reader` / `installer-to-setup` carry it into first-run setup. | That the **compiled installer** opens on the cedi and that the field is genuinely read-only on a clean VM, and that first-run setup shows it locked too. Gate 6 → *The build profile reaching the customer*. |
| — | The private signing key and the master password never reach the interface, the logs or a build | `ui.test.ts` asserts the rendered page and `document.body` contain no `PRIVATE KEY`; `main.test.ts` reads the **real log file** back and proves neither the right nor the wrong password is in it, that the key's contents are not logged, that the key is written only to the dialog's path with mode `0600`, and that a settings file containing `PRIVATE KEY` is **refused**; `npm run installer:check` scans 18 shipped installer files, verified to fail when the password is deliberately leaked into one. | Nothing. This one is entirely provable in software, and is proved. |

### What Build Studio actually writes (and what it does not)

The brief for this close-out asks about a `vendor-config.json`. **There is no such file, and there never was** — a
search of the whole repository returns nothing. The four things it was meant to carry are all real, but they live in
two files that already existed and are already tested:

| What the vendor sets | Where it goes | Read by |
| --- | --- | --- |
| Licence key generator's public key | `trustedEd25519Keys` in the **policy file** (`policy.html` → `.iflpolicy`) | the desktop, on import under *On-site / offline* |
| On-site period limit | `maximumOnsitePeriodYears` in the **policy file** *and* in `build-profile.json` | the desktop's on-site activation |
| Default currency, and whether it is locked | `defaultCurrencyCode` / `lockCurrency` in **`build-profile.json`** → `installer/nsis/generated.nsh` | the installer's currency page and first-run setup |
| Settings (version, cloud address) | `appVersion` / `licenseServerUrl` in **`build-profile.json`** | the installer and the app |

Build Studio writes exactly three files: `build-profile.json` **and** `buildprofile.generated.json` into the project
(the same content, the second because the installer generator and packaging look for different names), and its own
`build-studio-settings.json` under `%APPDATA%`. The private key is a fourth, and only to a path the vendor picks in a
dialog. Adding a `vendor-config.json` now would be a fourth name for data two existing files already carry, so it was
not invented for this close-out — the capability is present, the name in the request is not.

### The three-way contract, and the two holes found in it

The build profile is written by Build Studio, compiled into the installer by `npm run installer:script`, and read by
the app at first run. Three programs that never run together. Until this phase nothing connected them end to end,
and two links were missing:

1. **The generator never received the profile.** `writeInstallerHeader()` always generated the *default* profile, so
   a vendor could set Ghana cedis in the window and the installer would still ship Naira. Fixed by threading the
   profile through `writeGeneratedIncludes`, with `scripts/installer-script.ts` reading `build-profile.json` (or
   `INFOFLEX_BUILD_PROFILE_FILE`) and **failing loudly** on a malformed one instead of silently building defaults.
2. **The app never received it either.** Neither electron-builder config packed the profile, so the app's own
   `readBuildProfile` would have found nothing and first-run setup would not have known the currency was locked.
   Both configs now pack `installer/nsis/build-profile.json`, which the generator rewrites on every run so a build
   cannot inherit a stale one.

Both are the same class of defect as Phase 13's unparseable `install-config.json`: a file written by one program and
assumed, rather than tested, to be readable by another. Both now have tests that read the real files.

### The window itself is tested, without Electron

`buildstudio/ui.test.ts` (13 tests) loads the real `index.html` into jsdom, bundles `ui.ts` with esbuild the same way
the build does, and drives every interaction against a stub of the preload bridge. It asserts the things that would
otherwise only be found by a person clicking:

- every button has an id, a build group or a tab, so none is dead;
- the one-click build runs `do-everything` and lands on Output;
- each smaller button sends its own group name;
- the three check states render as tick / orange arrow / red cross, blocked first;
- **only required, self-installable tools are offered for installation** — the optional Git row is left alone;
- with no project chosen, *Build everything* sends the vendor to the Project screen with a sentence they can act on
  (this was wrong until the test found it: it reported the problem onto the Build screen, which the vendor was not
  looking at);
- the vendor unlock clears the password box whether the attempt succeeded or failed;
- **the private key never appears in the page** — the public key and fingerprint do, and the private half goes only
  to the save dialog;
- settings validation refuses a bad version and a plain-`http` cloud address, and *No limit* is saved as `null`;
- the USB copy sends the chosen drive path.

The renderer runs in plain Node with its own jsdom instance rather than vitest's jsdom environment: that environment
replaces `TextEncoder` with one from another realm, and esbuild refuses to run in that state. Noted here because the
failure message ("your JavaScript environment is broken") points at the wrong culprit.

### The rules the tool is built around

- **No terminal, ever.** Every child process is `windowsHide: true` and `shell: false`; output is streamed into the
  window. Cancel uses `taskkill /T /F`, because a polite signal does not stop a Windows build tree — proved by a
  real-process test that takes under ten seconds.
- **The window has no power of its own.** `contextIsolation` on, `nodeIntegration` off, one `contextBridge` object.
  Output from npm and installers is rendered with `textContent`, never `innerHTML`, so a log line cannot become script.
- **The master password is never stored or shown.** Only the PBKDF2 hash is compared; the box is cleared either way;
  `writeSettings` throws rather than write a file containing `PRIVATE KEY`.
- **Downloads are allowlisted, hashed and Authenticode-checked before anything runs.** The signature is read with a
  hidden `Get-AuthenticodeSignature`; an unverified file is not executed.
- **Artefacts are listed from the disk, never from intent.** A step that reports success but wrote nothing shows as
  *missing*.

### A capability I destroyed, and how it was found

The Build Studio window replaced `buildstudio/index.html` — which was also, until then, **the licence policy
exporter**: the page a vendor opens to produce the `.iflpolicy` a customer's desktop imports under *On-site /
offline → Import vendor policy*. Nothing type-checks a standalone HTML file, nothing tested it, and no build step
referenced it, so the whole capability disappeared without a single red test. It was found by reading
`docs/DECISIONS.md` against the tree, not by running anything.

It is restored as **`buildstudio/policy.html`**, its own URL, still standalone and still openable by double-click
with no toolchain — and it now has the tests it never had:

- **`buildstudio/policy.test.ts` (11).** The real page is run in a DOM with **Node's real Web Crypto**, a policy is
  generated, and the result is parsed with the application's own `parseVendorPolicyFile`. That is the assertion that
  matters: a page producing a file the app rejects is worse than no page, because the vendor discovers it at the
  customer's shop. Also pinned: the password never appears in the file and two exports of the same password get
  different salts; a blank term is `null`, not zero; the year menu is exactly 1..50 with no gaps; a short password, a
  mismatch, a plain-`http` address off the local mock, and a URL carrying credentials/query/fragment are all refused;
  a real Ed25519 key round-trips while a fake one is refused by the app; no `fetch`, no `XMLHttpRequest`, no storage
  call, no external resource; both password fields are cleared afterwards.

The window links to it (*Vendor tools → Open the policy page*), so it is no longer orphaned, and `ui.test.ts` presses
that button. The page is copied beside the window by `build:studio`. It opens in the vendor's **own browser** rather
than an in-app view: the page handles the master password, and a local file with no preload and no Node is the safest
place for that.

### The Windows-only code, tested on Linux

Every branch that only runs on Windows was unreachable here, and Windows is the only platform this tool ships to. So
the decisions were pulled out of the `if (platform === 'win32')` and given parameters:

- **`killTree` takes the platform and the spawn function.** `buildstudio/src/runner.test.ts` now proves Cancel sends
  `taskkill /pid <n> /T /F` **hidden** and does not also SIGTERM the parent (which could race), that a machine with no
  `taskkill` still falls back to SIGTERM, that SIGTERM is used off Windows, and that a process which never started is
  left alone rather than killed by pid 0.
- **`windowsDriveRoots` was extracted out of the IPC handler** and takes the platform and a look-up. The everyday case
  it defends: an empty card reader still has a drive letter, and looking at it throws. That must not empty the list,
  and the system drive must not be offered for "copy to USB". Both are now tested.
- **`buildstudio/src/authenticode.ts` is new.** The PowerShell quoting was an untested string concatenation in a download path —
  the one place a crafted path could matter. The path is now escaped by doubling the single quote, and tests prove a
  path containing `'; Remove-Item ...` cannot end the string or add a command, while `$` and backtick stay literal
  (which is why single quotes are used, not double). `interpretAuthenticode` fails closed on a non-zero exit, no exit,
  empty output or multi-line output — an unsigned file prints nothing, and "nothing" must never mean "fine".

Verified by weakening: removing the quote-doubling breaks exactly the two injection tests.

Still Windows-only and still untested, honestly: whether Windows *honours* taskkill and Authenticode, and whether the
PowerShell invocation behaves — those need the machine, and Gate 6 is where they are recorded.

### The Electron main process, executed for the first time

`buildstudio/main.ts` holds everything in the tool that can write a file, spawn a process or read the machine, and it
had never run. It type-checked and it bundled, which proves it compiles and nothing else.

`buildstudio/main.test.ts` (18) mocks `electron` and imports the real module, then calls every IPC handler the way the
window does. What it proves:

- **Every channel the preload bridge offers has a handler.** The test reads `preload.ts`, extracts every `invoke(...)`
  (more than twenty) and asserts each one is registered — a missing handler is a button that silently does nothing.
- **Settings keep what the window never sends.** The password hash survives a later save from a window that has no
  copy of it; a settings file containing `PRIVATE KEY` is refused.
- **The master password is checked against the stored hash and never logged** — the log is read back and asserted not to
  contain either the right or the wrong password.
- **The private key is written only to the path the vendor picks**, with mode `0600`, and the log names the key but not
  its contents. Cancelling the dialog writes nothing.
- **A download that cannot be Authenticode-verified is not run** (the Linux answer is "cannot verify", and the safe
  direction is to refuse) — and the vendor is told they can install it themselves.
- The project folder must really contain a `package.json`; the check answers rows the window can draw; an unknown build
  action is refused by name.
- **Copy to a USB drive** copies the built files verbatim into `Infoflex Installers` on the chosen drive, and refuses
  with "nothing built yet" — creating no folder — when the build produced nothing.

It found two real defects:

1. **Refresh on the Output screen crashed before a project was chosen.** `artefacts:verify` answers `{ ok: false, ... }`
   with no project, and the window went straight on to read `.missing.length` of it. A vendor pressing Refresh on a
   fresh install got a dead screen. The window now tells the two answers apart and shows the sentence; `ui.test.ts`
   covers it, and `buildstudio/main.test.ts` pins the shape the main process really returns.
2. **An unknown build action was reported as "choose the project folder first"**, because the project was validated
   before the action was. The vendor would go looking for the wrong problem. The action is now validated first.

### Documentation checked against the tree, because prose is not compiled

The lost policy exporter and a wrong migration name in `docs/SCHEMA.md` were the same failure: a document describing
something the code did not have, with nothing able to notice. So `docs/docs-accuracy.test.ts` (5) now checks the
facts a reader acts on:

- **every file path in the docs** exists in the tree, or is a file a build/tool produces at runtime (`install-config.json`,
  `build-studio-settings.json` and friends, listed explicitly so the exemption is a decision rather than a hole);
- **every `npm run <x>` in the docs** exists in `package.json` (32 referenced, and the test asserts the list is not
  empty so it cannot pass vacuously);
- **every migration file** is named in `docs/SCHEMA.md`'s table, with a row numbered to match, **and the table names
  no migration that is not on disk**;
- Build Studio is **not called "planned"** in the README, while the README must still say it has never been launched.

Verified to fail: reinstating the phantom migration, deleting a documented path, and restoring the word "planned" each
breaks exactly the intended assertion. Two real defects were fixed by writing it — migration 14 is `014_mobile_login.ts`
(the table had named a file that never existed) and does far more than the table said: it rebuilds `devices` so an unapproved device
can hold no token, and adds the keep-running/sleep/start-with-Windows preferences and the cloud relay pair. And the
README still described Build Studio as planned.

### Two build steps that called scripts which did not exist

Found while checking the plan against the manifest rather than against intent: *Build Vendor Cloud package* ran
`npm run cloud:package` and *Checking the result* ran `npm run artefacts:verify`, and **neither script existed**. On
a vendor's machine the first would have failed after the prerequisite check had already said everything was fine;
the second would have meant the build never verified its own output.

Both are now real:

- **`scripts/cloud-package.ts`** writes `dist/cloud/infoflex-vendor-cloud.zip` — a zip built by hand from `zlib`,
  because the format for stored and deflated entries is small enough to be certain about and adding a packaging
  dependency to a build tool is not. It **refuses `.env`, databases, logs and anything matching `PRIVATE KEY`**.
  `cloud/tests/cloud-package.test.ts` reads it back with an *independent* reader (central directory walked by hand,
  every CRC checked, every entry inflated, the Dockerfile compared byte-for-byte with its source), and also opens it
  with Python's `zipfile` during development.
- **`scripts/verify-artefacts.ts`** walks the disk for every artefact the plan promises, prints size and SHA-256,
  writes `dist/artefacts.json`, and **exits non-zero when one is missing** — verified here by running it, where it
  correctly reports both installers as not produced because no Windows toolchain exists.

`build-steps.test.ts` now reads the real `package.json` and fails if any step names a script that is not there, so
this class of defect cannot come back silently. The same test pins the cloud zip's path, so moving the writer breaks
the test rather than the Output screen.

### What this environment could not do, and what is owed

- **The window has never been opened in Electron.** No display, no Windows. The renderer is tested in jsdom; the
  Electron shell (`main.ts`, `preload.ts`) is type-checked and bundled, and that is all.
- **No Build Studio installer exists.** `electron-builder --win nsis` cannot fetch its toolchain here (TLS
  interception; no Wine, no `makensis`).
- **No prerequisite was downloaded or installed for real**, and no Authenticode check ran against a real file.
- **The seven screens have never been looked at.** Layout, contrast, tab order and control sizes are unjudged by
  human eyes; `docs/RELEASE-CHECKLIST.md` Gate 6 is the script for that.

## Phase 15 — packaging, documentation and the release

- **Three installers defects were found and none by a test.** Both electron-builder configs were schema-invalid (a
  `//` comment key, and `defines`, which is not an NSIS option), so **neither installer could ever have been built**.
  And `installer.nsi` was never wired in as `nsis.include`: electron-builder would have compiled its own stock wizard,
  and the standalone script created shortcuts and a firewall rule without installing the application. `installer:check`
  passed before and after all three. The config side now has its own test and the checker has a rule against
  `Section "Install"`.
- **No `.exe` exists.** electron-builder cannot fetch the Windows Electron runtime (TLS interception;
  `objects.githubusercontent.com` unreachable), `makensis` cannot be installed without root (since disproved — see
  below), and there is no Wine. The
  release folders and the manifest record exactly what is missing and why, and carry the NSIS sources and the Build
  Studio bundle so a Windows machine can rebuild the three executables.
- **Nothing ran on Windows, on a phone, or on a printer.** The Phase 15 end-to-end walk-through was not performed: its
  first step needs an installer that cannot be produced here. `docs/RELEASE-CHECKLIST.md` is the script for whoever can
  run it.
- **The silent `/CURRENCY` check covered 9 of 54 currencies.** Fixed by generating it from the catalogue, with a test
  per currency.
- **The secret scanner was wrong in four ways, each looking like a clean pass.** It now proves itself by planting both
  secrets before every run; ten tests pin each leak form and each false positive. `npm run release:scan` reports
  **clean across 756 files**.
- **Three documentation claims were wrong and were corrected against the code:** the vendor guide said an unknown
  `/CURRENCY` falls back to the default (it aborts with exit code 2); the backup retention and the licence grace period
  were checked rather than assumed.

## Phase 15 (continued) — the installer compiles, and did not

- **`makensis` is buildable here after all.** Previous phases recorded "cannot compile" as an environment fact. It was
  half true: no `makensis` was installed and no root existed to install one, but NSIS builds from source with the gcc
  that was always present. `scripts/compile-check-installer.ts` now does it — zlib and NSIS from source, SCons from
  PyPI — and compiles both builds.
- **Six compile-blocking defects came out of the first real compile**, none of which any test had caught:
  `${NSD_LB_SetCurSel}` and `${NSD_LB_GetCurSel}` (not nsDialogs macros), `${NSD_DisableWindow}` (does not exist),
  `${RunningX64}` without `x64.nsh`, `${AtLeastWin10}` (never defined by WinVer.nsh), and `${GetFileSize}`
  (it is `${GetSize}`). Plus a comment ending in a backslash that silently swallowed the following line.
- **The static checker had been blessing all of them**, because its allowlist of macro names contained the four names
  that do not exist. It was written from memory. A test now pins the names, and the allowlist was rebuilt from the
  headers.
- **The compile check itself failed three times before it worked**, each time reporting success while compiling
  nothing: the error was on stderr and only stdout was read; `makensis` exits 0 on script errors without `-V2`; and
  the regex patching MUI lacked the `m` flag so it silently matched nothing. It now demands positive proof of a full
  compile and treats "no compile output" as failure.
- **The uninstaller had never been compiled, and it did not compile.** electron-builder builds the installer twice; the
  second pass defines `BUILD_UNINSTALLER` and is the only one that includes `uninstaller.nsh`, which owns
  `customUnInstall` and the uninstaller's own `un.onInit`. All three harness shapes were installer passes, so the
  uninstaller was never built by anything in this repository. Compiling it produced three findings:
  - **A hard build failure.** This script defined `Function un.onInit`; so does electron-builder's template, and the two
    compile together because our script is an `nsis.include` rather than a replacement script. NSIS refuses the second
    definition: `Error: Function named "un.onInit" already exists.` The installer half built perfectly throughout, which
    is why the defect went unseen. Rewritten as the supported `customUnInit` hook, which the template inserts inside its
    own function, after `initMultiUser`.
  - **"Remove my data" removed nothing.** It deleted `$APPDATA\Infoflex` — but under `perMachine: true` the template has
    already run `SetShellVarContext all`, so `$APPDATA` there is `C:\ProgramData`. The database, licence and paired
    phones were never touched, and the customer was told they had been. The deletion now switches
    `SetShellVarContext current` first, the same way electron-builder's own delete-app-data code does.
  - **`install-config.json` outlived the program**, leaving a previous shop's currency in `%ProgramData%\Infoflex\`
    forever. Now removed unconditionally, since it is installer state rather than shop data.
  A fourth build shape (`uninstaller-pass`) compiles the pass, deliberately reproducing the template's `un.onInit` so the
  collision is a build failure; a mutation that restores `Function un.onInit` fails the compile check with that exact
  error. Ten contract tests and four new checker tests cover the class. The compile-time checker also gained a rule for a
  function declared twice within one script — the same mistake one level in, since the checker cannot see the template.
  None of this executes the uninstaller: there is no Windows or Wine here, so "the hooks compile in the layering
  electron-builder uses" is the claim, and `RELEASE-CHECKLIST.md` carries the rest as manual checks.
- **Silent mode did not silence anything.** Thirteen `MessageBox` commands had no `/SD`, and NSIS only suppresses a box
  in silent mode when one is given (`Source/exehead/util.c:138-141`: `if (g_exec_flags.silent && type >> 21)`). The
  `.onInit` validation errors, the VC++ digest mismatch, the install-failed notice and the password-attempt limit would
  all have appeared and blocked an unattended install. All thirteen now name a default — the safe one, not the
  dismissable one — and the rule is enforced by `installer:check`, which rejects a script with a single `/SD` removed.
- **The keep-my-data question ran during upgrades, where it could destroy data.** electron-builder runs the old
  uninstaller before every install, silently, with `--updated`; `customUnInit` prompted anyway, and "No" deletes the
  database, licence and paired phones. It also contradicted the flag the caller had passed, since `--updated` means keep
  data and `--delete-app-data` is the only way to ask otherwise. The hook now checks `--updated` first and returns. The
  ordering is the point — a check after a blocking dialog cannot prevent it — and the test compares offsets, so moving
  the check below the prompt fails it.
- **The vendor password could be skipped with `/S`.** The gate lived only in `PasswordPageLeave`, and a silent install
  draws no pages, so `/S` installed without the password and let the caller pick the currency from the command line. The
  gate was real for a double-click and absent for a typed flag. The silent branch now requires `/PASSWORD=`, verifies it
  with the same PBKDF2 helper and aborts on failure, including when the helper is missing. Two costs are documented
  rather than hidden: the password is visible in the process command line for the duration, and there is no attempt
  counter on a path whose counter would only hang an unattended run. A checker rule now requires a password page's
  silent branch to *invoke* the helper — not merely stage it — because the obvious version of the rule accepted
  `File /oname=...password-check.exe` and checked nothing.
- **That rule was dead for two runs.** Its page regex was anchored `^Page`, but the page is inserted from inside a
  macro and is therefore indented; the rule never executed, and a mutation deleting the whole silent password check was
  reported clean. This is the second check this phase written against the shape the author pictured rather than the
  shape the file has — the first was a test matching its own comments. Both were found by mutating.
- **The system check was bypassed by `/S` in the same way.** `ChecksPageLeave` refuses to continue on 32-bit Windows or
  anything older than Windows 10, and it too is a Leave callback — so a silent install on 32-bit Windows installed a
  64-bit app that cannot start, and reported success. The silent branch now re-checks both and refuses. The checker rule
  was generalised from "the password page" to "any Leave callback that can `Abort`", because two instances in one file
  is a class, not a coincidence; `ComponentsPageLeave` is exempt since it only records checkbox values.
- **The checker could not read its own input.** `stripComments` truncated each line at the first `;` regardless of
  quoting, so a `MessageBox` whose message contained a semicolon lost everything after it — including its `/SD IDOK` —
  and was reported as a silent-mode hazard that did not exist. NSIS starts a comment at a `;` outside quotes only; the
  stripper now does the same, with a test in each direction.
- **The prerequisite was skipped on the silent path, and the offline promise was never enforced.** `$NeedsVcRuntime`
  was computed only in `ChecksPageCreate`, so `/S` left it `"0"`, `InstallPrerequisites` returned immediately, and the
  interactive path installed the VC++ runtime while the unattended one did not. The offline build separately promised
  "every prerequisite is included" and installed anyway when the payload was missing, because the flag meant to catch
  that is set by a page the offline build excludes. The probe is now a `DetectVcRuntime` macro called by the page and by
  the silent branch, and the offline arm refuses with `SetErrorLevel 4`.
- **Three checker rules that did nothing, found only by mutating.** One tested a list of function names for a variable
  name; one used an index from a sliced array as though it were global; one was anchored past the indentation of a line
  inserted from a macro. Each looked correct, each was unreachable by reading, and each was caught by deleting the thing
  it was meant to protect and watching the check stay green. Mutating a new rule is now the practice here, not a
  formality.
- **The install log the customer is promised was never written.** `$INSTDIR\install.log` is named in the finish page's
  "Open install log" button, in the finish-page text and in the failure message. Nothing created it, so the button
  produced a file-not-found error exactly when somebody needed help. NSIS's `LogSet` is unavailable — it needs
  `NSIS_CONFIG_LOG`, which the build lacks, and electron-builder's `${LogSet}` is a no-op unless the project ships a
  custom debug NSIS binary. The log is now written with `FileWrite`, opened in `$PLUGINSDIR`, closed, and copied into
  `$INSTDIR` at the end, so it survives an install that fails before `$INSTDIR` is usable.
- **Two more checker rules that did nothing.** The "advertised file must be written" rule first had a backslash-escaping
  bug so it matched nothing at all, then a satisfaction test that counted the log's own header string as proof the file
  was written. Both were found by mutating. That makes four such rules this phase; breaking a new rule on purpose is
  the practice because nothing else has caught them.
- **Still not proven:** that electron-builder's template agrees with our hooks, that the payload lands in the right
  place, or that anything behaves correctly on Windows.

## Phase 15 (continued) — a real installer, not just a compiling script

- **The stubs are no longer a placeholder.** NSIS treats its Windows stubs as a Windows-only artefact (`SKIPSTUBS=all`
  is the documented POSIX recipe) and its release tarball ships none, so every earlier run stopped at the final
  byte-write with `PE file contains invalid DOS header`. `scripts/nsis-stub-builder.ts` now cross-compiles them from
  NSIS's own `Source/exehead`, using **Zig** — published to PyPI as a plain wheel, and a complete clang+lld
  cross-compiler — behind `i686-w64-mingw32-*` shims so NSIS's SConstruct builds unmodified. Twelve stubs, three
  compressions by four variants.
- **`npm run installer:compile` now produces a real `.exe` for every build:** roughly 111 KB online and 110.9 KB for
  each of the offline, offline-wrapper and uninstaller-pass builds, each a verified i386 PE with the Windows GUI
  subsystem. (Sizes move with every script change; the ones recorded earlier in this file are history,
  not a contract.)
- **The check inspects the artefact instead of trusting the log.** `installer/src/pe-artifact.ts` validates the DOS
  magic, the PE signature, the machine, the optional-header size, the section count and the subsystem, with 11 tests.
  It immediately earned its keep: dropping `-Wl,--subsystem,windows` from the stub link produced a **console** binary,
  which NSIS accepted without complaint and which would have flashed a terminal window at every vendor during install.
- **`warning 6010` is now a failure unless the omission is expected.** Zeroing a function body is how four custom pages
  were silently lost in an earlier phase. `EXPECTED_UNREFERENCED` lists what each build may drop; removing the page
  hook now fails the build and names eight discarded page functions.
- **`ChangeUI` still cannot be restored**, and the docs now say why: with real stubs in place, `ChangeUI all` fails
  with `Can't find IDD_LICENSE (102) in the custom UI` because it edits dialog resources, which needs a Windows
  resource compiler. That is a genuine limit, not a missing stub.
- **The check was weaker than the real build: `-WX` was missing.** electron-builder passes "warnings as errors", so a
  single warning stops `npm run build` — and the compile check did not, meaning both builds passed here while the real
  build would have failed. `installer.nsi` now suppresses the three codes it provokes on purpose, by number, so every
  other warning stays fatal; the check passes `-WX`; and the harness re-enables 6010 so a discarded function body is
  still reported. Five tests pin it.
- **The hook contract is checked against electron-builder's own template**, not against our belief about it. Every hook
  sits behind `!ifmacrodef`, so a misspelled macro name is silently skipped and the installer builds without the
  password page. Six tests read the template from `node_modules`: no orphan macros, every relied-on hook still present,
  page order preserved, and `customInstall`/`customUnInstall` still on the right side of the payload copy and the file
  delete.
- **`oneClick` would have silently deleted the password gate.** Only the assisted template calls our three page hooks;
  `oneClick.nsh` calls none of them. `oneClick: true` builds cleanly and ships an installer with no vendor gate — and
  every existing test would still have passed, because the harness inserts the hooks itself. A test now pins the
  setting and re-derives the reason from electron-builder's templates.
- **The offline wrapper had never been compiled.** The shipping offline build includes `offline-include.nsh`, not
  `installer.nsi`; the check had been simulating that build with a command-line define and leaving the wrapper untested.
  It is now a third build, and its output is byte-identical to the offline build's.
- **The prerequisite was run without being verified.** `InstallPrerequisites` called `ExecWait` on
  `vc_redist.x64.exe` with no checksum check, while the download page and the file-picker both verified it. Worse, the
  shipped all-zero digest made the *verified* paths refuse the file and left the unverified one as the only way through.
  The execution path now verifies first, deletes a mismatch, and installs without that component rather than running it.
- **The offline build could not compile.** Its offline branch does `File ... "${PREREQUISITE_VCREDIST}"`, a define no
  real build supplies -- only the harness did, which is why the compile check never showed it. Now `!ifdef`-guarded, the
  harness no longer invents the value, and a test pins the harness's define list. The checklist now says to *supply*
  that file, which nobody was doing.
- **Every shortcut pointed at a guessed executable name.** The desktop and Start menu shortcuts, the finish-page "Run
  now" box and the autostart entry all used `"${PRODUCT_NAME}.exe"`; electron-builder writes
  `"${PRODUCT_FILENAME}.exe"`, and a product name containing `:` or `/` makes those two different files. Correct today
  only because "Infoflex" happens to need no sanitising. All four now use `APP_EXECUTABLE_FILENAME`, and tests forbid
  rebuilding the path from the product name.
- **Two shortcuts were created twice, and ours won.** `customInstall` created `"$SMPROGRAMS\${PRODUCT_NAME}.lnk"` and
  `"$DESKTOP\${PRODUCT_NAME}.lnk"`; electron-builder's install section creates the same two files from `${SHORTCUT_NAME}`
  (default: the sanitised product name, i.e. the same `Infoflex`) *before* inserting the hook, and stamps each with
  `WinShell::SetLnkAUMI` immediately afterwards. `CreateShortCut` replaces the `.lnk` wholesale, so a fresh install ended
  up with shortcuts carrying no AppUserModelID — the thing Windows grouping, the taskbar jump list and pinning depend
  on — while a repair kept electron-builder's good ones. The two calls are removed; the file now has one owner, and a
  test forbids one coming back.
- **Still not proven:** the real `npm run build` cannot run here (electron-builder downloads its NSIS from GitHub and
  needs plugin DLLs this sandbox lacks), so the template is read rather than executed. And the `.exe` has never been executed. There is no Windows and no Wine here. The shippable
  installer still comes from `npm run build` on a Windows machine with the NSIS target, and the manual checklist in
  `RELEASE-CHECKLIST.md` is still the only thing that will tell us the pages behave.
- **The finish page launched the app as Administrator.** `MUI_FINISHPAGE_RUN "$INSTDIR\...exe"` with no
  `MUI_FINISHPAGE_RUN_FUNCTION`: MUI's finish page falls back to `Exec` (`Finish.nsh:482-486`), and `Exec` is
  `CreateProcess` (`util.c:87-92`), which inherits the elevated token of a `perMachine` installer. The define is now
  empty with `LaunchAsUser` doing the work through `${StdUtils.ExecShellAsUser}`, guarded on the plugin's presence
  because the source-built makensis here has no `StdUtils.dll` — the `!else` is a plain `Exec` and is commented as the
  defect it is. Both branches were compiled separately to show the guard selects correctly.
- **The download page's progress bar could never move.** NSISdl locates the wizard's stock progress control by
  `GetDlgItem(childwnd, 1004)/(1006)` (`nsisdl.cpp:61-66`, `Contrib/UIs/resource.h`); an nsDialogs page creates its
  controls as `1200 + id` under the 1018 placeholder (`nsDialogs.c:394`), so both lookups return NULL and
  `progress_callback` does nothing. The bar is gone. NSISdl also pumps no messages at all, so the status label could
  not repaint either; the text is now followed by `UpdateWindow` before the blocking call.
- **The Components page offered an install folder it did not use.** `${NSD_CreateDirRequest} -> Pop $0`, `$0` never
  read, and `$INSTDIR` is owned by `MUI_PAGE_DIRECTORY` which electron-builder inserts earlier. It is a label now.
- **Four dead variables** (`CompLaunch`, `CompDesktop`, `LaunchWanted`, `DesktopWanted`) deleted; the checker now
  reports a `Var` nothing reads and a control whose value is discarded. The rule's first version counted uses in the
  raw text, so the comment explaining it satisfied it — caught by mutation, fixed to read comment-stripped text.
- **A refusal fired after the application was already on disk, and said "Nothing was installed".** The offline build's
  missing-runtime refusal lives in `customInstall`, which electron-builder inserts *after* `installApplicationFiles`
  (`installSection.nsh:67` then `:82`) — so the payload, the shortcuts and the Apps & features entry already existed.
  It now calls `RollBackPartialInstall`, which removes the payload, both registry keys, `HKLM\Software\Infoflex` and
  `install-config.json` before aborting, and the message no longer claims the machine is untouched. My first draft of
  that rollback deleted only `${INSTALL_REGISTRY_KEY}` — electron-builder's bookkeeping — and left
  `${UNINSTALL_REGISTRY_KEY}`, the entry the *customer* sees; a test now pins both.
- **The harnesses now `!include "multiUser.nsh"` instead of restating it.** My first attempt copied the two registry-key
  formulas out of `multiUser.nsh:8-9`; the existing "defines no prerequisite path of its own" test rejected it, and was
  right to — the whitelist cannot tell a faithful copy from an invention. They now supply only what electron-builder
  passes with `-D` (`APP_GUID`, `UNINSTALL_APP_KEY`, `SHORTCUT_NAME`) and include the vendor header for the rest.
  `compile-check-installer.ts` gained the templates directory on the include path, mirroring `cwd: nsisTemplatesDir`.
- **A new checker rule needed three attempts** before it could fire at all: it first read only the macro body (missing
  the `Abort`, which is in a called function), then collected called function *names* instead of their bodies, then
  over-reached onto the download page where "Nothing was installed" is true. Each version reported nothing, and only
  mutating the script revealed it.
- **The Authenticode check was never implemented on any path.** Four places described it (`download-allowlist.ts`'s
  comment saying the read "is done by the NSIS side", the generated `${VCREDIST_PUBLISHER}`, the browse handler's
  "same checksum and publisher check", and the download page's own text); nothing performed it. The helper gained
  `--authenticode`, `interpretAuthenticode` decides the result and fails closed, and `CheckRedistSignature` is called
  from all three paths — download, browse, and immediately before `ExecWait`. Each re-checks rather than sharing a flag.
- **The download host allowlist was generated and never read.** `${ALLOWED_HOST_1..3}` came from
  `ALLOWED_DOWNLOAD_HOSTS` and the script used none of them, so the rule held on the TypeScript side only — which is the
  half that does not download. The download now refuses any other host and any non-https URL before opening a socket.
- **`install-config.json` recorded the wrong version.** It wrote electron-builder's `${APP_VERSION}` instead of
  `${INSTALLER_APP_VERSION}`, the version the vendor built for, so a 2.3.4 build told the machine it was 0.1.0. Found by
  deleting the "unused" define: the existing build-profile-wiring test then failed, revealing it was never dead weight,
  only unread.
- **New checker rule for dead generated defines**, fed its names by reading the generator rather than a hand-kept list.
  Two genuinely dead defines removed (`CURRENCY_COUNT`, `VCREDIST_SIZE`).

## Phase 15 (continued) — the prerequisite is fetched and verified, and never committed

The offline installer has claimed since it was written that every prerequisite is included, and the online one refuses
to download a file it cannot verify. Both promises rested on a digest that was still all zeros. This phase makes the
digest real, at release time, without putting a Microsoft binary in the repository.

**What runs now.** `npm run release:prerequisite` downloads `https://aka.ms/vs/17/release/vc_redist.x64.exe` — the only
URL the allowlist permits for this component, not a URL a caller passes in — reads its Authenticode signature and
publisher, computes the SHA-256, and writes the pin into `installer/nsis/build-profile.json`. The binary stays in
`installer/cache/`, which is gitignored. What is committed is a digest, a size, a version and a timestamp, none of which
is Microsoft's bytes. `npm run release:assemble` calls the same gate and refuses to finish while the digest is zeros;
Build Studio's "Build installers" now runs the fetch as its own step, before the installer data is generated.

**What the installer does with it.** `generate-installer-script.ts` prefers the profile's pin over the allowlist
placeholder when writing `VCREDIST_SHA256`, and writes a generated `prerequisite.nsh` that defines
`PREREQUISITE_INCLUDE` only when the pin is real. `installer.nsi` guards its offline `File` on that define, so an
unpinned development build compiles and carries no runtime — and then fails loudly at install time, which is the
behaviour the previous phase gave it — while a pinned release bundles the file.

**Three defects found while building it, none of them the one I set out to fix.**

- **The pin silently vanished between the release step and the header.** `parseBuildProfile` reads only the fields it
  knows, so the new `prerequisite` key was dropped on the way in and the header went on emitting the zeros. The first
  end-to-end pin test therefore "passed" as a no-op. Serialising had the same gap. A round-trip test now pins both
  directions, and it is the test that would have caught it.
- **A relative `File` path compiles in the harness and fails in the real build.** `makensis` resolves `File` against its
  own working directory, which electron-builder sets to its templates folder. `prerequisite.nsh` now emits an absolute
  path, computed at generation time. This is the third harness-versus-build divergence in this project, all of the
  same shape: the harness passes include directories the real build supplies differently.
- **`git checkout` on a file holding uncommitted work.** Reverting a deliberate mutation with `git checkout` discarded
  the phase's own edits to the generator along with it. Recovered by re-applying, but the lesson is that a mutation must
  be reverted from a saved copy (`cp` before mutating), not from the index.

**What is proven, and what is not.** Proven by execution on this machine: all four harness builds produce installers
with the fixture pinned, and the fixture's bytes are literally present in the built offline executable — a random
2,000-byte marker with a known SHA-256 was found inside the output, so the file really is embedded rather than
referenced. Also proven: with the cached file removed and the pin left in place, the build fails with
`File: "…" -> no files found` rather than shipping an installer with no runtime. And both refusal paths were run:
`release:assemble` prints `RELEASE STOPPED` and exits 1 for a profile with no pin and again for the zeros.

Not proven, and recorded here rather than glossed: **the real Microsoft download was never performed.** This sandbox
has no access to `aka.ms`, and has no Windows machine to run `signtool` on. So the curl invocation, the
`--authenticode` interpretation of a real signed Microsoft binary, and `fileVersionFromWindowsResource` have all been
exercised only against **synthetic inputs** — a stand-in payload and a stubbed signer. The signature-failure tests inject
a downloader and a signer rather than producing a genuinely mis-signed file. The first real run of
`npm run release:prerequisite` on a networked machine is the first time that path meets Microsoft's actual bytes;
`docs/RELEASE-CHECKLIST.md` now asks for the digest and version to be written in by hand and compared against
`certutil` output on a real PC, so that first run is verified by a person, not assumed.

## Phase 15 (continued) — a real digest is not the same as the right file

The gate added above proves the pinned digest is not the all-zeros placeholder. It says nothing about the bytes sitting
in `installer/cache/`, and those two facts come apart in ordinary ways: a cache left over from the previous release, a
file swapped while testing something, a fetch interrupted after the profile was written. In every one of those cases the
offline installer bundles bytes that its own `${VCREDIST_SHA256}` check refuses — so the release succeeds here and the
customer's install fails there, which is the worst place for a checksum to discover a mistake.

`verifyCachedPrerequisite` closes it. It re-reads the file the release is about to bundle and compares its size, its
SHA-256 **and** its signature against the pin, throwing a sentence that names the fix rather than a stack trace.
`release:assemble` calls it after the pin check; `release:prerequisite -- --check` calls it too, so the check a build box
runs is the same one.

**Why it re-reads rather than trusting the fetch.** A fetch that trusts its own earlier result is not a check. The pin in
the profile is a claim about a file; this is the comparison that makes it true at the moment it matters.

**Why the signature is re-read when the digest already matched.** A matching digest proves the bytes are the ones that
were hashed. It proves nothing about who made them. A pin recorded on a machine where the signature check was skipped
would otherwise be trusted forever, which is exactly the kind of one-time gap that survives every later release.

**What is proven.** Executed by hand against the real script, each with the plain-English message recorded: a matching
cache (passes and prints the signer), a stale cache with the same length and different bytes (refuses, showing both
digests), a wrong-size file (refuses before hashing), a missing file (refuses and names the missing path), and a file
with no valid signature (refuses). Both mutations of the new function — disabling the digest comparison, and disabling
the signature comparison — were caught by the tests that exist for them. Still not proven: none of these ran against a
real Microsoft binary, for the same reasons as the section above.

## Phase 15 (continued) — the phase was not finished, and the question "is that all?" found five more

Everything below was found after the two commits above were pushed, by running the work on a **clean clone** and
following the instructions the tooling itself prints. None of it was visible from the working tree, which is the point:
the tree always has a profile by the time anyone looks, and the messages were only ever read by the person who wrote them.

- **The redirect rule was enforced on the wrong address.** `httpDownload`'s own comment claimed it "refuses a redirect
  to a host that is not allowlisted"; `curl --location` followed up to three hops and nothing checked where it landed.
  `aka.ms` is a shortener, so the real request always goes through a redirect, which means the allowlist was checked
  against an address that never serves the bytes. `resolveFinalUrl` now asks curl for the effective URL (`--head`, so no
  body is fetched) and `isAllowlistedAddress` refuses anything that is not https on an allowlisted host. Verified
  against a local server issuing real 302s, and against six addresses including `download.microsoft.com.evil.example`.
  A failed HEAD falls through to the download rather than stopping, because the signature check is the real backstop.
- **The pin was committed nowhere.** `docs/DECISIONS.md` said "the pinned SHA-256 lives in `build-profile.json`, a
  committed text file". It was not committed: the root profile is not ignored but was never tracked either, so every
  release was recorded with no statement of which binary it carried — exactly what requirement 4 was for. `.gitignore`
  now carries `!build-profile.json` and the file is in the tree. The comment above `installer/cache/` claimed this was
  already true, which is why nobody re-read it.
- **A clean checkout printed `ENOENT` as a release decision.** `release:assemble` read the *generated* copy under
  `installer/nsis/`, which does not exist until `installer:script` has run. On a fresh clone the catch printed
  `RELEASE STOPPED: ENOENT: no such file or directory`. It now reads the root profile, and tolerates its absence with the
  sentence it was always meant to print.
- **The success message advertised an override that did not exist.** It told the operator the offline build "reads the
  file from `INFOFLEX_PREREQUISITE_VCREDIST` or `installer/cache/`". Nothing read that variable. An operator who moved
  the file and set it would have got a build that bundled nothing, and no error, because an unset define is legitimate.
  The message now states the one path and says there is no override, because a single path is what keeps the bundled file
  and the pinned digest the same file.
- **`--allow-unpinned` warned only to the terminal, and its files were missing from the checksum list.** The warning is
  now `release/DO-NOT-DISTRIBUTE.txt`, inside the folder somebody copies. And `SHA256SUMS.txt` was written *before* that
  file and `PREREQUISITE.txt` were created, so the two files whose purpose is to be checked were the two it omitted —
  found by grepping the built folder, now pinned by a test on the order of the writes.

**What is proven here.** The clean-clone behaviour was re-run after the fix (`RELEASE STOPPED` with a sentence, not
`ENOENT`). The redirect gate was verified against real 302 responses from a local server, and the address predicate was
run against six addresses and refused the four it should. The order bug was verified by building a folder and finding
`DO-NOT-DISTRIBUTE.txt` in `SHA256SUMS.txt`. Mutations — making `isAllowlistedAddress` always true, and restoring the
`installer/nsis` read — were both caught by the tests written for them.

**What is still not proven, and has not changed:** no real Microsoft download has ever been performed here, so the
redirect chain `aka.ms` → `download.visualstudio.microsoft.com` is copied from documentation and from the allowlist
rather than observed. `resolveFinalUrl` has run against a local redirect, not against `aka.ms`. The first release run on
a networked machine is the first time this code meets that chain, and `docs/RELEASE-CHECKLIST.md` asks for the digest and
version to be compared by hand at that point.

## Phase 15 (continued) — the version reader was never right, and the pin could only describe one thing

Two of the claims this project had been repeating were dischargeable rather than recordable, so they were discharged.
The first one came out badly.

**The version reader had three defects, and none of them was visible from a synthetic fixture.** `fileVersionFromWindowsResource`
looked for the UTF-16LE key `FileVersion` anywhere in the file and read what followed. It had never been run against a
real executable. The repository ships several — `signtool.exe` and the WiX compiler in `node_modules` — and running it
against them produced this:

| File | Old reader | Truth |
| --- | --- | --- |
| `signtool.exe` | `null` | `4.00 (WinBuild.160101.0800)` |
| `7z-x64.exe` | `null` | `16.04` |
| `candle.exe` | `]⼀[FileVersionMajorMinor]̀.⌀[AssemblyCompany]✀…` | `3.10.0.2103` |

1. **Alignment padding.** The key is padded to a 4-byte boundary and the padding is not one NUL — `signtool.exe` has
   three. The reader stopped at the first control character, so it returned `null` for every real file, which the caller
   reported as "unreadable on this machine" and the checklist turned into a blank a person fills in by hand.
2. **Real values are not bare numbers.** `4.00 (WinBuild.160101.0800)` does not match `^\d+(\.\d+)+$`.
3. **A linear scan finds the key in text that is not a version resource.** `candle.exe` embeds a WiX template containing
   `[FileVersionMajorMinor]`, and the old reader returned box-drawing characters as the version of the file. A wrong
   version in a release record is a fact somebody will compare against a real PC and believe.

The reader now searches for `VS_VERSION_INFO` first and only accepts a key inside it — every genuine resource has that
marker a few hundred bytes before its string table, and the template text that fooled the scan has none. Tests assert
all three real files exactly, and assert the *shape* of a version (digits, letters, dots, spaces, parentheses) so a
future false positive fails on form rather than on a lucky string. They skip with a stated reason if the packages are
ever pruned, rather than passing on an empty loop.

**The pin could only ever describe one component, and the release record was the place it would have gone wrong.**
`prerequisite` was a single optional object with `id: 'vcredist-x64'` typed as a literal. `download-allowlist.ts` is
written as a table so that a second component is an entry rather than a refactor, and a single-value pin would have
turned that into a trap: the release record reads the pin, so a second verified component would have been fetched,
bundled, and then omitted from the record of what the build carries — with nothing failing. The field is now
`prerequisites: BuildPrerequisitePin[]`, `id` is a string validated against the allowlist rather than a literal, a
duplicate id is refused, and readers match **by id rather than by position**. Pinning now merges into the list instead
of assigning it.

Adding a component to the allowlist is still not enough for the installer to carry it, and rather than leave that as a
quiet half-truth the generator now **refuses a profile that pins more than the installer can carry**, naming the
components and saying nothing was built.

**What is proven.** All three version-reader defects were found and fixed by running against real Microsoft-built
executables, and the tests fail if either the padding or the resource-boundary fix regresses (both mutations were run
and both were caught). The list change was verified end to end: a pinned profile produces `VCREDIST_SHA256` and
`PREREQUISITE_INCLUDE` exactly as before, and `release:assemble` still refuses a cache whose signature is not Microsoft's.

**What is still not proven.** The `info` about `aka.ms`'s redirect chain, and every claim about behaviour on a real
Windows PC, remain as they were: no networked release run and no Windows execution of these installers has happened
here. `docs/RELEASE-CHECKLIST.md` is what converts those into a person's observation.

## Phase 15 (continued) — the rebuild kit could not rebuild what it shipped

`release/installer-sources/` exists so the installer `.exe` can be rebuilt on a Windows machine without the rest of the
repository. It had two defects, and they pointed the same way: a folder that looks complete and cannot reproduce what
was shipped.

1. **Every missing file was skipped.** `if (!present(from)) continue`. `generated.nsh` and `prerequisite.nsh` are produced
   by `installer:script`, so a release assembled without that step shipped **both installers and neither of the headers
   they were compiled from** — while the folder still contained `installer.nsi`, which makes it look like a kit. The
   list is now explicit and required, each entry naming the command that produces it, and a missing one stops the
   release with the reason. Observed: running the assembly with `prerequisite.nsh` deleted now prints the file, the
   command, and `Nothing was written`, where before it copied six files and exited 0.
2. **The folder was never cleared.** A second release into the same tree kept the first release's headers beside the
   second release's installers: a `generated.nsh` carrying one digest next to an installer carrying another, and a
   rebuild that would silently differ from the shipped binary. Observed: a file planted in
   `release/installer-sources/generated.nsh` is gone after assembly, and all seven sources are present.

Both were found by asking what the release folder is *for*, not by running anything. The copy path itself cannot run on
this machine — the signature gate stops the assembly before it, correctly — so the guard is tested through an injected
predicate and the list is exported for a test, and both are labelled as tests of the guard rather than of the copy.

**A third observation, small and worth recording.** While observing the assembly messages the signature guard was
temporarily disabled; the tool then printed `Prerequisite verified on disk: … signed by null.` The guard was immediately
restored and nothing was committed in that state, but the observation was kept: a passing verification must never report
a null signer, and a caller that prints one must be able to assume it exists. The type says `string`; a test now says so
too, along with the case where the reader returns an empty string.

**What is still not proven.** Unchanged: no real Microsoft download, no Windows execution, no run of the offline
installer on a machine without the runtime. `docs/RELEASE-CHECKLIST.md` remains the place where those become a person's
observation rather than this project's claim.

## Phase 15 (continued) — the change broke the profile it had already written

Making the pin a list was correct and it introduced a migration defect, found by asking what happens to a
`build-profile.json` written by the previous commit rather than to one written by the current code.

The old file carries a real digest under `prerequisite` (singular). `parseBuildProfile` reads fields one at a time and
did not look at the old key, so the file **parsed successfully and silently became a development build**:

```
parsed: true
pins now: undefined
=> a pinned release profile from the previous commit becomes a DEV build, silently
```

That is the worst shape this class of bug takes. Nothing errored. `release:assemble` would have reported "no pin" and
told the operator to run `release:prerequisite` on a build that was already pinned, and the reasonable response —
running it again — would have hidden the fact that a file had been silently emptied of meaning.

`parseBuildProfile` now reads the old shape and marks the profile, and `release:prerequisite` prints a line naming the
command that rewrites the file. The marker is a runtime flag only: `serializeBuildProfile` builds its output from known
fields, so it never reaches disk. Verified on a real legacy profile: the pin is preserved
(`[ 'vcredist-x64 aaaaaaaa' ]`), the notice is printed, and the cache check then complains about the *right* digest —
which is how it should behave, and is proof the migration read the value rather than inventing a default.

**Why not refuse the old shape.** A refusal would strand a checked-out release profile with a message about a field
rather than about the build. The pin is valid data; the file merely holds it in a shape this version no longer writes.

**Why this keeps happening**, and it is worth stating once for the whole phase: every one of these defects lives where a
reader can succeed with an incomplete answer. A dropped field, a skipped copy, an allowlist checked before the redirect,
a digest compared without the file, a linear scan that finds the key in the wrong structure. The code ran, the answer
looked plausible, and plausible is what stops anybody looking. The tests added this phase are mostly assertions that a
check *fails* when it should — which is the only way to tell a working check from a decorative one.

## Phase 15 (continued) — the static checker could not see the file that decides whether the runtime ships

`npm run installer:check` reads a hand-kept list of includes and reports "Installer sources are consistent". The new
`prerequisite.nsh` was not on that list. With the file deleted, the checker still printed "consistent" and exited 0 —
because a file it does not read cannot be missing as far as it is concerned. The include it never read is the one
carrying `PREREQUISITE_INCLUDE`, which is the whole difference between an offline installer that bundles its runtime and
one that carries nothing and refuses at install time.

Fixed by adding it, and pinned two ways:

- one test asserts the specific file is in the list;
- one derives the list from `installer.nsi` itself — every `!include` that is not an NSIS vendor header must appear in
  `scripts/check-installer.ts`. The next include added to the script either goes in the checker or fails a test, so the
  list cannot silently go stale in the same way again.

Observed both directions: with the file deleted the checker now prints `FAIL installer/nsis/prerequisite.nsh could not
be read` and reports two problems; with it restored the check passes. Reverting the checker's list fails both tests.

**This is the fourth defect in this phase of the same family** — a check that runs, succeeds, and is not looking at the
thing that matters. The pattern is now explicit in `docs/DECISIONS.md`: every guard added here has a test that disables
the guard or removes the input and asserts the failure. A checker that has never been seen to fail is not evidence.

## Phase 16 — Client/server foundations

The product is moving from a single-PC point of sale to a shop **server** that owns the database and **clients** that
hold nothing and speak to it over authenticated transport. This phase builds the data and permission foundations for
that move and nothing else: no client executable, no new screen, no change to how a sale is rung up today.

The architecture change itself — kept, changed and removed, and why the repository was not swept into `apps/` and
`packages/` — is recorded first and separately in [ARCH_CHANGE_CLIENT_SERVER.md](ARCH_CHANGE_CLIENT_SERVER.md),
because the phase rules require that document to exist before code changes, not after them.

### What was built

**`packages/core`**, the code a client and a server both need: the four-role vocabulary, the permission policy, the
surface scanner, and re-exported money helpers. It imports no `node:` module, no `electron`, no `fastify` and no
`better-sqlite3`, and `packages/core/test/no-io.test.ts` walks its real import graph to prove it.

**One permission table.** `POLICY` in `packages/core/src/policy.ts` maps 107 IPC channels, 32 HTTP routes and the
actions that have no transport of their own to the roles allowed to use them. Absence is denial: `authorize()` returns
`no-policy` and the caller is refused. It is consulted in two places and nowhere else — the desktop `handle()` wrapper
in `src/main/ipc.ts`, and the Fastify route registrations in `src/api/server.ts` and `src/api/mobile-admin-routes.ts`.

**Migration 16**, additive, preserving every earlier table: `role_seats`, `client_devices`, `sessions`, `orders`,
`order_items`, `order_events`, `reservations`, `document_sequences`, `print_log`, `audit_signoffs` and `audit_flags`;
`users` rebuilt to widen the role CHECK and add `seat_no`; `sales` gaining `order_id`, `finalized_by` and
`server_receipt_no`. Schema reference: [SCHEMA.md](SCHEMA.md).

**The audit-only Supervisor.** `SUPERVISOR` lost its authority to approve returns and to resolve approvals, and that
loss is in the services (`return-service.ts`, `approval-queue-service.ts`), not only in the table. A role that holds no
operational authority cannot be the one granting it, so the rule lives where the operation happens.

### The DONE WHEN list, as proved by the suite

| Item | Result | How it is proved |
| --- | --- | --- |
| A migration plan exists | **pass — verified by tests** | `docs/ARCH_CHANGE_CLIENT_SERVER.md` plus the migration row in `docs/SCHEMA.md`, which `docs/docs-accuracy.test.ts` checks names every migration file that exists and no file that does not. |
| The Server launches and creates the DB | **pass — verified by tests** | `src/db/database.test.ts` opens a real database through `openShopDatabase`, applies all 16 migrations and re-runs them idempotently. |
| A test inserts and reads a record from each new table | **pass — verified by tests** | The same file inserts a row into every one of the 11 new tables and reads it back, and its table-coverage assertion is derived from the table list, so a new table with no row check fails it. |
| Every registered route and IPC channel has a policy entry | **pass — verified by tests** | `packages/core/test/policy-coverage.test.ts` derives the surface from `src/main/ipc.ts` and `src/api/*.ts` and compares it against the table in both directions. |
| A test fails when a policy entry is removed | **pass — verified by tests** | Two tests delete a real row from a copy of the table and assert exactly that name comes back unpoliced. Observed by hand as well: removing `ipc:pos:complete-sale` from `policy.ts` failed four tests. |
| Existing currency tests still pass | **pass — verified by tests** | `src/currency/currency.test.ts` and the end-to-end currency suites run unchanged; `packages/core/src/money.ts` re-exports the one implementation rather than copying it. |
| Existing licence tests still pass | **pass — verified by tests** | `src/license/` suites run unchanged. |
| Clients cannot open the DB by any code path | **pass — verified by tests** | `packages/core/test/ownership.test.ts` scans every TypeScript file in the tree, tracked or not, and fails on a client-side import of the database module or `better-sqlite3`. Planted files in `src/renderer`, `src/preload`, `mobile/src` and `packages/core` are each caught, and a file outside every declared directory is reported rather than allowed. |
| `docs/SCHEMA.md` written | **pass — verified by tests** | Updated and machine-checked by `docs/docs-accuracy.test.ts`. |
| A client on a second PC reaching the server over the LAN | **needs manual check on real hardware** | Owed in [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md). No client executable exists yet; this phase builds the foundations the client will need. |

### Two defects found while building this, both of the shape this project keeps meeting

**The pragma that did nothing.** Rebuilding `users` needs foreign-key enforcement paused. `PRAGMA foreign_keys = OFF`
inside the migration is a documented no-op inside a transaction, and the runner wraps every migration in one — so the
first version of migration 16 looked correct, ran, and failed later with `FOREIGN KEY constraint failed` far from the
cause. The fix is structural: a migration declares `setsForeignKeysOff`, the runner pauses enforcement *outside* the
transaction, and after the rebuild it runs `PRAGMA foreign_key_check` before restoring enforcement, so a rebuild that
orphaned a row is caught where it happened.

**The check that could not see the file that mattered.** The database-ownership scan read `git ls-files` only. A
brand-new client file that nobody had staged was invisible to it — and planting exactly such a file produced a green
run. Fixed by unioning `git ls-files --others --exclude-standard`, which is the difference between "what has been
committed" and "what is on disk and will be compiled".

### What this phase does not do

The physical `apps/server` and `apps/client` split, a client executable, order creation and finalisation over the API,
reservation expiry sweeps, and the Admin approval PIN are designed in the architecture document and deliberately not
built here. This phase is the foundation those rest on.
