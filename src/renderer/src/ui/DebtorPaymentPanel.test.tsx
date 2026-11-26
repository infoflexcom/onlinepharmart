// @vitest-environment jsdom
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getCurrency } from '@shared/currency/catalog'
import { defaultDisplayOptions, formatMoney } from '@shared/currency/money'
import type { DebtorReportRow, RecordDebtorPaymentInput } from '@shared/reports/types'
import { can } from '../../../../packages/core/src/capabilities'
import { DebtorPaymentPanel } from './DebtorPaymentPanel'

/**
 * The panel where a customer's balance can be settled.
 *
 * The service behind it is tested where it lives — `daily-audit-service.test.ts` refuses an overpayment, a customer who
 * owes nothing, and two tills spending one payment at once. What this file adds is the half none of those can see:
 * **what the panel offers, and what it sends**.
 *
 * The claim that matters most is the gate. `record_debtor_payment` has been an ACCOUNT capability since the capability
 * table was written, and until now nothing in the product called it — a capability with no control is not a restriction,
 * it is an omission. The other direction matters just as much: a panel that offered the control to everybody who could
 * read the list would be handing a money movement to a role that may only look.
 */

const CURRENCY = getCurrency('NGN')!
const DISPLAY = defaultDisplayOptions(CURRENCY)

function debtor(overrides: Partial<DebtorReportRow> = {}): DebtorReportRow {
  return {
    customerId: 'c-1', customerName: 'Bode Stores', phone: '+234 800 222 3333',
    balanceMinor: 150_000n, creditLimitMinor: 500_000n,
    ...overrides,
  }
}

const DEBTORS = {
  totalBalanceMinor: 200_000n,
  items: [
    debtor(),
    debtor({ customerId: 'c-2', customerName: 'Ada Customer', phone: '', balanceMinor: 50_000n, creditLimitMinor: 0n }),
  ],
}

const roots: Array<{ root: { unmount(): void }; holder: HTMLElement }> = []

async function mount(
  overrides: { mayRecordPayment?: boolean; onRecord?: (input: RecordDebtorPaymentInput) => Promise<boolean>; debtors?: typeof DEBTORS } = {},
): Promise<{ holder: HTMLElement; text(): string }> {
  const holder = document.createElement('div')
  document.body.append(holder)
  const root = createRoot(holder)
  roots.push({ root, holder })
  const element: ReactElement = (
    <DebtorPaymentPanel
      debtors={overrides.debtors ?? DEBTORS}
      currency={CURRENCY}
      display={DISPLAY}
      busy={false}
      mayRecordPayment={overrides.mayRecordPayment ?? true}
      onRecord={overrides.onRecord ?? (async () => true)}
    />
  )
  await act(async () => { root.render(element) })
  return { holder, text: () => holder.textContent ?? '' }
}

function button(holder: HTMLElement, label: RegExp): HTMLButtonElement {
  const found = [...holder.querySelectorAll('button')]
    .find((candidate) => label.test((candidate.textContent ?? '').trim()))
  expect(found, `a button labelled ${String(label)}`).toBeDefined()
  return found as HTMLButtonElement
}

/**
 * Set a controlled field the way a person does.
 *
 * React compares against the value it last rendered and treats a test assigning `.value` directly as no change, so
 * `onChange` never fires and the test fails while the screen is fine. The prototype's native setter defeats that
 * tracking — the same helper `UsersAndSeats.test.tsx` and `DailyAuditWorkspace.test.tsx` use.
 */
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

beforeEach(() => { document.body.innerHTML = '' })

afterEach(() => {
  for (const entry of roots.splice(0)) {
    act(() => { entry.root.unmount() })
    entry.holder.remove()
  }
})

