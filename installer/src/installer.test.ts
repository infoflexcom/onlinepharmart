import { describe, expect, it } from 'vitest'
import { pbkdf2Sync } from 'node:crypto'
import { CURRENCIES, getCurrency } from '../../src/currency/catalog'
import {
  INSTALLER_MAX_PASSWORD_ATTEMPTS, INSTALLER_PASSWORD_HASH,
  currencyExample, defaultCurrencyForInstaller, filterCurrencyList, initialPasswordGate,
  installScenario, installerCurrencyList, isCurrencyLockedForInstaller, isSilentInstallRequested,
  mayWriteInstallConfig, parseSilentCurrencyArgument, passwordGateMessage, recordPasswordAttempt,
  selectBuiltInCurrency, selectCustomCurrency, shouldOfferCurrencyPage,
} from './installer-policy'
import {
  createInstallConfig, installConfigPath, parseInstallConfig, serializeInstallConfig,
} from './install-config'
import {
  MAX_DOWNLOAD_ATTEMPTS, evaluateDisk, evaluateFirewall, evaluatePrinter, evaluateVcRuntime,
  downloadFailureOptions, evaluateWindows, retryAllowed, summarizeSystemCheck,
} from './system-check'
import {
  ALLOWED_DOWNLOAD_HOSTS, hostOf, resolveDownload, verifyBrowsedFile, verifyChecksum, verifySignature,
} from './download-allowlist'

/**
 * The installer's rules, tested without Windows.
 *
 * NSIS cannot be unit-tested and cannot be run in this build environment at all, so anything that could be made
 * a pure function was, and lives here. What remains in the .nsi file is drawing pages and doing file I/O.
 */

describe('the password gate', () => {
  // The vendor master password is not written in this file either. The test proves the comparison works by
  // deriving the correct password from the shipped salt through the same PBKDF2 the installer uses; if the
  // shipped hash and the vendor's password disagree, this fails, which is the point.
  const knownPassword = process.env.INFOFLEX_INSTALLER_TEST_PASSWORD ?? null

  const verify = (password: string): boolean => {
    const expected = Buffer.from(INSTALLER_PASSWORD_HASH.hash, 'base64url')
    const salt = Buffer.from(INSTALLER_PASSWORD_HASH.salt, 'base64url')
    const actual = pbkdf2Sync(password, salt, INSTALLER_PASSWORD_HASH.iterations, expected.length, 'sha256')
    return actual.length === expected.length && actual.reduce((diff, byte, index) => diff | (byte ^ expected[index]!), 0) === 0
  }

  it('rejects a wrong password and counts down the remaining attempts', () => {
    let state = initialPasswordGate()
    expect(passwordGateMessage(state)).toMatch(/vendor password/i)
    state = recordPasswordAttempt(state, verify('not-the-password'))
    expect(state).toEqual({ attemptsUsed: 1, locked: false })
    expect(passwordGateMessage(state)).toBe('That password is not correct. 4 attempts left.')
    state = recordPasswordAttempt(state, false)
    state = recordPasswordAttempt(state, false)
    state = recordPasswordAttempt(state, false)
    expect(passwordGateMessage(state)).toBe('That password is not correct. 1 attempt left.')
  })

  it('closes after five wrong attempts and stays closed even if the sixth is right', () => {
    let state = initialPasswordGate()
    for (let attempt = 0; attempt < INSTALLER_MAX_PASSWORD_ATTEMPTS; attempt += 1) {
      expect(state.locked, `still open after ${attempt}`).toBe(false)
      state = recordPasswordAttempt(state, false)
    }
    expect(state).toEqual({ attemptsUsed: 5, locked: true })
    expect(passwordGateMessage(state)).toMatch(/too many/i)
    // A correct password after the lock changes nothing: the gate is shut, not merely counting.
    expect(recordPasswordAttempt(state, true)).toEqual({ attemptsUsed: 5, locked: true })
  })

  it('accepts the vendor password and clears the counter', () => {
    if (!knownPassword) {
      // Without the secret in the environment this test cannot derive the answer, so rather than skip silently it
      // asserts the property that matters most: wrong passwords never pass. The strings below are deliberately
      // unrelated to the vendor password — a "close" variant would itself be a near-plaintext disclosure in the
      // repository, which is exactly what this phase must not ship.
      expect(verify('correct-horse-battery-staple')).toBe(false)
      expect(verify('')).toBe(false)
      expect(verify('Infoflex')).toBe(false)
      return
    }
    expect(verify(knownPassword)).toBe(true)
    expect(verify(`${knownPassword} `)).toBe(false)
    let state = recordPasswordAttempt(initialPasswordGate(), false)
    state = recordPasswordAttempt(state, true)
    expect(state).toEqual({ attemptsUsed: 0, locked: false })
  })

  it('ships a PBKDF2 hash with the parameters the app uses, never a plain password', () => {
    expect(INSTALLER_PASSWORD_HASH.algorithm).toBe('PBKDF2-SHA256')
    expect(INSTALLER_PASSWORD_HASH.iterations).toBeGreaterThanOrEqual(310_000)
    // A 32-byte digest and a 16-byte salt, base64url, and neither is the password in disguise.
    expect(Buffer.from(INSTALLER_PASSWORD_HASH.hash, 'base64url')).toHaveLength(32)
    expect(Buffer.from(INSTALLER_PASSWORD_HASH.salt, 'base64url')).toHaveLength(16)
    expect(INSTALLER_PASSWORD_HASH.hash).not.toMatch(/Handywife/iu)
    expect(INSTALLER_PASSWORD_HASH.salt).not.toMatch(/Handywife/iu)
  })
})

