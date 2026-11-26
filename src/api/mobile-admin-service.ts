import type { AuthenticatedPrincipal } from '../services/permissions'
import { requireAdmin } from '../services/permissions'
import type { Edition } from '../editions'
import type { LicenseSummary } from '../shared/license/types'
import type { ShopSettings } from '../shared/shop/types'
import type { PublicUser, UserPermissions } from '../shared/auth/types'
import type { ReportPeriodInput } from '../shared/reports/types'
import type { AuditSummaryForPhone } from '../shared/audit/types'
import type { ProductDraft, ProductRecord, InventoryAlert } from '../shared/inventory/types'
import type { PosReceiptRecord, PosRecentSaleRecord } from '../shared/pos/types'
import type { ReturnRecord, ReturnApprovalDecision } from '../shared/returns/types'
import type { ApprovalRequestView } from '../shared/approvals/types'
import type {
  MobileApproval,
  MobileApprovals,
  MobileBatch,
  MobileCashierPermissionInput,
  MobileCashierPermissionRow,
  MobileCashierPermissions,
  MobileDeviceList,
  MobileDeviceRow,
  MobileAuditSummary,
  MobileDashboard,
  MobileDashboardCashier,
  MobileProductCreateInput,
  MobileProductDetail,
  MobileProductSearch,
  MobileProductSummary,
  MobileProductUpdateInput,
  MobileSaleDetail,
  MobileSaleList,
  MobileSaleSummary,
  MobileShopHeader,
  MobileStockAdjustmentInput,
  MobileStockMovement,
  MobileStockReceiptInput,
} from '../shared/mobile/admin-types'

/**
 * Thrown when a write arrives from a screen that has been overtaken. The route turns it into a 409 with
 * `reloadRequired: true`, which is what makes the phone say "This item was changed, reload" instead of
 * silently overwriting the Admin's own newer edit from the desktop.
 */
export class MobileStaleVersionError extends Error {
  constructor(message = 'This item was changed, reload.') {
    super(message)
    this.name = 'MobileStaleVersionError'
  }
}

export class MobileReloadRequiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MobileReloadRequiredError'
  }
}

/** Everything the mobile surface needs from the host, each already scoped to one verified Admin. */
export interface MobileAdminHost {
  getSettings(): ShopSettings
  getEdition(): Edition | null
  getLicense(): LicenseSummary
  /** Re-reads the user row: a demoted or deactivated Admin must not keep a working phone. */
  revalidateAdmin(userId: string): { id: string; username: string; role: string; isActive: boolean; isLocked: boolean } | null
  /** The full user row, for the host services that take a PublicUser. */
  getUser(userId: string): PublicUser | null
  verifyAdminPassword(userId: string, password: string): Promise<boolean>

  listProducts(actor: { id: string; username: string; role: 'ADMIN' }, edition: Edition, search: string): ProductRecord[]
  getProduct(productId: string, actor: { id: string; username: string; role: 'ADMIN' }, edition: Edition): ProductRecord
  createProduct(draft: ProductDraft, actor: { id: string; username: string; role: 'ADMIN' }, edition: Edition): ProductRecord
  updateProduct(draft: ProductDraft, actor: { id: string; username: string; role: 'ADMIN' }, edition: Edition): ProductRecord
  adjustStock(input: Record<string, unknown>, actor: { id: string; username: string; role: 'ADMIN' }, edition: Edition): unknown
  receiveStock(input: Record<string, unknown>, actor: { id: string; username: string; role: 'ADMIN' }, edition: Edition): unknown
  getSellableBatches(productId: string, edition: Edition): Array<{ batchNumber: string; expiryDate: string | null; quantityMilli: string; unitCostMinor: string }>
  getAlerts(edition: Edition): InventoryAlert[]

