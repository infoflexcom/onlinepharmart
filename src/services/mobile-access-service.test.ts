import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpsRequest } from 'node:https'
import { X509Certificate } from 'node:crypto'
import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
import { migrateDatabase } from '../db/migrate'
import type { LicenseSummary } from '../shared/license/types'
import type { LicenseManager } from '../license/license-manager'
import type { ShopService } from './shop-service'
import type { AccountingReportService } from './accounting-report-service'
import type { ReturnService } from './return-service'
import type { MobileSafeStorage } from '../main/mobile-safe-storage'
import { MobileAccessService } from './mobile-access-service'

const activeLicense: LicenseSummary = {
  status: 'active', canUse: true, licenseId: 'mobile-host-test', source: 'online', edition: 'BOTH',
  startsAt: null, endsAt: null, defaultCurrencyCode: null, lockCurrency: false,
  features: { mobileLan: true, mobileInternet: false }, adminPhoneLimit: 2, graceDays: 0,
  lastOnlineCheck: null, reportedToPortal: true, vendorConfigured: false,
  maximumOnsitePeriodYears: null, licenseServerUrl: null, message: 'active',
}

function getHttps(url: string, ca?: string): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
        contentType: String(response.headers['content-type'] ?? ''),
      }))
    })
    request.on('error', reject)
    request.end()
  })
}

