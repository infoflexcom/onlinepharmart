import { describe, expect, it } from 'vitest'
import { getCurrency } from '@shared/currency/catalog'
import { defaultDisplayOptions } from '@shared/currency/money'
import { DEFAULT_OPERATIONAL_SETTINGS } from '@shared/shop/types'
import type { OperationalSettings, ShopSettings } from '@shared/shop/types'
import {
  actorDiscountBasisPoints,
  maximumDiscountFor,
  resolveDiscountCap,
  shopDiscountLimit,
} from './discount-cap'

/**
 * The ceiling itself.
 *
 * Every number in this file is written out rather than derived, and that is deliberate. The tests that consume this
 * module elsewhere — the till, the sale approval path, the daily audit — mostly assert what a *reader* does with the
 * ceiling, so when the module is wrong they move with it and stay green. Two mutations proved the gap: reading an
 * unconfigured shop limit as 0 instead of "no ceiling", and naming Settings as the binding limit when the two ceilings
 * are equal. Both changed money behaviour, and nothing outside this file noticed.
 *
 * So here the expectations are absolutes — 5%, `9n`, `USER_PERMISSION` — checked against the module rather than against
 * the module's own output.
 */

const CURRENCY = getCurrency('NGN')!
const DISPLAY = defaultDisplayOptions(CURRENCY)

/**
 * A settings object with only the operational block varied. The function under test reads one field off it, but the
 * cases worth pinning are the ones where that field is missing or impossible — shapes `OperationalSettings` does not
 * allow and a database can still hand over, which is why the guard exists.
 */
function settingsWith(operational: unknown): ShopSettings {
  return {
    profile: { name: 'Harbor Health', address: '12 Dock Road, Lagos', phone: '+234 1 555 0100' },
    currency: CURRENCY,
    display: DISPLAY,
    setupComplete: true,
    currencyConfirmed: true,
    currencyLocked: false,
    operational,
  } as unknown as ShopSettings
}

function withLimit(discountLimitBasisPoints: unknown): ShopSettings {
  return settingsWith({ ...DEFAULT_OPERATIONAL_SETTINGS, discountLimitBasisPoints } as OperationalSettings)
}

describe('actorDiscountBasisPoints', () => {
  it('gives an Admin the whole price, whatever their permission row says', () => {
    // The Admin sets the ceiling for other people; a permission row of 0 for them would be a shop that cannot discount
    // at all, and the Admin's own row is not something another Admin writes.
    for (const row of [0, 500, 2_000, 10_000]) {
      expect(actorDiscountBasisPoints('ADMIN', row), `ADMIN with a row of ${row}`).toBe(10_000)
    }
  })

  it('reads every other role from the permission row written for that person', () => {
    for (const role of ['SUPERVISOR', 'ACCOUNT', 'USER', 'CASHIER']) {
      for (const row of [0, 500, 2_000, 10_000]) {
        expect(actorDiscountBasisPoints(role, row), `${role} with a row of ${row}`).toBe(row)
      }
    }
  })
})

describe('shopDiscountLimit', () => {
  it('reads the ceiling the Admin configured', () => {
    // 0 is a real setting — "every discount asks me first" — and must survive as 0 rather than fall back.
    for (const limit of [0, 1, 500, 2_500, 10_000]) {
      expect(shopDiscountLimit(withLimit(limit)), `a configured limit of ${limit}`).toBe(limit)
    }
  })

  it('treats a missing or impossible limit as no shop ceiling, never as no discounts', () => {
    // The direction of this fallback is the whole test. Reading an unconfigured limit as 0 would turn "the Admin has not
    // set a shop ceiling" into "every discount in the shop needs the Admin", silently, on every till at once.
    const impossible: Array<[string, unknown]> = [
      ['no operational block at all', undefined],
      ['a null operational block', null],
      ['no limit field', { ...DEFAULT_OPERATIONAL_SETTINGS, discountLimitBasisPoints: undefined }],
      ['a negative limit', -1],
      ['a limit above the whole price', 10_001],
      ['a limit far above the whole price', 999_999],
      ['a fractional basis point', 12.5],
      ['a limit that is not a number', '500'],
      ['a limit that is NaN', Number.NaN],
    ]
    for (const [label, operational] of impossible) {
      expect(shopDiscountLimit(settingsWith(operational)), label).toBe(10_000)
    }
  })
})

