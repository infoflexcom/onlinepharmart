import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { can } from '../../packages/core/src/capabilities'
import type { PublicUser, UserRole } from '../shared/auth/types'
import type { Edition } from '../editions'
import type { ShopRepository } from './contracts/shop-repository'
import type { SaleType } from '../shared/pos/types'
import type { ApprovalOverrideLookup, PointOfSaleService, SaleApprovalKind } from './point-of-sale-service'
import { normaliseKey } from './idempotency'
import { fromMinor } from '../currency/parse'
import type {
  CreateOrderInput, FinalizeOrderInput, FinalizeOrderResult, OrderEventView, OrderLineView,
  OrderOrigin, OrderPriceChange, OrderStatus, OrderView,
} from '../shared/orders/types'

/**
 * The order-to-receipt workflow: a USER builds an order, stock is reserved, and an ACCOUNT finalizes it into a sale.
 *
 * ## What this service does and does not own
 *
 * It owns the order lifecycle — create, queue, adjust, cancel, expire, finalize — and the reservations that hold stock
 * while an order is unpaid. It does **not** re-implement pricing, promotions, loyalty, tender, credit limits, FEFO or
 * receipt numbering. Finalizing delegates to `PointOfSaleService.completeSale`, which already does all of that inside
 * one transaction and is already tested. Two engines that both deduct stock would eventually disagree, and the
 * disagreement would be in a customer's till.
 *
 * ## Why nesting the transactions is safe
 *
 * `completeSale` opens its own transaction, and finalize must also release the order's reservations and mark the order
 * paid. Those have to be atomic together: releasing without deducting would hand the stock to somebody else, and
 * deducting without releasing would leave a phantom hold. better-sqlite3 nests `transaction()` calls as SAVEPOINTs, so
 * the outer transaction here wraps the inner one and a throw anywhere rolls all of it back. That was verified rather
 * than assumed — see `order-service.test.ts`, which fails the inner work and asserts the release was undone.
 *
 * ## Reservation granularity
 *
 * Stock is reserved per **product**, not per batch. FEFO batch allocation happens at finalize, inside `deductStock`.
 * Reserving a specific batch at order time would look more precise and be worse: a batch reserved at 09:00 and sold at
 * 09:30 might no longer be the earliest-expiring one, and the picker would have been told to fetch stock that the till
 * then allocated differently. Reserving the quantity and allocating the batch at the moment of sale keeps one answer.
 */
export interface OrderServiceOptions {
  workstation?: string
  now?: () => number
  newId?: () => string
}

/** Refused because a price moved and the Account has not yet accepted the difference. */
export class OrderPriceChangedError extends Error {
  readonly changes: OrderPriceChange[]
  constructor(changes: OrderPriceChange[], totalWasMinor: bigint, totalNowMinor: bigint) {
    super(
      `Prices changed since this order was created. The total was ${totalWasMinor} and is now ${totalNowMinor} in minor units. `
      + 'Show the difference to the Account and finalize again with the change accepted.',
    )
    this.name = 'OrderPriceChangedError'
    this.changes = changes
  }
}

/** Refused because somebody else finalized this order first. Distinct so the UI can say "already completed". */
export class OrderAlreadyCompletedError extends Error {
  constructor(orderNumber: string, status: OrderStatus) {
    super(status === 'PAID'
      ? `Order ${orderNumber} was already completed by another account. It is paid; nothing further is needed.`
      : `Order ${orderNumber} is ${status.toLowerCase()} and cannot be finalized.`)
    this.name = 'OrderAlreadyCompletedError'
  }
}

interface OrderRow {
  id: string
  order_number: string
  type: SaleType
  status: OrderStatus
  customer_id: string | null
  created_by: string
  finalized_by: string | null
  currency_code: string
  subtotal: number
  discount: number
  tax: number
  total: number
  expires_at: string | null
  idempotency_key: string | null
  created_at: string
  row_version: number
}

interface ItemRow {
  id: string
  product_id: string | null
  description_snapshot: string
  unit: string
  quantity_milli: number
  unit_price: number
  discount: number
  line_total: number
}

export class OrderService {
  private readonly workstation: string
  private readonly now: () => number
  private readonly newId: () => string

  constructor(
    private readonly database: Database.Database,
    private readonly shop: ShopRepository,
    private readonly pointOfSale: PointOfSaleService,
    options: OrderServiceOptions = {},
  ) {
    this.workstation = (options.workstation ?? 'LOCAL_DESKTOP').slice(0, 120) || 'LOCAL_DESKTOP'
    this.now = options.now ?? Date.now
    this.newId = options.newId ?? randomUUID
  }

  // ─────────────────────────────────────────────────────────── creating an order

