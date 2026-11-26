import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { getCurrency } from '../currency/catalog'
import { defaultDisplayOptions } from '../currency/money'
import { migrateDatabase } from '../db/migrate'
import { SQLiteShopRepository } from '../db/sqlite-shop-repository'
import type { PublicUser } from '../shared/auth/types'
import type { ProductDraft, ProductRecord } from '../shared/inventory/types'
import { ProductInventoryService } from './product-inventory-service'
import { PointOfSaleService } from './point-of-sale-service'
import { ReturnService } from './return-service'
import { PRINTABLE_KINDS, PrintGateService, PrintRefusedError } from './print-gate-service'
import { POLICY } from '../../packages/core/src/policy'
import { can } from '../../packages/core/src/capabilities'

/**
 * The print gate: who may print, what is recorded when they do, and what a reprint looks like.
 *
 * The brief is unusually specific here, because a printed receipt is the one artefact a shop cannot take back. Every
 * test asserts on the log row rather than on the return value, on the principle that a ticket saying "printed" is worth
 * nothing if the trail behind it is missing.
 */

const PERMS = { allowWholesale: false, maxDiscountBasisPoints: 0, allowCreditSales: false, returnLimitMinor: 0n }
const PERMS_ACCOUNT = { ...PERMS, allowCreditSales: true, maxDiscountBasisPoints: 500 }
const PERMS_ADMIN = { allowWholesale: true, maxDiscountBasisPoints: 10_000, allowCreditSales: true, returnLimitMinor: 0n }

const ADMIN: PublicUser = { id: 'p-admin', fullName: 'Ada Admin', username: 'ada', role: 'ADMIN', isActive: true, isLocked: false, permissions: PERMS_ADMIN }
const ACCOUNT: PublicUser = { id: 'p-account', fullName: 'Amaka Account', username: 'account1', role: 'ACCOUNT', isActive: true, isLocked: false, permissions: PERMS_ACCOUNT }
const PICKER: PublicUser = { id: 'p-picker', fullName: 'Uche Picker', username: 'user1', role: 'USER', isActive: true, isLocked: false, permissions: PERMS }
const SUPERVISOR: PublicUser = { id: 'p-supervisor', fullName: 'Sam Supervisor', username: 'supervisor1', role: 'SUPERVISOR', isActive: true, isLocked: false, permissions: PERMS }

const NOW = Date.parse('2026-11-17T12:00:00.000Z')

interface Harness {
  database: Database.Database
  shop: SQLiteShopRepository
  pointOfSale: PointOfSaleService
  gate: PrintGateService
  advance: (minutes: number) => void
}

function createHarness(): Harness {
  const database = new Database(':memory:')
  migrateDatabase(database)
  const shop = new SQLiteShopRepository(database, false)
  const currency = getCurrency('NGN')!
  shop.saveSettings({
    ...shop.readSettings(),
    profile: {
      name: 'Harbor Health', address: '12 Dock Road', phone: '+234 1 555 0100', email: 'receipts@harbor.example',
      licenceNumber: 'LIC-204', taxNumber: 'TIN-887', storeLogo: null,
      receiptFooter: 'Keep your receipt.', thankYouNote: 'Thank you for shopping with us.',
    },
    currency,
    display: defaultDisplayOptions(currency),
    setupComplete: true,
    currencyConfirmed: true,
  })
  const insertUser = database.prepare('INSERT INTO users (id, username, password_hash, role, full_name) VALUES (?, ?, ?, ?, ?)')
  const insertPerms = database.prepare(`
    INSERT INTO user_permissions (user_id, allow_wholesale, max_discount_pct, allow_credit_sales, return_limit)
    VALUES (?, ?, ?, ?, ?)
  `)
  for (const user of [ADMIN, ACCOUNT, PICKER, SUPERVISOR]) {
    insertUser.run(user.id, user.username, 'test-hash', user.role, user.fullName)
    insertPerms.run(user.id, user.permissions.allowWholesale ? 1 : 0, user.permissions.maxDiscountBasisPoints,
      user.permissions.allowCreditSales ? 1 : 0, Number(user.permissions.returnLimitMinor))
  }

  let clock = NOW
  let posId = 0
  let returnId = 0
  const pointOfSale = new PointOfSaleService(database, shop, {
    workstation: 'TILL-01', now: () => clock, newId: () => `pos-${++posId}`,
  })
  const returns = new ReturnService(database, shop, {
    workstation: 'TILL-01', now: () => clock, newId: () => `ret-${++returnId}`,
  })
  // The gate is constructed once on the Server, as it is in production: one instance serving every till. Which machine
  // asked is a property of the request, not of the service, and the test below proves that.
  const gate = new PrintGateService(database, shop, pointOfSale, returns, {
    workstation: 'SERVER-PC', now: () => clock,
  })
  return {
    database, shop, pointOfSale, gate,
    advance: (minutes) => { clock += minutes * 60_000 },
  }
}

