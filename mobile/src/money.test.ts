import { describe, expect, it } from 'vitest'
import { getCurrency } from '../../src/currency/catalog'
import { defaultDisplayOptions } from '../../src/currency/money'
import { formatMobileMoney, formatMobileMoneyIn, formatPercent, formatQuantity, parseMoneyInput, shopCurrencyContext } from './money'

/**
 * The phone has no currency switch and no hard-coded symbol. These tests pin the two things that could
 * silently go wrong: the format of what it shows, and the interpretation of what the Admin types.
 */

const NGN = getCurrency('NGN')!
const UGX = getCurrency('UGX')!
const KWD = getCurrency('KWD')!
const XOF = getCurrency('XOF')!
const EUR = getCurrency('EUR')!

describe('money on the Admin phone', () => {
  it('shows Naira from integer minor units with the shop separators', () => {
    const context = shopCurrencyContext(NGN)
    expect(formatMobileMoney('255000', context)).toBe('₦2,550.00')
    expect(formatMobileMoney('100000000', context)).toBe('₦1,000,000.00')
    expect(formatMobileMoney('0', context)).toBe('₦0.00')
  })

  it('shows a 0-decimal currency with no decimal point at all', () => {
    const context = shopCurrencyContext(UGX)
    expect(NGN.decimalPlaces).toBe(2)
    expect(UGX.decimalPlaces).toBe(0)
    // UGX writes a spaced symbol before the number, per its entry in the currency table.
    expect(formatMobileMoney('255000', context)).toBe('USh 255,000')
    expect(formatMobileMoney('255000', context)).not.toContain('.')
  })

  it('shows a 3-decimal currency with three decimals', () => {
    expect(KWD.decimalPlaces).toBe(3)
    expect(formatMobileMoney('1234', shopCurrencyContext(KWD))).toContain('1.234')
  })

  it('respects the Admin choosing to show the ISO code after the amount', () => {
    const context = { currency: NGN, display: { ...defaultDisplayOptions(NGN), amountDisplay: 'code' as const } }
    const shown = formatMobileMoney('255000', context)
    expect(shown).toContain('NGN')
    expect(shown).toContain('2,550.00')
  })

  it('negates with the shop own minus and never a currency-specific glyph', () => {
    expect(formatMobileMoney('-2500', shopCurrencyContext(NGN))).toBe('−₦25.00')
  })

  it('formats a historical sale in the currency it was made in', () => {
    // A sale made before the shop re-locked the currency still reads in its own currency.
    // EUR places the symbol after the amount and uses European separators.
    expect(formatMobileMoneyIn('100000', EUR)).toBe('1.000,00 €')
  })

  it('shows a dash rather than a made-up zero when the host withholds an amount', () => {
    expect(formatMobileMoney(null, shopCurrencyContext(NGN))).toBe('—')
    expect(formatMobileMoney(undefined, shopCurrencyContext(NGN))).toBe('—')
    expect(formatMobileMoney('not-a-number', shopCurrencyContext(NGN))).toBe('—')
  })

  it('never uses floating point: a huge amount keeps every digit', () => {
    const huge = '9007199254740991'
    expect(formatMobileMoney(huge, shopCurrencyContext(UGX))).toBe('USh 9,007,199,254,740,991')
  })
})

describe('what the Admin types into a price field', () => {
  it('accepts the shop thousands separator and decimal point', () => {
    const result = parseMoneyInput('2,550.50', shopCurrencyContext(NGN))
    expect(result).toEqual({ ok: true, minor: '255050' })
  })

  it('accepts a plain number without separators', () => {
    expect(parseMoneyInput('1250', shopCurrencyContext(NGN))).toEqual({ ok: true, minor: '125000' })
    expect(parseMoneyInput('1250.5', shopCurrencyContext(NGN))).toEqual({ ok: true, minor: '125050' })
  })

  it('refuses more decimals than the currency allows instead of silently rounding', () => {
    const tooMany = parseMoneyInput('12.345', shopCurrencyContext(NGN))
    expect(tooMany.ok).toBe(false)
    if (!tooMany.ok) expect(tooMany.message).toContain('2 decimal places')
  })

  it('refuses any decimals for a 0-decimal currency', () => {
    const result = parseMoneyInput('5000.50', shopCurrencyContext(UGX))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('no decimal places')
    // A whole amount is fine.
    expect(parseMoneyInput('5000', shopCurrencyContext(UGX))).toEqual({ ok: true, minor: '5000' })
  })

  it('accepts three decimals for a 3-decimal currency', () => {
    expect(parseMoneyInput('12.345', shopCurrencyContext(KWD))).toEqual({ ok: true, minor: '12345' })
  })

  it('understands the franc-zone comma decimal', () => {
    // XOF uses a narrow no-break space for thousands and a comma for decimals.
    expect(XOF.decimalSeparator).toBe(',')
    expect(parseMoneyInput('5000', shopCurrencyContext(XOF))).toEqual({ ok: true, minor: '5000' })
  })

  it('refuses letters, a second amount, and an empty field with plain words', () => {
    const letters = parseMoneyInput('12abc', shopCurrencyContext(NGN))
    expect(letters.ok).toBe(false)
    if (!letters.ok) expect(letters.message).toMatch(/digits only/iu)
    expect(parseMoneyInput('', shopCurrencyContext(NGN))).toEqual({ ok: false, message: 'Enter an amount.' })
    const twoAmounts = parseMoneyInput('1.2.3', shopCurrencyContext(NGN))
    expect(twoAmounts.ok).toBe(false)
  })

  it('refuses an amount too large to store exactly', () => {
    const result = parseMoneyInput('999999999999999999', shopCurrencyContext(NGN))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/too large/iu)
  })
})

describe('quantities and percentages on the phone', () => {
  it('shows thousandths without trailing zeros', () => {
    expect(formatQuantity('5000')).toBe('5')
    expect(formatQuantity('5500')).toBe('5.5')
    expect(formatQuantity('5505')).toBe('5.505')
    expect(formatQuantity('-1500')).toBe('−1.5')
    expect(formatQuantity('0')).toBe('0')
    expect(formatQuantity(null)).toBe('0')
  })

  it('shows a discount limit from basis points', () => {
    expect(formatPercent(1000)).toBe('10%')
    expect(formatPercent(1250)).toBe('12.50%')
    expect(formatPercent(0)).toBe('0%')
  })
})
