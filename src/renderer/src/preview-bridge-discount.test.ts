import { describe, expect, it } from 'vitest'
import { getCurrency } from '@shared/currency/catalog'
import { defaultDisplayOptions } from '@shared/currency/money'
import { DEFAULT_OPERATIONAL_SETTINGS } from '@shared/shop/types'
import type { ProductDraft } from '@shared/inventory/types'
import type { PosQuoteInput } from '@shared/pos/types'
import type { InfoflexBridge } from '@shared/bridge'
import { createPreviewBridge } from './preview-bridge'

/**
 * The discount ceiling in the browser preview.
 *
 * `preview-bridge` is the whole of the memory-only host the browser preview runs on, and it had no test. It also
 * computed the discount ceiling twice, inline, from the cashier's own permission row alone:
 *
 *     subtotal * BigInt(user.role === 'ADMIN' ? 10_000 : user.permissions.maxDiscountBasisPoints) / 10_000n
 *
 * Both spellings left out the shop-wide ceiling from Settings, so a limit an Admin set on the preview's own Settings
 * screen did nothing at the preview's till: a cashier with 20% of their own discounted 20% in a shop capped at 5%, and
 * the installed product would have held that sale. Both now read `discount-cap`, the module that owns the rule.
 *
 * These tests drive the preview the way the screens do — first run, a product, a cashier, a shop setting, a login, a
 * quote — because the point is that the ceiling binds on the route the preview actually takes to a sale. The module's
 * own arithmetic is pinned by absolutes in `src/services/discount-cap.test.ts`; what is checked here is that the
 * preview asks it.
 *
 * One divergence is deliberate and is recorded in `preview-bridge.ts` rather than closed: above the ceiling the preview
 * refuses outright, where the installed Server raises an approval request and completes the sale once the Admin accepts.
 */

const CURRENCY = getCurrency('NGN')!
const DISPLAY = defaultDisplayOptions(CURRENCY)
const PASSWORD = 'Preview#Pass1'

/** A 200.00 retail item, so a quantity of one grosses 20 000 minor units and the percentages are easy to read. */
function productDraft(): ProductDraft {
  return {
    sku: 'VC-500', name: 'Vitamin C 500mg', brand: 'Harbor', description: '', barcode: '5001',
    additionalBarcodes: [], category: 'Vitamins', subCategory: '', department: '', shelfLocation: 'A1',
    unit: 'pack', packSizeUnits: 1, cost: '120', retailPrice: '200', wholesalePrice: '180',
    wholesaleMinimumQuantity: '5', reorderLevel: '10', genericName: 'Ascorbic acid', prescriptionRequired: false,
    weighedItem: false, pluCode: '', pricePerKg: '', expiryTracking: false, variants: [], isActive: true,
  }
}

/**
 * A preview shop, set up and signed in as a cashier.
 *
 * `shopLimit` of `null` leaves Settings alone, which is the state a shop is in before anybody configures a ceiling —
 * the state that must mean "no shop ceiling" rather than "no discounts".
 */
async function previewShop(shopLimit: number | null, cashierBasisPoints: number): Promise<{ bridge: InfoflexBridge; productId: string }> {
  const bridge = createPreviewBridge()
  await bridge.completeFirstRun({
    admin: { fullName: 'Ada Admin', username: 'admin', password: PASSWORD, confirmPassword: PASSWORD },
    profile: { name: 'Harbor Health', address: '12 Dock Road, Lagos', phone: '+234 1 555 0100' },
    currency: CURRENCY,
    display: DISPLAY,
    currencyConfirmed: true,
  })
  await bridge.login({ username: 'admin', password: PASSWORD })
  const product = await bridge.saveProduct(productDraft())
  // Completion checks stock before it checks the ceiling, so a basket with nothing behind it is refused for the wrong
  // reason and says nothing about discounts. Ten units is enough for every case here.
  await bridge.adjustStock({
    productId: product.id,
    expectedProductVersion: product.rowVersion,
    expectedStockVersion: product.stockVersion,
    direction: 'increase',
    quantity: '10',
    reason: 'Opening stock',
    // The preview tracks expiry, so stock has to arrive as a batch that has not expired: computed a year out rather than
    // written down, because a date in a test file goes stale on its own.
    batchNumber: 'B-1',
    expiryDate: new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10),
  })
  await bridge.createUser({
    fullName: 'Bola Cashier', username: 'bola', password: PASSWORD, confirmPassword: PASSWORD, role: 'USER',
    permissions: { allowWholesale: false, maxDiscountBasisPoints: cashierBasisPoints, allowCreditSales: false, returnLimitMinor: 0n },
  })
  if (shopLimit !== null) {
    await bridge.updateOperationalSettings({ ...DEFAULT_OPERATIONAL_SETTINGS, discountLimitBasisPoints: shopLimit })
  }
  await bridge.login({ username: 'bola', password: PASSWORD })
  return { bridge, productId: product.id }
}

function quote(productId: string, lines: Array<{ quantity: string; manualDiscount: string }>): PosQuoteInput {
  return {
    saleType: 'RETAIL',
    items: lines.map((line) => ({ productId, quantity: line.quantity, manualDiscount: line.manualDiscount })),
    customerId: null,
  }
}

const REFUSAL = 'The manual discount exceeds your permission limit.'

