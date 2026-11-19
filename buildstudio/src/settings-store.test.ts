import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  defaultSettings, incrementVersion, readSettings, settingsPath, writeSettings,
} from './settings-store'
import { defaultBuildProfile } from '../../installer/src/build-profile'
import { generateLicenceKeyPair } from './licence-keys'

const scratch = mkdtempSync(join(tmpdir(), 'bs-settings-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function freshDir(): string {
  const dir = mkdtempSync(join(scratch, 'run-'))
  return dir
}

describe('remembered settings', () => {
  it('starts from the documented defaults: Naira, unlocked, no cap, dist output', () => {
    const settings = defaultSettings()
    expect(settings.buildProfile.defaultCurrencyCode).toBe('NGN')
    expect(settings.buildProfile.lockCurrency).toBe(false)
    expect(settings.buildProfile.maximumOnsitePeriodYears).toBeNull()
    expect(settings.outputPath).toBe('dist')
    expect(settings.masterPasswordHash).toBeNull()
  })

  it('round-trips through its file', () => {
    const dir = freshDir()
    const settings = {
      ...defaultSettings(),
      projectPath: 'C:\\Infoflex',
      buildProfile: { ...defaultBuildProfile(), defaultCurrencyCode: 'GHS', lockCurrency: true, maximumOnsitePeriodYears: 3 },
    }
    writeSettings(dir, settings)
    expect(readSettings(dir)).toEqual(settings)
  })

  it('returns defaults when there is no file', () => {
    expect(readSettings(freshDir())).toEqual(defaultSettings())
  })

  it('survives a corrupt file rather than refusing to open', () => {
    const dir = freshDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(settingsPath(dir), 'not json at all', 'utf8')
    expect(readSettings(dir)).toEqual(defaultSettings())

    writeFileSync(settingsPath(dir), '{"format":"something-else","version":9}', 'utf8')
    expect(readSettings(dir)).toEqual(defaultSettings())
  })

  it('keeps the good fields when one field is wrong', () => {
    // One bad value must not lose the vendor's project folder.
    const dir = freshDir()
    writeFileSync(settingsPath(dir), JSON.stringify({
      format: 'infoflex-build-studio-settings', version: 1,
      projectPath: 'D:\\shop', outputPath: 42, buildProfile: 'nonsense', autoIncrementVersion: 'yes',
    }), 'utf8')
    const settings = readSettings(dir)
    expect(settings.projectPath).toBe('D:\\shop')
    expect(settings.outputPath).toBe('dist')
    expect(settings.buildProfile.defaultCurrencyCode).toBe('NGN')
    expect(settings.autoIncrementVersion).toBe(false)
  })

  it('refuses to write a private key, because they belong in a protected file of their own', () => {
    const dir = freshDir()
    const pair = generateLicenceKeyPair('vendor-key-2026')
    // Sneaking one in through a free-text field must not put it on disk in a settings file that gets copied about.
    expect(() => writeSettings(dir, {
      ...defaultSettings(),
      projectPath: pair.privateKeyPem,
    })).toThrow(/will not write a private key/iu)
    expect(existsSync(settingsPath(dir))).toBe(false)
  })

  it('never writes the master password, only its hash', () => {
    const dir = freshDir()
    const hash = { algorithm: 'PBKDF2-SHA256' as const, iterations: 310_000, salt: 'abc', hash: 'def' }
    writeSettings(dir, { ...defaultSettings(), masterPasswordHash: hash })
    const text = readFileSync(settingsPath(dir), 'utf8')
    expect(text).toContain('PBKDF2-SHA256')
    // The hash is stored; a plaintext password field would be a separate key, and there is none.
    expect(Object.keys(JSON.parse(text))).not.toContain('masterPassword')
  })
})

describe('version numbers', () => {
  it('bumps only the patch number', () => {
    expect(incrementVersion('1.4.2')).toBe('1.4.3')
    expect(incrementVersion('0.1.0')).toBe('0.1.1')
    expect(incrementVersion('12.34.99')).toBe('12.34.100')
  })

  it('keeps a pre-release suffix', () => {
    expect(incrementVersion('1.0.0-beta.2')).toBe('1.0.1-beta.2')
  })

  it('refuses a version it cannot parse rather than producing nonsense', () => {
    expect(() => incrementVersion('v1')).toThrow(/not a version number/iu)
    expect(() => incrementVersion('')).toThrow(/not a version number/iu)
  })
})

describe('the build profile Build Studio hands to the build', () => {
  /**
   * Build Studio writes the profile, `npm run installer:script` reads it and compiles it into the installer, and the
   * app reads the same file at first run. This is the join between the window and that pipeline: the profile Build
   * Studio saves must be one the generator accepts and the app can parse, or the vendor sets a currency and the
   * customer never sees it.
   */
  it('round-trips through the shared profile format the installer compiles in', async () => {
    const { parseBuildProfile, serializeBuildProfile } = await import('../../installer/src/build-profile')
    const directory = mkdtempSync(join(tmpdir(), 'studio-profile-'))
    try {
      const saved = { ...defaultSettings(), buildProfile: { ...defaultSettings().buildProfile, defaultCurrencyCode: 'GHS', lockCurrency: true, maximumOnsitePeriodYears: 3 } }
      writeSettings(directory, saved)
      const text = readFileSync(join(directory, 'build-studio-settings.json'), 'utf8')
      const written = JSON.parse(text) as { buildProfile: unknown }
      const parsed = parseBuildProfile(JSON.stringify(written.buildProfile))
      expect(parsed).not.toBeNull()
      expect(parsed?.defaultCurrencyCode).toBe('GHS')
      expect(parsed?.lockCurrency).toBe(true)
      expect(parsed?.maximumOnsitePeriodYears).toBe(3)
      // And serialising it back is byte-for-byte what the generator would write beside the installer.
      expect(serializeBuildProfile(parsed!)).toBe(serializeBuildProfile(saved.buildProfile))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
