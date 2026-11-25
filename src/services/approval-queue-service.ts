import type Database from 'better-sqlite3'
import type { PublicUser } from '../shared/auth/types'
import type { ApprovalDecision, ApprovalKind, ApprovalRequestView } from '../shared/approvals/types'

export type { ApprovalDecision, ApprovalKind, ApprovalRequestView }

/**
 * Who may resolve each kind of request.
 *
 * A till user raises them; **only the Admin decides**. The Supervisor used to appear against RETURN, DISCOUNT and
 * VOID, and was removed when the role became audit-only: every one of those three authorises a movement of money or
 * stock, and a role that holds no operational authority cannot be the one granting it. The Supervisor's new surface
 * is `audit_signoffs` and `audit_flags` — it can record that it reviewed a decision, never take one.
 */
const RESOLVERS: Record<ApprovalKind, Array<PublicUser['role']>> = {
  RETURN: ['ADMIN'],
  DISCOUNT: ['ADMIN'],
  CREDIT: ['ADMIN'],
  VOID: ['ADMIN'],
}

const KIND_LABEL: Record<ApprovalKind, string> = {
  RETURN: 'Return above the cashier’s limit',
  DISCOUNT: 'Discount above the shop limit',
  CREDIT: 'Credit above the customer’s limit',
  VOID: 'Void a completed sale',
}

interface RequestRow {
  id: string
  request_type: string
  requested_by: string
  approved_by: string | null
  status: string
  payload_json: string
  created_at: string
  resolved_at: string | null
  requester_name: string | null
  resolver_name: string | null
}

export interface RaiseApprovalInput {
  kind: ApprovalKind
  actor: PublicUser
  payload: Record<string, unknown>
  /** Amount in integer minor units, used for display and ordering only; never for arithmetic on floats. */
  amountMinor?: bigint
  currencyCode: string
}

export interface ApprovalListener {
  (event: { type: 'approval.created' | 'approval.resolved'; request: ApprovalRequestView }): void
}

/**
 * One queue for every decision a cashier cannot make alone: a discount above the cap, credit above the
 * customer's limit, a return above the limit, and voiding a completed sale. The desktop approvals screen and
 * the Admin's phone read the same rows, and both are notified over the same WebSocket when one resolves.
 */
export class ApprovalQueueService {
  private readonly listeners = new Set<ApprovalListener>()

