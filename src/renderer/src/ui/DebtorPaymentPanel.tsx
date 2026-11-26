import { useState } from 'react'
import type { FormEvent } from 'react'
import { formatMoney } from '@shared/currency/money'
import type { BootstrapData } from '@shared/shop/types'
import type { DebtorReportRow, RecordDebtorPaymentInput } from '@shared/reports/types'

interface Props {
  /** The report's own debtor list — one member, read the same way by the Admin's section and the ACCOUNT's summary. */
  debtors: { totalBalanceMinor: bigint; items: DebtorReportRow[] }
  currency: BootstrapData['settings']['currency']
  display: BootstrapData['settings']['display']
  busy: boolean
  /**
   * Whether the caller holds `record_debtor_payment`.
   *
   * The screen derives it from the same capability set the Server enforces rather than from a role name written here, so
   * this panel cannot offer a control the Server would refuse — and cannot keep offering one to a role that loses the
   * capability. Reading a report and moving a customer's money are not the same permission, and a panel that assumed
   * they were would hand the second to everybody it handed the first.
   */
  mayRecordPayment: boolean
  /**
   * Take the payment. Resolves `true` when the Server took it, so the form can clear itself; on a refusal it resolves
   * `false` and keeps what was typed, because a refused amount is usually a mistyped amount and emptying the field makes
   * the person retype it from memory of what they meant.
   */
  onRecord(input: RecordDebtorPaymentInput): Promise<boolean>
}

/** The methods the Server accepts for a payment against a balance, in the order the till reaches for them. */
const METHODS: Array<{ value: RecordDebtorPaymentInput['method']; label: string }> = [
  // Cash first, and named as the one that changes the drawer: it is the only method that moves what the day close
  // expects to find, and the person taking it is standing at a drawer.
  { value: 'CASH', label: 'Cash — goes into the drawer' },
  { value: 'TRANSFER', label: 'Bank transfer' },
  { value: 'CARD', label: 'Card / POS' },
]

/**
 * Money owed by customers, and the one place it can be settled.
 *
 * The list itself has always been in the Admin's Debtors section. What was missing was the act: `record_debtor_payment`
 * has been an ACCOUNT capability since the capability table was written, the service and the IPC channel behind it are
 * built and tested, and no control anywhere in the product called them. A capability with nothing to call it is not a
 * restriction, it is an omission — and the omission fell on the one role the brief describes as the one that "records
 * debtor payments".
 *
 * So the panel appears in both places the balances appear: under Debtors for an Admin, and in the day summary for an
 * ACCOUNT, who has no section selector because the Admin's detailed sections carry costs this role is not shown.
 *
 * The form asks for the four things the Server stores — an amount, a method, a reference and a note — and validates
 * nothing else. The refusals are the Server's own sentences ("Bode Stores owes nothing, so there is no payment to take.",
 * "…cannot be more than what is owed"), because a screen that re-implemented them would eventually word one differently
 * and the two would disagree about what is allowed.
 */