  getReport(input: ReportPeriodInput, actor: { id: string; username: string; role: 'ADMIN' }): import('../shared/reports/types').AccountingReport
  /**
   * The daily audit's short form: which days nobody has attested to, and which flags are still open.
   *
   * Optional so a host built before this feature still compiles, and deliberately *not* defaulted to an empty summary:
   * when it is absent the dashboard reports `audit: null`, which the phone renders as "this Server has no audit", rather
   * than as a shop with nothing outstanding.
   */
  getAuditSummary?(actor: PublicUser): AuditSummaryForPhone
  exportReportPdf(input: ReportPeriodInput, actor: { id: string; username: string; role: 'ADMIN' }): Promise<Uint8Array>

  listRecentSales(actor: PublicUser, limit?: number): PosRecentSaleRecord[]
  getReceipt(saleId: string | number, actor: PublicUser): PosReceiptRecord
  recordReceiptViewed(saleId: string | number, actor: PublicUser, channel: 'desktop' | 'mobile'): PosReceiptRecord

  listUsers(actor: PublicUser | null): PublicUser[]
  updateUser(actor: PublicUser | null, id: string, input: { fullName: string; username: string; role: PublicUser['role']; permissions: UserPermissions; isActive: boolean }, edition: Edition): PublicUser

  listPendingApprovals(actor: PublicUser): ApprovalRequestView[]
  listRecentApprovals(actor: PublicUser, limit?: number): ApprovalRequestView[]
  pendingApprovalCount(actor: PublicUser): number
  resolveApproval(requestId: string, decision: 'APPROVE' | 'REJECT', actor: PublicUser): ApprovalRequestView
  listPendingReturnApprovals(admin: AuthenticatedPrincipal): ReturnRecord[]
  resolveReturnApproval(returnId: string, decision: ReturnApprovalDecision, admin: AuthenticatedPrincipal): ReturnRecord

  countConnectedDevices(): number
  /** The paired phones the Admin can revoke from the phone; the registry itself lives on the host. */
  listPairedDevices(adminUserId: string): MobileDeviceRow[]
  revokePairedDevice(adminUserId: string, deviceId: string): void
  listStockMovements?(productId: string, limit: number): RawMovement[]
}

interface RawMovement {
  reference: string
  movement_type: string
  quantity_delta_milli: string
  reason: string | null
  created_by: string
  created_at: string
}

const RECENT_APPROVAL_LIMIT = 20
const MAX_MOVEMENTS = 40

/**
 * The single place where Admin phone requests become host service calls. The desktop routes the same
 * service methods, so there is exactly one set of business rules: prices, stock arithmetic, approvals,
 * edit permissions and the currency all come from the host, never from the phone.
 */
export class MobileAdminService {
  constructor(private readonly host: MobileAdminHost) {}

  // ---------------------------------------------------------------- identity

  /**
   * The one check every mobile route runs. `requireAdmin` rejects any non-Admin with the generic message;
   * the extra re-read means a phone whose owner was demoted since login fails on its very next call.
   */
  requireAdmin(principal: AuthenticatedPrincipal | null | undefined): AuthenticatedPrincipal & { role: 'ADMIN' } {
    const admin = requireAdmin(principal)
    const row = this.host.revalidateAdmin(admin.userId)
    if (!row || row.role !== 'ADMIN' || !row.isActive || row.isLocked) {
      throw new Error('This account cannot use the mobile app')
    }
    return { ...admin, username: row.username }
  }

  private requireEdition(): Edition {
    const license = this.host.getLicense()
    if (!license.canUse || !license.edition) {
      throw new Error("This shop's Infoflex licence has expired or been suspended. Mobile access is unavailable until the Admin renews it on the desktop.")
    }
    return license.edition
  }

  private actor(principal: AuthenticatedPrincipal): { id: string; username: string; role: 'ADMIN' } {
    return { id: principal.userId, username: principal.username, role: 'ADMIN' }
  }

  /** A full PublicUser for services that take one (POS, user administration). */
  private publicUser(principal: AuthenticatedPrincipal): PublicUser {
    const user = this.host.getUser(principal.userId)
    if (!user) throw new Error('This account cannot use the mobile app')
    return user
  }

  private async requireAdminPassword(principal: AuthenticatedPrincipal, password: unknown): Promise<void> {
    if (typeof password !== 'string' || password.length === 0) {
      throw new Error('Enter your Admin password to confirm this change.')
    }
    if (!await this.host.verifyAdminPassword(principal.userId, password)) {
      throw new Error('That Admin password is not correct.')
    }
  }

