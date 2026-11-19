# Infoflex Build Studio

The vendor's own tool: it turns the project folder into the customer's installers, on a Windows machine, without a
terminal.

The vendor sees eight screens and never a command prompt:

| Screen | What it does |
| --- | --- |
| **Welcome** | One button: *Build everything*. It checks the computer, then builds. |
| **Check computer** | Every prerequisite with a state — green tick, orange arrow (*Build Studio can install this*), red cross (*needs doing by hand*) — and one sentence saying whether a build can run. |
| **Project** | Pick the project folder; it is confirmed by reading `package.json`, not by trusting the path. |
| **Build** | The steps, streamed line by line, with Cancel that really kills the child process. |
| **Output** | Every artefact read off the disk with its size and SHA-256, plus *Copy to a USB drive*. |
| **Vendor tools** | The licence signing key pair, and a link to the policy page. Unlocked by the vendor master password. |
| **Settings** | The build profile: version, default currency, whether it is locked, the maximum on-site term, the Vendor Cloud address. |

## Running it

`buildstudio/policy.html` is a separate, standalone page — the licence policy exporter (`.iflpolicy`). It opens in a
plain browser with no build step and no Electron, because the file a vendor double-clicks has to work when nothing
else does. Build Studio links to it; it is not part of the window.

```bash
npm run studio        # builds buildstudio/out and starts the window
npm run dist:studio   # packages a Windows installer (needs Windows; see below)
npm run check:phase14 # typecheck, the whole test suite, and the window bundle
```

`scripts/build-studio.ts` bundles three files with esbuild: `main.js` (Electron's main process), `preload.js` (the
one bridge) and `ui.js` (the window's script, compiled from `ui.ts`). `index.html` and `logo.png` are copied beside
them. `buildstudio/out/` is generated and not committed.

## The rules this tool is built around

1. **No terminal.** Every child process is spawned with `windowsHide: true` and `shell: false`, and its output is
   streamed into the window instead. Cancel uses `taskkill /T /F`, because a polite signal does not stop a Windows
   build tree.
2. **The window has no power of its own.** `contextIsolation` is on, `nodeIntegration` is off, and the window can
   only call the functions `preload.ts` exposes. Output from npm and from installers is displayed by assigning
   `textContent`, never `innerHTML`, so a log line cannot become script.
3. **The master password is never stored or shown.** Only its salted PBKDF2 hash is compared, and the password box
   is cleared whether the attempt succeeded or failed. `settings-store.ts` refuses to write a file containing
   `PRIVATE KEY` at all.
4. **The signing private key comes back once, to a save dialog.** It is written to the path the vendor picks with
   mode `0600`, its contents are never logged and never rendered — the window shows the *public* key and the
   fingerprint. Dropping the private key back to the window is a compromise made for this one dialog only.
5. **Downloads are allowlisted, hashed and signature-checked before anything runs.** `prerequisites.ts` holds the
   URLs; `main.ts` verifies Authenticode with a hidden PowerShell `Get-AuthenticodeSignature` and refuses to
   execute an unverified file.
6. **Artefacts are listed from the disk, never from intent.** A step that claims success but wrote nothing shows as
   *missing*.

## What is tested, and what is not

Tested here, on any machine:

- `src/`. `build-steps.ts` (29), `runner.ts` (11, with real child processes), `system-check.ts` (17),
  `settings-store.ts` (11), `artefacts.ts` (10), `buildstudio.test.ts` (26).
- **`policy.test.ts` (11).** The policy page run with real Web Crypto, its output parsed by the app's own parser.
- **`ui.test.ts` (14).** The real `index.html` is loaded into a DOM, `ui.ts` is bundled and run against a stub of
  the preload bridge, and every interaction is driven: the one-click build, the smaller build buttons, the three
  check states, the install-only-what-is-missing rule, the vendor unlock, key generation (asserting the private key
  never appears in the page), the settings validation, and the USB copy. This is what stops a shipped window with a
  dead button.

Not tested here, and owed to a Windows machine:

- **The window has never been opened in Electron.** There is no display and no Windows in this environment. The
  renderer logic is tested in jsdom; the Electron shell itself is not.
- **No installer has been produced by `npm run dist:studio`.** `electron-builder --win nsis` cannot download its
  toolchain here (TLS interception; no Wine, no `makensis`).
- **No real prerequisite was downloaded or installed.**

`docs/RELEASE-CHECKLIST.md` Gate 5 is the click-by-click script for closing those.
