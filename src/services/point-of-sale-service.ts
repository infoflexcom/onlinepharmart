import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { CurrencyDefinition } from '../currency/catalog'
import { roundHalfUp } from '../currency/money'
import { parseMoneyExact } from '../currency/parse'
import type { Edition } from '../editions'
import type { PublicUser } from '../shared/auth/types'
import type { ShopRepository } from './contracts/shop-repository'
import type { ShopSettings } from '../shared/shop/types'
import type { ShopProfile } from '../shared/shop/types'
import type {
  CompletePosSaleInput,
  CompletePosSaleResult,
  HeldPosCartData,
  HeldPosCartRecord,
  PosCustomerDraft,
  PosCustomerRecord,
  PosPaymentMethod,
  PosPaymentRecord,
  PosQuoteInput,
  PosQuoteRecord,
  PosReceiptRecord,
  PosRecentSaleRecord,
  PosSaleItemRecord,
  ReceiptLayout,
  SaleType,
} from '../shared/pos/types'

const MAX_SQLITE_INTEGER = 9_223_372_036_854_775_807n
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER)
const MAX_SALE_LINES = 100

export interface PointOfSaleServiceOptions {
  workstation?: string
  now?: () => number
  newId?: () => string
}

/** The two limits a cashier cannot cross alone. Both are decided by an Admin, on the Server or from the phone app. */
export type SaleApprovalKind = 'CREDIT' | 'DISCOUNT'

/**
 * Thrown when a sale crosses a limit that an Admin can authorize, instead of a limit nobody can.
 *
 * This is a signal between two parts of this product rather than a message for a person: `completeSale` lets it escape
 * so the host can turn it into an approval request, while `quoteSale` catches it and shows the plain sentence it always
 * showed, because quoting a basket must not file paperwork. Splitting it this way keeps the limit arithmetic in exactly
 * one place — the two entry points differ only in what crossing the limit costs.
 */
export class SaleApprovalRequired extends Error {
  constructor(
    readonly kind: SaleApprovalKind,
    /** How far over the limit the sale is, in integer minor units. Never the whole amount: only the excess is asked for. */
    readonly excessMinor: bigint,
    /** The sentence a person should read. Kept identical to the refusal this replaced. */
    readonly explanation: string,
    /** What the Admin is being shown, so the request says more than "over the limit". */
    readonly detail: Record<string, unknown>,
  ) {
    super(explanation)
    this.name = 'SaleApprovalRequired'
  }
}

/**
 * Asks whether an Admin has already authorized this exact excess.
 *
 * Passed into the calculation rather than reached for globally, so a quote — which has no idempotency key and completes
 * nothing — can never find an override to hide behind.
 */
export type ApprovalOverrideLookup = (kind: SaleApprovalKind, excessMinor: bigint) => boolean

interface ProductRow {
  id: string
  sku: string
  name: string
  unit: string
  is_active: number
  department_id: string | null
  sale_price_text: string
  wholesale_price_text: string
  wholesale_min_text: string
  price_per_kg_text: string | null
  weighed_item: number
  prescription_required: number
  expiry_tracking: number
  generic_name: string
  department_name: string
  category_name: string
  stock_quantity_text: string
  stock_reserved_text: string
  row_version: number
  stock_version: number
  cost_text: string
}

interface CustomerRow {
  id: string
  name: string
  phone: string
  email: string
  address: string
  credit_limit_text: string
  balance_text: string
  row_version: number
  loyalty_member_id: string | null
  loyalty_member_number: string | null
  loyalty_points_balance: number
  loyalty_points_debt: number
  loyalty_row_version: number | null
  loyalty_active: number | null
}

interface SaleInputNormalized {
  idempotencyKey: string
  saleType: SaleType
  items: Array<{ productId: string; quantity: string; manualDiscount: string }>
  payments: Array<{ method: PosPaymentMethod; amount: string; reference: string }>
  customerId: string | null
  loyaltyPointsToRedeem: number
  prescriptionAcknowledged: boolean
  heldCartId: string | null
}

interface QuoteInputNormalized {
  saleType: SaleType
  items: Array<{ productId: string; quantity: string; manualDiscount: string }>
  customerId: string | null
  loyaltyPointsToRedeem: number
}

interface SaleComputation {
  lines: SaleLine[]
  grossSubtotal: bigint
  customer: CustomerRow | null
  promotion: { row: PromotionRow; discountMinor: bigint } | null
  promotionDiscount: bigint
  manualDiscount: bigint
  loyalty: { member: CustomerRow | null; redeemPoints: number; discountMinor: bigint; pointsEarned: number }
  loyaltyDiscount: bigint
  total: bigint
  prescriptionLines: SaleLine[]
}

interface SaleLine {
  product: ProductRow
  quantityMilli: bigint
  priceTier: SaleType
  unitPriceMinor: bigint
  grossMinor: bigint
  manualDiscountMinor: bigint
  promotionDiscountMinor: bigint
  loyaltyDiscountMinor: bigint
  lineTotalMinor: bigint
  prescriptionRequired: boolean
  expiryTracked: boolean
  batches: Array<{ batchId: string; batchNumber: string; expiryDate: string; quantityMilli: bigint }>
  saleItemId: string
}

interface BatchAllocation {
  batchId: string
  batchNumber: string
  expiryDate: string
  quantityMilli: bigint
}

interface PromotionRow {
  id: string
  name: string
  promotion_type: 'FIXED' | 'PERCENT'
  amount_text: string | null
  discount_basis_points: number | null
  product_id: string | null
  department_id: string | null
  minimum_quantity_text: string
  minimum_subtotal_text: string
  starts_at: string
}

interface SaleRow {
  id: number
  receipt_number: string
  sale_type: SaleType
  created_at: string
  currency_code: string
  subtotal_text: string
  discount_text: string
  tax_text: string
  total_text: string
  paid_text: string
  change_text: string
  credit_text: string
  tendered_text: string
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
  cashier_name_snapshot: string
  workstation_snapshot: string
  currency_name_snapshot: string
  currency_symbol_snapshot: string
  currency_decimals_snapshot: number
  currency_is_custom_snapshot: number
  display_mode_snapshot: 'symbol' | 'code'
  symbol_position_snapshot: 'before' | 'after'
  thousand_sep_snapshot: string
  decimal_sep_snapshot: string
  show_powered_by_snapshot: number
  promotion_id: string | null
  promotion_name_snapshot: string
  promotion_discount_text: string
  manual_discount_text: string
  loyalty_member_id: string | null
  loyalty_member_number_snapshot: string
  loyalty_points_earned: number
  loyalty_points_redeemed: number
  loyalty_discount_text: string
  prescription_acknowledged: number
}

export class PointOfSaleService {
  private readonly workstation: string
  private readonly now: () => number
  private readonly newId: () => string

  constructor(
    private readonly database: Database.Database,
    private readonly shop: ShopRepository,
    options: PointOfSaleServiceOptions = {},
  ) {
    this.workstation = cleanText(options.workstation ?? 'LOCAL_DESKTOP', 120) || 'LOCAL_DESKTOP'
    this.now = options.now ?? Date.now
    this.newId = options.newId ?? randomUUID
  }

  quoteSale(
    input: PosQuoteInput,
    actor: PublicUser,
    edition: Edition,
    /**
     * Passed only by a caller that is about to commit something — an order being generated, not a basket being priced.
     * With no lookup the ceiling is simply reported, so the till can show a cashier the total they are typing towards
     * without filing an approval request on every keystroke.
     */
    approvedOverride?: ApprovalOverrideLookup,
  ): PosQuoteRecord {
    validateActor(actor)
    validateEdition(edition)
    const normalized = normalizeQuoteInput(input)
    if (normalized.saleType === 'WHOLESALE' && actor.role !== 'ADMIN' && !actor.permissions.allowWholesale) {
      throw new Error('Your account does not have permission to make wholesale sales.')
    }
    const settings = this.shop.readSettings()
    let quote: SaleComputation
    try {
      quote = this.calculateSale(normalized, actor, edition, settings, approvedOverride)
    } catch (error) {
      // A quote shows the cashier the ceiling; it does not ask an Admin to lift it. Only completing the sale files a
      // request, because only completing it moves money. Without this the till would raise an approval request every
      // time somebody typed a discount into a basket they had not yet decided to sell.
      if (error instanceof SaleApprovalRequired && !approvedOverride) throw new Error(error.explanation)
      throw error
    }
    this.assertStockAvailable(quote.lines, edition)
    return {
      saleType: normalized.saleType,
      currencyCode: settings.currency.code,
      items: quote.lines.map((line) => ({
        productId: line.product.id,
        sku: line.product.sku,
        description: line.product.name,
        unit: line.product.unit,
        quantityMilli: line.quantityMilli,
        priceTier: line.priceTier,
        unitPriceMinor: line.unitPriceMinor,
        grossTotalMinor: line.grossMinor,
        manualDiscountMinor: line.manualDiscountMinor,
        promotionDiscountMinor: line.promotionDiscountMinor,
        loyaltyDiscountMinor: line.loyaltyDiscountMinor,
        lineTotalMinor: line.lineTotalMinor,
        prescriptionRequired: line.prescriptionRequired,
      })),
      subtotalMinor: quote.grossSubtotal,
      promotionName: quote.promotion?.row.name ?? '',
      promotionDiscountMinor: quote.promotionDiscount,
      manualDiscountMinor: quote.manualDiscount,
      loyaltyDiscountMinor: quote.loyaltyDiscount,
      loyaltyPointsToRedeem: quote.loyalty.redeemPoints,
      loyaltyPointsEarned: quote.loyalty.pointsEarned,
      totalMinor: quote.total,
      creditBalanceMinor: quote.customer ? BigInt(quote.customer.balance_text) : 0n,
      creditLimitMinor: quote.customer ? BigInt(quote.customer.credit_limit_text) : 0n,
      warnings: quote.prescriptionLines.map((line) => `Prescription required: ${line.product.name}`),
    }
  }

