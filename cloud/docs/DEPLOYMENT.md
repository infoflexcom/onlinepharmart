# Deploying Infoflex Cloud without a command line

This guide is for the **vendor** — the person who sells Infoflex licences. Every step is a web page, a click in a
hosting dashboard, or a file upload. There is no point at which you are asked to open a terminal, and where a
hosting company *does* require one, this guide says so plainly instead of hiding it.

There are two builds. Pick one before you start.

| | **Cloud build** (recommended) | **PHP build** (cheapest) |
| --- | --- | --- |
| Licence API (activate / check-in / public key / offline file) | Yes | Yes |
| Vendor portal (customers, licences, renewals, suspension, audit) | Yes | Yes |
| Internet relay for Admin phones | **Yes** | **No** — the relay is not in this build |
| What it runs on | A small VPS with Docker, or a managed Node host | Ordinary shared hosting with PHP and MySQL |
| Typical cost | about US$6–12 a month | about US$2–5 a month |
| Setup time | 30–45 minutes | 20–30 minutes |
| Who can do it | You, following this guide | You, following this guide, **if** your host has a "file manager" and "MySQL databases" panel |

If you want Admin phones to reach a shop over mobile data, you need the **cloud build** and a domain name you
control. Nothing else in this product needs a domain.

---

## Part 1 — What you need before you begin

1. **A hosting account.** Any of these work; you do not need to ask anybody's advice:
   - *Cloud build:* Hetzner Cloud, DigitalOcean, Vultr, Linode, or a managed Node host such as Render or Railway.
     Pick the smallest instance offered — this server holds a few thousand licence rows, not sales.
   - *PHP build:* any cPanel-style shared host (Namecheap, Hostinger, Truehost, WhoGoHost and similar), with PHP
     8.1 or newer and one MySQL database.
2. **A domain name**, if you want HTTPS with a real certificate (you do). `licences.yourcompany.com` is a good
   choice. Register it anywhere; you will only need to add two DNS records.
3. **An authenticator app** on your phone (Google Authenticator, Microsoft Authenticator, Authy or 1Password).
   You will need it every time you sign in to the portal. This is deliberate: the portal can suspend a shop's
   till, so it is guarded like a bank account.
4. **A password manager**, or a piece of paper in a locked drawer. Two secrets are created during setup and are
   shown **once**: the signing key file and your recovery copy of it. Lose the key and you cannot issue licences
   that installed copies of Infoflex will accept — but existing shops keep working, because their licences are
   already signed and stored on their own computers.

> **Before you buy anything:** the signing key is the single most important file in this business. It is created
> in step 4 and downloaded to your computer. Keep two copies: one on the server, one on a USB stick or in your
> password manager's file storage. Never e-mail it, and never put it in a GitHub repository.

---

## Part 2 — Set up DNS (5 minutes, all clicking)

In your domain registrar's control panel:

1. Open **DNS** (sometimes called **DNS Zone** or **Manage DNS**).
2. Add a record:

   | Type | Name | Value | TTL |
   | --- | --- | --- | --- |
   | A | `licences` | the server's IP address | 300 |

3. If you will use the relay (cloud build only), add a second record for the same IP with the name `relay`, and
   see *Part 7 — the relay* for the wildcard record that goes with it.

Wait a few minutes, then check by typing `https://licences.yourcompany.com` in a browser. It will not answer yet
— that is expected. It only needs to *resolve*, which you can confirm with any "DNS lookup" web page.

---

## Part 3 — Cloud build: create the server (10 minutes)

The screenshots in this section are from Hetzner Cloud; DigitalOcean and Vultr look different but ask the same
four questions. Each step names what you are looking for rather than a pixel position, because hosting panels
are redesigned often.

### 3.1 Create the project and the server

1. Sign in to your hosting dashboard.
2. Click **New project** → name it `Infoflex Cloud` → **Create**.
3. Inside the project, click **Add server** (or **Create Droplet**, **Deploy new server**).
4. Choose:
   - **Location:** the region nearest your customers. For Nigeria, a European region (Falkenstein, Frankfurt,
     London) or a South African region if offered.
   - **Image:** **Ubuntu 24.04**.
   - **Type:** the smallest **shared** instance, typically 1 vCPU / 2 GB RAM / 20 GB disk.
   - **Networking:** leave the public IPv4 on and note the address shown.
   - **SSH keys:** if the panel asks, choose **Password** or "add my key later". You will not need SSH for this
     guide, but the panel may insist on one of the two.
   - **Name:** `infoflex-cloud`.
