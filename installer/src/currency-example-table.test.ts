import { describe, expect, it } from 'vitest'
import { CURRENCIES, getCurrency, type CurrencyDefinition } from '../../src/currency/catalog'
import { defaultDisplayOptions } from '../../src/currency/money'
import { currencyExample } from './installer-policy'

/**
 * Every currency, not a sample.
 *
 * The installer's currency page shows a live example so a shopkeeper can see for themselves that the decimals
 * follow their money. If one of the fifty-four is wrong, the shop that uses it is the one that finds out — so the
 * brief asks for per-currency proof rather than three representative examples and a loop that only checks the
 * output is non-empty.
 *
 * This test has two halves, and the second is the reason the first is worth anything:
 *
 *   1. a golden table, written out by hand from what the page must show, so a change in the formatter's output is
 *      a visible edit to this file rather than a silently updated expectation;
 *   2. the same fifty-four re-derived here from the currency's own decimals, separators and symbol position by
 *      code that deliberately shares nothing with `formatMoney` — otherwise the table would only prove the
 *      function agrees with itself.
 */

/** The example the currency page shows, transcribed. */
const GOLDEN: Record<string, string> = {
  "NGN": "₦1,234,567.50",
  "USD": "$1,234,567.50",
  "EUR": "1.234.567,50 €",
  "GBP": "£1,234,567.50",
  "GHS": "GH₵ 1,234,567.50",
  "KES": "KSh 1,234,567.50",
  "ZAR": "R1,234,567.50",
  "XOF": "1 234 568 CFA",
  "XAF": "1 234 568 FCFA",
  "UGX": "USh 1,234,568",
  "TZS": "TSh 1,234,567.50",
  "RWF": "FRw 1,234,568",
  "ETB": "Br 1,234,567.50",
  "EGP": "E£1,234,567.50",
  "MAD": "1,234,567.50 د.م.",
  "TND": "1,234,567.500 د.ت",
  "DZD": "1,234,567.50 د.ج",
  "ZMW": "ZK 1,234,567.50",
  "MWK": "MK 1,234,567.50",
  "BWP": "P1,234,567.50",
  "NAD": "N$1,234,567.50",
  "MZN": "MT 1,234,567.50",
  "AOA": "Kz 1,234,567.50",
  "GMD": "D1,234,567.50",
  "SLE": "Le 1,234,567.50",
  "LRD": "L$1,234,567.50",
  "CDF": "FC 1,234,567.50",
  "SDG": "1,234,567.50 ج.س.",
  "SSP": "SSP 1,234,567.50",
  "CAD": "C$1,234,567.50",
  "AUD": "A$1,234,567.50",
  "NZD": "NZ$ 1,234,567.50",
  "INR": "₹1,234,567.50",
  "PKR": "₨1,234,567.50",
  "BDT": "৳1,234,567.50",
  "LKR": "Rs 1,234,567.50",
  "AED": "1,234,567.50 د.إ",
  "SAR": "1,234,567.50 ر.س",
  "QAR": "1,234,567.50 ر.ق",
  "KWD": "1,234,567.500 د.ك",
  "BHD": "1,234,567.500 د.ب",
  "OMR": "1,234,567.500 ر.ع.",
  "JOD": "1,234,567.500 د.ا",
  "TRY": "₺1,234,567.50",
  "CNY": "¥1,234,567.50",
  "JPY": "¥1,234,568",
  "KRW": "₩1,234,568",
  "SGD": "S$1,234,567.50",
  "MYR": "RM 1,234,567.50",
  "IDR": "Rp 1,234,567.50",
  "PHP": "₱1,234,567.50",
  "THB": "฿1,234,567.50",
  "BRL": "R$1.234.567,50",
  "MXN": "$1,234,567.50",
}

/** The amount the example represents, in this currency's minor units. */
function exampleMinorUnits(currency: CurrencyDefinition): bigint {
  const scale = 10n ** BigInt(currency.decimalPlaces)
  if (currency.decimalPlaces === 0) return 1_234_568n
  return 1_234_567n * scale + 5n * 10n ** BigInt(currency.decimalPlaces - 1)
}

/**
 * An independent rendering, written from the currency's data alone.
 *
 * No `formatMoney`, no `groupThousands`, no `formatToken` — a second implementation, so agreement means something.
 * The space rule is the one judgement it shares with the app: a symbol of two or more letters is separated from
 * the number, because "GH₵ 1,234,567.50" is readable and "GH₵1,234,567.50" looks like a typo.
 */
function renderIndependently(currency: CurrencyDefinition): string {
  const { thousandsSeparator: thousands, decimalSeparator: decimal } = defaultDisplayOptions(currency)
  // The display options carry the separators; the decimal count belongs to the currency itself.
  const places = currency.decimalPlaces
  const digits = exampleMinorUnits(currency).toString()
  const whole = places === 0 ? digits : digits.slice(0, -places)
  const fraction = places === 0 ? '' : digits.slice(-places)

  const groups: string[] = []
  let rest = whole
  while (rest.length > 3) {
    groups.unshift(rest.slice(-3))
    rest = rest.slice(0, -3)
  }
  groups.unshift(rest)

  const numeric = groups.join(thousands) + (places === 0 ? '' : decimal + fraction)
  if (currency.symbolPosition === 'after') return `${numeric} ${currency.symbol}`
  return /^\p{L}{2,}/u.test(currency.symbol) ? `${currency.symbol} ${numeric}` : `${currency.symbol}${numeric}`
}

describe('the live currency example, for every currency rather than a sample', () => {
  it('covers all fifty-four currencies and nothing else', () => {
    expect(Object.keys(GOLDEN).sort()).toEqual(CURRENCIES.map((c) => c.code).sort())
    expect(CURRENCIES).toHaveLength(54)
  })

  it.each(CURRENCIES.map((c) => [c.code, GOLDEN[c.code]] as const))(
    'shows the transcribed example for %s',
    (code, expected) => {
      expect(currencyExample(getCurrency(code)!)).toBe(expected)
    },
  )

  it.each(CURRENCIES.map((c) => [c.code, c] as const))(
    'agrees with an independent rendering for %s',
    (_code, currency) => {
      expect(currencyExample(currency)).toBe(renderIndependently(currency))
    },
  )

  it('uses each currency\'s own decimal count, separators and symbol position', () => {
    // The three shapes the brief names, checked against the data rather than against the output.
    for (const currency of CURRENCIES) {
      const example = currencyExample(currency)
      const options = defaultDisplayOptions(currency)
      if (currency.decimalPlaces === 0) {
        expect(example, `${currency.code} must have no decimal part`).not.toContain(options.decimalSeparator)
      } else {
        const fraction = example.split(options.decimalSeparator).at(1) ?? ''
        expect(fraction.replace(/\D/gu, ''), `${currency.code} decimal count`).toHaveLength(currency.decimalPlaces)
      }
      expect(example, `${currency.code} carries its own symbol`).toContain(currency.symbol)
    }
  })

  it('renders 3-decimal currencies with three decimals and 0-decimal with none', () => {
    for (const code of ['TND', 'KWD', 'BHD', 'OMR', 'JOD']) {
      expect(GOLDEN[code].split('.')[1]?.split(' ')[0], code).toHaveLength(3)
    }
    for (const code of ['XOF', 'XAF', 'UGX', 'RWF', 'JPY', 'KRW']) {
      expect(GOLDEN[code], code).not.toMatch(/\.\d/u)
    }
  })
})
