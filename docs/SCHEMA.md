# SQLite schema reference

**Scope:** Infoflex Pharm/Mart single-shop database. The schema is built from ordered migrations in `src/db/migrations/`. Product, inventory, POS sale/payment/receipt, Returns, accounting/reporting, the Admin LAN mobile PWA, and settings plus local backup/restore are implemented through the desktop host. Jurisdiction-specific tax rules, production sync, Internet mobile hosting, and physical-phone/Windows release validation remain incomplete.

## Database lifecycle

- Electron main opens `<app.getPath('userData')>/infoflex.sqlite` through `openShopDatabase()` in `src/db/index.ts`.
- The renderer never opens SQLite. `better-sqlite3` stays in the host process; desktop IPC invokes typed host services. The browser preview adapter is memory-only, and current Fastify scaffolding does not expose product/inventory routes.
- Open enables SQLite foreign keys, WAL journaling, and a 5-second busy timeout. It creates the parent directory, applies pending migrations in a transaction, and closes the handle if startup migration fails.
- `schema_migrations` records each applied version exactly once. Migrations run in numeric order.

| Version | File | Purpose |
| --- | --- | --- |
| 1 | `001_core.ts` | Currency catalog, settings, users, core business, audit, license, device, sync/idempotency, and approval tables. |
| 2 | `002_edition_modules.ts` | Pharmacy/supermarket fields and tables for batches, barcodes, variants, promotions, loyalty, shifts, and cash drawer. |
| 3 | `003_indexes_and_guards.ts` | Query indexes and database-level currency-lock / immutability guards. |
| 4 | `004_legacy_import.ts` | Copies the previous `shop_settings` record into `settings`; retains existing `business_entries` and `audit_log` tables. |
| 5 | `005_sync_metadata.ts` | Adds a local sync checkpoint and hashed operation receipts; stores no replicated shop-data payloads. |
| 6 | `006_authentication.ts` | Adds user full names, persistent lock/login timestamps and row versions, installer currency preselection, bounded idle timeout, and permission row versions. |
| 7 | `007_license_system.ts` | Adds current-license markers and mobile entitlement fields, append-only license history, runtime integrity/clock markers, and vendor policy configuration. |
| 8 | `008_product_inventory.ts` | Adds product classification/pricing and pack fields, stock adjustment reasons, ordered primary barcodes, purchase receiving/row versions and received batch data, stock invariants, indexes, and immutable stock-movement guards. |
| 9 | `009_point_of_sale.ts` | Adds sale/customer/store/currency snapshots, discounts/loyalty/credit/idempotency metadata, sale-time batch allocations, held carts, payment tender/change fields, and immutable receipt-print history. |
| 10 | `010_returns_workflow.ts` | Adds the configurable return window, sale-time expiry-tracking snapshot, return reasons/types/approvals/idempotency and historical snapshots, per-item disposition/batch and discount detail, loyalty points debt/reversals, store credits, immutable print history, and completed-return guards. |
| 11 | `011_accounting_reports.ts` | Adds business-date cash-close snapshots, shift settlement links, and historical supermarket report dimensions/indexes. |
| 12 | `012_mobile_sessions.ts` | Adds per-device access-token expiry and binds refresh-token hashes to paired devices, with lookup indexes. |
| 13 | `013_operational_settings.ts` | Adds receipt layout, optional VAT, discount ceiling, printer, accepted payment methods, expiry-alert, loyalty-rate, supervisor-PIN and scale settings; the sale-time "Powered by Infoflex" snapshot; and the `backup_log` journal. |
| 14 | `014_admin_two_factor.ts` | Adds the Admin's TOTP secret, confirmation timestamp and recovery-code hashes for internet sign-in. |
| 15 | `015_demo_data_removal.ts` | Re-creates the delete guard on `stock_movements` so rows written by the optional demonstration dataset (`reference_type = 'DEMO_SEED'`) can be withdrawn, while every real movement stays immutable. |

## Tables

### Migration, currency, settings, and access

