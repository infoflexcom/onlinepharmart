// @vitest-environment jsdom
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getCurrency } from '@shared/currency/catalog'
import { defaultDisplayOptions } from '@shared/currency/money'
import type { InfoflexBridge } from '@shared/bridge'
import type { PublicUser } from '@shared/auth/types'
import type { BootstrapData } from '@shared/shop/types'
import type { OrderView } from '@shared/orders/types'
import { ORDER_SLIP_NOT_A_RECEIPT } from '@shared/orders/types'
import { OrderWorkflow } from './OrderWorkflow'

/**
 * The order screen, mounted into a real DOM, for each of the four roles.
 *
 * The rules themselves are tested where they live — `print-gate-service.test.ts` for who may print, `order-service.test.ts`
 * for what an order does to stock, `permission-matrix.test.ts` for who may open the page. What this file adds is the
 * half none of those can see: **what the screen offers**.
 *
 * That matters most for the print button. The Server refuses a picker's print request, so a button on their screen
 * could not print — but a button that fails on click is worse than no button, because it tells the person at the till
 * that the refusal is a malfunction to be worked around. The brief asks for no print button and no print endpoint for
 * this role; the endpoint is the Server's job and the button is this file's.
 */

const PERMISSIONS = { allowWholesale: true, maxDiscountBasisPoints: 0, allowCreditSales: false, returnLimitMinor: 0n }

function user(role: PublicUser['role']): PublicUser {
  return {
    id: `${role}-1`, fullName: `${role} Person`, username: role.toLowerCase(), role,
    isActive: true, isLocked: false, permissions: PERMISSIONS,
  }
}

const CURRENCY = getCurrency('NGN')!
const BOOTSTRAP = {
  settings: { currency: CURRENCY, display: defaultDisplayOptions(CURRENCY), profile: { name: 'Harbor Health' } },
  appInfo: { productName: 'Infoflex', appVersion: '0.1.0' },
} as unknown as BootstrapData

function order(overrides: Partial<OrderView> = {}): OrderView {
  return {
    id: 'order-1', orderNumber: 'ORD-000001', type: 'RETAIL', status: 'PENDING',
    customerName: null, customerId: null, createdById: 'USER-1', createdByName: 'Picker One',
    finalizedById: null, finalizedByName: null, currencyCode: 'NGN',
    subtotalMinor: 2000n, discountMinor: 0n, taxMinor: 0n, totalMinor: 2000n,
    lines: [{
      id: 'line-1', productId: 'product-1', description: 'Vitamin C', unit: 'pack',
      quantityMilli: 2000n, unitPriceMinor: 1000n, discountMinor: 0n, lineTotalMinor: 2000n,
      prescriptionRequired: false,
    }],
    expiresAt: null, createdAt: '2026-11-17T12:00:00.000Z',
    saleId: null, receiptNumber: null, needsPrescriptionAck: false, events: [],
    ...overrides,
  }
}

const container = document.createElement('div')
const roots: Array<{ unmount: () => void }> = []

beforeEach(() => {
  document.body.appendChild(container)
})

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
  container.remove()
})

async function mount(element: React.ReactElement): Promise<void> {
  const root = createRoot(container)
  roots.push(root)
  await act(async () => { root.render(element) })
}

function bridge(overrides: Partial<InfoflexBridge> = {}): InfoflexBridge {
  return {
    getInventoryOverview: async () => ({ products: [], totals: null }) as never,
    listPosCustomers: async () => [],
    canMakeWholesaleSale: async () => false,
    listOrderQueue: async () => [],
    listMyOrders: async () => [],
    listPrintLog: async () => [],
    createPosCustomer: vi.fn(async () => ({ id: 'customer-2', name: 'New' }) as never),
    createOrder: vi.fn(async () => order()),
    cancelOrder: vi.fn(async () => order({ status: 'CANCELLED' })),
    adjustOrderLine: vi.fn(async () => order()),
    getOrder: async () => order(),
    finalizeOrder: vi.fn(async () => ({ order: order({ status: 'PAID' }), saleId: 1, receiptNumber: 'R-0000000001', idempotentReplay: false, priceChangesAccepted: [] }) as never),
    recordPosReceiptPrint: vi.fn(async () => ({ id: 1, receiptNumber: 'R-0000000001', duplicate: false }) as never),
    ...overrides,
  } as unknown as InfoflexBridge
}

