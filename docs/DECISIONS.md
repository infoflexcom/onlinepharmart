# Architecture, licensing, and security decisions

**Product:** Infoflex Pharm and Infoflex Mart.

**Current phase:** Phase 11 — Vendor Cloud, building on host-enforced licensing, Product/Inventory, POS, Returns, accounting/reporting, settings and backup/restore, the Admin-only LAN PWA (Phase 9) and the Admin phone app (Phase 10). The Electron main process owns authorization and SQLite writes; mobile requests use the same shared report/return services, Admin identity, migration chain, and audit log. Phase 11 adds the vendor-side licence server and phone-friendly portal, the optional internet relay with the desktop's outbound client, and the deployment/privacy/relay-limit documents. Every claim in this file is backed by an automated test or is listed in `docs/PHASES.md` as something this environment could not test.

Packaging note: `better-sqlite3` is pinned to v13, which moved to N-API and ships ABI-stable prebuilt binaries (including `win32-x64`) inside the package. Electron-builder therefore packages the prebuilt binary instead of running `node-gyp` (`build.npmRebuild` is `false`, and `**/*.node` is unpacked from the asar archive). This removed the earlier blocker where the Windows build required cross-compiling a native module for Electron 45's ABI. `src/main/native-packaging.test.ts` guards the contract.

Phase 7 is closed on software scope; see `docs/PHASES.md`. Three hardware gates are owed and carried as release-time tasks, each tagged "needs manual check on real hardware", with step-by-step instructions in `docs/RELEASE-CHECKLIST.md`: (1) Windows x64 graphical installer plus DPAPI `safeStorage` in the packaged app, (2) physical iOS/Android certificate fingerprint check, root-CA trust, Add to Home Screen and update-after-rebuild, (3) live LAN Wi-Fi/router/firewall behaviour confirming LAN-only access with no port forwarding.

## Product and customer-operation rules

- Each installed shop is a single-shop database. The store name is entered by the customer and is never hard-coded. Sales/returns and shared business entries preserve store name, address, and phone snapshots for historical documents.
- NGN is the default currency. Built-in catalog options cover the requested codes; validated custom currencies are supported. Amounts are integer minor units, represented as SQLite `INTEGER` and JavaScript `bigint`. Half-up ties round away from zero. Display and user-input parsing follow the selected currency's precision and separator/symbol preferences.
- There is no foreign-currency payment handling, currency conversion, or live exchange-rate feed. These remain future work.
- Product price/cost entry is parsed against the selected currency's exact 0–4 decimal precision into integer minor units; excess decimals are rejected rather than rounded. Quantities and weights are integer milli-units. Product CSV/XLSX imports provide per-row errors; exports restrict costs to Admins and protect CSV formula prefixes.
- Admins manage products and prices/costs, import catalogs, receive/adjust/count stock, and manage supermarket purchase orders. Other authorized roles can view product/stock information with costs hidden; host authorization is authoritative even when the UI hides controls. The preview bridge is a memory-only demonstration.
- Batch-tracked products use FEFO stock consumption and expiry alerts. Desktop checkout performs its own all-or-nothing sale, payment, stock, batch-allocation, audit, and receipt-snapshot transaction; the separate inventory consume operation remains a stock primitive, not a replacement for checkout. Supermarket weighed-item prices use integer arithmetic and explicit half-up rounding.
- Desktop POS covers retail/wholesale checkout, split tender and customer credit, promotion/manual/loyalty discounts, prescription acknowledgement, FEFO batch snapshots, held carts, retry-safe sale keys, and immutable receipt/reprint history. Tax amounts are currently zero; tax rules and tax reporting are not implemented.
- Desktop Returns links requests to completed receipts, reserves quantities while over-limit approvals are pending, and allows at most one unresolved approval per receipt line to preserve exact value allocation. It completes stock/payment/ledger/loyalty/audit effects atomically. The Admin-configurable return window defaults to seven days (1–365); only Admins can override it with a reason. Sealed eligible Pharmacy items return to their original unexpired batch; non-resellable or expired stock is written off. Refunds, store credit, exchanges, and original sale currency/store document snapshots are recorded.
- The shop currency is locked by the first completed sale, purchase, return, or stock valuation. Draft/pending records alone do not lock it. Day close persists its own currency code but is not a lock trigger. Vendor/license currency policy has a separate schema lock source. License renewal never writes a replacement currency into shop settings; an existing transaction lock takes precedence over later license defaults.
- Every customer or vendor operation—building, installation, activation, currency selection, pairing, updates, and renewals—must have a graphical window or web page. The Build Studio policy page and desktop activation screens are graphical. No customer/vendor operation should require a terminal.

## License authority and lifecycle

- `src/license/license-manager.ts` is the host authority. Renderer navigation is presentation only. `DesktopHostController` checks license state on protected operations; first-run setup and login are refused unless `LicenseManager` returns a currently usable, verified policy. Packaged builds have no development-license bypass.
- The desktop checks the locally stored signed token and policy at startup and on protected calls. A background check-in starts at launch, repeats daily while the license is usable, and retries at the shorter expired/suspended interval. A manual check-in is available in the activation/recovery screen. The renderer refreshes the displayed state periodically; it is not the enforcement mechanism.
- License end dates are exclusive midnight-UTC instants. A license ending today is expired at 00:00 UTC that day. The host handles not-yet-valid, active, grace, expired, suspended, revoked, machine-mismatch, clock-rollback, invalid, and tampered states. A clock-rollback state cannot be cleared by replacing/renewing the license; the operator must correct the clock first.
- A lock does not delete, rewrite, encrypt, or otherwise damage shop data. The activation screen offers recovery options, and the active/grace expiry banner tells operators to finish any in-progress sale before expiry. Host checks prevent a new protected checkout or return from committing under an unusable license; held carts and completed records remain saved. Real Windows validation of interruption/recovery behavior is still required.
- The current license and full license-event history are stored locally in SQLite. Important activation, check-in, failed-attempt, recovery, and policy-import events are audited; activation keys and entered master-password values are not included in audit metadata. Rate-limiting delays for repeated password/key failures increase from 250 ms up to 30 seconds.

## Tokens, policy, secrets, and machine binding

- Online activation responses and imported `.lic` files must be Ed25519-signed by a key trusted by the installation. Only public Ed25519 keys are stored in the vendor policy. No vendor signing private key is included in this repository, app, mock response, or installer. If Build Studio pins a license-service URL, the host requires an exact normalized match before sending an activation key. The client refuses HTTP redirects so credentials cannot be forwarded to a different host. When the policy leaves the URL blank, the first successful activation endpoint is saved for subsequent check-ins; a separate secure endpoint-migration workflow is future work.
- Offline on-site license tokens use HMAC-SHA256 with a per-installation secret held by Electron `safeStorage` (Windows OS-protected storage in the intended deployment). The secret is not stored in SQLite. Current license fields and vendor policy have local HMAC integrity tags; missing, copied, or changed local state fails closed. If the local authenticator is unavailable, recovery by policy import requires the same vendor master-password hash; only current license-authentication state is reset, while license history and shop data remain. If the authenticator is intact but the machine ID differs, the vendor master password can directly issue a replacement bound to the current machine without reimporting or resetting the policy.
- The vendor master password is entered in Build Studio and in the on-site activation screen, but only a salted PBKDF2-SHA256 hash (310,000 iterations) is exported/stored. The password is not written to the policy file, SQLite, audit logs, cloud, mobile, installer, or source as a literal. Build Studio derives the hash in-browser, clears the password fields after export, and makes no network or browser-storage calls.
- `buildstudio/policy.html` exports an `.iflpolicy` containing the salted hash, optional maximum on-site term, license-service URL, and public keys. A blank term means **no configured cap**. The host enforces a configured cap; the supported configuration range is 1–50 years, with 50 years used as an operator sanity limit rather than a default cap. The policy file is schema-validated but is **not digitally signed** in this phase. Distribute it through a controlled vendor channel; future scope is a vendor-signed policy format and protected signing workflow.
- The machine binding is SHA-256 over the OS installation ID supplied by `node-machine-id`, namespaced for Infoflex. It is stable across launches but is **not hardware-backed**: cloned Windows images or privileged OS manipulation can duplicate/change the identifier. This prevents ordinary file-copy reuse but is not proof of physical hardware identity.
- Local HMAC integrity detects accidental/offline database edits and many copy/tamper cases, but a local Windows administrator who can patch the executable, alter OS state, or control the running account is outside this protection boundary. Hardware-backed identity/attestation and a stronger anti-tamper design are future security work.

## Check-ins, reporting, cloud, and privacy

- A check-in sends license ID, machine ID, app version, platform, check-in time, source, online state, and (for an on-site license) the signed-policy/report details needed for vendor reporting: edition, dates, status, default currency code/lock, selected mobile features, Admin-phone limit, and grace days. It never sends shop name, sales, stock, customers, users, transactions, or currency amounts.
- Renewal, edition/feature/status changes, and grace terms are accepted only from a verified signed response. A remote service cannot suspend an offline-only on-site license before the host's first report: the mock creates its server-side record on the first check-in.
- `cloud/mock/server.ts` is a local development harness, not a production service. License/device metadata is kept in process memory only. Its Ed25519 keypair is generated per process and its key ID is random; it does not persist customer licenses across server restarts. The development desktop may trust a public key advertised by a loopback mock only when unpackaged. Do not use this trust mechanism or mock key in production.
- The mock console exercises online activation, first on-site reporting, extension, and suspension/resume. A production cloud must use vendor-managed durable license metadata, protected keys, authentication, authorization, monitoring, and deployment review; it must never become a shop-data store.

