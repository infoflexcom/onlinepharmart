import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { Workbook } from 'exceljs'
import { formatMoney, roundHalfUp } from '../currency/money'
import { parseMoneyExact } from '../currency/parse'
import type { Edition } from '../editions'
import type { ShopRepository } from './contracts/shop-repository'
import { IdempotencyGuard } from './idempotency'
import type {
  InventoryActor,
  ConsumeStockInput,
  FEFOSaleAllocation,
  FEFOSaleResult,
  InventoryAlert,
  InventoryOverview,
  ProductDraft,
  ProductImportReport,
  ProductRecord,
  ProductVariantDraft,
  ProductVariantRecord,
  PurchaseOrderDraft,
  PurchaseOrderRecord,
  PurchaseOrderReceiptInput,
  ReceiveStockInput,
  SellableBatch,
  StockAdjustmentInput,
  StockMutationResult,
  StocktakeInput,
  StocktakeVarianceRecord,
  SupplierOption,
  WeighedPriceResult,
} from '../shared/inventory/types'

const MAX_SQLITE_INTEGER = 9_223_372_036_854_775_807n
const NEAR_EXPIRY_DAYS = 90

export interface ProductInventoryServiceOptions {
  deviceName?: string
  now?: () => number
  newId?: () => string
}

interface ProductRow {
  id: string
  sku: string
  name: string
  brand: string
  description: string
  category: string | null
  sub_category: string
  department: string | null
  shelf_location: string
  unit: string
  pack_size_units: number
  cost_text: string
  sale_price_text: string
  wholesale_price_text: string
  wholesale_min_text: string
  reorder_level_text: string
  quantity_text: string
  reserved_text: string
  row_version: number
  stock_version: number
  generic_name: string
  prescription_required: number
  weighed_item: number
  plu_code: string | null
  price_per_kg_text: string | null
  expiry_tracking: number
  is_active: number
}

interface VariantRow {
  id: string
  variant_code: string
  label: string
  attributes_json: string
  sale_price_text: string | null
  row_version: number
}

interface NormalizedProduct {
  sku: string
  name: string
  brand: string
  description: string
  barcodeList: string[]
  category: string
  subCategory: string
  department: string
  shelfLocation: string
  unit: string
  packSizeUnits: number
  costMinor: bigint
  retailPriceMinor: bigint
  wholesalePriceMinor: bigint
  wholesaleMinimumQuantityMilli: bigint
  reorderLevelMilli: bigint
  genericName: string
  prescriptionRequired: boolean
  weighedItem: boolean
  pluCode: string
  pricePerKgMinor: bigint | null
  expiryTracking: boolean
  variants: Array<{ code: string; label: string; attributes: Record<string, string>; priceMinor: bigint | null }>
  isActive: boolean
}

export class ProductInventoryService {
  private readonly now: () => number
  private readonly newId: () => string
  private readonly deviceName: string
  private readonly idempotency: IdempotencyGuard

  constructor(
    private readonly database: Database.Database,
    private readonly shop: ShopRepository,
    options: ProductInventoryServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.newId = options.newId ?? randomUUID
    this.deviceName = cleanText(options.deviceName ?? 'LOCAL_DESKTOP', 120) || 'LOCAL_DESKTOP'
    this.idempotency = new IdempotencyGuard(database, () => new Date(this.now()))
  }

  getOverview(actor: InventoryActor, edition: Edition, search = ''): InventoryOverview {
    return {
      edition,
      products: this.listProducts(actor, edition, search),
      alerts: this.getAlerts(edition),
      suppliers: this.listSuppliers(),
      categories: this.listCategories(),
      departments: supportsSupermarket(edition) ? this.listDepartments() : [],
    }
  }

  listProducts(actor: InventoryActor, edition: Edition, search = ''): ProductRecord[] {
    validateActor(actor)
    validateEdition(edition)
    const query = normalizeSearch(search)
    const pattern = `%${escapeLike(query)}%`
    const rows = this.database.prepare(`
      SELECT p.id, p.sku, p.name, p.brand, p.description,
        parent.name AS category, p.sub_category, d.name AS department,
        p.shelf_location, p.unit, p.pack_size_units,
        CAST(p.cost AS TEXT) AS cost_text,
        CAST(p.sale_price AS TEXT) AS sale_price_text,
        CAST(p.wholesale_price AS TEXT) AS wholesale_price_text,
        CAST(p.wholesale_min_quantity_milli AS TEXT) AS wholesale_min_text,
        CAST(p.reorder_level_milli AS TEXT) AS reorder_level_text,
        CAST(COALESCE(s.quantity_milli, 0) AS TEXT) AS quantity_text,
        CAST(COALESCE(s.reserved_milli, 0) AS TEXT) AS reserved_text,
        p.row_version, COALESCE(s.row_version, 1) AS stock_version,
        p.generic_name, p.prescription_required, p.weighed_item, p.plu_code,
        CAST(p.price_per_kg AS TEXT) AS price_per_kg_text,
        p.expiry_tracking, p.is_active
      FROM products p
      LEFT JOIN categories parent ON parent.id = p.category_id
      LEFT JOIN departments d ON d.id = p.department_id
      LEFT JOIN stock s ON s.product_id = p.id
      WHERE (? = '' OR p.name LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR p.brand LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR p.generic_name LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR p.sku LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR COALESCE(p.plu_code, '') LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR EXISTS (SELECT 1 FROM product_barcodes b WHERE b.product_id = p.id AND b.barcode LIKE ? ESCAPE '\\' COLLATE NOCASE))
      ORDER BY p.name COLLATE NOCASE, p.sku COLLATE NOCASE
      LIMIT 1000
    `).all(query, pattern, pattern, pattern, pattern, pattern, pattern) as ProductRow[]

    return rows.map((row) => this.mapProduct(row, actor, edition))
  }

  createProduct(draft: ProductDraft, actor: InventoryActor, edition: Edition): ProductRecord {
    assertAdmin(actor)
    const settings = this.shop.readSettings()
    const normalized = normalizeProductDraft(draft, settings.currency, settings.display, edition)
    const id = this.newId()
    this.database.transaction(() => {
      this.assertUniqueProductFields(normalized, null)
      const categoryId = this.ensureCategory(normalized.category)
      const departmentId = supportsSupermarket(edition) ? this.ensureDepartment(normalized.department) : null
      this.database.prepare(`
        INSERT INTO products (
          id, sku, name, brand, description, category_id, sub_category, department_id,
          shelf_location, unit, pack_size_units, cost, sale_price, wholesale_price,
          wholesale_min_quantity_milli, reorder_level_milli, generic_name,
          prescription_required, weighed_item, plu_code, price_per_kg, expiry_tracking, is_active
        ) VALUES (
          @id, @sku, @name, @brand, @description, @categoryId, @subCategory, @departmentId,
          @shelfLocation, @unit, @packSizeUnits, @cost, @retailPrice, @wholesalePrice,
          @wholesaleMinimumQuantity, @reorderLevel, @genericName,
          @prescriptionRequired, @weighedItem, @pluCode, @pricePerKg, @expiryTracking, @isActive
        )
      `).run({
        id,
        sku: normalized.sku,
        name: normalized.name,
        brand: normalized.brand,
        description: normalized.description,
        categoryId,
        subCategory: normalized.subCategory,
        departmentId,
        shelfLocation: normalized.shelfLocation,
        unit: normalized.unit,
        packSizeUnits: normalized.packSizeUnits,
        cost: normalized.costMinor,
        retailPrice: normalized.retailPriceMinor,
        wholesalePrice: normalized.wholesalePriceMinor,
        wholesaleMinimumQuantity: normalized.wholesaleMinimumQuantityMilli,
        reorderLevel: normalized.reorderLevelMilli,
        genericName: normalized.genericName,
        prescriptionRequired: normalized.prescriptionRequired ? 1 : 0,
        weighedItem: normalized.weighedItem ? 1 : 0,
        pluCode: normalized.pluCode || null,
        pricePerKg: normalized.pricePerKgMinor,
        expiryTracking: normalized.expiryTracking ? 1 : 0,
        isActive: normalized.isActive ? 1 : 0,
      })
      this.database.prepare('INSERT INTO stock (product_id) VALUES (?)').run(id)
      this.replaceBarcodes(id, normalized.barcodeList)
      this.replaceVariants(id, normalized.variants)
      this.recordAudit(actor, 'product.created', {
        productId: id,
        sku: normalized.sku,
        prices: { old: null, new: priceSnapshot(normalized) },
        currencyCode: settings.currency.code,
        deviceName: this.deviceName,
      })
    }).immediate()
    return this.getProduct(id, actor, edition)
  }

  updateProduct(draft: ProductDraft, actor: InventoryActor, edition: Edition): ProductRecord {
    assertAdmin(actor)
    if (!draft.id || !Number.isInteger(draft.expectedVersion) || draft.expectedVersion! < 1) {
      throw new Error('Reload this product before saving the edit.')
    }
    const settings = this.shop.readSettings()
    const normalized = normalizeProductDraft(draft, settings.currency, settings.display, edition)
    const productId = cleanText(draft.id, 120)
    this.database.transaction(() => {
      const existing = this.requireProductRow(productId)
      if (existing.row_version !== draft.expectedVersion) throw staleProductConflict()
      this.assertUniqueProductFields(normalized, productId)
      const oldVariants = this.variantPriceSnapshot(productId)
      const previousPrices = priceSnapshotFromRow(existing, oldVariants)
      const nextPrices = priceSnapshot(normalized)
      const categoryId = this.ensureCategory(normalized.category)
      const departmentId = supportsSupermarket(edition) ? this.ensureDepartment(normalized.department) : null
      const result = this.database.prepare(`
        UPDATE products SET
          sku = @sku, name = @name, brand = @brand, description = @description,
          category_id = @categoryId, sub_category = @subCategory, department_id = @departmentId,
          shelf_location = @shelfLocation, unit = @unit, pack_size_units = @packSizeUnits,
          cost = @cost, sale_price = @retailPrice, wholesale_price = @wholesalePrice,
          wholesale_min_quantity_milli = @wholesaleMinimumQuantity,
          reorder_level_milli = @reorderLevel, generic_name = @genericName,
          prescription_required = @prescriptionRequired, weighed_item = @weighedItem,
          plu_code = @pluCode, price_per_kg = @pricePerKg, expiry_tracking = @expiryTracking,
          is_active = @isActive, row_version = row_version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = @id AND row_version = @expectedVersion
      `).run({
        id: productId,
        expectedVersion: draft.expectedVersion,
        sku: normalized.sku,
        name: normalized.name,
        brand: normalized.brand,
        description: normalized.description,
        categoryId,
        subCategory: normalized.subCategory,
        departmentId,
        shelfLocation: normalized.shelfLocation,
        unit: normalized.unit,
        packSizeUnits: normalized.packSizeUnits,
        cost: normalized.costMinor,
        retailPrice: normalized.retailPriceMinor,
        wholesalePrice: normalized.wholesalePriceMinor,
        wholesaleMinimumQuantity: normalized.wholesaleMinimumQuantityMilli,
        reorderLevel: normalized.reorderLevelMilli,
        genericName: normalized.genericName,
        prescriptionRequired: normalized.prescriptionRequired ? 1 : 0,
        weighedItem: normalized.weighedItem ? 1 : 0,
        pluCode: normalized.pluCode || null,
        pricePerKg: normalized.pricePerKgMinor,
        expiryTracking: normalized.expiryTracking ? 1 : 0,
        isActive: normalized.isActive ? 1 : 0,
      })
      if (result.changes !== 1) throw staleProductConflict()
      this.replaceBarcodes(productId, normalized.barcodeList)
      this.replaceVariants(productId, normalized.variants)
      this.recordAudit(actor, 'product.updated', {
        productId,
        sku: normalized.sku,
        prices: { old: previousPrices, new: nextPrices },
      })
      if (previousPrices.costMinor !== nextPrices.costMinor) {
        this.recordAudit(actor, 'product.cost.updated', {
          productId,
          sku: normalized.sku,
          oldCostMinor: previousPrices.costMinor,
          newCostMinor: nextPrices.costMinor,
          currencyCode: settings.currency.code,
          deviceName: this.deviceName,
        })
      }
      if (productPriceSnapshotChanged(previousPrices, nextPrices)) {
        this.recordAudit(actor, 'product.price.updated', {
          productId,
          sku: normalized.sku,
          oldPrices: previousPrices,
          newPrices: nextPrices,
          currencyCode: settings.currency.code,
          deviceName: this.deviceName,
        })
      }
    }).immediate()
    return this.getProduct(productId, actor, edition)
  }

