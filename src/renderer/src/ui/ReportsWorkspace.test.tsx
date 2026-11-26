// @vitest-environment jsdom
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getCurrency } from '@shared/currency/catalog'
import { defaultDisplayOptions, formatMoney } from '@shared/currency/money'
import type { InfoflexBridge } from '@shared/bridge'
import type { PublicUser } from '@shared/auth/types'
import type { BootstrapData } from '@shared/shop/types'
import type {
  AccountingReport,
  CashierShiftReportRow,
  CashPositionSummary,
  DayCloseRecord,
  DebtorReportRow,
  RecordDebtorPaymentInput,
} from '@shared/reports/types'
import { can } from '../../../../packages/core/src/capabilities'
import { ReportsWorkspace } from './ReportsWorkspace'

/**
 * The Reports screen, mounted into a real DOM — and specifically the wiring that makes a capability reachable.
 *
 * `DebtorPaymentPanel.test.tsx` tests the panel: what it offers, what it sends, what it does on a refusal. This file
 * tests the thing that decides whether anybody ever sees it. That is not a smaller claim. `record_debtor_payment` had
 * been an ACCOUNT capability since the capability table was written with a service, a channel and a policy row behind it,
 * and no control in the product called it — and the reason was wiring, not the panel: the balances lived inside
 * `adminReports`, the service built that block only for an Admin, and this screen renders its section selector only for
 * an Admin, so the role that held the capability could not reach a balance even in principle.
 *
 * So the assertions here are about *who can get to it*:
 *
 * - an ACCOUNT, whose only view of this screen is the day summary, sees the balances and the control in it;
 * - an Admin sees the same panel under Debtors, and it no longer depends on the Admin block being present;
 * - taking a payment reaches the bridge and re-reads the report, so the balance on screen is the one the Server now has.
 *
 * A screen that crashed on mount, or that rendered the panel only where the capability could not reach it, would fail
 * every one of those and none of the service tests.
 *
 * One honest note about coverage: `view_reports` is held only by ADMIN and ACCOUNT, and both also hold
 * `record_debtor_payment`, so the panel's read-only branch is not reachable through this screen today. That branch is
 * defensive — the offer is derived from the capability table rather than from the two roles that happen to reach the
 * page — and it is tested where it lives, in the panel's own file.
 */

const PERMISSIONS = { allowWholesale: false, maxDiscountBasisPoints: 0, allowCreditSales: false, returnLimitMinor: 0n }
const CURRENCY = getCurrency('NGN')!
const DISPLAY = defaultDisplayOptions(CURRENCY)
const BOOTSTRAP = {
  settings: { currency: CURRENCY, display: DISPLAY, profile: { name: 'Harbor Health' } },
  appInfo: { productName: 'Infoflex', appVersion: '0.1.0' },
  setupContext: { edition: 'BOTH' },
} as unknown as BootstrapData

const DAY = '2026-11-17'

function user(role: PublicUser['role']): PublicUser {
  return {
    id: `${role}-1`, fullName: `${role} Person`, username: role.toLowerCase(), role,
    isActive: true, isLocked: false, permissions: PERMISSIONS,
  }
}

function debtor(overrides: Partial<DebtorReportRow> = {}): DebtorReportRow {
  return {
    customerId: 'c-1', customerName: 'Bode Stores', phone: '+234 800 222 3333',
    balanceMinor: 150_000n, creditLimitMinor: 500_000n,
    ...overrides,
  }
}

const DEBTORS = { totalBalanceMinor: 150_000n, items: [debtor()] }

/**
 * A report, with the fields the screen actually reads filled in.
 *
 * `adminReports` defaults to null on purpose: an Admin's real report always has it, and asserting the Debtors section
 * renders without it is what proves the section stopped depending on the Admin block. Costs stay withheld for a
 * non-Admin, which is the other half of the same rule.
 */
