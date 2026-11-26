import type Database from 'better-sqlite3'
import type { ProductInventoryService } from '../services/product-inventory-service'
import type { PointOfSaleService } from '../services/point-of-sale-service'
import type { UserService } from '../services/user-service'
import type { AccountingReportService } from '../services/accounting-report-service'
import type { DailyAuditService } from '../services/daily-audit-service'
import type { ApprovalQueueService } from '../services/approval-queue-service'
import type { ReturnService } from '../services/return-service'
import type { ShopService } from '../services/shop-service'
import type { LicenseManager } from '../license/license-manager'
import type { Edition } from '../editions'
import type { MobileAdminHost } from './mobile-admin-service'
import type { MobileDeviceRow } from '../shared/mobile/admin-types'
import { MobileAdminService } from './mobile-admin-service'
import { BcryptAdminPasswordVerifier } from './admin-password'

export interface MobileAdminSurface {
  service: MobileAdminService
}

export interface MobileAdminSurfaceDeps {
  database: Database.Database
  shop: ShopService
  license: LicenseManager
  inventory: ProductInventoryService
  pointOfSale: PointOfSaleService
  users: UserService
  reports: AccountingReportService
  /**
   * The daily audit, required rather than optional.
   *
   * Optional here would have compiled everywhere and quietly produced a phone that reports "no audit service on this
   * Server" — a true sentence about a mis-wired installation, and the kind of true sentence nobody reads twice. Making
   * it a required dependency turns that into a compile error at the one place the surface is built.
   */
  audit: DailyAuditService
  approvals: ApprovalQueueService
  returns: ReturnService
  /** The device registry, for the "connected devices" count on the dashboard. */
  countConnectedDevices: () => number
  /** The same registry, for the Devices screen: the host decides which phones are paired. */
  listPairedDevices: (adminUserId: string) => MobileDeviceRow[]
  revokePairedDevice: (adminUserId: string, deviceId: string) => void
}

/**
 * Builds the phone's Admin surface out of the *same* service objects the desktop IPC talks to. Nothing here
 * re-implements a business rule: prices, stock maths, approvals, permissions and the currency all come from
 * the host services, so the phone cannot drift from the desktop.
 */