  /**
   * "Generate receipt" on the USER's screen: create the order, reserve the stock, snapshot the prices.
   *
   * The result is an order slip, not a receipt. It carries `ORDER_SLIP_NOT_A_RECEIPT` and the service exposes no print
   * path for it, because the brief's rule is that a USER cannot print anything at all — not that printing is hidden.
   */
  createOrder(
    input: CreateOrderInput,
    actor: PublicUser,
    edition: Edition,
    origin?: OrderOrigin,
    /** Present when the caller can correlate an Admin's decision to this attempt. Absent means the ceiling is simply reported. */
    approvedOverride?: ApprovalOverrideLookup,
  ): OrderView {
    this.requireActor(actor)
    this.requireCapability(actor, 'build_order', 'create an order')
    if (!input.items || input.items.length === 0) throw new Error('Add at least one item before generating the order.')

    const settings = this.shop.readSettings()
    // Quoted through the POS engine so promotions, loyalty, wholesale tiers and the discount cap all apply exactly as
    // they would at the till. A second pricing path here would be a second set of prices.
    const quote = this.pointOfSale.quoteSale({
      saleType: input.saleType,
      items: input.items,
      customerId: input.customerId ?? null,
      loyaltyPointsToRedeem: input.loyaltyPointsToRedeem,
    }, actor, edition, approvedOverride)

    const idempotencyKey = input.idempotencyKey?.trim() || null
    const expiryMinutes = this.orderExpiryMinutes()
    const originPc = (origin?.pcName?.trim() || this.workstation).slice(0, 120)
    const createdAt = new Date(this.now()).toISOString()
    let orderId = ''

    this.database.transaction(() => {
      // A retried create must not reserve the stock twice. The unique index on (created_by, idempotency_key) is the
      // backstop; this read is the fast path that returns the order the first call already made.
      if (idempotencyKey) {
        const existing = this.database.prepare(
          'SELECT id FROM orders WHERE created_by = ? AND idempotency_key = ?',
        ).get(actor.id, idempotencyKey) as { id: string } | undefined
        if (existing) { orderId = existing.id; return }
      }

      orderId = this.newId()
      const orderNumber = this.nextOrderNumber()
      const expiresAt = new Date(this.now() + expiryMinutes * 60_000).toISOString()

      this.database.prepare(`
        INSERT INTO orders (
          id, order_number, type, status, customer_id, created_by, currency_code,
          subtotal, discount, tax, total, price_snapshot_at, expires_at, idempotency_key, row_version, created_at, updated_at,
          origin_pc, client_device_id
        ) VALUES (?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      `).run(
        orderId, orderNumber, input.saleType, input.customerId ?? null, actor.id, settings.currency.code,
        Number(quote.subtotalMinor),
        Number(quote.manualDiscountMinor + quote.promotionDiscountMinor + quote.loyaltyDiscountMinor),
        Number(quote.totalMinor), createdAt, expiresAt, idempotencyKey, createdAt, createdAt,
        // The machine the goods were picked on. Taken from the authenticated connection by the caller, never from
        // anything the client says about itself: a client that could name itself could name itself after somebody
        // else's PC, and then the audit trail would point at the wrong till. Falls back to this service's own
        // workstation, which is the Server's window name for an order picked there.
        originPc, origin?.clientDeviceId ?? null,
      )

      const insertItem = this.database.prepare(`
        INSERT INTO order_items (
          id, order_id, product_id, description_snapshot, unit, quantity_milli, unit_price, discount, tax, line_total
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      `)
      for (const line of quote.items) {
        insertItem.run(
          this.newId(), orderId, line.productId, line.description, line.unit,
          Number(line.quantityMilli), Number(line.unitPriceMinor),
          Number(line.manualDiscountMinor + line.promotionDiscountMinor + line.loyaltyDiscountMinor),
          Number(line.lineTotalMinor),
        )
      }

      // Reserving is the step that makes the order mean something: without it two pickers could promise the same last
      // unit to two different customers and the Account would discover it at the till.
      for (const line of quote.items) {
        this.reserve(line.productId, line.quantityMilli, orderId, line.description)
      }

      this.recordEvent(orderId, 'order.created', null, 'PENDING', actor.id,
        `${quote.items.length} line(s), total ${quote.totalMinor} minor units, expires in ${expiryMinutes} minute(s).`)
      this.audit(actor, 'order.created', {
        orderId, orderNumber, saleType: input.saleType,
        totalMinor: quote.totalMinor.toString(), currencyCode: settings.currency.code, expiresAt,
      })
    }).immediate()

    return this.getOrder(orderId, actor)
  }

  /**
   * Hold stock for one line.
   *
   * The `WHERE quantity_milli - reserved_milli >= ?` guard is the whole point: it makes "is there stock left" a
   * condition of the write rather than a check before it, so two concurrent orders cannot both reserve the last unit.
   * `changes === 0` then means somebody got there first, and the order is refused rather than half-created — the
   * enclosing transaction rolls the earlier lines back.
   */
  private reserve(productId: string, quantityMilli: bigint, orderId: string, description: string): void {
    const quantity = Number(quantityMilli)
    const result = this.database.prepare(`
      UPDATE stock
      SET reserved_milli = reserved_milli + ?, row_version = row_version + 1, updated_at = ?
      WHERE product_id = ? AND quantity_milli - reserved_milli >= ?
    `).run(quantity, new Date(this.now()).toISOString(), productId, quantity)
    if (result.changes !== 1) {
      throw new Error(`There is not enough available stock of ${description} to reserve for this order.`)
    }
    this.database.prepare(`
      INSERT INTO reservations (id, order_id, product_id, batch_id, quantity_milli, created_at)
      VALUES (?, ?, ?, NULL, ?, ?)
    `).run(this.newId(), orderId, productId, quantity, new Date(this.now()).toISOString())
  }

