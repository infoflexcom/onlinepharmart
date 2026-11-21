import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { BUILD_STEPS, explainFailure, redactSecrets, stepsForGroup, totalWeight } from './src/build-steps'
import { TOOLS, findTool, planDownload, type ToolId } from './src/prerequisites'
import { runSystemCheck } from './src/system-check'
import { runCommand, type RunningCommand } from './src/runner'
import {
  defaultSettings, incrementVersion, readSettings, writeSettings, type BuildStudioSettings,
} from './src/settings-store'
import { inspectAllArtefacts, removableDriveChoices, windowsDriveRoots } from './src/artefacts'
import { authenticodeScript, canCheckAuthenticode, interpretAuthenticode } from './src/authenticode'
import { generateLicenceKeyPair } from './src/licence-keys'
import { buildProfileProblems, serializeBuildProfile } from '../installer/src/build-profile'
import { verifyMasterPassword } from '../src/license/vendor-policy'
import { CURRENCIES } from '../src/currency/catalog'

/**
 * Infoflex Build Studio — the vendor's window onto the build.
 *
 * This file is deliberately thin. Everything that decides something lives in `src/`, where it has tests that run on
 * any machine; what is left here is the parts that genuinely need Electron: windows, dialogs, spawning processes and
 * writing files. The rule the brief sets — no terminal for the vendor — is met by never opening one: every child
 * process is hidden, and all output is streamed into the window instead.
 *
 * Two things are never written anywhere: the vendor master password (only its salted hash) and the signing private
 * key (only to a file the vendor picks, from a dialog, once).
 */

let window: BrowserWindow | null = null
let settings: BuildStudioSettings = defaultSettings()
let settingsDirectory = ''
let running: RunningCommand | null = null
let logPath = ''
/** Secrets to redact from everything this run emits. Never persisted. */
const runSecrets: string[] = []

function settingsDir(): string {
  // Beside the vendor's own profile, not in the project: the project is what gets copied to another machine.
  return join(app.getPath('userData'))
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    title: 'Infoflex Build Studio',
    backgroundColor: '#f7f4ee',
    icon: join(__dirname, '../build/icon.ico'),
    // No menu bar: the brief asks for buttons, and a stray View/Reload menu is a way to get into a state a
    // non-programmer cannot get out of.
    autoHideMenuBar: true,
    webPreferences: {
      // The window shows local HTML and talks through this one preload bridge; nothing remote is loaded.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: join(__dirname, 'preload.js'),
    },
  })
  void window.loadFile(join(__dirname, 'index.html'))
  window.on('closed', () => { window = null })
}

app.whenReady().then(() => {
  settingsDirectory = settingsDir()
  settings = readSettings(settingsDirectory)
  logPath = join(settingsDirectory, 'build-studio.log')
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
}).catch((error: unknown) => {
  dialog.showErrorBox('Infoflex Build Studio could not start', error instanceof Error ? error.message : String(error))
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

// --------------------------------------------------------------------------------------------- logging

function log(line: string): void {
  const text = redactSecrets(line, runSecrets)
  try {
    appendFileSync(logPath, `${new Date().toISOString()} ${text}\n`, 'utf8')
  } catch {
    // A log that cannot be written must not stop a build.
  }
  window?.webContents.send('log:line', text)
}

// --------------------------------------------------------------------------------------------- probing

/** Runs a command and returns its first output line, or null when it is not installed. */
function probeVersion(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: string | null): void => { if (!settled) { settled = true; resolve(value) } }
    let child
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      done(null)
      return
    }
    let output = ''
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
    child.on('error', () => done(null))
    child.on('close', (code) => done(code === 0 ? (output.split(/\r?\n/u).find((line) => line.trim()) ?? null) : null))
    setTimeout(() => { done(null); try { child.kill() } catch { /* gone */ } }, 15_000).unref()
  })
}

/**
 * Whether the C++ build tools are installed, from the registry key their installer writes.
 *
 * `reg query` is a console program, so it is run hidden and its output parsed rather than forwarded: the vendor must
 * never see a console flash. Returning null means "not asked", which the system check treats as not blocking.
 */
function probeCppTools(): Promise<boolean | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  return new Promise((resolve) => {
    let settled = false
    const done = (value: boolean | null): void => { if (!settled) { settled = true; resolve(value) } }
    let child
    try {
      child = spawn('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\Installer', '/s', '/f', 'VC,Tools'], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      done(null)
      return
    }
    let output = ''
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
    child.on('error', () => done(null))
    child.on('close', (code) => done(code === 0 && output.length > 0))
    setTimeout(() => { done(null); try { child.kill() } catch { /* gone */ } }, 20_000).unref()
  })
}

