# Release checklist — hardware gates

These are the checks that **cannot** be performed by the automated suite or on a Linux build machine.
Everything software-verifiable is already covered by `npm run check:phase8` and summarised in
[PHASES.md](PHASES.md). Nothing here should be marked done on the basis of automated tests.

Each gate below is tagged **needs manual check on real hardware**. Do the gates in order: gate 1 produces
the installer that gates 2 and 4 install, gate 3 needs gates 1–2 working, and gate 4 needs gate 1 and a
USB stick.

Prepare once:

- A Windows 10 or Windows 11 **x64** PC (a clean VM is ideal; use a normal user account, not a terminal-only
  session). Note whether the account is the same one you will use later.
- One iPhone (iOS 16 or newer) and one Android phone (Android 10 or newer).
- A shop-like Wi-Fi router you can administer: set it to a private range such as `192.168.1.0/24`, and confirm
  the PC and both phones join **the same** SSID/subnet. A second "guest"/mobile-hotspot network is useful for
  the negative test in gate 3.
- A test shop database with at least one completed sale and one return, so reports are not empty.
- Do **not** use real customer data, and do **not** port-forward anything.

---

## Gate 1 — Windows x64: graphical installer and DPAPI `safeStorage`

**Status: needs manual check on real hardware.**
Why it cannot be automated here: packaging and OS-protected encryption are Windows-only behaviours. The
build agent has no Windows, no Wine, and no DPAPI.

### 1.1 Build the installer on Windows

1. Install Node.js 22 LTS (x64) and Git on the Windows PC.
2. In a terminal **on that PC** (maintainer step only — customers never do this):
   ```powershell
   git clone <repository> infoflex
   cd infoflex
   npm ci
   npm run check:phase7
   npm run dist:win
   ```
3. Confirm `npm run check:phase7` finishes with all tests passing.
4. Confirm `npm run dist:win` produces `dist\Infoflex Setup.exe`.
   - Native modules are prebuilt (N-API), so no Windows compiler or `node-gyp` toolchain is required.
   - If it fails, record the failing step and the last ~20 log lines; do not hand-edit `dist\`.

### 1.2 Confirm it is a graphical installer

1. Double-click `dist\Infoflex Setup.exe`.
2. Confirm you see the NSIS wizard with the Infoflex banner/sidebar artwork, an **Installation directory**
   choice, and desktop + Start Menu shortcut options.
3. Confirm you are never asked to open a terminal, run a command, or edit a file.
4. Install to the default location using **your normal user account** without "Run as administrator".
5. Confirm the desktop shortcut opens Infoflex and the license screen appears before setup or login.

### 1.3 Confirm DPAPI `safeStorage` protects the mobile TLS identity

1. Sign in as an Admin, complete first-run setup if prompted, then open **Mobile Access** and choose
   **Enable mobile access**.
2. Confirm the status shows **Running**, a private `https://192.168.x.x:43871/` URL, and a root SHA-256
   fingerprint.
