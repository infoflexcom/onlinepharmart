import Database from 'better-sqlite3'
import { Workbook } from 'exceljs'
import { describe, expect, it } from 'vitest'
import { defaultDisplayOptions } from '../currency/money'
import { getCurrency } from '../currency/catalog'
import { migrateDatabase } from '../db/migrate'
import { SQLiteShopRepository } from '../db/sqlite-shop-repository'
import type { ProductDraft, PurchaseOrderReceiptInput, ReceiveStockInput } from '../shared/inventory/types'
import type { InventoryActor } from '../shared/inventory/types'
import { ProductInventoryService } from './product-inventory-service'

const admin: InventoryActor = { id: 'inventory-admin', username: 'inventoryadmin', role: 'ADMIN' }
const cashier: InventoryActor = { id: 'inventory-cashier', username: 'inventorycashier', role: 'CASHIER' }

function createHarness(currencyCode = 'NGN') {
  const database = new Database(':memory:')
  migrateDatabase(database)
  const shop = new SQLiteShopRepository(database, false)
  const currency = getCurrency(currencyCode)!
  shop.saveSettings({
    ...shop.readSettings(),
    profile: { name: 'Test Shop', address: 'Main Street', phone: '+234 800 000 0000' },
    currency,
    display: defaultDisplayOptions(currency),
    setupComplete: true,
    currencyConfirmed: true,
  })
  const insertUser = database.prepare('INSERT INTO users (id, username, password_hash, role, full_name) VALUES (?, ?, ?, ?, ?)')
  insertUser.run(admin.id, admin.username, 'not-a-real-hash', 'ADMIN', 'Inventory Admin')
  insertUser.run(cashier.id, cashier.username, 'not-a-real-hash', 'CASHIER', 'View Only Cashier')
  let id = 0
  const inventory = new ProductInventoryService(database, shop, {
    deviceName: 'TEST-REGISTER-4',
    now: () => Date.parse('2026-11-17T12:00:00.000Z'),
    newId: () => `inventory-test-${++id}`,
  })
  return { database, shop, inventory, close: () => database.close() }
}

function productDraft(overrides: Partial<ProductDraft> = {}): ProductDraft {
  return {
    sku: 'MED-001', name: 'Vitamin C', brand: 'Harbor', description: 'Vitamin supplement',
    barcode: '1234567890123', additionalBarcodes: ['2345678901234'], category: 'Vitamins', subCategory: 'Supplements',
    department: '', shelfLocation: '', unit: 'tablet', packSizeUnits: 10,
    cost: '10.00', retailPrice: '20.00', wholesalePrice: '18.00', wholesaleMinimumQuantity: '5', reorderLevel: '2',
    genericName: '', prescriptionRequired: false, weighedItem: false, pluCode: '', pricePerKg: '',
    expiryTracking: false, variants: [], isActive: true,
    ...overrides,
  }
}

function receiveInput(productId: string, productVersion: number, stockVersion: number, overrides: Partial<ReceiveStockInput> = {}): ReceiveStockInput {
  return {
    productId,
    expectedProductVersion: productVersion,
    expectedStockVersion: stockVersion,
    quantity: '1',
    quantityUnit: 'unit',
    unitCost: '10.00',
    supplierName: 'Coastal Medical Supplies',
    supplierReference: 'INV-001',
    note: 'Morning delivery',
    batchNumber: 'LOT-001',
    expiryDate: '2027-05-31',
    ...overrides,
  }
}