function report(overrides: Partial<AccountingReport> = {}, as: PublicUser): AccountingReport {
  const admin = as.role === 'ADMIN'
  return {
    header: {
      storeName: 'Harbor Health', storeAddress: '12 Dock Road, Lagos', currency: CURRENCY, display: DISPLAY,
      period: { type: 'DAY', startDate: DAY, endDate: DAY, label: DAY },
      generatedAt: '2026-11-17T09:00:00.000Z', scope: admin ? 'STORE' : 'PERSONAL',
      viewerName: as.fullName, edition: 'BOTH',
    },
    summary: {
      grossSalesMinor: 130_000n, totalSalesMinor: 123_000n, transactions: 2,
      retail: { totalMinor: 38_000n, transactions: 1 }, wholesale: { totalMinor: 85_000n, transactions: 1 },
      discountsMinor: 7_000n, returnsMinor: 19_000n, refundsMinor: 19_000n, netSalesMinor: 104_000n,
      cogsMinor: admin ? 60_000n : null, grossProfitMinor: admin ? 44_000n : null, returnTransactions: 1,
    },
    daily: [], paymentMethods: [], refundMethods: [], salesByUser: [],
    cashPosition: null, dayClose: null, shifts: [],
    debtors: DEBTORS,
    adminReports: null,
    ...overrides,
  }
}

/** An OPEN shift. `cashierId` decides two things the screen guards on, so tests set it deliberately. */
function shift(overrides: Partial<CashierShiftReportRow> = {}): CashierShiftReportRow {
  return {
    id: 'shift-1', cashierId: 'ACCOUNT-1', cashierName: 'ACCOUNT Person',
    openedAt: '2026-11-17T08:00:00.000Z', closedAt: null, status: 'OPEN', currencyCode: 'NGN',
    openingFloatMinor: 10_000n, cashSalesMinor: 20_000n, cashRefundsMinor: 0n,
    drawerAdjustmentsMinor: 0n, debtorCashMinor: 0n, expectedCashMinor: 30_000n,
    countedCashMinor: null, varianceMinor: null, closedBy: '', closeNote: '',
    ...overrides,
  }
}

function cashPosition(overrides: Partial<CashPositionSummary> = {}): CashPositionSummary {
  return {
    businessDate: DAY, currencyCode: 'NGN', openingFloatMinor: 10_000n, cashSalesMinor: 20_000n,
    cashRefundsMinor: 0n, drawerAdjustmentsMinor: 0n, debtorCashMinor: 0n, expectedCashMinor: 30_000n,
    ...overrides,
  }
}

function dayClose(overrides: Partial<DayCloseRecord> = {}): DayCloseRecord {
  return {
    id: 1, closeNumber: 'DC-00000001', businessDate: DAY, openedAt: '2026-11-17T00:00:00.000Z',
    closedAt: '2026-11-17T19:00:00.000Z', closedBy: 'ADMIN Person', currencyCode: 'NGN',
    salesTotalMinor: 123_000n, returnsTotalMinor: 19_000n, expectedCashMinor: 30_000n,
    countedCashMinor: 29_500n, varianceMinor: -500n, note: 'Short by five hundred',
    storeName: 'Harbor Health', storeAddress: '12 Dock Road, Lagos',
    ...overrides,
  }
}

const mounted: Array<{ root: { unmount(): void }; container: HTMLElement }> = []

/** Each mount gets a container of its own: two React roots over one node is not two screens. */
async function mount(element: ReactElement): Promise<HTMLElement> {
  const holder = document.createElement('div')
  document.body.append(holder)
  const root = createRoot(holder)
  mounted.push({ root, container: holder })
  await act(async () => { root.render(element) })
  return holder
}

/**
 * Every method this screen can call, named.
 *
 * A test double whose catch-all answers any unknown method with a plausible empty value is a lie about every method it
 * has not been told about, so these are spelled out and a new call the screen grows has to be added here on purpose.
 */
interface Bridge {
  getAccountingReport: ReturnType<typeof vi.fn>
  recordDebtorPayment: ReturnType<typeof vi.fn>
  exportReportCsv: ReturnType<typeof vi.fn>
  exportReportExcel: ReturnType<typeof vi.fn>
  exportReportPdf: ReturnType<typeof vi.fn>
  closeReportingDay: ReturnType<typeof vi.fn>
  openCashierShift: ReturnType<typeof vi.fn>
  closeCashierShift: ReturnType<typeof vi.fn>
  recordCashDrawerEvent: ReturnType<typeof vi.fn>
}

interface Harness {
  bridge: Bridge
  container: HTMLElement
  text(): string
}

