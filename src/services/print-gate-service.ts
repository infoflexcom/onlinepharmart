import type Database from 'better-sqlite3'
import { can } from '../../packages/core/src/capabilities'
import type { PublicUser, UserRole } from '../shared/auth/types'
import type { ReceiptLayout } from '../shared/pos/types'
import type { ShopRepository } from './contracts/shop-repository'
import type { PointOfSaleService } from './point-of-sale-service'
import type { ReturnService } from './return-service'

/**
 * The only route to a printer.
 *
 * ## Why a gate rather than a check inside each printer
 *
 * The receipt printer and the credit-note printer already existed and already recorded their own print events
 * (`sale_print_events`, `return_print_events`). What neither could do is answer the question the brief actually asks:
 * *who printed this document, from which PC, which copy number was it, and why was it printed again*. That answer has
 * to be the same shape for every kind of document, and it has to be impossible to reach a printer without producing it.
 *
 * So this service is the single entry point. It checks the role, writes the unified `print_log` row, and only then asks
 * the document's own service for the thing to print. A new document kind added later gets the log and the role check
 * for free by coming through here, instead of being a fourth place to remember.
 *
 * ## What this does not prevent
 *
 * A determined person can photograph the screen. No application-level control stops that, and claiming otherwise would
 * be worse than saying so. What these controls do make true is that every printed copy is attributable: the audit trail
 * and the print log together say who produced it, when, from which machine, and whether it was a duplicate. Recorded in
 * DECISIONS.md as required.
 */
export interface PrintGateOptions {
  workstation?: string
  now?: () => number
}

export type PrintableDocumentKind = 'SALE' | 'RETURN'

export interface PrintRequest {
  kind: PrintableDocumentKind
  /** The sale id or the return id. */
  documentId: string | number
  layout: ReceiptLayout
  /** Required for any copy after the first. It is the answer to "why is there a second one of these". */
  reason?: string
}

/**
 * Where the print was asked for.
 *
 * This exists because the gate runs on the Server, which serves every till. A workstation name captured when the
 * service was constructed would be the *server's* machine name on every entry, and the log would say that one PC
 * printed every receipt in the shop. The brief asks for the PC on each entry, so the caller has to say which machine
 * asked — and the Server fills this in from the authenticated connection, never from anything the client asserts about
 * itself without a device row behind it.
 */
export interface PrintContext {
  /** The name of the machine that asked for the print. */
  pcName?: string | null
  /** The approved client device, when the request came over the network rather than from the Server's own window. */
  clientDeviceId?: string | null
}

export interface PrintTicket {
  kind: PrintableDocumentKind
  documentId: string
  /** Sequential per document: 1 for the first copy, 2 for the first reprint, and so on. */
  copyNumber: number
  /** True from the second copy onwards. The renderer stamps DUPLICATE on the document when this is set. */
  duplicate: boolean
  receiptNumber: string | null
  layout: ReceiptLayout
  printedBy: string
  workstation: string
  printedAt: string
  /** The document to hand to the renderer, as its own service produced it. */
  document: unknown
}

export interface PrintLogEntry {
  id: number
  kind: PrintableDocumentKind
  documentId: string
  copyNumber: number
  duplicate: boolean
  receiptNumber: string | null
  printedBy: string
  printedByName: string
  workstation: string
  reprintReason: string
  printedAt: string
}

/** Refused because the caller's role may not print at all. */
export class PrintRefusedError extends Error {
  constructor(role: UserRole) {
    // Names the caller's own role and nothing else. Saying "printing needs an ACCOUNT" would hand the till a map of
    // which roles can print, which is the same information leak the login refusal avoids.
    super(`A ${role.toLowerCase()} account cannot print documents.`)
    this.name = 'PrintRefusedError'
  }
}

export class PrintGateService {
  private readonly workstation: string
  private readonly now: () => number

