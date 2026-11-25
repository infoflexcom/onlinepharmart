import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { getCurrency } from '../currency/catalog'
import { defaultDisplayOptions } from '../currency/money'
import { fromMinor } from '../currency/parse'
import { migrateDatabase } from '../db/migrate'
import { SQLiteShopRepository } from '../db/sqlite-shop-repository'
import type { PublicUser } from '../shared/auth/types'
import type { ProductDraft } from '../shared/inventory/types'
import { Workbook } from 'exceljs'
import { ProductInventoryService } from './product-inventory-service'
import { PointOfSaleService } from './point-of-sale-service'
import { ReturnService } from './return-service'
import { AccountingReportService } from './accounting-report-service'

const NOW = Date.parse('2026-11-17T12:00:00.000Z')
const ADMIN: PublicUser = {
  id: 'report-admin', fullName: 'Report Admin', username: 'reportadmin', role: 'ADMIN', isActive: true, isLocked: false,
  permissions: { allowWholesale: true, maxDiscountBasisPoints: 10_000, allowCreditSales: true, returnLimitMinor: 9_000_000_000_000n },
}
/**
 * The till role. `ACCOUNT`, not the deprecated `CASHIER`: the brief gives the day's report to ACCOUNT, and a CASHIER
 * row resolves to USER, which has no reports. Naming the role the brief names keeps this fixture about the reports
 * rather than about the alias.
 */
const CASHIER: PublicUser = {
  id: 'report-cashier', fullName: 'Report Cashier', username: 'reportcashier', role: 'ACCOUNT', isActive: true, isLocked: false,
  permissions: { allowWholesale: false, maxDiscountBasisPoints: 2_000, allowCreditSales: true, returnLimitMinor: 9_000_000_000_000n },
}

function createHarness(currencyCode: string) {
  const database = new Database(':memory:')
  migrateDatabase(database)
  const shop = new SQLiteShopRepository(database, false)
  const currency = getCurrency(currencyCode)!
  shop.saveSettings({
    ...shop.readSettings(),
    profile: { name: 'Harbor Health', address: '12 Dock Road, Lagos', phone: '+234 1 555 0100' },
    currency,
    display: defaultDisplayOptions(currency),
    setupComplete: true,
    currencyConfirmed: true,
  })
  const insertUser = database.prepare('INSERT INTO users (id, username, password_hash, role, full_name) VALUES (?, ?, ?, ?, ?)')
  for (const user of [ADMIN, CASHIER]) insertUser.run(user.id, user.username, 'test-hash', user.role, user.fullName)
  const insertPermission = database.prepare(`
    INSERT INTO user_permissions (user_id, allow_wholesale, max_discount_pct, allow_credit_sales, return_limit)
    VALUES (?, ?, ?, ?, ?)
  `)
  insertPermission.run(ADMIN.id, 1, 10_000, 1, ADMIN.permissions.returnLimitMinor)
  insertPermission.run(CASHIER.id, 0, 2_000, 1, CASHIER.permissions.returnLimitMinor)
  let generatedId = 0
  const options = { now: () => NOW, newId: () => `report-seed-${++generatedId}` }
  const inventory = new ProductInventoryService(database, shop, { ...options, deviceName: 'REPORT-TEST-REGISTER' })
  const pointOfSale = new PointOfSaleService(database, shop, { ...options, workstation: 'REPORT-TEST-REGISTER' })
  const returns = new ReturnService(database, shop, { ...options, workstation: 'REPORT-TEST-REGISTER' })
  const reports = new AccountingReportService(database, shop, options)
  return { database, shop, inventory, pointOfSale, returns, reports, close: () => database.close() }
}

