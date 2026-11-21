# Infoflex Cloud — privacy notice (template)

> **How to use this template.** Replace the parts in `[square brackets]`, publish it on the vendor's own website,
> and link it from the licence e-mail and from the desktop app's Licence screen. It is written to be read by a
> pharmacist or shop owner, not a lawyer, and it deliberately makes promises the software can keep — each one is
> asserted by a test in `cloud/tests/schema.test.ts` or by the `refuseBusinessData` check in the licence API.
> It is a template, not legal advice; a vendor in Nigeria should have it read once by a Nigerian lawyer.
>
> The Act it cites is the **Nigeria Data Protection Act 2023** (NDPA), and the regulator is the **Nigeria Data
> Protection Commission** (NDPC). If the vendor sells outside Nigeria, add the equivalent local law — for example
> the GDPR in the EU or the UK, or Kenya's Data Protection Act.

---

## Who we are

Infoflex is point-of-sale and stock software for pharmacies and supermarkets. It is sold and supported by
**[Vendor legal name]**, of **[address]**, reachable at **[e-mail]** and **[phone]**. In this notice, "we" is that
company and "you" is the shop that holds an Infoflex licence.

Our licence server is at **https://[licences.example.com]**. It exists to check that a copy of Infoflex is
licensed, to keep that licence's dates and settings up to date, and to let our support team help you.

## What we hold, and nothing else

We hold **licence and contact data only**:

| What | Why | Where |
| --- | --- | --- |
| Your shop's name, contact person, phone number and e-mail address | To identify your licence, to reach you about renewals, and to support you | Licence server |
| The licence key, edition (pharmacy/supermarket/both), start and end dates, status | To decide whether the software may run | Licence server |
| One machine identifier | To bind the licence to one computer, so it cannot be copied to another | Licence server |
| The default currency **code** (for example `NGN`) and whether it is locked | So the till preselects your currency at setup | Licence server |
| Whether Admin phone access is allowed on your network and over the internet, and how many Admin phones | To enforce what your licence permits | Licence server |
| Check-in times, the Infoflex version and the platform (Windows version) | So support can see which version you are running, and so a licence that has not been seen recently is visible to us | Licence server |
| The two-factor secret and password hash of our own staff accounts | To protect the vendor portal | Licence server, for our staff only |

**We never receive, store, or ask for:**

- your sales, receipts, invoices, returns or totals;
- your prices, costs, margins or currency amounts of any kind;
- your stock levels, batches or expiry dates;
- your customers' names, phone numbers or purchase history;
- your employees' names, PINs, passwords or roles;
- your cashier shifts, drawers, Z-reports or accounting entries.

That is not a matter of policy but of construction: the licence server's database has no column that could hold
any of it, and its public interface **refuses** a request that contains any of those fields, with the error
`business_data_not_permitted`. Both facts are checked by automated tests on every build. Your shop's data stays on
your own computer, in your own database, under your own control.

## Why we are allowed to hold it (NDPA 2023)

Under the Nigeria Data Protection Act 2023 we rely on:

- **Performance of a contract** (section 25(1)(a)) — the licence data is what the contract is about: without the
  key, dates, and machine binding there is no licence to perform.
- **Legitimate interests** (section 25(1)(f)) — contact details and check-in records, so that we can support you
  and tell you before a licence lapses. We have balanced this against your rights: it is a small amount of data,
  it is about your business rather than your customers, and you can ask us to stop using it for reminders at any
  time (see *Your rights*) without affecting the licence itself.
- **Consent**, only where we need it — for example, if you ask us to allow Admin phone access **over the
  internet**. That is off by default, it is a separate tick, and you can switch it off whenever you like.

We do not use your data for advertising, we do not sell it, and we do not profile you.

## Who sees it

- **Our own staff**, through the vendor portal. Every staff account needs a password and an authenticator code,
  every action is written to an audit log with the person's address and the time, and sessions end after 30
  minutes of inactivity.
- **Our hosting provider**, which stores the server's disk. **[Provider name, country]**. It cannot read the
  licence signing key, which is kept as a file only our server can read.
