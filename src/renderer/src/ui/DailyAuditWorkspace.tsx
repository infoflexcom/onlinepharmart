import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { formatMoney } from '@shared/currency/money'
import type { PublicUser } from '@shared/auth/types'
import type { InfoflexBridge } from '@shared/bridge'
import type { BootstrapData } from '@shared/shop/types'
import type {
  AuditCheckCode,
  AuditDayStatus,
  AuditFlagRow,
  AuditSignOffOutcome,
  DailyAuditReport,
  UnauditedDay,
} from '@shared/audit/types'
import { AUDIT_CHECK_TITLES } from '../../../services/audit-export'
import './audit.css'

interface Props {
  bridge: InfoflexBridge
  bootstrap: BootstrapData
  user: PublicUser
}

/**
 * The daily audit — the Supervisor's screen, and the Admin's view of whether the Supervisor has looked.
 *
 * Three decisions shape it, and each one is a refusal to let the screen say something the data does not support:
 *
 * - **It offers nothing the server would refuse.** Every button is rendered from `canSignOff`, `canNote` and `canExport`
 *   on the report itself, which the service derives from the caller's capabilities. A screen that showed a Sign off
 *   button to somebody the server would reject teaches that person the wrong thing about their own role, and the error
 *   they get is a surprise instead of a fact about the screen.
 * - **A clean day says it was checked.** The findings panel lists all six checks with "nothing found" beside the ones
 *   that found nothing, rather than showing an empty box. An empty box on an audit screen is indistinguishable from a
 *   screen that did not run, and that ambiguity is the one thing this feature exists to remove.
 * - **There is no print button, and the absence is stated.** An audit is not a receipt; the one document this screen can
 *   produce is a file the Admin keeps. Saying so on the screen is what stops the omission reading as an oversight.
 */
