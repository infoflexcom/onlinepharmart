import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CURRENCIES } from '../../src/currency/catalog'
import { generateCurrencyUiInclude } from './generate-installer-script'

/**
 * The generated dropdown and the index-to-fields mapping.
 *
 * `currency-ui.nsh` is what the currency page actually runs: `FillCurrencyList` puts rows in the dropdown and
 * `SetCurrencyFromIndex` turns the chosen row number back into the seven values the installer carries. Nothing had
 * tested it, and the failure it can produce is quiet and specific: row 7 listed as Ugandan shillings but selecting
 * Ugandan shillings giving Kenyan ones would install a shop with the wrong money, and every other test in this
 * repository would still pass, because the catalogue and the policy would both be right.
 *
 * So this reads the generated include as text — the same artefact makensis consumes — and checks it against the
 * catalogue, row by row.
 */

const INCLUDE = readFileSync('installer/nsis/currency-ui.nsh', 'utf8')

interface Row {
  index: number
  label: string
}

/** The rows `FillCurrencyList` adds, in order. */
function listedRows(): Row[] {
  const rows: Row[] = []
  for (const line of INCLUDE.split('\n')) {
    const match = /\$\{NSD_LB_AddString\} \$CurrencyList "(.*)"$/u.exec(line.trim())
    // `$$` in an NSIS string is one literal dollar, so the label as a person sees it is the unescaped text.
    if (match) rows.push({ index: rows.length, label: match[1]!.replace(/\$\$/gu, '$') })
  }
  return rows
}

interface Arm {
  index: number
  code: string
  name: string
  symbol: string
  decimals: string
  position: string
  thousands: string
  decimal: string
}

/** Every `${If} $R0 == "n"` arm, with the seven values it assigns. */
function mappingArms(): Arm[] {
  const lines = INCLUDE.split('\n')
  const start = lines.findIndex((line) => line.includes('!macro SetCurrencyFromIndex'))
  expect(start, 'SetCurrencyFromIndex must be in the include').toBeGreaterThanOrEqual(0)

  const arms: Arm[] = []
  let current: Partial<Arm> | null = null
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]!.trim()
    if (line.startsWith('!macroend')) break
    const arm = /^\$\{(?:If|ElseIf)\} \$R0 == "(\d+)"$/u.exec(line)
    if (arm) {
      if (current) arms.push(current as Arm)
      current = { index: Number(arm[1]) }
      continue
    }
    // The arms end before the default fallback, which assigns CurrencyCodeOut again. Reading past ${EndIf}
    // would attribute the fallback to the last arm — which is exactly how this test would have reported the
    // wrong currency for row 53 while the include was right.
    if (line === '${EndIf}') { if (current) { arms.push(current as Arm); current = null } continue }
    if (!current) continue
    const copy = /^StrCpy \$(Currency\w+Out) "(.*)"$/u.exec(line)
    if (!copy) continue
    const [, variable, value] = copy
    // NSIS writes $$ for a literal dollar.
    const text = value!.replace(/\$\$/gu, '$')
    if (variable === 'CurrencyCodeOut') current.code = text
    else if (variable === 'CurrencyNameOut') current.name = text
    else if (variable === 'CurrencySymbolOut') current.symbol = text
    else if (variable === 'CurrencyDecimalsOut') current.decimals = text
    else if (variable === 'CurrencyPositionOut') current.position = text
    else if (variable === 'CurrencyThousandsOut') current.thousands = text
    else if (variable === 'CurrencyDecimalOut') current.decimal = text
  }
  if (current) arms.push(current as Arm)
  return arms
}

describe('the generated currency dropdown', () => {
  it('is the file the generator currently produces', () => {
    // If somebody edits the include by hand, this fails until they edit the generator instead.
    expect(INCLUDE).toBe(generateCurrencyUiInclude())
  })

  it('lists a row for every currency and no others', () => {
    const rows = listedRows()
    expect(rows).toHaveLength(CURRENCIES.length)
    expect(rows.map((row) => row.label)).toEqual(CURRENCIES.map((c) => `${c.code} - ${c.name} (${c.symbol})`))
  })

  it('has one mapping arm per row, numbered in the same order', () => {
    const arms = mappingArms()
    expect(arms).toHaveLength(CURRENCIES.length)
    // The arm's index must equal the row's index, or choosing a currency selects a different one.
    arms.forEach((arm, position) => expect(arm.index, `arm ${position}`).toBe(position))
    expect(arms.map((arm) => arm.code)).toEqual(CURRENCIES.map((c) => c.code))
  })

  it.each(CURRENCIES.map((c, index) => [c.code, index, c] as const))(
    'maps row %s to the same seven values the app has',
    (_label, index, currency) => {
      const arm = mappingArms()[index]!
      expect(arm.code).toBe(currency.code)
      expect(arm.name).toBe(currency.name)
      expect(arm.symbol).toBe(currency.symbol)
      expect(arm.decimals).toBe(String(currency.decimalPlaces))
      expect(arm.position).toBe(currency.symbolPosition)
      expect(arm.thousands).toBe(currency.thousandsSeparator)
      expect(arm.decimal).toBe(currency.decimalSeparator)
    },
  )

  it('falls back to the default currency when the index is unknown', () => {
    // A row number that matches no arm must still leave a usable currency, not an empty code.
    const fallback = /\$\{If\} \$CurrencyCodeOut == ""\s*\n\s*StrCpy \$CurrencyCodeOut "(\w+)"/u.exec(INCLUDE)
    expect(fallback, 'SetCurrencyFromIndex must have a default when no arm matches').not.toBeNull()
    expect(fallback![1]).toBe('NGN')
  })

  it('escapes a dollar sign the way NSIS needs, and only for the symbol', () => {
    // "$$" in an NSIS string is one literal dollar. A currency whose *name* contained one would need the same,
    // and today none does — this pins that assumption so adding one later is a visible decision.
    for (const currency of CURRENCIES) {
      if (currency.symbol.includes('$')) expect(currency.name).not.toContain('$')
    }
    const usd = listedRows().find((row) => row.label.startsWith('USD -'))
    expect(usd?.label).toBe('USD - US dollar ($)')
    // And the raw include really does escape it.
    expect(INCLUDE).toContain('USD - US dollar ($$)')
  })
})