## Host, persistence, and shared rules

- Electron main owns `better-sqlite3` at `<app.getPath('userData')>/infoflex.sqlite`. The renderer has no Node/database access and communicates through the narrow typed preload bridge.
- Database opening enables WAL, foreign keys, a busy timeout, and ordered transactional migrations. Migration compatibility imports the previous single `shop_settings` record while preserving existing business and audit rows.
- First-run setup is shown only when the verified license policy is active and no users exist. One immediate SQLite transaction creates the Admin (bcrypt hash), saves the full store/receipt profile, currency and display preferences, applies vendor lock state, and writes audit events. Store name is required. The successful flow returns to login rather than signing in automatically.
- `INFOFLEX_INSTALLER_CURRENCY` is a non-secret installer-to-host preselection setting for supported built-in currencies. A verified license currency takes precedence when there is no transaction lock; a vendor lock is rendered read-only and rechecked by the host.
- Role policy is edition-aware: Cashier and Admin accounts are available in all editions; Supervisor accounts are available only to Supermarket and BOTH licenses. Supervisors cannot manage users, use mobile access, or change Admin settings. Cashier wholesale, maximum discount, credit-sale, and return-limit permissions are stored per user.
- Authentication, account lockout, idle expiry, Admin-only user/password management, edition checks, role-page checks, and protected settings operations run in the host for each IPC request. Sessions store only a user ID and are rehydrated from SQLite on each request. The browser-only preview bridge is in-memory demonstration code, not an authority or production security boundary.
- `ShopService` and `ProductInventoryService` are shared host-side business logic. Desktop IPC calls them only after host license/session/page/role checks; future API adapters must reuse the service/permission layer rather than reimplementing currency or inventory rules in renderer/mobile code. Current Fastify scaffolding does not expose inventory routes.
- `createHostApi()` remains a factory; the Electron `MobileAccessService` explicitly starts it only after a signed-in Admin enables Mobile Access. It uses a private-address SAN leaf certificate signed by a root CA whose private key is encrypted by Electron `safeStorage`. The PWA and API share that HTTPS origin; the Electron server enforces private socket addresses even if a license also has an Internet entitlement. It does not trust forwarded headers or enable CORS. The API stays off by default and shuts down on app quit, LAN entitlement loss, or private-address changes.
- Pairing is a five-minute, one-use eight-digit code rate-limited by socket IP. The Admin-phone limit is rechecked inside the immediate SQLite registration transaction. Access tokens are opaque, high-entropy, 15-minute bearer secrets stored as hashes in `devices`; 90-day refresh tokens are hashed, bound to devices, rotated transactionally, and reuse revokes the device. Explicit logout, Admin revocation, password reset/deactivation/role removal, account invalidation, stale refresh expiry, and detected refresh reuse revoke device sessions. License capacity is freed by revocation.
- The PWA offers only Admin accounting summaries/PDF and pending return approval/rejection. It does not expose POS, stock mutation, customer records, or user management. The service worker caches static assets only; private API data is not cached offline. Each phone must install and fingerprint-check the exported root certificate. Phone trust installation is a manual OS step and is not detectable/enforceable by the desktop.
- Non-Admin, unauthenticated, feature-denied, and inactive-license requests receive generic denials and are audited. Automated tests cover pairing/session lifecycle, certificate generation, the HTTPS listener, local-network restrictions, PWA serving, and shared report/return routes. No physical-phone, real Windows DPAPI, Wi-Fi/firewall, or installer validation is claimed; a security and real-device release check remains required. Do not port-forward or expose the LAN listener to the Internet.
- Database triggers reinforce the currency lock and completed-record rules; stock movements and business entries are append-only. Product CRUD, stock receipt, reasoned adjustments, stocktake variance, purchase-order goods receipt, FEFO inventory consumption, weighed-price calculation, atomic POS sale/payment/receipt, and transactional Returns workflows are implemented host workflows. Tax calculation, payment-processor integration, and redemption of store-credit balances against a later checkout are not implemented; the FEFO consume operation is not a substitute for the POS transaction boundary.
- Sync scaffolding records local cursors and operation receipts with hashes/idempotency references only; it does not store replication payloads or authorize cloud transfer of shop data.

## Schema decisions

- The schema lives in ordered migrations under `src/db/migrations/`; its table reference is `/docs/SCHEMA.md`.
- Money fields use integer minor units only. Quantity/stock/weight fields use integer milli-units. Migration 8 adds product pack/reorder/wholesale fields, primary barcode ordering, purchase-order versions/receipt details, and stock immutability/negative-quantity guards. Product, stock, batch, and purchase-order writes compare optimistic versions in the service.
- Sales use an autoincrement sequence to produce a stored, unique, sequential receipt number. Completed sales cannot be changed or deleted by ordinary writes. Corrections must use a future audited reversal/void workflow, not rewrite history.
- Sales and returns store currency and store identity snapshots; purchases, stock valuation, payments, day close, cashier shifts, cash drawer events, and the shared business ledger also carry currency codes.
- Pharmacy- and supermarket-specific fields coexist in the shared products model; generic/prescription and batch/expiry tracking plus supermarket department, shelf, weighed-item, PLU, variants, and price-per-kg support are edition-aware. Verified edition claims gate service features, and a BOTH license follows the combined rules. Product costs remain Admin-only.
- `user_permissions` contains business permissions and deliberately has no mobile-access toggle. Admin-only mobile access is a host-side role assertion. Cashiers use desktop only.
- Device access credentials and rotating refresh credentials are stored as hashes only. The PWA keeps its bearer/refresh values in phone-browser IndexedDB; desktop TLS CA/server private keys are protected by OS safe storage and never shipped in the PWA. Passwords remain hashes only. License history stores license tokens/claims; no license private key or vendor master password belongs in the app, database, logs, installer, cloud, Build Studio, or mobile assets.

## Phase 8 decisions (settings, backup/restore, hardening)

- **Settings are split into identity and operation.** `ShopProfile` keeps what prints on customer documents (name, address, phone, email, licence number, tax number, logo, footer, thank-you note). A new `OperationalSettings` object holds receipt paper size, the "Powered by Infoflex" toggle, optional VAT, the shop-wide discount ceiling, printer, accepted payment methods, expiry-alert days, loyalty rate, supervisor PIN rules, and scale settings. Both live in the single `settings` row and are saved through `ShopService.updateOperationalSettings`, which validates with `normalizeOperationalSettings`, writes in one transaction with an audit event, and never touches a stored amount.
- **Amounts stay integer minor units; rates stay integer basis points.** VAT rate, discount ceiling, and loyalty rate are stored as basis points (0–10 000) so no percentage is ever a float. The VAT preview computes `total × rate / 10 000` in `BigInt`.
- **Payment methods and the discount ceiling are enforced at the till, not only displayed.** `PointOfSaleService.calculateTender` refuses a tender whose method the shop switched off, and `calculateSale` applies the stricter of the cashier's permission and the shop-wide ceiling. A setting that cannot change behaviour is a lie to the operator, so both are covered by tests. The credit/permission rules are unchanged.
- **Display preferences remain display-only.** "Symbol or code", position, and separators are still editable after the currency locks, and they change formatting only. Every display change is audited (`currency.display.updated`).
- **The currency lock explains itself.** The guard now distinguishes a vendor lock from a transaction lock, using one shared wording module (`src/shared/currency/lock-messages.ts`) so the host message and the Settings panel never disagree. Previously both cases reported "a transaction has been recorded", which was wrong for vendor-locked installs.
- **Backup is a single-file SQLite snapshot plus a JSON manifest.** `VACUUM INTO` produces one consistent copy (write-ahead log folded in) while the app runs, unlike copying the database and its `-wal` at two different moments. The manifest records format, version, timestamp, app version, currency code, store name, byte size, SHA-256, and per-table row counts.
- **Restore validates before it deletes.** Order of checks: Admin confirmation → manifest present and self-consistent → file hash matches the manifest → currency compatible → no newer rows would be lost → copy passes `PRAGMA integrity_check` and row counts on a staging file → only then swap. Every failure leaves the live database untouched, and each message says "Nothing was restored".
- **Restore never rewinds licence state or the paired-device list.** The staging copy has the licence tables (`license_state`, `license_history`, `license_runtime`, `license_vendor_config`), `devices`, `refresh_tokens`, and `backup_log` replaced by the running install's contents; the audit journal is the union of both. Backups never contain or restore credentials from another machine's licence.
- **Currency after restore.** A backup whose currency differs is refused when the live shop has transactions (mixing currencies would silently corrupt reports). On an empty install the restored shop adopts the backup currency and locks it, because the restored books are already kept in it. Restored data with transactions always ends up locked.
- **A restore replaces the database file, so the app restarts.** Older service instances in the same process would be reading a deleted file. The main process reopens the shop repository for the restore's own bookkeeping and then relaunches the app; the customer still only pressed a button. A safety copy of the replaced database is written next to the live database before the swap.
- **Automatic backups are daily and local.** The main process runs a check at start-up and every six hours; the service makes at most one automatic backup per calendar day into the app-data `backups` folder and keeps the thirty newest. A shop with no backup, or one older than seven days, sees a warning in Settings. No command line is required for any backup or restore step.
- **Restore operations are path-confined.** The folder is trimmed and length-capped, the file name is reduced with `basename()` and must match the Infoflex backup naming pattern, and only manifest-verified pairs are restored, so a crafted file name cannot reach outside the chosen folder.
- **Security review is machine-checked.** `src/main/security-review.test.ts` asserts that every IPC channel maps to a specifically guarded host method (with an explicit, reasoned list of the pre-sign-in exceptions), that the IPC registrar rejects sub-frame senders, that preload and main agree on the channel list, that settings/backup methods are Admin-only, that every mobile API route has an authorising pre-handler, that replies are fixed messages rather than raw errors, that no SQL statement interpolates a bound value, that no secret reaches a console call, and that the master password is stored only as a salted PBKDF2-SHA256 hash. New channels or endpoints that skip a check fail the build.

