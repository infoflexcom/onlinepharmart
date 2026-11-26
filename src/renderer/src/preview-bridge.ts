import { compare as bcryptCompare, hash as bcryptHash } from 'bcryptjs'
import type { InfoflexBridge } from '@shared/bridge'
import type { AppPage, CreateUserInput, PublicUser, UpdateUserInput } from '@shared/auth/types'
import { defaultPermissions, canAccessPageForRole } from '@shared/auth/policy'
import { DEFAULT_CURRENCY_CODE, getCurrency, createCustomCurrency } from '@shared/currency/catalog'
import { defaultDisplayOptions, formatMoney, roundHalfUp } from '@shared/currency/money'
import { parseMoneyExact } from '@shared/currency'
import { normalizeShopProfile, validateMoneyDisplay } from '@shared/shop/validation'
import { DEFAULT_OPERATIONAL_SETTINGS, type BootstrapData, type FirstRunInput, type ShopSettings } from '@shared/shop/types'
import { normalizeOperationalSettings } from '@shared/shop/validation'
import { TRANSACTION_CURRENCY_LOCK_MESSAGE, VENDOR_CURRENCY_LOCK_MESSAGE } from '@shared/currency/lock-messages'
import type { LicenseSummary } from '@shared/license/types'
import type { ApprovalRequestView } from '@shared/approvals/types'
import type {
  CreateOrderInput, FinalizeOrderInput, FinalizeOrderResult, OrderEventView, OrderStatus, OrderView,
} from '@shared/orders/types'
import type { SaleType } from '@shared/pos/types'
import type { PrintLogEntry } from '../../services/print-gate-service'
import { drawerAdjustmentSigned, expectedDrawerCash } from '../../services/cash-drawer'
import { can, resolveRole } from '../../../packages/core/src/index'
import { createPreviewAudit } from './preview-audit'
import { createAuditCsv } from '../../services/audit-export'
import type {
  AuditDayStatus, AuditDebtorPaymentRow, AuditExportInput, AuditExportResult, AuditFlagNoteInput, AuditFlagRow,
  AuditNoteFindingInput, AuditSignOffRow, AuditSummaryForPhone, DailyAuditReport, DayAuditInput, RaiseAuditFlagInput,
  ResolveAuditFlagInput, SignOffDayInput, UnauditedDay,
} from '@shared/audit/types'
import type {
  MobileAccessStatus, MobileConnectionTest, MobileKeepRunningSettings, MobileTotpEnrollment,
  PairedMobileDevice, PendingMobileApproval, TotpStatus,
} from '@shared/mobile/types'
import type {
  AccountingReport,
  CashDrawerEventInput,
  CashierShiftReportRow,
  CloseCashierShiftInput,
  CloseDayInput,
  DayCloseRecord,
  DebtorReportRow,
  OpenCashierShiftInput,
  RecordDebtorPaymentInput,
  ReportExportInput,
  ReportPeriodInput,
} from '@shared/reports/types'
import type {
  ReturnApprovalDecision,
  ReturnDocumentLayout,
  RequestReturnInput,
  ReturnItemCondition,
  ReturnRecord,
  ReturnSaleRecord,
  ReturnSaleItemRecord,
  ResolveReturnApprovalResult,
} from '@shared/returns/types'
import type {
  CompletePosSaleInput,
  HeldPosCartData,
  HeldPosCartRecord,
  PosCustomerDraft,
  PosCustomerRecord,
  PosQuoteInput,
  PosQuoteRecord,
  PosReceiptRecord,
  PosRecentSaleRecord,
  ReceiptLayout,
} from '@shared/pos/types'
import type { Edition } from '../../editions'
import type {
  ConsumeStockInput,
  FEFOSaleAllocation,
  FEFOSaleResult,
  InventoryAlert,
  InventoryOverview,
  ProductDraft,
  ProductImportReport,
  ProductRecord,
  PurchaseOrderDraft,
  PurchaseOrderRecord,
  PurchaseOrderReceiptInput,
  ReceiveStockInput,
  SellableBatch,
  StockAdjustmentInput,
  StockMutationResult,
  StocktakeInput,
  StocktakeVarianceRecord,
  WeighedPriceResult,
} from '@shared/inventory/types'

const defaultCurrency = getCurrency(DEFAULT_CURRENCY_CODE)!

function getPreviewEdition(): Edition {
  if (typeof window !== 'undefined') {
    const requested = new URLSearchParams(window.location.search).get('edition')?.toUpperCase()
    if (requested === 'PHARMACY' || requested === 'SUPERMARKET' || requested === 'BOTH') return requested
  }
  return 'PHARMACY'
}

const edition = getPreviewEdition()
const previewLicense: LicenseSummary = {
  status: 'active', canUse: true, licenseId: 'browser-preview', source: 'online', edition,
  startsAt: null, endsAt: null, defaultCurrencyCode: null, lockCurrency: false,
  features: { mobileLan: true, mobileInternet: true }, adminPhoneLimit: 100, graceDays: 0,
  lastOnlineCheck: null, reportedToPortal: false, vendorConfigured: false,
  maximumOnsitePeriodYears: null, licenseServerUrl: null, message: 'Browser preview only; desktop licensing is enforced by the Electron host.',
}

type PreviewAccount = {
  user: PublicUser
  passwordHash: string
  failedAttempts: number
  /** When the seat was given a password. Absent means "needs password", exactly as `users.password_set_at`. */
  passwordSetAt?: number
}

/** The preview's stand-in for the settings migration 17 adds. Defaults match the real ones. */
const previewTeamSettings = {
  supervisorSeesCost: false,
  singleLoginPerAccount: true,
  allowAdminOnClients: false,
  orderExpiryMinutes: 120,
}

/** Seat counts the preview has been asked for, so raising a count twice does not look like a different shop. */
const previewSeatTargets: Partial<Record<'ADMIN' | 'SUPERVISOR' | 'ACCOUNT' | 'USER', number>> = {}

/** Memory-only demonstration adapter for the browser preview. Desktop IPC uses SQLite host services. */
function normalizePreviewUsername(value: string): string {
  if (typeof value !== 'string') throw new Error('Enter a username.')
  const username = value.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) throw new Error('Username must be 3–32 letters, numbers, dots, underscores, or hyphens.')
  return username
}

function validatePreviewPassword(password: string, confirmation: string): void {
  if (typeof password !== 'string' || typeof confirmation !== 'string' || password.length < 10) {
    throw new Error('Use at least 10 characters for the password.')
  }
  if (new TextEncoder().encode(password).length > 72) throw new Error('Password must be 72 UTF-8 bytes or fewer.')
  const categories = [/[a-z]/.test(password), /[A-Z]/.test(password), /[0-9]/.test(password), /[^A-Za-z0-9]/.test(password)].filter(Boolean).length
  if (categories < 3) throw new Error('Use a mix of upper-case, lower-case, numbers, and symbols.')
  if (password !== confirmation) throw new Error('Passwords do not match.')
}

function previewProductName(selectedEdition: string): string {
  if (selectedEdition === 'PHARMACY') return 'Infoflex Pharm'
  if (selectedEdition === 'SUPERMARKET') return 'Infoflex Mart'
  return 'Infoflex Pharm & Mart'
}

