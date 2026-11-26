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
  AuditCheckCode,
  AuditDayStatus,
  AuditFlagRow,
  AuditSignOffRow,
  DailyAuditReport,
  UnauditedDay,
} from '@shared/audit/types'
import { AUDIT_CHECK_CODES } from '@shared/audit/types'
import { AUDIT_CHECK_TITLES } from '../../../services/audit-export'
import { DailyAuditWorkspace } from './DailyAuditWorkspace'

/**
 * The audit screen, mounted into a real DOM.
 *
 * The rules themselves are tested where they live: `daily-audit-service.test.ts` for what a day contains and who may
 * sign it, `audit-export.test.ts` for the file, `audit-checks` through the service for the severities, and
 * `permission-matrix.test.ts` for who may open the page at all. What this file adds is the half none of those can see —
 * **what the screen offers, and what it says**.
 *
 * That matters more here than on most screens, because three of this phase's claims are claims about a *rendered* page
 * and not about a service:
 *
 * - the screen offers nothing the Server would refuse, so a button is evidence about the caller's own role;
 * - a clean day lists all six checks with "Nothing found" beside them, because an empty box on an audit screen is
 *   indistinguishable from a screen that never ran;
 * - there is no print control, and the absence is written on the screen rather than left to be noticed.
 *
 * A screen that crashed on mount would fail every one of those and none of the service tests, which is the lesson an
 * earlier phase wrote down after exactly that happened.
 */

const PERMISSIONS = { allowWholesale: false, maxDiscountBasisPoints: 0, allowCreditSales: false, returnLimitMinor: 0n }

function user(role: PublicUser['role']): PublicUser {
  return {
    id: `${role}-1`, fullName: `${role} Person`, username: role.toLowerCase(), role,
    isActive: true, isLocked: false, permissions: PERMISSIONS,
  }
}

const CURRENCY = getCurrency('NGN')!
const DISPLAY = defaultDisplayOptions(CURRENCY)
const BOOTSTRAP = {
  settings: { currency: CURRENCY, display: DISPLAY, profile: { name: 'Harbor Health' } },
  appInfo: { productName: 'Infoflex', appVersion: '0.1.0' },
  setupContext: { edition: 'BOTH' },
} as unknown as BootstrapData

const TODAY = '2026-11-17'

function signOff(overrides: Partial<AuditSignOffRow> = {}): AuditSignOffRow {
  return {
    id: 'so-1', outcome: 'AUDITED', note: '', signedByName: 'Sam Supervisor',
    signedAt: '2026-11-17T19:40:00.000Z', subjectDigest: 'a-digest-of-the-day', digestMatches: true,
    ...overrides,
  }
}

function flag(overrides: Partial<AuditFlagRow> = {}): AuditFlagRow {
  return {
    id: 'flag-1', source: 'AUTOMATIC', checkCode: 'CASH_DIFFERENCE', severity: 'SERIOUS',
    detail: 'The drawer was short by ₦84.00', raisedByName: 'Sam Supervisor', raisedAt: '2026-11-17T19:05:00.000Z',
    resolvedByName: '', resolvedAt: '', resolutionNote: '',
    ...overrides,
  }
}