## Phase 10 decisions (the Admin's phone app)

- **Pairing no longer mints a session.** The old flow exchanged the eight-digit code for an access token, which meant possession of a code was the whole of authentication. Now the code only creates a **PENDING** device plus a request token held by the phone; the device has `token_hash = NULL`, so it can reach nothing but the pairing page. The Admin approves on the PC, which activates the phone's request token as its device token, and only then can the phone log in. Approval is not sign-in.
- **Three-step pairing, each step independently useless.** (1) `POST /api/v1/mobile/pair` → `202` with `{requestId, requestToken}` and no credential. (2) `GET /api/v1/mobile/pair/status` long-polls and returns only a status word. (3) `POST /api/v1/mobile/session/login` needs Admin username + password + the device token (+ authenticator code off-LAN). A stolen code gives an attacker nothing; a stolen device token gives an attacker nothing; only the admin's password completes a session.
- **Admin-only is enforced in the host, not by the client or a setting.** `assessMobileEligibility` rejects every non-`ADMIN` role as a first-class reason, `MobileDeviceService.login` always runs bcrypt (a dummy hash for unknown users) so timing does not reveal existence or role, and every failure throws the single constant `MOBILE_LOGIN_DENIED`. `authenticateBearer` re-reads the user row on **every** request, so demotion, deactivation or a lock cuts the phone off on the next call rather than at token expiry. `/api/v1/mobile/session/logout` is Admin-gated too, so there is no mobile route a non-Admin credential can cause to act at all.
- **Lockouts are per device as well as per IP.** Five wrong passwords lock that phone for fifteen minutes even from one address, because the realistic attack on a counter phone is a person holding the unlocked phone. The per-IP budget (5/minute) still sits in front of it, and non-Admin attempts count toward both, so trying a Cashier account is as expensive as guessing a password.
- **The QR codes are drawn by our own encoder, and checked by someone else's decoder.** The pairing card and the authenticator set-up show a QR image so a normal camera app can open the page without anyone typing `192.168.1.20:43871`. Rather than add a runtime dependency to the desktop bundle, `src/shared/qr/qr-code.ts` implements byte-mode QR with level-M error correction for versions 1–10 (about 213 bytes, far more than any address or `otpauth` URI here). The tests assert structure (finders, timing, dark module, version/alignment placement, determinism, a refusal rather than a truncated code when the payload cannot fit), and the matrices were additionally round-tripped through the independent `jsQR` decoder — `npm install --no-save jsqr && npx tsx scripts/verify-qr-code.ts` covers five LAN/`.local` addresses plus two authenticator URIs, which need versions 7 and 9. That script is deliberately outside `npm test` and outside the dependency list, so the shipped bundle carries no decoder. The image carries the **address only** — never the pairing code, never the password — so a photograph of the screen does not shorten the three-step pairing, and the caption says the code is typed separately.
- **The authenticator secret is sealed by the OS.** `users.totp_secret_ciphertext` holds the secret encrypted with Electron `safeStorage` (DPAPI on Windows); there is no plaintext column and no plaintext log line. Verification accepts ±1 time step and stores `totp_last_step`, so a shoulder-surfed code cannot be replayed. Off-LAN logins always require a code; on-LAN they do not unless the Admin asks for it, which is the balance between the threat (remote attacker) and the friction (owner standing at the till).
- **The four-digit approval code is compared by a human, not by the server.** The phone displays it, the desktop pop-up shows it, and the Admin decides whether they match. It is stored in the audit metadata rather than a plaintext column, and it never authenticates anything by itself.
- **Licence problems get their own message, everything else gets a generic one.** `GET /api/v1/licence` is deliberately public and returns only `{usable, status, message}`; protected routes answer a lapsed licence with a licence-specific sentence so the phone can say "ask the Admin to renew", while role and credential failures stay indistinguishable. The security review's route allowlist names this endpoint explicitly with its reason.
- **`devices` was rebuilt, not altered.** A pending device has no access token, so `token_hash` had to become nullable; SQLite cannot drop `NOT NULL` in place, so migration 14 follows the documented create/copy/drop/rename procedure inside the migration transaction with `foreign_keys` paused and verified with `PRAGMA foreign_key_check` afterwards. Existing pairs keep their token hash and are treated as approved, so an upgrading shop does not re-pair.
- **Only approved phones consume a licence slot.** `LicenseManager.assertAdminPhoneCapacityForUser` counts `approved_at IS NOT NULL`, so a pending request can never block the approval that would let the shop use its licensed phone.
- **An approved phone is not expired just because it has never signed in.** `expireExpiredSessions` skips devices with no refresh token at all; approval is the trusted state and a *session* is what expires. Without this, opening the Mobile Access screen revoked a freshly approved phone — a bug the new tests caught. Abandoned pairing requests are revoked after a day instead.
- **Firewall changes are narrow and explicit.** One inbound TCP rule, one port, **Private profile only**, created only when the Admin presses "Repair firewall rule". Detection reads `Get-NetFirewallRule`/`Get-NetFirewallPortFilter`; a rule scoped to the Public profile counts as blocking because the shop LAN is private. A failed query never claims the port is blocked (that would send the owner chasing the wrong problem).
- **The host keeps running from a tray icon.** Closing the window hides instead of quitting while mobile access is on; "Start Infoflex when Windows starts" uses the normal login-item mechanism with a `--hidden` argument, never a scheduled task or registry edit. A `powerSaveBlocker` is held only while a phone is actually connected and is released the moment it disconnects, so the PC is never left permanently awake.
- **Bluetooth is deliberately not used for mobile access.** iPhone web apps cannot use it (no Web Bluetooth in Safari on iOS), and even where it exists the throughput and reliability are far below Wi-Fi for an approval flow. Bluetooth printers and scanners on the PC are unaffected because they are a desktop concern. This is documented on the screen as well so an owner is not left wondering.
- **One approvals queue for four kinds of request.** `approval_requests.request_type` now carries `RETURN`, `DISCOUNT`, `CREDIT`, and `VOID`, read through a single `ApprovalQueueService` that issues conditional `UPDATE ... WHERE status = 'PENDING'` writes so two Admins pressing Approve cannot both succeed. Credit is Admin-only; returns, discounts and voids are Admin or Supervisor. The same rows feed the desktop panel and the phone, and every created or resolved request is broadcast on the existing `/api/v1/admin/events` WebSocket; the panel also polls, so a dropped socket degrades to a few seconds' delay rather than a blank screen.
- **Stock changes are idempotent, and the existing table was reused.** `IdempotencyGuard` writes into the `idempotency_keys` table from migration 1 (`route` = scope, `request_hash` = body fingerprint, `response_json` = the original answer) rather than adding a second ledger. The claim and the work share one IMMEDIATE transaction, so a concurrent retry sees the claim and is told to wait; a failure rolls the claim back so a genuine retry can proceed; reusing a key for a *different* body is refused. Optimistic locking (`row_version`/`stock_version` with `UPDATE ... WHERE row_version = ?`) already guarded concurrent *different* edits and is unchanged.
- **Amounts on the phone are formatted on the phone.** The API returns integer minor units as strings plus the currency definition; `mobile/src/main.ts` renders them, so changing the display preferences never requires a server change and no symbol is hard-coded in the shell.

- **The phone's shell is plain DOM, not React.** The Admin PWA ships as one small entry bundle built with `document.createElement` helpers (`mobile/src/admin-screens.ts`) rather than a React runtime. The desktop is React, but the phone is opened on a mid-range Android over a weak shop Wi-Fi: the React runtime and a component tree would add ~45 kB gzipped and a hydration cost before the first screen appears, and none of the phone's screens need component state beyond what a re-render of the whole screen already gives. The screens remain split into pure builders, so they are unit-tested without a browser.
- **Admin-only is enforced in the host, and in four places.** The login refuses every non-Admin with the same generic sentence after the same bcrypt work (`mobile-login-policy.ts`); every phone API call re-reads the user row so a demotion, deactivation or lock bites on the next request rather than at token expiry (`MobileAdminService.requireAdmin`); pairing only ever attaches a device to an Admin; and demoting or deleting an Admin revokes their devices immediately. The phone has no cashier mode and no selling screen at all, so even a hypothetical role confusion has nothing to reach.
- **The phone renders money, and only the currency table spells a symbol.** The API sends integer minor units as strings plus the shop's `CurrencyDefinition` and display options. `mobile/src/money.ts` calls the desktop's own `formatMoney`, so a 0-decimal shop shows `USh 255,000` and a comma-decimal shop shows `1.000,00 €`. The build test asserts that each currency glyph appears in the built shell exactly as many times as the currency table spells it — one changed formatter would break the test rather than ship a second set of rules.
- **Price boxes on the phone accept what the shop's currency accepts.** A price input prefills in the shop's decimal places and separator (`250`, `250,5`), refuses more decimals than the currency allows with the host's own words ("This currency allows at most 0 decimal places"), and then sends a plain decimal that the host parses and validates again. The phone therefore never rounds silently and never invents a second validation rule.
- **A product scanned but never stocked is added from the phone.** The host insists on an SKU; a carton at the shelf has a barcode but no SKU. The phone derives the SKU from the barcode (with a numeric suffix if that SKU is already taken) rather than inventing a new host rule or making the Admin walk to the PC. Everything else — prices, edition rules, the audit trail — goes through the same `ProductInventoryService` the desktop uses.
- **Web Push is deliberately not shipped in this phase; in-app badges are.** A real push implementation needs a VAPID key pair stored by the host, a subscription store, and an iOS-installed-app delivery path that cannot be exercised without a physical iPhone — and the brief lists push as optional with a badge fallback. What ships is the in-app badge (the approvals tab count and the dashboard tiles), which is honest, always current, and needs no key material that this environment could neither test nor keep secure. The decision is recorded here rather than left implied.
- **A screen that was overtaken says "changed, reload" instead of overwriting.** Every stock and product write carries the `rowVersion`/`stockVersion` the screen was built from; a mismatch is a 409 with `reloadRequired: true` and `code: 'STALE_VERSION'`. Stock adjustments also carry an idempotency key generated once per submission, so a retried request after a dropped connection cannot move stock twice.

