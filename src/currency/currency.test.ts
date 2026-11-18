import { describe, expect, it } from 'vitest'
import { CURRENCIES, DEFAULT_CURRENCY_CODE, getCurrency } from './catalog'
import { assertCurrencyChangeAllowed } from './lock-guard'
import { fromMinor, parseMoney, parseMoneyExact, toMinor } from './parse'
import { applyRateHalfUp, decimalToMinor, formatMoney, roundHalfUp } from './money'

const REQUIRED_CURRENCIES = [
  'NGN', 'USD', 'EUR', 'GBP', 'GHS', 'KES', 'ZAR', 'XOF', 'XAF', 'UGX', 'TZS', 'RWF', 'ETB', 'EGP',
  'MAD', 'TND', 'DZD', 'ZMW', 'MWK', 'BWP', 'NAD', 'MZN', 'AOA', 'GMD', 'SLE', 'LRD', 'CDF', 'SDG',
  'SSP', 'CAD', 'AUD', 'NZD', 'INR', 'PKR', 'BDT', 'LKR', 'AED', 'SAR', 'QAR', 'KWD', 'BHD', 'OMR',
  'JOD', 'TRY', 'CNY', 'JPY', 'KRW', 'SGD', 'MYR', 'IDR', 'PHP', 'THB', 'BRL', 'MXN',
]

describe('currency catalog', () => {
  it('includes every requested built-in ISO code exactly once', () => {
    const codes = CURRENCIES.map(({ code }) => code)
    expect(codes).toEqual(REQUIRED_CURRENCIES)
    expect(new Set(codes).size).toBe(REQUIRED_CURRENCIES.length)
    expect(getCurrency(DEFAULT_CURRENCY_CODE)?.code).toBe(DEFAULT_CURRENCY_CODE)
  })

  it('provides usable display metadata for every built-in currency', () => {
    for (const currency of CURRENCIES) {
      expect(currency.name.trim(), currency.code).not.toBe('')
      expect(currency.symbol.trim(), currency.code).not.toBe('')
      expect(Number.isInteger(currency.decimalPlaces), currency.code).toBe(true)
      expect(currency.decimalPlaces, currency.code).toBeGreaterThanOrEqual(0)
      expect(currency.decimalPlaces, currency.code).toBeLessThanOrEqual(4)
      expect(['before', 'after'], currency.code).toContain(currency.symbolPosition)
      expect(currency.decimalSeparator.length, currency.code).toBeGreaterThan(0)
      expect(currency.thousandsSeparator, currency.code).not.toBe(currency.decimalSeparator)
    }
  })

  it('uses the requested zero and three decimal places', () => {
    for (const code of ['UGX', 'JPY', 'KRW', 'RWF', 'XOF', 'XAF']) {
      expect(getCurrency(code)?.decimalPlaces, code).toBe(0)
    }
    for (const code of ['KWD', 'BHD', 'OMR', 'JOD']) {
      expect(getCurrency(code)?.decimalPlaces, code).toBe(3)
    }
  })
})