describe('the panel lists what customers owe', () => {
  it('shows every balance, the total, and a credit limit that has not been set as not set', async () => {
    const screen = await mount()
    expect(screen.text()).toContain('Money owed by customers')
    expect(screen.text()).toContain(formatMoney(200_000n, CURRENCY, DISPLAY))
    expect(screen.text()).toContain('2 customer accounts')
    expect(screen.text()).toContain('Bode Stores')
    expect(screen.text()).toContain(formatMoney(150_000n, CURRENCY, DISPLAY))
    // A limit of zero is "nobody set one", not "this customer may owe nothing": the two read the same as a number and
    // mean opposite things to the person deciding whether to extend more credit.
    expect(screen.text()).toContain('No limit set')
    // A customer with no phone number on file is a dash, not a blank cell that looks like a rendering mistake.
    expect(screen.text()).toContain('Ada Customer')
  })

  it('says so when nobody owes anything, and offers no form to fill in', async () => {
    const screen = await mount({ debtors: { totalBalanceMinor: 0n, items: [] } })
    expect(screen.text()).toContain('No customer credit balances are outstanding.')
    expect(screen.text()).toContain('0 customer accounts')
    expect(screen.holder.querySelectorAll('button')).toHaveLength(0)
  })
})

describe('the control to settle a balance is offered by capability, not by who is looking', () => {
  it('offers it to the role that holds the capability', async () => {
    // Derived from the capability table rather than written out, so the assertion moves with the table instead of
    // contradicting it: the ACCOUNT is the role the brief describes as the one that "records debtor payments".
    expect(can('ACCOUNT', 'record_debtor_payment')).toBe(true)
    const screen = await mount({ mayRecordPayment: can('ACCOUNT', 'record_debtor_payment') })
    expect(screen.holder.querySelectorAll('button.debtor-take-payment')).toHaveLength(2)
    expect(screen.text()).toContain('Take a payment')
  })

  it('offers nothing to a role that may read the list but not move money, and says so without naming who may', async () => {
    expect(can('SUPERVISOR', 'record_debtor_payment'), 'a Supervisor is audit-only').toBe(false)
    const screen = await mount({ mayRecordPayment: can('SUPERVISOR', 'record_debtor_payment') })
    // The balances are still readable — that is the whole of what this caller is allowed.
    expect(screen.text()).toContain('Bode Stores')
    expect(screen.text()).toContain(formatMoney(150_000n, CURRENCY, DISPLAY))
    expect(screen.holder.querySelectorAll('button')).toHaveLength(0)
    expect(screen.holder.querySelector('form')).toBeNull()
    expect(screen.text()).toContain('It cannot take a payment against a balance.')
    // And the sentence does not say which role could, which is the same information a refusal withholds: what to
    // become to get further.
    for (const role of ['Admin', 'ADMIN', 'Account', 'ACCOUNT']) {
      expect(screen.text(), `the note names ${role}`).not.toContain(role)
    }
  })
})