## Phase 11 — Vendor Cloud (licence server, portal and internet relay)

- **Two builds, one contract.** The licence server ships twice: `cloud/src` (Node, Fastify, SQLite, includes the relay) and `cloud/php` (dependency-free PHP 8.1 + MySQL, no relay). Both speak the identical four-call API that `src/license/server-client.ts` already used, and both sign the same Ed25519 envelope that `src/license/crypto.ts` verifies. That is why the desktop needed no new wire format for Phase 11: a portal-created licence reaches an existing till unchanged. The PHP build is not a second, simpler licensing model — it is the same rules in a language a shared host can run, and its 32-check suite proves the token is byte-identical to the Node build's.
- **The cloud stores licence and contact data only, and refuses the rest.** `ALLOWED_COLUMNS` (Node) and `ifx_allowed_columns()` (PHP) enumerate every column, and a schema test fails on anything not listed; the public API answers `400 business_data_not_permitted` for twenty shop-data keys. Currency travels as a **code** plus a lock flag, never a symbol, rate or amount. This is a construction, not a policy: there is no column that could hold a sale.
- **The vendor's private key is a file, never a value in the tree.** The signing key is loaded from a path (`INFOFLEX_CLOUD_SIGNING_KEY_FILE`, `signing_key_path`) and the cloud refuses to start without it; `secrets.test.ts` walks the repository for PEM bodies and password hashes and fails the build if one appears. The vendor master password never reaches the cloud at all — Build Studio keeps only the PBKDF2 hash.
- **The relay is a documented trusted pass-through, not a claim of end-to-end encryption.** The shop PC dials out (`src/main/relay-client.ts`), the cloud turns HTTP into frames (`cloud/src/relay/server.ts`), and the phone's request is answered by the shop's own listener. The relay terminates TLS and can therefore read what it forwards; libsodium and Noise are not available in this environment and a handshake that only ever ran in a unit test would be a lie. `cloud/docs/RELAY-LIMITS.md` says so plainly, the portal repeats it, and the screen where the Admin ticks the option repeats it again.
- **The phone's link is minted by the shop, from a per-shop key.** After a verified `hello`, the relay sends a `welcome` frame carrying a grant key derived as `HMAC(master secret, shop address)`. A shop can therefore mint links for itself and for no other shop, and it never holds the vendor's secret. The link is an HMAC over `{shopId, machineId, expiresAt}` in `src/shared/relay/protocol.ts` — one copy of that rule, shared by the minting client and the verifying relay, so the two cannot disagree. A link lasts ten minutes and is re-minted every time the screen draws a QR code.
- **A relayed request is an internet request, and the marker that says so is honoured from loopback alone.** The relay client connects to the shop's listener from `127.0.0.1`, which the listener would otherwise classify as the shop's own network — the exact shortcut the design must prevent. So the client adds `x-infoflex-relay: 1`, the listener accepts it **only from a loopback peer** (`arrivalFor`), and a relayed request then requires the `mobileInternet` entitlement and cannot skip the authenticator. A phone on the shop's Wi-Fi adding that header changes nothing, and a public address adding it is still refused. Two tests in `src/api/server.test.ts` are the boundary.
- **The host's rules are untouched by the relay.** The relay cannot approve a device, mint a session or skip TOTP, because it copies bytes into the shop's own API, where `MobileAdminService` and `MobileDeviceService` still require Admin-only identity, device approval and (over the internet) an authenticator code. A cashier is refused over the relay exactly as on the LAN — proved end to end in `src/main/relay-client.test.ts`, where a real cloud relay, the real `RelayClient` and the real listener all run.
- **A frame may name a path, never a destination.** `RelayClient.localTarget()` is fixed by the host; a frame cannot make the shop's computer fetch an arbitrary URL, and with no listener the client answers with its own refusal rather than going elsewhere. Both are asserted.
- **The relay's address is published by the licence server, never typed.** `/api/license/config` carries `relayUrl` when the deployment runs a relay; the desktop stores it (`license_vendor_config.relay_url`) after activation and refreshes it on check-in, accepting only a `wss://` host with a real domain name. A shop cannot be pointed at somebody else's relay by a typo or a phishing e-mail, and switching the relay on later needs no visit to the shop.
- **Internet access is off by default and needs three separate things to be true.** The signed licence must carry `mobileInternet`; the Admin must press the switch on the Mobile Access screen (persisted in `settings.mobile_internet_enabled`, which existed unused since migration 1 and is now wired); and the PC must be running with local mobile access on, because every relayed request is served by that listener. Any one of them false, and the phone falls back to the shop network.
- **Suspension bites immediately.** `RelayHub.disconnectShop` drops an open tunnel and `RelayVerifier.forget` clears the cached decision, so a vendor suspending a licence from a phone disconnects the shop's tunnel rather than waiting for the next reconnect. On the desktop, `applyLicenseChange()` runs whenever the licence summary is read after a check-in, so the screen tells the truth instead of showing a socket that is about to be refused.
- **Deployment is click-first, and the honest exceptions are named.** `cloud/docs/DEPLOYMENT.md` is written for somebody with a hosting panel and no terminal; the two things that genuinely cannot be clicked — generating an Ed25519 key and installing Docker on a bare VPS — are called out with the exact command to forward to support, rather than hidden behind a fake web page (an earlier draft of that guide pointed at a "generate your secrets" URL that did not exist, which was removed).
- **The privacy notice is a template the software already keeps.** `cloud/docs/PRIVACY-NOTICE.md` cites the Nigeria Data Protection Act 2023, names the lawful bases, the retention periods and the NDPC complaint route, and states the relay's limit in the customer's own terms. Every promise in it is either asserted by a test or listed in a short checklist for the vendor.
- **`docs/PHASES.md` records what could not be tested here.** No browser and no phone exist in this environment: the portal is proved through `server.inject` (real routing, real HTML) rather than a screenshot, and the phone's half of the relay is an HTTP request rather than a physical handset. The PHP build's MySQL-specific DDL runs against SQLite because no MySQL server is reachable. Those are stated as gaps, not glossed.

## Phase 12 — Polish, demonstration data and the full test sweep

- **The demonstration dataset is data, not a mode.** Loading it writes ordinary products, batches, promotions and users through the same tables a real shop uses; there is no `demo_mode` flag anywhere and nothing in the sale, report or licence path knows the difference. That is deliberate: a demo that took a different code path would prove nothing about the real one, and a flag would have to be honoured by every query in the system for the rest of its life.
- **Loading demo data is not a transaction.** The brief allows either reading, and this build takes the safer one: a demo load creates no sale, return or purchase, so `isCurrencyLocked()` stays false and an Admin who tries the demo before opening for business can still switch currency afterwards. Only real trading locks what the shop sells in. The one place this required new machinery is stock: `receiveStock` and purchase receipts write a business entry, which the currency-lock guard (correctly) treats as trading. So demonstration opening stock is written by a private `seedOpeningStock()` as `reference_type = 'DEMO_SEED'` movements with a null `created_by` — real enough to be counted, sold and reported, and unmistakably not a purchase.
- **Immutable stock movements got one narrow, explicit exception rather than a weakened trigger.** Migration 15 re-creates `stock_movements_are_immutable_delete` with `WHEN OLD.reference_type <> 'DEMO_SEED'`. Every real movement is still undeletable, and the exception is a single string that the seeding code is the only writer of. The alternative — dropping the trigger for the duration of a removal — would have made the immutability guarantee conditional on a caller's good behaviour.
- **Removal refuses rather than cascade-deletes.** `findRealUsage()` looks for a sale item, a return item, a purchase item, a non-`demo-` movement, or a sale rung up by a demonstration cashier. If it finds any, removal stops and says so in plain words; if it finds none, the dataset is removed cleanly and the catalogue is empty again. A cascade would have been easier and would have been the one path in this application that can delete a completed sale.
- **The currency lock was tested as an attacker would test it.** `src/api/locked-currency-channels.test.ts` invokes the real `settings:change-currency` IPC handler with whatever a hostile renderer would send, calls the host controller beneath it directly, and then throws seven plausible phone routes at the API and asserts each is 404/405. The phone has no currency route today; the point of the test is that adding one later fails here.
- **Every built-in currency is swept, not sampled.** Testing NGN, USD, JPY and KWD proves four rows out of fifty-four. `src/currency/currency.test.ts` now formats, parses, re-parses, negates and rounds an amount in all of them, through each currency's own separators and symbol side. **That sweep found a real bug**: `formatMoney` writes negatives with a true minus sign (U+2212) outside the symbol, and `parseMoney` could not read its own output back. Fixed in `stripCurrencyToken` by lifting the sign, stripping the currency token, and putting the sign back.
- **One palette, checked as a fact.** The Phase 12 brief names navy `#1F3F73`, gold `#C9A24B` and off-white. The desktop stylesheet already used them; the phone app and the mobile-access stylesheet had drifted to `#17345F` and `#C6A45D`. Those literals are now replaced, so a designer comparing a phone screenshot to a desktop screenshot sees the same two colours.
- **Empty states, loading states and confirmation dialogs already existed and were left alone.** Every destructive action in the UI (currency change, user deactivation, revoking a phone, turning off mobile access, regenerating a certificate, removing demo data, discarding a held cart) goes through `window.confirm`; every list has an explicit empty message. Rather than rewriting working components to look more modern, the panel this phase added was given the same treatment and tested that it does it.

