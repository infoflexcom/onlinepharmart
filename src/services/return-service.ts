import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getCurrency, type CurrencyDefinition } from '../currency/catalog'
import { roundHalfUp } from '../currency/money'
import type { Edition } from '../editions'
import type { UserRole } from '../shared/auth/types'
import type { ShopProfile, ShopSettings } from '../shared/shop/types'
import type {
  RequestReturnInput,
  ReturnApprovalChannel,
  ReturnApprovalDecision,
  ReturnDocumentLayout,
  ReturnItemCondition,
  ReturnPaymentMethod,
  ReturnRecord,
  ReturnSaleItemRecord,
  ReturnSaleRecord,
  ReturnType as ReturnKind,
  ReturnReason,
  ReturnStatus,
  ReturnStockDisposition,
  ResolveReturnApprovalResult,
} from '../shared/returns/types'
import type { ShopRepository } from './contracts/shop-repository'

const MAX_SQLITE_INTEGER = 9_223_372_036_854_775_807n
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER)
const MAX_RETURN_LINES = 100
const RETURN_REASONS: readonly ReturnReason[] = ['WRONG_ITEM', 'DAMAGED', 'EXPIRED', 'CUSTOMER_CHANGED_MIND', 'OTHER']
const RETURN_TYPES: readonly ReturnKind[] = ['REFUND', 'STORE_CREDIT', 'EXCHANGE']
const ITEM_CONDITIONS: readonly ReturnItemCondition[] = ['RESELLABLE', 'OPENED', 'EXPIRED', 'DAMAGED', 'OTHER_NON_RESELLABLE']

export interface ReturnActor {
  id: string
  username: string
  role: UserRole
  fullName?: string
}

export interface ReturnServiceOptions {
  workstation?: string
  now?: () => number
  newId?: () => string
}

interface AuthorizedActor extends ReturnActor {
  fullName: string
  returnLimitMinor: bigint
}

interface SaleHeaderRow {
  id: number
  receipt_number: string
  status: string
  created_at: string
  cashier_id: string | null
  cashier_name_snapshot: string
  currency_code: string
  subtotal_text: string
  discount_text: string
  total_text: string
  store_name: string
  store_address: string
  store_phone: string
  store_email: string
  store_licence_number: string
  store_tax_number: string
  store_logo: string | null
  store_receipt_footer: string
  store_thank_you_note: string
  customer_id: string | null
  customer_name_snapshot: string
  customer_phone_snapshot: string
  customer_email_snapshot: string
  customer_address_snapshot: string
  currency_name_snapshot: string
  currency_symbol_snapshot: string
  currency_decimals_snapshot: number
  currency_is_custom_snapshot: number
  display_mode_snapshot: 'symbol' | 'code'
  symbol_position_snapshot: 'before' | 'after'
  thousand_sep_snapshot: string
  decimal_sep_snapshot: string
  promotion_discount_text: string
  loyalty_discount_text: string
  loyalty_member_id: string | null
  loyalty_points_earned: number
  loyalty_points_redeemed: number
  legacy_currency_name: string
  legacy_currency_symbol: string
  legacy_currency_decimals: number
  legacy_currency_custom: number
  legacy_currency_position: 'before' | 'after'
  legacy_thousand_sep: string
  legacy_decimal_sep: string
}

interface SaleItemRow {
  id: string
  sale_id: number
  product_id: string | null
  description_snapshot: string
  quantity_text: string
  unit_price_text: string
  gross_total_text: string
  manual_discount_text: string
  promotion_discount_text: string
  loyalty_discount_text: string
  line_total_text: string
  product_sku_snapshot: string
  unit_snapshot: string
  expiry_tracking_snapshot: number
  current_sku: string | null
  current_expiry_tracking: number | null
  current_generic_name: string | null
  current_prescription_required: number | null
}

interface SaleBatchRow {
  batch_id: string
  batch_number_snapshot: string
  expiry_date_snapshot: string
  quantity_text: string
}

interface ReturnLineInsert {
  id: string
  saleItem: SaleItemRow
  quantityMilli: bigint
  condition: ReturnItemCondition
  expiryTracked: boolean
  sourceBatchId: string | null
  sourceBatchNumber: string
  sourceExpiryDate: string
  amounts: AmountParts
}

interface AmountParts {
  gross: bigint
  manualDiscount: bigint
  promotionDiscount: bigint
  loyaltyDiscount: bigint
  lineTotal: bigint
}

interface CompletedAllocationState {
  quantity: bigint
  amounts: AmountParts
}

interface PendingReturnItemRow {
  id: string
  sale_item_id: string
  product_id: string | null
  quantity_text: string
  item_condition: ReturnItemCondition
  expiry_tracking_snapshot: number
  source_batch_id: string | null
  source_batch_number_snapshot: string
  source_expiry_date_snapshot: string
}

interface ReturnHeaderRow {
  id: number
  return_number: string
  sale_id: number
  cashier_id: string | null
  approved_by: string | null
  status: ReturnStatus
  currency_code: string
  subtotal_text: string
  total_text: string
  store_name: string
  store_address: string
  store_phone: string
  created_at: string
  reason: ReturnReason
  return_type: ReturnKind
  refund_method: ReturnPaymentMethod | null
  payment_reference: string
  reason_note: string
  original_receipt_number: string
  cashier_name_snapshot: string
  approved_name_snapshot: string
  approved_at: string | null
  approval_channel: ReturnApprovalChannel | null
  approval_request_id: string | null
  return_window_days_snapshot: number
  return_window_override: number
  return_window_override_reason: string
  store_email: string
  store_licence_number: string
  store_tax_number: string
  store_logo: string | null
  store_receipt_footer: string
  store_thank_you_note: string
  currency_name_snapshot: string
  currency_symbol_snapshot: string
  currency_decimals_snapshot: number
  currency_is_custom_snapshot: number
  display_mode_snapshot: 'symbol' | 'code'
  symbol_position_snapshot: 'before' | 'after'
  thousand_sep_snapshot: string
  decimal_sep_snapshot: string
  customer_id: string | null
  customer_name_snapshot: string
  customer_phone_snapshot: string
  customer_email_snapshot: string
  customer_address_snapshot: string
  promotion_amount_reversed_text: string
  loyalty_discount_reversed_text: string
  loyalty_points_reversed: number
  loyalty_points_restored: number
  legacy_currency_name: string
  legacy_currency_symbol: string
  legacy_currency_decimals: number
  legacy_currency_custom: number
  legacy_currency_position: 'before' | 'after'
  legacy_thousand_sep: string
  legacy_decimal_sep: string
}

interface ReturnItemRow {
  id: string
  sale_item_id: string
  product_id: string | null
  description_snapshot: string
  quantity_text: string
  unit_price_text: string
  line_total_text: string
  gross_amount_text: string
  manual_discount_text: string
  promotion_discount_text: string
  loyalty_discount_text: string
  item_condition: ReturnItemCondition
  stock_disposition: ReturnStockDisposition
  writeoff_reason: string
  source_batch_id: string | null
  source_batch_number_snapshot: string
  source_expiry_date_snapshot: string
  sku_snapshot: string
  unit_snapshot: string
}

interface CreditRow {
  credit_number: string
  credit_type: 'STORE_CREDIT' | 'EXCHANGE'
  amount_text: string
  remaining_text: string
  customer_id: string | null
  created_at: string
}

export class ReturnService {
  private readonly workstation: string
  private readonly now: () => number
  private readonly newId: () => string

  constructor(
    private readonly database: Database.Database,
    private readonly shop: ShopRepository,
    options: ReturnServiceOptions = {},
  ) {
    this.workstation = cleanText(options.workstation ?? 'LOCAL_DESKTOP', 120) || 'LOCAL_DESKTOP'
    this.now = options.now ?? Date.now
    this.newId = options.newId ?? randomUUID
  }

  findSaleForReturn(receiptNumber: string, actor: ReturnActor, edition: Edition): ReturnSaleRecord {
    this.authorizeActor(actor)
    validateEdition(edition)
    const normalizedReceipt = normalizeReceiptNumber(receiptNumber)
    const sale = this.querySaleByReceipt(normalizedReceipt)
    if (!sale || sale.status !== 'COMPLETED') throw new Error('A completed sale with that receipt number could not be found.')
    return this.mapReturnableSale(sale, edition)
  }