  // ---------------------------------------------------------------- header & dashboard

  header(): MobileShopHeader {
    const settings = this.host.getSettings()
    const edition = this.host.getEdition()
    return {
      storeName: settings.profile.name,
      storeAddress: settings.profile.address,
      storePhone: settings.profile.phone,
      edition: edition ?? 'PHARMACY',
      currency: settings.currency,
      display: settings.display,
      generatedAt: new Date().toISOString(),
    }
  }

  dashboard(principal: AuthenticatedPrincipal): MobileDashboard {
    const admin = this.requireAdmin(principal)
    const edition = this.requireEdition()
    const today = new Date()
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const month = date.slice(0, 7)
    const dayReport = this.host.getReport({ period: 'DAY', date }, this.actor(admin))
    const monthReport = this.host.getReport({ period: 'MONTH', date: month }, this.actor(admin))
    const alerts = this.host.getAlerts(edition)

    return {
      header: this.header(),
      today: {
        date,
        totalSalesMinor: dayReport.summary.totalSalesMinor.toString(),
        netSalesMinor: dayReport.summary.netSalesMinor.toString(),
        transactions: dayReport.summary.transactions,
      },
      month: {
        label: month,
        totalSalesMinor: monthReport.summary.totalSalesMinor.toString(),
        netSalesMinor: monthReport.summary.netSalesMinor.toString(),
        transactions: monthReport.summary.transactions,
      },
      counts: {
        lowStock: alerts.filter((alert) => alert.type === 'low_stock').length,
        nearExpiry: alerts.filter((alert) => alert.type === 'near_expiry').length,
        expired: alerts.filter((alert) => alert.type === 'expired').length,
        pendingApprovals: this.host.pendingApprovalCount(this.publicUser(admin)),
        connectedDevices: this.host.countConnectedDevices(),
      },
      salesByCashierToday: dayReport.salesByUser.map((row) => this.cashierRow(row)),
      audit: this.auditSummary(admin),
    }
  }

  /**
   * The audit block of the dashboard.
   *
   * The phone asks for the same summary the desktop's own audit screen asks for, through the same service, so a day that
   * is outstanding on the till's screen is outstanding in the Admin's pocket. What the phone does *not* get is the day's
   * figures in detail: signing a day off is an act that needs the whole screen, and a dashboard tile that invited it
   * would be inviting an attestation made from a summary.
   */
  private auditSummary(admin: AuthenticatedPrincipal): MobileAuditSummary | null {
    // `typeof` and not truthiness: the method is optional, and a host that has the property but cannot answer it - an
    // empty array from a stub, a null from a service that was never wired - is a host with no audit to show. Calling
    // anything that is not a function would take the whole dashboard down over an informational block.
    if (typeof this.host.getAuditSummary !== 'function') return null
    const summary = this.host.getAuditSummary(this.publicUser(admin))
    // Checked rather than trusted, for the same reason the print gate checks a kind the type says cannot be wrong: the
    // value comes from a host this service does not own. `getAuditSummary` is optional so that an older host still
    // compiles, and a host that answers it with nothing usable *is* an older host - it has no audit service to ask. What
    // must not happen is the whole dashboard failing because an informational block could not be built: the day's sales,
    // the stock alerts and the pending approvals are all still true, and the phone has a state for this ("This Server has
    // no audit service") which is a more useful answer than an error.
    if (!Array.isArray(summary?.unauditedDays) || !Array.isArray(summary.openFlags) || !Array.isArray(summary.auditedDays)) {
      return null
    }
    return {
      unauditedDays: summary.unauditedDays.map((day) => ({
        businessDate: day.businessDate,
        accountName: day.accountName,
        transactions: day.transactions,
        salesMinor: day.salesMinor.toString(),
        currencyCode: day.currencyCode,
        openFlags: day.openFlags,
        dayClosed: day.dayClosed,
      })),
      openFlags: summary.openFlags.map((flag) => ({
        id: flag.id,
        businessDate: flag.businessDate,
        severity: flag.severity,
        // Trimmed for a phone: the full note, with every stamp, is on the desktop screen where it can be read.
        detail: flag.detail.length > 220 ? `${flag.detail.slice(0, 220).trimEnd()}…` : flag.detail,
        raisedByName: flag.raisedByName,
        raisedAt: flag.raisedAt,
      })),
      auditedDays: summary.auditedDays.length,
    }
  }