export function createPreviewBridge(): InfoflexBridge {
  let settings: ShopSettings = {
    profile: { name: '', address: '', phone: '' },
    currency: defaultCurrency,
    display: defaultDisplayOptions(defaultCurrency),
    setupComplete: false,
    currencyConfirmed: false,
    currencyLocked: false,
    idleTimeoutMinutes: 15,
    returnWindowDays: 7,
    operational: { ...DEFAULT_OPERATIONAL_SETTINGS },
  }
  const accounts = new Map<string, PreviewAccount>()
  let currentUser: PublicUser | null = null
  let lastActivity = 0
  const previewMobileDevices: PairedMobileDevice[] = []
  let previewKeepRunning: MobileKeepRunningSettings = { keepRunning: true, startWithWindows: true, preventSleep: true }
  const previewApprovals: ApprovalRequestView[] = []
  let nextId = 0
  let nextProductId = 0
  const inventoryProducts: ProductRecord[] = []
  const inventoryBatches: Array<SellableBatch & { productId: string }> = []
  const purchaseOrders: PurchaseOrderRecord[] = []
  const stocktakeReport: StocktakeVarianceRecord[] = []
  const previewCustomers: PosCustomerRecord[] = []
  const heldPosCarts: HeldPosCartRecord[] = []
  const previewReceipts = new Map<number, PosReceiptRecord>()
  const previewReturns: ReturnRecord[] = []
  const previewShifts: CashierShiftReportRow[] = []
  const previewDayCloses = new Map<string, DayCloseRecord>()
  let nextPreviewCloseId = 0
  /**
   * The preview's daily audit.
   *
   * Constructed here rather than inside the returned object because the sources are closures over this state: the audit
   * has to read the day as it stands when the screen asks, not as it stood when the bridge was built.
   */
  const previewAudit = createPreviewAudit({
    receipts: () => [...previewReceipts.values()],
    returns: () => previewReturns,
    shifts: () => previewShifts,
    dayCloses: () => previewDayCloses,
    customers: () => previewCustomers,
    products: () => inventoryProducts,
    orders: () => previewOrders
      .filter((order) => order.status === 'CANCELLED' || order.status === 'EXPIRED')
      .map((order) => ({
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: order.status === 'EXPIRED' ? 'EXPIRED' as const : 'CANCELLED' as const,
        pickedByName: order.createdByName,
        totalMinor: order.totalMinor,
        at: order.createdAt,
        reason: order.events.length > 0 ? order.events[order.events.length - 1]!.detail : '',
      })),
    users: () => [...accounts.values()].map(({ user }) => user),
    settings: () => settings,
    edition: () => edition,
  })
  const previewIdempotency = new Map<string, number>()
  /**
   * The browser preview's copy of the order workflow.
   *
   * In memory, like everything else in this file, and deliberately structured the same way as `OrderService`: an order
   * reserves stock, and finalizing releases the reservation and delegates to the same `completePosSale` the till uses.
   * A preview that took a different route to a sale would demo behaviour the product does not have.
   */
  /** Two hours, the brief's default. The preview has no settings row for it and does not need one. */
  const PREVIEW_ORDER_EXPIRY_MINUTES = 120
  const previewOrders: PreviewOrderRow[] = []
  let previewOrderSequence = 0

  interface PreviewOrderLine {
    id: string
    productId: string
    description: string
    unit: string
    quantityMilli: bigint
    unitPriceMinor: bigint
    discountMinor: bigint
    lineTotalMinor: bigint
    prescriptionRequired: boolean
  }

  interface PreviewOrderRow {
    id: string
    orderNumber: string
    type: SaleType
    status: OrderStatus
    customerId: string | null
    createdById: string
    createdByName: string
    finalizedByName: string | null
    currencyCode: string
    subtotalMinor: bigint
    discountMinor: bigint
    totalMinor: bigint
    lines: PreviewOrderLine[]
    expiresAt: string
    createdAt: string
    saleId: number | null
    receiptNumber: string | null
    events: OrderEventView[]
  }

  /** The shape the screens read, built from the preview's own row. Mirrors `OrderService.toView`. */
  function previewOrderView(row: PreviewOrderRow): OrderView {
    return {
      ...structuredClone({
        id: row.id, orderNumber: row.orderNumber, type: row.type, status: row.status,
        customerId: row.customerId, createdById: row.createdById, createdByName: row.createdByName,
        finalizedById: null, finalizedByName: row.finalizedByName, currencyCode: row.currencyCode,
        expiresAt: row.expiresAt, createdAt: row.createdAt, saleId: row.saleId, receiptNumber: row.receiptNumber,
      }),
      customerName: row.customerId
        ? previewCustomers.find((candidate) => candidate.id === row.customerId)?.name ?? null
        : null,
      subtotalMinor: row.subtotalMinor,
      discountMinor: row.discountMinor,
      taxMinor: 0n,
      totalMinor: row.totalMinor,
      lines: row.lines.map((line) => ({ ...line })),
      needsPrescriptionAck: row.lines.some((line) => line.prescriptionRequired),
      events: row.events.map((event) => ({ ...event })),
    }
  }

  function requireOrderRole(user: PublicUser, capability: 'build_order' | 'take_payment' | 'see_own_orders', act: string): void {
    const role = user.role === 'CASHIER' ? 'USER' : user.role
    if (!can(role, capability)) throw new Error(`Your role cannot ${act}.`)
  }

  /** Release an unpaid order's holds and mark it finished, the preview's equivalent of the expiry sweep. */
  function sweepPreviewOrders(now: number): void {
    for (const row of previewOrders) {
      if (row.status !== 'PENDING') continue
      if (Date.parse(row.expiresAt) > now) continue
      for (const line of row.lines) {
        const product = inventoryProducts.find((candidate) => candidate.id === line.productId)
        if (product) product.reservedMilli -= line.quantityMilli
      }
      row.status = 'EXPIRED'
      row.events.push({
        event: 'order.expired', fromStatus: 'PENDING', toStatus: 'EXPIRED', actorName: null,
        detail: 'Unpaid past its expiry; reserved stock released.', createdAt: new Date(now).toISOString(),
      })
    }
  }

  function context() {
    const initialCurrency = settings.currency ?? defaultCurrency
    return {
      licenseActivated: true,
      edition,
      installerCurrencyCode: null,
      licenseDefaultCurrencyCode: null,
      currencyLocked: settings.currencyLocked,
      vendorCurrencyLocked: false,
      initialCurrency,
      productName: previewProductName(edition),
      // The browser preview has no licence, so it names no caps and offers the same starting team size as a real
      // install. Keeping these here rather than in the screen means the preview exercises the same shape the desktop
      // host returns, which is the only way the preview is worth having.
      seatCaps: { account: null, user: null, supervisor: null },
      seatDefaults: { account: 1, user: 1, supervisor: 0 },
    }
  }

  function getActiveUser(touch = true): PublicUser {
    if (!currentUser) throw new Error('Your session has expired. Sign in again.')
    if (Date.now() - lastActivity >= (settings.idleTimeoutMinutes ?? 15) * 60_000) {
      currentUser = null
      throw new Error('Your session has expired. Sign in again.')
    }
    if (touch) lastActivity = Date.now()
    const account = accounts.get(currentUser.id)
    if (!account || !account.user.isActive || account.user.isLocked) {
      currentUser = null
      throw new Error('Your session has expired. Sign in again.')
    }
    currentUser = { ...account.user, permissions: { ...account.user.permissions } }
    return currentUser
  }

  function requireAdmin(): PublicUser {
    const user = getActiveUser()
    if (user.role !== 'ADMIN') throw new Error('This action is restricted to the Admin.')
    return user
  }

  function requireInventoryPage(page: 'products' | 'stock' | 'pos'): PublicUser {
    const user = getActiveUser()
    if (!canAccessPageForRole(user, page, edition)) throw new Error('You do not have permission to open this page.')
    return user
  }

  function requireInventoryAdmin(page: 'products' | 'stock' | 'pos'): PublicUser {
    const user = requireInventoryPage(page)
    if (user.role !== 'ADMIN') throw new Error('This action is restricted to the Admin.')
    return user
  }

  function parsePreviewQuantity(value: string): bigint {
    if (typeof value !== 'string') throw new Error('Enter a valid quantity.')
    const match = /^(\d+)(?:\.(\d{0,3}))?$/.exec(value.trim())
    if (!match) throw new Error('Enter a non-negative quantity with at most three decimal places.')
    return BigInt(match[1]!) * 1000n + BigInt((match[2] ?? '').padEnd(3, '0') || '0')
  }

  function previewMoney(value: string): bigint {
    return parseMoneyExact(value, settings.currency, settings.display)
  }

  function findPreviewProduct(id: string): ProductRecord {
    const product = inventoryProducts.find((item) => item.id === id)
    if (!product) throw new Error('Product was not found or is no longer available.')
    return product
  }

  function inventoryProductView(user: PublicUser, product: ProductRecord): ProductRecord {
    return { ...structuredClone(product), costMinor: user.role === 'ADMIN' ? product.costMinor : null }
  }

  function savePreviewProduct(draft: ProductDraft, user: PublicUser): ProductRecord {
    if (!draft || typeof draft !== 'object') throw new Error('Enter product details.')
    const existing = draft.id ? findPreviewProduct(draft.id) : null
    if (existing && existing.rowVersion !== draft.expectedVersion) throw new Error('This item changed. Reload before saving the edit.')
    const sku = draft.sku.trim().toUpperCase()
    const name = draft.name.trim()
    if (!sku || !name) throw new Error('Enter an SKU and product name.')
    if (inventoryProducts.some((product) => product.sku.toLowerCase() === sku.toLowerCase() && product.id !== existing?.id)) {
      throw new Error(`SKU “${sku}” is already assigned to another product.`)
    }
    if (!Number.isInteger(draft.packSizeUnits) || draft.packSizeUnits < 1) throw new Error('Pack size must be a positive whole number.')
    const costMinor = previewMoney(draft.cost)
    const retailPriceMinor = previewMoney(draft.retailPrice)
    const wholesalePriceMinor = previewMoney(draft.wholesalePrice || '0')
    if ([costMinor, retailPriceMinor, wholesalePriceMinor].some((amount) => amount < 0n)) throw new Error('Prices cannot be negative.')
    const barcodes = [draft.barcode, ...(draft.additionalBarcodes ?? [])].map((value) => value.trim().toUpperCase()).filter(Boolean)
    if (new Set(barcodes).size !== barcodes.length) throw new Error('A barcode appears more than once for this product.')
    for (const barcode of barcodes) {
      if (inventoryProducts.some((product) => product.id !== existing?.id && [product.barcode, ...product.additionalBarcodes].some((value) => value.toLowerCase() === barcode.toLowerCase()))) {
        throw new Error(`Barcode “${barcode}” is already assigned to another product.`)
      }
    }
    const variants = (draft.variants ?? []).map((variant) => ({
      id: `preview-variant-${++nextProductId}`,
      code: variant.code.trim().toUpperCase(),
      label: variant.label.trim(),
      priceMinor: variant.price.trim() ? previewMoney(variant.price) : null,
      attributes: { ...(variant.attributes ?? {}) },
      rowVersion: 1,
    }))
    const product: ProductRecord = {
      id: existing?.id ?? `preview-product-${++nextProductId}`,
      sku,
      name,
      brand: draft.brand.trim(),
      description: draft.description.trim(),
      barcode: barcodes[0] ?? '',
      additionalBarcodes: barcodes.slice(1),
      category: draft.category.trim(),
      subCategory: draft.subCategory.trim(),
      department: draft.department.trim(),
      shelfLocation: draft.shelfLocation.trim(),
      unit: draft.unit.trim() || 'each',
      packSizeUnits: draft.packSizeUnits,
      costMinor,
      retailPriceMinor,
      wholesalePriceMinor,
      wholesaleMinimumQuantityMilli: parsePreviewQuantity(draft.wholesaleMinimumQuantity || '0'),
      reorderLevelMilli: parsePreviewQuantity(draft.reorderLevel || '0'),
      quantityMilli: existing?.quantityMilli ?? 0n,
      reservedMilli: existing?.reservedMilli ?? 0n,
      rowVersion: (existing?.rowVersion ?? 0) + 1,
      stockVersion: existing?.stockVersion ?? 1,
      genericName: edition === 'PHARMACY' || edition === 'BOTH' ? draft.genericName.trim() : '',
      prescriptionRequired: draft.prescriptionRequired === true,
      weighedItem: draft.weighedItem === true,
      pluCode: draft.pluCode.trim().toUpperCase(),
      pricePerKgMinor: draft.pricePerKg.trim() ? previewMoney(draft.pricePerKg) : null,
      expiryTracking: edition === 'PHARMACY' || draft.expiryTracking === true,
      isActive: draft.isActive !== false,
      variants,
    }
    if (product.weighedItem && (!product.pluCode || product.pricePerKgMinor === null)) {
      throw new Error('Weighed items need a PLU code and price per kilogram.')
    }
    if (existing) {
      // Only a price move is recorded, and only the price that was there before it. This is the preview's stand-in for
      // the `product.updated` audit-log entries the Server writes: without it, an override could never be explained by a
      // later price change, and correcting a spelling would look like one.
      if (existing.retailPriceMinor !== product.retailPriceMinor
        || existing.wholesalePriceMinor !== product.wholesalePriceMinor) {
        previewAudit.notePriceChange(
          product.id, existing.retailPriceMinor, existing.wholesalePriceMinor,
        )
      }
      inventoryProducts[inventoryProducts.indexOf(existing)] = product
    } else inventoryProducts.push(product)
    return inventoryProductView(user, product)
  }

  function updatePreviewStock(product: ProductRecord, delta: bigint, batchNumber: string, expiryDate: string, unitCost: bigint): void {
    const tracked = edition === 'PHARMACY' || product.expiryTracking
    if (!tracked && (batchNumber || expiryDate)) throw new Error('Batch and expiry details are not enabled for this product.')
    if (tracked && delta > 0n) {
      if (!batchNumber.trim() || !/^\d{4}-\d{2}-\d{2}$/u.test(expiryDate)) throw new Error('Enter a valid batch number and expiry date.')
      const existing = inventoryBatches.find((item) => item.productId === product.id && item.batchNumber?.toLowerCase() === batchNumber.toLowerCase())
      if (existing && existing.expiryDate !== expiryDate) throw new Error('This batch number already exists with a different expiry date.')
      if (existing) existing.quantityMilli += delta
      else inventoryBatches.push({ productId: product.id, batchId: `preview-batch-${++nextProductId}`, batchNumber, expiryDate, quantityMilli: delta, unitCostMinor: unitCost })
    } else if (tracked && delta < 0n) {
      let remaining = -delta
      const batches = inventoryBatches.filter((item) => item.productId === product.id && item.quantityMilli > 0n
        && (!batchNumber || item.batchNumber?.toLowerCase() === batchNumber.toLowerCase()))
        .sort((a, b) => (a.expiryDate ?? '').localeCompare(b.expiryDate ?? ''))
      for (const batch of batches) {
        const take = batch.quantityMilli < remaining ? batch.quantityMilli : remaining
        batch.quantityMilli -= take
        remaining -= take
        if (remaining === 0n) break
      }
      if (remaining > 0n) throw new Error('Expiry-tracked lots do not contain enough stock for this adjustment.')
    }
    const next = product.quantityMilli + delta
    if (next < product.reservedMilli) throw new Error('Stock cannot be reduced below reserved quantity.')
    product.quantityMilli = next
    product.stockVersion += 1
  }

  function inventoryAlerts(): InventoryAlert[] {
    const alerts: InventoryAlert[] = []
    for (const product of inventoryProducts.filter((item) => item.isActive)) {
      if (product.quantityMilli <= product.reorderLevelMilli) {
        alerts.push({ type: 'low_stock', productId: product.id, sku: product.sku, productName: product.name,
          quantityMilli: product.quantityMilli, reorderLevelMilli: product.reorderLevelMilli, unit: product.unit })
      }
      for (const batch of inventoryBatches.filter((item) => item.productId === product.id && item.quantityMilli > 0n && item.expiryDate)) {
        const days = (Date.parse(`${batch.expiryDate}T00:00:00Z`) - Date.now()) / 86_400_000
        if (days <= 90) alerts.push({ type: days < 0 ? 'expired' : 'near_expiry', productId: product.id, sku: product.sku,
          productName: product.name, batchId: batch.batchId!, batchNumber: batch.batchNumber!, expiryDate: batch.expiryDate!,
          quantityMilli: batch.quantityMilli, unit: product.unit })
      }
    }
    return alerts
  }

  function publicAccount(user: PublicUser): PublicUser {
    return { ...user, permissions: { ...user.permissions } }
  }

  function importPreviewRows(rows: string[][], user: PublicUser): ProductImportReport {
    if (rows.length < 2) throw new Error('The import needs a header and at least one product row.')
    const headers = rows[0]!.map((header) => header.trim().toLowerCase().replace(/[\s-]+/gu, '_'))
    for (const required of ['sku', 'name', 'retail_price']) {
      if (!headers.includes(required)) throw new Error(`The product import is missing the required “${required}” column.`)
    }
    const report: ProductImportReport = { imported: 0, errors: [] }
    for (let index = 1; index < rows.length; index += 1) {
      const values = rows[index]!
      if (values.every((value) => !value.trim())) continue
      try {
        const record = Object.fromEntries(headers.map((header, column) => [header, values[column] ?? '']))
        let variants: ProductDraft['variants'] = []
        if (record.variants_json?.trim()) {
          const parsed = JSON.parse(record.variants_json) as unknown
          if (!Array.isArray(parsed)) throw new Error('Variants JSON must be an array.')
          variants = parsed.map((value) => {
            const item = value as Record<string, unknown>
            return { code: String(item.code ?? ''), label: String(item.label ?? ''), price: String(item.price ?? ''), attributes: (item.attributes ?? {}) as Record<string, string> }
          })
        }
        savePreviewProduct({
          sku: record.sku ?? '', name: record.name ?? '', brand: record.brand ?? '', description: record.description ?? '',
          barcode: record.barcode ?? '', additionalBarcodes: (record.additional_barcodes ?? '').split(/[|;]/u).filter(Boolean),
          category: record.category ?? '', subCategory: record.sub_category ?? '', department: record.department ?? '',
          shelfLocation: record.shelf_location ?? '', unit: record.unit || 'each', packSizeUnits: Number(record.pack_size_units || '1'),
          cost: record.cost || '0', retailPrice: record.retail_price ?? '', wholesalePrice: record.wholesale_price || '0',
          wholesaleMinimumQuantity: record.wholesale_minimum_quantity || '0', reorderLevel: record.reorder_level || '0',
          genericName: record.generic_name ?? '', prescriptionRequired: previewBoolean(record.prescription_required),
          weighedItem: previewBoolean(record.weighed_item), pluCode: record.plu_code ?? '', pricePerKg: record.price_per_kg ?? '',
          expiryTracking: previewBoolean(record.expiry_tracking), variants,
          isActive: record.is_active === '' || record.is_active === undefined ? true : previewBoolean(record.is_active),
        }, user)
        report.imported += 1
      } catch (error) {
        report.errors.push({ row: index + 1, message: error instanceof Error ? error.message : 'This row could not be imported.' })
      }
    }
    return report
  }

  function previewExportRows(user: PublicUser): string[][] {
    const admin = user.role === 'ADMIN'
    const headers = [
      'sku', 'name', 'brand', 'description', 'barcode', 'additional_barcodes', 'category', 'sub_category',
      'department', 'shelf_location', 'unit', 'pack_size_units', ...(admin ? ['cost'] : []),
      'retail_price', 'wholesale_price', 'wholesale_minimum_quantity', 'reorder_level',
      ...(edition !== 'SUPERMARKET' ? ['generic_name', 'prescription_required'] : []),
      ...(edition !== 'PHARMACY' ? ['weighed_item', 'plu_code', 'price_per_kg', 'expiry_tracking'] : []),
      'is_active', 'variants_json', 'currency_code',
    ]
    const rows = [headers]
    for (const product of inventoryProducts) {
      const fields = [
        product.sku, product.name, product.brand, product.description, product.barcode,
        product.additionalBarcodes.join('|'), product.category, product.subCategory, product.department,
        product.shelfLocation, product.unit, String(product.packSizeUnits),
      ]
      if (admin) fields.push(formatMoney(product.costMinor ?? 0n, settings.currency, settings.display))
      fields.push(formatMoney(product.retailPriceMinor, settings.currency, settings.display),
        formatMoney(product.wholesalePriceMinor, settings.currency, settings.display),
        formatPreviewQuantity(product.wholesaleMinimumQuantityMilli), formatPreviewQuantity(product.reorderLevelMilli))
      if (edition !== 'SUPERMARKET') fields.push(product.genericName, String(product.prescriptionRequired))
      if (edition !== 'PHARMACY') fields.push(String(product.weighedItem), product.pluCode,
        product.pricePerKgMinor === null ? '' : formatMoney(product.pricePerKgMinor, settings.currency, settings.display), String(product.expiryTracking))
      fields.push(String(product.isActive), JSON.stringify(product.variants.map((variant) => ({
        code: variant.code, label: variant.label,
        price: variant.priceMinor === null ? '' : formatMoney(variant.priceMinor, settings.currency, settings.display),
        attributes: variant.attributes,
      }))), settings.currency.code)
      rows.push(fields)
    }
    return rows
  }

  function requireReturnPage(): PublicUser {
    const user = getActiveUser()
    if (!canAccessPageForRole(user, 'returns', edition)) throw new Error('You do not have permission to open the Returns page.')
    return user
  }

  async function getBootstrap(): Promise<BootstrapData> {
    if (currentUser) {
      try { currentUser = getActiveUser(false) } catch { currentUser = null }
    }
    return {
      appInfo: {
        appName: previewProductName(edition),
        productName: previewProductName(edition),
        appVersion: '0.1.0',
        edition,
        runtime: 'preview',
        // The browser preview stands for the Server: there is no client machine to hand anybody over to.
        appRole: 'server',
      },
      settings: structuredClone(settings),
      setupContext: context(),
      license: previewLicense,
      hasUsers: accounts.size > 0,
      currentUser: currentUser ? publicAccount(currentUser) : null,
    }
  }

  // Assigned to a name rather than returned inline, because the order workflow delegates to this bridge's own
  // `quotePosSale` and `completePosSale`. Reaching for them through the returned object is what keeps the preview on
  // the same route to a sale as the desktop host, instead of growing a second pricing path.
  const bridge: InfoflexBridge = {
    getBootstrap,
    async getLicenseStatus() { return previewLicense },
    async importVendorPolicyFile() { throw new Error('Import the Build Studio policy from the Electron desktop host.') },
    async activateOnline() { throw new Error('Online activation is available in the Electron desktop host, not this browser preview.') },
    async importLicenseFile() { throw new Error('License file import is available in the Electron desktop host.') },
    async activateOnsite() { throw new Error('On-site activation is available in the Electron desktop host.') },
    async checkInLicense() { return { checkedAt: new Date().toISOString(), updated: false, status: 'active', message: 'Browser preview does not contact the license service.' } },
    async getShopSettings() { return structuredClone(settings) },
    async completeFirstRun(input: FirstRunInput) {
      if (accounts.size) throw new Error('First-run setup has already been completed.')
      if (!input?.admin) throw new Error('Enter the required Admin account details.')
      const profile = normalizeShopProfile(input.profile)
      const adminName = input.admin.fullName.trim()
      const username = normalizePreviewUsername(input.admin.username)
      if (!adminName) throw new Error('Enter Admin full name.')
      validatePreviewPassword(input.admin.password, input.admin.confirmPassword)
      if (!input.currencyConfirmed) throw new Error('Confirm the shop currency before completing setup.')
      const currency = input.currency.kind === 'custom' ? createCustomCurrency(input.currency) : getCurrency(input.currency.code)
      if (!currency) throw new Error('Choose a supported currency.')
      validateMoneyDisplay(input.display)
      const passwordHash = await bcryptHash(input.admin.password, 10)
      const admin: PublicUser = {
        id: `preview-user-${++nextId}`,
        fullName: adminName,
        username,
        role: 'ADMIN',
        isActive: true,
        isLocked: false,
        permissions: defaultPermissions('ADMIN'),
      }
      settings = {
        ...settings,
        profile,
        currency,
        display: { ...input.display },
        setupComplete: true,
        currencyConfirmed: true,
        currencyLocked: context().currencyLocked,
      }
      accounts.set(admin.id, { user: admin, passwordHash, failedAttempts: 0 })
      return structuredClone(settings)
    },
    async login(input) {
      const username = typeof input?.username === 'string' ? input.username.trim().toLowerCase() : ''
      const password = typeof input?.password === 'string' ? input.password : ''
      const account = [...accounts.values()].find(({ user }) => user.username === username)
      const matches = account ? await bcryptCompare(password, account.passwordHash) : false
      if (!account || !account.user.isActive || account.user.isLocked || !matches) {
        if (account && !account.user.isLocked && !matches) {
          account.failedAttempts += 1
          if (account.failedAttempts >= 5) account.user.isLocked = true
        }
        throw new Error('Unable to sign in. Check your username and password or contact the Admin.')
      }
      account.failedAttempts = 0
      currentUser = publicAccount(account.user)
      lastActivity = Date.now()
      return publicAccount(currentUser)
    },
    async logout() { currentUser = null },
    async getCurrentUser() {
      try { return publicAccount(getActiveUser(false)) } catch { return null }
    },
    async touchSession() { try { getActiveUser(); lastActivity = Date.now(); return true } catch { return false } },
    async getNavigation() {
      const user = getActiveUser()
      const labels: Array<[AppPage, string]> = [
        ['dashboard', 'Dashboard'], ['pos', 'POS'], ['products', 'Products'], ['stock', 'Stock / Purchases'],
        ['returns', 'Returns'], ['customers', 'Customers'], ['reports', 'Reports'], ['users', 'Users'],
        ['mobile', 'Mobile Access'], ['settings', 'Settings'], ['batches', 'Batches / Expiry'],
      ]
      return labels.filter(([page]) => canAccessPageForRole(user, page, edition)).map(([id, label]) => ({ id, label }))
    },
    async openPage(page) {
      const user = getActiveUser()
      if (!canAccessPageForRole(user, page, edition)) throw new Error('You do not have permission to open this page.')
      return { page }
    },
    async canMakeWholesaleSale() {
      const user = getActiveUser()
      return user.role === 'ADMIN' || user.permissions.allowWholesale
    },
    async assertMobileFeature() { if (requireAdmin() && !previewLicense.features.mobileLan && !previewLicense.features.mobileInternet) throw new Error('Mobile access is not included in this preview license.') },
    async assertAdminPhoneCapacity() { requireAdmin() },
    async getMobileAccessStatus(): Promise<MobileAccessStatus> {
      requireAdmin()
      return {
        running: false, urls: [], friendlyUrls: [], port: null, certificateFingerprint: null,
        certificateNeedsInstall: false, pairedDeviceCount: previewMobileDevices.length,
        connectedDeviceCount: previewMobileDevices.filter((device) => device.connected).length,
        phoneLimit: previewLicense.features.mobileLan ? 1 : 0, firewallBlocked: false, firewallMessage: null,
        message: 'The secure mobile listener is available in the installed desktop app, not this browser preview.',
        internet: {
          state: 'unavailable', entitled: previewLicense.features.mobileInternet, enabled: false,
          publicUrl: null, relayHost: null, link: null,
          message: 'Internet access is available only in the installed desktop app.',
          privacyNote: '',
        },
      }
    },
    async startMobileAccess(): Promise<MobileAccessStatus> { requireAdmin(); throw new Error('The secure mobile listener is available only in the installed desktop app.') },
    async stopMobileAccess(): Promise<MobileAccessStatus> { requireAdmin(); return this.getMobileAccessStatus() },
    async setMobileInternetAccess(): Promise<MobileAccessStatus> { requireAdmin(); throw new Error('Internet access is available only in the installed desktop app.') },
    async beginMobilePairing() { requireAdmin(); throw new Error('Phone pairing is available only in the installed desktop app.') },
    async listMobileDevices() { requireAdmin(); return [...previewMobileDevices] },
    async revokeMobileDevice() { requireAdmin(); return [...previewMobileDevices] },
    async getMobileTrustCertificate() { requireAdmin(); throw new Error('The trust certificate is available only in the installed desktop app.') },
    async acknowledgeMobileCertificateInstalled(): Promise<MobileAccessStatus> { requireAdmin(); return this.getMobileAccessStatus() },
    async regenerateMobileCertificate(): Promise<MobileAccessStatus> { requireAdmin(); throw new Error('Certificate management is available only in the installed desktop app.') },
    async listPendingMobileApprovals(): Promise<PendingMobileApproval[]> { requireAdmin(); return [] },
    async approveMobileDevice(): Promise<PendingMobileApproval[]> { requireAdmin(); throw new Error('Device approval is available only in the installed desktop app.') },
    async rejectMobileDevice(): Promise<PendingMobileApproval[]> { requireAdmin(); throw new Error('Device approval is available only in the installed desktop app.') },
    async renameMobileDevice(): Promise<PairedMobileDevice[]> { requireAdmin(); throw new Error('Renaming a phone is available only in the installed desktop app.') },
    async revokeAllMobileDevices(): Promise<PairedMobileDevice[]> { requireAdmin(); previewMobileDevices.length = 0; return [] },
    async turnOffAllMobileAccess(): Promise<MobileAccessStatus> { requireAdmin(); return this.getMobileAccessStatus() },
    async repairMobileFirewall(): Promise<MobileAccessStatus> { requireAdmin(); throw new Error('Firewall repair is available only in the installed Windows app.') },
    async testMobileConnection(): Promise<MobileConnectionTest> {
      requireAdmin()
      return {
        ok: false, checkedAt: new Date().toISOString(), port: null, urls: [], certificateFingerprint: null, firewallBlocked: false,
        steps: [{ label: 'Installed desktop app', ok: false, detail: 'Mobile access runs in the installed Infoflex desktop app, not this browser preview.' }],
      }
    },
    async startMobileTotpEnrollment(): Promise<MobileTotpEnrollment> { requireAdmin(); throw new Error('Authenticator set-up is available only in the installed desktop app.') },
    async confirmMobileTotp(): Promise<TotpStatus> { requireAdmin(); throw new Error('Authenticator set-up is available only in the installed desktop app.') },
    async getMobileTotpStatus(): Promise<TotpStatus> { requireAdmin(); return { enrolled: false, confirmedAt: null } },
    async disableMobileTotp(): Promise<TotpStatus> { requireAdmin(); return { enrolled: false, confirmedAt: null } },
    async getKeepRunningSettings(): Promise<MobileKeepRunningSettings> { requireAdmin(); return previewKeepRunning },
    async setKeepRunningSettings(settings: MobileKeepRunningSettings): Promise<MobileKeepRunningSettings> {
      requireAdmin()
      previewKeepRunning = { ...settings }
      return previewKeepRunning
    },
    async listPendingApprovals(): Promise<ApprovalRequestView[]> { return previewApprovals.filter((request) => request.status === 'PENDING') },
    async listRecentApprovals(): Promise<ApprovalRequestView[]> { return previewApprovals.filter((request) => request.status !== 'PENDING') },
    async pendingApprovalCount(): Promise<number> { return previewApprovals.filter((request) => request.status === 'PENDING').length },
    async resolveApproval(requestId: string, decision: 'APPROVE' | 'REJECT'): Promise<ApprovalRequestView> {
      // A Cashier cannot decide their own request in the preview either; the host enforces the same rule.
      const user = getActiveUser()
      if (!user || user.role === 'CASHIER') throw new Error('Only an Admin can decide this request.')
      const request = previewApprovals.find((entry) => entry.id === requestId)
      if (!request || request.status !== 'PENDING') throw new Error('This request was already decided.')
      request.status = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED'
      request.resolvedBy = user.fullName
      request.resolvedAt = new Date().toISOString()
      return request
    },
    async listUsers() { requireAdmin(); return [...accounts.values()].map(({ user }) => publicAccount(user)) },

    // ─── Team size and seats, in the browser preview ────────────────────────────────────────────────────────────
    // These mirror the real `TeamService` rules rather than stubbing them out, because the preview's only value is
    // that a person can see and use the screen without a Windows machine. The caps come from `previewSeatCaps`, which
    // the preview sets to no cap (null), exactly as a licence that names none.
    async getTeamSnapshot() {
      requireAdmin()
      return {
        seats: [...accounts.values()].map(({ user, passwordSetAt }) => ({
          id: user.id, seatNo: null, role: user.role === 'CASHIER' ? 'USER' as const : user.role,
          fullName: user.fullName, username: user.username, needsPassword: !passwordSetAt,
          isActive: user.isActive, isLocked: user.isLocked, lastLoginAt: null, lastPc: null,
          permissions: user.permissions,
        })),
        counts: (['ADMIN', 'SUPERVISOR', 'ACCOUNT', 'USER'] as const).map((role) => ({
          role,
          seats: [...accounts.values()].filter(({ user }) => user.role === role).length,
          activeAccounts: [...accounts.values()].filter(({ user }) => user.role === role && user.isActive).length,
          licenceCap: null,
        })),
        supervisorSeesCost: previewTeamSettings.supervisorSeesCost,
        singleLoginPerAccount: previewTeamSettings.singleLoginPerAccount,
        allowAdminOnClients: previewTeamSettings.allowAdminOnClients,
        orderExpiryMinutes: previewTeamSettings.orderExpiryMinutes,
      }
    },
    async setSeatCount(change) {
      requireAdmin()
      // The preview has no seat rows to grow; it reports the count it was asked for so the screen behaves, and says
      // plainly in its own message that seat creation is a desktop-host action.
      const snapshot = await this.getTeamSnapshot()
      const current = snapshot.counts.find((entry) => entry.role === change.role)!
      if (change.seats < current.activeAccounts) {
        throw new Error(`${current.activeAccounts} active ${change.role.toLowerCase()} account(s) use a seat. Deactivate one first.`)
      }
      previewSeatTargets[change.role] = change.seats
      return snapshot.counts.map((entry) => (entry.role === change.role ? { ...entry, seats: change.seats } : entry))
    },
    async renameSeat(userId, fullName) {
      requireAdmin()
      const entry = [...accounts.values()].find(({ user }) => user.id === userId)
      if (!entry) throw new Error('That seat no longer exists.')
      if (!fullName.trim()) throw new Error('Enter the name of the person using this seat.')
      entry.user.fullName = fullName.trim()
    },
    async setSeatPassword(userId, password, confirmPassword) {
      requireAdmin()
      validatePreviewPassword(password, confirmPassword)
      const entry = [...accounts.values()].find(({ user }) => user.id === userId)
      if (!entry) throw new Error('That seat no longer exists.')
      entry.passwordHash = await bcryptHash(password, 10)
      entry.user.isActive = true
      entry.passwordSetAt = Date.now()
    },
    async updateTeamSettings(input) { requireAdmin(); Object.assign(previewTeamSettings, input) },
    async setSeatActive(userId, isActive) {
      requireAdmin()
      const entry = [...accounts.values()].find(({ user }) => user.id === userId)
      if (!entry) throw new Error('That seat no longer exists.')
      entry.user.isActive = isActive
    },
    async setSeatPermissions(userId, permissions) {
      requireAdmin()
      const entry = [...accounts.values()].find(({ user }) => user.id === userId)
      if (!entry) throw new Error('That seat no longer exists.')
      if (entry.user.role === 'ADMIN') throw new Error('The Admin has no per-user limits.')
      entry.user.permissions = permissions
    },
    async getRoleSummary() {
      requireAdmin()
      // Kept short in the preview; the desktop host returns the full sentences from `TeamService.roleSummary()`.
      return [
        { role: 'ACCOUNT' as const, summary: 'Takes payment, prints documents, processes returns and reports the day.' },
        { role: 'USER' as const, summary: 'Picks goods and builds orders. Cannot print, take payment, process returns or see reports.' },
        { role: 'SUPERVISOR' as const, summary: 'Read-only audit and stock viewer.' },
        { role: 'ADMIN' as const, summary: 'Every function, including users and settings.' },
      ]
    },

    async createUser(input: CreateUserInput) {
      requireAdmin()
      validatePreviewPassword(input.password, input.confirmPassword)
      const username = normalizePreviewUsername(input.username)
      if ([...accounts.values()].some(({ user }) => user.username === username)) throw new Error('That username is already in use.')
      const passwordHash = await bcryptHash(input.password, 10)
      const user: PublicUser = {
        id: `preview-user-${++nextId}`,
        fullName: input.fullName.trim(), username, role: input.role,
        isActive: true, isLocked: false, permissions: { ...input.permissions },
      }
      accounts.set(user.id, { user, passwordHash, failedAttempts: 0 })
      return publicAccount(user)
    },
    async updateUser(id: string, input: UpdateUserInput) {
      requireAdmin()
      const account = accounts.get(id)
      if (!account) throw new Error('The selected user no longer exists.')
      account.user = { ...account.user, ...input, username: normalizePreviewUsername(input.username), permissions: { ...input.permissions } }
      return publicAccount(account.user)
    },
    async deactivateUser(id: string) {
      requireAdmin()
      const account = accounts.get(id)
      if (!account) throw new Error('The selected user no longer exists.')
      account.user.isActive = false
      if (currentUser?.id === id) currentUser = null
    },
    async resetPassword(id: string, password: string, confirmPassword: string) {
      requireAdmin()
      const account = accounts.get(id)
      if (!account) throw new Error('The selected user no longer exists.')
      validatePreviewPassword(password, confirmPassword)
      account.passwordHash = await bcryptHash(password, 10)
      account.user.isLocked = false
      account.failedAttempts = 0
    },
    async unlockUser(id: string) {
      requireAdmin()
      const account = accounts.get(id)
      if (!account) throw new Error('The selected user no longer exists.')
      account.user.isLocked = false
      account.failedAttempts = 0
      return publicAccount(account.user)
    },
    async getInventoryOverview(search = '') {
      const user = requireInventoryPage('products')
      const query = search.trim().toLowerCase()
      const products = inventoryProducts.filter((product) => !query || [product.name, product.sku, product.brand, product.barcode, ...product.additionalBarcodes]
        .some((value) => value.toLowerCase().includes(query)))
        .map((product) => inventoryProductView(user, product))
      return {
        edition,
        products,
        alerts: inventoryAlerts(),
        suppliers: [],
        categories: [...new Set(inventoryProducts.map((product) => product.category).filter(Boolean))].sort(),
        departments: [...new Set(inventoryProducts.map((product) => product.department).filter(Boolean))].sort(),
      } satisfies InventoryOverview
    },
    async saveProduct(draft: ProductDraft) {
      const user = requireInventoryAdmin('products')
      return savePreviewProduct(draft, user)
    },
    async importProductsCsv(contents: string) {
      const user = requireInventoryAdmin('products')
      if (typeof contents !== 'string' || new TextEncoder().encode(contents).length > 10_000_000) throw new Error('Choose a CSV file no larger than 10 MB.')
      return importPreviewRows(parsePreviewCsv(contents), user)
    },
    async importProductsExcel(contents: Uint8Array) {
      const { Workbook } = await import('exceljs')
      const user = requireInventoryAdmin('products')
      if (!(contents instanceof Uint8Array) || contents.byteLength === 0 || contents.byteLength > 10_000_000) throw new Error('Choose a valid Excel workbook no larger than 10 MB.')
      const workbook = new Workbook()
      try {
        const copy = new Uint8Array(contents.byteLength)
        copy.set(contents)
        await workbook.xlsx.load(copy.buffer)
      } catch {
        throw new Error('The Excel file could not be opened. Choose a valid .xlsx workbook.')
      }
      const worksheet = workbook.worksheets[0]
      if (!worksheet || worksheet.rowCount > 10_001 || worksheet.columnCount > 100) throw new Error('The Excel workbook is empty or exceeds the import limits.')
      const rows: string[][] = []
      for (let rowNumber = 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
        const row = worksheet.getRow(rowNumber)
        const values: string[] = []
        for (let column = 1; column <= worksheet.columnCount; column += 1) {
          const value = row.getCell(column).value
          if (value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value)) {
            throw new Error(`Formula cells are not allowed in product imports (row ${rowNumber}, column ${column}).`)
          }
          values.push(value === null || value === undefined ? '' : value instanceof Date ? value.toISOString().slice(0, 10)
            : typeof value === 'object' && 'text' in value ? String(value.text)
              : String(value))
        }
        rows.push(values)
      }
      return importPreviewRows(rows, user)
    },
    async exportProductsCsv() {
      const user = requireInventoryPage('products')
      return `\uFEFF${previewExportRows(user).map((row) => row.map(previewCsvCell).join(',')).join('\r\n')}`
    },
    async exportProductsExcel() {
      const { Workbook } = await import('exceljs')
      const user = requireInventoryPage('products')
      const workbook = new Workbook()
      const worksheet = workbook.addWorksheet('Products')
      worksheet.addRows(previewExportRows(user))
      worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
      worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3F73' } }
      worksheet.views = [{ state: 'frozen', ySplit: 1 }]
      const bytes = new Uint8Array(await workbook.xlsx.writeBuffer())
      let binary = ''
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)))
      }
      return btoa(binary)
    },
    async receiveStock(input: ReceiveStockInput) {
      const user = requireInventoryAdmin('stock')
      const product = findPreviewProduct(input.productId)
      if (product.rowVersion !== input.expectedProductVersion || product.stockVersion !== input.expectedStockVersion) throw new Error('This item changed. Reload before receiving stock.')
      if (input.quantityUnit !== 'unit' && input.quantityUnit !== 'pack') throw new Error('Choose units or packs for the received quantity.')
      const quantity = parsePreviewQuantity(input.quantity)
      if (quantity <= 0n) throw new Error('Received quantity must be greater than zero.')
      const quantityMilli = quantity * BigInt(input.quantityUnit === 'pack' ? product.packSizeUnits : 1)
      const unitCost = previewMoney(input.unitCost)
      if (unitCost < 0n) throw new Error('Unit cost cannot be negative.')
      updatePreviewStock(product, quantityMilli, input.batchNumber, input.expiryDate, unitCost)
      product.costMinor = unitCost
      product.rowVersion += 1
      const reference = `P-PREVIEW-${Date.now()}`
      return { product: inventoryProductView(user, product), reference, quantityDeltaMilli: quantityMilli } satisfies StockMutationResult
    },
    async adjustStock(input: StockAdjustmentInput) {
      const user = requireInventoryAdmin('stock')
      if (!input.reason.trim()) throw new Error('Enter a reason for the stock adjustment.')
      const product = findPreviewProduct(input.productId)
      if (product.rowVersion !== input.expectedProductVersion || product.stockVersion !== input.expectedStockVersion) throw new Error('This item’s stock changed. Reload before changing stock.')
      const quantity = parsePreviewQuantity(input.quantity)
      if (quantity <= 0n) throw new Error('Adjustment quantity must be greater than zero.')
      const delta = input.direction === 'increase' ? quantity : input.direction === 'decrease' ? -quantity : 0n
      if (delta === 0n) throw new Error('Choose whether stock is increasing or decreasing.')
      updatePreviewStock(product, delta, input.batchNumber, input.expiryDate, product.costMinor ?? 0n)
      return { product: inventoryProductView(user, product), reference: `ADJ-PREVIEW-${Date.now()}`, quantityDeltaMilli: delta } satisfies StockMutationResult
    },
    async recordStocktake(input: StocktakeInput) {
      const user = requireInventoryAdmin('stock')
      if (!input.reason.trim()) throw new Error('Enter a reason for the stocktake.')
      const product = findPreviewProduct(input.productId)
      if (product.rowVersion !== input.expectedProductVersion || product.stockVersion !== input.expectedStockVersion) throw new Error('This item’s stock changed. Reload before changing stock.')
      const counted = parsePreviewQuantity(input.countedQuantity)
      const variance = counted - product.quantityMilli
      if (counted < product.reservedMilli) throw new Error('Counted stock cannot be below the reserved quantity.')
      if (variance !== 0n) updatePreviewStock(product, variance, input.batchNumber, input.expiryDate, product.costMinor ?? 0n)
      const reference = `ST-PREVIEW-${Date.now()}`
      stocktakeReport.unshift({ productId: product.id, sku: product.sku, productName: product.name,
        expectedQuantityMilli: counted - variance, countedQuantityMilli: counted, varianceMilli: variance,
        reason: input.reason.trim(), actor: user.username, deviceName: 'BROWSER_PREVIEW', createdAt: new Date().toISOString() })
      return { product: inventoryProductView(user, product), reference, quantityDeltaMilli: variance, varianceMilli: variance } satisfies StockMutationResult
    },
    async getStocktakeVarianceReport() {
      requireInventoryPage('stock')
      return structuredClone(stocktakeReport)
    },
    async listPurchaseOrders() {
      requireInventoryAdmin('stock')
      if (edition === 'PHARMACY') throw new Error('Purchase orders are available only in the supermarket edition.')
      return structuredClone(purchaseOrders)
    },
    async createPurchaseOrder(_draft: PurchaseOrderDraft) {
      requireInventoryAdmin('stock')
      throw new Error('The browser preview does not persist supermarket purchase orders. Use the desktop host.')
    },
    async receivePurchaseOrder(_input: PurchaseOrderReceiptInput) {
      requireInventoryAdmin('stock')
      throw new Error('The browser preview does not persist supermarket goods-received notes. Use the desktop host.')
    },
    async getSellableBatches(productId: string) {
      requireInventoryPage('pos')
      const product = findPreviewProduct(productId)
      if (!(edition === 'PHARMACY' || product.expiryTracking)) return [{ batchId: null, batchNumber: null, expiryDate: null, quantityMilli: product.quantityMilli, unitCostMinor: product.costMinor ?? 0n }]
      return inventoryBatches.filter((batch) => batch.productId === productId && batch.quantityMilli > 0n && (batch.expiryDate ?? '') >= new Date().toISOString().slice(0, 10))
        .sort((a, b) => (a.expiryDate ?? '').localeCompare(b.expiryDate ?? ''))
        .map(({ productId: _productId, ...batch }) => structuredClone(batch))
    },
    async consumeStockFEFO(input: ConsumeStockInput) {
      const user = requireInventoryPage('pos')
      const product = findPreviewProduct(input.productId)
      if (product.rowVersion !== input.expectedProductVersion || product.stockVersion !== input.expectedStockVersion) throw new Error('This item’s stock changed. Reload before completing the sale.')
      const quantity = parsePreviewQuantity(input.quantity)
      if (quantity <= 0n) throw new Error('Sale quantity must be greater than zero.')
      const tracked = edition === 'PHARMACY' || product.expiryTracking
      const available = tracked
        ? inventoryBatches.filter((batch) => batch.productId === product.id && (batch.expiryDate ?? '') >= new Date().toISOString().slice(0, 10) && batch.quantityMilli > 0n)
          .sort((a, b) => (a.expiryDate ?? '').localeCompare(b.expiryDate ?? ''))
        : []
      const sellable = tracked ? available.reduce((sum, batch) => sum + batch.quantityMilli, 0n) : product.quantityMilli
      if (sellable < quantity) {
        if (product.quantityMilli >= quantity) throw new Error('Sale blocked: not enough unexpired batch stock is available.')
        throw new Error('There is not enough stock available to complete this sale.')
      }
      const allocations: FEFOSaleAllocation[] = []
      if (tracked) {
        let remaining = quantity
        for (const batch of available) {
          if (!remaining) break
          const take = batch.quantityMilli < remaining ? batch.quantityMilli : remaining
          batch.quantityMilli -= take
          remaining -= take
          allocations.push({ batchId: batch.batchId, batchNumber: batch.batchNumber, expiryDate: batch.expiryDate, quantityMilli: take })
        }
      } else allocations.push({ batchId: null, batchNumber: null, expiryDate: null, quantityMilli: quantity })
      product.quantityMilli -= quantity
      product.stockVersion += 1
      return { product: inventoryProductView(user, product), reference: input.reference, quantityDeltaMilli: -quantity, allocations } satisfies FEFOSaleResult
    },
    async getWeighedPrice(productId: string, weight: string) {
      requireInventoryPage('pos')
      const product = findPreviewProduct(productId)
      if (!product.weighedItem || product.pricePerKgMinor === null) throw new Error('This product is not configured as a weighed item.')
      const weightMilli = parsePreviewQuantity(weight)
      if (weightMilli <= 0n) throw new Error('Enter a weight greater than zero.')
      return { productId, weightMilli, priceMinor: roundHalfUp(product.pricePerKgMinor * weightMilli, 1000n), currencyCode: settings.currency.code } satisfies WeighedPriceResult
    },
    async listPosCustomers() {
      requireInventoryPage('pos')
      return structuredClone(previewCustomers)
    },
    async createPosCustomer(input: PosCustomerDraft) {
      requireAdmin()
      if (input.enrolLoyalty && edition === 'PHARMACY') throw new Error('Loyalty enrolment is available only in the supermarket edition.')
      const name = input.name.trim()
      if (!name) throw new Error('Enter the customer name.')
      const customer: PosCustomerRecord = {
        id: `preview-customer-${++nextId}`, name, phone: input.phone?.trim() ?? '', email: input.email?.trim() ?? '',
        address: input.address?.trim() ?? '', creditLimitMinor: previewMoney(input.creditLimit || '0'), balanceMinor: 0n,
        rowVersion: 1, loyaltyMemberId: input.enrolLoyalty ? `preview-member-${nextId}` : null,
        loyaltyMemberNumber: input.enrolLoyalty ? `LM-PREVIEW-${nextId}` : null, loyaltyPointsBalance: 0,
      }
      previewCustomers.unshift(customer)
      return structuredClone(customer)
    },
    async quotePosSale(input: PosQuoteInput) {
      const user = requireInventoryPage('pos')
      if (input.saleType === 'WHOLESALE' && user.role !== 'ADMIN' && !user.permissions.allowWholesale) throw new Error('Your account does not have permission to make wholesale sales.')
      const lines = input.items.map((item) => {
        const product = findPreviewProduct(item.productId)
        const quantityMilli = parsePreviewQuantity(item.quantity)
        const unitPrice = product.weighedItem && product.pricePerKgMinor !== null
          ? product.pricePerKgMinor : input.saleType === 'WHOLESALE' ? product.wholesalePriceMinor : product.retailPriceMinor
        const gross = roundHalfUp(unitPrice * quantityMilli, 1000n)
        const manualDiscount = previewMoney(item.manualDiscount ?? '0')
        return { product, quantityMilli, unitPrice, gross, manualDiscount }
      })
      const subtotalMinor = lines.reduce((sum, line) => sum + line.gross, 0n)
      const manualDiscountMinor = lines.reduce((sum, line) => sum + line.manualDiscount, 0n)
      const limit = subtotalMinor * BigInt(user.role === 'ADMIN' ? 10_000 : user.permissions.maxDiscountBasisPoints) / 10_000n
      if (manualDiscountMinor > limit) throw new Error('The manual discount exceeds your permission limit.')
      const customer = input.customerId ? previewCustomers.find((candidate) => candidate.id === input.customerId) : undefined
      const warnings = lines.filter((line) => line.product.prescriptionRequired).map((line) => `Prescription required: ${line.product.name}`)
      return {
        saleType: input.saleType, currencyCode: settings.currency.code,
        items: lines.map((line) => ({
          productId: line.product.id, sku: line.product.sku, description: line.product.name, unit: line.product.unit,
          quantityMilli: line.quantityMilli, priceTier: input.saleType, unitPriceMinor: line.unitPrice,
          grossTotalMinor: line.gross, manualDiscountMinor: line.manualDiscount, promotionDiscountMinor: 0n,
          loyaltyDiscountMinor: 0n, lineTotalMinor: line.gross - line.manualDiscount,
          prescriptionRequired: line.product.prescriptionRequired,
        })),
        subtotalMinor, promotionName: '', promotionDiscountMinor: 0n, manualDiscountMinor, loyaltyDiscountMinor: 0n,
        loyaltyPointsToRedeem: input.loyaltyPointsToRedeem ?? 0, loyaltyPointsEarned: 0,
        totalMinor: subtotalMinor - manualDiscountMinor,
        creditBalanceMinor: customer?.balanceMinor ?? 0n, creditLimitMinor: customer?.creditLimitMinor ?? 0n, warnings,
      } satisfies PosQuoteRecord
    },
    async completePosSale(input: CompletePosSaleInput) {
      const user = requireInventoryPage('pos')
      const existingId = previewIdempotency.get(input.idempotencyKey)
      if (existingId) {
        const previous = previewReceipts.get(existingId)
        if (previous) return { receipt: structuredClone(previous), idempotentReplay: true }
      }
      if (input.saleType === 'WHOLESALE' && user.role !== 'ADMIN' && !user.permissions.allowWholesale) throw new Error('Your account does not have permission to make wholesale sales.')
      const customer = input.customerId ? previewCustomers.find((candidate) => candidate.id === input.customerId) : undefined
      if (input.customerId && !customer) throw new Error('The selected customer is unavailable.')
      const lines = input.items.map((item) => {
        const product = findPreviewProduct(item.productId)
        const quantityMilli = parsePreviewQuantity(item.quantity)
        if (quantityMilli <= 0n || product.quantityMilli - product.reservedMilli < quantityMilli) throw new Error(`There is not enough stock available for ${product.name}.`)
        if (input.saleType === 'WHOLESALE' && product.wholesaleMinimumQuantityMilli > quantityMilli) throw new Error(`${product.name} does not meet the wholesale minimum.`)
        const unitPrice = product.weighedItem && product.pricePerKgMinor !== null
          ? product.pricePerKgMinor
          : input.saleType === 'WHOLESALE' ? product.wholesalePriceMinor : product.retailPriceMinor
        const gross = roundHalfUp(unitPrice * quantityMilli, 1000n)
        const discount = previewMoney(item.manualDiscount ?? '0')
        return { product, quantityMilli, unitPrice, gross, discount, lineTotal: gross - discount }
      })
      const subtotal = lines.reduce((sum, line) => sum + line.gross, 0n)
      const manualDiscount = lines.reduce((sum, line) => sum + line.discount, 0n)
      const maximum = subtotal * BigInt(user.role === 'ADMIN' ? 10_000 : user.permissions.maxDiscountBasisPoints) / 10_000n
      if (manualDiscount > maximum || lines.some((line) => line.discount > line.gross)) throw new Error('The manual discount exceeds your permission limit.')
      const total = subtotal - manualDiscount
      let nonCash = 0n
      let cashTendered = 0n
      for (const payment of input.payments) {
        if (payment.method === 'TRANSFER' || payment.method === 'CARD') nonCash += previewMoney(payment.amount)
        if (payment.method === 'CASH') cashTendered += previewMoney(payment.amount)
      }
      if (nonCash > total) throw new Error('Payments cannot exceed the sale total.')
      const cashApplied = cashTendered < total - nonCash ? cashTendered : total - nonCash
      const credit = total - nonCash - cashApplied
      if (credit > 0n) {
        if (!input.payments.some((payment) => payment.method === 'CREDIT')) throw new Error('The sale is underpaid; add an authorised Credit payment.')
        if (user.role !== 'ADMIN' && !user.permissions.allowCreditSales) throw new Error('Your account does not have permission to make credit sales.')
        if (!customer || customer.creditLimitMinor <= 0n || customer.balanceMinor + credit > customer.creditLimitMinor) throw new Error('This sale would exceed the customer’s credit limit.')
      }
      if (lines.some((line) => line.product.prescriptionRequired) && !input.prescriptionAcknowledged) throw new Error('Prescription confirmation is required before selling this item.')
      const batchAllocations: Array<Array<{ batchId: string; batchNumber: string; expiryDate: string; quantityMilli: bigint }>> = []
      const plannedBatchRemaining = new Map<string, bigint>()
      for (const line of lines) {
        const allocations: Array<{ batchId: string; batchNumber: string; expiryDate: string; quantityMilli: bigint }> = []
        if (edition === 'PHARMACY' || line.product.expiryTracking) {
          const batches = inventoryBatches.filter((batch) => batch.productId === line.product.id && (batch.expiryDate ?? '') >= new Date().toISOString().slice(0, 10))
            .sort((a, b) => (a.expiryDate ?? '').localeCompare(b.expiryDate ?? ''))
          const sellable = batches.reduce((sum, batch) => sum + (plannedBatchRemaining.get(batch.batchId ?? '') ?? batch.quantityMilli), 0n)
          if (sellable < line.quantityMilli) throw new Error(`There is not enough unexpired batch stock for ${line.product.name}.`)
          let remaining = line.quantityMilli
          for (const batch of batches) {
            if (remaining === 0n) break
            const available = plannedBatchRemaining.get(batch.batchId ?? '') ?? batch.quantityMilli
            if (available <= 0n) continue
            const take = available < remaining ? available : remaining
            remaining -= take
            if (typeof batch.batchId !== 'string' || !batch.batchNumber || !batch.expiryDate) throw new Error(`The preview could not save the original batch allocation for ${line.product.name}.`)
            plannedBatchRemaining.set(batch.batchId, available - take)
            allocations.push({ batchId: batch.batchId, batchNumber: batch.batchNumber, expiryDate: batch.expiryDate, quantityMilli: take })
          }
        }
        batchAllocations.push(allocations)
      }
      const saleId = previewReceipts.size + 1
      const receiptNumber = `R-PREVIEW-${String(saleId).padStart(6, '0')}`
      const items = lines.map((line, index) => ({
        id: `preview-sale-item-${saleId}-${index}`, productId: line.product.id, sku: line.product.sku,
        description: line.product.name, unit: line.product.unit, quantityMilli: line.quantityMilli,
        priceTier: input.saleType, unitPriceMinor: line.unitPrice, grossTotalMinor: line.gross,
        manualDiscountMinor: line.discount, promotionDiscountMinor: 0n, loyaltyDiscountMinor: 0n,
        discountMinor: line.discount, taxMinor: 0n, lineTotalMinor: line.lineTotal,
        prescriptionRequired: line.product.prescriptionRequired,
        batches: (batchAllocations[index] ?? []).map((batch) => ({ ...batch })),
      }))
      const remaining = total - nonCash
      const cashChange = cashTendered > remaining ? cashTendered - remaining : 0n
      const payments = input.payments.filter((payment) => payment.method !== 'CREDIT').map((payment, index) => {
        const tendered = previewMoney(payment.amount)
        const applied = payment.method === 'CASH' ? (tendered < remaining ? tendered : remaining) : tendered
        return { id: `preview-payment-${saleId}-${index}`, method: payment.method, amountMinor: applied, tenderedMinor: tendered, changeMinor: payment.method === 'CASH' ? cashChange : 0n, currencyCode: settings.currency.code, reference: payment.reference ?? '' }
      })
      const receipt: PosReceiptRecord = {
        id: saleId, receiptNumber, status: 'COMPLETED', saleType: input.saleType, createdAt: new Date().toISOString(),
        currency: structuredClone(settings.currency), display: structuredClone(settings.display),
        store: structuredClone(settings.profile),
        customer: customer ? { id: customer.id, name: customer.name, phone: customer.phone, email: customer.email, address: customer.address } : null,
        cashier: user.fullName, workstation: 'BROWSER_PREVIEW', items, payments,
        subtotalMinor: subtotal, promotionDiscountMinor: 0n, promotionName: '', manualDiscountMinor: manualDiscount,
        loyaltyDiscountMinor: 0n, loyaltyPointsEarned: 0, loyaltyPointsRedeemed: 0,
        discountMinor: manualDiscount, taxMinor: 0n, totalMinor: total, paidMinor: total - credit,
        creditMinor: credit, tenderedMinor: nonCash + cashTendered, changeMinor: cashChange,
        prescriptionAcknowledged: Boolean(input.prescriptionAcknowledged), warnings: [], duplicate: false, printCount: 0,
      }
      for (const allocation of batchAllocations.flat()) {
        const batch = inventoryBatches.find((candidate) => candidate.batchId === allocation.batchId)
        if (!batch || batch.quantityMilli < allocation.quantityMilli) throw new Error('The preview batch quantity changed while completing the sale.')
        batch.quantityMilli -= allocation.quantityMilli
      }
      for (const line of lines) {
        line.product.quantityMilli -= line.quantityMilli
        line.product.stockVersion += 1
      }
      if (customer && credit > 0n) customer.balanceMinor += credit
      previewReceipts.set(saleId, receipt)
      previewIdempotency.set(input.idempotencyKey, saleId)
      settings.currencyLocked = true
      return { receipt: structuredClone(receipt), idempotentReplay: false }
    },
    async listRecentPosSales() {
      requireInventoryPage('pos')
      return [...previewReceipts.values()].sort((a, b) => b.id - a.id).map((receipt) => ({
        id: receipt.id, receiptNumber: receipt.receiptNumber, saleType: receipt.saleType, createdAt: receipt.createdAt,
        customerName: receipt.customer?.name ?? '', cashier: receipt.cashier, totalMinor: receipt.totalMinor,
        currencyCode: receipt.currency.code, currency: structuredClone(receipt.currency), display: structuredClone(receipt.display),
        duplicate: receipt.printCount > 1, printCount: receipt.printCount,
      })) satisfies PosRecentSaleRecord[]
    },
    async getPosReceipt(saleId: string | number) {
      requireInventoryPage('pos')
      const receipt = previewReceipts.get(Number(saleId))
      if (!receipt) throw new Error('The preview receipt could not be found.')
      return structuredClone({ ...receipt, duplicate: receipt.printCount > 1 })
    },
    async recordPosReceiptPrint(saleId: string | number, layout: ReceiptLayout, reason?: string) {
      const user = requireInventoryPage('pos')
      // The gate's role rule, restated here because the preview has no gate: a USER or SUPERVISOR gets no printer.
      if (user.role !== 'ADMIN' && user.role !== 'ACCOUNT' && user.role !== 'CASHIER') {
        throw new Error(`A ${user.role.toLowerCase()} account cannot print documents.`)
      }
      if (!['THERMAL_80', 'THERMAL_58', 'A4_RECEIPT', 'A4_INVOICE'].includes(layout)) throw new Error('Choose a valid receipt or invoice layout.')
      const receipt = previewReceipts.get(Number(saleId))
      if (!receipt) throw new Error('The preview receipt could not be found.')
      if (!receipt.store.name.trim()) throw new Error('Printing is blocked because this sale has no saved store name. Update store details in Settings.')
      const duplicate = receipt.printCount > 0
      if (duplicate && !(reason ?? '').trim()) throw new Error('Give a reason for printing this document again. It is recorded beside the copy.')
      const next = { ...receipt, printCount: receipt.printCount + 1, duplicate }
      previewReceipts.set(receipt.id, next)
      return structuredClone(next)
    },

    // ── the order-to-receipt workflow ──────────────────────────────────────────────────────────────────────
    async createOrder(input: CreateOrderInput): Promise<OrderView> {
      const user = requireInventoryPage('pos')
      requireOrderRole(user, 'build_order', 'create an order')
      if (!input.items.length) throw new Error('Add at least one item before generating the order.')
      const quote = await bridge.quotePosSale({
        saleType: input.saleType, items: input.items, customerId: input.customerId ?? null,
        loyaltyPointsToRedeem: input.loyaltyPointsToRedeem,
      })
      const now = Date.now()
      sweepPreviewOrders(now)
      if (input.idempotencyKey) {
        const existing = previewOrders.find((row) => row.createdById === user.id && row.orderNumber.includes(input.idempotencyKey!))
        if (existing) return previewOrderView(existing)
      }
      // Reserving here is the point of an order: without it two pickers could promise the same last unit.
      for (const line of quote.items) {
        const product = findPreviewProduct(line.productId)
        if (product.quantityMilli - product.reservedMilli < line.quantityMilli) {
          throw new Error(`There is not enough available stock of ${product.name} to reserve for this order.`)
        }
      }
      for (const line of quote.items) findPreviewProduct(line.productId).reservedMilli += line.quantityMilli

      previewOrderSequence += 1
      const row: PreviewOrderRow = {
        id: `preview-order-${previewOrderSequence}`,
        orderNumber: `ORD-${String(previewOrderSequence).padStart(6, '0')}`,
        type: input.saleType,
        status: 'PENDING',
        customerId: input.customerId ?? null,
        createdById: user.id,
        createdByName: user.fullName || user.username,
        finalizedByName: null,
        currencyCode: quote.currencyCode,
        subtotalMinor: quote.subtotalMinor,
        discountMinor: quote.manualDiscountMinor + quote.promotionDiscountMinor + quote.loyaltyDiscountMinor,
        totalMinor: quote.totalMinor,
        lines: quote.items.map((line: (typeof quote.items)[number], index: number) => ({
          id: `preview-order-${previewOrderSequence}-line-${index}`,
          productId: line.productId, description: line.description, unit: line.unit,
          quantityMilli: line.quantityMilli, unitPriceMinor: line.unitPriceMinor,
          discountMinor: line.manualDiscountMinor + line.promotionDiscountMinor + line.loyaltyDiscountMinor,
          lineTotalMinor: line.lineTotalMinor, prescriptionRequired: line.prescriptionRequired,
        })),
        expiresAt: new Date(now + PREVIEW_ORDER_EXPIRY_MINUTES * 60_000).toISOString(),
        createdAt: new Date(now).toISOString(),
        saleId: null,
        receiptNumber: null,
        events: [{
          event: 'order.created', fromStatus: null, toStatus: 'PENDING', actorName: user.fullName || user.username,
          detail: `${quote.items.length} line(s) reserved.`, createdAt: new Date(now).toISOString(),
        }],
      }
      previewOrders.unshift(row)
      return previewOrderView(row)
    },

    async listOrderQueue(): Promise<OrderView[]> {
      const user = requireInventoryPage('pos')
      requireOrderRole(user, 'take_payment', 'see the order queue')
      sweepPreviewOrders(Date.now())
      return previewOrders.filter((row) => row.status === 'PENDING')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(previewOrderView)
    },

    async listMyOrders(): Promise<OrderView[]> {
      const user = requireInventoryPage('pos')
      requireOrderRole(user, 'see_own_orders', 'see your orders')
      sweepPreviewOrders(Date.now())
      const role = user.role === 'CASHIER' ? 'USER' : user.role
      const rows = can(role, 'take_payment') ? previewOrders : previewOrders.filter((row) => row.createdById === user.id)
      return rows.map(previewOrderView)
    },

    async getOrder(orderId: string): Promise<OrderView> {
      const user = requireInventoryPage('pos')
      const row = previewOrders.find((candidate) => candidate.id === orderId)
      if (!row) throw new Error('That order could not be found.')
      const role = user.role === 'CASHIER' ? 'USER' : user.role
      if (!can(role, 'take_payment') && row.createdById !== user.id) throw new Error('That order belongs to another picker.')
      return previewOrderView(row)
    },

    async adjustOrderLine(orderId: string, itemId: string, quantity: string): Promise<OrderView> {
      const user = requireInventoryPage('pos')
      requireOrderRole(user, 'take_payment', 'adjust an order')
      const row = previewOrders.find((candidate) => candidate.id === orderId)
      if (!row) throw new Error('That order could not be found.')
      if (row.status !== 'PENDING') throw new Error(`That order is ${row.status.toLowerCase()} and can no longer be changed.`)
      const line = row.lines.find((candidate) => candidate.id === itemId)
      if (!line) throw new Error('That line is not on this order.')
      const next = parsePreviewQuantity(quantity)
      const delta = next - line.quantityMilli
      const product = findPreviewProduct(line.productId)
      if (delta > 0n && product.quantityMilli - product.reservedMilli < delta) {
        throw new Error(`There is not enough available stock of ${product.name} to reserve for this order.`)
      }
      product.reservedMilli += delta
      const was = line.quantityMilli
      line.quantityMilli = next
      line.lineTotalMinor = roundHalfUp(line.unitPriceMinor * next, 1000n) - line.discountMinor
      row.totalMinor = row.lines.reduce((sum, candidate) => sum + candidate.lineTotalMinor, 0n)
      row.events.push({
        event: 'order.line_adjusted', fromStatus: row.status, toStatus: row.status,
        actorName: user.fullName || user.username,
        detail: `${line.description}: quantity ${was} → ${next} milli-units.`, createdAt: new Date().toISOString(),
      })
      return previewOrderView(row)
    },

    async cancelOrder(orderId: string, reason: string): Promise<OrderView> {
      const user = requireInventoryPage('pos')
      if (!reason.trim()) throw new Error('Give a reason for cancelling. It is recorded on the audit trail.')
      const row = previewOrders.find((candidate) => candidate.id === orderId)
      if (!row) throw new Error('That order could not be found.')
      if (row.status === 'PAID') throw new Error('That order is paid. Process a return instead — a completed sale cannot be cancelled.')
      if (row.status !== 'PENDING') throw new Error(`That order is already ${row.status.toLowerCase()}.`)
      const role = user.role === 'CASHIER' ? 'USER' : user.role
      if (!can(role, 'take_payment') && row.createdById !== user.id) throw new Error('That order belongs to another picker.')
      for (const line of row.lines) findPreviewProduct(line.productId).reservedMilli -= line.quantityMilli
      row.status = 'CANCELLED'
      row.events.push({
        event: 'order.cancelled', fromStatus: 'PENDING', toStatus: 'CANCELLED',
        actorName: user.fullName || user.username, detail: reason.trim(), createdAt: new Date().toISOString(),
      })
      return previewOrderView(row)
    },

    async finalizeOrder(orderId: string, input: FinalizeOrderInput): Promise<FinalizeOrderResult> {
      const user = requireInventoryPage('pos')
      requireOrderRole(user, 'take_payment', 'finalize an order and take payment')
      if (!input.idempotencyKey || input.idempotencyKey.length < 8) {
        throw new Error('A finalize needs an idempotency key, so a double-click cannot create two sales.')
      }
      const row = previewOrders.find((candidate) => candidate.id === orderId)
      if (!row) throw new Error('That order could not be found.')
      sweepPreviewOrders(Date.now())
      if (row.status === 'PAID' && row.saleId !== null) {
        return {
          order: previewOrderView(row), saleId: row.saleId, receiptNumber: row.receiptNumber ?? '',
          idempotentReplay: true, priceChangesAccepted: [],
        }
      }
      if (row.status !== 'PENDING') {
        throw new Error(row.status === 'PAID'
          ? `Order ${row.orderNumber} was already completed by another account.`
          : `Order ${row.orderNumber} is ${row.status.toLowerCase()} and cannot be finalized.`)
      }
      // The prices are re-checked against the products as they are now, and the Account has to accept a difference.
      const changes = row.lines.map((line) => {
        const product = findPreviewProduct(line.productId)
        const now = row.type === 'WHOLESALE' ? product.wholesalePriceMinor : product.retailPriceMinor
        return now === line.unitPriceMinor ? null : {
          productId: line.productId, description: line.description, wasMinor: line.unitPriceMinor, nowMinor: now,
        }
      }).filter((change): change is NonNullable<typeof change> => change !== null)
      if (changes.length > 0 && !input.acceptPriceChange) {
        throw new Error('Prices changed since this order was created. Show the difference to the Account and finalize again with the change accepted.')
      }
      // Release before deducting, exactly as the real service does: the sale measures availability as
      // quantity − reserved, so an order's own hold would otherwise block its own payment.
      for (const line of row.lines) findPreviewProduct(line.productId).reservedMilli -= line.quantityMilli
      try {
        const completed = await bridge.completePosSale({
          idempotencyKey: input.idempotencyKey,
          saleType: row.type,
          items: row.lines.map((line) => ({ productId: line.productId, quantity: String(line.quantityMilli / 1000n) })),
          payments: input.payments as never,
          customerId: input.customerId ?? row.customerId,
          loyaltyPointsToRedeem: input.loyaltyPointsToRedeem,
          prescriptionAcknowledged: input.prescriptionAcknowledged,
        })
        row.status = 'PAID'
        row.saleId = Number(completed.receipt.id)
        row.receiptNumber = completed.receipt.receiptNumber
        row.finalizedByName = user.fullName || user.username
        row.events.push({
          event: 'order.finalized', fromStatus: 'PENDING', toStatus: 'PAID',
          actorName: user.fullName || user.username,
          detail: `Receipt ${completed.receipt.receiptNumber}.`, createdAt: new Date().toISOString(),
        })
        return {
          order: previewOrderView(row), saleId: row.saleId, receiptNumber: row.receiptNumber ?? completed.receipt.receiptNumber,
          idempotentReplay: completed.idempotentReplay, priceChangesAccepted: changes,
        }
      } catch (error) {
        // The sale failed, so the hold goes back: stock that is neither held nor sold could be promised twice.
        for (const line of row.lines) findPreviewProduct(line.productId).reservedMilli += line.quantityMilli
        throw error
      }
    },

    async listPrintLog(limit = 200): Promise<PrintLogEntry[]> {
      const user = requireInventoryPage('pos')
      const role = user.role === 'CASHIER' ? 'USER' : user.role
      if (!can(role, 'view_audit') && !can(role, 'print_documents')) throw new Error('Your role cannot read the print log.')
      // Rebuilt from the preview's receipts, which carry the copy count the desktop print_log would hold.
      return [...previewReceipts.values()]
        .flatMap((receipt) => Array.from({ length: receipt.printCount }, (_unused, index) => ({
          id: receipt.id * 100 + index,
          kind: 'SALE' as const,
          documentId: String(receipt.id),
          copyNumber: index + 1,
          duplicate: index > 0,
          receiptNumber: receipt.receiptNumber,
          printedBy: user.username,
          printedByName: user.fullName || user.username,
          workstation: 'BROWSER_PREVIEW',
          reprintReason: '',
          printedAt: receipt.createdAt,
        })))
        .sort((a, b) => b.printedAt.localeCompare(a.printedAt))
        .slice(0, Math.max(1, limit))
    },
    async holdPosCart(data: HeldPosCartData) {
      requireInventoryPage('pos')
      const now = new Date().toISOString()
      const held = { id: `preview-hold-${++nextId}`, saleType: data.saleType, data: structuredClone(data), createdAt: now, updatedAt: now }
      heldPosCarts.unshift(held)
      return structuredClone(held)
    },
    async listHeldPosCarts() {
      requireInventoryPage('pos')
      return structuredClone(heldPosCarts)
    },
    async recallHeldPosCart(id: string) {
      requireInventoryPage('pos')
      const held = heldPosCarts.find((cart) => cart.id === id)
      if (!held) throw new Error('This held cart is unavailable.')
      return structuredClone(held)
    },
    async discardHeldPosCart(id: string) {
      requireInventoryPage('pos')
      const index = heldPosCarts.findIndex((cart) => cart.id === id)
      if (index < 0) throw new Error('This held cart is unavailable.')
      heldPosCarts.splice(index, 1)
    },
    async findSaleForReturn(receiptNumber: string): Promise<ReturnSaleRecord> {
      requireReturnPage()
      const normalized = receiptNumber.trim().toUpperCase()
      const sale = [...previewReceipts.values()].find((candidate) => candidate.receiptNumber.toUpperCase() === normalized)
      if (!sale) throw new Error('A completed sale with that receipt number could not be found.')
      const days = settings.returnWindowDays ?? 7
      const saleTime = Date.parse(sale.createdAt)
      const deadline = saleTime + days * 86_400_000
      const now = Date.now()
      const items: ReturnSaleItemRecord[] = sale.items.map((item) => {
        const returned = previewReturns.filter((record) => record.saleId === sale.id && record.status !== 'REJECTED')
          .flatMap((record) => record.items).filter((line) => line.saleItemId === item.id)
          .reduce((sum, line) => sum + line.quantityMilli, 0n)
        return {
          saleItemId: item.id, productId: item.productId, sku: item.sku, description: item.description, unit: item.unit,
          quantityMilli: item.quantityMilli, returnedQuantityMilli: returned,
          returnableQuantityMilli: item.quantityMilli > returned ? item.quantityMilli - returned : 0n,
          unitPriceMinor: item.unitPriceMinor, grossTotalMinor: item.grossTotalMinor,
          manualDiscountMinor: item.manualDiscountMinor, promotionDiscountMinor: item.promotionDiscountMinor,
          loyaltyDiscountMinor: item.loyaltyDiscountMinor, lineTotalMinor: item.lineTotalMinor,
          expiryTracked: edition === 'PHARMACY' || inventoryProducts.find((product) => product.id === item.productId)?.expiryTracking === true,
          batches: item.batches.map((batch) => ({ ...batch })),
        }
      })
      return {
        saleId: sale.id, receiptNumber: sale.receiptNumber, createdAt: sale.createdAt, cashier: sale.cashier,
        currency: structuredClone(sale.currency), display: structuredClone(sale.display), store: structuredClone(sale.store),
        customer: sale.customer ? { ...sale.customer } : null, totalMinor: sale.totalMinor,
        promotionDiscountMinor: sale.promotionDiscountMinor, loyaltyDiscountMinor: sale.loyaltyDiscountMinor,
        loyaltyPointsEarned: sale.loyaltyPointsEarned, loyaltyPointsRedeemed: sale.loyaltyPointsRedeemed,
        items, returnWindowDays: days, withinReturnWindow: now >= saleTime && now <= deadline,
        remainingWindowMilliseconds: Math.max(0, deadline - now),
      }
    },
    async createReturn(input: RequestReturnInput): Promise<ReturnRecord> {
      const user = requireReturnPage()
      if (!input || !Array.isArray(input.items) || input.items.length === 0) throw new Error('Select at least one item from the receipt.')
      const sale = [...previewReceipts.values()].find((candidate) => candidate.receiptNumber.toUpperCase() === input.receiptNumber.trim().toUpperCase())
      if (!sale) throw new Error('A completed sale with that receipt number could not be found.')
      const days = settings.returnWindowDays ?? 7
      const saleTime = Date.parse(sale.createdAt)
      const withinWindow = Date.now() >= saleTime && Date.now() <= saleTime + days * 86_400_000
      const override = input.overrideReturnWindow === true
      if (!withinWindow && !override) throw new Error(`This sale is outside the ${days}-day return window. An Admin must record an override.`)
      if (override && user.role !== 'ADMIN') throw new Error('Only an Admin can override the return window.')
      if (override && !input.windowOverrideReason?.trim()) throw new Error('Enter the reason for the Admin return-window override.')
      if (!['WRONG_ITEM', 'DAMAGED', 'EXPIRED', 'CUSTOMER_CHANGED_MIND', 'OTHER'].includes(input.reason)) throw new Error('Choose a valid return reason.')
      if (!['REFUND', 'STORE_CREDIT', 'EXCHANGE'].includes(input.type)) throw new Error('Choose Refund, Store credit, or Exchange.')
      if (input.reason === 'OTHER' && !input.reasonNote?.trim()) throw new Error('Add a short note when the reason is Other.')
      const priorReturns = previewReturns.filter((record) => record.saleId === sale.id && record.status !== 'REJECTED')
      const returnedBySaleItem = (saleItemId: string) => priorReturns.flatMap((record) => record.items).filter((item) => item.saleItemId === saleItemId)
      const outputItems: ReturnRecord['items'] = []
      let total = 0n
      for (const requestLine of input.items) {
        const saleLine = sale.items.find((item) => item.id === requestLine.saleItemId)
        if (!saleLine) throw new Error('A selected item does not belong to this receipt.')
        const quantity = parsePreviewQuantity(requestLine.quantity)
        const previous = returnedBySaleItem(saleLine.id)
        const priorQuantity = previous.reduce((sum, item) => sum + item.quantityMilli, 0n)
        if (quantity <= 0n || priorQuantity + quantity > saleLine.quantityMilli) throw new Error(`The requested quantity of ${saleLine.description} exceeds the remaining sold quantity.`)
        if (!['RESELLABLE', 'OPENED', 'EXPIRED', 'DAMAGED', 'OTHER_NON_RESELLABLE'].includes(requestLine.condition)) throw new Error('Choose a valid returned-item condition.')
        const condition: ReturnItemCondition = input.reason === 'EXPIRED' ? 'EXPIRED'
          : input.reason === 'DAMAGED' ? 'DAMAGED' : requestLine.condition
        const lineTotal = proportionalPreview(saleLine.lineTotalMinor, priorQuantity, quantity, saleLine.quantityMilli)
        const gross = proportionalPreview(saleLine.grossTotalMinor, priorQuantity, quantity, saleLine.quantityMilli)
        const manual = proportionalPreview(saleLine.manualDiscountMinor, priorQuantity, quantity, saleLine.quantityMilli)
        const promo = proportionalPreview(saleLine.promotionDiscountMinor, priorQuantity, quantity, saleLine.quantityMilli)
        const loyalty = proportionalPreview(saleLine.loyaltyDiscountMinor, priorQuantity, quantity, saleLine.quantityMilli)
        const stockDisposition: ReturnRecord['items'][number]['stockDisposition'] = condition === 'RESELLABLE' && saleLine.productId ? 'RESTOCKED'
          : saleLine.productId ? 'WRITTEN_OFF' : 'NO_STOCK'
        const writeoffReason = stockDisposition !== 'WRITTEN_OFF' ? ''
          : condition === 'OPENED' ? 'Opened item; not returned to sellable stock.'
            : condition === 'EXPIRED' ? 'Expired item; not returned to sellable stock.'
              : condition === 'DAMAGED' ? 'Damaged item; written off.' : 'Non-resellable item; written off.'
        const sourceBatch = saleLine.batches[0]
        const expiryTracked = edition === 'PHARMACY' || inventoryProducts.find((product) => product.id === saleLine.productId)?.expiryTracking === true
        if (expiryTracked && condition === 'RESELLABLE' && !sourceBatch) {
          throw new Error('The browser preview has no saved original Pharmacy batch for this item. Use the desktop host for this return.')
        }
        outputItems.push({
          id: `preview-return-item-${previewReturns.length + 1}-${outputItems.length + 1}`,
          saleItemId: saleLine.id, productId: saleLine.productId, sku: saleLine.sku,
          description: saleLine.description, unit: saleLine.unit, quantityMilli: quantity, condition,
          stockDisposition, writeoffReason, sourceBatchId: sourceBatch?.batchId ?? null,
          sourceBatchNumber: sourceBatch?.batchNumber ?? '', sourceExpiryDate: sourceBatch?.expiryDate ?? '',
          grossAmountMinor: gross, manualDiscountMinor: manual, promotionDiscountMinor: promo,
          loyaltyDiscountMinor: loyalty, lineTotalMinor: lineTotal,
        })
        total += lineTotal
      }
      const id = previewReturns.length + 1
      const status: ReturnRecord['status'] = total > user.permissions.returnLimitMinor ? 'PENDING' : 'COMPLETED'
      let credit: ReturnRecord['credit'] = null
      const createdAt = new Date().toISOString()
      const record: ReturnRecord = {
        id, returnNumber: `C-PREVIEW-${String(id).padStart(6, '0')}`, saleId: sale.id, receiptNumber: sale.receiptNumber,
        status, reason: input.reason, reasonNote: input.reasonNote?.trim() ?? '', type: input.type,
        refundMethod: input.type === 'REFUND' ? (input.refundMethod ?? 'CASH') : null,
        paymentReference: input.type === 'REFUND' ? input.paymentReference?.trim() ?? '' : '', createdAt,
        cashierId: user.id, cashier: user.fullName, approverId: null, approvedBy: '', approvedAt: null,
        approvalChannel: null, approvalRequestId: status === 'PENDING' ? `preview-approval-${id}` : null,
        returnWindowDays: days, returnWindowOverride: override,
        returnWindowOverrideReason: override ? input.windowOverrideReason?.trim() ?? '' : '',
        currency: structuredClone(sale.currency), display: structuredClone(sale.display), store: structuredClone(sale.store),
        customer: sale.customer ? { ...sale.customer } : null, subtotalMinor: total, totalMinor: total,
        promotionAmountReversedMinor: outputItems.reduce((sum, item) => sum + item.promotionDiscountMinor, 0n),
        loyaltyDiscountReversedMinor: outputItems.reduce((sum, item) => sum + item.loyaltyDiscountMinor, 0n),
        loyaltyPointsReversed: 0, loyaltyPointsRestored: 0, items: outputItems, credit,
        duplicate: false, printCount: 0,
      }
      if (status === 'COMPLETED') {
        for (const item of outputItems) {
          if (item.stockDisposition === 'RESTOCKED' && item.productId) {
            const product = findPreviewProduct(item.productId)
            product.quantityMilli += item.quantityMilli
            product.stockVersion += 1
            if (item.sourceBatchId) {
              const batch = inventoryBatches.find((candidate) => candidate.batchId === item.sourceBatchId)
              if (batch) batch.quantityMilli += item.quantityMilli
            }
          }
        }
        if (input.type !== 'REFUND' && total > 0n) {
          credit = {
            creditNumber: `SC-PREVIEW-${String(id).padStart(6, '0')}`, type: input.type,
            amountMinor: total, remainingMinor: total, customerId: sale.customer?.id ?? null, createdAt,
          }
          record.credit = credit
        }
        settings.currencyLocked = true
      }
      previewReturns.unshift(record)
      return structuredClone(record)
    },
    async listReturns() {
      requireReturnPage()
      return structuredClone(previewReturns.slice(0, 100))
    },
    async getReturnDocument(returnId: string | number) {
      requireReturnPage()
      const record = previewReturns.find((candidate) => candidate.id === Number(returnId))
      if (!record) throw new Error('The preview return document could not be found.')
      return structuredClone(record)
    },
    async resolveReturnApproval(returnId: string | number, decision: ReturnApprovalDecision): Promise<ResolveReturnApprovalResult> {
      const user = requireReturnPage()
      if (user.role !== 'ADMIN' && user.role !== 'SUPERVISOR') throw new Error('Only an Admin or Supervisor can approve this return.')
      const index = previewReturns.findIndex((candidate) => candidate.id === Number(returnId))
      const record = previewReturns[index]
      if (!record || record.status !== 'PENDING') throw new Error('This return is no longer awaiting approval.')
      if (record.cashierId === user.id) throw new Error('A user cannot approve their own return request.')
      if (decision !== 'APPROVE' && decision !== 'REJECT') throw new Error('Choose approve or reject.')
      let next: ReturnRecord = { ...record, status: decision === 'APPROVE' ? 'COMPLETED' : 'REJECTED' }
      if (decision === 'APPROVE') {
        for (const item of record.items) {
          if (item.stockDisposition === 'RESTOCKED' && item.productId) {
            const product = findPreviewProduct(item.productId)
            product.quantityMilli += item.quantityMilli
            product.stockVersion += 1
            const batch = item.sourceBatchId ? inventoryBatches.find((candidate) => candidate.batchId === item.sourceBatchId) : undefined
            if (batch) batch.quantityMilli += item.quantityMilli
          }
        }
        const credit = record.type !== 'REFUND' && record.totalMinor > 0n ? {
          creditNumber: `SC-PREVIEW-${String(record.id).padStart(6, '0')}`, type: record.type,
          amountMinor: record.totalMinor, remainingMinor: record.totalMinor, customerId: record.customer?.id ?? null,
          createdAt: new Date().toISOString(),
        } : null
        next = { ...next, approvedBy: user.fullName, approverId: user.id, approvedAt: new Date().toISOString(), approvalChannel: 'DESKTOP', credit }
        settings.currencyLocked = true
      }
      previewReturns[index] = next
      return { decision, returnRecord: structuredClone(next) }
    },
    async recordReturnPrint(returnId: string | number, layout: ReturnDocumentLayout) {
      requireReturnPage()
      if (!['THERMAL_80', 'THERMAL_58', 'A4_RECEIPT', 'A4_INVOICE'].includes(layout)) throw new Error('Choose a supported return or credit-note layout.')
      const index = previewReturns.findIndex((candidate) => candidate.id === Number(returnId))
      const record = previewReturns[index]
      if (!record || record.status !== 'COMPLETED') throw new Error('Only a completed return can be printed.')
      const duplicate = record.printCount > 0
      const next = { ...record, printCount: record.printCount + 1, duplicate }
      previewReturns[index] = next
      return structuredClone(next)
    },
    async getAccountingReport(input: ReportPeriodInput) {
      const user = getActiveUser()
      if (!canAccessPageForRole(user, 'reports', edition)) throw new Error('You do not have permission to open Reports.')
      return buildPreviewAccountingReport(input, user, settings, edition, previewShifts, previewDayCloses, previewCustomers)
    },
    async exportReportCsv(input: ReportExportInput) {
      const user = getActiveUser()
      if (input.section !== 'summary' && user.role !== 'ADMIN') throw new Error('Detailed reports are restricted to the Admin.')
      if (input.section !== 'summary') throw new Error('Detailed exports are available from the licensed desktop host, not this memory-only preview.')
      const report = buildPreviewAccountingReport(input, user, settings, edition, previewShifts, previewDayCloses, previewCustomers)
      return previewReportCsv(report)
    },
    async exportReportExcel() {
      throw new Error('Excel export is available from the licensed desktop host, not this memory-only preview.')
    },
    async exportReportPdf() {
      throw new Error('PDF export is available from the licensed desktop host, not this memory-only preview.')
    },
    async closeReportingDay(input: CloseDayInput): Promise<DayCloseRecord> {
      const user = requireAdmin()
      const report = buildPreviewAccountingReport({ period: 'DAY', date: input.businessDate }, user, settings, edition, previewShifts, previewDayCloses, previewCustomers)
      if (!report.cashPosition) throw new Error('Choose a business date for the cash close.')
      const countedCashMinor = previewMoney(input.countedCash)
      if (countedCashMinor < 0n) throw new Error('Counted cash cannot be negative.')
      const existing = previewDayCloses.get(`${input.businessDate}:${settings.currency.code}`)
      if (existing) throw new Error('A cash close has already been saved for this business date.')
      const closeNumber = `DC-PREVIEW-${String(++nextPreviewCloseId).padStart(4, '0')}`
      const saved: DayCloseRecord = {
        id: nextPreviewCloseId,
        closeNumber,
        businessDate: input.businessDate,
        openedAt: `${input.businessDate}T00:00:00.000Z`,
        closedAt: new Date().toISOString(),
        closedBy: user.fullName,
        currencyCode: settings.currency.code,
        salesTotalMinor: report.summary.totalSalesMinor,
        returnsTotalMinor: report.summary.returnsMinor,
        expectedCashMinor: report.cashPosition.expectedCashMinor,
        countedCashMinor,
        varianceMinor: countedCashMinor - report.cashPosition.expectedCashMinor,
        note: input.note?.trim() ?? '',
        storeName: settings.profile.name,
        storeAddress: settings.profile.address,
      }
      previewDayCloses.set(`${input.businessDate}:${settings.currency.code}`, saved)
      return structuredClone(saved)
    },
    async openCashierShift(input: OpenCashierShiftInput): Promise<CashierShiftReportRow> {
      const user = getActiveUser()
      if (edition === 'PHARMACY') throw new Error('Cashier shifts are available only in a Supermarket edition.')
      if (previewShifts.some((shift) => shift.status === 'OPEN' && shift.cashierId === user.id)) throw new Error('You already have an open cashier shift.')
      const openingFloatMinor = previewMoney(input.openingFloat)
      if (openingFloatMinor < 0n) throw new Error('Opening float cannot be negative.')
      const shift: CashierShiftReportRow = {
        id: `PREVIEW-SHIFT-${Date.now()}-${previewShifts.length + 1}`,
        cashierId: user.id,
        cashierName: user.fullName,
        openedAt: new Date().toISOString(),
        closedAt: null,
        status: 'OPEN',
        currencyCode: settings.currency.code,
        openingFloatMinor,
        cashSalesMinor: 0n,
        cashRefundsMinor: 0n,
        drawerAdjustmentsMinor: 0n,
        // No debts are collected in the preview; the field is here so the shape matches the real Server's.
        debtorCashMinor: 0n,
        expectedCashMinor: openingFloatMinor,
        countedCashMinor: null,
        varianceMinor: null,
        closedBy: '',
        closeNote: '',
      }
      previewShifts.unshift(shift)
      return structuredClone(shift)
    },
    async closeCashierShift(input: CloseCashierShiftInput): Promise<CashierShiftReportRow> {
      const user = getActiveUser()
      const index = previewShifts.findIndex((shift) => shift.id === input.shiftId && shift.status === 'OPEN')
      const existing = previewShifts[index]
      if (!existing) throw new Error('This cashier shift is no longer open.')
      if (user.role !== 'ADMIN' && existing.cashierId !== user.id) throw new Error('You can close only your own cashier shift.')
      const countedCashMinor = previewMoney(input.countedCash)
      if (countedCashMinor < 0n) throw new Error('Counted cash cannot be negative.')
      const closed: CashierShiftReportRow = {
        ...existing,
        status: 'CLOSED',
        closedAt: new Date().toISOString(),
        countedCashMinor,
        varianceMinor: countedCashMinor - existing.expectedCashMinor,
        closedBy: user.fullName,
        closeNote: input.note?.trim() ?? '',
      }
      previewShifts[index] = closed
      return structuredClone(closed)
    },
    async recordCashDrawerEvent(input: CashDrawerEventInput): Promise<void> {
      const user = getActiveUser()
      const index = previewShifts.findIndex((shift) => shift.id === input.shiftId && shift.status === 'OPEN')
      const existing = previewShifts[index]
      if (!existing) throw new Error('Drawer events can be recorded only on an open shift.')
      if (user.role !== 'ADMIN' && existing.cashierId !== user.id) throw new Error('You can record events only on your own cashier shift.')
      const amount = previewMoney(input.amount)
      if (amount <= 0n) throw new Error('Drawer event amount must be greater than zero.')
      if (!input.note.trim()) throw new Error('Enter a drawer event note.')
      const delta = drawerAdjustmentSigned(input.type, amount)
      previewShifts[index] = {
        ...existing,
        drawerAdjustmentsMinor: existing.drawerAdjustmentsMinor + delta,
        expectedCashMinor: existing.expectedCashMinor + delta,
      }
    },
    async recordDebtorPayment(input: RecordDebtorPaymentInput): Promise<AuditDebtorPaymentRow> {
      const user = getActiveUser()
      if (!canAccessPageForRole(user, 'customers', edition)) {
        throw new Error('You do not have permission to take a payment against a customer balance.')
      }
      const amountMinor = previewMoney(input.amount)
      return previewAudit.recordDebtorPayment({
        customerId: input.customerId,
        amountMinor,
        method: input.method,
        reference: input.reference,
        note: input.note,
      }, user)
    },

    async getDayAudit(input: DayAuditInput): Promise<DailyAuditReport> {
      const user = getActiveUser()
      if (!canAccessPageForRole(user, 'audit', edition)) throw new Error('You do not have permission to audit the day.')
      return previewAudit.getDayAudit(input, user)
    },
    async listAuditDayStatuses(): Promise<AuditDayStatus[]> {
      const user = getActiveUser()
      if (!canAccessPageForRole(user, 'audit', edition)) throw new Error('You do not have permission to audit the day.')
      return previewAudit.dayStatuses(user)
    },
    async listUnauditedDays(days?: number): Promise<UnauditedDay[]> {
      const user = getActiveUser()
      if (!canAccessPageForRole(user, 'audit', edition)) throw new Error('You do not have permission to audit the day.')
      void days
      return previewAudit.listUnauditedDays(user)
    },
    async getAuditSummary(): Promise<AuditSummaryForPhone> {
      const user = getActiveUser()
      if (!canAccessPageForRole(user, 'audit', edition)) throw new Error('You do not have permission to audit the day.')
      return previewAudit.summaryForPhone(user)
    },
    async signOffAuditDay(input: SignOffDayInput): Promise<AuditSignOffRow> {
      const user = getActiveUser()
      if (!canAccessPageForRole(user, 'audit', edition)) throw new Error('You do not have permission to audit the day.')
      return previewAudit.signOffDay(input, user)
    },
    async noteAuditFinding(input: AuditNoteFindingInput): Promise<AuditFlagRow> {
      const user = getActiveUser()
      if (!canAccessPageForRole(user, 'audit', edition)) throw new Error('You do not have permission to audit the day.')
      return previewAudit.noteFinding(input, user)
    },
    async raiseAuditFlag(input: RaiseAuditFlagInput): Promise<AuditFlagRow> {
      const user = getActiveUser()
      if (!canAccessPageForRole(user, 'audit', edition)) throw new Error('You do not have permission to audit the day.')
      return previewAudit.raiseFlag(input, user)
    },
    async addAuditFlagNote(input: AuditFlagNoteInput): Promise<AuditFlagRow> {
      const user = getActiveUser()
      if (!canAccessPageForRole(user, 'audit', edition)) throw new Error('You do not have permission to audit the day.')
      return previewAudit.addFlagNote(input.flagId, input.detail, user)
    },
    async resolveAuditFlag(input: ResolveAuditFlagInput): Promise<AuditFlagRow> {
      const user = getActiveUser()
      if (!canAccessPageForRole(user, 'audit', edition)) throw new Error('You do not have permission to audit the day.')
      return previewAudit.resolveFlag(input.flagId, input.resolutionNote, user)
    },
    async exportAudit(input: AuditExportInput): Promise<AuditExportResult> {
      const user = getActiveUser()
      if (!canAccessPageForRole(user, 'audit', edition)) throw new Error('You do not have permission to audit the day.')
      if (!can(resolveRole(user.role) ?? 'USER', 'export_audit')) {
        throw new Error('Your role may read the audit but not export it.')
      }
      // Built from the very report the caller was shown, which is the property that matters: an export is not a second
      // opinion about the day. The encoding is the browser's own, since the file never leaves this tab.
      const report = previewAudit.getDayAudit(input, user)
      // The same writer the licensed host uses, so the file a reviewer downloads from the demo is byte-for-byte the
      // shape the shop's own export has.
      const csv = createAuditCsv(report)
      const bytes = new TextEncoder().encode(csv)
      let binary = ''
      for (const byte of bytes) binary += String.fromCharCode(byte)
      if (input.format === 'EXCEL') {
        throw new Error('Excel export is available from the licensed desktop host, not this memory-only preview.')
      }
      return {
        format: 'CSV',
        contentBase64: btoa(binary),
        fileName: `daily-audit-${report.businessDate}.csv`,
        mimeType: 'text/csv;charset=utf-8',
        storeName: report.header.storeName,
        currencyCode: report.currencyCode,
      }
    },

    async updateStoreDetails(profile) {
      requireAdmin()
      settings = { ...settings, profile: normalizeShopProfile(profile) }
      return structuredClone(settings)
    },
    async updateDisplaySettings(display) {
      requireAdmin()
      validateMoneyDisplay(display)
      settings = { ...settings, display: { ...display } }
      return structuredClone(settings)
    },
    async changeCurrency(currency, confirmed) {
      requireAdmin()
      if (settings.currencyLocked) {
        throw new Error(settings.currencyLockedByVendor ? VENDOR_CURRENCY_LOCK_MESSAGE : TRANSACTION_CURRENCY_LOCK_MESSAGE)
      }
      if (!confirmed) throw new Error('Confirm the shop currency before saving it.')
      const nextCurrency = currency.kind === 'custom' ? createCustomCurrency(currency) : getCurrency(currency.code)
      if (!nextCurrency) throw new Error('Choose a supported currency.')
      settings = { ...settings, currency: nextCurrency, display: defaultDisplayOptions(nextCurrency), currencyConfirmed: true }
      return structuredClone(settings)
    },
    async updateIdleTimeout(minutes) {
      requireAdmin()
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) throw new Error('Idle timeout must be between 1 and 240 minutes.')
      settings = { ...settings, idleTimeoutMinutes: minutes }
      return structuredClone(settings)
    },
    async updateReturnWindowDays(days) {
      requireAdmin()
      if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('The return window must be a whole number from 1 to 365 days.')
      settings = { ...settings, returnWindowDays: days }
      return structuredClone(settings)
    },
    async updateOperationalSettings(input) {
      requireAdmin()
      settings = { ...settings, operational: normalizeOperationalSettings(input) }
      return structuredClone(settings)
    },
    // The browser preview has no disk access; these answer honestly rather than pretending to back up.
    async getBackupStatus() {
      requireAdmin()
      return {
        automaticEnabled: false,
        lastBackupAt: null,
        lastBackupFile: null,
        automaticFolder: '',
        daysSinceBackup: null,
        stale: true,
        warning: 'Backups run in the installed desktop app, not in this browser preview.',
        recent: [],
      }
    },
    async createManualBackup() {
      requireAdmin()
      throw new Error('Backups run in the installed desktop app, not in this browser preview.')
    },
    async listBackupFiles() {
      requireAdmin()
      return []
    },
    async restoreBackup() {
      requireAdmin()
      throw new Error('Restoring runs in the installed desktop app, not in this browser preview.')
    },
    async chooseBackupFolder() {
      requireAdmin()
      return null
    },
    async getDemoDataStatus() {
      requireAdmin()
      return {
        loaded: false, products: 0, users: 0, demoUsers: [], inUse: false, inUseReason: null,
        currency: settings.currency.code,
      }
    },
    async loadDemoData() {
      requireAdmin()
      throw new Error('The demonstration catalogue is available in the installed desktop app, not this browser preview.')
    },
    async removeDemoData() {
      requireAdmin()
      throw new Error('The demonstration catalogue is available in the installed desktop app, not this browser preview.')
    },
  }
  return bridge
}

