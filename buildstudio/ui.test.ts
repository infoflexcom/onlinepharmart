import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { buildSync } from 'esbuild'
import { describe, expect, it } from 'vitest'

/**
 * The Build Studio window, exercised for real.
 *
 * The HTML and the script are two files that have to agree: every `id` the script reaches for has to exist, and every
 * button on screen has to do something. A mismatch shows up as a window that opens with dead buttons, which is exactly
 * the failure a non-programmer cannot diagnose. So the HTML is loaded into a DOM, the script is bundled from source,
 * and every interaction is driven against a stub of the preload bridge.
 *
 * The environment is deliberately left as plain Node and the page is built with its own `JSDOM` instance: jsdom's
 * vitest environment swaps out `TextEncoder` for one from another realm, and esbuild — which the window's script is
 * bundled with — refuses to run in that state.
 *
 * This runs anywhere: it needs no Electron, no Windows and no display.
 */

const root = 'buildstudio'

/** Bundles `ui.ts` the same way `scripts/build-studio.ts` does, but in memory. */
function bundleUi(): string {
  const result = buildSync({
    entryPoints: [`${root}/ui.ts`],
    bundle: true,
    write: false,
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
    logLevel: 'silent',
  })
  return result.outputFiles[0]?.text ?? ''
}

interface Calls { [key: string]: unknown[][] }

/**
 * Loads the window with a stub bridge.
 *
 * The stub answers with plausible values and records every call, so a test can assert what the window asked the build
 * machine to do — which is the only interesting question about a button.
 */
function openWindow(options: { projectPath?: string | null } = {}): { dom: JSDOM; calls: Calls; errors: string[] } {
  const html = readFileSync(`${root}/index.html`, 'utf8')
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'file:///app/index.html' })
  const calls: Calls = {}
  const errors: string[] = []
  const record = (name: string, value: unknown): void => { calls[name] = [...(calls[name] ?? []), [value]] }
  const settings = {
    projectPath: options.projectPath === undefined ? 'C:\\projects\\infoflex' : options.projectPath,
    outputPath: 'dist',
    certificatePath: null,
    buildProfile: {
      appVersion: '1.4.2', defaultCurrencyCode: 'GHS', lockCurrency: true, maximumOnsitePeriodYears: 3, licenseServerUrl: null,
    },
    autoIncrementVersion: false,
    releaseNotes: '',
    masterPasswordHash: null,
  }
  const remove = (): void => {}
  const bridge = {
    settings: {
      read: async () => settings,
      write: async (next: unknown) => { record('settings:write', next); return next },
    },
    dialog: {
      pickFolder: async () => 'C:\\projects\\infoflex',
      pickFile: async () => 'C:\\installers\\vs.exe',
      savePrivateKey: async (pem: string) => { record('savePrivateKey', pem); return 'C:\\keys\\private.pem' },
    },
    project: { detect: async (folder: string) => { record('project:detect', folder); return { ok: true, name: 'infoflex', version: '1.4.2' } } },
    check: {
      run: async () => {
        record('check:run', null)
        return {
          ready: false,
          headline: '2 things need attention before a build can run.',
          checks: [
            { id: 'node', title: 'Node.js', required: true, state: 'ok', message: 'v20.11.0' },
            { id: 'vs-build-tools', title: 'C++ build tools', required: true, state: 'missing-installable', message: 'Not installed; Build Studio can install it.' },
            { id: 'makensis', title: 'NSIS', required: true, state: 'blocked', message: 'Install by hand.' },
            { id: 'git', title: 'Git', required: false, state: 'missing-installable', message: 'Optional.' },
          ],
        }
      },
    },
    tools: { install: async (ids: string[]) => { record('tools:install', ids); return { ok: true, results: [] } } },
    build: {
      run: async (group: string) => {
        record('build:run', group)
        return { ok: true, artefacts: [], missing: [] }
      },
      cancel: async () => { record('build:cancel', null) },
      onStep: (handler: (step: unknown) => void) => { record('onStep', handler); return remove },
      onProgress: (handler: (value: unknown) => void) => { record('onProgress', handler); return remove },
    },
    artefacts: {
      verify: async () => ({
        missing: [],
        artefacts: [
          { title: 'Infoflex Setup.exe', path: 'C:\\out\\a.exe', relativePath: 'a.exe', exists: true, sizeBytes: 2048, sha256: 'abc123' },
          { title: 'Infoflex Setup Offline.exe', path: 'C:\\out\\b.exe', relativePath: 'b.exe', exists: false, sizeBytes: 0, sha256: null },
        ],
      }),
      openFolder: async () => true,
      copyToDrive: async (path: string) => { record('copyToDrive', path); return { ok: true, message: 'Copied.' } },
    },
    drives: { list: async () => [{ path: 'D:\\', label: 'D drive' }] },
    vendor: {
      unlock: async (password: string) => { record('vendor:unlock', password); return { ok: password === 'right' } },
      generateKeys: async (keyId: string) => {
        record('generateKeys', keyId)
        return { ok: true, publicKeyPem: '-----BEGIN PUBLIC KEY-----\nAAA\n-----END PUBLIC KEY-----', fingerprint: 'AB:CD', privateKeyPem: '-----BEGIN PRIVATE KEY-----\nZZZ\n-----END PRIVATE KEY-----' }
      },
    },
    log: { path: async () => 'C:\\log', open: async () => true, copy: async () => 'log text', onLine: () => remove },
    app: {
      info: async () => ({ version: '1.0.0', tools: [], steps: [] }),
      currencies: async () => [
        { code: 'NGN', name: 'Nigerian naira', symbol: '₦' },
        { code: 'GHS', name: 'Ghanaian cedi', symbol: 'GH₵' },
      ],
    },
  }
  ;(dom.window as unknown as { studio: unknown }).studio = bridge
  dom.window.addEventListener('error', (event) => errors.push(String((event as unknown as { message: string }).message)))
  dom.window.eval(bundleUi())
  return { dom, calls, errors }
}