function productDraft(overrides: Partial<ProductDraft> = {}): ProductDraft {
  return {
    sku: 'PRT-001', name: 'Paracetamol', brand: 'Harbor', description: 'Pain relief',
    barcode: '1234567890123', additionalBarcodes: [], category: 'Analgesics', subCategory: 'General',
    department: '', shelfLocation: '', unit: 'pack', packSizeUnits: 1,
    cost: '10.00', retailPrice: '20.00', wholesalePrice: '18.00', wholesaleMinimumQuantity: '5', reorderLevel: '2',
    genericName: '', prescriptionRequired: false, weighedItem: false, pluCode: '', pricePerKg: '',
    expiryTracking: false, variants: [], isActive: true,
    ...overrides,
  }
}

/** A completed sale to print, made through the real POS path. */
let saleSequence = 0

function completedSale(harness: Harness, key = `print-test-sale-${String(++saleSequence).padStart(4, '0')}`): { saleId: number; receiptNumber: string } {
  const inventory = new ProductInventoryService(harness.database, harness.shop, {
    deviceName: 'TILL-01', now: () => NOW, newId: () => `inv-${Math.random().toString(36).slice(2, 9)}`,
  })
  const sku = `PRT-${String(++saleSequence).padStart(3, '0')}`
  const product: ProductRecord = inventory.createProduct(productDraft({ sku, barcode: `12345678${sku.slice(-5)}` }), ADMIN, 'PHARMACY')
  inventory.receiveStock({
    productId: product.id, expectedProductVersion: product.rowVersion, expectedStockVersion: product.stockVersion,
    quantity: '10', quantityUnit: 'unit', unitCost: '10.00', supplierName: 'Coastal Medical Supplies',
    supplierReference: 'INV-PRT', note: 'Print gate test stock', batchNumber: 'LOT-PRT', expiryDate: '2028-12-31',
  }, ADMIN, 'PHARMACY')
  const result = harness.pointOfSale.completeSale({
    idempotencyKey: key,
    saleType: 'RETAIL',
    items: [{ productId: product.id, quantity: '1' }],
    payments: [{ method: 'CASH', amount: '20.00' }],
  }, ACCOUNT, 'PHARMACY')
  return { saleId: Number(result.receipt.id), receiptNumber: result.receipt.receiptNumber }
}

function logRows(harness: Harness): Array<{
  document_kind: string; document_id: string; copy_no: number; duplicate: number; reprint_reason: string
  printed_by: string; printed_at: string
}> {
  return harness.database.prepare('SELECT * FROM print_log ORDER BY id').all() as never
}

describe('the print endpoint is open to the two roles that may print', () => {
  it('lets an ACCOUNT print and records who, where and when', () => {
    const harness = createHarness()
    const sale = completedSale(harness)

    const ticket = harness.gate.print({ kind: 'SALE', documentId: sale.saleId, layout: 'THERMAL_80' }, ACCOUNT)

    expect(ticket.copyNumber).toBe(1)
    expect(ticket.duplicate).toBe(false)
    expect(ticket.receiptNumber).toBe(sale.receiptNumber)
    const rows = logRows(harness)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      document_kind: 'SALE', document_id: String(sale.saleId), copy_no: 1, duplicate: 0,
      printed_by: ACCOUNT.id, printed_at: '2026-11-17T12:00:00.000Z',
    })
  })

  it('lets the Admin print, on the Server', () => {
    const harness = createHarness()
    const sale = completedSale(harness)
    expect(harness.gate.print({ kind: 'SALE', documentId: sale.saleId, layout: 'A4_RECEIPT' }, ADMIN).copyNumber).toBe(1)
  })
})

