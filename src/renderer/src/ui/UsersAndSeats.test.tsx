// @vitest-environment jsdom
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InfoflexBridge } from '@shared/bridge'
import type { PublicUser } from '@shared/auth/types'
import type { TeamSnapshot } from '../../../services/team-service'
import { UsersAndSeats } from './UsersAndSeats'

/**
 * The Users and Seats screen, mounted into a real DOM.
 *
 * The service rules are tested where they live, in `team-service.test.ts`. What this file adds is the half those tests
 * cannot see: that the screen *shows* the state the service reports and *asks* for the change it claims to make. A seat
 * that needs a password has to say so; the "Add one" button has to be dead at the licence cap; the limits modal has to
 * send basis points when the customer typed a percentage. Each of those is a way to be correct in the service and wrong
 * on the screen, and the customer only ever meets the screen.
 */

const LIMITS = { allowWholesale: true, maxDiscountBasisPoints: 0, allowCreditSales: false, returnLimitMinor: 0n }

const ADMIN: PublicUser = {
  id: 'admin-1', fullName: 'Ada Admin', username: 'ada', role: 'ADMIN', isActive: true, isLocked: false, permissions: LIMITS,
}

type SeatShape = TeamSnapshot['seats'][number]

/** A seat as the service reports one. Overrides are typed so a misspelled field fails here, not silently. */
function seat(overrides: Partial<SeatShape> = {}): SeatShape {
  return {
    id: 'seat-1', seatNo: 1, role: 'ACCOUNT', fullName: 'Unassigned seat', username: 'account1',
    needsPassword: true, isActive: false, isLocked: false, lastLoginAt: null, lastPc: null, permissions: LIMITS,
    ...overrides,
  }
}

function snapshot(overrides: Partial<TeamSnapshot> = {}): TeamSnapshot {
  return {
    seats: [seat({})],
    counts: [
      { role: 'ACCOUNT', seats: 1, activeAccounts: 0, licenceCap: 2 },
      { role: 'USER', seats: 0, activeAccounts: 0, licenceCap: null },
      { role: 'SUPERVISOR', seats: 0, activeAccounts: 0, licenceCap: 0 },
    ],
    supervisorSeesCost: false,
    singleLoginPerAccount: true,
    allowAdminOnClients: false,
    orderExpiryMinutes: 120,
    ...overrides,
  }
}

const SUMMARY = [
  { role: 'ACCOUNT' as const, summary: 'Sells, takes payment, processes returns, closes the day and reads reports.' },
  { role: 'USER' as const, summary: 'Picks goods and follows the orders given to them. Cannot take payment.' },
  { role: 'SUPERVISOR' as const, summary: 'Reads the audit trail and stock levels. Cannot change money or stock.' },
]

let container: HTMLDivElement
const roots: Array<{ unmount: () => void }> = []

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

async function mount(element: React.ReactElement): Promise<void> {
  const root = createRoot(container)
  roots.push(root)
  await act(async () => { root.render(element) })
}

