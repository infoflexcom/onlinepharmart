import type { AmountDisplay, CurrencyDefinition, SymbolPosition } from './catalog'
import { validateSeparators } from './catalog'

export interface MoneyDisplayOptions {
  amountDisplay: AmountDisplay
  symbolPosition: SymbolPosition
  thousandsSeparator: string
  decimalSeparator: string
}

export function defaultDisplayOptions(currency: CurrencyDefinition): MoneyDisplayOptions {
  return {
    amountDisplay: 'symbol',
    symbolPosition: currency.symbolPosition,
    thousandsSeparator: currency.thousandsSeparator,
    decimalSeparator: currency.decimalSeparator,
  }
}

/** Format integer minor units without converting money to a floating-point number. */
export function formatMoney(
  amountMinor: bigint,
  currency: CurrencyDefinition,
  options: MoneyDisplayOptions = defaultDisplayOptions(currency),
): string {
  assertDecimalPlaces(currency.decimalPlaces)
  validateSeparators(options.thousandsSeparator, options.decimalSeparator)

  const negative = amountMinor < 0n
  const magnitude = negative ? -amountMinor : amountMinor
  const scale = 10n ** BigInt(currency.decimalPlaces)
  const whole = magnitude / scale
  const fraction = magnitude % scale
  const groupedWhole = groupThousands(whole.toString(), options.thousandsSeparator)
  const numeric = currency.decimalPlaces === 0
    ? groupedWhole
    : `${groupedWhole}${options.decimalSeparator}${fraction.toString().padStart(currency.decimalPlaces, '0')}`
  const token = options.amountDisplay === 'code' ? currency.code : currency.symbol
  const formatted = formatToken(numeric, token, options.symbolPosition)
  return negative ? `−${formatted}` : formatted
}

function groupThousands(digits: string, separator: string): string {
  if (!separator) return digits
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, separator)
}

function formatToken(numeric: string, token: string, position: SymbolPosition): string {
  if (position === 'after') return `${numeric} ${token}`
  // ISO codes and alphabetic symbols read more clearly with a space; common glyph symbols do not.
  const needsSpace = /^[\p{L}]{2,}/u.test(token)
  return `${token}${needsSpace ? ' ' : ''}${numeric}`
}

/** Parse a plain decimal string into minor units using round-half-up, never Number(). */
export function decimalToMinor(input: string, decimalPlaces: number): bigint {
  assertDecimalPlaces(decimalPlaces)
  const value = input.trim()
  const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(value)
  if (!match) throw new Error('Enter a valid amount using digits and a decimal point.')

  const negative = match[1] === '-'
  const whole = BigInt(match[2])
  const fraction = match[3] ?? ''
  const scale = 10n ** BigInt(decimalPlaces)
  const kept = fraction.slice(0, decimalPlaces).padEnd(decimalPlaces, '0')
  let minor = whole * scale + (kept ? BigInt(kept) : 0n)

  if (fraction.length > decimalPlaces && fraction.charCodeAt(decimalPlaces) >= 53) {
    minor += 1n
  }
  return negative && minor !== 0n ? -minor : minor
}

/** Round a rational quantity to an integer, with exact half values rounded away from zero. */
export function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('The denominator must be a positive integer.')
  const negative = numerator < 0n
  const magnitude = negative ? -numerator : numerator
  const rounded = (magnitude + denominator / 2n) / denominator
  return negative ? -rounded : rounded
}

/** Apply a rational rate to minor units (for example 750 basis points as 750 / 10,000). */
export function applyRateHalfUp(amountMinor: bigint, rateNumerator: bigint, rateDenominator: bigint): bigint {
  if (rateNumerator < 0n) throw new Error('The rate cannot be negative.')
  if (rateDenominator <= 0n) throw new Error('The rate denominator must be positive.')
  return roundHalfUp(amountMinor * rateNumerator, rateDenominator)
}

function assertDecimalPlaces(decimalPlaces: number): void {
  if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 4) {
    throw new Error('Currency decimal places must be an integer from 0 to 4.')
  }
}