  /**
   * The next order number, assigned at creation rather than at finalize.
   *
   * Migration 16's comment said an order number would be NULL until finalised, so a cancelled order would not leave a
   * gap. The brief asks for the opposite and is the authority here: the picker is handed a number to read out and the
   * Account's queue is ordered by it, so a number that does not exist until payment is no use to either. Gaps are
   * accepted and are honest — a cancelled order really did happen. Recorded in ARCH_CHANGE_CLIENT_SERVER.md.
   *
   * `MAX + 1` is safe here specifically because the Server is the only writer and this runs inside an IMMEDIATE
   * transaction; it would not be safe in a multi-writer database and should not be copied elsewhere.
   */
  private nextOrderNumber(): string {
    // `document_sequences` is the allocator migration 16 built for exactly this: one row per document kind, seeded and
    // owned by the Server, with a trigger that refuses a number moving backwards. Taking MAX() over `orders` and
    // parsing the number back out of its own string would be a second allocator that no trigger protects, and one that
    // silently disagrees with the receipt sequence if anybody ever reuses this shape for sales.
    //
    // UPDATE then SELECT rather than RETURNING, and safe because this only ever runs inside the IMMEDIATE transaction
    // that creates the order: the Server is the single writer, so nothing can move the row between the two statements.
    this.database.prepare(`
      UPDATE document_sequences SET last_value = last_value + 1, updated_at = ? WHERE kind = 'ORDER'
    `).run(new Date(this.now()).toISOString())
    const row = this.database.prepare(
      `SELECT last_value FROM document_sequences WHERE kind = 'ORDER'`,
    ).get() as { last_value: number } | undefined
    if (!row) throw new Error('The order-number sequence is missing. Ask the Admin to check the database.')
    return `ORD-${String(row.last_value).padStart(6, '0')}`
  }

  // ─────────────────────────────────────────────────────────── reading orders

  /**
   * The ACCOUNT's queue: every order awaiting payment, oldest first so nothing sits at the back.
   *
   * Expired orders are swept before the read, so the queue never shows an order whose stock has already been released.
   * Showing one would invite the Account to take payment for goods that are no longer held.
   */
  listQueue(actor: PublicUser): OrderView[] {
    this.requireActor(actor)
    this.requireCapability(actor, 'take_payment', 'see the order queue')
    this.expireDueOrders(actor)
    const rows = this.database.prepare(`
      SELECT * FROM orders WHERE status = 'PENDING' ORDER BY created_at ASC, order_number ASC
    `).all() as OrderRow[]
    return rows.map((row) => this.toView(row))
  }

  /** A USER's own orders, and only their own. `see_own_orders` is the capability the brief names for this. */
  listMyOrders(actor: PublicUser): OrderView[] {
    this.requireActor(actor)
    this.requireCapability(actor, 'see_own_orders', 'see your orders')
    this.expireDueOrders(actor)
    // An Admin or an Account asking for "my orders" gets every order: they are allowed to see all of them anyway, and
    // scoping the query by owner would hide the shop's own history from the person who owns the shop.
    if (can(this.roleOf(actor), 'take_payment')) {
      const rows = this.database.prepare('SELECT * FROM orders ORDER BY created_at DESC').all() as OrderRow[]
      return rows.map((row) => this.toView(row))
    }
    const rows = this.database.prepare(
      'SELECT * FROM orders WHERE created_by = ? ORDER BY created_at DESC',
    ).all(actor.id) as OrderRow[]
    return rows.map((row) => this.toView(row))
  }

  /** One order, scoped: a USER may read their own, an ACCOUNT or Admin may read any. */
  getOrder(orderId: string, actor: PublicUser): OrderView {
    this.requireActor(actor)
    const row = this.database.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as OrderRow | undefined
    if (!row) throw new Error('That order could not be found.')
    if (!can(this.roleOf(actor), 'take_payment') && row.created_by !== actor.id) {
      // The same sentence for "not yours" and "does not exist" would be wrong here: the picker needs to know an order
      // they were given is not theirs, and the id is not a secret in the way a username is.
      throw new Error('That order belongs to another picker.')
    }
    return this.toView(row)
  }

  // ─────────────────────────────────────────────────────────── changing an order