async function mountScreen(
  as: PublicUser,
  overrides: Partial<InfoflexBridge> = {},
  initialSection?: 'summary' | 'debtors' | 'valuation',
  reportOverrides: Partial<AccountingReport> = {},
): Promise<Harness> {
  const bridge = {
    getAccountingReport: vi.fn(async () => report(reportOverrides, as)),
    recordDebtorPayment: vi.fn(async (_input: RecordDebtorPaymentInput) => ({
      paymentNumber: 'DP-00000001', customerName: 'Bode Stores', receivedByName: as.fullName,
      paymentMethod: 'CASH', amountMinor: 25_000n, balanceBeforeMinor: 150_000n, balanceAfterMinor: 125_000n,
      reference: '', at: '2026-11-17T09:05:00.000Z',
    })),
    exportReportCsv: vi.fn(async () => 'Metric,Amount\nNet sales,1040.00'),
    exportReportExcel: vi.fn(async () => 'U3RvcmU='),
    exportReportPdf: vi.fn(async () => 'U3RvcmU='),
    closeReportingDay: vi.fn(async () => dayClose()),
    openCashierShift: vi.fn(async () => shift()),
    closeCashierShift: vi.fn(async () => shift({
      status: 'CLOSED', closedAt: '2026-11-17T19:00:00.000Z', countedCashMinor: 29_500n,
      varianceMinor: -500n, closedBy: 'ADMIN Person',
    })),
    recordCashDrawerEvent: vi.fn(async () => shift({ drawerAdjustmentsMinor: -2_000n })),
    ...overrides,
  } as unknown as InfoflexBridge & Bridge

  const holder = await mount(
    <ReportsWorkspace bridge={bridge} bootstrap={BOOTSTRAP} user={as} initialSection={initialSection} />,
  )
  return { bridge, container: holder, text: () => holder.textContent ?? '' }
}

/** Set a controlled field the way a person does; see `DailyAuditWorkspace.test.tsx` for why `.value` alone fails. */
function setField(field: HTMLInputElement | HTMLSelectElement, value: string): void {
  const prototype = field instanceof HTMLSelectElement
    ? window.HTMLSelectElement.prototype
    : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (!setter) throw new Error('no native value setter')
  setter.call(field, value)
  field.dispatchEvent(new Event('input', { bubbles: true }))
  field.dispatchEvent(new Event('change', { bubbles: true }))
}

function button(container: HTMLElement, label: RegExp): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((candidate) => label.test((candidate.textContent ?? '').trim()))
  expect(found, `a button labelled ${String(label)}`).toBeDefined()
  return found as HTMLButtonElement
}

function clicked(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].filter((candidate) => (candidate.textContent ?? '').trim() === label)
  expect(found, `exactly one button labelled ${label}`).toHaveLength(1)
  return found[0] as HTMLButtonElement
}

