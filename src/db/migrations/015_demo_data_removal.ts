import type Database from 'better-sqlite3'

/**
 * Lets the demonstration dataset be removed without weakening the rule that real stock history is immutable.
 *
 * `stock_movements_are_immutable_delete` (migration 3) refuses every delete, which is right for real work: a
 * movement is the evidence behind a stock figure. But the optional demo catalogue writes one opening movement
 * per product, and a shop that loads the demo and then decides to start for real has to be able to get back to
 * an empty catalogue — otherwise "load the demo, try it, remove it" would leave permanent rows nobody wants.
 *
 * The escape hatch is narrow on purpose: only movements whose `reference_type` is `DEMO_SEED` may be deleted,
 * and no production code path writes that value. `StockAdjustmentInput` maps to `ADJUSTMENT`, a sale to `SALE`,
 * a return to `RETURN`, a purchase to `PURCHASE_ORDER`. The demo service is the only writer, and it also
 * refuses to remove anything once a *real* movement or sale references a demo product.
 */
export function migrateDemoDataRemoval(database: Database.Database): void {
  database.exec(`
    DROP TRIGGER IF EXISTS stock_movements_are_immutable_delete;

    CREATE TRIGGER stock_movements_are_immutable_delete
    BEFORE DELETE ON stock_movements
    WHEN OLD.reference_type <> 'DEMO_SEED'
    BEGIN
      SELECT RAISE(ABORT, 'Stock movements are immutable');
    END;
  `)
}
