import Database from 'better-sqlite3'
import { hash as bcryptHash } from 'bcryptjs'
import { describe, expect, it, vi } from 'vitest'
import { defaultDisplayOptions, formatMoney } from '../currency/money'
import { getCurrency } from '../currency/catalog'
import { registerDesktopIpc } from '../main/ipc'
import type { IpcMain } from 'electron'
import { migrateDatabase } from '../db/migrate'
import { SQLiteShopRepository } from '../db/sqlite-shop-repository'
import { SQLiteUserRepository } from '../db/sqlite-user-repository'
import type { LicensePolicyProvider, VerifiedLicensePolicy } from '../license/setup-policy'
import type { CreateUserInput, UserPermissions } from '../shared/auth/types'
import { defaultPermissions } from '../shared/auth/policy'
import type { FirstRunInput } from '../shared/shop/types'
import { AuthService } from './auth-service'
import { SetupService } from './setup-service'
import { ShopService } from './shop-service'
import { UserService } from './user-service'
import { DesktopHostController } from '../main/desktop-host-controller'
import { ProductInventoryService } from './product-inventory-service'
import { PointOfSaleService } from './point-of-sale-service'
import { ReturnService } from './return-service'
import { AccountingReportService } from './accounting-report-service'
import type { MobileAccessService } from './mobile-access-service'
import type { ProductDraft } from '../shared/inventory/types'

const ADMIN_PASSWORD = 'Admin-Pass!2026'
const CASHIER_PASSWORD = 'Cashier-Pass!2026'
const GHS = getCurrency('GHS')!
const TEST_LICENSE_POLICY: VerifiedLicensePolicy = {
  licenseId: 'test-policy', edition: 'PHARMACY', defaultCurrencyCode: null, lockCurrency: false,
}

function firstRunInput(currency = GHS): FirstRunInput {
  return {
    admin: { fullName: 'Amina Okafor', username: 'shopadmin', password: ADMIN_PASSWORD, confirmPassword: ADMIN_PASSWORD },
    profile: {
      name: 'Harbor Health Pharmacy',
      address: '12 Dock Road, Lagos',
      phone: '+234 1 555 0100',
      email: 'hello@harbor.example',
      licenceNumber: 'PCN-4821',
      taxNumber: 'VAT-0048',
      storeLogo: null,
      receiptFooter: 'Keep your receipt.',
      thankYouNote: 'Thank you for choosing us.',
    },
    currency,
    display: defaultDisplayOptions(currency),
    currencyConfirmed: true,
  }
}

function createFixture(policy: VerifiedLicensePolicy | null = TEST_LICENSE_POLICY, mobileAccess?: MobileAccessService) {
  const database = new Database(':memory:')
  migrateDatabase(database)
  const shop = new SQLiteShopRepository(database, false)
  const users = new SQLiteUserRepository(database)
  let clock = 1_000_000
  let generatedId = 0
  const license: LicensePolicyProvider = { getVerifiedPolicy: () => policy }
  const setup = new SetupService(shop, users, shop, license, () => new Date('2026-11-17T12:00:00.000Z'), () => `user-${++generatedId}`)
  // Client PC: these tests sign in Cashiers and Supervisors, which a server install correctly refuses. The role is
  // declared here rather than the rule being relaxed, so the sign-in scoping stays enforced in every fixture that does
  // not need to exercise a server.
  const auth = new AuthService(users, shop, { deviceName: 'TEST-DESKTOP', ipAddress: null }, () => new Date('2026-11-17T12:00:00.000Z'), () => clock,
    { app: 'client', allowAdminOnClients: () => true },
  )
  const shopService = new ShopService(shop, { deviceName: 'TEST-DESKTOP', ipAddress: null }, () => new Date('2026-11-17T12:00:00.000Z'), () => `entry-${++generatedId}`)
  const userService = new UserService(users, shop, () => new Date('2026-11-17T12:00:00.000Z'), () => `managed-user-${++generatedId}`)
  const inventory = new ProductInventoryService(database, shop, {
    deviceName: 'TEST-DESKTOP', now: () => Date.parse('2026-11-17T12:00:00.000Z'), newId: () => `inventory-${++generatedId}`,
  })
  const pointOfSale = new PointOfSaleService(database, shop, {
    workstation: 'TEST-DESKTOP', now: () => Date.parse('2026-11-17T12:00:00.000Z'), newId: () => `pos-${++generatedId}`,
  })
  const returns = new ReturnService(database, shop, {
    workstation: 'TEST-DESKTOP', now: () => Date.parse('2026-11-17T12:00:00.000Z'), newId: () => `return-${++generatedId}`,
  })
  const reports = new AccountingReportService(database, shop, { now: () => Date.parse('2026-11-17T12:00:00.000Z') })
  const host = new DesktopHostController(shop, users, setup, auth, userService, shopService, () => clock, '0.1.0', undefined, inventory, pointOfSale, returns, reports, mobileAccess)
  return {
    database, shop, users, setup, auth, shopService, userService, inventory, pointOfSale, returns, reports, host,
    setClock(value: number) { clock = value },
    close() { database.close() },
  }
}