/** The day the service would hand back: two sales, a counted drawer that is short, and one serious finding. */
function report(overrides: Partial<DailyAuditReport> = {}): DailyAuditReport {
  return {
    header: {
      storeName: 'Harbor Health', storeAddress: '12 Dock Road, Lagos', currency: CURRENCY, display: DISPLAY,
      period: { type: 'DAY', startDate: TODAY, endDate: TODAY, label: TODAY },
      generatedAt: '2026-11-17T19:30:00.000Z', scope: 'STORE', viewerName: 'Sam Supervisor', edition: 'BOTH',
    },
    businessDate: TODAY,
    currencyCode: 'NGN',
    edition: 'BOTH',
    account: null,
    accounts: [{ id: 'a1', name: 'Amaka Account', username: 'account1', transactions: 1, salesMinor: 3_800n }],
    totals: {
      grossSalesMinor: 13_000n, totalSalesMinor: 12_300n, netSalesMinor: 10_400n, transactions: 2,
      retailMinor: 3_800n, retailTransactions: 1, wholesaleMinor: 8_500n, wholesaleTransactions: 1,
      discountsMinor: 700n, returnsMinor: 1_900n, returnTransactions: 1, refundsMinor: 1_900n,
      creditSalesMinor: 500n, creditTransactions: 1, debtorPaymentsMinor: 500n, debtorPaymentTransactions: 1,
      voids: 0, overrides: 1, reprints: 0, cancelledOrders: 0, expiredOrders: 0,
    },
    sales: [],
    voids: [],
    overrides: [],
    discounts: [],
    reprints: [],
    returns: [],
    creditSales: [],
    debtorPayments: [],
    orders: [],
    paymentMethods: [
      { method: 'CASH', transactions: 2, salesMinor: 10_000n, refundsMinor: -1_900n, netMinor: 8_100n },
    ],
    cashTie: {
      currencyCode: 'NGN', openingFloatMinor: 10_000n, cashSalesMinor: 10_000n, cashRefundsMinor: -1_900n,
      drawerAdjustmentsMinor: -200n, debtorCashMinor: 500n, expectedCashMinor: 18_400n, countedCashMinor: 10_000n,
      differenceMinor: -8_400n, counted: true, closedByName: 'Ada Admin', closedAt: '2026-11-17T19:00:00.000Z',
      differs: true,
    },
    dayClose: null,
    shifts: [],
    findings: [{
      code: 'CASH_DIFFERENCE', severity: 'SERIOUS', headline: 'The drawer was short by ₦84.00',
      detail: 'Expected ₦184.00, counted ₦100.00.', count: 1, amountMinor: -8_400n,
    }],
    checksRun: [...AUDIT_CHECK_CODES],
    flags: [flag()],
    signOff: null,
    reconciliation: {
      grossFromRowsMinor: 13_000n, grossFromLedgerMinor: 13_000n, salesFromRowsMinor: 12_300n,
      salesFromLedgerMinor: 12_300n, transactionsFromRows: 2, transactionsFromLedger: 2,
      paymentsFromRowsMinor: 12_300n, paymentsFromLedgerMinor: 12_300n, returnsFromRowsMinor: 1_900n,
      returnsFromLedgerMinor: 1_900n, refundsFromRowsMinor: 1_900n, refundsFromLedgerMinor: 1_900n,
      discountsFromRowsMinor: 700n, discountsFromLedgerMinor: 700n, matches: true, differences: [],
    },
    canSignOff: true,
    canNote: true,
    canExport: true,
    ...overrides,
  }
}

function unauditedDay(overrides: Partial<UnauditedDay> = {}): UnauditedDay {
  return {
    businessDate: '2026-11-16', accountId: null, accountName: 'Whole store', transactions: 18,
    salesMinor: 412_300n, currencyCode: 'NGN', openFlags: 1, dayClosed: true,
    ...overrides,
  }
}

function dayStatus(overrides: Partial<AuditDayStatus> = {}): AuditDayStatus {
  return {
    businessDate: TODAY, accountId: null, accountName: 'Whole store', audited: false, outcome: null,
    signedByName: '', signedAt: '', openFlags: 1, transactions: 2, salesMinor: 12_300n, currencyCode: 'NGN',
    dayClosed: true,
    ...overrides,
  }
}

interface Harness {
  bridge: InfoflexBridge
  text(): string
  container: HTMLElement
}

const mounted: Array<{ root: { unmount(): void }; container: HTMLElement }> = []

/**
 * Mount into a container of its own.
 *
 * Several tests mount the screen twice - once as a caller who may write and once as a caller who may only read - and
 * two React roots over one DOM node is not two screens: unmounting either takes the other's nodes with it.
 */