function bridge(state: TeamSnapshot, overrides: Partial<InfoflexBridge> = {}): InfoflexBridge {
  return {
    getTeamSnapshot: async () => state,
    getRoleSummary: async () => SUMMARY,
    setSeatCount: vi.fn(async () => undefined),
    renameSeat: vi.fn(async () => undefined),
    setSeatPassword: vi.fn(async () => undefined),
    setSeatActive: vi.fn(async () => undefined),
    setSeatPermissions: vi.fn(async () => undefined),
    updateTeamSettings: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as InfoflexBridge
}

const buttons = (label: RegExp): HTMLButtonElement[] =>
  [...container.querySelectorAll('button')].filter((candidate) => label.test(candidate.textContent ?? '')) as HTMLButtonElement[]

/**
 * Write to a *controlled* React input the way React can see it.
 *
 * Assigning `.value` directly is not enough: React tracks the value it last rendered and treats an assignment that
 * matches its own record as no change, so `onChange` never fires and the test fails while the screen is fine. Going
 * through the prototype's native setter defeats that tracking, which is the standard way to drive a controlled input
 * from a test. (The limits modal needs none of this — its fields are uncontrolled and read from FormData on submit.)
 */
function setInputValue(field: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('no native value setter')
  setter.call(field, value)
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

/** The input inside the <label> whose text matches — the way these fields are actually marked up. */
function labelledInput(label: RegExp): HTMLInputElement {
  const wrapper = [...container.querySelectorAll('label')].find((candidate) => label.test(candidate.textContent ?? ''))
  const field = wrapper?.querySelector('input')
  if (!field) throw new Error(`no input labelled ${label}`)
  return field as HTMLInputElement
}

async function mountWith(state: TeamSnapshot, overrides: Partial<InfoflexBridge> = {}) {
  const stub = bridge(state, overrides)
  await mount(<UsersAndSeats bridge={stub} currentUser={ADMIN} />)
  return stub
}

describe('the seat table shows the state the service reports', () => {
  it('marks a seat that cannot sign in, and says why', async () => {
    await mountWith(snapshot())
    expect(container.textContent).toContain('Needs password')
    // The explanation is on the screen, not only in the docs: an Admin who does not know this will hand out a username
    // and wonder why nobody can sign in with it.
    expect(container.textContent).toMatch(/cannot sign in/u)
  })

  it('shows an active seat as Active, and a locked one as Locked as well', async () => {
    await mountWith(snapshot({
      seats: [
        seat({ id: 'a', fullName: 'Ready Person', isActive: true, needsPassword: false, lastLoginAt: '2026-11-17T08:00:00.000Z' }),
        seat({ id: 'b', seatNo: 2, fullName: 'Locked Person', username: 'account2', isActive: true, needsPassword: false, isLocked: true }),
      ],
    }))
    expect(container.textContent).toContain('Active')
    expect(container.textContent).toContain('Locked')
  })

  it('shows the PC the person last signed in from, and nothing when there is none', async () => {
    await mountWith(snapshot({
      seats: [
        seat({ id: 'a', isActive: true, needsPassword: false, lastPc: 'TILL-FRONT' }),
        seat({ id: 'b', seatNo: 2, username: 'account2', lastPc: null }),
      ],
    }))
    expect(container.textContent).toContain('TILL-FRONT')
  })

  it('offers Deactivate on an active seat and Activate on an inactive one, and calls the host', async () => {
    const stub = await mountWith(snapshot({
      seats: [seat({ id: 'a', isActive: true, needsPassword: false }), seat({ id: 'b', seatNo: 2, username: 'account2', isActive: false })],
    }))
    expect(buttons(/Deactivate/u)).toHaveLength(1)
    expect(buttons(/Activate/u)).toHaveLength(1)

    await act(async () => { buttons(/Deactivate/u)[0]!.click() })
    expect(stub.setSeatActive).toHaveBeenCalledWith('a', false)
  })

  it('does not offer to deactivate the Admin row, because there must always be one', async () => {
    await mountWith(snapshot({
      seats: [seat({ id: 'admin-1', seatNo: null, role: 'ADMIN', fullName: 'Ada Admin', username: 'ada', isActive: true, needsPassword: false })],
    }))
    expect(buttons(/Deactivate/u)).toHaveLength(0)
  })
})

describe('the seat counts obey the licence on the screen, not only in the service', () => {
  it('disables Add one at the licence cap', async () => {
    await mountWith(snapshot({
      counts: [
        { role: 'ACCOUNT', seats: 2, activeAccounts: 0, licenceCap: 2 },
        { role: 'USER', seats: 0, activeAccounts: 0, licenceCap: null },
        { role: 'SUPERVISOR', seats: 0, activeAccounts: 0, licenceCap: 0 },
      ],
    }))
    const adds = buttons(/Add one/u)
    // ACCOUNT is at its cap of 2 and SUPERVISOR has a cap of 0; USER has no cap, so its button stays live.
    expect(adds[0]!.disabled, 'ACCOUNT at cap').toBe(true)
    expect(adds[2]!.disabled, 'SUPERVISOR capped at zero').toBe(true)
    expect(adds[1]!.disabled, 'USER uncapped').toBe(false)
  })

  it('disables Remove one when every seat is held by an active account', async () => {
    await mountWith(snapshot({
      counts: [{ role: 'ACCOUNT', seats: 1, activeAccounts: 1, licenceCap: 5 },
        { role: 'USER', seats: 0, activeAccounts: 0, licenceCap: null },
        { role: 'SUPERVISOR', seats: 0, activeAccounts: 0, licenceCap: 0 }],
    }))
    expect(buttons(/Remove one/u)[0]!.disabled).toBe(true)
  })

  it('shows the licence cap beside the count, so the refusal is never a surprise', async () => {
    await mountWith(snapshot())
    expect(container.textContent).toMatch(/licence allows 2/u)
  })

  it('asks the host to change the count by one', async () => {
    const stub = await mountWith(snapshot())
    await act(async () => { buttons(/Add one/u)[0]!.click() })
    expect(stub.setSeatCount).toHaveBeenCalledWith({ role: 'ACCOUNT', seats: 2 })
  })
})

describe('the limits modal converts what the customer typed into what the schema stores', () => {
  it('sends basis points for a percentage, and a bigint for the return limit', async () => {
    const stub = await mountWith(snapshot({
      seats: [seat({ id: 'a', isActive: true, needsPassword: false, permissions: {
        allowWholesale: false, maxDiscountBasisPoints: 0, allowCreditSales: false, returnLimitMinor: 0n,
      } })],
    }))

    await act(async () => { buttons(/^Limits$/u)[0]!.click() })
    expect(container.textContent).toMatch(/Maximum discount/u)

    // The field is labelled in percent because that is how a shopkeeper thinks; the column stores hundredths of a
    // percent. The conversion has to happen exactly once, here, and this pins it.
    const discount = [...container.querySelectorAll('input')].find((candidate) => candidate.name === 'maxDiscount') as HTMLInputElement
    const limit = [...container.querySelectorAll('input')].find((candidate) => candidate.name === 'returnLimit') as HTMLInputElement
    const wholesale = [...container.querySelectorAll('input')].find((candidate) => candidate.name === 'allowWholesale') as HTMLInputElement
    await act(async () => {
      discount.value = '12.5'
      discount.dispatchEvent(new Event('input', { bubbles: true }))
      limit.value = '500000'
      limit.dispatchEvent(new Event('input', { bubbles: true }))
      wholesale.click()
    })
    await act(async () => {
      const form = container.querySelector('form.modal') as HTMLFormElement
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(stub.setSeatPermissions).toHaveBeenCalledWith('a', {
      allowWholesale: true,
      maxDiscountBasisPoints: 1250,
      allowCreditSales: false,
      returnLimitMinor: 500_000n,
    })
  })

  it('comes back showing the stored limits, so the Admin can see what is already set', async () => {
    await mountWith(snapshot({
      seats: [seat({ id: 'a', isActive: true, needsPassword: false, permissions: {
        allowWholesale: true, maxDiscountBasisPoints: 725, allowCreditSales: true, returnLimitMinor: 900n,
      } })],
    }))
    await act(async () => { buttons(/^Limits$/u)[0]!.click() })
    const discount = [...container.querySelectorAll('input')].find((candidate) => candidate.name === 'maxDiscount') as HTMLInputElement
    const credit = [...container.querySelectorAll('input')].find((candidate) => candidate.name === 'allowCreditSales') as HTMLInputElement
    expect(discount.value, '725 basis points reads as 7.25%').toBe('7.25')
    expect(credit.checked).toBe(true)
  })

  it('says plainly that a limit narrows a role rather than adding to it', async () => {
    await mountWith(snapshot())
    await act(async () => { buttons(/^Limits$/u)[0]!.click() })
    // The sentence that stops an Admin believing they have just given a USER the till.
    expect(container.textContent).toMatch(/never add a permission the role does not have/u)
  })
})

describe('the shop-wide rules are shown as the shop set them', () => {
  it('reflects the settings and writes back through the host', async () => {
    const stub = await mountWith(snapshot({ supervisorSeesCost: false, singleLoginPerAccount: true, allowAdminOnClients: false, orderExpiryMinutes: 120 }))
    const toggles = [...container.querySelectorAll('.toggle input[type="checkbox"]')] as HTMLInputElement[]
    expect(toggles).toHaveLength(3)
    expect(toggles[0]!.checked, 'supervisor cost off by default').toBe(false)
    expect(toggles[1]!.checked, 'one login per account on by default').toBe(true)
    expect(toggles[2]!.checked, 'Admin on clients off by default').toBe(false)

    await act(async () => { toggles[0]!.click() })
    expect(stub.updateTeamSettings).toHaveBeenCalledWith({ supervisorSeesCost: true })
  })

  it('shows the order expiry in minutes and writes the number back', async () => {
    const stub = await mountWith(snapshot({ orderExpiryMinutes: 90 }))
    // Found by its label rather than by position, because "the last number input on the page" stops being this field the
    // moment a modal opens or a column is added.
    const expiry = labelledInput(/expire after/u)
    expect(expiry.value).toBe('90')
    // React's onChange is the DOM `input` event, not `change`; dispatching `change` silently does nothing.
    await act(async () => { setInputValue(expiry, '45') })
    expect(stub.updateTeamSettings).toHaveBeenCalledWith({ orderExpiryMinutes: 45 })
  })
})

describe('the role summary is read-only', () => {
  it('lists all three roles with what each may do, and offers no control to change it', async () => {
    await mountWith(snapshot())
    const summary = container.querySelector('.role-summary')!
    expect(summary).not.toBeNull()
    expect(summary.textContent).toContain('Sells, takes payment')
    expect(summary.textContent).toContain('Cannot take payment')
    expect(summary.textContent).toContain('Cannot change money or stock')
    // Fixed means fixed: the brief makes these the rules the server enforces, not a preference the Admin can tune. An
    // input here would be a control that either did nothing or quietly disagreed with the policy table.
    expect(summary.querySelectorAll('input, select, button')).toHaveLength(0)
    expect(container.textContent).toMatch(/the rules the server enforces, not a preference/u)
  })
})

describe('a failure is shown rather than swallowed', () => {
  it('puts the refusal on screen when the host refuses a seat count', async () => {
    await mountWith(snapshot(), {
      setSeatCount: vi.fn(async () => { throw new Error('This licence allows 2 Account accounts. Choose 2 or fewer.') }),
    })
    await act(async () => { buttons(/Add one/u)[0]!.click() })
    // The customer typed nothing wrong; the licence stopped them. The message has to reach them or they will click again.
    expect(container.textContent).toMatch(/licence allows 2 Account accounts/u)
    expect(container.querySelector('.form-error')).not.toBeNull()
  })

  it('confirms a change that worked, so a save is not silent', async () => {
    await mountWith(snapshot())
    await act(async () => { buttons(/Add one/u)[0]!.click() })
    expect(container.querySelector('.form-status')).not.toBeNull()
  })
})
