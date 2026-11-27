// @vitest-environment jsdom
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getCurrency } from '@shared/currency/catalog'
import { defaultDisplayOptions, formatMoney } from '@shared/currency/money'
import { DEFAULT_OPERATIONAL_SETTINGS } from '@shared/shop/types'
import type { BootstrapData } from '@shared/shop/types'
import type { InfoflexBridge } from '@shared/bridge'
import type { PublicUser } from '@shared/auth/types'
import type { ProductRecord } from '@shared/inventory/types'
import type { InventoryOverview } from '@shared/inventory/types'
import type {
  HeldPosCartRecord,
  PosCustomerRecord,
  PosQuoteRecord,
  PosReceiptRecord,
  PosRecentSaleRecord,
} from '@shared/pos/types'
import { actorDiscountBasisPoints, resolveDiscountCap, shopDiscountLimit } from '../../../services/discount-cap'
import { can } from '../../../../packages/core/src/capabilities'
import { PosWorkspace, discountCeilingSentence } from './PosWorkspace'

/**
 * The till, mounted into a real DOM.
 *
 * The money rules are tested where they live — `point-of-sale-service.test.ts` for what a sale costs and who may make
 * one, `discount-cap.test.ts` for the ceiling itself, `permission-matrix.test.ts` for who may open the page. What this
 * file adds is the half none of those can see: **what the screen offers, what it tells the person standing at it, and
 * what it sends**.
 *
 * The till is where the two are most likely to disagree, because it is the one screen that both reads a permission and
 * re-states a money rule in words. A screen that offers a control the Server refuses teaches the cashier that the
 * refusal is a fault; a screen that hides one the Server allows is a feature nobody can find; and a screen that states a
 * ceiling it computed itself will eventually state a different one from the till that enforces it.
 *
 * Writing this file found the third case. The discount field used to be disabled by
 * `user.role === 'ADMIN' || user.permissions.maxDiscountBasisPoints > 0` — a boolean made out of a ceiling, with the
 * shop-wide ceiling from Settings missing from it entirely. A cashier whose limit the Admin set to 0 could not type a
 * discount and so could not ask, and the Server would have asked for them, because exceeding a ceiling raises an approval
 * rather than refusing. The screen now reads the ceiling from `discount-cap` — the module the till and the audit both
 * read — states it, and leaves what happens above it to the Server.
 */

const CURRENCY = getCurrency('NGN')!
const DISPLAY = defaultDisplayOptions(CURRENCY)

function bootstrap(discountLimitBasisPoints: number = DEFAULT_OPERATIONAL_SETTINGS.discountLimitBasisPoints): BootstrapData {
  return {
    settings: {
      profile: { name: 'Harbor Health', address: '12 Dock Road, Lagos', phone: '+234 1 555 0100' },
      currency: CURRENCY,
      display: DISPLAY,
      setupComplete: true,
      currencyConfirmed: true,
      currencyLocked: false,
      operational: { ...DEFAULT_OPERATIONAL_SETTINGS, discountLimitBasisPoints },
    },
    appInfo: { productName: 'Infoflex', appVersion: '0.1.0', runtime: 'desktop' },
    setupContext: { edition: 'BOTH' },
  } as unknown as BootstrapData
}

function permissions(overrides: Partial<PublicUser['permissions']> = {}): PublicUser['permissions'] {
  return {
    allowWholesale: false, maxDiscountBasisPoints: 0, allowCreditSales: false, returnLimitMinor: 0n,
    ...overrides,
  }
}

function user(role: PublicUser['role'], overrides: Partial<PublicUser['permissions']> = {}): PublicUser {
  return {
    id: `${role}-1`, fullName: `${role} Person`, username: role.toLowerCase(), role,
    isActive: true, isLocked: false, permissions: permissions(overrides),
  }
}