describe('the print endpoint is closed to everybody else', () => {
  // Both of these are DONE WHEN items, and both are asserted here rather than only in the policy table: the table says
  // the channel is refused, and this says the service behind it refuses too, so a second caller cannot walk past it.
  const refused: Array<[string, PublicUser]> = [
    ['a USER', PICKER],
    ['a SUPERVISOR', SUPERVISOR],
  ]

  it.each(refused)('refuses %s, and logs nothing', (_label, actor) => {
    const harness = createHarness()
    const sale = completedSale(harness)
    let caught: unknown = null
    try {
      harness.gate.print({ kind: 'SALE', documentId: sale.saleId, layout: 'THERMAL_80' }, actor)
    } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(PrintRefusedError)
    // The refusal names the caller's own role and does not say which role would have been allowed.
    expect(String((caught as Error).message)).not.toMatch(/ACCOUNT/u)
    expect(logRows(harness), 'a refused print leaves no log row').toHaveLength(0)
    // And nothing was handed back to a renderer: the document was never produced.
    expect((harness.database.prepare('SELECT COUNT(*) AS n FROM sale_print_events').get() as { n: number }).n).toBe(0)
  })

  it('refuses a locked account even in a role that may print', () => {
    const harness = createHarness()
    const sale = completedSale(harness)
    expect(() => harness.gate.print({ kind: 'SALE', documentId: sale.saleId, layout: 'THERMAL_80' }, { ...ACCOUNT, isLocked: true }))
      .toThrow(/active signed-in user/u)
    expect(logRows(harness)).toHaveLength(0)
  })

  it('lets a SUPERVISOR read the print log without being able to add to it', () => {
    const harness = createHarness()
    const sale = completedSale(harness)
    harness.gate.print({ kind: 'SALE', documentId: sale.saleId, layout: 'THERMAL_80' }, ACCOUNT)
    // Auditing the Accounts' day includes their reprints, so reading is allowed even though printing is not.
    const log = harness.gate.listPrintLog(SUPERVISOR)
    expect(log).toHaveLength(1)
    expect(log[0]!.printedByName).toBe('Amaka Account')
    expect(() => harness.gate.print({ kind: 'SALE', documentId: sale.saleId, layout: 'THERMAL_80' }, SUPERVISOR))
      .toThrow(PrintRefusedError)
  })

  it('is called as each of the four roles, and only two of them get a document', () => {
    // The brief asks for this by name: a test that calls the print path as each role. Which roles are allowed is
    // derived from `can()` rather than written out here, so the expectation cannot drift from the capability table it
    // enforces — if a role is ever given `print_documents`, this test moves with it instead of quietly contradicting it.
    for (const actor of [ADMIN, ACCOUNT, PICKER, SUPERVISOR]) {
      const harness = createHarness()
      const sale = completedSale(harness)
      // `can()` takes only the four real roles; the legacy `CASHIER` row resolves to USER everywhere else, and
      // resolving it here rather than widening `can()` keeps one alias rule instead of two.
      const mayPrint = can(actor.role === 'CASHIER' ? 'USER' : actor.role, 'print_documents')
      if (mayPrint) {
        const ticket = harness.gate.print({ kind: 'SALE', documentId: sale.saleId, layout: 'THERMAL_80' }, actor)
        expect(ticket.copyNumber, `${actor.role} should get a first copy`).toBe(1)
        expect(ticket.duplicate).toBe(false)
      } else {
        expect(
          () => harness.gate.print({ kind: 'SALE', documentId: sale.saleId, layout: 'THERMAL_80' }, actor),
          `${actor.role} must be refused at the print endpoint`,
        ).toThrowError(PrintRefusedError)
        // A refused print leaves no row behind. A log entry for a document that was never produced would be a lie in
        // the one record whose whole purpose is saying what was printed, by whom, and from where.
        expect(harness.gate.listPrintLog(ADMIN), `${actor.role} must leave no log row`).toHaveLength(0)
      }
      harness.database.close()
    }
    // Asserted outright as well, so a change to the capability table cannot make the loop above pass by shrinking
    // what it checks. These are the two roles the brief names.
    const allowed = (actor: PublicUser): boolean => can(actor.role === 'CASHIER' ? 'USER' : actor.role, 'print_documents')
    expect([ADMIN, ACCOUNT, PICKER, SUPERVISOR].filter(allowed).map((actor) => actor.role))
      .toEqual(['ADMIN', 'ACCOUNT'])
  })

  it('refuses the print log to a picker, who audits nothing', () => {
    const harness = createHarness()
    expect(() => harness.gate.listPrintLog(PICKER)).toThrow(/cannot read the print log/u)
  })
})