- **Money leaves the host as a decimal string, converted in exactly one place.** `JSON.stringify` throws on a BigInt, and the host computes in `bigint` minor units, so every successful phone response has to be converted. Phase 12 found that only one route did it: the reports route answered 500 the first time it was loaded with money in the shop. The fix is not a per-route reminder — it is a single `serializeBigInts` in the route wrapper, so a route added tomorrow is correct by construction. A rule that has to be remembered at every call site is a rule that will be forgotten at one, and this one was.
- **The phone's price parser accepts what the phone's own display prints.** `formatMobileMoney` renders `₦1,234.56`; `parseMoneyInput` refused the symbol, so copying an amount off the dashboard into a price field was rejected. The desktop's parser already tolerated the token, so the phone now does the same. The two parsers still differ deliberately on one point: the phone refuses a negative price outright, because no price is negative and the host would reject it a layer later with a less useful message.

- **A test matrix is re-audited by opening the files, not by reading it.** Phase 12's matrix was wrong once — it claimed phone money coverage in four currencies when the route layer had no successful-response test at all. After fixing that, every remaining row was checked by opening the cited file and locating the claimed scenario. That exercise is cheap and it is the only thing that makes the table worth reading; a matrix nobody re-reads decays into marketing copy. It found one further gap (the phone-API row had only ever run the Both edition), now closed, and confirmed the rest.
- **Test data obeys the same edition rules as the product.** The new per-edition tests initially failed on a Pharmacy licence because the draft set a department and a shelf location — supermarket-only fields — and then because Pharmacy stock arrives as an expiry-tracked lot. That is the service working correctly. The fix belongs in the test data, never in a relaxation of the rule, and both facts are now written into the fixture so the next reader learns them from the code rather than from a failing build.

## Phase 13 — the graphical installer

- **NSIS, driven by electron-builder, rather than Inno Setup.** Both can satisfy the brief. electron-builder already drives NSIS, so the installer and the app it installs come from one build, one version number and one icon set; Inno Setup would be a second toolchain to keep in step with the product. The trade was accepted knowingly: NSIS has no crypto and a weak macro language, and rather than lean on either, the crypto is a separate tested helper and **every rule lives in TypeScript** under `installer/src/`.
- **No business rule is written in NSIS.** The `.nsi` draws pages and does file I/O. The password gate's five-attempt limit, the currency table and its example line, what counts as a green tick or a red cross, which URL may be downloaded and what happens when verification fails — all of it is pure functions with tests. This is not tidiness: `makensis` cannot run in this build environment, so a rule written in NSIS would ship completely unexamined, whereas a rule written in TypeScript is proved by `npm test` before the build machine ever sees it.
- **There is no function that downloads to a URL.** `resolveDownload(id)` takes an allowlist *id* and nothing else, so a caller cannot express "fetch this address instead" even by mistake. The URL is re-validated (HTTPS, allowlisted host) after lookup, which is redundant while the table is the only source — and worth keeping precisely because it still holds if somebody later adds an entry with a typo.
- **An unpinned checksum fails rather than guessing.** `download-allowlist.ts` ships an all-zero SHA-256 for the prerequisite, so a build whose checksum has not been pinned cannot install that prerequisite instead of installing an unverified one. The failure points in the safe direction, and the release step that fixes it is written down in `installer/README.md`.
- **The password gate refuses to live in NSIS.** NSIS can only compare strings, and anything it *can* compute from the password would be trivially reversible from an installer binary that ships to every customer. So the installer shells out to a small bundled helper that does PBKDF2-SHA256 with the same 310,000 iterations and the same hash format the application already uses — one rule, one format, one place to rotate the password. A missing helper fails closed.
- **The installer writes exactly one file for the app, and it holds no secret.** `%ProgramData%\Infoflex\install-config.json` answers one question — which currency — and contains no licence, password, database path or user. The update and repair paths may not write it; only a fresh install may. A corrupt or hand-edited file is treated as "no choice" rather than as an error at startup, because a shop with an unreadable installer setting must still be able to open the app and pick its currency.
- **A custom currency from the installer had to be registered, and was not.** The installer offers "Custom currency...", but `setInstallerCurrencyCode` accepted only built-in ISO codes, so a shop that chose its own money would have had the choice silently dropped at first run and been given the default. Found by the integration test that joins the installer's file to the setup screen, and fixed by letting the repository register the custom definition through the same validation the setup screen uses.
- **The installer's rules are checked by a hand-written static checker.** Since the script cannot be compiled here, `check-nsis-script.ts` catches the errors a person actually makes in NSIS — a `Call` to a function that was never declared (the first mistake made while writing it), unbalanced `${If}`/`${Loop}`/`Function` blocks, a page macro defined but never inserted so the page silently vanishes, a define redefined with a different value. It does not pretend to prove the script compiles, and `docs/PHASES.md` says so.
- **The three-button fallback appears only after a failure, and Retry withdraws itself.** The rules for when each button is honest live in `downloadFailureOptions` and are tested: Retry while attempts remain, Browse always (a file the customer already has is still checksum-verified before it runs, so browsing is never a way round the publisher check), and the offline pointer only when an offline build exists. After the third failure Retry is disabled and the message stops suggesting it, because a fourth attempt on a connection that has failed three times wastes a shopkeeper's afternoon.
- **A checksum mismatch stops offering Retry entirely.** A flaky line produces a short or failed file; a file that arrives complete with the wrong digest is a different event — the wrong file arrived. Retrying would fetch the same wrong file, so the page jumps straight to Browse or the offline installer and says the file was deleted and not run.
- **"Use the Offline installer instead" explains, and then closes.** An online installer that cannot download its own prerequisite is in no position to fetch a 400 MB offline build, so the honest action is to name the alternative and leave the computer untouched rather than pretend to fix itself.

- **The live example is proved for all fifty-four currencies, twice.** An earlier test asserted the three examples the brief prints and then looped over the rest checking only that the output contained its own symbol — which is a sample with a formality attached, and the shopkeeper whose currency was never looked at is the one who finds the error. The page's example is now pinned for every currency in a transcribed table, and independently re-derived in the test from the currency's decimals, separators and symbol position by code that shares nothing with `formatMoney`. The table catches a regression in the formatter; the second renderer catches the two of them agreeing on something wrong.

- **The installer's JSON is written by hand, and therefore tested like code.** NSIS has no JSON writer, so `EscapeJson` in `json-escaping.nsh` implements JSON's escaping. The risk is obvious in hindsight: nothing parsed the emitted file, and it was invalid JSON for every currency — unescaped separators, and a malformed conditional writing `installerKind` twice. `install-config-writer.test.ts` now reconstructs the file from the script's own `FileWrite` lines and parses it with the app's reader, so the two writers cannot drift unnoticed again.
- **A custom currency that cannot be written safely is refused at the point of entry, not corrupted at the point of writing.** A letter outside ASCII would need `\uXXXX`, which needs a code point NSIS cannot get without a plugin; passing the raw character through would depend on the encoding a Unicode NSIS build chooses, which cannot be tested in this environment. Rather than guess and ship a silently corrupt file, `customCurrencyRecordingProblem` refuses the value while the customer is still looking at the field, with a sentence that says to re-enter it. Refusing early and in plain words is better than accepting the input and losing it later.

## Phase boundaries and verification

Phase 11 adds the vendor cloud: the licence server and portal in two builds (Node with the relay, PHP without it), the desktop's relay client, the Admin's switch for internet access, and the deployment, privacy and relay-limit documents under `cloud/docs/`. The current delivery includes migrations through 14; product/catalog and inventory workflows; POS and returns; accounting/reporting; the Admin LAN PWA with pairing, TLS, refresh/revocation, and shared mobile report/approval services; Phase 8 settings, local backup/restore and the security review; the Phase 9 Admin-only mobile host with approval, two-factor login, firewall repair, tray keep-running and the shared approvals queue; and the Phase 10 Admin phone app (dashboard, stock, sales, approvals, reports, devices) served as a plain-DOM PWA. Vendor signing-key rotation without a redeploy, signed Build Studio policy files, hardware attestation, later store-credit redemption, and verified Windows installation/DPAPI behavior remain future work. Tax/VAT is now configurable and printed, but the tax rules of a specific jurisdiction (multiple rates, exemptions, tax-authority filing formats) are not implemented. Existing shop databases apply pending migrations at host startup; take a backup and verify the recorded migration version before deployment. Tests here use in-memory databases and do not establish the migration status of any external shop database.