export function DailyAuditWorkspace({ bridge, bootstrap, user }: Props) {
  const [businessDate, setBusinessDate] = useState(localDate(new Date()))
  const [accountId, setAccountId] = useState('')
  const [report, setReport] = useState<DailyAuditReport | null>(null)
  const [unaudited, setUnaudited] = useState<UnauditedDay[]>([])
  const [statuses, setStatuses] = useState<AuditDayStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [outcome, setOutcome] = useState<AuditSignOffOutcome>('AUDITED')
  const [signOffNote, setSignOffNote] = useState('')
  const [noteFor, setNoteFor] = useState<AuditCheckCode | ''>('')
  const [noteText, setNoteText] = useState('')
  const [flagText, setFlagText] = useState('')
  const [flagSeverity, setFlagSeverity] = useState<'NOTE' | 'CONCERN' | 'SERIOUS'>('CONCERN')
  const [resolutionFor, setResolutionFor] = useState('')
  const [resolutionText, setResolutionText] = useState('')
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({})

  const currency = bootstrap.settings.currency
  const display = bootstrap.settings.display
  const showShifts = bootstrap.setupContext.edition === 'SUPERMARKET' || bootstrap.setupContext.edition === 'BOTH'
  const money = useCallback((amount: bigint | null): string => (
    amount === null ? '—' : formatMoney(amount, currency, display)
  ), [currency, display])

  const load = useCallback(async (date: string, account: string): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const [day, days, list] = await Promise.all([
        bridge.getDayAudit({ businessDate: date, accountId: account === '' ? null : account }),
        bridge.listAuditDayStatuses(),
        bridge.listUnauditedDays(),
      ])
      setReport(day)
      setStatuses(days)
      setUnaudited(list)
      setMessage('')
    } catch (loadError) {
      setReport(null)
      setError(errorMessage(loadError))
    } finally {
      setLoading(false)
    }
  }, [bridge])

  useEffect(() => { void load(localDate(new Date()), '') }, [load])

  /** Re-read after anything that writes, so the screen never shows a figure it has just made stale. */
  const refresh = useCallback(async (): Promise<void> => {
    await load(businessDate, accountId)
  }, [load, businessDate, accountId])

  async function act(action: () => Promise<string | void>): Promise<void> {
    setBusy(true)
    setError('')
    try {
      const said = await action()
      setMessage(said ?? '')
      await refresh()
    } catch (actionError) {
      setError(errorMessage(actionError))
    } finally {
      setBusy(false)
    }
  }

  function onSubmitDay(event: FormEvent): void {
    event.preventDefault()
    void load(businessDate, accountId)
  }

  function toggleSection(name: string): void {
    setOpenSections((current) => ({ ...current, [name]: !current[name] }))
  }

  const accountOptions = useMemo(() => report?.accounts ?? [], [report])
  const openFlags = useMemo(() => (report?.flags ?? []).filter((flag) => flag.resolvedAt === ''), [report])
  const closedFlags = useMemo(() => (report?.flags ?? []).filter((flag) => flag.resolvedAt !== ''), [report])

  return (
    <section className="audit-workspace">
      <header className="audit-header">
        <div>
          <span className="eyebrow eyebrow--gold">{bootstrap.appInfo.productName.toUpperCase()}</span>
          <h2>Daily audit</h2>
          <p>
            Every figure on this screen is read from the ledger at the moment it is opened, and nothing about a day is
            stored except a flag or a sign-off. There is no cached copy to disagree with the shop's own records.
          </p>
        </div>
        <div className="audit-header-actions">
          {/* Stated rather than left to be inferred from a button that is not there. */}
          <p className="audit-no-print">No printing from this screen. An audit is a file, not a receipt.</p>
          {report?.canExport === true && (
            <>
              {/*
                Both formats, from one handler, because the only difference between them is the word passed to the
                service. The service decides what a format is and refuses anything else, so the screen does not carry a
                second list of formats that could drift from it - and the file it hands back carries its own name and
                mime type, which the screen does not guess at either.
              */}
              {(['CSV', 'EXCEL'] as const).map((format) => (
                <button
                  key={format}
                  type="button"
                  className="inventory-secondary"
                  disabled={busy || loading}
                  onClick={() => void act(async () => {
                    const exported = await bridge.exportAudit({
                      businessDate: report.businessDate,
                      accountId: report.account?.id ?? null,
                      format,
                    })
                    downloadAuditFile(exported.fileName, exported.contentBase64, exported.mimeType)
                    return `Audit for ${report.businessDate} exported as ${format === 'CSV' ? 'CSV' : 'Excel'}.`
                  })}
                >
                  {format === 'CSV' ? 'Export CSV' : 'Export Excel'}
                </button>
              ))}
            </>
          )}
        </div>
      </header>

      {error && <div className="form-error" role="alert"><span>!</span>{error}</div>}
      {message && <div className="audit-message" role="status">{message}</div>}

      <div className="audit-columns">
        <div className="audit-pane audit-pane--days">
          <h3>Days that need a look</h3>
          <p className="audit-muted">
            A day appears here when something happened on it and nobody has attested to it. Signing off the whole store
            covers every till in it.
          </p>
          {unaudited.length === 0
            ? <p className="audit-empty">Nothing outstanding. Every day with activity has been audited.</p>
            : (
              <ul className="audit-day-list">
                {unaudited.slice(0, 40).map((day) => (
                  <li key={`${day.businessDate}:${day.accountId ?? 'STORE'}`}>
                    <button
                      type="button"
                      className="audit-day-button"
                      onClick={() => {
                        setBusinessDate(day.businessDate)
                        setAccountId(day.accountId ?? '')
                        void load(day.businessDate, day.accountId ?? '')
                      }}
                    >
                      <strong>{day.businessDate}</strong>
                      <span>{day.accountName}</span>
                      <span className="audit-day-figures">
                        {day.transactions} sale{day.transactions === 1 ? '' : 's'} · {money(day.salesMinor)}
                        {day.dayClosed ? '' : ' · not counted yet'}
                        {day.openFlags > 0 ? ` · ${day.openFlags} open flag${day.openFlags === 1 ? '' : 's'}` : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

          <h4>Recent days</h4>
          <table className="audit-table audit-table--statuses">
            <thead>
              <tr><th>Date</th><th>Till</th><th>Status</th><th>Signed by</th></tr>
            </thead>
            <tbody>
              {statuses.slice(0, 24).map((day) => (
                <tr key={`${day.businessDate}:${day.accountId ?? 'STORE'}`}>
                  <td>{day.businessDate}</td>
                  <td>{day.accountName}</td>
                  <td>
                    {day.audited
                      ? <span className={`audit-badge audit-badge--${outcomeClass(day.outcome)}`}>
                        {day.outcome === 'AUDITED' ? 'Audited' : 'Audited with issues'}
                      </span>
                      : <span className="audit-badge audit-badge--open">Not audited</span>}
                    {day.openFlags > 0 && <span className="audit-badge audit-badge--flag">{day.openFlags} open</span>}
                  </td>
                  <td>{day.signedByName || '—'}</td>
                </tr>
              ))}
              {statuses.length === 0 && (
                <tr><td colSpan={4} className="audit-empty-cell">No activity in the last 30 days.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="audit-pane">
          <form className="audit-day-form" onSubmit={onSubmitDay}>
            <label>
              <span>Business date</span>
              <input
                type="date"
                value={businessDate}
                max={localDate(new Date())}
                onChange={(event) => setBusinessDate(event.target.value)}
              />
            </label>
            <label>
              <span>Till</span>
              <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
                <option value="">Whole store</option>
                {accountOptions.map((account) => (
                  <option key={account.id} value={account.id}>{account.name} · {account.transactions} sales</option>
                ))}
              </select>
            </label>
            <button type="submit" className="inventory-primary" disabled={loading || busy}>
              {loading ? 'Reading…' : 'Read the day'}
            </button>
          </form>

          {!report && !loading && <p className="audit-empty">Choose a business date to audit.</p>}

          {report && (
            <>
              {report.signOff && (
                <div className={`audit-verdict ${report.signOff.digestMatches ? 'audit-verdict--signed' : 'audit-verdict--moved'}`}>
                  <strong>
                    {report.signOff.outcome === 'AUDITED' ? 'Audited' : 'Audited with issues'}
                    {' · '}
                    {report.signOff.signedByName} at {report.signOff.signedAt}
                  </strong>
                  {report.signOff.note && <p className="audit-verdict-note">{report.signOff.note}</p>}
                  {/* The one warning that must never be suppressed: the verdict covers the day as it was shown then. */}
                  {!report.signOff.digestMatches && (
                    <p className="audit-verdict-warning">
                      This day has moved since it was signed off — a sale, a return or a count changed a total. The
                      sign-off cannot be edited and neither can a completed sale, so both are shown as they are.
                    </p>
                  )}
                </div>
              )}

              <section className="audit-block">
                <h3>What the checks found</h3>
                <table className="audit-table">
                  <thead>
                    <tr><th>Check</th><th>Result</th><th>Amount</th></tr>
                  </thead>
                  <tbody>
                    {report.checksRun.map((code) => {
                      const finding = report.findings.find((candidate) => candidate.code === code)
                      return (
                        <tr key={code}>
                          <td>{AUDIT_CHECK_TITLES[code]}</td>
                          <td>
                            {finding
                              ? (
                                <>
                                  <span className={`audit-badge audit-badge--${severityClass(finding.severity)}`}>
                                    {finding.severity}
                                  </span>
                                  <span className="audit-finding-headline">{finding.headline}</span>
                                  {finding.detail && <span className="audit-finding-detail">{finding.detail}</span>}
                                </>
                              )
                              : <span className="audit-clear">Nothing found</span>}
                          </td>
                          <td className="audit-money">{money(finding?.amountMinor ?? null)}</td>
                          {report.canNote && finding && (
                            <td>
                              <button
                                type="button"
                                className="audit-link"
                                disabled={busy}
                                onClick={() => { setNoteFor(code); setNoteText('') }}
                              >
                                Note this
                              </button>
                            </td>
                          )}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                {noteFor !== '' && (
                  <form
                    className="audit-note-form"
                    onSubmit={(event) => {
                      event.preventDefault()
                      const code = noteFor
                      const detail = noteText
                      setNoteFor('')
                      void act(async () => {
                        await bridge.noteAuditFinding({
                          businessDate: report.businessDate, accountId: report.account?.id ?? null, code, detail,
                        })
                        return 'Note added to the finding.'
                      })
                    }}
                  >
                    <label>
                      <span>Your note on {AUDIT_CHECK_TITLES[noteFor]}</span>
                      <textarea
                        rows={2}
                        value={noteText}
                        maxLength={1000}
                        onChange={(event) => setNoteText(event.target.value)}
                        placeholder="What you checked, and what you concluded."
                      />
                    </label>
                    <div className="audit-note-actions">
                      <button type="submit" className="inventory-primary" disabled={busy}>Save note</button>
                      <button type="button" className="audit-link" onClick={() => setNoteFor('')}>Cancel</button>
                    </div>
                  </form>
                )}
              </section>

              <section className="audit-block">
                <h3>The drawer tied to the day</h3>
                <table className="audit-table audit-table--tie">
                  <tbody>
                    <tr><th>Opening float</th><td className="audit-money">{money(report.cashTie.openingFloatMinor)}</td></tr>
                    <tr><th>Cash sales</th><td className="audit-money">{money(report.cashTie.cashSalesMinor)}</td></tr>
                    <tr><th>Cash refunds paid out</th><td className="audit-money">{money(report.cashTie.cashRefundsMinor)}</td></tr>
                    <tr><th>Drawer paid in and paid out</th><td className="audit-money">{money(report.cashTie.drawerAdjustmentsMinor)}</td></tr>
                    <tr><th>Cash taken against customer balances</th><td className="audit-money">{money(report.cashTie.debtorCashMinor)}</td></tr>
                    <tr className="audit-row--total"><th>Expected in the drawer</th><td className="audit-money">{money(report.cashTie.expectedCashMinor)}</td></tr>
                    <tr><th>Counted in the drawer</th><td className="audit-money">{money(report.cashTie.countedCashMinor)}</td></tr>
                    <tr className={report.cashTie.differs ? 'audit-row--differs' : 'audit-row--total'}>
                      <th>Difference</th>
                      <td className="audit-money">{money(report.cashTie.differenceMinor)}</td>
                    </tr>
                  </tbody>
                </table>
                <p className="audit-muted">
                  {report.cashTie.counted
                    ? `${report.cashTie.closedByName || 'Somebody'} counted this day at ${report.cashTie.closedAt || 'an unrecorded time'}.`
                    : 'This day has not been counted yet. The expectation above is what the drawer should hold; the difference appears once the Admin closes the day.'}
                </p>
              </section>

              <section className="audit-block">
                <h3>The day in figures</h3>
                <dl className="audit-totals">
                  <div><dt>Gross sales</dt><dd>{money(report.totals.grossSalesMinor)}</dd></div>
                  <div><dt>Discounts</dt><dd>{money(report.totals.discountsMinor)}</dd></div>
                  <div><dt>Sales taken</dt><dd>{money(report.totals.totalSalesMinor)}</dd></div>
                  <div><dt>Returns</dt><dd>{money(report.totals.returnsMinor)}</dd></div>
                  <div><dt>Net sales</dt><dd>{money(report.totals.netSalesMinor)}</dd></div>
                  <div><dt>Retail</dt><dd>{money(report.totals.retailMinor)} · {report.totals.retailTransactions}</dd></div>
                  <div><dt>Wholesale</dt><dd>{money(report.totals.wholesaleMinor)} · {report.totals.wholesaleTransactions}</dd></div>
                  <div><dt>Left on account</dt><dd>{money(report.totals.creditSalesMinor)} · {report.totals.creditTransactions}</dd></div>
                  <div><dt>Debtor payments</dt><dd>{money(report.totals.debtorPaymentsMinor)} · {report.totals.debtorPaymentTransactions}</dd></div>
                  <div><dt>Transactions</dt><dd>{report.totals.transactions}</dd></div>
                  <div><dt>Price overrides</dt><dd>{report.totals.overrides}</dd></div>
                  <div><dt>Duplicate prints</dt><dd>{report.totals.reprints}</dd></div>
                </dl>
                <p className={report.reconciliation.matches ? 'audit-clear-line' : 'audit-differs-line'}>
                  {report.reconciliation.matches
                    ? 'These totals agree with the sales ledger to the last unit.'
                    : `These totals do not agree with the sales ledger: ${report.reconciliation.differences.join('; ')}.`}
                </p>
              </section>

              <section className="audit-block">
                <h3>How the day was paid for</h3>
                <table className="audit-table">
                  <thead><tr><th>Method</th><th>Transactions</th><th>Sales</th><th>Refunds</th><th>Net</th></tr></thead>
                  <tbody>
                    {report.paymentMethods.map((row) => (
                      <tr key={row.method}>
                        <td>{row.method}</td>
                        <td>{row.transactions}</td>
                        <td className="audit-money">{money(row.salesMinor)}</td>
                        <td className="audit-money">{money(row.refundsMinor)}</td>
                        <td className="audit-money">{money(row.netMinor)}</td>
                      </tr>
                    ))}
                    {report.paymentMethods.length === 0 && (
                      <tr><td colSpan={5} className="audit-empty-cell">No payments on this day.</td></tr>
                    )}
                  </tbody>
                </table>
              </section>

              {showShifts && report.shifts.length > 0 && (
                <section className="audit-block">
                  <h3>Each till's own count</h3>
                  <table className="audit-table">
                    <thead>
                      <tr><th>Cashier</th><th>Opened</th><th>Status</th><th>Float</th><th>Expected</th><th>Counted</th><th>Over or short</th></tr>
                    </thead>
                    <tbody>
                      {report.shifts.map((shift) => (
                        <tr key={shift.id}>
                          <td>{shift.cashierName}</td>
                          <td>{shift.openedAt}</td>
                          <td>{shift.status === 'OPEN' ? 'Open' : 'Closed'}</td>
                          <td className="audit-money">{money(shift.openingFloatMinor)}</td>
                          <td className="audit-money">{money(shift.expectedCashMinor)}</td>
                          <td className="audit-money">{money(shift.countedCashMinor)}</td>
                          <td className="audit-money">{money(shift.varianceMinor)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              )}

              {/* The detail sections. Collapsed by default: a day with four hundred sales is audited by its totals and
                  its findings, and the rows are here for the one that needs reading. */}
              <DetailSection
                title={`Sales (${report.sales.length})`}
                name="sales"
                open={openSections}
                onToggle={toggleSection}
                empty="No sales on this day."
              >
                <table className="audit-table">
                  <thead>
                    <tr><th>Receipt</th><th>Time</th><th>Cashier</th><th>Type</th><th>Paid by</th><th>Gross</th><th>Discount</th><th>Total</th></tr>
                  </thead>
                  <tbody>
                    {report.sales.map((row) => (
                      <tr key={row.saleId}>
                        <td>{row.receiptNumber}</td>
                        <td>{row.time}</td>
                        <td>{row.cashierName}</td>
                        <td>{row.saleType === 'WHOLESALE' ? 'Wholesale' : 'Retail'}</td>
                        <td>{row.paymentMethods}</td>
                        <td className="audit-money">{money(row.grossMinor)}</td>
                        <td className="audit-money">{money(row.discountMinor)}</td>
                        <td className="audit-money">{money(row.totalMinor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DetailSection>

              <DetailSection
                title={`Lines charged off the catalogue (${report.overrides.length})`}
                name="overrides"
                open={openSections}
                onToggle={toggleSection}
                empty="Every line was charged at the catalogue price for its tier."
              >
                <table className="audit-table">
                  <thead>
                    <tr><th>Receipt</th><th>Cashier</th><th>Product</th><th>Tier</th><th>Catalogue</th><th>Charged</th><th>Difference</th><th>Catalogue changed since</th></tr>
                  </thead>
                  <tbody>
                    {report.overrides.map((row, index) => (
                      <tr key={`${row.saleId}-${row.sku}-${index}`}>
                        <td>{row.receiptNumber}</td>
                        <td>{row.cashierName}</td>
                        <td>{row.productName}</td>
                        <td>{row.priceTier === 'WHOLESALE' ? 'Wholesale' : 'Retail'}</td>
                        <td className="audit-money">{money(row.cataloguePriceMinor)}</td>
                        <td className="audit-money">{money(row.chargedPriceMinor)}</td>
                        <td className="audit-money">{money(row.differenceMinor)}</td>
                        <td>
                          {row.catalogueChangedSince
                            ? 'Yes — the price was changed after this sale'
                            : 'No'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DetailSection>

              <DetailSection
                title={`Discounts (${report.discounts.length})`}
                name="discounts"
                open={openSections}
                onToggle={toggleSection}
                empty="No discounts were given on this day."
              >
                <table className="audit-table">
                  <thead>
                    <tr><th>Receipt</th><th>Cashier</th><th>Gross</th><th>Discount</th><th>Cap</th><th>Cap set by</th><th>Position</th></tr>
                  </thead>
                  <tbody>
                    {report.discounts.map((row, index) => (
                      <tr key={`${row.saleId}-${index}`}>
                        <td>{row.receiptNumber}</td>
                        <td>{row.cashierName}</td>
                        <td className="audit-money">{money(row.grossMinor)}</td>
                        <td className="audit-money">{money(row.discountMinor)}</td>
                        <td>{percentOf(row.capBasisPoints)}</td>
                        <td>{row.capSource === 'USER_PERMISSION' ? 'Their own permission' : 'Shop settings'}</td>
                        <td>{row.aboveCap ? 'Past the cap' : row.nearCap ? 'Close to the cap' : 'Within the cap'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DetailSection>

              <DetailSection
                title={`Returns and refunds (${report.returns.length})`}
                name="returns"
                open={openSections}
                onToggle={toggleSection}
                empty="No returns on this day."
              >
                <table className="audit-table">
                  <thead>
                    <tr><th>Return</th><th>Original receipt</th><th>Taken by</th><th>Approved by</th><th>Refunded by</th><th>Amount</th><th>Outside the window</th></tr>
                  </thead>
                  <tbody>
                    {report.returns.map((row) => (
                      <tr key={row.returnId}>
                        <td>{row.returnNumber}</td>
                        <td>{row.saleReceiptNumber}</td>
                        <td>{row.cashierName}</td>
                        <td>{row.approvedByName || '—'}</td>
                        <td>{row.refundMethods || '—'}</td>
                        <td className="audit-money">{money(row.totalMinor)}</td>
                        <td>{row.outsideWindow ? 'Yes' : 'No'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DetailSection>

              <DetailSection
                title={`Left on a customer's account (${report.creditSales.length})`}
                name="credit"
                open={openSections}
                onToggle={toggleSection}
                empty="No credit sales on this day."
              >
                <table className="audit-table">
                  <thead>
                    <tr><th>Receipt</th><th>Customer</th><th>Cashier</th><th>Credit</th><th>Balance now</th><th>Credit limit</th></tr>
                  </thead>
                  <tbody>
                    {report.creditSales.map((row, index) => (
                      <tr key={`${row.saleId}-${index}`}>
                        <td>{row.receiptNumber}</td>
                        <td>{row.customerName}</td>
                        <td>{row.cashierName}</td>
                        <td className="audit-money">{money(row.creditMinor)}</td>
                        <td className="audit-money">{money(row.customerBalanceMinor)}</td>
                        <td className="audit-money">{money(row.creditLimitMinor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DetailSection>

              <DetailSection
                title={`Customers settling what they owed (${report.debtorPayments.length})`}
                name="debtors"
                open={openSections}
                onToggle={toggleSection}
                empty="No customer settled a balance on this day."
              >
                <table className="audit-table">
                  <thead>
                    <tr><th>Payment</th><th>Customer</th><th>Taken by</th><th>Method</th><th>Before</th><th>Paid</th><th>After</th></tr>
                  </thead>
                  <tbody>
                    {report.debtorPayments.map((row) => (
                      <tr key={row.paymentNumber}>
                        <td>{row.paymentNumber}</td>
                        <td>{row.customerName}</td>
                        <td>{row.receivedByName}</td>
                        <td>{row.paymentMethod}</td>
                        <td className="audit-money">{money(row.balanceBeforeMinor)}</td>
                        <td className="audit-money">{money(row.amountMinor)}</td>
                        <td className="audit-money">{money(row.balanceAfterMinor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DetailSection>

              <DetailSection
                title={`Documents printed more than once (${report.reprints.length})`}
                name="reprints"
                open={openSections}
                onToggle={toggleSection}
                empty="Nothing was printed twice on this day."
              >
                <table className="audit-table">
                  <thead>
                    <tr><th>Document</th><th>Receipt</th><th>Copy</th><th>Printed by</th><th>From</th><th>Reason given</th></tr>
                  </thead>
                  <tbody>
                    {report.reprints.map((row, index) => (
                      <tr key={`${row.documentId}-${row.copyNo}-${index}`}>
                        <td>{row.documentKind}</td>
                        <td>{row.receiptNumber}</td>
                        <td>{row.copyNo}</td>
                        <td>{row.printedByName}</td>
                        <td>{row.clientDeviceName || '—'}</td>
                        <td>{row.reason || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DetailSection>

              <DetailSection
                title={`Orders cancelled or expired (${report.orders.length})`}
                name="orders"
                open={openSections}
                onToggle={toggleSection}
                empty="Every order raised on this day was completed."
              >
                <table className="audit-table">
                  <thead><tr><th>Order</th><th>Picked by</th><th>Status</th><th>Amount</th><th>Reason</th></tr></thead>
                  <tbody>
                    {report.orders.map((row) => (
                      <tr key={row.orderId}>
                        <td>{row.orderNumber}</td>
                        <td>{row.pickedByName}</td>
                        <td>{row.status === 'EXPIRED' ? 'Expired' : 'Cancelled'}</td>
                        <td className="audit-money">{money(row.totalMinor)}</td>
                        <td>{row.reason || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DetailSection>

              <DetailSection
                title={`Sales that were not completed (${report.voids.length})`}
                name="voids"
                open={openSections}
                onToggle={toggleSection}
                empty="Nothing was left uncompleted. A finished sale in this product is reversed by a return, never by a void."
              >
                <table className="audit-table">
                  <thead><tr><th>Receipt</th><th>Cashier</th><th>Status</th><th>At</th><th>Amount</th></tr></thead>
                  <tbody>
                    {report.voids.map((row) => (
                      <tr key={row.saleId}>
                        <td>{row.receiptNumber}</td>
                        <td>{row.cashierName}</td>
                        <td>{row.status}</td>
                        <td>{row.at}</td>
                        <td className="audit-money">{money(row.totalMinor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DetailSection>

              <section className="audit-block">
                <h3>Flags on this day</h3>
                {openFlags.length === 0 && closedFlags.length === 0 && (
                  <p className="audit-empty">No flags. Raise one below if something needs following up.</p>
                )}
                {openFlags.map((flag) => (
                  <FlagCard
                    key={flag.id}
                    flag={flag}
                    canNote={report.canNote}
                    busy={busy}
                    resolutionFor={resolutionFor}
                    resolutionText={resolutionText}
                    setResolutionFor={setResolutionFor}
                    setResolutionText={setResolutionText}
                    onNote={(detail) => void act(async () => {
                      await bridge.addAuditFlagNote({ flagId: flag.id, detail })
                      return 'Note added to the flag.'
                    })}
                    onResolve={(note) => void act(async () => {
                      await bridge.resolveAuditFlag({ flagId: flag.id, resolutionNote: note })
                      setResolutionFor('')
                      return 'Flag resolved. It stays on the record.'
                    })}
                  />
                ))}
                {closedFlags.map((flag) => (
                  <FlagCard key={flag.id} flag={flag} canNote={false} busy={busy}
                    resolutionFor="" resolutionText="" setResolutionFor={setResolutionFor}
                    setResolutionText={setResolutionText} />
                ))}

                {report.canNote && (
                  <form
                    className="audit-note-form"
                    onSubmit={(event) => {
                      event.preventDefault()
                      const detail = flagText
                      const severity = flagSeverity
                      setFlagText('')
                      void act(async () => {
                        await bridge.raiseAuditFlag({
                          businessDate: report.businessDate, accountId: report.account?.id ?? null, severity, detail,
                        })
                        return 'Flag raised.'
                      })
                    }}
                  >
                    <h4>Raise a flag</h4>
                    <label>
                      <span>How serious</span>
                      <select
                        value={flagSeverity}
                        onChange={(event) => setFlagSeverity(event.target.value as 'NOTE' | 'CONCERN' | 'SERIOUS')}
                      >
                        <option value="NOTE">Note — for the record</option>
                        <option value="CONCERN">Concern — worth a look</option>
                        <option value="SERIOUS">Serious — needs an answer</option>
                      </select>
                    </label>
                    <label>
                      <span>What you found</span>
                      <textarea
                        rows={2}
                        value={flagText}
                        maxLength={1000}
                        onChange={(event) => setFlagText(event.target.value)}
                        placeholder="Say what happened, in the words you would want read back to you in a month."
                      />
                    </label>
                    <button type="submit" className="inventory-primary" disabled={busy}>Raise flag</button>
                  </form>
                )}
              </section>

              {report.canSignOff && (
                <section className="audit-block audit-block--signoff">
                  <h3>{report.signOff ? 'Already signed off' : 'Sign this day off'}</h3>
                  {report.signOff
                    ? (
                      <p className="audit-muted">
                        {report.signOff.signedByName} signed this day as
                        {' '}
                        {report.signOff.outcome === 'AUDITED' ? 'audited' : 'audited with issues'}
                        . A sign-off is history and cannot be changed; if the day has moved since, both facts are shown.
                      </p>
                    )
                    : (
                      <form
                        className="audit-note-form"
                        onSubmit={(event) => {
                          event.preventDefault()
                          const note = signOffNote
                          const verdict = outcome
                          setSignOffNote('')
                          void act(async () => {
                            await bridge.signOffAuditDay({
                              businessDate: report.businessDate,
                              accountId: report.account?.id ?? null,
                              outcome: verdict,
                              note,
                            })
                            return `${report.businessDate} signed off by ${user.fullName}.`
                          })
                        }}
                      >
                        <fieldset className="audit-outcome">
                          <legend>Verdict</legend>
                          <label>
                            <input
                              type="radio"
                              name="audit-outcome"
                              checked={outcome === 'AUDITED'}
                              onChange={() => setOutcome('AUDITED')}
                            />
                            <span>Audited — the day is as it should be</span>
                          </label>
                          <label>
                            <input
                              type="radio"
                              name="audit-outcome"
                              checked={outcome === 'AUDITED_WITH_ISSUES'}
                              onChange={() => setOutcome('AUDITED_WITH_ISSUES')}
                            />
                            <span>Audited with issues — something needs following up</span>
                          </label>
                        </fieldset>
                        <label>
                          <span>Note{report.findings.length > 0 && outcome === 'AUDITED' ? ' (required — this day has findings)' : ''}</span>
                          <textarea
                            rows={3}
                            value={signOffNote}
                            maxLength={2000}
                            onChange={(event) => setSignOffNote(event.target.value)}
                            placeholder={report.findings.length > 0
                              ? 'A clean verdict on a day with findings has to say why the findings are acceptable.'
                              : 'Optional. Anything the next reader should know.'}
                          />
                        </label>
                        <button type="submit" className="inventory-primary" disabled={busy}>Sign off {report.businessDate}</button>
                      </form>
                    )}
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  )
}

function DetailSection({ title, name, open, onToggle, empty, children }: {
  title: string
  name: string
  open: Record<string, boolean>
  onToggle: (name: string) => void
  empty: string
  children: ReactNode
}) {
  const isOpen = open[name] === true
  return (
    <section className={`audit-block audit-block--detail ${isOpen ? 'is-open' : ''}`}>
      <button type="button" className="audit-disclosure" onClick={() => onToggle(name)}>
        <span className="audit-disclosure-mark" aria-hidden="true">{isOpen ? '−' : '+'}</span>
        <h3>{title}</h3>
      </button>
      {isOpen && (
        <div className="audit-detail-body">
          {children}
          <p className="audit-muted">{empty}</p>
        </div>
      )}
    </section>
  )
}

function FlagCard({ flag, canNote, busy, resolutionFor, resolutionText, setResolutionFor, setResolutionText, onNote, onResolve }: {
  flag: AuditFlagRow
  canNote: boolean
  busy: boolean
  resolutionFor: string
  resolutionText: string
  setResolutionFor: (value: string) => void
  setResolutionText: (value: string) => void
  onNote?: (detail: string) => void
  onResolve?: (note: string) => void
}) {
  const resolved = flag.resolvedAt !== ''
  return (
    <article className={`audit-flag ${resolved ? 'audit-flag--resolved' : `audit-flag--${severityClass(flag.severity)}`}`}>
      <header>
        <span className={`audit-badge audit-badge--${flagBadgeClass(flag)}`}>
          {resolved ? 'Resolved' : flag.severity}
        </span>
        <strong>{flag.source === 'AUTOMATIC' && flag.checkCode !== '' ? AUDIT_CHECK_TITLES[flag.checkCode] : 'Raised by hand'}</strong>
        <span className="audit-flag-who">{flag.raisedByName} · {flag.raisedAt}</span>
      </header>
      {/* The whole note, stamps and all: it is an append-only conversation, and trimming it would hide who said what. */}
      <pre className="audit-flag-detail">{flag.detail}</pre>
      {resolved && (
        <p className="audit-flag-resolution">
          {flag.resolvedByName} closed it at {flag.resolvedAt}
          {flag.resolutionNote ? ` — ${flag.resolutionNote}` : '.'}
        </p>
      )}
      {!resolved && canNote && (
        <div className="audit-flag-actions">
          {resolutionFor === flag.id
            ? (
              <form
                className="audit-note-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  onResolve?.(resolutionText)
                }}
              >
                <label>
                  <span>How it was settled</span>
                  <textarea
                    rows={2}
                    value={resolutionText}
                    maxLength={1000}
                    onChange={(event) => setResolutionText(event.target.value)}
                  />
                </label>
                <div className="audit-note-actions">
                  <button type="submit" className="inventory-primary" disabled={busy}>Resolve</button>
                  <button type="button" className="audit-link" onClick={() => setResolutionFor('')}>Cancel</button>
                </div>
              </form>
            )
            : (
              <>
                <button type="button" className="audit-link" disabled={busy} onClick={() => onNote?.('')}>
                  Add a note
                </button>
                <button
                  type="button"
                  className="audit-link"
                  disabled={busy}
                  onClick={() => { setResolutionFor(flag.id); setResolutionText('') }}
                >
                  Resolve
                </button>
              </>
            )}
        </div>
      )}
    </article>
  )
}

/**
 * The modifier half of a badge's class, from a value rather than from an inline ternary.
 *
 * Not cosmetics: a bare `'clean'` inside a `className` expression is indistinguishable from a class name to anything that
 * reads this file without running it — including the stylesheet-coverage test, which reports it as a class no stylesheet
 * defines. Keeping the fragment inside a function is what makes the screen's class list checkable.
 */
function outcomeClass(outcome: AuditSignOffOutcome | null): string {
  return outcome === 'AUDITED' ? 'clean' : 'issues'
}

function flagBadgeClass(flag: AuditFlagRow): string {
  return flag.resolvedAt === '' ? severityClass(flag.severity) : 'resolved'
}

function severityClass(severity: string): string {
  if (severity === 'SERIOUS') return 'serious'
  if (severity === 'CONCERN') return 'concern'
  if (severity === 'RESOLVED') return 'resolved'
  return 'note'
}

/** Basis points as a percentage, in the same words the export uses. */
function percentOf(basisPoints: bigint): string {
  const whole = basisPoints / 100n
  const hundredths = (basisPoints % 100n).toString().padStart(2, '0')
  return hundredths === '00' ? `${whole}%` : `${whole}.${hundredths.replace(/0+$/u, '')}%`
}

function localDate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function downloadAuditFile(fileName: string, contentBase64: string, mimeType: string): void {
  const binary = atob(contentBase64)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 2_000)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'This audit action could not be completed.'
}