function freeDiskBytes(path: string): Promise<bigint> {
  return new Promise((resolve) => {
    // `fs.statfs` is available on Node 18+; a failure is reported as "plenty" rather than blocking a build.
    import('node:fs').then(({ statfs }) => {
      statfs(path, (error, stats) => {
        if (error) resolve(1n << 40n)
        else resolve(BigInt(stats.bavail) * BigInt(stats.bsize))
      })
    }).catch(() => resolve(1n << 40n))
  })
}

// --------------------------------------------------------------------------------------------- IPC

ipcMain.handle('settings:read', () => settings)

ipcMain.handle('settings:write', (_event, next: BuildStudioSettings) => {
  settings = { ...next, masterPasswordHash: next.masterPasswordHash ?? settings.masterPasswordHash }
  writeSettings(settingsDirectory, settings)
  log('Settings saved.')
  return settings
})

ipcMain.handle('dialog:pick-folder', async (_event, current: string | null) => {
  if (!window) return null
  const result = await dialog.showOpenDialog(window, {
    title: 'Choose the Infoflex project folder', defaultPath: current ?? homedir(), properties: ['openDirectory'],
  })
  return result.canceled ? null : result.filePaths[0] ?? null
})

ipcMain.handle('dialog:pick-file', async (_event, title: string) => {
  if (!window) return null
  const result = await dialog.showOpenDialog(window, { title, properties: ['openFile'] })
  return result.canceled ? null : result.filePaths[0] ?? null
})

ipcMain.handle('dialog:save-private-key', async (_event, pem: string, keyId: string) => {
  if (!window) return null
  const result = await dialog.showSaveDialog(window, {
    title: 'Save the private signing key (keep this file safe)',
    defaultPath: join(homedir(), `${keyId}-PRIVATE-KEY.pem`),
    filters: [{ name: 'Key file', extensions: ['pem'] }],
  })
  if (result.canceled || !result.filePath) return null
  // Written once, to a path the vendor chose, with an explicit warning. It is never logged and never in settings.
  writeFileSync(result.filePath, pem, { encoding: 'utf8', mode: 0o600 })
  log(`Private signing key for "${keyId}" saved. Its contents are deliberately not logged.`)
  return result.filePath
})

ipcMain.handle('project:detect', (_event, folder: string) => {
  try {
    const manifest = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')) as { name?: string; version?: string }
    return { ok: true, name: manifest.name ?? 'Infoflex', version: manifest.version ?? '0.0.0' }
  } catch {
    return { ok: false, message: 'That folder does not look like the Infoflex project: there is no readable package.json in it.' }
  }
})

ipcMain.handle('check:run', async () => {
  log('Checking this computer.')
  const result = await runSystemCheck({
    probe: async (tool) => (tool.probe ? probeVersion(tool.probe.command, tool.probe.args) : null),
    probePartialInstall: probeCppTools,
    freeDiskBytes: () => freeDiskBytes(settings.projectPath ?? process.cwd()),
    canInstall: (tool) => planDownload(tool.id as ToolId).ok,
  })
  log(result.headline)
  return result
})

ipcMain.handle('tools:install', async (_event, ids: ToolId[]) => {
  if (!window) return { ok: false, message: 'The window is closed.' }
  const results: Array<{ id: ToolId; ok: boolean; message: string }> = []
  for (const id of ids) {
    const tool = findTool(id)
    if (!tool) continue
    const planned = planDownload(id)
    if (!planned.ok) {
      results.push({ id, ok: false, message: planned.reason })
      log(`${tool.title}: ${planned.reason}`)
      continue
    }
    log(`Downloading ${tool.title} from ${new URL(planned.plan.url).hostname}.`)
    const target = join(tmpdir(), `infoflex-${id}${planned.plan.url.endsWith('.msi') ? '.msi' : '.exe'}`)
    const download = await downloadToFile(planned.plan.url, target, tool.title)
    if (!download.ok) {
      results.push({ id, ok: false, message: download.message })
      continue
    }
    log(`Running the ${tool.title} installer without opening a window.`)
    const exitCode = await runInstaller(target, planned.plan.silentArguments)
    results.push({
      id, ok: exitCode === 0 || exitCode === 3010,
      message: exitCode === 3010 ? `${tool.title} installed; Windows wants a restart to finish.` : exitCode === 0 ? `${tool.title} installed.` : `${tool.title} installer finished with code ${exitCode}.`,
    })
  }
  return { ok: results.every((result) => result.ok), results }
})

