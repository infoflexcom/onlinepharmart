# License phase manual verification checklist

> Phase closure status and the outstanding hardware gates live in [PHASES.md](PHASES.md) and
> [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md). This document remains the wider licensing/manual
> verification list for the license phase; the three Phase 7 hardware gates are tracked in the release checklist.

**Environment:** a clean, supported Windows machine with the actual packaged Electron runtime and graphical NSIS installer. These are release-verification steps for a maintainer; customers and vendors must not be asked to use a terminal. Do not use real shop data or production signing keys in the mock tests.

## Clean install and first-launch gate

- [ ] Install through the graphical Windows installer and launch Infoflex. A fresh install opens the license screen before first-run setup or login.
- [ ] Confirm setup/login cannot be reached by navigation, a remembered session, or direct renderer/IPC invocation until the host has a usable license.
- [ ] Close and relaunch the app; the gate remains in force until valid activation. After activation, verify the app resumes setup/login without resetting the local database.
- [ ] Confirm the screen explains expiry recovery and that license locks do not change or delete shop data.

## Build Studio policy and on-site activation

- [ ] Open `buildstudio/policy.html` in a current browser. Generate a policy with a random vendor master password and a three-year cap. Confirm the downloaded `.iflpolicy` contains a salted PBKDF2 hash, not the password.
- [ ] Generate a no-cap policy and confirm the blank cap remains `null`. Confirm the UI documents the 50-year sanity limit.
- [ ] Confirm the page makes no network requests or browser-storage writes. Do not use a production master password during this check.
- [ ] Import the policy through the desktop GUI. Enter a wrong master password and confirm activation is rejected with increasing delays; check local audit/history for the attempt and confirm neither password value appears.
- [ ] With the valid password, issue offline licenses for 1, 3, and 5 years; test 2 years and a custom end date. With the three-year policy, attempt a term longer than three years and confirm the host rejects it even if the UI is bypassed.
- [ ] Verify edition selection, mobile LAN/Internet flags, Admin-phone limit, optional default currency, and currency lock are reflected in the host-verified license summary.
- [ ] Complete setup with a locked default currency. Confirm the setup selector preselects that currency and is read-only. After recording a transaction, attempt an on-site renewal/rebind with a different currency; confirm rejection or preservation of the existing transaction currency.

## Signed file, online activation, expiry, and reporting

- [ ] Import a valid vendor-signed Ed25519 `.lic`. Confirm invalid signatures, untrusted key IDs, expired/not-yet-valid dates, and a token bound to another machine are rejected or remain locked with a clear recovery state.
- [ ] With a vendor-pinned service URL, confirm the online activation endpoint is read-only in the UI and the host rejects a different URL before sending the activation key. Confirm redirects are not followed. If the policy has no URL, confirm the first successful endpoint is saved for check-ins.
- [ ] In a development-only test installation, start the mock service using the maintainer command `npm run cloud:mock`; perform activation and extension through the graphical desktop and mock-console pages. Do not use the mock server for production.
- [ ] Activate the one-day mock plan. Confirm expiry locks desktop/mobile host requests, presents recovery actions, and leaves local shop data intact. Extend it in the mock console and confirm the app unlocks automatically within the configured expired polling interval (default: 60 seconds) without deleting data.
- [ ] Issue an offline on-site license with a reporting URL and verify the first successful check-in reports only license/device/version/online metadata and required on-site entitlement details. Confirm the payload contains no shop name, sales, stock, customers, users, transactions, or currency amounts.
- [ ] Before first report, confirm the mock has no server-side license record to suspend. After the report, suspend and resume through the mock console and verify signed updates lock/unlock the host on check-in.

## Machine binding, clock, safe storage, and installer inspection

- [ ] On Windows, verify the authenticator is protected through Electron `safeStorage`; restart under the same account and confirm the license still verifies.
- [ ] Copy only the database to another machine and confirm the license fails closed. Import the same vendor policy and perform the authorized on-site rebind; confirm license history and shop data remain intact.
- [ ] In a controlled test where the existing authenticator remains available but the machine ID differs, confirm `machine_mismatch` offers an on-site rebind path. Reimporting the already-intact policy must not reset the authenticator; an authorized on-site replacement must bind to the current machine and preserve license history and shop data.
- [ ] Move the system clock backwards by more than the configured tolerance. Confirm `clock_rollback` locks access and that replacement/renewal is refused until the clock is corrected.
- [ ] Inspect the actual installer and installed application contents. Confirm no plaintext vendor master password and no static/private vendor signing key is present. The local mock's process-memory key generation is development-only and must not be packaged as a vendor signing key.
- [ ] Inspect application/audit logs and the check-in network payload for accidental password or business-data disclosure.

## Admin mobile access and physical-device verification

The Windows package can now be assembled without a native rebuild (`better-sqlite3` v13 N-API prebuilds plus `build.npmRebuild: false`), so the installer to inspect is the output of `npm run dist:win` on Windows. The remaining mobile-verification bullet points that need a packaged build and a real phone are below.

Already covered by automated tests in this repository (do not re-verify by hand, but re-run `npm run check:phase7` after changes): root CA/server certificate generation and chain/fingerprint checks with `safeStorage`-encrypted keys, refusal of insecure `basic_text` storage, listener shutdown on address or LAN-entitlement loss, non-private socket denial for API and PWA assets (forwarded headers are not trusted), pairing expiry/single-use/rate limiting, licensed phone capacity, session rotation and refresh-reuse revocation, sign-out and account-invalidation revocation, static PWA headers, static-only service-worker caching with navigation-only offline shell fallback, and an end-to-end HTTPS run that pairs a phone, reads the Admin report, and approves a pending return with the `MOBILE` channel. The steps below cover what only a packaged Windows build and real phones can prove.

- [ ] On a packaged Windows build, enable LAN Mobile Access from the signed-in Admin UI. Confirm it is off by default, reports private IPv4 URLs, and refuses startup when the LAN license feature or secure `safeStorage` backend is unavailable.
- [ ] Export the root certificate, transfer it to a test phone, compare the SHA-256 fingerprint, install/trust it using the phone OS settings, then open the HTTPS PWA and install it from the browser menu. Verify that no certificate warning is bypassed.
- [ ] Pair one Admin phone with a fresh eight-digit code. Confirm the code expires after five minutes, is single-use, and a second use/five invalid attempts is denied. Test licensed device limits 1 and 2, a competing registration, revocation, sign-out, and released capacity.
- [ ] On the phone, verify daily/monthly report totals and PDF share/download, and approve/reject a pending return. Confirm Cashier credentials cannot pair or call Admin routes, all report/API responses are no-store, and service-worker caches contain only static assets (no reports, returns, or credentials).
- [ ] After re-running `npm run build:mobile` with a visible app change, reload the installed PWA and confirm the new build appears (the stamped cache name changes and the old cache is deleted). Confirm the installed app still opens to the pairing/report screen with the desktop host stopped, and that no financial value is shown from cache.
- [ ] Confirm access tokens refresh/rotate, reusing an old refresh credential revokes the phone, password reset/deactivation revokes sessions, and a 90-day expired refresh releases the slot.
- [ ] While the service is running, remove the LAN license entitlement/expire the license, change the host private address, and quit Infoflex. Confirm the listener shuts down and never restarts automatically; confirm a public/forwarded socket address cannot reach the PWA/API even if the license has an Internet entitlement.
- [ ] Repeat on supported iOS and Android versions and real Wi-Fi/firewall configurations. The automated localhost TLS checks do not replace phone trust/PWA validation or Windows DPAPI/installer checks; do not release until these boxes are completed.
