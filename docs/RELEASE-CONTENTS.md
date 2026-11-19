# What is in the release folders, and what is not

Assembled by `npm run release:assemble` into `/release`, `/tools` and `/cloud-package`. `release/MANIFEST.json` is
the machine-readable version of this page, written on every run, and `release/SHA256SUMS.txt` carries the checksum of
every file that *is* there.

## The five deliverables

| # | Deliverable | Folder | In this build? |
| --- | --- | --- | --- |
| 1 | `Infoflex Setup.exe` | `/release` | **No — see below** |
| 2 | `Infoflex Setup Offline.exe` | `/release` | **No — see below** |
| 3 | `Infoflex Build Studio.exe` | `/tools` | **No — see below**; the runnable bundle *is* present |
| 4 | The Admin mobile PWA | inside the desktop app | **Yes** — built into the desktop bundle, which is what the installer packs |
| 5 | The Vendor Cloud package | `/cloud-package` | **Yes** |

## Why the three `.exe` files are missing

Not for want of code, and now down to **one** reason rather than three:

1. **electron-builder must download the Electron runtime for Windows.** It fetches `electron-v45.3.3-win32-x64.zip` from `github.com/electron/electron/releases/download/…`, which redirects to `objects.githubusercontent.com`. This build agent cannot reach that host — a direct `curl` of the redirect target exits 35 (SSL connect error). The rest of `github.com` is reachable, which is what makes this easy to mistake for a working network. Without a Windows payload there is nothing to put inside an installer.
2. **Not `makensis`.** An earlier version of this file said the compiler could not be installed without root. That is no longer true and is not the reason: NSIS is built from source here and its Windows stubs are cross-compiled with Zig, so `npm run installer:compile` produces a **real installer** for all three build shapes. Verified from each output's PE header.
3. **No Wine**, so the produced installer cannot be *run* here. That limits testing, not building.

The same wall stops `npm run dist:win`, `installer:online`, `installer:offline` and `dist:studio` on this machine — all
four need the Windows Electron runtime. On any Windows PC with the repository checked out, `npm ci` followed by those
four commands produces all three exactly as documented in `docs/RELEASE-CHECKLIST.md`.

**What this does not tell you:** whether the installers work. Nothing here has been run on Windows.

## What *is* in the folders, and why it is useful

| Path | What it is |
| --- | --- |
| `release/SHA256SUMS.txt` | SHA-256 of every file listed below. The paths are relative to the repository root, so verify with `sha256sum -c release/SHA256SUMS.txt` **from the root** — running it from inside `release/` fails on every entry. On Windows, `certutil -hashfile <file> SHA256` per file. |
| `release/MANIFEST.json` | Every deliverable, whether it is present, the commit it came from, and the reason for each absence. |
| `release/installer-sources/` | The six NSIS files the installer is compiled from — `installer.nsi`, the two generated includes, `json-escaping.nsh`, the offline wrapper and the build profile. Copying these onto a Windows machine is enough to rebuild the installers without the rest of the repository. |
| `tools/build-studio-bundle/` | The compiled Build Studio (`main.js`, `preload.js`, `ui.js`, `index.html`, `policy.html`) — everything `npm run dist:studio` would wrap into the `.exe`. On a Windows PC with Node installed, `npx electron tools/build-studio-bundle/main.js` runs the tool *without* packaging it. |
| `cloud-package/infoflex-vendor-cloud.zip` | The Vendor Cloud: Node and PHP builds, the portal, the relay, `docker-compose.yml`, `Caddyfile`, and `docs/DEPLOYMENT.md` (the click-by-click deployment guide). Verified to contain no `.env`, no database, no log and no private key. |

## The pre-release scan

`npm run release:scan` searches the source tree, the compiled Build Studio bundle, the cloud package and the
installer sources for the vendor master password and for any private-key material. It prints what it searched and what
it found, and exits non-zero on a hit. Its result is recorded in `docs/PHASES.md` and in the final report.

## Rebuilding the executables on Windows

On a Windows 10/11 machine with Node 20+:

```
npm ci
npm run installer:online      # -> dist/online/Infoflex Setup.exe
npm run installer:offline     # -> dist/offline/Infoflex Setup Offline.exe
npm run dist:studio           # -> dist/buildstudio/Infoflex Build Studio Setup.exe
npm run release:assemble      # collects all of them into release/ and tools/, with checksums
```

Then work through Gate 5 and Gate 6 of `docs/RELEASE-CHECKLIST.md`. That is the only way any of this becomes "tested".
