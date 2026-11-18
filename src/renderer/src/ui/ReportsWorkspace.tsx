import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { formatMoney } from '@shared/currency/money'
import type { PublicUser } from '@shared/auth/types'
import type { InfoflexBridge } from '@shared/bridge'
import type { BootstrapData } from '@shared/shop/types'
import type {
  AccountingReport,
  CashierShiftReportRow,
  ReportPeriod,
  ReportSectionId,
} from '@shared/reports/types'

interface Props {
  bridge: InfoflexBridge
  bootstrap: BootstrapData
  user: PublicUser
  initialSection?: ReportSectionId
}

const REPORT_SECTIONS: Array<{ id: ReportSectionId; label: string }> = [
  { id: 'summary', label: 'Daily & monthly summary' },
  { id: 'top-sellers', label: 'Top sellers' },
  { id: 'slow-movers', label: 'Slow movers' },
  { id: 'valuation', label: 'Inventory valuation' },
  { id: 'low-stock', label: 'Low stock' },
  { id: 'debtors', label: 'Debtors / credit' },
  { id: 'purchases', label: 'Purchases' },
  { id: 'user-performance', label: 'User performance' },
  { id: 'audit-log', label: 'Audit log' },
  { id: 'stocktake', label: 'Stocktake variances' },
  { id: 'pharmacy', label: 'Pharmacy reports' },
  { id: 'supermarket', label: 'Supermarket reports' },
]

