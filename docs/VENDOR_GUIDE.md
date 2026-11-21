# Infoflex Vendor Guide

For the person who sells, builds and supports Infoflex. Everything here is done through a window — Build Studio, the
Vendor Cloud portal, or a browser. Nothing requires a command prompt except the one-time deployment of the cloud,
which has a step-by-step page and is spelled out in §4.

> **The one rule.** You have a master password and a signing private key. The password unlocks on-site activation on a
> customer's own computer; the key lets your portal issue licences that any Infoflex will accept. Both are liabilities
> the moment they leak. **Never** put either on a build machine you do not control, in a chat message, in an email, in
> a ticket, or in a document you hand to a customer. §9 is about this, and it is the most important section in the file.

## Contents

1. [Build Studio](#1-build-studio)
2. [Per-country installers, default and locked currency](#2-per-country-installers-default-and-locked-currency)
3. [Signing](#3-signing)
4. [Deploying the Vendor Cloud](#4-deploying-the-vendor-cloud)
5. [Customers and licences](#5-customers-and-licences)
6. [Activation: online, licence file, on-site](#6-activation-online-licence-file-on-site)
7. [Renewal and reactivation from the portal](#7-renewal-and-reactivation-from-the-portal)
8. [Suspension, rebinding, and handing over an installer](#8-suspension-rebinding-and-handing-over-an-installer)
9. [Guarding the master password](#9-guarding-the-master-password)
10. [Silent install with `/CURRENCY`](#10-silent-install-with-currency)

---

## 1. Build Studio

Build Studio is the graphical tool that produces an installer. It runs on your Windows machine. `npm run dist:studio`
packages it; the built app is `Infoflex Build Studio.exe`.

**What it does.** It writes the installer's configuration — the app version, the default currency and whether to lock
it, the on-site period cap, the store name — into `installer/nsis/build-profile.json`, then calls electron-builder to
compile the `.exe`. The generated NSIS header comes from that profile, so what the installer describes and what the app
later reads are the same file, not two places that can drift.

**The first screen** asks for the app version (this appears in Programs and Features and in the installer's file
properties) and the edition you are building.

**Then the currency panel.** Pick a default currency from the catalogue. Tick **Lock currency** if the customer must
not change it. See §2 for when to lock and when not to.

**Then the on-site cap.** The maximum number of years an on-site licence may run for. This is a real safeguard, not a
formality: an on-site licence is generated offline from the master password, so a five-year on-site licence is five
years in which a leaked password is worth something. One to three years is the usual range. Everything is explained
in §9.

**Then Build.** Two builds are available:

| Build | Produces | Use when |
| --- | --- | --- |
| Online | `Infoflex Setup.exe` | The customer has Internet while installing, or you want the smaller file |
| Offline | `Infoflex Setup Offline.exe` | The customer has no Internet, or a slow/unreliable link |

The offline build bundles every prerequisite and skips the download page entirely. Both carry the same password gate
and the same Region and Currency page.

**Build Studio shows you the build log.** If a build fails, the reason is there in plain words, and the log can be
copied with one button. A certificate error during the build means the machine cannot reach the Electron download
host; that is a network problem, not a code problem.

---

## 2. Per-country installers, default and locked currency

A per-country installer is an ordinary build with the country and currency pre-chosen, so the customer sees their own
currency already selected.

**Build one per country** when you ship to several countries and want each customer to receive a file that is already
correct. Name them clearly: `Infoflex Setup - Ghana.exe`, `Infoflex Setup - Nigeria.exe`.

**Lock the currency** when the customer has already been configured, or when you know the country is fixed and a wrong
choice would be expensive to unwind. A locked currency shows on the installer's Region and Currency page as
read-only, with an explanation, and the customer cannot change it there or in first-run setup.

**Do not lock it** when the customer is new and might legitimately be near a border or trade in a second currency.
Locking is for preventing a mistake, not for making a decision the customer should make.

**The "I chose wrong" conversation.** If a customer changed the currency and then made a sale, the currency is now
locked by the software itself (see the Customer Guide). There is no conversion path: the database has no record of
which currency each amount was in. The only remedy is a reinstall with a fresh database, and the old sales cannot be
brought across. Say this plainly and early, and export their reports before you wipe anything.

---

## 3. Signing

Every licence the portal issues is signed with an Ed25519 key. The desktop app carries the matching **public** keys
only, in `trustedEd25519Keys` in the policy file — a list, so you can rotate a key without invalidating licences
already issued.

**Generate the key pair once**, on a machine that is not the build machine. The private half goes into the cloud's
`INFOFLEX_CLOUD_SIGNING_KEY` environment variable and nowhere else. The public half goes into the policy file, which
is compiled into the app.

**Rotate a key** by adding the new public key to `trustedEd25519Keys` and shipping a build, keeping the old one in the
list, then retiring the old key once customers have updated. Removing a key while licences signed by it are still in
the field locks those customers out.

**Never sign a licence by hand.** Everything goes through the portal, which records who issued what and when.

---

## 4. Deploying the Vendor Cloud

The Vendor Cloud is the portal, the relay, and the licence issuer. `/cloud-package/infoflex-vendor-cloud.zip` contains
everything: the Node and PHP builds, `docker-compose.yml`, the `Caddyfile`, and `docs/DEPLOYMENT.md`.

The deployment page walks through it click by click. The shape of it:

1. **A server** with a public address and a domain name you control. Any host that offers Docker will do: 2 GB of RAM
   is plenty for a few hundred pharmacies.
2. **DNS.** Point your domain at the server, and a wildcard record at the relay subdomain. The relay serves each
   shop's address from a subdomain, which is why the wildcard matters.
3. **Secrets.** Four values, set as environment variables, never in the compose file:
   `INFOFLEX_CLOUD_SIGNING_KEY`, `INFOFLEX_CLOUD_SESSION_SECRET`, `INFOFLEX_CLOUD_DATABASE_KEY`, and the relay secret.
   The service refuses to start without them and says which one is missing, rather than starting in a broken state.
4. **Start it.** `docker compose up -d`. The Caddy container obtains and renews the certificates by itself.
5. **Check it.** The portal's health page reports the database, the relay and the signer separately.

**What the cloud stores, and what it does not.** It stores customers, licences, issued licence records and an audit
trail of who did what. It does **not** store pharmacy data — no stock, no sales, no patient records. The relay
forwards connections and keeps no copy of what passes through. That is a deliberate boundary, and it is the answer
when a customer asks.

Full detail, including backups of the portal's own database and how to upgrade, is in `cloud/docs/DEPLOYMENT.md`
inside the zip.

---

## 5. Customers and licences

**Adding a customer.** Portal → Customers → **Add**. Store name, country, contact, and the currency you are building
for. The store name here should match what the customer will type in first-run setup; the portal shows both so you
can spot a mismatch.

**Issuing a licence.** Portal → Licences → **Issue**. Choose the customer, the edition, the term, and whether it is
online or on-site.

- **Online licences** are checked against the portal. Renewal is a click, and the customer's app unlocks on its next
  check.
- **On-site licences** are generated offline from the master password, for customers with no Internet. They are
  capped at the maximum period in the build profile — see §9 for why.

Every issue, renewal, suspension and rebind is written to the portal's audit log with who did it and when.

**The default and locked currency carry through.** A licence records the currency the customer is configured for. If
you issue an on-site licence with a different currency from what is installed, the app refuses it — which is the
behaviour you want, because it stops a licence for the wrong market being applied to a shop.

---

## 6. Activation: online, licence file, on-site

Three routes, one for each kind of connectivity. Tell the customer which one to expect before they install; it saves a
support call.

**Online activation.** The customer connects to the Internet once, enters their licence key, and the app validates it
against the portal. The app then works offline until the licence needs checking again.

**Licence-file activation.** You issue the licence, the portal produces a `.licence` file, you send it, and the
customer clicks **Activate from a file**. This is for a customer who has email but will not connect the pharmacy
computer to the network. The file is signed, so it cannot be forged or edited.

**On-site activation.** For a customer with no Internet at all. You generate the on-site code in the portal from the
customer's installation ID, the customer types it in along with the master password, and the app verifies the code
against the salted hash it carries. The master password never leaves the vendor's side; the app holds only a hash and
checks what the customer types against it.

---

## 7. Renewal and reactivation from the portal

**Renewal** is the common case. Portal → Licences → find the customer → **Renew**, choose the new term, confirm. The
customer's app unlocks on its next licence check. Nothing is sent, nothing is installed, and no data is touched.

**Reactivation** is the same action applied to an expired licence. The distinction matters only in conversation: a
customer whose licence lapsed yesterday says "reactivate", one whose licence runs out next month says "renew".

**From a phone.** The portal is a web page and works on a phone browser. Everything above — issuing, renewing,
suspending — can be done from the pharmacy's doorstep or from your car, and that is the point of the phone-sized
layout.

**After a reactivation** the app unlocks fully: selling, stock, mobile access and reports all return at once. Nothing
is lost during a lapse — an expired licence blocks changes, not reading — so the customer resumes exactly where they
stopped.

---

## 8. Suspension, rebinding, and handing over an installer

**Suspension** is for a customer who has not paid, or whose licence you need to stop. Portal → Licences →
**Suspend**. The app stops allowing changes at its next check, and the mobile app refuses new logins. Data is
untouched, so reinstating is one click and the customer loses nothing.

**Rebinding** is for a licence that is being moved to a new computer — the old one died, or the shop is relocating.
Portal → Licences → **Rebind** releases the licence from the old machine and lets it activate on the new one. The
licence record shows the old machine so you can tell a genuine replacement from a request to run the same licence in
two shops.

**Handing over an installer.** Send the `.exe` and the Customer Guide. Tell the customer, in the message:

1. the installation password — this is the *installer* password, not the master password, and the two are never the
   same thing;
2. whether it is the online or offline build;
3. their licence key, or the licence file;
4. which currency the build is set to, and whether it is locked.

**Check the file before you send it.** `npm run release:scan` searches for the master password and for private-key
material, and prints what it searched. A clean result on a build you are about to hand to a customer is not optional.

---

## 9. Guarding the master password

This section exists because the design has one real limit, and you should know it exactly.

**How a licence is protected.** An online licence is checked against the portal, so revoking it is immediate. An
on-site licence cannot be — there is no Internet — so it is verified on the customer's own machine. That verification
needs something the customer's machine can check without being able to mint new licences. The design uses the master
password: the customer types it, the app checks it against a salted PBKDF2 hash it carries, and the licence opens.

**What that means.** The master password is not in the app — only a salted hash is, and the scans in
`npm run release:scan` prove that. But the password is, by design, known to the people who issue on-site licences, and
an on-site licence can be generated for any period up to the build profile's cap. **The cap is your real control.** A
cap of two years means a leaked password is worth at most two years of unlicensed use, in shops that already have your
software. A cap of ten years means ten.

**What to do.**

- Keep the password in a password manager, not in a text file, a spreadsheet or a note on your desktop.
- Do not type it into a customer's computer. On-site activation is done by the *customer*, using the password you gave
  them at installation; you do not need to be at the machine, and you should not be.
- Keep the on-site cap as low as your customers can tolerate. Raising it for one customer raises it for all, because
  the cap is a build setting.
- Rotate the password if you ever suspect it leaked. Rotation means building and shipping an installer that carries
  the new hash; customers on the old build keep working, but on-site activation on an old build uses the old
  password until they update.
- Remember that the password is also what the installer asks for. Changing it changes both, so a rotation needs a
  note to customers about which password is which.

**What the app does to make brute force expensive.** Repeated wrong entries are progressively delayed and then locked,
and every attempt is logged. That raises the cost of guessing; it does not make a short password safe. Choose a long
one.

---

## 10. Silent install with `/CURRENCY`

For deploying to many machines at once, the installer accepts a currency so nobody has to click through the Region and
Currency page.

```
"Infoflex Setup.exe" /S /CURRENCY=GHS
```

`/S` is the silent switch — install with no window. `/CURRENCY=` sets the currency, using the three-letter ISO code.

**Any of the 54 currencies in the app's catalogue is accepted**, because the check is generated from that same
catalogue. An unknown code, or `/CURRENCY=` with nothing after it, **aborts the install** with a message naming the
code — it does not quietly fall back to the default. That is deliberate: a shop silently installed in the wrong money
is far worse than an install that stops and tells you why. The exit code is 2.

The remaining pages of the wizard — password, checks, components — are handled by the silent switch: the password
comes from the build's configuration rather than being typed, and the checks and components take their defaults.

**The currency still locks after the first sale**, exactly as it does in an attended install. A silent install is not
a way to change the currency later.

**What a silent install cannot do:** it cannot activate. Activation needs a licence key or file, and the customer
chooses which route. Plan on one attended step per machine for activation, or use a licence file that the customer
opens after the install completes.

---

*Everything in this guide was written against the code as it stands. Where a claim depends on your configuration --
the on-site cap, whether a currency is locked, which activation route a customer uses -- the guide says so rather than
assuming.*
