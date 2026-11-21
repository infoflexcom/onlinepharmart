import { formatMoney } from '../currency/money'
import type { ReceiptLayout, PosReceiptRecord } from './types'

/** Thermal printers commonly lack glyphs for currency-specific symbols; ISO codes are reliable. */
export function usesIsoCodeFallback(receipt: PosReceiptRecord, layout: ReceiptLayout): boolean {
  if (layout !== 'THERMAL_80' && layout !== 'THERMAL_58') return false
  return !/^[\x20-\x7e]+$/u.test(receipt.currency.symbol)
}

export function formatReceiptMoney(receipt: PosReceiptRecord, amountMinor: bigint, layout: ReceiptLayout): string {
  const display = usesIsoCodeFallback(receipt, layout)
    ? { ...receipt.display, amountDisplay: 'code' as const }
    : receipt.display
  return formatMoney(amountMinor, receipt.currency, display)
}

export function formatPosQuantity(quantityMilli: bigint, unit: string): string {
  const negative = quantityMilli < 0n
  const absolute = negative ? -quantityMilli : quantityMilli
  const whole = absolute / 1000n
  const fraction = (absolute % 1000n).toString().padStart(3, '0').replace(/0+$/u, '')
  const quantity = `${negative ? '−' : ''}${whole}${fraction ? `.${fraction}` : ''}`
  return unit ? `${quantity} ${unit}` : quantity
}