  /**
   * Adjust one line's quantity. An ACCOUNT act, and a logged one: the brief asks specifically that adjustments are
   * recorded, because a quantity changed between picking and payment is exactly the kind of thing a shop needs to
   * be able to answer later.
   */
  adjustLineQuantity(orderId: string, itemId: string, quantity: string, actor: PublicUser): OrderView {
    this.requireActor(actor)
    this.requireCapability(actor, 'take_payment', 'adjust an order')
    const quantityMilli = parseQuantity(quantity)

    let view: OrderView | null = null
    this.database.transaction(() => {
      const row = this.requirePending(orderId)
      const item = this.database.prepare(
        'SELECT * FROM order_items WHERE id = ? AND order_id = ?',
      ).get(itemId, orderId) as ItemRow | undefined
      if (!item) throw new Error('That line is not on this order.')
      if (!item.product_id) throw new Error('That line has no product to adjust.')

      const was = BigInt(item.quantity_milli)
      const delta = quantityMilli - was
      if (delta !== 0n) {
        if (delta > 0n) this.reserve(item.product_id, delta, orderId, item.description_snapshot)
        else this.release(item.product_id, -delta, orderId)
        this.database.prepare(`
          UPDATE order_items
          SET quantity_milli = ?,
              line_total = CAST(ROUND(unit_price * ? / 1000.0 - discount) AS INTEGER)
          WHERE id = ?
        `).run(Number(quantityMilli), Number(quantityMilli), itemId)
        this.recomputeTotals(orderId)
      }
      this.database.prepare('UPDATE orders SET row_version = row_version + 1, updated_at = ? WHERE id = ?')
        .run(new Date(this.now()).toISOString(), orderId)
      this.recordEvent(orderId, 'order.line_adjusted', row.status, row.status, actor.id,
        `${item.description_snapshot}: quantity ${was} → ${quantityMilli} milli-units.`)
      this.audit(actor, 'order.line_adjusted', {
        orderId, orderNumber: row.order_number, itemId,
        quantityWasMilli: was.toString(), quantityNowMilli: quantityMilli.toString(),
      })
      view = this.toView(this.database.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as OrderRow)
    }).immediate()
    return view!
  }

  /**
   * Cancel an unpaid order and release its stock.
   *
   * Either side may cancel, as the brief requires: the picker who knows the customer walked away, or the Account who
   * knows the order cannot be paid. A reason is mandatory, because "cancelled" without one is an audit entry that
   * answers nothing.
   */
  cancelOrder(orderId: string, reason: string, actor: PublicUser): OrderView {
    this.requireActor(actor)
    const cleaned = reason.trim()
    if (!cleaned) throw new Error('Give a reason for cancelling. It is recorded on the audit trail.')
    if (cleaned.length > 400) throw new Error('Keep the cancellation reason under 400 characters.')

    let view: OrderView | null = null
    this.database.transaction(() => {
      const row = this.database.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as OrderRow | undefined
      if (!row) throw new Error('That order could not be found.')
      if (row.status === 'PAID') {
        // A paid order is a completed sale, and completed sales are never deleted or cancelled. The route back is a
        // return, which is a different document with its own approvals.
        throw new Error('That order is paid. Process a return instead — a completed sale cannot be cancelled.')
      }
      if (row.status !== 'PENDING') throw new Error(`That order is already ${row.status.toLowerCase()}.`)
      const mayCancelAny = can(this.roleOf(actor), 'take_payment')
      if (!mayCancelAny && row.created_by !== actor.id) throw new Error('That order belongs to another picker.')
      this.releaseAllFor(orderId)
      this.database.prepare("UPDATE orders SET status = 'CANCELLED', row_version = row_version + 1, updated_at = ? WHERE id = ?")
        .run(new Date(this.now()).toISOString(), orderId)
      this.recordEvent(orderId, 'order.cancelled', 'PENDING', 'CANCELLED', actor.id, cleaned)
      this.audit(actor, 'order.cancelled', { orderId, orderNumber: row.order_number, reason: cleaned })
      view = this.toView(this.database.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as OrderRow)
    }).immediate()
    return view!
  }

  // ─────────────────────────────────────────────────────────── expiry

  /**
   * Release every order whose expiry has passed.
   *
   * Called before any read of the queue and before any finalize, rather than on a timer. A timer would be a second
   * writer with its own notion of the time, and on a Server that is switched off overnight the sweep would simply not
   * have run — whereas the first person to open the queue in the morning gets a correct one. The clock is the Server's,
   * as the network rule requires.
   */
  expireDueOrders(actor: PublicUser): number {
    this.requireActor(actor)
    const nowIso = new Date(this.now()).toISOString()
    let expired = 0
    this.database.transaction(() => {
      const due = this.database.prepare(`
        SELECT id, order_number FROM orders WHERE status = 'PENDING' AND expires_at IS NOT NULL AND expires_at <= ?
      `).all(nowIso) as Array<{ id: string; order_number: string }>
      for (const order of due) {
        this.releaseAllFor(order.id)
        this.database.prepare("UPDATE orders SET status = 'EXPIRED', row_version = row_version + 1, updated_at = ? WHERE id = ?")
          .run(nowIso, order.id)
        this.recordEvent(order.id, 'order.expired', 'PENDING', 'EXPIRED', actor.id,
          'Unpaid past its expiry; reserved stock released.')
        this.audit(actor, 'order.expired', { orderId: order.id, orderNumber: order.order_number })
        expired += 1
      }
    }).immediate()
    return expired
  }