| Table | Purpose and important fields |
| --- | --- |
| `schema_migrations` | Applied migration version, name, and timestamp. |
| `currencies` | Seeded built-in ISO catalog and validated customer-defined currency metadata. Stores code, display name/symbol, precision, symbol position, separators, and `is_custom`. It stores no exchange rates. |
| `settings` | Single shop row (`id = 1`): customer-entered name/address/phone, contact/receipt fields, mobile service flags, selected currency and display preferences, installer currency preselection, setup confirmation, bounded idle timeout, 1–365-day return window (default seven days), vendor/transaction currency-lock flags, and the operational settings added in migration 13 (receipt layout, VAT on/off + rate in basis points + inclusive flag, discount ceiling in basis points, printer name, accepted payment methods as JSON, expiry-alert days, loyalty rate, supervisor PIN rules, scale settings, `show_powered_by`). |
| `backup_log` | One row per automatic backup, manual backup, or restore, with file name, folder, byte size, currency code, app version, SHA-256, actor and timestamp. Deliberately kept when a restore replaces shop data, so the backup history survives. |
| `users` | Host-authenticated Admin, Supervisor, and Cashier accounts; bcrypt password hashes only, active/five-attempt lockout state, last-login timestamp, full name, row version, and audit timestamps. |
| `user_permissions` | Per-user business permissions (`allow_wholesale`, discount basis points, credit sales, and integer `return_limit`) plus row version. **There is deliberately no mobile permission toggle.** Mobile access is Admin-only in host authorization code. |
| `license_state` | Current and historical license rows with signed/local token, machine binding, edition, dates, source, default currency, lock, check-in/report markers, entitlement features, Admin-phone limit, and signed grace days. The active row is protected by a partial unique index. |
| `license_history` | Append-only activation, policy, check-in, renewal, and failure events with claims/token where applicable and sanitized detail metadata. It contains no entered password or shop transaction payload. |
| `license_runtime` | Single-row current-license pointer, last trusted clock instant, and local integrity tag. |
| `license_vendor_config` | Single-row salted master-password hash, optional Build Studio term cap, trusted public Ed25519 keys, server URL, policy-integrity tag, and throttling counters. It stores no signing private key or plaintext master password. |
| `audit_log` | Actor, action, JSON metadata, device name, remote IP, and timestamp for important local/remote events. |
| `devices` | Paired phone name/platform, Admin owner/approver, hashed current opaque access credential, access expiry, last-seen/IP data, and revocation flag. Raw access tokens are never stored. |
| `refresh_tokens` | Hashed refresh credential, Admin user and optional paired-device foreign key, expiry, revocation time, and creation time. Migration 12 binds new mobile refresh credentials to a device; legacy unbound rows are retained. |
| `sync_state` | Single local checkpoint with last cursor, last successful sync, status, and a row version. |
| `sync_operations` | Idempotent operation receipt linked to device and idempotency key. Stores request/response hashes and status, not request/response payloads. |

### Products, people, inventory, and transactions

| Table | Purpose and important fields |
| --- | --- |
| `categories` | Product category tree with active state. |
| `suppliers` | Supplier identity and contact details. |
| `customers` | Customer identity, integer-minor-unit credit limit/balance, optimistic `row_version`, and active state. |
| `products` | SKU, name/description, brand/category/sub-category, barcode set, unit/pack conversion, department/shelf, integer-minor-unit cost/retail/wholesale prices, reorder threshold, active flag, and optimistic `row_version`. Migration 2 adds generic/prescription and batch/expiry fields for pharmacy, plus department, weighed-item, PLU, and price-per-kg fields for supermarkets. Migration 8 adds brand/sub-category, wholesale price/minimum, reorder level, pack size, and explicit expiry tracking. |
| `stock` | Current/reserved inventory in integer milli-units, with a separate stock `row_version`; migration 8 seeds a stock row for each existing product. A database trigger rejects negative on-hand quantities. |
| `stock_movements` | Immutable stock ledger; movement kind, quantity delta in milli-units, integer unit cost, currency code, reference, actor, and migration-8 adjustment reason. `STOCK_VALUATION` locks currency. |
| `sales` | Sale header, generated unique sequential receipt, customer/cashier/workstation, status/type, currency and display settings, promotion/loyalty/credit/idempotency metadata, integer-minor-unit totals, store/customer identity snapshots, and the sale-time `show_powered_by_snapshot` for the printed Infoflex line. |
| `sale_items` | Quantity in milli-units and integer-minor-unit price, discount, tax, and line total; preserves product/description/pricing/expiry-tracking snapshots for historical returns. |
| `payments` | A sale or return payment, integer-minor-unit amount, currency code, method, reference, tendered amount, and change. A check requires exactly one of `sale_id` or `return_id`. |
| `returns` | Return header, generated unique return number, source sale, status/reason/type/refund method, idempotency and approval references, return-window decision, requesting-user/approver/store/customer/currency/display snapshots (the original sale cashier stays on the source sale), integer-minor-unit totals, and loyalty reversals. |
| `return_items` | Returned quantities and saved line-value/discount allocations, sale/product/description references, condition, restocked/write-off/no-stock disposition, and original batch/expiry snapshot. |
| `return_credits` | Unique store-credit or exchange-credit note linked to a return, customer, original currency, face amount, and remaining balance. Redemption against a later sale is not implemented. |
| `return_print_events` | Immutable first-print/reprint events with user, workstation, document layout, duplicate flag, and timestamp. |
| `purchases` | Supplier purchase-order/receipt header, currency code, `DRAFT`/`COMPLETED`/`CANCELLED` status, integer-minor-unit totals, supplier reference/receipt note/time, and migration-8 optimistic `row_version`. |
| `purchase_items` | Ordered quantities and integer-minor-unit unit cost/line total plus migration-8 received quantity in milli-units, batch number, and expiry date. Existing completed purchase rows are backfilled as fully received. |
| `day_closings` | Close number, open/closed times, cashier and currency snapshot, integer-minor-unit totals. A close does not independently lock currency. |
| `business_entries` | Shared append-only service ledger with kind, currency, integer-minor-unit amount, store name/address/phone snapshots, and timestamp. Existing rows are preserved on migration. |