describe('the discount ceiling in the browser preview', () => {
  it('lets a cashier discount within their own limit when the shop has set no ceiling', async () => {
    const { bridge, productId } = await previewShop(null, 2_000)
    // 10% of a 200.00 basket, from a cashier allowed 20%, in a shop that has never configured a limit. Reading an
    // unconfigured limit as 0 would refuse this, on every preview till at once.
    const quoted = await bridge.quotePosSale(quote(productId, [{ quantity: '1', manualDiscount: '20' }]))
    expect(quoted.subtotalMinor).toBe(20_000n)
    expect(quoted.manualDiscountMinor).toBe(2_000n)
  })

  it('holds a discount the shop ceiling forbids, even where the permission row allows it', async () => {
    const { bridge, productId } = await previewShop(500, 2_000)
    // The case the inline arithmetic could not see: 20% of their own, 5% for the shop, a 10% discount typed.
    await expect(bridge.quotePosSale(quote(productId, [{ quantity: '1', manualDiscount: '20' }]))).rejects.toThrow(REFUSAL)
    // At the ceiling rather than above it, the same cashier and the same shop go through.
    const atCeiling = await bridge.quotePosSale(quote(productId, [{ quantity: '1', manualDiscount: '10' }]))
    expect(atCeiling.manualDiscountMinor).toBe(1_000n)
  })

  it('holds a discount the permission row forbids, even where the shop allows it', async () => {
    const { bridge, productId } = await previewShop(10_000, 200)
    await expect(bridge.quotePosSale(quote(productId, [{ quantity: '1', manualDiscount: '10' }]))).rejects.toThrow(REFUSAL)
    const withinOwn = await bridge.quotePosSale(quote(productId, [{ quantity: '1', manualDiscount: '4' }]))
    expect(withinOwn.manualDiscountMinor).toBe(400n)
  })

  it('enforces the same ceiling when the sale is completed as when it is quoted', async () => {
    const { bridge, productId } = await previewShop(500, 2_000)
    // Two sites, one helper: quoting is a price, completing is money and stock, and a ceiling that bound only one of
    // them would let a discount through by skipping the quote.
    await expect(bridge.quotePosSale(quote(productId, [{ quantity: '1', manualDiscount: '20' }]))).rejects.toThrow(REFUSAL)
    await expect(bridge.completePosSale({
      idempotencyKey: 'preview-cap-check-1',
      saleType: 'RETAIL',
      items: [{ productId, quantity: '1', manualDiscount: '20' }],
      payments: [{ method: 'CASH', amount: '180' }],
      customerId: null,
    })).rejects.toThrow(REFUSAL)

    const within = await bridge.completePosSale({
      idempotencyKey: 'preview-cap-check-2',
      saleType: 'RETAIL',
      items: [{ productId, quantity: '1', manualDiscount: '10' }],
      payments: [{ method: 'CASH', amount: '190' }],
      customerId: null,
    })
    expect(within.receipt.totalMinor, 'the ceiling is not a tax on a discount that is allowed').toBe(19_000n)
  })

  it('counts the ceiling against the whole basket, not against each line', async () => {
    const { bridge, productId } = await previewShop(500, 2_000)
    // Two lines of 150.00 gross: 40 000 in total, so 5% allows 2 000. Each line is under that on its own; together they
    // are over. Per-line ceilings would let a basket be discounted without limit by splitting it.
    await expect(bridge.quotePosSale(quote(productId, [
      { quantity: '1', manualDiscount: '15' },
      { quantity: '1', manualDiscount: '15' },
    ]))).rejects.toThrow(REFUSAL)

    const split = await bridge.quotePosSale(quote(productId, [
      { quantity: '1', manualDiscount: '10' },
      { quantity: '1', manualDiscount: '10' },
    ]))
    expect(split.subtotalMinor).toBe(40_000n)
    expect(split.manualDiscountMinor).toBe(2_000n)
  })

  it('gives an Admin the whole price whatever their own permission row says', async () => {
    const bridge = createPreviewBridge()
    await bridge.completeFirstRun({
      admin: { fullName: 'Ada Admin', username: 'admin', password: PASSWORD, confirmPassword: PASSWORD },
      profile: { name: 'Harbor Health', address: '12 Dock Road, Lagos', phone: '+234 1 555 0100' },
      currency: CURRENCY,
      display: DISPLAY,
      currencyConfirmed: true,
    })
    await bridge.login({ username: 'admin', password: PASSWORD })
    const product = await bridge.saveProduct(productDraft())
    // Two accounts, the same permission row of 0, different roles. The row is the Admin's decision about a person, so it
    // cannot be the thing that limits the Admin.
    for (const [username, role] of [['ada2', 'ADMIN'], ['bola', 'USER']] as Array<[string, 'ADMIN' | 'USER']>) {
      await bridge.createUser({
        fullName: `${username} Test`, username, password: PASSWORD, confirmPassword: PASSWORD, role,
        permissions: { allowWholesale: false, maxDiscountBasisPoints: 0, allowCreditSales: false, returnLimitMinor: 0n },
      })
    }

    await bridge.login({ username: 'ada2', password: PASSWORD })
    const adminQuote = await bridge.quotePosSale(quote(product.id, [{ quantity: '1', manualDiscount: '100' }]))
    expect(adminQuote.manualDiscountMinor, 'an Admin may discount the whole price').toBe(10_000n)

    await bridge.login({ username: 'bola', password: PASSWORD })
    await expect(bridge.quotePosSale(quote(product.id, [{ quantity: '1', manualDiscount: '1' }]))).rejects.toThrow(REFUSAL)
  })
})