async function mount(element: ReactElement): Promise<HTMLElement> {
  const holder = document.createElement('div')
  document.body.append(holder)
  const root = createRoot(holder)
  mounted.push({ root, container: holder })
  await act(async () => { root.render(element) })
  return holder
}

async function mountScreen(overrides: Partial<InfoflexBridge> = {}, as: PublicUser = user('SUPERVISOR')): Promise<Harness> {
  const bridge = {
    getDayAudit: vi.fn(async () => report()),
    listAuditDayStatuses: vi.fn(async () => [dayStatus()]),
    listUnauditedDays: vi.fn(async () => [unauditedDay()]),
    exportAudit: vi.fn(async () => ({
      format: 'CSV', contentBase64: 'U3RvcmU=', fileName: `daily-audit-${TODAY}.csv`,
      mimeType: 'text/csv;charset=utf-8', storeName: 'Harbor Health', currencyCode: 'NGN',
    }) as never),
    signOffAuditDay: vi.fn(async () => signOff()),
    noteAuditFinding: vi.fn(async () => flag({ detail: 'The drawer was short by ₦84.00\n[Sam · 2026-11-17] Counted twice.' })),
    raiseAuditFlag: vi.fn(async () => flag({ source: 'MANUAL', checkCode: '' })),
    addAuditFlagNote: vi.fn(async () => flag()),
    resolveAuditFlag: vi.fn(async () => flag({ resolvedAt: '2026-11-17T19:45:00.000Z', resolvedByName: 'Sam Supervisor' })),
    ...overrides,
  } as unknown as InfoflexBridge

  const holder = await mount(<DailyAuditWorkspace bridge={bridge} bootstrap={BOOTSTRAP} user={as} />)
  return { bridge, container: holder, text: () => holder.textContent ?? '' }
}

/** Every button on the screen, by its visible label. */
function buttons(harness: Harness): string[] {
  return [...harness.container.querySelectorAll('button')].map((button) => (button.textContent ?? '').trim())
}

/**
 * Set a controlled field's value the way a person does.
 *
 * React tracks the value it last rendered and treats a test assigning `.value` directly as no change, so `onChange`
 * never fires and the test fails while the screen is fine. Going through the prototype's native setter defeats that
 * tracking - the same helper `UsersAndSeats.test.tsx` uses, for the same reason.
 */
function setFieldText(field: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  const prototype = field instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (!setter) throw new Error('no native value setter')
  setter.call(field, value)
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

function click(harness: Harness, label: RegExp): void {
  const found = [...harness.container.querySelectorAll('button')]
    .find((button) => label.test((button.textContent ?? '').trim()))
  expect(found, `a button labelled ${String(label)}`).toBeDefined()
  act(() => { found!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

// jsdom implements neither half of the object-URL pair the export download uses. Added for the duration of a test and
// removed after, rather than stubbed over the global URL, which would stop `new URL(...)` working anywhere else.
const addedUrlMethods: string[] = []

beforeEach(() => {
  for (const [name, value] of Object.entries({ createObjectURL: (): string => 'blob:preview', revokeObjectURL: (): void => undefined })) {
    if (typeof (URL as unknown as Record<string, unknown>)[name] !== 'function') {
      (URL as unknown as Record<string, unknown>)[name] = value
      addedUrlMethods.push(name)
    }
  }
})

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => { entry.root.unmount() })
    entry.container.remove()
  }
  for (const name of addedUrlMethods.splice(0)) delete (URL as unknown as Record<string, unknown>)[name]
})