describe('region and currency', () => {
  it('lists every built-in currency exactly once, labelled "CODE - Name (symbol)"', () => {
    const list = installerCurrencyList()
    expect(list).toHaveLength(CURRENCIES.length)
    expect(new Set(list.map(({ code }) => code)).size).toBe(CURRENCIES.length)
    for (const entry of list) {
      expect(entry.label).toBe(`${entry.code} - ${entry.name} (${entry.symbol})`)
    }
    expect(list.find(({ code }) => code === 'NGN')?.label).toBe('NGN - Nigerian naira (₦)')
  })

  it('searches by code, by name and by symbol', () => {
    const byCode = filterCurrencyList('NGN')
    expect(byCode.map(({ code }) => code)).toContain('NGN')
    expect(filterCurrencyList('naira').map(({ code }) => code)).toEqual(['NGN'])
    expect(filterCurrencyList('cedi').map(({ code }) => code)).toEqual(['GHS'])
    expect(filterCurrencyList('₦').map(({ code }) => code)).toContain('NGN')
    expect(filterCurrencyList('   ')).toHaveLength(CURRENCIES.length)
    expect(filterCurrencyList('zzzz-not-a-currency')).toEqual([])
  })

  it('shows a correct live example for 2-, 0- and 3-decimal currencies', () => {
    // Exactly the examples the brief prints.
    expect(currencyExample(getCurrency('NGN')!)).toBe('₦1,234,567.50')
    expect(currencyExample(getCurrency('JPY')!)).toBe('¥1,234,568')
    expect(currencyExample(getCurrency('KWD')!)).toBe('1,234,567.500 د.ك')
    // And the other shapes: franc-zone grouping, a European comma decimal, a three-letter symbol.
    expect(currencyExample(getCurrency('EUR')!)).toBe('1.234.567,50 €')
    // The franc zone groups with U+202F NARROW NO-BREAK SPACE, not an ordinary space — the difference matters
    // because an ordinary space would let a number wrap across two lines on a receipt.
    expect(currencyExample(getCurrency('XOF')!)).toBe('1\u202f234\u202f568 CFA')
    // Every currency produces a non-empty example that contains its own symbol.
    for (const currency of CURRENCIES) {
      const example = currencyExample(currency)
      expect(example, currency.code).toContain(currency.symbol)
      expect(example.replace(/\D/gu, '').length, currency.code).toBeGreaterThan(0)
    }
  })

  it('preselects Nigerian Naira by default, or the vendor-locked currency when there is one', () => {
    expect(defaultCurrencyForInstaller(null).code).toBe('NGN')
    expect(defaultCurrencyForInstaller('  ghs ').code).toBe('GHS')
    // An unknown locked code falls back to the default rather than leaving the page empty.
    expect(defaultCurrencyForInstaller('NOPE').code).toBe('NGN')
    expect(isCurrencyLockedForInstaller(null)).toBe(false)
    expect(isCurrencyLockedForInstaller('NGN')).toBe(true)
  })

  it('validates a built-in selection and refuses an unknown code', () => {
    expect(selectBuiltInCurrency(' ghs ')).toMatchObject({ ok: true, currency: { code: 'GHS' } })
    expect(selectBuiltInCurrency('XYZ')).toMatchObject({ ok: false })
  })

  it('accepts a custom currency, including every decimal count from 0 to 4', () => {
    for (const decimals of ['0', '1', '2', '3', '4']) {
      const result = selectCustomCurrency({ code: 'WBC', name: 'West Bank Coin', symbol: 'W', decimalPlaces: decimals })
      expect(result.ok, decimals).toBe(true)
      if (result.ok) {
        expect(result.currency.decimalPlaces).toBe(Number(decimals))
        expect(result.currency.kind).toBe('custom')
        expect(currencyExample(result.currency)).toContain('W')
      }
    }
  })

  it('refuses a custom currency with bad fields, in words a shopkeeper can act on', () => {
    const cases: Array<[Partial<{ code: string; name: string; symbol: string; decimalPlaces: string }>, RegExp]> = [
      [{ decimalPlaces: 'two' }, /single digit/i],
      [{ decimalPlaces: '5' }, /decimal places/i],
      [{ code: 'NGN' }, /ISO currency|list/i],
      [{ code: '' }, /2–8 letters/i],
      [{ name: '' }, /name/i],
      [{ symbol: '' }, /symbol/i],
    ]
    for (const [patch, pattern] of cases) {
      const result = selectCustomCurrency({ code: 'WBC', name: 'West Bank Coin', symbol: 'W', decimalPlaces: '2', ...patch })
      expect(result.ok, JSON.stringify(patch)).toBe(false)
      if (!result.ok) expect(result.message).toMatch(pattern)
    }
  })
})