  createReturn(input: RequestReturnInput, actor: ReturnActor, edition: Edition): ReturnRecord {
    const authorized = this.authorizeActor(actor)
    validateEdition(edition)
    const normalized = normalizeRequest(input)
    const requestHash = hashRequest(normalized)
    let returnId = 0

    this.database.transaction(() => {
      if (normalized.idempotencyKey) {
        const existing = this.database.prepare(`
          SELECT id, request_hash, cashier_id FROM returns WHERE idempotency_key = ?
        `).get(normalized.idempotencyKey) as { id: number; request_hash: string; cashier_id: string | null } | undefined
        if (existing) {
          if (existing.cashier_id !== authorized.id || existing.request_hash !== requestHash) {
            throw new Error('This return key was already used for a different request. Refresh the receipt and try again.')
          }
          returnId = existing.id
          return
        }
      }

      const sale = this.querySaleByReceipt(normalized.receiptNumber)
      if (!sale || sale.status !== 'COMPLETED') throw new Error('A completed sale with that receipt number could not be found.')
      const settings = this.shop.readSettings()
      const returnWindowDays = settings.returnWindowDays ?? 7
      const saleTime = Date.parse(sale.created_at)
      if (!Number.isFinite(saleTime)) throw new Error('This receipt has an invalid saved transaction date; contact an Admin.')
      const windowDeadline = saleTime + returnWindowDays * 86_400_000
      const withinWindow = this.now() >= saleTime && this.now() <= windowDeadline
      if (!withinWindow && !normalized.overrideReturnWindow) {
        throw new Error(`This sale is outside the ${returnWindowDays}-day return window. An Admin must record a return-window override.`)
      }
      if (normalized.overrideReturnWindow && authorized.role !== 'ADMIN') {
        throw new Error('Only an Admin can override the return window.')
      }
      if (!withinWindow && (!normalized.overrideReturnWindow || !normalized.windowOverrideReason)) {
        throw new Error('An Admin override reason is required for a return outside the configured window.')
      }

      const saleItems = this.querySaleItems(sale.id)
      const saleItemsById = new Map(saleItems.map((item) => [item.id, item]))
      if (normalized.items.length < 1 || normalized.items.length > MAX_RETURN_LINES) {
        throw new Error(`A return must contain between 1 and ${MAX_RETURN_LINES} item lines.`)
      }
      const requestedLines: ReturnLineInsert[] = []
      const seenSaleItems = new Set<string>()
      for (const requestLine of normalized.items) {
        if (seenSaleItems.has(requestLine.saleItemId)) throw new Error('Choose each receipt line only once on a return.')
        seenSaleItems.add(requestLine.saleItemId)
        const saleItem = saleItemsById.get(requestLine.saleItemId)
        if (!saleItem) throw new Error('A selected item does not belong to this receipt.')
        const existingPending = this.database.prepare(`
          SELECT 1 FROM return_items ri JOIN returns r ON r.id = ri.return_id
          WHERE ri.sale_item_id = ? AND r.status = 'PENDING' LIMIT 1
        `).get(saleItem.id)
        if (existingPending) throw new Error('This receipt item already has a return awaiting approval. Resolve that request before submitting another return for the item.')
        const quantityMilli = parseQuantityMilli(requestLine.quantity)
        if (quantityMilli <= 0n) throw new Error('Return quantity must be greater than zero.')
        const reserved = this.sumReturnedQuantity(saleItem.id, ['PENDING', 'COMPLETED'])
        const sold = BigInt(saleItem.quantity_text)
        if (reserved + quantityMilli > sold) {
          throw new Error(`The requested quantity of ${saleItem.description_snapshot} exceeds the quantity sold less prior completed or pending returns.`)
        }
        const expiryTracked = isExpiryTracked(saleItem, edition)
        const condition = normalizeConditionForReason(requestLine.condition, normalized.reason)
        const sourceAllocations = this.allocateOriginalBatches(saleItem, quantityMilli, condition, expiryTracked)
        const priorAmounts = this.getCompletedAllocationState(saleItem.id)
        let state = priorAmounts
        for (const allocation of sourceAllocations) {
          const amounts = allocateAmounts(saleItem, state, allocation.quantityMilli)
          state = advanceAllocationState(state, allocation.quantityMilli, amounts)
          requestedLines.push({
            id: this.newId(),
            saleItem,
            quantityMilli: allocation.quantityMilli,
            condition,
            expiryTracked,
            sourceBatchId: allocation.batchId,
            sourceBatchNumber: allocation.batchNumber,
            sourceExpiryDate: allocation.expiryDate,
            amounts,
          })
        }
      }

      const createdAt = this.isoNow()
      const returnResult = this.database.prepare(`
        INSERT INTO returns (
          sale_id, cashier_id, approved_by, status, currency_code, subtotal, total,
          store_name, store_address, store_phone, created_at,
          reason, return_type, refund_method, payment_reference, reason_note, request_hash, idempotency_key,
          original_receipt_number, cashier_name_snapshot, workstation_snapshot,
          return_window_days_snapshot, return_window_override, return_window_override_reason, return_limit_minor,
          store_email, store_licence_number, store_tax_number, store_logo, store_receipt_footer, store_thank_you_note,
          currency_name_snapshot, currency_symbol_snapshot, currency_decimals_snapshot, currency_is_custom_snapshot,
          display_mode_snapshot, symbol_position_snapshot, thousand_sep_snapshot, decimal_sep_snapshot,
          customer_id, customer_name_snapshot, customer_phone_snapshot, customer_email_snapshot, customer_address_snapshot
        ) VALUES (
          @saleId, @cashierId, NULL, 'PENDING', @currencyCode, 0, 0,
          @storeName, @storeAddress, @storePhone, @createdAt,
          @reason, @returnType, @refundMethod, @paymentReference, @reasonNote, @requestHash, @idempotencyKey,
          @receiptNumber, @cashierName, @workstation,
          @returnWindowDays, @windowOverride, @windowOverrideReason, @returnLimit,
          @storeEmail, @storeLicenceNumber, @storeTaxNumber, @storeLogo, @storeFooter, @thankYouNote,
          @currencyName, @currencySymbol, @currencyDecimals, @currencyIsCustom,
          @displayMode, @symbolPosition, @thousandSep, @decimalSep,
          @customerId, @customerName, @customerPhone, @customerEmail, @customerAddress
        )
      `).run({
        saleId: sale.id,
        cashierId: authorized.id,
        currencyCode: sale.currency_code,
        storeName: sale.store_name,
        storeAddress: sale.store_address,
        storePhone: sale.store_phone,
        createdAt,
        reason: normalized.reason,
        returnType: normalized.type,
        refundMethod: normalized.refundMethod,
        paymentReference: normalized.paymentReference,
        reasonNote: normalized.reasonNote,
        requestHash,
        idempotencyKey: normalized.idempotencyKey,
        receiptNumber: sale.receipt_number,
        // The return snapshot must name the user in `cashier_id` (the requester), not the original sale cashier.
        cashierName: authorized.fullName,
        workstation: this.workstation,
        returnWindowDays,
        windowOverride: normalized.overrideReturnWindow ? 1 : 0,
        windowOverrideReason: normalized.windowOverrideReason,
        returnLimit: authorized.returnLimitMinor,
        storeEmail: sale.store_email,
        storeLicenceNumber: sale.store_licence_number,
        storeTaxNumber: sale.store_tax_number,
        storeLogo: sale.store_logo,
        storeFooter: sale.store_receipt_footer,
        thankYouNote: sale.store_thank_you_note,
        currencyName: sale.currency_name_snapshot || sale.legacy_currency_name || sale.currency_code,
        currencySymbol: sale.currency_symbol_snapshot || sale.legacy_currency_symbol || sale.currency_code,
        currencyDecimals: sale.currency_name_snapshot ? sale.currency_decimals_snapshot : sale.legacy_currency_decimals,
        currencyIsCustom: sale.currency_is_custom_snapshot || sale.legacy_currency_custom ? 1 : 0,
        displayMode: sale.display_mode_snapshot,
        symbolPosition: sale.currency_name_snapshot ? sale.symbol_position_snapshot : sale.legacy_currency_position,
        thousandSep: sale.currency_name_snapshot ? sale.thousand_sep_snapshot : sale.legacy_thousand_sep,
        decimalSep: sale.currency_name_snapshot ? sale.decimal_sep_snapshot : sale.legacy_decimal_sep,
        customerId: sale.customer_id,
        customerName: sale.customer_name_snapshot,
        customerPhone: sale.customer_phone_snapshot,
        customerEmail: sale.customer_email_snapshot,
        customerAddress: sale.customer_address_snapshot,
      })
      returnId = Number(returnResult.lastInsertRowid)
      const returnNumber = (this.database.prepare('SELECT return_number FROM returns WHERE id = ?').get(returnId) as { return_number: string }).return_number
      const insertItem = this.database.prepare(`
        INSERT INTO return_items (
          id, return_id, sale_item_id, product_id, description_snapshot, quantity_milli, unit_price, line_total,
          gross_amount, manual_discount, promotion_discount, loyalty_discount, item_condition, stock_disposition,
          expiry_tracking_snapshot, source_batch_id, source_batch_number_snapshot, source_expiry_date_snapshot, writeoff_reason
        ) VALUES (
          @id, @returnId, @saleItemId, @productId, @description, @quantity, @unitPrice, @lineTotal,
          @gross, @manualDiscount, @promotionDiscount, @loyaltyDiscount, @condition, 'NO_STOCK',
          @expiryTracked, @batchId, @batchNumber, @expiryDate, ''
        )
      `)
      let estimatedTotal = 0n
      for (const line of requestedLines) {
        estimatedTotal += line.amounts.lineTotal
        insertItem.run({
          id: line.id,
          returnId,
          saleItemId: line.saleItem.id,
          productId: line.saleItem.product_id,
          description: line.saleItem.description_snapshot,
          quantity: line.quantityMilli,
          unitPrice: BigInt(line.saleItem.unit_price_text),
          lineTotal: line.amounts.lineTotal,
          gross: line.amounts.gross,
          manualDiscount: line.amounts.manualDiscount,
          promotionDiscount: line.amounts.promotionDiscount,
          loyaltyDiscount: line.amounts.loyaltyDiscount,
          condition: line.condition,
          expiryTracked: line.expiryTracked ? 1 : 0,
          batchId: line.sourceBatchId,
          batchNumber: line.sourceBatchNumber,
          expiryDate: line.sourceExpiryDate,
        })
      }
      assertSqliteInteger(estimatedTotal, 'Return amount')
      this.database.prepare('UPDATE returns SET subtotal = ?, total = ? WHERE id = ? AND status = \'PENDING\'')
        .run(estimatedTotal, estimatedTotal, returnId)

      const returnNumberText = returnNumber
      if (estimatedTotal > authorized.returnLimitMinor) {
        const approvalId = this.newId()
        this.database.prepare(`
          INSERT INTO approval_requests (id, request_type, requested_by, status, payload_json, created_at)
          VALUES (?, 'RETURN', ?, 'PENDING', ?, ?)
        `).run(approvalId, authorized.id, JSON.stringify({ returnId, returnNumber: returnNumberText, receiptNumber: sale.receipt_number }), createdAt)
        this.database.prepare('UPDATE returns SET approval_request_id = ? WHERE id = ? AND status = \'PENDING\'')
          .run(approvalId, returnId)
        this.audit(authorized, 'returns.approval.requested', {
          returnId, returnNumber: returnNumberText, receiptNumber: sale.receipt_number,
          estimatedAmountMinor: estimatedTotal.toString(), returnLimitMinor: authorized.returnLimitMinor.toString(),
          currencyCode: sale.currency_code,
        })
      } else {
        this.completePendingReturn(returnId, sale, authorized, null, null)
      }
      this.audit(authorized, 'returns.requested', {
        returnId, returnNumber: returnNumberText, receiptNumber: sale.receipt_number,
        reason: normalized.reason, type: normalized.type, status: estimatedTotal > authorized.returnLimitMinor ? 'PENDING' : 'COMPLETED',
        itemCount: requestedLines.length, amountMinor: estimatedTotal.toString(), currencyCode: sale.currency_code,
        returnWindowDays, windowOverride: normalized.overrideReturnWindow,
      })
    }).immediate()

    return this.readReturn(returnId)
  }