describe('the audit screen mounts, for every role that can reach the page', () => {
  // The Phase 17 lesson, applied here: a screen that throws on mount passes every service test and shows nobody
  // anything. Each role gets its own mount because the report's permission flags differ by caller in production.
  const roles: Array<PublicUser['role']> = ['ADMIN', 'SUPERVISOR', 'ACCOUNT', 'USER']

  it.each(roles)('mounts for a %s and reads the day', async (role) => {
    const harness = await mountScreen({}, user(role))
    expect(harness.text()).toContain('Daily audit')
    expect(harness.bridge.getDayAudit).toHaveBeenCalledTimes(1)
  })

  it('reads today, for the whole store, before anybody touches it', async () => {
    const harness = await mountScreen()
    const call = (harness.bridge.getDayAudit as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      businessDate: string; accountId: string | null
    }
    expect(call.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/u)
    expect(call.accountId, 'no till chosen means the whole store, not a guess at one').toBeNull()
    // The date input agrees with what was asked for, so the screen is not showing one day and reading another.
    const input = harness.container.querySelector('input[type="date"]') as HTMLInputElement
    expect(input.value).toBe(call.businessDate)
  })

  it('survives a Server that refuses the day, and says so as an alert', async () => {
    const harness = await mountScreen({
      getDayAudit: vi.fn(async () => { throw new Error('You do not have permission to audit the day.') }),
    })
    const alert = harness.container.querySelector('[role="alert"]')
    expect(alert, 'the refusal is announced, not swallowed').toBeDefined()
    expect(alert!.textContent).toContain('You do not have permission to audit the day.')
    // And the screen is still a screen: it asks for a date rather than rendering nothing at all.
    expect(harness.text()).toContain('Choose a business date to audit.')
  })
})

describe('the screen offers nothing the Server would refuse', () => {
  it('shows every control when the report says the caller may use it', async () => {
    const harness = await mountScreen()
    const labels = buttons(harness).join(' | ')
    expect(labels).toContain('Export CSV')
    expect(labels).toContain('Export Excel')
    expect(labels).toContain('Note this')
    expect(labels).toMatch(/Sign off \d{4}-\d{2}-\d{2}/u)
  })

  it('shows none of them when the report says the caller may only read', async () => {
    // This is the shape a read-only caller gets, and it is the Server's answer rather than the screen's own role check:
    // a screen that decided for itself would eventually disagree with the service that decides for real.
    const harness = await mountScreen({
      getDayAudit: vi.fn(async () => report({ canExport: false, canNote: false, canSignOff: false })),
    })
    const labels = buttons(harness).join(' | ')
    expect(labels).not.toContain('Export')
    expect(labels).not.toContain('Note this')
    expect(labels).not.toMatch(/Sign off/u)
    // The day is still readable, which is the whole of what that caller is allowed.
    expect(harness.text()).toContain('The day in figures')
    expect(harness.text()).toContain('₦130.00')
  })

  it('offers the note button only against a finding, and only to somebody who may write one', async () => {
    const clean = await mountScreen({
      getDayAudit: vi.fn(async () => report({ findings: [], flags: [] })),
    })
    expect(buttons(clean).join(' | ')).not.toContain('Note this')

    const readOnly = await mountScreen({
      getDayAudit: vi.fn(async () => report({ canNote: false })),
    })
    expect(buttons(readOnly).join(' | ')).not.toContain('Note this')
  })

  it('exports in the format the button names, and asks the Server rather than building the file itself', async () => {
    const harness = await mountScreen()
    // jsdom cannot save a file; what matters is what the screen asked for and that it did not fabricate a document.
    harness.bridge.exportAudit = vi.fn(async () => { throw new Error('download blocked in test') }) as never
    click(harness, /^Export Excel$/u)
    expect(harness.bridge.exportAudit).toHaveBeenCalledWith({
      businessDate: TODAY, accountId: null, format: 'EXCEL',
    })
  })
})