3. In File Explorer, open `%APPDATA%\Infoflex\` (the Electron `userData` folder) and locate
   `mobile-api-identity.json`.
4. Open it in Notepad and confirm:
   - `encryptedCaPrivateKey` and `encryptedServerPrivateKey` contain **base64 gibberish**, not
     `-----BEGIN PRIVATE KEY-----`.
   - Searching the whole `userData` folder for `PRIVATE KEY` finds **no plaintext key**.
5. Restart the PC **without** changing the Windows account. Start Infoflex again.
   - Confirm the listener can be re-enabled and the **fingerprint is unchanged**, i.e. the OS could decrypt
     the stored keys.
   - If Windows prompts to sign in as a different user, the keys must fail closed instead: record the error.
6. Sign out of Windows and sign in as a **different local user**, then start Infoflex from the installed
   shortcut.
   - Expected: mobile access refuses to start (or reports an invalid/undecryptable identity) instead of
     serving HTTPS. Record the exact message.
7. Confirm `basic_text` fallback never appears in the packaged app; that path is only reachable on
   unsupported Linux storage backends and is already covered by automated tests.

### 1.4 Uninstall, and check what it actually removed

Everything in this section is **compiled and inspected, never run**. `npm run installer:compile` builds the uninstaller
pass, so the hooks are known to compile in the layering electron-builder uses; nothing here has executed, because there
is no Windows and no Wine in the build environment. These steps are the only thing that will tell us the uninstaller
behaves.

Do this on a machine you can throw away, after a full install with mobile access enabled and a first-run setup done.

1. **Before** uninstalling, note the state you expect to be gone:
   - `netsh advfirewall firewall show rule name="Infoflex Mobile Access"` — one rule.
   - `reg query "HKLM\Software\Microsoft\Windows\CurrentVersion\Run" /v Infoflex` — one value.
   - `reg query "HKLM\Software\Infoflex"` — the installer's InstallDir/CurrencyCode/KeepInTray values.
   - `%ProgramData%\Infoflex\install-config.json` — exists.
   - `%APPDATA%\Infoflex\` — the database, licence and paired phones.
2. Run the uninstaller and answer **No** to "Keep your shop data" (i.e. remove everything).
3. Confirm all of these are gone: the firewall rule, the `Run` value, `HKLM\Software\Infoflex`,
   `%ProgramData%\Infoflex\install-config.json`, and `%APPDATA%\Infoflex\`.

   The `%APPDATA%` one is the check that matters most. Under `perMachine: true` the uninstaller's shell variable context
   is `all` until the hook switches it, so `$APPDATA` there is `C:\ProgramData`; the fix switches to `current` before
   deleting. If `%APPDATA%\Infoflex\` survives, that switch is not working, and the "remove everything" answer is
   lying to the customer.

   Also confirm `%APPDATA%\infoflex-pharmart\` and `%APPDATA%\Infoflex Pharmart\` — electron-builder may target the
   package name rather than the app name — and record which one actually existed.
4. Reinstall, and answer **Yes** to "Keep your shop data" this time.
   - Expected: the program is replaced and the database, licence and paired phones are still there.
   - Expected: `install-config.json` is written again, so the setup screen still arrives with the right currency.
5. Run the uninstaller as a **different** Windows administrator from the one who installed.
   - Expected: it still removes the machine-wide items, because it elevates. Record the exact outcome if it does not.
6. Install, then uninstall **without** ever completing first-run setup.
   - Expected: `%APPDATA%\Infoflex\` may not exist at all; the uninstaller must not fail on its absence.

### 1.5 Silent install, silent uninstall, and an upgrade

These are the paths an unattended deployment takes, and none of them can be exercised here. A `MessageBox` with no
`/SD` is shown even under `/S`, so the failure mode is a process that waits forever rather than one that errors — check
for a hang, not for a message.

1. Install silently from an administrator prompt:
   `"Infoflex Setup.exe" /S /PASSWORD=<the vendor password>`
   - Expected: it completes with no window at all and no visible dialog. Time it; record how long.
2. **Check the gate is real, which it was not before this phase.** Run each of these and record the result:
   - `"Infoflex Setup.exe" /S` with no password on a machine with no prior install.
     Expected: it fails with "needs the vendor password for a silent install" and installs nothing. If it installs,
     the gate is bypassable with one flag again.
   - `"Infoflex Setup.exe" /S /PASSWORD=wrong`.
     Expected: it fails, says the password is not correct, and changes nothing.
   - `"Infoflex Setup.exe" /S /PASSWORD=<correct> /CURRENCY=XYZ` where XYZ is not a supported code.
     Expected: it fails and names XYZ.
   - `"Infoflex Setup.exe" /S /PASSWORD=<correct>` on a **32-bit** Windows machine, or on Windows 8.1 or older.
     Expected: it refuses and installs nothing. This check exists because the system-check page was the only place it
     was enforced, so `/S` used to install a 64-bit app where it could not run. If you have no such machine, say so in
     the record rather than ticking it.
   Be aware that the password you type appears in the process command line while it runs; this is a known and accepted
   cost of the silent path, not a defect to report.
3. **Check the prerequisite is installed on the silent path.** On a Windows machine that does NOT have the Visual C++
   2015-2022 x64 redistributable (a fresh VM is ideal; check `HKLM\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64`),
   run the silent install from step 1.
   - Expected: the runtime IS installed afterwards, the same as an interactive install would do. It used to be skipped
     silently, because the detection lived only on a page that `/S` never draws.
   - Also confirm the app starts, which is the thing the runtime is for.
4. **The offline installer must refuse an incomplete build.** If you can produce one deliberately (build with
   `-DPREREQUISITE_VCREDIST` pointing at a missing file), run it on a machine with no internet.
   - Expected: it refuses and says the installer is incomplete. It used to install anyway while the components page
     promised "every prerequisite is included".
   - If you cannot produce one, record that rather than ticking it.
5. Uninstall silently via `"%PROGRAMFILES%\Infoflex\Uninstall Infoflex.exe" /S`.
   - Expected: completes without a dialog, and keeps your data (silent means no question, and the safe default is "keep").
6. **The upgrade test, which is the one that matters.** Install the previous build, complete first-run setup and add a
   product. Then install the new build over it, interactively.
   - Expected: the installer does **not** ask "Keep your shop data?" — the old uninstaller runs silently underneath it,
     and a question there would be about data the upgrade must keep.
   - Expected after the upgrade: your products are still there and the app opens without first-run setup.
   - Record what happens if you answer **No** at such a prompt, if you see one. That delete is unrecoverable, and seeing
     it at all means the `--updated` guard is not working.
7. Repeat step 6 but start the new installer from a command line with `/S`.
   - Expected: same outcome, no dialog, data intact.
8. Cancel an upgrade by running the new installer and answering "No" to "are you sure you want to cancel?" if offered.
   - Expected: the old version is still installed and working. An upgrade that removes the old version before it has
     installed the new one leaves the machine with neither.

### Gate 1 record

| Check | Result | Notes / exact message |
| --- | --- | --- |
| `check:phase7` green on Windows | ☐ pass ☐ fail | |
| `dist\Infoflex Setup.exe` produced | ☐ pass ☐ fail | |
| Wizard is graphical, no terminal needed | ☐ pass ☐ fail | |
| Installs as standard user, app launches | ☐ pass ☐ fail | |
| Identity file stores base64, no plaintext key | ☐ pass ☐ fail | |
| Same-user restart keeps fingerprint | ☐ pass ☐ fail | |
| Different Windows user fails closed | ☐ pass ☐ fail | |
| Uninstall removes firewall rule, Run value, HKLM key | ☐ pass ☐ fail | |
| Uninstall removes `install-config.json` from ProgramData | ☐ pass ☐ fail | |
| "Remove everything" really removes `%APPDATA%\Infoflex` | ☐ pass ☐ fail | |
| Uninstall as a different admin still removes machine-wide items | ☐ pass ☐ fail | |
| Silent install `/S /PASSWORD=` completes with no dialog | ☐ pass ☐ fail | |
| Silent install with NO password FAILS and installs nothing | ☐ pass ☐ fail | |
| Silent install with a WRONG password fails and changes nothing | ☐ pass ☐ fail | |
| Silent install with an invalid `/CURRENCY=` fails | ☐ pass ☐ fail | |
| Silent install INSTALLS the VC++ runtime when missing | ☐ pass ☐ fail | |
| `install.log` exists after a successful install, opens, has content | ☐ pass ☐ fail | |
| `install.log` exists after a FAILED install, ends `Result: FAILED` | ☐ pass ☐ fail | |
| Offline installer refuses a missing payload | ☐ pass ☐ fail ☐ not tested | |
| Silent install on 32-bit or pre-Win10 refuses | ☐ pass ☐ fail ☐ not tested (no machine) | |
| Silent uninstall `/S` completes with no dialog, keeps data | ☐ pass ☐ fail | |
| Upgrade does NOT ask the keep-data question | ☐ pass ☐ fail | |
| Upgrade preserves products and skips first-run setup | ☐ pass ☐ fail | |

---

## Gate 2 — Physical iOS and Android: certificate trust and PWA install

**Status: needs manual check on real hardware.**
Why it cannot be automated here: installing a root CA and adding a home-screen icon are OS/browser UI
actions on real devices. The build agent has no phones, no Safari, and no Android runtime.

### 2.1 Export and verify the certificate fingerprint

1. On the Windows PC, sign in as Admin and open **Mobile Access** with the listener running.
2. Write down the **Root SHA-256 fingerprint** shown on screen (32 hex pairs).
3. Choose **Export trust certificate**. Confirm the browser/Explorer saves
   `infoflex-mobile-root-ca.crt`.
4. The `.crt` must contain **only** a public certificate. Right-click → Open → confirm it shows
   `Infoflex Mobile Access Root` and no private key. Do not proceed if a key is present.
5. Transfer it to each phone over a trusted channel (USB cable, AirDrop to your own phone, or local
   share). Do not email it through untrusted relays.

### 2.2 iPhone / iPad

1. Open the `.crt` on the phone and, if prompted, allow the **Profile Downloaded** banner.
2. Go to **Settings → General → VPN & Device Management → Infoflex Mobile Access Root → Install**, then
   enter the passcode and confirm **Install**.
3. Go to **Settings → General → About → Certificate Trust Settings** and enable **full trust** for
   `Infoflex Mobile Access Root`.
4. Open Safari and go to `https://<private-host-ip>:43871/`.
   - Expected: the pairing screen loads **with no certificate warning**, and the address bar shows a lock.
   - A warning page means the certificate is not trusted; stop and fix trust rather than tapping through.
5. **Add to Home Screen**: tap Share → **Add to Home Screen** → Add.
6. Launch the new **Infoflex Admin** icon from the home screen.
   - Expected: it opens full-screen (no Safari chrome), portrait, with the Infoflex launcher icon and a dark
     blue status bar — not a screenshot thumbnail and not a browser tab.

### 2.3 Android

1. Open the `.crt` from Files/Downloads and choose **Install certificate → CA certificate → Install anyway**
   (menu names vary by vendor: *Security → Encryption & credentials → Install a certificate*).
2. Confirm the certificate appears under **Trusted credentials → User**.
3. Open Chrome and go to `https://<private-host-ip>:43871/`.
   - Expected: pairing screen loads with no warning and a padlock.
4. **Install app**: Chrome menu → **Install app** / **Add to Home screen** → Install.
5. Launch the installed app from the launcher.
   - Expected: standalone window, Infoflex icon rendered inside a round/squircle mask without clipping or a
     white border, correct app name, dark blue theme colour.

### 2.4 Pair and use the phone

