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
import type { AccountingReport, DebtorReportRow, RecordDebtorPaymentInput } from '@shared/reports/types'
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

interface Harness {
  bridge: {
    getAccountingReport: ReturnType<typeof vi.fn>
    recordDebtorPayment: ReturnType<typeof vi.fn>
  }
  container: HTMLElement
  text(): string
}

async function mountScreen(
  as: PublicUser,
  overrides: Partial<InfoflexBridge> = {},
  initialSection?: 'summary' | 'debtors' | 'valuation',
): Promise<Harness> {
  const bridge = {
    getAccountingReport: vi.fn(async () => report({}, as)),
    recordDebtorPayment: vi.fn(async (_input: RecordDebtorPaymentInput) => ({
      paymentNumber: 'DP-00000001', customerName: 'Bode Stores', receivedByName: as.fullName,
      paymentMethod: 'CASH', amountMinor: 25_000n, balanceBeforeMinor: 150_000n, balanceAfterMinor: 125_000n,
      reference: '', at: '2026-11-17T09:05:00.000Z',
    })),
    exportReportCsv: vi.fn(async () => 'a,b'),
    exportReportExcel: vi.fn(async () => 'U3RvcmU='),
    exportReportPdf: vi.fn(async () => ({ contentBase64: 'U3RvcmU=', fileName: 'report.pdf' })),
    ...overrides,
  } as unknown as InfoflexBridge & Harness['bridge']

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

beforeEach(() => { document.body.innerHTML = '' })

afterEach(() => {
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