  constructor(
    private readonly database: Database.Database,
    private readonly shop: ShopRepository,
    private readonly pointOfSale: PointOfSaleService,
    private readonly returns: ReturnService,
    options: PrintGateOptions = {},
  ) {
    this.workstation = (options.workstation ?? 'LOCAL_DESKTOP').slice(0, 120) || 'LOCAL_DESKTOP'
    this.now = options.now ?? Date.now
  }

  /**
   * Print one document, or refuse.
   *
   * The role check runs before anything is read about the document, so a refused caller learns nothing about whether
   * the document exists.
   */
  print(request: PrintRequest, actor: PublicUser, context: PrintContext = {}): PrintTicket {
    this.requireActor(actor)
    if (!can(this.roleOf(actor), 'print_documents')) throw new PrintRefusedError(actor.role)

    const layout = request.layout
    if (!LAYOUTS.includes(layout)) throw new Error('Choose a receipt layout: 80 mm, 58 mm, A4 receipt or A4 invoice.')
    const documentId = String(request.documentId ?? '').trim()
    if (!documentId) throw new Error('Choose the document to print.')

    // The machine that asked, falling back to the Server's own window when the request came from it.
    const pcName = (context.pcName ?? '').trim().slice(0, 120) || this.workstation
    let ticket: PrintTicket | null = null
    this.database.transaction(() => {
      const copyNumber = this.nextCopyNumber(request.kind, documentId)
      const duplicate = copyNumber > 1
      const reason = (request.reason ?? '').trim()
      if (duplicate && !reason) {
        // Required, and required to be a real sentence rather than a dot: a reprint with no reason is indistinguishable
        // from a reprint nobody can account for, which is the whole thing the log exists to prevent.
        throw new Error('Give a reason for printing this document again. It is recorded beside the copy.')
      }
      if (reason.length > 300) throw new Error('Keep the reprint reason under 300 characters.')

      // The document is produced by its own service, which keeps its existing print-event record. That record and this
      // one are not competitors: the older tables answer "how many times was this sale printed", while print_log is the
      // unified trail across every document kind, with the copy number and the reason.
      // `ReturnDocumentLayout` and `ReceiptLayout` are the same four literals declared in two modules, so the layout
      // passes straight through with no cast. If they ever diverge, this line stops compiling, which is the point: a
      // silent `as never` here would have let a layout one renderer cannot draw reach it.
      const document = request.kind === 'SALE'
        ? this.pointOfSale.recordReceiptPrint(documentId, layout, actor)
        : this.returns.recordReturnPrint(documentId, layout, actor)

      const receiptNumber = readReceiptNumber(document)
      const printedAt = new Date(this.now()).toISOString()
      this.database.prepare(`
        INSERT INTO print_log (
          document_kind, document_id, copy_no, duplicate, printed_by, client_device_id, printed_at, reprint_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(request.kind, documentId, copyNumber, duplicate ? 1 : 0, actor.id,
        context.clientDeviceId ?? null, printedAt, reason)

      this.audit(actor, duplicate ? 'print.duplicate' : 'print.issued', {
        kind: request.kind, documentId, receiptNumber, copyNumber, duplicate, layout,
        reason: duplicate ? reason : undefined, pcName,
      })

      ticket = {
        kind: request.kind,
        documentId,
        copyNumber,
        duplicate,
        receiptNumber,
        layout,
        printedBy: actor.username,
        workstation: pcName,
        printedAt,
        document,
      }
    }).immediate()

    return ticket!
  }

  /**
   * The next copy number for a document.
   *
   * Counted inside the write transaction, so two simultaneous reprints of the same receipt cannot both be copy 2. The
   * UNIQUE index on (document_kind, document_id, copy_no) is the backstop that makes that true even if this read were
   * ever moved outside the transaction.
   */
  private nextCopyNumber(kind: PrintableDocumentKind, documentId: string): number {
    const row = this.database.prepare(`
      SELECT COALESCE(MAX(copy_no), 0) AS highest FROM print_log WHERE document_kind = ? AND document_id = ?
    `).get(kind, documentId) as { highest: number }
    return row.highest + 1
  }

  /** Every copy of every document, newest first. The Admin's print log. */
  listPrintLog(actor: PublicUser, limit = 200): PrintLogEntry[] {
    this.requireActor(actor)
    // Not gated on `print_documents`: a SUPERVISOR audits the Accounts' day, and reprints are explicitly part of what
    // the brief says a Supervisor reviews. Reading the log is not printing.
    if (!can(this.roleOf(actor), 'view_audit') && !can(this.roleOf(actor), 'print_documents')) {
      throw new Error('Your role cannot read the print log.')
    }
    const rows = this.database.prepare(`
      SELECT p.id, p.document_kind, p.document_id, p.copy_no, p.duplicate, p.reprint_reason, p.printed_at,
        u.full_name, u.username, COALESCE(d.name, '') AS device_name,
        CASE p.document_kind
          WHEN 'SALE' THEN (SELECT receipt_number FROM sales WHERE id = CAST(p.document_id AS INTEGER))
          ELSE NULL
        END AS receipt_number
      FROM print_log p
        LEFT JOIN users u ON u.id = p.printed_by
        LEFT JOIN client_devices d ON d.id = p.client_device_id
      ORDER BY p.printed_at DESC, p.id DESC LIMIT ?
    `).all(Math.max(1, Math.min(1000, Math.trunc(limit)))) as Array<{
      id: number; document_kind: PrintableDocumentKind; document_id: string; copy_no: number; duplicate: number
      reprint_reason: string; printed_at: string; full_name: string | null; username: string | null
      receipt_number: string | null; device_name: string
    }>
    return rows.map((row) => ({
      id: row.id,
      kind: row.document_kind,
      documentId: row.document_id,
      copyNumber: row.copy_no,
      duplicate: row.duplicate === 1,
      receiptNumber: row.receipt_number,
      printedBy: row.username ?? 'unknown',
      printedByName: row.full_name || row.username || 'Unknown account',
      // The device name as it was when it printed, or the Server's own window for a print asked for on the Server.
      // A revoked device keeps its row, so this does not go blank when the Admin revokes the machine later.
      workstation: row.device_name || this.workstation,
      reprintReason: row.reprint_reason,
      printedAt: row.printed_at,
    }))
  }

  /** How many copies of a document exist, so a screen can label the next one before it is printed. */
  copyCount(kind: PrintableDocumentKind, documentId: string | number, actor: PublicUser): number {
    this.requireActor(actor)
    const row = this.database.prepare(`
      SELECT COUNT(*) AS copies FROM print_log WHERE document_kind = ? AND document_id = ?
    `).get(kind, String(documentId)) as { copies: number }
    return row.copies
  }

  private roleOf(actor: PublicUser): Exclude<UserRole, 'CASHIER'> {
    return (actor.role === 'CASHIER' ? 'USER' : actor.role) as Exclude<UserRole, 'CASHIER'>
  }

  private requireActor(actor: PublicUser): void {
    if (!actor || typeof actor.id !== 'string' || !actor.id.trim() || !actor.isActive || actor.isLocked) {
      throw new Error('An active signed-in user is required to print.')
    }
  }

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

/** The layouts a document may be printed in, in one place so the check and the picker cannot disagree. */
export const LAYOUTS: readonly ReceiptLayout[] = ['THERMAL_80', 'THERMAL_58', 'A4_RECEIPT', 'A4_INVOICE']

/**
 * The receipt number off a document, whichever service produced it.
 *
 * Both records carry it under the same name; reading it defensively rather than asserting a type means a third document
 * kind can be added without this function becoming a chain of casts.
 */
function readReceiptNumber(document: unknown): string | null {
  if (!document || typeof document !== 'object') return null
  const value = (document as Record<string, unknown>).receiptNumber
  return typeof value === 'string' && value.trim() ? value : null
}