function press(target: HTMLElement): void {
  target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

/** What the screen says happened, or null when it is reporting a refusal instead. */
function status(container: HTMLElement): string | null {
  return container.querySelector('[role="status"]')?.textContent ?? null
}

async function takePayment(harness: Harness, amount: string): Promise<void> {
  const open = harness.container.querySelector('button.debtor-take-payment') as HTMLButtonElement
  expect(open, 'the row offers the control').toBeDefined()
  await act(async () => { open.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  const form = harness.container.querySelector('form') as HTMLFormElement
  expect(form, 'the form opened').toBeDefined()
  const field = form.querySelector('input[inputmode="decimal"]') as HTMLInputElement
  await act(async () => { setField(field, amount) })
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
}

const addedUrlMethods: string[] = []

beforeEach(() => {
  document.body.innerHTML = ''
  // Added to the real `URL` rather than stubbing the global: replacing `URL` outright breaks `new URL(...)` everywhere,
  // which costs a confusing failure in code that has nothing to do with downloads.
  for (const [name, value] of Object.entries({ createObjectURL: (): string => 'blob:preview', revokeObjectURL: (): void => undefined })) {
    if (typeof (URL as unknown as Record<string, unknown>)[name] !== 'function') {
      (URL as unknown as Record<string, unknown>)[name] = value
      addedUrlMethods.push(name)
    }
  }
})

afterEach(() => {
  for (const name of addedUrlMethods.splice(0)) delete (URL as unknown as Record<string, unknown>)[name]
  for (const entry of mounted.splice(0)) {
    act(() => { entry.root.unmount() })
    entry.container.remove()
  }
})

describe('the screen mounts for the two roles that may open it', () => {
  it.each([['ADMIN'], ['ACCOUNT']] as Array<[PublicUser['role']]>)('mounts as %s and reads the day', async (role) => {
    const as = user(role)
    // Only these two hold `view_reports`, so these are the only two the navigation can bring here.
    expect(can(role === 'CASHIER' ? 'USER' : role, 'view_reports'), `${role} may open Reports`).toBe(true)
    const screen = await mountScreen(as)
    expect(screen.bridge.getAccountingReport).toHaveBeenCalled()
    expect(screen.text()).toContain('Harbor Health')
    expect(screen.container.querySelector('[role="alert"]')).toBeNull()
  })

  it('renders a Server refusal as an alert and does not pretend the day was read', async () => {
    const screen = await mountScreen(user('ACCOUNT'), {
      getAccountingReport: vi.fn(async () => { throw new Error('You do not have permission to open Reports.') }),
    } as Partial<InfoflexBridge>)
    const alert = screen.container.querySelector('[role="alert"]')
    expect(alert).not.toBeNull()
    expect(alert!.textContent).toContain('You do not have permission to open Reports.')
    // And there is no panel full of invented zeros standing in for the report that was refused.
    expect(screen.text()).not.toContain('Money owed by customers')
  })
})

describe('an ACCOUNT can reach a balance and the control that settles it', () => {
  it('shows the balances and the control in the day summary, which is the only view this role gets', async () => {
    const as = user('ACCOUNT')
    expect(can('ACCOUNT', 'record_debtor_payment'), 'the capability this screen has to reach').toBe(true)
    const screen = await mountScreen(as)

    expect(screen.text()).toContain('Money owed by customers')
    expect(screen.text()).toContain('Bode Stores')
    expect(screen.text()).toContain(formatMoney(150_000n, CURRENCY, DISPLAY))
    expect(screen.container.querySelectorAll('button.debtor-take-payment')).toHaveLength(1)

    // There is no section selector for this role, which is the whole reason the balances had to come into the summary:
    // the Admin's detailed sections are Admin-only and carry costs, so a control placed only under one of them would be
    // placed only where this role cannot go.
    const selectors = [...screen.container.querySelectorAll<HTMLSelectElement>('.reports-toolbar select')]
      .map((select) => [...select.options].map((option) => option.value))
    expect(selectors.some((options) => options.includes('debtors')), 'no section selector reaches Debtors').toBe(false)
  })

  it('shows no cost anywhere in what this role is given', async () => {
    const screen = await mountScreen(user('ACCOUNT'))
    // The summary withholds cost and gross profit for a non-Admin; the debtor panel must not smuggle either back in,
    // because a balance is exactly the kind of figure that invites a margin beside it.
    for (const forbidden of ['Cost of goods', 'Gross profit', 'Margin']) {
      expect(screen.text(), `${forbidden} is withheld from an ACCOUNT`).not.toContain(forbidden)
    }
  })
})

describe('an Admin sees the same panel under Debtors', () => {
  it('renders it from the report rather than from the Admin block', async () => {
    const screen = await mountScreen(user('ADMIN'), {}, 'debtors')
    expect(screen.text()).toContain('Money owed by customers')
    expect(screen.text()).toContain('Bode Stores')
    expect(screen.container.querySelectorAll('button.debtor-take-payment')).toHaveLength(1)
    // The fixture deliberately carries no Admin block at all, and the section still renders: that is the proof the
    // balances stopped living inside it. Before the move this section could not have shown anything without it.
    expect(screen.text()).not.toContain('Admin report data is unavailable.')
  })

  it('still refuses the sections that are Admin data, so the exemption is the debtors section alone', async () => {
    const screen = await mountScreen(user('ADMIN'), {}, 'valuation')
    expect(screen.text()).toContain('Admin report data is unavailable.')
    expect(screen.text()).not.toContain('Money owed by customers')
  })
})

describe('taking a payment goes to the Server and the day is read again', () => {
  it('sends what was typed and re-reads the report', async () => {
    const as = user('ACCOUNT')
    const screen = await mountScreen(as)
    const readsBefore = screen.bridge.getAccountingReport.mock.calls.length

    await takePayment(screen, '250.00')

    expect(screen.bridge.recordDebtorPayment).toHaveBeenCalledTimes(1)
    expect(screen.bridge.recordDebtorPayment).toHaveBeenCalledWith({
      customerId: 'c-1', amount: '250.00', method: 'CASH', reference: '', note: '',
    })
    // Read again, because the balance on screen has to be the balance the Server now holds. A panel that showed the
    // pre-payment figure after a successful payment would invite taking the same money twice.
    expect(screen.bridge.getAccountingReport.mock.calls.length).toBeGreaterThan(readsBefore)
    expect(screen.container.querySelector('[role="status"]')?.textContent).toContain('DP-00000001')
    expect(screen.container.querySelector('[role="status"]')?.textContent)
      .toContain(formatMoney(125_000n, CURRENCY, DISPLAY))
  })

  it('renders a refusal as an alert and keeps the balances on screen', async () => {
    const screen = await mountScreen(user('ACCOUNT'), {
      recordDebtorPayment: vi.fn(async () => {
        throw new Error('Bode Stores owes nothing, so there is no payment to take.')
      }),
    } as Partial<InfoflexBridge>)

    await takePayment(screen, '250.00')

    const alert = screen.container.querySelector('[role="alert"]')
    expect(alert, 'the Server sentence reaches the person').not.toBeNull()
    expect(alert!.textContent).toContain('owes nothing, so there is no payment to take.')
    // The list is still there and still true: a refusal to move money is not a reason to hide what is owed.
    expect(screen.text()).toContain('Bode Stores')
    expect(screen.text()).toContain(formatMoney(150_000n, CURRENCY, DISPLAY))
  })
})

describe('the export asks for the section the caller may export', () => {
  /**
   * `exportSection` is the screen's own scope guard: a caller with no section selector is exported the summary whatever
   * section the screen was opened on. The prop is how a deep link would arrive, so the guard has to be the screen's
   * rather than the navigation's.
   */
  it('exports an ACCOUNT the summary, and names the file after what it actually holds', async () => {
    const downloaded: string[] = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) { downloaded.push(this.download) })
    try {
      const screen = await mountScreen(user('ACCOUNT'), {}, 'valuation')
      // Read off the screen rather than written down here: the date field defaults to today, and today in this sandbox is
      // not the business date the fixtures use. The claim is that the export asks for the day the person is looking at,
      // whatever day that is - hard-coding a date would make the test pass or fail on the calendar instead.
      const onScreen = (screen.container.querySelector('input[type="date"]') as HTMLInputElement).value
      expect(onScreen).toMatch(/^\d{4}-\d{2}-\d{2}$/u)

      await act(async () => { press(button(screen.container, /^CSV$/u)) })

      expect(screen.bridge.exportReportCsv).toHaveBeenCalledTimes(1)
      expect(screen.bridge.exportReportCsv.mock.calls[0]![0])
        .toMatchObject({ period: 'DAY', date: onScreen, section: 'summary' })
      expect(downloaded).toHaveLength(1)
      expect(downloaded[0]).toContain(`-${onScreen}-summary.csv`)
      // The name is built from the same value as the request, so it cannot describe a section the file does not hold.
      expect(downloaded[0]).not.toContain('valuation')
      expect(status(screen.container)).toBe('CSV report downloaded.')
    } finally {
      click.mockRestore()
    }
  })

  it('exports an Admin the section they chose, named for it', async () => {
    const downloaded: string[] = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) { downloaded.push(this.download) })
    try {
      const screen = await mountScreen(user('ADMIN'), {}, 'valuation')
      await act(async () => { press(button(screen.container, /^CSV$/u)) })
      expect(screen.bridge.exportReportCsv.mock.calls[0]![0]).toMatchObject({ section: 'valuation' })
      expect(downloaded[0]).toContain('-valuation.csv')
    } finally {
      click.mockRestore()
    }
  })

  it('sends Excel and PDF to their own writers and says which format arrived', async () => {
    const screen = await mountScreen(user('ADMIN'))
    await act(async () => { press(button(screen.container, /^Excel$/u)) })
    expect(screen.bridge.exportReportExcel).toHaveBeenCalledTimes(1)
    expect(status(screen.container)).toBe('EXCEL report downloaded.')

    await act(async () => { press(button(screen.container, /^PDF$/u)) })
    expect(screen.bridge.exportReportPdf).toHaveBeenCalledTimes(1)
    expect(status(screen.container)).toBe('PDF report downloaded.')
    // Neither went through the CSV writer, which is the mistake a shared handler makes.
    expect(screen.bridge.exportReportCsv).not.toHaveBeenCalled()
  })

  it('renders a refused export as an alert and claims no download', async () => {
    const downloaded: string[] = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) { downloaded.push(this.download) })
    try {
      const screen = await mountScreen(user('ADMIN'), {
        exportReportCsv: vi.fn(async () => { throw new Error('Detailed report exports are restricted to the Admin.') }),
      } as Partial<InfoflexBridge>)
      await act(async () => { press(button(screen.container, /^CSV$/u)) })

      const alert = screen.container.querySelector('[role="alert"]')
      expect(alert, 'the Server sentence reaches the person').not.toBeNull()
      expect(alert!.textContent).toContain('Detailed report exports are restricted to the Admin.')
      expect(downloaded, 'nothing was downloaded').toHaveLength(0)
      expect(status(screen.container), 'and nothing claims otherwise').toBeNull()
    } finally {
      click.mockRestore()
    }
  })
})