  // ─────────────────────────────────────────────────────────── finalizing

  /**
   * Turn an order into a sale: take payment, deduct stock, assign the receipt number, print.
   *
   * Three guarantees the brief asks for, all inside one transaction:
   *
   * 1. **Idempotency.** A retry with the same key replays the first result rather than making a second sale. The key is
   *    checked on the order row *and* passed to `completeSale`, which has its own key and request-hash check.
   * 2. **Concurrency.** Two Accounts finalizing the same order: the status guard runs inside an IMMEDIATE transaction,
   *    so the second one sees `PAID` and gets `OrderAlreadyCompletedError` rather than a second sale.
   * 3. **Prices re-checked.** If a price moved since the order was created, the finalize is refused with the
   *    difference until the Account accepts it. Repricing silently would mean the customer was charged something
   *    nobody agreed to.
   */
  /**
   * Record that the till tried to take this order's payment and was refused.
   *
   * Nothing was charged and no stock moved — the sale transaction rolled back before the approval request was raised —
   * so there is no sale to look at later. But the attempt happened, and the daily audit has to be able to see it,
   * because "the order was refused, and then somebody adjusted a line, and then it went through" is a pattern worth a
   * Supervisor's attention while "the order was adjusted and then paid" is an ordinary day.
   *
   * It goes in `order_events`, which migration 16 made immutable in both directions, so neither half of that pattern
   * can be edited afterwards. The host calls this from the same place it raises the approval request; it is not a
   * client-reachable action, and the capability check below is the reason it cannot become one by accident.
   */
  recordPaymentRefusal(orderId: string, explanation: string, actor: PublicUser): void {
    this.requireActor(actor)
    this.requireCapability(actor, 'take_payment', 'attempt a payment')
    const existing = this.database.prepare('SELECT id, status FROM orders WHERE id = ?').get(orderId) as
      { id: string; status: OrderStatus } | undefined
    if (!existing) throw new Error('That order could not be found.')
    // A paid order cannot be attempted again, and recording a refusal against one would put a lie in an immutable log.
    if (existing.status === 'PAID') return
    const detail = typeof explanation === 'string' && explanation.trim()
      ? explanation.trim().slice(0, 300)
      : 'Payment refused.'
    this.database.transaction(() => {
      this.recordEvent(orderId, 'order.payment_refused', existing.status, existing.status, actor.id, detail)
      this.audit(actor, 'order.payment_refused', { orderId, detail })
    }).immediate()
  }