  completeSale(
    input: CompletePosSaleInput,
    actor: PublicUser,
    edition: Edition,
    /**
     * An extra source of authorization, used by the order workflow.
     *
     * An order's discount may have been approved against the key the picker used to generate it, while the Account
     * paying for it brings a key of their own. Both approvals are the same Admin decision about the same basket, so
     * the caller supplies the other one and the two are OR'd rather than the order workflow having to re-key a request
     * it did not raise. It can only widen what this attempt's own key already allows, never bypass the amount check:
     * the lookup is still asked about one specific excess.
     */
    additionalOverride?: ApprovalOverrideLookup,
  ): CompletePosSaleResult {
    validateActor(actor)
    validateEdition(edition)
    const normalized = normalizeSaleInput(input)
    const requestHash = hashSaleRequest(normalized)
    let saleId = 0
    let replay = false
    /** Whether an Admin has authorized this exact excess for this attempt, from either key. */
    const authorized = (kind: SaleApprovalKind, excessMinor: bigint): boolean => (
      this.hasApprovedOverride(kind, excessMinor, normalized.idempotencyKey, actor)
      || (additionalOverride?.(kind, excessMinor) ?? false)
    )

    this.database.transaction(() => {
      const previous = this.database.prepare(`
        SELECT id, request_hash, cashier_id FROM sales WHERE idempotency_key = ?
      `).get(normalized.idempotencyKey) as { id: number; request_hash: string; cashier_id: string | null } | undefined
      if (previous) {
        if (previous.cashier_id !== actor.id) throw new Error('This checkout key belongs to another cashier.')
        if (previous.request_hash !== requestHash) {
          throw new Error('This idempotency key was already used for a different sale. Start a new checkout.')
        }
        saleId = previous.id
        replay = true
        return
      }
      if (normalized.saleType === 'WHOLESALE' && actor.role !== 'ADMIN' && !actor.permissions.allowWholesale) {
        throw new Error('Your account does not have permission to make wholesale sales.')
      }

      const settings = this.shop.readSettings()
      const storeName = cleanText(settings.profile.name, 120)
      const computation = this.calculateSale({
        saleType: normalized.saleType,
        items: normalized.items,
        customerId: normalized.customerId,
        loyaltyPointsToRedeem: normalized.loyaltyPointsToRedeem,
      }, actor, edition, settings,
      // Bound to this attempt, so the only override the calculation can find is one an Admin approved for this very
      // sale. A quote passes no lookup at all and therefore cannot be pre-authorized.
      authorized,
      )
      const {
        lines, grossSubtotal, customer, promotion, promotionDiscount, manualDiscount,
        loyalty, loyaltyDiscount, total, prescriptionLines,
      } = computation

      if (prescriptionLines.length > 0 && !normalized.prescriptionAcknowledged) {
        const names = [...new Set(prescriptionLines.map((line) => line.product.name))].slice(0, 4).join(', ')
        throw new Error(`Prescription confirmation is required before selling: ${names}.`)
      }

      const tender = calculateTender(normalized.payments, total, settings.currency, settings.display, enabledMethods(settings))
      if (tender.creditMinor > 0n) {
        if (!customer) throw new Error('Select a customer before putting any amount on credit.')
        if (actor.role !== 'ADMIN' && !actor.permissions.allowCreditSales) {
          throw new Error('Your account does not have permission to make credit sales.')
        }
        const creditLimit = BigInt(customer.credit_limit_text)
        const customerBalance = BigInt(customer.balance_text)
        assertSqliteInteger(customerBalance + tender.creditMinor, 'Customer balance')
        if (creditLimit <= 0n || customerBalance + tender.creditMinor > creditLimit) {
          const explanation = 'This sale would exceed the customer’s available credit limit.'
          // With no limit set at all, the whole credit amount is the excess: there is no ceiling to measure against,
          // so the Admin is being asked to authorize the entire amount going on account.
          const excess = creditLimit <= 0n
            ? tender.creditMinor
            : customerBalance + tender.creditMinor - creditLimit
          if (!authorized('CREDIT', excess)) {
            throw new SaleApprovalRequired('CREDIT', excess, explanation, {
              customerId: customer.id,
              customerName: customer.name,
              creditLimitMinor: creditLimit.toString(),
              customerBalanceMinor: customerBalance.toString(),
              requestedCreditMinor: tender.creditMinor.toString(),
              hasCreditLimit: creditLimit > 0n,
            })
          }
        }
      }

      const stockNeeds = aggregateQuantities(lines)

      const openShift = this.database.prepare(`
        SELECT id FROM cashier_shifts
        WHERE cashier_id = ? AND currency_code = ? AND status = 'OPEN'
        ORDER BY opened_at DESC LIMIT 1
      `).get(actor.id, settings.currency.code) as { id: string } | undefined
      const member = loyalty.member
      const saleCreatedAt = this.isoNow()
      const saleResult = this.database.prepare(`
        INSERT INTO sales (
          customer_id, cashier_id, status, currency_code, subtotal, discount, tax, total, paid, change_amount,
          store_name, store_address, store_phone, sale_type, idempotency_key, request_hash,
          cashier_name_snapshot, workstation_snapshot, store_email, store_licence_number, store_tax_number,
          store_logo, store_receipt_footer, store_thank_you_note,
          customer_name_snapshot, customer_phone_snapshot, customer_email_snapshot, customer_address_snapshot,
          currency_name_snapshot, currency_symbol_snapshot, currency_decimals_snapshot, currency_is_custom_snapshot,
          display_mode_snapshot, symbol_position_snapshot, thousand_sep_snapshot, decimal_sep_snapshot,
          promotion_id, promotion_name_snapshot, promotion_discount, manual_discount,
          loyalty_member_id, loyalty_member_number_snapshot, loyalty_points_earned, loyalty_points_redeemed,
          loyalty_discount, credit_amount, total_tendered, prescription_acknowledged, shift_id, created_at,
          show_powered_by_snapshot, order_id, finalized_by
        ) VALUES (
          @customerId, @cashierId, 'COMPLETED', @currencyCode, @subtotal, @discount, 0, @total, @paid, @change,
          @storeName, @storeAddress, @storePhone, @saleType, @idempotencyKey, @requestHash,
          @cashierName, @workstation, @storeEmail, @storeLicenceNumber, @storeTaxNumber,
          @storeLogo, @storeReceiptFooter, @storeThankYouNote,
          @customerName, @customerPhone, @customerEmail, @customerAddress,
          @currencyName, @currencySymbol, @currencyDecimals, @currencyIsCustom,
          @displayMode, @symbolPosition, @thousandSep, @decimalSep,
          @promotionId, @promotionName, @promotionDiscount, @manualDiscount,
          @loyaltyMemberId, @loyaltyMemberNumber, @loyaltyPointsEarned, @loyaltyPointsRedeemed,
          @loyaltyDiscount, @creditAmount, @tendered, @prescriptionAcknowledged, @shiftId, @createdAt,
          @showPoweredBy, @orderId, @finalizedBy
        )
      `).run({
        customerId: customer?.id ?? null,
        cashierId: actor.id,
        // Both NULL for a counter sale the Account built directly, which is most sales. Populated only when a picker's
        // order is being finalized, and only here, because the row cannot be updated once it is COMPLETED.
        orderId: input.orderId ?? null,
        finalizedBy: input.finalizedBy ?? null,
        currencyCode: settings.currency.code,
        subtotal: grossSubtotal,
        discount: promotionDiscount + manualDiscount + loyaltyDiscount,
        total,
        paid: tender.paidMinor,
        change: tender.changeMinor,
        storeName,
        storeAddress: cleanText(settings.profile.address, 240),
        storePhone: cleanText(settings.profile.phone, 160),
        saleType: normalized.saleType,
        idempotencyKey: normalized.idempotencyKey,
        requestHash,
        cashierName: cleanText(actor.fullName, 120),
        workstation: this.workstation,
        storeEmail: cleanText(settings.profile.email, 120),
        storeLicenceNumber: cleanText(settings.profile.licenceNumber, 100),
        storeTaxNumber: cleanText(settings.profile.taxNumber, 100),
        storeLogo: settings.profile.storeLogo ?? null,
        storeReceiptFooter: cleanText(settings.profile.receiptFooter, 300),
        storeThankYouNote: cleanText(settings.profile.thankYouNote, 200),
        showPoweredBy: settings.operational?.showPoweredBy === false ? 0 : 1,
        customerName: customer?.name ?? '',
        customerPhone: customer?.phone ?? '',
        customerEmail: customer?.email ?? '',
        customerAddress: customer?.address ?? '',
        currencyName: settings.currency.name,
        currencySymbol: settings.currency.symbol,
        currencyDecimals: settings.currency.decimalPlaces,
        currencyIsCustom: settings.currency.kind === 'custom' ? 1 : 0,
        displayMode: settings.display.amountDisplay,
        symbolPosition: settings.display.symbolPosition,
        thousandSep: settings.display.thousandsSeparator,
        decimalSep: settings.display.decimalSeparator,
        promotionId: promotion?.row.id ?? null,
        promotionName: promotion?.row.name ?? '',
        promotionDiscount,
        manualDiscount,
        loyaltyMemberId: member?.loyalty_member_id ?? null,
        loyaltyMemberNumber: member?.loyalty_member_number ?? '',
        loyaltyPointsEarned: loyalty.pointsEarned,
        loyaltyPointsRedeemed: loyalty.redeemPoints,
        loyaltyDiscount,
        creditAmount: tender.creditMinor,
        tendered: tender.tenderedMinor,
        prescriptionAcknowledged: prescriptionLines.length > 0 ? 1 : 0,
        shiftId: openShift?.id ?? null,
        createdAt: saleCreatedAt,
      })
      saleId = Number(saleResult.lastInsertRowid)
      const receiptNumber = (this.database.prepare('SELECT receipt_number FROM sales WHERE id = ?').get(saleId) as { receipt_number: string }).receipt_number
      const stockAllocations = new Map<string, BatchAllocation[]>()
      for (const [productId, quantityMilli] of stockNeeds) {
        const product = lines.find((line) => line.product.id === productId)!.product
        stockAllocations.set(productId, this.deductStock(product, quantityMilli, actor, edition, settings.currency.code, receiptNumber, saleCreatedAt))
      }
      distributeBatchAllocations(lines, stockAllocations)

      this.persistSaleLines(lines, saleId)
      this.persistPayments(tender, saleId, settings.currency.code, openShift?.id ?? null)
      this.applyCustomerCredit(customer, tender.creditMinor)
      this.applyLoyalty(loyalty, saleId)
      this.persistSaleBusinessEntry(total, settings)
      this.audit(actor, 'pos.sale.completed', {
        saleId,
        receiptNumber,
        saleType: normalized.saleType,
        currencyCode: settings.currency.code,
        subtotalMinor: grossSubtotal.toString(),
        discountMinor: (promotionDiscount + manualDiscount + loyaltyDiscount).toString(),
        totalMinor: total.toString(),
        paidMinor: tender.paidMinor.toString(),
        creditMinor: tender.creditMinor.toString(),
        changeMinor: tender.changeMinor.toString(),
        itemCount: lines.length,
        idempotencyKey: normalized.idempotencyKey,
        workstation: this.workstation,
        fefoBatches: lines.flatMap((line) => line.batches.map((batch) => ({
          productId: line.product.id,
          batchNumber: batch.batchNumber,
          expiryDate: batch.expiryDate,
          quantityMilli: batch.quantityMilli.toString(),
        }))),
        prescriptionAcknowledged: prescriptionLines.length > 0,
      })
      if (normalized.heldCartId) {
        const deleted = this.database.prepare('DELETE FROM held_carts WHERE id = ? AND user_id = ?').run(normalized.heldCartId, actor.id)
        if (deleted.changes !== 1) throw new Error('The held cart no longer belongs to this cashier. Reload the held-cart list.')
      }
    }).immediate()

    const receipt = this.readReceipt(saleId)
    return { receipt, idempotentReplay: replay }
  }