  constructor(
    private readonly database: Database.Database,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  subscribe(listener: ApprovalListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Inserts the request inside the caller's transaction, so a sale/return and its approval request cannot
   * diverge. Callers that use this must call `announce()` after committing; `raise()` does both for them.
   */
  raiseInTransaction(input: RaiseApprovalInput): ApprovalRequestView {
    const actor = requireActor(input.actor)
    const createdAt = this.now().toISOString()
    const id = this.newId()
    const payload = {
      ...input.payload,
      kind: input.kind,
      label: KIND_LABEL[input.kind],
      requester: actor.fullName,
      currencyCode: input.currencyCode,
      ...(input.amountMinor === undefined ? {} : { amountMinor: input.amountMinor.toString() }),
    }
    this.database.prepare(`
      INSERT INTO approval_requests (id, request_type, requested_by, status, payload_json, created_at)
      VALUES (?, ?, ?, 'PENDING', ?, ?)
    `).run(id, input.kind, actor.id, JSON.stringify(payload), createdAt)
    this.audit(actor.username, 'approvals.requested', { ...payload, requestId: id })
    return this.read(id)
  }

  raise(input: RaiseApprovalInput): ApprovalRequestView {
    const view = this.database.transaction(() => this.raiseInTransaction(input)).immediate()
    // Announced only after the row is committed, so no listener can react to a request that then rolls back.
    this.emit({ type: 'approval.created', request: view })
    return view
  }

  listPending(actor: PublicUser): ApprovalRequestView[] {
    const verified = requireActor(actor)
    // The kind list is a fixed literal with bound values, never interpolated SQL.
    const rows = this.database.prepare(`
      SELECT r.*, u.full_name AS requester_name, a.full_name AS resolver_name
      FROM approval_requests r
      LEFT JOIN users u ON u.id = r.requested_by
      LEFT JOIN users a ON a.id = r.approved_by
      WHERE r.status = 'PENDING'
        AND r.request_type IN ('RETURN', 'DISCOUNT', 'CREDIT', 'VOID')
      ORDER BY r.created_at ASC, r.id ASC LIMIT 200
    `).all() as RequestRow[]
    // A supervisor sees return/discount/void; only an Admin sees credit requests.
    return rows
      .filter((row) => RESOLVERS[row.request_type as ApprovalKind]?.includes(verified.role))
      .map((row) => toView(row))
  }

  listRecent(actor: PublicUser, limit = 50): ApprovalRequestView[] {
    requireActor(actor)
    const rows = this.database.prepare(`
      SELECT r.*, u.full_name AS requester_name, a.full_name AS resolver_name
      FROM approval_requests r
      LEFT JOIN users u ON u.id = r.requested_by
      LEFT JOIN users a ON a.id = r.approved_by
      WHERE r.status <> 'PENDING'
      ORDER BY r.resolved_at DESC, r.created_at DESC LIMIT ?
    `).all(Math.min(Math.max(limit, 1), 200)) as RequestRow[]
    return rows.map(toView)
  }

  /**
   * Resolves one request. The status update is conditional on the row still being PENDING, so two Admins
   * pressing Approve at the same moment cannot both succeed: the loser gets a clear "already decided".
   */
  resolveInTransaction(requestId: string, decision: ApprovalDecision, actor: PublicUser): ApprovalRequestView {
    const verified = requireActor(actor)
    if (decision !== 'APPROVE' && decision !== 'REJECT') throw new Error('Choose approve or reject for this request.')
    const row = this.database.prepare('SELECT request_type, status FROM approval_requests WHERE id = ?')
      .get(requestId) as { request_type: string; status: string } | undefined
    if (!row) throw new Error('That approval request no longer exists.')
    const kind = row.request_type as ApprovalKind
    const resolvers = RESOLVERS[kind]
    if (!resolvers) throw new Error('That request is not part of the approvals queue.')
    if (!resolvers.includes(verified.role)) {
      throw new Error('Only an Admin can decide this request.')
    }
    if (row.status !== 'PENDING') throw new Error('This request was already decided.')
    const resolvedAt = this.now().toISOString()
    const result = this.database.prepare(`
      UPDATE approval_requests SET status = ?, approved_by = ?, resolved_at = ?
      WHERE id = ? AND status = 'PENDING'
    `).run(decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', verified.id, resolvedAt, requestId)
    if (result.changes !== 1) throw new Error('This request was already decided on another screen.')
    this.audit(verified.username, decision === 'APPROVE' ? 'approvals.approved' : 'approvals.rejected', {
      requestId, kind,
    })
    return this.read(requestId)
  }

  resolve(requestId: string, decision: ApprovalDecision, actor: PublicUser): ApprovalRequestView {
    const view = this.database.transaction(() => this.resolveInTransaction(requestId, decision, actor)).immediate()
    this.emit({ type: 'approval.resolved', request: view })
    return view
  }

  /** Emits the "created" event for a request inserted with `raiseInTransaction`. */
  announce(request: ApprovalRequestView): void {
    this.emit({ type: 'approval.created', request })
  }

  /** Count for the badge the cashier's screen and the Admin's phone both show. */
  pendingCount(actor: PublicUser): number {
    return this.listPending(actor).length
  }

  read(requestId: string): ApprovalRequestView {
    const row = this.database.prepare(`
      SELECT r.*, u.full_name AS requester_name, a.full_name AS resolver_name
      FROM approval_requests r
      LEFT JOIN users u ON u.id = r.requested_by
      LEFT JOIN users a ON a.id = r.approved_by
      WHERE r.id = ?
    `).get(requestId) as RequestRow | undefined
    if (!row) throw new Error('That approval request no longer exists.')
    return toView(row)
  }

  private emit(event: { type: 'approval.created' | 'approval.resolved'; request: ApprovalRequestView }): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // A broken subscriber must never break the queue.
      }
    }
  }

  private audit(actor: string, action: string, metadata: Record<string, unknown>): void {
    this.database.prepare(`
      INSERT INTO audit_log (id, actor, action, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(this.newId(), actor, action, JSON.stringify(metadata), this.now().toISOString())
  }
}

function toView(row: RequestRow): ApprovalRequestView {
  let payload: Record<string, unknown> = {}
  try {
    payload = JSON.parse(row.payload_json) as Record<string, unknown>
  } catch {
    payload = {}
  }
  const kind = row.request_type as ApprovalKind
  return {
    id: row.id,
    kind,
    label: typeof payload.label === 'string' ? payload.label : kind.replaceAll('_', ' ').toLowerCase(),
    status: row.status as ApprovalRequestView['status'],
    requester: row.requester_name ?? 'Unknown user',
    requestedBy: row.requested_by,
    resolvedBy: row.resolver_name,
    amountMinor: typeof payload.amountMinor === 'string' ? payload.amountMinor : null,
    currencyCode: typeof payload.currencyCode === 'string' ? payload.currencyCode : null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    payload,
  }
}

function requireActor(actor: PublicUser | null | undefined): PublicUser {
  if (!actor || !actor.id || !actor.role) throw new Error('Sign in before using the approvals queue.')
  return actor
}