describe('ProductInventoryService', () => {
  it('creates/searches products, hides costs from other roles, and enforces Admin-only price changes', () => {
    const harness = createHarness()
    try {
      const product = harness.inventory.createProduct(productDraft({ genericName: 'ascorbic acid' }), admin, 'PHARMACY')
      expect(product).toMatchObject({ sku: 'MED-001', name: 'Vitamin C', barcode: '1234567890123', rowVersion: 1, stockVersion: 1 })
      expect(product.costMinor).toBe(1000n)
      expect(product.quantityMilli).toBe(0n)
      const cashierProduct = harness.inventory.listProducts(cashier, 'PHARMACY', '2345678901234')[0]
      expect(cashierProduct?.id).toBe(product.id)
      expect(cashierProduct?.costMinor).toBeNull()
      expect(cashierProduct?.retailPriceMinor).toBe(2000n)
      expect(harness.inventory.exportProductsCsv(cashier, 'PHARMACY').split('\r\n')[0]).not.toContain('cost')
      expect(harness.inventory.exportProductsCsv(admin, 'PHARMACY').split('\r\n')[0]).toContain('cost')
      expect(() => harness.inventory.createProduct(productDraft({ sku: 'NOPE' }), cashier, 'PHARMACY')).toThrow(/Admin/u)
      expect(() => harness.inventory.updateProduct({ ...productDraft(), id: product.id, expectedVersion: product.rowVersion, retailPrice: '99.00' }, cashier, 'PHARMACY')).toThrow(/Admin/u)
    } finally {
      harness.close()
    }
  })

  it('neutralizes spreadsheet formula prefixes in product CSV exports', () => {
    const harness = createHarness()
    try {
      harness.inventory.createProduct(productDraft({ sku: 'CSV-1', name: '=1+1', barcode: '', additionalBarcodes: [] }), admin, 'SUPERMARKET')
      const csv = harness.inventory.exportProductsCsv(admin, 'SUPERMARKET')
      expect(csv).toContain("\"'=1+1\"")
    } finally {
      harness.close()
    }
  })

  it('allows only one of two simultaneous product price edits and returns a clean stale-edit conflict', async () => {
    const harness = createHarness()
    try {
      const product = harness.inventory.createProduct(productDraft(), admin, 'SUPERMARKET')
      const editOne = { ...productDraft(), id: product.id, expectedVersion: product.rowVersion, retailPrice: '21.00' }
      const editTwo = { ...productDraft(), id: product.id, expectedVersion: product.rowVersion, retailPrice: '22.00' }
      const outcomes = await Promise.allSettled([
        Promise.resolve().then(() => harness.inventory.updateProduct(editOne, admin, 'SUPERMARKET')),
        Promise.resolve().then(() => harness.inventory.updateProduct(editTwo, admin, 'SUPERMARKET')),
      ])
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
      const conflict = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult
      expect(String(conflict.reason)).toMatch(/changed.*reload before saving/iu)
      expect(harness.database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'product.price.updated'").get()).toEqual({ count: 1 })
      expect([2100n, 2200n]).toContain(harness.inventory.listProducts(admin, 'SUPERMARKET')[0]?.retailPriceMinor)
    } finally {
      harness.close()
    }
  })

  it('imports CSV rows with individual errors and accepts shop separators without rounding excess decimals', () => {
    const harness = createHarness('EUR')
    try {
      const report = harness.inventory.importProductsCsv([
        'sku,name,retail_price,cost,barcode,unit,pack_size_units',
        'EUR-01,Calm Balm,"1.234,56","1.000,00",9988776655443,jar,1',
        'EUR-02,,12,0,9988776655444,jar,1',
      ].join('\n'), admin, 'SUPERMARKET')
      expect(report.imported).toBe(1)
      expect(report.errors).toHaveLength(1)
      expect(report.errors[0]).toMatchObject({ row: 3 })
      expect(harness.inventory.listProducts(admin, 'SUPERMARKET')[0]?.retailPriceMinor).toBe(123456n)
      expect(() => harness.inventory.createProduct(productDraft({ sku: 'TOO-PRECISE', retailPrice: '1.234' }), admin, 'SUPERMARKET')).toThrow(/at most 2 decimal places/u)
      const malformed = harness.inventory.importProductsCsv('sku,name,retail_price\nEUR-03,Soap,1.234', admin, 'SUPERMARKET')
      expect(malformed.imported).toBe(0)
      expect(malformed.errors[0]?.message).toMatch(/at most 2 decimal places/u)
    } finally {
      harness.close()
    }
  })

  it('imports and exports Excel workbooks with a per-row error report', async () => {
    const harness = createHarness()
    try {
      const workbook = new Workbook()
      const worksheet = workbook.addWorksheet('Products')
      worksheet.addRow(['sku', 'name', 'retail_price', 'cost', 'barcode'])
      worksheet.addRow(['XLS-01', 'Excel item', '1,234.50', '500.00', '1234509876543'])
      worksheet.addRow(['XLS-02', 'Formula item', { formula: '1+1' }, '0', '1234509876544'])
      const bytes = new Uint8Array(await workbook.xlsx.writeBuffer())
      const report = await harness.inventory.importProductsExcel(bytes, admin, 'SUPERMARKET')
      expect(report.imported).toBe(1)
      expect(report.errors).toHaveLength(1)
      expect(report.errors[0]?.row).toBe(3)
      const exported = await harness.inventory.exportProductsExcel(admin, 'SUPERMARKET')
      expect(Buffer.from(exported, 'base64').subarray(0, 2).toString()).toBe('PK')
      const output = new Workbook()
      const outputBytes = new Uint8Array(Buffer.from(exported, 'base64'))
      await output.xlsx.load(outputBytes.buffer)
      expect(output.getWorksheet('Products')?.getCell('A1').value).toBe('sku')
      expect(String(output.getWorksheet('Products')?.getCell('M1').value)).toBe('cost')
      const cashierExcel = await harness.inventory.exportProductsExcel(cashier, 'SUPERMARKET')
      const cashierBook = new Workbook()
      const cashierBytes = new Uint8Array(Buffer.from(cashierExcel, 'base64'))
      await cashierBook.xlsx.load(cashierBytes.buffer)
      const headerValues = cashierBook.getWorksheet('Products')!.getRow(1).values as unknown[]
      expect(headerValues.map(String)).not.toContain('cost')
    } finally {
      harness.close()
    }
  })

  it('receives stock in pack conversions transactionally and writes cost/device audit history', () => {
    const harness = createHarness()
    try {
      const product = harness.inventory.createProduct(productDraft(), admin, 'PHARMACY')
      const received = harness.inventory.receiveStock(receiveInput(product.id, product.rowVersion, product.stockVersion, {
        quantity: '2', quantityUnit: 'pack', unitCost: '12.50', batchNumber: 'LOT-2', expiryDate: '2027-06-30',
      }), admin, 'PHARMACY')
      expect(received.product.quantityMilli).toBe(20_000n)
      expect(received.product.costMinor).toBe(1250n)
      expect(received.product.stockVersion).toBe(2)
      expect(received.product.rowVersion).toBe(2)
      expect(harness.database.prepare('SELECT status, supplier_reference, received_note FROM purchases WHERE purchase_number = ?').get(received.reference)).toMatchObject({
        status: 'COMPLETED', supplier_reference: 'INV-001', received_note: 'Morning delivery',
      })
      expect(harness.database.prepare('SELECT received_quantity_milli, batch_number, expiry_date FROM purchase_items').get()).toMatchObject({
        received_quantity_milli: 20_000, batch_number: 'LOT-2', expiry_date: '2027-06-30',
      })
      expect(harness.database.prepare("SELECT kind, amount_minor FROM business_entries WHERE id = ?").get(received.reference)).toMatchObject({ kind: 'purchase', amount_minor: 25_000 })
      expect(harness.database.prepare("SELECT device_name FROM audit_log WHERE action = 'inventory.stock_received'").get()).toEqual({ device_name: 'TEST-REGISTER-4' })
      const costAudit = harness.database.prepare("SELECT metadata_json, device_name FROM audit_log WHERE action = 'product.cost.updated'").get() as { metadata_json: string; device_name: string }
      expect(JSON.parse(costAudit.metadata_json)).toMatchObject({ oldCostMinor: '1000', newCostMinor: '1250' })
      expect(costAudit.device_name).toBe('TEST-REGISTER-4')
    } finally {
      harness.close()
    }
  })

  it('rolls back the complete receipt when the audit ledger write fails', () => {
    const harness = createHarness()
    try {
      const product = harness.inventory.createProduct(productDraft(), admin, 'PHARMACY')
      harness.database.exec(`
        CREATE TRIGGER reject_inventory_receipt_audit
        BEFORE INSERT ON audit_log WHEN NEW.action = 'inventory.stock_received'
        BEGIN SELECT RAISE(ABORT, 'audit ledger unavailable'); END;
      `)
      expect(() => harness.inventory.receiveStock(receiveInput(product.id, product.rowVersion, product.stockVersion), admin, 'PHARMACY'))
        .toThrow(/audit ledger unavailable/u)
      const unchanged = harness.inventory.listProducts(admin, 'PHARMACY')[0]!
      expect(unchanged).toMatchObject({ quantityMilli: 0n, costMinor: 1000n, rowVersion: 1, stockVersion: 1 })
      expect(harness.database.prepare('SELECT COUNT(*) AS count FROM purchases').get()).toEqual({ count: 0 })
      expect(harness.database.prepare('SELECT COUNT(*) AS count FROM purchase_items').get()).toEqual({ count: 0 })
      expect(harness.database.prepare('SELECT COUNT(*) AS count FROM stock_movements').get()).toEqual({ count: 0 })
      expect(harness.database.prepare('SELECT COUNT(*) AS count FROM business_entries').get()).toEqual({ count: 0 })
      expect(harness.database.prepare('SELECT COUNT(*) AS count FROM suppliers').get()).toEqual({ count: 0 })
      expect(harness.database.prepare('SELECT COUNT(*) AS count FROM product_batches').get()).toEqual({ count: 0 })
    } finally {
      harness.close()
    }
  })

  it('requires adjustment reasons, records stocktake variance, and rejects stale stock edits cleanly', async () => {
    const harness = createHarness()
    try {
      let product = harness.inventory.createProduct(productDraft({ reorderLevel: '1' }), admin, 'SUPERMARKET')
      expect(() => harness.inventory.adjustStock({
        productId: product.id, expectedProductVersion: product.rowVersion, expectedStockVersion: product.stockVersion,
        direction: 'increase', quantity: '1', reason: ' ', batchNumber: '', expiryDate: '',
      }, admin, 'SUPERMARKET')).toThrow(/reason/u)
      const received = harness.inventory.receiveStock(receiveInput(product.id, product.rowVersion, product.stockVersion, {
        quantity: '5', batchNumber: '', expiryDate: '',
      }), admin, 'SUPERMARKET')
      product = received.product
      const adjustA = { productId: product.id, expectedProductVersion: product.rowVersion, expectedStockVersion: product.stockVersion,
        direction: 'decrease' as const, quantity: '1', reason: 'Damaged during handling', batchNumber: '', expiryDate: '' }
      const adjustB = { ...adjustA, quantity: '2', reason: 'Second operator edit' }
      const attempts = await Promise.allSettled([
        Promise.resolve().then(() => harness.inventory.adjustStock(adjustA, admin, 'SUPERMARKET')),
        Promise.resolve().then(() => harness.inventory.adjustStock(adjustB, admin, 'SUPERMARKET')),
      ])
      expect(attempts.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
      const rejection = attempts.find((item) => item.status === 'rejected') as PromiseRejectedResult
      expect(String(rejection.reason)).toMatch(/stock changed.*reload/iu)
      const after = harness.inventory.listProducts(admin, 'SUPERMARKET')[0]!
      const stocktake = harness.inventory.recordStocktake({
        productId: after.id, expectedProductVersion: after.rowVersion, expectedStockVersion: after.stockVersion,
        countedQuantity: '2', reason: 'Closing count', batchNumber: '', expiryDate: '',
      }, admin, 'SUPERMARKET')
      expect(stocktake.varianceMilli).toBe(2_000n - after.quantityMilli)
      const report = harness.inventory.getStocktakeVarianceReport(cashier, 'SUPERMARKET')
      expect(report[0]).toMatchObject({ sku: 'MED-001', reason: 'Closing count', deviceName: 'TEST-REGISTER-4' })
    } finally {
      harness.close()
    }
  })

  it('uses FEFO, blocks expired pharmacy lots at sale time, and reports near-expiry batches', () => {
    const harness = createHarness()
    try {
      let product = harness.inventory.createProduct(productDraft(), admin, 'PHARMACY')
      product = harness.inventory.receiveStock(receiveInput(product.id, product.rowVersion, product.stockVersion, {
        quantity: '2', batchNumber: 'EXPIRED', expiryDate: '2026-11-16',
      }), admin, 'PHARMACY').product
      expect(harness.inventory.getSellableBatches(product.id, 'PHARMACY')).toEqual([])
      expect(harness.inventory.getAlerts('PHARMACY').some((alert) => alert.type === 'expired')).toBe(true)
      expect(() => harness.inventory.consumeStockFEFO({
        productId: product.id, expectedProductVersion: product.rowVersion, expectedStockVersion: product.stockVersion,
        quantity: '1', reference: 'R-EXPIRED',
      }, cashier, 'PHARMACY')).toThrow(/Sale blocked/u)
      product = harness.inventory.receiveStock(receiveInput(product.id, product.rowVersion, product.stockVersion, {
        quantity: '2', batchNumber: 'SOON', expiryDate: '2026-12-31',
      }), admin, 'PHARMACY').product
      const received = harness.inventory.receiveStock(receiveInput(product.id, product.rowVersion, product.stockVersion, {
        quantity: '2', batchNumber: 'LATER', expiryDate: '2027-01-10',
      }), admin, 'PHARMACY')
      const sale = harness.inventory.consumeStockFEFO({
        productId: product.id, expectedProductVersion: received.product.rowVersion, expectedStockVersion: received.product.stockVersion,
        quantity: '3', reference: 'R-FEFO-1',
      }, cashier, 'PHARMACY')
      expect(sale.allocations.map((allocation) => [allocation.batchNumber, allocation.quantityMilli])).toEqual([['SOON', 2000n], ['LATER', 1000n]])
      expect(sale.product.quantityMilli).toBe(3_000n)
      expect(harness.inventory.getAlerts('PHARMACY').some((alert) => alert.type === 'near_expiry')).toBe(true)
    } finally {
      harness.close()
    }
  })

  it('supports supermarket purchase orders, goods receipt, weighed pricing, and strict 0/3-decimal currencies', () => {
    const harness = createHarness('KWD')
    try {
      let product = harness.inventory.createProduct(productDraft({
        sku: 'MART-001', name: 'Loose Dates', genericName: '', barcode: '4567890123456', additionalBarcodes: [],
        unit: 'kg', packSizeUnits: 1, cost: '0.500', retailPrice: '1.500', wholesalePrice: '1.200',
        department: 'Produce', shelfLocation: 'Aisle 2 / Bin 5', weighedItem: true, pluCode: '31415',
        pricePerKg: '12.345', expiryTracking: true,
      }), admin, 'SUPERMARKET')
      expect(harness.inventory.getWeighedPrice(product.id, '0.250', 'SUPERMARKET')).toMatchObject({ weightMilli: 250n, priceMinor: 3086n, currencyCode: 'KWD' })
      const po = harness.inventory.createPurchaseOrder({
        supplierName: 'Fresh Imports', supplierReference: 'PO-CLIENT-55', note: 'Weekly delivery',
        items: [{ productId: product.id, quantity: '2', quantityUnit: 'unit', unitCost: '0.750' }],
      }, admin, 'SUPERMARKET')
      expect(po.status).toBe('DRAFT')
      expect(po.totalMinor).toBe(1500n)
      expect(harness.inventory.listProducts(admin, 'SUPERMARKET')[0]?.quantityMilli).toBe(0n)
      const receipt: PurchaseOrderReceiptInput = { purchaseId: po.id, expectedVersion: po.rowVersion, supplierReference: 'GRN-55', receivedNote: 'All goods inspected', items: [{ purchaseItemId: po.items[0]!.id, batchNumber: 'DATE-LOT-1', expiryDate: '2027-03-01' }] }
      const completed = harness.inventory.receivePurchaseOrder(receipt, admin, 'SUPERMARKET')
      expect(completed.status).toBe('COMPLETED')
      expect(completed.items[0]?.receivedQuantityMilli).toBe(2000n)
      product = harness.inventory.listProducts(admin, 'SUPERMARKET')[0]!
      expect(product.quantityMilli).toBe(2000n)
      expect(harness.inventory.exportProductsCsv(admin, 'SUPERMARKET')).toContain('12.345')
      expect(() => harness.inventory.createProduct(productDraft({ sku: 'KWD-BAD', retailPrice: '1.2345' }), admin, 'SUPERMARKET')).toThrow(/at most 3 decimal places/u)
    } finally {
      harness.close()
    }
  })

  it('leaves draft orders unlocked and refuses receipt after the shop currency changes', () => {
    const harness = createHarness('KWD')
    try {
      const product = harness.inventory.createProduct(productDraft({ sku: 'DRAFT-PO', barcode: '' }), admin, 'SUPERMARKET')
      const order = harness.inventory.createPurchaseOrder({
        supplierName: 'Market Supplier', supplierReference: 'DRAFT-1', note: '',
        items: [{ productId: product.id, quantity: '1', quantityUnit: 'unit', unitCost: '0.750' }],
      }, admin, 'SUPERMARKET')
      expect(harness.shop.readSettings().currencyLocked).toBe(false)
      const ngn = getCurrency('NGN')!
      harness.shop.saveSettings({ ...harness.shop.readSettings(), currency: ngn, display: defaultDisplayOptions(ngn) })
      expect(() => harness.inventory.receivePurchaseOrder({
        purchaseId: order.id, expectedVersion: order.rowVersion, supplierReference: '', receivedNote: '',
        items: [{ purchaseItemId: order.items[0]!.id, batchNumber: '', expiryDate: '' }],
      }, admin, 'SUPERMARKET')).toThrow(/currency changed/u)
      expect(harness.inventory.listPurchaseOrders(admin, 'SUPERMARKET')[0]).toMatchObject({ status: 'DRAFT', rowVersion: 1 })
      expect(harness.inventory.listProducts(admin, 'SUPERMARKET')[0]?.quantityMilli).toBe(0n)
    } finally {
      harness.close()
    }
  })

  it('formats and stores zero-decimal currency amounts without fractional rounding', () => {
    const harness = createHarness('JPY')
    try {
      const product = harness.inventory.createProduct(productDraft({ sku: 'JPY-001', retailPrice: '1234', cost: '800', wholesalePrice: '1000' }), admin, 'SUPERMARKET')
      expect(product.retailPriceMinor).toBe(1234n)
      expect(harness.inventory.exportProductsCsv(admin, 'SUPERMARKET')).toContain('1,234')
      expect(() => harness.inventory.createProduct(productDraft({ sku: 'JPY-BAD', retailPrice: '1234.5' }), admin, 'SUPERMARKET')).toThrow(/at most 0 decimal places/u)
    } finally {
      harness.close()
    }
  })
})