describe('resolveDiscountCap', () => {
  it('lets the stricter of the two ceilings win', () => {
    const cases: Array<[number, number, number]> = [
      [2_000, 500, 500], // the shop is tighter
      [500, 2_000, 500], // the person is tighter
      [0, 10_000, 0],
      [10_000, 0, 0],
      [500, 500, 500],
      [10_000, 10_000, 10_000],
      [1_250, 300, 300],
    ]
    for (const [actor, shop, expected] of cases) {
      expect(resolveDiscountCap(actor, shop).limitBasisPoints, `actor ${actor} against shop ${shop}`).toBe(expected)
    }
  })

  it('names Settings as the ceiling only when Settings is what binds', () => {
    // Blaming a setting that is not stopping anything sends the cashier to the wrong screen to change it.
    expect(resolveDiscountCap(2_000, 500).setBy, 'the shop is tighter').toBe('SHOP_SETTINGS')
    expect(resolveDiscountCap(500, 2_000).setBy, 'the person is tighter').toBe('USER_PERMISSION')
    expect(resolveDiscountCap(500, 500).setBy, 'equal ceilings').toBe('USER_PERMISSION')
    expect(resolveDiscountCap(0, 0).setBy, 'both zero').toBe('USER_PERMISSION')
    expect(resolveDiscountCap(10_000, 10_000).setBy, 'both the whole price').toBe('USER_PERMISSION')
    expect(resolveDiscountCap(0, 500).setBy, 'the person may not discount at all').toBe('USER_PERMISSION')
    expect(resolveDiscountCap(500, 0).setBy, 'the shop allows no discount').toBe('SHOP_SETTINGS')
  })

  it('states the same ceiling as a percentage a person can read', () => {
    expect(resolveDiscountCap(500, 500).limitPercent, '500 basis points').toBe(5)
    expect(resolveDiscountCap(1_250, 1_250).limitPercent, '1250 basis points').toBe(12.5)
    expect(resolveDiscountCap(10_000, 10_000).limitPercent, 'the whole price').toBe(100)
    expect(resolveDiscountCap(0, 0).limitPercent, 'nothing').toBe(0)
    expect(resolveDiscountCap(1, 1).limitPercent, 'one basis point').toBe(0.01)
  })

  it('keeps the percentage and the basis points the same ceiling', () => {
    for (const actor of [0, 250, 500, 1_250, 10_000]) {
      for (const shop of [0, 500, 10_000]) {
        const cap = resolveDiscountCap(actor, shop)
        expect(cap.limitPercent * 100, `actor ${actor} against shop ${shop}`).toBe(cap.limitBasisPoints)
      }
    }
  })
})

describe('maximumDiscountFor', () => {
  it('truncates rather than rounds, the way the till always has', () => {
    // 199 minor units at 5% is 9.95: rounding would take 10 off a sale that only allows 9.95, so the customer is
    // discounted more than the ceiling permits.
    expect(maximumDiscountFor(199n, 500)).toBe(9n)
    expect(maximumDiscountFor(1_999n, 500)).toBe(99n)
    expect(maximumDiscountFor(99n, 100)).toBe(0n)
    expect(maximumDiscountFor(1n, 10_000)).toBe(1n)
    expect(maximumDiscountFor(20_000n, 500)).toBe(1_000n)
    expect(maximumDiscountFor(20_000n, 10_000)).toBe(20_000n)
  })

  it('takes nothing off when the ceiling is zero, and the whole gross when it is the whole price', () => {
    for (const gross of [0n, 1n, 199n, 20_000n, 1_234_567n]) {
      expect(maximumDiscountFor(gross, 0), `a gross of ${gross} with no discount allowed`).toBe(0n)
      expect(maximumDiscountFor(gross, 10_000), `a gross of ${gross} with any discount allowed`).toBe(gross)
    }
  })

  it('never allows more off than the sale is worth, and never less than nothing', () => {
    for (const gross of [0n, 1n, 7n, 199n, 20_000n, 1_234_567n]) {
      for (const limit of [0, 1, 100, 500, 1_250, 9_999, 10_000]) {
        const most = maximumDiscountFor(gross, limit)
        expect(most >= 0n, `${gross} at ${limit} basis points`).toBe(true)
        expect(most <= gross, `${gross} at ${limit} basis points`).toBe(true)
      }
    }
  })

  it('discounts the ceiling the resolver picked, not either input on its own', () => {
    // The composition the till and the Server both rely on: resolve first, then apply. At 20% of their own in a shop
    // capped at 5%, a 20 000 minor-unit gross allows 1 000 off — not the 4 000 the cashier's own row would allow.
    const cap = resolveDiscountCap(actorDiscountBasisPoints('USER', 2_000), shopDiscountLimit(withLimit(500)))
    expect(cap.limitBasisPoints).toBe(500)
    expect(cap.setBy).toBe('SHOP_SETTINGS')
    expect(maximumDiscountFor(20_000n, cap.limitBasisPoints)).toBe(1_000n)
  })
})