describe('desktop mobile HTTPS lifecycle', () => {
  it('starts the built PWA on HTTPS with an OS-encrypted private identity and can stop/regenerate it', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'infoflex-mobile-host-'))
    const clientDirectory = join(userDataPath, 'mobile')
    mkdirSync(clientDirectory)
    writeFileSync(join(clientDirectory, 'index.html'), '<!doctype html><title>Infoflex test PWA</title>')
    const database = new Database(':memory:')
    migrateDatabase(database)
    database.prepare(`
      INSERT INTO users (id, full_name, username, password_hash, role)
      VALUES ('admin-1', 'Harbor Admin', 'admin', 'not-a-real-password-hash', 'ADMIN')
    `).run()
    const license = {
      getSnapshot: vi.fn(() => activeLicense),
      assertFeature: vi.fn(),
      assertAdminPhoneCapacityForUser: vi.fn(),
    } as unknown as LicenseManager
    const shop = {
      getSettings: vi.fn(() => ({})),
      recordDeniedAccess: vi.fn(),
    } as unknown as ShopService
    const reports = { getDashboard: vi.fn(), exportPdf: vi.fn() } as unknown as AccountingReportService
    const returns = { listPendingMobileApprovals: vi.fn(), resolveMobileApproval: vi.fn() } as unknown as ReturnService
    const safeStorage: MobileSafeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value, 'utf8'),
      decryptString: (value) => value.toString('utf8'),
    }
    const service = new MobileAccessService(database, shop, license, reports, returns, {
      userDataPath,
      mobileClientDirectory: clientDirectory,
      safeStorage,
      port: 0,
      getAddresses: () => ['192.168.1.50'],
    })
    try {
      const status = await service.start('admin-1')
      expect(status.running).toBe(true)
      expect(status.port).toBeGreaterThan(0)
      expect(status.urls).toEqual([`https://192.168.1.50:${status.port}/`])
      expect(status.certificateNeedsInstall).toBe(true)
      expect(status.certificateFingerprint).toMatch(/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/u)

      const identity = JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile(join(userDataPath, 'mobile-api-identity.json'), 'utf8'))) as {
        caCertificate: string; encryptedCaPrivateKey: string; serverCertificate: string; encryptedServerPrivateKey: string
      }
      expect(identity.encryptedCaPrivateKey).not.toContain('PRIVATE KEY')
      expect(identity.encryptedServerPrivateKey).not.toContain('PRIVATE KEY')
      const ca = new X509Certificate(identity.caCertificate)
      const server = new X509Certificate(identity.serverCertificate)
      expect(ca.ca).toBe(true)
      expect(server.ca).toBe(false)
      expect(server.verify(ca.publicKey)).toBe(true)
      expect(server.checkIP('192.168.1.50')).toBeTruthy()
      const pem = await service.exportCertificate('admin-1')
      expect(new X509Certificate(pem).ca).toBe(true)

      const response = await getHttps(`https://127.0.0.1:${status.port}/`, pem)
      expect(response.status).toBe(200)
      expect(response.body).toContain('Infoflex test PWA')
      expect(response.contentType).toContain('text/html')

      const acknowledged = await service.acknowledgeCertificateInstalled('admin-1')
      expect(acknowledged.certificateNeedsInstall).toBe(false)
      const fingerprint = status.certificateFingerprint
      const regenerated = await service.regenerateCertificate('admin-1')
      expect(regenerated.running).toBe(false)
      expect(regenerated.certificateNeedsInstall).toBe(true)
      expect(regenerated.certificateFingerprint).not.toBe(fingerprint)
      const stopped = await service.stop('admin-1')
      expect(stopped.running).toBe(false)
    } finally {
      await service.close()
      database.close()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('stops its listener when the private address changes or the LAN entitlement becomes unusable', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'infoflex-mobile-host-'))
    const clientDirectory = join(userDataPath, 'mobile')
    mkdirSync(clientDirectory)
    writeFileSync(join(clientDirectory, 'index.html'), '<!doctype html><title>Infoflex test PWA</title>')
    const database = new Database(':memory:')
    migrateDatabase(database)
    database.prepare(`
      INSERT INTO users (id, full_name, username, password_hash, role)
      VALUES ('admin-1', 'Harbor Admin', 'admin', 'not-a-real-password-hash', 'ADMIN')
    `).run()
    let snapshot = activeLicense
    let addresses = ['192.168.1.50']
    const license = {
      getSnapshot: vi.fn(() => snapshot),
      assertFeature: vi.fn((feature: string) => {
        if (feature !== 'mobileLan' || !snapshot.features.mobileLan) throw new Error('LAN not included')
      }),
      assertAdminPhoneCapacityForUser: vi.fn(),
    } as unknown as LicenseManager
    const shop = { getSettings: vi.fn(), recordDeniedAccess: vi.fn() } as unknown as ShopService
    const safeStorage: MobileSafeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value, 'utf8'),
      decryptString: (value) => value.toString('utf8'),
    }
    const service = new MobileAccessService(database, shop, license, {} as AccountingReportService, {} as ReturnService, {
      userDataPath,
      mobileClientDirectory: clientDirectory,
      safeStorage,
      port: 0,
      getAddresses: () => addresses,
      healthcheckIntervalMs: 10,
    })
    try {
      expect((await service.start('admin-1')).running).toBe(true)
      addresses = ['192.168.1.51']
      await new Promise((resolve) => setTimeout(resolve, 40))
      expect((await service.status('admin-1')).running).toBe(false)

      expect((await service.start('admin-1')).running).toBe(true)
      snapshot = { ...activeLicense, canUse: false, status: 'expired' }
      await new Promise((resolve) => setTimeout(resolve, 40))
      expect((await service.status('admin-1')).running).toBe(false)
    } finally {
      await service.close()
      database.close()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('refuses startup when encryption storage, LAN licensing, or the PWA build is missing', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'infoflex-mobile-host-'))
    const database = new Database(':memory:')
    migrateDatabase(database)
    database.prepare(`
      INSERT INTO users (id, full_name, username, password_hash, role)
      VALUES ('admin-1', 'Harbor Admin', 'admin', 'not-a-real-password-hash', 'ADMIN')
    `).run()
    const license = {
      getSnapshot: vi.fn(() => activeLicense),
      assertFeature: vi.fn(),
      assertAdminPhoneCapacityForUser: vi.fn(),
    } as unknown as LicenseManager
    const shop = { getSettings: vi.fn(), recordDeniedAccess: vi.fn() } as unknown as ShopService
    const reports = {} as AccountingReportService
    const returns = {} as ReturnService
    const safeStorage: MobileSafeStorage = {
      isEncryptionAvailable: () => false,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString('utf8'),
    }
    const base = {
      userDataPath,
      mobileClientDirectory: join(userDataPath, 'missing-client'),
      safeStorage,
      getAddresses: () => ['192.168.1.50'],
    }
    const service = new MobileAccessService(database, shop, license, reports, returns, base)
    try {
      await expect(service.start('admin-1')).rejects.toThrow(/not been built/u)
      const clientDirectory = join(userDataPath, 'client')
      mkdirSync(clientDirectory)
      writeFileSync(join(clientDirectory, 'index.html'), '<!doctype html>')
      const missingSecureStorage = new MobileAccessService(database, shop, license, reports, returns, {
        ...base, mobileClientDirectory: clientDirectory,
      })
      await expect(missingSecureStorage.start('admin-1')).rejects.toThrow(/operating-system storage/u)
      const basicTextStorage = new MobileAccessService(database, shop, license, reports, returns, {
        ...base,
        mobileClientDirectory: clientDirectory,
        safeStorage: {
          ...safeStorage,
          isEncryptionAvailable: () => true,
          getSelectedStorageBackend: () => 'basic_text',
        },
      })
      await expect(basicTextStorage.start('admin-1')).rejects.toThrow(/operating-system storage/u)
      expect(existsSync(join(userDataPath, 'mobile-api-identity.json'))).toBe(false)
      const noLanLicense = {
        ...license,
        getSnapshot: () => ({ ...activeLicense, features: { mobileLan: false, mobileInternet: true } }),
        assertFeature: () => { throw new Error('LAN not included') },
      } as unknown as LicenseManager
      const disabled = new MobileAccessService(database, shop, noLanLicense, reports, returns, {
        ...base, mobileClientDirectory: clientDirectory,
        safeStorage: { ...safeStorage, isEncryptionAvailable: () => true },
      })
      await expect(disabled.start('admin-1')).rejects.toThrow(/does not include local-network mobile access/u)
    } finally {
      await service.close()
      database.close()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})