1. On the desktop choose **Pair an Admin phone**; a one-time eight-digit code appears with a countdown.
2. On the phone enter the code and a phone name; confirm pairing succeeds.
3. Confirm on the desktop that the phone appears in **Paired Admin phones** and the slot count increments.
4. On the phone, check the period selector: **Daily** and **Monthly** totals, the day-by-day chart,
   payment/refund method panels, and **Share / download PDF** (share sheet opens, or the PDF downloads).
5. Open **Return approvals**, then approve or reject a pending return. Confirm the decision appears on the
   desktop with channel **MOBILE**.
6. Confirm a Cashier account cannot pair and cannot reach the Admin screens.
7. In Settings/DevTools or a fresh tab, confirm the service-worker cache contains **only** static assets —
   no report JSON, no return data, no tokens.

### 2.5 Update after rebuild (cache versioning)

1. On the Windows PC, re-run `npm run build:mobile` (or `npm run build`) after a visible UI change, and
   restart Infoflex.
2. On the phone, close and reopen the installed app (pull to refresh, or fully quit and relaunch).
3. Expected: the **new** build appears. A phone stuck on the old screen means the stamped cache name did not
   rotate — record it as a failure.
4. Stop the Infoflex listener on the desktop and relaunch the installed app.
   - Expected: the app opens to its own screen (not a blank page) and shows that data is unavailable /
     reconnect to the host. It must **not** display cached financial figures.

### 2.6 Revocation and sign-out

1. On the phone choose **Sign out**; confirm the desktop phone list loses the device and the slot is freed.
2. Pair again, then on the desktop choose **Revoke** for that phone; confirm the phone can no longer load
   data (sign-in/pairing screen) on its next request.

### Gate 2 record

| Check | iOS | Android | Notes |
| --- | --- | --- | --- |
| Fingerprint on phone matches desktop | ☐ | ☐ | |
| Root CA installed and trusted | ☐ | ☐ | |
| PWA loads with no certificate warning | ☐ | ☐ | |
| Add to Home Screen / Install app works | ☐ | ☐ | |
| Launches standalone with correct icon | ☐ | ☐ | |
| Pairing with one-time code | ☐ | ☐ | |
| Daily and monthly summaries correct | ☐ | ☐ | |
| PDF share/download | ☐ | ☐ | |
| Approve/reject returned with `MOBILE` channel | ☐ | ☐ | |
| Service-worker cache has static assets only | ☐ | ☐ | |
| New build visible after rebuild | ☐ | ☐ | |
| Offline launch shows no financial data | ☐ | ☐ | |
| Sign-out and desktop revoke both work | ☐ | ☐ | |

---

## Gate 3 — Live LAN Wi-Fi, router and firewall behaviour

**Status: needs manual check on real hardware.**
Why it cannot be automated here: this is real network topology, OS firewall prompting, AP client isolation,
and router configuration. The build agent only proves the socket-address check in code.

### 3.1 Reachability on the shop LAN

1. Connect the Windows PC by Wi-Fi (or Ethernet) and both phones to the **same** private network.
2. Confirm the URL shown in Mobile Access uses a private address (`10.x`, `172.16–31.x`, or `192.168.x`).
3. Confirm both phones load the PWA at that address.

### 3.2 Windows firewall

1. When Windows Defender Firewall first prompts for Infoflex, allow it on the **Private** network profile
   **only**. Do not tick Public/Domain unless the shop LAN genuinely requires it.
2. If no prompt appears and phones cannot connect:
   **Windows Security → Firewall & network protection → Allow an app through firewall** → enable Infoflex
   for **Private** only → confirm phones can connect.
3. Confirm the adapter is classified as a **Private** network, not Public. On a Public profile the phone must
   be unable to connect; record that as expected behaviour.

### 3.3 LAN-only enforcement (negative tests)

1. **Guest network / mobile hotspot:** put one phone on a different network (guest SSID or 4G hotspot) and
   try the host URL. Expected: no response / timeout. The listener must not be reachable from outside the LAN.
2. **AP client isolation:** if your router has "client isolation"/"AP isolation" on the main SSID, confirm the
   effect and then disable it for the shop SSID, since isolated clients cannot reach the host.
3. **Forwarding:** confirm the router has **no** port-forward / DMZ / UPnP rule pointing at the PC's
   `43871` port. If any exists, remove it. Do not port-forward the mobile listener under any circumstances,
   even on a license that includes an Internet feature.
4. From a machine on another network, attempt to reach `https://<public-ip>:43871/`. Expected: connection
   refused or timeout, never the pairing screen.

### 3.4 Shutdown and address-change behaviour

1. With the listener running, quit Infoflex. Confirm the phone can no longer load data.
2. Relaunch: confirm the listener stays **off** until an Admin explicitly enables it again.
3. While running, move the PC to a different private subnet (e.g. switch SSID to another router) and confirm
   within ~1 minute that the listener stops and the status shows it is no longer running. Re-enable it and
   confirm the URL reflects the new private address.
4. While running, expire or remove the LAN entitlement on the license (use the mock service in a development
   install: `npm run cloud:mock`). Confirm the listener shuts down and does not restart by itself.
5. Confirm report/API responses are `no-store` (browser DevTools → Network → check `cache-control`).

### Gate 3 record

| Check | Result | Notes |
| --- | --- | --- |
| Same-LAN reachability from both phones | ☐ pass ☐ fail | |
| Firewall allowed on Private only | ☐ pass ☐ fail | |
| Public-profile network blocked | ☐ pass ☐ fail | |
| Phone on foreign network cannot connect | ☐ pass ☐ fail | |
| No port-forward/DMZ/UPnP rule | ☐ pass ☐ fail | |
| Public IP cannot reach the listener | ☐ pass ☐ fail | |
| Quit stops the listener; relaunch stays off | ☐ pass ☐ fail | |
| Address change stops the listener | ☐ pass ☐ fail | |
| LAN entitlement loss stops the listener | ☐ pass ☐ fail | |
| API responses are `no-store` | ☐ pass ☐ fail | |

---

## Gate 4 — Windows x64: backup to a USB stick, wipe, and restore

**Status: needs manual check on real hardware.**
Why it cannot be automated: it needs real removable media, the Windows file picker, and a full app restart
against a replaced database file. The automated suite proves the same flow on temporary files, but not with
your hardware.

### 4.1 Prepare

1. Install the app from gate 1 and sign in as the Admin.
2. Record three sales and one return so reports are not empty. Note the store name and the currency shown on
   the receipt.