describe('nothing on this screen can print', () => {
  it('offers no print control, and says on the screen that this is deliberate', async () => {
    const harness = await mountScreen()
    // No *action* whose label is about printing. The screen does mention printing - a day's duplicate prints are one of
    // the things an audit looks at - and the section that lists them is opened by a disclosure button, so the assertion
    // is about controls that do something and not about the word appearing.
    for (const button of harness.container.querySelectorAll('button')) {
      if (button.classList.contains('audit-disclosure')) continue
      const label = (button.textContent ?? '').trim()
      expect(label, `"${label}" is a print control`).not.toMatch(/print|receipt/u)
    }
    // And the disclosures are disclosures: each one opens a table of what already happened.
    const disclosures = [...harness.container.querySelectorAll('button.audit-disclosure')]
    expect(disclosures.length).toBeGreaterThan(0)
    expect(disclosures.some((node) => (node.textContent ?? '').includes('printed more than once'))).toBe(true)
    const stated = harness.container.querySelector('.audit-no-print')
    expect(stated, 'the absence is stated rather than left to be noticed').toBeDefined()
    expect(stated!.textContent).toBe('No printing from this screen. An audit is a file, not a receipt.')
  })

  it('has no print method to call, so the claim is not only about the buttons it happens to render', async () => {
    const harness = await mountScreen()
    const printable = ['recordPosReceiptPrint', 'printDocument', 'printAudit', 'recordReturnPrint']
    for (const method of printable) {
      expect(method in harness.bridge, `${method} is not part of this screen's contract`).toBe(false)
    }
    // The one document this screen can produce is a file, and both of its buttons ask for one.
    expect(buttons(harness).filter((label) => label.startsWith('Export'))).toHaveLength(2)
  })
})

describe('a clean day says it was checked', () => {
  it('lists all six checks with "Nothing found" beside the quiet ones, rather than showing an empty box', async () => {
    const harness = await mountScreen({
      getDayAudit: vi.fn(async () => report({ findings: [], flags: [] })),
    })
    const cleared = harness.container.querySelectorAll('.audit-clear')
    expect(cleared).toHaveLength(AUDIT_CHECK_CODES.length)
    // And each check is named, so a reader can see what was looked for and not merely that nothing turned up.
    for (const code of AUDIT_CHECK_CODES) {
      expect(harness.text(), `${code} is named on the screen`).toContain(AUDIT_CHECK_TITLES[code as AuditCheckCode])
    }
    expect(harness.text()).toContain('What the checks found')
  })

  it('writes a finding in colour and in words, because colour alone is not a finding', async () => {
    const harness = await mountScreen()
    const badge = harness.container.querySelector('.audit-badge--serious')
    expect(badge, 'the severity carries a colour class').toBeDefined()
    expect(badge!.textContent, 'and the word beside it').toBe('SERIOUS')
    expect(harness.text()).toContain('The drawer was short by ₦84.00')
    // The amount is on the row, in the shop's own formatting - computed here rather than spelled out, because where a
    // currency puts the minus sign is the currency's business and not the test's guess.
    expect(harness.text()).toContain(formatMoney(-8_400n, CURRENCY, DISPLAY))
    expect(harness.container.querySelector('.audit-money')!.textContent).not.toBe('')
  })

  it('says whether the totals agree with the ledger, and names the difference when they do not', async () => {
    const agreeing = await mountScreen()
    expect(agreeing.container.querySelector('.audit-clear-line')!.textContent)
      .toContain('These totals agree with the sales ledger to the last unit.')

    const differing = await mountScreen({
      getDayAudit: vi.fn(async () => report({
        reconciliation: { ...report().reconciliation, matches: false, differences: ['gross sales: the audit shows 13000 and the ledger shows 13100'] },
      })),
    })
    const line = differing.container.querySelector('.audit-differs-line')
    expect(line, 'a disagreement is not rendered in the agreeing style').toBeDefined()
    expect(line!.textContent).toContain('gross sales: the audit shows 13000 and the ledger shows 13100')
  })

  it('shows an uncounted day as uncounted instead of showing a difference of nothing', async () => {
    const harness = await mountScreen({
      getDayAudit: vi.fn(async () => report({
        findings: [],
        flags: [],
        cashTie: { ...report().cashTie, counted: false, countedCashMinor: null, differenceMinor: null, differs: false, closedByName: '', closedAt: '' },
      })),
    })
    expect(harness.text()).toContain('This day has not been counted yet.')
    // A figure that does not exist yet is a dash, never a zero: ₦0.00 counted would read as a drawer found empty.
    expect(harness.text()).toContain('—')
    expect(harness.text()).not.toContain('Counted in the drawer₦0.00')
  })
})