describe('a reprint is marked DUPLICATE and needs a reason', () => {
  it('numbers copies in sequence and flags the second as a duplicate', () => {
    const harness = createHarness()
    const sale = completedSale(harness)
    const first = harness.gate.print({ kind: 'SALE', documentId: sale.saleId, layout: 'THERMAL_80' }, ACCOUNT)
    harness.advance(4)
    const second = harness.gate.print({
      kind: 'SALE', documentId: sale.saleId, layout: 'THERMAL_80', reason: 'Customer asked for a copy',
    }, ACCOUNT)

    expect(first).toMatchObject({ copyNumber: 1, duplicate: false })
    expect(second).toMatchObject({ copyNumber: 2, duplicate: true })
    const rows = logRows(harness)
    expect(rows.map((row) => row.copy_no)).toEqual([1, 2])
    expect(rows[1]!.duplicate).toBe(1)
    expect(rows[1]!.reprint_reason).toBe('Customer asked for a copy')
    expect(rows[1]!.printed_at).toBe('2026-11-17T12:04:00.000Z')
  })

  it('refuses a reprint with no reason, and logs nothing', () => {
    const harness = createHarness()
    const sale = completedSale(harness)
    harness.gate.print({ kind: 'SALE', documentId: sale.saleId, layout: 'THERMAL_80' }, ACCOUNT)
    expect(() => harness.gate.print({ kind: 'SALE', documentId: sale.saleId, layout: 'THERMAL_80' }, ACCOUNT))
      .toThrow(/Give a reason for printing this document again/u)
    expect(() => harness.gate.print({
      kind: 'SALE', documentId: sale.saleId, layout: 'THERMAL_80', reason: '   ',
    }, ACCOUNT)).toThrow(/Give a reason/u)
    expect(logRows(harness), 'the refused reprints are not recorded as copies').toHaveLength(1)
  })

  it('does not demand a reason for the first copy', () => {
    const harness = createHarness()
    const sale = completedSale(harness)
    expect(() => harness.gate.print({ kind: 'SALE', documentId: sale.saleId, layout: 'THERMAL_80' }, ACCOUNT)).not.toThrow()
  })

  it('numbers copies per document, so a second receipt starts again at one', () => {
    const harness = createHarness()
    const first = completedSale(harness, 'print-test-sale-a')
    const second = completedSale(harness, 'print-test-sale-b')
    harness.gate.print({ kind: 'SALE', documentId: first.saleId, layout: 'THERMAL_80' }, ACCOUNT)
    harness.gate.print({ kind: 'SALE', documentId: first.saleId, layout: 'THERMAL_80', reason: 'Jam' }, ACCOUNT)
    const ticket = harness.gate.print({ kind: 'SALE', documentId: second.saleId, layout: 'THERMAL_80' }, ACCOUNT)
    expect(ticket.copyNumber, 'a different document is not a reprint of the first').toBe(1)
    expect(ticket.duplicate).toBe(false)
  })

  it('audits a reprint separately from a first print', () => {
    const harness = createHarness()
    const sale = completedSale(harness)
    harness.gate.print({ kind: 'SALE', documentId: sale.saleId, layout: 'THERMAL_80' }, ACCOUNT)
    harness.gate.print({ kind: 'SALE', documentId: sale.saleId, layout: 'THERMAL_80', reason: 'Faded' }, ACCOUNT)
    const actions = (harness.database.prepare('SELECT action, metadata_json FROM audit_log ORDER BY rowid').all() as
      Array<{ action: string; metadata_json: string }>).filter((row) => row.action.startsWith('print.'))
    expect(actions.map((row) => row.action)).toEqual(['print.issued', 'print.duplicate'])
    expect(JSON.parse(actions[1]!.metadata_json)).toMatchObject({ copyNumber: 2, duplicate: true, reason: 'Faded' })
  })
})

