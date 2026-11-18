# Infoflex Pharm & Infoflex Mart

A phased Electron + React + TypeScript desktop application for the Infoflex pharmacy and supermarket editions.

## Current phase: the Admin's phone as a secure host

The Electron main process owns license/session/role authorization and local SQLite writes. The completed foundation includes licensing, product/inventory and purchase workflows, retail/wholesale POS, returns, and host-owned accounting/reporting. Phase 7 adds an explicitly enabled Admin mobile PWA served from the desktop over HTTPS on a private LAN, one-time phone pairing, short-lived access credentials with rotating refresh sessions, device revocation, read-only sales summaries/PDFs, and pending-return approvals. Phase 8 adds Admin settings (store profile and logo, live receipt preview, receipt layout, optional VAT, discount ceiling, printer, accepted payment methods, edition options, a searchable currency list with the two lock explanations, a read-only licence panel, and a link to Mobile Access), local daily/manual backups with a verified restore that preserves licence state and paired devices, and a machine-checked security review of every IPC channel and API endpoint. Phase 9 makes the listener a genuinely Admin-only host: pairing creates a **pending** device that reaches nothing until the Admin approves it on the PC, the phone then signs in with the Admin username, password and device token, an authenticator code is required for any off-LAN sign-in, every request re-checks that the token's user is still an active Admin, and demoting or deactivating an Admin revokes the phone instantly. It also adds the full Mobile Access screen (addresses, friendly name, a QR code the phone camera can open, a QR code for authenticator set-up, paired list with rename/revoke/revoke-all, live connected count, master kill switch, licence phone limit, connection test, firewall repair, keep-running from the tray), one approvals queue for discounts, credit, returns and voids with live updates to the cashier and the phone, and idempotency keys on stock changes. The browser preview is memory-only and is not authoritative.

License activation is checked before first-run setup, sign-in, and protected host operations. The desktop supports online vendor-key activation, vendor-signed Ed25519 `.lic` import, and offline on-site activation using a Build Studio policy. Licenses are machine-bound; dates, signature/HMAC, policy integrity, expiry, suspension, and clock rollback are checked by the host. License loss or expiry locks access without altering shop data.

The customer/vendor UI for policy creation is the standalone [Build Studio policy page](buildstudio/index.html). It derives a salted PBKDF2-SHA256 hash in-browser and exports a local `.iflpolicy`; it does not store the entered password or make network requests. The main desktop contains online, file-import, and on-site activation screens. A local license mock is available through `npm run cloud:mock` for development only; its Ed25519 key is ephemeral and is not a production signing service.

**Important boundaries:** mobile access is for the Admin only — Cashier and Supervisor accounts are refused at login and on every mobile route, by design and not by a setting. The LAN listener is the supported path; the Internet option depends on a licence that includes it. Do not port-forward the mobile listener on a licence that does not include Internet access. Every phone must install and trust the host’s exported root certificate and verify its SHA-256 fingerprint. The root private key is protected with Electron `safeStorage`; if the OS backend is unavailable or insecure, the listener will not start. Phone trust installation, Wi-Fi/firewall behavior, the Windows DPAPI backend, and the packaged Windows installer still need manual real-device/Windows verification before release. The OS-install identifier used for machine binding is not hardware-backed and may be duplicated by some system images. The Build Studio policy file is not digitally signed; protect its distribution. Tax calculation and later store-credit redemption are not implemented. A production license cloud is not included. See [mobile/README.md](mobile/README.md), [docs/DECISIONS.md](docs/DECISIONS.md), and [docs/LICENSE-MANUAL-CHECKLIST.md](docs/LICENSE-MANUAL-CHECKLIST.md) for setup, limits, and release verification.

The browser preview is not an authorization boundary and uses transient in-memory data only. The actual desktop app persists shop settings and license state in the shop PC's local SQLite database.

## Maintainer commands

These are source-repository commands for contributors, not customer or vendor activation/install steps:

- `npm run dev:web` — start the browser UI preview (binds to `0.0.0.0`).
- `npm run dev` — start the Electron desktop development app.
- `npm test` — run automated tests.
- `npm run typecheck` — check TypeScript.
- `npm run check:license` — run typecheck, tests, web build, and Electron bundle build for the license phase.
- `npm run check:phase5` — run the verification suite for the POS phase.
- `npm run check:phase6` — run the retained verification suite for Returns/reporting and their integrations.
- `npm run check:phase9` — run typecheck, full tests, desktop web build, PWA build, and Electron bundle build (current phase).
- `npm run check:phase8` — the same sequence for the settings/backup phase.
- `npm run check:phase7` — the same sequence for the mobile-access phase.
- `npm run cloud:mock` — start the local mock license service for development.
- `npm run dist:win` — Windows NSIS packaging entry point. Native modules use ABI-stable N-API prebuilds, so no Electron rebuild is needed; run it on Windows and complete `docs/LICENSE-MANUAL-CHECKLIST.md` before release.

Phase status is tracked in [docs/PHASES.md](docs/PHASES.md); the hardware checks that a customer release still requires are in [docs/RELEASE-CHECKLIST.md](docs/RELEASE-CHECKLIST.md).

A Windows release must ultimately be prepared through the planned graphical Build Studio workflow; customers must never be asked to run terminal commands.