describe('the silent install switch', () => {
  it('reads /CURRENCY from a command line, with or without quotes', () => {
    expect(parseSilentCurrencyArgument('Infoflex Setup.exe /S /CURRENCY=GHS')).toMatchObject({ ok: true, currency: { code: 'GHS' } })
    expect(parseSilentCurrencyArgument('"/CURRENCY=KWD"')).toMatchObject({ ok: true, currency: { code: 'KWD' } })
    expect(parseSilentCurrencyArgument('/currency=ngn')).toMatchObject({ ok: true, currency: { code: 'NGN' } })
    expect(parseSilentCurrencyArgument('Infoflex Setup.exe /S')).toBeNull()
  })

  it('refuses an invalid code with a message naming the switch, rather than quietly using the default', () => {
    const result = parseSilentCurrencyArgument('/CURRENCY=NOTACODE')
    expect(result).toMatchObject({ ok: false })
    if (result && !result.ok) expect(result.message).toContain('/CURRENCY=NOTACODE')
    const empty = parseSilentCurrencyArgument('/CURRENCY=')
    expect(empty).toMatchObject({ ok: false })
  })

  it('recognises the silent flags electron-builder and NSIS understand', () => {
    expect(isSilentInstallRequested('setup.exe /S')).toBe(true)
    expect(isSilentInstallRequested('setup.exe /SILENT')).toBe(true)
    expect(isSilentInstallRequested('setup.exe --silent')).toBe(true)
    expect(isSilentInstallRequested('setup.exe')).toBe(false)
    expect(isSilentInstallRequested('setup.exe /CURRENCY=GHS')).toBe(false)
  })
})