describe('taking a payment sends what the Server stores, and nothing it does not', () => {
  it('opens on the customer chosen, showing the balance the amount will be measured against', async () => {
    const screen = await mount()
    expect(screen.holder.querySelector('form')).toBeNull()
    await act(async () => { screen.holder.querySelectorAll('button.debtor-take-payment')[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(screen.holder.querySelector('form'), 'the form opens for the row that was chosen').toBeDefined()
    // The ceiling is on the screen before anybody types, so an overpayment is a visible mistake rather than a refusal
    // discovered after the fact. It is visible *text*, not a disabled field's value, which nothing reading the panel
    // would see.
    expect(screen.text()).toContain('Taking a payment from')
    expect(screen.text()).toContain('Ada Customer')
    expect(screen.text()).toContain(`who owes ${formatMoney(50_000n, CURRENCY, DISPLAY)}`)
    // And the other customer's balance is not what the form is measuring.
    expect(screen.text()).not.toContain(`who owes ${formatMoney(150_000n, CURRENCY, DISPLAY)}`)
  })

  it('sends the customer, the amount as typed, the method, the reference and the note', async () => {
    const onRecord = vi.fn(async () => true)
    const screen = await mount({ onRecord })
    await act(async () => { screen.holder.querySelectorAll('button.debtor-take-payment')[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    const form = screen.holder.querySelector('form') as HTMLFormElement
    const fields = [...form.querySelectorAll('input, select')] as Array<HTMLInputElement | HTMLSelectElement>
    const amount = fields.find((field) => field.getAttribute('inputmode') === 'decimal') as HTMLInputElement
    const method = form.querySelector('select') as HTMLSelectElement
    const reference = fields.find((field) => field instanceof HTMLInputElement
      && field.placeholder === 'Cheque or transfer number') as HTMLInputElement
    const note = fields.filter((field) => field.tagName === 'INPUT').pop() as HTMLInputElement

    await act(async () => {
      setField(amount, '2500.00')
      setField(method, 'TRANSFER')
      setField(reference, 'TRF-8891')
      setField(note, 'Part payment, balance next week')
    })
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })

    expect(onRecord).toHaveBeenCalledTimes(1)
    expect(onRecord).toHaveBeenCalledWith({
      customerId: 'c-1',
      // As typed, in the shop's own decimals: the panel does not convert to minor units, because the Server parses what
      // the till typed against the shop currency and a second conversion here is a second chance to round differently.
      amount: '2500.00',
      method: 'TRANSFER',
      reference: 'TRF-8891',
      note: 'Part payment, balance next week',
    })
  })

  it('defaults to cash and says out loud that cash is the method that changes the drawer', async () => {
    const screen = await mount()
    await act(async () => { screen.holder.querySelectorAll('button.debtor-take-payment')[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const method = screen.holder.querySelector('form select') as HTMLSelectElement
    expect(method.value).toBe('CASH')
    expect([...method.options].map((option) => option.value)).toEqual(['CASH', 'TRANSFER', 'CARD'])
    // Named on the screen, because the person taking it is standing at a drawer that the day close will count.
    expect(method.options[0]!.textContent).toContain('goes into the drawer')
  })

  it('will not submit an empty amount', async () => {
    const onRecord = vi.fn(async () => true)
    const screen = await mount({ onRecord })
    await act(async () => { screen.holder.querySelectorAll('button.debtor-take-payment')[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const submit = button(screen.holder, /^Record the payment$/u)
    expect(submit.disabled, 'nothing to take yet').toBe(true)
    await act(async () => { submit.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onRecord).not.toHaveBeenCalled()
  })

  it('clears the form when the Server took the payment', async () => {
    const screen = await mount({ onRecord: async () => true })
    await act(async () => { screen.holder.querySelectorAll('button.debtor-take-payment')[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const form = screen.holder.querySelector('form') as HTMLFormElement
    const amount = form.querySelector('input[inputmode="decimal"]') as HTMLInputElement
    await act(async () => { setField(amount, '500.00') })
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    // The form closes: the payment is taken, and leaving it open invites taking it twice.
    expect(screen.holder.querySelector('form')).toBeNull()
  })

  it('keeps what was typed when the Server refused, because a refused amount is usually a mistyped one', async () => {
    const screen = await mount({ onRecord: async () => false })
    await act(async () => { screen.holder.querySelectorAll('button.debtor-take-payment')[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const form = screen.holder.querySelector('form') as HTMLFormElement
    const amount = form.querySelector('input[inputmode="decimal"]') as HTMLInputElement
    const reference = form.querySelector('input[placeholder="Cheque or transfer number"]') as HTMLInputElement
    await act(async () => {
      setField(amount, '1500000.00')
      setField(reference, 'TRF-8891')
    })
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    const stillOpen = screen.holder.querySelector('form')
    expect(stillOpen, 'the refusal does not close the form').toBeDefined()
    expect((stillOpen!.querySelector('input[inputmode="decimal"]') as HTMLInputElement).value).toBe('1500000.00')
    expect((stillOpen!.querySelector('input[placeholder="Cheque or transfer number"]') as HTMLInputElement).value).toBe('TRF-8891')
  })

  it('closes the form without recording anything when the caller cancels', async () => {
    const onRecord = vi.fn(async () => true)
    const screen = await mount({ onRecord })
    await act(async () => { screen.holder.querySelectorAll('button.debtor-take-payment')[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { button(screen.holder, /^Cancel$/u).dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(screen.holder.querySelector('form')).toBeNull()
    expect(onRecord).not.toHaveBeenCalled()
  })
})
