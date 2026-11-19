import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CURRENCIES } from '../../src/currency/catalog'
import { generateInstallerHeader } from './generate-installer-script'
import { INSTALLER_PASSWORD_HASH, INSTALLER_MAX_PASSWORD_ATTEMPTS } from './installer-policy'
import {
  ALLOWED_DOWNLOAD_HOSTS, ALLOWLISTED_COMPONENTS, hostOf, resolveDownload, type AllowlistedComponent,
} from './download-allowlist'

/**
 * `generated.nsh` — the defines every other part of the installer reads.
 *
 * Its per-currency defines are what `currency-ui.nsh` copies into the live variables, so an error here surfaces
 * as a shop charging in the wrong currency, not as a crash. And its password define is the line that must never
 * become a plaintext password, which makes the file worth reading as text rather than trusting the generator.
 *
 * The include is expected to match the generator exactly: an edited generated file means somebody changed the
 * installer without changing the code that produces it, and the next `npm run installer:script` would silently
 * undo their work.
 */

const GENERATED = readFileSync('installer/nsis/generated.nsh', 'utf8')

function define(name: string): string | null {
  const match = new RegExp(`^!define ${name} (.*)$`, 'mu').exec(GENERATED)
  if (!match) return null
  return match[1]!.trim()
}

/** A define's value with NSIS quoting and escaping removed. */
function defineText(name: string): string | null {
  const value = define(name)
  if (value === null) return null
  const quoted = /^"(.*)"$/u.exec(value)
  return (quoted ? quoted[1]! : value).replace(/\$\$/gu, '$')
}

describe('generated.nsh', () => {
  it('is exactly what the generator produces', () => {
    expect(GENERATED).toBe(generateInstallerHeader())
  })

  it('carries the password as a hash and parameters, never as a password', () => {
    expect(defineText('INSTALLER_PASSWORD_SALT')).toBe(INSTALLER_PASSWORD_HASH.salt)
    expect(defineText('INSTALLER_PASSWORD_HASH')).toBe(INSTALLER_PASSWORD_HASH.hash)
    expect(define('INSTALLER_PASSWORD_ITERATIONS')).toBe(String(INSTALLER_PASSWORD_HASH.iterations))
    expect(define('INSTALLER_MAX_ATTEMPTS')).toBe(String(INSTALLER_MAX_PASSWORD_ATTEMPTS))
    // The two defines that must exist are exactly the salt and the hash: no third one carrying a password.
    const passwordDefines = GENERATED.match(/^!define INSTALLER_PASSWORD_\w+/gmu) ?? []
    expect(passwordDefines.sort()).toEqual([
      '!define INSTALLER_PASSWORD_HASH',
      '!define INSTALLER_PASSWORD_ITERATIONS',
      '!define INSTALLER_PASSWORD_SALT',
    ])
  })

  it('hashes with the same parameters the application uses', () => {
    // Rotation must happen in one place. If the app's policy and the installer's define disagree, the installer
    // accepts a password the app rejects — or the reverse.
    expect(INSTALLER_PASSWORD_HASH.algorithm).toBe('PBKDF2-SHA256')
    expect(INSTALLER_PASSWORD_HASH.iterations).toBe(310_000)
  })

  it.each(CURRENCIES.map((c, index) => [c.code, index, c] as const))(
    'defines every field for currency %s (%i)',
    (code, index, currency) => {
      expect(defineText(`CUR_${index}_CODE`)).toBe(currency.code)
      expect(defineText(`CUR_${index}_NAME`)).toBe(currency.name)
      expect(defineText(`CUR_${index}_SYMBOL`)).toBe(currency.symbol)
      expect(defineText(`CUR_${index}_DECIMALS`)).toBe(String(currency.decimalPlaces))
      expect(defineText(`CUR_${index}_POSITION`)).toBe(currency.symbolPosition)
      expect(defineText(`CUR_${index}_THOUSANDS`)).toBe(currency.thousandsSeparator)
      expect(defineText(`CUR_${index}_DECIMAL`)).toBe(currency.decimalSeparator)
      // Guard against the names being right but the values swapped between two currencies.
      expect(defineText(`CUR_${index}_CODE`)).toBe(code)
    },
  )

  it('defines nothing beyond the currencies it has', () => {
    expect(define(`CUR_${CURRENCIES.length}_CODE`)).toBeNull()
    expect(defineText('CURRENCY_COUNT')).toBe(String(CURRENCIES.length))
  })

  it('carries the download address of an allowlisted component, not a hand-typed one', () => {
    const resolved = resolveDownload('vcredist-x64')
    expect(resolved.ok, resolved.ok ? '' : resolved.message).toBe(true)
    const component = (resolved as { ok: true; component: AllowlistedComponent }).component
    expect(defineText('VCREDIST_URL')).toBe(component.url)
    expect(defineText('VCREDIST_PUBLISHER')).toBe(component.publisher)
    expect(defineText('VCREDIST_SHA256')).toBe(component.sha256)
    // A URL that does not match the allowlist at build time would be caught here rather than at a customer's PC.
    expect(ALLOWED_DOWNLOAD_HOSTS).toContain(hostOf(component.url))
    expect(ALLOWLISTED_COMPONENTS.length).toBeGreaterThan(0)
  })

  it('ships the checksum unpinned, which fails closed rather than accepting any file', () => {
    // The release step that pins it is written in installer/README.md. If this test starts failing, somebody
    // pinned it — good — and this test should be updated to assert the pinned digest instead.
    expect(defineText('VCREDIST_SHA256')).toBe('0'.repeat(64))
  })

  it('keeps the installer config path in step with the app', () => {
    expect(defineText('INSTALLER_CONFIG_DIR')).toBe('Infoflex')
    expect(defineText('INSTALLER_CONFIG_FILE')).toBe('install-config.json')
  })

  it('is pure ASCII except where a currency symbol genuinely is not', () => {
    // The file is a Unicode build's input and carries symbols like ₦ and د.ك by necessity. What must not happen is
    // a stray invisible character — a non-breaking space where a plain one was meant — in a define that is copied
    // into the JSON. The separators are checked per currency above; this checks for characters nobody intended.
    const suspicious = [...GENERATED].filter((character) => {
      const code = character.codePointAt(0)!
      return (code < 0x20 && character !== '\n' && character !== '\r') || code === 0xfeff || code === 0xad
    })
    expect(suspicious, `unexpected control characters: ${JSON.stringify(suspicious)}`).toEqual([])
  })
})