function buildPreviewAccountingReport(
  input: ReportPeriodInput,
  viewer: PublicUser,
  settings: ShopSettings,
  edition: Edition,
  allShifts: CashierShiftReportRow[],
  dayCloses: Map<string, DayCloseRecord>,
  customers: PosCustomerRecord[],
): AccountingReport {
  if (!input || (input.period !== 'DAY' && input.period !== 'MONTH')) throw new Error('Choose a daily or monthly report period.')
  const datePattern = input.period === 'DAY' ? /^(\d{4})-(\d{2})-(\d{2})$/u : /^(\d{4})-(\d{2})$/u
  const parts = datePattern.exec(input.date)
  if (!parts) throw new Error('Choose a valid report date.')
  const year = Number(parts[1])
  const month = Number(parts[2])
  const day = input.period === 'DAY' ? Number(parts[3]) : 1
  const dateValue = new Date(Date.UTC(year, month - 1, day))
  if (dateValue.getUTCFullYear() !== year || dateValue.getUTCMonth() + 1 !== month || dateValue.getUTCDate() !== day) {
    throw new Error('Choose a valid report date.')
  }
  const pad = (value: number) => String(value).padStart(2, '0')
  const startDate = `${year}-${pad(month)}-${input.period === 'DAY' ? pad(day) : '01'}`
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const endDate = input.period === 'DAY' ? startDate : `${year}-${pad(month)}-${pad(daysInMonth)}`
  const dates = input.period === 'DAY'
    ? [startDate]
    : Array.from({ length: daysInMonth }, (_, index) => `${year}-${pad(month)}-${pad(index + 1)}`)
  const isAdmin = viewer.role === 'ADMIN'
  const zero = 0n
  const visibleShifts = edition !== 'PHARMACY'
    ? allShifts.filter((shift) => (isAdmin || shift.cashierId === viewer.id)
      && (shift.status === 'OPEN' || (shift.openedAt.slice(0, 10) >= startDate && shift.openedAt.slice(0, 10) <= endDate)
        || Boolean(shift.closedAt && shift.closedAt.slice(0, 10) >= startDate && shift.closedAt.slice(0, 10) <= endDate)))
    : []
  const selectedClose = input.period === 'DAY' && isAdmin
    ? dayCloses.get(`${startDate}:${settings.currency.code}`) ?? null
    : null
  let openingFloatMinor = zero
  let cashSalesMinor = zero
  let cashRefundsMinor = zero
  let drawerAdjustmentsMinor = zero
  if (input.period === 'DAY') {
    for (const shift of allShifts.filter((entry) => (isAdmin || entry.cashierId === viewer.id) && entry.openedAt.slice(0, 10) === startDate)) {
      openingFloatMinor += shift.openingFloatMinor
      cashSalesMinor += shift.cashSalesMinor
      cashRefundsMinor += shift.cashRefundsMinor
      drawerAdjustmentsMinor += shift.drawerAdjustmentsMinor
    }
  }
  const daily = dates.map((date) => ({
    date, totalSalesMinor: zero, transactions: 0, retailSalesMinor: zero, retailTransactions: 0,
    wholesaleSalesMinor: zero, wholesaleTransactions: 0, discountsMinor: zero, returnsMinor: zero,
    refundsMinor: zero, netSalesMinor: zero, cogsMinor: isAdmin ? zero : null, grossProfitMinor: isAdmin ? zero : null,
  }))
  // The same rule the Server applies - a positive balance, largest first, name as the tie-break - read from the
  // preview's own customer list rather than invented, so a credit sale made in the demo shows up here and a payment
  // taken against it moves the balance the way it would in the shop.
  const debtorItems = customers
    .filter((customer) => customer.balanceMinor > 0n)
    .sort((left, right) => right.balanceMinor === left.balanceMinor
      ? left.name.localeCompare(right.name)
      : right.balanceMinor > left.balanceMinor ? 1 : -1)
    .map((customer): DebtorReportRow => ({
      customerId: customer.id,
      customerName: customer.name,
      phone: customer.phone,
      balanceMinor: customer.balanceMinor,
      creditLimitMinor: customer.creditLimitMinor,
    }))
  const adminReports = isAdmin ? {
    topSellers: [], slowMovers: [], valuation: { totalQuantityMilli: zero, totalValueMinor: zero, items: [] },
    lowStock: [],
    purchases: { totalMinor: zero, transactions: 0, items: [], bySupplier: [] },
    userPerformance: [], auditLog: [], stocktakes: [],
    pharmacy: edition === 'SUPERMARKET' ? null : { expiryLots: [], prescriptionSales: [], writeOffs: [] },
    supermarket: edition === 'PHARMACY' ? null : {
      departments: [], promotions: [], loyalty: { transactions: 0, pointsRedeemed: zero, discountsMinor: zero },
    },
  } : null
  const label = input.period === 'DAY'
    ? startDate
    : new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  return {
    header: {
      storeName: settings.profile.name, storeAddress: settings.profile.address,
      currency: settings.currency, display: settings.display,
      period: { type: input.period, startDate, endDate, label },
      generatedAt: new Date().toISOString(), scope: isAdmin ? 'STORE' : 'PERSONAL',
      viewerName: viewer.fullName, edition,
    },
    summary: {
      grossSalesMinor: zero, totalSalesMinor: zero, transactions: 0,
      retail: { totalMinor: zero, transactions: 0 }, wholesale: { totalMinor: zero, transactions: 0 },
      discountsMinor: zero, returnsMinor: zero, refundsMinor: zero, netSalesMinor: zero,
      cogsMinor: isAdmin ? zero : null, grossProfitMinor: isAdmin ? zero : null, returnTransactions: 0,
    },
    daily,
    paymentMethods: (['CASH', 'TRANSFER', 'CARD', 'CREDIT'] as const).map((method) => ({ method, totalMinor: zero, transactions: 0 })),
    refundMethods: (['CASH', 'TRANSFER', 'CARD', 'STORE_CREDIT', 'EXCHANGE_CREDIT'] as const).map((method) => ({ method, totalMinor: zero, transactions: 0 })),
    salesByUser: [{
      userId: viewer.id, userName: viewer.fullName, username: viewer.username, transactions: 0,
      retailSalesMinor: zero, wholesaleSalesMinor: zero, totalSalesMinor: zero, discountsMinor: zero,
      returnsMinor: zero, netSalesMinor: zero, cogsMinor: isAdmin ? zero : null, grossProfitMinor: isAdmin ? zero : null,
    }],
    cashPosition: input.period === 'DAY' ? {
      businessDate: startDate, currencyCode: settings.currency.code, openingFloatMinor, cashSalesMinor,
      cashRefundsMinor, drawerAdjustmentsMinor,
      // The preview has no debtor payments to collect, but the expectation is still the shared formula rather than a
      // fourth spelling of the same sum: a preview that adds the numbers up its own way is a preview that can show a
      // drawer total the real Server would never produce.
      debtorCashMinor: zero,
      expectedCashMinor: expectedDrawerCash({
        openingFloatMinor, cashSalesMinor, cashRefundsMinor, drawerAdjustmentsMinor, debtorCashMinor: zero,
      }),
    } : null,
    dayClose: selectedClose,
    shifts: visibleShifts,
    debtors: {
      totalBalanceMinor: debtorItems.reduce((sum, row) => sum + row.balanceMinor, 0n),
      items: debtorItems,
    },
    adminReports,
  }
}