3. Plug in a USB stick and note its drive letter (e.g. `E:\`).

### 4.2 Back up to the USB stick

1. Open **Settings** and scroll to **Backup & restore**.
2. Press **Choose folder…** and pick the USB stick. Confirm the folder path appears in the box.
3. Press **Back up now**. Confirm the message names a file beginning `infoflex-backup-…`.
4. In Windows Explorer, open the stick: confirm both `infoflex-backup-….infoflexbackup` and its
   `.manifest.json` are there, and that the file is not 0 bytes.

### 4.3 Wipe the shop data

1. Quit the app.
2. In `%APPDATA%`, find the app's user-data folder and rename `infoflex.sqlite` to `infoflex.sqlite.old`
   (keep it — this is your manual safety copy). Remove `infoflex.sqlite-wal` and `infoflex.sqlite-shm` if present.
3. Start the app. Confirm it shows first-run setup (no users, no sales).

### 4.4 Restore

1. Complete first-run setup far enough to sign in as an Admin again (a temporary Admin, different password).
2. Open **Settings → Backup & restore**, press **Choose folder…**, pick the USB stick, then
   **Find backups in this folder**.
3. Press **Restore this** on your backup and accept the confirmation.
4. The app restarts on its own. Sign in.

### 4.5 Verify

| Check | Expected | Result |
| --- | --- | --- |
| Sales and return from 2.2 are back | Same receipts, same amounts | ☐ pass ☐ fail |
| Store name and currency | Same as recorded before the wipe | ☐ pass ☐ fail |
| Licence panel | Same edition, period and days remaining as before the wipe; the app was never unlicensed | ☐ pass ☐ fail |
| Paired phones | Same device list in **Mobile Access** as before the wipe | ☐ pass ☐ fail |
| Currency change | Blocked, with "The currency is locked because transactions already exist." | ☐ pass ☐ fail |
| Safety copy | A `…-before-restore…` file exists in the app-data `backups` folder | ☐ pass ☐ fail |
| Recent activity list | Shows the restore, newest first, with your Admin username | ☐ pass ☐ fail |
| Second restore of a foreign-currency backup | Refused with the mixed-currency message; data unchanged | ☐ pass ☐ fail |

### 4.6 Negative checks

1. Switch off **Bank transfer** in Settings → receipt settings; try a transfer tender at the till: refused.
2. Set the discount limit to 5%; try a 10% manual discount as an Admin: refused.
3. Rename the manifest on one backup file and try to restore it: refused, nothing changes.

---

## Sign-off

Phases 7 and 8 are closed on software scope (see [PHASES.md](PHASES.md)). A customer release requires all
four gates above to be ticked on real hardware:

- [ ] Gate 1 — Windows x64 installer + DPAPI `safeStorage` — needs manual check on real hardware
- [ ] Gate 2 — iOS/Android certificate, trust, PWA install, update — needs manual check on real hardware
- [ ] Gate 3 — live LAN/router/firewall, LAN-only, no port forwarding — needs manual check on real hardware
- [ ] Gate 4 — Windows backup to USB, wipe, restore, licence/devices intact — needs manual check on real hardware

Remaining known software limitations (not gates): jurisdiction-specific tax rules and tax-authority filing
formats are not implemented (a single configurable VAT rate is); store-credit redemption against a later sale
is not implemented; there is no production license cloud or
Internet mobile hosting; the machine binding is OS-install-ID based, not hardware-backed.

## Phase 9 — real-phone and clean-Windows gates

These cannot be proven by the automated suite (it uses loopback HTTPS with generated certificates, injected
firewall/power/login-item fakes, and a fake OS key store). Each must be done by hand on real hardware.

**Admin phone, on the shop Wi-Fi**
- [ ] Save the certificate from Mobile Access and install it on a real Android phone (Settings → Security → Encryption & credentials → Install a certificate → CA certificate).
- [ ] Install the same certificate on a real iPhone and switch on full trust (Settings → General → About → Certificate Trust Settings).
- [ ] Open the address shown on the desktop in the phone browser with **no** certificate warning, and compare the shown fingerprint with the desktop.
- [ ] Point the phone's normal camera app (not a special scanner app) at the QR code on the pairing card: it must offer to open exactly the address shown underneath.
- [ ] Then enter the pairing code by hand — the QR deliberately does not contain it — and confirm the desktop pop-up names the right phone, type, code and address.
- [ ] Approve on the PC, then sign in on the phone with the Admin username and password; confirm the phone shows data and the desktop shows "1 phone connected right now".
- [ ] Turn on the authenticator: scan the set-up QR code with a real authenticator app (and check the typeable key also works), confirm a code, then sign in over the Internet with a code (and confirm a replayed code is refused).
- [ ] Leave the phone idle for 30 minutes and confirm it asks for the password again instead of silently continuing.
- [ ] Enter a wrong password five times on the phone and confirm it is locked out; confirm the desktop audit log records each attempt with device name and IP.
- [ ] Revoke the phone and confirm the next API call fails immediately; "Revoke all" and "Turn off all mobile access" behave the same.
- [ ] Add to Home Screen and confirm the installed web app still reaches the host after a rebuild (service-worker update).

**Cashier and Supervisor**
- [ ] On a real phone, try to sign in with a Cashier account and then a Supervisor account: the message must be identical to a wrong password, with no hint of the role, and each attempt must appear in the audit log.

**Tray and power, on a clean Windows 10/11 x64 machine**
- [ ] Close the main window with mobile access on: Infoflex stays in the tray and the phone keeps working; "Quit Infoflex" from the tray really exits.
- [ ] Enable "Start Infoflex when Windows starts", restart Windows, and confirm the app starts hidden with mobile access available.
- [ ] With "Stop the computer sleeping" on, confirm the PC does not sleep while a phone is connected and does sleep again after the phone disconnects.
- [ ] Confirm DPAPI-backed `safeStorage` works in the packaged build (authenticator secret survives a restart, and a copied database cannot be decrypted on another PC).

**Windows Firewall**
- [ ] On a fresh install with the rule absent, confirm Mobile Access reports the port as blocked with plain-language text.
- [ ] Press "Repair firewall rule", approve the Windows prompt, and confirm the phone can connect, and that the new rule is **Private profile only**.

**Licence**
- [ ] With an expired/suspended licence, confirm the phone shows the licence message and no data, and that every other mobile route is refused.

**Bluetooth**
- [ ] Confirm a Bluetooth receipt printer and a Bluetooth barcode scanner on the PC still work while mobile access is on (mobile access never uses Bluetooth).

## Phase 10 — Admin phone app on real phones

None of the following could be run in this environment (no Android or iPhone, and no browser could be installed
here), so each item is a manual check before release.

### Install and shell
- [ ] On Android Chrome, open the address from the desktop and use ⋮ → "Add to Home screen" / "Install app". The desktop browser must say the host is trusted, and the installed app must open standalone (no address bar).
- [ ] On iPhone (Safari only — Edge/Chrome on iOS cannot install), use Share → "Add to Home Screen". Confirm iOS 16.4 or later, and that the installed app opens with the navy splash and the shop's name in the header.
- [ ] Confirm the icon on the home screen is the Infoflex mark at a sensible size, and the status bar uses the navy theme.
- [ ] Put the phone in flight mode, reopen the installed app, and confirm the shell paints with the "Offline" banner and the last screen's data is **not** served from cache as if it were current.
- [ ] While offline, press Save on a stock adjustment and a price change: the phone must refuse immediately with "Nothing was saved" and must never queue the write.

### Admin-only
- [ ] Sign in with a Cashier account, then a Supervisor account: the message must be identical to a wrong password and each attempt must appear in the desktop audit log with the device name and IP.
- [ ] With the phone signed in, demote that Admin on the desktop: the phone's next action must be refused, not wait for a token to expire.
- [ ] Confirm there is no cashier mode, no selling screen and no "new sale" control anywhere in the installed app.

### Scanning, stock and money
- [ ] Scan a real barcode with the phone camera; confirm it opens the matching product, and that the torch toggle works (or says the phone offers no torch).
- [ ] Cover the camera and type the barcode instead: manual entry must always work.
- [ ] Scan a barcode that is not on file, add the product, then receive its first stock with a batch and expiry date.
- [ ] Edit the retail and wholesale prices, confirming the Admin password is asked for again and a wrong password saves nothing.
- [ ] Adjust stock with each reason in the list and with "Other"; confirm the reason appears in the stock history with the Admin's name.
- [ ] In the **NGN** shop, confirm amounts read exactly as on the desktop (e.g. ₦1,234.56) and that a price typed with a comma thousands separator is accepted.
- [ ] In a **0-decimal** currency shop (e.g. UGX), confirm reports show `USh 255,000` with no decimals, and that typing `2500.50` into a price box is refused with "This currency allows at most 0 decimal places".
- [ ] Widen/reduce the phone's text size (Accessibility settings) and confirm no control is clipped and the tab bar stays usable.

### Reports, sales and approvals
- [ ] Open Reports for today and for this month, then share the PDF: the share sheet must receive a real PDF named after the shop, and opening it must show the same figures in the shop's currency.
- [ ] Browse Sales, open a retail receipt and a wholesale invoice, share each as a PDF and as an image, and print at the counter. Confirm the sale is described as view-only and cannot be edited.
- [ ] Raise a discount request at the desktop, then approve it from the phone and confirm the till accepts the discount; try to approve the same request again from a stale screen and confirm "already decided".
- [ ] Switch a cashier's "can make wholesale sales" on and off from the phone, with the Admin password, and confirm the till honours it immediately and no other permission changed.
- [ ] Open More → Manage connected phones: the list must show this phone as signed in, and revoking another paired phone must make that phone's next action fail at once.
- [ ] Press the approvals tab with a pending request: the in-app badge must show the count. (Web Push is not shipped in this phase — there is no push notification to test; see docs/DECISIONS.md.)

## Phase 11 — Vendor Cloud and the internet relay (needs manual check on real hardware / a real host)

The cloud's own suites run here (`npm run check:phase11`), but four things cannot be proved in a build container:
a real domain with a real certificate, a real phone on mobile data, a real MySQL host, and a real Ed25519 signer.
Each item below is written so somebody with the deployed system can tick it.

### The licence server, on the real domain
- [ ] Deploy the cloud build by following `cloud/docs/DEPLOYMENT.md` from Part 1 to Part 5 on the real host. Every step must be possible in the hosting panel; if any step needs a terminal that the guide does not already name, fix the guide.
- [ ] Open `https://<your-domain>/health` and confirm `{"status":"ok","version":1}` with a valid padlock and no certificate warning.
- [ ] Confirm the browser shows HSTS on the second visit, and that `curl -sI https://<your-domain>/portal/login` (or the browser's network panel) shows `x-frame-options: DENY`, `content-security-policy` with `script-src 'none'`, and `x-content-type-options: nosniff`.
- [ ] Sign in to the portal with the Owner account and the authenticator app: the six-digit code must be required, and a code reused twice must be refused.
- [ ] Stop and restart the container; confirm the portal still knows the Owner account and every licence (the database volume and key volume are mounted correctly).
- [ ] Let one daily backup run, then list `INFOFLEX_CLOUD_BACKUP_DIR`: `infoflex-cloud-YYYYMMDDTHHMMSSZ.sqlite` must exist and be a plausible size. Restore it into a scratch copy and confirm the portal opens with the same licences.
- [ ] If SMTP is configured, confirm one expiry reminder arrives at the vendor inbox and that the dashboard marks the stage as sent.

### A real shop PC against the real cloud
- [ ] On a Windows shop PC, import the vendor policy that pins the cloud's public key, then activate online with a key created in the portal. Confirm the Licence screen shows the end date and the edition.
- [ ] Confirm setup preselects the portal's default currency, and that a licence with **Lock currency** ticked cannot be changed in Settings (the lock explanation must say the vendor set it).
- [ ] From the portal on a phone, extend the licence by a year and press **Notify now**; within the polling interval the till's Licence screen must show the new end date with no password typed.
- [ ] From the portal, suspend the licence: the till must refuse a new sale within the polling interval and must not lose data. Unsuspend and confirm the till recovers.
- [ ] In the portal, press **Reset machine binding** for that licence, activate the same key on a second PC, and confirm the first PC reports a machine mismatch rather than silently continuing.
- [ ] Download the offline `.lic` file for that licence, try to import it on a different machine, and confirm it is refused.

### The internet relay, on a real phone and real mobile data
- [ ] In the portal, create a test licence with **Mobile over the internet** ticked, activate it, then on the PC switch on local mobile access and press **Allow over the internet**. The badge must reach **Live** and show an `https://<shop>.<relay-domain>` address with a real padlock on the phone.
- [ ] Scan the link with an Admin phone **on mobile data** (not the shop Wi-Fi). Sign in with the Admin username, password and authenticator code; confirm device approval is requested on the PC and that a Cashier account is refused with the same sentence as a wrong password.
- [ ] Open a report and a pending return approval over the relay; confirm the numbers match the desktop and that an approval decided on the phone appears on the PC.
- [ ] Suspend the licence in the portal while the phone is connected: the phone must fail at once, and the PC's Mobile Access screen must show **Refused** rather than a dead tunnel.
- [ ] Switch **Allow over the internet** off on the PC: the phone must lose access while the same phone keeps working on the shop Wi-Fi.
- [ ] Disconnect the PC from the internet: the phone must show the relay's "shop's computer is offline" page, not a hang.
- [ ] Read `cloud/docs/RELAY-LIMITS.md` and confirm the sentence about the relay being able to read traffic still matches what the software does. If the sign-off on that trade-off is not acceptable to the vendor, leave internet access off — the LAN path is unaffected.

### The PHP build, on the real shared host
- [ ] Follow `cloud/docs/DEPLOYMENT.md` Part 8 on the real host: create the database, upload `public/` and `lib/`, put `config.php` above the web root, set PHP 8.1+, enable AutoSSL and force HTTPS.
- [ ] Ask the host's support to generate the Ed25519 key (the exact command is in the guide) and confirm the portal's `/api.php?action=config` returns a `publicKey`.
- [ ] Upload `tests/run.php`, open it in a browser, confirm `32 passed, 0 failed`, then **delete the tests folder**.
- [ ] Create a licence in the PHP portal, activate a real shop PC against it, and confirm the offline `.lic` download and a renewal check-in both work.
- [ ] Confirm the PHP build has no relay page and that the desktop reports "this licence server does not offer internet access".

## Phase 12 — Polish, demonstration data, and the screens a person actually sees

`npm run check:phase12` proves the behaviour: the demonstration dataset loads and removes without locking the
currency, a locked currency cannot be moved through IPC or the API, a sale in NGN/USD/JPY/KWD reaches its receipt
and its report, an Admin's phone adjustment and a cashier's sale stay consistent, and every component that this
phase touched renders. It cannot prove what any of that **looks like**, because no browser can be installed in the
build environment (`npx playwright install chromium` cannot download one) and no phone or Windows machine is
attached. The items below are the pixel-and-hardware half, and they are the reason Phase 12 is "DONE (software)"
rather than "done".

### The palette, on a screen
- [ ] On Windows at 1280×800 and at 1024×768, open each workspace (Setup, Login, POS, Inventory, Returns, Reports, Settings, Mobile Access, Licence) and confirm one navy (`#1F3F73`), one gold (`#C9A24B`) and one off-white; no purple, no second blue, no stray legacy gold.
- [ ] Do the same in the Admin phone app in an iPhone-Safari-sized window and an Android-Chrome-sized window (390×844 and 360×800). The two must look like the same product as the desktop.
- [ ] Check contrast on the gold-on-navy buttons and the muted grey body text with the browser's accessibility panel; nothing below WCAG AA for body text.
- [ ] Tab through the Settings screen: every control must show the gold focus ring, and the demo panel's buttons must be reachable in order.

### Loading, empty and confirmation states
- [ ] Start the app on a slow disk and confirm the loading screen appears and then leaves; it must never sit forever on a real machine.
- [ ] With an empty catalogue, open Inventory, POS, Returns, Reports, Approvals and Mobile Access, and confirm each says in plain words what to do next rather than showing a blank panel.
- [ ] Trigger every destructive action and confirm the dialog names the thing it will destroy: change currency, deactivate a user, revoke one phone, revoke all phones, regenerate the certificate, turn off mobile access, turn off the authenticator, discard a held cart, remove demonstration data. Cancel each one and confirm nothing changed.
- [ ] Type an invalid price, an out-of-range discount, a bad store name and an invalid phone pairing code, and confirm each message is a friendly sentence a shopkeeper understands, not an exception name.

### The demonstration dataset, on a real screen
- [ ] Settings → Demonstration data on a fresh install: load it. Confirm 30 products on the Pharmacy edition, 60 on the Supermarket edition (and 90 on Both), the Fresh and Grocery departments, six weighed lines with a PLU and a price per kilogram, and two active promotions.
- [ ] Confirm the three sample logins appear and that `Demo-Pass!2026` signs each in: `demo.cashier.on` may sell wholesale, `demo.cashier.off` may not, and `demo.supervisor` only exists on the Supermarket edition.
- [ ] Confirm the prices read sensibly in the chosen currency — no ₦0.00 items, no three decimals on a two-decimal currency, and whole numbers on a 0-decimal currency.
- [ ] Ring up one demonstration sale, then try to remove the dataset: removal must refuse and explain that a sale depends on it.
- [ ] On a second fresh install, load the dataset and remove it straight away. Confirm the catalogue is empty, the demonstration users are gone, and **Settings still lets you change the currency** — the lock must not have engaged.
- [ ] Print a demonstration receipt on the real printer and confirm it carries the shop name, the currency and the demonstration product names.

### Emulator and hardware items carried from Phase 12
- [ ] Run the PWA in a Playwright iPhone 14 profile and an Android Pixel 7 profile against a real listener; pair, sign in, read a report, adjust stock, approve a request, and confirm the layout does not scroll sideways and the touch targets are at least 44 px.
- [ ] On a physical iPhone and a physical Android phone, install the PWA from the browser prompt, confirm the splash, use the camera to scan a barcode, and print a receipt through the share sheet.
- [ ] These overlap with Gates 1–4 above; do not close a gate twice or claim one from a desktop-only check.

## Phase 13 — the installer on a clean Windows machine (Gate 5)

`npm run check:phase13` proves the installer's rules, its generated data, its structure and that no master
password is compiled into it. It cannot produce a **shippable** `.exe`, because the Windows Electron runtime cannot be
downloaded in the build environment (TLS interception on `objects.githubusercontent.com`), so there is no application
payload to package and no Wine to run one under. **So no shippable installer binary has been built or run.**

What *has* been built is the installer itself: `npm run installer:compile` compiles all three build shapes to real i386
executables and verifies each from its PE header. That proves the script, the hooks and the electron-builder wiring; it
proves nothing about behaviour. The items below are that missing half, in the order a person would meet them.

### Build, once, on a Windows build machine
- [ ] On Windows with Node 20+, run `npm run installer:online` and `npm run installer:offline`. Both must finish and leave `dist/online/Infoflex Setup.exe` and `dist/offline/Infoflex Setup Offline.exe`.
- [ ] Pin the prerequisite checksum first: replace the all-zero `sha256` in `installer/src/download-allowlist.ts` with the digest of the exact VC++ redistributable being shipped, and rebuild. (**With the zeros in place every verification fails by design.**) That now includes the execution path: until this phase, `InstallPrerequisites` ran the file without checking it, so the zeros blocked the download page while the unverified path still installed the binary.
- [ ] **Supply the redistributable the offline build carries — a decision, not just a task.** This is the one open
  question that needs a person to choose, so the options are laid out rather than assumed:

  | Option | What it costs | What goes wrong |
  | --- | --- | --- |
  | Commit `vc_redist.x64.exe` to the repository | ~25 MB in every clone, forever, for a binary Microsoft publishes | Git history grows; the file must be re-fetched and re-verified each time Microsoft revises it; it is a stale copy of a security-relevant binary |
  | Fetch it in the release job | a download step in CI, pinned by the digest already recorded | the release job needs network access to `aka.ms`, which the build agent here does not have; a fetch failure blocks a release |
  | Ship without it, on purpose | nothing | the offline installer stops being offline for its one prerequisite: a machine with no internet cannot complete the install, which is the case the offline build exists to serve |

  Whichever is chosen, the offline build must then define `-DPREREQUISITE_VCREDIST=<path>`, and the digest in
  `installer/nsis/generated.nsh` must be the real SHA-256 of the supplied file rather than the all-zero placeholder —
  an all-zero digest makes every verification path refuse the file. Note that as of this phase the offline arm
  **refuses to install** when the payload is missing (see below), so "ship without it" is now a loud failure rather
  than a quiet one. That is deliberate: before this phase the offline build installed anyway while its components page
  promised the prerequisite was included.

- [ ] **Supply the redistributable the offline build carries.** `installer.nsi` includes it with `File` only when `PREREQUISITE_VCREDIST` is defined, and no configuration defines it yet — so today the offline build produces an installer that carries no runtime and will ask for it on first use. Put `vc_redist.x64.exe` somewhere in the repo (it is ~25 MB, so decide deliberately whether to commit it or fetch it in the release job) and add `-DPREREQUISITE_VCREDIST=<path>` to the offline build so the "every prerequisite bundled" promise is actually kept. **This was a build-stopping error before the guard was added:** the offline installer would not compile at all, and the compile check could not show it because the harness defined the variable itself.
- [ ] Optional: code-sign both executables. The build must also work unsigned.

### On a clean Windows 10 VM, then a clean Windows 11 VM
- [ ] Double-click `Infoflex Setup.exe`. It must open a wizard window with the Infoflex banner and sidebar, show a UAC prompt, and **never** open a console window. (DONE WHEN 1)
- [ ] Click Next. The password page must refuse an empty and a wrong password, count down the remaining attempts, and close the installer on the fifth wrong attempt. Enter the vendor password: Next must enable. (DONE WHEN 2)
- [ ] On the currency page, confirm the list shows every built-in currency as "NGN - Nigerian naira (₦)", that it defaults to Naira, that typing searches by code, name and symbol, and that the example line reads `₦1,234,567.50`. Select **JPY** and confirm `¥1,234,568`; select **KWD** and confirm `1,234,567.500 د.ك`. (DONE WHEN 3)
- [ ] Open **Custom currency...**, enter a code, name, symbol and 3 decimals, and confirm the example updates and the wizard accepts it. Try to leave the page with an empty name and confirm it refuses with a plain sentence. (DONE WHEN 3)
- [ ] On the system check, compare every row against the machine: Windows version, free space, the VC++ runtime (uninstall it first to see the orange arrow), firewall and printer as information only. A 32-bit VM must be refused outright. (DONE WHEN 5)
- [ ] With the VC++ runtime uninstalled and the network **on**, complete the download page: progress, then a verified file, then the runtime installed. Then do it again with the network **off** and confirm the failure is explained in plain words and the file is deleted. (DONE WHEN 6, 7)
- [ ] **Confirm the install log exists, since it never did before this phase.** After the install, open
  `$INSTDIR\install.log` (typically `%PROGRAMFILES%\Infoflex\install.log`), and also click **Open install log** on
  the finish page before closing the wizard.
  - Expected: the file exists and opens in Notepad/WordPad, with a header naming the product and version, the install
    directory, the currency, and one line per step. Previously the button produced a Windows "cannot find the file"
    error because nothing ever wrote it.
  - Record the first five lines and the last line verbatim. If the file is missing, that is a release blocker: three
    separate on-screen messages tell the customer it is there.
- [ ] **Check the failure path leaves a log too.** Temporarily make the install fail (e.g. run it with the app already
  running so the payload copy fails, or cancel at the point the wizard reports an error).
  - Expected: the error dialog names `$INSTDIR\install.log` and that file exists afterwards, ending with
    `Result: FAILED`. A log that only appears on success is useless, because the failures are when it is read.
- [ ] **Confirm "Launch now" does not run the app as Administrator.** Finish the wizard with the launch box ticked,
  then look at the running process: Task Manager → Details → right-click the column header → *Select columns* →
  tick **Elevated**. The `Infoflex` process must show **No**.
  - Also confirm there was no second UAC prompt after the wizard closed. The installer is `perMachine` and is already
    elevated; before this phase the finish page used `MUI_FINISHPAGE_RUN "<path>"`, which MUI runs with `Exec`, which
    inherits that token — so the app started as Administrator on every install.
  - Then check ownership, which is the damage rather than the symptom: `%APPDATA%\Infoflex` must **not** be owned by
    `Administrators`, and `dir /q "%APPDATA%\Infoflex"` must not show `BUILTIN\Administrators` as owner. If it is,
    the DPAPI-protected mobile TLS identity was written under the Administrator's key and the next non-elevated launch
    will not be able to read it.
  - If this fails, it is a release blocker, not a cosmetic issue.
- [ ] **Confirm the downloaded runtime page shows its status text while it is working.** Uninstall the VC++ runtime and
  run the **online** installer with the network on. As the download page starts, its status line must read
  *Downloading the Microsoft Visual C++ runtime…* **while** it downloads.
  - There is deliberately **no progress bar** on that page: NSISdl drives the wizard's stock progress control by ID
    (1004/1006) and cannot address an nsDialogs control, so a bar there could only sit at zero.
  - The status line is set and then `UpdateWindow` is called before NSISdl blocks, because NSISdl pumps no messages.
    If the line stays blank until the download finishes, that `UpdateWindow` is not enough on this Windows build and
    the ordering needs revisiting — record what you saw.
- [ ] **Confirm the install folder is not editable on the Components page.** It must read *Install folder (change it
  on the previous page)* with the path underneath, and there must be no text box there. Go *back* to the Directory
  page, change the folder, continue, and confirm the Components page shows the new path and the app installs there.
  (Previously it offered an editable box whose value was discarded.)
- [ ] Install. On the finish page confirm the currency summary, the launch checkbox and the log link. Confirm a Start Menu entry, a desktop shortcut and an entry in **Apps & features**. (DONE WHEN 1)
- [ ] Launch the app. It must open on **Activation** with the store name blank, and the first-run setup screen must arrive with the installer's currency already selected — including for the **custom** currency. (DONE WHEN 4, 9)
- [ ] In `%ProgramData%\Infoflex\install-config.json`, confirm it holds the currency and no secret of any kind.
- [ ] With the firewall rule ticked, open Windows Firewall → Inbound Rules and confirm exactly one `Infoflex Mobile Access` rule, **Private** profile only, TCP, and that the Admin's phone can reach the PC after pairing. Switch the network to Public and confirm the phone is blocked. (DONE WHEN 10)
- [ ] Run the installer again over the installed copy: it must offer Repair/Update, skip the currency page, and **leave the currency and the database untouched**. Confirm `install-config.json`'s timestamp has not changed. Then Uninstall, answer "Keep my data" with Yes, and confirm the app data survives and reinstalling finds it. (DONE WHEN 11)
- [ ] Reinstall and uninstall answering No, and confirm the data is removed.
- [ ] From an elevated prompt — for this vendor test only — run `"Infoflex Setup.exe" /S /CURRENCY=GHS` on a clean VM and confirm the app opens with Ghana cedi preselected. Then run it with `/S /CURRENCY=NOTACODE` and confirm the install **fails with a message naming the switch** rather than installing Naira. (DONE WHEN 12)

### The offline installer, on a machine with no internet at all
- [ ] Disable the network adapter. Run `Infoflex Setup Offline.exe`. It must never attempt a connection, must not show the download page, must install the VC++ runtime from its own payload if it is missing, and must complete to the finish page. (DONE WHEN 8)
- [ ] Launch the app, activate **on-site** with the vendor master password, confirm the licence is created with no internet, and confirm the currency chosen at install is still the one in use. (DONE WHEN 8)
- [ ] Unplug the network again and confirm the app keeps working for local sales.

### Two things this checklist is watching for
- [ ] **The three-button download fallback.** Pull the network during the download. After the first failure the page must show **Try the download again**, **Browse for the file myself** and **Use the Offline installer instead**, and must stay on the page instead of showing a message box. After the third failure, Retry must be greyed out and the text must stop suggesting it. Then restore the network, click Retry on a fresh run, and confirm the install continues. Click Browse, choose an unrelated `.exe`, and confirm it is refused with "not the one Infoflex expects" and nothing is run. Choose the correct file and confirm the install proceeds.
- [ ] **A tampered download is not retried.** Record what the page shows when the checksum does not match: it must say the file was deleted and not run, and must not offer another attempt.
- [ ] **Anything that needs the mouse.** The rules are tested; the layout, tab order and control sizes have never been looked at by a person in this project. Record anything awkward.

---

## Phase 14 — Build Studio on a Windows vendor machine (Gate 6)

`npm run check:phase14` proves the rules, the window's wiring and that it bundles. It cannot open the window in
Electron or build a Windows installer, so **the screens have never been seen and no Build Studio `.exe` exists.**
These are the missing steps.

### First run
- [ ] On a Windows 10 and a Windows 11 machine, `npm ci`, then `npm run studio`. Confirm a window opens with no console window behind it and no menu bar. (DONE WHEN, item 1)
- [ ] **Welcome** shows one button. Press *Check computer*: every row must load, sorted blocked → orange → green, with a one-sentence verdict. Compare each row against the machine, uninstalling a tool to see the orange arrow.

### The system check, row by row
- [ ] On a machine with everything installed, every required row is a green tick and the verdict says a build can run.
- [ ] Uninstall one tool (Git is the safest). Re-check: that row turns to an **orange arrow** with a sentence saying Build Studio can install it, and the verdict still says a build cannot start yet.
- [ ] Confirm a **red cross** row (one that can only be installed by hand — the C++ build tools before the redirect is accepted) is phrased as something the vendor must do, not as something Build Studio will fix.
- [ ] Compare every row against the machine with `node --version`, `git --version` and **Apps & features**. A row that claims a tool is present when it is not is the failure that costs a vendor a day.
- [ ] Unplug the network and re-check. The rows that need no network must still resolve; anything that cannot be checked must say so rather than showing a green tick it has not earned.

### Installing the missing tools
- [ ] With Git (or another orange-arrow tool) uninstalled, press *Install the missing tools*.
- [ ] Watch for a **console window flashing**: there must be none, at any point, including during the download and the installer.
- [ ] Confirm the download comes from the official host named in the row, that Windows shows a UAC prompt for the installer, and that a tampered download is refused rather than run (the log must say the publisher could not be verified).
- [ ] Confirm the check **re-runs itself** afterwards and the row turns green with no second click.
- [ ] Confirm the count on the button matches the number of orange required rows, and that an **optional** row (Git/Python where optional) is never installed without being asked.
- [ ] Cancel a UAC prompt mid-install: the vendor must get a sentence, not a stack trace, and the row must stay orange rather than turning green.

### The one-click build on a PC with no developer tools
This is the whole promise of the tool and it cannot be proven anywhere but here: a clean Windows machine, nothing installed, and a vendor who is not a programmer.
- [ ] Take a **fresh Windows 11 VM** with no Node, no Git, no Python, no Visual Studio Build Tools, no `makensis`. Confirm none are on `PATH`.
- [ ] Install Build Studio with `npm run dist:studio`'s output. Launch it from the Start Menu — **not** from a terminal.
- [ ] *Check computer* must report exactly what is missing, without failing to start or showing an unhandled error. The window must open even though Node is absent. (DONE WHEN, item 1)
- [ ] Press *Install the missing tools* and let it finish. Accept the UAC prompts. Confirm no console window appears at any point.
- [ ] *Project* → choose the project folder. Then press **Build everything**, once, and do nothing else.
- [ ] It must complete without the vendor typing anything, and end on **Output** with both `Infoflex Setup.exe` and `Infoflex Setup Offline.exe` listed with a size and a SHA-256. (DONE WHEN, item 1)
- [ ] Confirm the total wall time is recorded, and that the elapsed clock kept running during the long steps rather than freezing.
- [ ] Press *Copy to a USB drive*, plug in a stick, and carry the two installers to a second clean machine — confirm they install there.
- [ ] **Record anything the vendor would have had to know that the window did not tell them.** That is the measure of this screen.

### The build
- [ ] **Project** → choose the project folder. A folder that is not the project must be refused; the real one must be accepted and shown with its version.
- [ ] Press *Build everything*. Confirm the steps are named in the Build screen, output streams in line by line, the elapsed time runs, and *Cancel* during the npm install really stops it (`tasklist` shows no orphaned node processes) and says nothing was copied.
- [ ] Let it finish. Confirm **Output** lists both installers with a size and a SHA-256, that the hashes match `certutil -hashfile <file> SHA256`, and that a file deleted by hand shows as *missing* on *Refresh*.
- [ ] Press *Copy to a USB drive*, choose the plugged-in stick, and confirm the files are there and the message names the folder.
- [ ] Run each smaller button (*Install project files*, *Run tests*, *Test-run the app*, *Build Admin mobile app*, *Build installers*, *Build Vendor Cloud package*) once and confirm each does what it says.
- [ ] Break the build on purpose (rename `node_modules`). Confirm the failure is explained in plain words with a next step, not raw npm output, and that *Copy error details* puts the log on the clipboard.

### The build profile reaching the customer (DONE WHEN, item 3)
- [ ] **Settings**: set version `2.3.4`, default currency **GHS**, *Lock the currency* on, on-site limit **3 years**, cloud address `https://...`. Save. Confirm a bad version and a plain `http://` address are both refused with a sentence.
- [ ] Build the installers. Confirm `installer/nsis/generated.nsh` contains `INSTALLER_DEFAULT_CURRENCY "GHS"`, `INSTALLER_CURRENCY_LOCKED 1` and `INSTALLER_APP_VERSION "2.3.4"`, and that `installer/nsis/build-profile.json` holds the same values.
- [ ] Run the resulting installer on a clean VM: the currency page must open on **Ghana cedi, read-only**, and the app's first-run setup must show the cedi locked too. (DONE WHEN, item 3)
- [ ] Repeat with the lock **off**: the page must open on the cedi and stay editable.
- [ ] **The 3-year versus no-limit test, done on one machine so the only difference is the setting.** Build once with on-site limit **3 years**: at the shop, on-site activation with a 5-year term must be **refused** with a message naming the 3-year maximum, and no licence must be created (`SELECT`-free check: the licences screen still shows *not activated*). (DONE WHEN, item 2)
- [ ] Build again with **No limit**. Confirm `installer/nsis/build-profile.json` holds `"maximumOnsitePeriodYears": null`, then on the same machine issue the **identical** 5-year term: it must be **accepted**, and the expiry shown must be five years out. (DONE WHEN, item 2)
- [ ] With the 3-year build, confirm a **3-year** term is accepted — the boundary itself, not just outside it — and a 3-year-and-one-day term is refused.

### The licence policy page (restored in phase 14 — has never been looked at by a person)
- [ ] Open `buildstudio/policy.html` **by double-clicking it**, with the network unplugged. It must work: no build
  step, no server, no console. Confirm the page makes no network request (browser dev tools, Network tab, stays empty).
- [ ] Choose a 3-year cap, a `https://` address, and generate. Confirm the file downloads as
  `infoflex-vendor-policy.iflpolicy` and contains a `PBKDF2-SHA256` hash with a salt — and that the password itself
  appears nowhere in it (`findstr /i "<your password>"`).
- [ ] Import that file into the desktop's **Activation → On-site / offline → Import vendor policy**, then issue an
  on-site licence with the master password: it must accept a 3-year term and refuse a 5-year one.
- [ ] Generate again with the same password and confirm the salt **differs** from the first export.
- [ ] Try a 6-character password, a mismatched confirmation, `http://` to a real host, and a URL with `?x=1`: all
  must be refused with a plain sentence. `http://localhost:4310` must be accepted.
- [ ] After a successful export, confirm **both password boxes are empty**.

### The licence key generator
- [ ] Wrong master password: refuse, and **confirm the password box is emptied** either way. Right password: the tools unlock. Close and reopen the window: it must be locked again.
- [ ] With the tools locked, confirm the key generator and *Save the private key* are not reachable at all.
- [ ] Enter a key name, press *Generate key pair*, and confirm the **public key and its fingerprint** appear with a plain warning that the private half has not been saved yet.
- [ ] Generate a key pair. Confirm the **public** key and fingerprint are shown, and that the private key is **not on screen, not in `build-studio-settings.json`, and not in `build-studio.log`** (`findstr /i "PRIVATE" %APPDATA%\Infoflex Build Studio\build-studio.log`).
- [ ] Press *Save the private key*, choose a path, and confirm the file exists with the contents intact and that the log names only the path. Upload it to the Vendor Cloud and confirm a licence issued from it validates in the app.
- [ ] `findstr /i "Handywife" /s buildstudio\out\*` must find nothing.

### Packaging
- [ ] `npm run dist:studio` on Windows produces `Infoflex Build Studio Setup.exe`; install it on a clean machine and confirm it opens without the project's `node_modules`.