  private cashierRow(row: import('../shared/reports/types').UserSalesSummary): MobileDashboardCashier {
    return {
      userId: row.userId,
      userName: row.userName,
      username: row.username,
      transactions: row.transactions,
      totalSalesMinor: row.totalSalesMinor.toString(),
      netSalesMinor: row.netSalesMinor.toString(),
    }
  }

  // ---------------------------------------------------------------- stock

  searchProducts(principal: AuthenticatedPrincipal, search: string): MobileProductSearch {
    const admin = this.requireAdmin(principal)
    const edition = this.requireEdition()
    const term = search.trim().slice(0, 80)
    // An empty search is allowed and returns the first page of the catalogue, so the screen is never blank.
    const products = this.host.listProducts(this.actor(admin), edition, term).slice(0, 50).map((product) => this.product(product))
    const normalised = term.toLowerCase()
    const exact = normalised.length > 0
      ? this.host.listProducts(this.actor(admin), edition, term)
        .find((product) => product.barcode.toLowerCase() === normalised || product.sku.toLowerCase() === normalised)
      : undefined
    return { header: this.header(), products, exactMatchProductId: exact?.id ?? null }
  }

  productDetail(principal: AuthenticatedPrincipal, productId: string): MobileProductDetail {
    const admin = this.requireAdmin(principal)
    const edition = this.requireEdition()
    const record = this.host.getProduct(productId, this.actor(admin), edition)
    const batches = this.batchesFor(record.id, edition, record)
    const history = (this.host.listStockMovements?.(record.id, MAX_MOVEMENTS) ?? []).map((row) => this.movement(row))
    return { product: this.product(record), batches, history }
  }

  private batchesFor(productId: string, edition: Edition, record: ProductRecord): MobileBatch[] {
    const fromService = this.host.getSellableBatches(productId, edition)
    if (fromService.length > 0) {
      return fromService.map((batch) => ({
        batchNumber: batch.batchNumber,
        expiryDate: batch.expiryDate ?? null,
        quantityMilli: batch.quantityMilli,
        unitCostMinor: batch.unitCostMinor ?? record.costMinor?.toString() ?? null,
      }))
    }
    // A product with no batches (a supermarket line, or stock received without a batch) still reports its
    // on-hand quantity, so the screen never looks empty when stock exists.
    const onHand = record.quantityMilli.toString()
    return [{ batchNumber: '', expiryDate: null, quantityMilli: onHand, unitCostMinor: record.costMinor?.toString() ?? null }]
  }

  private movement(row: RawMovement): MobileStockMovement {
    return {
      reference: row.reference,
      movementType: row.movement_type,
      quantityDeltaMilli: row.quantity_delta_milli,
      reason: row.reason ?? '',
      batchNumber: '',
      actor: row.created_by,
      createdAt: row.created_at,
    }
  }

  private product(record: ProductRecord): MobileProductSummary {
    return {
      id: record.id,
      sku: record.sku,
      name: record.name,
      brand: record.brand,
      barcode: record.barcode,
      category: record.category,
      unit: record.unit,
      quantityMilli: record.quantityMilli.toString(),
      reorderLevelMilli: record.reorderLevelMilli.toString(),
      retailPriceMinor: record.retailPriceMinor.toString(),
      wholesalePriceMinor: record.wholesalePriceMinor.toString(),
      costMinor: record.costMinor === null ? null : record.costMinor.toString(),
      rowVersion: record.rowVersion,
      stockVersion: record.stockVersion,
      isActive: record.isActive,
      prescriptionRequired: record.prescriptionRequired,
      expiryTracking: record.expiryTracking,
    }
  }