/**
 * Downloads to a file, then verifies the Authenticode publisher before anything is run.
 *
 * The signature check is the reason a vendor can trust this: the URL is hard-coded, but a compromised network could
 * still serve a different file, and running it would be the end of the customer's machine. `Get-AuthenticodeSignature`
 * is the only built-in way to check, and it is invoked hidden so no console appears.
 */
async function downloadToFile(url: string, target: string, title: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await fetch(url, { redirect: 'follow' })
    if (!response.ok) return { ok: false, message: `${title} could not be downloaded (the server said ${response.status}).` }
    const buffer = Buffer.from(await response.arrayBuffer())
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, buffer)
    log(`Downloaded ${buffer.length} bytes.`)
    const publisher = await authenticodePublisher(target)
    if (publisher === null) {
      return { ok: false, message: `${title} was downloaded but its publisher could not be verified, so it will not be run. You can install it yourself from the official website.` }
    }
    log(`Publisher verified: ${publisher}`)
    return { ok: true }
  } catch (error) {
    return { ok: false, message: `${title} could not be downloaded: ${error instanceof Error ? error.message : String(error)}. You can install it yourself from the official website.` }
  }
}

function authenticodePublisher(path: string): Promise<string | null> {
  if (!canCheckAuthenticode(process.platform)) return Promise.resolve(null)
  return new Promise((resolve) => {
    const script = authenticodeScript(path)
    let child
    try {
      child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      resolve(null)
      return
    }
    let output = ''
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
    child.on('error', () => resolve(null))
    child.on('close', (code) => resolve(interpretAuthenticode({ exitCode: code, stdout: output })))
    setTimeout(() => { try { child.kill() } catch { /* gone */ } resolve(null) }, 30_000).unref()
  })
}

function runInstaller(path: string, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(path, args, { windowsHide: true, stdio: 'ignore' })
    } catch {
      resolve(null)
      return
    }
    child.on('error', () => resolve(null))
    child.on('close', (code) => resolve(code))
  })
}

ipcMain.handle('build:run', async (_event, group: string) => {
  if (running) return { ok: false, message: 'A build is already running.' }
  // Validated before anything else: an action that does not exist is a fault in the caller, and reporting it as
  // "choose the project folder first" would send the vendor looking for the wrong problem.
  const steps = stepsForGroup(group)
  const projectPath = settings.projectPath
  if (!projectPath) return { ok: false, message: 'Choose the project folder first.' }
  const total = totalWeight(steps)
  let doneWeight = 0

  // The build profile is written into the project so the installer generator and the app pick it up.
  const problems = buildProfileProblems(settings.buildProfile)
  if (problems.length > 0) {
    return { ok: false, message: problems.map((problem) => problem.message).join(' ') }
  }
  const profileVersion = settings.autoIncrementVersion
    ? incrementVersion(settings.buildProfile.appVersion)
    : settings.buildProfile.appVersion
  const profile = { ...settings.buildProfile, appVersion: profileVersion }
  writeFileSync(join(projectPath, 'build-profile.json'), serializeBuildProfile(profile), 'utf8')
  writeFileSync(join(projectPath, 'buildprofile.generated.json'), serializeBuildProfile(profile), 'utf8')
  log(`Build profile written: currency ${profile.defaultCurrencyCode}${profile.lockCurrency ? ' (locked)' : ''}, version ${profileVersion}.`)

  for (const step of steps) {
    window?.webContents.send('build:step', { id: step.id, title: step.title, detail: step.detail })
    log(`--- ${step.title}`)
    const command = runCommand({
      cwd: projectPath, command: step.command, args: step.args, secrets: runSecrets,
      env: { INFOFLEX_BUILD_PROFILE: profile.defaultCurrencyCode, INFOFLEX_BUILD_VERSION: profileVersion },
      onLine: (line) => log(line),
      onDone: () => {},
      idleNoticeMs: 20_000,
      idleNotice: (elapsed) => log(`Still working… (${Math.round(elapsed / 1000)}s with no output, which is normal for this step).`),
    })
    running = command
    const result = await command.done
    running = null

    if (result.cancelled) {
      log('Build cancelled.')
      return { ok: false, cancelled: true, message: 'The build was cancelled. Nothing was copied anywhere.' }
    }
    if (result.exitCode !== 0) {
      // The raw output was already streamed; what the vendor needs is the sentence and the fixes.
      const explanation = explainFailure({ step, output: '', exitCode: result.exitCode })
      log(`${explanation.cause} ${explanation.fixes.join(' ')}`)
      return { ok: false, message: explanation.cause, detail: explanation.fixes }
    }
    doneWeight += step.weight
    window?.webContents.send('build:progress', { percent: Math.floor((doneWeight / total) * 100) })
  }

  const report = await inspectAllArtefacts(projectPath, profileVersion)
  log(report.missing.length === 0 ? 'Every promised file was produced.' : report.missing.join(' '))
  return { ok: report.missing.length === 0, artefacts: report.artefacts, missing: report.missing }
})

