import type Database from 'better-sqlite3'

export function migrateProductInventory(database: Database.Database): void {
  database.exec(`
    ALTER TABLE products ADD COLUMN brand TEXT NOT NULL DEFAULT '';
    ALTER TABLE products ADD COLUMN sub_category TEXT NOT NULL DEFAULT '';
    ALTER TABLE products ADD COLUMN wholesale_price INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(wholesale_price) = 'integer' AND wholesale_price >= 0);
    ALTER TABLE products ADD COLUMN wholesale_min_quantity_milli INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(wholesale_min_quantity_milli) = 'integer' AND wholesale_min_quantity_milli >= 0);
    ALTER TABLE products ADD COLUMN reorder_level_milli INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(reorder_level_milli) = 'integer' AND reorder_level_milli >= 0);
    ALTER TABLE products ADD COLUMN pack_size_units INTEGER NOT NULL DEFAULT 1
      CHECK (typeof(pack_size_units) = 'integer' AND pack_size_units BETWEEN 1 AND 1000000);
    ALTER TABLE products ADD COLUMN expiry_tracking INTEGER NOT NULL DEFAULT 0
      CHECK (expiry_tracking IN (0, 1));
    ALTER TABLE stock_movements ADD COLUMN adjustment_reason TEXT NOT NULL DEFAULT '';
    ALTER TABLE product_barcodes ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1));
    ALTER TABLE product_barcodes ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0);
    ALTER TABLE purchases ADD COLUMN supplier_reference TEXT NOT NULL DEFAULT '';
    ALTER TABLE purchases ADD COLUMN received_note TEXT NOT NULL DEFAULT '';
    ALTER TABLE purchases ADD COLUMN row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0);
    ALTER TABLE purchases ADD COLUMN received_at TEXT;
    ALTER TABLE purchase_items ADD COLUMN received_quantity_milli INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(received_quantity_milli) = 'integer' AND received_quantity_milli >= 0);
    ALTER TABLE purchase_items ADD COLUMN batch_number TEXT NOT NULL DEFAULT '';
    ALTER TABLE purchase_items ADD COLUMN expiry_date TEXT NOT NULL DEFAULT '';

    UPDATE purchase_items SET received_quantity_milli = quantity_milli
      WHERE purchase_id IN (SELECT id FROM purchases WHERE status = 'COMPLETED');

    INSERT OR IGNORE INTO stock (product_id)
      SELECT id FROM products;

    CREATE INDEX IF NOT EXISTS idx_products_name_nocase ON products(name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_product_barcodes_product ON product_barcodes(product_id, barcode);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_product_barcodes_one_primary ON product_barcodes(product_id) WHERE is_primary = 1;
    CREATE INDEX IF NOT EXISTS idx_purchases_supplier_created ON purchases(supplier_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_purchases_status_created ON purchases(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_product_batches_fefo ON product_batches(product_id, expiry_date, created_at);

    CREATE TRIGGER IF NOT EXISTS stock_quantity_cannot_be_negative
    BEFORE UPDATE OF quantity_milli ON stock
    WHEN NEW.quantity_milli < 0
    BEGIN
      SELECT RAISE(ABORT, 'Stock quantity cannot be negative');
    END;

    CREATE TRIGGER IF NOT EXISTS stock_movements_are_immutable_update
    BEFORE UPDATE ON stock_movements
    BEGIN
      SELECT RAISE(ABORT, 'Stock movements are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS stock_movements_are_immutable_delete
    BEFORE DELETE ON stock_movements
    BEGIN
      SELECT RAISE(ABORT, 'Stock movements are immutable');
    END;
  `)
}
