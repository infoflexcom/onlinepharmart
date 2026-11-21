import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CURRENCIES, getCurrency, type CurrencyDefinition } from '../../src/currency/catalog'
import { createInstallConfig, parseInstallConfig, serializeInstallConfig } from './install-config'
import { customCurrencyRecordingProblem } from './installer-policy'

/**
 * Does the file the installer hand-writes actually read back?
 *
 * Three programs share `install-config.json`: NSIS writes it, the Electron main process reads it, and the update
 * and repair paths must not touch it. The reader has tests and the writer's TypeScript counterpart has tests, but
 * the *file NSIS emits* had never been parsed by anything — and when it finally was, it was invalid JSON. Two
 * escaping holes had been invisible: `"thousandsSeparator": ","` (a bare comma inside a string) and a missing
 * comma before `"isCustom"`.
 *
 * So this test reconstructs the file from the installer's own `FileWrite` lines and the companion include's
 * `EscapeJson`, then hands the result to the real reader. It is a simulation, not a compile — it cannot prove
 * makensis accepts the script, and `docs/PHASES.md` says so — but it does prove the format the script aims at is
 * the format the app accepts, which is the part that was silently wrong.
 */

const NSIS = 'installer/nsis/installer.nsi'
const ESCAPER = 'installer/nsis/json-escaping.nsh'

/** The installer's `EscapeJson`, transcribed. Must mirror installer/nsis/json-escaping.nsh line for line. */
function escapeJson(value: string): string {
  let out = ''
  for (const character of value) {
    if (character === '"') out += '\\"'
    else if (character === '\\') out += '\\\\'
    else if (character === '\r') continue
    else if (character === '\n') out += '\\n'
    else if (character === '\t') out += '\\t'
    else out += character
  }
  return out
}

const VARS = {
  CurrencyCodeOut: 'CurrencyCodeJson',
  CurrencyNameOut: 'CurrencyNameJson',
  CurrencySymbolOut: 'CurrencySymbolJson',
  CurrencyThousandsOut: 'CurrencyThousandsJson',
  CurrencyDecimalOut: 'CurrencyDecimalJson',
  CurrencyDecimalsOut: 'CurrencyDecimalsOut',
  CurrencyPositionOut: 'CurrencyPositionOut',
  CurrencyIsCustom: 'CurrencyIsCustom',
} as const

/** Rebuilds install-config.json from the script's FileWrite statements for one currency choice. */
function renderInstallConfigFile(currency: CurrencyDefinition, kind: 'online' | 'offline'): string {
  const lines = readFileSync(NSIS, 'utf8').split('\n')
  // Start at the first FileWrite of the block — the opening brace — not at writtenAt, or the rendered
  // file is missing its head and every assertion below fails for the wrong reason.
  const start = lines.findIndex((line) => /^\s*FileWrite \$1 "\{\$\\r\$\\n"/u.test(line))
  expect(start, 'the FileWrite block that writes install-config.json must exist').toBeGreaterThan(0)

  // The escaped copies the script computes with EscapeJson before writing.
  const json: Record<string, string> = {
    CurrencyCodeJson: escapeJson(currency.code),
    CurrencyNameJson: escapeJson(currency.name),
    CurrencySymbolJson: escapeJson(currency.symbol),
    CurrencyThousandsJson: escapeJson(currency.thousandsSeparator),
    CurrencyDecimalJson: escapeJson(currency.decimalSeparator),
  }
  const raw: Record<string, string> = {
    CurrencyDecimalsOut: String(currency.decimalPlaces),
    CurrencyPositionOut: currency.symbolPosition,
    CurrencyIsCustom: currency.kind === 'custom' ? '1' : '0',
  }
  void VARS

  const conditionals: boolean[] = []
  let out = ''
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]!.trim()
    if (line.startsWith('FileClose')) break
    // Two conditionals guard the block: which installer this is, and whether the currency is custom.
    const offlineMatch = /^\$\{If\} \$\{INFOPLEX_OFFLINE\} == (\d)$/u.exec(line)
    if (offlineMatch) {
      conditionals.push((offlineMatch[1] === '1') === (kind === 'offline'))
      continue
    }
    const customMatch = /^\$\{If\} \$CurrencyIsCustom == "(\d)"$/u.exec(line)
    if (customMatch) {
      conditionals.push((customMatch[1] === '1') === (currency.kind === 'custom'))
      continue
    }
    if (line === '${Else}') { conditionals[conditionals.length - 1] = !conditionals[conditionals.length - 1]; continue }
    if (line === '${EndIf}') { conditionals.pop(); continue }
    if (conditionals.includes(false)) continue

    const write = /^FileWrite \$1 "(.*)"$/u.exec(line)
    if (!write) continue
    // Order matters: NSIS escapes first ($\r$\n, $\"), then variables are substituted. Substituting first would
    // let a variable name be formed out of the escape text and corrupt the file in a way the real installer
    // never would — a harness bug that looks exactly like a product bug.
    out += write[1]!
      // NSIS escapes first: $\r$\n is a CRLF, $\" is a quote.
      .replace(/\$\\r\$\\n/gu, "\r\n")
      .replace(/\$\\"/gu, '"')
      .replace(/\$\{APP_VERSION\}/gu, '0.1.0')
      .replace(/\$(\w+)/gu, (whole, name) => {
        if (name in json) return json[name]
        if (name in raw) return raw[name]
        throw new Error(`The installer writes an unknown variable ${whole} into install-config.json.`)
      })
  }
  return out
}