export function ReportsWorkspace({ bridge, bootstrap, user, initialSection = 'summary' }: Props) {
  const [period, setPeriod] = useState<ReportPeriod>('DAY')
  const [day, setDay] = useState(localDate(new Date()))
  const [month, setMonth] = useState(localDate(new Date()).slice(0, 7))
  const [section, setSection] = useState<ReportSectionId>(initialSection)
  const [report, setReport] = useState<AccountingReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [countedCash, setCountedCash] = useState('')
  const [closeNote, setCloseNote] = useState('')
  const [openingFloat, setOpeningFloat] = useState('0')
  const [shiftCounts, setShiftCounts] = useState<Record<string, string>>({})
  const [drawerShiftId, setDrawerShiftId] = useState('')
  const [drawerType, setDrawerType] = useState<'PAID_IN' | 'PAID_OUT' | 'FLOAT' | 'SAFE_DROP'>('PAID_IN')
  const [drawerAmount, setDrawerAmount] = useState('')
  const [drawerNote, setDrawerNote] = useState('')

  const periodInput = useMemo(() => ({ period, date: period === 'DAY' ? day : month }), [period, day, month])
  const showPharmacy = bootstrap.setupContext.edition === 'PHARMACY' || bootstrap.setupContext.edition === 'BOTH'
  const showSupermarket = bootstrap.setupContext.edition === 'SUPERMARKET' || bootstrap.setupContext.edition === 'BOTH'
  const visibleSections = useMemo(() => REPORT_SECTIONS.filter(({ id }) => {
    if (id !== 'pharmacy' || showPharmacy) return id !== 'supermarket' || showSupermarket
    return false
  }), [showPharmacy, showSupermarket])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await bridge.getAccountingReport(periodInput)
      setReport(result)
      setCountedCash(result.dayClose ? fromMinor(result.dayClose.countedCashMinor, result.header.currency.decimalPlaces) : '')
      if (result.shifts.length > 0 && !result.shifts.some((shift) => shift.id === drawerShiftId && shift.status === 'OPEN')) {
        setDrawerShiftId(result.shifts.find((shift) => shift.status === 'OPEN' && shift.cashierId === user.id)?.id
          ?? result.shifts.find((shift) => shift.status === 'OPEN')?.id ?? '')
      }
    } catch (caught) {
      setError(errorMessage(caught))
      setReport(null)
    } finally {
      setLoading(false)
    }
  }, [bridge, drawerShiftId, periodInput, user.id])

  useEffect(() => { void refresh() }, [refresh])

  const currency = report?.header.currency ?? bootstrap.settings.currency
  const display = report?.header.display ?? bootstrap.settings.display
  const admin = user.role === 'ADMIN'
  const exportSection = admin ? section : 'summary'

  async function downloadCsv(): Promise<void> {
    await exportReport('csv')
  }

  async function downloadExcel(): Promise<void> {
    await exportReport('excel')
  }

  async function downloadPdf(): Promise<void> {
    await exportReport('pdf')
  }

  async function exportReport(kind: 'csv' | 'excel' | 'pdf'): Promise<void> {
    setBusy(true)
    setMessage('')
    setError('')
    try {
      const input = { ...periodInput, section: exportSection }
      if (kind === 'csv') {
        const csv = await bridge.exportReportCsv(input)
        downloadBlob(fileName('csv'), new Blob([csv], { type: 'text/csv;charset=utf-8' }))
      } else if (kind === 'excel') {
        const encoded = await bridge.exportReportExcel(input)
        downloadBlob(fileName('xlsx'), base64Blob(encoded, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))
      } else {
        const encoded = await bridge.exportReportPdf(input)
        downloadBlob(fileName('pdf'), base64Blob(encoded, 'application/pdf'))
      }
      setMessage(`${kind.toUpperCase()} report downloaded.`)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  function fileName(extension: string): string {
    const datePart = (period === 'DAY' ? day : month).replace(/[^0-9-]/gu, '')
    const store = (report?.header.storeName || 'store').trim().toLowerCase().replace(/[^a-z0-9]+/gu, '-')
    return `infoflex-${store}-${datePart}-${section}.${extension}`
  }

  async function closeDay(): Promise<void> {
    if (!report || period !== 'DAY') return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const saved = await bridge.closeReportingDay({ businessDate: report.header.period.startDate, countedCash, note: closeNote })
      setMessage(`Cash close ${saved.closeNumber} saved · ${saved.currencyCode}.`)
      await refresh()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  async function openShift(): Promise<void> {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const shift = await bridge.openCashierShift({ openingFloat })
      setMessage(`Cashier shift opened at ${shift.openedAt}.`)
      await refresh()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  async function closeShift(shift: CashierShiftReportRow): Promise<void> {
    const counted = shiftCounts[shift.id] ?? ''
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const saved = await bridge.closeCashierShift({ shiftId: shift.id, countedCash: counted })
      setMessage(`${saved.cashierName} shift closed · difference ${formatMoney(saved.varianceMinor ?? 0n, currency, display)}.`)
      await refresh()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  async function recordDrawerEvent(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await bridge.recordCashDrawerEvent({ shiftId: drawerShiftId, type: drawerType, amount: drawerAmount, note: drawerNote })
      setMessage(`${drawerType.replace('_', ' ').toLowerCase()} recorded.`)
      setDrawerAmount('')
      setDrawerNote('')
      await refresh()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  return <section className="reports-workspace" aria-label="Accounting reports">
    <header className="reports-heading">
      <div>
        <span className="eyebrow eyebrow--gold">ACCOUNTING · {admin ? 'ADMIN' : 'PERSONAL VIEW'}</span>
        <h2>Reports & cash close</h2>
        <p>{admin
          ? 'Daily and monthly accounting, inventory performance, edition reports, and audited cash settlement.'
          : 'Your own desktop sales and transaction totals only. Store-wide reports and cost/profit figures are Admin-only.'}</p>
      </div>
      <div className="reports-heading-actions">
        <button className="secondary-button" type="button" onClick={() => void refresh()} disabled={loading || busy}>Refresh</button>
        <button className="secondary-button" type="button" onClick={() => window.print()} disabled={!report}>Print</button>
      </div>
    </header>

    <div className="reports-toolbar">
      <label className="reports-control"><span>Report period</span><select value={period} onChange={(event) => setPeriod(event.currentTarget.value as ReportPeriod)}>
        <option value="DAY">Daily</option><option value="MONTH">Monthly</option>
      </select></label>
      {period === 'DAY'
        ? <label className="reports-control"><span>Business date</span><input type="date" value={day} onChange={(event) => setDay(event.currentTarget.value)} /></label>
        : <label className="reports-control"><span>Month</span><input type="month" value={month} onChange={(event) => setMonth(event.currentTarget.value)} /></label>}
      {admin && <label className="reports-control reports-control--section"><span>Report</span><select value={section} onChange={(event) => setSection(event.currentTarget.value as ReportSectionId)}>
        {visibleSections.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}
      </select></label>}
      <div className="reports-export-actions">
        <button type="button" className="inventory-secondary" disabled={!report || busy} onClick={() => void downloadCsv()}>CSV</button>
        <button type="button" className="inventory-secondary" disabled={!report || busy} onClick={() => void downloadExcel()}>Excel</button>
        <button type="button" className="inventory-secondary" disabled={!report || busy} onClick={() => void downloadPdf()}>PDF</button>
      </div>
    </div>

    {error && <div className="form-error" role="alert"><span>!</span>{error}</div>}
    {message && <div className="reports-success" role="status">{message}</div>}
    {loading && !report && <div className="reports-loading">Loading host-verified report…</div>}
    {!loading && !report && !error && <div className="reports-empty">No report data is available for this period.</div>}
    {report && <div className="reports-print-root">
      <div className="reports-print-header">
        <div><span className="eyebrow eyebrow--gold">{report.header.currency.code} · {report.header.period.label}</span>
          <h2>{report.header.storeName || 'Store report'}</h2>
          <p>{report.header.storeAddress || 'Store address not configured'}</p></div>
        <span className="reports-scope-tag">{report.header.scope === 'STORE' ? 'STORE-WIDE' : `MY FIGURES · ${report.header.viewerName}`}</span>
      </div>
      {section === 'summary' || !admin
        ? <>
          <AccountingSummaryView report={report} />
          {showSupermarket && <SupermarketShiftPanel
            report={report} user={user} isAdmin={admin} currency={currency} display={display} busy={busy}
            openingFloat={openingFloat} setOpeningFloat={setOpeningFloat} onOpenShift={() => void openShift()}
            shiftCounts={shiftCounts} setShiftCounts={setShiftCounts} onCloseShift={(shift) => void closeShift(shift)}
            drawerShiftId={drawerShiftId} setDrawerShiftId={setDrawerShiftId} drawerType={drawerType}
            setDrawerType={setDrawerType} drawerAmount={drawerAmount} setDrawerAmount={setDrawerAmount}
            drawerNote={drawerNote} setDrawerNote={setDrawerNote} onDrawerEvent={(event) => void recordDrawerEvent(event)}
          />}
          {admin && period === 'DAY' && <DailyCashClosePanel
            report={report} countedCash={countedCash} setCountedCash={setCountedCash} closeNote={closeNote}
            setCloseNote={setCloseNote} busy={busy} onClose={() => void closeDay()}
          />}
        </>
        : <AdminReportSection report={report} section={section} currency={currency} display={display} />}
    </div>}
  </section>
}

function AccountingSummaryView({ report }: { report: AccountingReport }) {
  const { summary, header } = report
  const money = (value: bigint | null) => value === null ? null : formatMoney(value, header.currency, header.display)
  const cards = [
    ['Total sales', money(summary.totalSalesMinor), `${summary.transactions} transaction${summary.transactions === 1 ? '' : 's'}`],
    ['Gross sales', money(summary.grossSalesMinor), 'Before discounts'],
    ['Discounts', money(summary.discountsMinor), 'Manual, promotion and loyalty'],
    ['Returns', money(summary.returnsMinor), `${summary.returnTransactions} completed return${summary.returnTransactions === 1 ? '' : 's'}`],
    ['Refunds', money(summary.refundsMinor), 'Refunds only; store credit is separate'],
    ['Net sales', money(summary.netSalesMinor), 'Total sales less returns'],
    ...(report.header.scope === 'STORE'
      ? [['COGS', money(summary.cogsMinor), 'Historical stock-movement cost'], ['Gross profit', money(summary.grossProfitMinor), 'Net sales less COGS']]
      : []),
  ]
  return <>
    <div className="report-metric-grid">
      {cards.map(([label, value, note]) => value && <article className="report-metric-card" key={label}>
        <span>{label}</span><strong>{value}</strong><small>{note}</small>
      </article>)}
    </div>
    <section className="management-card report-chart-card">
      <div className="management-card__header"><div><span className="eyebrow eyebrow--gold">{header.period.type === 'MONTH' ? 'MONTHLY TREND' : 'DAILY TOTAL'}</span><h3>Net sales by day</h3>
        <p>{header.period.type === 'MONTH' ? 'Each bar is a business day; select a bar to compare its net sales.' : `Sales totals for ${header.period.label}.`}</p></div></div>
      <SalesChart report={report} />
    </section>
    {header.period.type === 'MONTH' && <section className="management-card">
      <div className="management-card__header"><div><span className="eyebrow eyebrow--gold">DAILY BREAKDOWN</span><h3>Month by day</h3></div></div>
      <DataTable headers={['Date', 'Sales', 'Tx', 'Retail', 'Wholesale', 'Discounts', 'Returns', 'Net sales', ...(header.scope === 'STORE' ? ['COGS', 'Gross profit'] : [])]} rows={report.daily.map((row) => [
        row.date, formatMoney(row.totalSalesMinor, header.currency, header.display), String(row.transactions),
        formatMoney(row.retailSalesMinor, header.currency, header.display), formatMoney(row.wholesaleSalesMinor, header.currency, header.display),
        formatMoney(row.discountsMinor, header.currency, header.display), formatMoney(row.returnsMinor, header.currency, header.display),
        formatMoney(row.netSalesMinor, header.currency, header.display),
        ...(header.scope === 'STORE' ? [formatMoney(row.cogsMinor ?? 0n, header.currency, header.display), formatMoney(row.grossProfitMinor ?? 0n, header.currency, header.display)] : []),
      ])} />
    </section>}
    <div className="report-two-column">
      <section className="management-card">
        <div className="management-card__header"><div><span className="eyebrow eyebrow--gold">SALES MIX</span><h3>Retail and wholesale</h3></div></div>
        <div className="report-breakdown-list">
          <div><span>Retail · {summary.retail.transactions} transactions</span><strong>{formatMoney(summary.retail.totalMinor, header.currency, header.display)}</strong></div>
          <div><span>Wholesale · {summary.wholesale.transactions} transactions</span><strong>{formatMoney(summary.wholesale.totalMinor, header.currency, header.display)}</strong></div>
        </div>
      </section>
      <section className="management-card">
        <div className="management-card__header"><div><span className="eyebrow eyebrow--gold">TENDER</span><h3>Sales payment methods</h3></div></div>
        <div className="report-breakdown-list">{report.paymentMethods.map((method) => <div key={method.method}>
          <span>{method.method} · {method.transactions} transaction{method.transactions === 1 ? '' : 's'}</span>
          <strong>{formatMoney(method.totalMinor, header.currency, header.display)}</strong>
        </div>)}</div>
      </section>
    </div>
    {report.header.scope === 'STORE' && <section className="management-card">
      <div className="management-card__header"><div><span className="eyebrow eyebrow--gold">RETURNS</span><h3>Return payment methods</h3><p>Refund totals are separated from store-credit and exchange notes.</p></div></div>
      <div className="report-breakdown-list">{report.refundMethods.map((method) => <div key={method.method}>
        <span>{method.method} · {method.transactions} return{method.transactions === 1 ? '' : 's'}</span>
        <strong>{formatMoney(method.totalMinor, header.currency, header.display)}</strong>
      </div>)}</div>
    </section>}
    <section className="management-card">
      <div className="management-card__header"><div><span className="eyebrow eyebrow--gold">{header.scope === 'STORE' ? 'CASHIER PERFORMANCE' : 'PERSONAL ACTIVITY'}</span><h3>{header.scope === 'STORE' ? 'Sales per user' : 'My sales'}</h3>
        {header.scope === 'PERSONAL' && <p>Only transactions attributed to this signed-in user are included.</p>}</div></div>
      <DataTable headers={['User', 'Retail', 'Wholesale', 'Tx', 'Discounts', 'Returns', 'Net sales', ...(header.scope === 'STORE' ? ['Gross profit'] : [])]} rows={report.salesByUser.map((row) => [
        row.userName, formatMoney(row.retailSalesMinor, header.currency, header.display), formatMoney(row.wholesaleSalesMinor, header.currency, header.display),
        String(row.transactions), formatMoney(row.discountsMinor, header.currency, header.display), formatMoney(row.returnsMinor, header.currency, header.display),
        formatMoney(row.netSalesMinor, header.currency, header.display), ...(header.scope === 'STORE' ? [formatMoney(row.grossProfitMinor ?? 0n, header.currency, header.display)] : []),
      ])} />
    </section>
  </>
}

function SalesChart({ report }: { report: AccountingReport }) {
  const values = report.daily.map((row) => row.netSalesMinor)
  const maximum = values.reduce((largest, value) => {
    const magnitude = value < 0n ? -value : value
    return magnitude > largest ? magnitude : largest
  }, 0n)
  const width = 980
  const height = 270
  const left = 38
  const right = 10
  const baseline = 135
  const slot = (width - left - right) / Math.max(report.daily.length, 1)
  const labelStride = Math.max(1, Math.ceil(report.daily.length / 18))
  return <div className="report-chart-scroll"><svg className="report-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Net sales by day bar chart">
    <line x1={left} y1={baseline} x2={width - right} y2={baseline} stroke="#d9e1ec" />
    {report.daily.map((row, index) => {
      const negative = row.netSalesMinor < 0n
      const magnitude = negative ? -row.netSalesMinor : row.netSalesMinor
      const ratio = maximum === 0n ? 0 : Number((magnitude * 1000n) / maximum) / 1000
      const barHeight = Math.max(row.netSalesMinor === 0n ? 0 : 2, ratio * 100)
      const barWidth = Math.max(2, Math.min(15, slot * 0.64))
      const x = left + index * slot + (slot - barWidth) / 2
      const y = negative ? baseline : baseline - barHeight
      return <g key={row.date}>
        <rect x={x} y={y} width={barWidth} height={barHeight} rx="2" fill={negative ? '#bd645c' : '#c9a24b'}>
          <title>{`${row.date} · ${formatMoney(row.netSalesMinor, report.header.currency, report.header.display)}`}</title>
        </rect>
        {index % labelStride === 0 && <text className="report-chart-label" x={x + barWidth / 2} y={height - 20} textAnchor="middle">{row.date.slice(8)}</text>}
      </g>
    })}
  </svg></div>
}

function DailyCashClosePanel({
  report, countedCash, setCountedCash, closeNote, setCloseNote, busy, onClose,
}: {
  report: AccountingReport
  countedCash: string
  setCountedCash: (value: string) => void
  closeNote: string
  setCloseNote: (value: string) => void
  busy: boolean
  onClose: () => void
}) {
  const position = report.cashPosition
  if (!position) return null
  return <section className="management-card report-cash-close">
    <div className="management-card__header"><div><span className="eyebrow eyebrow--gold">END OF DAY · ADMIN</span><h3>Cash close · {position.businessDate}</h3>
      <p>Expected cash uses opening floats, cash tenders net of change, cash refunds, and drawer paid-in/out and safe-drop events.</p></div></div>
    <div className="report-cash-grid">
      <div><span>Opening float</span><strong>{formatMoney(position.openingFloatMinor, report.header.currency, report.header.display)}</strong></div>
      <div><span>Cash sales</span><strong>{formatMoney(position.cashSalesMinor, report.header.currency, report.header.display)}</strong></div>
      <div><span>Cash refunds</span><strong>{formatMoney(position.cashRefundsMinor, report.header.currency, report.header.display)}</strong></div>
      <div><span>Drawer adjustments</span><strong>{formatMoney(position.drawerAdjustmentsMinor, report.header.currency, report.header.display)}</strong></div>
      <div className="report-cash-grid__expected"><span>Expected cash · {position.currencyCode}</span><strong>{formatMoney(position.expectedCashMinor, report.header.currency, report.header.display)}</strong></div>
    </div>
    {report.dayClose
      ? <div className="report-close-saved">
        <div><span>Counted cash</span><strong>{formatMoney(report.dayClose.countedCashMinor, report.header.currency, report.header.display)}</strong></div>
        <div><span>Difference · {report.dayClose.varianceMinor > 0n ? 'over' : report.dayClose.varianceMinor < 0n ? 'short' : 'balanced'}</span>
          <strong>{formatMoney(report.dayClose.varianceMinor, report.header.currency, report.header.display)}</strong></div>
        <small>{report.dayClose.closeNumber} · Closed by {report.dayClose.closedBy} · Saved in {report.dayClose.currencyCode}{report.dayClose.note ? ` · ${report.dayClose.note}` : ''}</small>
      </div>
      : <div className="report-close-form">
        <label className="reports-control"><span>Counted cash ({position.currencyCode})</span><input inputMode="decimal" value={countedCash} onChange={(event) => setCountedCash(event.currentTarget.value)} placeholder="0.00" /></label>
        <label className="reports-control"><span>Close note</span><input maxLength={500} value={closeNote} onChange={(event) => setCloseNote(event.currentTarget.value)} placeholder="Optional explanation" /></label>
        <button className="primary-button" type="button" disabled={busy || !countedCash.trim()} onClick={onClose}>Save end-of-day close</button>
      </div>}
  </section>
}

function SupermarketShiftPanel({
  report, user, isAdmin, currency, display, busy, openingFloat, setOpeningFloat, onOpenShift,
  shiftCounts, setShiftCounts, onCloseShift, drawerShiftId, setDrawerShiftId, drawerType, setDrawerType,
  drawerAmount, setDrawerAmount, drawerNote, setDrawerNote, onDrawerEvent,
}: {
  report: AccountingReport
  user: PublicUser
  isAdmin: boolean
  currency: BootstrapData['settings']['currency']
  display: BootstrapData['settings']['display']
  busy: boolean
  openingFloat: string
  setOpeningFloat: (value: string) => void
  onOpenShift: () => void
  shiftCounts: Record<string, string>
  setShiftCounts: (value: Record<string, string>) => void
  onCloseShift: (shift: CashierShiftReportRow) => void
  drawerShiftId: string
  setDrawerShiftId: (value: string) => void
  drawerType: 'PAID_IN' | 'PAID_OUT' | 'FLOAT' | 'SAFE_DROP'
  setDrawerType: (value: 'PAID_IN' | 'PAID_OUT' | 'FLOAT' | 'SAFE_DROP') => void
  drawerAmount: string
  setDrawerAmount: (value: string) => void
  drawerNote: string
  setDrawerNote: (value: string) => void
  onDrawerEvent: (event: FormEvent<HTMLFormElement>) => void
}) {
  const openShifts = report.shifts.filter((shift) => shift.status === 'OPEN')
  const canOpen = !openShifts.some((shift) => shift.cashierId === user.id)
  return <section className="management-card report-shifts-card">
    <div className="management-card__header"><div><span className="eyebrow eyebrow--gold">SUPERMARKET · CASHIER CONTROL</span><h3>Cashier shifts · over / short</h3>
      <p>Sales attach to the cashier’s open shift. Counted cash minus expected cash is saved as the signed over/short difference.</p></div></div>
    {canOpen && <div className="report-open-shift-form">
      <label className="reports-control"><span>Opening float ({currency.code})</span><input inputMode="decimal" value={openingFloat} onChange={(event) => setOpeningFloat(event.currentTarget.value)} /></label>
      <button className="secondary-button" type="button" disabled={busy} onClick={onOpenShift}>Open my cashier shift</button>
    </div>}
    {openShifts.length > 0 && <form className="report-drawer-event-form" onSubmit={onDrawerEvent}>
      <label className="reports-control"><span>Open shift</span><select value={drawerShiftId} onChange={(event) => setDrawerShiftId(event.currentTarget.value)}>
        {openShifts.map((shift) => <option key={shift.id} value={shift.id}>{shift.cashierName} · {shift.id.slice(0, 8)}</option>)}
      </select></label>
      <label className="reports-control"><span>Drawer event</span><select value={drawerType} onChange={(event) => setDrawerType(event.currentTarget.value as typeof drawerType)}>
        <option value="PAID_IN">Paid in</option><option value="PAID_OUT">Paid out</option><option value="FLOAT">Add float</option><option value="SAFE_DROP">Safe drop</option>
      </select></label>
      <label className="reports-control"><span>Amount ({currency.code})</span><input inputMode="decimal" value={drawerAmount} onChange={(event) => setDrawerAmount(event.currentTarget.value)} /></label>
      <label className="reports-control"><span>Reason / note</span><input required maxLength={240} value={drawerNote} onChange={(event) => setDrawerNote(event.currentTarget.value)} /></label>
      <button className="secondary-button" type="submit" disabled={busy || !drawerShiftId || !drawerAmount.trim() || !drawerNote.trim()}>Record drawer event</button>
    </form>}
    <DataTable headers={['Cashier', 'Status', 'Opened', 'Opening float', 'Cash sales', 'Refunds', 'Drawer events', 'Expected', 'Counted', 'Over / short', 'Close / status']} rows={report.shifts.map((shift) => [
      shift.cashierName, shift.status, new Date(shift.openedAt).toLocaleString(), formatMoney(shift.openingFloatMinor, currency, display),
      formatMoney(shift.cashSalesMinor, currency, display), formatMoney(shift.cashRefundsMinor, currency, display),
      formatMoney(shift.drawerAdjustmentsMinor, currency, display), formatMoney(shift.expectedCashMinor, currency, display),
      shift.countedCashMinor === null ? '—' : formatMoney(shift.countedCashMinor, currency, display),
      shift.varianceMinor === null ? 'Open' : formatMoney(shift.varianceMinor, currency, display),
      ...(isAdmin || shift.cashierId === user.id ? [shift.status === 'OPEN'
        ? <div className="shift-count-controls" key={`close-${shift.id}`}><input aria-label={`Counted cash for ${shift.cashierName}`} inputMode="decimal" value={shiftCounts[shift.id] ?? ''} onChange={(event) => setShiftCounts({ ...shiftCounts, [shift.id]: event.currentTarget.value })} placeholder="Counted" /><button type="button" disabled={busy || !(shiftCounts[shift.id] ?? '').trim()} onClick={() => onCloseShift(shift)}>Close</button></div>
        : `${shift.closedBy || 'Closed'}${shift.closeNote ? ` · ${shift.closeNote}` : ''}`] : []),
    ])} empty="No cashier shifts are recorded in this period." />
  </section>
}

function AdminReportSection({ report, section, currency, display }: {
  report: AccountingReport
  section: ReportSectionId
  currency: BootstrapData['settings']['currency']
  display: BootstrapData['settings']['display']
}) {
  const data = report.adminReports
  if (!data) return <div className="reports-empty">Admin report data is unavailable.</div>
  const money = (value: bigint | null) => value === null ? '—' : formatMoney(value, currency, display)
  switch (section) {
    case 'top-sellers': return <ReportPanel title="Top sellers" description="Ranked by units sold in the selected period.">
      <DataTable headers={['SKU', 'Product', 'Quantity', 'Sales', 'Transactions']} rows={data.topSellers.map((row) => [row.sku, row.productName, formatQuantity(row.quantitySoldMilli), money(row.salesMinor), String(row.transactions)])} empty="No completed sales in this period." />
    </ReportPanel>
    case 'slow-movers': return <ReportPanel title="Slow movers" description="Active products with stock, ranked by lowest units sold in this period.">
      <DataTable headers={['SKU', 'Product', 'On hand', 'Sold', 'Sales']} rows={data.slowMovers.map((row) => [row.sku, row.productName, formatQuantity(row.onHandQuantityMilli ?? 0n), formatQuantity(row.quantitySoldMilli), money(row.salesMinor)])} empty="No products with on-hand stock." />
    </ReportPanel>
    case 'valuation': return <ReportPanel title="Inventory valuation" description="Current on-hand stock at saved product cost; tracked lots use their saved batch cost.">
      <div className="report-total-banner"><span>Total stock value</span><strong>{money(data.valuation.totalValueMinor)}</strong><small>{formatQuantity(data.valuation.totalQuantityMilli)} units on hand</small></div>
      <DataTable headers={['SKU', 'Product', 'On hand', 'Reserved', 'Unit cost', 'Stock value']} rows={data.valuation.items.map((row) => [row.sku, row.productName, formatQuantity(row.quantityMilli), formatQuantity(row.reservedMilli), money(row.costPerUnitMinor), money(row.valueMinor)])} />
    </ReportPanel>
    case 'low-stock': return <ReportPanel title="Low stock" description="Active products at or below their configured reorder level.">
      <DataTable headers={['SKU', 'Product', 'On hand', 'Reserved', 'Reorder level']} rows={data.lowStock.map((row) => [row.sku, row.productName, formatQuantity(row.quantityMilli), formatQuantity(row.reservedMilli), formatQuantity(row.reorderLevelMilli)])} empty="No products are at or below the reorder level." />
    </ReportPanel>
    case 'debtors': return <ReportPanel title="Debtors / customer credit" description="Outstanding positive balances; balances are in the current saved shop currency.">
      <div className="report-total-banner"><span>Total outstanding</span><strong>{money(data.debtors.totalBalanceMinor)}</strong><small>{data.debtors.items.length} customer account(s)</small></div>
      <DataTable headers={['Customer', 'Phone', 'Balance', 'Credit limit']} rows={data.debtors.items.map((row) => [row.customerName, row.phone, money(row.balanceMinor), money(row.creditLimitMinor)])} empty="No customer credit balances are outstanding." />
    </ReportPanel>
    case 'purchases': return <>
      <ReportPanel title="Completed purchases" description="Supplier receipts posted in the selected period.">
        <div className="report-total-banner"><span>Purchase total</span><strong>{money(data.purchases.totalMinor)}</strong><small>{data.purchases.transactions} completed purchase(s)</small></div>
        <DataTable headers={['Reference', 'Supplier', 'Received by', 'Date', 'Total']} rows={data.purchases.items.map((row) => [row.purchaseNumber, row.supplierName, row.receivedBy, new Date(row.createdAt).toLocaleString(), money(row.totalMinor)])} empty="No completed purchases in this period." />
      </ReportPanel>
      <ReportPanel title="Purchases by supplier"><DataTable headers={['Supplier', 'Transactions', 'Total']} rows={data.purchases.bySupplier.map((row) => [row.supplierName, String(row.transactions), money(row.totalMinor)])} empty="No supplier totals to show." /></ReportPanel>
    </>
    case 'user-performance': return <ReportPanel title="User performance" description="Sales, discounts, returns processed, and Admin-only gross profit by account.">
      <DataTable headers={['User', 'Username', 'Tx', 'Retail', 'Wholesale', 'Discounts', 'Returns', 'Net sales', 'COGS', 'Gross profit']} rows={data.userPerformance.map((row) => [
        row.userName, row.username, String(row.transactions), money(row.retailSalesMinor), money(row.wholesaleSalesMinor), money(row.discountsMinor),
        `${row.returnsProcessed} · ${money(row.returnsMinor)}`, money(row.netSalesMinor), money(row.cogsMinor), money(row.grossProfitMinor),
      ])} empty="No user transactions in this period." />
    </ReportPanel>
    case 'audit-log': return <ReportPanel title="Audit log" description={`${data.auditLog.length} newest audit record(s) for this period; capped at 500.`}>
      <DataTable headers={['Date', 'Actor', 'Action', 'Device', 'IP', 'Metadata']} rows={data.auditLog.map((row) => [new Date(row.createdAt).toLocaleString(), row.actor, row.action, row.deviceName, row.ipAddress ?? '—', JSON.stringify(row.metadata)])} empty="No audit events in this period." />
    </ReportPanel>
    case 'stocktake': return <ReportPanel title="Stocktake variances" description="Counted-versus-expected quantity changes from immutable audit events.">
      <DataTable headers={['Date', 'SKU', 'Product', 'Expected', 'Counted', 'Variance', 'Reason', 'Actor', 'Device']} rows={data.stocktakes.map((row) => [
        new Date(row.createdAt).toLocaleString(), row.sku, row.productName, formatQuantity(row.expectedQuantityMilli), formatQuantity(row.countedQuantityMilli),
        formatQuantity(row.varianceMilli), row.reason, row.actor, row.deviceName,
      ])} empty="No stocktakes in this period." />
    </ReportPanel>
    case 'pharmacy': return data.pharmacy ? <>
      <ReportPanel title="Expired and near-expiry batches" description="Positive on-hand batch quantities expired or expiring within the next 90 days.">
        <DataTable headers={['State', 'SKU', 'Product', 'Batch', 'Expiry', 'Qty', 'Stock value']} rows={data.pharmacy.expiryLots.map((row) => [row.state, row.sku, row.productName, row.batchNumber, row.expiryDate, formatQuantity(row.quantityMilli), money(row.valueMinor)])} empty="No expired or near-expiry stock." />
      </ReportPanel>
      <ReportPanel title="Prescription-required sales"><DataTable headers={['SKU', 'Product', 'Generic name', 'Quantity', 'Sales', 'Transactions']} rows={data.pharmacy.prescriptionSales.map((row) => [row.sku, row.productName, row.genericName || '—', formatQuantity(row.quantitySoldMilli), money(row.salesMinor), String(row.transactions)])} empty="No prescription-required sales in this period." /></ReportPanel>
      <ReportPanel title="Return write-offs"><DataTable headers={['Reason', 'Items', 'Quantity', 'Returned value']} rows={data.pharmacy.writeOffs.map((row) => [row.reason, String(row.items), formatQuantity(row.quantityMilli), money(row.returnedValueMinor)])} empty="No Pharmacy return write-offs in this period." /></ReportPanel>
    </> : <div className="reports-empty">Pharmacy reports are not enabled for this license.</div>
    case 'supermarket': return data.supermarket ? <>
      <ReportPanel title="Cashier shifts and over / short" description="Shift-level expected cash, counted amount, and saved difference.">
        <DataTable headers={['Cashier', 'Status', 'Opened', 'Sales', 'Refunds', 'Drawer events', 'Expected', 'Counted', 'Over / short']} rows={report.shifts.map((shift) => [
          shift.cashierName, shift.status, new Date(shift.openedAt).toLocaleString(), money(shift.cashSalesMinor), money(shift.cashRefundsMinor),
          money(shift.drawerAdjustmentsMinor), money(shift.expectedCashMinor), shift.countedCashMinor === null ? '—' : money(shift.countedCashMinor),
          shift.varianceMinor === null ? 'Open' : money(shift.varianceMinor),
        ])} empty="No cashier shifts are recorded in this period." />
      </ReportPanel>
      <ReportPanel title="Department sales"><DataTable headers={['Department', 'Transactions', 'Quantity', 'Sales', 'Discounts']} rows={data.supermarket.departments.map((row) => [row.department, String(row.transactions), formatQuantity(row.quantitySoldMilli), money(row.salesMinor), money(row.discountsMinor)])} empty="No department sales in this period." /></ReportPanel>
      <ReportPanel title="Promotion performance"><DataTable headers={['Promotion', 'Transactions', 'Discounts', 'Sales']} rows={data.supermarket.promotions.map((row) => [row.promotion, String(row.transactions), money(row.discountsMinor), money(row.salesMinor)])} empty="No promotion discounts in this period." /></ReportPanel>
      <ReportPanel title="Loyalty redemptions"><div className="report-breakdown-list"><div><span>Transactions using points</span><strong>{data.supermarket.loyalty.transactions}</strong></div><div><span>Points redeemed</span><strong>{data.supermarket.loyalty.pointsRedeemed.toString()}</strong></div><div><span>Loyalty discounts</span><strong>{money(data.supermarket.loyalty.discountsMinor)}</strong></div></div></ReportPanel>
    </> : <div className="reports-empty">Supermarket reports are not enabled for this license.</div>
    default: return <AccountingSummaryView report={report} />
  }
}

function ReportPanel({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <section className="management-card report-detail-panel"><div className="management-card__header"><div>
    <span className="eyebrow eyebrow--gold">ADMIN REPORT</span><h3>{title}</h3>{description && <p>{description}</p>}
  </div></div>{children}</section>
}

function DataTable({ headers, rows, empty }: { headers: string[]; rows: Array<ReactNode[]>; empty?: string }) {
  if (rows.length === 0) return <p className="reports-empty reports-empty--table">{empty ?? 'No records to display.'}</p>
  return <div className="report-table-scroll"><table className="report-table"><thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead>
    <tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody>
  </table></div>
}

function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function formatQuantity(value: bigint): string {
  const negative = value < 0n
  const magnitude = negative ? -value : value
  const whole = magnitude / 1_000n
  const fraction = (magnitude % 1_000n).toString().padStart(3, '0').replace(/0+$/u, '')
  return `${negative ? '−' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

function fromMinor(value: bigint, decimalPlaces: number): string {
  const negative = value < 0n
  const magnitude = negative ? -value : value
  const scale = 10n ** BigInt(decimalPlaces)
  const whole = magnitude / scale
  const fraction = decimalPlaces > 0 ? `.${(magnitude % scale).toString().padStart(decimalPlaces, '0')}` : ''
  return `${negative ? '-' : ''}${whole}${fraction}`
}

function base64Blob(value: string, type: string): Blob {
  const binary = atob(value)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return new Blob([bytes], { type })
}

function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 2_000)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'This report action could not be completed.'
}