- **Our e-mail provider**, if you have given us an e-mail address and we send you a renewal reminder.
- **Nobody else.** We do not share licence data with any third party for marketing, and we do not transfer it
  outside **[Nigeria / the countries listed here]** except to a hosting provider in a country the NDPC recognises
  as providing adequate protection, or under the safeguards in section 41–43 of the Act.

If you allow **Admin phone access over the internet**, your phone's requests pass through our relay server while
you are using it. The relay forwards those requests to your shop's computer and **stores none of them**. It can,
in principle, read them in transit, as any secure web server can. The full statement is in our
`RELAY-LIMITS.md`, and the same paragraph appears on the screen where you tick the option. If you do not want
that, leave internet access off: the Admin phone still works on your shop's own network, which never leaves your
building.

## How long we keep it

| Data | Kept for |
| --- | --- |
| Licence and customer record | The life of the licence, plus **[7] years** for tax and warranty records |
| Check-in records | **[24] months**, then deleted |
| Audit log | **[7] years** (it is the record of who changed a licence) |
| Activation attempts (a hash of the key, the address and the outcome) | **[90] days** |
| E-mail address | Until you ask us to remove it, or the licence record is deleted |

## How we protect it

- HTTPS only, with a real certificate and modern TLS.
- Hardened headers, a strict content security policy, and no third-party scripts on the portal.
- Passwords stored as **argon2id** hashes; two-factor authentication is **mandatory** for every vendor account.
- CSRF protection on every form, and a session cookie that is `HttpOnly`, `SameSite=Strict` and `Secure`.
- The licence **signing key** is a file on the server that only the server's own user can read. It is not in the
  database, not in the source code, and not in any installer.
- A database snapshot every day, fourteen kept, on a volume that is not reachable from the web.
- Backups and the live database are in the same hosting account, so a lost server is restored from the host's
  own snapshot as well. Ask us where your copy is if you need to.

If a personal data breach occurs that is likely to result in a risk to you, we will tell the **Nigeria Data
Protection Commission within 72 hours** and tell you without undue delay, as sections 40 and 41 of the Act
require, describing what happened, what we have done and what you should do.

## Your rights

Under the NDPA 2023 you may ask us, at any time and free of charge:

1. **to see** what we hold about your shop (we will export it as a file);
2. **to correct** anything wrong — a misspelt shop name, a changed phone number;
3. **to delete** it, once the licence has ended and the retention period above has passed — a live licence cannot
   be deleted without ending the licence, because the licence *is* the record;
4. **to restrict** what we do with it — for example, "stop sending me renewal e-mails";
5. **to object** to our legitimate-interest processing (reminders and support records), after which we stop unless
   we have a compelling reason;
6. **to portability** — the same export as (1), in a machine-readable file;
7. **to complain** to the Nigeria Data Protection Commission, <https://ndpc.gov.ng>, if you are unhappy with our
   answer.

Write to **[privacy e-mail]** and we will answer within **30 days**. You do not need a lawyer, a form or a fee.
We may ask one question to confirm you are the licence holder — usually the last four characters of your licence
key — and no more.

## Children

Infoflex has no consumer users and no features aimed at children. We do not knowingly hold data about anyone
under 18.

## Changes

If this notice changes in a way that affects what we hold or why, we will e-mail the address on your licence
before the change takes effect, and keep earlier versions at **[URL]**. The version you are reading is dated
**[2026-11-17]**.

---

### For the vendor: what this notice commits you to

Publishing this template is a promise, and every promise in it is one the software already keeps — except the
ones you must do yourself:

- [ ] Fill in the retention periods and make sure your server really keeps nothing longer (the check-in table is
      the only one that grows without bound; prune it yearly).
- [ ] Name your hosting provider and its country, and confirm it is a lawful transfer.
- [ ] Put a real privacy e-mail address in and answer within 30 days.
- [ ] Keep the daily snapshots actually running (`INFOFLEX_CLOUD_BACKUP_DIR` is on a mounted volume).
- [ ] Publish the export you promise: `cloud/src/license-service.ts` can produce it per customer; the portal's CSV
      covers the licence list.
