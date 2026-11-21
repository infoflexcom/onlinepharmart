import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { generateCurrencyUiInclude, generateInstallerHeader } from './generate-installer-script'
import { defaultBuildProfile, type BuildProfile } from './build-profile'

/**
 * The path a vendor's build settings take to the customer.
 *
 * Build Studio writes `build-profile.json`; `npm run installer:script` reads it and compiles the values into the
 * generated NSIS header; electron-builder packs the same profile beside the app, where first-run setup reads it.
 * Three programs that never run together, joined by one file — so what is worth testing is that they agree.
 *
 * The question each test answers is "if the vendor set this in the window, would the customer's installer actually
 * behave that way?", not "does the generator output some text".
 */

const ONLINE = readFileSync('electron-builder.installer-online.json', 'utf8')
const OFFLINE = readFileSync('electron-builder.installer-offline.json', 'utf8')

function ghanaBuild(overrides: Partial<BuildProfile> = {}): BuildProfile {
  return {
    ...defaultBuildProfile(),
    appVersion: '2.3.4',
    defaultCurrencyCode: 'GHS',
    lockCurrency: true,
    maximumOnsitePeriodYears: 3,
    licenseServerUrl: 'https://licences.infoflex.example',
    ...overrides,
  }
}

describe('a build profile reaches the installer', () => {
  it('preselects the vendor currency and locks the page when the vendor locked it', () => {
    const header = generateInstallerHeader(ghanaBuild())
    const ui = generateCurrencyUiInclude(ghanaBuild())

    // The index is what the dropdown opens on; the locked define is what the page branches on.
    expect(header).toContain('!define INSTALLER_DEFAULT_CURRENCY "GHS"')
    expect(header).toContain('!define INSTALLER_CURRENCY_LOCKED 1')

    // And the row the index points at really is the Ghanaian cedi: an off-by-one here installs the wrong money.
    const index = Number(/^!define INSTALLER_DEFAULT_INDEX (\d+)$/mu.exec(header)?.[1])
    const rowCode = new RegExp(`^!define CUR_${index}_CODE "([A-Z]{3})"$`, 'mu').exec(header)?.[1]
    expect(rowCode).toBe('GHS')
    // The locked page shows this example, so it must be a cedi example and not, say, a naira one.
    // The symbol is separated from the amount by a space because Ghanaian amounts are often written that way in the
    // catalogue, which is the whole point of taking the example from it rather than typing one.
    expect(header).toMatch(/^!define CUR_DEFAULT_EXAMPLE "GH₵ ?1,234,567\.50"$/mu)
    // The row itself must exist in the currency page's data as well, not only in the header.
    expect(ui).toContain('Ghanaian cedi')
  })

  it('leaves the currency editable in a build that did not lock it', () => {
    const header = generateInstallerHeader(ghanaBuild({ lockCurrency: false, defaultCurrencyCode: 'NGN' }))
    expect(header).toContain('!define INSTALLER_CURRENCY_LOCKED 0')
    expect(header).toContain('!define INSTALLER_DEFAULT_CURRENCY "NGN"')
  })

  it('carries the build version into both the installer and the app', () => {
    expect(generateInstallerHeader(ghanaBuild())).toContain('2.3.4')
  })

  it('asks electron-builder to pack the profile the generator just wrote, in both builds', () => {
    // One file, one path: the app's `readBuildProfile` looks for `resources/build-profile.json`, and the generator
    // writes exactly the file electron-builder is told to copy there.
    // Parsed rather than string-matched: the configs are formatted JSON, and an assertion on exact whitespace fails
    // the moment anyone reformats a file without changing what it means.
    for (const config of [ONLINE, OFFLINE]) {
      const parsed = JSON.parse(config) as { extraResources?: string[] }
      expect(parsed.extraResources, "the app cannot read the vendor's build profile").toContain(
        'installer/nsis/build-profile.json',
      )
    }
  })

  it('produces a profile file the app can parse back to what the vendor set', async () => {
    const { serializeBuildProfile, parseBuildProfile } = await import('./build-profile')
    const parsed = parseBuildProfile(serializeBuildProfile(ghanaBuild()))
    expect(parsed).not.toBeNull()
    expect(parsed).toMatchObject({
      appVersion: '2.3.4',
      defaultCurrencyCode: 'GHS',
      lockCurrency: true,
      maximumOnsitePeriodYears: 3,
      licenseServerUrl: 'https://licences.infoflex.example',
    })
  })

  it('does not let the on-site cap leak into the installer as a currency-shaped value', () => {
    // The cap is enforced by the app at activation, not by the installer. It must not appear in the currency page's
    // data at all, where a stray number would silently become a decimal-places setting.
    const ui = generateCurrencyUiInclude(ghanaBuild({ maximumOnsitePeriodYears: 5 }))
    expect(ui).not.toContain('INSTALLER_ONSITE')
  })
})
