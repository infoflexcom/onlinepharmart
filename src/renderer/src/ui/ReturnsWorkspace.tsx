import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { formatMoney } from '@shared/currency/money'
import { ApprovalsPanel } from './ApprovalsPanel'
import { formatPosQuantity } from '@shared/pos/receipt-format'
import type { PublicUser } from '@shared/auth/types'
import type { InfoflexBridge } from '@shared/bridge'
import type { BootstrapData } from '@shared/shop/types'
import type {
  ReturnDocumentLayout,
  ReturnItemCondition,
  ReturnRecord,
  ReturnReason,
  ReturnSaleRecord,
  ReturnType as ReturnKind,
} from '@shared/returns/types'
import { ReturnNoteDocument, returnDocumentText } from './ReturnNoteDocument'

interface Props {
  bridge: InfoflexBridge
  bootstrap: BootstrapData
  user: PublicUser
}

interface ReturnDraftLine {
  quantity: string
  condition: ReturnItemCondition
}

const REASONS: Array<{ value: ReturnReason; label: string }> = [
  { value: 'WRONG_ITEM', label: 'Wrong item' },
  { value: 'DAMAGED', label: 'Damaged' },
  { value: 'EXPIRED', label: 'Expired' },
  { value: 'CUSTOMER_CHANGED_MIND', label: 'Customer changed mind' },
  { value: 'OTHER', label: 'Other' },
]
const CONDITIONS: Array<{ value: ReturnItemCondition; label: string }> = [
  { value: 'RESELLABLE', label: 'Sealed / resellable' },
  { value: 'OPENED', label: 'Opened — write off' },
  { value: 'EXPIRED', label: 'Expired — write off' },
  { value: 'DAMAGED', label: 'Damaged — write off' },
  { value: 'OTHER_NON_RESELLABLE', label: 'Other non-resellable — write off' },
]
const DOCUMENT_LAYOUTS: Array<{ value: ReturnDocumentLayout; label: string }> = [
  { value: 'THERMAL_80', label: '80 mm thermal' },
  { value: 'THERMAL_58', label: '58 mm thermal' },
  { value: 'A4_RECEIPT', label: 'A4 return note' },
  { value: 'A4_INVOICE', label: 'A4 credit note' },
]