  listReturns(actor: ReturnActor): ReturnRecord[] {
    this.authorizeActor(actor)
    const ids = this.database.prepare('SELECT id FROM returns ORDER BY id DESC LIMIT 100').all() as Array<{ id: number }>
    return ids.map(({ id }) => this.readReturn(id))
  }

  listPendingMobileApprovals(admin: ReturnActor): ReturnRecord[] {
    const verified = this.authorizeActor(admin)
    if (verified.role !== 'ADMIN') throw new Error('Mobile return approvals are restricted to Admin accounts.')
    const ids = this.database.prepare(`
      SELECT id FROM returns WHERE status = 'PENDING' AND approval_request_id IS NOT NULL ORDER BY id ASC LIMIT 100
    `).all() as Array<{ id: number }>
    return ids.map(({ id }) => this.readReturn(id))
  }

  getReturnDocument(returnId: string | number, actor: ReturnActor): ReturnRecord {
    this.authorizeActor(actor)
    return this.readReturn(normalizeReturnId(returnId))
  }

  resolveApproval(
    returnId: string | number,
    decision: ReturnApprovalDecision,
    actor: ReturnActor,
    channel: ReturnApprovalChannel = 'DESKTOP',
  ): ResolveReturnApprovalResult {
    const approver = this.authorizeActor(actor)
    const normalizedId = normalizeReturnId(returnId)
    if (decision !== 'APPROVE' && decision !== 'REJECT') throw new Error('Choose approve or reject for this return request.')
    if (approver.role !== 'ADMIN' && approver.role !== 'SUPERVISOR') {
      throw new Error('Only an Admin or Supervisor can approve a return above the requester’s limit.')
    }
    if (channel === 'MOBILE' && approver.role !== 'ADMIN') {
      throw new Error('Mobile return approvals are restricted to Admin accounts.')
    }
    if (channel !== 'DESKTOP' && channel !== 'MOBILE') throw new Error('Choose a valid approval channel.')

    this.database.transaction(() => {
      const header = this.database.prepare(`
        SELECT id, sale_id, cashier_id, status, approval_request_id, return_number, original_receipt_number
        FROM returns WHERE id = ?
      `).get(normalizedId) as {
        id: number; sale_id: number; cashier_id: string | null; status: ReturnStatus; approval_request_id: string | null
        return_number: string; original_receipt_number: string
      } | undefined
      if (!header || header.status !== 'PENDING' || !header.approval_request_id) {
        throw new Error('This return is no longer awaiting approval.')
      }
      if (header.cashier_id === approver.id) throw new Error('A user cannot approve their own return request.')
      const request = this.database.prepare(`
        SELECT id, requested_by, status FROM approval_requests WHERE id = ? AND request_type = 'RETURN'
      `).get(header.approval_request_id) as { id: string; requested_by: string; status: string } | undefined
      if (!request || request.status !== 'PENDING' || request.requested_by !== header.cashier_id) {
        throw new Error('The return approval request is no longer active.')
      }
      if (decision === 'REJECT') {
        this.database.prepare(`
          UPDATE approval_requests SET status = 'REJECTED', approved_by = ?, resolved_at = ?
          WHERE id = ? AND status = 'PENDING'
        `).run(approver.id, this.isoNow(), request.id)
        this.database.prepare(`UPDATE returns SET status = 'REJECTED', approved_by = ?, approved_name_snapshot = ?, approved_at = ?, approval_channel = ? WHERE id = ? AND status = 'PENDING'`)
          .run(approver.id, approver.fullName, this.isoNow(), channel, normalizedId)
        this.audit(approver, 'returns.approval.rejected', {
          returnId: normalizedId, returnNumber: header.return_number, receiptNumber: header.original_receipt_number,
          requesterId: request.requested_by, channel,
        })
      } else {
        const sale = this.querySaleById(header.sale_id)
        if (!sale || sale.status !== 'COMPLETED') throw new Error('The original completed sale could not be found.')
        this.completePendingReturn(normalizedId, sale, approver, request.id, channel)
        this.database.prepare(`
          UPDATE approval_requests SET status = 'APPROVED', approved_by = ?, resolved_at = ?
          WHERE id = ? AND status = 'PENDING'
        `).run(approver.id, this.isoNow(), request.id)
        this.audit(approver, 'returns.approval.approved', {
          returnId: normalizedId, returnNumber: header.return_number, receiptNumber: header.original_receipt_number,
          requesterId: request.requested_by, channel,
        })
      }
    }).immediate()

    return { decision, returnRecord: this.readReturn(normalizedId) }
  }

  resolveMobileApproval(returnId: string | number, decision: ReturnApprovalDecision, admin: ReturnActor): ResolveReturnApprovalResult {
    const verified = this.authorizeActor(admin)
    if (verified.role !== 'ADMIN') throw new Error('Mobile return approvals are restricted to Admin accounts.')
    return this.resolveApproval(returnId, decision, verified, 'MOBILE')
  }

