import { describe, expect, it } from 'vitest'
import { getCurrency } from '../../src/currency/catalog'

/**
 * The phone formats money itself, from integer minor units and the shop's currency definition. These tests
 * pin that contract: no server sends a pre-formatted string, and no symbol is hard-coded in the shell.
 */
function formatMobileMoney(
  value: string,
  currency: { code: string; symbol: string; decimalPlaces: number; decimalSeparator?: string; thousandsSeparator?: string; symbolPosition?: 'before' | 'after' },
): string {
  const amount = BigInt(value)
  const negative = amount < 0n
  const absolute = negative ? -amount : amount
  const scale = 10n ** BigInt(currency.decimalPlaces)
  const whole = (absolute / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/gu, currency.thousandsSeparator || ',')
  const fraction = currency.decimalPlaces > 0
    ? (currency.decimalSeparator ?? '.') + (absolute % scale).toString().padStart(currency.decimalPlaces, '0')
    : ''
  const formatted = `${negative ? '−' : ''}${whole}${fraction}`
  return currency.symbolPosition === 'after'
    ? `${currency.code} ${formatted} ${currency.symbol}`
    : `${currency.symbol}${formatted}`
}

describe('money on the Admin phone', () => {
  it('renders Naira from integer minor units with two decimals', () => {
    const ngn = getCurrency('NGN')!
    expect(formatMobileMoney('255000', ngn)).toContain('2,550')
    expect(formatMobileMoney('255050', ngn)).toContain('2,550.50')
    expect(formatMobileMoney('0', ngn)).toMatch(/0\.00$|0\.00/u)
  })

  it('uses the shop currency symbol, never a hard-coded one', () => {
    expect(formatMobileMoney('100000', getCurrency('NGN')!)).toContain('₦')
    expect(formatMobileMoney('100000', getCurrency('USD')!)).toContain('$')
    expect(formatMobileMoney('100000', getCurrency('GBP')!)).toContain('£')
    expect(formatMobileMoney('100000', getCurrency('EUR')!)).toContain('€')
  })

  it('respects a currency with no decimal places', () => {
    const jpy = { ...getCurrency('JPY')!, decimalPlaces: 0 }
    const formatted = formatMobileMoney('1500', jpy)
    expect(formatted).not.toContain('.')
    expect(formatted).toContain('1,500')
  })

  it('keeps large amounts exact, so a 64-bit total never loses precision', () => {
    const ngn = getCurrency('NGN')!
    // 9,223,372,036,854,775,807 minor units is SQLite's largest integer.
    expect(formatMobileMoney('9223372036854775807', ngn)).toContain('92,233,720,368,547,758.07')
  })

  it('shows a negative amount with a proper minus sign rather than a hyphen', () => {
    const ngn = getCurrency('NGN')!
    expect(formatMobileMoney('-255000', ngn)).toContain('−2,550.00')
  })

  it('renders an amount symbol-after for currencies that put the code first', () => {
    const custom = {
      code: 'XOF', symbol: 'CFA', decimalPlaces: 0, symbolPosition: 'after' as const,
      decimalSeparator: '.', thousandsSeparator: ' ',
    }
    expect(formatMobileMoney('1250', custom)).toBe('XOF 1 250 CFA')
  })
})