  importProductsCsv(csv: string, actor: InventoryActor, edition: Edition): ProductImportReport {
    assertAdmin(actor)
    validateEdition(edition)
    if (typeof csv !== 'string' || Buffer.byteLength(csv, 'utf8') > 10_000_000) {
      throw new Error('Choose a product CSV file no larger than 10 MB.')
    }
    const rows = parseCsv(csv)
    if (rows.length < 2) throw new Error('The CSV must include a header and at least one product row.')
    const headers = validateImportHeaders(rows[0]!, 'CSV')
    const errors: ProductImportReport['errors'] = []
    let imported = 0
    for (let index = 1; index < rows.length; index += 1) {
      const fields = rows[index]!
      if (fields.every((field) => !field.trim())) continue
      try {
        const row = Object.fromEntries(headers.map((header, column) => [header, fields[column] ?? '']))
        this.createProduct(csvRowToDraft(row), actor, edition)
        imported += 1
      } catch (error) {
        errors.push({ row: index + 1, message: error instanceof Error ? error.message : 'This row could not be imported.' })
      }
    }
    return { imported, errors }
  }

  async importProductsExcel(contents: Uint8Array, actor: InventoryActor, edition: Edition): Promise<ProductImportReport> {
    assertAdmin(actor)
    validateEdition(edition)
    if (!(contents instanceof Uint8Array) || contents.byteLength === 0 || contents.byteLength > 10_000_000) {
      throw new Error('Choose a valid Excel workbook no larger than 10 MB.')
    }
    const workbook = new Workbook()
    try {
      const copy = new Uint8Array(contents.byteLength)
      copy.set(contents)
      await workbook.xlsx.load(copy.buffer)
    } catch {
      throw new Error('The Excel file could not be opened. Choose a valid .xlsx workbook.')
    }
    const worksheet = workbook.worksheets[0]
    if (!worksheet || worksheet.rowCount < 2) throw new Error('The Excel workbook needs a header and at least one product row.')
    if (worksheet.rowCount > 10_001 || worksheet.columnCount > 100) {
      throw new Error('The Excel workbook exceeds the 10,000-row or 100-column import limit.')
    }
    const headerValues: string[] = []
    for (let column = 1; column <= worksheet.columnCount; column += 1) {
      headerValues.push(excelCellToText(worksheet.getRow(1).getCell(column).value, 1, column))
    }
    const headers = validateImportHeaders(headerValues, 'Excel')
    const errors: ProductImportReport['errors'] = []
    let imported = 0
    for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
      try {
        const row = worksheet.getRow(rowNumber)
        const values = headers.map((_header, index) => excelCellToText(row.getCell(index + 1).value, rowNumber, index + 1))
        if (values.every((value) => !value.trim())) continue
        const record = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']))
        this.createProduct(csvRowToDraft(record), actor, edition)
        imported += 1
      } catch (error) {
        errors.push({ row: rowNumber, message: error instanceof Error ? error.message : 'This row could not be imported.' })
      }
    }
    return { imported, errors }
  }

  exportProductsCsv(actor: InventoryActor, edition: Edition): string {
    const settings = this.shop.readSettings()
    const products = this.listProducts(actor, edition)
    const rows = buildProductExportRows(products, actor, edition, settings)
    return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`
  }

  async exportProductsExcel(actor: InventoryActor, edition: Edition): Promise<string> {
    const settings = this.shop.readSettings()
    const products = this.listProducts(actor, edition)
    const workbook = new Workbook()
    workbook.creator = 'Infoflex'
    workbook.created = new Date(this.now())
    const worksheet = workbook.addWorksheet('Products')
    worksheet.addRows(buildProductExportRows(products, actor, edition, settings))
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
    worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3F73' } }
    worksheet.views = [{ state: 'frozen', ySplit: 1 }]
    if (worksheet.columnCount > 0) worksheet.autoFilter = { from: 'A1', to: `${columnLetter(worksheet.columnCount)}1` }
    const bytes = await workbook.xlsx.writeBuffer()
    return Buffer.from(bytes).toString('base64')
  }

  listSuppliers(): SupplierOption[] {
    return (this.database.prepare(`
      SELECT id, name, phone, email FROM suppliers WHERE is_active = 1 ORDER BY name COLLATE NOCASE
    `).all() as SupplierOption[]).map((supplier) => ({ ...supplier }))
  }

  listPurchaseOrders(actor: InventoryActor, edition: Edition): PurchaseOrderRecord[] {
    assertAdmin(actor)
    requireSupermarketEdition(edition)
    const ids = this.database.prepare(`
      SELECT CAST(p.id AS TEXT) AS id FROM purchases p ORDER BY p.created_at DESC, p.id DESC LIMIT 200
    `).all() as Array<{ id: string }>
    return ids.map(({ id }) => this.getPurchaseOrder(id, actor, edition))
  }

  createPurchaseOrder(draft: PurchaseOrderDraft, actor: InventoryActor, edition: Edition): PurchaseOrderRecord {
    assertAdmin(actor)
    requireSupermarketEdition(edition)
    const settings = this.shop.readSettings()
    const supplierName = requiredText(draft?.supplierName, 'Supplier name', 120)
    const supplierReference = cleanText(draft?.supplierReference, 120)
    const note = cleanText(draft?.note, 500)
    if (!Array.isArray(draft?.items) || draft.items.length < 1 || draft.items.length > 100) {
      throw new Error('A purchase order must contain between 1 and 100 product lines.')
    }
    const lines = draft.items.map((line) => {
      const productId = cleanText(line?.productId, 120)
      const product = this.requireProductRow(productId)
      if (product.is_active !== 1) throw new Error(`${product.name} is inactive and cannot be ordered.`)
      if (line.quantityUnit !== 'unit' && line.quantityUnit !== 'pack') throw new Error('Choose units or packs for each order line.')
      const enteredQuantity = parseQuantityMilli(line.quantity)
      if (enteredQuantity <= 0n) throw new Error('Order quantities must be greater than zero.')
      const quantityMilli = enteredQuantity * BigInt(line.quantityUnit === 'pack' ? product.pack_size_units : 1)
      assertSqliteInteger(quantityMilli, 'Ordered quantity')
      const unitCostMinor = parseMoneyExact(line.unitCost, settings.currency, settings.display)
      if (unitCostMinor < 0n) throw new Error('Unit cost cannot be negative.')
      assertSqliteInteger(unitCostMinor, 'Unit cost')
      const lineTotalMinor = roundHalfUp(unitCostMinor * quantityMilli, 1000n)
      assertSqliteInteger(lineTotalMinor, 'Purchase order line total')
      return { productId, product, quantityMilli, unitCostMinor, lineTotalMinor }
    })
    const totalMinor = lines.reduce((total, line) => total + line.lineTotalMinor, 0n)
    assertSqliteInteger(totalMinor, 'Purchase order total')
    let purchaseId = 0
    this.database.transaction(() => {
      const supplierId = this.ensureSupplier(supplierName)
      const result = this.database.prepare(`
        INSERT INTO purchases (
          supplier_id, status, currency_code, subtotal, tax, total,
          supplier_reference, received_note, row_version
        ) VALUES (?, 'DRAFT', ?, ?, 0, ?, ?, ?, 1)
      `).run(supplierId, settings.currency.code, totalMinor, totalMinor, supplierReference, note)
      purchaseId = Number(result.lastInsertRowid)
      const insertItem = this.database.prepare(`
        INSERT INTO purchase_items (
          id, purchase_id, product_id, description_snapshot, quantity_milli, unit_cost, line_total, received_quantity_milli
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      `)
      for (const line of lines) {
        insertItem.run(this.newId(), purchaseId, line.productId, line.product.name, line.quantityMilli,
          line.unitCostMinor, line.lineTotalMinor)
      }
      const reference = (this.database.prepare('SELECT purchase_number FROM purchases WHERE id = ?').get(purchaseId) as { purchase_number: string }).purchase_number
      this.recordAudit(actor, 'inventory.purchase_order.created', {
        purchaseId: String(purchaseId),
        reference,
        supplier: supplierName,
        supplierReference,
        currencyCode: settings.currency.code,
        totalMinor: totalMinor.toString(),
        lineCount: lines.length,
        deviceName: this.deviceName,
      })
    }).immediate()
    return this.getPurchaseOrder(String(purchaseId), actor, edition)
  }

  receivePurchaseOrder(input: PurchaseOrderReceiptInput, actor: InventoryActor, edition: Edition): PurchaseOrderRecord {
    assertAdmin(actor)
    requireSupermarketEdition(edition)
    if (!Number.isInteger(input?.expectedVersion) || input.expectedVersion < 1) throw new Error('Reload this purchase order before receiving it.')
    const purchaseId = normalizePurchaseId(input.purchaseId)
    const settings = this.shop.readSettings()
    const supplierReference = cleanText(input.supplierReference, 120)
    const receivedNote = cleanText(input.receivedNote, 500)
    if (!Array.isArray(input.items)) throw new Error('Enter received batch details for each purchase order line.')
    const receiptByItem = new Map<string, { batchNumber: string; expiryDate: string }>()
    for (const item of input.items) {
      const itemId = cleanText(item?.purchaseItemId, 120)
      if (!itemId || receiptByItem.has(itemId)) throw new Error('Each purchase order line must appear exactly once on the goods-received note.')
      receiptByItem.set(itemId, { batchNumber: cleanText(item.batchNumber, 80), expiryDate: cleanText(item.expiryDate, 10) })
    }
    let purchaseNumber = ''
    this.database.transaction(() => {
      const purchase = this.database.prepare(`
        SELECT id, purchase_number, supplier_id, status, row_version, supplier_reference, received_note,
          currency_code, CAST(total AS TEXT) AS total_text
        FROM purchases WHERE id = ?
      `).get(Number(purchaseId)) as {
        id: number; purchase_number: string; supplier_id: string | null; status: string; row_version: number
        supplier_reference: string; received_note: string; currency_code: string; total_text: string
      } | undefined
      if (!purchase) throw new Error('This purchase order could not be found.')
      if (purchase.status !== 'DRAFT' || purchase.row_version !== input.expectedVersion) throw stalePurchaseOrderConflict()
      if (purchase.currency_code !== settings.currency.code) throw new Error('The shop currency changed after this order was created. Recreate the purchase order in the current currency.')
      const items = this.database.prepare(`
        SELECT id, product_id, CAST(quantity_milli AS TEXT) AS quantity_text,
          CAST(unit_cost AS TEXT) AS unit_cost_text, CAST(line_total AS TEXT) AS line_total_text
        FROM purchase_items WHERE purchase_id = ? ORDER BY rowid
      `).all(purchase.id) as Array<{
        id: string; product_id: string; quantity_text: string; unit_cost_text: string; line_total_text: string
      }>
      if (items.length === 0 || receiptByItem.size !== items.length || items.some((item) => !receiptByItem.has(item.id))) {
        throw new Error('The goods-received note must include every line on this purchase order exactly once.')
      }
      const supplier = purchase.supplier_id
        ? this.database.prepare('SELECT name FROM suppliers WHERE id = ?').get(purchase.supplier_id) as { name: string } | undefined
        : undefined
      if (!supplier) throw new Error('The purchase order supplier could not be found.')
      purchaseNumber = purchase.purchase_number
      let calculatedTotal = 0n
      for (const item of items) {
        const product = this.requireProductRow(item.product_id)
        const quantityMilli = BigInt(item.quantity_text)
        const unitCostMinor = BigInt(item.unit_cost_text)
        const lineTotalMinor = BigInt(item.line_total_text)
        const receipt = receiptByItem.get(item.id)!
        const expiryTracked = requiresExpiryTracking(product, edition)
        if (expiryTracked) validateBatchDetails(receipt.batchNumber, receipt.expiryDate)
        else if (receipt.batchNumber || receipt.expiryDate) throw new Error(`${product.name} does not use batch/expiry tracking in this edition.`)
        assertSqliteInteger(BigInt(product.quantity_text) + quantityMilli, 'New stock quantity')
        this.addToBatch(product, quantityMilli, unitCostMinor, receipt.batchNumber, receipt.expiryDate, expiryTracked)
        const costUpdate = this.database.prepare(`
          UPDATE products SET cost = ?, row_version = row_version + 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND row_version = ?
        `).run(unitCostMinor, product.id, product.row_version)
        if (costUpdate.changes !== 1) throw staleProductConflict()
        this.updateStockQuantity(product.id, product.stock_version, quantityMilli)
        this.database.prepare(`
          UPDATE purchase_items SET received_quantity_milli = ?, batch_number = ?, expiry_date = ? WHERE id = ? AND purchase_id = ?
        `).run(quantityMilli, receipt.batchNumber, receipt.expiryDate, item.id, purchase.id)
        this.database.prepare(`
          INSERT INTO stock_movements (
            id, product_id, movement_type, reference_type, reference_id, quantity_delta_milli,
            unit_cost, currency_code, created_by, adjustment_reason
          ) VALUES (?, ?, 'PURCHASE', 'PURCHASE_ORDER', ?, ?, ?, ?, ?, '')
        `).run(this.newId(), product.id, purchaseNumber, quantityMilli, unitCostMinor, settings.currency.code, actor.id)
        if (unitCostMinor !== BigInt(product.cost_text)) {
          this.recordAudit(actor, 'product.cost.updated', {
            productId: product.id,
            sku: product.sku,
            oldCostMinor: product.cost_text,
            newCostMinor: unitCostMinor.toString(),
            currencyCode: settings.currency.code,
            deviceName: this.deviceName,
          })
        }
        calculatedTotal += lineTotalMinor
      }
      const completed = this.database.prepare(`
        UPDATE purchases SET status = 'COMPLETED', received_by = ?, received_at = ?,
          supplier_reference = ?, received_note = ?, row_version = row_version + 1
        WHERE id = ? AND status = 'DRAFT' AND row_version = ?
      `).run(actor.id, this.isoNow(), supplierReference || purchase.supplier_reference,
        receivedNote || purchase.received_note, purchase.id, input.expectedVersion)
      if (completed.changes !== 1) throw stalePurchaseOrderConflict()
      this.insertBusinessEntry(purchaseNumber, calculatedTotal, settings)
      this.recordAudit(actor, 'inventory.purchase_order.received', {
        purchaseId: String(purchase.id),
        reference: purchaseNumber,
        supplier: supplier.name,
        supplierReference: supplierReference || purchase.supplier_reference,
        totalMinor: calculatedTotal.toString(),
        currencyCode: settings.currency.code,
        lineCount: items.length,
        deviceName: this.deviceName,
      })
    }).immediate()
    return this.getPurchaseOrder(purchaseId, actor, edition)
  }

  private getPurchaseOrder(purchaseId: string, actor: InventoryActor, edition: Edition): PurchaseOrderRecord {
    requireSupermarketEdition(edition)
    validateActor(actor)
    const purchase = this.database.prepare(`
      SELECT p.id, p.purchase_number, COALESCE(s.name, '') AS supplier_name,
        p.supplier_reference, p.received_note, p.status, p.row_version, p.currency_code,
        CAST(p.total AS TEXT) AS total_text, p.created_at, p.received_at
      FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id
      WHERE p.id = ?
    `).get(Number(purchaseId)) as {
      id: number; purchase_number: string; supplier_name: string; supplier_reference: string; received_note: string
      status: 'DRAFT' | 'COMPLETED' | 'CANCELLED'; row_version: number; currency_code: string
      total_text: string; created_at: string; received_at: string | null
    } | undefined
    if (!purchase) throw new Error('This purchase order could not be found.')
    const items = this.database.prepare(`
      SELECT i.id, i.product_id, i.description_snapshot, p.sku, p.name, p.unit, p.pack_size_units,
        CAST(i.quantity_milli AS TEXT) AS quantity_text, CAST(i.unit_cost AS TEXT) AS unit_cost_text,
        CAST(i.line_total AS TEXT) AS line_total_text, CAST(i.received_quantity_milli AS TEXT) AS received_text,
        i.batch_number, i.expiry_date
      FROM purchase_items i JOIN products p ON p.id = i.product_id
      WHERE i.purchase_id = ? ORDER BY i.rowid
    `).all(purchase.id) as Array<{
      id: string; product_id: string; description_snapshot: string; sku: string; name: string; unit: string; pack_size_units: number
      quantity_text: string; unit_cost_text: string; line_total_text: string; received_text: string; batch_number: string; expiry_date: string
    }>
    return {
      id: String(purchase.id),
      reference: purchase.purchase_number,
      supplierName: purchase.supplier_name,
      supplierReference: purchase.supplier_reference,
      note: purchase.received_note,
      status: purchase.status,
      rowVersion: purchase.row_version,
      currencyCode: purchase.currency_code,
      totalMinor: actor.role === 'ADMIN' ? BigInt(purchase.total_text) : null,
      createdAt: purchase.created_at,
      receivedAt: purchase.received_at,
      items: items.map((item) => ({
        id: item.id,
        productId: item.product_id,
        sku: item.sku,
        productName: item.name || item.description_snapshot,
        quantityMilli: BigInt(item.quantity_text),
        unitCostMinor: actor.role === 'ADMIN' ? BigInt(item.unit_cost_text) : null,
        lineTotalMinor: actor.role === 'ADMIN' ? BigInt(item.line_total_text) : null,
        receivedQuantityMilli: BigInt(item.received_text),
        unit: item.unit,
        packSizeUnits: item.pack_size_units,
        batchNumber: item.batch_number,
        expiryDate: item.expiry_date,
      })),
    }
  }

  getAlerts(edition: Edition): InventoryAlert[] {
    validateEdition(edition)
    const lowStockRows = this.database.prepare(`
      SELECT p.id, p.sku, p.name, p.unit,
        CAST(COALESCE(s.quantity_milli, 0) AS TEXT) AS quantity_text,
        CAST(p.reorder_level_milli AS TEXT) AS reorder_text
      FROM products p LEFT JOIN stock s ON s.product_id = p.id
      WHERE p.is_active = 1 AND COALESCE(s.quantity_milli, 0) <= p.reorder_level_milli
      ORDER BY p.name COLLATE NOCASE
    `).all() as Array<{ id: string; sku: string; name: string; unit: string; quantity_text: string; reorder_text: string }>
    const alerts: InventoryAlert[] = lowStockRows.map((row) => ({
      type: 'low_stock', productId: row.id, sku: row.sku, productName: row.name,
      quantityMilli: BigInt(row.quantity_text), reorderLevelMilli: BigInt(row.reorder_text), unit: row.unit,
    }))

    const today = this.today()
    const cutoff = addCalendarDays(today, NEAR_EXPIRY_DAYS)
    const expiryRows = this.database.prepare(`
      SELECT b.id AS batch_id, b.product_id, p.sku, p.name, p.unit, b.batch_no, b.expiry_date,
        CAST(b.quantity_milli AS TEXT) AS quantity_text
      FROM product_batches b JOIN products p ON p.id = b.product_id
      WHERE p.is_active = 1 AND b.quantity_milli > 0 AND b.expiry_date <= ?
        AND (? = 'PHARMACY'
          OR (? = 'BOTH' AND (p.expiry_tracking = 1 OR p.prescription_required = 1 OR p.generic_name <> ''))
          OR (? = 'SUPERMARKET' AND p.expiry_tracking = 1))
      ORDER BY b.expiry_date, p.name COLLATE NOCASE
    `).all(cutoff, edition, edition, edition) as Array<{
      batch_id: string; product_id: string; sku: string; name: string; unit: string
      batch_no: string; expiry_date: string; quantity_text: string
    }>
    for (const row of expiryRows) {
      const expired = row.expiry_date < today
      alerts.push({
        type: expired ? 'expired' : 'near_expiry',
        productId: row.product_id,
        sku: row.sku,
        productName: row.name,
        batchId: row.batch_id,
        batchNumber: row.batch_no,
        expiryDate: row.expiry_date,
        quantityMilli: BigInt(row.quantity_text),
        unit: row.unit,
      })
    }
    return alerts
  }

  getStocktakeVarianceReport(actor: InventoryActor, edition: Edition): StocktakeVarianceRecord[] {
    validateActor(actor)
    validateEdition(edition)
    const rows = this.database.prepare(`
      SELECT actor, metadata_json, device_name, created_at
      FROM audit_log WHERE action = 'inventory.stocktake.completed'
      ORDER BY created_at DESC LIMIT 500
    `).all() as Array<{ actor: string; metadata_json: string; device_name: string; created_at: string }>
    const report: StocktakeVarianceRecord[] = []
    for (const row of rows) {
      try {
        const data = JSON.parse(row.metadata_json) as Record<string, unknown>
        if (typeof data.productId !== 'string' || typeof data.sku !== 'string'
          || typeof data.expectedQuantityMilli !== 'string' || typeof data.countedQuantityMilli !== 'string'
          || typeof data.varianceMilli !== 'string' || typeof data.reason !== 'string') continue
        const product = this.database.prepare('SELECT name FROM products WHERE id = ?').get(data.productId) as { name: string } | undefined
        report.push({
          productId: data.productId,
          sku: data.sku,
          productName: product?.name ?? data.sku,
          expectedQuantityMilli: BigInt(data.expectedQuantityMilli),
          countedQuantityMilli: BigInt(data.countedQuantityMilli),
          varianceMilli: BigInt(data.varianceMilli),
          reason: data.reason,
          actor: row.actor,
          deviceName: row.device_name,
          createdAt: row.created_at,
        })
      } catch {
        // Ignore malformed historical audit records while keeping valid reports available.
      }
    }
    return report
  }

  getSellableBatches(productId: string, edition: Edition): SellableBatch[] {
    validateEdition(edition)
    const product = this.requireProductRow(productId)
    if (!requiresExpiryTracking(product, edition)) {
      return [{ batchId: null, batchNumber: null, expiryDate: null, quantityMilli: BigInt(product.quantity_text), unitCostMinor: BigInt(product.cost_text) }]
    }
    const today = this.today()
    return (this.database.prepare(`
      SELECT id, batch_no, expiry_date, CAST(quantity_milli AS TEXT) AS quantity_text,
        CAST(cost AS TEXT) AS cost_text
      FROM product_batches WHERE product_id = ? AND quantity_milli > 0 AND expiry_date >= ?
      ORDER BY expiry_date ASC, created_at ASC, id ASC
    `).all(productId, today) as Array<{
      id: string; batch_no: string; expiry_date: string; quantity_text: string; cost_text: string
    }>).map((row) => ({
      batchId: row.id,
      batchNumber: row.batch_no,
      expiryDate: row.expiry_date,
      quantityMilli: BigInt(row.quantity_text),
      unitCostMinor: BigInt(row.cost_text),
    }))
  }

  consumeStockFEFO(input: ConsumeStockInput, actor: InventoryActor, edition: Edition): FEFOSaleResult {
    validateActor(actor)
    validateEdition(edition)
    const productId = cleanText(input?.productId, 120)
    const quantityMilli = parseQuantityMilli(input?.quantity)
    if (quantityMilli <= 0n) throw new Error('Sale quantity must be greater than zero.')
    const reference = requiredText(input?.reference, 'Sale reference', 120)
    const settings = this.shop.readSettings()
    let allocations: FEFOSaleAllocation[] = []
    this.database.transaction(() => {
      const product = this.requireProductRow(productId)
      if (product.is_active !== 1) throw new Error('This product is inactive and cannot be sold.')
      this.assertExpectedVersions(product, input.expectedProductVersion, input.expectedStockVersion)
      if (requiresExpiryTracking(product, edition)) {
        const rows = this.database.prepare(`
          SELECT id, batch_no, expiry_date, CAST(quantity_milli AS TEXT) AS quantity_text, row_version
          FROM product_batches WHERE product_id = ? AND quantity_milli > 0 AND expiry_date >= ?
          ORDER BY expiry_date ASC, created_at ASC, id ASC
        `).all(productId, this.today()) as Array<{
          id: string; batch_no: string; expiry_date: string; quantity_text: string; row_version: number
        }>
        const sellable = rows.reduce((sum, row) => sum + BigInt(row.quantity_text), 0n)
        if (sellable < quantityMilli) {
          if (BigInt(product.quantity_text) >= quantityMilli) throw new Error('Sale blocked: not enough unexpired batch stock is available.')
          throw new Error('There is not enough stock available to complete this sale.')
        }
        let remaining = quantityMilli
        allocations = []
        for (const batch of rows) {
          if (remaining === 0n) break
          const inBatch = BigInt(batch.quantity_text)
          const take = inBatch < remaining ? inBatch : remaining
          this.decreaseBatch(batch.id, batch.row_version, take)
          allocations.push({ batchId: batch.id, batchNumber: batch.batch_no, expiryDate: batch.expiry_date, quantityMilli: take })
          remaining -= take
        }
      } else {
        if (BigInt(product.quantity_text) < quantityMilli) throw new Error('There is not enough stock available to complete this sale.')
        allocations = [{ batchId: null, batchNumber: null, expiryDate: null, quantityMilli }]
      }
      this.updateStockQuantity(productId, input.expectedStockVersion, -quantityMilli)
      this.database.prepare(`
        INSERT INTO stock_movements (
          id, product_id, movement_type, reference_type, reference_id, quantity_delta_milli,
          unit_cost, currency_code, created_by, adjustment_reason
        ) VALUES (?, ?, 'SALE', 'SALE', ?, ?, ?, ?, ?, '')
      `).run(this.newId(), productId, reference, -quantityMilli, product.cost_text, settings.currency.code, actor.id)
      this.recordAudit(actor, 'inventory.stock.sold', {
        productId,
        sku: product.sku,
        reference,
        quantityMilli: quantityMilli.toString(),
        fefoAllocations: allocations.map((allocation) => ({
          batchId: allocation.batchId,
          batchNumber: allocation.batchNumber,
          expiryDate: allocation.expiryDate,
          quantityMilli: allocation.quantityMilli.toString(),
        })),
        currencyCode: settings.currency.code,
        deviceName: this.deviceName,
      })
    }).immediate()
    return {
      product: this.getProduct(productId, actor, edition),
      reference,
      quantityDeltaMilli: -quantityMilli,
      allocations,
    }
  }

  getWeighedPrice(productId: string, weight: string, edition: Edition): WeighedPriceResult {
    validateEdition(edition)
    const product = this.requireProductRow(cleanText(productId, 120))
    if (!supportsSupermarket(edition) || product.weighed_item !== 1 || product.price_per_kg_text === null) {
      throw new Error('This product is not configured as a weighed item.')
    }
    const weightMilli = parseQuantityMilli(weight)
    if (weightMilli <= 0n) throw new Error('Enter a weight greater than zero.')
    const priceMinor = roundHalfUp(BigInt(product.price_per_kg_text) * weightMilli, 1000n)
    assertSqliteInteger(priceMinor, 'Weighed item price')
    return { productId: product.id, weightMilli, priceMinor, currencyCode: this.shop.readSettings().currency.code }
  }

  receiveStock(input: ReceiveStockInput, actor: InventoryActor, edition: Edition): StockMutationResult {
    assertAdmin(actor)
    validateEdition(edition)
    const settings = this.shop.readSettings()
    const productId = cleanText(input?.productId, 120)
    const supplierName = requiredText(input?.supplierName, 'Supplier name', 120)
    const supplierReference = cleanText(input?.supplierReference, 120)
    const note = cleanText(input?.note, 500)
    const quantityUnit = input?.quantityUnit
    if (quantityUnit !== 'unit' && quantityUnit !== 'pack') throw new Error('Choose units or packs for the received quantity.')
    const rawQuantity = parseQuantityMilli(input?.quantity)
    const rawUnitCost = parseMoneyExact(input?.unitCost, settings.currency, settings.display)
    if (rawQuantity <= 0n) throw new Error('Received quantity must be greater than zero.')
    if (rawUnitCost < 0n) throw new Error('Unit cost cannot be negative.')
    let mutation: { purchaseNumber: string; quantityMilli: bigint }

    this.database.transaction(() => {
      const product = this.requireProductRow(productId)
      this.assertExpectedVersions(product, input.expectedProductVersion, input.expectedStockVersion)
      const quantityMilli = rawQuantity * BigInt(quantityUnit === 'pack' ? product.pack_size_units : 1)
      assertSqliteInteger(quantityMilli, 'Received quantity')
      const currentQuantity = BigInt(product.quantity_text)
      assertSqliteInteger(currentQuantity + quantityMilli, 'New stock quantity')
      const expiryTracked = requiresExpiryTracking(product, edition)
      const batchNumber = cleanText(input.batchNumber, 80)
      const expiryDate = cleanText(input.expiryDate, 10)
      if (expiryTracked) validateBatchDetails(batchNumber, expiryDate)
      else if (batchNumber || expiryDate) throw new Error('Batch and expiry details are available only for expiry-tracked products.')
      const supplierId = this.ensureSupplier(supplierName)
      this.addToBatch(product, quantityMilli, rawUnitCost, batchNumber, expiryDate, expiryTracked)

      const costUpdate = this.database.prepare(`
        UPDATE products SET cost = ?, row_version = row_version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND row_version = ?
      `).run(rawUnitCost, productId, input.expectedProductVersion)
      if (costUpdate.changes !== 1) throw staleProductConflict()
      const stockUpdate = this.database.prepare(`
        UPDATE stock SET quantity_milli = quantity_milli + ?, row_version = row_version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE product_id = ? AND row_version = ?
      `).run(quantityMilli, productId, input.expectedStockVersion)
      if (stockUpdate.changes !== 1) throw staleStockConflict()

      const lineTotal = roundHalfUp(rawUnitCost * quantityMilli, 1000n)
      assertSqliteInteger(lineTotal, 'Purchase total')
      const receivedAt = this.isoNow()
      const purchase = this.database.prepare(`
        INSERT INTO purchases (
          supplier_id, received_by, status, currency_code, subtotal, tax, total,
          supplier_reference, received_note, received_at
        ) VALUES (?, ?, 'COMPLETED', ?, ?, 0, ?, ?, ?, ?)
      `).run(supplierId, actor.id, settings.currency.code, lineTotal, lineTotal, supplierReference, note, receivedAt)
      const purchaseId = Number(purchase.lastInsertRowid)
      const purchaseNumber = (this.database.prepare('SELECT purchase_number FROM purchases WHERE id = ?').get(purchaseId) as { purchase_number: string }).purchase_number
      this.database.prepare(`
        INSERT INTO purchase_items (
          id, purchase_id, product_id, description_snapshot, quantity_milli, unit_cost, line_total,
          received_quantity_milli, batch_number, expiry_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(this.newId(), purchaseId, productId, product.name, quantityMilli, rawUnitCost, lineTotal,
        quantityMilli, batchNumber, expiryDate)
      this.database.prepare(`
        INSERT INTO stock_movements (
          id, product_id, movement_type, reference_type, reference_id, quantity_delta_milli,
          unit_cost, currency_code, created_by, adjustment_reason
        ) VALUES (?, ?, 'PURCHASE', 'PURCHASE', ?, ?, ?, ?, ?, '')
      `).run(this.newId(), productId, purchaseNumber, quantityMilli, rawUnitCost, settings.currency.code, actor.id)
      this.insertBusinessEntry(purchaseNumber, lineTotal, settings)
      this.recordAudit(actor, 'inventory.stock_received', {
        productId,
        sku: product.sku,
        supplier: supplierName,
        supplierReference,
        purchaseNumber,
        quantityMilli: quantityMilli.toString(),
        quantityUnit,
        unitCostMinor: rawUnitCost.toString(),
        lineTotalMinor: lineTotal.toString(),
        currencyCode: settings.currency.code,
        batchNumber: batchNumber || null,
        expiryDate: expiryDate || null,
        deviceName: this.deviceName,
      })
      if (rawUnitCost !== BigInt(product.cost_text)) {
        this.recordAudit(actor, 'product.cost.updated', {
          productId,
          sku: product.sku,
          oldCostMinor: product.cost_text,
          newCostMinor: rawUnitCost.toString(),
          currencyCode: settings.currency.code,
          deviceName: this.deviceName,
        })
      }
      mutation = { purchaseNumber, quantityMilli }
    }).immediate()

    return {
      product: this.getProduct(productId, actor, edition),
      reference: mutation!.purchaseNumber,
      quantityDeltaMilli: mutation!.quantityMilli,
    }
  }

  /**
   * Adjusts stock once per idempotency key. A retry with the same key returns the original result rather than
   * moving stock a second time; the version checks below still protect two *different* concurrent edits.
   */
  adjustStock(input: StockAdjustmentInput, actor: InventoryActor, edition: Edition): StockMutationResult {
    return this.idempotency.run({
      scope: 'stock.adjust',
      key: input?.idempotencyKey,
      request: { ...input, idempotencyKey: undefined, actorId: actor?.id },
      execute: () => this.adjustStockUncached(input, actor, edition),
    }).response
  }

  private adjustStockUncached(input: StockAdjustmentInput, actor: InventoryActor, edition: Edition): StockMutationResult {
    assertAdmin(actor)
    validateEdition(edition)
    const reason = requiredText(input?.reason, 'Adjustment reason', 240)
    const productId = cleanText(input?.productId, 120)
    const quantity = parseQuantityMilli(input?.quantity)
    if (quantity <= 0n) throw new Error('Adjustment quantity must be greater than zero.')
    const delta = input.direction === 'decrease' ? -quantity : input.direction === 'increase' ? quantity : 0n
    if (delta === 0n) throw new Error('Choose whether stock is increasing or decreasing.')
    const settings = this.shop.readSettings()
    const reference = `ADJ-${this.newId().slice(0, 8).toUpperCase()}`
    this.database.transaction(() => {
      const product = this.requireProductRow(productId)
      this.assertExpectedVersions(product, input.expectedProductVersion, input.expectedStockVersion)
      this.applyStockDelta(product, delta, input.batchNumber, input.expiryDate, edition)
      const nextQuantity = BigInt(product.quantity_text) + delta
      if (nextQuantity < BigInt(product.reserved_text)) throw new Error('Adjustment cannot reduce stock below the reserved quantity.')
      assertSqliteInteger(nextQuantity, 'New stock quantity')
      this.updateStockQuantity(productId, input.expectedStockVersion, delta)
      this.database.prepare(`
        INSERT INTO stock_movements (
          id, product_id, movement_type, reference_type, reference_id, quantity_delta_milli,
          unit_cost, currency_code, created_by, adjustment_reason
        ) VALUES (?, ?, 'ADJUSTMENT', 'ADJUSTMENT', ?, ?, ?, ?, ?, ?)
      `).run(this.newId(), productId, reference, delta, product.cost_text, settings.currency.code, actor.id, reason)
      this.recordAudit(actor, 'inventory.stock.adjusted', {
        productId,
        sku: product.sku,
        reference,
        quantityDeltaMilli: delta.toString(),
        reason,
        currencyCode: settings.currency.code,
        deviceName: this.deviceName,
      })
    }).immediate()
    return { product: this.getProduct(productId, actor, edition), reference, quantityDeltaMilli: delta }
  }

  /** A stocktake is also keyed, so a retried count cannot apply its variance twice. */
  recordStocktake(input: StocktakeInput, actor: InventoryActor, edition: Edition): StockMutationResult {
    return this.idempotency.run({
      scope: 'stock.stocktake',
      key: input?.idempotencyKey,
      request: { ...input, idempotencyKey: undefined, actorId: actor?.id },
      execute: () => this.recordStocktakeUncached(input, actor, edition),
    }).response
  }

  private recordStocktakeUncached(input: StocktakeInput, actor: InventoryActor, edition: Edition): StockMutationResult {
    assertAdmin(actor)
    validateEdition(edition)
    const reason = requiredText(input?.reason, 'Stocktake reason', 240)
    const productId = cleanText(input?.productId, 120)
    const counted = parseQuantityMilli(input?.countedQuantity)
    if (counted < 0n) throw new Error('Counted stock cannot be negative.')
    assertSqliteInteger(counted, 'Counted quantity')
    const settings = this.shop.readSettings()
    const reference = `ST-${this.newId().slice(0, 8).toUpperCase()}`
    let variance = 0n
    this.database.transaction(() => {
      const product = this.requireProductRow(productId)
      this.assertExpectedVersions(product, input.expectedProductVersion, input.expectedStockVersion)
      const current = BigInt(product.quantity_text)
      variance = counted - current
      if (variance !== 0n) {
        this.applyStockDelta(product, variance, input.batchNumber, input.expiryDate, edition)
        if (counted < BigInt(product.reserved_text)) throw new Error('Counted stock cannot be below the reserved quantity.')
        this.updateStockQuantity(productId, input.expectedStockVersion, variance)
        this.database.prepare(`
          INSERT INTO stock_movements (
            id, product_id, movement_type, reference_type, reference_id, quantity_delta_milli,
            unit_cost, currency_code, created_by, adjustment_reason
          ) VALUES (?, ?, 'ADJUSTMENT', 'STOCKTAKE', ?, ?, ?, ?, ?, ?)
        `).run(this.newId(), productId, reference, variance, product.cost_text, settings.currency.code, actor.id, reason)
      }
      this.recordAudit(actor, 'inventory.stocktake.completed', {
        productId,
        sku: product.sku,
        reference,
        expectedQuantityMilli: current.toString(),
        countedQuantityMilli: counted.toString(),
        varianceMilli: variance.toString(),
        reason,
        currencyCode: settings.currency.code,
        deviceName: this.deviceName,
      })
    }).immediate()
    return { product: this.getProduct(productId, actor, edition), reference, quantityDeltaMilli: variance, varianceMilli: variance }
  }

  private getProduct(productId: string, actor: InventoryActor, edition: Edition): ProductRecord {
    const row = this.queryProductById(productId)
    return this.mapProduct(row, actor, edition)
  }

  private queryProductById(productId: string): ProductRow {
    const row = this.database.prepare(`
      SELECT p.id, p.sku, p.name, p.brand, p.description,
        parent.name AS category, p.sub_category, d.name AS department,
        p.shelf_location, p.unit, p.pack_size_units,
        CAST(p.cost AS TEXT) AS cost_text,
        CAST(p.sale_price AS TEXT) AS sale_price_text,
        CAST(p.wholesale_price AS TEXT) AS wholesale_price_text,
        CAST(p.wholesale_min_quantity_milli AS TEXT) AS wholesale_min_text,
        CAST(p.reorder_level_milli AS TEXT) AS reorder_level_text,
        CAST(COALESCE(s.quantity_milli, 0) AS TEXT) AS quantity_text,
        CAST(COALESCE(s.reserved_milli, 0) AS TEXT) AS reserved_text,
        p.row_version, COALESCE(s.row_version, 1) AS stock_version,
        p.generic_name, p.prescription_required, p.weighed_item, p.plu_code,
        CAST(p.price_per_kg AS TEXT) AS price_per_kg_text,
        p.expiry_tracking, p.is_active
      FROM products p
      LEFT JOIN categories parent ON parent.id = p.category_id
      LEFT JOIN departments d ON d.id = p.department_id
      LEFT JOIN stock s ON s.product_id = p.id
      WHERE p.id = ?
    `).get(productId) as ProductRow | undefined
    if (!row) throw new Error('Product was not found or is no longer available.')
    return row
  }

  private requireProductRow(productId: string): ProductRow {
    return this.queryProductById(productId)
  }

  private mapProduct(row: ProductRow, actor: InventoryActor, edition: Edition): ProductRecord {
    const barcodes = this.database.prepare(`
      SELECT barcode FROM product_barcodes WHERE product_id = ? ORDER BY is_primary DESC, sort_order, created_at, barcode
    `).all(row.id) as Array<{ barcode: string }>
    const variants = this.database.prepare(`
      SELECT id, variant_code, label, attributes_json, CAST(sale_price AS TEXT) AS sale_price_text, row_version
      FROM product_variants WHERE product_id = ? AND is_active = 1 ORDER BY label COLLATE NOCASE
    `).all(row.id) as VariantRow[]
    return {
      id: row.id,
      sku: row.sku,
      name: row.name,
      brand: row.brand,
      description: row.description,
      barcode: barcodes[0]?.barcode ?? '',
      additionalBarcodes: barcodes.slice(1).map(({ barcode }) => barcode),
      category: row.category ?? '',
      subCategory: row.sub_category,
      department: supportsSupermarket(edition) ? row.department ?? '' : '',
      shelfLocation: supportsSupermarket(edition) ? row.shelf_location : '',
      unit: row.unit,
      packSizeUnits: row.pack_size_units,
      costMinor: actor.role === 'ADMIN' ? BigInt(row.cost_text) : null,
      retailPriceMinor: BigInt(row.sale_price_text),
      wholesalePriceMinor: BigInt(row.wholesale_price_text),
      wholesaleMinimumQuantityMilli: BigInt(row.wholesale_min_text),
      reorderLevelMilli: BigInt(row.reorder_level_text),
      quantityMilli: BigInt(row.quantity_text),
      reservedMilli: BigInt(row.reserved_text),
      rowVersion: row.row_version,
      stockVersion: row.stock_version,
      genericName: supportsPharmacy(edition) ? row.generic_name : '',
      prescriptionRequired: supportsPharmacy(edition) && row.prescription_required === 1,
      weighedItem: supportsSupermarket(edition) && row.weighed_item === 1,
      pluCode: supportsSupermarket(edition) ? row.plu_code ?? '' : '',
      pricePerKgMinor: supportsSupermarket(edition) && row.price_per_kg_text !== null ? BigInt(row.price_per_kg_text) : null,
      expiryTracking: requiresExpiryTracking(row, edition),
      isActive: row.is_active === 1,
      variants: supportsSupermarket(edition) ? variants.map(mapVariant) : [],
    }
  }

  private assertExpectedVersions(product: ProductRow, expectedProductVersion: number, expectedStockVersion: number): void {
    if (!Number.isInteger(expectedProductVersion) || product.row_version !== expectedProductVersion) throw staleProductConflict()
    if (!Number.isInteger(expectedStockVersion) || product.stock_version !== expectedStockVersion) throw staleStockConflict()
  }

  private assertUniqueProductFields(product: NormalizedProduct, currentId: string | null): void {
    const skuRow = this.database.prepare(`
      SELECT id FROM products WHERE sku = ? COLLATE NOCASE AND (? IS NULL OR id <> ?) LIMIT 1
    `).get(product.sku, currentId, currentId) as { id: string } | undefined
    if (skuRow) throw new Error(`SKU “${product.sku}” is already assigned to another product.`)
    for (const barcode of product.barcodeList) {
      const row = this.database.prepare(`
        SELECT product_id FROM product_barcodes WHERE barcode = ? COLLATE NOCASE AND (? IS NULL OR product_id <> ?) LIMIT 1
      `).get(barcode, currentId, currentId) as { product_id: string } | undefined
      if (row) throw new Error(`Barcode “${barcode}” is already assigned to another product.`)
    }
    if (product.pluCode) {
      const row = this.database.prepare('SELECT id FROM products WHERE plu_code = ? COLLATE NOCASE AND (? IS NULL OR id <> ?) LIMIT 1')
        .get(product.pluCode, currentId, currentId) as { id: string } | undefined
      if (row) throw new Error(`PLU “${product.pluCode}” is already assigned to another product.`)
    }
  }

  private ensureCategory(name: string): string | null {
    if (!name) return null
    const id = this.newId()
    this.database.prepare('INSERT OR IGNORE INTO categories (id, name) VALUES (?, ?)').run(id, name)
    return (this.database.prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE').get(name) as { id: string }).id
  }

  private ensureDepartment(name: string): string | null {
    if (!name) return null
    const id = this.newId()
    this.database.prepare('INSERT OR IGNORE INTO departments (id, name) VALUES (?, ?)').run(id, name)
    return (this.database.prepare('SELECT id FROM departments WHERE name = ? COLLATE NOCASE').get(name) as { id: string }).id
  }

  private ensureSupplier(name: string): string {
    const current = this.database.prepare('SELECT id FROM suppliers WHERE name = ? COLLATE NOCASE AND is_active = 1 LIMIT 1')
      .get(name) as { id: string } | undefined
    if (current) return current.id
    const id = this.newId()
    this.database.prepare('INSERT INTO suppliers (id, name) VALUES (?, ?)').run(id, name)
    return id
  }

  private replaceBarcodes(productId: string, barcodes: string[]): void {
    this.database.prepare('DELETE FROM product_barcodes WHERE product_id = ?').run(productId)
    const insert = this.database.prepare('INSERT INTO product_barcodes (id, product_id, barcode, is_primary, sort_order) VALUES (?, ?, ?, ?, ?)')
    barcodes.forEach((barcode, index) => insert.run(this.newId(), productId, barcode, index === 0 ? 1 : 0, index))
  }

  private replaceVariants(productId: string, variants: NormalizedProduct['variants']): void {
    this.database.prepare('DELETE FROM product_variants WHERE product_id = ?').run(productId)
    const insert = this.database.prepare(`
      INSERT INTO product_variants (id, product_id, variant_code, label, attributes_json, sale_price, is_active)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `)
    for (const variant of variants) {
      insert.run(this.newId(), productId, variant.code, variant.label, JSON.stringify(variant.attributes), variant.priceMinor)
    }
  }

  private variantPriceSnapshot(productId: string): Array<{ code: string; priceMinor: string | null }> {
    return (this.database.prepare(`
      SELECT variant_code, CAST(sale_price AS TEXT) AS sale_price_text FROM product_variants WHERE product_id = ? AND is_active = 1
      ORDER BY variant_code COLLATE NOCASE
    `).all(productId) as Array<{ variant_code: string; sale_price_text: string | null }>).map((row) => ({
      code: row.variant_code,
      priceMinor: row.sale_price_text,
    }))
  }

  private addToBatch(product: ProductRow, quantityMilli: bigint, unitCost: bigint, batchNumber: string, expiryDate: string, expiryTracked: boolean): void {
    if (!expiryTracked) return
    const current = this.database.prepare(`
      SELECT id, expiry_date, CAST(quantity_milli AS TEXT) AS quantity_text, row_version
      FROM product_batches WHERE product_id = ? AND batch_no = ? COLLATE NOCASE
    `).get(product.id, batchNumber) as { id: string; expiry_date: string; quantity_text: string; row_version: number } | undefined
    if (current && current.expiry_date !== expiryDate) {
      throw new Error('This batch number already exists with a different expiry date.')
    }
    if (current) {
      const result = this.database.prepare(`
        UPDATE product_batches SET quantity_milli = quantity_milli + ?, cost = ?, row_version = row_version + 1
        WHERE id = ? AND row_version = ?
      `).run(quantityMilli, unitCost, current.id, current.row_version)
      if (result.changes !== 1) throw staleStockConflict()
    } else {
      this.database.prepare(`
        INSERT INTO product_batches (id, product_id, batch_no, expiry_date, quantity_milli, cost)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(this.newId(), product.id, batchNumber, expiryDate, quantityMilli, unitCost)
    }
  }

  private applyStockDelta(product: ProductRow, delta: bigint, batchNumberValue: string, expiryDateValue: string, edition: Edition): void {
    const expiryTracked = requiresExpiryTracking(product, edition)
    const batchNumber = cleanText(batchNumberValue, 80)
    const expiryDate = cleanText(expiryDateValue, 10)
    if (!expiryTracked) {
      if (batchNumber || expiryDate) throw new Error('Batch and expiry details are available only for expiry-tracked products.')
      return
    }
    if (delta > 0n) {
      validateBatchDetails(batchNumber, expiryDate)
      this.addToBatch(product, delta, BigInt(product.cost_text), batchNumber, expiryDate, true)
      return
    }
    if (expiryDate) throw new Error('Do not change a batch expiry date during stock removal.')
    const remaining = -delta
    if (batchNumber) {
      const batch = this.database.prepare(`
        SELECT id, CAST(quantity_milli AS TEXT) AS quantity_text, row_version FROM product_batches
        WHERE product_id = ? AND batch_no = ? COLLATE NOCASE
      `).get(product.id, batchNumber) as { id: string; quantity_text: string; row_version: number } | undefined
      if (!batch || BigInt(batch.quantity_text) < remaining) throw new Error('The selected batch does not contain enough stock.')
      this.decreaseBatch(batch.id, batch.row_version, remaining)
      return
    }
    const batches = this.database.prepare(`
      SELECT id, CAST(quantity_milli AS TEXT) AS quantity_text, row_version FROM product_batches
      WHERE product_id = ? AND quantity_milli > 0 ORDER BY expiry_date ASC, created_at ASC, id ASC
    `).all(product.id) as Array<{ id: string; quantity_text: string; row_version: number }>
    let toRemove = remaining
    for (const batch of batches) {
      if (toRemove === 0n) break
      const inBatch = BigInt(batch.quantity_text)
      const take = inBatch < toRemove ? inBatch : toRemove
      this.decreaseBatch(batch.id, batch.row_version, take)
      toRemove -= take
    }
    if (toRemove > 0n) throw new Error('Expiry-tracked lots do not contain enough stock for this adjustment.')
  }

  private decreaseBatch(batchId: string, rowVersion: number, quantityMilli: bigint): void {
    const result = this.database.prepare(`
      UPDATE product_batches SET quantity_milli = quantity_milli - ?, row_version = row_version + 1
      WHERE id = ? AND row_version = ? AND quantity_milli >= ?
    `).run(quantityMilli, batchId, rowVersion, quantityMilli)
    if (result.changes !== 1) throw staleStockConflict()
  }

  private updateStockQuantity(productId: string, expectedVersion: number, delta: bigint): void {
    const result = this.database.prepare(`
      UPDATE stock SET quantity_milli = quantity_milli + ?, row_version = row_version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE product_id = ? AND row_version = ? AND quantity_milli + ? >= reserved_milli
    `).run(delta, productId, expectedVersion, delta)
    if (result.changes !== 1) throw staleStockConflict()
  }

  private insertBusinessEntry(reference: string, amountMinor: bigint, settings: ReturnType<ShopRepository['readSettings']>): void {
    this.database.prepare(`
      INSERT INTO business_entries (
        id, kind, currency_code, amount_minor, store_name_snapshot, store_address_snapshot, store_phone_snapshot, created_at
      ) VALUES (?, 'purchase', ?, ?, ?, ?, ?, ?)
    `).run(reference, settings.currency.code, amountMinor, settings.profile.name, settings.profile.address, settings.profile.phone, this.isoNow())
  }

  private insertAudit(actor: InventoryActor, action: string, metadata: Record<string, unknown>): void {
    this.database.prepare(`
      INSERT INTO audit_log (id, actor, action, metadata_json, device_name, ip_address, created_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?)
    `).run(this.newId(), actor.username, action, JSON.stringify(metadata), this.deviceName, this.isoNow())
  }

  private recordAudit(actor: InventoryActor, action: string, metadata: Record<string, unknown>): void {
    this.insertAudit(actor, action, metadata)
  }

  private listCategories(): string[] {
    return (this.database.prepare('SELECT name FROM categories WHERE is_active = 1 ORDER BY name COLLATE NOCASE').all() as Array<{ name: string }>).map(({ name }) => name)
  }

  private listDepartments(): string[] {
    return (this.database.prepare('SELECT name FROM departments WHERE is_active = 1 ORDER BY name COLLATE NOCASE').all() as Array<{ name: string }>).map(({ name }) => name)
  }

  private today(): string {
    return new Date(this.now()).toISOString().slice(0, 10)
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString()
  }
}

function normalizeProductDraft(draft: ProductDraft, currency: ReturnType<ShopRepository['readSettings']>['currency'], display: ReturnType<ShopRepository['readSettings']>['display'], edition: Edition): NormalizedProduct {
  if (!draft || typeof draft !== 'object') throw new Error('Enter product details.')
  validateEdition(edition)
  const sku = requiredText(draft.sku, 'SKU', 80).toUpperCase()
  const name = requiredText(draft.name, 'Product name', 160)
  const brand = cleanText(draft.brand, 120)
  const description = cleanText(draft.description, 600)
  const category = cleanText(draft.category, 100)
  const subCategory = cleanText(draft.subCategory, 100)
  if (subCategory && !category) throw new Error('Choose a category before adding a sub-category.')
  const department = cleanText(draft.department, 100)
  const shelfLocation = cleanText(draft.shelfLocation, 100)
  const unit = requiredText(draft.unit, 'Stock unit', 32)
  if (!Number.isInteger(draft.packSizeUnits) || draft.packSizeUnits < 1 || draft.packSizeUnits > 1_000_000) {
    throw new Error('Pack size must be a whole number between 1 and 1,000,000 base units.')
  }
  const price = (value: unknown, label: string) => {
    if (typeof value !== 'string') throw new Error(`Enter a valid ${label.toLowerCase()}.`)
    const parsed = parseMoneyExact(value, currency, display)
    if (parsed < 0n) throw new Error(`${label} cannot be negative.`)
    assertSqliteInteger(parsed, label)
    return parsed
  }
  const optionalPrice = (value: unknown, label: string) => value === undefined || value === null || value === '' ? 0n : price(value, label)
  const optionalQuantity = (value: unknown, label: string) => {
    if (value === undefined || value === null || value === '') return 0n
    if (typeof value !== 'string') throw new Error(`Enter a valid ${label.toLowerCase()}.`)
    return parseQuantityMilli(value)
  }
  const costMinor = price(draft.cost, 'Cost')
  const retailPriceMinor = price(draft.retailPrice, 'Retail price')
  const wholesalePriceMinor = optionalPrice(draft.wholesalePrice, 'Wholesale price')
  const wholesaleMinimumQuantityMilli = optionalQuantity(draft.wholesaleMinimumQuantity, 'Wholesale minimum quantity')
  const reorderLevelMilli = optionalQuantity(draft.reorderLevel, 'Reorder level')
  if (draft.additionalBarcodes !== undefined && !Array.isArray(draft.additionalBarcodes)) throw new Error('Additional barcodes must be a list.')
  if (draft.variants !== undefined && !Array.isArray(draft.variants)) throw new Error('Enter variants as a list.')
  const barcodeList = normalizeBarcodes(draft.barcode, draft.additionalBarcodes ?? [])
  const pharmacy = supportsPharmacy(edition)
  const supermarket = supportsSupermarket(edition)
  if (!pharmacy && (draft.genericName || draft.prescriptionRequired)) {
    throw new Error('Generic name and prescription fields are available only in the pharmacy edition.')
  }
  const genericName = pharmacy ? cleanText(draft.genericName, 160) : ''
  const prescriptionRequired = pharmacy && optionalBoolean(draft.prescriptionRequired, 'Prescription-only')
  const weighedItem = supermarket && optionalBoolean(draft.weighedItem, 'Weighed item')
  const pluCode = supermarket ? cleanText(draft.pluCode, 40).toUpperCase() : ''
  const pricePerKgMinor = supermarket && draft.pricePerKg !== undefined && draft.pricePerKg !== null && draft.pricePerKg !== ''
    ? price(draft.pricePerKg, 'Price per kilogram')
    : null
  const variantsInput = draft.variants ?? []
  if (supermarket && weighedItem && (!pluCode || pricePerKgMinor === null)) {
    throw new Error('Weighed items need a PLU code and price per kilogram.')
  }
  if (!supermarket && (department || shelfLocation || draft.weighedItem || draft.pluCode || draft.pricePerKg || variantsInput.length)) {
    throw new Error('Department, shelf, weighed-item, PLU, price-per-kg and variant fields are available only in the supermarket edition.')
  }
  const expiryTracking = edition === 'PHARMACY'
    ? true
    : supermarket && (optionalBoolean(draft.expiryTracking, 'Expiry tracking') || (edition === 'BOTH' && Boolean(genericName || prescriptionRequired)))
  const variants = normalizeVariants(variantsInput, currency, display, supermarket)
  return {
    sku, name, brand, description, barcodeList, category, subCategory,
    department: supermarket ? department : '',
    shelfLocation: supermarket ? shelfLocation : '',
    unit, packSizeUnits: draft.packSizeUnits,
    costMinor, retailPriceMinor, wholesalePriceMinor,
    wholesaleMinimumQuantityMilli, reorderLevelMilli,
    genericName, prescriptionRequired, weighedItem, pluCode,
    pricePerKgMinor, expiryTracking, variants,
    isActive: draft.isActive === undefined ? true : optionalBoolean(draft.isActive, 'Product active status'),
  }
}

function normalizeVariants(variants: ProductVariantDraft[], currency: ReturnType<ShopRepository['readSettings']>['currency'], display: ReturnType<ShopRepository['readSettings']>['display'], supermarket: boolean): NormalizedProduct['variants'] {
  if (!Array.isArray(variants)) throw new Error('Enter variants as a list.')
  if (!supermarket && variants.length > 0) throw new Error('Product variants are available only in the supermarket edition.')
  if (variants.length > 100) throw new Error('A product may have at most 100 variants.')
  const seen = new Set<string>()
  return variants.map((variant) => {
    if (!variant || typeof variant !== 'object' || Array.isArray(variant)) throw new Error('Each product variant needs a code and label.')
    const code = requiredText(variant.code, 'Variant code', 80).toUpperCase()
    const label = requiredText(variant.label, 'Variant label', 120)
    if (seen.has(code)) throw new Error(`Variant code “${code}” appears more than once.`)
    seen.add(code)
    if (variant.price !== undefined && typeof variant.price !== 'string') throw new Error('Enter a valid variant price.')
    const priceText = variant.price?.trim() ?? ''
    const priceMinor = priceText ? parseMoneyExact(priceText, currency, display) : null
    if (priceMinor !== null && priceMinor < 0n) throw new Error('Variant prices cannot be negative.')
    if (priceMinor !== null) assertSqliteInteger(priceMinor, 'Variant price')
    const attributes = variant.attributes ?? {}
    if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) throw new Error('Variant attributes must be a text object.')
    const normalizedAttributes: Record<string, string> = {}
    for (const [key, value] of Object.entries(attributes)) {
      const cleanKey = requiredText(key, 'Variant attribute name', 40)
      normalizedAttributes[cleanKey] = requiredText(value, 'Variant attribute value', 100)
    }
    return { code, label, attributes: normalizedAttributes, priceMinor }
  })
}

function mapVariant(row: VariantRow): ProductVariantRecord {
  let attributes: Record<string, string> = {}
  try {
    const parsed = JSON.parse(row.attributes_json) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      attributes = Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    }
  } catch {
    attributes = {}
  }
  return {
    id: row.id,
    code: row.variant_code,
    label: row.label,
    priceMinor: row.sale_price_text === null ? null : BigInt(row.sale_price_text),
    attributes,
    rowVersion: row.row_version,
  }
}

function priceSnapshot(product: NormalizedProduct): Record<string, string | null> {
  return {
    costMinor: product.costMinor.toString(),
    retailPriceMinor: product.retailPriceMinor.toString(),
    wholesalePriceMinor: product.wholesalePriceMinor.toString(),
    pricePerKgMinor: product.pricePerKgMinor?.toString() ?? null,
    variants: JSON.stringify(product.variants.map((variant) => ({ code: variant.code, priceMinor: variant.priceMinor?.toString() ?? null }))),
  }
}

function priceSnapshotFromRow(row: ProductRow, variants: Array<{ code: string; priceMinor: string | null }>): Record<string, string | null> {
  return {
    costMinor: row.cost_text,
    retailPriceMinor: row.sale_price_text,
    wholesalePriceMinor: row.wholesale_price_text,
    pricePerKgMinor: row.price_per_kg_text,
    variants: JSON.stringify(variants),
  }
}

function productPriceSnapshotChanged(previous: Record<string, string | null>, next: Record<string, string | null>): boolean {
  return ['retailPriceMinor', 'wholesalePriceMinor', 'pricePerKgMinor', 'variants']
    .some((key) => previous[key] !== next[key])
}

function csvRowToDraft(row: Record<string, string>): ProductDraft {
  let variants: ProductVariantDraft[] = []
  if (row.variants_json?.trim()) {
    let parsed: unknown
    try { parsed = JSON.parse(row.variants_json) } catch { throw new Error('Variants JSON is invalid.') }
    if (!Array.isArray(parsed)) throw new Error('Variants JSON must be an array.')
    variants = parsed.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Each variant must be an object.')
      const record = value as Record<string, unknown>
      const attributes = record.attributes && typeof record.attributes === 'object' && !Array.isArray(record.attributes)
        ? Object.fromEntries(Object.entries(record.attributes as Record<string, unknown>).map(([key, item]) => [key, String(item)]))
        : {}
      return { code: String(record.code ?? ''), label: String(record.label ?? ''), price: String(record.price ?? ''), attributes }
    })
  }
  return {
    sku: row.sku ?? '',
    name: row.name ?? '',
    brand: row.brand ?? '',
    description: row.description ?? '',
    barcode: row.barcode ?? '',
    additionalBarcodes: splitBarcodeList(row.additional_barcodes ?? ''),
    category: row.category ?? '',
    subCategory: row.sub_category ?? '',
    department: row.department ?? '',
    shelfLocation: row.shelf_location ?? '',
    unit: row.unit || 'each',
    packSizeUnits: integerFromText(row.pack_size_units, 1),
    cost: row.cost || '0',
    retailPrice: row.retail_price ?? '',
    wholesalePrice: row.wholesale_price || '0',
    wholesaleMinimumQuantity: row.wholesale_minimum_quantity || '0',
    reorderLevel: row.reorder_level || '0',
    genericName: row.generic_name ?? '',
    prescriptionRequired: parseBoolean(row.prescription_required),
    weighedItem: parseBoolean(row.weighed_item),
    pluCode: row.plu_code ?? '',
    pricePerKg: row.price_per_kg ?? '',
    expiryTracking: parseBoolean(row.expiry_tracking),
    variants,
    isActive: row.is_active === '' || row.is_active === undefined ? true : parseBoolean(row.is_active),
  }
}

function parseCsv(csv: string): string[][] {
  const input = csv.replace(/^\uFEFF/u, '')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') { cell += '"'; index += 1 }
      else if (char === '"') quoted = false
      else cell += char
    } else if (char === '"' && cell.length === 0) quoted = true
    else if (char === ',') { row.push(cell); cell = '' }
    else if (char === '\n') { row.push(cell.replace(/\r$/u, '')); rows.push(row); row = []; cell = '' }
    else cell += char
  }
  if (quoted) throw new Error('The product CSV contains an unclosed quoted field.')
  if (cell.length || row.length) { row.push(cell.replace(/\r$/u, '')); rows.push(row) }
  return rows.filter((line) => line.some((value) => value.trim() !== ''))
}

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[\s-]+/gu, '_')
}

function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value
  return `"${safe.replace(/"/gu, '""')}"`
}

function buildProductExportRows(
  products: ProductRecord[],
  actor: InventoryActor,
  edition: Edition,
  settings: ReturnType<ShopRepository['readSettings']>,
): string[][] {
  const includeCost = actor.role === 'ADMIN'
  const headers = [
    'sku', 'name', 'brand', 'description', 'barcode', 'additional_barcodes', 'category', 'sub_category',
    'department', 'shelf_location', 'unit', 'pack_size_units',
    ...(includeCost ? ['cost'] : []),
    'retail_price', 'wholesale_price', 'wholesale_minimum_quantity', 'reorder_level',
    ...(supportsPharmacy(edition) ? ['generic_name', 'prescription_required'] : []),
    ...(supportsSupermarket(edition) ? ['weighed_item', 'plu_code', 'price_per_kg', 'expiry_tracking'] : []),
    'is_active', 'variants_json', 'currency_code',
  ]
  const rows = [headers]
  for (const product of products) {
    const fields: string[] = [
      product.sku, product.name, product.brand, product.description, product.barcode,
      product.additionalBarcodes.join('|'), product.category, product.subCategory,
      product.department, product.shelfLocation, product.unit, String(product.packSizeUnits),
    ]
    if (includeCost) fields.push(formatMoney(product.costMinor ?? 0n, settings.currency, settings.display))
    fields.push(
      formatMoney(product.retailPriceMinor, settings.currency, settings.display),
      formatMoney(product.wholesalePriceMinor, settings.currency, settings.display),
      formatQuantity(product.wholesaleMinimumQuantityMilli),
      formatQuantity(product.reorderLevelMilli),
    )
    if (supportsPharmacy(edition)) fields.push(product.genericName, String(product.prescriptionRequired))
    if (supportsSupermarket(edition)) fields.push(String(product.weighedItem), product.pluCode,
      product.pricePerKgMinor === null ? '' : formatMoney(product.pricePerKgMinor, settings.currency, settings.display),
      String(product.expiryTracking))
    fields.push(String(product.isActive), JSON.stringify(product.variants.map((variant) => ({
      code: variant.code,
      label: variant.label,
      price: variant.priceMinor === null ? '' : formatMoney(variant.priceMinor, settings.currency, settings.display),
      attributes: variant.attributes,
    }))), settings.currency.code)
    rows.push(fields)
  }
  return rows
}

function validateImportHeaders(rawHeaders: string[], kind: string): string[] {
  const headers = rawHeaders.map((header, index) => {
    const normalized = normalizeHeader(header)
    if (!normalized) return `__blank_${index + 1}`
    if (normalized === 'sale_price' || normalized === 'price') return 'retail_price'
    if (normalized === 'product_name' || normalized === 'item_name') return 'name'
    if (normalized === 'barcode_number') return 'barcode'
    return normalized
  })
  while (headers.length > 0 && headers[headers.length - 1]?.startsWith('__blank_')) headers.pop()
  const duplicates = headers.filter((header, index) => headers.indexOf(header) !== index)
  if (duplicates.length) throw new Error(`The ${kind} import has duplicate “${duplicates[0]}” columns.`)
  for (const required of ['sku', 'name', 'retail_price']) {
    if (!headers.includes(required)) throw new Error(`The ${kind} product import is missing the required “${required}” column.`)
  }
  return headers
}

function excelCellToText(value: unknown, row: number, column: number): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Cell ${columnLetter(column)}${row} is not a finite number.`)
    return String(value)
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'object') {
    const cell = value as Record<string, unknown>
    if ('formula' in cell || 'sharedFormula' in cell) {
      throw new Error(`Formula cells are not allowed in product imports (cell ${columnLetter(column)}${row}). Replace the formula with a value.`)
    }
    if (typeof cell.text === 'string') return cell.text
    if (Array.isArray(cell.richText)) {
      return cell.richText.map((part) => part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text : '').join('')
    }
  }
  throw new Error(`Cell ${columnLetter(column)}${row} uses an unsupported Excel value.`)
}

function columnLetter(column: number): string {
  let value = column
  let result = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    result = String.fromCharCode(65 + remainder) + result
    value = Math.floor((value - 1) / 26)
  }
  return result
}

function normalizeBarcodes(primary: string, additional: string[]): string[] {
  if (!Array.isArray(additional)) throw new Error('Additional barcodes must be a list.')
  const values = [primary, ...additional].map((value) => cleanText(value, 80)).filter(Boolean)
  const normalized = values.map((barcode) => barcode.replace(/\s+/gu, '').toUpperCase())
  if (normalized.some((barcode) => !/^[A-Z0-9._/-]{3,80}$/u.test(barcode))) throw new Error('Barcodes must contain 3–80 letters, digits, dots, slashes, underscores or hyphens.')
  if (new Set(normalized).size !== normalized.length) throw new Error('A barcode appears more than once for this product.')
  return normalized
}

function splitBarcodeList(value: string): string[] {
  return value.split(/[|;]/u).map((item) => item.trim()).filter(Boolean)
}

function parseQuantityMilli(input: string): bigint {
  if (typeof input !== 'string') throw new Error('Enter a valid quantity.')
  const value = input.trim().replace(/[\s\u00a0\u202f]/gu, '')
  const match = /^(\d+)(?:\.(\d{0,3}))?$/.exec(value)
  if (!match) throw new Error('Enter a non-negative quantity with at most three decimal places.')
  const whole = BigInt(match[1]!)
  const fractional = BigInt((match[2] ?? '').padEnd(3, '0') || '0')
  const milli = whole * 1000n + fractional
  assertSqliteInteger(milli, 'Quantity')
  return milli
}

function formatQuantity(milli: bigint): string {
  const negative = milli < 0n
  const absolute = negative ? -milli : milli
  const whole = absolute / 1000n
  const fraction = (absolute % 1000n).toString().padStart(3, '0').replace(/0+$/u, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

function integerFromText(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback
  if (!/^\d+$/u.test(value.trim())) throw new Error('Pack size must be a whole number.')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error('Pack size must be a whole number.')
  return parsed
}

function parseBoolean(value: string | undefined): boolean {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false
  throw new Error(`“${value}” is not a valid true/false value.`)
}

function optionalBoolean(value: unknown, label: string): boolean {
  if (value === undefined || value === null) return false
  if (typeof value !== 'boolean') throw new Error(`${label} must be selected as yes or no.`)
  return value
}

function validateBatchDetails(batchNumber: string, expiryDate: string): void {
  if (!batchNumber) throw new Error('Enter the batch/lot number for this expiry-tracked stock.')
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(expiryDate) || !Number.isFinite(Date.parse(`${expiryDate}T00:00:00.000Z`))
    || new Date(`${expiryDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== expiryDate) {
    throw new Error('Enter a valid batch expiry date.')
  }
}

function addCalendarDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function requiresExpiryTracking(product: Pick<ProductRow, 'expiry_tracking' | 'generic_name' | 'prescription_required'>, edition: Edition): boolean {
  return edition === 'PHARMACY'
    || (edition === 'BOTH' && (product.expiry_tracking === 1 || product.prescription_required === 1 || Boolean(product.generic_name)))
    || (edition === 'SUPERMARKET' && product.expiry_tracking === 1)
}

function supportsPharmacy(edition: Edition): boolean {
  return edition === 'PHARMACY' || edition === 'BOTH'
}

function supportsSupermarket(edition: Edition): boolean {
  return edition === 'SUPERMARKET' || edition === 'BOTH'
}

function requireSupermarketEdition(edition: Edition): void {
  validateEdition(edition)
  if (!supportsSupermarket(edition)) throw new Error('Purchase orders are available only in the supermarket edition.')
}

function normalizePurchaseId(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{1,12}$/u.test(value)) throw new Error('Choose a valid purchase order.')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('Choose a valid purchase order.')
  return String(parsed)
}

function validateEdition(edition: Edition): void {
  if (!['PHARMACY', 'SUPERMARKET', 'BOTH'].includes(edition)) throw new Error('A valid licensed edition is required.')
}

function validateActor(actor: InventoryActor): void {
  if (!actor || typeof actor.id !== 'string' || !actor.id.trim() || typeof actor.username !== 'string' || !actor.username.trim()) {
    throw new Error('An authenticated user is required for inventory access.')
  }
}