describe('a reprint shows the original snapshot, not today\'s settings', () => {
  it('keeps the store name the sale was made under after the shop is renamed', () => {
    const harness = createHarness()
    const sale = completedSale(harness)
    const first = harness.gate.print({ kind: 'SALE', documentId: sale.saleId, layout: 'THERMAL_80' }, ACCOUNT)
    const documentBefore = first.document as { store: { name: string } }
    expect(documentBefore.store.name).toBe('Harbor Health')

    // The shop renames itself. A reprint of an old receipt must still say Harbor Health: the customer bought from the
    // shop as it was named then, and a receipt that changes after the fact is not a record of anything.
    harness.shop.saveSettings({
      ...harness.shop.readSettings(),
      profile: { ...harness.shop.readSettings().profile, name: 'Harbor Health and Beauty' },
    })

    const reprint = harness.gate.print({
      kind: 'SALE', documentId: sale.saleId, layout: 'THERMAL_80', reason: 'Customer asked for a copy',
    }, ACCOUNT)
    const documentAfter = reprint.document as { store: { name: string }; currency: { code: string } }
    expect(documentAfter.store.name, 'the snapshot holds').toBe('Harbor Health')
    expect(documentAfter.currency.code).toBe('NGN')

    // A new sale picks up the new name, so the rename is not simply ignored.
    const fresh = completedSale(harness, 'print-test-sale-renamed')
    const freshTicket = harness.gate.print({ kind: 'SALE', documentId: fresh.saleId, layout: 'THERMAL_80' }, ACCOUNT)
    expect((freshTicket.document as { store: { name: string } }).store.name).toBe('Harbor Health and Beauty')
  })
})

describe('printing is blocked when the shop has no name to print', () => {
  it('refuses and points at Settings rather than printing a blank header', () => {
    const harness = createHarness()
    // The name has to be missing when the sale is *made*, because a completed sale cannot be edited afterwards —
    // `completed_sales_cannot_be_changed` refuses the UPDATE, which is the guarantee that reprints never change. The
    // sale snapshots whatever the settings said, and a blank snapshot is what this blocks.
    harness.shop.saveSettings({
      ...harness.shop.readSettings(),
      profile: { ...harness.shop.readSettings().profile, name: '   ' },
    })
    const sale = completedSale(harness)

    let caught: unknown = null
    try {
      harness.gate.print({ kind: 'SALE', documentId: sale.saleId, layout: 'THERMAL_80' }, ACCOUNT)
    } catch (error) { caught = error }
    expect(String((caught as Error).message)).toMatch(/store name/u)
    // The message has to send the Admin somewhere, not just say no.
    expect(String((caught as Error).message)).toMatch(/store details|Settings/u)
    expect(logRows(harness), 'a blocked print is not a copy').toHaveLength(0)
  })
})

