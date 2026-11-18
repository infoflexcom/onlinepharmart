import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpsRequest, type RequestOptions } from 'node:https'
import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
import { getCurrency } from '../currency/catalog'
import { defaultDisplayOptions } from '../currency/money'
import { fromMinor } from '../currency/parse'
import { migrateDatabase } from '../db/migrate'
import { SQLiteShopRepository } from '../db/sqlite-shop-repository'
import type { LicenseManager } from '../license/license-manager'
import type { LicenseSummary } from '../shared/license/types'
import type { PublicUser } from '../shared/auth/types'
import type { ProductDraft } from '../shared/inventory/types'
import type { MobileSafeStorage } from '../main/mobile-safe-storage'
import { AccountingReportService } from './accounting-report-service'
import { MobileAccessService } from './mobile-access-service'
import { PointOfSaleService } from './point-of-sale-service'
import { ProductInventoryService } from './product-inventory-service'
import { ReturnService } from './return-service'
import { ShopService } from './shop-service'

const NOW = Date.parse('2026-11-17T12:00:00.000Z')
const ADMIN_PASSWORD = 'Harbor-Admin-Pass-9'
const ADMIN: PublicUser = {
  id: 'admin-1', fullName: 'Harbor Admin', username: 'shopadmin', role: 'ADMIN', isActive: true, isLocked: false,
  permissions: { allowWholesale: true, maxDiscountBasisPoints: 10_000, allowCreditSales: true, returnLimitMinor: 9_223_372_036_854_775_807n },
}
const CASHIER: PublicUser = {
  id: 'cashier-1', fullName: 'Return Cashier', username: 'returncashier', role: 'CASHIER', isActive: true, isLocked: false,
  permissions: { allowWholesale: false, maxDiscountBasisPoints: 0, allowCreditSales: false, returnLimitMinor: 100n },
}

const license: LicenseSummary = {
  status: 'active', canUse: true, licenseId: 'mobile-integration', source: 'online', edition: 'BOTH',
  startsAt: null, endsAt: null, defaultCurrencyCode: null, lockCurrency: false,
  features: { mobileLan: true, mobileInternet: false }, adminPhoneLimit: 2, graceDays: 0,
  lastOnlineCheck: null, reportedToPortal: true, vendorConfigured: false,
  maximumOnsitePeriodYears: null, licenseServerUrl: null, message: 'active',
}

interface HttpsResult { status: number; body: string; contentType: string; headers: Record<string, string | string[] | undefined> }

function httpsCall(
  url: string,
  ca: string,
  init: { method?: string; authorization?: string; json?: unknown } = {},
): Promise<HttpsResult> {
  return new Promise((resolve, reject) => {
    const payload = init.json === undefined ? null : Buffer.from(JSON.stringify(init.json), 'utf8')
    const options: RequestOptions = {
      method: init.method ?? 'GET',
      ca,
      rejectUnauthorized: true,
      headers: {
        accept: 'application/json',
        ...(init.authorization ? { authorization: init.authorization } : {}),
        ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
      },
    }
    const request = httpsRequest(url, options, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
        contentType: String(response.headers['content-type'] ?? ''),
        headers: response.headers,
      }))
    })
    request.on('error', reject)
    request.end(payload ?? undefined)
  })
}

function productDraft(): ProductDraft {
  return {
    sku: 'MOBILE-E2E-001', name: 'Mobile end-to-end item', brand: 'Harbor', description: 'Phone return approval item',
    barcode: '', additionalBarcodes: [], category: 'General', subCategory: '', department: '', shelfLocation: '',
    unit: 'each', packSizeUnits: 1, cost: '1.00', retailPrice: '25.00', wholesalePrice: '20.00',
    wholesaleMinimumQuantity: '0', reorderLevel: '0', genericName: '', prescriptionRequired: false,
    weighedItem: false, pluCode: '', pricePerKg: '', expiryTracking: false, variants: [], isActive: true,
  }
}

