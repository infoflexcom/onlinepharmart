export type SymbolPosition = 'before' | 'after'
export type AmountDisplay = 'symbol' | 'code'

export interface CurrencyDefinition {
  code: string
  name: string
  symbol: string
  decimalPlaces: number
  symbolPosition: SymbolPosition
  thousandsSeparator: string
  decimalSeparator: string
  kind: 'iso' | 'custom'
}

const western = { thousandsSeparator: ',', decimalSeparator: '.' } as const
const european = { thousandsSeparator: '.', decimalSeparator: ',' } as const
const francZone = { thousandsSeparator: '\u202f', decimalSeparator: ',' } as const

/** Built-in ISO 4217 choices. Currency display settings are copied into shop settings. */
export const CURRENCIES: readonly CurrencyDefinition[] = [
  { code: 'NGN', name: 'Nigerian naira', symbol: '₦', decimalPlaces: 2, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'USD', name: 'US dollar', symbol: '$', decimalPlaces: 2, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'EUR', name: 'Euro', symbol: '€', decimalPlaces: 2, symbolPosition: 'after', ...european, kind: 'iso' },
  { code: 'GBP', name: 'British pound', symbol: '£', decimalPlaces: 2, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'GHS', name: 'Ghanaian cedi', symbol: 'GH₵', decimalPlaces: 2, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'KES', name: 'Kenyan shilling', symbol: 'KSh', decimalPlaces: 2, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'ZAR', name: 'South African rand', symbol: 'R', decimalPlaces: 2, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'XOF', name: 'West African CFA franc', symbol: 'CFA', decimalPlaces: 0, symbolPosition: 'after', ...francZone, kind: 'iso' },
  { code: 'XAF', name: 'Central African CFA franc', symbol: 'FCFA', decimalPlaces: 0, symbolPosition: 'after', ...francZone, kind: 'iso' },
  { code: 'UGX', name: 'Ugandan shilling', symbol: 'USh', decimalPlaces: 0, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'TZS', name: 'Tanzanian shilling', symbol: 'TSh', decimalPlaces: 2, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'RWF', name: 'Rwandan franc', symbol: 'FRw', decimalPlaces: 0, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'ETB', name: 'Ethiopian birr', symbol: 'Br', decimalPlaces: 2, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'EGP', name: 'Egyptian pound', symbol: 'E£', decimalPlaces: 2, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'MAD', name: 'Moroccan dirham', symbol: 'د.م.', decimalPlaces: 2, symbolPosition: 'after', ...western, kind: 'iso' },
  { code: 'TND', name: 'Tunisian dinar', symbol: 'د.ت', decimalPlaces: 3, symbolPosition: 'after', ...western, kind: 'iso' },
  { code: 'DZD', name: 'Algerian dinar', symbol: 'د.ج', decimalPlaces: 2, symbolPosition: 'after', ...western, kind: 'iso' },
  { code: 'ZMW', name: 'Zambian kwacha', symbol: 'ZK', decimalPlaces: 2, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'MWK', name: 'Malawian kwacha', symbol: 'MK', decimalPlaces: 2, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'BWP', name: 'Botswana pula', symbol: 'P', decimalPlaces: 2, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'NAD', name: 'Namibian dollar', symbol: 'N$', decimalPlaces: 2, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'MZN', name: 'Mozambican metical', symbol: 'MT', decimalPlaces: 2, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'AOA', name: 'Angolan kwanza', symbol: 'Kz', decimalPlaces: 2, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'GMD', name: 'Gambian dalasi', symbol: 'D', decimalPlaces: 2, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'SLE', name: 'Sierra Leonean leone', symbol: 'Le', decimalPlaces: 2, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'LRD', name: 'Liberian dollar', symbol: 'L$', decimalPlaces: 2, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'CDF', name: 'Congolese franc', symbol: 'FC', decimalPlaces: 2, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'SDG', name: 'Sudanese pound', symbol: 'ج.س.', decimalPlaces: 2, symbolPosition: 'after', ...western, kind: 'iso' },
  { code: 'SSP', name: 'South Sudanese pound', symbol: 'SSP', decimalPlaces: 2, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'CAD', name: 'Canadian dollar', symbol: 'C$', decimalPlaces: 2, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'AUD', name: 'Australian dollar', symbol: 'A$', decimalPlaces: 2, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'NZD', name: 'New Zealand dollar', symbol: 'NZ$', decimalPlaces: 2, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'INR', name: 'Indian rupee', symbol: '₹', decimalPlaces: 2, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'PKR', name: 'Pakistani rupee', symbol: '₨', decimalPlaces: 2, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'BDT', name: 'Bangladeshi taka', symbol: '৳', decimalPlaces: 2, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'LKR', name: 'Sri Lankan rupee', symbol: 'Rs', decimalPlaces: 2, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'AED', name: 'UAE dirham', symbol: 'د.إ', decimalPlaces: 2, symbolPosition: 'after', ...western, kind: 'iso' },
  { code: 'SAR', name: 'Saudi riyal', symbol: 'ر.س', decimalPlaces: 2, symbolPosition: 'after', ...western, kind: 'iso' },
  { code: 'QAR', name: 'Qatari riyal', symbol: 'ر.ق', decimalPlaces: 2, symbolPosition: 'after', ...western, kind: 'iso' },
  { code: 'KWD', name: 'Kuwaiti dinar', symbol: 'د.ك', decimalPlaces: 3, symbolPosition: 'after', ...western, kind: 'iso' },
  { code: 'BHD', name: 'Bahraini dinar', symbol: 'د.ب', decimalPlaces: 3, symbolPosition: 'after', ...western, kind: 'iso' },
  { code: 'OMR', name: 'Omani rial', symbol: 'ر.ع.', decimalPlaces: 3, symbolPosition: 'after', ...western, kind: 'iso' },
  { code: 'JOD', name: 'Jordanian dinar', symbol: 'د.ا', decimalPlaces: 3, symbolPosition: 'after', ...western, kind: 'iso' },
  { code: 'TRY', name: 'Turkish lira', symbol: '₺', decimalPlaces: 2, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'CNY', name: 'Chinese yuan', symbol: '¥', decimalPlaces: 2, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'JPY', name: 'Japanese yen', symbol: '¥', decimalPlaces: 0, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'KRW', name: 'South Korean won', symbol: '₩', decimalPlaces: 0, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'SGD', name: 'Singapore dollar', symbol: 'S$', decimalPlaces: 2, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'MYR', name: 'Malaysian ringgit', symbol: 'RM', decimalPlaces: 2, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'IDR', name: 'Indonesian rupiah', symbol: 'Rp', decimalPlaces: 2, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'PHP', name: 'Philippine peso', symbol: '₱', decimalPlaces: 2, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'THB', name: 'Thai baht', symbol: '฿', decimalPlaces: 2, symbolPosition: 'before', ...western, kind: 'iso' },
  { code: 'BRL', name: 'Brazilian real', symbol: 'R$', decimalPlaces: 2, symbolPosition: 'before', ...european, kind: 'iso' },
  { code: 'MXN', name: 'Mexican peso', symbol: '$', decimalPlaces: 2, symbolPosition: 'before', ...western, kind: 'iso' },
] as const satisfies readonly CurrencyDefinition[]