export function createMobileAdminSurface(deps: MobileAdminSurfaceDeps): MobileAdminSurface {
  const edition = (): Edition | null => {
    const snapshot = deps.license.getSnapshot()
    return snapshot.canUse ? snapshot.edition : null
  }
  const actor = (principal: { id: string; username: string; role: 'ADMIN' }) => principal

  const host: MobileAdminHost = {
    getSettings: () => deps.shop.getSettings(),
    getEdition: edition,
    getLicense: () => deps.license.getSnapshot(),

    /**
     * Re-reads the user row on every call. This is what makes demotion, deactivation or a lock bite on the
     * phone's next request instead of at token expiry.
     */
    revalidateAdmin: (userId) => {
      // `is_locked` is derived, not stored: a lock is an unexpired `locked_until`. Reading it the same way
      // the user repository does keeps the phone and the desktop agreeing about who is locked out.
      const row = deps.database.prepare(`
        SELECT id, username, role, is_active,
               CASE WHEN locked_until IS NOT NULL AND locked_until > ? THEN 1 ELSE 0 END AS is_locked
        FROM users WHERE id = ?
      `).get(new Date().toISOString(), userId) as
        { id: string; username: string; role: string; is_active: number; is_locked: number } | undefined
      if (!row) return null
      return { id: row.id, username: row.username, role: row.role, isActive: row.is_active === 1, isLocked: row.is_locked === 1 }
    },

    getUser: (userId) => {
      // The host's user repository is the single source; this reads the same row the desktop sees.
      const user = deps.users.getPublicUser(userId)
      return user ?? null
    },

    verifyAdminPassword: async (userId, password) => {
      const verifier = new BcryptAdminPasswordVerifier({
        getPasswordHash: (id) => {
          const row = deps.database.prepare('SELECT password_hash FROM users WHERE id = ?').get(id) as { password_hash?: string } | undefined
          return row?.password_hash ?? null
        },
      })
      return await verifier.verify(userId, password)
    },

    listProducts: (caller, currentEdition, search) => deps.inventory.listProducts(actor(caller), currentEdition, search),
    // The inventory service's own lookup is private; the overview search returns the same mapped record.
    getProduct: (productId, caller, currentEdition) => {
      const found = deps.inventory.listProducts(actor(caller), currentEdition, '').find((product) => product.id === productId)
      if (!found) throw new Error('That product is no longer in the catalogue. Reload the screen.')
      return found
    },
    createProduct: (draft, caller, currentEdition) => deps.inventory.createProduct(draft, actor(caller), currentEdition),
    updateProduct: (draft, caller, currentEdition) => deps.inventory.updateProduct(draft, actor(caller), currentEdition),
    adjustStock: (input, caller, currentEdition) => deps.inventory.adjustStock(input as never, actor(caller), currentEdition),
    receiveStock: (input, caller, currentEdition) => deps.inventory.receiveStock(input as never, actor(caller), currentEdition),
    getSellableBatches: (productId, currentEdition) => deps.inventory.getSellableBatches(productId, currentEdition)
      .map((batch) => ({
        batchNumber: batch.batchNumber ?? '',
        expiryDate: batch.expiryDate ?? null,
        quantityMilli: batch.quantityMilli.toString(),
        unitCostMinor: batch.unitCostMinor.toString(),
      })),
    getAlerts: (currentEdition) => deps.inventory.getAlerts(currentEdition),

    getReport: (input, caller) => deps.reports.getDashboard(input, actor(caller), edition() ?? 'PHARMACY'),
    // The same service the desktop audit screen asks, so a day outstanding on the till is outstanding in the Admin's
    // pocket. The phone gets the summary and no more: signing a day off needs the whole screen, not a tile.
    getAuditSummary: (caller) => deps.audit.summaryForPhone(caller, edition() ?? 'PHARMACY'),
    exportReportPdf: async (input, caller) =>
      await deps.reports.exportPdf({ ...input, section: 'summary' }, actor(caller), edition() ?? 'PHARMACY'),

    listRecentSales: (caller, limit) => limit === undefined
      ? deps.pointOfSale.listRecentSales(caller)
      : deps.pointOfSale.listRecentSales(caller, limit),
    getReceipt: (saleId, caller) => deps.pointOfSale.getReceipt(saleId, caller),
    recordReceiptViewed: (saleId, caller, channel) => deps.pointOfSale.recordReceiptViewed(saleId, caller, channel),

    listUsers: (caller) => deps.users.listUsers(caller),
    updateUser: (caller, id, input, currentEdition) => deps.users.updateUser(caller, id, input, currentEdition),

    listPendingApprovals: (caller) => deps.approvals.listPending(caller),
    listRecentApprovals: (caller, limit) => limit === undefined
      ? deps.approvals.listRecent(caller, 50)
      : deps.approvals.listRecent(caller, limit),
    pendingApprovalCount: (caller) => deps.approvals.pendingCount(caller),
    resolveApproval: (requestId, decision, caller) => deps.approvals.resolve(requestId, decision, caller),
    listPendingReturnApprovals: (admin) => deps.returns.listPendingMobileApprovals({
      id: admin.userId, username: admin.username, role: admin.role,
    }),
    resolveReturnApproval: (returnId, decision, admin) => {
      const result = deps.returns.resolveMobileApproval(returnId, decision, {
        id: admin.userId, username: admin.username, role: admin.role,
      })
      return result.returnRecord
    },

    countConnectedDevices: () => deps.countConnectedDevices(),
    listPairedDevices: (adminUserId) => deps.listPairedDevices(adminUserId),
    revokePairedDevice: (adminUserId, deviceId) => deps.revokePairedDevice(adminUserId, deviceId),

    listStockMovements: (productId, limit) => deps.database.prepare(`
      SELECT m.reference_id AS reference, m.movement_type, m.quantity_delta_milli,
             m.adjustment_reason AS reason, m.created_at,
             COALESCE(u.username, '') AS created_by
      FROM stock_movements m
      LEFT JOIN users u ON u.id = m.created_by
      WHERE m.product_id = ?
      ORDER BY m.created_at DESC
      LIMIT ?
    `).all(productId, limit) as never,
  }

  return { service: new MobileAdminService(host) }
}