describe('the install-config.json the installer hand-writes', () => {
  it.each(CURRENCIES.map((c) => [c.code, c] as const))(
    'is valid JSON the app reads for %s',
    (_code, currency) => {
      const text = renderInstallConfigFile(currency, 'online')
      expect(() => JSON.parse(text), text).not.toThrow()
      const parsed = parseInstallConfig(text)
      expect(parsed, `the app must accept the file the installer writes for ${currency.code}`).not.toBeNull()
      // And it must say the same thing the installer meant.
      expect(parsed!.currency).toEqual({
        code: currency.code,
        name: currency.name,
        symbol: currency.symbol,
        decimalPlaces: currency.decimalPlaces,
        symbolPosition: currency.symbolPosition,
        thousandsSeparator: currency.thousandsSeparator,
        decimalSeparator: currency.decimalSeparator,
        isCustom: false,
      })
    },
  )

  it('records which installer wrote it', () => {
    const online = parseInstallConfig(renderInstallConfigFile(getCurrency('NGN')!, 'online'))
    const offline = parseInstallConfig(renderInstallConfigFile(getCurrency('NGN')!, 'offline'))
    expect(online!.installerKind).toBe('online')
    expect(offline!.installerKind).toBe('offline')
    // Only one installerKind survives: the old script wrote both, which is also invalid JSON.
    expect(renderInstallConfigFile(getCurrency('NGN')!, 'online').match(/"installerKind"/gu)).toHaveLength(1)
  })

  it('survives a custom currency containing a quote and a backslash', () => {
    const custom: CurrencyDefinition = {
      code: 'WBC', name: 'The "West" Bank\\Coin', symbol: '"W"', decimalPlaces: 3,
      symbolPosition: 'before', thousandsSeparator: ',', decimalSeparator: '.', kind: 'custom',
    }
    const text = renderInstallConfigFile(custom, 'offline')
    expect(() => JSON.parse(text), text).not.toThrow()
    const parsed = parseInstallConfig(text)
    expect(parsed!.currency.name).toBe(custom.name)
    expect(parsed!.currency.symbol).toBe(custom.symbol)
    expect(parsed!.currency.isCustom).toBe(true)
  })

  it('agrees with the TypeScript writer, field for field', () => {
    // The two writers must not drift: the app's own createInstallConfig is the reference, and the hand-written
    // file must carry the same keys with the same meanings.
    const generated = JSON.parse(serializeInstallConfig(createInstallConfig({
      currency: getCurrency('KWD')!, writtenAt: '', installerKind: 'online', appVersion: '0.1.0',
    }))) as Record<string, unknown>
    const handWritten = JSON.parse(renderInstallConfigFile(getCurrency('KWD')!, 'online')) as Record<string, unknown>
    expect(Object.keys(handWritten).sort()).toEqual(Object.keys(generated).sort())
    expect(Object.keys(handWritten.currency as object).sort()).toEqual(Object.keys(generated.currency as object).sort())
    expect(handWritten.currency).toEqual(generated.currency)
  })
})

describe('refusing what the installer cannot record', () => {
  it('accepts every built-in currency, because the table is ASCII by construction', () => {
    for (const currency of CURRENCIES) expect(customCurrencyRecordingProblem(currency), currency.code).toBeNull()
  })

  it('refuses a custom currency with characters NSIS cannot safely write', () => {
    const base: CurrencyDefinition = {
      code: 'WBC', name: 'West Bank Coin', symbol: 'W', decimalPlaces: 2,
      symbolPosition: 'before', thousandsSeparator: ',', decimalSeparator: '.', kind: 'custom',
    }
    expect(customCurrencyRecordingProblem(base)).toBeNull()
    const problems = [
      { ...base, name: 'Naira ₦' },
      { ...base, symbol: '৳' },
      { ...base, name: 'Café Coin' },
      { ...base, thousandsSeparator: '\u202f' },
    ]
    for (const currency of problems) {
      const problem = customCurrencyRecordingProblem(currency)
      expect(problem, JSON.stringify(currency)).not.toBeNull()
      expect(problem).toMatch(/ordinary letters, numbers and punctuation/iu)
      expect(problem).toMatch(/re-enter/iu)
    }
  })

  it('keeps the escape helper honest against the NSIS include', () => {
    // If somebody edits json-escaping.nsh without editing the transcription above, this fails.
    const include = readFileSync(ESCAPER, 'utf8')
    expect(include).toContain('StrCmp $1 \'$\\"\'')
    expect(include).toContain("StrCpy $3 '$3$\\\"$\\\"'")
    expect(include).toContain("StrCpy $3 '$3\\\\'")
  })
})