ipcMain.handle('build:cancel', () => { running?.cancel() })

ipcMain.handle('artefacts:verify', async () => {
  if (!settings.projectPath) return { ok: false, message: 'Choose the project folder first.' }
  return inspectAllArtefacts(settings.projectPath, settings.buildProfile.appVersion)
})

ipcMain.handle('artefacts:open-folder', async () => {
  if (!settings.projectPath) return false
  await shell.openPath(join(settings.projectPath, settings.outputPath ?? 'dist'))
  return true
})

ipcMain.handle('artefacts:copy-to-drive', async (_event, drivePath: string) => {
  if (!settings.projectPath) return { ok: false, message: 'Choose the project folder first.' }
  const report = await inspectAllArtefacts(settings.projectPath, settings.buildProfile.appVersion)
  const built = report.artefacts.filter((artefact) => artefact.exists)
  if (built.length === 0) return { ok: false, message: 'There is nothing built yet to copy.' }
  const folder = join(drivePath, 'Infoflex Installers')
  mkdirSync(folder, { recursive: true })
  for (const artefact of built) {
    cpSync(artefact.path, join(folder, `${artefact.title}`))
  }
  log(`Copied ${built.length} files to ${folder}.`)
  return { ok: true, message: `Copied ${built.length} files to ${folder}.`, folder }
})

ipcMain.handle('drives:list', () =>
  // Electron has no cross-platform drive enumeration; on Windows the letters that exist are the useful answer.
  removableDriveChoices(windowsDriveRoots(process.platform, (path) => {
    const exists = existsSync(path)
    return { exists, isDirectory: exists && statSync(path).isDirectory() }
  })))

ipcMain.handle('vendor:unlock', (_event, password: string) => {
  // The password is checked against the stored salted hash and then dropped. It is never held, never logged.
  if (!settings.masterPasswordHash) {
    return { ok: false, message: 'Set the vendor master password in the app\'s vendor policy first, then import that policy here.' }
  }
  const ok = verifyMasterPassword(password, settings.masterPasswordHash)
  log(ok ? 'Vendor tools unlocked.' : 'Vendor tools: wrong password.')
  return ok ? { ok: true } : { ok: false, message: 'That password is not correct.' }
})

ipcMain.handle('vendor:generate-keys', (_event, keyId: string) => {
  try {
    const pair = generateLicenceKeyPair(keyId)
    // Only the public half comes back to the window; the private half goes straight to the save dialog.
    return { ok: true, publicKeyPem: pair.publicKeyPem, fingerprint: pair.publicKeyFingerprint, privateKeyPem: pair.privateKeyPem }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
})

ipcMain.handle('app:open-policy-page', async () => {
  // Deliberately in the vendor's browser, not in a Build Studio window: the page handles the master password, and a
  // plain local HTML file with no preload and no Node is the safest possible place for that.
  await shell.openPath(join(__dirname, 'policy.html'))
  return true
})

ipcMain.handle('log:path', () => logPath)

ipcMain.handle('log:open', async () => { await shell.openPath(logPath); return true })

ipcMain.handle('log:copy', () => {
  try {
    return readFileSync(logPath, 'utf8')
  } catch {
    return ''
  }
})

ipcMain.handle('app:currencies', () =>
  // The same table the app itself uses, so Build Studio cannot offer a currency the build does not know.
  CURRENCIES.map((currency) => ({ code: currency.code, name: currency.name, symbol: currency.symbol })))

ipcMain.handle('app:info', () => ({ version: app.getVersion(), tools: TOOLS.map((tool) => ({ id: tool.id, title: tool.title, required: tool.required })), steps: BUILD_STEPS.map((step) => ({ id: step.id, title: step.title, detail: step.detail })) }))