export function ReturnsWorkspace({ bridge, bootstrap, user }: Props) {
  const pharmacy = bootstrap.setupContext.edition === 'PHARMACY' || bootstrap.setupContext.edition === 'BOTH'
  const canApprove = user.role === 'ADMIN' || user.role === 'SUPERVISOR'
  const [receiptInput, setReceiptInput] = useState('')
  const [sale, setSale] = useState<ReturnSaleRecord | null>(null)
  const [draftLines, setDraftLines] = useState<Record<string, ReturnDraftLine>>({})
  const [reason, setReason] = useState<ReturnReason>('CUSTOMER_CHANGED_MIND')
  const [reasonNote, setReasonNote] = useState('')
  const [returnType, setReturnType] = useState<ReturnKind>('REFUND')
  const [refundMethod, setRefundMethod] = useState<'CASH' | 'TRANSFER' | 'CARD'>('CASH')
  const [paymentReference, setPaymentReference] = useState('')
  const [overrideWindow, setOverrideWindow] = useState(false)
  const [overrideReason, setOverrideReason] = useState('')
  const [history, setHistory] = useState<ReturnRecord[]>([])
  const [document, setDocument] = useState<ReturnRecord | null>(null)
  const [layout, setLayout] = useState<ReturnDocumentLayout>('A4_RECEIPT')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const refreshHistory = useCallback(async () => {
    try {
      setHistory(await bridge.listReturns())
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }, [bridge])

  useEffect(() => { void refreshHistory() }, [refreshHistory])

  async function findReceipt(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setError('')
    setMessage('')
    setSale(null)
    setBusy(true)
    try {
      const found = await bridge.findSaleForReturn(receiptInput)
      setSale(found)
      setDraftLines(Object.fromEntries(found.items.map((item) => [item.saleItemId, { quantity: '', condition: 'RESELLABLE' as const }])))
      setOverrideWindow(false)
      setOverrideReason('')
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  function updateDraftLine(saleItemId: string, change: Partial<ReturnDraftLine>): void {
    setDraftLines((current) => ({ ...current, [saleItemId]: { ...(current[saleItemId] ?? { quantity: '', condition: 'RESELLABLE' }), ...change } }))
  }

  async function submitReturn(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!sale) return
    setError('')
    setMessage('')
    const items = sale.items.flatMap((item) => {
      const draft = draftLines[item.saleItemId]
      return draft?.quantity.trim() ? [{ saleItemId: item.saleItemId, quantity: draft.quantity, condition: draft.condition }] : []
    })
    if (!items.length) {
      setError('Enter a return quantity for at least one item.')
      return
    }
    setBusy(true)
    try {
      const result = await bridge.createReturn({
        receiptNumber: sale.receiptNumber,
        reason,
        reasonNote,
        type: returnType,
        refundMethod: returnType === 'REFUND' ? refundMethod : undefined,
        paymentReference: returnType === 'REFUND' ? paymentReference : undefined,
        items,
        overrideReturnWindow: overrideWindow,
        windowOverrideReason: overrideWindow ? overrideReason : undefined,
        idempotencyKey: makeIdempotencyKey(),
      })
      setSale(null)
      setDraftLines({})
      setReceiptInput('')
      if (result.status === 'COMPLETED') {
        setDocument(result)
        setMessage(`${result.returnNumber} completed for ${formatMoney(result.totalMinor, result.currency, result.display)}.`)
      } else {
        setMessage(`${result.returnNumber} is pending Admin/Supervisor approval. No refund or stock change has been applied yet.`)
      }
      await refreshHistory()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  async function resolveApproval(returnId: number, decision: 'APPROVE' | 'REJECT'): Promise<void> {
    setError('')
    setMessage('')
    setBusy(true)
    try {
      const result = await bridge.resolveReturnApproval(returnId, decision)
      setMessage(decision === 'APPROVE'
        ? `${result.returnRecord.returnNumber} approved and completed.`
        : `${result.returnRecord.returnNumber} rejected; its reserved quantity is available again.`)
      if (decision === 'APPROVE') setDocument(result.returnRecord)
      await refreshHistory()
      if (sale) setSale(await bridge.findSaleForReturn(sale.receiptNumber))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  async function openDocument(returnId: number): Promise<void> {
    setError('')
    try {
      setDocument(await bridge.getReturnDocument(returnId))
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  async function printDocument(): Promise<void> {
    if (!document) return
    setBusy(true)
    setError('')
    try {
      const printed = await bridge.recordReturnPrint(document.id, layout)
      setDocument(printed)
      const cleanupPrintMode = () => window.document.body.classList.remove('printing-return-note')
      window.document.body.classList.add('printing-return-note')
      window.addEventListener('afterprint', cleanupPrintMode, { once: true })
      window.setTimeout(() => {
        try { window.print() } catch { cleanupPrintMode() }
      }, 0)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  async function shareDocument(): Promise<void> {
    if (!document) return
    const text = returnDocumentText(document)
    try {
      if (navigator.share) await navigator.share({ title: document.type === 'REFUND' ? 'Return note' : 'Credit note', text })
      else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        setMessage('Return note copied. Paste it into a message or email to share.')
      } else throw new Error('Sharing is unavailable in this window. Use Print and save the document as a PDF.')
    } catch (caught) {
      if (caught instanceof Error && caught.name === 'AbortError') return
      setError(errorMessage(caught))
    }
  }

  const pending = history.filter((record) => record.status === 'PENDING' && record.approvalRequestId)
  const recent = history.filter((record) => record.status !== 'PENDING')
  const selectedCount = sale ? sale.items.filter((item) => Boolean(draftLines[item.saleItemId]?.quantity.trim())).length : 0

  return (
    <section className="returns-workspace">
      {/* The queue sits above the return form so a cashier sees the decision without hunting for it. */}
      <ApprovalsPanel
        bridge={bridge}
        currency={bootstrap.settings.currency}
        canDecide={canApprove}
        pollMs={5_000}
      />
      <div className="returns-heading">
        <div><span className="eyebrow eyebrow--gold">SALES SUPPORT</span><h2>Returns and credit notes</h2><p>Search a completed receipt, enter only the returned quantities, then review the stock disposition before completing.</p></div>
        <div className="returns-limit"><span>Your return limit</span><strong>{formatMoney(user.permissions.returnLimitMinor, bootstrap.settings.currency, bootstrap.settings.display)}</strong><small>Amounts are compared in integer minor units.</small></div>
      </div>

      {error && <div className="form-error" role="alert"><span>!</span>{error}</div>}
      {message && <div className="success-message" role="status">{message}</div>}

      <section className="management-card returns-search-card">
        <div className="management-card__header"><div><span className="eyebrow eyebrow--gold">FIND ORIGINAL SALE</span><h3>Receipt lookup</h3><p>Returns are linked to the completed sale. A receipt cannot be changed or deleted by this workflow.</p></div></div>
        <form className="returns-search-form" onSubmit={(event) => void findReceipt(event)}>
          <label className="field"><span>Receipt number</span><input required maxLength={48} value={receiptInput} onChange={(event) => setReceiptInput(event.target.value.toUpperCase())} placeholder="R-0000000001" autoComplete="off" /></label>
          <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Working…' : 'Find receipt'}</button>
        </form>
      </section>

      {sale && <section className="management-card return-sale-card">
        <div className="management-card__header"><div><span className="eyebrow eyebrow--gold">ORIGINAL SALE</span><h3>{sale.receiptNumber} · {sale.store.name || 'Saved store'}</h3><p>{new Date(sale.createdAt).toLocaleString()} · Cashier {sale.cashier || '—'} · Original total <strong>{formatMoney(sale.totalMinor, sale.currency, sale.display)}</strong></p></div><span className={sale.withinReturnWindow ? 'return-window-pill is-open' : 'return-window-pill is-closed'}>{sale.withinReturnWindow ? `${sale.returnWindowDays}-day window open` : `Outside ${sale.returnWindowDays}-day window`}</span></div>
        {!sale.withinReturnWindow && <div className="return-window-alert">This sale is outside the configured return window. Only an Admin can proceed with a written override reason.</div>}
        <form className="return-request-form" onSubmit={(event) => void submitReturn(event)}>
          <div className="return-item-list">
            <div className="return-item-list__heading"><strong>Receipt items</strong><span>{selectedCount} selected</span></div>
            {sale.items.map((item) => {
              const draft = draftLines[item.saleItemId] ?? { quantity: '', condition: 'RESELLABLE' as const }
              return <div className="return-line" key={item.saleItemId}>
                <div className="return-line__identity"><strong>{item.description}</strong><small>{item.sku || 'No SKU'} · Sold {formatPosQuantity(item.quantityMilli, item.unit)} · Already returned {formatPosQuantity(item.returnedQuantityMilli, item.unit)}</small>
                  {item.expiryTracked && <small className="return-line__batch">Pharmacy: resellable items return to the original saved batch. Opened/expired items are always written off.</small>}
                  {item.batches.length > 0 && <small className="return-line__batch">Original batch allocation: {item.batches.map((batch) => `${batch.batchNumber} (${formatPosQuantity(batch.quantityMilli, item.unit)}, exp ${batch.expiryDate})`).join(' · ')}</small>}
                </div>
                <label className="field"><span>Return qty <small>Available {formatPosQuantity(item.returnableQuantityMilli, item.unit)}</small></span><input inputMode="decimal" type="text" value={draft.quantity} disabled={item.returnableQuantityMilli === 0n || busy} onChange={(event) => updateDraftLine(item.saleItemId, { quantity: event.target.value })} placeholder="0" /></label>
                <label className="field"><span>Item condition</span><select value={draft.condition} disabled={busy} onChange={(event) => updateDraftLine(item.saleItemId, { condition: event.target.value as ReturnItemCondition })}>{CONDITIONS.map((condition) => <option key={condition.value} value={condition.value}>{condition.label}</option>)}</select></label>
                <div className="return-line__value"><span>Original line value</span><strong>{formatMoney(item.lineTotalMinor, sale.currency, sale.display)}</strong></div>
              </div>
            })}
          </div>

          <div className="return-form-grid">
            <label className="field"><span>Reason</span><select value={reason} onChange={(event) => setReason(event.target.value as ReturnReason)} disabled={busy}>{REASONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
            <label className="field"><span>Return type</span><select value={returnType} onChange={(event) => setReturnType(event.target.value as ReturnKind)} disabled={busy}><option value="REFUND">Refund</option><option value="STORE_CREDIT">Store credit</option><option value="EXCHANGE">Exchange</option></select></label>
            {returnType === 'REFUND' && <label className="field"><span>Refund method</span><select value={refundMethod} onChange={(event) => setRefundMethod(event.target.value as typeof refundMethod)} disabled={busy}><option value="CASH">Cash</option><option value="TRANSFER">Transfer</option><option value="CARD">Card / POS</option></select></label>}
            {returnType === 'REFUND' && <label className="field"><span>Payment reference <small>Optional</small></span><input maxLength={120} value={paymentReference} onChange={(event) => setPaymentReference(event.target.value)} disabled={busy} /></label>}
            {reason === 'OTHER' && <label className="field field--wide"><span>Reason note</span><input required maxLength={240} value={reasonNote} onChange={(event) => setReasonNote(event.target.value)} disabled={busy} /></label>}
            {(reason === 'DAMAGED' || reason === 'EXPIRED') && <p className="return-policy-note field--wide">{reason === 'EXPIRED' ? 'Expired goods are recorded as write-offs and cannot be returned to sellable stock.' : 'Damaged items are recorded as write-offs unless a different non-damaged reason is selected.'}</p>}
            {!sale.withinReturnWindow && user.role === 'ADMIN' && <div className="return-override field--wide">
              <label className="return-override-check"><input type="checkbox" checked={overrideWindow} onChange={(event) => setOverrideWindow(event.target.checked)} disabled={busy} /> <span>Override the return window as Admin</span></label>
              {overrideWindow && <label className="field"><span>Override reason</span><input required maxLength={240} value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} disabled={busy} /></label>}
            </div>}
          </div>
          {returnType !== 'REFUND' && <p className="return-policy-note">Store credit and exchange create a saved credit note in the original sale currency. No cash refund is issued for these types.</p>}
          <div className="return-submit-row"><span>{pharmacy ? 'Opened or expired Pharmacy items are written off; sealed eligible items return to their original batch.' : 'Non-resellable returned items are recorded as write-offs.'}</span><button className="primary-button" type="submit" disabled={busy || (!sale.withinReturnWindow && (user.role !== 'ADMIN' || !overrideWindow || !overrideReason.trim()))}>{busy ? 'Processing…' : 'Submit return'}</button></div>
        </form>
      </section>}

      {canApprove && <section className="management-card">
        <div className="management-card__header"><div><span className="eyebrow eyebrow--gold">APPROVAL QUEUE</span><h3>Returns awaiting approval</h3><p>Above-limit requests have no stock, payment, or loyalty effect until an Admin or Supervisor approves them. Mobile approvals are Admin-only.</p></div><span className="inventory-count">{pending.length} pending</span></div>
        {pending.length === 0 ? <p className="empty-list">No return approvals are waiting.</p> : <div className="return-approval-list">{pending.map((record) => <div className="return-approval-row" key={record.id}>
          <div><strong>{record.returnNumber} · {record.receiptNumber}</strong><small>{record.cashier} · {reasonLabel(record.reason)} · {new Date(record.createdAt).toLocaleString()}</small></div>
          <bdi dir="ltr">{formatMoney(record.totalMinor, record.currency, record.display)}</bdi>
          <div className="return-approval-actions"><button type="button" className="secondary-button" disabled={busy || record.cashierId === user.id} onClick={() => void resolveApproval(record.id, 'REJECT')}>Reject</button><button type="button" className="primary-button" disabled={busy || record.cashierId === user.id} onClick={() => void resolveApproval(record.id, 'APPROVE')}>Approve</button></div>
        </div>)}</div>}
      </section>}

      <section className="management-card">
        <div className="management-card__header"><div><span className="eyebrow eyebrow--gold">HISTORY</span><h3>Recent returns</h3><p>Completed notes preserve the original sale’s saved store name and currency display.</p></div></div>
        {recent.length === 0 ? <p className="empty-list">Completed and rejected returns will appear here.</p> : <div className="return-history-list">{recent.map((record) => <div className="return-history-row" key={record.id}>
          <div><strong>{record.returnNumber} · {record.receiptNumber}</strong><small>{record.status} · {record.type.replace('_', ' ')} · {new Date(record.createdAt).toLocaleString()}</small></div>
          <bdi dir="ltr">{formatMoney(record.totalMinor, record.currency, record.display)}</bdi>
          {record.status === 'COMPLETED' && <button type="button" className="text-button" onClick={() => void openDocument(record.id)}>View note</button>}
        </div>)}</div>}
      </section>

      {document && <div className="pos-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDocument(null) }}>
        <section className="pos-modal pos-receipt-modal return-document-modal" role="dialog" aria-modal="true" aria-labelledby="return-document-title">
          <header className="pos-modal-header pos-receipt-modal-header"><div><span className="eyebrow eyebrow--gold">{document.type === 'REFUND' ? 'RETURN NOTE' : 'CREDIT NOTE'}</span><h3 id="return-document-title">{document.returnNumber}{document.duplicate && <em className="pos-duplicate-pill">DUPLICATE</em>}</h3><p>Saved store: {document.store.name} · Original receipt: {document.receiptNumber}</p></div><button type="button" aria-label="Close document" onClick={() => setDocument(null)}>×</button></header>
          <div className="pos-print-controls"><label><span>Document layout</span><select value={layout} onChange={(event) => setLayout(event.target.value as ReturnDocumentLayout)}>{DOCUMENT_LAYOUTS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><small>Amounts use the original sale’s saved {document.currency.code} currency and display.</small><button type="button" className="secondary-button" disabled={busy} onClick={() => void shareDocument()}>Share / copy</button><button type="button" className="primary-button" disabled={busy} onClick={() => void printDocument()}>Print / PDF</button></div>
          <div className="return-note-preview-scroll"><div className="return-note-print-root"><ReturnNoteDocument record={document} layout={layout} /></div></div>
        </section>
      </div>}
    </section>
  )
}

function reasonLabel(reason: ReturnReason): string {
  return REASONS.find((item) => item.value === reason)?.label ?? reason
}

function makeIdempotencyKey(): string {
  if (globalThis.crypto?.randomUUID) return `return-${globalThis.crypto.randomUUID()}`
  return `return-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The return could not be completed.'
}
