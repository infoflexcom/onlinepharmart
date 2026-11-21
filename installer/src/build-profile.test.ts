import { describe, expect, it } from 'vitest'
import { CURRENCIES, getCurrency } from '../../src/currency/catalog'
import {
  buildDefaultCurrency, buildProfileProblems, defaultBuildProfile, installerCurrencyPageMode,
  installerDefaultCurrencyIndex, ONSITE_PERIOD_CHOICES, parseBuildProfile, serializeBuildProfile,
  serverUrlProblem, validateBuildProfile, type BuildProfile,
} from './build-profile'

/**
 * The per-build settings, which decide two of the phase's DONE WHEN items:
 *
 *   - "a build with default currency GHS preselects Ghana Cedi in the installer";
 *   - "a build with the currency locked shows it read-only".
 *
 * Both are properties of a file that Build Studio writes and two other programs read, so the tests here are about
 * the contract: what a valid profile is, what an invalid one is refused for, and what each consumer is told to do
 * with it. The installer and app sides are tested where they consume these functions.
 */

function profile(overrides: Partial<BuildProfile> = {}): BuildProfile {
  return { ...defaultBuildProfile(), ...overrides }
}

describe('a build profile', () => {
  it('defaults to Naira, unlocked, no period cap and no cloud', () => {
    const base = defaultBuildProfile()
    expect(base).toMatchObject({
      defaultCurrencyCode: 'NGN', lockCurrency: false, maximumOnsitePeriodYears: null, licenseServerUrl: null,
    })
    expect(buildProfileProblems(base)).toEqual([])
  })

  it('round-trips through its file, upper-casing the currency code', () => {
    const text = serializeBuildProfile(profile({ defaultCurrencyCode: 'ghs', lockCurrency: true }))
    expect(JSON.parse(text).defaultCurrencyCode).toBe('GHS')
    expect(parseBuildProfile(text)).toMatchObject({ defaultCurrencyCode: 'GHS', lockCurrency: true })
  })

  it('rejects a currency that is not in the built-in list', () => {
    const problems = buildProfileProblems(profile({ defaultCurrencyCode: 'XXX' }))
    expect(problems).toHaveLength(1)
    expect(problems[0]!.field).toBe('defaultCurrencyCode')
    expect(problems[0]!.message).toMatch(/not a currency in the built-in list/iu)
  })

  it('accepts every built-in currency, so a vendor can sell anywhere', () => {
    for (const currency of CURRENCIES) {
      expect(buildProfileProblems(profile({ defaultCurrencyCode: currency.code })), currency.code).toEqual([])
    }
  })

  it('offers exactly the periods the brief names, with No limit first', () => {
    expect(ONSITE_PERIOD_CHOICES).toEqual([null, 1, 2, 3, 5, 10])
    for (const years of ONSITE_PERIOD_CHOICES) {
      expect(buildProfileProblems(profile({ maximumOnsitePeriodYears: years })), String(years)).toEqual([])
    }
    // Anything else is a vendor typo, not a feature.
    for (const years of [0, 4, 7, 100, -1, 2.5]) {
      const problems = buildProfileProblems(profile({ maximumOnsitePeriodYears: years }))
      expect(problems.some((p) => p.field === 'maximumOnsitePeriodYears'), String(years)).toBe(true)
    }
  })

  it('rejects a version that is not dotted numbers', () => {
    for (const appVersion of ['', 'v1', '1', '1.2', 'abc', '1.2.3.4.5']) {
      expect(buildProfileProblems(profile({ appVersion })).some((p) => p.field === 'appVersion'), appVersion).toBe(true)
    }
    for (const appVersion of ['1.0.0', '0.1.0', '12.34.56', '1.0.0-beta.2']) {
      expect(buildProfileProblems(profile({ appVersion })), appVersion).toEqual([])
    }
  })

  it('refuses a plain-http cloud address except on this computer', () => {
    // The address receives licence keys, so sending one over plain HTTP to a real host is the mistake this
    // rule exists to make impossible.
    expect(serverUrlProblem('https://cloud.example.com')).toBeNull()
    expect(serverUrlProblem('http://localhost:8080')).toBeNull()
    expect(serverUrlProblem('http://127.0.0.1:3000')).toBeNull()
    expect(serverUrlProblem('http://cloud.example.com')).toMatch(/https/iu)
    expect(serverUrlProblem('cloud.example.com')).toMatch(/https:\/\//u)
    expect(serverUrlProblem('https://user:pw@cloud.example.com')).toMatch(/username or password/iu)
    expect(serverUrlProblem('https://cloud.example.com/?a=1')).toMatch(/query/iu)
    expect(serverUrlProblem('ftp://cloud.example.com')).toMatch(/https/iu)
    expect(serverUrlProblem('')).toMatch(/blank|Enter/iu)
  })

  it('reports every problem at once, so a vendor fixes one form and not five builds', () => {
    const problems = buildProfileProblems(profile({
      appVersion: 'nope', defaultCurrencyCode: 'ZZZ', maximumOnsitePeriodYears: 4, licenseServerUrl: 'http://example.com',
    }))
    expect(problems.map((p) => p.field).sort()).toEqual(
      ['appVersion', 'defaultCurrencyCode', 'licenseServerUrl', 'maximumOnsitePeriodYears'],
    )
  })

  it('returns null rather than throwing when a file is unusable', () => {
    for (const text of ['', 'not json', '{}', '[]', 'null', '{"format":"infoflex-build-profile","version":1}']) {
      expect(parseBuildProfile(text), text).toBeNull()
    }
  })

  it('throws one readable sentence from validate, for callers that want it', () => {
    expect(() => validateBuildProfile(profile({ defaultCurrencyCode: 'ZZZ' }))).toThrow(/not a currency/iu)
    expect(() => validateBuildProfile(profile())).not.toThrow()
  })
})

describe('what the installer does with a build', () => {
  it('preselects the build currency in the dropdown', () => {
    // The brief's example: a build with GHS must open on Ghana Cedis, not on row 0 because that happens to be Naira.
    const ghs = profile({ defaultCurrencyCode: 'GHS' })
    expect(buildDefaultCurrency(ghs).code).toBe('GHS')
    expect(buildDefaultCurrency(ghs).symbol).toBe('GH₵')
    const index = installerDefaultCurrencyIndex(ghs, CURRENCIES)
    expect(index).toBeGreaterThan(0)
    expect(CURRENCIES[index]!.code).toBe('GHS')
  })

  it('finds the right row for every currency, and falls back to the first only if absent', () => {
    for (const currency of CURRENCIES) {
      expect(installerDefaultCurrencyIndex(profile({ defaultCurrencyCode: currency.code }), CURRENCIES), currency.code)
        .toBe(CURRENCIES.findIndex((c) => c.code === currency.code))
    }
    expect(installerDefaultCurrencyIndex(profile({ defaultCurrencyCode: 'ZZZ' }), CURRENCIES)).toBe(0)
  })

  it('is editable by default and locked only when the vendor says so', () => {
    expect(installerCurrencyPageMode(profile())).toBe('editable')
    expect(installerCurrencyPageMode(profile({ lockCurrency: true }))).toBe('locked')
    // Locking does not change which currency is preselected — it only stops it being changed.
    expect(buildDefaultCurrency(profile({ defaultCurrencyCode: 'KES', lockCurrency: true })).code).toBe('KES')
  })

  it('resolves a real currency definition for every build default', () => {
    for (const code of ['NGN', 'GHS', 'KWD', 'JPY', 'EUR']) {
      const currency = buildDefaultCurrency(profile({ defaultCurrencyCode: code }))
      expect(currency.decimalPlaces).toBe(getCurrency(code)!.decimalPlaces)
    }
  })
})