export function DebtorPaymentPanel({ debtors, currency, display, busy, mayRecordPayment, onRecord }: Props) {
  const [chosen, setChosen] = useState<DebtorReportRow | null>(null)
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<RecordDebtorPaymentInput['method']>('CASH')
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')

  const money = (value: bigint): string => formatMoney(value, currency, display)

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (chosen === null) return
    const taken = await onRecord({
      customerId: chosen.customerId,
      amount: amount.trim(),
      method,
      reference: reference.trim(),
      note: note.trim(),
    })
    if (taken) {
      setChosen(null)
      setAmount('')
      setReference('')
      setNote('')
      setMethod('CASH')
    }
  }

  function choose(row: DebtorReportRow): void {
    setChosen(row)
    setAmount('')
    setReference('')
    setNote('')
  }

  return (
    <section className="management-card report-detail-panel">
      <div className="management-card__header">
        <div>
          <span className="eyebrow eyebrow--gold">CUSTOMER BALANCES</span>
          <h3>Money owed by customers</h3>
          <p>
            Outstanding positive balances, in the shop's own currency. Taking a payment here moves the customer's balance
            and, when it is cash, the drawer the day close will count — in one step, so the two cannot disagree.
          </p>
        </div>
      </div>

      <div className="report-total-banner">
        <span>Total outstanding</span>
        <strong>{money(debtors.totalBalanceMinor)}</strong>
        <small>{debtors.items.length} customer account{debtors.items.length === 1 ? '' : 's'}</small>
      </div>

      {debtors.items.length === 0
        ? <p className="reports-empty reports-empty--table">No customer credit balances are outstanding.</p>
        : (
          <div className="report-table-scroll">
            <table className="report-table">
              <thead>
                <tr>
                  <th>Customer</th><th>Phone</th><th>Balance</th><th>Credit limit</th>
                  {mayRecordPayment && <th>Take a payment</th>}
                </tr>
              </thead>
              <tbody>
                {debtors.items.map((row) => (
                  <tr key={row.customerId}>
                    <td>{row.customerName}</td>
                    <td>{row.phone || '—'}</td>
                    <td className="report-money">{money(row.balanceMinor)}</td>
                    <td className="report-money">{row.creditLimitMinor > 0n ? money(row.creditLimitMinor) : 'No limit set'}</td>
                    {mayRecordPayment && (
                      <td>
                        <button
                          type="button"
                          className="secondary-button debtor-take-payment"
                          disabled={busy}
                          onClick={() => choose(row)}
                        >
                          {chosen?.customerId === row.customerId ? 'Entering a payment' : 'Take a payment'}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      {mayRecordPayment === false && (
        /* Stated, in the same spirit as the audit screen stating that it cannot print: a control that is not there
           should say why, or it reads as a screen that failed to load. It does not name the role that may, which is the
           same information a refusal withholds. */
        <p className="reports-note">
          This view can read what customers owe. It cannot take a payment against a balance.
        </p>
      )}

      {/* One condition for the whole entry, written once: the heading and the form belong together, and two adjacent
          siblings each testing the same thing is two places for them to drift apart.

          The customer is named in a line of its own rather than in a disabled field: who the payment is from is the one
          thing on this form that must not be a guess, and a read-only input's value is not text anybody reading the panel
          — or a screen reader that skipped it — would see as a heading. The balance beside the name is the figure the
          Server will measure the amount against, so the ceiling is on screen before anybody types. */}
      {chosen !== null && mayRecordPayment && <>
        <p className="reports-note">
          Taking a payment from <strong>{chosen.customerName}</strong>, who owes {money(chosen.balanceMinor)}.
        </p>
        <form className="report-drawer-event-form" onSubmit={(event) => void submit(event)}>
          <label className="reports-control">
            <span>Amount ({currency.code})</span>
            <input
              inputMode="decimal"
              value={amount}
              disabled={busy}
              placeholder={money(chosen.balanceMinor)}
              onChange={(event) => setAmount(event.currentTarget.value)}
            />
          </label>
          <label className="reports-control">
            <span>Method</span>
            <select
              value={method}
              disabled={busy}
              onChange={(event) => setMethod(event.currentTarget.value as RecordDebtorPaymentInput['method'])}
            >
              {METHODS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className="reports-control">
            <span>Reference</span>
            <input
              maxLength={80}
              value={reference}
              disabled={busy}
              placeholder="Cheque or transfer number"
              onChange={(event) => setReference(event.currentTarget.value)}
            />
          </label>
          <label className="reports-control">
            <span>Note</span>
            <input
              maxLength={240}
              value={note}
              disabled={busy}
              onChange={(event) => setNote(event.currentTarget.value)}
            />
          </label>
          <button className="secondary-button" type="submit" disabled={busy || amount.trim() === ''}>
            Record the payment
          </button>
          <button className="secondary-button" type="button" disabled={busy} onClick={() => setChosen(null)}>
            Cancel
          </button>
        </form>
      </>}
    </section>
  )
}