  recordReturnPrint(returnId: string | number, layout: ReturnDocumentLayout, actor: ReturnActor): ReturnRecord {
    const printer = this.authorizeActor(actor)
    if (!['THERMAL_80', 'THERMAL_58', 'A4_RECEIPT', 'A4_INVOICE'].includes(layout)) {
      throw new Error('Choose a supported return or credit-note layout.')
    }
    const id = normalizeReturnId(returnId)
    this.database.transaction(() => {
      const header = this.database.prepare(`
        SELECT id, status, store_name, return_number, return_type FROM returns WHERE id = ?
      `).get(id) as { id: number; status: ReturnStatus; store_name: string; return_number: string; return_type: ReturnKind } | undefined
      if (!header || header.status !== 'COMPLETED') throw new Error('Only a completed return can be printed or shared as a final document.')
      if (!header.store_name.trim()) throw new Error('Printing is blocked because the original sale has no saved store name.')
      const count = (this.database.prepare('SELECT COUNT(*) AS count FROM return_print_events WHERE return_id = ?').get(id) as { count: number }).count
      const duplicate = count > 0
      this.database.prepare(`
        INSERT INTO return_print_events (id, return_id, printed_by, workstation, document_layout, is_duplicate, printed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(this.newId(), id, printer.id, this.workstation, layout, duplicate ? 1 : 0, this.isoNow())
      this.audit(printer, duplicate ? 'returns.document.reprinted' : 'returns.document.printed', {
        returnId: id, returnNumber: header.return_number, type: header.return_type, layout, duplicate,
      })
    }).immediate()
    return this.readReturn(id)
  }

  private completePendingReturn(
    returnId: number,
    sale: SaleHeaderRow,
    approver: AuthorizedActor,
    approvalRequestId: string | null,
    channel: ReturnApprovalChannel | null,
  ): void {
    const returnHeader = this.database.prepare(`
      SELECT status, cashier_id, return_type, refund_method, payment_reference, return_number, reason,
        approval_request_id, currency_code, customer_id
      FROM returns WHERE id = ?
    `).get(returnId) as {
      status: ReturnStatus; cashier_id: string | null; return_type: ReturnKind; refund_method: ReturnPaymentMethod | null
      payment_reference: string; return_number: string; reason: ReturnReason; approval_request_id: string | null
      currency_code: string; customer_id: string | null
    } | undefined
    if (!returnHeader || returnHeader.status !== 'PENDING') throw new Error('This return is no longer pending.')
    if (approvalRequestId && returnHeader.approval_request_id !== approvalRequestId) {
      throw new Error('The approval request no longer matches this return.')
    }
    const currentItems = this.database.prepare(`
      SELECT id, sale_item_id, product_id, CAST(quantity_milli AS TEXT) AS quantity_text,
        item_condition, expiry_tracking_snapshot, source_batch_id, source_batch_number_snapshot, source_expiry_date_snapshot
      FROM return_items WHERE return_id = ? ORDER BY rowid
    `).all(returnId) as PendingReturnItemRow[]
    if (currentItems.length === 0) throw new Error('This return request has no items.')
    const completedAt = this.isoNow()

    const saleItemsById = new Map(this.querySaleItems(sale.id).map((item) => [item.id, item]))
    const grouped = new Map<string, PendingReturnItemRow[]>()
    for (const item of currentItems) {
      const group = grouped.get(item.sale_item_id) ?? []
      group.push(item)
      grouped.set(item.sale_item_id, group)
    }

    let totalMinor = 0n
    let promotionReversed = 0n
    let loyaltyDiscountReversed = 0n
    for (const [saleItemId, rows] of grouped) {
      const saleItem = saleItemsById.get(saleItemId)
      if (!saleItem) throw new Error('A returned item no longer matches its original sale line.')
      const prior = this.getCompletedAllocationState(saleItemId)
      const currentQuantity = rows.reduce((sum, row) => sum + BigInt(row.quantity_text), 0n)
      const otherPending = this.sumPendingQuantityExcept(saleItemId, returnId)
      const soldQuantity = BigInt(saleItem.quantity_text)
      if (prior.quantity + otherPending + currentQuantity > soldQuantity) {
        throw new Error(`The return quantity for ${saleItem.description_snapshot} now exceeds the remaining sold quantity.`)
      }
      let state = prior
      for (const row of rows) {
        const quantity = BigInt(row.quantity_text)
        const amounts = allocateAmounts(saleItem, state, quantity)
        state = advanceAllocationState(state, quantity, amounts)
        totalMinor += amounts.lineTotal
        promotionReversed += amounts.promotionDiscount
        loyaltyDiscountReversed += amounts.loyaltyDiscount
        const stockResult = this.restoreStock(row, approver, returnHeader.return_number, sale.currency_code, completedAt)
        this.database.prepare(`
          UPDATE return_items SET gross_amount = ?, manual_discount = ?, promotion_discount = ?, loyalty_discount = ?,
            line_total = ?, stock_disposition = ?, writeoff_reason = ? WHERE id = ? AND return_id = ?
        `).run(amounts.gross, amounts.manualDiscount, amounts.promotionDiscount, amounts.loyaltyDiscount,
          amounts.lineTotal, stockResult.disposition, stockResult.writeoffReason, row.id, returnId)
      }
    }
    assertSqliteInteger(totalMinor, 'Return amount')
    assertSqliteInteger(promotionReversed, 'Promotion reversal')
    assertSqliteInteger(loyaltyDiscountReversed, 'Loyalty discount reversal')

    const priorHistory = this.database.prepare(`
      SELECT CAST(COALESCE(SUM(total), 0) AS TEXT) AS returned_total,
        CAST(COALESCE(SUM(loyalty_discount_reversed), 0) AS TEXT) AS loyalty_discount,
        COALESCE(SUM(loyalty_points_reversed), 0) AS points_reversed,
        COALESCE(SUM(loyalty_points_restored), 0) AS points_restored
      FROM returns WHERE sale_id = ? AND status = 'COMPLETED'
    `).get(sale.id) as {
      returned_total: string; loyalty_discount: string; points_reversed: number; points_restored: number
    }
    const priorReturnedTotal = BigInt(priorHistory.returned_total)
    const cumulativeReturnedTotal = priorReturnedTotal + totalMinor
    const cumulativeLoyaltyDiscount = BigInt(priorHistory.loyalty_discount) + loyaltyDiscountReversed
    const earnedPointsTarget = proportionalTarget(BigInt(sale.loyalty_points_earned), cumulativeReturnedTotal, BigInt(sale.total_text))
    const redeemBase = BigInt(sale.loyalty_discount_text)
    const restoredPointsTarget = redeemBase > 0n
      ? proportionalTarget(BigInt(sale.loyalty_points_redeemed), cumulativeLoyaltyDiscount, redeemBase)
      : 0n
    const pointsReversed = earnedPointsTarget - BigInt(priorHistory.points_reversed)
    const pointsRestored = restoredPointsTarget - BigInt(priorHistory.points_restored)
    if (pointsReversed < 0n || pointsRestored < 0n || pointsReversed > MAX_SAFE_INTEGER || pointsRestored > MAX_SAFE_INTEGER) {
      throw new Error('The loyalty reversal exceeds the supported whole-number range.')
    }
    this.reverseLoyalty(sale, returnId, approver, pointsReversed, pointsRestored)

    let creditNumber = ''
    if ((returnHeader.return_type === 'STORE_CREDIT' || returnHeader.return_type === 'EXCHANGE') && totalMinor > 0n) {
      const credit = this.database.prepare(`
        INSERT INTO return_credits (return_id, customer_id, currency_code, credit_type, amount_minor, remaining_minor, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(returnId, returnHeader.customer_id, sale.currency_code, returnHeader.return_type, totalMinor, totalMinor, this.isoNow())
      creditNumber = (this.database.prepare('SELECT credit_number FROM return_credits WHERE id = ?').get(Number(credit.lastInsertRowid)) as { credit_number: string }).credit_number
    }

    const paymentMethod = returnHeader.return_type === 'REFUND'
      ? `REFUND_${returnHeader.refund_method ?? 'CASH'}`
      : returnHeader.return_type === 'STORE_CREDIT' ? 'STORE_CREDIT' : 'EXCHANGE_CREDIT'
    const paymentReference = returnHeader.return_type === 'REFUND' ? returnHeader.payment_reference : creditNumber
    if (totalMinor > 0n) {
      const openShift = this.database.prepare(`
        SELECT id FROM cashier_shifts
        WHERE cashier_id = ? AND currency_code = ? AND status = 'OPEN'
        ORDER BY opened_at DESC LIMIT 1
      `).get(approver.id, sale.currency_code) as { id: string } | undefined
      this.database.prepare(`
        INSERT INTO payments (
          id, sale_id, return_id, payment_method, amount, currency_code, reference,
          tendered_amount, change_amount, shift_id
        ) VALUES (?, NULL, ?, ?, ?, ?, ?, 0, 0, ?)
      `).run(this.newId(), returnId, paymentMethod, totalMinor, sale.currency_code, paymentReference, openShift?.id ?? null)
    }

    const updated = this.database.prepare(`
      UPDATE returns SET status = 'COMPLETED', subtotal = ?, total = ?, approved_by = ?,
        approved_name_snapshot = ?, approved_at = ?, approval_channel = ?,
        promotion_amount_reversed = ?, loyalty_discount_reversed = ?, loyalty_points_reversed = ?, loyalty_points_restored = ?
      WHERE id = ? AND status = 'PENDING'
    `).run(totalMinor, totalMinor, approvalRequestId ? approver.id : null,
      approvalRequestId ? approver.fullName : '', approvalRequestId ? completedAt : null, channel,
      promotionReversed, loyaltyDiscountReversed, pointsReversed, pointsRestored, returnId)
    if (updated.changes !== 1) throw new Error('This return changed while it was being completed. Refresh the return list.')

    this.database.prepare(`
      INSERT INTO business_entries (
        id, kind, currency_code, amount_minor, store_name_snapshot, store_address_snapshot, store_phone_snapshot, created_at
      ) VALUES (?, 'return', ?, ?, ?, ?, ?, ?)
    `).run(this.newId(), sale.currency_code, totalMinor, sale.store_name, sale.store_address, sale.store_phone, completedAt)
    this.audit(approver, 'returns.completed', {
      returnId, returnNumber: returnHeader.return_number, receiptNumber: sale.receipt_number,
      reason: returnHeader.reason, type: returnHeader.return_type, amountMinor: totalMinor.toString(),
      currencyCode: sale.currency_code, promotionAmountReversedMinor: promotionReversed.toString(),
      loyaltyDiscountReversedMinor: loyaltyDiscountReversed.toString(), loyaltyPointsReversed: pointsReversed.toString(),
      loyaltyPointsRestored: pointsRestored.toString(), approvalChannel: channel, creditNumber,
    })
  }

  private restoreStock(
    item: PendingReturnItemRow,
    actor: AuthorizedActor,
    returnNumber: string,
    currencyCode: string,
    completedAt: string,
  ): { disposition: ReturnStockDisposition; writeoffReason: string } {
    if (!item.product_id) return { disposition: 'NO_STOCK', writeoffReason: '' }
    const quantity = BigInt(item.quantity_text)
    const product = this.database.prepare(`
      SELECT id, CAST(cost AS TEXT) AS cost_text FROM products WHERE id = ?
    `).get(item.product_id) as { id: string; cost_text: string } | undefined
    if (!product) return { disposition: 'NO_STOCK', writeoffReason: '' }

    if (item.item_condition !== 'RESELLABLE') {
      return { disposition: 'WRITTEN_OFF', writeoffReason: writeoffReasonForCondition(item.item_condition) }
    }

    let unitCost = BigInt(product.cost_text)
    if (item.expiry_tracking_snapshot === 1) {
      if (!item.source_batch_id) {
        throw new Error(`The original Pharmacy batch for ${item.sale_item_id} is unavailable. Record the item as non-resellable instead of restocking it.`)
      }
      const batch = this.database.prepare(`
        SELECT id, product_id, batch_no, expiry_date, CAST(quantity_milli AS TEXT) AS quantity_text,
          CAST(cost AS TEXT) AS cost_text, row_version
        FROM product_batches WHERE id = ? AND product_id = ?
      `).get(item.source_batch_id, item.product_id) as {
        id: string; product_id: string; batch_no: string; expiry_date: string; quantity_text: string; cost_text: string; row_version: number
      } | undefined
      if (!batch) throw new Error(`The original Pharmacy batch for ${item.sale_item_id} no longer exists; the return was not completed.`)
      if (batch.expiry_date < this.isoNow().slice(0, 10)) {
        return { disposition: 'WRITTEN_OFF', writeoffReason: 'The original Pharmacy batch is expired.' }
      }
      unitCost = BigInt(batch.cost_text)
      const batchUpdate = this.database.prepare(`
        UPDATE product_batches SET quantity_milli = quantity_milli + ?, row_version = row_version + 1
        WHERE id = ? AND product_id = ? AND row_version = ?
      `).run(quantity, batch.id, item.product_id, batch.row_version)
      if (batchUpdate.changes !== 1) throw new Error('The original Pharmacy batch changed while completing the return. Refresh and try again.')
    }

    const stock = this.database.prepare(`
      SELECT CAST(quantity_milli AS TEXT) AS quantity_text FROM stock WHERE product_id = ?
    `).get(item.product_id) as { quantity_text: string } | undefined
    if (!stock) throw new Error('The product stock record is missing; the return was not completed.')
    assertSqliteInteger(BigInt(stock.quantity_text) + quantity, 'Returned stock quantity')
    const stockUpdate = this.database.prepare(`
      UPDATE stock SET quantity_milli = quantity_milli + ?, row_version = row_version + 1, updated_at = ?
      WHERE product_id = ?
    `).run(quantity, this.isoNow(), item.product_id)
    if (stockUpdate.changes !== 1) throw new Error('Stock changed while completing the return. Refresh and try again.')

    this.database.prepare(`
      INSERT INTO stock_movements (
        id, product_id, movement_type, reference_type, reference_id, quantity_delta_milli,
        unit_cost, currency_code, created_by, adjustment_reason, created_at
      ) VALUES (?, ?, 'RETURN', 'RETURN', ?, ?, ?, ?, ?, ?, ?)
    `).run(this.newId(), item.product_id, returnNumber, quantity, unitCost, currencyCode, actor.id,
      'Resellable customer return restored to original stock', completedAt)
    return { disposition: 'RESTOCKED', writeoffReason: '' }
  }

  private reverseLoyalty(
    sale: SaleHeaderRow,
    returnId: number,
    actor: AuthorizedActor,
    pointsReversed: bigint,
    pointsRestored: bigint,
  ): void {
    if (!sale.loyalty_member_id || (pointsReversed === 0n && pointsRestored === 0n)) return
    const member = this.database.prepare(`
      SELECT id, points_balance, points_debt, row_version FROM loyalty_members WHERE id = ?
    `).safeIntegers().get(sale.loyalty_member_id) as {
      id: string; points_balance: number | bigint; points_debt: number | bigint; row_version: number | bigint
    } | undefined
    if (!member) throw new Error('The original loyalty member is unavailable; the return was not completed.')
    const currentBalance = BigInt(member.points_balance)
    const currentDebt = BigInt(member.points_debt)
    const useRestoredToPayDebt = currentDebt < pointsRestored ? currentDebt : pointsRestored
    const newDebtBeforeReversal = currentDebt - useRestoredToPayDebt
    const availableAfterRestore = currentBalance + pointsRestored - useRestoredToPayDebt
    const takeFromBalance = availableAfterRestore < pointsReversed ? availableAfterRestore : pointsReversed
    const newBalance = availableAfterRestore - takeFromBalance
    const newDebt = newDebtBeforeReversal + pointsReversed - takeFromBalance
    if (newBalance > MAX_SAFE_INTEGER || newDebt > MAX_SAFE_INTEGER) {
      throw new Error('The loyalty reversal exceeds the supported whole-number range.')
    }
    const update = this.database.prepare(`
      UPDATE loyalty_members SET points_balance = ?, points_debt = ?, row_version = row_version + 1
      WHERE id = ? AND row_version = ?
    `).run(newBalance, newDebt, member.id, member.row_version)
    if (update.changes !== 1) throw new Error('Loyalty points changed during the return. Refresh and try again.')
    const addAdjustment = this.database.prepare(`
      INSERT INTO loyalty_transactions (id, loyalty_member_id, sale_id, return_id, points_delta, transaction_type)
      VALUES (?, ?, ?, ?, ?, 'ADJUST')
    `)
    if (pointsRestored > 0n) addAdjustment.run(this.newId(), member.id, sale.id, returnId, pointsRestored)
    if (pointsReversed > 0n) addAdjustment.run(this.newId(), member.id, sale.id, returnId, -pointsReversed)
    this.audit(actor, 'returns.loyalty.reversed', {
      returnId, saleId: sale.id, memberId: member.id,
      pointsReversed: pointsReversed.toString(), pointsRestored: pointsRestored.toString(),
      pointsDebtAdded: (pointsReversed - takeFromBalance).toString(),
    })
  }

  private allocateOriginalBatches(
    saleItem: SaleItemRow,
    requestedQuantity: bigint,
    condition: ReturnItemCondition,
    expiryTracked: boolean,
  ): Array<{ batchId: string | null; batchNumber: string; expiryDate: string; quantityMilli: bigint }> {
    if (!expiryTracked || !saleItem.product_id) {
      return [{ batchId: null, batchNumber: '', expiryDate: '', quantityMilli: requestedQuantity }]
    }
    const batches = this.querySaleBatches(saleItem.id)
    if (batches.length === 0) {
      if (condition === 'RESELLABLE') {
        throw new Error(`No original Pharmacy batch was saved for ${saleItem.description_snapshot}. Record it as non-resellable rather than returning it to sellable stock.`)
      }
      return [{ batchId: null, batchNumber: '', expiryDate: '', quantityMilli: requestedQuantity }]
    }
    const allocations: Array<{ batchId: string | null; batchNumber: string; expiryDate: string; quantityMilli: bigint }> = []
    let remaining = requestedQuantity
    for (const batch of batches) {
      if (remaining === 0n) break
      const alreadyReturned = this.sumReturnedFromBatch(saleItem.id, batch.batch_id)
      const available = BigInt(batch.quantity_text) - alreadyReturned
      if (available <= 0n) continue
      const take = available < remaining ? available : remaining
      allocations.push({
        batchId: batch.batch_id,
        batchNumber: batch.batch_number_snapshot,
        expiryDate: batch.expiry_date_snapshot,
        quantityMilli: take,
      })
      remaining -= take
    }
    if (remaining > 0n) {
      if (condition === 'RESELLABLE') {
        throw new Error(`The original Pharmacy batches do not contain enough unreturned quantity for ${saleItem.description_snapshot}.`)
      }
      allocations.push({ batchId: null, batchNumber: '', expiryDate: '', quantityMilli: remaining })
    }
    return allocations
  }

  private mapReturnableSale(sale: SaleHeaderRow, edition: Edition): ReturnSaleRecord {
    const settings = this.shop.readSettings()
    const returnWindowDays = settings.returnWindowDays ?? 7
    const saleTime = Date.parse(sale.created_at)
    const deadline = saleTime + returnWindowDays * 86_400_000
    const now = this.now()
    const items = this.querySaleItems(sale.id).map((row): ReturnSaleItemRecord => {
      const sold = BigInt(row.quantity_text)
      const returned = this.sumReturnedQuantity(row.id, ['PENDING', 'COMPLETED'])
      return {
        saleItemId: row.id,
        productId: row.product_id,
        sku: row.product_sku_snapshot || row.current_sku || '',
        description: row.description_snapshot,
        unit: row.unit_snapshot || '',
        quantityMilli: sold,
        returnedQuantityMilli: returned,
        returnableQuantityMilli: sold > returned ? sold - returned : 0n,
        unitPriceMinor: BigInt(row.unit_price_text),
        grossTotalMinor: effectiveGross(row),
        manualDiscountMinor: BigInt(row.manual_discount_text),
        promotionDiscountMinor: BigInt(row.promotion_discount_text),
        loyaltyDiscountMinor: BigInt(row.loyalty_discount_text),
        lineTotalMinor: BigInt(row.line_total_text),
        expiryTracked: isExpiryTracked(row, edition),
        batches: this.querySaleBatches(row.id).map((batch) => ({
          batchId: batch.batch_id,
          batchNumber: batch.batch_number_snapshot,
          expiryDate: batch.expiry_date_snapshot,
          quantityMilli: BigInt(batch.quantity_text),
        })),
      }
    })
    const snapshot = currencyAndDisplay(sale)
    return {
      saleId: sale.id,
      receiptNumber: sale.receipt_number,
      createdAt: sale.created_at,
      cashier: sale.cashier_name_snapshot,
      currency: snapshot.currency,
      display: snapshot.display,
      store: storeFromSale(sale),
      customer: sale.customer_id ? {
        id: sale.customer_id,
        name: sale.customer_name_snapshot,
        phone: sale.customer_phone_snapshot,
        email: sale.customer_email_snapshot,
        address: sale.customer_address_snapshot,
      } : null,
      totalMinor: BigInt(sale.total_text),
      promotionDiscountMinor: BigInt(sale.promotion_discount_text),
      loyaltyDiscountMinor: BigInt(sale.loyalty_discount_text),
      loyaltyPointsEarned: sale.loyalty_points_earned,
      loyaltyPointsRedeemed: sale.loyalty_points_redeemed,
      items,
      returnWindowDays,
      withinReturnWindow: Number.isFinite(saleTime) && now >= saleTime && now <= deadline,
      remainingWindowMilliseconds: Math.max(0, deadline - now),
    }
  }

  private querySaleByReceipt(receiptNumber: string): SaleHeaderRow | null {
    const row = this.database.prepare(`${SALE_HEADER_SELECT} WHERE s.receipt_number = ? COLLATE NOCASE`).get(receiptNumber) as SaleHeaderRow | undefined
    return row ?? null
  }

  private querySaleById(saleId: number): SaleHeaderRow | null {
    const row = this.database.prepare(`${SALE_HEADER_SELECT} WHERE s.id = ?`).get(saleId) as SaleHeaderRow | undefined
    return row ?? null
  }

  private querySaleItems(saleId: number): SaleItemRow[] {
    return this.database.prepare(`
      SELECT si.id, si.sale_id, si.product_id, si.description_snapshot,
        CAST(si.quantity_milli AS TEXT) AS quantity_text, CAST(si.unit_price AS TEXT) AS unit_price_text,
        CAST(si.gross_total AS TEXT) AS gross_total_text, CAST(si.manual_discount AS TEXT) AS manual_discount_text,
        CAST(si.promotion_discount AS TEXT) AS promotion_discount_text, CAST(si.loyalty_discount AS TEXT) AS loyalty_discount_text,
        CAST(si.line_total AS TEXT) AS line_total_text, si.product_sku_snapshot, si.unit_snapshot,
        si.expiry_tracking_snapshot, p.sku AS current_sku, p.expiry_tracking AS current_expiry_tracking,
        p.generic_name AS current_generic_name, p.prescription_required AS current_prescription_required
      FROM sale_items si LEFT JOIN products p ON p.id = si.product_id
      WHERE si.sale_id = ? ORDER BY si.rowid
    `).all(saleId) as SaleItemRow[]
  }

  private querySaleBatches(saleItemId: string): SaleBatchRow[] {
    return this.database.prepare(`
      SELECT batch_id, batch_number_snapshot, expiry_date_snapshot, CAST(quantity_milli AS TEXT) AS quantity_text
      FROM sale_item_batches WHERE sale_item_id = ? ORDER BY rowid
    `).all(saleItemId) as SaleBatchRow[]
  }

  private sumReturnedQuantity(saleItemId: string, statuses: ReturnStatus[]): bigint {
    const placeholders = statuses.map(() => '?').join(', ')
    const result = this.database.prepare(`
      SELECT CAST(COALESCE(SUM(ri.quantity_milli), 0) AS TEXT) AS quantity_text
      FROM return_items ri JOIN returns r ON r.id = ri.return_id
      WHERE ri.sale_item_id = ? AND r.status IN (${placeholders})
    `).get(saleItemId, ...statuses) as { quantity_text: string }
    return BigInt(result.quantity_text)
  }

  private sumReturnedFromBatch(saleItemId: string, batchId: string): bigint {
    const result = this.database.prepare(`
      SELECT CAST(COALESCE(SUM(ri.quantity_milli), 0) AS TEXT) AS quantity_text
      FROM return_items ri JOIN returns r ON r.id = ri.return_id
      WHERE ri.sale_item_id = ? AND ri.source_batch_id = ? AND r.status IN ('PENDING', 'COMPLETED')
    `).get(saleItemId, batchId) as { quantity_text: string }
    return BigInt(result.quantity_text)
  }

  private getCompletedAllocationState(saleItemId: string): CompletedAllocationState {
    const row = this.database.prepare(`
      SELECT CAST(COALESCE(SUM(ri.quantity_milli), 0) AS TEXT) AS quantity_text,
        CAST(COALESCE(SUM(ri.gross_amount), 0) AS TEXT) AS gross_text,
        CAST(COALESCE(SUM(ri.manual_discount), 0) AS TEXT) AS manual_text,
        CAST(COALESCE(SUM(ri.promotion_discount), 0) AS TEXT) AS promotion_text,
        CAST(COALESCE(SUM(ri.loyalty_discount), 0) AS TEXT) AS loyalty_text,
        CAST(COALESCE(SUM(ri.line_total), 0) AS TEXT) AS line_total_text
      FROM return_items ri JOIN returns r ON r.id = ri.return_id
      WHERE ri.sale_item_id = ? AND r.status = 'COMPLETED'
    `).get(saleItemId) as {
      quantity_text: string; gross_text: string; manual_text: string; promotion_text: string; loyalty_text: string; line_total_text: string
    }
    return {
      quantity: BigInt(row.quantity_text),
      amounts: {
        gross: BigInt(row.gross_text), manualDiscount: BigInt(row.manual_text),
        promotionDiscount: BigInt(row.promotion_text), loyaltyDiscount: BigInt(row.loyalty_text),
        lineTotal: BigInt(row.line_total_text),
      },
    }
  }

  private sumPendingQuantityExcept(saleItemId: string, returnId: number): bigint {
    const row = this.database.prepare(`
      SELECT CAST(COALESCE(SUM(ri.quantity_milli), 0) AS TEXT) AS quantity_text
      FROM return_items ri JOIN returns r ON r.id = ri.return_id
      WHERE ri.sale_item_id = ? AND ri.return_id <> ? AND r.status = 'PENDING'
    `).get(saleItemId, returnId) as { quantity_text: string }
    return BigInt(row.quantity_text)
  }

  private readReturn(returnId: number): ReturnRecord {
    const row = this.database.prepare(`
      SELECT r.id, r.return_number, r.sale_id, r.cashier_id, r.approved_by, r.status, r.currency_code,
        CAST(r.subtotal AS TEXT) AS subtotal_text, CAST(r.total AS TEXT) AS total_text,
        r.store_name, r.store_address, r.store_phone, r.created_at, r.reason, r.return_type,
        r.refund_method, r.payment_reference, r.reason_note, r.original_receipt_number,
        r.cashier_name_snapshot, r.approved_name_snapshot, r.approved_at, r.approval_channel, r.approval_request_id,
        r.return_window_days_snapshot, r.return_window_override, r.return_window_override_reason,
        r.store_email, r.store_licence_number, r.store_tax_number, r.store_logo, r.store_receipt_footer, r.store_thank_you_note,
        r.currency_name_snapshot, r.currency_symbol_snapshot, r.currency_decimals_snapshot, r.currency_is_custom_snapshot,
        r.display_mode_snapshot, r.symbol_position_snapshot, r.thousand_sep_snapshot, r.decimal_sep_snapshot,
        r.customer_id, r.customer_name_snapshot, r.customer_phone_snapshot, r.customer_email_snapshot, r.customer_address_snapshot,
        CAST(r.promotion_amount_reversed AS TEXT) AS promotion_amount_reversed_text,
        CAST(r.loyalty_discount_reversed AS TEXT) AS loyalty_discount_reversed_text,
        r.loyalty_points_reversed, r.loyalty_points_restored,
        c.name AS legacy_currency_name, c.symbol AS legacy_currency_symbol, c.decimals AS legacy_currency_decimals,
        c.is_custom AS legacy_currency_custom, c.symbol_position AS legacy_currency_position,
        c.thousand_sep AS legacy_thousand_sep, c.decimal_sep AS legacy_decimal_sep
      FROM returns r LEFT JOIN currencies c ON c.code = r.currency_code WHERE r.id = ?
    `).get(returnId) as ReturnHeaderRow | undefined
    if (!row) throw new Error('The return document could not be found.')
    const itemRows = this.database.prepare(`
      SELECT ri.id, ri.sale_item_id, ri.product_id, ri.description_snapshot,
        CAST(ri.quantity_milli AS TEXT) AS quantity_text, CAST(ri.unit_price AS TEXT) AS unit_price_text,
        CAST(ri.line_total AS TEXT) AS line_total_text, CAST(ri.gross_amount AS TEXT) AS gross_amount_text,
        CAST(ri.manual_discount AS TEXT) AS manual_discount_text, CAST(ri.promotion_discount AS TEXT) AS promotion_discount_text,
        CAST(ri.loyalty_discount AS TEXT) AS loyalty_discount_text, ri.item_condition, ri.stock_disposition,
        ri.writeoff_reason, ri.source_batch_id, ri.source_batch_number_snapshot, ri.source_expiry_date_snapshot,
        si.product_sku_snapshot AS sku_snapshot, si.unit_snapshot
      FROM return_items ri LEFT JOIN sale_items si ON si.id = ri.sale_item_id
      WHERE ri.return_id = ? ORDER BY ri.rowid
    `).all(returnId) as ReturnItemRow[]
    const credit = this.database.prepare(`
      SELECT credit_number, credit_type, CAST(amount_minor AS TEXT) AS amount_text,
        CAST(remaining_minor AS TEXT) AS remaining_text, customer_id, created_at
      FROM return_credits WHERE return_id = ?
    `).get(returnId) as CreditRow | undefined
    const printCount = (this.database.prepare('SELECT COUNT(*) AS count FROM return_print_events WHERE return_id = ?').get(returnId) as { count: number }).count
    const legacyName = row.currency_name_snapshot || row.legacy_currency_name || row.currency_code
    const legacySymbol = row.currency_symbol_snapshot || row.legacy_currency_symbol || row.currency_code
    const currency: CurrencyDefinition = {
      code: row.currency_code,
      name: legacyName,
      symbol: legacySymbol,
      decimalPlaces: row.currency_name_snapshot ? row.currency_decimals_snapshot : row.legacy_currency_decimals ?? 2,
      kind: (row.currency_is_custom_snapshot === 1 || row.legacy_currency_custom === 1) ? 'custom' : 'iso',
      symbolPosition: row.currency_name_snapshot ? row.symbol_position_snapshot : row.legacy_currency_position ?? 'before',
      thousandsSeparator: row.currency_name_snapshot ? row.thousand_sep_snapshot : row.legacy_thousand_sep ?? ',',
      decimalSeparator: row.currency_name_snapshot ? row.decimal_sep_snapshot : row.legacy_decimal_sep ?? '.',
    }
    const display = {
      amountDisplay: row.display_mode_snapshot,
      symbolPosition: row.currency_name_snapshot ? row.symbol_position_snapshot : row.legacy_currency_position ?? 'before',
      thousandsSeparator: row.currency_name_snapshot ? row.thousand_sep_snapshot : row.legacy_thousand_sep ?? ',',
      decimalSeparator: row.currency_name_snapshot ? row.decimal_sep_snapshot : row.legacy_decimal_sep ?? '.',
    } as const
    const store: ShopProfile = {
      name: row.store_name,
      address: row.store_address,
      phone: row.store_phone,
      email: row.store_email,
      licenceNumber: row.store_licence_number,
      taxNumber: row.store_tax_number,
      storeLogo: row.store_logo,
      receiptFooter: row.store_receipt_footer,
      thankYouNote: row.store_thank_you_note,
    }
    return {
      id: row.id,
      returnNumber: row.return_number,
      saleId: row.sale_id,
      receiptNumber: row.original_receipt_number,
      status: row.status,
      reason: row.reason,
      reasonNote: row.reason_note,
      type: row.return_type,
      refundMethod: row.refund_method,
      paymentReference: row.payment_reference,
      createdAt: row.created_at,
      cashierId: row.cashier_id,
      cashier: row.cashier_name_snapshot,
      approverId: row.approved_by,
      approvedBy: row.approved_name_snapshot,
      approvedAt: row.approved_at,
      approvalChannel: row.approval_channel,
      approvalRequestId: row.approval_request_id,
      returnWindowDays: row.return_window_days_snapshot,
      returnWindowOverride: row.return_window_override === 1,
      returnWindowOverrideReason: row.return_window_override_reason,
      currency,
      display,
      store,
      customer: row.customer_id ? {
        id: row.customer_id,
        name: row.customer_name_snapshot,
        phone: row.customer_phone_snapshot,
        email: row.customer_email_snapshot,
        address: row.customer_address_snapshot,
      } : null,
      subtotalMinor: BigInt(row.subtotal_text),
      totalMinor: BigInt(row.total_text),
      promotionAmountReversedMinor: BigInt(row.promotion_amount_reversed_text),
      loyaltyDiscountReversedMinor: BigInt(row.loyalty_discount_reversed_text),
      loyaltyPointsReversed: row.loyalty_points_reversed,
      loyaltyPointsRestored: row.loyalty_points_restored,
      items: itemRows.map((item) => ({
        id: item.id,
        saleItemId: item.sale_item_id,
        productId: item.product_id,
        sku: item.sku_snapshot,
        description: item.description_snapshot,
        unit: item.unit_snapshot,
        quantityMilli: BigInt(item.quantity_text),
        condition: item.item_condition,
        stockDisposition: item.stock_disposition,
        writeoffReason: item.writeoff_reason,
        sourceBatchId: item.source_batch_id,
        sourceBatchNumber: item.source_batch_number_snapshot,
        sourceExpiryDate: item.source_expiry_date_snapshot,
        grossAmountMinor: BigInt(item.gross_amount_text),
        manualDiscountMinor: BigInt(item.manual_discount_text),
        promotionDiscountMinor: BigInt(item.promotion_discount_text),
        loyaltyDiscountMinor: BigInt(item.loyalty_discount_text),
        lineTotalMinor: BigInt(item.line_total_text),
      })),
      credit: credit ? {
        creditNumber: credit.credit_number,
        type: credit.credit_type,
        amountMinor: BigInt(credit.amount_text),
        remainingMinor: BigInt(credit.remaining_text),
        customerId: credit.customer_id,
        createdAt: credit.created_at,
      } : null,
      duplicate: printCount > 1,
      printCount,
    }
  }

  private authorizeActor(actor: ReturnActor): AuthorizedActor {
    if (!actor || typeof actor.id !== 'string' || !actor.id.trim() || typeof actor.username !== 'string' || !actor.username.trim()) {
      throw new Error('An active signed-in host user is required for returns.')
    }
    const row = this.database.prepare(`
      SELECT u.id, u.username, u.full_name, u.role, u.is_active, u.locked_at,
        COALESCE(p.return_limit, 0) AS return_limit
      FROM users u LEFT JOIN user_permissions p ON p.user_id = u.id WHERE u.id = ?
    `).safeIntegers().get(actor.id) as {
      id: string; username: string; full_name: string; role: UserRole; is_active: number | bigint
      locked_at: string | null; return_limit: number | bigint
    } | undefined
    if (!row || row.username !== actor.username || row.role !== actor.role || Number(row.is_active) !== 1 || row.locked_at !== null) {
      throw new Error('Your session is no longer authorized to use returns. Sign in again.')
    }
    const returnLimit = BigInt(row.return_limit)
    if (returnLimit < 0n || returnLimit > MAX_SQLITE_INTEGER) throw new Error('This account has an invalid return limit; contact an Admin.')
    return {
      id: row.id,
      username: row.username,
      role: row.role,
      fullName: cleanText(row.full_name || actor.fullName || row.username, 120),
      returnLimitMinor: returnLimit,
    }
  }

  private audit(actor: ReturnActor, action: string, metadata: Record<string, unknown>): void {
    this.shop.appendAudit({
      actor: actor.username,
      action,
      metadata,
      deviceName: this.workstation,
      ipAddress: null,
      createdAt: this.isoNow(),
    })
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString()
  }
}

const SALE_HEADER_SELECT = `
  SELECT s.id, s.receipt_number, s.status, s.created_at, s.cashier_id, s.cashier_name_snapshot,
    s.currency_code, CAST(s.subtotal AS TEXT) AS subtotal_text, CAST(s.discount AS TEXT) AS discount_text,
    CAST(s.total AS TEXT) AS total_text, s.store_name, s.store_address, s.store_phone, s.store_email,
    s.store_licence_number, s.store_tax_number, s.store_logo, s.store_receipt_footer, s.store_thank_you_note,
    s.customer_id, s.customer_name_snapshot, s.customer_phone_snapshot, s.customer_email_snapshot, s.customer_address_snapshot,
    s.currency_name_snapshot, s.currency_symbol_snapshot, s.currency_decimals_snapshot, s.currency_is_custom_snapshot,
    s.display_mode_snapshot, s.symbol_position_snapshot, s.thousand_sep_snapshot, s.decimal_sep_snapshot,
    CAST(s.promotion_discount AS TEXT) AS promotion_discount_text, CAST(s.loyalty_discount AS TEXT) AS loyalty_discount_text,
    s.loyalty_member_id, s.loyalty_points_earned, s.loyalty_points_redeemed,
    c.name AS legacy_currency_name, c.symbol AS legacy_currency_symbol, c.decimals AS legacy_currency_decimals,
    c.is_custom AS legacy_currency_custom, c.symbol_position AS legacy_currency_position,
    c.thousand_sep AS legacy_thousand_sep, c.decimal_sep AS legacy_decimal_sep
  FROM sales s LEFT JOIN currencies c ON c.code = s.currency_code
`

function normalizeRequest(input: RequestReturnInput): {
  receiptNumber: string
  reason: ReturnReason
  reasonNote: string
  type: ReturnKind
  refundMethod: ReturnPaymentMethod | null
  paymentReference: string
  items: Array<{ saleItemId: string; quantity: string; condition: ReturnItemCondition }>
  overrideReturnWindow: boolean
  windowOverrideReason: string
  idempotencyKey: string | null
} {
  if (!input || typeof input !== 'object') throw new Error('Enter valid return details.')
  const receiptNumber = normalizeReceiptNumber(input.receiptNumber)
  if (!RETURN_REASONS.includes(input.reason)) throw new Error('Choose a valid return reason.')
  if (!RETURN_TYPES.includes(input.type)) throw new Error('Choose Refund, Store credit, or Exchange.')
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > MAX_RETURN_LINES) {
    throw new Error(`Select between 1 and ${MAX_RETURN_LINES} items from the original receipt.`)
  }
  const reasonNote = cleanText(input.reasonNote, 240)
  if (input.reason === 'OTHER' && !reasonNote) throw new Error('Add a short note when the reason is Other.')
  const refundMethod = input.type === 'REFUND'
    ? normalizeRefundMethod(input.refundMethod ?? 'CASH')
    : null
  const paymentReference = input.type === 'REFUND' ? cleanText(input.paymentReference, 120) : ''
  const items = input.items.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('Choose valid returned item details.')
    const saleItemId = normalizeId(item.saleItemId, 'receipt item')
    const quantity = requiredText(item.quantity, 'Return quantity', 24)
    parseQuantityMilli(quantity)
    if (!ITEM_CONDITIONS.includes(item.condition)) throw new Error('Choose a valid item condition and stock disposition.')
    const condition = normalizeConditionForReason(item.condition, input.reason)
    return { saleItemId, quantity, condition }
  })
  const overrideReturnWindow = input.overrideReturnWindow ?? false
  if (typeof overrideReturnWindow !== 'boolean') throw new Error('Return-window override must be yes or no.')
  const windowOverrideReason = cleanText(input.windowOverrideReason, 240)
  if (overrideReturnWindow && !windowOverrideReason) throw new Error('Enter the reason for the Admin return-window override.')
  const idempotencyKey = input.idempotencyKey === undefined || input.idempotencyKey === null || input.idempotencyKey === ''
    ? null : normalizeIdempotencyKey(input.idempotencyKey)
  return {
    receiptNumber, reason: input.reason, reasonNote, type: input.type, refundMethod, paymentReference,
    items, overrideReturnWindow, windowOverrideReason, idempotencyKey,
  }
}