function seedReportTransactions(currencyCode: string) {
  const harness = createHarness(currencyCode)
  const currency = harness.shop.readSettings().currency
  const scale = 10n ** BigInt(currency.decimalPlaces)
  try {
    const productDraft: ProductDraft = {
      sku: `REPORT-${currencyCode}`, name: 'Vitamin C', brand: 'Harbor', description: 'Vitamin supplement',
      barcode: '', additionalBarcodes: [], category: 'Vitamins', subCategory: 'Supplements', department: 'Health',
      shelfLocation: 'A-01', unit: 'each', packSizeUnits: 1,
      cost: fromMinor(10n * scale, currency), retailPrice: fromMinor(20n * scale, currency),
      wholesalePrice: fromMinor(18n * scale, currency), wholesaleMinimumQuantity: '5', reorderLevel: '2',
      genericName: '', prescriptionRequired: false, weighedItem: false, pluCode: '', pricePerKg: '',
      expiryTracking: false, variants: [], isActive: true,
    }
    const adminActor = { id: ADMIN.id, username: ADMIN.username, role: ADMIN.role, fullName: ADMIN.fullName }
    const cashierActor = { id: CASHIER.id, username: CASHIER.username, role: CASHIER.role, fullName: CASHIER.fullName }
    let product = harness.inventory.createProduct(productDraft, adminActor, 'BOTH')
    product = harness.inventory.receiveStock({
      productId: product.id, expectedProductVersion: product.rowVersion, expectedStockVersion: product.stockVersion,
      quantity: '20', quantityUnit: 'unit', unitCost: fromMinor(10n * scale, currency),
      supplierName: 'Coastal Medical Supplies', supplierReference: `INV-${currencyCode}`,
      note: 'Accounting report seed', batchNumber: '', expiryDate: '',
    }, adminActor, 'BOTH').product

    const cashierShift = harness.reports.openCashierShift({ openingFloat: fromMinor(100n * scale, currency) }, cashierActor, 'BOTH')
    harness.reports.openCashierShift({ openingFloat: fromMinor(50n * scale, currency) }, adminActor, 'BOTH')
    const customer = harness.pointOfSale.createCustomer({
      name: 'Ada Customer', phone: '+234 800 111 2222', email: 'ada@example.test', address: '4 Market Lane',
      creditLimit: fromMinor(100n * scale, currency), enrolLoyalty: false,
    }, ADMIN, 'BOTH')

    const retailSale = harness.pointOfSale.completeSale({
      idempotencyKey: `report-retail-${currencyCode}`,
      saleType: 'RETAIL',
      items: [{ productId: product.id, quantity: '2', manualDiscount: fromMinor(2n * scale, currency) }],
      payments: [
        { method: 'CASH', amount: fromMinor(20n * scale, currency) },
        { method: 'TRANSFER', amount: fromMinor(18n * scale, currency), reference: 'TRF-REPORT' },
      ],
    }, CASHIER, 'BOTH').receipt
    const wholesaleSale = harness.pointOfSale.completeSale({
      idempotencyKey: `report-wholesale-${currencyCode}`,
      saleType: 'WHOLESALE',
      customerId: customer.id,
      items: [{ productId: product.id, quantity: '5', manualDiscount: fromMinor(5n * scale, currency) }],
      payments: [
        { method: 'CASH', amount: fromMinor(80n * scale, currency) },
        { method: 'CREDIT', amount: fromMinor(5n * scale, currency) },
      ],
    }, ADMIN, 'BOTH').receipt

    const returned = harness.returns.createReturn({
      receiptNumber: retailSale.receiptNumber,
      reason: 'CUSTOMER_CHANGED_MIND',
      reasonNote: 'Report seed return',
      type: 'REFUND',
      refundMethod: 'CASH',
      items: [{ saleItemId: retailSale.items[0]!.id, quantity: '1', condition: 'RESELLABLE' }],
      idempotencyKey: `report-return-${currencyCode}`,
    }, CASHIER, 'BOTH')
    harness.reports.recordCashDrawerEvent({
      shiftId: cashierShift.id,
      type: 'SAFE_DROP', amount: fromMinor(2n * scale, currency), note: 'Seeded safe drop',
    }, CASHIER, 'BOTH')

    return { harness, currency, scale, retailSale, wholesaleSale, returned, cashierActor, adminActor }
  } catch (error) {
    harness.close()
    throw error
  }
}