describe('install, update and repair', () => {
  it('never rewrites the currency of an existing install', () => {
    expect(installScenario({ alreadyInstalled: false, sameVersion: true })).toBe('fresh')
    expect(installScenario({ alreadyInstalled: true, sameVersion: true })).toBe('repair')
    expect(installScenario({ alreadyInstalled: true, sameVersion: false })).toBe('update')
    expect(mayWriteInstallConfig('fresh')).toBe(true)
    expect(mayWriteInstallConfig('repair')).toBe(false)
    expect(mayWriteInstallConfig('update')).toBe(false)
  })

  it('hides the currency page for updates and repairs, and for a vendor-locked build', () => {
    expect(shouldOfferCurrencyPage('fresh', null)).toBe(true)
    expect(shouldOfferCurrencyPage('fresh', 'NGN')).toBe(false)
    expect(shouldOfferCurrencyPage('update', null)).toBe(false)
    expect(shouldOfferCurrencyPage('repair', null)).toBe(false)
  })
})

describe('the install-config file the app reads at first run', () => {
  const config = createInstallConfig({
    currency: getCurrency('GHS')!,
    writtenAt: '2026-11-19T05:00:00.000Z',
    installerKind: 'offline',
    appVersion: '0.1.0',
  })

  it('round-trips the currency choice and holds nothing secret', () => {
    const text = serializeInstallConfig(config)
    const parsed = parseInstallConfig(text)
    expect(parsed).not.toBeNull()
    expect(parsed!.currency).toMatchObject({ code: 'GHS', decimalPlaces: 2, symbolPosition: 'before' })
    expect(parsed!.installerKind).toBe('offline')
    // No secret, no licence, no password, no path to a database.
    expect(text).not.toMatch(/password|licen[cs]e|secret|master|salt|hash|sqlite/iu)
  })

  it('puts the file under ProgramData, in its own folder', () => {
    expect(installConfigPath('C:\\ProgramData')).toBe('C:\\ProgramData\\Infoflex\\install-config.json')
    expect(installConfigPath('C:\\ProgramData\\')).toBe('C:\\ProgramData\\Infoflex\\install-config.json')
  })

  it('treats a corrupt or hand-edited file as "no choice" instead of crashing the app', () => {
    expect(parseInstallConfig('')).toBeNull()
    expect(parseInstallConfig('not json')).toBeNull()
    expect(parseInstallConfig('null')).toBeNull()
    expect(parseInstallConfig('[]')).toBeNull()
    expect(parseInstallConfig(JSON.stringify({ ...config, format: 'something-else' }))).toBeNull()
    expect(parseInstallConfig(JSON.stringify({ ...config, version: 2 }))).toBeNull()
    expect(parseInstallConfig(JSON.stringify({ ...config, installerKind: 'usb' }))).toBeNull()
    expect(parseInstallConfig(JSON.stringify({ ...config, currency: { ...config.currency, code: 'lower' } }))).toBeNull()
    expect(parseInstallConfig(JSON.stringify({ ...config, currency: { ...config.currency, decimalPlaces: 9 } }))).toBeNull()
    expect(parseInstallConfig(JSON.stringify({ ...config, currency: { ...config.currency, symbolPosition: 'middle' } }))).toBeNull()
  })

  it('keeps a custom currency distinguishable from a built-in one', () => {
    const custom = selectCustomCurrency({ code: 'WBC', name: 'West Bank Coin', symbol: 'W', decimalPlaces: '3' })
    expect(custom.ok).toBe(true)
    if (!custom.ok) return
    const parsed = parseInstallConfig(serializeInstallConfig(createInstallConfig({
      currency: custom.currency, writtenAt: '2026-11-19T05:00:00.000Z', installerKind: 'online', appVersion: '0.1.0',
    })))
    expect(parsed!.currency).toMatchObject({ code: 'WBC', isCustom: true, decimalPlaces: 3 })
  })
})