function normalizeConditionForReason(condition: ReturnItemCondition, reason: ReturnReason): ReturnItemCondition {
  if (reason === 'EXPIRED') return 'EXPIRED'
  if (reason === 'DAMAGED') return 'DAMAGED'
  return condition
}

function normalizeRefundMethod(value: unknown): ReturnPaymentMethod {
  if (value !== 'CASH' && value !== 'TRANSFER' && value !== 'CARD') throw new Error('Choose Cash, Transfer, or Card for the refund.')
  return value
}

function normalizeReceiptNumber(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Enter the receipt number.')
  const receipt = value.trim().toUpperCase()
  if (!/^R-[A-Z0-9-]{3,40}$/u.test(receipt)) throw new Error('Enter a valid completed-sale receipt number.')
  return receipt
}

function normalizeReturnId(value: string | number): number {
  const text = String(value)
  if (!/^\d{1,12}$/u.test(text)) throw new Error('Choose a valid return request.')
  const id = Number(text)
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Choose a valid return request.')
  return id
}

function normalizeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\u0000-\u001f]/u.test(value)) {
    throw new Error(`Choose a valid ${label}.`)
  }
  return value.trim()
}

function normalizeIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128 || !/^[A-Za-z0-9._:-]+$/u.test(value)) {
    throw new Error('A valid return request key is required. Try the action again without changing its details.')
  }
  return value
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`Enter a valid ${label.toLowerCase()}.`)
  const normalized = cleanText(value, maxLength)
  if (!normalized) throw new Error(`Enter ${label.toLowerCase()}.`)
  return normalized
}