function product(overrides: Partial<ProductRecord> = {}): ProductRecord {
  return {
    id: 'p-1', sku: 'POS-001', name: 'Vitamin C 500mg', brand: 'Harbor', description: 'Supplement',
    barcode: '6151234567890', additionalBarcodes: [], category: 'Vitamins', subCategory: 'Supplements',
    department: 'Health', shelfLocation: 'A-01', unit: 'each', packSizeUnits: 1,
    costMinor: 10_000n, retailPriceMinor: 20_000n, wholesalePriceMinor: 18_000n,
    wholesaleMinimumQuantityMilli: 5_000n, reorderLevelMilli: 10_000n, quantityMilli: 40_000n, reservedMilli: 0n,
    rowVersion: 1, stockVersion: 1, genericName: 'Ascorbic acid', prescriptionRequired: false, weighedItem: false,
    pluCode: '', pricePerKgMinor: null, expiryTracking: false, isActive: true, variants: [],
    ...overrides,
  }
}

function overview(products: ProductRecord[] = [product()]): InventoryOverview {
  return { edition: 'BOTH', products, alerts: [], suppliers: [], categories: ['Vitamins'], departments: ['Health'] }
}

/** A quote for one unit at the retail price. The figures are the Server's; the screen only displays them. */
function quote(overrides: Partial<PosQuoteRecord> = {}): PosQuoteRecord {
  return {
    saleType: 'RETAIL', currencyCode: 'NGN',
    items: [{
      productId: 'p-1', sku: 'POS-001', description: 'Vitamin C 500mg', unit: 'each', quantityMilli: 1_000n,
      priceTier: 'RETAIL', unitPriceMinor: 20_000n, grossTotalMinor: 20_000n, manualDiscountMinor: 0n,
      promotionDiscountMinor: 0n, loyaltyDiscountMinor: 0n, lineTotalMinor: 20_000n, prescriptionRequired: false,
    }],
    subtotalMinor: 20_000n, promotionName: '', promotionDiscountMinor: 0n, manualDiscountMinor: 0n,
    loyaltyDiscountMinor: 0n, loyaltyPointsToRedeem: 0, loyaltyPointsEarned: 0, totalMinor: 20_000n,
    creditBalanceMinor: 0n, creditLimitMinor: 0n, warnings: [],
    ...overrides,
  }
}

function receipt(overrides: Partial<PosReceiptRecord> = {}): PosReceiptRecord {
  return {
    id: 1, receiptNumber: 'R-0000000042', status: 'COMPLETED', saleType: 'RETAIL',
    createdAt: '2026-11-17T10:00:00.000Z', currency: CURRENCY, display: DISPLAY,
    store: { name: 'Harbor Health', address: '12 Dock Road, Lagos', phone: '+234 1 555 0100' },
    customer: null, cashier: 'ADMIN Person', workstation: 'TILL-PC', items: [],
    payments: [{ id: 'pay-1', method: 'CASH', amountMinor: 20_000n, reference: '' } as never],
    subtotalMinor: 20_000n, promotionDiscountMinor: 0n, promotionName: '', manualDiscountMinor: 0n,
    loyaltyDiscountMinor: 0n, loyaltyPointsEarned: 0, loyaltyPointsRedeemed: 0, discountMinor: 0n, taxMinor: 0n,
    totalMinor: 20_000n, paidMinor: 20_000n, creditMinor: 0n, tenderedMinor: 20_000n, changeMinor: 0n,
    prescriptionAcknowledged: false, warnings: [], duplicate: false, printCount: 1,
    ...overrides,
  }
}

const NO_CUSTOMERS: PosCustomerRecord[] = []
const NO_HELD: HeldPosCartRecord[] = []
const NO_RECENT: PosRecentSaleRecord[] = []

/** Every method this screen can call, named — see the note in `ReportsWorkspace.test.tsx` about catch-all doubles. */
interface Bridge {
  getInventoryOverview: ReturnType<typeof vi.fn>
  listPosCustomers: ReturnType<typeof vi.fn>
  listHeldPosCarts: ReturnType<typeof vi.fn>
  listRecentPosSales: ReturnType<typeof vi.fn>
  quotePosSale: ReturnType<typeof vi.fn>
  completePosSale: ReturnType<typeof vi.fn>
  holdPosCart: ReturnType<typeof vi.fn>
  recallHeldPosCart: ReturnType<typeof vi.fn>
  discardHeldPosCart: ReturnType<typeof vi.fn>
  createPosCustomer: ReturnType<typeof vi.fn>
  getPosReceipt: ReturnType<typeof vi.fn>
  recordPosReceiptPrint: ReturnType<typeof vi.fn>
}