describe('the log records the machine that asked, not the Server', () => {
  it('reports the till that printed, when the request came from a client PC', () => {
    const harness = createHarness()
    const sale = completedSale(harness)
    const ticket = harness.gate.print(
      { kind: 'SALE', documentId: sale.saleId, layout: 'THERMAL_80' },
      ACCOUNT,
      { pcName: 'TILL-07' },
    )
    // The brief asks for the PC on every print log entry. The gate runs on the Server, so a name captured at
    // construction would have blamed the Server for every receipt in the shop.
    expect(ticket.workstation).toBe('TILL-07')
  })

  it('falls back to the Server\'s own window for a print asked for on the Server', () => {
    const harness = createHarness()
    const sale = completedSale(harness)
    expect(harness.gate.print({ kind: 'SALE', documentId: sale.saleId, layout: 'THERMAL_80' }, ADMIN).workstation)
      .toBe('SERVER-PC')
  })

  it('records the client device on the log row when there is one', () => {
    const harness = createHarness()
    const sale = completedSale(harness)
    harness.database.prepare(`
      INSERT INTO client_devices (id, name, os, last_seen) VALUES ('dev-1', 'TILL-07', 'Windows 10', '2026-11-17T12:00:00.000Z')
    `).run()
    harness.gate.print({ kind: 'SALE', documentId: sale.saleId, layout: 'THERMAL_80' }, ACCOUNT,
      { pcName: 'TILL-07', clientDeviceId: 'dev-1' })
    const row = harness.database.prepare('SELECT client_device_id FROM print_log').get() as { client_device_id: string | null }
    expect(row.client_device_id).toBe('dev-1')
    // And the Admin's log reads the device name back, so a revoked device does not blank the entry.
    expect(harness.gate.listPrintLog(ADMIN)[0]!.workstation).toBe('TILL-07')
  })
})

describe('the layout is validated before anything is printed', () => {
  it('refuses a layout no renderer can draw', () => {
    const harness = createHarness()
    const sale = completedSale(harness)
    expect(() => harness.gate.print({
      kind: 'SALE', documentId: sale.saleId, layout: 'A3_POSTER' as never,
    }, ACCOUNT)).toThrow(/Choose a receipt layout/u)
    expect(logRows(harness)).toHaveLength(0)
  })

  it('accepts each of the four layouts the brief names', () => {
    const harness = createHarness()
    const sale = completedSale(harness)
    const layouts = ['THERMAL_80', 'THERMAL_58', 'A4_RECEIPT', 'A4_INVOICE'] as const
    for (const [index, layout] of layouts.entries()) {
      expect(() => harness.gate.print({
        kind: 'SALE', documentId: sale.saleId, layout,
        // The first copy needs no reason; every later one does, which is the rule the reprint tests assert.
        reason: index === 0 ? undefined : `Reprinted on ${layout}`,
      }, ACCOUNT), layout).not.toThrow()
    }
    expect(logRows(harness).map((row) => row.copy_no)).toEqual([1, 2, 3, 4])
  })
})

