import { useCallback, useEffect, useState } from 'react'
import type { InfoflexBridge } from '@shared/bridge'
import type { ApprovalRequestView } from '@shared/approvals/types'
import { formatMoney } from '@shared/currency/money'
import type { CurrencyDefinition } from '@shared/currency/catalog'

interface Props {
  bridge: InfoflexBridge
  currency: CurrencyDefinition
  /** Only an Admin or Supervisor can decide; the queue says so too, and the host enforces it. */
  canDecide: boolean
  /** How often to re-read the queue so a cashier's screen updates without pressing Refresh. */
  pollMs?: number
  /**
   * Optional first paint. The panel refreshes from the host immediately either way; supplying a snapshot avoids
   * a flash of "nothing waiting" on a queue that matters (and makes the panel renderable without side effects).
   */
  initialPending?: ApprovalRequestView[]
  initialRecent?: ApprovalRequestView[]
}

/**
 * The approvals queue. A cashier sees what is waiting and who is dealing with it; an Admin or Supervisor can
 * decide. It polls the host rather than relying only on the WebSocket, so a dropped connection degrades to a
 * short delay instead of a blank screen.
 */
export function ApprovalsPanel({ bridge, currency, canDecide, pollMs = 5_000, initialPending, initialRecent }: Props) {
  const [pending, setPending] = useState<ApprovalRequestView[]>(initialPending ?? [])
  const [recent, setRecent] = useState<ApprovalRequestView[]>(initialRecent ?? [])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const reload = useCallback(async () => {
    const [nextPending, nextRecent] = await Promise.all([
      bridge.listPendingApprovals(),
      bridge.listRecentApprovals(),
    ])
    setPending(nextPending)
    setRecent(nextRecent)
    return nextPending
  }, [bridge])

  useEffect(() => {
    let active = true
    void reload().catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : 'The approvals queue could not be loaded.')
    })
    return () => { active = false }
  }, [reload])

  useEffect(() => {
    const timer = window.setInterval(() => {
      void reload().catch(() => undefined)
    }, pollMs)
    return () => window.clearInterval(timer)
  }, [reload, pollMs])

  async function decide(request: ApprovalRequestView, decision: 'APPROVE' | 'REJECT'): Promise<void> {
    setBusy(request.id)
    setError('')
    setMessage('')
    try {
      await bridge.resolveApproval(request.id, decision)
      await reload()
      setMessage(`${request.label} for ${request.requester}: ${decision === 'APPROVE' ? 'approved' : 'rejected'}. The cashier’s screen updates now.`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'That decision could not be saved.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="approvals" aria-labelledby="approvals-title">
      <header className="approvals__header">
        <div>
          <span className="mobile-access__eyebrow">WAITING FOR A DECISION</span>
          <h2 id="approvals-title">Approvals {pending.length > 0 && <span className="approvals__badge">{pending.length}</span>}</h2>
          <p>Discounts above the limit, credit above a customer’s limit, returns above the limit, and voids. The cashier sees your decision immediately.</p>
        </div>
      </header>

      {error && <div className="form-error" role="alert">{error}</div>}
      {message && <div className="mobile-access__notice is-success" role="status">{message}</div>}

      {pending.length === 0
        ? <p className="mobile-access__empty">Nothing is waiting for approval.</p>
        : <ul className="approvals__list">
          {pending.map((request) => <li key={request.id} className="approvals__item">
            <div className="approvals__info">
              <strong>{request.label}</strong>
              <span>
                {request.requester} · {formatWhen(request.createdAt)}
                {request.amountMinor && request.currencyCode
                  ? ` · ${formatAmount(request.amountMinor, request.currencyCode, currency)}`
                  : ''}
              </span>
            </div>
            {canDecide
              ? <div className="mobile-access__actions">
                <button type="button" className="mobile-access__button is-primary" disabled={busy === request.id} onClick={() => void decide(request, 'APPROVE')}>Approve</button>
                <button type="button" className="mobile-access__button is-danger" disabled={busy === request.id} onClick={() => void decide(request, 'REJECT')}>Reject</button>
              </div>
              : <span className="approvals__waiting">Waiting for an Admin or Supervisor</span>}
          </li>)}
        </ul>}

      {recent.length > 0 && <details className="approvals__recent">
        <summary>Recently decided ({recent.length})</summary>
        <ul>
          {recent.map((request) => <li key={request.id}>
            <span className={`approvals__pill is-${request.status.toLowerCase()}`}>{request.status}</span>
            {request.label} · {request.requester}
            {request.resolvedBy ? ` · decided by ${request.resolvedBy}` : ''}
            {request.resolvedAt ? ` · ${formatWhen(request.resolvedAt)}` : ''}
          </li>)}
        </ul>
      </details>}
    </section>
  )
}

/** Amounts arrive as integer minor units; the shop's own currency formatting renders them. */
function formatAmount(amountMinor: string, currencyCode: string, fallback: CurrencyDefinition): string {
  try {
    const currency = currencyCode === fallback.code ? fallback : { ...fallback, code: currencyCode }
    return formatMoney(BigInt(amountMinor), currency)
  } catch {
    return `${amountMinor} ${currencyCode}`
  }
}

function formatWhen(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}
