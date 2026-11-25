import type Database from 'better-sqlite3'

/**
 * The order-to-receipt workflow: what migration 16 designed and this phase fills in.
 *
 * Migration 16 created `orders`, `order_items`, `order_events`, `reservations`, `print_log` and `document_sequences`,
 * and deliberately built nothing on them. This phase is the building. It needs three things the earlier design did not
 * have, and it turned out NOT to need a fourth:
 *
 * - **`order_items.unit`.** An order slip has to say "2 kg" or "3 each". Without the unit the line is a number with no
 *   meaning on a printed slip, and reading it back from `products` at print time would be exactly the kind of
 *   live-join-that-rewrites-history the snapshot columns exist to prevent: a product switched from `each` to `box`
 *   would change what an old order said.
 * - **`print_log.reprint_reason`.** The brief requires a reason for a reprint, and `print_log` as designed had nowhere
 *   to put one.
 * - **`orders.origin_pc`.** Which machine the order was picked on, in words.
 *
 * **Not needed: a join table from an order to its sale.** An earlier draft of this migration created `order_sales` on
 * the stated grounds that `sales` had no `order_id` column. That was wrong — migration 16 line 209 adds exactly
 * `sales.order_id TEXT REFERENCES orders(id)`, alongside `finalized_by` and `server_receipt_no`. The column existed and
 * was simply never written, because nothing finalized an order until now. Two records of one relationship are two
 * chances for them to disagree, so the link lives on `sales` where it was designed to live and there is no shadow
 * table. The reason it has to be written at INSERT time rather than afterwards is migration 3's
 * `completed_sales_cannot_be_changed` trigger: the sale is COMPLETED the moment it exists. That rule is right, and it
 * is what makes the ordering here matter.
 */
export function migrateOrderWorkflow(database: Database.Database): void {
  database.exec(`
    -- ── order_items: the unit the line was sold in, snapshotted ──────────────────────────────────────
    ALTER TABLE order_items ADD COLUMN unit TEXT NOT NULL DEFAULT 'each';

    -- ── print_log: why a copy was printed again ──────────────────────────────────────────────────────
    -- The brief requires a reason for every reprint. An empty string means "this was the first copy", which is why the
    -- column is NOT NULL with a default rather than nullable: "no reason given" and "no reason needed" must not be the
    -- same value in a log whose whole purpose is answering a question later.
    ALTER TABLE print_log ADD COLUMN reprint_reason TEXT NOT NULL DEFAULT '';

    -- ── orders: which client PC the order came from, in words ────────────────────────────────────────
    -- client_device_id already links an order to an approved device row, but a device that has since been revoked
    -- takes its name with it (ON DELETE SET NULL). The picker's PC name on an audit trail must not vanish when the
    -- Admin revokes the machine, so the name at the time is kept.
    ALTER TABLE orders ADD COLUMN origin_pc TEXT NOT NULL DEFAULT '';
  `)
}
