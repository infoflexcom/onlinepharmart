# Infoflex Pharmacy Manager — Final Report

Phase 15 of 15. This report is written to be useful rather than reassuring: it separates what was built and proved
from what was built and never run, and it names the things this project cannot yet do.

Date: 2026-11-17. Branch: `arena/e7ff32b0-onlinepharmart`.

---

## 1. The headline

The product is complete as source: 90 test files, 1,119 automated tests, a clean typecheck, and a full build. The
installer sources are consistent and pass their own checks. The cloud package builds. The Build Studio tool builds.
Both secret scans come back clean with a scan that proves itself first.

**No `.exe` was produced.** Not because of the code — because this build environment cannot reach the host that serves
the Windows Electron runtime, has no `makensis`, and has no Wine. Details in §5. This is the single most important
thing in this report, and it is why several items below are marked "could not test" rather than "passed".

**Nothing has run on Windows. Nothing has run on a real phone. No receipt has been printed by a real thermal
printer.** Wherever this report says a feature "works", it means the logic is covered by automated tests that run on
Linux, not that a pharmacist has used it.

---

## 2. What works, and how it is known to work

| Area | State | Evidence |
| --- | --- | --- |
| Sales, returns, stock, purchasing, pricing | Built | 1,119 tests including POS checkout, FEFO batch allocation, returns and restock |
| Money handling | Built | Integer minor units throughout; no floating-point money anywhere; half-up rounding tested for discounts, VAT, promotions, loyalty |
| Currencies | Built | 54 currencies in full detail (0, 2 or 3 decimals); a Custom option; formatting proved for all 54 two independent ways |
| Currency locking | Built | Cannot be moved through desktop IPC, the host controller, or any phone route; display options stay editable |
| Licences | Built | Ed25519 signing, online and on-site routes, grace period 0–30 days, expiry blocks changes not reading, renew/reactivate/suspend/rebind |
| Vendor Cloud | Built | Portal, relay, licence issuer; Node and PHP variants; refuses to start without any of its four secrets |
| Admin mobile PWA | Built | Pairing, TLS with its own CA, refresh/revocation, Admin-only rule enforced at route and host |
| Installer sources | Built and checked | Static checker plus a new config test; see §3 |
| Build Studio | Built | The tool and its bundle; packaged `.exe` needs Windows |
| Backups | Built | Automatic daily with 30-file retention; manual export; restore path tested |
| Secret hygiene | **Verified here** | `npm run release:scan`, self-testing, clean on 736 files |
| Documentation | Written | Customer guide, vendor guide, troubleshooting, updated schema and decisions |

---

## 3. What was found and fixed in this phase

Three defects in the installer would each, on their own, have shipped a broken product. **None of them was caught by
any test in the suite**, and `npm run installer:check` passed both before and after all three fixes.

1. **`"//"` keys in all three electron-builder configs.** electron-builder rejects unknown properties, so every build
   failed schema validation immediately. Removed; explanatory comments belong in a companion document.

2. **`"defines": { "INFOPLEX_OFFLINE": "0" }` in `nsis`.** Not a valid electron-builder option — and it fails with a
   misleading message (`configuration.nsis should be one of these: null`) that names neither `defines` nor the real
   problem. **Neither installer config could ever have been built.** Removed, and the offline flag now travels through
   a two-line include wrapper instead.

3. **`installer.nsi` was never wired into the build.** electron-builder would have compiled its own stock wizard, so
   the password gate, the Region and Currency page and the install-config write would not have existed in the shipped
   `.exe` at all. Worse, the script was written as a *standalone* installer: it created desktop and Start Menu
   shortcuts and added a firewall rule, but never copied the application. Had it been wired in as `script`, those
   shortcuts would have pointed at an app that was never installed. It is now an `include` exposing `customInstall`
   and `customUnInstall` to a template that still does the installing.

Two further defects found while writing the tooling for this phase:

4. **The silent `/CURRENCY=` check accepted only 9 of the app's 54 currencies.** `Infoflex Setup.exe /S
   /CURRENCY=UGX` aborted with "not a built-in currency" for a currency the app supports in full. The check is now
   generated one-branch-per-currency from the same catalogue the wizard's dropdown uses, with a test asserting a branch
   exists for every currency.

5. **The secret scanner was broken four different ways, and every break looked like a clean result.** A stray separator
   in the assembled password (searching for a string that does not exist), dotfiles skipped, `.pem` excluded as
   non-text, and a threshold that missed key bodies wrapped at 64 columns. It now plants both secrets and refuses to
   report unless it finds them; ten tests pin each leak form and each legitimate base64 it must not flag.

Each of these is now covered by a test that fails if the defect returns.

---

## 4. What was tested, and on what

**Real, on this machine (Linux, Node 22):**
- The full automated suite: **90 files, 1,119 tests, all passing**; `tsc --noEmit` clean.
- The PHP variant's own suite, run as part of the above.
- The doc-accuracy tests, which verify every file path mentioned in the documentation actually exists.
- `npm run release:scan` — with deliberately planted leaks to prove it detects them, then clean on the tree.
- `npm run installer:check` — 19 shipped installer files, static analysis only.
- Build Studio's bundle, the web build, the mobile PWA build, the Electron bundle, the cloud package zip.

**Not tested, and cannot be tested here:**
- **No Windows computer was used.** The installers have never been built, never been run, never been seen. The
  password gate, the currency page, the prerequisite check, the firewall rule, the shortcuts and the uninstaller are
  all unexercised.
- **No real phone.** Pairing, certificate acceptance on iOS and Android, "Add to Home Screen", the hotspot path and
  the relay path have never run on a device. The pairing and TLS logic is covered by tests against a real local HTTPS
  listener, which is not the same thing.
- **No printer.** No receipt has been printed. The thermal-printer glyph problem described in the troubleshooting guide
  is well known in the field, not something observed here.
- **No currencies were used in a real shop.** Formatting for all 54 is proved by test; nothing was proved by a
  pharmacist in Lagos or Accra looking at a screen.
- **No clean-profile end-to-end install.** The Phase 15 brief asks for a full walk-through — build, install, activate,
  pair, sell, expire, reactivate. **It was not performed**, because the first step is impossible in this environment.

The full clean-machine checklist is in `docs/RELEASE-CHECKLIST.md`; it is the script for the person who can run it.

---

## 5. Why no `.exe` exists

Three independent walls, in the order they are hit:

1. **electron-builder must download the Electron runtime.** It fetches the Windows Electron runtime (version 45.3.3, win32-x64) from
   `github.com/electron/electron/releases/download/…`, which redirects to `objects.githubusercontent.com`. That host
   is unreachable from here — a direct request returns nothing. `github.com` itself resolves and returns 200, which is
   what makes this look like a working network. The build fails with
   `⨯ unable to verify the first certificate`, a TLS-interception error raised while following that redirect.
2. **`makensis` is not installed**, and cannot be: `apt-get install nsis` requires root, which this environment does
   not grant. No npm package supplies a working binary — the `makensis` npm module is a wrapper around the same
   missing executable.
3. **No Wine**, so even a Windows compiler could not be run.

The result is recorded in `release/MANIFEST.json`: the release folder contains everything that *could* be produced, a
SHA-256 for each of those files, and for each of the three missing executables a plain statement of why. It also
contains `release/installer-sources/` — the six NSIS files — and `tools/build-studio-bundle/`, so that a Windows
machine can rebuild all three without the rest of the repository.

**To produce them:** on any Windows 10/11 machine with Node 20+, run `npm ci`, then `npm run installer:online`,
`npm run installer:offline`, `npm run dist:studio` and `npm run release:assemble`.

---

## 6. Known limitations

These are properties of the product, not gaps in this phase's work. All are documented where the relevant person will
look.

**Licensing.**
- An on-site licence is verified on the customer's own machine against a salted hash of the master password. Anyone
  who knows that password can mint an on-site licence up to the build's configured maximum period. **The maximum
  on-site period is the real control**, and a long one multiplies the value of a leak. This is stated in the vendor
  guide, in the schema document, and here.
- Rotating the password requires shipping a new build; customers on the old build keep working but on-site activation
  still uses the old password until they update.
- Hardware attestation, so that a licence is bound to a specific machine fingerprint, is not implemented.

**Currency.**
- One currency per installation. No conversion, no exchange rates, no multi-currency tender.
- The database does not record which currency each historical amount was in, so a wrong choice after the first sale
  cannot be repaired in place. The remedy is a reinstall with a fresh database, and old sales do not come across.
- Multi-currency would need a currency column or per-sale rate snapshot on every money-bearing row, and a migration
  that cannot be inferred from existing data. It is a future phase, not a setting.

**Mobile.**
- Admin accounts only. A lost phone can therefore do a great deal of damage if it is unlocked; revoking a device or
  resetting the Admin account cuts every paired phone off at once, which is the mitigation.
- The Internet option routes through the vendor's relay, so traffic leaves the building. The relay keeps no copy, but
  the traffic does pass through a server that is not the customer's. Hotspot mode is the alternative that avoids it.

**Installer.**
- The static checker proves properties *of the file it reads*. It cannot prove the script compiles, and it did not
  catch any of the three defects in §3 — because none of them were properties of that file. The config side now has
  its own test.
- Silent install cannot activate. Activation is one attended step per machine.

**Platform.**
- Windows 10/11 only. No macOS or Linux build exists.
- The mobile app is a PWA, not a native app, so it cannot use the camera for barcode scanning beyond what the browser
  allows, and iOS pushes are limited by Safari.

**Dependencies.**
- `npm audit` reports an advisory for `picomatch <= 4.0.7`, reachable only through build tooling. No patched release
  exists as of this date; the affected packages are dev/build-only and `npm audit --omit=dev` is clean. Do not apply
  the suggested force-downgrade; recheck upstream before the next release build.

---

## 7. Suggested improvements, in the order I would do them

1. **Run the clean-machine checklist on real Windows hardware.** Nothing in this report substitutes for it, and every
   one of the three installer defects found this phase would have been found in the first ten minutes of a real
   install. This is not a documentation task; it is the difference between "built" and "works".
2. **Add a CI job that builds the installers on a Windows runner.** The absence of one is why the defects in §3
   survived to Phase 15. A runner that compiles the `.nsi` and asserts the resulting `.exe` contains the application
   payload would have caught all three.
3. **Test on at least three real phones** — an older Android, a current Android, and an iPhone — for certificate
   acceptance and Add to Home Screen. These are the paths most likely to differ from the test environment, and the
   ones users hit first.
4. **Print a receipt on a real 58 mm and a real 80 mm thermal printer**, in a currency whose symbol is missing from the
   printer's code page, to confirm the ISO-code fallback reads well at that size.
5. **Bind licences to a machine fingerprint** so an on-site licence cannot be copied between computers, which would let
   the on-site period cap be raised without the same risk.
6. **Lower the on-site cap.** If it is currently generous, halve it. The cap is the only thing standing between a
   leaked password and years of free software.
7. **Add a currency-conversion phase**, if customers ask for it — with a rate snapshot per sale, because a
   reconstructed rate is a guess and a guessed rate is a wrong ledger.

---

## 8. Where everything is

| What | Where |
| --- | --- |
| The release folder, manifest and checksums | `release/` |
| The Build Studio bundle | `tools/build-studio-bundle/` |
| The Vendor Cloud bundle | `cloud-package/infoflex-vendor-cloud.zip` |
| Customer instructions | `docs/CUSTOMER_GUIDE.md` |
| Vendor instructions | `docs/VENDOR_GUIDE.md` |
| Problem solving | `docs/TROUBLESHOOTING.md` |
| Database and API reference | `docs/SCHEMA.md` |
| Every design decision and its reasoning | `docs/DECISIONS.md` |
| The clean-machine checklist | `docs/RELEASE-CHECKLIST.md` |
| What the release folders should contain | `docs/RELEASE-CONTENTS.md` |

Verify a downloaded file with `certutil -hashfile <file> SHA256` on Windows, or `sha256sum -c release/SHA256SUMS.txt`
elsewhere.

---

## 9. Honest summary

The software is complete, the tests pass, the secrets are clean, and the documentation describes what the code
actually does — three claims in the drafts were wrong and were corrected against the source.

The packaging is not complete. Three of the five required deliverables could not be built, for reasons that are
environmental and stated precisely in §5, and the end-to-end test the phase asked for could not be run because its
first step is impossible here.

The installer fixes in §3 are the most valuable output of this phase, and the most uncomfortable: a product that had
passed every automated check for four phases was, until this session, incapable of producing an installer that
installed the application.