describe('the system check', () => {
  it('accepts Windows 10 and 11 64-bit and refuses anything older or 32-bit', () => {
    expect(evaluateWindows({ platform: 'win32', major: 10, build: 19045, is64Bit: true })).toMatchObject({ status: 'ok', detail: 'Windows 10 (build 19045)' })
    expect(evaluateWindows({ platform: 'win32', major: 10, build: 22631, is64Bit: true })).toMatchObject({ status: 'ok', detail: 'Windows 11 (build 22631)' })
    expect(evaluateWindows({ platform: 'win32', major: 6, build: 9600, is64Bit: true })).toMatchObject({ status: 'blocked' })
    expect(evaluateWindows({ platform: 'win32', major: 10, build: 10240, is64Bit: false })).toMatchObject({ status: 'blocked' })
    expect(evaluateWindows({ platform: 'other', major: 10, build: 19045, is64Bit: true })).toMatchObject({ status: 'blocked' })
    expect(evaluateWindows({ platform: 'win32', major: null, build: null, is64Bit: true })).toMatchObject({ status: 'blocked' })
  })

  it('measures disk space against the brief\'s 1 GB floor', () => {
    expect(evaluateDisk(1_000_000_000)).toMatchObject({ status: 'ok', detail: '1.0 GB free' })
    expect(evaluateDisk(12_400_000_000)).toMatchObject({ status: 'ok', detail: '12 GB free' })
    expect(evaluateDisk(999_000_000)).toMatchObject({ status: 'blocked' })
    expect(evaluateDisk(null)).toMatchObject({ status: 'missing' })
  })

  it('reports the VC++ runtime as found or missing, never as a guess', () => {
    expect(evaluateVcRuntime({ detectedVersion: '14.38.33135', probeSucceeded: true })).toMatchObject({ status: 'ok' })
    expect(evaluateVcRuntime({ detectedVersion: null, probeSucceeded: true })).toMatchObject({ status: 'missing', detail: 'Not found' })
    expect(evaluateVcRuntime({ detectedVersion: null, probeSucceeded: false })).toMatchObject({ status: 'missing' })
  })

  it('reports firewall and printer as information, never as a blocker', () => {
    for (const state of ['on', 'off', 'unknown'] as const) {
      expect(evaluateFirewall({ state }).status).toBe('info')
    }
    for (const printers of [0, 1, 7, null]) {
      expect(evaluatePrinter({ printers }).status).toBe('info')
    }
  })

  it('blocks continuation only on a genuine blocker, and names it', () => {
    const summary = summarizeSystemCheck([
      evaluateWindows({ platform: 'other', major: 10, build: 19045, is64Bit: true }),
      evaluateDisk(5_000_000_000),
    ])
    expect(summary.canContinue).toBe(false)
    expect(summary.blocker).toMatch(/^Windows version: /)

    const fine = summarizeSystemCheck([
      evaluateDisk(5_000_000_000),
      evaluateWindows({ platform: 'win32', major: 10, build: 19045, is64Bit: true }),
      evaluateVcRuntime({ detectedVersion: null, probeSucceeded: true }),
    ])
    // A missing runtime is orange, not red: it can be installed, so the wizard may continue to the download.
    expect(fine.canContinue).toBe(true)
    expect(fine.blocker).toBeNull()
    expect(fine.results.map(({ id }) => id)).toEqual(['windows', 'disk', 'vcredist'])
  })

  it('stops offering Retry after three attempts', () => {
    expect(retryAllowed(0)).toBe(true)
    expect(retryAllowed(MAX_DOWNLOAD_ATTEMPTS - 1)).toBe(true)
    expect(retryAllowed(MAX_DOWNLOAD_ATTEMPTS)).toBe(false)
  })

  it('offers the right fallback buttons as attempts run out', () => {
    // First failure: all three are honest, because a flaky line often recovers.
    const first = downloadFailureOptions({ attemptsUsed: 1, offlineInstallerAvailable: true })
    expect(first).toMatchObject({ retry: true, browse: true, useOfflineInstaller: true })
    expect(first.message).toMatch(/try again/i)

    // Last allowed attempt still offers Retry.
    expect(downloadFailureOptions({ attemptsUsed: MAX_DOWNLOAD_ATTEMPTS - 1, offlineInstallerAvailable: true }).retry).toBe(true)

    // After the third failure Retry disappears and the message stops suggesting it.
    const exhausted = downloadFailureOptions({ attemptsUsed: MAX_DOWNLOAD_ATTEMPTS, offlineInstallerAvailable: true })
    expect(exhausted).toMatchObject({ retry: false, browse: true, useOfflineInstaller: true })
    expect(exhausted.message).not.toMatch(/try again/i)
    expect(exhausted.message).toMatch(/offline installer/i)

    // Browsing is always allowed: a file the customer already has is still verified before it runs.
    expect(downloadFailureOptions({ attemptsUsed: 0, offlineInstallerAvailable: false }).browse).toBe(true)
    // Without an offline build there is nothing to point at.
    expect(downloadFailureOptions({ attemptsUsed: 3, offlineInstallerAvailable: false }).useOfflineInstaller).toBe(false)
  })
})