Run `npm run check:phase11` for typecheck, the full automated suite (including the cloud and PHP suites), web/PWA builds, and Electron bundle build. `npm run check:phase10` and earlier remain available. `check:phase9`, `check:phase8`, `check:phase7` and earlier remain available; licensing checks remain `npm run check:license` / `npm run check:phase4`. Manual release checks are still needed for real iOS/Android certificate trust and PWA installation (including the installed-app splash, a real camera scan, the share sheet and print at the counter), real-phone pairing and authenticator apps, Wi-Fi/firewall behavior, tray/minimise-to-tray and start-with-Windows on a clean Windows machine, Windows safeStorage/DPAPI and installer contents, actual `.lic` import, privacy inspection of outgoing license check-ins, and customer/vendor GUI flow. Automated local TLS tests do not replace these physical-device and Windows checks.

The full npm audit currently reports the new GHSA-fc5q-39xc-vjpf / CVE-2026-112366 advisory for `picomatch <= 4.0.7` through Vite/Vitest/Electron build tooling. On 2026-11-17 the registry has no patched release; the upstream repository has not shipped a fix. The affected packages are dev/build-only (`npm audit --omit=dev --audit-level=low` reports no production dependency vulnerabilities). Do not apply the suggested force-downgrade; recheck the advisory and upstream release before the next release build.

## Phase 15 — packaging, documentation and release

- **Three installer defects were found by trying to build, and none of them by the test suite.** `installer:check` passed before and after every one of them. Two were electron-builder schema violations (`"//"` comment keys, and `defines`, which is not an NSIS option) that made both configs invalid, so **neither installer could ever have been built**; the third was worse and quieter — `installer.nsi` was written as a standalone script and was never wired in as `nsis.include`, so electron-builder would have compiled its own stock wizard, our password gate and currency page would not have existed in the shipped `.exe`, and the script in any case created desktop and Start Menu shortcuts and a firewall rule without ever installing the application. The lesson is specific: a static checker proves properties *of the file it reads*, and none of these three were properties of that file. The config side now has its own test (`perMachine`, `allowElevation`, `include`, and the absence of `script`), and the checker gained a rule against `Section "Install"` colliding with electron-builder's own.
- **`nsis.include` with `custom*` macros, not `nsis.script`.** `script` *replaces* electron-builder's entire installer template — including `installApplicationFiles`, the registry writes, the shortcuts and the uninstaller. Using it is how the standalone-script defect happened. `include` adds our pages and hooks to a template that still does the installing. The offline build needs `INFOPLEX_OFFLINE 1` and `include` takes one file, so `offline-include.nsh` is a two-line wrapper that defines it and includes the real script: one set of pages, two builds, no drift.
- **The silent `/CURRENCY=` check is generated from the currency catalogue, not written by hand.** It was a chain of nine `${If}`s for nine popular currencies while the app knows 54, so `Infoflex Setup.exe /S /CURRENCY=UGX` aborted a legitimate silent install with "not a built-in currency". It is now one generated branch per catalogue entry, pinned by a test that asserts a branch exists for every currency the app knows. An unknown or empty code still **aborts with exit code 2** rather than falling back to the default: a shop silently installed in the wrong money is worse than an install that stops and says why.
- **The secret scan proves itself before it reports.** Writing `release-scan.ts` produced four bugs, each of which made a broken scan look like a clean one: the assembled password had a stray separator (`6433-Handywife-0013346`, which matches nothing), dotfiles were skipped, the text-file extension list excluded `.pem`, and the wrapped-key threshold missed bodies broken at 64 columns. It now plants both a password and a key in a temporary folder and refuses to report unless it finds them, and ten tests pin each leak form it claims to detect and each legitimate base64 it must not flag.
- **The scan searches encoded forms, because a leak that `grep` misses is the leak that ships.** Plain text, base64, hex, and the punctuation-stripped string, plus private keys with and without their PEM header. The punctuation-stripped form is reported only when it appears as a whole quoted value — otherwise the fragments used to assemble the real password elsewhere in the tree trip it.
- **Nothing in the repository may contain the password as a literal, including the scanner and its test.** Each assembles it from fragments and checks the result's length and hyphen count, because a mistaken assembly is indistinguishable from a clean scan.
- **The release folder reports what it could not build instead of quietly omitting it.** `assemble-release.ts` collects every deliverable, hashes what exists, and writes the reason for each absence into `release/MANIFEST.json`, a build artefact rather than a committed file. On a Linux build agent the three `.exe` files cannot be produced, because electron-builder downloads the Electron runtime from `objects.githubusercontent.com`, which this environment cannot reach — and a release folder that silently lacked two installers would be far worse than one that names them. (The manifest once also blamed `makensis`, which was true then and is not now; it is built from source here and the stubs are cross-compiled, so the stated reason was narrowed to the one that still holds. A reason that has quietly stopped being true is worse than no reason.)
- **Build Studio's compiled bundle and the installer's NSIS sources ship inside the release folders.** If the `.exe` cannot be produced here, the next best thing is everything needed to produce it elsewhere: the bundle runs under Node without packaging, and six files in `release/installer-sources/` are enough to rebuild both installers without the rest of the repository.
- **The documentation states the licence system's real limit rather than implying it has none.** An on-site licence is verified on the customer's own machine, so the master password is known to whoever issues those licences, and the build profile's maximum on-site period is the actual control on what a leaked password is worth. `VENDOR_GUIDE.md` says this plainly and recommends the lowest cap the customers will tolerate, because that number is the difference between a leak costing a year or costing ten.
- **The receipt's ISO-code fallback is documented as the answer to a missing glyph, not as a workaround.** Thermal printers commonly lack ₦, GH₵, KSh and the CFA franc, and Settings already allows the code to be shown instead of the symbol. It is a display preference that stays editable after the currency locks, because it changes how amounts are *written*, not what they *are*.
- **Documentation claims were checked against the code, and three were wrong.** The vendor guide initially said an unknown `/CURRENCY` falls back to the default (it aborts); the customer guide's backup retention of thirty was verified at `backup-service.ts`; the licence grace period of up to thirty days was verified in `license-manager.ts`. Where a claim could not be checked here it is marked as depending on configuration rather than stated flatly.

## Phase 15 (continued) — the installer finally compiled, and it did not

`installer.nsi` had never been through `makensis`. Every previous phase said so and moved on, because the sandbox has
no `makensis` and no root to install one. That was true when it was written and it is no longer true: NSIS can be
built from source with the gcc that was here all along, and `scripts/compile-check-installer.ts` now does exactly
that — zlib from source, SCons from PyPI, `scons SKIPSTUBS=all` for the compiler alone, then both builds compiled.

**Six defects came out of the first successful compile, and every one of them was a hard failure.** The installer
could not have been built at all had anyone run the build:

1. `${NSD_LB_SetCurSel}` — not an nsDialogs macro. The real one is `NSD_LB_SetSelectionIndex`.
2. `${NSD_LB_GetCurSel}` — likewise; `NSD_LB_GetSelectionIndex`.
3. `${NSD_DisableWindow}` — exists nowhere. It is now the `WM_ENABLE` message that such a macro would have sent.
4. `${ElseIfNot} ${RunningX64}` — `RunningX64` comes from `x64.nsh`, which was never included.
5. `${AtLeastWin10}` — `WinVer.nsh` defines `AtLeastWin8` and `AtLeastWin11` and never `AtLeastWin10`, because
   Windows 10 and 11 both report major version 10. It is now defined in the installer against build 10240.
6. `${GetFileSize}` — not a FileFunc macro; the real one is `GetSize`, with a different signature.

- **The static checker was the reason none of this was caught, and the cause was its own allowlist.** `installer:check`
  carries a list of macro names it accepts without a definition. That list had been written from memory and contained
  `NSD_LB_GetCurSel`, `NSD_LB_SetCurSel`, `NSD_DisableWindow` and `GetFileSize` — the exact four names that do not
  exist. It therefore blessed the precise calls that would fail, and a checker that agrees with a mistake is worse than
  no checker, because it is evidence. The list now holds names verified against the headers, and a test asserts that
  every macro the installer uses is in it, that the four invented names are gone from both, and that `x64.nsh` is
  included and `AtLeastWin10` defined.
- **A comment ending in a backslash silently deleted the next line.** `json-escaping.nsh` had `; \ becomes \\` above
  `StrCmp $1 '\'`, and a trailing backslash escapes the newline in NSIS — so the entire backslash-doubling branch was
  discarded (warning 6050). Any Windows path written into `install-config.json` would have produced invalid JSON. The
  comment is reworded, and a test now fails on any comment line ending in a backslash.
- **A check that cannot fail is not a check, and this script was one three times before it worked.** It first reported
  success while `makensis` was failing at start-up, because (a) the error went to stderr and only stdout was read,
  (b) `makensis` exits 0 on script errors unless `-V2` is passed, so the throw never happened, and (c) the regex that
  patched MUI's `ChangeUI` lines lacked the `m` flag, so it silently matched nothing and the build failed on a MUI
  error instead. Each of those made a broken run look clean. The script now requires a produced file and reads its
  header — see the next entry — rather than inferring success from output text.