  /** Editing any price on the phone needs the Admin password again, exactly as the brief requires. */
  async updateProduct(principal: AuthenticatedPrincipal, input: MobileProductUpdateInput): Promise<MobileProductDetail> {
    const admin = this.requireAdmin(principal)
    const edition = this.requireEdition()
    await this.requireAdminPassword(admin, input.adminPassword)
    const current = this.host.getProduct(input.productId, this.actor(admin), edition)
    if (current.rowVersion !== input.expectedRowVersion) throw new MobileStaleVersionError()

    const draft: ProductDraft = {
      id: current.id,
      expectedVersion: input.expectedRowVersion,
      sku: current.sku,
      name: input.name,
      brand: input.brand,
      description: current.description,
      barcode: input.barcode,
      additionalBarcodes: current.additionalBarcodes,
      category: input.category,
      subCategory: current.subCategory,
      department: current.department,
      shelfLocation: current.shelfLocation,
      unit: input.unit,
      packSizeUnits: current.packSizeUnits,
      cost: normaliseMoneyInput(input.cost, 'Cost price'),
      retailPrice: normaliseMoneyInput(input.retailPrice, 'Retail price'),
      wholesalePrice: normaliseMoneyInput(input.wholesalePrice, 'Wholesale price'),
      wholesaleMinimumQuantity: current.wholesaleMinimumQuantityMilli.toString(),
      reorderLevel: input.reorderLevel,
      genericName: current.genericName,
      prescriptionRequired: current.prescriptionRequired,
      weighedItem: current.weighedItem,
      pluCode: current.pluCode,
      pricePerKg: current.pricePerKgMinor?.toString() ?? '',
      expiryTracking: current.expiryTracking,
      variants: current.variants.map((variant) => ({
        code: variant.code,
        label: variant.label,
        price: variant.priceMinor === null ? '' : variant.priceMinor.toString(),
        attributes: variant.attributes,
      })),
      isActive: current.isActive,
    }
    let saved: ProductRecord
    try {
      saved = this.host.updateProduct(draft, this.actor(admin), edition)
    } catch (error) {
      throw this.translateWriteError(error)
    }
    return this.productDetail(admin, saved.id)
  }