describe('download safety', () => {
  it('will not resolve anything that is not on the allowlist', () => {
    expect(resolveDownload('vcredist-x64')).toMatchObject({ ok: true })
    for (const attempt of ['https://evil.example/vc.exe', 'vcredist', 'some-other-thing', '']) {
      const result = resolveDownload(attempt)
      expect(result.ok, attempt).toBe(false)
    }
  })

  it('serves every component from HTTPS on an officially allowlisted host', () => {
    const target = resolveDownload('vcredist-x64')
    expect(target.ok).toBe(true)
    if (!target.ok) return
    expect(target.url.startsWith('https://')).toBe(true)
    expect(ALLOWED_DOWNLOAD_HOSTS).toContain(hostOf(target.url))
    expect(hostOf('http://aka.ms/vs/17/release/vc_redist.x64.exe')).toBeNull()
    expect(hostOf('not a url')).toBeNull()
    expect(hostOf('https://aka.ms.evil.example/x.exe')).toBe('aka.ms.evil.example')
    expect(ALLOWED_DOWNLOAD_HOSTS).not.toContain('aka.ms.evil.example')
  })

  it('deletes a file whose checksum does not match the pinned hash', () => {
    const result = verifyChecksum('vcredist-x64', Buffer.from('the wrong file'))
    expect(result).toMatchObject({ ok: false, deleteFile: true })
    if (!result.ok) expect(result.message).toMatch(/deleted/u)
  })

  it('accepts a file only when it is signed by the pinned publisher', () => {
    expect(verifySignature({ id: 'vcredist-x64', status: 'Valid', signerSubject: 'CN=Microsoft Corporation, O=Microsoft Corporation' }))
      .toMatchObject({ ok: true })
    for (const bad of [
      { status: 'NotSigned' as const, signerSubject: null },
      { status: 'HashMismatch' as const, signerSubject: 'CN=Microsoft Corporation' },
      { status: 'NotTrusted' as const, signerSubject: 'CN=Microsoft Corporation' },
      { status: 'Valid' as const, signerSubject: 'CN=Totally Legit Software Ltd' },
      { status: 'Valid' as const, signerSubject: null },
    ]) {
      const result = verifySignature({ id: 'vcredist-x64', ...bad })
      expect(result, JSON.stringify(bad)).toMatchObject({ ok: false, deleteFile: true })
    }
  })

  it('holds a "browse for the file myself" pick to the same checksum', () => {
    expect(verifyBrowsedFile('vcredist-x64', Buffer.from('anything')).ok).toBe(false)
  })
})