  finalizeOrder(orderId: string, input: FinalizeOrderInput, actor: PublicUser, edition: Edition): FinalizeOrderResult {
    this.requireActor(actor)
    this.requireCapability(actor, 'take_payment', 'finalize an order and take payment')
    // Validated with the shared key rule rather than a third copy of it. `normaliseKey` accepts a strict subset of what
    // `completeSale` accepts (the same length bounds and alphabet, minus the dot), so a key this service passes on is
    // guaranteed to be passed on downstream too — the reverse would mean a refusal from deep inside the sale engine with
    // a message about "checkout keys" on an order screen. See DECISIONS.md.
    const key = normaliseKey(input.idempotencyKey)
    if (!key) throw new Error('A finalize needs an idempotency key, so a double-click cannot create two sales.')

    // Sweep first: an order that expired while the Account was counting cash must not be finalized against stock that
    // has already been released and possibly sold to somebody else.
    this.expireDueOrders(actor)

    const existing = this.database.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as OrderRow | undefined
    if (!existing) throw new Error('That order could not be found.')

    // A replay is answered before anything is written, so the second click is cheap and cannot disturb the first sale.
    if (existing.status === 'PAID' && existing.idempotency_key === key && existing.finalized_by === actor.id) {
      const sale = this.saleForOrder(orderId)
      return {
        order: this.toView(existing),
        saleId: sale.id,
        receiptNumber: sale.receipt_number,
        idempotentReplay: true,
        priceChangesAccepted: [],
      }
    }
    if (existing.status !== 'PENDING') throw new OrderAlreadyCompletedError(existing.order_number, existing.status)

    const settings = this.shop.readSettings()
    const lines = this.readLines(orderId)
    const changes = this.detectPriceChanges(lines, existing.type === 'WHOLESALE')
    if (changes.length > 0 && !input.acceptPriceChange) {
      throw new OrderPriceChangedError(changes, BigInt(existing.total), this.currentTotal(lines))
    }

    let result: FinalizeOrderResult | null = null
    this.database.transaction(() => {
      // Re-read inside the transaction. The check above happened outside it, and another Account may have finalized in
      // between; re-checking here is what makes "exactly one succeeds" true rather than merely likely.
      const row = this.database.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as OrderRow
      if (row.status !== 'PENDING') throw new OrderAlreadyCompletedError(row.order_number, row.status)

      // An Admin who authorized this order's discount did it against the key the picker used to generate the order,
      // while the Account finalizing it brings a key of their own. Either approval is the same decision about the same
      // basket, so either unlocks it — otherwise one discount would need approving twice, and the second request would
      // look to the Admin like a new problem rather than the one they had just settled.
      const createKey = row.idempotency_key
      const authorized = (kind: SaleApprovalKind, excessMinor: bigint): boolean => (
        this.pointOfSale.hasApprovedOverride(kind, excessMinor, key, actor)
        || (createKey !== null && createKey !== key
          && this.pointOfSale.hasApprovedOverride(kind, excessMinor, createKey, actor))
      )

      // Release this order's holds before deducting, because `deductStock` measures availability as
      // quantity − reserved. Leaving the hold in place would make the order's own reservation block its own sale.
      // Verified by a test that removes this call and asserts the finalize fails.
      this.releaseAllFor(orderId)

      const completed = this.pointOfSale.completeSale({
        idempotencyKey: key,
        saleType: row.type,
        items: lines.map((line) => ({
          productId: line.product_id!,
          quantity: milliToString(line.quantity_milli),
          // The discount the picker applied, snapshotted on the order and carried into the sale. It is re-checked
          // against the ceiling here rather than trusted: an Admin may have lowered the shop limit between the order
          // being generated and it being paid, and the receipt must not print a discount nobody would authorize now.
          manualDiscount: line.discount > 0
            ? fromMinor(BigInt(line.discount), settings.currency)
            : undefined,
        })),
        payments: input.payments as never,
        customerId: input.customerId ?? row.customer_id,
        loyaltyPointsToRedeem: input.loyaltyPointsToRedeem,
        prescriptionAcknowledged: input.prescriptionAcknowledged,
        // The link is made at INSERT time because it cannot be made later: the sale is COMPLETED the moment it exists
        // and migration 3's trigger aborts any UPDATE of a completed sale. That is the right rule, so the order id goes
        // in with the row rather than being patched on afterwards.
        orderId: row.id,
        finalizedBy: actor.id,
      }, actor, edition, authorized)

      const saleId = Number(completed.receipt.id)
      const receiptNumber = completed.receipt.receiptNumber
      const finishedAt = new Date(this.now()).toISOString()
      this.database.prepare(`
        UPDATE orders
        SET status = 'PAID', finalized_by = ?, idempotency_key = ?, row_version = row_version + 1, updated_at = ?
        WHERE id = ? AND status = 'PENDING'
      `).run(actor.id, key, finishedAt, orderId)

      this.recordEvent(orderId, 'order.finalized', 'PENDING', 'PAID', actor.id,
        `Receipt ${receiptNumber}. Tendered by ${actor.fullName || actor.username}.`)
      this.audit(actor, 'order.finalized', {
        orderId, orderNumber: row.order_number, saleId, receiptNumber,
        totalMinor: completed.receipt.totalMinor.toString(), currencyCode: settings.currency.code,
        priceChangesAccepted: changes.length,
        workstation: this.workstation,
      })

      result = {
        order: this.toView(this.database.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as OrderRow),
        saleId,
        receiptNumber,
        idempotentReplay: completed.idempotentReplay,
        priceChangesAccepted: changes,
      }
    }).immediate()

    return result!
  }

  /**
   * Compare the order's snapshotted unit prices against what the products cost now.
   *
   * Read outside the write transaction on purpose: this is a question for the Account to answer, and holding a write
   * lock while a human reads a screen and decides would block the till.
   */
  private detectPriceChanges(lines: ItemRow[], wholesale: boolean): OrderPriceChange[] {
    const changes: OrderPriceChange[] = []
    for (const line of lines) {
      if (!line.product_id) continue
      // Both price columns are selected and the right one is chosen here rather than by interpolating a column name
      // into the SQL. The value was a controlled literal and could not have been injected, but a scanner that allows
      // one interpolated identifier has to decide what the next one may be, and the answer is never satisfying. Both
      // columns are INTEGER minor units, so the comparison is exact — no parsing and no rounding to get wrong. Which
      // one matters depends on the order's type: comparing a wholesale order against the retail price would report a
      // change on every line.
      const product = this.database.prepare(`
        SELECT sale_price, wholesale_price FROM products WHERE id = ?
      `).get(line.product_id) as { sale_price: number; wholesale_price: number } | undefined
      if (!product) continue
      const wasMinor = BigInt(line.unit_price)
      const nowMinor = BigInt(wholesale ? product.wholesale_price : product.sale_price)
      if (nowMinor !== wasMinor) {
        changes.push({
          productId: line.product_id,
          description: line.description_snapshot,
          wasMinor,
          nowMinor,
        })
      }
    }
    return changes
  }

  private currentTotal(lines: ItemRow[]): bigint {
    return lines.reduce((sum, line) => sum + BigInt(line.line_total), 0n)
  }

