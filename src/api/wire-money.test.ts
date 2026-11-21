import Database from 'better-sqlite3'
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { serializeBigInts } from './serialize-money'
import { getCurrency } from '../currency/catalog'
import { fromMinor } from '../currency/parse'
import { migrateDatabase } from '../db/migrate'
import { SQLiteShopRepository } from '../db/sqlite-shop-repository'
import { PointOfSaleService } from '../services/point-of-sale-service'
import { ProductInventoryService } from '../services/product-inventory-service'
import { AccountingReportService } from '../services/accounting-report-service'
import type { PublicUser } from '../shared/auth/types'
import { defaultPermissions } from '../shared/auth/policy'

/**
 * Money crossing the wire.
 *
 * The host computes in `bigint` minor units and `JSON.stringify` throws on a BigInt, so every successful phone
 * response has to be converted before it is sent. This file has two halves on purpose:
 *
 * 1. the converter itself, on the shapes the services actually produce (nested objects, arrays, null, a Buffer);
 * 2. a Fastify server with a real route in front of a real report containing real money, because the bug this
 *    was written for — `GET /api/v1/mobile/admin/reports` answering 500 with "Do not know how to serialize a
 *    BigInt" — passed every existing refusal test and would still pass them today. The refusal tests never
 *    reach a successful response, so they cannot catch it.
 */

const ADMIN: PublicUser = {
  id: 'wire-admin', fullName: 'Wire Admin', username: 'wireadmin', role: 'ADMIN', isActive: true, isLocked: false,
  permissions: defaultPermissions('ADMIN'),
}

describe('converting a host result for the wire', () => {
  it('turns every bigint into a decimal string, however deeply nested', () => {
    const converted = serializeBigInts({
      totalSalesMinor: 123_456n,
      nested: { zero: 0n, negative: -5n, nil: null, list: [1n, { deep: 2n }] },
      untouched: { text: 'cash', count: 3, flag: true },
      listOfRows: [{ amountMinor: 10n }, { amountMinor: 20n }],
    })
    expect(converted).toEqual({
      totalSalesMinor: '123456',
      nested: { zero: '0', negative: '-5', nil: null, list: ['1', { deep: '2' }] },
      untouched: { text: 'cash', count: 3, flag: true },
      listOfRows: [{ amountMinor: '10' }, { amountMinor: '20' }],
    })
    // The point is that it survives JSON, and keeps every digit of a 64-bit amount.
    expect(JSON.parse(JSON.stringify(converted))).toEqual(converted)
    expect((serializeBigInts({ huge: 9_007_199_254_740_993n }) as { huge: string }).huge).toBe('9007199254740993')
  })

  it('leaves binary payloads alone rather than walking them as objects', () => {
    const bytes = new Uint8Array([37, 80, 68, 70])
    expect(serializeBigInts(bytes)).toBe(bytes)
    expect(serializeBigInts(Buffer.from('pdf'))).toBeInstanceOf(Buffer)
  })
})

describe('a real report with real money survives the wire', () => {
  it.each(['NGN', 'JPY', 'KWD'])('serializes a %s dashboard without throwing', async (code) => {
    const database = new Database(':memory:')
    migrateDatabase(database)
    const repository = new SQLiteShopRepository(database, false)
    const currency = getCurrency(code)!
    repository.saveSettings({
      ...repository.readSettings(),
      profile: { name: 'Wire Test Shop', address: '1 Cable Way', phone: '+234 1 555 0000' },
      currency, display: { amountDisplay: 'symbol', symbolPosition: currency.symbolPosition,
        thousandsSeparator: currency.thousandsSeparator, decimalSeparator: currency.decimalSeparator },
      setupComplete: true, currencyConfirmed: true,
    })
    // `receiveStock` writes a purchase whose `received_by` is a foreign key onto `users.id`, so the actor has
    // to be a real row rather than a literal.
    database.prepare('INSERT INTO users (id, username, password_hash, role, full_name) VALUES (?, ?, ?, ?, ?)')
      .run(ADMIN.id, ADMIN.username, 'test-hash', ADMIN.role, ADMIN.fullName)
    const NOW = Date.now()
    const options = { now: () => NOW }
    const inventory = new ProductInventoryService(database, repository, { ...options, deviceName: 'WIRE-PC' })
    const pos = new PointOfSaleService(database, repository, { ...options, workstation: 'WIRE-PC' })
    const reports = new AccountingReportService(database, repository, options)

    const scale = 10n ** BigInt(currency.decimalPlaces)
    let product = inventory.createProduct({
      sku: `WIRE-${code}`, name: 'Wire test item', brand: '', description: '', barcode: '',
      additionalBarcodes: [], category: 'Test', subCategory: '', department: '', shelfLocation: '',
      unit: 'each', packSizeUnits: 1, cost: fromMinor(10n * scale, currency),
      retailPrice: fromMinor(20n * scale, currency), wholesalePrice: fromMinor(18n * scale, currency),
      wholesaleMinimumQuantity: '1', reorderLevel: '1', genericName: '', prescriptionRequired: false,
      weighedItem: false, pluCode: '', pricePerKg: '', expiryTracking: false, variants: [], isActive: true,
    }, ADMIN, 'BOTH')
    product = inventory.receiveStock({
      productId: product.id, expectedProductVersion: product.rowVersion, expectedStockVersion: product.stockVersion,
      quantity: '5', quantityUnit: 'unit', unitCost: fromMinor(10n * scale, currency),
      supplierName: 'Cable Supplies', supplierReference: `WIRE-${code}`, note: '', batchNumber: '', expiryDate: '',
    }, ADMIN, 'BOTH').product
    pos.completeSale({
      idempotencyKey: `wire-${code}`, saleType: 'RETAIL',
      items: [{ productId: product.id, quantity: '2' }],
      payments: [{ method: 'CASH', amount: fromMinor(40n * scale, currency) }],
    }, ADMIN, 'BOTH')

    const date = new Date(NOW)
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    const report = reports.getDashboard({ period: 'DAY', date: day }, { id: ADMIN.id, username: ADMIN.username, role: 'ADMIN' }, 'BOTH')

    // Fastify with the same send path the phone routes use.
    const server = Fastify({ logger: false })
    server.get('/report', async (_request, reply) => reply
      .header('cache-control', 'no-store')
      .send(serializeBigInts(report)))
    try {
      const response = await server.inject({ method: 'GET', url: '/report' })
      expect(response.statusCode, `report said ${response.body}`).toBe(200)
      const body = response.json()
      expect(body.header.currency.code).toBe(code)
      expect(body.summary.totalSalesMinor).toBe((40n * scale).toString())
      // The figure is a string of minor units, and the phone's own formatter reads it back exactly.
      expect(typeof body.summary.totalSalesMinor).toBe('string')
    } finally {
      await server.close()
      database.close()
    }
  })
})