5. Click **Create & buy now**. Wait for the status to read **Running**, and copy the **IPv4 address**.

### 3.2 Point the domain at the server

Go back to your registrar's DNS page and make sure the `licences` record's value is that IPv4 address.

### 3.3 Install Docker — the one step that needs a developer at some hosts

Managed hosts (Render, Railway) let you deploy a container from a repository with no terminal at all. A plain VPS
gives you a Linux machine, and installing Docker on it normally means typing one command as `root`. **This is the
only step in the whole guide that is not pure clicking**, and it is a one-time step per server.

If you have nobody who can type it, use this instead, which needs no terminal:

1. In your hosting panel, open **Apps** or **One-click apps** (Hetzner has "Apps", DigitalOcean has "Marketplace").
2. Choose **Docker** (or "Docker on Ubuntu") and create the server from that image.
3. Every server created from that image already has Docker, and you can continue at step 3.4 using the panel's
   **Console** button only if a later step asks for it — this guide never does.

### 3.4 Confirm the server is ready

Open your hosting panel's **Console** or **Web terminal** (a browser window showing the server's screen — still
not a terminal on your own computer, and you are not asked to type anything here) and confirm the login prompt
appears. Close it again. That is all this guide needs from it.

---

## Part 4 — Cloud build: put the cloud on the server

The cloud is a single container. Everything below happens in your hosting panel's **file upload** and
**environment variables** screens, with two exceptions that are clearly marked.

### 4.1 Create the two secrets

There are two secrets, and **neither can be made in a browser**: a signing key is a private key file, and a session
secret is random bytes. Neither portal can generate them, because the portal only exists *after* the key does.
This is the one part of this guide that is honestly not clicking — it is two lines typed once, or forwarded to
whoever set your server up.

**If you have a terminal (or your host has a "Web SSH" / "Console" button, which most do):**

```
openssl genpkey -algorithm ed25519 -out signing-key.pem
openssl rand -base64 48
```

The first line writes `signing-key.pem` — the licence signing key, the one thing to never lose. The second prints
48 random bytes in base64; that is the session secret. Copy it somewhere safe before closing the window.

**If you have no terminal at all**, ask your hosting support to run those two lines for you. Paste them exactly as
written; they are standard OpenSSL and any support desk will recognise them. Ask them to put `signing-key.pem` in
your `/keys` volume and to send you the second line's output.

Then:

1. **Back up `signing-key.pem` now** — to your password manager's file storage *and* to a USB stick. Without it
   you cannot issue or renew a single licence, and there is no recovery: the key is not stored anywhere else, by
   design (DONE WHEN 10). Do not rename the file; the deployment looks for that name.
2. Keep the session secret in the same password manager, labelled "Infoflex Cloud session secret". If you lose it
   you only log everybody out; a new one is generated the same way.

Both values go into the environment in 4.3, never into a file you upload.

### 4.2 Upload the deployment folder

1. In the hosting panel, open **Volumes** or **Storage** and create a small volume (`infoflex-keys`, 1 GB), then
   attach it to the server at `/keys`.
2. Upload `signing-key.pem` into that volume with the panel's upload button.
3. Upload the deployment files. If your panel has **Stacks**, **Compose** or **App from repository**, point it at
   the repository and the file `cloud/docker-compose.yml`. If it only has a file manager, upload the `cloud`
   folder and the `src`, `package.json`, `package-lock.json` and `tsconfig.json` files next to it, keeping the
   folder structure — the compose file refers to them by relative path.

### 4.3 Fill in the environment variables

Open **Environment** (or **Variables**, or **Stack → Environment**) and paste each line from
`cloud/.env.example`. The ones that must have a value:

| Variable | What to type |
| --- | --- |
| `INFOFLEX_CLOUD_PUBLIC_URL` | `https://licences.yourcompany.com` |
| `INFOFLEX_CLOUD_SIGNING_KEY_FILE` | `/keys/signing-key.pem` |
| `INFOFLEX_CLOUD_SESSION_SECRET` | the long string you generated in 4.1 |
| `INFOFLEX_CLOUD_OWNER_EMAIL` | your own e-mail address |
| `INFOFLEX_CLOUD_DATABASE` | `/data/infoflex-cloud.sqlite` |
| `INFOFLEX_CLOUD_BACKUP_DIR` | `/data/backups` |
| `INFOFLEX_CLOUD_TRUST_PROXY` | `true` (Caddy is in front of the cloud) |
| `INFOFLEX_PUBLIC_HOST` | `licences.yourcompany.com` |