### Edition and operations tables

| Table | Purpose and important fields |
| --- | --- |
| `departments` | Supermarket department lookup. |
| `product_batches` | Tracked product batch/lot, expiry date, quantity, integer-minor-unit cost, and `row_version`; indexed for product/expiry ordering used by FEFO. |
| `product_barcodes` | Unique primary and additional product barcodes; migration 8 stores deterministic order and enforces at most one primary barcode per product. |
| `product_variants` | Variant attributes and optional integer-minor-unit price override, with `row_version`. |
| `promotions` | Fixed-minor-unit or percentage/basis-point discount with an exclusive-value check and active dates. |
| `price_rules` | Product/department price bounds in integer minor units and optional active dates. |
| `loyalty_members` | Customer membership, points balance, return-generated points debt, and `row_version`. |
| `loyalty_transactions` | Earn/redeem/adjust point ledger linked to a member and optional sale/return. |
| `sale_item_batches` | Immutable checkout-time batch/lot and expiry allocations per sale item, used to return Pharmacy stock to its original batch. |
| `sale_print_events` | Immutable first-print/reprint history for sale receipts and invoices. |
| `held_carts` | Cashier-owned POS drafts persisted for later recall; they are not completed sale records and do not lock currency. |
| `cashier_shifts` | Cashier shift, currency snapshot, status, and integer-minor-unit opening/expected/counted/variance amounts. |
| `cash_drawer_events` | Paid-in/out, float, or safe-drop event with integer-minor-unit amount and currency snapshot. |

## Invariants enforced in code and/or SQLite

