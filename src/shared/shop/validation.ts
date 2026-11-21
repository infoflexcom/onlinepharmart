import type { MoneyDisplayOptions } from '../currency/money'
import { validateSeparators } from '../currency/catalog'
import { PAYMENT_METHOD_SETTINGS, type OperationalSettings, type ShopProfile } from './types'

export function normalizeShopProfile(profile: ShopProfile): ShopProfile {
  if (!profile || typeof profile !== 'object') throw new Error('Enter the store details.')
  for (const key of ['name', 'address', 'phone'] as const) {
    if (typeof profile[key] !== 'string') throw new Error(`Enter a valid store ${key}.`)
  }
  const normalized: ShopProfile = {
    name: profile.name.trim(),
    address: profile.address.trim(),
    phone: profile.phone.trim(),
    email: optionalText(profile.email, 'email'),
    licenceNumber: optionalText(profile.licenceNumber, 'licence number'),
    taxNumber: optionalText(profile.taxNumber, 'tax number'),
    storeLogo: profile.storeLogo ?? null,
    receiptFooter: optionalText(profile.receiptFooter, 'receipt footer'),
    thankYouNote: optionalText(profile.thankYouNote, 'thank-you note'),
  }
  if (!normalized.name) throw new Error('Enter your store name; it is required on customer documents.')
  if (normalized.name.length > 120) throw new Error('Store name must be 120 characters or fewer.')
  if (normalized.address.length > 240) throw new Error('Store address must be 240 characters or fewer.')
  if (normalized.phone.length > 160) throw new Error('Store phone number(s) must be 160 characters or fewer.')
  if (normalized.email && (normalized.email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized.email))) {
    throw new Error('Enter a valid store email address.')
  }
  if (normalized.licenceNumber && normalized.licenceNumber.length > 100) throw new Error('Licence number must be 100 characters or fewer.')
  if (normalized.taxNumber && normalized.taxNumber.length > 100) throw new Error('Tax number must be 100 characters or fewer.')
  if (normalized.receiptFooter && normalized.receiptFooter.length > 300) throw new Error('Receipt footer must be 300 characters or fewer.')
  if (normalized.thankYouNote && normalized.thankYouNote.length > 200) throw new Error('Thank-you note must be 200 characters or fewer.')
  if (normalized.storeLogo !== null && typeof normalized.storeLogo !== 'string') throw new Error('Choose a valid store logo image.')
  if (normalized.storeLogo && (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(normalized.storeLogo) || normalized.storeLogo.length > 1_400_000)) {
    throw new Error('Choose a PNG, JPEG, or WebP store logo smaller than 1 MB.')
  }
  return normalized
}

export function validateMoneyDisplay(display: MoneyDisplayOptions): void {
  if (!display || typeof display !== 'object') throw new Error('Choose valid currency display settings.')
  if (display.amountDisplay !== 'symbol' && display.amountDisplay !== 'code') {
    throw new Error('Choose whether to display the currency symbol or ISO code.')
  }
  if (display.symbolPosition !== 'before' && display.symbolPosition !== 'after') {
    throw new Error('Choose whether the currency label appears before or after the amount.')
  }
  if (typeof display.thousandsSeparator !== 'string' || typeof display.decimalSeparator !== 'string') {
    throw new Error('Choose valid currency separators.')
  }
  validateSeparators(display.thousandsSeparator, display.decimalSeparator)
}

function optionalText(value: unknown, label: string): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new Error(`Enter valid ${label} text.`)
  return value.trim()
}

const DOCUMENT_LAYOUTS = ['THERMAL_80', 'THERMAL_58', 'A4_RECEIPT'] as const

export function normalizeOperationalSettings(input: OperationalSettings): OperationalSettings {
  if (!input || typeof input !== 'object') throw new Error('Choose valid receipt settings.')
  const layout = input.documentLayout
  if (!DOCUMENT_LAYOUTS.includes(layout)) throw new Error('Choose a valid receipt paper size.')
  if (!Array.isArray(input.enabledPaymentMethods)) throw new Error('Choose the payment methods you accept.')
  const methods = [...new Set(input.enabledPaymentMethods)]
  if (methods.length === 0) throw new Error('Keep at least one payment method switched on.')
  for (const method of methods) {
    if (!PAYMENT_METHOD_SETTINGS.includes(method)) throw new Error('Choose a valid payment method.')
  }
  const methodsInOrder = PAYMENT_METHOD_SETTINGS.filter((method) => methods.includes(method))
  if (typeof input.printerName !== 'string' || input.printerName.trim().length > 120) {
    throw new Error('Choose a valid printer name.')
  }
  if (typeof input.scalePort !== 'string' || input.scalePort.trim().length > 120) {
    throw new Error('Enter a valid scale connection.')
  }
  return {
    showPoweredBy: booleanSetting(input.showPoweredBy, 'show the Infoflex label'),
    documentLayout: layout,
    vatEnabled: booleanSetting(input.vatEnabled, 'switch VAT on or off'),
    vatRateBasisPoints: basisPoints(input.vatRateBasisPoints, 'VAT rate', 0, 10_000),
    vatInclusive: booleanSetting(input.vatInclusive, 'choose whether prices include VAT'),
    discountLimitBasisPoints: basisPoints(input.discountLimitBasisPoints, 'discount limit', 0, 10_000),
    printerName: input.printerName.trim(),
    enabledPaymentMethods: [...methodsInOrder],
    expiryAlertDays: integerInRange(input.expiryAlertDays, 'expiry alert days', 1, 3_650),
    loyaltyRateBasisPoints: basisPoints(input.loyaltyRateBasisPoints, 'loyalty rate', 0, 10_000),
    supervisorPinRequired: booleanSetting(input.supervisorPinRequired, 'choose supervisor PIN rules'),
    supervisorPinLength: integerInRange(input.supervisorPinLength, 'supervisor PIN length', 4, 8),
    scaleEnabled: booleanSetting(input.scaleEnabled, 'switch the scale on or off'),
    scalePort: input.scalePort.trim(),
  }
}

function booleanSetting(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Choose whether to ${label}.`)
  return value
}

function basisPoints(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Enter ${label} between 0 and ${max / 100}%.`)
  }
  return value
}

function integerInRange(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Enter ${label} between ${min} and ${max}.`)
  }
  return value
}