function cleanText(value: unknown, maxLength: number): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new Error('Enter valid text.')
  const normalized = value.replace(/[\r\n\t\p{C}]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  if (normalized.length > maxLength) throw new Error(`Text must be ${maxLength} characters or fewer.`)
  return normalized
}

function parseQuantityMilli(value: string): bigint {
  if (typeof value !== 'string') throw new Error('Enter a valid return quantity.')
  const match = /^(\d+)(?:\.(\d{0,3}))?$/.exec(value.trim().replace(/[\s\u00a0\u202f]/gu, ''))
  if (!match) throw new Error('Enter a positive quantity with at most three decimal places.')
  const amount = BigInt(match[1]!) * 1000n + BigInt((match[2] ?? '').padEnd(3, '0') || '0')
  assertSqliteInteger(amount, 'Return quantity')
  return amount
}

function isExpiryTracked(item: SaleItemRow, edition: Edition): boolean {
  if (item.expiry_tracking_snapshot === 1 || edition === 'PHARMACY') return true
  if (edition === 'BOTH') return item.current_expiry_tracking === 1
    || item.current_prescription_required === 1 || Boolean(item.current_generic_name)
  return false
}

function effectiveGross(item: SaleItemRow): bigint {
  const saved = BigInt(item.gross_total_text)
  if (saved > 0n || BigInt(item.line_total_text) === 0n) return saved
  return BigInt(item.line_total_text) + BigInt(item.manual_discount_text)
    + BigInt(item.promotion_discount_text) + BigInt(item.loyalty_discount_text)
}

