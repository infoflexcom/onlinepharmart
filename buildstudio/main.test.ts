import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Build Studio's Electron main process, executed.
 *
 * `main.ts` is the only part of the tool that can write files, spawn processes and read the machine, and until now it
 * had never run at all — it was type-checked and bundled, which proves it compiles and nothing more. Everything that
 * decides something about safety lives in `src/`, where it has tests; what is left here is the wiring, and wiring is
 * exactly what fails silently.
 *
 * So `electron` is mocked and the real module is imported: every IPC handler is invoked the way the window would
 * invoke it, and the handler's own logic is what runs. No display, no Electron binary, no Windows.
 */

interface Handler { (event: unknown, ...args: unknown[]): unknown }

/** What the mocked `electron` recorded, reset between tests. */
const state = {
  handlers: new Map<string, Handler>(),
  saved: [] as Array<{ target: string; data: string }>,
  opened: [] as string[],
  shown: [] as Array<{ kind: string; message: string }>,
  sends: [] as Array<{ channel: string; payload: unknown }>,
  dialogResults: { openDirectory: '' as string, openFile: '' as string, save: '' as string },
  userData: '',
}

vi.mock('electron', () => {
  const app = {
    whenReady: () => Promise.resolve(),
    getPath: () => state.userData,
    getVersion: () => '9.9.9',
    on: () => undefined,
    quit: () => undefined,
  }
  class BrowserWindow {
    webContents = { send: (channel: string, payload: unknown) => state.sends.push({ channel, payload }) }
    on(): void {}
    static getAllWindows(): unknown[] { return [] }
    constructor(public options: unknown) {}
    loadFile(): Promise<void> { return Promise.resolve() }
  }
  const dialog = {
    showOpenDialog: () => Promise.resolve({ canceled: !state.dialogResults.openDirectory, filePaths: [state.dialogResults.openDirectory] }),
    showSaveDialog: () => Promise.resolve({ canceled: !state.dialogResults.save, filePath: state.dialogResults.save }),
    showErrorBox: (kind: string, message: string) => state.shown.push({ kind, message }),
  }
  const ipcMain = { handle: (channel: string, handler: Handler) => state.handlers.set(channel, handler) }
  const shell = {
    openPath: (target: string) => { state.opened.push(target); return Promise.resolve('') },
  }
  return { app, BrowserWindow, dialog, ipcMain, shell, default: { app, BrowserWindow, dialog, ipcMain, shell } }
})

const mkdtempSync_ = (await import('node:fs')).mkdtempSync

/** Invokes an IPC handler exactly as the preload bridge does. */
async function call<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = state.handlers.get(channel)
  if (!handler) throw new Error(`Build Studio registers no handler for "${channel}".`)
  return await handler({ sender: {} }, ...args) as T
}

/** Loads the module once, after the mock is in place. */
async function studio(): Promise<void> {
  await import('./main')
  // The app's own startup callback runs on `whenReady`, which resolves immediately.
  await new Promise((resolve) => { setTimeout(resolve, 20) })
}