describe('nothing that is not a receipt or a credit note can reach the printer', () => {
  /**
   * The brief's requirement is "no receipt printing from the audit and report screens". The desktop answers it by never
   * offering a print button on those screens — but a screen that does not offer something is not a guarantee, and the
   * guarantee has to live where the printer is. These tests are that guarantee.
   */

  // Derived from the exported list rather than written out, so adding a printable kind is a change that has to be made
  // in the service and breaks this test on the way past.
  it('offers exactly two kinds of document, and neither is an audit or a report', () => {
    expect([...PRINTABLE_KINDS].sort()).toEqual(['RETURN', 'SALE'])
    for (const forbidden of ['AUDIT', 'REPORT', 'DAY_CLOSE', 'SIGN_OFF', 'FLAG']) {
      expect(PRINTABLE_KINDS).not.toContain(forbidden as never)
    }
  })

  it.each(['AUDIT', 'REPORT', 'DAY_CLOSE'])('refuses a %s subject, even for the Admin who may print everything else', (kind) => {
    const harness = createHarness()
    const sale = completedSale(harness)
    expect(() => harness.gate.print({
      // A real sale id, so what is being refused is the *kind* and not a document that happens not to exist. Without
      // this, the test would pass for the wrong reason: an unknown kind used to fall into the returns branch and fail
      // there with "that return could not be found", which is a different sentence with a different meaning.
      kind: kind as never, documentId: sale.saleId, layout: 'THERMAL_80',
    }, ADMIN)).toThrowError('Only a receipt or a credit note can be printed. An audit and a report are files, not documents to hand over.')
    expect(logRows(harness), 'a refused kind leaves no log row').toHaveLength(0)
  })

  it('refuses an audit subject before reading anything about the document', () => {
    const harness = createHarness()
    // Nothing has been sold, so there is no document to read at all. The refusal is still the kind refusal, which proves
    // the order: a caller learns nothing about whether an id exists.
    expect(() => harness.gate.print({
      kind: 'AUDIT' as never, documentId: '999999', layout: 'A4_INVOICE',
    }, ADMIN)).toThrowError(/Only a receipt or a credit note can be printed/u)
    expect(logRows(harness)).toHaveLength(0)
  })

  it('refuses the Supervisor, who is the person the audit screen belongs to', () => {
    const harness = createHarness()
    const sale = completedSale(harness)
    // The auditor holds view_audit, write_audit_note and export_audit, and no printing capability at all. That is not a
    // gap in the role table: a Supervisor who could print a receipt could produce a document nobody at the till made.
    expect(can('SUPERVISOR', 'print_documents')).toBe(false)
    expect(can('SUPERVISOR', 'view_audit')).toBe(true)
    expect(can('SUPERVISOR', 'export_audit')).toBe(true)
    expect(() => harness.gate.print({ kind: 'SALE', documentId: sale.saleId, layout: 'THERMAL_80' }, SUPERVISOR))
      .toThrowError(PrintRefusedError)
    expect(logRows(harness)).toHaveLength(0)
  })

  it('has no audit channel in the policy table that could print, and no print channel an auditor can reach', () => {
    const auditChannels = Object.keys(POLICY).filter((key) => key.startsWith('ipc:audit:'))
    expect(auditChannels.length).toBeGreaterThan(0)
    for (const channel of auditChannels) {
      expect(channel, `${channel} looks like a print channel`).not.toMatch(/print/u)
    }
    // And the way back: every channel that does print is closed to a Supervisor, so the audit's own role cannot reach a
    // printer through some other door.
    const printChannels = Object.keys(POLICY).filter((key) => key.includes('print'))
    expect(printChannels.length).toBeGreaterThan(0)
    for (const channel of printChannels) {
      const entry = POLICY[channel as keyof typeof POLICY]
      if (channel === 'ipc:print:log') {
        // Reading the log is the auditor's business; making an entry in it is not. The distinction is the capability.
        expect(entry.roles).toContain('SUPERVISOR')
        expect(can('SUPERVISOR', 'print_documents')).toBe(false)
        continue
      }
      expect(entry.roles, `${channel} is reachable by a Supervisor`).not.toContain('SUPERVISOR')
    }
  })

  it('can read a REPORT row from the log without being able to write one', () => {
    const harness = createHarness()
    // The schema is wider than the gate on purpose: print_log records history, and a REPORT row written by an earlier
    // build is still a fact about the shop. The audit reads those rows; the gate can no longer produce them.
    harness.database.prepare(`
      INSERT INTO print_log (document_kind, document_id, copy_no, duplicate, printed_by, printed_at, reprint_reason)
      VALUES ('REPORT', 'day-2026-11-17', 1, 0, ?, '2026-11-17T12:00:00.000Z', '')
    `).run(ADMIN.id)
    expect(harness.database.prepare(`
      SELECT COUNT(*) AS n FROM print_log WHERE document_kind = 'REPORT'
    `).get()).toEqual({ n: 1 })
    expect(() => harness.gate.print({
      kind: 'REPORT' as never, documentId: 'day-2026-11-17', layout: 'A4_RECEIPT',
    }, ADMIN)).toThrowError(/Only a receipt or a credit note can be printed/u)
    // The pre-existing row is untouched and no second one appeared.
    expect(harness.database.prepare('SELECT COUNT(*) AS n FROM print_log').get()).toEqual({ n: 1 })
  })
})