interface Harness {
  bridge: Bridge
  container: HTMLElement
  text(): string
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

async function mountTill(
  as: PublicUser,
  overrides: Partial<InfoflexBridge> = {},
  shopDiscountLimitBasisPoints?: number,
): Promise<Harness> {
  const bridge = {
    getInventoryOverview: vi.fn(async () => overview()),
    listPosCustomers: vi.fn(async () => NO_CUSTOMERS),
    listHeldPosCarts: vi.fn(async () => NO_HELD),
    listRecentPosSales: vi.fn(async () => NO_RECENT),
    quotePosSale: vi.fn(async () => quote()),
    completePosSale: vi.fn(async () => ({ receipt: receipt(), idempotentReplay: false })),
    holdPosCart: vi.fn(async () => ({ id: 'held-1' })),
    recallHeldPosCart: vi.fn(async () => ({ id: 'held-1' })),
    discardHeldPosCart: vi.fn(async () => ({ discarded: true })),
    createPosCustomer: vi.fn(async () => ({ id: 'c-1' })),
    getPosReceipt: vi.fn(async () => receipt()),
    recordPosReceiptPrint: vi.fn(async () => receipt()),
    ...overrides,
  } as unknown as InfoflexBridge & Bridge

  const holder = await mount(
    <PosWorkspace
      bridge={bridge}
      bootstrap={bootstrap(shopDiscountLimitBasisPoints)}
      user={as}
      onNavigate={() => undefined}
    />,
  )
  // Let the debounced catalogue read land before any assertion about what is on screen.
  await settle()
  return { bridge, container: holder, text: () => holder.textContent ?? '' }
}

/** Wait out the screen's own debounce. Real timers, because the delays are short and faking them stalls `act`. */
async function settle(ms = 220): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) })
}

function button(container: HTMLElement, label: RegExp): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')]
    .find((candidate) => label.test((candidate.textContent ?? '').replace(/\s+/gu, ' ').trim()))
  expect(found, `a button labelled ${String(label)}`).toBeDefined()
  return found as HTMLButtonElement
}