- **The harness inserts the page hooks, because without them four functions are never compiled.** `customPageAfterChangeDir`
  registers the four custom `Page` commands; a harness that omits it leaves those functions unreferenced, NSIS emits
  "warning 6010 ... zeroing code", and their bodies — the currency page's entire read-back logic — are thrown away
  unexamined. A planted `${NSD_LB_BogusMacro}` on the currency page went undetected until the hooks were inserted at
  the same points electron-builder uses (assistedInstaller.nsh lines 9, 43, 48).
- **The stubs are real, so the check produces an actual installer instead of stopping short of one.** NSIS does not
  ship Windows stubs for POSIX and its own build treats them as a Windows-only artefact, which is why the previous
  phase could only get as far as "every macro resolved, then the final byte-write failed on the placeholder". They are
  now cross-compiled from NSIS's own `Source/exehead` by `scripts/nsis-stub-builder.ts`, using Zig — which is on PyPI
  as a plain wheel and is a complete clang+lld cross-compiler — driven through `i686-w64-mingw32-*` shims so NSIS's
  SConstruct builds unmodified. `npm run installer:compile` now writes a ~111 KB i386 PE for each build.
- **The produced file is inspected, not assumed.** `installer/src/pe-artifact.ts` reads the DOS magic, the PE
  signature at `e_lfanew`, the machine, the optional-header size, the section count and the subsystem, and the build
  fails if any of them is wrong. This has already earned its keep: dropping `-Wl,--subsystem,windows` from the stub
  link produced a *console* binary — a valid-looking PE that would flash a terminal window at the vendor — and the
  subsystem check is what caught it. NSIS was perfectly happy with that build.
- **Warning 6010 is treated as a failure unless the omission is expected.** "Zeroing code" means NSIS threw a function
  body away unexamined. That is legitimate for the download page in the offline build, and it is exactly how four
  custom pages were silently lost before the harness inserted the right hook. `EXPECTED_UNREFERENCED` names the
  functions each build may drop; anything else, and any listed omission that no longer happens, fails the build.
  Removing `customPageAfterChangeDir` now reports eight discarded page functions by name.
- **Two things are stubbed, and only two.** MUI2's `ChangeUI` and `InstProgressFlags` open the installer's own UI
  `.exe` and rewrite its dialog resources, which needs a Windows resource compiler — a real limitation, not a
  placeholder. They are commented out in a private copy of the NSIS tree with a marker at each site; nothing in the
  repository is touched. Re-tested with the real stubs: restoring `ChangeUI` still fails with
  `Can't find IDD_LICENSE (102) in the custom UI`, so the patch is not a stand-in for a missing stub.
- **The build was missing electron-builder's `-WX`, so the check was easier than the real thing.** electron-builder runs
  makensis with "warnings as errors" unless the config says otherwise, and this project does not say otherwise. The
  compile check did not pass `-WX`, so both builds passed here while `npm run build` would have stopped on the first
  warning. That is the worst shape of a check: it agrees with the harness and not with the build it stands in for. The
  check now passes `-WX`, and `installer.nsi` disables the three codes it provokes on purpose — 6020 (this file is an
  `include`; the template calls `WriteUninstaller`), 6010 (documented per-build omissions) and 6001 (variables the
  template owns) — **by number, never `disable all`**, so any other warning is still fatal. The harness then re-enables
  6010, because that warning is the only signal NSIS gives that it discarded a function body, and silence there is how
  four custom pages went missing once already. A test pins all four of those facts.
- **The hooks now match electron-builder's real template, read from `node_modules`.** Every hook is inserted behind
  `!ifmacrodef`, so a misspelled macro name is not an error — the hook is skipped, the installer builds, and the
  password page or the currency write simply never happens, with nothing in any log to say so. The harness cannot catch
  that by construction: it defines the same macros, so if both are wrong both agree.
  `installer/src/electron-builder-template.test.ts` therefore checks against the shipped template itself: every macro we define is one the template calls (catching a
  typo on our side), every hook we rely on still exists, the four page hooks keep their page order, `customInstall` still
  runs after the payload and shortcuts, and `customUnInstall` still runs before the files are deleted. Renaming
  `customInstall` to `customInstal` now fails two tests by name.
- **`oneClick` is now pinned, because one boolean deletes the password gate.** electron-builder picks between two page
  templates: `assistedInstaller.nsh` when `oneClick` is false, `oneClick.nsh` when it is true. Only the first calls
  `customWelcomePage`, `customPageAfterChangeDir` or `customFinishPage` — `oneClick.nsh` is eighteen lines and calls none
  of them. Setting `oneClick: true` therefore removes the vendor password gate and the Region and Currency page from the
  installer, and the build still succeeds with no warning anywhere: the hooks are defined, they are simply never
  inserted. Nothing in the compile check would have noticed either, because the harness inserts the hooks itself. A
  test now asserts `oneClick: false` and re-derives from electron-builder's templates why that matters, so if a future
  version teaches `oneClick.nsh` to call the hooks the test says so instead of the requirement silently becoming stale.
- **The offline wrapper is compiled, which it never was.** The shipping offline build does not include `installer.nsi`:
  it includes `offline-include.nsh`, which sets `INFOPLEX_OFFLINE` and includes `installer.nsi`. The compile check had
  been building "the offline build" by passing `-DINFOPLEX_OFFLINE=1` directly, so this wrapper was compiled by nothing
  at all. It is now a third build in the check, and a typo in its `!include` fails the run. Making it compile also
  needed two honest fixes rather than test scaffolding: the wrapper's `!define` is now guarded, because NSIS treats a
  redefinition as a hard error, and the harness no longer pre-defines `INFOPLEX_OFFLINE` — `installer.nsi` already
  defaults it, so the value now always comes from the file under test rather than from a harness that agreed with
  itself. The wrapper's output is byte-identical to the offline build's, which is the point of it.
- **The prerequisite was executed without being verified, and the safety measure guarded the wrong path.** The online
  download page checks the redistributable's SHA-256 and publisher, and "Browse for the file myself" checks the digest
  too. `InstallPrerequisites` — the function that actually runs the file — checked nothing and called `ExecWait` on it.
  Because the shipped digest is all zeros until a release pins it, the verified paths *refused every download* while
  the unverified path was the one that still ran the binary. A guard on everything except the dangerous step is worse
  than no guard, because it reads as diligence. The execution path now compares `${VCREDIST_SHA256}` with the same
  bundled helper before `ExecWait`, deletes a mismatch, says so, and continues the install without that component rather
  than running it. Six tests hold every `ExecWait` in the script to having a digest check earlier in its own function.
- **The offline build could not compile, and the harness was why nobody knew.** `installer.nsi`'s offline branch does
  `File ... "${PREREQUISITE_VCREDIST}"`, and nothing in the real build defined `PREREQUISITE_VCREDIST` — only the
  harness did, with a path to a placeholder. So `npm run installer:offline` would have stopped at
  `File: "${PREREQUISITE_VCREDIST}" -> no files found` on line 786, while the compile check built happily. This is the
  same shape as the `-WX` gap: the harness supplying a value the build lacked made the harness agree with itself. The
  command is now `!ifdef`-guarded, so a build without the file still produces an installer; the harness no longer
  defines the variable at all; and a test pins the harness's list of defines so it cannot quietly grow a new
  substitute for a value the real build is missing. The release checklist now says plainly that the checklist item is
  to **supply** that file, not merely to pin its checksum.
- **Every shortcut was built from a guessed executable name.** `CreateShortCut`, the finish page's "Run now" box and the
  autostart registry value all pointed at `"${PRODUCT_NAME}.exe"`. electron-builder writes the executable as
  `"${PRODUCT_FILENAME}.exe"`, and those two differ whenever the product name contains a character Windows forbids in a
  file name: `productName: "Infoflex:Pharmart"` yields `InfoflexPharmart.exe`. The installer would then report success
  while creating a finish-page Run target and an autostart entry that both pointed at nothing. It is correct today only
  because the product name happens to have no such character, which is exactly the sort of assumption that survives
  until somebody renames the product. Both surviving sites now use electron-builder's own `APP_EXECUTABLE_FILENAME`, with
  a `!ifndef` fallback for a standalone compile; verified by compiling the fallback in both configurations and reading
  back `InfoflexPharmart.exe` and `Infoflex.exe`. Tests forbid rebuilding an executable path from `${PRODUCT_NAME}`.
- **Fixing that made two shortcuts correct when they should not have existed.** The two `CreateShortCut` calls were
  writing `"$SMPROGRAMS\${PRODUCT_NAME}.lnk"` and `"$DESKTOP\${PRODUCT_NAME}.lnk"` from inside `customInstall`. But
  electron-builder's install section creates both shortcuts *before* it inserts `customInstall`, at
  `"$SMPROGRAMS\${SHORTCUT_NAME}.lnk"` and `"$DESKTOP\${SHORTCUT_NAME}.lnk"` — and `SHORTCUT_NAME` defaults to the
  sanitised product name, which is the same `"Infoflex"`. So the two pairs were the same two files. electron-builder
  stamps each with `WinShell::SetLnkAUMI` right after creating it; `CreateShortCut` replaces a `.lnk` wholesale, so our
  call wrote an identical shortcut minus the AppUserModelID that Windows grouping, the taskbar jump list and pinning
  depend on. It was also inconsistent in a way that hid the cause: `customInstall` only runs on a fresh install, so a
  *repair* kept electron-builder's correct link and only a fresh install lost it. Both calls are gone — the file has one
  owner — and a test forbids `CreateShortCut` returning to this script.