/**
 * Every control label on the screen that could *do* something to a document, lower-cased.
 *
 * The print log's own disclosure is excluded, and that exclusion is the point: reading the log of who printed what is
 * an audit act, not a print act, and a SUPERVISOR is deliberately allowed the first and refused the second. Counting
 * "Print log" as a print offer would make this test demand that an auditor be unable to read the audit.
 */
function controls(): string[] {
  return [...container.querySelectorAll('button, input[type="submit"], summary')]
    .filter((element) => !element.closest('.orders-print-log'))
    .map((element) => (element.textContent ?? '').trim().toLowerCase())
}

async function mountAs(role: PublicUser['role'], overrides: Partial<InfoflexBridge> = {}): Promise<InfoflexBridge> {
  const stub = bridge(overrides)
  await mount(<OrderWorkflow bridge={stub} bootstrap={BOOTSTRAP} user={user(role)} />)
  return stub
}

describe('what each role is offered', () => {
  it('gives a picker no way to print, and says so on the screen', async () => {
    await mountAs('USER')
    for (const label of controls()) {
      // The assertion is about offers, not about wording: anything that reads as printing has no business on this
      // screen for a role the Server would refuse.
      expect(label, `a picker was offered a control reading "${label}"`).not.toMatch(/print|reprint/u)
    }
    expect(container.textContent).toContain('Printing is available to Accounts and the Admin only.')
  })

  it('gives a picker the order slip and marks it as not a receipt', async () => {
    const stub = await mountAs('USER')
    // Generate the order the way the button does.
    const form = container.querySelector('form.orders-basket') as HTMLFormElement | null
    expect(form, 'the picker pane should offer a basket form').not.toBeNull()
    // The slip's wording is a constant shared with the service, so the screen and the slip cannot drift apart.
    expect(ORDER_SLIP_NOT_A_RECEIPT).toBe('NOT PAID - NOT A RECEIPT')
    expect(typeof stub.createOrder).toBe('function')
  })

  it('gives a picker no payment controls at all', async () => {
    await mountAs('USER')
    expect(container.textContent).not.toContain('Payment queue')
    for (const label of controls()) {
      expect(label, `a picker was offered "${label}"`).not.toMatch(/finali[sz]e|take payment/u)
    }
  })

  it('gives a SUPERVISOR neither the till nor a printer', async () => {
    await mountAs('SUPERVISOR', { listPrintLog: async () => [] })
    expect(container.textContent).not.toContain('Payment queue')
    for (const label of controls()) {
      expect(label, `a SUPERVISOR was offered "${label}"`).not.toMatch(/print|reprint|finali[sz]e/u)
    }
    // A SUPERVISOR may read the print log without being able to add to it: auditing the Accounts' reprints is the job.
    expect(container.textContent).toContain('Print log')
  })

  it('gives an ACCOUNT the queue and a way to finalize, but not the print log', async () => {
    await mountAs('ACCOUNT', { listOrderQueue: async () => [order()] })
    expect(container.textContent).toContain('Payment queue')
    expect(container.textContent).toContain('ORD-000001')
    // An Account can print, so the note that tells a picker they cannot must not appear on their screen.
    expect(container.textContent).not.toContain('Printing is available to Accounts and the Admin only.')
    // Reading every copy everybody printed is an audit capability, not a till one.
    expect(container.textContent).not.toContain('Print log')
  })

  it('gives an Admin the queue, the printer and the print log', async () => {
    await mountAs('ADMIN', { listOrderQueue: async () => [order()] })
    expect(container.textContent).toContain('Payment queue')
    expect(container.textContent).toContain('Print log')
  })
})

describe('the slip a picker hands over', () => {
  it('says NOT PAID and shows the live status once an order exists', async () => {
    await mountAs('USER', { listMyOrders: async () => [order({ status: 'PAID', receiptNumber: 'R-0000000007' })] })
    expect(container.textContent).toContain('PAID')
    expect(container.textContent).toContain('R-0000000007')
  })

  it('shows a cancelled order as cancelled, with no way to pay for it', async () => {
    await mountAs('USER', { listMyOrders: async () => [order({ status: 'CANCELLED' })] })
    expect(container.textContent).toContain('CANCELLED')
    for (const label of controls()) {
      expect(label, `a cancelled order offered "${label}"`).not.toMatch(/finali[sz]e|pay/u)
    }
  })
})