describe('Admin mobile access over a real HTTPS listener', () => {
  it('pairs, reads an Admin report, approves a pending return, and revokes on refresh-token reuse', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'infoflex-mobile-e2e-'))
    const clientDirectory = join(userDataPath, 'mobile')
    mkdirSync(clientDirectory)
    writeFileSync(join(clientDirectory, 'index.html'), '<!doctype html><title>Infoflex mobile e2e</title>')
    // Mirror a real `build:mobile` output: the worker, manifest, and launcher icons all ship together.
    cpSync(join(process.cwd(), 'mobile/public'), clientDirectory, { recursive: true })

    const database = new Database(':memory:')
    migrateDatabase(database)
    const repository = new SQLiteShopRepository(database, false)
    const currency = getCurrency('NGN')!
    repository.saveSettings({
      ...repository.readSettings(),
      profile: { name: 'Harbor Health', address: '12 Dock Road, Lagos', phone: '+234 1 555 0100' },
      currency,
      display: defaultDisplayOptions(currency),
      setupComplete: true,
      currencyConfirmed: true,
    })
    const insertUser = database.prepare('INSERT INTO users (id, username, password_hash, role, full_name) VALUES (?, ?, ?, ?, ?)')
    const { hashSync } = await import('bcryptjs')
    for (const user of [ADMIN, CASHIER]) {
      insertUser.run(user.id, user.username, hashSync(user.id === ADMIN.id ? ADMIN_PASSWORD : 'Cashier-Pass-77', 4), user.role, user.fullName)
    }
    const insertPermission = database.prepare(`
      INSERT INTO user_permissions (user_id, allow_wholesale, max_discount_pct, allow_credit_sales, return_limit)
      VALUES (?, ?, ?, ?, ?)
    `)
    insertPermission.run(ADMIN.id, 1, 10_000, 1, ADMIN.permissions.returnLimitMinor)
    insertPermission.run(CASHIER.id, 0, 0, 0, CASHIER.permissions.returnLimitMinor)

    let generatedId = 0
    const options = { now: () => NOW, newId: () => `mobile-e2e-${++generatedId}` }
    const inventory = new ProductInventoryService(database, repository, { ...options, deviceName: 'MOBILE-E2E-REGISTER' })
    const pointOfSale = new PointOfSaleService(database, repository, { ...options, workstation: 'MOBILE-E2E-REGISTER' })
    const returns = new ReturnService(database, repository, { ...options, workstation: 'MOBILE-E2E-REGISTER' })
    const reports = new AccountingReportService(database, repository, options)
    const shop = new ShopService(repository, { deviceName: 'MOBILE-E2E-REGISTER', ipAddress: null }, () => new Date(NOW))

    const adminActor = { id: ADMIN.id, username: ADMIN.username, role: ADMIN.role }
    let product = inventory.createProduct(productDraft(), adminActor, 'BOTH')
    product = inventory.receiveStock({
      productId: product.id, expectedProductVersion: product.rowVersion, expectedStockVersion: product.stockVersion,
      quantity: '1', quantityUnit: 'unit', unitCost: '1.00', supplierName: 'Coastal Supplies',
      supplierReference: 'MOBILE-E2E-RECEIPT', note: 'Mobile approval stock', batchNumber: '', expiryDate: '',
    }, adminActor, 'BOTH').product
    const receipt = pointOfSale.completeSale({
      idempotencyKey: 'mobile-e2e-sale-0001', saleType: 'RETAIL',
      items: [{ productId: product.id, quantity: '1' }],
      payments: [{ method: 'CASH', amount: fromMinor(2_500n, currency) }],
    }, ADMIN, 'BOTH').receipt
    const pending = returns.createReturn({
      receiptNumber: receipt.receiptNumber, reason: 'CUSTOMER_CHANGED_MIND', reasonNote: '', type: 'REFUND',
      refundMethod: 'CASH', items: [{ saleItemId: receipt.items[0]!.id, quantity: '1', condition: 'RESELLABLE' }],
      idempotencyKey: 'mobile-e2e-return-0001',
    }, CASHIER, 'BOTH')
    expect(pending).toMatchObject({ status: 'PENDING', totalMinor: 2_500n })

    const licenseManager = {
      getSnapshot: vi.fn(() => license),
      assertFeature: vi.fn((feature: string) => {
        if (feature !== 'mobileLan' || !license.features.mobileLan) throw new Error('LAN mobile access is not included.')
      }),
      assertAdminPhoneCapacityForUser: vi.fn(),
    } as unknown as LicenseManager
    const safeStorage: MobileSafeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value, 'utf8'),
      decryptString: (value) => value.toString('utf8'),
    }
    const service = new MobileAccessService(database, shop, licenseManager, reports, returns, {
      userDataPath, mobileClientDirectory: clientDirectory, safeStorage, port: 0,
      getAddresses: () => ['192.168.1.60'], now: () => NOW,
      friendlyHostName: 'infoflex-harbor-health',
      phoneLimit: 2,
      verifyPassword: async (password, hash) => {
        const { compare } = await import('bcryptjs')
        return password.length <= 72 && await compare(password, hash)
      },
    })

    try {
      const started = await service.start(ADMIN.id)
      expect(started.running).toBe(true)
      expect(started.urls).toEqual([`https://192.168.1.60:${started.port}/`])
      const ca = await service.exportCertificate(ADMIN.id)
      const base = `https://127.0.0.1:${started.port}`

      const shell = await httpsCall(`${base}/`, ca)
      expect(shell.status).toBe(200)
      expect(shell.contentType).toContain('text/html')
      expect(shell.body).toContain('Infoflex mobile e2e')
      expect(String(shell.headers['content-security-policy'])).toContain("worker-src 'self'")
      const manifest = await httpsCall(`${base}/manifest.webmanifest`, ca)
      expect(manifest.status).toBe(200)
      expect(manifest.contentType).toContain('application/manifest+json')

      // Every shell asset the phone requests (icons, worker, iOS touch icon) must resolve over HTTPS.
      for (const asset of ['/service-worker.js', '/icons/icon-180.png', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png']) {
        const assetResponse = await httpsCall(`${base}${asset}`, ca)
        expect(assetResponse.status, asset).toBe(200)
      }

      // API data must never be reachable without a paired phone session.
      const unpaired = await httpsCall(`${base}/api/v1/admin/reports/summary?period=DAY&date=2026-11-17`, ca)
      expect(unpaired.status).toBe(401)
      expect(unpaired.headers['cache-control']).toBe('no-store')

      const pairing = service.beginPairing(ADMIN.id)
      expect(pairing.pairingUrl).toBe(`https://192.168.1.60:${started.port}/`)
      expect(pairing.addresses).toEqual([`192.168.1.60:${started.port}`])
      expect(started.friendlyUrls).toEqual([`https://infoflex-harbor-health.local:${started.port}/`])

      // Step 1: the phone exchanges the code for a PENDING request. No session comes back.
      const requested = await httpsCall(`${base}/api/v1/mobile/pair`, ca, {
        method: 'POST',
        json: { code: pairing.code, deviceName: 'Admin iPhone', platform: 'iPhone Safari' },
      })
      expect(requested.status).toBe(202)
      expect(requested.headers['cache-control']).toBe('no-store')
      const pairRequest = JSON.parse(requested.body) as { requestToken: string; requestId: string }
      expect(JSON.stringify(pairRequest)).not.toMatch(/accessToken|refreshToken/)

      // A device that has NOT been approved is refused by the API and by login.
      const notApproved = await httpsCall(`${base}/api/v1/admin/settings`, ca, { authorization: `Bearer ${pairRequest.requestToken}` })
      expect(notApproved.status).toBe(401)
      const loginBeforeApproval = await httpsCall(`${base}/api/v1/mobile/session/login`, ca, {
        method: 'POST',
        json: { username: ADMIN.username, password: ADMIN_PASSWORD, deviceToken: pairRequest.requestToken },
      })
      expect(loginBeforeApproval.status).toBe(401)
      expect(service.listDevices(ADMIN.id)).toEqual([])

      // Step 2: the Admin approves on the PC. The phone polls and learns it may now sign in.
      const waiting = await httpsCall(`${base}/api/v1/mobile/pair/status?requestToken=${pairRequest.requestToken}`, ca)
      expect(JSON.parse(waiting.body)).toMatchObject({ status: 'PENDING' })
      expect(service.listPendingApprovals(ADMIN.id)).toHaveLength(1)
      service.approveDevice(ADMIN.id, pairRequest.requestId)
      const approved = await httpsCall(`${base}/api/v1/mobile/pair/status?requestToken=${pairRequest.requestToken}`, ca)
      expect(JSON.parse(approved.body)).toMatchObject({ status: 'APPROVED', loginRequired: true })
      expect(service.listDevices(ADMIN.id)).toHaveLength(1)

      // Step 3: Admin username + password + device token, all over TLS on the LAN.
      const login = await httpsCall(`${base}/api/v1/mobile/session/login`, ca, {
        method: 'POST',
        json: { username: ADMIN.username, password: ADMIN_PASSWORD, deviceToken: pairRequest.requestToken },
      })
      expect(login.status).toBe(200)
      expect(login.headers['cache-control']).toBe('no-store')
      const credentials = JSON.parse(login.body) as {
        deviceId: string; accessToken: string; refreshToken: string; accessTokenExpiresAt: string
        user: { username: string; role: string }
      }
      expect(credentials.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/u)
      expect(credentials.user.role).toBe('ADMIN')
      expect(pairing.code).not.toContain(credentials.accessToken)
      // Every mobile sign-in is audited with the real socket address (loopback in this test harness).
      const loginAudit = database.prepare("SELECT action, ip_address FROM audit_log WHERE action = 'mobile.login.succeeded'").get()
      expect(loginAudit).toEqual({ action: 'mobile.login.succeeded', ip_address: '127.0.0.1' })

      const authorization = `Bearer ${credentials.accessToken}`
      const report = await httpsCall(`${base}/api/v1/admin/reports/summary?period=DAY&date=2026-11-17`, ca, { authorization })
      expect(report.status).toBe(200)
      expect(report.headers['cache-control']).toBe('no-store')
      const summary = JSON.parse(report.body) as { header: { storeName: string }; summary: { grossSalesMinor: string } }
      expect(summary.header.storeName).toBe('Harbor Health')
      expect(summary.summary.grossSalesMinor).toBe('2500')

      const pendingList = await httpsCall(`${base}/api/v1/admin/returns/pending`, ca, { authorization })
      expect(pendingList.status).toBe(200)
      const requests = (JSON.parse(pendingList.body) as { requests: Array<{ id: number; amountMinor: string; requester: string }> }).requests
      expect(requests).toEqual([expect.objectContaining({ id: pending.id, amountMinor: '2500', requester: CASHIER.fullName })])

      const approval = await httpsCall(`${base}/api/v1/admin/returns/${pending.id}/approval`, ca, {
        method: 'POST', authorization, json: { decision: 'APPROVE' },
      })
      expect(approval.status).toBe(200)
      expect(JSON.parse(approval.body)).toMatchObject({ decision: 'APPROVE', return: { status: 'COMPLETED' } })
      expect(database.prepare('SELECT approval_channel FROM returns WHERE id = ?').get(pending.id))
        .toEqual({ approval_channel: 'MOBILE' })

      const settings = await httpsCall(`${base}/api/v1/admin/settings`, ca, { authorization })
      expect(settings.status).toBe(200)
      expect(JSON.parse(settings.body)).toMatchObject({ profile: { name: 'Harbor Health' } })

      const rotated = await httpsCall(`${base}/api/v1/mobile/session/refresh`, ca, {
        method: 'POST', json: { refreshToken: credentials.refreshToken },
      })
      expect(rotated.status).toBe(200)
      expect(rotated.headers['cache-control']).toBe('no-store')
      const next = JSON.parse(rotated.body) as { accessToken: string; refreshToken: string }
      expect(next.refreshToken).not.toBe(credentials.refreshToken)
      const refreshed = await httpsCall(`${base}/api/v1/admin/reports/summary?period=DAY&date=2026-11-17`, ca, {
        authorization: `Bearer ${next.accessToken}`,
      })
      expect(refreshed.status).toBe(200)
      const supersededAccess = await httpsCall(`${base}/api/v1/admin/reports/summary?period=DAY&date=2026-11-17`, ca, { authorization })
      expect(supersededAccess.status).toBe(401)

      // Replaying the rotated refresh credential is treated as theft and revokes the phone.
      const replay = await httpsCall(`${base}/api/v1/mobile/session/refresh`, ca, {
        method: 'POST', json: { refreshToken: credentials.refreshToken },
      })
      expect(replay.status).toBe(401)
      const afterReuse = await httpsCall(`${base}/api/v1/admin/reports/summary?period=DAY&date=2026-11-17`, ca, {
        authorization: `Bearer ${next.accessToken}`,
      })
      expect(afterReuse.status).toBe(401)
      expect(service.listDevices(ADMIN.id)).toEqual([])
      const auditActions = (database.prepare('SELECT action FROM audit_log').all() as Array<{ action: string }>)
        .map(({ action }) => action)
      // The new flow audits the request, the approval and the sign-in separately.
      expect(auditActions).toContain('mobile.device.requested')
      expect(auditActions).toContain('mobile.device.approved')
      expect(auditActions).toContain('mobile.login.succeeded')
      expect(auditActions).toContain('mobile.session.refresh_reuse_detected')

      // A second phone goes through the same pair -> approve -> login path, then signs out.
      const secondPairing = service.beginPairing(ADMIN.id)
      const secondRequest = JSON.parse((await httpsCall(`${base}/api/v1/mobile/pair`, ca, {
        method: 'POST', json: { code: secondPairing.code, deviceName: 'Backup iPhone', platform: 'iPhone Safari' },
      })).body) as { requestToken: string; requestId: string }
      service.approveDevice(ADMIN.id, secondRequest.requestId)
      const secondCredentials = JSON.parse((await httpsCall(`${base}/api/v1/mobile/session/login`, ca, {
        method: 'POST',
        json: { username: ADMIN.username, password: ADMIN_PASSWORD, deviceToken: secondRequest.requestToken },
      })).body) as { accessToken: string }
      expect(service.listDevices(ADMIN.id)).toHaveLength(1)

      const signedOut = await httpsCall(`${base}/api/v1/mobile/session/logout`, ca, {
        method: 'POST', authorization: `Bearer ${secondCredentials.accessToken}`,
      })
      expect(signedOut.status).toBe(204)
      const afterSignOut = await httpsCall(`${base}/api/v1/admin/returns/pending`, ca, {
        authorization: `Bearer ${secondCredentials.accessToken}`,
      })
      expect(afterSignOut.status).toBe(401)
      expect(service.listDevices(ADMIN.id)).toEqual([])

      const stopped = await service.stop(ADMIN.id)
      expect(stopped.running).toBe(false)
      expect(stopped.urls).toEqual([])
    } finally {
      await service.close()
      database.close()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})
