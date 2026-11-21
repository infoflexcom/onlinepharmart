# Infoflex Troubleshooting

Work through these in order. Each section says what to check, why it matters, and what to do. Nothing here needs a
command prompt.

**Before anything else:** the pharmacy computer is the server. If it is asleep, switched off, or has lost its network
connection, nothing else will work — and that is the cause of about half of all support calls. Check it first.

---

## 1. The phone cannot connect

The phone shows a blank page, "This site can't be reached", or a spinning loader.

There are six causes. Go through them in this order; each is more likely than the one after it.

### 1a. Are they on the same Wi-Fi network?

This is the most common cause by a wide margin.

On the **phone**: Settings → Wi-Fi, and read the network name.
On the **computer**: click the network icon in the bottom-right corner and read the network name.

They must be **exactly the same**. Two networks with similar names — `Pharmacy` and `Pharmacy-Guest` — are different
networks, and a device on one cannot reach a device on the other.

### 1b. Is it the guest network?

Many routers provide a separate guest network for customers. **Guest networks are isolated**: a phone on the guest
network cannot talk to a computer on the main network, even though both are "connected to the Wi-Fi". This isolation
is a security feature and it is working as intended.

**Fix:** connect the phone to the main network, not the guest one. If the pharmacy's Wi-Fi password is not given to
customers, the Admin's phone still needs the main network's password.

### 1c. Is there a VPN running on the phone?

A VPN on the phone sends *all* traffic — including traffic to your own computer — through a server somewhere else.
The phone can no longer see the local network.

**Fix:** turn the VPN off while using Infoflex on the pharmacy network. If you need the VPN for something else, turn it
on only when you are away from the shop.

### 1d. Is the computer's firewall blocking it?

Windows blocks incoming connections by default. The Infoflex installer adds a firewall rule for the mobile port, but
security software can override or remove it.

**Fix:** open Windows Security → Firewall & network protection → **Allow an app through firewall**. Find **Infoflex**
in the list. Make sure **Private** is ticked. If it is not listed, the installer's rule did not take — reinstall, or
add it by hand from that same screen.

> Note that "Private" is the one that matters. The shop's Wi-Fi must be marked as a **private** network in Windows,
> not "public". Windows treats public networks far more strictly, and on a public network the phone will not get
> through.

### 1e. Is the certificate trusted?

On the phone you may see **"Your connection is not private"** or **"This Connection Is Not Private"**. This is
expected and is not a fault: Infoflex uses its own certificate because it runs on your computer rather than on the
public Internet.

- **Chrome on Android:** tap **Advanced** → **Proceed to (address)**.
- **Safari on iPhone:** tap **Show Details** → **visit this website** → **Visit Website**.

If the browser offers no way forward at all, the problem is one of 1a–1d, not the certificate.

### 1f. Is the computer asleep?

A sleeping computer is not on the network. If the phone connects and then drops after a few minutes, this is almost
always why.

**Fix:** Settings → System → Power & sleep. Set **Sleep** to **Never** on the pharmacy computer, at least while the
shop is open. A pharmacy computer that sleeps is a pharmacy that cannot take a phone order.

### Still not connecting: hotspot mode

If you have been through all six and the phone still cannot connect, use hotspot mode. It sidesteps the network
entirely, so it also tells you whether the problem was the network.

1. On the **phone**, turn on the mobile hotspot (Android: Settings → Network → Hotspot; iPhone: Settings → Personal
   Hotspot).
2. On the **computer**, connect to the phone's hotspot as though it were ordinary Wi-Fi.
3. Open the address on the phone again.

If this works, the problem is the shop's network — the router, the guest isolation, or the firewall — and the vendor
can help you fix it. If it still fails, the problem is the app or the certificate, and the vendor needs to know that.

---

## 2. The mobile app refuses a login

**"Only an Admin can use the mobile app."**

This is intended. Cashier and Supervisor accounts cannot use the phone app, at all, by design. A phone can be lost or
stolen, and a lost phone must not be able to make sales in someone else's shop.

**What to do:** log in on the phone with the Admin account. If the person who needs mobile access is not the Admin,
either make them an Admin (Settings → Staff — consider carefully, an Admin can do everything) or accept that mobile
access is the Admin's alone.

**A previously working phone stopped working.** The Admin account was reset or deactivated. That revokes every paired
phone at once, which is deliberate — resetting a password is exactly when you want old devices cut off. Pair the phone
again.

---

## 3. The licence

### "The licence check is failing"

Three causes, in order of likelihood.