describe('integer minor-unit money', () => {
  it('formats amounts with grouping and the configured currency data', () => {
    const ngn = getCurrency('NGN')!
    expect(formatMoney(123456789n, ngn)).toBe(`${ngn.symbol}1,234,567.89`)

    const eur = getCurrency('EUR')!
    expect(formatMoney(123456n, eur)).toBe(`1.234,56 ${eur.symbol}`)
  })

  it('formats before and after the symbol and supports independent separators', () => {
    const ngn = getCurrency('NGN')!
    expect(formatMoney(123450n, ngn)).toBe(`${ngn.symbol}1,234.50`)
    expect(formatMoney(123450n, ngn, {
      amountDisplay: 'symbol',
      symbolPosition: 'after',
      thousandsSeparator: ' ',
      decimalSeparator: ',',
    })).toBe(`1 234,50 ${ngn.symbol}`)
  })

  it('supports ISO code display and zero-decimal currencies', () => {
    const ngn = getCurrency('NGN')!
    expect(formatMoney(123456n, ngn, {
      amountDisplay: 'code',
      symbolPosition: 'before',
      thousandsSeparator: ',',
      decimalSeparator: '.',
    })).toBe('NGN 1,234.56')

    const jpy = getCurrency('JPY')!
    expect(formatMoney(123456n, jpy)).toBe(`${jpy.symbol}123,456`)
  })

  it('formats negatives with a true minus sign without losing integer precision', () => {
    const ngn = getCurrency('NGN')!
    expect(formatMoney(-9007199254740993n, ngn)).toBe(`−${ngn.symbol}90,071,992,547,409.93`)
  })

  it('parses decimal strings into integer minor units with half-up rounding', () => {
    expect(decimalToMinor('1234.50', 2)).toBe(123450n)
    expect(decimalToMinor('1.234', 2)).toBe(123n)
    expect(decimalToMinor('1.235', 2)).toBe(124n)
    expect(decimalToMinor('-1.235', 2)).toBe(-124n)
    expect(decimalToMinor('0.5', 0)).toBe(1n)
    expect(decimalToMinor('0.499', 0)).toBe(0n)
    expect(decimalToMinor('90071992547409.93', 2)).toBe(9007199254740993n)
  })

  it('supports NGN, JPY and KWD precision in parsing and formatting', () => {
    const ngn = getCurrency('NGN')!
    const jpy = getCurrency('JPY')!
    const kwd = getCurrency('KWD')!
    expect(parseMoney(`${ngn.symbol}1,234.56`, ngn)).toBe(123456n)
    expect(formatMoney(1234n, jpy)).toBe(`${jpy.symbol}1,234`)
    expect(parseMoney(`1,234.567 ${kwd.symbol}`, kwd)).toBe(1234567n)
    expect(formatMoney(1234567n, kwd)).toBe(`1,234.567 ${kwd.symbol}`)
  })

  it('formats, parses and rounds every built-in currency through its own separators, symbol side and precision', () => {
    // The brief asks for formatting and parsing to be proved for *every* built-in currency, not a sample. Sweeping
    // the catalogue means a typo in one row — a thousand separator equal to the decimal one, a symbol on the wrong
    // side, a three-decimal currency catalogued as two — fails here rather than at a customer's till.
    for (const currency of CURRENCIES) {
      const scale = 10n ** BigInt(currency.decimalPlaces)
      // A round amount with digits either side of both separators, so grouping is exercised.
      const amount = 1_234_567n * scale + 89n
      const formatted = formatMoney(amount, currency)

      // The symbol is present, on the requested side, and never mixed with the separators or ISO code.
      expect(formatted, currency.code).toContain(currency.symbol)
      if (currency.symbolPosition === 'before') {
        expect(formatted.startsWith(currency.symbol), `${currency.code}: ${formatted}`).toBe(true)
      } else {
        expect(formatted.endsWith(currency.symbol), `${currency.code}: ${formatted}`).toBe(true)
      }
      // Where the symbol is its own ISO code (SSP, for one), that text is expected and correct.
      if (currency.symbol !== currency.code) expect(formatted, currency.code).not.toContain(currency.code)

      // Grouping really happened: the thousands separator appears, and the decimal part has exactly the
      // currency's number of places and nothing else.
      expect(formatted, currency.code).toContain(currency.thousandsSeparator)
      // A currency shown after the amount may be separated from it by a space ("1.234,56 €"), which the
      // formatter is entitled to add; trim it so the digits alone are measured.
      const digits = (currency.symbolPosition === 'before'
        ? formatted.slice(currency.symbol.length)
        : formatted.slice(0, -currency.symbol.length)).trim()
      const parts = digits.split(currency.decimalSeparator)
      const whole = parts[0] ?? ''
      const fraction = parts[1]
      expect(parts.length, `${currency.code}: ${formatted}`).toBe(currency.decimalPlaces === 0 ? 1 : 2)
      expect(whole.split(currency.thousandsSeparator).join(''), `${currency.code}: ${formatted}`).toMatch(/^\d+$/u)
      expect(whole, currency.code).not.toBe(whole.split(currency.thousandsSeparator).join(''))
      if (currency.decimalPlaces === 0) {
        expect(fraction, `${currency.code} must have no decimal part`).toBeUndefined()
      } else {
        expect(fraction, currency.code).toBe('89'.padStart(currency.decimalPlaces, '0'))
      }

      // The formatted text parses back to the exact same integer minor units, which is the whole promise of the
      // minor-unit model: what the customer sees is what the ledger holds.
      expect(parseMoney(formatted, currency), `${currency.code}: ${formatted}`).toBe(amount)
      expect(parseMoneyExact(formatted, currency), `${currency.code}: ${formatted}`).toBe(amount)
      // The canonical decimal string carries the same digits, so an export or a receipt body cannot drift from it.
      expect(fromMinor(amount, currency).replace('.', currency.decimalSeparator), currency.code).toBe(
        `${whole.split(currency.thousandsSeparator).join('')}${currency.decimalPlaces === 0 ? '' : `${currency.decimalSeparator}${fraction}`}`,
      )

      // Negative amounts keep a true minus sign in front of the whole thing, never inside it.
      const negative = formatMoney(-amount, currency)
      // A real minus sign (U+2212), placed outside the symbol so the symbol still reads on its own side.
      expect(negative.startsWith('\u2212'), `${currency.code}: ${negative}`).toBe(true)
      expect(negative.slice(1), `${currency.code}: ${negative}`).toBe(formatted)
      expect(parseMoney(negative, currency), currency.code).toBe(-amount)

      // Half-up rounding at the currency's own precision: adding half a minor unit rounds away from zero.
      expect(roundHalfUp(amount * 10n + 5n, 10n), currency.code).toBe(amount + 1n)
      expect(roundHalfUp(-(amount * 10n + 5n), 10n), currency.code).toBe(-(amount + 1n))
      expect(roundHalfUp(amount * 10n + 4n, 10n), currency.code).toBe(amount)

      // Arithmetic never leaves integer minor units.
      const doubled = applyRateHalfUp(amount, 2_000n, 1_000n)
      expect(doubled, currency.code).toBe(amount * 2n)
      // And a rate that does not divide evenly still rounds half up, exactly once.
      expect(applyRateHalfUp(10n, 1n, 4n), currency.code).toBe(3n)
    }
  })

  it('parses using configured separators and round-trips canonical decimal strings', () => {
    const ngn = getCurrency('NGN')!
    const eur = getCurrency('EUR')!
    expect(parseMoney('1.234,56 ' + eur.symbol, eur)).toBe(123456n)
    expect(toMinor('12.34', ngn)).toBe(1234n)
    expect(fromMinor(1234n, ngn)).toBe('12.34')
    expect(fromMinor(-12n, getCurrency('JPY')!)).toBe('-12')
    expect(() => parseMoney('not a number', ngn)).toThrow(/valid amount/i)
  })

  it('parses exact prices in shop or plain separators and rejects excess precision', () => {
    const ngn = getCurrency('NGN')!
    const eur = getCurrency('EUR')!
    const jpy = getCurrency('JPY')!
    const kwd = getCurrency('KWD')!
    expect(parseMoneyExact('₦1,234.56', ngn)).toBe(123456n)
    expect(parseMoneyExact('1234.56', eur)).toBe(123456n)
    expect(parseMoneyExact('1.234,56 €', eur)).toBe(123456n)
    expect(parseMoneyExact('1,234.567', kwd)).toBe(1234567n)
    expect(parseMoneyExact('1234.567', kwd)).toBe(1234567n)
    expect(parseMoneyExact('1234', jpy)).toBe(1234n)
    expect(() => parseMoneyExact('12.345', ngn)).toThrow(/at most 2 decimal places/i)
    expect(() => parseMoneyExact('12.0', jpy)).toThrow(/at most 0 decimal places/i)
    expect(() => parseMoneyExact('1.2345', kwd)).toThrow(/at most 3 decimal places/i)
  })

  it('applies taxes and discounts with exact integer half-up arithmetic', () => {
    expect(roundHalfUp(5n, 2n)).toBe(3n)
    expect(roundHalfUp(-5n, 2n)).toBe(-3n)
    expect(applyRateHalfUp(101n, 1n, 2n)).toBe(51n)
    expect(applyRateHalfUp(10001n, 750n, 10000n)).toBe(750n)
    expect(() => roundHalfUp(1n, 0n)).toThrow(/denominator/i)
    expect(() => applyRateHalfUp(1n, -1n, 2n)).toThrow(/rate/i)
  })

  it('provides a host-side currency lock guard', () => {
    expect(() => assertCurrencyChangeAllowed({ isCurrencyLocked: () => false })).not.toThrow()
    expect(() => assertCurrencyChangeAllowed({ isCurrencyLocked: () => true })).toThrow(/locked/i)
  })

  it('rejects invalid amounts, decimal settings and ambiguous separators', () => {
    expect(() => decimalToMinor('1,25', 2)).toThrow(/valid amount/i)
    expect(() => decimalToMinor('1.2.3', 2)).toThrow(/valid amount/i)
    expect(() => decimalToMinor('1', 5)).toThrow(/decimal places/i)
    expect(() => formatMoney(100n, getCurrency('NGN')!, {
      amountDisplay: 'symbol',
      symbolPosition: 'before',
      thousandsSeparator: ',',
      decimalSeparator: ',',
    })).toThrow(/different/i)
  })
})