  listCustomers(actor: PublicUser): PosCustomerRecord[] {
    validateActor(actor)
    return (this.database.prepare(`
      SELECT c.id, c.name, c.phone, c.email, c.address,
        CAST(c.credit_limit AS TEXT) AS credit_limit_text, CAST(c.balance AS TEXT) AS balance_text, c.row_version,
        l.id AS loyalty_member_id, l.member_number AS loyalty_member_number,
        COALESCE(l.points_balance, 0) AS loyalty_points_balance, COALESCE(l.points_debt, 0) AS loyalty_points_debt,
        l.row_version AS loyalty_row_version, l.is_active AS loyalty_active
      FROM customers c
      LEFT JOIN loyalty_members l ON l.customer_id = c.id AND l.is_active = 1
      WHERE c.is_active = 1 ORDER BY c.name COLLATE NOCASE LIMIT 1000
    `).all() as CustomerRow[]).map(mapCustomer)
  }

  createCustomer(input: PosCustomerDraft, actor: PublicUser, edition: Edition): PosCustomerRecord {
    validateActor(actor)
    validateEdition(edition)
    if (actor.role !== 'ADMIN') throw new Error('Only the Admin can create customer accounts and set credit limits.')
    const settings = this.shop.readSettings()
    const name = requiredText(input?.name, 'Customer name', 120)
    const phone = cleanText(input?.phone, 80)
    const email = cleanText(input?.email, 120)
    const address = cleanText(input?.address, 240)
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new Error('Enter a valid customer email address.')
    const creditLimit = parseMoneyExact(input?.creditLimit ?? '0', settings.currency, settings.display)
    assertSqliteInteger(creditLimit, 'Customer credit limit')
    if (creditLimit < 0n) throw new Error('Customer credit limit cannot be negative.')
    if (input?.enrolLoyalty !== undefined && typeof input.enrolLoyalty !== 'boolean') throw new Error('Choose whether to enrol this customer in loyalty.')
    const enrolLoyalty = input.enrolLoyalty === true
    if (enrolLoyalty && !supportsSupermarket(edition)) throw new Error('Loyalty enrolment is available only in the supermarket edition.')
    const id = this.newId()
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO customers (id, name, phone, email, address, credit_limit, balance, is_active)
        VALUES (?, ?, ?, ?, ?, ?, 0, 1)
      `).run(id, name, phone, email, address, creditLimit)
      if (enrolLoyalty) {
        const memberNumber = this.createMemberNumber()
        this.database.prepare(`
          INSERT INTO loyalty_members (id, customer_id, member_number, points_balance, is_active)
          VALUES (?, ?, ?, 0, 1)
        `).run(this.newId(), id, memberNumber)
      }
      this.audit(actor, 'pos.customer.created', { customerId: id, customerName: name, creditLimitMinor: creditLimit.toString(), loyaltyEnrolled: enrolLoyalty })
    }).immediate()
    const customer = this.getCustomerRow(id)
    if (!customer) throw new Error('Customer account could not be loaded after creation.')
    return mapCustomer(customer)
  }

  listRecentSales(actor: PublicUser, limit = 50): PosRecentSaleRecord[] {
    validateActor(actor)
    const safeLimit = Math.max(1, Math.min(100, Number.isInteger(limit) ? limit : 50))
    return (this.database.prepare(`
      SELECT s.id, s.receipt_number, s.sale_type, s.created_at, s.customer_name_snapshot,
        s.cashier_name_snapshot, CAST(s.total AS TEXT) AS total_text, s.currency_code,
        s.currency_name_snapshot, s.currency_symbol_snapshot, s.currency_decimals_snapshot,
        s.currency_is_custom_snapshot, s.display_mode_snapshot, s.symbol_position_snapshot,
        s.thousand_sep_snapshot, s.decimal_sep_snapshot,
        COALESCE(c.name, s.currency_code) AS legacy_currency_name,
        COALESCE(c.symbol, s.currency_code) AS legacy_currency_symbol,
        COALESCE(c.decimals, 2) AS legacy_currency_decimals, COALESCE(c.is_custom, 0) AS legacy_currency_custom,
        COUNT(p.id) AS print_count
      FROM sales s LEFT JOIN sale_print_events p ON p.sale_id = s.id
        LEFT JOIN currencies c ON c.code = s.currency_code
      WHERE s.status = 'COMPLETED'
      GROUP BY s.id ORDER BY s.id DESC LIMIT ?
    `).all(safeLimit) as Array<{
      id: number; receipt_number: string; sale_type: SaleType; created_at: string; customer_name_snapshot: string
      cashier_name_snapshot: string; total_text: string; currency_code: string; print_count: number
      currency_name_snapshot: string; currency_symbol_snapshot: string; currency_decimals_snapshot: number
      currency_is_custom_snapshot: number; display_mode_snapshot: 'symbol' | 'code'; symbol_position_snapshot: 'before' | 'after'
      thousand_sep_snapshot: string; decimal_sep_snapshot: string; legacy_currency_name: string; legacy_currency_symbol: string
      legacy_currency_decimals: number; legacy_currency_custom: number
    }>).map((row) => ({
      id: row.id,
      receiptNumber: row.receipt_number,
      saleType: row.sale_type,
      createdAt: row.created_at,
      customerName: row.customer_name_snapshot,
      cashier: row.cashier_name_snapshot,
      totalMinor: BigInt(row.total_text),
      currencyCode: row.currency_code,
      currency: {
        code: row.currency_code,
        name: row.currency_name_snapshot || row.legacy_currency_name,
        symbol: row.currency_symbol_snapshot || row.legacy_currency_symbol,
        decimalPlaces: row.currency_name_snapshot ? row.currency_decimals_snapshot : row.legacy_currency_decimals,
        kind: (row.currency_is_custom_snapshot === 1 || row.legacy_currency_custom === 1) ? 'custom' : 'iso',
        symbolPosition: row.symbol_position_snapshot,
        thousandsSeparator: row.thousand_sep_snapshot,
        decimalSeparator: row.decimal_sep_snapshot,
      },
      display: {
        amountDisplay: row.display_mode_snapshot,
        symbolPosition: row.symbol_position_snapshot,
        thousandsSeparator: row.thousand_sep_snapshot,
        decimalSeparator: row.decimal_sep_snapshot,
      },
      duplicate: row.print_count > 1,
      printCount: row.print_count,
    }))
  }

  getReceipt(saleId: string | number, actor: PublicUser): PosReceiptRecord {
    validateActor(actor)
    return this.readReceipt(normalizeSaleId(saleId))
  }

  recordReceiptPrint(saleId: string | number, layout: ReceiptLayout, actor: PublicUser): PosReceiptRecord {
    validateActor(actor)
    validateLayout(layout)
    const numericId = normalizeSaleId(saleId)
    let duplicate = false
    let nextPrintCount = 0
    this.database.transaction(() => {
      const sale = this.database.prepare('SELECT id, store_name FROM sales WHERE id = ? AND status = \'COMPLETED\'').get(numericId) as { id: number; store_name: string } | undefined
      if (!sale) throw new Error('The completed sale could not be found.')
      if (!sale.store_name.trim()) throw new Error('Printing is blocked because this sale has no saved store name. Update store details before creating a new sale.')
      const printCount = (this.database.prepare('SELECT COUNT(*) AS count FROM sale_print_events WHERE sale_id = ?').get(numericId) as { count: number }).count
      duplicate = printCount > 0
      nextPrintCount = printCount + 1
      this.database.prepare(`
        INSERT INTO sale_print_events (id, sale_id, printed_by, workstation, document_layout, is_duplicate, printed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(this.newId(), numericId, actor.id, this.workstation, layout, duplicate ? 1 : 0, this.isoNow())
      const receiptNumber = (this.database.prepare('SELECT receipt_number FROM sales WHERE id = ?').get(numericId) as { receipt_number: string }).receipt_number
      this.audit(actor, duplicate ? 'pos.receipt.duplicate_printed' : 'pos.receipt.printed', {
        saleId: numericId, receiptNumber, layout, duplicate, workstation: this.workstation,
      })
    }).immediate()
    return { ...this.readReceipt(numericId), duplicate, printCount: nextPrintCount }
  }

  recordReceiptViewed(saleId: string | number, actor: PublicUser, channel: 'desktop' | 'mobile' = 'desktop'): PosReceiptRecord {
    validateActor(actor)
    const receipt = this.readReceipt(normalizeSaleId(saleId))
    if (channel === 'mobile') this.audit(actor, 'pos.receipt.mobile_viewed', { saleId: receipt.id, receiptNumber: receipt.receiptNumber })
    return receipt
  }

  holdCart(data: HeldPosCartData, actor: PublicUser): HeldPosCartRecord {
    validateActor(actor)
    const normalized = normalizeHeldCartData(data)
    const id = this.newId()
    const createdAt = this.isoNow()
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO held_carts (id, user_id, sale_type, cart_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, actor.id, normalized.saleType, JSON.stringify(normalized), createdAt, createdAt)
      this.audit(actor, 'pos.cart.held', { heldCartId: id, saleType: normalized.saleType, itemCount: normalized.items.length })
    }).immediate()
    return { id, saleType: normalized.saleType, data: normalized, createdAt, updatedAt: createdAt }
  }

  listHeldCarts(actor: PublicUser): HeldPosCartRecord[] {
    validateActor(actor)
    return (this.database.prepare(`
      SELECT id, sale_type, cart_json, created_at, updated_at
      FROM held_carts WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100
    `).all(actor.id) as Array<{ id: string; sale_type: SaleType; cart_json: string; created_at: string; updated_at: string }>).map((row) => ({
      id: row.id,
      saleType: row.sale_type,
      data: parseHeldCartData(row.cart_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  recallHeldCart(id: string, actor: PublicUser): HeldPosCartRecord {
    validateActor(actor)
    const cart = this.database.prepare(`
      SELECT id, sale_type, cart_json, created_at, updated_at
      FROM held_carts WHERE id = ? AND user_id = ?
    `).get(normalizeId(id, 'held cart'), actor.id) as {
      id: string; sale_type: SaleType; cart_json: string; created_at: string; updated_at: string
    } | undefined
    if (!cart) throw new Error('This held cart is unavailable or belongs to another cashier.')
    this.audit(actor, 'pos.cart.recalled', { heldCartId: cart.id })
    return { id: cart.id, saleType: cart.sale_type, data: parseHeldCartData(cart.cart_json), createdAt: cart.created_at, updatedAt: cart.updated_at }
  }

  discardHeldCart(id: string, actor: PublicUser): void {
    validateActor(actor)
    this.database.transaction(() => {
      const result = this.database.prepare('DELETE FROM held_carts WHERE id = ? AND user_id = ?').run(normalizeId(id, 'held cart'), actor.id)
      if (result.changes !== 1) throw new Error('This held cart is unavailable or belongs to another cashier.')
      this.audit(actor, 'pos.cart.discarded', { heldCartId: id })
    }).immediate()
  }

  /**
   * Whether an Admin has already authorized this excess, for this attempt, for this cashier.
   *
   * All four have to match. Matching on the idempotency key alone would let one approval cover every later attempt
   * that reused the key; matching on the amount alone would let an Admin who authorized a small overage be quoted as
   * having authorized a large one. A rejected or still-pending request authorizes nothing, and an approval filed by a
   * different cashier is not this cashier's to spend.
   *
   * The request is read straight from `approval_requests` rather than through `ApprovalQueueService`: this service
   * already reads `sales`, `customers` and `stock` directly, and depending on the queue here would make two services
   * that each construct the other's database calls.
   */
  /**
   * Public because the order workflow has to ask the same question. An order's discount is snapshotted when the picker
   * generates it and re-checked when an Account takes payment, so both moments consult the Admin's decision — and
   * there must be one rule for what counts as approved, not one per caller.
   */
  hasApprovedOverride(
    kind: SaleApprovalKind,
    excessMinor: bigint,
    idempotencyKey: string,
    actor: PublicUser,
  ): boolean {
    const rows = this.database.prepare(`
      SELECT payload_json FROM approval_requests
      WHERE request_type = ? AND status = 'APPROVED' AND requested_by = ?
    `).all(kind, actor.id) as Array<{ payload_json: string }>
    for (const row of rows) {
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(row.payload_json) as Record<string, unknown>
      } catch {
        // A payload this service cannot read cannot authorize anything. Skipping it is the safe direction: the sale is
        // refused and the cashier is told to ask again, rather than an unreadable row being treated as consent.
        continue
      }
      if (payload.idempotencyKey !== idempotencyKey) continue
      // Compared as strings of the same bigint, so 500 and 500.0 and "500" cannot be argued into being equal.
      if (String(payload.excessMinor ?? '') !== excessMinor.toString()) continue
      return true
    }
    return false
  }

  private calculateSale(
    input: QuoteInputNormalized,
    actor: PublicUser,
    edition: Edition,
    settings: ReturnType<ShopRepository['readSettings']>,
    /** Present only when a sale is being completed. A quote passes nothing and so can never be pre-authorized. */
    approvedOverride?: ApprovalOverrideLookup,
  ): SaleComputation {
    const lines = input.items.map((item) => this.priceSaleLine(item, input.saleType, settings.currency, settings.display, edition))
    const grossSubtotal = lines.reduce((total, line) => total + line.grossMinor, 0n)
    assertSqliteInteger(grossSubtotal, 'Sale subtotal')
    const customer = input.customerId ? this.getCustomerRow(input.customerId) : null
    if (input.customerId && (!customer || !this.isCustomerActive(input.customerId))) {
      throw new Error('The selected customer is unavailable. Refresh the customer list and try again.')
    }
    const promotion = supportsSupermarket(edition) ? this.choosePromotion(lines) : null
    const promotionDiscount = promotion?.discountMinor ?? 0n
    allocateDiscount(lines, promotionDiscount, (line) => this.promotionEligible(line.product, promotion?.row ?? null), 'promotion')
    for (const line of lines) {
      if (line.manualDiscountMinor < 0n || line.manualDiscountMinor > line.grossMinor - line.promotionDiscountMinor) {
        throw new Error(`The discount for ${line.product.name} cannot exceed its remaining line total.`)
      }
      line.lineTotalMinor -= line.manualDiscountMinor
    }
    const manualDiscount = lines.reduce((total, line) => total + line.manualDiscountMinor, 0n)
    // The stricter of two ceilings applies: the cashier's permission and the shop-wide limit from Settings.
    const shopLimit = shopDiscountLimit(settings)
    const actorLimit = actor.role === 'ADMIN' ? 10_000 : actor.permissions.maxDiscountBasisPoints
    const limitBasisPoints = Math.min(actorLimit, shopLimit)
    const maximumDiscount = (grossSubtotal * BigInt(limitBasisPoints)) / 10_000n
    if (manualDiscount > maximumDiscount) {
      const limit = limitBasisPoints / 100
      const byShopLimit = limitBasisPoints === shopLimit && shopLimit < actorLimit
      const explanation = byShopLimit
        ? `This sale's manual discount exceeds the ${limit}% shop limit set in Settings.`
        : `This sale's manual discount exceeds your ${limit}% permission limit.`
      const excess = manualDiscount - maximumDiscount
      // Changed in Phase 18: this used to be a flat refusal, and a cashier who hit it had one option — take the
      // discount off and overcharge the customer. The brief wants the Admin asked instead, so the excess is what gets
      // authorized: approving a 500 discount must not blanket-authorize a 5,000 one on the next attempt.
      if (!approvedOverride?.('DISCOUNT', excess)) {
        throw new SaleApprovalRequired('DISCOUNT', excess, explanation, {
          requestedDiscountMinor: manualDiscount.toString(),
          allowedDiscountMinor: maximumDiscount.toString(),
          limitBasisPoints,
          limitPercent: limit,
          setBy: byShopLimit ? 'SHOP_SETTINGS' : 'USER_PERMISSION',
          subtotalMinor: grossSubtotal.toString(),
          saleType: input.saleType,
        })
      }
    }

    let beforeLoyalty = grossSubtotal - promotionDiscount - manualDiscount
    const loyalty = supportsSupermarket(edition)
      ? this.computeLoyalty(customer, input.loyaltyPointsToRedeem, beforeLoyalty, settings.currency)
      : { member: null, redeemPoints: 0, discountMinor: 0n, pointsEarned: 0 }
    if (input.loyaltyPointsToRedeem > 0 && !loyalty.member) {
      throw new Error('Loyalty redemption requires an active member linked to the selected customer.')
    }
    const loyaltyDiscount = loyalty.discountMinor
    if (loyaltyDiscount > beforeLoyalty) throw new Error('The selected loyalty reward exceeds the remaining sale amount.')
    allocateDiscount(lines, loyaltyDiscount, (line) => line.lineTotalMinor > 0n, 'loyalty')
    beforeLoyalty -= loyaltyDiscount
    if (loyalty.member) {
      const scale = 10n ** BigInt(settings.currency.decimalPlaces)
      const earned = beforeLoyalty / scale
      if (earned > MAX_SAFE_INTEGER) throw new Error('This sale would earn more loyalty points than the application can safely store.')
      loyalty.pointsEarned = Number(earned)
    }
    assertSqliteInteger(beforeLoyalty, 'Sale total')
    const prescriptionLines = lines.filter((line) => line.prescriptionRequired)
    return {
      lines,
      grossSubtotal,
      customer,
      promotion,
      promotionDiscount,
      manualDiscount,
      loyalty,
      loyaltyDiscount,
      total: beforeLoyalty,
      prescriptionLines,
    }
  }

  private assertStockAvailable(lines: SaleLine[], edition: Edition): void {
    for (const [productId, quantityMilli] of aggregateQuantities(lines)) {
      const product = lines.find((line) => line.product.id === productId)!.product
      const stock = this.database.prepare(`
        SELECT CAST(quantity_milli AS TEXT) AS quantity_text, CAST(reserved_milli AS TEXT) AS reserved_text
        FROM stock WHERE product_id = ?
      `).get(productId) as { quantity_text: string; reserved_text: string } | undefined
      if (!stock || BigInt(stock.quantity_text) - BigInt(stock.reserved_text) < quantityMilli) {
        throw new Error(`There is not enough available stock of ${product.name} to complete this sale.`)
      }
      if (requiresExpiryTracking(product, edition)) {
        const today = new Date(this.now()).toISOString().slice(0, 10)
        const sellable = this.database.prepare(`
          SELECT CAST(COALESCE(SUM(quantity_milli), 0) AS TEXT) AS quantity_text
          FROM product_batches WHERE product_id = ? AND quantity_milli > 0 AND expiry_date >= ?
        `).get(productId, today) as { quantity_text: string }
        if (BigInt(sellable.quantity_text) < quantityMilli) {
          throw new Error(`Sale blocked: ${product.name} does not have enough unexpired batch stock. Expired stock is not sellable.`)
        }
      }
    }
  }

  private priceSaleLine(
    item: SaleInputNormalized['items'][number],
    saleType: SaleType,
    currency: CurrencyDefinition,
    display: ReturnType<ShopRepository['readSettings']>['display'],
    edition: Edition,
  ): SaleLine {
    const product = this.getProduct(item.productId)
    if (!product || product.is_active !== 1) throw new Error('A product in this cart is inactive or no longer exists. Refresh the POS catalog.')
    const quantityMilli = parseQuantityMilli(item.quantity)
    if (quantityMilli <= 0n) throw new Error(`Enter a positive quantity for ${product.name}.`)
    const isWeighed = supportsSupermarket(edition) && product.weighed_item === 1
    if (saleType === 'WHOLESALE') {
      if (isWeighed) throw new Error(`${product.name} is weighed and cannot be sold on the wholesale price tier.`)
      if (BigInt(product.wholesale_min_text) > 0n && quantityMilli < BigInt(product.wholesale_min_text)) {
        throw new Error(`${product.name} requires a wholesale quantity of at least ${formatQuantity(BigInt(product.wholesale_min_text))}.`)
      }
    }
    const unitPriceMinor = isWeighed
      ? product.price_per_kg_text === null ? null : BigInt(product.price_per_kg_text)
      : BigInt(saleType === 'WHOLESALE' ? product.wholesale_price_text : product.sale_price_text)
    if (unitPriceMinor === null) throw new Error(`${product.name} needs a price per kilogram before it can be sold by weight.`)
    if (saleType === 'WHOLESALE' && unitPriceMinor <= 0n) throw new Error(`A wholesale price has not been configured for ${product.name}.`)
    const grossMinor = roundHalfUp(unitPriceMinor * quantityMilli, 1000n)
    assertSqliteInteger(grossMinor, `${product.name} line total`)
    const manualDiscountMinor = item.manualDiscount ? parseMoneyExact(item.manualDiscount, currency, display) : 0n
    assertSqliteInteger(manualDiscountMinor, `${product.name} discount`)
    if (manualDiscountMinor < 0n) throw new Error(`The discount for ${product.name} cannot be negative.`)
    return {
      product,
      quantityMilli,
      priceTier: saleType,
      unitPriceMinor,
      grossMinor,
      manualDiscountMinor,
      promotionDiscountMinor: 0n,
      loyaltyDiscountMinor: 0n,
      lineTotalMinor: grossMinor,
      prescriptionRequired: product.prescription_required === 1 && supportsPharmacy(edition),
      expiryTracked: requiresExpiryTracking(product, edition),
      batches: [],
      saleItemId: this.newId(),
    }
  }

  private choosePromotion(lines: SaleLine[]): { row: PromotionRow; discountMinor: bigint } | null {
    const now = new Date(this.now()).toISOString()
    const rows = this.database.prepare(`
      SELECT id, name, promotion_type, CAST(amount_minor AS TEXT) AS amount_text, discount_basis_points,
        product_id, department_id, CAST(minimum_quantity_milli AS TEXT) AS minimum_quantity_text,
        CAST(minimum_subtotal AS TEXT) AS minimum_subtotal_text, starts_at
      FROM promotions
      WHERE is_active = 1 AND datetime(starts_at) <= datetime(?) AND datetime(ends_at) >= datetime(?)
      ORDER BY starts_at ASC, name COLLATE NOCASE, id
    `).all(now, now) as PromotionRow[]
    const candidates = rows.map((row) => {
      const eligible = lines.filter((line) => this.promotionEligible(line.product, row))
      const eligibleGross = eligible.reduce((sum, line) => sum + line.grossMinor, 0n)
      const eligibleQuantity = eligible.reduce((sum, line) => sum + line.quantityMilli, 0n)
      if (eligibleGross <= 0n || eligibleQuantity < BigInt(row.minimum_quantity_text) || eligibleGross < BigInt(row.minimum_subtotal_text)) return null
      let amount = row.promotion_type === 'FIXED'
        ? BigInt(row.amount_text ?? '0')
        : roundHalfUp(eligibleGross * BigInt(row.discount_basis_points ?? 0), 10_000n)
      if (amount > eligibleGross) amount = eligibleGross
      return { row, discountMinor: amount, eligibleGross }
    }).filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null && candidate.discountMinor > 0n)
    if (!candidates.length) return null
    candidates.sort((left, right) => left.discountMinor === right.discountMinor
      ? left.row.name.localeCompare(right.row.name) || left.row.id.localeCompare(right.row.id)
      : left.discountMinor > right.discountMinor ? -1 : 1)
    const selected = candidates[0]!
    return { row: selected.row, discountMinor: selected.discountMinor }
  }

  private promotionEligible(product: ProductRow, promotion: PromotionRow | null): boolean {
    if (!promotion) return false
    return (!promotion.product_id || promotion.product_id === product.id)
      && (!promotion.department_id || promotion.department_id === product.department_id)
  }

  private computeLoyalty(
    customer: CustomerRow | null,
    requestedPoints: number,
    amountBeforeReward: bigint,
    currency: CurrencyDefinition,
  ): { member: CustomerRow | null; redeemPoints: number; discountMinor: bigint; pointsEarned: number } {
    const member = customer?.loyalty_member_id && customer.loyalty_active === 1 ? customer : null
    if (member && (!Number.isSafeInteger(member.loyalty_points_balance) || member.loyalty_points_balance < 0)) {
      throw new Error('The loyalty balance exceeds the supported whole-number range. Contact an Admin before continuing.')
    }
    if (requestedPoints > 0 && !member) throw new Error('Loyalty redemption requires an active member linked to the selected customer.')
    if (requestedPoints > 0 && (!Number.isSafeInteger(requestedPoints) || requestedPoints < 0)) {
      throw new Error('Enter a whole-number loyalty points amount.')
    }
    if (member && requestedPoints > member.loyalty_points_balance) throw new Error('The loyalty member does not have enough points.')
    const scale = 10n ** BigInt(currency.decimalPlaces)
    if (requestedPoints > 0 && currency.decimalPlaces < 2 && requestedPoints % 100 !== 0) {
      throw new Error('For a zero- or one-decimal currency, redeem loyalty points in multiples of 100.')
    }
    const discountMinor = currency.decimalPlaces >= 2
      ? BigInt(requestedPoints) * (scale / 100n)
      : BigInt(requestedPoints / 100) * scale
    if (discountMinor > amountBeforeReward) throw new Error('The selected loyalty reward exceeds the remaining sale amount.')
    return { member, redeemPoints: requestedPoints, discountMinor, pointsEarned: 0 }
  }

  private deductStock(
    product: ProductRow,
    quantityMilli: bigint,
    actor: PublicUser,
    edition: Edition,
    currencyCode: string,
    receiptNumber: string,
    createdAt: string,
  ): BatchAllocation[] {
    const stock = this.database.prepare(`
      SELECT CAST(quantity_milli AS TEXT) AS quantity_text, CAST(reserved_milli AS TEXT) AS reserved_text
      FROM stock WHERE product_id = ?
    `).get(product.id) as { quantity_text: string; reserved_text: string } | undefined
    if (!stock || BigInt(stock.quantity_text) - BigInt(stock.reserved_text) < quantityMilli) {
      throw new Error(`There is not enough available stock of ${product.name} to complete this sale.`)
    }

    const allocations: BatchAllocation[] = []
    if (requiresExpiryTracking(product, edition)) {
      const today = new Date(this.now()).toISOString().slice(0, 10)
      const batches = this.database.prepare(`
        SELECT id, batch_no, expiry_date, CAST(quantity_milli AS TEXT) AS quantity_text, row_version
        FROM product_batches
        WHERE product_id = ? AND quantity_milli > 0 AND expiry_date >= ?
        ORDER BY expiry_date ASC, created_at ASC, id ASC
      `).all(product.id, today) as Array<{ id: string; batch_no: string; expiry_date: string; quantity_text: string; row_version: number }>
      const sellable = batches.reduce((sum, batch) => sum + BigInt(batch.quantity_text), 0n)
      if (sellable < quantityMilli) {
        throw new Error(`Sale blocked: ${product.name} does not have enough unexpired batch stock. Expired stock is not sellable.`)
      }
      let remaining = quantityMilli
      for (const batch of batches) {
        if (remaining === 0n) break
        const available = BigInt(batch.quantity_text)
        const take = available < remaining ? available : remaining
        const result = this.database.prepare(`
          UPDATE product_batches SET quantity_milli = quantity_milli - ?, row_version = row_version + 1
          WHERE id = ? AND row_version = ? AND quantity_milli >= ?
        `).run(take, batch.id, batch.row_version, take)
        if (result.changes !== 1) throw new Error('Batch stock changed during checkout. Refresh the cart and try again.')
        allocations.push({ batchId: batch.id, batchNumber: batch.batch_no, expiryDate: batch.expiry_date, quantityMilli: take })
        remaining -= take
      }
    }

    const update = this.database.prepare(`
      UPDATE stock SET quantity_milli = quantity_milli - ?, row_version = row_version + 1, updated_at = ?
      WHERE product_id = ? AND quantity_milli >= reserved_milli + ?
    `).run(quantityMilli, this.isoNow(), product.id, quantityMilli)
    if (update.changes !== 1) throw new Error(`Stock of ${product.name} changed during checkout. Refresh the cart and try again.`)

    this.database.prepare(`
      INSERT INTO stock_movements (
        id, product_id, movement_type, reference_type, reference_id, quantity_delta_milli,
        unit_cost, currency_code, created_by, adjustment_reason, created_at
      ) VALUES (?, ?, 'SALE', 'SALE', ?, ?, ?, ?, ?, '', ?)
    `).run(this.newId(), product.id, receiptNumber, -quantityMilli, BigInt(product.cost_text), currencyCode, actor.id, createdAt)
    return allocations
  }

  private persistSaleLines(lines: SaleLine[], saleId: number): void {
    const insertItem = this.database.prepare(`
      INSERT INTO sale_items (
        id, sale_id, product_id, description_snapshot, quantity_milli, unit_price, discount, tax, line_total,
        price_tier, gross_total, manual_discount, promotion_discount, loyalty_discount,
        product_sku_snapshot, unit_snapshot, prescription_required, expiry_tracking_snapshot,
        department_snapshot, category_snapshot, generic_name_snapshot
      ) VALUES (
        @id, @saleId, @productId, @description, @quantity, @unitPrice, @discount, 0, @lineTotal,
        @priceTier, @gross, @manualDiscount, @promotionDiscount, @loyaltyDiscount,
        @sku, @unit, @prescriptionRequired, @expiryTracked, @department, @category, @genericName
      )
    `)
    const insertBatch = this.database.prepare(`
      INSERT INTO sale_item_batches (sale_item_id, batch_id, batch_number_snapshot, expiry_date_snapshot, quantity_milli)
      VALUES (?, ?, ?, ?, ?)
    `)
    for (const line of lines) {
      const discountMinor = line.manualDiscountMinor + line.promotionDiscountMinor + line.loyaltyDiscountMinor
      insertItem.run({
        id: line.saleItemId,
        saleId,
        productId: line.product.id,
        description: line.product.name,
        quantity: line.quantityMilli,
        unitPrice: line.unitPriceMinor,
        discount: discountMinor,
        lineTotal: line.lineTotalMinor,
        priceTier: line.priceTier,
        gross: line.grossMinor,
        manualDiscount: line.manualDiscountMinor,
        promotionDiscount: line.promotionDiscountMinor,
        loyaltyDiscount: line.loyaltyDiscountMinor,
        sku: line.product.sku,
        unit: line.product.unit,
        prescriptionRequired: line.prescriptionRequired ? 1 : 0,
        expiryTracked: line.expiryTracked ? 1 : 0,
        department: line.product.department_name,
        category: line.product.category_name,
        genericName: line.product.generic_name,
      })
      for (const batch of line.batches) {
        insertBatch.run(line.saleItemId, batch.batchId, batch.batchNumber, batch.expiryDate, batch.quantityMilli)
      }
    }
  }

  private persistPayments(tender: CalculatedTender, saleId: number, currencyCode: string, shiftId: string | null): void {
    const insert = this.database.prepare(`
      INSERT INTO payments (
        id, sale_id, return_id, payment_method, amount, currency_code, reference,
        tendered_amount, change_amount, shift_id
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const payment of tender.records) {
      insert.run(this.newId(), saleId, payment.method, payment.amountMinor, currencyCode,
        payment.reference, payment.tenderedMinor, payment.changeMinor, shiftId)
    }
    if (tender.creditMinor > 0n) {
      insert.run(this.newId(), saleId, 'CREDIT', tender.creditMinor, currencyCode, '', 0n, 0n, shiftId)
    }
  }

  private applyCustomerCredit(customer: CustomerRow | null, creditMinor: bigint): void {
    if (creditMinor <= 0n || !customer) return
    const result = this.database.prepare(`
      UPDATE customers SET balance = balance + ?, row_version = row_version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND row_version = ? AND is_active = 1
    `).run(creditMinor, customer.id, customer.row_version)
    if (result.changes !== 1) throw new Error('The customer account changed during checkout. Refresh the customer list and try again.')
  }

  private applyLoyalty(
    loyalty: { member: CustomerRow | null; redeemPoints: number; discountMinor: bigint; pointsEarned: number },
    saleId: number,
  ): void {
    if (!loyalty.member || (loyalty.redeemPoints === 0 && loyalty.pointsEarned === 0)) return
    const member = loyalty.member
    if (!Number.isSafeInteger(member.loyalty_points_debt) || member.loyalty_points_debt < 0) {
      throw new Error('The loyalty return balance exceeds the supported whole-number range.')
    }
    const earnedPoints = BigInt(loyalty.pointsEarned)
    const currentDebt = BigInt(member.loyalty_points_debt)
    const debtPaid = earnedPoints < currentDebt ? earnedPoints : currentDebt
    const availableEarned = earnedPoints - debtPaid
    const nextBalance = BigInt(member.loyalty_points_balance) - BigInt(loyalty.redeemPoints) + availableEarned
    const nextDebt = currentDebt - debtPaid
    if (nextBalance < 0n || nextBalance > MAX_SAFE_INTEGER || nextDebt > MAX_SAFE_INTEGER) {
      throw new Error('The loyalty balance would exceed the supported whole-number range.')
    }
    const result = this.database.prepare(`
      UPDATE loyalty_members
      SET points_balance = points_balance - ? + ?, points_debt = points_debt - ?, row_version = row_version + 1
      WHERE id = ? AND row_version = ? AND points_balance >= ? AND points_debt >= ? AND is_active = 1
    `).run(loyalty.redeemPoints, availableEarned, debtPaid, member.loyalty_member_id,
      member.loyalty_row_version, loyalty.redeemPoints, debtPaid)
    if (result.changes !== 1) throw new Error('Loyalty points changed during checkout. Refresh the customer and try again.')
    if (loyalty.redeemPoints > 0) {
      this.database.prepare(`
        INSERT INTO loyalty_transactions (id, loyalty_member_id, sale_id, points_delta, transaction_type)
        VALUES (?, ?, ?, ?, 'REDEEM')
      `).run(this.newId(), member.loyalty_member_id, saleId, -loyalty.redeemPoints)
    }
    if (loyalty.pointsEarned > 0) {
      this.database.prepare(`
        INSERT INTO loyalty_transactions (id, loyalty_member_id, sale_id, points_delta, transaction_type)
        VALUES (?, ?, ?, ?, 'EARN')
      `).run(this.newId(), member.loyalty_member_id, saleId, loyalty.pointsEarned)
    }
    if (debtPaid > 0n) {
      this.database.prepare(`
        INSERT INTO loyalty_transactions (id, loyalty_member_id, sale_id, points_delta, transaction_type)
        VALUES (?, ?, ?, ?, 'ADJUST')
      `).run(this.newId(), member.loyalty_member_id, saleId, -debtPaid)
    }
  }

  private persistSaleBusinessEntry(
    totalMinor: bigint,
    settings: ReturnType<ShopRepository['readSettings']>,
  ): void {
    this.database.prepare(`
      INSERT INTO business_entries (
        id, kind, currency_code, amount_minor, store_name_snapshot, store_address_snapshot, store_phone_snapshot, created_at
      ) VALUES (?, 'sale', ?, ?, ?, ?, ?, ?)
    `).run(this.newId(), settings.currency.code, totalMinor, settings.profile.name,
      settings.profile.address, settings.profile.phone, this.isoNow())
  }

  private readReceipt(saleId: number): PosReceiptRecord {
    const row = this.database.prepare(`
      SELECT s.id, s.receipt_number, s.sale_type, s.created_at, s.currency_code,
        CAST(s.subtotal AS TEXT) AS subtotal_text, CAST(s.discount AS TEXT) AS discount_text,
        CAST(s.tax AS TEXT) AS tax_text, CAST(s.total AS TEXT) AS total_text,
        CAST(s.paid AS TEXT) AS paid_text, CAST(s.change_amount AS TEXT) AS change_text,
        CAST(s.credit_amount AS TEXT) AS credit_text, CAST(s.total_tendered AS TEXT) AS tendered_text,
        s.store_name, s.store_address, s.store_phone, s.store_email, s.store_licence_number, s.store_tax_number,
        s.store_logo, s.store_receipt_footer, s.store_thank_you_note, s.customer_id,
        s.customer_name_snapshot, s.customer_phone_snapshot, s.customer_email_snapshot, s.customer_address_snapshot,
        s.cashier_name_snapshot, s.workstation_snapshot, s.currency_name_snapshot, s.currency_symbol_snapshot,
        s.currency_decimals_snapshot, s.currency_is_custom_snapshot, s.display_mode_snapshot,
        s.symbol_position_snapshot, s.thousand_sep_snapshot, s.decimal_sep_snapshot,
        s.show_powered_by_snapshot,
        s.promotion_id, s.promotion_name_snapshot, CAST(s.promotion_discount AS TEXT) AS promotion_discount_text,
        CAST(s.manual_discount AS TEXT) AS manual_discount_text, s.loyalty_member_id,
        s.loyalty_member_number_snapshot, s.loyalty_points_earned, s.loyalty_points_redeemed,
        CAST(s.loyalty_discount AS TEXT) AS loyalty_discount_text, s.prescription_acknowledged,
        COALESCE(c.name, '') AS legacy_currency_name, COALESCE(c.symbol, '') AS legacy_currency_symbol,
        COALESCE(c.decimals, 2) AS legacy_currency_decimals, COALESCE(c.is_custom, 0) AS legacy_currency_custom
      FROM sales s LEFT JOIN currencies c ON c.code = s.currency_code
      WHERE s.id = ? AND s.status = 'COMPLETED'
    `).get(saleId) as SaleRow & {
      legacy_currency_name: string; legacy_currency_symbol: string; legacy_currency_decimals: number; legacy_currency_custom: number
    } | undefined
    if (!row) throw new Error('The completed sale could not be found.')

    const itemRows = this.database.prepare(`
      SELECT id, product_id, product_sku_snapshot, description_snapshot, unit_snapshot,
        CAST(quantity_milli AS TEXT) AS quantity_text, price_tier, CAST(unit_price AS TEXT) AS unit_price_text,
        CAST(gross_total AS TEXT) AS gross_text, CAST(manual_discount AS TEXT) AS manual_discount_text,
        CAST(promotion_discount AS TEXT) AS promotion_discount_text, CAST(loyalty_discount AS TEXT) AS loyalty_discount_text,
        CAST(discount AS TEXT) AS discount_text, CAST(tax AS TEXT) AS tax_text,
        CAST(line_total AS TEXT) AS line_total_text, prescription_required
      FROM sale_items WHERE sale_id = ? ORDER BY rowid
    `).all(saleId) as Array<{
      id: string; product_id: string; product_sku_snapshot: string; description_snapshot: string; unit_snapshot: string
      quantity_text: string; price_tier: SaleType; unit_price_text: string; gross_text: string; manual_discount_text: string
      promotion_discount_text: string; loyalty_discount_text: string; discount_text: string; tax_text: string; line_total_text: string
      prescription_required: number
    }>
    const itemBatches = this.database.prepare(`
      SELECT sale_item_id, batch_id, batch_number_snapshot, expiry_date_snapshot, CAST(quantity_milli AS TEXT) AS quantity_text
      FROM sale_item_batches WHERE sale_item_id = ?
    `)
    const items: PosSaleItemRecord[] = itemRows.map((item) => ({
      id: item.id,
      productId: item.product_id,
      sku: item.product_sku_snapshot,
      description: item.description_snapshot,
      unit: item.unit_snapshot,
      quantityMilli: BigInt(item.quantity_text),
      priceTier: item.price_tier,
      unitPriceMinor: BigInt(item.unit_price_text),
      grossTotalMinor: BigInt(item.gross_text),
      manualDiscountMinor: BigInt(item.manual_discount_text),
      promotionDiscountMinor: BigInt(item.promotion_discount_text),
      loyaltyDiscountMinor: BigInt(item.loyalty_discount_text),
      discountMinor: BigInt(item.discount_text),
      taxMinor: BigInt(item.tax_text),
      lineTotalMinor: BigInt(item.line_total_text),
      prescriptionRequired: item.prescription_required === 1,
      batches: (itemBatches.all(item.id) as Array<{
        batch_id: string; batch_number_snapshot: string; expiry_date_snapshot: string; quantity_text: string
      }>).map((batch) => ({
        batchId: batch.batch_id,
        batchNumber: batch.batch_number_snapshot,
        expiryDate: batch.expiry_date_snapshot,
        quantityMilli: BigInt(batch.quantity_text),
      })),
    }))

    const paymentRows = this.database.prepare(`
      SELECT id, payment_method, CAST(amount AS TEXT) AS amount_text, CAST(tendered_amount AS TEXT) AS tendered_text,
        CAST(change_amount AS TEXT) AS change_text, currency_code, reference
      FROM payments WHERE sale_id = ? ORDER BY created_at, rowid
    `).all(saleId) as Array<{
      id: string; payment_method: PosPaymentMethod; amount_text: string; tendered_text: string; change_text: string
      currency_code: string; reference: string
    }>
    const payments: PosPaymentRecord[] = paymentRows.map((payment) => ({
      id: payment.id,
      method: payment.payment_method,
      amountMinor: BigInt(payment.amount_text),
      tenderedMinor: BigInt(payment.tendered_text),
      changeMinor: BigInt(payment.change_text),
      currencyCode: payment.currency_code,
      reference: payment.reference,
    }))
    const printCount = (this.database.prepare('SELECT COUNT(*) AS count FROM sale_print_events WHERE sale_id = ?').get(saleId) as { count: number }).count
    const currency: CurrencyDefinition = {
      code: row.currency_code,
      name: row.currency_name_snapshot || row.legacy_currency_name || row.currency_code,
      symbol: row.currency_symbol_snapshot || row.legacy_currency_symbol || row.currency_code,
      decimalPlaces: row.currency_name_snapshot ? row.currency_decimals_snapshot : row.legacy_currency_decimals,
      kind: (row.currency_is_custom_snapshot === 1 || row.legacy_currency_custom === 1) ? 'custom' : 'iso',
      symbolPosition: row.symbol_position_snapshot,
      thousandsSeparator: row.thousand_sep_snapshot,
      decimalSeparator: row.decimal_sep_snapshot,
    }
    const display = {
      amountDisplay: row.display_mode_snapshot,
      symbolPosition: row.symbol_position_snapshot,
      thousandsSeparator: row.thousand_sep_snapshot,
      decimalSeparator: row.decimal_sep_snapshot,
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
    const warnings = items.filter((item) => item.prescriptionRequired).map((item) => `Prescription required: ${item.description}`)
    const promotionDiscountMinor = BigInt(row.promotion_discount_text)
    const manualDiscountMinor = BigInt(row.manual_discount_text)
    const loyaltyDiscountMinor = BigInt(row.loyalty_discount_text)
    return {
      id: row.id,
      receiptNumber: row.receipt_number,
      status: 'COMPLETED',
      saleType: row.sale_type,
      createdAt: row.created_at,
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
      cashier: row.cashier_name_snapshot,
      workstation: row.workstation_snapshot,
      items,
      payments,
      subtotalMinor: BigInt(row.subtotal_text),
      promotionDiscountMinor,
      promotionName: row.promotion_name_snapshot,
      manualDiscountMinor,
      loyaltyDiscountMinor,
      loyaltyPointsEarned: row.loyalty_points_earned,
      loyaltyPointsRedeemed: row.loyalty_points_redeemed,
      discountMinor: BigInt(row.discount_text),
      taxMinor: BigInt(row.tax_text),
      totalMinor: BigInt(row.total_text),
      paidMinor: BigInt(row.paid_text),
      creditMinor: BigInt(row.credit_text),
      tenderedMinor: BigInt(row.tendered_text),
      changeMinor: BigInt(row.change_text),
      prescriptionAcknowledged: row.prescription_acknowledged === 1,
      warnings,
      duplicate: printCount > 1,
      printCount,
      showPoweredBy: row.show_powered_by_snapshot === 1,
    }
  }

  private getProduct(productId: string): ProductRow | null {
    return this.database.prepare(`
      SELECT p.id, p.sku, p.name, p.unit, p.is_active, p.department_id,
        COALESCE(d.name, '') AS department_name, COALESCE(c.name, '') AS category_name,
        CAST(p.sale_price AS TEXT) AS sale_price_text, CAST(p.wholesale_price AS TEXT) AS wholesale_price_text,
        CAST(p.wholesale_min_quantity_milli AS TEXT) AS wholesale_min_text,
        CAST(p.price_per_kg AS TEXT) AS price_per_kg_text, p.weighed_item, p.prescription_required,
        p.expiry_tracking, p.generic_name,
        CAST(COALESCE(s.quantity_milli, 0) AS TEXT) AS stock_quantity_text,
        CAST(COALESCE(s.reserved_milli, 0) AS TEXT) AS stock_reserved_text,
        p.row_version, COALESCE(s.row_version, 1) AS stock_version,
        CAST(p.cost AS TEXT) AS cost_text
      FROM products p
      LEFT JOIN stock s ON s.product_id = p.id
      LEFT JOIN departments d ON d.id = p.department_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.id = ?
    `).get(productId) as ProductRow | undefined ?? null
  }

  private getCustomerRow(id: string): CustomerRow | null {
    return this.database.prepare(`
      SELECT c.id, c.name, c.phone, c.email, c.address,
        CAST(c.credit_limit AS TEXT) AS credit_limit_text, CAST(c.balance AS TEXT) AS balance_text, c.row_version,
        l.id AS loyalty_member_id, l.member_number AS loyalty_member_number,
        COALESCE(l.points_balance, 0) AS loyalty_points_balance, COALESCE(l.points_debt, 0) AS loyalty_points_debt,
        l.row_version AS loyalty_row_version, l.is_active AS loyalty_active
      FROM customers c LEFT JOIN loyalty_members l ON l.customer_id = c.id
      WHERE c.id = ?
    `).get(id) as CustomerRow | undefined ?? null
  }

  private isCustomerActive(id: string): boolean {
    const row = this.database.prepare('SELECT is_active FROM customers WHERE id = ?').get(id) as { is_active: number } | undefined
    return row?.is_active === 1
  }

  private createMemberNumber(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const number = `LM-${this.newId().replace(/-/gu, '').slice(0, 10).toUpperCase()}`
      const exists = this.database.prepare('SELECT 1 FROM loyalty_members WHERE member_number = ?').get(number)
      if (!exists) return number
    }
    throw new Error('A unique loyalty member number could not be created. Try again.')
  }

  private audit(actor: PublicUser, action: string, metadata: Record<string, unknown>): void {
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

interface CalculatedTender {
  records: Array<{ method: Exclude<PosPaymentMethod, 'CREDIT'>; amountMinor: bigint; tenderedMinor: bigint; changeMinor: bigint; reference: string }>
  paidMinor: bigint
  creditMinor: bigint
  tenderedMinor: bigint
  changeMinor: bigint
}

/** The methods this shop accepts, from Settings; an unreadable setting falls back to every method. */
function enabledMethods(settings: ShopSettings): ReadonlySet<string> {
  const configured = settings.operational?.enabledPaymentMethods
  if (!Array.isArray(configured) || configured.length === 0) {
    return new Set(['CASH', 'TRANSFER', 'CARD', 'CREDIT'])
  }
  return new Set(configured)
}

/** Shop-wide discount ceiling from Settings, 0–10 000 basis points; any discount when unset. */
function shopDiscountLimit(settings: ShopSettings): number {
  const limit = settings.operational?.discountLimitBasisPoints
  return typeof limit === 'number' && Number.isInteger(limit) && limit >= 0 && limit <= 10_000 ? limit : 10_000
}

const PAYMENT_METHOD_NAMES: Record<PosPaymentMethod, string> = {
  CASH: 'Cash', TRANSFER: 'Bank transfer', CARD: 'POS / Card', CREDIT: 'Credit',
}

function assertPaymentMethodsEnabled(methods: Iterable<PosPaymentMethod>, enabled: ReadonlySet<string>): void {
  for (const method of new Set(methods)) {
    if (!enabled.has(method)) {
      throw new Error(`${PAYMENT_METHOD_NAMES[method]} payments are switched off in Settings. Choose another payment method or ask an Admin to enable it.`)
    }
  }
}

function calculateTender(
  payments: SaleInputNormalized['payments'],
  total: bigint,
  currency: CurrencyDefinition,
  display: ReturnType<ShopRepository['readSettings']>['display'],
  enabled: ReadonlySet<string>,
): CalculatedTender {
  if (total === 0n) {
    if (payments.length > 0) throw new Error('Remove payment lines for a fully discounted sale.')
    return { records: [], paidMinor: 0n, creditMinor: 0n, tenderedMinor: 0n, changeMinor: 0n }
  }
  if (payments.length === 0) throw new Error('Add a payment method before completing this sale.')
  assertPaymentMethodsEnabled(payments.map((payment) => payment.method), enabled)
  const cashPayments = payments.filter((payment) => payment.method === 'CASH')
  const creditPayments = payments.filter((payment) => payment.method === 'CREDIT')
  if (cashPayments.length > 1) throw new Error('Use one cash tender line; add other payment methods as split payments.')
  if (creditPayments.length > 1) throw new Error('Only one Credit payment line is allowed.')

  let nonCashTotal = 0n
  const nonCash = payments.filter((payment): payment is SaleInputNormalized['payments'][number] & { method: 'TRANSFER' | 'CARD' } =>
    payment.method === 'TRANSFER' || payment.method === 'CARD')
  const records: CalculatedTender['records'] = []
  for (const payment of nonCash) {
    const amount = parsePaymentAmount(payment.amount, currency, display)
    if (amount <= 0n) throw new Error(`${payment.method} payment amounts must be greater than zero.`)
    nonCashTotal += amount
    assertSqliteInteger(nonCashTotal, 'Payment total')
    records.push({ method: payment.method, amountMinor: amount, tenderedMinor: amount, changeMinor: 0n, reference: payment.reference })
  }
  if (nonCashTotal > total) throw new Error('Non-cash payments cannot exceed the sale total.')
  const cashTendered = cashPayments.length ? parsePaymentAmount(cashPayments[0]!.amount, currency, display) : 0n
  if (cashPayments.length && cashTendered <= 0n) throw new Error('Enter the cash amount tendered.')
  const remainingAfterNonCash = total - nonCashTotal
  const cashApplied = cashTendered < remainingAfterNonCash ? cashTendered : remainingAfterNonCash
  const changeMinor = cashTendered - cashApplied
  const creditMinor = remainingAfterNonCash - cashApplied
  const paidMinor = nonCashTotal + cashApplied
  const tenderedMinor = nonCashTotal + cashTendered

  if (creditMinor > 0n && creditPayments.length === 0) {
    throw new Error('The sale is underpaid. Add cash, Transfer, POS/Card, or an authorised Credit payment.')
  }
  if (creditMinor === 0n && creditPayments.length > 0) throw new Error('Remove the Credit payment; there is no outstanding balance.')
  if (creditPayments.length > 0) {
    const entered = creditPayments[0]!.amount.trim()
    if (entered && entered !== '0') {
      const statedCredit = parsePaymentAmount(entered, currency, display)
      if (statedCredit !== creditMinor) throw new Error('The Credit payment must equal the host-calculated unpaid balance.')
    }
  }
  if (cashPayments.length) {
    records.push({
      method: 'CASH', amountMinor: cashApplied, tenderedMinor: cashTendered,
      changeMinor, reference: cashPayments[0]!.reference,
    })
  }
  assertSqliteInteger(tenderedMinor, 'Total tendered')
  assertSqliteInteger(changeMinor, 'Change')
  return { records, paidMinor, creditMinor, tenderedMinor, changeMinor }
}

function allocateDiscount(
  lines: SaleLine[],
  amount: bigint,
  eligible: (line: SaleLine) => boolean,
  kind: 'promotion' | 'loyalty',
): void {
  if (amount <= 0n) return
  const baseFor = (line: SaleLine): bigint => kind === 'promotion'
    ? line.grossMinor - line.promotionDiscountMinor
    : line.lineTotalMinor
  const selected = lines.filter((line) => eligible(line) && baseFor(line) > 0n)
  const totalWeight = selected.reduce((total, line) => total + baseFor(line), 0n)
  if (totalWeight <= 0n || amount > totalWeight) throw new Error('The requested discount exceeds the eligible item total.')

  let unallocated = amount
  const shares = selected.map((line) => {
    const share = amount * baseFor(line) / totalWeight
    const available = baseFor(line)
    const applied = share > available ? available : share
    unallocated -= applied
    return { line, applied }
  })
  for (const share of shares) {
    if (unallocated <= 0n) break
    const available = baseFor(share.line) - share.applied
    if (available <= 0n) continue
    const extra = available < unallocated ? available : unallocated
    share.applied += extra
    unallocated -= extra
  }
  if (unallocated !== 0n) throw new Error('The discount could not be allocated exactly across the sale items.')
  for (const { line, applied } of shares) {
    if (kind === 'promotion') line.promotionDiscountMinor += applied
    else line.loyaltyDiscountMinor += applied
    line.lineTotalMinor -= applied
  }
}

function distributeBatchAllocations(lines: SaleLine[], allocationsByProduct: Map<string, BatchAllocation[]>): void {
  for (const [productId, allocations] of allocationsByProduct) {
    if (allocations.length === 0) continue
    const productLines = lines.filter((line) => line.product.id === productId)
    let batchIndex = 0
    let remainingInBatch = allocations[0]?.quantityMilli ?? 0n
    for (const line of productLines) {
      let lineRemaining = line.quantityMilli
      while (lineRemaining > 0n) {
        const batch = allocations[batchIndex]
        if (!batch) throw new Error('FEFO batch allocation did not cover the product quantity.')
        const take = lineRemaining < remainingInBatch ? lineRemaining : remainingInBatch
        line.batches.push({ ...batch, quantityMilli: take })
        lineRemaining -= take
        remainingInBatch -= take
        if (remainingInBatch === 0n) {
          batchIndex += 1
          remainingInBatch = allocations[batchIndex]?.quantityMilli ?? 0n
        }
      }
    }
  }
}

function aggregateQuantities(lines: SaleLine[]): Map<string, bigint> {
  const totals = new Map<string, bigint>()
  for (const line of lines) totals.set(line.product.id, (totals.get(line.product.id) ?? 0n) + line.quantityMilli)
  for (const [productId, quantity] of totals) assertSqliteInteger(quantity, `Quantity of product ${productId}`)
  return totals
}

function normalizeQuoteInput(input: PosQuoteInput): QuoteInputNormalized {
  if (!input || typeof input !== 'object') throw new Error('Enter a valid sale quote.')
  const saleType = normalizeSaleType(input.saleType)
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > MAX_SALE_LINES) {
    throw new Error(`A sale must contain between 1 and ${MAX_SALE_LINES} item lines.`)
  }
  const items = input.items.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('Enter valid sale item details.')
    const productId = normalizeId(item.productId, 'product')
    const quantity = requiredText(item.quantity, 'Quantity', 24)
    parseQuantityMilli(quantity)
    const manualDiscount = item.manualDiscount === undefined ? '0' : requiredText(item.manualDiscount, 'Discount', 48)
    return { productId, quantity, manualDiscount }
  })
  const customerId = input.customerId === undefined || input.customerId === null || input.customerId === ''
    ? null : normalizeId(input.customerId, 'customer')
  const loyaltyPointsToRedeem = input.loyaltyPointsToRedeem ?? 0
  if (!Number.isSafeInteger(loyaltyPointsToRedeem) || loyaltyPointsToRedeem < 0) throw new Error('Enter a whole-number loyalty points amount.')
  return { saleType, items, customerId, loyaltyPointsToRedeem }
}

function normalizeSaleInput(input: CompletePosSaleInput): SaleInputNormalized {
  if (!input || typeof input !== 'object') throw new Error('Enter a valid sale.')
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey)
  const saleType = normalizeSaleType(input.saleType)
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > MAX_SALE_LINES) {
    throw new Error(`A sale must contain between 1 and ${MAX_SALE_LINES} item lines.`)
  }
  const items = input.items.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('Enter valid sale item details.')
    const productId = normalizeId(item.productId, 'product')
    const quantity = requiredText(item.quantity, 'Quantity', 24)
    parseQuantityMilli(quantity)
    const manualDiscount = item.manualDiscount === undefined ? '0' : requiredText(item.manualDiscount, 'Discount', 48)
    return { productId, quantity, manualDiscount }
  })
  if (!Array.isArray(input.payments) || input.payments.length > 10) throw new Error('Enter valid payment lines.')
  const payments = input.payments.map((payment) => {
    const method = normalizePaymentMethod(payment?.method)
    const amount = payment?.amount === undefined || payment?.amount === null ? '' : cleanText(payment.amount, 48)
    if (method !== 'CREDIT' && !amount) throw new Error(`Enter an amount for ${method}.`)
    return { method, amount, reference: cleanText(payment?.reference, 120) }
  })
  const customerId = input.customerId === undefined || input.customerId === null || input.customerId === ''
    ? null : normalizeId(input.customerId, 'customer')
  const loyaltyPointsToRedeem = input.loyaltyPointsToRedeem ?? 0
  if (!Number.isSafeInteger(loyaltyPointsToRedeem) || loyaltyPointsToRedeem < 0) throw new Error('Enter a whole-number loyalty points amount.')
  const prescriptionAcknowledged = input.prescriptionAcknowledged ?? false
  if (typeof prescriptionAcknowledged !== 'boolean') throw new Error('Prescription confirmation must be yes or no.')
  const heldCartId = input.heldCartId === undefined || input.heldCartId === null || input.heldCartId === ''
    ? null : normalizeId(input.heldCartId, 'held cart')
  return { idempotencyKey, saleType, items, payments, customerId, loyaltyPointsToRedeem, prescriptionAcknowledged, heldCartId }
}

function normalizeHeldCartData(data: HeldPosCartData): HeldPosCartData {
  if (!data || typeof data !== 'object' || !Array.isArray(data.items) || data.items.length < 1 || data.items.length > MAX_SALE_LINES) {
    throw new Error('A held cart must contain at least one item.')
  }
  const loyaltyPointsToRedeem = data.loyaltyPointsToRedeem ?? 0
  if (!Number.isSafeInteger(loyaltyPointsToRedeem) || loyaltyPointsToRedeem < 0) throw new Error('Enter a whole-number loyalty points amount.')
  return {
    saleType: normalizeSaleType(data.saleType),
    items: data.items.map((item) => {
      if (!item || typeof item !== 'object') throw new Error('Enter valid held-cart item details.')
      const quantity = requiredText(item.quantity, 'Quantity', 24)
      parseQuantityMilli(quantity)
      return {
        productId: normalizeId(item.productId, 'product'),
        quantity,
        manualDiscount: item?.manualDiscount === undefined ? '0' : requiredText(item.manualDiscount, 'Discount', 48),
      }
    }),
    customerId: data.customerId ? normalizeId(data.customerId, 'customer') : null,
    loyaltyPointsToRedeem,
  }
}

function parseHeldCartData(json: string): HeldPosCartData {
  try {
    const parsed = JSON.parse(json) as HeldPosCartData
    return normalizeHeldCartData(parsed)
  } catch {
    throw new Error('This held cart is damaged and cannot be recalled.')
  }
}

function hashSaleRequest(input: SaleInputNormalized): string {
  const canonical = {
    saleType: input.saleType,
    items: input.items.map(({ productId, quantity, manualDiscount }) => ({ productId, quantity, manualDiscount })),
    payments: input.payments.map(({ method, amount, reference }) => ({ method, amount, reference })),
    customerId: input.customerId,
    loyaltyPointsToRedeem: input.loyaltyPointsToRedeem,
    prescriptionAcknowledged: input.prescriptionAcknowledged,
    heldCartId: input.heldCartId,
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

function normalizeIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128 || !/^[A-Za-z0-9._:-]+$/u.test(value)) {
    throw new Error('A valid unique checkout key is required. Retry this checkout without changing its key.')
  }
  return value
}

function normalizeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\u0000-\u001f]/u.test(value)) {
    throw new Error(`Choose a valid ${label}.`)
  }
  return value.trim()
}

function normalizeSaleId(value: string | number): number {
  const text = String(value)
  if (!/^\d{1,12}$/u.test(text)) throw new Error('Choose a valid sale receipt.')
  const saleId = Number(text)
  if (!Number.isSafeInteger(saleId) || saleId < 1) throw new Error('Choose a valid sale receipt.')
  return saleId
}

function normalizeSaleType(value: unknown): SaleType {
  if (value !== 'RETAIL' && value !== 'WHOLESALE') throw new Error('Choose retail or wholesale pricing.')
  return value
}

function normalizePaymentMethod(value: unknown): PosPaymentMethod {
  if (value !== 'CASH' && value !== 'TRANSFER' && value !== 'CARD' && value !== 'CREDIT') throw new Error('Choose Cash, Transfer, POS/Card, or Credit.')
  return value
}

function validateLayout(value: ReceiptLayout): void {
  if (!['THERMAL_80', 'THERMAL_58', 'A4_RECEIPT', 'A4_INVOICE'].includes(value)) throw new Error('Choose a valid receipt or invoice layout.')
}

function validateActor(actor: PublicUser): void {
  if (!actor || typeof actor.id !== 'string' || !actor.id.trim() || typeof actor.username !== 'string' || !actor.username.trim()
    || !actor.isActive || actor.isLocked || !actor.permissions) {
    throw new Error('An active signed-in desktop user is required for POS.')
  }
}

function validateEdition(edition: Edition): void {
  if (!['PHARMACY', 'SUPERMARKET', 'BOTH'].includes(edition)) throw new Error('A valid licensed edition is required for POS.')
}

function supportsPharmacy(edition: Edition): boolean {
  return edition === 'PHARMACY' || edition === 'BOTH'
}

function supportsSupermarket(edition: Edition): boolean {
  return edition === 'SUPERMARKET' || edition === 'BOTH'
}

function requiresExpiryTracking(product: Pick<ProductRow, 'expiry_tracking' | 'generic_name' | 'prescription_required'>, edition: Edition): boolean {
  return edition === 'PHARMACY'
    || (edition === 'BOTH' && (product.expiry_tracking === 1 || product.prescription_required === 1 || Boolean(product.generic_name)))
    || (edition === 'SUPERMARKET' && product.expiry_tracking === 1)
}

function parseQuantityMilli(value: string): bigint {
  if (typeof value !== 'string') throw new Error('Enter a valid quantity.')
  const match = /^(\d+)(?:\.(\d{0,3}))?$/.exec(value.trim().replace(/[\s\u00a0\u202f]/gu, ''))
  if (!match) throw new Error('Enter a non-negative quantity with at most three decimal places.')
  const amount = BigInt(match[1]!) * 1000n + BigInt((match[2] ?? '').padEnd(3, '0') || '0')
  assertSqliteInteger(amount, 'Quantity')
  return amount
}

function formatQuantity(milli: bigint): string {
  const whole = milli / 1000n
  const fraction = (milli % 1000n).toString().padStart(3, '0').replace(/0+$/u, '')
  return `${whole}${fraction ? `.${fraction}` : ''}`
}

function parsePaymentAmount(value: string, currency: CurrencyDefinition, display: ReturnType<ShopRepository['readSettings']>['display']): bigint {
  const amount = parseMoneyExact(value, currency, display)
  assertSqliteInteger(amount, 'Payment amount')
  if (amount < 0n) throw new Error('Payment amounts cannot be negative.')
  return amount
}

function requiredText(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== 'string') throw new Error(`Enter a valid ${label.toLowerCase()}.`)
  const normalized = cleanText(value, maximumLength)
  if (!normalized) throw new Error(`Enter ${label.toLowerCase()}.`)
  return normalized
}

function cleanText(value: unknown, maximumLength: number): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new Error('Enter valid text.')
  const normalized = value.replace(/[\r\n\t\p{C}]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  if (normalized.length > maximumLength) throw new Error(`Text must be ${maximumLength} characters or fewer.`)
  return normalized
}

function assertSqliteInteger(value: bigint, label: string): void {
  if (value < -MAX_SQLITE_INTEGER || value > MAX_SQLITE_INTEGER) throw new Error(`${label} exceeds the supported SQLite integer range.`)
}

function mapCustomer(row: CustomerRow): PosCustomerRecord {
  if (!Number.isSafeInteger(row.loyalty_points_balance) || row.loyalty_points_balance < 0) {
    throw new Error('This customer’s loyalty balance exceeds the supported whole-number range.')
  }
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    address: row.address,
    creditLimitMinor: BigInt(row.credit_limit_text),
    balanceMinor: BigInt(row.balance_text),
    rowVersion: row.row_version,
    loyaltyMemberId: row.loyalty_member_id,
    loyaltyMemberNumber: row.loyalty_member_number,
    loyaltyPointsBalance: row.loyalty_points_balance,
  }
}
