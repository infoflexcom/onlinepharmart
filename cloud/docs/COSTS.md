# What Infoflex Cloud costs to run

Two numbers matter: what one vendor pays monthly for the whole cloud, and what the cloud can carry at that price.
Both are honest estimates from the code in this repository — the licence server holds licence rows, not sales, and
that is why the numbers are so small.

## The two recommended configurations

### A. Cloud build on a small VPS (with relay)

| Item | Monthly |
| --- | --- |
| VPS, 1 vCPU / 2 GB / 20 GB SSD (Hetzner CX22, DigitalOcean basic, Vultr regular) | US$4–6 |
| Block volume for database, backups and the key, 1 GB | US$0.10–0.50 |
| Domain name (amortised, ≈US$12/year) | US$1 |
| TLS certificate (Let's Encrypt via Caddy) | free |
| E-mail reminders through an existing mailbox | free |
| Or a transactional mail service (1 000 messages/month) | US$0–3 |
| Off-site copy of the key (password manager storage) | free |
| **Total** | **US$5.10–10.50** |

Add roughly US$2–4 if you want the relay's wildcard certificate handled by a managed DNS provider with an API
(some registrars charge for API access; Cloudflare's free plan does not, and works with Caddy).

### B. PHP build on shared hosting (no relay)

| Item | Monthly |
| --- | --- |
| Shared hosting with PHP 8.1+, one MySQL database, AutoSSL | US$2–5 |
| Domain name | US$1 |
| **Total** | **US$3–6** |

## What that buys, in licences

The workload is: one activation per new shop, one check-in per shop per day while the licence is active, and one
portal page view when the vendor looks at something.

| Activity | Per shop per month |
| --- | --- |
| Check-ins (24-hour polling while active) | 30 |
| Check-ins while suspended or expired (60-second polling) | 43 200 if left alone — the reason suspension is time-boxed |
| Portal traffic | none (it is the vendor's, not the shop's) |

| Dimension | Where it runs out |
| --- | --- |
| Database size | 1 000 licences ≈ 0.4 MB; 100 000 licences ≈ 40 MB. The 20 GB disk is never the limit. |
| Daily check-ins | The 1 vCPU instance answers roughly 2 000 requests/second for this query shape; 100 000 shops is about 1.2 requests/second. CPU is not the limit. |
| Relay bandwidth | 24 MiB per shop per minute is the cap. A real Admin session moves a few hundred KB per screen; a shop with a metered 1 GB plan can use the relay for an hour a month comfortably. |
| Backups | 14 snapshots of a 40 MB database is 560 MB — still inside the 1 GB volume. Move to `backupKeep=7` past 100 000 licences. |
| Memory | The Node process idles at ~90 MB and a relay tunnel holds ~1 MB per connected shop. 2 GB carries 1 500 simultaneously connected shops. |

**A useful rule of thumb:** one US$6 VPS comfortably serves **several thousand licences and a few hundred
simultaneously connected relay shops**. If you outgrow it, the first move is `INFOFLEX_CLOUD_DATABASE` onto the
block volume (it already is), and the second is a bigger instance — not an architecture change.

## What would cost more

| Change | Extra cost | When it is worth it |
| --- | --- | --- |
| PostgreSQL instead of SQLite | managed Postgres US$15–20 | Multiple cloud instances behind a load balancer, i.e. tens of thousands of shops |
| Off-site backup storage (S3/B2) | US$1–5 | If the hosting account itself is the risk you are hedging |
| A mail service with a dedicated IP | US$15–35 | Only if you send invoices/newsletters, not for three reminders per licence |
| A second server as a warm standby | doubles the server line | If a day of portal downtime is unacceptable — note that shops keep working, because a till with a valid licence does not need the cloud |

## What this does **not** include

- **The desktop app's distribution**: Windows code signing (≈US$200–400/year from a certificate authority) and
  the update-host bandwidth. That is in the installer docs, not here.
- **Support time.** The cloud is the cheap part of running this business.
- **VAT and local taxes** on the hosting bill.

## Cheapest possible honest answer

If you are selling your first ten licences and want to spend nothing until you have revenue: the PHP build on the
cheapest shared host that offers PHP 8.1, MySQL and AutoSSL, with your existing e-mail address for reminders.
That is about **US$3 a month including the domain**, it has no relay, and it is the same licence API the desktop
app already speaks.