describe('internet access for the Admin phone', () => {
  /** A service with a started listener and an optional relay factory, sharing one in-memory database. */
  async function fixture(options: {
    features?: { mobileLan: boolean; mobileInternet: boolean }
    relayUrl?: string | null
    createRelayClient?: () => unknown
  } = {}) {
    const userDataPath = mkdtempSync(join(tmpdir(), 'infoflex-mobile-internet-'))
    const clientDirectory = join(userDataPath, 'mobile')
    mkdirSync(clientDirectory)
    writeFileSync(join(clientDirectory, 'index.html'), '<!doctype html><title>Infoflex test PWA</title>')
    const database = new Database(':memory:')
    migrateDatabase(database)
    database.prepare(`
      INSERT INTO users (id, full_name, username, password_hash, role)
      VALUES ('admin-1', 'Harbor Admin', 'admin', 'not-a-real-password-hash', 'ADMIN')
    `).run()
    const snapshot = { ...activeLicense, features: options.features ?? { mobileLan: true, mobileInternet: true } }
    const license = {
      getSnapshot: vi.fn(() => snapshot),
      assertFeature: vi.fn(),
      assertAdminPhoneCapacityForUser: vi.fn(),
    } as unknown as LicenseManager
    const shop = { getSettings: vi.fn(), recordDeniedAccess: vi.fn() } as unknown as ShopService
    const reports = { getDashboard: vi.fn(), exportPdf: vi.fn() } as unknown as AccountingReportService
    const returns = { listPendingMobileApprovals: vi.fn(), resolveMobileApproval: vi.fn() } as unknown as ReturnService
    const safeStorage: MobileSafeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value, 'utf8'),
      decryptString: (value) => value.toString('utf8'),
    }
    const audits: Array<{ action: string; actor: string; metadata: Record<string, unknown> }> = []
    const service = new MobileAccessService(database, shop, license, reports, returns, {
      userDataPath,
      mobileClientDirectory: clientDirectory,
      safeStorage,
      port: 0,
      getAddresses: () => ['192.168.1.50'],
      relayUrl: () => options.relayUrl === undefined ? 'wss://relay.example.com' : options.relayUrl,
      ...(options.createRelayClient ? { createRelayClient: options.createRelayClient as never } : {}),
      audit: (action, actor, metadata) => audits.push({ action, actor, metadata }),
    })
    return {
      service, database, audits,
      cleanup: async () => {
        await service.close()
        database.close()
        rmSync(userDataPath, { recursive: true, force: true })
      },
    }
  }

  it('refuses the switch unless the signed licence includes internet access', async () => {
    const env = await fixture({ features: { mobileLan: true, mobileInternet: false } })
    try {
      await env.service.start('admin-1')
      await expect(env.service.setInternetAccess('admin-1', true))
        .rejects.toThrow(/does not include mobile access over the internet/u)
      // And the screen says the same thing, so the Admin is not left guessing.
      expect(env.service.internetStatus().state).toBe('unavailable')
      expect(env.service.internetStatus().entitled).toBe(false)
    } finally {
      await env.cleanup()
    }
  })

  it('needs a local listener and a configured relay before it connects anything', async () => {
    const withoutRelay = await fixture({ relayUrl: null })
    try {
      await withoutRelay.service.start('admin-1')
      await expect(withoutRelay.service.setInternetAccess('admin-1', true))
        .rejects.toThrow(/No Infoflex relay is configured/u)
    } finally {
      await withoutRelay.cleanup()
    }
  })

  it('remembers the Admin switch in settings, starts the relay only when entitled, and drops it on suspend', async () => {
    const started: string[] = []
    const stopped: string[] = []
    const fakeRelay = {
      start: () => { started.push('start') },
      stop: () => { stopped.push('stop') },
      disconnect: (reason: string) => { stopped.push(reason) },
      get publicUrl() { return 'https://04e246440fe3.relay.example.com' },
      currentStatus: { state: 'connected' as const, message: 'Connected.', publicUrl: 'https://04e246440fe3.relay.example.com', connectedAt: null, lastFrameAt: null, reason: null },
      createLink: () => ({ url: 'https://04e246440fe3.relay.example.com/?g=v1.x.y.z', expiresAt: '2026-11-17T12:30:00.000Z' }),
    }
    const env = await fixture({ createRelayClient: () => fakeRelay })
    try {
      await env.service.start('admin-1')
      expect(started).toHaveLength(0)

      const on = await env.service.setInternetAccess('admin-1', true)
      expect(started).toEqual(['start'])
      expect(on.internet.enabled).toBe(true)
      expect(on.internet.state).toBe('connected')
      expect(on.internet.link?.url).toContain('relay.example.com')
      expect(env.database.prepare('SELECT mobile_internet_enabled AS enabled FROM settings WHERE id = 1').get())
        .toEqual({ enabled: 1 })
      expect(env.audits.map((entry) => entry.action)).toContain('mobile.internet.enabled')

      await env.service.setInternetAccess('admin-1', false)
      expect(stopped.length).toBeGreaterThan(0)
      expect(env.service.internetStatus().state).toBe('off')
    } finally {
      await env.cleanup()
    }
  })
})