function previewReportCsv(report: AccountingReport): string {
  const rows: string[][] = [
    ['Store', report.header.storeName],
    ['Address', report.header.storeAddress],
    ['Period', report.header.period.label],
    ['Currency', report.header.currency.code],
    ['Total sales', formatMoney(report.summary.totalSalesMinor, report.header.currency, report.header.display)],
    ['Transactions', String(report.summary.transactions)],
    ['Discounts', formatMoney(report.summary.discountsMinor, report.header.currency, report.header.display)],
    ['Returns', formatMoney(report.summary.returnsMinor, report.header.currency, report.header.display)],
    ['Net sales', formatMoney(report.summary.netSalesMinor, report.header.currency, report.header.display)],
  ]
  return `\uFEFF${rows.map((row) => row.map(previewCsvCell).join(',')).join('\r\n')}`
}

function proportionalPreview(total: bigint, alreadyReturned: bigint, quantity: bigint, sold: bigint): bigint {
  if (sold <= 0n || alreadyReturned + quantity > sold) throw new Error('The requested return quantity exceeds the quantity sold.')
  const previousTarget = alreadyReturned === 0n ? 0n : alreadyReturned === sold ? total : roundHalfUp(total * alreadyReturned, sold)
  const nextQuantity = alreadyReturned + quantity
  const nextTarget = nextQuantity === sold ? total : roundHalfUp(total * nextQuantity, sold)
  return nextTarget - previousTarget
}

function parsePreviewCsv(input: string): string[][] {
  const text = input.replace(/^\uFEFF/u, '')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { cell += '"'; index += 1 }
      else if (character === '"') quoted = false
      else cell += character
    } else if (character === '"' && cell.length === 0) quoted = true
    else if (character === ',') { row.push(cell); cell = '' }
    else if (character === '\n') { row.push(cell.replace(/\r$/u, '')); rows.push(row); row = []; cell = '' }
    else cell += character
  }
  if (quoted) throw new Error('The CSV contains an unclosed quoted field.')
  if (cell.length || row.length) { row.push(cell.replace(/\r$/u, '')); rows.push(row) }
  return rows.filter((line) => line.some((value) => value.trim()))
}

function previewCsvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value
  return `"${safe.replace(/"/gu, '""')}"`
}

function previewBoolean(value: string | undefined): boolean {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false
  throw new Error(`“${value}” is not a valid true/false value.`)
}

function formatPreviewQuantity(value: bigint): string {
  const whole = value / 1000n
  const fraction = (value % 1000n).toString().padStart(3, '0').replace(/0+$/u, '')
  return `${whole}${fraction ? `.${fraction}` : ''}`
}
