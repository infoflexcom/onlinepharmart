import type { CurrencyDefinition } from '../../src/currency/catalog'
import type { MoneyDisplayOptions } from '../../src/currency/money'
import { defaultDisplayOptions, formatMoney } from '../../src/currency/money'

/**
 * Every amount the phone shows goes through here.
 *
 * The host sends an integer string in minor units plus the shop's currency definition and display options;
 * this module turns that into text with the *same* rules the desktop uses (same rounding of nothing — the
 * value is already an integer — same separators, same symbol position, same "show the ISO code instead"
 * option). There is no currency switch on the phone and no default symbol in this file.
 */

export interface MobileCurrencyContext {
  currency: CurrencyDefinition
  display?: MoneyDisplayOptions
}

export function shopCurrencyContext(currency: CurrencyDefinition, display?: MoneyDisplayOptions): MobileCurrencyContext {
  return { currency, display: display ?? defaultDisplayOptions(currency) }
}

/** Formats an integer minor-unit string. Never accepts a float, so no precision can be invented. */
export function formatMobileMoney(minor: string | null | undefined, context: MobileCurrencyContext): string {
  if (minor === null || minor === undefined || minor === '') return '—'
  const value = parseMinor(minor)
  if (value === null) return '—'
  return formatMoney(value, context.currency, context.display)
}

/** Values that came from a different currency (a historical receipt) format with that sale's currency. */
export function formatMobileMoneyIn(minor: string | null | undefined, currency: CurrencyDefinition, display?: MoneyDisplayOptions): string {
  return formatMobileMoney(minor, shopCurrencyContext(currency, display))
}

/** A signed amount for adjustments and refunds: the minus is the shop's own, never a hard-coded symbol. */
export function formatMobileMoneySigned(minor: string | null | undefined, context: MobileCurrencyContext): string {
  const value = typeof minor === 'string' ? parseMinor(minor) : null
  if (value === null) return '—'
  const text = formatMobileMoney((value < 0n ? -value : value).toString(), context)
  return value < 0n ? `−${text}` : text
}

export function parseMinor(minor: string): bigint | null {
  if (!/^-?\d+$/u.test(minor)) return null
  try {
    return BigInt(minor)
  } catch {
    return null
  }
}

/**
 * Parses an amount the Admin typed on the phone. Accepts the shop's own separators (a Naira shop's comma
 * thousands and dot decimal; a franc-zone shop's space thousands and comma decimal) and rejects more
 * decimal places than the currency allows, so "12.345" cannot silently become 12.34.
 */
export function parseMoneyInput(input: string, context: MobileCurrencyContext): { ok: true; minor: string } | { ok: false; message: string } {
  const { currency } = context
  const raw = input.trim()
  if (raw === '') return { ok: false, message: 'Enter an amount.' }
  // Strip the shop's thousands separator and any ordinary spaces/NBSP a phone keyboard inserts.
  const withoutThousands = currency.thousandsSeparator
    ? raw.split(currency.thousandsSeparator).join('')
    : raw
  const cleaned = withoutThousands.replace(/[\s\u00a0\u202f]/gu, '')
  if (!/^\d*[.,]?\d*$/u.test(cleaned) && !/^\d+(?:[.,]\d+)?$/u.test(cleaned)) {
    return { ok: false, message: 'Enter an amount using digits only.' }
  }
  const parts = cleaned.split(normaliseDecimal(cleaned, currency.decimalSeparator))
  if (parts.length > 2) return { ok: false, message: 'Enter a single amount.' }
  const whole = parts[0] || '0'
  const fraction = parts[1] ?? ''
  if (fraction.length > currency.decimalPlaces) {
    return {
      ok: false,
      message: currency.decimalPlaces === 0
        ? `${currency.name} has no decimal places; enter a whole amount.`
        : `${currency.name} allows ${currency.decimalPlaces} decimal places.`,
    }
  }
  const scale = 10n ** BigInt(currency.decimalPlaces)
  const minor = BigInt(whole) * scale + BigInt(fraction.padEnd(currency.decimalPlaces, '0') || '0')
  if (minor > 9_007_199_254_740_991n) return { ok: false, message: 'That amount is too large.' }
  return { ok: true, minor: minor.toString() }
}

function normaliseDecimal(cleaned: string, separator: string): string {
  // A phone keyboard may not offer the shop's decimal separator; accept either and interpret per the shop.
  if (cleaned.includes(separator)) return separator
  return cleaned.includes(',') ? ',' : '.'
}

/** Quantities are integer thousandths on every screen ("milli"), shown without trailing zeros. */
export function formatQuantity(quantityMilli: string | null | undefined): string {
  if (!quantityMilli) return '0'
  const value = parseMinor(quantityMilli)
  if (value === null) return '0'
  const negative = value < 0n
  const absolute = negative ? -value : value
  const whole = absolute / 1_000n
  const fraction = (absolute % 1_000n).toString().padStart(3, '0').replace(/0+$/u, '')
  return `${negative ? '−' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

/** A percentage from basis points, used for discount limits shown on the cashier list. */
export function formatPercent(basisPoints: number): string {
  if (!Number.isFinite(basisPoints)) return '0%'
  const whole = Math.floor(basisPoints / 100)
  const rest = basisPoints % 100
  return rest === 0 ? `${whole}%` : `${whole}.${String(rest).padStart(2, '0')}%`
}
