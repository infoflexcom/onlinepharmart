# Infoflex Pharmacy Manager — Customer Guide

For the pharmacy that buys, installs and uses Infoflex. Nothing here needs a command prompt, a terminal or a
PowerShell window: every step is a window you click through.

**Keep this page.** The two things that go wrong most often on the first day are a phone that cannot reach the
computer, and a mistaken currency choice. Both are answered below, and the second one is worth reading *before* you
install.

---

## Contents

1. [Before you start](#1-before-you-start)
2. [Installing](#2-installing)
3. [Choosing your currency](#3-choosing-your-currency)
4. [Activating](#4-activating)
5. [First-run setup](#5-first-run-setup)
6. [Daily use for the Admin](#6-daily-use-for-the-admin)
7. [Daily use for cashiers](#7-daily-use-for-cashiers)
8. [Wholesale sales](#8-wholesale-sales)
9. [Why the currency locks](#9-why-the-currency-locks)
10. [Backups](#10-backups)
11. [Turning on Mobile Access](#11-turning-on-mobile-access)
12. [Pairing an Android phone](#12-pairing-an-android-phone)
13. [Pairing an iPhone or iPad](#13-pairing-an-iphone-or-ipad)
14. [Using the phone over the Internet](#14-using-the-phone-over-the-internet)
15. [When the licence expires](#15-when-the-licence-expires)
16. [Where to get help](#16-where-to-get-help)

---

## 1. Before you start

**The computer.** Windows 10 or Windows 11, 64-bit. A desktop with a wired keyboard is best for the counter. The
pharmacy computer is the *server*: the database lives on it, and every other device reads and writes through it. If
it is switched off, the phones cannot connect.

**Internet.** Not required. Infoflex works completely offline — selling, stock, receipts, reports and backups all
work with the cable unplugged. You need the Internet only to activate online, and only if you choose to reach the
pharmacy's phones from outside the building.

**Printer.** Any Windows printer. A 58 mm or 80 mm thermal receipt printer is what most pharmacies use.

**Time.** About fifteen minutes, plus however long it takes to type in your stock.

**One thing to decide now: your currency.** See the next section. Choosing wrongly is the one mistake this software
cannot fix for you later.

---

## 2. Installing

You will have been given a file ending in `.exe`, with a name like `Infoflex Setup.exe`.

1. **Double-click it.** Windows will ask whether to allow the app to make changes. Click **Yes**. That is the normal
   prompt for any installer; it is asking because Infoflex installs for everyone who uses the computer.

2. **Enter the installation password** the vendor gave you. It is not your pharmacy password and it is not your
   username. It stops the wrong copy of the software being installed. It is entered once, here, and you will not need
   it again. If you mistype it three times the window tells you so and you can try again.

3. **Region and Currency.** See the next section — this is the important one.

4. **Checks.** The installer looks at the computer and lists what it found: whether the Windows components Infoflex
   needs are present, how much disk space there is, and whether there is a printer. Anything missing is shown with a
   **Fix** or **Install** button next to it. Click through them; the installer does the work, you do not open anything
   else.

5. **Components.** Choose what to install. Unless the vendor told you otherwise, leave every tick in place.

6. **Install.** Click it. If you were given the smaller "online" installer, you will see a download step first; if you
   were given `Infoflex Setup Offline.exe`, everything it needs is already inside the file and that step is skipped.

7. **Finish.** Tick **Launch Infoflex** and click **Finish**.

The first time it starts it offers to start with Windows. Say yes on the pharmacy computer: it should be running
whenever the shop is open, because that is what the phones and the receipt printer connect to.

---

## 3. Choosing your currency

The installer shows a **Region and Currency** page. Pick your country, then check the currency it filled in.

The list contains the currencies Infoflex knows in full detail — 54 of them, plus a **Custom** option where you can
type a code and symbol yourself. It covers most of Africa, the Middle East, Europe, the Americas and Asia. For each
one the software knows whether it is written with 2 decimals (most currencies), 0 decimals (UGX, RWF, XOF, XAF, JPY,
KRW) or 3 decimals (KWD, BHD, OMR, JOD, TND).

**Choose carefully.** Once you have made your first sale, the currency is locked. See
[Why the currency locks](#9-why-the-currency-locks).

If the vendor built your installer for one country, this page may already be filled in and possibly locked so it
cannot be changed. That is deliberate: it prevents the wrong currency being installed on a pharmacy that has already
been configured.

---

## 4. Activating

Infoflex will not run a shop until it knows its licence is valid. Two ways, and the vendor will tell you which applies
to you.

### Activating online

You need the Internet for this, once.

1. Start Infoflex. The **Activation** window appears.
2. Choose **Activate online**.
3. Type the **licence key** the vendor sent you. It is a long string of letters and numbers; copy and paste it rather
   than typing it.
4. Click **Activate**. The window says how long the licence runs for.

### Activating with a licence file

If the vendor gave you a file ending in `.licence`, or you have no Internet:

1. Start Infoflex, choose **Activate from a file**.
2. Click **Browse**, find the file, click **Open**.
3. Click **Activate**.

### Activating on-site (no Internet at all)

The vendor can send your computer its own licence using the password you were given at installation:

1. Choose **On-site activation**.
2. Type the on-site code the vendor read out or sent you.
3. Type the installation password again.
4. Click **Activate**.

This works with the network cable unplugged. It is how pharmacies with no Internet at all are activated.

Whichever route you used, the licence shows in **Settings → Licence**: the edition, the expiry date, and the store it
is licensed to.

---

## 5. First-run setup

Before you can sell anything, Infoflex asks three things:

**Your store name.** This is what prints at the top of every receipt. Type it exactly as you want customers to read
it — "Harbor Health Pharmacy", not "harbor". You can change it later in Settings, but every receipt printed before
the change keeps the old name.

**Your Admin account.** A username and a password for the person who runs the pharmacy. This account can do
everything: add staff, change prices, see every report, and pair phones.

> Choose a password you will remember and that others will not guess. There is a limit on how many wrong attempts are
> allowed before the account locks for a while, which protects you but also means a forgotten password costs you time.

**Your currency.** It is filled in from the installer. If the installer locked it, you cannot change it here, and the
page says so.

Click **Finish setup**. You are now looking at the Infoflex dashboard, and you can make your first sale.

---

## 6. Daily use for the Admin

**Adding stock.** Go to **Stock → Add item**. Type the name, the pack size, the cost price and the selling price.
Barcode scanners type into the barcode box automatically — point the scanner at the box and pull the trigger.

**Adding staff.** Go to **Staff → Add user**. Choose **Cashier** or **Supervisor**. A cashier can sell and take
payment; a supervisor can also do stock adjustments. Neither can see the reports the Admin sees, and neither can pair
a phone.

**Prices.** Manage → Price list. Every change is recorded with your name and the time, so a disputed price can always
be traced.

**Reports.** Reports → Sales for the day, week or month; Stock for what is running low; Staff for who sold what. Only
the Admin sees the shop-wide versions. A cashier who opens reports sees only their own sales.

**Mobile Access.** Off by default. See [Turning on Mobile Access](#11-turning-on-mobile-access) when you want it.

---

## 7. Daily use for cashiers

A cashier logs in at the same screen as everyone else, with the username and password the Admin created.

**Making a sale.** Scan or search for the item, set the quantity, click **Add**. Repeat. The running total is on the
right. Click **Take payment**, choose cash, card or transfer, enter what the customer handed over, and the change is
worked out for you. The receipt prints, and it shows your store name at the top and every amount in your currency.

**Discounts.** A cashier can give the discounts the Admin has allowed in Settings. A discount larger than that needs
a supervisor.

**Returns.** Find the original sale by receipt number, open it, and click **Return**. The sale itself is never
deleted: the return is recorded against it, so the audit trail stays intact.

**What a cashier cannot do.** Delete a completed sale, change prices, add staff, see other cashiers' figures, or use
the mobile app. If they try, Infoflex refuses and records the attempt.

---

## 8. Wholesale sales

A wholesale sale is a sale at wholesale prices, usually to another shop or clinic buying in quantity.

A cashier can make one. At the top of the sale screen there is a switch between **Retail** and **Wholesale**. Set it
to Wholesale and the prices change to the wholesale prices the Admin has set for each item. If an item has no
wholesale price set, Infoflex uses the retail price and says so on the line, so nobody is surprised at the total.

Wholesale sales appear in the reports separately from retail, so you can see what the shop sells over the counter and
what it sells in bulk.

---

## 9. Why the currency locks

Your currency is written into every amount the software stores. A price of "5,000" means five thousand of *your*
currency, and the software does not store which currency alongside each individual number — that would be wasteful
and slow.

Because of that, after the **first completed sale** the currency can no longer be changed. Everything already
recorded means what it meant when it was recorded, and changing the currency afterwards would silently turn every
past sale into a different amount of money.

### What still changes after the lock

The lock applies to the *currency*, not to how amounts are written. You can still change, in Settings → Currency:

- **where the symbol goes** — `₦5,000.00` or `5.000,00 ₦`
- **the thousands separator** — comma or space or full stop
- **the decimal separator** — full stop or comma
- **whether the symbol or the ISO code is shown** — `₦5,000.00` or `NGN 5,000.00`

That last one matters for thermal printers: see [Troubleshooting](TROUBLESHOOTING.md) if your printer renders the
symbol as a blank box.

### If you chose the wrong currency

**Before your first sale:** open Settings → Currency and change it. Nothing is affected.

**After your first sale:** the vendor has to reinstall Infoflex with a fresh database. Sales already recorded cannot
be converted — the software has no record of which amounts were in which currency, so there is nothing to convert
from. Export what reports you can before the reinstall, because the old data will be gone.

This is why the installer asks, and why it is worth a moment's thought before you type in your stock.

---

## 10. Backups

**Automatic.** Infoflex backs itself up every day to a folder on the same computer, keeping the last thirty. This
protects you against a mistake in the software. It does **not** protect you against the computer being stolen, its
disk failing, or a fire.

**Manual, and off the computer.** Once a week, go to **Settings → Backup → Back up now**, and choose a USB stick or a
folder that syncs to cloud storage. Take the stick home, or let the cloud folder upload it.

**Test a restore once.** An untested backup is a hope. Once, in a quiet hour, restore yesterday's backup on a spare
computer and check the sales are there. Then you know your backups work.

---

## 11. Turning on Mobile Access

Mobile Access lets an Admin use Infoflex on a phone — checking stock, adding a product, seeing today's takings —
without walking back to the counter.

**Only Admin accounts can use the mobile app.** Cashier and Supervisor accounts are refused, at the phone and again
at the computer. This is deliberate: a phone can be lost, and a lost phone should not be able to ring up sales in
someone else's shop.

1. On the computer, log in as the Admin.
2. Go to **Settings → Mobile Access**.
3. Click **Turn on Mobile Access**.
4. A panel appears with a **QR code** and a **pairing code** — six digits, valid for a few minutes.

Leave this panel open while you pair.

---

## 12. Pairing an Android phone

The phone and the computer must be on the **same Wi-Fi network**. Not the guest network — the same one.

1. On the phone, open **Chrome**.
2. Type the address shown on the computer's panel, or scan the QR code with the phone's camera and tap the link.
3. The phone shows a certificate warning. This is expected: Infoflex uses its own certificate because it is running
   on your computer, not on the public Internet. Tap **Advanced**, then **Proceed**.
4. The phone asks for the **pairing code**. Type the six digits from the computer.
5. The phone asks you to log in as the Admin — the same username and password as on the computer.
6. The phone now shows the Infoflex dashboard.

**Add it to your home screen** so it opens like an app:

- **Android / Chrome:** tap the three-dot menu, then **Add to Home screen**, then **Add**.
- **iPhone / Safari:** tap the **Share** button (the square with an arrow), scroll down, tap **Add to Home Screen**,
  then **Add**.

Infoflex then appears with its own icon. Tapping it opens straight to the dashboard, without the address bar.

---

## 13. Pairing an iPhone or iPad

Same steps, with one difference. Safari is stricter about certificates than Chrome.

1. On the iPhone, open **Safari** (not Chrome — Safari is the one that can install to the home screen).
2. Enter the address shown on the computer.
3. You will see **"This Connection Is Not Private"**. Tap **Show Details**, then **visit this website**, then
   **Visit Website**. You may be asked for your iPhone passcode.
4. Type the six-digit pairing code, then log in as the Admin.
5. **Share → Add to Home Screen → Add.**

If Safari refuses the certificate entirely, the phone is on a different network from the computer, or something on
the network is intercepting the connection. See [Troubleshooting](TROUBLESHOOTING.md), which walks through each cause.

---

## 14. Using the phone over the Internet

On the same Wi-Fi, the phone talks straight to the computer. That is the fastest and most private option, and it is
the one to use at the counter.

If the Admin needs to check the shop from home, Infoflex can do that too, in one of two ways:

**Hotspot mode — no Internet needed.** Turn on the phone's mobile hotspot, and connect the pharmacy computer to it.
Now the phone and the computer are on the same network again, wherever you are. This is the simplest option and it
keeps all your data on your own devices.

**The Internet option.** With Mobile Access on and the computer connected to the Internet, the Admin's phone can
reach it from anywhere. This routes the connection through the vendor's relay server, because your pharmacy computer
is behind a router that the outside world cannot dial into.

> **What that means for your data.** The relay forwards the encrypted connection; it does not hold your database and
> does not keep a copy of your sales. But the traffic does pass through a server that is not yours. If your pharmacy
> handles data you would not want leaving the building, use hotspot mode instead, or keep Mobile Access on the local
> network only.

---

## 15. When the licence expires

Infoflex does not delete anything when a licence expires. It stops letting you make changes: no new sales, no stock
edits, and the mobile app refuses to log in.

**You can still see everything.** Reports, stock lists and past sales all remain readable, so you can trade on paper
for a day and still know where you stand.

To renew, contact the vendor. The vendor can reactivate you **from a phone**, without visiting and without asking you
to open anything technical. As soon as they do, Infoflex unlocks on its own the next time it checks — you do not need
to reinstall, and nothing you recorded is lost.

If your pharmacy has no Internet, the vendor can send an on-site code for the renewal the same way they did the
first activation.

---

## 16. Where to get help

- **A phone cannot connect:** [Troubleshooting → The phone cannot connect](TROUBLESHOOTING.md#1-the-phone-cannot-connect)
- **A currency symbol prints as a blank box:** [Troubleshooting → The receipt](TROUBLESHOOTING.md#4-the-receipt)
- **The licence check is failing:** [Troubleshooting → The licence](TROUBLESHOOTING.md#3-the-licence)
- **Anything else:** [Troubleshooting](TROUBLESHOOTING.md), then the vendor.

When you contact the vendor, tell them the store name, what you were doing, and what the screen said. Infoflex's
**Settings → About** page has a button that copies the version and licence details for you to paste into the message.
That saves a round trip.

---

*This guide describes Infoflex Pharmacy Manager as built. Where a feature depends on your vendor's configuration — a
locked currency, a per-country installer, on-site rather than online activation — the guide says so.*