/** Waits for the pending microtasks the window chains on open. */
const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 25) })

describe('the Build Studio window', () => {
  it('bundles and opens without a script error', async () => {
    const { dom, errors } = openWindow()
    await settle()
    expect(errors).toEqual([])
    expect(dom.window.document.getElementById('app-version')?.textContent).toBe('Version 1.0.0')
  })

  it('offers every currency the app knows, and selects the one in the build profile', async () => {
    const { dom } = openWindow()
    await settle()
    const options = [...dom.window.document.querySelectorAll('#default-currency option')].map((option) => option.textContent)
    expect(options).toEqual(['NGN - Nigerian naira (₦)', 'GHS - Ghanaian cedi (GH₵)'])
    const select = dom.window.document.getElementById('default-currency') as HTMLSelectElement
    expect(select.value).toBe('GHS')
  })

  it('shows the three check states with their own symbols, blocked first', async () => {
    const { dom, calls } = openWindow()
    await settle()
    dom.window.document.getElementById('start-check')?.dispatchEvent(new dom.window.Event('click'))
    await settle()
    expect(calls['check:run']).toHaveLength(1)
    const rows = [...dom.window.document.querySelectorAll('#checks .check')]
    expect(rows.map((row) => row.querySelector('.glyph')?.textContent)).toEqual(['✓', '↓', '✕', '↓'])
    expect(rows[1]?.className).toBe('check orange')
    expect(rows[2]?.className).toBe('check red')
    expect(dom.window.document.getElementById('verdict')?.textContent).toBe('2 things need attention before a build can run.')
  })

  it('offers to install only the required tools that Build Studio can install itself', async () => {
    const { dom, calls } = openWindow()
    await settle()
    dom.window.document.getElementById('start-check')?.dispatchEvent(new dom.window.Event('click'))
    await settle()
    const install = dom.window.document.getElementById('install-missing') as HTMLButtonElement
    expect(install.textContent).toBe('Install the missing tool')
    expect(install.disabled).toBe(false)
    install.dispatchEvent(new dom.window.Event('click'))
    await settle()
    // The optional Git row is left alone: installing something the vendor did not ask for is not helpful.
    expect(calls['tools:install']?.[0]?.[0]).toEqual(['vs-build-tools'])
  })

  it('runs the one-click build and moves to the output screen when it finishes', async () => {
    const { dom, calls } = openWindow()
    await settle()
    dom.window.document.getElementById('do-everything')?.dispatchEvent(new dom.window.Event('click'))
    await settle()
    expect(calls['build:run']?.[0]?.[0]).toBe('do-everything')
    const output = dom.window.document.querySelector('[data-panel="output"]') as HTMLElement
    expect(output.classList.contains('hidden')).toBe(false)
    const table = dom.window.document.querySelector('#artefacts table')
    expect(table?.textContent).toContain('Infoflex Setup.exe')
    expect(table?.textContent).toContain('2.0 KB')
    expect(table?.textContent).toContain('missing')
  })

  it('runs each smaller build button with its own group name', async () => {
    const { dom, calls } = openWindow()
    await settle()
    for (const id of ['run-tests', 'build-mobile-app', 'build-installers']) {
      dom.window.document.querySelector(`[data-build="${id}"]`)?.dispatchEvent(new dom.window.Event('click'))
      await settle()
    }
    expect((calls['build:run'] ?? []).map((args) => (args as string[])[0])).toEqual(['run-tests', 'build-mobile-app', 'build-installers'])
  })

  it('refuses to build before a project folder is chosen, and says so on the Project screen', async () => {
    const { dom, calls } = openWindow({ projectPath: null })
    await settle()
    dom.window.document.getElementById('do-everything')?.dispatchEvent(new dom.window.Event('click'))
    await settle()
    // Nothing was asked of the build machine: the window stopped the build itself.
    expect(calls['build:run']).toBeUndefined()
    const projectPanel = dom.window.document.querySelector('[data-panel="project"]') as HTMLElement
    expect(projectPanel.classList.contains('hidden')).toBe(false)
    expect(dom.window.document.getElementById('project-error')?.textContent).toContain('Choose the project folder first.')
  })

  it('will not accept a folder that is not the project', async () => {
    const { dom, calls } = openWindow({ projectPath: null })
    await settle()
    ;(dom.window as unknown as { studio: { project: { detect: unknown } } }).studio.project.detect =
      async () => ({ ok: false, message: 'That folder does not look like the Infoflex project.' })
    dom.window.document.getElementById('pick-project')?.dispatchEvent(new dom.window.Event('click'))
    await settle()
    expect(calls['settings:write']).toBeUndefined()
    expect(dom.window.document.getElementById('project-error')?.textContent).toContain('does not look like the Infoflex project')
  })

  it('unlocks the vendor tools with the master password and clears the box afterwards', async () => {
    const { dom, calls } = openWindow()
    await settle()
    const password = dom.window.document.getElementById('vendor-password') as HTMLInputElement
    password.value = 'wrong'
    dom.window.document.getElementById('unlock-vendor')?.dispatchEvent(new dom.window.Event('click'))
    await settle()
    expect(calls['vendor:unlock']?.[0]?.[0]).toBe('wrong')
    // The field is emptied whether the password was right or wrong.
    expect(password.value).toBe('')
    expect(dom.window.document.getElementById('vendor-locked')?.classList.contains('hidden')).toBe(false)

    password.value = 'right'
    dom.window.document.getElementById('unlock-vendor')?.dispatchEvent(new dom.window.Event('click'))
    await settle()
    expect(dom.window.document.getElementById('vendor-locked')?.classList.contains('hidden')).toBe(true)
    expect(dom.window.document.getElementById('vendor-unlocked')?.classList.contains('hidden')).toBe(false)
  })

  it('shows the public key, never the private one, and offers to save the private half to a file', async () => {
    const { dom, calls } = openWindow()
    await settle()
    ;(dom.window.document.getElementById('key-id') as HTMLInputElement).value = 'infoflex-2026'
    dom.window.document.getElementById('generate-keys')?.dispatchEvent(new dom.window.Event('click'))
    await settle()
    expect(calls['generateKeys']?.[0]?.[0]).toBe('infoflex-2026')
    const panel = dom.window.document.getElementById('key-result')
    expect(panel?.textContent).toContain('-----BEGIN PUBLIC KEY-----')
    expect(panel?.textContent).toContain('AB:CD')
    // The private key must not be rendered anywhere in the window.
    expect(panel?.textContent).not.toContain('PRIVATE KEY')
    expect(dom.window.document.body.textContent).not.toContain('PRIVATE KEY')

    const save = [...(panel?.querySelectorAll('button') ?? [])].find((button) => /Save the private key/u.test(button.textContent ?? ''))
    save?.dispatchEvent(new dom.window.Event('click'))
    await settle()
    // It goes to the dialog — the one place allowed to write it — and nowhere else.
    expect(String(calls['savePrivateKey']?.[0]?.[0])).toContain('BEGIN PRIVATE KEY')
    expect(panel?.textContent).toContain('C:\\keys\\private.pem')
  })

  it('saves settings that pass its own checks, and refuses a bad version or a plain-http cloud address', async () => {
    const { dom, calls } = openWindow()
    await settle()
    const version = dom.window.document.getElementById('app-version-input') as HTMLInputElement
    version.value = 'not a version'
    dom.window.document.getElementById('save-settings')?.dispatchEvent(new dom.window.Event('click'))
    await settle()
    expect(calls['settings:write']).toBeUndefined()
    expect(dom.window.document.getElementById('settings-problems')?.textContent).toContain('The version must look like 1.4.2.')

    version.value = '1.5.0'
    ;(dom.window.document.getElementById('cloud-url') as HTMLInputElement).value = 'http://licences.example.com'
    dom.window.document.getElementById('save-settings')?.dispatchEvent(new dom.window.Event('click'))
    await settle()
    expect(calls['settings:write']).toBeUndefined()
    expect(dom.window.document.getElementById('settings-problems')?.textContent).toContain('https://')

    ;(dom.window.document.getElementById('cloud-url') as HTMLInputElement).value = 'https://licences.example.com'
    ;(dom.window.document.getElementById('onsite-period') as HTMLSelectElement).value = ''
    dom.window.document.getElementById('save-settings')?.dispatchEvent(new dom.window.Event('click'))
    await settle()
    const saved = calls['settings:write']?.[0]?.[0] as { buildProfile: { appVersion: string; maximumOnsitePeriodYears: number | null; defaultCurrencyCode: string; lockCurrency: boolean } }
    expect(saved.buildProfile.appVersion).toBe('1.5.0')
    // "No limit" is null, not zero: a zero-year limit would reject every licence.
    expect(saved.buildProfile.maximumOnsitePeriodYears).toBeNull()
    expect(saved.buildProfile.defaultCurrencyCode).toBe('GHS')
    expect(saved.buildProfile.lockCurrency).toBe(true)
  })

  it('lists the removable drives and copies the built files to the chosen one', async () => {
    const { dom, calls } = openWindow()
    await settle()
    dom.window.document.querySelector('[data-tab="output"]')?.dispatchEvent(new dom.window.Event('click'))
    dom.window.document.getElementById('refresh-drives')?.dispatchEvent(new dom.window.Event('click'))
    await settle()
    const drive = dom.window.document.querySelector('#drives .drive')
    expect(drive?.textContent).toContain('D drive')
    drive?.dispatchEvent(new dom.window.Event('click'))
    await settle()
    expect(calls['copyToDrive']?.[0]?.[0]).toBe('D:\\')
    expect(dom.window.document.getElementById('copy-result')?.textContent).toBe('Copied.')
  })

  it('reaches for nothing that is not in the page, so no button is dead', async () => {
    const html = readFileSync(`${root}/index.html`, 'utf8')
    const document_ = new JSDOM(html).window.document
    // Every id the script uses must exist in the HTML; a missing one throws on open, which the first test catches, but
    // this also proves no button is present without something happening when it is pressed.
    const ids = [...document_.querySelectorAll('[id]')].map((element) => element.id)
    expect(new Set(ids).size).toBe(ids.length)
    const buttons = [...document_.querySelectorAll('button')]
    expect(buttons.length).toBeGreaterThan(20)
    for (const button of buttons) {
      expect(
        button.id || button.dataset.build || button.dataset.tab,
        `button "${button.textContent}" has no id, build group or tab`,
      ).toBeTruthy()
    }
  })
})
