# Infoflex Setup — the customer installer

Two executables are produced from one NSIS source:

| Build | Command | Network | Carries |
| --- | --- | --- | --- |
| `Infoflex Setup.exe` | `npm run installer:online` | Downloads a missing prerequisite from an allowlisted Microsoft address, verifies it, runs it | Nothing extra |
| `Infoflex Setup Offline.exe` | `npm run installer:offline` | **Never opens a socket** | Every prerequisite |

Both run from a double-click with the standard UAC prompt and never show a console window.

## Where the rules live

NSIS is a macro language with no test runner and no types, so **no business rule is written in it**. The `.nsi`
draws pages and does file I/O; everything that decides something is TypeScript in `installer/src/`, where
`npm test` can prove it:

| File | What it decides |
| --- | --- |
| `installer-policy.ts` | The password gate and its five-attempt limit; the currency list, search and labels; the live example line; custom-currency validation; `/CURRENCY=` validation; which install scenario may rewrite the currency |
| `install-config.ts` | The `install-config.json` contract the app reads at first run, and how a corrupt one is refused |
| `system-check.ts` | What counts as a green tick, an orange download arrow, a red cross, and which rows block the wizard |
| `download-allowlist.ts` | The only URLs that may ever be downloaded, the pinned checksum, the publisher check, and what happens when each fails |
| `password-check.ts` | The PBKDF2 comparison and the SHA-256 check the installer shells out to (NSIS has no crypto) |
| `check-nsis-script.ts` | A static checker for the `.nsi` itself |

## Generated files — do not edit

`npm run installer:script` writes:

- `installer/nsis/generated.nsh` — the password hash and salt, the currency table (one define per field), the
  download target and the allowed hosts.
- `installer/nsis/currency-ui.nsh` — the dropdown's rows and the row-index-to-fields mapping.

They are generated from the same `CURRENCIES` array the application uses, so a currency can never exist in the
app but not in the installer.

## Brand assets

`npm run installer:assets` converts `build/installer-banner.png` and `build/installer-sidebar.png` into the 24-bit
BMPs MUI requires (`scripts/png-to-bmp.ts`). `build/icon.ico` is the setup icon.

## Before a release

1. **Pin the prerequisite checksum.** `download-allowlist.ts` ships with an all-zero SHA-256, which
   *fails verification by design* — an unpinned build cannot install its prerequisite rather than installing an
   unverified one. Replace it with the digest of the exact build being shipped.
2. `npm run installer:check` — generated files present and current, `.nsi` structurally sound, no master password
   in any shipped installer file, brand bitmaps valid.
3. Build both installers on a Windows machine (see `docs/PHASES.md`: they cannot be compiled in the Linux build
   environment).
4. Walk `docs/RELEASE-CHECKLIST.md` Gate 5 on a clean Windows 10 and Windows 11 machine.