describe('a sign-off is shown as the attestation it is', () => {
  it('shows the verdict, who signed it and when', async () => {
    const harness = await mountScreen({
      getDayAudit: vi.fn(async () => report({
        canSignOff: false,
        signOff: signOff({ outcome: 'AUDITED', note: 'Counted with the Account present.' }),
      })),
    })
    const verdict = harness.container.querySelector('.audit-verdict--signed')
    expect(verdict, 'a day that still reads as signed is styled as signed').toBeDefined()
    expect(verdict!.textContent).toContain('Audited')
    expect(verdict!.textContent).toContain('Sam Supervisor')
    expect(verdict!.textContent).toContain('Counted with the Account present.')
    expect(harness.container.querySelector('.audit-verdict-warning')).toBeNull()
  })

  it('warns when the day has moved since, and offers no way to dismiss the warning', async () => {
    const harness = await mountScreen({
      getDayAudit: vi.fn(async () => report({
        // The digest no longer matches: something about the day changed after somebody attested to it.
        signOff: signOff({ outcome: 'AUDITED_WITH_ISSUES', digestMatches: false }),
      })),
    })
    const warning = harness.container.querySelector('.audit-verdict-warning')
    expect(warning).toBeDefined()
    expect(warning!.textContent).toContain('This day has moved since it was signed off')
    expect(harness.container.querySelector('.audit-verdict--moved')).toBeDefined()
    // Not suppressible: no control anywhere inside the verdict can close, hide or acknowledge the warning. A warning
    // that can be clicked away is a warning that will be, and then the screen shows a clean verdict over a moved day.
    const verdict = harness.container.querySelector('.audit-verdict')!
    expect(verdict.querySelectorAll('button')).toHaveLength(0)
    expect(verdict.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    expect(harness.text()).toContain('Audited with issues')
  })

  it('sends the verdict and the note the signer wrote, and caps the note where the Server caps it', async () => {
    const harness = await mountScreen()
    const block = harness.container.querySelector('.audit-block--signoff')
    expect(block, 'the sign-off block is on the screen').toBeDefined()
    // Exactly the two verdicts the brief gives a Supervisor, as radio buttons rather than a free-text field: a verdict
    // that somebody types is a verdict nobody can query.
    const radios = [...block!.querySelectorAll('input[name="audit-outcome"]')] as HTMLInputElement[]
    expect(radios).toHaveLength(2)
    expect(radios.filter((radio) => radio.checked)).toHaveLength(1)
    expect(block!.textContent).toContain('Audited — the day is as it should be')
    expect(block!.textContent).toContain('Audited with issues — something needs following up')

    const note = block!.querySelector('textarea') as HTMLTextAreaElement
    expect(note, 'the sign-off form asks for a note').toBeDefined()
    // The same ceiling the service enforces, so the screen cannot accept 4 000 characters and then be refused.
    expect(note.maxLength).toBe(2000)
    // This day has findings, so a clean verdict has to explain itself, and the screen says that before the Server does.
    expect(block!.textContent).toContain('Note (required — this day has findings)')

    const form = note.closest('form') as HTMLFormElement
    await act(async () => { setFieldText(note, 'Counted twice, with the Account present.') })
    // A radio answers to a click, which is what sets `checked` and fires React's onChange; assigning `.checked` in a
    // test does neither.
    await act(async () => { radios[1]!.click() })
    expect(radios[1]!.checked, 'the second verdict is the one now chosen').toBe(true)
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(harness.bridge.signOffAuditDay).toHaveBeenCalledWith(expect.objectContaining({
      businessDate: TODAY, accountId: null, outcome: 'AUDITED_WITH_ISSUES',
      note: 'Counted twice, with the Account present.',
    }))
    // The screen re-reads the day after writing, so it never shows a figure it has just made stale.
    expect(harness.bridge.getDayAudit).toHaveBeenCalledTimes(2)
  })
})

describe('a flag keeps every word anybody added to it', () => {
  it('renders an append-only note verbatim, stamps and line breaks included', async () => {
    const stamped = 'The drawer was short by ₦84.00\n[Sam Supervisor · 2026-11-17T19:05:00.000Z] Counted twice.\n[Ada Admin · 2026-11-17T19:20:00.000Z] Recounted, still short.'
    const harness = await mountScreen({
      getDayAudit: vi.fn(async () => report({ flags: [flag({ detail: stamped })] })),
    })
    // A `pre`, not a paragraph: the stamps are the evidence that the note grew rather than changed, and collapsing the
    // line breaks would make three entries read as one sentence somebody wrote in a hurry.
    const pre = [...harness.container.querySelectorAll('pre')].find((node) => node.textContent?.includes('Counted twice.'))
    expect(pre, 'the flag detail is preserved whitespace').toBeDefined()
    expect(pre!.textContent).toBe(stamped)
    expect(pre!.textContent!.split('\n')).toHaveLength(3)
  })

  it('separates the flags still open from the ones somebody resolved', async () => {
    const harness = await mountScreen({
      getDayAudit: vi.fn(async () => report({
        flags: [
          flag({ id: 'flag-open', detail: 'Still open' }),
          flag({
            id: 'flag-closed', detail: 'Was open', severity: 'NOTE', resolvedAt: '2026-11-17T19:45:00.000Z',
            resolvedByName: 'Sam Supervisor', resolutionNote: 'Recounted and found the missing ₦84.00 in the safe.',
          }),
        ],
      })),
    })
    expect(harness.text()).toContain('Still open')
    expect(harness.text()).toContain('Was open')
    expect(harness.text()).toContain('Recounted and found the missing ₦84.00 in the safe.')
    // A resolved flag is shown, not removed: closing a concern is part of the day's history.
    expect(harness.container.querySelector('.audit-badge--resolved')).toBeDefined()
  })
})

describe('the days that need a look are the way in', () => {
  it('lists an unaudited day with what happened on it, and reads that day when it is chosen', async () => {
    const harness = await mountScreen({
      listUnauditedDays: vi.fn(async () => [
        unauditedDay(),
        unauditedDay({ businessDate: '2026-11-15', accountId: 'a1', accountName: 'Amaka Account', transactions: 4, salesMinor: 255_000n, dayClosed: false, openFlags: 0 }),
      ]),
    })
    expect(harness.text()).toContain('2026-11-16')
    expect(harness.text()).toContain('18 sales')
    expect(harness.text()).toContain('₦4,123.00')
    expect(harness.text()).toContain('1 open flag')
    // The second day has not been counted, and says so rather than looking ready.
    expect(harness.text()).toContain('not counted yet')

    click(harness, /2026-11-15/u)
    expect(harness.bridge.getDayAudit).toHaveBeenLastCalledWith({ businessDate: '2026-11-15', accountId: 'a1' })
  })

  it('says when nothing is outstanding, which is a different thing from a list that failed to load', async () => {
    const harness = await mountScreen({ listUnauditedDays: vi.fn(async () => []) })
    expect(harness.text()).toContain('Nothing outstanding. Every day with activity has been audited.')
    expect(harness.container.querySelector('.audit-day-list')).toBeNull()
  })
})