function assertAdmin(actor: InventoryActor): void {
  validateActor(actor)
  if (actor.role !== 'ADMIN') throw new Error('This action is restricted to the Admin.')
}

function requiredText(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== 'string') throw new Error(`Enter a valid ${label.toLowerCase()}.`)
  const normalized = cleanText(value, maximumLength)
  if (!normalized) throw new Error(`Enter ${label.toLowerCase()}.`)
  return normalized
}

function cleanText(value: unknown, maximumLength: number): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new Error('Enter valid text.')
  const normalized = value.replace(/[\r\n\t\p{C}]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  if (normalized.length > maximumLength) throw new Error(`Text must be ${maximumLength} characters or fewer.`)
  return normalized
}

function normalizeSearch(value: string): string {
  if (typeof value !== 'string') throw new Error('Enter a valid product search.')
  return value.trim().slice(0, 120)
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, '\\$&')
}

function assertSqliteInteger(value: bigint, label: string): void {
  if (value < -MAX_SQLITE_INTEGER || value > MAX_SQLITE_INTEGER) throw new Error(`${label} exceeds the supported SQLite integer range.`)
}

function staleProductConflict(): Error {
  return new Error('This item changed. Reload before saving the edit.')
}

function staleStockConflict(): Error {
  return new Error('This item’s stock changed. Reload before changing stock.')
}

function stalePurchaseOrderConflict(): Error {
  return new Error('This purchase order changed or was already received. Reload the order before continuing.')
}