- **The static checker called a correct `!ifdef`/`!else` pair a redefinition.** Its duplicate-`!define` rule compared
  every definition in the file without noticing that only one arm of a conditional is ever compiled, so the guarded
  fallback this phase added was reported as an error. The rule now tracks the branch path — every enclosing conditional
  and which side of its `!else` — so two defines conflict only when they could actually be compiled together. Three
  tests hold both directions: different values in the two arms are allowed, and two different values in the *same* arm
  are still an error. The dangerous fix here would have been to delete the guard from the script to satisfy the
  checker; narrowing the rule is what keeps the guard.
- **What this still does not prove, and the docs say so.** It produces a real `.exe`, and it still does not prove
  electron-builder's template agrees with us — page order, where `customInstall` runs, whether the payload lands in the
  right place. It does not prove anything runs correctly on Windows: the file has never been executed, because there
  is no Windows and no Wine here. The real `npm run build` still cannot run here — electron-builder downloads its own
  NSIS distribution from GitHub at build time, and the plugin DLLs it needs do not exist in this sandbox — so the
  hook contract is checked by reading its template rather than by running it. `installer:check` no longer
  claims that compiling "needs Windows or Wine", because that stopped being true.

## The uninstaller, which had never been compiled

Phase 15 closed with the installer compiling in three shapes and nothing ever compiling the *uninstaller*. That gap was
not cosmetic. `electron-builder` builds the installer twice: the second makensis run defines `BUILD_UNINSTALLER`, and
only that pass includes `uninstaller.nsh` — the file that owns `!insertmacro customUnInstall` and the uninstaller's own
`Function un.onInit`. Every harness shape was an installer pass, so the uninstaller was, in the only sense that matters
here, unbuilt. Compiling it took one afternoon and found three defects, two of which would have shipped.

**1. The uninstaller could not build at all.** This script defined `Function un.onInit`. So does electron-builder's
`uninstaller.nsh`, and — this is the part that makes it fatal rather than merely redundant — this script is layered
into that same compile via `nsis.include`, not substituted for the template. NSIS rejects the second definition outright:

```
Error: Function named "un.onInit" already exists.
```

The installer half of the build was unaffected, which is exactly why nobody had seen it. The supported hook is
`customUnInit`, which the template inserts *inside* its own `un.onInit`. That placement is not incidental: it is what
runs after `initMultiUser`, and `initMultiUser` is what gives the hook the right shell variable context (defect 2). A
working `un.onInit` of our own would have had to reimplement that setup, and would have silently skipped the UAC
outer/inner-instance handling that `initMultiUser` performs for the per-machine case.

**2. "Remove my data" deleted the wrong folder and said otherwise.** The hook that honours the keep-data question ran
`RMDir /r "$APPDATA\Infoflex"`. This installer is `perMachine: true`, and `initMultiUser` →
`setInstallModePerAllUsers` → `SetShellVarContext all` runs before it, so `$APPDATA` at that moment is
`C:\ProgramData` — not the user's roaming AppData, and `$LOCALAPPDATA` is `C:\ProgramData` too. The two deletions pointed
at folders that have never held the database. A customer who answered "remove everything" would have kept the database,
the licence and the paired phones, been told it was all gone, and — worse — a subsequent reinstall would have adopted the
old data as though it were new. The fix switches to `SetShellVarContext current` around the deletions. electron-builder's
own delete-app-data code does the same thing for the same reason (`uninstaller.nsh`), which is the strongest available
evidence that the reasoning is right.

**3. `install-config.json` survived every uninstall.** The installer writes it into `%ProgramData%\Infoflex\` so the
setup screen can arrive with the shop's currency preselected. Nothing removed it. It is not the shop's data — every
fresh install rewrites it, and once the program is gone nothing reads it — so the correct answer is to delete it
unconditionally rather than tie it to the keep-data answer.

**Why the missing compile pass is the real finding.** Each of the three defects is individually small. What made them
survive is that a whole build step had no coverage, and the three shapes of the harness looked like thorough coverage of
the installer. A harness that compiles the thing you ship, and never compiles the second thing you ship, reports success
about half the artefact. The fourth build shape (`uninstaller-pass`) exists to close that, and it reproduces the
template's own `un.onInit` precisely so that defect 1 is a build failure rather than an assertion — confirmed by
mutation: restoring `Function un.onInit` makes `npm run installer:compile` fail with electron-builder's real error
message.

**What this still does not prove.** The new build compiles our hooks in the layering electron-builder uses; it does not
execute the uninstaller, because there is no Windows and no Wine here. It does not prove the firewall rule is actually
removed on a real machine, that `netsh` succeeds, that the registry value is the one the app set, or that
`SetShellVarContext current` resolves to the right user when the uninstaller is launched by an administrator whose
account differs from the one that ran the app. Those remain release-time checks, and they are listed as such in
`docs/RELEASE-CHECKLIST.md` — described as **compiled and inspected**, never as **run**.

## Silence is a mode, not an absent window

The uninstaller work above left the keep-my-data question sitting in `customUnInit`. That hook also runs during every
**upgrade**: electron-builder executes the previous version's uninstaller before installing the new one, with
`ExecWait '"$uninstallerFileNameTemp" /S /KEEP_APP_DATA $0'` where `$0` carries `--updated` — silently, from inside the
new installer, with no window of its own. Asking the question there was wrong five ways, and only the first is obvious.

**A `MessageBox` is not suppressed by silent mode unless it says so.** NSIS's runtime decides (`Source/exehead/util.c`):

```
if (g_exec_flags.silent && type >> 21)
  return type >> 21;
// no silent or no default, just show
```

`type >> 21` is the `/SD <button>` value, set at compile time from bit 21 of the command's flags. With no `/SD`, the
shift yields 0, the condition fails, and the box is shown **even in a fully silent run**. Thirteen `MessageBox` commands
in this script had no `/SD` — including the two `.onInit` validation errors, the VC++ digest-mismatch warning, the
install-failed notice, and the "too many password attempts" message. Under `/S` each of those would have appeared and
waited for a click that nobody was there to make: an unattended deployment, a support script or an upgrade would hang.
Every one now names its default, and the choice of default is the safe answer rather than the dismissable one.

**The upgrade question could have destroyed the shop's database.** Answering "No" to the prompt deletes the database,
the licence and the paired phones. During an upgrade that prompt appeared *before* the new installer had done anything,
and its answer silently overrode what the caller had already decided: `--updated` means keep the data, and
`--delete-app-data` is the only documented way to ask for the opposite. Two mechanisms were live and disagreeing about
the same folder, and the one the customer saw was the one that could lose their data. `customUnInit` now reads
`--updated` first and returns before prompting or deleting.

**Why the order of those two things matters more than either.** The check has to precede the prompt, because a check
after a blocking dialog cannot prevent it. The test that pins this compares string offsets (`--updated` must appear
before `MessageBox`, with a `Return` between them), and a mutation that moves the check below the prompt fails it — a
mutation that merely deleted the check would have passed a weaker test.

**Pinning it.** The `/SD` rule went into the static checker rather than only into a test, because it is a property of a
single line, which is what a checker is for. Running it against the real script found the thirteen; running it against
a script with one `/SD` removed fails `installer:check` on its own, without any test runner involved. The trade-off is
stated in the rule: it cannot tell whether a given box is reachable in silent mode, so it is unconditional. A
conditional rule would need control-flow modelling the checker does not have, and the safe answer is the same for every
box anyway.

**Not proven.** Whether these dialogs appear, and in what order, is a runtime property. Nothing here executed an
installer or an uninstaller — there is still no Windows and no Wine — so the claim is that every `MessageBox` now
carries a silent default in the compiled script, verified by reading NSIS's own runtime logic and by compiling. The
upgrade sequence itself is read from `installUtil.nsh`, not observed.

## The tests kept reading their own commentary

Three separate times this phase, a test failed on a *comment* rather than on code. The pattern is worth naming because
each instance was caught by a mutation rather than by the suite going red on its own:

1. `blockOf` in `uninstaller-contract.test.ts` matched `SetShellVarContext current` inside the explanatory comment above
   the line it was supposed to find. Deleting the actual instruction passed the test.
2. The `/SD` rule counted the phrase "MessageBox ... `/SD`" in a comment as a compliant command.
3. `prerequisite-verification.test.ts` scanned the raw script for `ExecWait`, and a comment quoting electron-builder's
   `ExecWait '"$uninstallerFileNameTemp" /S /KEEP_APP_DATA $0'` was reported as an unverified launch in a function that
   has nothing to do with it.

The cause is the same each time: the assertion was written against source text, and prose in a source file is still
source text. The fix is mechanical — strip comment lines before scanning, in every helper that reads the script — and it
is now done in all three. The generalisation is the part worth keeping: **a test over a file's text must decide whether
it is testing the text or the program**, and if the latter, comments have to go before the match. Case 3 is the most
instructive, because the file was *right* and the comment was *new*: that test had been passing for two commits and only
broke when a new comment explained something the test was already checking. A suite whose correctness depends on nobody
writing prose is not a suite.

Two things that did not come out of this, and are recorded so they are not claimed as wins: no test caught these on its
own, and the docs-accuracy failure alongside them was real — `installUtil.nsh` was named in prose as a file, and that
suite requires each such name to exist or to be listed with a reason. It was listed.