function inventoryProductDraft(overrides: Partial<ProductDraft> = {}): ProductDraft {
  return {
    sku: 'HOST-001', name: 'Host Test Product', brand: '', description: '', barcode: '6677889900112', additionalBarcodes: [],
    category: 'General', subCategory: '', department: '', shelfLocation: '', unit: 'each', packSizeUnits: 1,
    cost: '1.00', retailPrice: '2.00', wholesalePrice: '1.50', wholesaleMinimumQuantity: '2', reorderLevel: '1',
    genericName: '', prescriptionRequired: false, weighedItem: false, pluCode: '', pricePerKg: '', expiryTracking: false,
    variants: [], isActive: true, ...overrides,
  }
}

function cashierInput(username: string, permissions: UserPermissions = defaultPermissions('CASHIER')): CreateUserInput {
  return {
    fullName: username === 'cashier.on' ? 'Cashier One' : username === 'cashier.off' ? 'Cashier Two' : username,
    username,
    password: CASHIER_PASSWORD,
    confirmPassword: CASHIER_PASSWORD,
    role: 'CASHIER',
    permissions,
  }
}

describe('first-run setup and authentication phase', () => {
  it('gates setup and login until the host supplies a verified active license policy', async () => {
    const fixture = createFixture(null)
    try {
      await fixture.host.initialize()
      const bootstrap = await fixture.host.getBootstrap(1)
      expect(bootstrap.setupContext.licenseActivated).toBe(false)
      expect(bootstrap.hasUsers).toBe(false)
      await expect(fixture.host.completeFirstRun(firstRunInput())).rejects.toThrow(/activate a valid infoflex licence/i)
      await expect(fixture.host.login(1, { username: 'shopadmin', password: ADMIN_PASSWORD })).rejects.toThrow(/activate a valid infoflex licence/i)
    } finally {
      fixture.close()
    }
  })

  it('preselects the installer currency, requires a store name, and saves the full setup with an Admin atomically', async () => {
    const fixture = createFixture()
    try {
      fixture.shop.setInstallerCurrencyCode(' ghs ')
      const context = await fixture.setup.getSetupContext()
      expect(context.initialCurrency.code).toBe('GHS')
      expect(context.installerCurrencyCode).toBe('GHS')
      expect(context.currencyLocked).toBe(false)
      expect(context.vendorCurrencyLocked).toBe(false)

      const invalid = firstRunInput(GHS)
      invalid.profile.name = '  '
      await expect(fixture.setup.completeFirstRun(invalid)).rejects.toThrow(/store name/i)
      expect(fixture.users.countUsers()).toBe(0)
      expect(fixture.shop.readSettings().setupComplete).toBe(false)

      const result = await fixture.setup.completeFirstRun(firstRunInput(GHS))
      expect(result.admin).toMatchObject({
        fullName: 'Amina Okafor', username: 'shopadmin', role: 'ADMIN', isActive: true, isLocked: false,
      })
      expect(result.settings).toMatchObject({
        profile: {
          name: 'Harbor Health Pharmacy', address: '12 Dock Road, Lagos', phone: '+234 1 555 0100',
          email: 'hello@harbor.example', licenceNumber: 'PCN-4821', taxNumber: 'VAT-0048',
          receiptFooter: 'Keep your receipt.', thankYouNote: 'Thank you for choosing us.',
        },
        currency: { code: 'GHS' }, setupComplete: true, currencyConfirmed: true,
      })
      expect(formatMoney(123456789n, result.settings.currency, result.settings.display)).toContain(GHS.symbol)
      expect(fixture.database.prepare("SELECT action FROM audit_log WHERE action = 'currency.selected'").get()).toEqual({ action: 'currency.selected' })
      const stored = fixture.users.getUserByUsername('shopadmin')!
      expect(stored.passwordHash).not.toBe(ADMIN_PASSWORD)
      expect(stored.passwordHash.startsWith('$2')).toBe(true)
      expect(fixture.users.countUsers()).toBe(1)
      expect(fixture.database.prepare("SELECT action FROM audit_log WHERE action = 'first_run.setup.completed'").get()).toEqual({ action: 'first_run.setup.completed' })
    } finally {
      fixture.close()
    }
  })

  it('locks a vendor-selected currency and exposes an explicit read-only setup state', async () => {
    const vendorPolicy: VerifiedLicensePolicy = {
      licenseId: 'license-test', edition: 'BOTH', defaultCurrencyCode: 'USD', lockCurrency: true,
    }
    const fixture = createFixture(vendorPolicy)
    try {
      fixture.shop.setInstallerCurrencyCode('NGN')
      const context = await fixture.setup.getSetupContext()
      expect(context.initialCurrency.code).toBe('USD')
      expect(context.installerCurrencyCode).toBe('NGN')
      expect(context.currencyLocked).toBe(true)
      expect(context.vendorCurrencyLocked).toBe(true)

      await expect(fixture.setup.completeFirstRun(firstRunInput(getCurrency('NGN')!))).rejects.toThrow(/locked/i)
      const result = await fixture.setup.completeFirstRun(firstRunInput(getCurrency('USD')!))
      expect(result.settings.currency.code).toBe('USD')
      expect(fixture.shop.isCurrencyLockedByVendor()).toBe(true)
      expect(fixture.shop.readSettings().currencyLocked).toBe(true)
    } finally {
      fixture.close()
    }
  })

  it('rolls back the Admin and shop settings when the setup audit cannot be written', async () => {
    const fixture = createFixture()
    try {
      fixture.database.exec(`
        CREATE TRIGGER reject_setup_audit BEFORE INSERT ON audit_log
        BEGIN SELECT RAISE(ABORT, 'audit storage unavailable'); END;
      `)
      await expect(fixture.setup.completeFirstRun(firstRunInput())).rejects.toThrow(/audit storage unavailable/i)
      expect(fixture.users.countUsers()).toBe(0)
      expect(fixture.shop.readSettings().setupComplete).toBe(false)
    } finally {
      fixture.close()
    }
  })

  it('locks after five failures, rejects overlong bcrypt suffixes, and audits login outcomes', async () => {
    const fixture = createFixture()
    try {
      const permissions = defaultPermissions('CASHIER')
      const hash = await bcryptHash(CASHIER_PASSWORD, 4)
      fixture.users.createUser({
        id: 'auth-cashier', fullName: 'Cashier User', username: 'cashier', passwordHash: hash,
        role: 'CASHIER', permissions,
      })
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await expect(fixture.auth.login({ username: 'cashier', password: 'Wrong-Password!1' })).rejects.toThrow(/unable to sign in/i)
      }
      expect(fixture.users.getUserByUsername('cashier')?.isLocked).toBe(true)
      expect((fixture.database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'auth.login.failed'").get() as { count: number }).count).toBe(5)
      await expect(fixture.auth.login({ username: 'cashier', password: CASHIER_PASSWORD })).rejects.toThrow(/unable to sign in/i)
      expect(fixture.users.getUserByUsername('cashier')?.isLocked).toBe(true)

      const boundaryPassword = `${CASHIER_PASSWORD}${'x'.repeat(55)}`
      expect(new TextEncoder().encode(boundaryPassword).length).toBe(72)
      fixture.users.createUser({
        id: 'auth-long-password', fullName: 'Long Password User', username: 'longpass',
        passwordHash: await bcryptHash(boundaryPassword, 4), role: 'CASHIER', permissions,
      })
      await expect(fixture.auth.login({ username: 'longpass', password: `${boundaryPassword}trailing` })).rejects.toThrow(/unable to sign in/i)
      await expect(fixture.auth.login({ username: 'longpass', password: boundaryPassword })).resolves.toMatchObject({ username: 'longpass' })
      expect((fixture.database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'auth.login.succeeded'").get() as { count: number }).count).toBe(1)
    } finally {
      fixture.close()
    }
  })

  it('authorizes Admin, Supervisor, and Cashier operations in the host and blocks direct IPC attempts', async () => {
    const bothPolicy: VerifiedLicensePolicy = { ...TEST_LICENSE_POLICY, licenseId: 'both-edition', edition: 'BOTH' }
    const fixture = createFixture(bothPolicy)
    try {
      await fixture.host.initialize()
      await fixture.host.completeFirstRun(firstRunInput())
      const loginBootstrap = await fixture.host.getBootstrap(1)
      expect(loginBootstrap.hasUsers).toBe(true)
      expect(loginBootstrap.currentUser).toBeNull()
      expect(loginBootstrap.settings.profile).toEqual({ name: 'Harbor Health Pharmacy', address: '', phone: '' })
      await fixture.host.login(1, { username: 'shopadmin', password: ADMIN_PASSWORD })
      expect((await fixture.host.getBootstrap(1)).settings.profile.email).toBe('hello@harbor.example')
      await expect(fixture.host.completeFirstRun(firstRunInput())).rejects.toThrow(/already been completed/i)

      const inventoryProduct = fixture.host.saveProduct(1, inventoryProductDraft())
      expect(inventoryProduct).toMatchObject({ sku: 'HOST-001', name: 'Host Test Product' })
      const initialAdminOverview = fixture.host.getInventoryOverview(1)
      expect(initialAdminOverview.products.map((product) => product.id)).toContain(inventoryProduct.id)
      expect(initialAdminOverview.products.find((product) => product.id === inventoryProduct.id)?.costMinor).toBe(100n)

      // These are ACCOUNTs, not the deprecated CASHIER. The brief gives the till to ACCOUNT; a CASHIER row now resolves
      // to USER, which may build an order but may not export a product list or open reports. Using the role the brief
      // actually names keeps this test about the till rather than about the alias.
      const cashierOn = await fixture.host.createUser(1, { ...cashierInput('cashier.on'), role: 'ACCOUNT' })
      const cashierOff = await fixture.host.createUser(1, {
        ...cashierInput('cashier.off'),
        role: 'ACCOUNT',
        permissions: {
          ...defaultPermissions('CASHIER'),
          allowWholesale: false,
          maxDiscountBasisPoints: 725,
          allowCreditSales: true,
          returnLimitMinor: 123456n,
        },
      })
      const supervisorInput: CreateUserInput = {
        ...cashierInput('supervisor'), fullName: 'Store Supervisor', role: 'SUPERVISOR',
        permissions: { ...defaultPermissions('SUPERVISOR'), maxDiscountBasisPoints: 250 },
      }
      const supervisor = await fixture.host.createUser(1, supervisorInput)
      expect(cashierOn.permissions.allowWholesale).toBe(true)
      expect(cashierOff.permissions).toMatchObject({ allowWholesale: false, maxDiscountBasisPoints: 725, allowCreditSales: true, returnLimitMinor: 123456n })

      await fixture.host.login(2, { username: 'cashier.on', password: CASHIER_PASSWORD })
      await fixture.host.login(3, { username: 'cashier.off', password: CASHIER_PASSWORD })
      await fixture.host.login(4, { username: 'supervisor', password: CASHIER_PASSWORD })
      expect(fixture.host.getInventoryOverview(2).products[0]?.costMinor).toBeNull()
      // A product-list export carries supplier cost columns, so it needs product-edit rights, which belong to the Admin.
      // An ACCOUNT may view stock (the line above) but may not export the price file.
      expect(() => fixture.host.exportProductsCsv(2)).toThrow(/permission/i)
      expect(() => fixture.host.saveProduct(2, inventoryProductDraft({ sku: 'CASHIER-CREATE' }))).toThrow(/Admin/u)
      expect(() => fixture.host.saveProduct(4, inventoryProductDraft({ sku: 'SUPERVISOR-CREATE' }))).toThrow(/Admin/u)
      expect(fixture.host.canMakeWholesaleSale(2)).toBe(true)
      expect(fixture.host.canMakeWholesaleSale(3)).toBe(false)
      expect(fixture.host.openPage(2, 'pos')).toEqual({ page: 'pos' })
      expect(fixture.host.listPosCustomers(2)).toEqual([])
      expect(() => fixture.host.listPosCustomers(0)).toThrow(/session has expired/i)
      // A SUPERVISOR is audit-only. It may export the *audit* trail but holds no view of the shop's accounts, so the
      // reports page is refused. This assertion used to require it to open; the brief moved, and the stricter
      // expectation is recorded here rather than the page being reopened to keep an older test passing.
      expect(() => fixture.host.openPage(4, 'reports')).toThrow(/permission/i)
      expect(() => fixture.host.openPage(2, 'users')).toThrow(/permission/i)
      expect(() => fixture.host.openPage(2, 'mobile')).toThrow(/permission/i)
      expect(() => fixture.host.openPage(2, 'settings')).toThrow(/permission/i)
      expect(() => fixture.host.openPage(4, 'users')).toThrow(/permission/i)
      expect(() => fixture.host.listUsers(2)).toThrow(/admin/i)
      expect(fixture.host.getShopSettings(2).profile.name).toBe('Harbor Health Pharmacy')
      expect(() => fixture.host.getShopSettings(0)).toThrow(/session has expired/i)
      expect(() => fixture.host.updateIdleTimeout(2, 30)).toThrow(/admin/i)
      expect(fixture.host.openPage(2, 'returns')).toEqual({ page: 'returns' })
      // A SUPERVISOR is audit-only: the brief says it "cannot ... sell, change stock, or approve anything", and returns
      // are a money movement. This assertion previously required the page to open for a supervisor.
      expect(() => fixture.host.openPage(4, 'returns')).toThrow(/permission/i)

      const received = fixture.host.receiveStock(1, {
        productId: inventoryProduct.id, expectedProductVersion: inventoryProduct.rowVersion,
        expectedStockVersion: inventoryProduct.stockVersion, quantity: '1', quantityUnit: 'unit', unitCost: '1.00',
        supplierName: 'Coastal Supplies', supplierReference: 'HOST-RETURN-STOCK-001', note: 'Host return integration test',
        batchNumber: '', expiryDate: '',
      })
      const hostReceipt = fixture.host.completePosSale(1, {
        idempotencyKey: 'host-return-sale-0001', saleType: 'RETAIL',
        items: [{ productId: inventoryProduct.id, quantity: '1' }],
        payments: [{ method: 'CASH', amount: '2.00' }],
      }).receipt
      expect(received.product.quantityMilli).toBe(1_000n)

      const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
      const ipcStub = {
        handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) { handlers.set(channel, handler) },
      }
      registerDesktopIpc(ipcStub as unknown as Pick<IpcMain, 'handle'>, fixture.host)
      const ipcEvent = (id: number) => {
        const mainFrame = {}
        return { sender: { id, mainFrame }, senderFrame: mainFrame }
      }
      const invoke = (channel: string, senderId: number, ...args: unknown[]) => handlers.get(channel)!(ipcEvent(senderId), ...args)
      await expect(Promise.resolve().then(() => invoke('inventory:save-product', 2, inventoryProductDraft({ sku: 'IPC-CASHIER' })))).rejects.toThrow(/Admin/u)
      // A product export carries supplier cost, so it needs product-edit rights and is refused to an ACCOUNT. This
      // asserts the same rule through the IPC channel that the direct host call above asserts, which is the point of
      // the second half of this test: a forbidden action is refused whether it arrives as a method call or an IPC frame.
      await expect(Promise.resolve().then(() => invoke('inventory:export-csv', 2))).rejects.toThrow(/permission/i)
      await expect(Promise.resolve().then(() => invoke('pos:list-customers', 2))).resolves.toEqual([])
      await expect(Promise.resolve().then(() => invoke('pos:list-customers', 0))).rejects.toThrow(/session has expired/i)
      await expect(Promise.resolve().then(() => invoke('inventory:save-product', 1, inventoryProductDraft({ sku: 'IPC-ADMIN', barcode: '6677889900113' })))).resolves.toMatchObject({ sku: 'IPC-ADMIN' })
      await expect(Promise.resolve().then(() => invoke('users:list', 2))).rejects.toThrow(/admin/i)
      await expect(Promise.resolve().then(() => invoke('shop:get-settings', 0))).rejects.toThrow(/session has expired/i)
      await expect(Promise.resolve().then(() => invoke('shell:open-page', 2, 'users'))).rejects.toThrow(/permission/i)
      await expect(Promise.resolve().then(() => invoke('settings:update-idle-timeout', 2, 30))).rejects.toThrow(/admin/i)
      await expect(Promise.resolve().then(() => invoke('settings:update-idle-timeout', 1, true))).rejects.toThrow(/between 1 and 240/i)
      await expect(Promise.resolve().then(() => invoke('settings:update-return-window', 2, 30))).rejects.toThrow(/admin/i)
      await expect(Promise.resolve().then(() => invoke('settings:update-return-window', 1, 30))).resolves.toMatchObject({ returnWindowDays: 30 })
      await expect(Promise.resolve().then(() => invoke('returns:find-sale', 0, hostReceipt.receiptNumber))).rejects.toThrow(/session has expired/i)
      const foundForReturn = await invoke('returns:find-sale', 2, hostReceipt.receiptNumber) as { receiptNumber: string; items: Array<{ saleItemId: string }> }
      expect(foundForReturn).toMatchObject({ receiptNumber: hostReceipt.receiptNumber, items: [{ saleItemId: hostReceipt.items[0]!.id }] })
      const returnRequest = {
        receiptNumber: hostReceipt.receiptNumber, reason: 'CUSTOMER_CHANGED_MIND', type: 'REFUND',
        refundMethod: 'CASH', items: [{ saleItemId: hostReceipt.items[0]!.id, quantity: '1', condition: 'RESELLABLE' }],
        idempotencyKey: 'host-return-request-0001',
      }
      await expect(Promise.resolve().then(() => invoke('returns:create', 0, returnRequest))).rejects.toThrow(/session has expired/i)
      const pendingReturn = await invoke('returns:create', 2, returnRequest) as { id: number; status: string; totalMinor: bigint }
      expect(pendingReturn).toMatchObject({ status: 'PENDING', totalMinor: 200n })
      const replayedReturn = await invoke('returns:create', 2, returnRequest) as { id: number; status: string }
      expect(replayedReturn.id).toBe(pendingReturn.id)
      expect(fixture.database.prepare('SELECT quantity_milli FROM stock WHERE product_id = ?').get(inventoryProduct.id)).toEqual({ quantity_milli: 0 })
      expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM payments WHERE return_id IS NOT NULL').get()).toEqual({ count: 0 })
      // Sender 4 is the Supervisor, which may no longer approve a return: the decision moved to the Admin (sender 1).
      await expect(Promise.resolve().then(() => invoke('returns:resolve-approval', 4, pendingReturn.id, 'APPROVE'))).rejects.toThrow(/restricted to the Admin/u)
      const approvedReturn = await invoke('returns:resolve-approval', 1, pendingReturn.id, 'APPROVE') as { returnRecord: { status: string; approvalChannel: string } }
      expect(approvedReturn.returnRecord).toMatchObject({ status: 'COMPLETED', approvalChannel: 'DESKTOP' })
      expect(fixture.database.prepare('SELECT quantity_milli FROM stock WHERE product_id = ?').get(inventoryProduct.id)).toEqual({ quantity_milli: 1_000 })
      await expect(Promise.resolve().then(() => invoke('returns:get-document', 2, pendingReturn.id))).resolves.toMatchObject({ returnNumber: expect.stringMatching(/^C-/u) })
      await expect(Promise.resolve().then(() => invoke('returns:print-document', 2, pendingReturn.id, 'A4_RECEIPT'))).resolves.toMatchObject({
        status: 'COMPLETED', printCount: 1, duplicate: false,
      })
      expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM return_print_events WHERE return_id = ?').get(pendingReturn.id)).toEqual({ count: 1 })

      const updatedPermissions = { ...cashierOn.permissions, allowWholesale: false }
      fixture.host.updateUser(1, cashierOn.id, {
        fullName: cashierOn.fullName,
        username: cashierOn.username,
        role: cashierOn.role,
        permissions: updatedPermissions,
        isActive: true,
      })
      expect(fixture.host.getCurrentUser(2)?.permissions.allowWholesale).toBe(false)
      expect(fixture.host.canMakeWholesaleSale(2)).toBe(false)

      const lockedPassword = 'Lock-Test!2026'
      fixture.users.createUser({
        id: 'locked-cashier', fullName: 'Locked Cashier', username: 'locked.cashier',
        passwordHash: await bcryptHash(lockedPassword, 4), role: 'CASHIER', permissions: defaultPermissions('CASHIER'),
      })
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await expect(fixture.host.login(5, { username: 'locked.cashier', password: 'Wrong-Password!1' })).rejects.toThrow(/unable to sign in/i)
      }
      expect(fixture.users.getUserById('locked-cashier')?.isLocked).toBe(true)
      expect(fixture.host.unlockUser(1, 'locked-cashier').isLocked).toBe(false)
      await fixture.host.login(5, { username: 'locked.cashier', password: lockedPassword })

      expect(supervisor.role).toBe('SUPERVISOR')
      const actions = (fixture.database.prepare('SELECT action FROM audit_log').all() as Array<{ action: string }>).map(({ action }) => action)
      expect(actions).toContain('user.created')
      expect(actions).toContain('user.updated')
      expect(actions).toContain('user.unlocked')
      expect(actions).toContain('auth.login.succeeded')
      expect(actions).toContain('first_run.setup.completed')

      fixture.host.updateIdleTimeout(1, 1)
      fixture.setClock(1_060_000)
      expect(fixture.host.getCurrentUser(2)).toBeNull()
      expect(() => fixture.host.openPage(2, 'pos')).toThrow(/session has expired/i)
    } finally {
      fixture.close()
    }
  })

  it('revokes paired mobile sessions when an Admin account is reset or deactivated', async () => {
    const revokeSessionsForUser = vi.fn()
    const mobileAccess = { revokeSessionsForUser } as unknown as MobileAccessService
    const fixture = createFixture(TEST_LICENSE_POLICY, mobileAccess)
    try {
      await fixture.host.initialize()
      await fixture.host.completeFirstRun(firstRunInput())
      await fixture.host.login(1, { username: 'shopadmin', password: ADMIN_PASSWORD })
      const cashier = await fixture.host.createUser(1, cashierInput('mobile.cashier'))

      fixture.host.deactivateUser(1, cashier.id)
      await fixture.host.resetPassword(1, 'user-1', 'New-Admin-Password!2026', 'New-Admin-Password!2026')

      expect(revokeSessionsForUser).toHaveBeenNthCalledWith(1, cashier.id, 'shopadmin')
      expect(revokeSessionsForUser).toHaveBeenNthCalledWith(2, 'user-1', 'shopadmin')
      expect(fixture.host.getCurrentUser(1)).toBeNull()
    } finally {
      fixture.close()
    }
  })

  it('enforces reports-page access and keeps non-Admin desktop reports personal through host and IPC', async () => {
    const fixture = createFixture()
    try {
      await fixture.host.initialize()
      await fixture.host.completeFirstRun(firstRunInput())
      await fixture.host.login(1, { username: 'shopadmin', password: ADMIN_PASSWORD })
      // ACCOUNT, not CASHIER: the brief gives an ACCOUNT the day's reports and a personal view with costs withheld.
      // A CASHIER row resolves to USER, which has no reports at all, so the personal-report behaviour this test exists
      // for belongs to ACCOUNT.
      await fixture.host.createUser(1, { ...cashierInput('reports.cashier'), role: 'ACCOUNT' })
      await fixture.host.login(2, { username: 'reports.cashier', password: CASHIER_PASSWORD })

      const day = { period: 'DAY' as const, date: '2026-11-17' }
      const adminReport = fixture.host.getAccountingReport(1, day)
      expect(adminReport.header).toMatchObject({ storeName: 'Harbor Health Pharmacy', scope: 'STORE' })
      expect(adminReport.summary.grossProfitMinor).toBe(0n)
      expect(adminReport.adminReports).not.toBeNull()

      const personalReport = fixture.host.getAccountingReport(2, day)
      expect(personalReport.header.scope).toBe('PERSONAL')
      expect(personalReport.header.viewerName).toBe('reports.cashier')
      expect(personalReport.summary.cogsMinor).toBeNull()
      expect(personalReport.summary.grossProfitMinor).toBeNull()
      expect(personalReport.adminReports).toBeNull()
      expect(() => fixture.host.closeReportingDay(2, { businessDate: '2026-11-17', countedCash: '0.00' }))
        .toThrow(/Admin/u)
      expect(() => fixture.host.getAccountingReport(0, day)).toThrow(/session has expired/i)

      const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
      const ipcStub = { handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) { handlers.set(channel, handler) } }
      registerDesktopIpc(ipcStub as unknown as Pick<IpcMain, 'handle'>, fixture.host)
      const mainFrame = {}
      const ipcEvent = (id: number) => ({ sender: { id, mainFrame }, senderFrame: mainFrame })
      const invoke = (channel: string, senderId: number, ...args: unknown[]) => handlers.get(channel)!(ipcEvent(senderId), ...args)
      await expect(Promise.resolve().then(() => invoke('reports:get-accounting', 2, day))).resolves.toMatchObject({
        header: { scope: 'PERSONAL' }, summary: { cogsMinor: null, grossProfitMinor: null }, adminReports: null,
      })
      await expect(Promise.resolve().then(() => invoke('reports:close-day', 2, { businessDate: '2026-11-17', countedCash: '0.00' })))
        .rejects.toThrow(/Admin/u)
      await expect(Promise.resolve().then(() => invoke('reports:get-accounting', 0, day))).rejects.toThrow(/session has expired/i)
    } finally {
      fixture.close()
    }
  })
})