describe('the Build Studio main process', () => {
  beforeEach(async () => {
    state.handlers.clear()
    state.saved.length = 0
    state.opened.length = 0
    state.shown.length = 0
    state.sends.length = 0
    state.dialogResults = { openDirectory: '', openFile: '', save: '' }
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    state.userData = mkdtempSync(join(tmpdir(), 'studio-main-'))
    vi.resetModules()
    await studio()
  })

  it('registers every channel the preload bridge can call', async () => {
    const { readFileSync } = await import('node:fs')
    const preload = readFileSync('buildstudio/preload.ts', 'utf8')
    // Every `invoke('x:y')` in the bridge must have a handler here, or a button in the window silently does nothing.
    const channels = [...preload.matchAll(/invoke\('([a-z:-]+)'/gu)].map((match) => match[1]!)
    expect(channels.length).toBeGreaterThan(20)
    const unhandled = channels.filter((channel) => !state.handlers.has(channel))
    expect(unhandled, 'the bridge can call these, but no handler exists').toEqual([])
  })

  it('reports the tool version and the actions it offers', async () => {
    const info = await call<{ version: string; tools: Array<{ id: string }>; steps: Array<{ id: string }> }>('app:info')
    expect(info.version).toBe('9.9.9')
    expect(info.tools.length).toBeGreaterThan(3)
    // Eleven steps: the plan the one-click build runs end to end.
    expect(info.steps.length).toBe(11)
  })

  it('offers every currency in the catalogue, so the window cannot invent one', async () => {
    const { CURRENCIES } = await import('../src/currency/catalog')
    const currencies = await call<Array<{ code: string }>>('app:currencies')
    expect(currencies).toHaveLength(CURRENCIES.length)
    expect(currencies.map((currency) => currency.code)).toContain('GHS')
  })

  it('saves settings without ever writing a private key, and keeps the stored password hash', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const first = await call<Record<string, unknown>>('settings:write', {
      format: 'infoflex-build-studio-settings', version: 1, projectPath: null, outputPath: 'dist',
      certificatePath: null, autoIncrementVersion: false, releaseNotes: '',
      buildProfile: { format: 'infoflex-build-profile', version: 1, appVersion: '1.0.0', defaultCurrencyCode: 'GHS', lockCurrency: true, maximumOnsitePeriodYears: 3, licenseServerUrl: null },
      masterPasswordHash: { algorithm: 'PBKDF2-SHA256', iterations: 310_000, salt: 's', hash: 'h' },
    })
    expect(first).toBeTruthy()
    // A later save from the window never carries the hash (it is never sent to the window); it must survive anyway.
    const second = await call<{ masterPasswordHash: unknown }>('settings:write', {
      format: 'infoflex-build-studio-settings', version: 1, projectPath: 'C:\\p', outputPath: 'dist',
      certificatePath: null, autoIncrementVersion: true, releaseNotes: 'notes',
      buildProfile: { format: 'infoflex-build-profile', version: 1, appVersion: '1.0.1', defaultCurrencyCode: 'GHS', lockCurrency: true, maximumOnsitePeriodYears: 3, licenseServerUrl: null },
      masterPasswordHash: null,
    })
    expect(second.masterPasswordHash).toEqual({ algorithm: 'PBKDF2-SHA256', iterations: 310_000, salt: 's', hash: 'h' })

    const text = readFileSync(join(state.userData, 'build-studio-settings.json'), 'utf8')
    expect(text).toContain('GHS')
    expect(text).not.toMatch(/PRIVATE KEY/u)
  })

  it('refuses a settings file that would contain a private key', async () => {
    await expect(call('settings:write', {
      format: 'infoflex-build-studio-settings', version: 1, projectPath: null, outputPath: 'dist',
      certificatePath: '-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----',
      autoIncrementVersion: false, releaseNotes: '',
      buildProfile: { format: 'infoflex-build-profile', version: 1, appVersion: '1.0.0', defaultCurrencyCode: 'NGN', lockCurrency: false, maximumOnsitePeriodYears: null, licenseServerUrl: null },
      masterPasswordHash: null,
    })).rejects.toThrow(/will not write a private key/iu)
  })

  it('checks a folder is really the project before accepting it', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const empty = mkdtempSync(join(tmpdir(), 'not-project-'))
    const bad = await call<{ ok: boolean; message: string }>('project:detect', empty)
    expect(bad.ok).toBe(false)
    expect(bad.message).toMatch(/package\.json/iu)

    writeFileSync(join(empty, 'package.json'), JSON.stringify({ name: 'infoflex-pharmart', version: '3.2.1' }))
    const good = await call<{ ok: boolean; name: string; version: string }>('project:detect', empty)
    expect(good).toMatchObject({ ok: true, name: 'infoflex-pharmart', version: '3.2.1' })
  })

  it('answers the system check with rows the window can draw', async () => {
    const result = await call<{ checks: Array<{ id: string; state: string; required: boolean }>; ready: boolean; headline: string }>('check:run')
    expect(result.checks.length).toBeGreaterThan(3)
    expect(['ok', 'missing-installable', 'blocked']).toContain(result.checks[0]!.state)
    expect(typeof result.headline).toBe('string')
    // On this machine Node exists, so it cannot claim nothing is installed.
    expect(result.checks.some((check) => check.state === 'ok')).toBe(true)
  })

  it('refuses to build before a project is chosen, and says so in words', async () => {
    const result = await call<{ ok: boolean; message: string }>('build:run', 'do-everything')
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/choose the project folder/iu)
  })

  it('refuses an action it does not know rather than doing nothing', async () => {
    await expect(call('build:run', 'make-me-a-sandwich')).rejects.toThrow(/not a Build Studio action/iu)
  })

  it('answers "not yet" to an artefact check before a project is chosen, rather than crashing the screen', async () => {
    // The window draws whatever this returns. Answering undefined here made Output throw on `.missing.length`, which
    // is a crash the vendor sees and nobody can diagnose.
    const answer = await call<{ ok: boolean; message: string } | undefined>('artefacts:verify')
    expect(answer).toMatchObject({ ok: false })
    expect(answer?.message).toMatch(/choose the project folder/iu)
  })

  it('reports artefacts from the disk, including the ones that are missing', async () => {
    const project = state.userData
    await call('settings:write', {
      format: 'infoflex-build-studio-settings', version: 1, projectPath: project, outputPath: 'dist',
      certificatePath: null, autoIncrementVersion: false, releaseNotes: '',
      buildProfile: { format: 'infoflex-build-profile', version: 1, appVersion: '1.0.0', defaultCurrencyCode: 'NGN', lockCurrency: false, maximumOnsitePeriodYears: null, licenseServerUrl: null },
      masterPasswordHash: null,
    })
    const report = await call<{ artefacts: Array<{ title: string; exists: boolean }>; missing: string[] }>('artefacts:verify')
    expect(report.artefacts.length).toBeGreaterThanOrEqual(3)
    // Nothing has been built in this sandbox, so every installer is missing — and it must say so rather than list them.
    expect(report.missing.length).toBeGreaterThan(0)
    expect(report.artefacts.every((artefact) => !artefact.exists)).toBe(true)
  })

  it('unlocks the vendor tools only against the stored hash, then forgets the password', async () => {
    // No hash stored yet: refuse, with an explanation rather than a crash.
    const none = await call<{ ok: boolean; message: string }>('vendor:unlock', 'anything')
    expect(none.ok).toBe(false)
    expect(none.message).toMatch(/master password/iu)

    const { createMasterPasswordHash } = await import('../src/license/vendor-policy')
    const hash = createMasterPasswordHash('CorrectHorseBatteryStaple')
    await call('settings:write', {
      format: 'infoflex-build-studio-settings', version: 1, projectPath: null, outputPath: 'dist',
      certificatePath: null, autoIncrementVersion: false, releaseNotes: '',
      buildProfile: { format: 'infoflex-build-profile', version: 1, appVersion: '1.0.0', defaultCurrencyCode: 'NGN', lockCurrency: false, maximumOnsitePeriodYears: null, licenseServerUrl: null },
      masterPasswordHash: hash,
    })

    expect(await call<{ ok: boolean }>('vendor:unlock', 'wrong-password')).toEqual({ ok: false, message: 'That password is not correct.' })
    expect(await call<{ ok: boolean }>('vendor:unlock', 'CorrectHorseBatteryStaple')).toEqual({ ok: true })

    // The password must never reach the log, on either path.
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const logText = readFileSync(join(state.userData, 'build-studio.log'), 'utf8')
    expect(logText).not.toContain('CorrectHorseBatteryStaple')
    expect(logText).not.toContain('wrong-password')
  })

  it('generates a key pair and returns the private half only to be written to a file', async () => {
    const result = await call<{ ok: boolean; publicKeyPem: string; fingerprint: string; privateKeyPem: string }>('vendor:generate-keys', 'test-key-2026')
    expect(result.ok).toBe(true)
    expect(result.publicKeyPem).toContain('BEGIN PUBLIC KEY')
    expect(result.privateKeyPem).toContain('BEGIN PRIVATE KEY')
    expect(result.fingerprint).toBeTruthy()
  })

  it('writes the private key only to the path the vendor picks, with owner-only permissions', async () => {
    const { readFileSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')
    const target = join(state.userData, 'chosen-private-key.pem')
    state.dialogResults.save = target

    const key = await call<{ privateKeyPem: string }>('vendor:generate-keys', 'test-key-2026')
    const written = await call<string | null>('dialog:save-private-key', key.privateKeyPem, 'test-key-2026')
    expect(written).toBe(target)
    expect(readFileSync(target, 'utf8')).toBe(key.privateKeyPem)
    // Owner-only on the file that matters most.
    if (process.platform !== 'win32') {
      expect(statSync(target).mode & 0o777).toBe(0o600)
    }

    // And the log records that it happened without recording what it was.
    const logText = readFileSync(join(state.userData, 'build-studio.log'), 'utf8')
    expect(logText).toContain('test-key-2026')
    expect(logText).not.toContain('BEGIN PRIVATE KEY')
  })

  it('writes nothing when the vendor cancels the save dialog', async () => {
    state.dialogResults.save = ''
    const written = await call<string | null>('dialog:save-private-key', '-----BEGIN PRIVATE KEY-----\nX\n-----END PRIVATE KEY-----', 'k')
    expect(written).toBeNull()
  })

  it('opens the policy page from the bundle beside the main process', async () => {
    await call('app:open-policy-page')
    expect(state.opened).toHaveLength(1)
    expect(state.opened[0]).toMatch(/policy\.html$/u)
  })

  it('gives the log screen a real path and its contents', async () => {
    const path = await call<string>('log:path')
    expect(path).toMatch(/build-studio\.log$/u)
    expect(typeof await call<string>('log:copy')).toBe('string')
  })

  it('copies the built files to the drive the vendor picked, and refuses when there is nothing to copy', async () => {
    const { mkdirSync, writeFileSync, readdirSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const project = state.userData
    const drive = mkdtempSync_(join(tmpdir(), 'usb-'))

    await call('settings:write', {
      format: 'infoflex-build-studio-settings', version: 1, projectPath: project, outputPath: 'dist',
      certificatePath: null, autoIncrementVersion: false, releaseNotes: '',
      buildProfile: { format: 'infoflex-build-profile', version: 1, appVersion: '1.0.0', defaultCurrencyCode: 'NGN', lockCurrency: false, maximumOnsitePeriodYears: null, licenseServerUrl: null },
      masterPasswordHash: null,
    })

    // Nothing built yet: it must say so rather than create an empty folder on the vendor's stick.
    const empty = await call<{ ok: boolean; message: string }>('artefacts:copy-to-drive', drive)
    expect(empty).toMatchObject({ ok: false })
    expect(empty.message).toMatch(/nothing built yet/iu)
    expect(readdirSync(drive)).toEqual([])

    // Build the cloud package for real, which is the one artefact this environment can produce.
    mkdirSync(join(project, 'dist/cloud'), { recursive: true })
    writeFileSync(join(project, 'dist/cloud/infoflex-vendor-cloud.zip'), 'pretend zip')

    const copied = await call<{ ok: boolean; folder: string; message: string }>('artefacts:copy-to-drive', `${drive}/`)
    expect(copied.ok).toBe(true)
    const folder = join(drive, 'Infoflex Installers')
    expect(copied.folder).toBe(folder)
    expect(readdirSync(folder)).toContain('Vendor Cloud package')
    // Copied verbatim, not re-encoded or renamed to something the vendor cannot find.
    expect(readFileSync(join(folder, 'Vendor Cloud package'), 'utf8')).toBe('pretend zip')
  })

  it('opens the output folder in Explorer only when there is a project', async () => {
    expect(await call<boolean>('artefacts:open-folder')).toBe(false)
    const { join } = await import('node:path')
    await call('settings:write', {
      format: 'infoflex-build-studio-settings', version: 1, projectPath: state.userData, outputPath: 'out',
      certificatePath: null, autoIncrementVersion: false, releaseNotes: '',
      buildProfile: { format: 'infoflex-build-profile', version: 1, appVersion: '1.0.0', defaultCurrencyCode: 'NGN', lockCurrency: false, maximumOnsitePeriodYears: null, licenseServerUrl: null },
      masterPasswordHash: null,
    })
    expect(await call<boolean>('artefacts:open-folder')).toBe(true)
    expect(state.opened.at(-1)).toBe(join(state.userData, 'out'))
  })

  it('will not run a downloaded installer whose publisher cannot be verified', async () => {
    // On Linux there is no Authenticode, so the answer is "cannot verify" — and the safe direction is to refuse.
    // The file must not be run, and the vendor must be told they can install it themselves.
    const result = await call<{ ok: boolean; results: Array<{ ok: boolean; message: string }> }>('tools:install', ['git'])
    expect(result.ok).toBe(false)
    const first = result.results[0]
    expect(first?.ok).toBe(false)
    expect(first?.message).toMatch(/will not be run|publisher|downloaded/iu)
  })
})