  private saleForOrder(orderId: string): { id: number; receipt_number: string } {
    // Read from `sales.order_id`, the column migration 16 added for this link, rather than a parallel table holding the
    // same fact in a second place. Two records of one relationship are two chances for them to disagree.
    const row = this.database.prepare(
      'SELECT id AS sale_id, receipt_number FROM sales WHERE order_id = ?',
    ).get(orderId) as { sale_id: number; receipt_number: string } | undefined
    if (!row) throw new Error('This order is marked paid but has no sale recorded. Ask the Admin to check the audit trail.')
    return { id: row.sale_id, receipt_number: row.receipt_number }
  }

  // ─────────────────────────────────────────────────────────── reservations

  /** Release one product's hold. `reserved_milli >= ?` keeps the column's CHECK from ever being violated. */
  private release(productId: string, quantityMilli: bigint, orderId: string): void {
    const quantity = Number(quantityMilli)
    const result = this.database.prepare(`
      UPDATE stock SET reserved_milli = reserved_milli - ?, row_version = row_version + 1, updated_at = ?
      WHERE product_id = ? AND reserved_milli >= ?
    `).run(quantity, new Date(this.now()).toISOString(), productId, quantity)
    if (result.changes !== 1) {
      throw new Error(`Could not release reserved stock for this order. Ask the Admin to check the stock records.`)
    }
    this.database.prepare(`
      UPDATE reservations SET released_at = ? WHERE order_id = ? AND product_id = ? AND released_at IS NULL
    `).run(new Date(this.now()).toISOString(), orderId, productId)
  }

  private releaseAllFor(orderId: string): void {
    const held = this.database.prepare(`
      SELECT product_id, CAST(quantity_milli AS TEXT) AS quantity_text FROM reservations
      WHERE order_id = ? AND released_at IS NULL
    `).all(orderId) as Array<{ product_id: string; quantity_text: string }>
    for (const row of held) this.release(row.product_id, BigInt(row.quantity_text), orderId)
  }

  /** Reserved quantity still held by unpaid orders, for the stock screens. */
  reservedFor(productId: string): bigint {
    const row = this.database.prepare(`
      SELECT CAST(COALESCE(SUM(quantity_milli), 0) AS TEXT) AS total FROM reservations
      WHERE product_id = ? AND released_at IS NULL
    `).get(productId) as { total: string }
    return BigInt(row.total)
  }

  // ─────────────────────────────────────────────────────────── internals

  private readLines(orderId: string): ItemRow[] {
    return this.database.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY rowid').all(orderId) as ItemRow[]
  }

  private recomputeTotals(orderId: string): void {
    const row = this.database.prepare(`
      SELECT CAST(COALESCE(SUM(line_total), 0) AS TEXT) AS total, CAST(COALESCE(SUM(discount), 0) AS TEXT) AS discount
      FROM order_items WHERE order_id = ?
    `).get(orderId) as { total: string; discount: string }
    this.database.prepare('UPDATE orders SET total = ?, discount = ? WHERE id = ?')
      .run(Number(BigInt(row.total)), Number(BigInt(row.discount)), orderId)
  }

  private requirePending(orderId: string): OrderRow {
    const row = this.database.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as OrderRow | undefined
    if (!row) throw new Error('That order could not be found.')
    if (row.status !== 'PENDING') throw new Error(`That order is ${row.status.toLowerCase()} and can no longer be changed.`)
    return row
  }

  /**
   * How long an unpaid order holds its stock.
   *
   * Read straight from the column with no fallback, because migration 17 declared it `NOT NULL DEFAULT 120` with a
   * `CHECK (BETWEEN 1 AND 10080)`. A default here for "a value the schema cannot hold" would be unreachable code that
   * reads as a safety net: somebody would later relax the CHECK believing this method still caught a bad value, and it
   * would not, because it would never have been called with one. The guarantee lives in the schema and is tested there.
   */
  private orderExpiryMinutes(): number {
    const row = this.database.prepare('SELECT order_expiry_minutes FROM settings LIMIT 1').get() as
      { order_expiry_minutes: number } | undefined
    if (!row) throw new Error('The shop settings could not be read. Ask the Admin to check the server.')
    return row.order_expiry_minutes
  }