Leave `INFOFLEX_CLOUD_SMTP_*` blank for now; reminders will appear on the dashboard instead, and can be switched
on later (Part 6).

### 4.4 Start it

Click **Deploy** (or **Start stack**, **Redeploy**). The panel shows a log. Wait for a line reading
`Infoflex Cloud listening on 8080`, then open `https://licences.yourcompany.com/health` in a browser. You should
see `{"status":"ok","version":1}`.

If you see a certificate warning, DNS has not finished propagating; wait ten minutes and reload. If you see
nothing at all, the cloud container is not running — open the panel's log for it and look for a line beginning
`INFOFLEX_CLOUD_` telling you which setting is missing.

---

## Part 5 — First sign-in and the first licence (10 minutes)

### 5.1 Create the Owner account

1. Open `https://licences.yourcompany.com/portal/login` in a browser.
2. Because there is no account yet, the page sends you to **Create the first Owner**.
3. Type your name, the e-mail address you put in `INFOFLEX_CLOUD_OWNER_EMAIL`, and a password of at least 12
   characters with a mix of letters, numbers and a symbol (or a passphrase of 20+ characters).
4. Click **Create Owner and continue to 2FA**.
5. The next page shows a QR code. Open your authenticator app, tap **+** → **Scan a QR code**, and point it at the
   screen. If the camera will not cooperate, the page also shows the key in four-character groups — type that
   into the app's **Enter a setup key** option.
6. Type the six digits the app is showing into **Six-digit code** and click **Activate two-factor**.
7. You are returned to the sign-in page. Sign in with your e-mail, your password and a fresh code. Bookmark
   `/portal` — that is your working screen from now on.

### 5.2 Create a customer and a licence

1. On the dashboard, click **New licence**.
2. Fill in:
   - **Business name** — the shop's name, e.g. `Bright Chemist`.
   - **Contact name**, **Phone**, **E-mail** — optional, but an e-mail is what renewal reminders use.
   - **Edition** — Pharmacy, Supermarket, or Both.
   - **Starts / Ends** — today and one year from today are prefilled. Use the date picker, or the 1-, 2-, 3- and
     5-year quick buttons next to the end date.
   - **DEFAULT CURRENCY** — the currency the till should preselect at setup. Pick `NGN` for a Nigerian shop.
   - **Lock currency** — tick this when the shop must not be able to change it. A locked currency without a code
     is refused, because locking "nothing" is meaningless.
   - **Admin phones allowed**, **Grace period** — how many Admin phones the licence may pair, and how many days
     the till keeps working after a suspension begins.
   - **Mobile access** — "on the shop's own network" is on by default; "over the internet" is **off** and stays
     off unless you tick it.
3. Click **Create licence**. You land on the licence page, which shows the activation key (`IFX-…`).

### 5.3 Hand the key to the shop

Read the key to the shop over the phone, or press **Generate activation code** and read the eight-character code
instead. On the shop's PC, open Infoflex → **Activate** → type the key. The till activates, and the setup screen
already has `NGN` selected because that is what you set.

The dashboard now shows the licence as **online now** within a minute. If it does not, the shop has no internet
access on that PC — an offline `.lic` file can be downloaded from the licence page for a machine whose ID the
shop reads from the app.

---

## Part 6 — E-mail reminders (optional, 5 minutes)

Without e-mail the dashboard shows what is expiring in 7, 14 and 30 days, which is enough if you look at it. With
e-mail, the customer and you both get a message at each of those three points.

