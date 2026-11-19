# Host-enforced license system

`LicenseManager` in Electron main is the source of truth for activation and authorization. It verifies signed Ed25519 online/file tokens, local HMAC on-site tokens, machine binding, dates, status, policy/license integrity, and clock rollback. Setup and login remain gated until the host returns a usable verified entitlement; renderer routing is not trusted for authorization.

## Vendor and customer workflows

- `buildstudio/policy.html` is a standalone graphical Build Studio policy exporter. It uses Web Crypto to derive a salted PBKDF2-SHA256 hash (310,000 iterations), writes an `.iflpolicy` file containing only that hash, an optional maximum on-site term, a service URL, and public Ed25519 keys, and clears the password inputs after export. The page makes no network calls and uses no browser storage.
- The Electron license screen imports that policy, activates with an online vendor key, imports a signed Ed25519 `.lic` file, or issues/renews an offline on-site HMAC license after verifying the vendor master password. Date pickers, 1/2/3/5-year shortcuts, optional default currency/lock, mobile features, Admin-phone limit, and custom end date are available in the on-site flow.
- An optional Build Studio term cap is enforced by the host. Blank means no configured cap; 50 years is the documented implementation sanity limit. End dates are exclusive midnight UTC.
- If the imported policy pins a license-service URL, the host blocks online activation against any other endpoint before sending the activation key. Redirects are rejected. If the policy leaves the URL blank, the first successful endpoint is saved for check-ins; secure endpoint migration is future work.
- The master password itself is never stored or logged. Local on-site HMAC material and policy/license integrity tags use an installation secret protected by Electron `safeStorage`; SQLite stores the hash, tokens, claims, and event history.
- If the local authenticator is missing or unavailable (for example, only the SQLite database was moved to another Windows installation or OS account), reimport the exact same Build Studio policy. Its master-password hash must match before the current license-authentication state is reset; then issue a new on-site license for the new machine. If the authenticator and policy are intact but the license reports `machine_mismatch`, do not reimport the policy: that import is intentionally refused. Use on-site / offline with the vendor master password to issue a machine-bound replacement, or import a signed license file issued for that machine. Both recovery paths preserve license history and shop data.

## Check-in and development mock

The host checks in at startup, daily when active, at a shorter interval while expired/suspended, and on request from the UI. Only license/device/version/online metadata and required on-site reporting details are sent; no shop business data is included. Before its first report, an offline-only on-site license has no cloud-side mock record to suspend.

`cloud/mock/server.ts` is a local test harness. It creates a process-memory Ed25519 keypair and random key ID on each start, stores test license metadata in memory, and offers a graphical console for activation, extension, and status changes. The unpackaged development app trusts a loopback mock key only; this is not production key trust or a production license service.

## Security limits and deferred work

The machine ID is derived from the OS installation identifier and is not hardware-backed; cloned images may duplicate it. Local integrity checks are not a defense against a privileged user who can patch the executable or control OS state. The `.iflpolicy` file is validated but not digitally signed and must be distributed securely. Production cloud persistence/authentication and vendor signing-key operations, hardware attestation, signed policy files, mobile pairing/device registration, and real Windows DPAPI/installer verification remain future/manual scope. See [`docs/DECISIONS.md`](../../docs/DECISIONS.md).