- **Money:** Monetary values are signed SQLite `INTEGER` minor units and TypeScript `bigint`; schema checks use `typeof(value) = 'integer'`. Currency precision (0–4 decimal places) is display/conversion metadata. Quantities are integer milli-units, not floating point.
- **Rounding:** Decimal entry conversion and rational-rate math use round-half-up (ties away from zero). Display/parsing never convert monetary values to JavaScript floating-point numbers.
- **Currency:** NGN is the default; built-in codes are seeded and validated custom currency definitions are stored separately. The currency code is copied onto sales, returns, purchases, stock movements, day closes, payments, shifts, cash-drawer events, and business entries. Product/stock money input is parsed against the shop currency's configured precision without silently rounding extra decimal places. Foreign-currency payment handling and live exchange rates are not implemented.
- **Currency lock:** A completed sale, purchase, return, or a stock-valuation movement sets `settings.currency_locked` and the transaction-lock source. Draft/pending sales, purchases, and returns do not lock until completion. Database triggers reject later currency changes and prevent clearing that lock. A vendor lock also prevents clearing. Day close stores its currency but is not a lock trigger. The service checks the lock before changing currency; database guards remain the final protection.
- **Receipt sequence:** Sales use an `AUTOINCREMENT` integer primary key and a stored generated `R-` number formatted to ten digits, protected by a unique constraint. Return (`C-`), store-credit (`SC-`), purchase (`P-`), and day-close (`D-`) references use generated/sequence-backed unique identifiers.
- **Historical identity:** Sale, return, and shared business-entry rows snapshot the shop name, address, and phone at write time. Updating shop settings cannot rewrite old documents.
- **Concurrency:** Mutable customer/product/stock/batch/variant/loyalty rows use positive `row_version` columns. Product updates check product versions; stock mutations also check a separate stock version; purchase-order receipt checks the order version. Conflicts fail without partially applying a write and prompt the operator to reload.
- **Completed records:** Shared business entries and stock movements cannot be updated or deleted; completed sales and returns, their items, and their payments cannot be changed or deleted. Inventory receipt/adjustment/stocktake, purchase receipt, POS checkout, and return completion commit their stock/batch, payment, business-entry, and audit effects atomically. Corrections use new reasoned ledger movements or a separate return/void workflow; completed history is not rewritten.
- **Access control:** Roles and editions are host decisions; request bodies or renderer flags are not authorization. Product costs are omitted for non-Admins; product creation/updates, price/cost changes, imports, stock adjustments/receipt/stocktake, and purchase orders are Admin-only. Mobile routes are Admin-only in host authorization; `user_permissions` has no mobile toggle.
- **Secrets:** This schema stores password hashes and device/refresh-token hashes only. No license private key or vendor master password belongs in the app, database, installer, logs, cloud, Build Studio, or mobile bundle.

## Product and inventory workflows

`src/services/product-inventory-service.ts` is the host-side product/stock service. Product CRUD, search, stock operations, import/export, purchase orders, FEFO stock consumption, and weighed-price calculation run through host authorization and the narrow preload bridge. Products and Stock routes render in `src/renderer/src/ui/InventoryWorkspace.tsx`; the browser preview adapter stores data in memory only and is not a persistence or security boundary.

- Product setup includes SKU/name, primary and additional barcodes, brand/category/sub-category, units per pack, department/shelf location, retail/wholesale prices, cost, reorder threshold, variants, pharmacy prescription/generic fields, and supermarket PLU/weighed-price/expiry fields.
- CSV and `.xlsx` imports validate headers and rows, return per-row errors, and do not silently round invalid money. Exports omit cost fields for non-Admins; spreadsheet-formula prefixes are escaped in CSV output. Import files have size/row/column limits.
- Admin stock receipt writes a completed purchase/stock movement and business-entry/audit records in one SQLite transaction. Unit-versus-pack conversion is applied before storing integer milli-unit quantities. Adjustments require a reason; stocktake persists the count variance and a device/actor audit record. All are version-checked.
- Supermarket Admins can create draft purchase orders and receive the complete order with a goods-received note. Draft orders do not change on-hand stock. Receipt updates stock, batch details where configured, product cost, purchase status, currency totals, and audit data atomically. Purchase receipt requires the shop currency to remain unchanged since order creation.
- Expiry-tracked stock is received into batches. The inventory consume operation and POS checkout allocate from the earliest non-expired batches, check stock availability, block insufficient unexpired stock, and save movements and checkout-time allocations. POS checkout creates the receipt, item/payment/customer/currency snapshots, idempotency record, audit, and stock changes in one host transaction; it currently records zero tax because tax calculation is not implemented.
- Desktop Returns looks up a completed receipt and saves requested return quantities against its original items. Completed/pending quantities are reserved to prevent over-return, with at most one unresolved approval request per receipt line; over-limit requests wait for Admin/Supervisor approval and cause no stock/payment/loyalty effects until approved. Refund, store-credit, and exchange types use the sale's exact stored minor-unit values; completed actions atomically update return status, payments/credit notes, stock/batches or write-offs, loyalty reversals/debt, business entries, and audit.
- For Pharmacy/expiry-tracked goods, checkout snapshots exact sold batch allocations. Resellable returned units restore to those original batches only while the batch remains unexpired; opened, expired, damaged, and other non-resellable items are recorded as write-offs. Refund items may also return to stock for non-expiry-tracked products when marked resellable.
- The default return window is seven days and Admins may configure 1–365 days. An out-of-window request requires an Admin override and written reason. Per-user return limits are integer minor units; higher requests remain pending until an Admin/Supervisor approves, and requesters cannot approve their own requests. The Admin-only LAN PWA can list and approve/reject pending requests; the shared `ReturnService` records the explicit MOBILE approval channel and remains authoritative.
- Completed return and credit notes use original sale store/currency/display snapshots. A4 and 58/80 mm print layouts and immutable print/reprint event tracking are supported. Store-credit balances are recorded, but redemption against a future sale is not implemented.
- Supermarket weighed-item pricing multiplies price-per-kilogram by milli-unit weight using integer arithmetic and half-up rounding. Stock alerts include reorder thresholds and expired/near-expiry batches.