describe('AccountingReportService', () => {
  it.each(['NGN', 'JPY', 'KWD'])('matches seeded daily/monthly hand calculations and exports valid numeric Excel money cells for %s', async (currencyCode) => {
    const seeded = seedReportTransactions(currencyCode)
    const { harness, currency, scale, retailSale, wholesaleSale, returned, cashierActor, adminActor } = seeded
    try {
      expect(retailSale.totalMinor).toBe(38n * scale)
      expect(wholesaleSale.totalMinor).toBe(85n * scale)
      expect(returned.totalMinor).toBe(19n * scale)

      const dayInput = { period: 'DAY' as const, date: '2026-11-17' }
      const day = harness.reports.getDashboard(dayInput, adminActor, 'BOTH')
      expect(day.header).toMatchObject({
        storeName: 'Harbor Health', storeAddress: '12 Dock Road, Lagos', currency: { code: currencyCode },
        scope: 'STORE', period: { startDate: '2026-11-17', endDate: '2026-11-17' },
      })
      expect(day.summary).toMatchObject({
        grossSalesMinor: 130n * scale,
        totalSalesMinor: 123n * scale,
        transactions: 2,
        retail: { totalMinor: 38n * scale, transactions: 1 },
        wholesale: { totalMinor: 85n * scale, transactions: 1 },
        discountsMinor: 7n * scale,
        returnsMinor: 19n * scale,
        refundsMinor: 19n * scale,
        netSalesMinor: 104n * scale,
        cogsMinor: 60n * scale,
        grossProfitMinor: 44n * scale,
        returnTransactions: 1,
      })
      expect(day.paymentMethods).toEqual([
        { method: 'CASH', totalMinor: 100n * scale, transactions: 2 },
        { method: 'TRANSFER', totalMinor: 18n * scale, transactions: 1 },
        { method: 'CARD', totalMinor: 0n, transactions: 0 },
        { method: 'CREDIT', totalMinor: 5n * scale, transactions: 1 },
      ])
      expect(day.refundMethods).toContainEqual({ method: 'CASH', totalMinor: 19n * scale, transactions: 1 })
      expect(day.cashPosition).toMatchObject({
        openingFloatMinor: 150n * scale,
        cashSalesMinor: 100n * scale,
        cashRefundsMinor: 19n * scale,
        drawerAdjustmentsMinor: -2n * scale,
        expectedCashMinor: 229n * scale,
      })
      expect(day.shifts).toHaveLength(2)
      expect(day.adminReports?.topSellers[0]).toMatchObject({
        sku: `REPORT-${currencyCode}`, quantitySoldMilli: 7_000n, salesMinor: 123n * scale, transactions: 2,
      })
      expect(day.adminReports?.valuation.totalValueMinor).toBe(140n * scale)

      const cashierDay = harness.reports.getDashboard(dayInput, cashierActor, 'BOTH')
      expect(cashierDay.header.scope).toBe('PERSONAL')
      expect(cashierDay.summary).toMatchObject({
        totalSalesMinor: 38n * scale, transactions: 1,
        retail: { totalMinor: 38n * scale, transactions: 1 }, wholesale: { totalMinor: 0n, transactions: 0 },
        discountsMinor: 2n * scale, returnsMinor: 19n * scale, netSalesMinor: 19n * scale,
        cogsMinor: null, grossProfitMinor: null,
      })
      expect(cashierDay.salesByUser.map(({ username }) => username)).toEqual(['reportcashier'])
      expect(cashierDay.adminReports).toBeNull()
      expect(cashierDay.daily[0]?.grossProfitMinor).toBeNull()

      const month = harness.reports.getDashboard({ period: 'MONTH', date: '2026-11' }, adminActor, 'BOTH')
      expect(month.daily).toHaveLength(30)
      expect(month.daily.find(({ date }) => date === '2026-11-17')).toMatchObject({
        totalSalesMinor: 123n * scale, transactions: 2,
        retailSalesMinor: 38n * scale, wholesaleSalesMinor: 85n * scale,
        discountsMinor: 7n * scale, returnsMinor: 19n * scale, netSalesMinor: 104n * scale,
        cogsMinor: 60n * scale, grossProfitMinor: 44n * scale,
      })
      expect(month.daily.filter(({ date }) => date !== '2026-11-17').every(({ netSalesMinor }) => netSalesMinor === 0n)).toBe(true)

      const pharmacyEdition = harness.reports.getDashboard(dayInput, adminActor, 'PHARMACY')
      expect(pharmacyEdition.adminReports?.pharmacy).not.toBeNull()
      expect(pharmacyEdition.adminReports?.supermarket).toBeNull()
      expect(pharmacyEdition.shifts).toEqual([])
      expect(() => harness.reports.openCashierShift({ openingFloat: fromMinor(scale, currency) }, adminActor, 'PHARMACY'))
        .toThrow(/Supermarket license/u)
      const supermarketEdition = harness.reports.getDashboard(dayInput, adminActor, 'SUPERMARKET')
      expect(supermarketEdition.adminReports?.pharmacy).toBeNull()
      expect(supermarketEdition.adminReports?.supermarket).not.toBeNull()
      expect(supermarketEdition.shifts).toHaveLength(2)

      const cashierShift = day.shifts.find(({ cashierId }) => cashierId === CASHIER.id)
      expect(cashierShift).toMatchObject({
        expectedCashMinor: 99n * scale, cashSalesMinor: 20n * scale,
        cashRefundsMinor: 19n * scale, drawerAdjustmentsMinor: -2n * scale,
      })
      const closedShift = harness.reports.closeCashierShift({
        shiftId: cashierShift!.id,
        countedCash: fromMinor(99n * scale + 1n, currency),
      }, cashierActor, 'BOTH')
      expect(closedShift).toMatchObject({ status: 'CLOSED', varianceMinor: 1n, currencyCode: currencyCode })

      const dayClose = harness.reports.closeDay({
        businessDate: '2026-11-17', countedCash: fromMinor(229n * scale + 1n, currency), note: 'Hand checked',
      }, adminActor, 'BOTH')
      expect(dayClose).toMatchObject({
        businessDate: '2026-11-17', currencyCode, storeName: 'Harbor Health', storeAddress: '12 Dock Road, Lagos',
        expectedCashMinor: 229n * scale, countedCashMinor: 229n * scale + 1n, varianceMinor: 1n,
      })
      expect(harness.reports.getDashboard(dayInput, adminActor, 'BOTH').dayClose?.varianceMinor).toBe(1n)

      const csv = harness.reports.exportCsv({ ...dayInput, section: 'summary' }, adminActor, 'BOTH')
      expect(csv).toContain('Harbor Health')
      expect(csv).toContain(currencyCode)
      expect(csv).toContain(fromMinor(104n * scale, currency))

      const workbookBase64 = await harness.reports.exportExcel({ ...dayInput, section: 'summary' }, adminActor, 'BOTH')
      const openedWorkbook = new Workbook()
      const workbookBytes = Buffer.from(workbookBase64, 'base64')
      await openedWorkbook.xlsx.load(workbookBytes as unknown as Parameters<typeof openedWorkbook.xlsx.load>[0])
      const financial = openedWorkbook.getWorksheet('financial-summary')
      expect(financial).toBeDefined()
      expect(financial?.getCell('A1').value).toBe('Harbor Health')
      expect(financial?.getCell('B4').value).toBe(currencyCode)
      expect(financial?.getCell('B10').value).toBe(123)
      expect(typeof financial?.getCell('B10').value).toBe('number')
      expect(financial?.getCell('B10').numFmt).toContain(currencyCode)
      expect(financial?.getCell('B10').numFmt).toContain(currency.decimalPlaces === 0 ? '#,##0' : `.${'0'.repeat(currency.decimalPlaces)}`)
      expect(financial?.getCell('B17').value).toBe(60)
      expect(typeof financial?.getCell('B17').value).toBe('number')
      const cashCloseSheet = openedWorkbook.getWorksheet('cash-close')
      expect(cashCloseSheet?.getCell('A1').value).toBe('Harbor Health')
      expect(cashCloseSheet?.getCell('B4').value).toBe(currencyCode)
      expect(cashCloseSheet?.getCell('G9').value).toBe(229)
      expect(typeof cashCloseSheet?.getCell('G9').value).toBe('number')
      expect(cashCloseSheet?.getCell('G9').numFmt).toContain(currencyCode)
      const shiftSheet = openedWorkbook.getWorksheet('cashier-shifts')
      expect(shiftSheet?.getCell('A1').value).toBe('Harbor Health')
      expect([shiftSheet?.getCell('H9').value, shiftSheet?.getCell('H10').value].sort((left, right) => Number(left) - Number(right))).toEqual([99, 130])
      const cashierShiftRow = [9, 10].find((rowNumber) => shiftSheet?.getCell(`A${rowNumber}`).value === 'Report Cashier')!
      expect(shiftSheet?.getCell(`J${cashierShiftRow}`).value).toBe(1 / Number(scale))
      expect(typeof shiftSheet?.getCell(`J${cashierShiftRow}`).value).toBe('number')

      const pdf = await harness.reports.exportPdf({ ...dayInput, section: 'summary' }, adminActor, 'BOTH')
      expect(Buffer.from(pdf).subarray(0, 5).toString()).toBe('%PDF-')
      expect(Buffer.from(pdf).byteLength).toBeGreaterThan(500)
    } finally {
      harness.close()
    }
  })

  it('rejects invalid periods and restricts day-close saving to an Admin', () => {
    const seeded = seedReportTransactions('NGN')
    try {
      expect(() => seeded.harness.reports.getDashboard({ period: 'DAY', date: '2026-02-30' }, seeded.adminActor, 'BOTH'))
        .toThrow(/valid business date/u)
      expect(() => seeded.harness.reports.closeDay({ businessDate: '2026-11-17', countedCash: '1.00' }, seeded.cashierActor, 'BOTH'))
        .toThrow(/Admin/u)
    } finally {
      seeded.harness.close()
    }
  })
})