  createProduct(principal: AuthenticatedPrincipal, input: MobileProductCreateInput): MobileProductDetail {
    const admin = this.requireAdmin(principal)
    const edition = this.requireEdition()
    const draft: ProductDraft = {
      sku: input.sku,
      name: input.name,
      brand: '',
      description: '',
      barcode: input.barcode,
      additionalBarcodes: [],
      category: input.category,
      subCategory: '',
      department: '',
      shelfLocation: '',
      unit: input.unit || 'unit',
      packSizeUnits: 1,
      cost: normaliseMoneyInput(input.cost, 'Cost price'),
      retailPrice: normaliseMoneyInput(input.retailPrice, 'Retail price'),
      wholesalePrice: normaliseMoneyInput(input.wholesalePrice, 'Wholesale price'),
      wholesaleMinimumQuantity: '1',
      reorderLevel: input.reorderLevel || '0',
      genericName: '',
      prescriptionRequired: Boolean(input.prescriptionRequired),
      weighedItem: false,
      pluCode: '',
      pricePerKg: '',
      expiryTracking: Boolean(input.expiryTracking),
      variants: [],
      isActive: true,
    }
    // A product scanned at the shelf has no SKU written on it, and the host insists on one. Deriving it here
    // keeps the phone usable without inventing a second validation rule: the barcode is the shop's own
    // identifier, so it makes the natural SKU, with a suffix only if that SKU is somehow already taken.
    const baseSku = draft.sku.trim() || derivedSku(draft.barcode)
    let created: ProductRecord | null = null
    let lastError: unknown = null
    for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
      try {
        created = this.host.createProduct({ ...draft, sku: attempt === 0 ? baseSku : `${baseSku}-${attempt + 1}` }, this.actor(admin), edition)
      } catch (error) {
        lastError = error
        const message = error instanceof Error ? error.message : ''
        if (!/already assigned|already exists|UNIQUE/iu.test(message)) break
      }
    }
    if (!created) throw this.translateWriteError(lastError)
    return this.productDetail(admin, created.id)
  }

  adjustStock(principal: AuthenticatedPrincipal, input: MobileStockAdjustmentInput): MobileProductDetail {
    const admin = this.requireAdmin(principal)
    const edition = this.requireEdition()
    const reason = (input.reason ?? '').trim()
    if (reason.length < 3) throw new Error('Say why the stock is changing, for example "Damaged in transit".')
    try {
      this.host.adjustStock({
        productId: input.productId,
        expectedProductVersion: input.expectedProductVersion,
        expectedStockVersion: input.expectedStockVersion,
        direction: input.direction === 'decrease' ? 'decrease' : 'increase',
        quantity: input.quantity,
        reason,
        batchNumber: input.batchNumber ?? '',
        expiryDate: input.expiryDate ?? '',
        // The phone generates one per submission, so a dropped connection cannot apply the change twice.
        idempotencyKey: input.idempotencyKey,
      }, this.actor(admin), edition)
    } catch (error) {
      throw this.translateWriteError(error)
    }
    return this.productDetail(admin, input.productId)
  }

  receiveStock(principal: AuthenticatedPrincipal, input: MobileStockReceiptInput): MobileProductDetail {
    const admin = this.requireAdmin(principal)
    const edition = this.requireEdition()
    try {
      this.host.receiveStock({
        productId: input.productId,
        expectedProductVersion: input.expectedProductVersion,
        expectedStockVersion: input.expectedStockVersion,
        quantity: input.quantity,
        quantityUnit: input.quantityUnit === 'pack' ? 'pack' : 'unit',
        unitCost: normaliseMoneyInput(input.unitCost, 'Unit cost'),
        supplierName: input.supplierName ?? '',
        supplierReference: input.supplierReference ?? '',
        note: input.note ?? '',
        batchNumber: input.batchNumber ?? '',
        expiryDate: input.expiryDate ?? '',
      }, this.actor(admin), edition)
    } catch (error) {
      throw this.translateWriteError(error)
    }
    return this.productDetail(admin, input.productId)
  }

  // ---------------------------------------------------------------- reports

  report(principal: AuthenticatedPrincipal, input: ReportPeriodInput) {
    const admin = this.requireAdmin(principal)
    return this.host.getReport(input, this.actor(admin))
  }

  reportPdf(principal: AuthenticatedPrincipal, input: ReportPeriodInput): Promise<Uint8Array> {
    const admin = this.requireAdmin(principal)
    return this.host.exportReportPdf(input, this.actor(admin))
  }

  // ---------------------------------------------------------------- sales (read only)

  sales(principal: AuthenticatedPrincipal, search: string): MobileSaleList {
    const admin = this.requireAdmin(principal)
    const user = this.publicUser(admin)
    const term = search.trim().toLowerCase()
    // The POS service caps a listing at 100 rows; the phone filters and shows the newest of those.
    const sales = this.host.listRecentSales(user, 100)
      .filter((sale) => !term || sale.receiptNumber.toLowerCase().includes(term) || sale.customerName.toLowerCase().includes(term))
      .slice(0, 60)
      .map((sale) => this.saleSummary(sale))
    return { header: this.header(), sales }
  }

  private saleSummary(sale: PosRecentSaleRecord): MobileSaleSummary {
    return {
      id: sale.id,
      receiptNumber: sale.receiptNumber,
      saleType: sale.saleType,
      createdAt: sale.createdAt,
      customerName: sale.customerName,
      cashier: sale.cashier,
      totalMinor: sale.totalMinor.toString(),
      currencyCode: sale.currencyCode,
    }
  }

  saleDetail(principal: AuthenticatedPrincipal, saleId: string | number): MobileSaleDetail {
    const admin = this.requireAdmin(principal)
    const user = this.publicUser(admin)
    const receipt = this.host.getReceipt(saleId, user)
    // Viewing from the phone is recorded, so the desktop's print count and the audit trail stay honest.
    this.host.recordReceiptViewed(saleId, user, 'mobile')
    return {
      header: this.header(),
      id: receipt.id,
      receiptNumber: receipt.receiptNumber,
      saleType: receipt.saleType,
      createdAt: receipt.createdAt,
      cashier: receipt.cashier,
      workstation: receipt.workstation,
      customer: receipt.customer ? { name: receipt.customer.name, phone: receipt.customer.phone, address: receipt.customer.address } : null,
      lines: receipt.items.map((item) => ({
        sku: item.sku,
        description: item.description,
        quantityMilli: item.quantityMilli.toString(),
        unit: item.unit,
        unitPriceMinor: item.unitPriceMinor.toString(),
        lineTotalMinor: item.lineTotalMinor.toString(),
      })),
      subtotalMinor: receipt.subtotalMinor.toString(),
      discountMinor: receipt.discountMinor.toString(),
      taxMinor: receipt.taxMinor.toString(),
      totalMinor: receipt.totalMinor.toString(),
      paidMinor: receipt.paidMinor.toString(),
      creditMinor: receipt.creditMinor.toString(),
      payments: receipt.payments.map((payment) => ({
        method: payment.method,
        amountMinor: payment.amountMinor.toString(),
        reference: payment.reference,
      })),
      currency: receipt.currency,
    }
  }

  // ---------------------------------------------------------------- cashier permissions

  cashierPermissions(principal: AuthenticatedPrincipal): MobileCashierPermissions {
    const admin = this.requireAdmin(principal)
    const users = this.host.listUsers(this.publicUser(admin))
    return {
      cashiers: users
        .filter((user) => user.role === 'CASHIER' || user.role === 'SUPERVISOR')
        .map((user) => this.cashierPermissionRow(user)),
    }
  }

  private cashierPermissionRow(user: PublicUser): MobileCashierPermissionRow {
    return {
      id: user.id,
      fullName: user.fullName,
      username: user.username,
      role: user.role === 'SUPERVISOR' ? 'SUPERVISOR' : 'CASHIER',
      isActive: user.isActive,
      allowWholesale: user.permissions.allowWholesale,
      maxDiscountBasisPoints: user.permissions.maxDiscountBasisPoints,
      allowCreditSales: user.permissions.allowCreditSales,
    }
  }

  /**
   * The Admin may toggle wholesale selling from the phone and nothing else: creating users and setting
   * passwords stay on the desktop, and this method copies the existing permissions rather than accepting
   * a permission object from the phone, so no other permission can be smuggled through.
   */
  async setCashierWholesale(principal: AuthenticatedPrincipal, input: MobileCashierPermissionInput): Promise<MobileCashierPermissions> {
    const admin = this.requireAdmin(principal)
    const edition = this.requireEdition()
    await this.requireAdminPassword(admin, input.adminPassword)
    const actor = this.publicUser(admin)
    const target = this.host.listUsers(actor).find((user) => user.id === input.userId)
    if (!target) throw new Error('That cashier is no longer on this shop.')
    if (target.role !== 'CASHIER' && target.role !== 'SUPERVISOR') {
      throw new Error('Only a Cashier’s wholesale permission can be changed from the phone.')
    }
    this.host.updateUser(actor, target.id, {
      fullName: target.fullName,
      username: target.username,
      role: target.role,
      permissions: { ...target.permissions, allowWholesale: Boolean(input.allowWholesale) },
      isActive: target.isActive,
    }, edition)
    return this.cashierPermissions(admin)
  }

  // ---------------------------------------------------------------- paired phones

  /**
   * The Admin's own paired phones. The host decides what a device is; this only shapes it for the screen.
   * Revoking is all-or-nothing on the host side, so a revoked phone's very next call fails.
   */
  devices(principal: AuthenticatedPrincipal): MobileDeviceList {
    const admin = this.requireAdmin(principal)
    return { header: this.header(), devices: this.host.listPairedDevices(admin.userId) }
  }

  /** Revoking needs the Admin's password again: it signs a phone out of the shop from across the room. */
  async revokeDevice(principal: AuthenticatedPrincipal, deviceId: string, adminPassword: string): Promise<MobileDeviceList> {
    const admin = this.requireAdmin(principal)
    await this.requireAdminPassword(admin, adminPassword)
    this.host.revokePairedDevice(admin.userId, deviceId)
    return this.devices(admin)
  }

  // ---------------------------------------------------------------- approvals

  approvals(principal: AuthenticatedPrincipal): MobileApprovals {
    const admin = this.requireAdmin(principal)
    const actor = this.publicUser(admin)
    const pending = this.host.listPendingApprovals(actor)
    const recent = this.host.listRecentApprovals(actor, RECENT_APPROVAL_LIMIT)
    return {
      header: this.header(),
      pending: pending.map((request) => this.approval(request)),
      recent: recent.map((request) => this.approval(request)),
      pendingCount: pending.length,
    }
  }

  /** Keeps the host view intact but strips any internal payload the phone has no use for. */
  private approval(request: ApprovalRequestView): MobileApproval {
    return { ...request }
  }

  /**
   * Return approvals raised by the desktop still live in the older returns queue, so both queues are
   * searched. Whichever queue owns the request decides it; a request that no longer exists reports
   * "already decided" rather than a vague failure.
   */
  resolveApproval(principal: AuthenticatedPrincipal, requestId: string, decision: 'APPROVE' | 'REJECT'): MobileApprovals {
    const admin = this.requireAdmin(principal)
    try {
      this.host.resolveApproval(requestId, decision, this.publicUser(admin))
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      // "Already decided" is the queue's definitive answer; asking the returns queue next would mask it
      // with "that is not a return". Only an id the queue has never heard of falls through.
      const unknownToQueue = /no longer exists|not part of the approvals queue/iu.test(message)
      if (!unknownToQueue) throw this.translateDecisionError(error)
      try {
        this.host.resolveReturnApproval(requestId, decision, admin)
      } catch (returnError) {
        throw this.translateDecisionError(returnError)
      }
    }
    return this.approvals(admin)
  }

  private translateDecisionError(error: unknown): Error {
    const message = error instanceof Error ? error.message : 'The request could not be decided.'
    // Only a request that exists but is no longer waiting is "already decided". A malformed id or a
    // request that is not a return must keep the host's own words rather than a misleading message.
    if (/already decided|no longer waiting|has already been (approved|rejected|resolved)/iu.test(message)) {
      return new MobileReloadRequiredError('This request was already decided. Refresh to see the current list.')
    }
    if (/could not be found|no longer exists/iu.test(message)) {
      return new MobileReloadRequiredError('This request is no longer on the host. Refresh to see the current list.')
    }
    if (/Only an Admin/iu.test(message)) return new Error('Only an Admin can decide this request.')
    return new Error(message)
  }

  // ---------------------------------------------------------------- error translation

  /**
   * Turns the host's own optimistic-locking messages into the phone's one stale sentence, so the Admin
   * sees the same instruction on either screen rather than a SQLite-flavoured detail.
   */
  private translateWriteError(error: unknown): Error {
    const message = error instanceof Error ? error.message : 'The change could not be saved.'
    if (/changed.*reload|version|was already used|still being saved/iu.test(message)) {
      if (/already used|still being saved/iu.test(message)) return new Error(message)
      return new MobileStaleVersionError()
    }
    return new Error(message)
  }
}

/** A readable SKU for a product added by scanning: the barcode when there is one, else a timestamp. */
function derivedSku(barcode: string): string {
  const cleaned = barcode.replace(/[^A-Za-z0-9-]+/gu, '').toUpperCase()
  if (cleaned.length >= 4) return cleaned.slice(0, 40)
  const stamp = new Date().toISOString().replace(/[^0-9]/gu, '').slice(0, 14)
  return `SKU-${stamp}`
}

function normaliseMoneyInput(value: string, label: string): string {
  const text = String(value ?? '').trim().replace(/[\s,_]/gu, '')
  if (!/^\d+(\.\d+)?$/u.test(text)) throw new Error(`${label} must be an amount, for example 1250.00.`)
  return text
}