## Legacy compatibility

Migration 4 reads row `id = 1` from a prior `shop_settings` table when present and maps its store profile, currency, display, confirmation, and setup fields to the single `settings` row. A custom currency is copied only when it has a non-conflicting custom code. Existing `business_entries` and `audit_log` tables are not recreated, so their records survive. A pre-existing transaction ledger entry causes the imported settings to start with currency locked. Migration integration tests exercise a representative legacy database and confirm the old transaction remains authoritative.

## Verification

`src/db/database.test.ts` checks migration order/idempotence through version 15, a populated v7-to-v8 upgrade/backfill, legacy device/refresh-row compatibility, negative-stock and immutable-ledger guards, table coverage, seeded currencies, integer money affinity, receipt sequence, foreign-key integrity, legacy import, and currency locking. `src/services/mobile-device-service.test.ts` covers one-use pairing, capacity checks in registration transactions, access expiry, hashed tokens, refresh rotation/reuse detection, rate limits, and revocation. `src/services/mobile-access-service.test.ts` exercises a real local HTTPS listener, CA/leaf certificate validation, safe-storage requirements, PWA serving, start/stop, and certificate regeneration. `src/api/mobile-session.test.ts` covers LAN-only pairing/refresh gates, logout, static PWA security headers, and API/static route separation; `src/api/server.test.ts` covers Admin reports/Returns routes and serialization. `src/services/point-of-sale-service.test.ts` covers FEFO batch snapshots, atomic/idempotent checkout and reprints, promotion/manual/loyalty discounts, split tender/credit, expiry snapshots, and loyalty debt repayment. `src/services/return-service.test.ts` covers partial/refused over-returns, idempotency, approvals/self-approval and mobile channel, window override, Pharmacy batch restock/write-off/expiry, loyalty reversals/debt, exact allocations, snapshots/credits/prints, and rollback. Phase 12 adds the optional demonstration dataset and its removal path: `src/services/demo-data-service.ts` writes 30 pharmacy and 60 supermarket products across two departments (six weighed lines), their batches as `DEMO_SEED` movements, two promotions and three sample accounts, inside one transaction, without ever creating a sale -- so `isCurrencyLocked()` is still false afterwards and the Admin can still choose a currency. Removal is refused in plain words when any real sale, return or purchase touches the dataset, and deletes nothing when it refuses. `src/services/demo-data-service.test.ts` covers both, plus the Admin-only boundary through the desktop host. `src/api/locked-currency-channels.test.ts` proves a locked currency cannot be moved through the real desktop IPC channel, the host controller beneath it, or any guessable phone route, and that harmless display preferences still change. `src/services/pos-currency-end-to-end.test.ts` runs a sale, its receipt, a reprint and the report in NGN, USD, JPY and KWD. `src/api/cross-device-consistency.test.ts` runs an Admin's phone adjustment against a cashier's sale of the same item and checks stock, totals and the audit log agree. `src/api/mobile-currency-routes.test.ts` sells in NGN, USD, JPY and KWD and reads dashboard, product, sale and report amounts back over the real admin routes; `src/api/wire-money.test.ts` proves bigint minor units are converted to decimal strings on the way out, which they were not on the reports route before Phase 12 closed. `src/renderer/src/ui/DemoDataPanel.test.tsx` is the project's first jsdom-mounted component test, because the demonstration panel's job is interactive.

Host/IPC role/page checks are covered in `src/services/first-run-authentication.test.ts`; `src/services/product-inventory-service.test.ts` covers role/cost boundaries, CSV formula-injection protection, XLSX import/export, strict currency precision, stock receipt/adjustments, audit metadata, rollback, stocktake variance, stale writes, FEFO/expiry blocking, purchase orders, weighed pricing, and zero-/three-decimal currencies.