function allocateAmounts(item: SaleItemRow, state: CompletedAllocationState, quantity: bigint): AmountParts {
  const soldQuantity = BigInt(item.quantity_text)
  if (state.quantity + quantity > soldQuantity) throw new Error('A return quantity exceeds the original sale line.')
  return {
    gross: allocationDelta(effectiveGross(item), state.quantity, quantity, soldQuantity, state.amounts.gross),
    manualDiscount: allocationDelta(BigInt(item.manual_discount_text), state.quantity, quantity, soldQuantity, state.amounts.manualDiscount),
    promotionDiscount: allocationDelta(BigInt(item.promotion_discount_text), state.quantity, quantity, soldQuantity, state.amounts.promotionDiscount),
    loyaltyDiscount: allocationDelta(BigInt(item.loyalty_discount_text), state.quantity, quantity, soldQuantity, state.amounts.loyaltyDiscount),
    lineTotal: allocationDelta(BigInt(item.line_total_text), state.quantity, quantity, soldQuantity, state.amounts.lineTotal),
  }
}

function advanceAllocationState(
  state: CompletedAllocationState,
  quantity: bigint,
  amounts: AmountParts,
): CompletedAllocationState {
  return { quantity: state.quantity + quantity, amounts: addAmounts(state.amounts, amounts) }
}

