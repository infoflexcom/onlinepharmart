import type { CurrencyDefinition } from './catalog'
import { decimalToMinor, defaultDisplayOptions, type MoneyDisplayOptions } from './money'

/** Parse a user-entered amount using the selected shop currency's separators and precision. */
export function parseMoney(
  text: string,
  currency: CurrencyDefinition,
  options: MoneyDisplayOptions = defaultDisplayOptions(currency),
): bigint {
  let normalized = stripCurrencyToken(text, currency)
  if (options.thousandsSeparator) normalized = normalized.split(options.thousandsSeparator).join('')
  normalized = normalized.replace(/[\s\u00a0\u202f]/gu, '')
  if (options.decimalSeparator !== '.') {
    if (normalized.split(options.decimalSeparator).length > 2) {
      throw new Error('Enter a valid amount with one decimal separator.')
    }
    normalized = normalized.split(options.decimalSeparator).join('.')
  }
  return decimalToMinor(normalized, currency.decimalPlaces)
}

/** Parse a price exactly; unlike parseMoney, this refuses rounding past the currency precision. */
export function parseMoneyExact(
  text: string,
  currency: CurrencyDefinition,
  options: MoneyDisplayOptions = defaultDisplayOptions(currency),
): bigint {
  let normalized = stripCurrencyToken(text, currency)
  const localDecimal = options.decimalSeparator
  const usesLocalDecimal = Boolean(localDecimal && normalized.includes(localDecimal))
  const decimalSeparator = usesLocalDecimal
    ? localDecimal
    : localDecimal !== '.' && normalized.includes('.') ? '.' : null

  if (options.thousandsSeparator && options.thousandsSeparator !== decimalSeparator) {
    normalized = normalized.split(options.thousandsSeparator).join('')
  }
  normalized = normalized.replace(/[\s\u00a0\u202f]/gu, '')
  if (decimalSeparator && decimalSeparator !== '.') {
    if (normalized.split(decimalSeparator).length > 2) throw new Error('Enter a valid amount with one decimal separator.')
    normalized = normalized.split(decimalSeparator).join('.')
  }
  const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(normalized)
  if (!match) throw new Error('Enter a valid amount using the shop currency separators or a plain decimal number.')
  const fraction = match[3] ?? ''
  if (fraction.length > currency.decimalPlaces) {
    throw new Error(`This currency allows at most ${currency.decimalPlaces} decimal places.`)
  }
  return decimalToMinor(normalized, currency.decimalPlaces)
}

function stripCurrencyToken(text: string, currency: CurrencyDefinition): string {
  if (typeof text !== 'string') throw new Error('Enter a valid amount.')
  let normalized = text.trim()
  if (!normalized) throw new Error('Enter an amount.')
  for (const token of [currency.code, currency.symbol]) {
    if (!token) continue
    const upper = normalized.toUpperCase()
    const upperToken = token.toUpperCase()
    if (upper.startsWith(upperToken)) normalized = normalized.slice(token.length)
    else if (upper.endsWith(upperToken)) normalized = normalized.slice(0, -token.length)
  }
  return normalized.trim()
}

/** Parse an ungrouped decimal string into exact integer minor units. */
export function toMinor(majorAmount: string, currency: CurrencyDefinition): bigint {
  return decimalToMinor(majorAmount, currency.decimalPlaces)
}

/** Convert integer minor units to a canonical decimal string, without grouping or a symbol. */
export function fromMinor(minorUnits: bigint, currency: CurrencyDefinition): string {
  if (!Number.isInteger(currency.decimalPlaces) || currency.decimalPlaces < 0 || currency.decimalPlaces > 4) {
    throw new Error('Currency decimal places must be an integer from 0 to 4.')
  }
  const negative = minorUnits < 0n
  const magnitude = negative ? -minorUnits : minorUnits
  const scale = 10n ** BigInt(currency.decimalPlaces)
  const whole = magnitude / scale
  if (currency.decimalPlaces === 0) return `${negative ? '-' : ''}${whole}`
  const fraction = (magnitude % scale).toString().padStart(currency.decimalPlaces, '0')
  return `${negative ? '-' : ''}${whole}.${fraction}`
}