describe('the end-of-day close is an Admin-only act', () => {
  it('offers an ACCOUNT no close, even with a cash position on the report', async () => {
    const screen = await mountScreen(user('ACCOUNT'), {}, 'summary', { cashPosition: cashPosition() })
    // The figures this role may see are still there; the act that freezes the business date is not.
    expect(screen.text()).not.toContain('Save end-of-day close')
    expect(screen.text()).not.toContain('Cash close')
    expect(screen.container.querySelector('.report-close-form')).toBeNull()
  })

  it('will not save a close with nothing counted, and sends the count when there is one', async () => {
    const screen = await mountScreen(user('ADMIN'), {}, 'summary', { cashPosition: cashPosition() })
    const save = button(screen.container, /^Save end-of-day close$/u)
    expect(save.disabled, 'no count yet').toBe(true)

    const counted = screen.container.querySelector('.report-close-form input[inputmode="decimal"]') as HTMLInputElement
    const note = screen.container.querySelector('.report-close-form input[maxlength="500"]') as HTMLInputElement
    await act(async () => {
      setField(counted, '295.00')
      setField(note, 'Hand counted twice')
    })
    expect(save.disabled).toBe(false)

    const reads = screen.bridge.getAccountingReport.mock.calls.length
    await act(async () => { press(save) })
    expect(screen.bridge.closeReportingDay).toHaveBeenCalledWith({
      businessDate: DAY, countedCash: '295.00', note: 'Hand counted twice',
    })
    // Read again: the close changes what the day says, and a screen showing the pre-close day would invite closing twice.
    expect(screen.bridge.getAccountingReport.mock.calls.length).toBeGreaterThan(reads)
    expect(status(screen.container)).toContain('DC-00000001')
  })

  it('shows a day already closed in words, with no form to close it again', async () => {
    const screen = await mountScreen(user('ADMIN'), {}, 'summary', {
      cashPosition: cashPosition(), dayClose: dayClose(),
    })
    expect(screen.text()).toContain('DC-00000001')
    expect(screen.text()).toContain('Closed by ADMIN Person')
    // The difference is a word as well as a figure: -500 minor units on its own does not say which way it went.
    expect(screen.text()).toContain('Difference · short')
    expect(screen.text()).toContain(formatMoney(-500n, CURRENCY, DISPLAY))
    expect(screen.container.querySelector('.report-close-form'), 'a closed day offers no form').toBeNull()
    expect(screen.text()).not.toContain('Save end-of-day close')
  })

  it('renders a refused close as an alert and leaves the form ready to try again', async () => {
    const screen = await mountScreen(user('ADMIN'), {
      closeReportingDay: vi.fn(async () => { throw new Error('The day is already closed.') }),
    } as Partial<InfoflexBridge>, 'summary', { cashPosition: cashPosition() })

    const counted = screen.container.querySelector('.report-close-form input[inputmode="decimal"]') as HTMLInputElement
    await act(async () => { setField(counted, '295.00') })
    await act(async () => { press(button(screen.container, /^Save end-of-day close$/u)) })

    expect(screen.container.querySelector('[role="alert"]')?.textContent).toContain('The day is already closed.')
    expect(status(screen.container)).toBeNull()
    // Still open, still editable: the count that was refused is not thrown away.
    expect(screen.container.querySelector('.report-close-form')).not.toBeNull()
    expect(counted.value).toBe('295.00')
  })
})