1. Get SMTP details from your e-mail provider (Gmail, Zoho, or your host's mail service). They look like
   `smtp.zoho.com`, port `587`, a user name and a password or "app password".
2. In the hosting panel's **Environment** screen, fill in `INFOFLEX_CLOUD_SMTP_HOST`, `_PORT`, `_USER`,
   `_PASSWORD`, `INFOFLEX_CLOUD_MAIL_FROM` and `INFOFLEX_CLOUD_VENDOR_EMAIL` (your own inbox).
3. Click **Redeploy**. The dashboard's "E-mail reminders are not configured" note disappears.

Each reminder is sent once per licence per term, so a restart cannot spam a customer, and a renewal starts the
next term's reminders fresh.

---

## Part 7 — The relay for Admin phones (cloud build only)

The relay is what lets an Admin open the shop's admin screens on a phone over mobile data, with no port
forwarding and no VPN. This part is **the one that needs a developer**, and this guide says so plainly.

### What the relay does

- The shop's PC opens one outbound connection to your server. Nothing is opened on the shop's router.
- The phone goes to `https://<shop-id>.relay.yourcompany.com`, which reaches the shop's PC through that
  connection.
- The relay only runs while the licence is active, **internet access is ticked for that licence**, and the PC's
  own "Mobile access over the internet" switch is on. It also refuses a phone that does not present a link minted
  by that shop's own till.
- The shop PC still enforces everything it always did: Admin only, device approval, TOTP. A cashier cannot use
  the relay because there is no cashier route to reach.

### What a developer must do (and why)

1. **A wildcard DNS record.** Every shop gets its own subdomain, so the record is `*.relay` with the same IP.
2. **A wildcard TLS certificate via a DNS challenge.** Caddy can do this automatically, but only with a DNS
   provider plugin compiled in — that is a different container image from the stock one. Give your developer this
   sentence: *"build Caddy with the DNS provider plugin for my registrar and use `tls { dns <provider> {env.DNS_API_TOKEN} }`
   in the Caddyfile"*.
3. **The API token** for that DNS provider, set as `DNS_API_TOKEN` in the Caddy service's environment.
4. **Set `INFOFLEX_CLOUD_RELAY_DOMAIN`** to `relay.yourcompany.com` and generate `INFOFLEX_CLOUD_RELAY_SECRET`
   (`openssl rand -hex 32`). Both go in the environment screen.

Without those four things the relay is simply absent: the portal's **Relay** page says "not configured", and
mobile access over the internet does nothing. Everything else works.

### What the relay can and cannot see

The relay terminates TLS, so it is a trusted pass-through: it copies bytes between the phone and the shop's PC
and stores no copy of a page, a report or a receipt. It can, in principle, read traffic in flight exactly as any
HTTPS server could. There is **no end-to-end encryption between the phone and the shop PC** in this build. The
shop's own admin login, device approval and TOTP still have to be satisfied to see anything, and every byte is
TLS-protected on both hops. The full statement is in [RELAY-LIMITS.md](RELAY-LIMITS.md), and the portal's relay
page repeats it.

---

## Part 8 — The PHP build (shared hosting, no relay)

Follow this if you chose the cheaper build. All of it is file manager and control-panel clicking.

1. **Create the database.** In your host's control panel open **MySQL Databases** → create a database and a user,
   and give the user all privileges on it. Write down the four values: host (usually `localhost`), database name,
   user, password.
2. **Upload the files.** Open **File Manager** → `public_html` (or the domain's folder) and upload the contents of
   `cloud/php/public/` *into* `public_html`, then create a folder `lib` beside them and upload everything from
   `cloud/php/lib/`. Also upload `cloud/php/config.example.php` to the folder *above* `public_html` (usually
   `/home/youruser/`), rename it `config.php`, and edit it with the panel's code editor:
   - `dsn`, `db_user`, `db_password` — the values from step 1; the DSN looks like
     `mysql:host=localhost;dbname=yourdb;charset=utf8mb4`.
   - `public_url` — `https://licences.yourcompany.com`.
   - `bootstrap_owner_email` — your own address.
   - `secure_cookies` — `true`.
   - `signing_key_path` — see step 3.
3. **Create the signing key.** The PHP build needs the same Ed25519 key as the cloud build. You cannot generate
   one in a browser; ask your host's support to run
   `openssl genpkey -algorithm ed25519 -out /home/youruser/licence-key.pem` for you, or generate it once on any
   computer that has OpenSSL and upload the file. Put the path in `signing_key_path`. Keep a backup copy.
4. **Set the PHP version** in the control panel to **8.1 or newer**, and confirm the **openssl** extension is
   enabled (it is by default almost everywhere).
5. **Turn on HTTPS.** In the control panel, find **SSL/TLS** → **Let's Encrypt** (AutoSSL, or a one-click
   certificate) and enable it for the domain. Then check **Force HTTPS redirect**.
6. **Visit the site.** Open `https://licences.yourcompany.com/` — you are sent to **Create the first Owner**.
   From here the screens are the same as the cloud build's, minus the relay page.
7. **Test it from a browser.** Open `/api.php?action=config`. You should see a JSON object with `publicKey`.

The PHP build's tests can be run by your host: upload `cloud/php/tests/run.php` next to `lib`, open
`https://licences.yourcompany.com/tests/run.php`, and you should see `32 passed, 0 failed`. **Delete the tests
folder afterwards.**

What the PHP build does **not** have: the relay, the automatic `.lic` CSV-style backup job (your host's control
panel has its own database backup — turn it on), and the grace-period reminders scheduler (run the portal and the
dashboard instead; the reminder list is identical).

---

## Part 9 — Backups and restoring (5 minutes)

The cloud build takes its own snapshot once a day into `INFOFLEX_CLOUD_BACKUP_DIR` and keeps the newest 14. To
restore:

1. Open `https://licences.yourcompany.com/health` and confirm the cloud is running.
2. In the hosting panel's **Storage** or **File manager**, open `/data/backups`. Each file is named
   `infoflex-cloud-YYYYMMDDThhmmssZ.sqlite`.
3. To restore, stop the cloud (the panel's **Stop** button), rename the live `/data/infoflex-cloud.sqlite` to
   `infoflex-cloud-before-restore.sqlite`, copy the snapshot you want over the live name, and start the cloud
   again.

The PHP build relies on your host's database backup; enable it in the control panel and keep seven daily copies.

---

## Part 10 — What still needs a developer

Everything else in this guide is clicking. These three things are not, and each is a one-off:

| Task | Why it cannot be clicked | What to ask for |
| --- | --- | --- |
| Generating the Ed25519 signing key | A browser cannot write a private key file to your server | `openssl genpkey -algorithm ed25519 -out signing-key.pem`, then upload it |
| Installing Docker on a bare VPS | The image is a Linux package | Use a host's Docker one-click image, or one pasted command |
| The relay's wildcard certificate | It needs a Caddy build with your DNS provider's plugin | The four points in Part 7 |

If you cannot get any of these done, the cloud build still works without the relay, and the PHP build needs only
the key.

---

## Part 11 — Monthly cost

Prices are the smallest useful configuration as published in November 2026, and exclude VAT and the domain.

| Item | Cloud build | PHP build |
| --- | --- | --- |
| Server / hosting | US$4–6 (1 vCPU, 2 GB) | US$2–4 (shared) |
| Volume for database and keys | US$0.50 (1 GB) | included |
| Domain name | US$1 (≈US$12 a year) | US$1 |
| TLS certificate | free (Let's Encrypt via Caddy) | free (AutoSSL) |
| E-mail reminders | free with an existing mailbox; US$0–3 with a mail service | same |
| Backups | included (14 local snapshots) | included in host's backup, if enabled |
| **Total** | **≈ US$6–12 a month** | **≈ US$3–5 a month** |

Scaling notes: this server holds licence rows, not sales. A hundred shops checking in every 24 hours is about
four requests an hour, and a thousand shop activations is under a megabyte of database. Do not buy a bigger
server until you pass several thousand licences; if you ever need to, the numbers are in
[COSTS.md](COSTS.md).

---

## Part 12 — If something looks wrong

| What you see | What it means | What to do |
| --- | --- | --- |
| `INFOFLEX_CLOUD_SIGNING_KEY is not set` in the log | The environment variable is missing or points at nothing | Re-check Part 4.3, especially `_FILE` vs the value |
| `INFOFLEX_CLOUD_PUBLIC_URL must be an https:// address` | Production refuses plain HTTP | Use `https://`, and put Caddy in front |
| The portal sends you to **Create the first Owner** even though you have an account | The database volume is not mounted, so it started empty | Check the volume in Part 4.2 is at `/data` |
| `That email or password is not correct.` with a correct password | The authenticator code was wrong or reused; eight failures lock the account for 15 minutes | Wait, then try a fresh code |
| A shop says the app says "licence expired" | The term really has ended | Find the licence, **Renew or extend**, and the till picks it up within a minute |
| A shop's licence shows **suspended** and they did not ask | Somebody suspended it, or the payment lapsed | **Unsuspend**, and check the audit log for who |
| The relay page says **not configured** | `INFOFLEX_CLOUD_RELAY_DOMAIN` is empty | Part 7 — and that part needs a developer |
| The till will not accept a new activation key | The key is for a different machine and the licence is still bound | Open the licence, **Reset machine binding**, then activate again |