  private recordEvent(
    orderId: string, event: string, from: OrderStatus | null, to: OrderStatus | null, actorId: string, detail: string,
  ): void {
    this.database.prepare(`
      INSERT INTO order_events (order_id, event, from_status, to_status, actor_id, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(orderId, event, from, to, actorId, detail, new Date(this.now()).toISOString())
  }

  private toView(row: OrderRow): OrderView {
    const lines = this.readLines(row.id).map((line): OrderLineView => ({
      id: line.id,
      productId: line.product_id,
      description: line.description_snapshot,
      unit: line.unit,
      quantityMilli: BigInt(line.quantity_milli),
      unitPriceMinor: BigInt(line.unit_price),
      discountMinor: BigInt(line.discount),
      lineTotalMinor: BigInt(line.line_total),
      prescriptionRequired: this.isPrescription(line.product_id),
    }))
    const customer = row.customer_id
      ? this.database.prepare('SELECT name FROM customers WHERE id = ?').get(row.customer_id) as { name: string } | undefined
      : undefined
    const events = this.database.prepare(`
      SELECT e.event, e.from_status, e.to_status, e.detail, e.created_at, u.full_name AS actor_name, u.username
      FROM order_events e LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.order_id = ? ORDER BY e.id ASC
    `).all(row.id) as Array<{
      event: string; from_status: OrderStatus | null; to_status: OrderStatus | null; detail: string
      created_at: string; actor_name: string | null; username: string | null
    }>
    const sale = row.status === 'PAID'
      ? this.database.prepare('SELECT id AS sale_id, receipt_number FROM sales WHERE order_id = ?').get(row.id) as
        { sale_id: number; receipt_number: string } | undefined
      : undefined
    const creator = this.database.prepare('SELECT full_name, username FROM users WHERE id = ?').get(row.created_by) as
      { full_name: string; username: string } | undefined
    const finalizer = row.finalized_by
      ? this.database.prepare('SELECT full_name, username FROM users WHERE id = ?').get(row.finalized_by) as
        { full_name: string; username: string } | undefined
      : undefined

    return {
      id: row.id,
      orderNumber: row.order_number,
      type: row.type,
      status: row.status,
      customerName: customer?.name ?? null,
      customerId: row.customer_id,
      createdById: row.created_by,
      createdByName: creator?.full_name || creator?.username || 'Unknown picker',
      finalizedById: row.finalized_by,
      finalizedByName: finalizer?.full_name || finalizer?.username || null,
      currencyCode: row.currency_code,
      subtotalMinor: BigInt(row.subtotal),
      discountMinor: BigInt(row.discount),
      taxMinor: BigInt(row.tax),
      totalMinor: BigInt(row.total),
      lines,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      saleId: sale?.sale_id ?? null,
      receiptNumber: sale?.receipt_number ?? null,
      needsPrescriptionAck: lines.some((line) => line.prescriptionRequired),
      events: events.map((event): OrderEventView => ({
        event: event.event,
        fromStatus: event.from_status,
        toStatus: event.to_status,
        actorName: event.actor_name || event.username || null,
        detail: event.detail,
        createdAt: event.created_at,
      })),
    }
  }

  private isPrescription(productId: string | null): boolean {
    if (!productId) return false
    const row = this.database.prepare('SELECT prescription_required FROM products WHERE id = ?').get(productId) as
      { prescription_required: number } | undefined
    return row?.prescription_required === 1
  }

  /** `can()` takes the four real roles; a legacy `CASHIER` row is a `USER` and must be resolved before the call. */
  private roleOf(actor: PublicUser): Exclude<UserRole, 'CASHIER'> {
    return (actor.role === 'CASHIER' ? 'USER' : actor.role) as Exclude<UserRole, 'CASHIER'>
  }

  private requireCapability(actor: PublicUser, capability: 'build_order' | 'take_payment' | 'see_own_orders', act: string): void {
    if (!can(this.roleOf(actor), capability)) {
      // The refusal names the action, not the role it would have needed: telling a USER "this needs an ACCOUNT" is a
      // map of the permission table handed to everybody at the till.
      throw new Error(`Your role cannot ${act}.`)
    }
  }

  private requireActor(actor: PublicUser): void {
    if (!actor || typeof actor.id !== 'string' || !actor.id.trim() || !actor.isActive || actor.isLocked || !actor.permissions) {
      throw new Error('An active signed-in user is required for orders.')
    }
  }

  /**
   * Written through the repository rather than by hand, so the columns match every other audit row.
   *
   * The role is not a column here: `appendAudit` resolves it from the username, which is the same reason no other
   * service passes one. Passing `actorRole` would have been a second, hand-kept copy of a fact the table already
   * derives, and the two would eventually disagree.
   */
  private audit(actor: PublicUser, action: string, metadata: Record<string, unknown>): void {
    this.shop.appendAudit({
      actor: actor.username,
      action,
      metadata,
      deviceName: this.workstation,
      ipAddress: null,
      createdAt: new Date(this.now()).toISOString(),
    })
  }
}

// ─────────────────────────────────────────────────────────────── module helpers

function parseQuantity(value: string): bigint {
  const text = String(value ?? '').trim()
  if (!/^\d{1,12}(\.\d{1,3})?$/u.test(text)) {
    throw new Error('Enter a quantity as a positive number with up to three decimal places.')
  }
  const [whole, fraction = ''] = text.split('.')
  const milli = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'))
  if (milli <= 0n) throw new Error('A quantity must be greater than zero.')
  return milli
}

function milliToString(quantityMilli: number): string {
  const whole = Math.floor(quantityMilli / 1000)
  const fraction = String(quantityMilli % 1000).padStart(3, '0').replace(/0+$/u, '')
  return fraction ? `${whole}.${fraction}` : String(whole)
}