export const DEFAULT_CURRENCY_CODE = 'NGN'
export const CUSTOM_CURRENCY_OPTION = 'CUSTOM'

const currencyByCode = new Map(CURRENCIES.map((currency) => [currency.code, currency]))

export function getCurrency(code: string): CurrencyDefinition | undefined {
  return currencyByCode.get(code.toUpperCase())
}

export interface CustomCurrencyInput {
  code: string
  name: string
  symbol: string
  decimalPlaces: number
  symbolPosition?: SymbolPosition
  thousandsSeparator?: string
  decimalSeparator?: string
}

export function createCustomCurrency(input: CustomCurrencyInput): CurrencyDefinition {
  const code = input.code.trim().toUpperCase()
  const name = input.name.trim()
  const symbol = input.symbol.trim()
  if (!/^[A-Z][A-Z0-9]{1,7}$/.test(code) || code === CUSTOM_CURRENCY_OPTION) {
    throw new Error('Enter a custom currency code using 2–8 letters or numbers.')
  }
  if (currencyByCode.has(code)) {
    throw new Error('That code is already an ISO currency. Choose it from the currency list instead.')
  }
  if (!name) throw new Error('Enter a name for the custom currency.')
  if (name.length > 80) throw new Error('Custom currency name must be 80 characters or fewer.')
  if (!symbol) throw new Error('Enter a symbol for the custom currency.')
  if (symbol.length > 12) throw new Error('Custom currency symbol must be 12 characters or fewer.')
  if (input.symbolPosition !== undefined && input.symbolPosition !== 'before' && input.symbolPosition !== 'after') {
    throw new Error('Choose whether the currency label appears before or after the amount.')
  }
  if (!Number.isInteger(input.decimalPlaces) || input.decimalPlaces < 0 || input.decimalPlaces > 4) {
    throw new Error('Custom currencies must use between 0 and 4 decimal places.')
  }
  const thousandsSeparator = input.thousandsSeparator ?? western.thousandsSeparator
  const decimalSeparator = input.decimalSeparator ?? western.decimalSeparator
  validateSeparators(thousandsSeparator, decimalSeparator)

  return {
    code,
    name,
    symbol,
    decimalPlaces: input.decimalPlaces,
    symbolPosition: input.symbolPosition ?? 'before',
    thousandsSeparator,
    decimalSeparator,
    kind: 'custom',
  }
}

export function validateSeparators(thousandsSeparator: string, decimalSeparator: string): void {
  if (thousandsSeparator.length > 3 || decimalSeparator.length < 1 || decimalSeparator.length > 3) {
    throw new Error('Separators must be one to three characters (the thousands separator may be blank).')
  }
  if (thousandsSeparator !== '' && thousandsSeparator === decimalSeparator) {
    throw new Error('The thousands and decimal separators must be different.')
  }
}
