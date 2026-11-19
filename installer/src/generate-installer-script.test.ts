import { describe, expect, it } from 'vitest'
import { CURRENCIES, getCurrency } from '../../src/currency/catalog'
import { currencyExample, INSTALLER_PASSWORD_HASH } from './installer-policy'
import { containsMasterPassword, currencyTableBlock, generateCurrencyUiInclude, generateInstallerHeader, nsisString } from './generate-installer-script'

/**
 * The generated NSIS header.
 *
 * The .nsi that ships is produced from these functions, so anything wrong here is wrong in the installer. In
 * particular: NSIS treats `$` as a variable sigil, so an unescaped symbol in a currency row would silently read
 * a variable called "" or corrupt the row — which is why escaping is asserted rather than assumed, and why a
 * currency with a `$` symbol (USD, and a dozen others) is tested explicitly.
 */

describe('generating the installer header', () => {
  it('escapes NSIS sigils and quotes rather than emitting them raw', () => {
    expect(nsisString('plain')).toBe('"plain"')
    expect(nsisString('$1,234')).toBe('"$$1,234"')
    expect(nsisString('say "hi"')).toBe('"say $\\"hi$\\""')
  })

  it('writes one tab-separated row per built-in currency, with its own example', () => {
    const rows = currencyTableBlock().split('\n')
    expect(rows).toHaveLength(CURRENCIES.length)
    for (const [index, currency] of CURRENCIES.entries()) {
      const fields = rows[index]!.split('\t')
      expect(fields).toHaveLength(8)
      expect(fields[0]).toBe(currency.code)
      expect(fields[1]).toBe(currency.name)
      expect(fields[2]).toBe(currency.symbol)
      expect(fields[3]).toBe(String(currency.decimalPlaces))
      expect(fields[4]).toBe(currency.symbolPosition)
      expect(fields[7]).toBe(currencyExample(currency))
    }
  })

  it('emits the password hash and never the password itself', () => {
    const header = generateInstallerHeader()
    expect(header).toContain(INSTALLER_PASSWORD_HASH.hash)
    expect(header).toContain(INSTALLER_PASSWORD_HASH.salt)
    expect(header).toContain(String(INSTALLER_PASSWORD_HASH.iterations))
    // The header is compiled into a distributable, so this is the last line of defence.
    expect(header).not.toMatch(/Handywife/iu)
  })

  it('carries the currency count, the default and the allowlisted download', () => {
    const header = generateInstallerHeader()
    expect(header).toContain(`!define CURRENCY_COUNT ${CURRENCIES.length}`)
    expect(header).toContain('!define INSTALLER_DEFAULT_CURRENCY "NGN"')
    expect(header).toContain('https://aka.ms/vs/17/release/vc_redist.x64.exe')
    expect(header).toContain('!define VCREDIST_SHA256 ')
  })

  it('detects the master password in any text, for the release guard', () => {
    // The guard must be exercised with a secret of realistic shape, but the *real* vendor password must never be
    // written into this repository — a test that hard-coded it would be the exact leak the guard exists to stop.
    // So the fixture is a same-shape stand-in, read from the environment if the real one is available.
    const secret = process.env.INFOFLEX_MASTER_PASSWORD?.trim() || 'zq7-Fictional-Guard-Sample-9182'
    expect(containsMasterPassword(`a line with ${secret} in it`, secret)).toBe(true)
    expect(containsMasterPassword(`a line with ${secret.toUpperCase()} in it`, secret)).toBe(true)
    expect(containsMasterPassword(`a line with ${secret.toLowerCase()} in it`, secret)).toBe(true)
    expect(containsMasterPassword('nothing here', secret)).toBe(false)
    // A very short secret is not searched for, to avoid matching half the alphabet.
    expect(containsMasterPassword('abc', 'ab')).toBe(false)
  })

  it('keeps a $ symbol currency readable after generation', () => {
    const header = generateInstallerHeader()
    const usd = getCurrency('USD')!
    const index = CURRENCIES.findIndex(({ code }) => code === 'USD')
    // Every field of USD is emitted as its own define, with `$` doubled so NSIS does not read a variable.
    const symbol = header.split('\n').find((line) => line.startsWith(`!define CUR_${index}_SYMBOL `))
    expect(symbol, 'a USD symbol define must exist').toBeDefined()
    expect(symbol).toContain('"$$"')
    expect(symbol).toContain(usd.symbol.replace('$', '$$'))
    const example = header.split('\n').find((line) => line.startsWith(`!define CUR_${index}_EXAMPLE `))
    expect(example).toContain('$$1,234,567.50')
  })

  it('emits the dropdown and the index mapping in the currency include', () => {
    const include = generateCurrencyUiInclude()
    // One list row per currency, labelled as the brief asks.
    expect(include.split('\n').filter((line) => line.includes('NSD_LB_AddString'))).toHaveLength(CURRENCIES.length)
    expect(include).toContain('"NGN - Nigerian naira (₦)"')
    // One comparison arm per currency, and a fallback for an empty selection.
    expect(include.split('\n').filter((line) => line.includes('$R0 == "'))).toHaveLength(CURRENCIES.length)
    expect(include).toContain('StrCpy $CurrencyCodeOut "NGN"')
  })
})