function allocationDelta(total: bigint, alreadyReturned: bigint, quantity: bigint, soldQuantity: bigint, previousAmount: bigint): bigint {
  const nextQuantity = alreadyReturned + quantity
  const target = nextQuantity === soldQuantity ? total : roundHalfUp(total * nextQuantity, soldQuantity)
  return target - previousAmount
}

function proportionalTarget(total: bigint, returnedAmount: bigint, originalAmount: bigint): bigint {
  if (total <= 0n || returnedAmount <= 0n || originalAmount <= 0n) return 0n
  if (returnedAmount >= originalAmount) return total
  return roundHalfUp(total * returnedAmount, originalAmount)
}

function addAmounts(left: AmountParts, right: AmountParts): AmountParts {
  return {
    gross: left.gross + right.gross,
    manualDiscount: left.manualDiscount + right.manualDiscount,
    promotionDiscount: left.promotionDiscount + right.promotionDiscount,
    loyaltyDiscount: left.loyaltyDiscount + right.loyaltyDiscount,
    lineTotal: left.lineTotal + right.lineTotal,
  }
}

function hashRequest(input: ReturnType<typeof normalizeRequest>): string {
  return createHash('sha256').update(JSON.stringify({
    receiptNumber: input.receiptNumber,
    reason: input.reason,
    reasonNote: input.reasonNote,
    type: input.type,
    refundMethod: input.refundMethod,
    paymentReference: input.paymentReference,
    items: input.items,
    overrideReturnWindow: input.overrideReturnWindow,
    windowOverrideReason: input.windowOverrideReason,
  })).digest('hex')
}

function currencyAndDisplay(sale: SaleHeaderRow): { currency: CurrencyDefinition; display: ShopSettings['display'] } {
  const legacy = !sale.currency_name_snapshot
  const currency: CurrencyDefinition = {
    code: sale.currency_code,
    name: sale.currency_name_snapshot || sale.legacy_currency_name || sale.currency_code,
    symbol: sale.currency_symbol_snapshot || sale.legacy_currency_symbol || sale.currency_code,
    decimalPlaces: legacy ? sale.legacy_currency_decimals : sale.currency_decimals_snapshot,
    kind: (sale.currency_is_custom_snapshot === 1 || sale.legacy_currency_custom === 1) ? 'custom' : 'iso',
    symbolPosition: legacy ? sale.legacy_currency_position : sale.symbol_position_snapshot,
    thousandsSeparator: legacy ? sale.legacy_thousand_sep : sale.thousand_sep_snapshot,
    decimalSeparator: legacy ? sale.legacy_decimal_sep : sale.decimal_sep_snapshot,
  }
  if (!getCurrency(currency.code) && !currency.name) currency.name = currency.code
  return {
    currency,
    display: {
      amountDisplay: sale.display_mode_snapshot,
      symbolPosition: currency.symbolPosition,
      thousandsSeparator: currency.thousandsSeparator,
      decimalSeparator: currency.decimalSeparator,
    },
  }
}

function storeFromSale(sale: SaleHeaderRow): ShopProfile {
  return {
    name: sale.store_name,
    address: sale.store_address,
    phone: sale.store_phone,
    email: sale.store_email,
    licenceNumber: sale.store_licence_number,
    taxNumber: sale.store_tax_number,
    storeLogo: sale.store_logo,
    receiptFooter: sale.store_receipt_footer,
    thankYouNote: sale.store_thank_you_note,
  }
}

function writeoffReasonForCondition(condition: ReturnItemCondition): string {
  switch (condition) {
    case 'OPENED': return 'Opened product; not returned to sellable stock.'
    case 'EXPIRED': return 'Expired product; not returned to sellable stock.'
    case 'DAMAGED': return 'Damaged product; written off.'
    case 'OTHER_NON_RESELLABLE': return 'Non-resellable product; written off.'
    case 'RESELLABLE': return ''
  }
}

function validateEdition(edition: Edition): void {
  if (edition !== 'PHARMACY' && edition !== 'SUPERMARKET' && edition !== 'BOTH') {
    throw new Error('A valid licensed edition is required for returns.')
  }
}

function assertSqliteInteger(value: bigint, label: string): void {
  if (value < -MAX_SQLITE_INTEGER || value > MAX_SQLITE_INTEGER) throw new Error(`${label} exceeds the supported SQLite integer range.`)
}