describe('cashier shifts and the drawer', () => {
  it('offers to open a shift only to somebody who does not have one open', async () => {
    const own = await mountScreen(user('ACCOUNT'), {}, 'summary', { shifts: [shift()] })
    expect(own.text(), 'a second open shift for one cashier is the mistake this hides').not.toContain('Open my cashier shift')

    const none = await mountScreen(user('ACCOUNT'), {}, 'summary', { shifts: [] })
    const float = none.container.querySelector('.report-open-shift-form input[inputmode="decimal"]') as HTMLInputElement
    await act(async () => { setField(float, '150.00') })
    await act(async () => { press(button(none.container, /^Open my cashier shift$/u)) })
    expect(none.bridge.openCashierShift).toHaveBeenCalledWith({ openingFloat: '150.00' })
  })

  it('shows the drawer form only while a shift is open, and needs both an amount and a reason', async () => {
    const none = await mountScreen(user('ACCOUNT'), {}, 'summary', { shifts: [] })
    expect(none.container.querySelector('.report-drawer-event-form'), 'no open shift, no drawer to adjust').toBeNull()

    const screen = await mountScreen(user('ACCOUNT'), {}, 'summary', { shifts: [shift()] })
    const form = screen.container.querySelector('.report-drawer-event-form') as HTMLFormElement
    expect(form, 'an open shift means a drawer somebody is responsible for').not.toBeNull()

    const submit = button(screen.container, /^Record drawer event$/u)
    expect(submit.disabled, 'no amount and no reason yet').toBe(true)

    const amount = form.querySelector('input[inputmode="decimal"]') as HTMLInputElement
    const note = form.querySelector('input[maxlength="240"]') as HTMLInputElement
    const type = form.querySelectorAll('select')[1] as HTMLSelectElement
    await act(async () => {
      setField(type, 'SAFE_DROP')
      setField(amount, '20.00')
      setField(note, 'Dropped into the safe')
    })
    expect(submit.disabled).toBe(false)
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })

    expect(screen.bridge.recordCashDrawerEvent).toHaveBeenCalledWith({
      shiftId: 'shift-1', type: 'SAFE_DROP', amount: '20.00', note: 'Dropped into the safe',
    })
    // The type arrives as the value the Server stores, not the label the person picked.
    expect(status(screen.container)).toBe('safe drop recorded.')
    expect(amount.value, 'cleared so the same event is not recorded twice by accident').toBe('')
    expect(note.value).toBe('')
  })

  it('does not offer a till operator the Close control on another cashier shift', async () => {
    const screen = await mountScreen(user('ACCOUNT'), {}, 'summary', {
      shifts: [shift({ id: 'shift-9', cashierId: 'somebody-else', cashierName: 'Other Cashier' })],
    })
    // The shift is still listed - reading it is not the restricted part.
    expect(screen.text()).toContain('Other Cashier')
    expect(screen.container.querySelector('input[aria-label^="Counted cash for"]')).toBeNull()
    expect([...screen.container.querySelectorAll('button')].map((candidate) => (candidate.textContent ?? '').trim()))
      .not.toContain('Close')
  })

  it('lets an Admin close any shift, sending the count typed against that shift', async () => {
    const screen = await mountScreen(user('ADMIN'), {
      // The Server answers with the row it closed, so the double answers with that shift and not the fixture default.
      // The confirmation is built from what comes back, which is the point: the screen does not guess whose shift it was.
      closeCashierShift: vi.fn(async () => shift({
        id: 'shift-9', cashierId: 'somebody-else', cashierName: 'Other Cashier', status: 'CLOSED',
        closedAt: '2026-11-17T19:00:00.000Z', countedCashMinor: 29_500n, varianceMinor: -500n, closedBy: 'ADMIN Person',
      })),
    } as Partial<InfoflexBridge>, 'summary', {
      shifts: [shift({ id: 'shift-9', cashierId: 'somebody-else', cashierName: 'Other Cashier' })],
    })
    const counted = screen.container.querySelector('input[aria-label="Counted cash for Other Cashier"]')
    expect(counted, 'the Admin is offered the control on another cashier shift').not.toBeNull()

    const close = clicked(screen.container, 'Close')
    expect(close.disabled, 'nothing counted yet').toBe(true)
    await act(async () => { setField(counted as HTMLInputElement, '295.00') })
    expect(close.disabled).toBe(false)
    await act(async () => { press(close) })

    expect(screen.bridge.closeCashierShift).toHaveBeenCalledWith({ shiftId: 'shift-9', countedCash: '295.00' })
    expect(status(screen.container)).toContain('Other Cashier shift closed')
    // The over/short is the point of the act, so it is in the confirmation rather than only in the table.
    expect(status(screen.container)).toContain(formatMoney(-500n, CURRENCY, DISPLAY))
  })
})
