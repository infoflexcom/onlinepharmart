export type ApprovalKind = 'RETURN' | 'DISCOUNT' | 'CREDIT' | 'VOID'
export type ApprovalDecision = 'APPROVE' | 'REJECT'
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'

/** What the desktop approvals screen and the Admin's phone both render. */
export interface ApprovalRequestView {
  id: string
  kind: ApprovalKind
  /** Plain-language heading, e.g. "Discount above the shop limit". */
  label: string
  status: ApprovalStatus
  requester: string
  requestedBy: string
  resolvedBy: string | null
  /** Integer minor units as a string, so no precision is lost between SQLite and JSON. */
  amountMinor: string | null
  currencyCode: string | null
  createdAt: string
  resolvedAt: string | null
  payload: Record<string, unknown>
}