**No Internet, and the app expected it.** An online licence needs to reach the portal periodically. If the pharmacy's
Internet is down, the app keeps working for a grace period and then asks again. Reconnect the Internet and it clears
by itself.

**The clock is wrong.** Licence dates are compared against the computer's clock. If the pharmacy computer's date is
set to next year — a flat CMOS battery does exactly this — a valid licence looks expired.

**Fix:** Settings → Time & Language → Date & time → **Set time automatically**. Then restart Infoflex.

**The licence really has expired or been suspended.** Check the expiry date in Settings → Licence. If it has passed,
contact the vendor; they can renew or reactivate it from their phone and the app unlocks at its next check.

### "Everything is read-only but I can still see my data"

That is what an expired licence does. It blocks changes — no new sales, no stock edits, no mobile logins — and leaves
every screen readable. Nothing has been lost. The vendor renewing the licence restores everything at once.

### The on-site password is rejected

Check it character by character. It is case-sensitive, and the hyphens matter. After several wrong attempts the app
delays each further attempt, and the delay grows; wait rather than hammering it.

If you are certain it is right and it is still refused, the build may carry a different password from the one you were
given — usually because an older installer was used. Tell the vendor the app version from Settings → About.

---

## 4. The receipt

### A currency symbol prints as a blank box, a question mark, or an odd symbol

The thermal printer has a limited character set and may not include your currency's symbol — ₦, GH₵, KSh and the CFA
franc are the usual casualties. The printer receives the symbol, does not recognise it, and prints a placeholder.

**Fix: show the ISO code instead of the symbol.** Settings → Currency → **Show currency as** → **Code**. Receipts then
print `NGN 5,000.00` rather than `₦5,000.00`.

This is the standard answer and it is why the option exists. It affects display only: the amounts, the totals and the
recorded data do not change.

If you would rather keep the symbol, some thermal printers can be loaded with a code page that includes it, but that is
a printer job and not something Infoflex can do for you.

### Amounts print in the wrong format
`5.000,00` where you expect `5,000.00`, or the symbol on the wrong side.

Settings → Currency. Change **symbol position**, **thousands separator** and **decimal separator**. These stay
editable after the currency locks, because they change how amounts are *written*, not what they *are*.

### The store name is wrong on the receipt

Settings → Shop → Store name. Change it and the next receipt is right. Receipts already printed keep the old name —
they are a record of what happened at the time.

### Nothing prints at all

Check the printer is on, has paper, and is selected in Settings → Printing. Then print a Windows test page from
Settings → Devices → Printers. If the test page fails, the problem is between Windows and the printer and Infoflex is
not involved.

---

## 5. "I chose the wrong currency"

### Before the first sale

Open Settings → Currency and change it. Nothing is affected. Do it now, before you ring up anything.

### After the first sale

**The currency is now locked, and this cannot be undone in the app.**

Here is why, in plain terms. Every amount in the database is a whole number of minor units — 500000 means 5,000.00.
The database does not store which currency those minor units belong to, because that would mean repeating the same
word on every row of every table. The currency is a setting, and the setting is applied to every amount when it is
displayed.

Change the currency after sales exist and every past sale silently changes meaning: a 5,000 naira sale becomes a 5,000
cedi sale, at a stroke, with no conversion and no record that anything happened. That is not a display change; it is
falsifying the books.

**There is no conversion path**, because the software has no record of what currency the old amounts were in. There is
nothing to convert *from*.

**The only remedy** is for the vendor to reinstall Infoflex with a fresh database. Before that:

1. Export your reports — sales, stock, staff — to a file you keep.
2. Tell the vendor exactly which currency you want.
3. Understand that the sales in the old database will not be in the new one. They are not being converted; they are
   being left behind.

This is why the installer asks, and why the Customer Guide says to think about it before typing in stock.

---

## 6. What to send the vendor

A useful message gets a problem fixed in one exchange instead of five. Include:

1. **The store name** and the country.
2. **What you were doing** — "pairing an iPhone", "printing a receipt", "activating on-site".
3. **What the screen said**, word for word. A photo of the screen is better than a description.
4. **The app version and licence details.** Settings → About has a button that copies all of it to the clipboard;
   paste that into the message.
5. **Whether anything changed recently** — a Windows update, a new router, a new phone, a power cut.

If it is a phone that cannot connect, add:

6. **Whether hotspot mode works** (see §1). That single answer tells the vendor whether the problem is the network or
   the app, and saves an entire round of questions.

What **not** to send: your password, the installation password, or any licence file. The vendor does not need them,
and a password in a chat message is a password that has leaked.