function press(target: HTMLElement): void {
  target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

/** Set a controlled field the way a person does; see `DailyAuditWorkspace.test.tsx` for why `.value` alone fails. */
function setField(field: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string): void {
  const prototype = field instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : field instanceof HTMLSelectElement
      ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (!setter) throw new Error('no native value setter')
  setter.call(field, value)
  field.dispatchEvent(new Event('input', { bubbles: true }))
  field.dispatchEvent(new Event('change', { bubbles: true }))
}

/** The discount field on a cart line, which only exists once something is in the cart. */
async function withOneItem(screen: Harness): Promise<HTMLInputElement> {
  await act(async () => { press(button(screen.container, /Vitamin C 500mg/u)) })
  await settle()
  const field = screen.container.querySelector('input[aria-label="Vitamin C 500mg manual discount"]')
  expect(field, 'the cart line has a discount field').not.toBeNull()
  return field as HTMLInputElement
}

/** The ceiling the Server will apply to this caller in this shop, read from the module rather than written out here. */
function ceilingFor(as: PublicUser, shopLimitBasisPoints?: number): ReturnType<typeof resolveDiscountCap> {
  const settings = bootstrap(shopLimitBasisPoints).settings
  return resolveDiscountCap(
    actorDiscountBasisPoints(as.role, as.permissions.maxDiscountBasisPoints),
    shopDiscountLimit(settings),
  )
}

const addedUrlMethods: string[] = []

beforeEach(() => {
  document.body.innerHTML = ''
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

describe('the till mounts for every role that may open it', () => {
  it.each([['ADMIN'], ['ACCOUNT'], ['USER']] as Array<['ADMIN' | 'ACCOUNT' | 'USER']>)(
    'mounts as %s, reads the catalogue and shows no refusal',
    async (role) => {
      // The page is keyed to `build_order`, which a USER holds: picking goods is the first half of selling them, and the
      // till is where the queue is. So all three arrive here, and all three must find a screen that works.
      expect(can(role, 'build_order'), `${role} may open the till`).toBe(true)
      const screen = await mountTill(user(role))
      expect(screen.bridge.getInventoryOverview).toHaveBeenCalled()
      expect(screen.text()).toContain('Point of Sale')
      expect(screen.text()).toContain('Vitamin C 500mg')
      expect(screen.container.querySelector('[role="alert"]')).toBeNull()
    },
  )

  it('renders a refused catalogue as an alert rather than an empty till that looks idle', async () => {
    const screen = await mountTill(user('ACCOUNT'), {
      getInventoryOverview: vi.fn(async () => { throw new Error('You do not have permission to open this page.') }),
    } as Partial<InfoflexBridge>)
    const alert = screen.container.querySelector('[role="alert"]')
    expect(alert).not.toBeNull()
    expect(alert!.textContent).toContain('You do not have permission to open this page.')
  })
})

describe('the discount ceiling is stated, and the field is not a switch', () => {
  it('lets a cashier whose limit is zero type a discount, and tells them the Admin will be asked', async () => {
    const as = user('ACCOUNT', { maxDiscountBasisPoints: 0 })
    expect(ceilingFor(as).limitBasisPoints, 'the Server applies a ceiling of nothing').toBe(0)

    const screen = await mountTill(as)
    const field = await withOneItem(screen)

    // The whole point of the change: a ceiling of zero means "ask", not "never". Disabling the field left this cashier
    // one option, which is the outcome Phase 18 removed from the Server - take the discount off and overcharge, or find
    // the Admin by word of mouth with nothing recorded.
    expect(field.disabled, 'the ceiling is not a switch').toBe(false)
    expect(screen.text()).toContain('Every manual discount asks the Admin first.')
    expect(field.title).toContain('Every manual discount asks the Admin first.')
  })

  it('states the tighter of the two ceilings, and says so when the shop set it', async () => {
    const as = user('ACCOUNT', { maxDiscountBasisPoints: 2_000 })
    const cap = ceilingFor(as, 500)
    expect(cap.limitPercent, 'the shop ceiling is tighter than this cashier’s own').toBe(5)
    expect(cap.setBy).toBe('SHOP_SETTINGS')

    const screen = await mountTill(as, {}, 500)
    await withOneItem(screen)
    expect(screen.text()).toContain('Manual discounts up to 5% go through; above that the Admin is asked.')
    expect(screen.text()).toContain('The shop limit in Settings is the tighter of the two.')
    // And not the cashier's own 20%, which is the figure a second spelling of this rule would have shown.
    expect(screen.text()).not.toContain('up to 20%')
  })

  it('does not blame the shop setting when the cashier’s own limit is the tighter one', async () => {
    const as = user('ACCOUNT', { maxDiscountBasisPoints: 500 })
    const cap = ceilingFor(as, 10_000)
    expect(cap.limitPercent).toBe(5)
    expect(cap.setBy, 'the shop is not stopping anything').toBe('USER_PERMISSION')

    const screen = await mountTill(as, {}, 10_000)
    await withOneItem(screen)
    expect(screen.text()).toContain('Manual discounts up to 5% go through; above that the Admin is asked.')
    expect(screen.text()).not.toContain('shop limit in Settings')
  })

  it('tells an Admin the ceiling is the whole price', async () => {
    const as = user('ADMIN')
    expect(ceilingFor(as).limitPercent).toBe(100)
    const screen = await mountTill(as)
    await withOneItem(screen)
    expect(screen.text()).toContain('Manual discounts up to 100% go through')
  })

  it('says the same thing as the module it reads, for every combination of the two ceilings', () => {
    // Derived rather than written out: the screen imports `resolveDiscountCap`, so the sentence has to follow whatever
    // that module says. A hand-written list of cases here would be a second spelling of the rule, which is the mistake
    // this test exists to prevent.
    //
    // Worth being clear about what that buys, because it is less than it looks. Both sides of every assertion below come
    // from the same call, so this test proves the screen reads the module and renders it faithfully — and it stays green
    // when the module itself is wrong. Making the shop limit win ties, or reading an unconfigured limit as 0, moves the
    // sentence and the expectation together. Those are pinned by absolutes in `discount-cap.test.ts`, which is the file
    // that has to be wrong for this one to lie.
    for (const role of ['ADMIN', 'ACCOUNT', 'USER'] as const) {
      for (const own of [0, 500, 2_000, 10_000]) {
        for (const shop of [0, 500, 10_000]) {
          const cap = resolveDiscountCap(actorDiscountBasisPoints(role, own), shop)
          const sentence = discountCeilingSentence(cap)
          if (cap.limitBasisPoints === 0) {
            expect(sentence, `${role}/${own}/${shop}`).toContain('asks the Admin first')
          } else {
            expect(sentence, `${role}/${own}/${shop}`).toContain(`up to ${cap.limitPercent}%`)
            expect(sentence).toContain('the Admin is asked')
          }
          expect(sentence.includes('shop limit in Settings'), `${role}/${own}/${shop} names the shop only when it binds`)
            .toBe(cap.setBy === 'SHOP_SETTINGS')
          // The ceiling is read off the same values for the assertion as for the screen.
          expect(cap.limitBasisPoints).toBe(Math.min(actorDiscountBasisPoints(role, own), shop))
        }
      }
    }
  })
})

describe('wholesale and credit are switches, and say so when they are off', () => {
  it('locks the wholesale tier for a cashier without the permission, and says why', async () => {
    const screen = await mountTill(user('ACCOUNT', { allowWholesale: false }))
    const wholesale = button(screen.container, /^Wholesale/u)
    expect(wholesale.disabled).toBe(true)
    // Stated rather than left to be inferred from a button that does nothing, and the same treatment the discount
    // ceiling now gets.
    expect(wholesale.title).toBe('Wholesale permission is disabled for this cashier.')
    expect(wholesale.textContent).toContain('LOCKED')
  })

  it('unlocks it with the permission', async () => {
    const screen = await mountTill(user('ACCOUNT', { allowWholesale: true }))
    const wholesale = button(screen.container, /^Wholesale/u)
    expect(wholesale.disabled).toBe(false)
    expect(wholesale.textContent).not.toContain('LOCKED')
  })

  it('offers credit as a payment only to a caller who may sell on credit', async () => {
    const without = await mountTill(user('ACCOUNT', { allowCreditSales: false }))
    await act(async () => { press(button(without.container, /Vitamin C 500mg/u)) })
    await settle()
    await act(async () => { press(button(without.container, /^Checkout/u)) })
    expect(button(without.container, /\+ Cash/u)).toBeDefined()
    expect([...without.container.querySelectorAll('button')].map((candidate) => candidate.textContent))
      .not.toContain('+ Credit')

    const withCredit = await mountTill(user('ACCOUNT', { allowCreditSales: true }))
    await act(async () => { press(button(withCredit.container, /Vitamin C 500mg/u)) })
    await settle()
    await act(async () => { press(button(withCredit.container, /^Checkout/u)) })
    expect(button(withCredit.container, /\+ Credit/u)).toBeDefined()
  })
})

describe('the cart asks the Server what the sale costs', () => {
  it('quotes the cart and shows the Server’s line total rather than one computed here', async () => {
    const screen = await mountTill(user('ACCOUNT'))
    await act(async () => { press(button(screen.container, /Vitamin C 500mg/u)) })
    await settle()

    expect(screen.bridge.quotePosSale).toHaveBeenCalled()
    expect(screen.bridge.quotePosSale.mock.calls[0]![0]).toMatchObject({
      saleType: 'RETAIL', items: [{ productId: 'p-1', quantity: '1', manualDiscount: '0' }], customerId: null,
    })
    // The figure on screen is the one the quote came back with.
    expect(screen.text()).toContain(formatMoney(20_000n, CURRENCY, DISPLAY))
  })

  it('shows a refused quote and holds checkout until there is a total', async () => {
    const screen = await mountTill(user('ACCOUNT'), {
      quotePosSale: vi.fn(async () => { throw new Error('Insufficient stock for this sale.') }),
    } as Partial<InfoflexBridge>)
    await act(async () => { press(button(screen.container, /Vitamin C 500mg/u)) })
    await settle()

    expect(screen.container.querySelector('.pos-quote-error')?.textContent).toContain('Insufficient stock for this sale.')
    // No total, no checkout: completing against a quote that never arrived would send a sale nobody has priced.
    expect(button(screen.container, /^Checkout/u).disabled).toBe(true)
  })

  it('does not offer an inactive product at all, rather than offering one that will be refused', async () => {
    const screen = await mountTill(user('ACCOUNT'), {
      getInventoryOverview: vi.fn(async () => overview([product({ isActive: false }), product({ id: 'p-2', sku: 'POS-002', name: 'Paracetamol 500mg' })])),
    } as Partial<InfoflexBridge>)
    // The list is filtered, so there is nothing to click: a control that only ever produces a refusal teaches the
    // cashier that the refusal is a fault. The active product beside it is still offered.
    expect(screen.text()).not.toContain('Vitamin C 500mg')
    expect(screen.text()).toContain('Paracetamol 500mg')
    expect(screen.bridge.quotePosSale, 'nothing was added to quote').not.toHaveBeenCalled()
  })
})

describe('completing a sale', () => {
  async function atCheckout(screen: Harness): Promise<void> {
    await act(async () => { press(button(screen.container, /Vitamin C 500mg/u)) })
    await settle()
    await act(async () => { press(button(screen.container, /^Checkout/u)) })
  }

  it('sends the quoted sale with one idempotency key, and reuses that key when the same sale is retried', async () => {
    // The first attempt is lost - a dropped request, a till that never saw the answer - and the second is the same sale.
    // A completed sale closes the checkout and empties the cart, so a retry is the only way this guard is ever reached,
    // and it is the case it exists for: the Server may already have taken the money for the first attempt.
    let attempts = 0
    const screen = await mountTill(user('ACCOUNT'), {
      completePosSale: vi.fn(async () => {
        attempts += 1
        if (attempts === 1) throw new Error('The till lost the Server for a moment. Try the sale again.')
        return { receipt: receipt(), idempotentReplay: false }
      }),
    } as Partial<InfoflexBridge>)
    await atCheckout(screen)

    const complete = button(screen.container, /^Complete sale/u)
    expect(complete.disabled, 'a total has arrived').toBe(false)
    await act(async () => { press(complete) })
    expect(screen.container.querySelector('[role="alert"]')?.textContent).toContain('lost the Server')

    // Still the same sale, so still the same key: a fresh one here would let the Server take the money twice.
    await act(async () => { press(button(screen.container, /^Complete sale/u)) })
    expect(screen.bridge.completePosSale).toHaveBeenCalledTimes(2)
    const [first, second] = screen.bridge.completePosSale.mock.calls.map((call) => call[0] as { idempotencyKey: string })
    expect(first.idempotencyKey.length).toBeGreaterThanOrEqual(8)
    expect(second.idempotencyKey, 'one key per sale, not per attempt').toBe(first.idempotencyKey)
    expect(screen.container.querySelector('[role="status"]')?.textContent).toContain('R-0000000042')
  })

  it('says plainly when the Server replays an earlier sale instead of making a second one', async () => {
    const screen = await mountTill(user('ACCOUNT'), {
      completePosSale: vi.fn(async () => ({ receipt: receipt(), idempotentReplay: true })),
    } as Partial<InfoflexBridge>)
    await atCheckout(screen)
    await act(async () => { press(button(screen.container, /^Complete sale/u)) })
    expect(screen.container.querySelector('[role="status"]')?.textContent)
      .toContain('no second sale or stock deduction was created')
  })

  it('makes a new key once the sale is a different sale', async () => {
    let attempts = 0
    const screen = await mountTill(user('ACCOUNT'), {
      completePosSale: vi.fn(async () => {
        attempts += 1
        if (attempts === 1) throw new Error('The till lost the Server for a moment. Try the sale again.')
        return { receipt: receipt(), idempotentReplay: false }
      }),
    } as Partial<InfoflexBridge>)
    await atCheckout(screen)
    await act(async () => { press(button(screen.container, /^Complete sale/u)) })
    const first = (screen.bridge.completePosSale.mock.calls[0]![0] as { idempotencyKey: string }).idempotencyKey

    // Corrected rather than retried. Editing a line clears the pending submission outright, so this is the screen
    // forgetting the earlier attempt; the case where it has to *notice* the sale changed is the one below.
    await act(async () => { press(button(screen.container, /^Back to cart/u)) })
    const quantity = screen.container.querySelector('.pos-cart-line input[type="number"]') as HTMLInputElement
    expect(quantity, 'the cart is still there to correct').not.toBeNull()
    await act(async () => { setField(quantity, '2') })
    await settle()
    await act(async () => { press(button(screen.container, /^Checkout/u)) })
    await act(async () => { press(button(screen.container, /^Complete sale/u)) })

    const secondCall = screen.bridge.completePosSale.mock.calls[1]![0] as { idempotencyKey: string; items: Array<{ quantity: string }> }
    expect(secondCall.idempotencyKey, 'a different sale is a different key').not.toBe(first)
    expect(secondCall.items[0]!.quantity, 'and it is the corrected sale that was sent').toBe('2')
  })

  it('makes a new key when the cart changed by a path that does not clear the pending sale', async () => {
    let attempts = 0
    const screen = await mountTill(user('ACCOUNT'), {
      completePosSale: vi.fn(async () => {
        attempts += 1
        if (attempts === 1) throw new Error('The till lost the Server for a moment. Try the sale again.')
        return { receipt: receipt(), idempotentReplay: false }
      }),
    } as Partial<InfoflexBridge>)
    await atCheckout(screen)
    await act(async () => { press(button(screen.container, /^Complete sale/u)) })
    const first = (screen.bridge.completePosSale.mock.calls[0]![0] as { idempotencyKey: string }).idempotencyKey

    // Another unit by clicking the product again, which is the path that does *not* clear the pending submission: the
    // key has to be replaced because the sale it described is no longer the sale on screen. Compared by fingerprint
    // rather than cleared on every edit, so a retry of an unchanged sale still carries the same key.
    await act(async () => { press(button(screen.container, /^Back to cart/u)) })
    await act(async () => { press(button(screen.container, /Vitamin C 500mg/u)) })
    await settle()
    await act(async () => { press(button(screen.container, /^Checkout/u)) })
    await act(async () => { press(button(screen.container, /^Complete sale/u)) })

    const secondCall = screen.bridge.completePosSale.mock.calls[1]![0] as { idempotencyKey: string; items: Array<{ quantity: string }> }
    expect(secondCall.items[0]!.quantity, 'the second unit really was added').toBe('2')
    expect(secondCall.idempotencyKey, 'a changed sale is not the sale the old key describes').not.toBe(first)
  })

  it('holds a prescription sale until the warning is acknowledged', async () => {
    const screen = await mountTill(user('ACCOUNT'), {
      quotePosSale: vi.fn(async () => quote({ warnings: ['Paracetamol 500mg requires a prescription.'] })),
    } as Partial<InfoflexBridge>)
    await atCheckout(screen)

    const complete = button(screen.container, /^Complete sale/u)
    expect(complete.disabled, 'an unacknowledged prescription warning holds the sale').toBe(true)
    expect(screen.bridge.completePosSale).not.toHaveBeenCalled()

    const acknowledge = screen.container.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(acknowledge, 'the warning offers something to tick').not.toBeNull()
    await act(async () => { press(acknowledge) })
    expect(button(screen.container, /^Complete sale/u).disabled).toBe(false)
  })

  it('renders a refusal as an alert and keeps the cart, so the sale can be corrected rather than retyped', async () => {
    const screen = await mountTill(user('ACCOUNT'), {
      completePosSale: vi.fn(async () => {
        throw new Error('This sale’s manual discount exceeds your 5% permission limit.')
      }),
    } as Partial<InfoflexBridge>)
    await atCheckout(screen)
    await act(async () => { press(button(screen.container, /^Complete sale/u)) })

    expect(screen.container.querySelector('[role="alert"]')?.textContent)
      .toContain('exceeds your 5% permission limit')
    expect(screen.container.querySelector('[role="status"]'), 'nothing claims the sale completed').toBeNull()
    expect(screen.text(), 'the cart survives the refusal').toContain('Vitamin C 500mg')
  })
})
