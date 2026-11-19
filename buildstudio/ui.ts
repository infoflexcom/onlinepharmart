/**
 * The Build Studio window.
 *
 * Deliberately plain script with no framework: the whole program is a few hundred lines of DOM work, and a build
 * tool that fails to start because a bundler mis-configured itself is a worse outcome than one written by hand.
 *
 * All privileged work goes through `window.studio`, which the preload script exposes. Nothing here touches files,
 * processes or the network directly.
 */

interface Studio {
  settings: { read: () => Promise<Settings>; write: (settings: unknown) => Promise<Settings> }
  dialog: { pickFolder: (current: string | null) => Promise<string | null>; pickFile: (title: string) => Promise<string | null>; savePrivateKey: (pem: string, keyId: string) => Promise<string | null> }
  project: { detect: (folder: string) => Promise<{ ok: boolean; name?: string; version?: string; message?: string }> }
  check: { run: () => Promise<CheckResult> }
  tools: { install: (ids: string[]) => Promise<{ ok: boolean; results: Array<{ id: string; ok: boolean; message: string }> }> }
  build: {
    run: (group: string) => Promise<BuildResult>
    cancel: () => Promise<void>
    onStep: (handler: (step: { id: string; title: string; detail: string }) => void) => () => void
    onProgress: (handler: (value: { percent: number }) => void) => () => void
  }
  artefacts: {
    verify: () => Promise<ArtefactReport>
    openFolder: () => Promise<boolean>
    copyToDrive: (path: string) => Promise<{ ok: boolean; message: string; folder?: string }>
  }
  drives: { list: () => Promise<Array<{ path: string; label: string }>> }
  vendor: { unlock: (password: string) => Promise<{ ok: boolean; message?: string }>; generateKeys: (keyId: string) => Promise<{ ok: boolean; publicKeyPem?: string; fingerprint?: string; privateKeyPem?: string; message?: string }> }
  log: { path: () => Promise<string>; open: () => Promise<boolean>; copy: () => Promise<string>; onLine: (handler: (line: string) => void) => () => void }
  app: {
    info: () => Promise<{ version: string; tools: Array<{ id: string; title: string; required: boolean }>; steps: Array<{ id: string; title: string; detail: string }> }>
    currencies: () => Promise<Array<{ code: string; name: string; symbol: string }>>
    openPolicyPage: () => Promise<boolean>
  }
}

interface Settings {
  projectPath: string | null
  outputPath: string | null
  certificatePath: string | null
  buildProfile: { appVersion: string; defaultCurrencyCode: string; lockCurrency: boolean; maximumOnsitePeriodYears: number | null; licenseServerUrl: string | null }
  autoIncrementVersion: boolean
  releaseNotes: string
  masterPasswordHash: unknown
}

interface CheckRow { id: string; title: string; required: boolean; state: 'ok' | 'missing-installable' | 'blocked'; message: string }
interface CheckResult { checks: CheckRow[]; ready: boolean; headline: string }
interface Artefact { title: string; path: string; relativePath: string; exists: boolean; sizeBytes: number; sha256: string | null }
interface ArtefactReport { artefacts: Artefact[]; missing: string[] }
interface BuildResult { ok: boolean; cancelled?: boolean; message?: string; detail?: string[]; artefacts?: Artefact[]; missing?: string[] }

/**
 * `window.studio` is installed by the preload script.
 *
 * This file is a classic script, not a module, so a top-level `interface` here merges into the global one — which is
 * what lets the rest of the file say `window.studio` and have it type-checked.
 */
interface Window { studio: Studio }

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Build Studio is missing part of its window: ${id}`)
  return element as T
}

/** The currencies, in the order the app lists them. Kept here as a label list only; the build reads the real table. */
let currencies: Array<{ code: string; name: string; symbol: string }> = []
let settings: Settings
let lastGroup = 'do-everything'
let unbindLog: (() => void) | null = null

// --------------------------------------------------------------------------------------------- tabs

function showTab(name: string): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('#tabs button')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === name))
  }
  for (const panel of document.querySelectorAll<HTMLElement>('[data-panel]')) {
    panel.classList.toggle('hidden', panel.dataset.panel !== name)
  }
}

for (const button of document.querySelectorAll<HTMLButtonElement>('#tabs button')) {
  button.addEventListener('click', () => showTab(button.dataset.tab ?? 'welcome'))
}

// --------------------------------------------------------------------------------------------- log

function appendLog(line: string, isError = false): void {
  const box = $('build-log')
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 24
  const row = document.createElement('div')
  if (isError || /\berror\b|\bfail/iu.test(line)) row.className = 'err'
  row.textContent = line
  box.append(row)
  // Only auto-scroll when the vendor is already at the bottom, so reading back is not fought with.
  if (atBottom) box.scrollTop = box.scrollHeight
}

// --------------------------------------------------------------------------------------------- settings

function renderCurrencySelect(): void {
  const select = $('default-currency') as HTMLSelectElement
  select.innerHTML = ''
  for (const currency of currencies) {
    const option = document.createElement('option')
    option.value = currency.code
    option.textContent = `${currency.code} - ${currency.name} (${currency.symbol})`
    select.append(option)
  }
  select.value = settings.buildProfile.defaultCurrencyCode
}

function renderOnsitePeriods(): void {
  const select = $('onsite-period') as HTMLSelectElement
  select.innerHTML = ''
  const choices: Array<[string, string]> = [
    ['', 'No limit'], ['1', '1 year'], ['2', '2 years'], ['3', '3 years'], ['5', '5 years'], ['10', '10 years'],
  ]
  for (const [value, label] of choices) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    select.append(option)
  }
  select.value = settings.buildProfile.maximumOnsitePeriodYears === null ? '' : String(settings.buildProfile.maximumOnsitePeriodYears)
}

function renderSettings(): void {
  ;($('project-path') as HTMLInputElement).value = settings.projectPath ?? ''
  ;($('output-path') as HTMLInputElement).value = settings.outputPath ?? 'dist'
  ;($('cert-path') as HTMLInputElement).value = settings.certificatePath ?? ''
  ;($('cloud-url') as HTMLInputElement).value = settings.buildProfile.licenseServerUrl ?? ''
  ;($('app-version-input') as HTMLInputElement).value = settings.buildProfile.appVersion
  ;($('auto-increment') as HTMLInputElement).checked = settings.autoIncrementVersion
  ;($('release-notes') as HTMLTextAreaElement).value = settings.releaseNotes ?? ''
  ;($('lock-currency') as HTMLSelectElement).value = settings.buildProfile.lockCurrency ? 'on' : 'off'
  renderCurrencySelect()
  renderOnsitePeriods()
}

function collectSettings(): Settings {
  const next: Settings = {
    ...settings,
    outputPath: ($('output-path') as HTMLInputElement).value.trim() || 'dist',
    autoIncrementVersion: ($('auto-increment') as HTMLInputElement).checked,
    releaseNotes: ($('release-notes') as HTMLTextAreaElement).value,
    buildProfile: {
      appVersion: ($('app-version-input') as HTMLInputElement).value.trim(),
      defaultCurrencyCode: ($('default-currency') as HTMLSelectElement).value,
      lockCurrency: ($('lock-currency') as HTMLSelectElement).value === 'on',
      maximumOnsitePeriodYears: ($('onsite-period') as HTMLSelectElement).value === ''
        ? null
        : Number(($('onsite-period') as HTMLSelectElement).value),
      licenseServerUrl: ($('cloud-url') as HTMLInputElement).value.trim() || null,
    },
  }
  return next
}

// --------------------------------------------------------------------------------------------- system check

function glyph(state: CheckRow['state']): string {
  return state === 'ok' ? '✓' : state === 'blocked' ? '✕' : '↓'
}

function renderChecks(result: CheckResult): void {
  const list = $('checks')
  list.innerHTML = ''
  for (const check of result.checks) {
    const row = document.createElement('div')
    row.className = `check ${check.state === 'ok' ? 'ok' : check.state === 'blocked' ? 'red' : 'orange'}`
    const glyphBox = document.createElement('div')
    glyphBox.className = 'glyph'
    glyphBox.textContent = glyph(check.state)
    const body = document.createElement('div')
    body.className = 'body'
    const name = document.createElement('div')
    name.className = 'name'
    name.textContent = check.title
    if (!check.required) {
      const tag = document.createElement('span')
      tag.className = 'tag'
      tag.textContent = 'optional'
      name.append(tag)
    }
    const message = document.createElement('div')
    message.className = 'msg'
    message.textContent = check.message
    body.append(name, message)
    row.append(glyphBox, body)
    list.append(row)
  }
  const verdict = $('verdict')
  verdict.className = `verdict ${result.ready ? 'ready' : 'notready'}`
  verdict.textContent = result.headline
  verdict.classList.remove('hidden')

  const installable = result.checks.filter((check) => check.state === 'missing-installable' && check.required)
  ;($('install-missing') as HTMLButtonElement).disabled = installable.length === 0
  ;($('install-missing') as HTMLButtonElement).textContent = installable.length > 0
    ? `Install ${installable.length === 1 ? 'the missing tool' : `the ${installable.length} missing tools`}`
    : 'Nothing missing to install'
  ;($('browse-installer') as HTMLButtonElement).disabled = installable.length === 0
}

async function runCheck(): Promise<void> {
  showTab('check')
  const button = $('run-check') as HTMLButtonElement
  button.disabled = true
  button.textContent = 'Checking…'
  $('check-errors').innerHTML = ''
  try {
    renderChecks(await window.studio.check.run())
  } catch (error) {
    showError('check-errors', error instanceof Error ? error.message : String(error))
  } finally {
    button.disabled = false
    button.textContent = 'Check again'
  }
}

// --------------------------------------------------------------------------------------------- errors

function showError(containerId: string, message: string, fixes: string[] = []): void {
  const container = $(containerId)
  const box = document.createElement('div')
  box.className = 'errbox'
  const heading = document.createElement('h4')
  heading.textContent = 'That did not work'
  const text = document.createElement('div')
  text.textContent = message
  box.append(heading, text)
  if (fixes.length > 0) {
    const list = document.createElement('ul')
    for (const fix of fixes) {
      const item = document.createElement('li')
      item.textContent = fix
      list.append(item)
    }
    box.append(list)
  }
  container.innerHTML = ''
  container.append(box)
}

// --------------------------------------------------------------------------------------------- build

function setBuilding(active: boolean): void {
  for (const id of ['do-everything', 'install-missing']) {
    const element = document.getElementById(id) as HTMLButtonElement | null
    if (element) element.disabled = active
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-build]')) button.disabled = active
  ;($('cancel-build') as HTMLButtonElement).disabled = !active
}

async function runBuild(group: string): Promise<void> {
  lastGroup = group
  showTab('build')
  $('build-log').innerHTML = ''
  $('build-errors').innerHTML = ''
  ;($('retry-build') as HTMLButtonElement).disabled = true
  ;($('build-bar') as HTMLElement).style.width = '0%'
  ;($('build-step') as HTMLElement).textContent = 'Starting…'
  setBuilding(true)

  const started = Date.now()
  const timer = window.setInterval(() => {
    const seconds = Math.floor((Date.now() - started) / 1000)
    ;($('build-elapsed') as HTMLElement).textContent = `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
  }, 1000)

  const removeStep = window.studio.build.onStep((step) => {
    ;($('build-step') as HTMLElement).textContent = `${step.title} — ${step.detail}`
  })
  const removeProgress = window.studio.build.onProgress((value) => {
    ;($('build-bar') as HTMLElement).style.width = `${value.percent}%`
  })

  try {
    const result = await window.studio.build.run(group)
    if (!result.ok) {
      if (result.cancelled) {
        ;($('build-step') as HTMLElement).textContent = 'Cancelled.'
      } else {
        showError('build-errors', result.message ?? 'The build stopped.', result.detail ?? [])
        ;($('retry-build') as HTMLButtonElement).disabled = false
      }
    } else {
      ;($('build-bar') as HTMLElement).style.width = '100%'
      ;($('build-step') as HTMLElement).textContent = 'Finished.'
      await refreshArtefacts()
      showTab('output')
    }
  } catch (error) {
    showError('build-errors', error instanceof Error ? error.message : String(error))
    ;($('retry-build') as HTMLButtonElement).disabled = false
  } finally {
    window.clearInterval(timer)
    setBuilding(false)
    removeStep()
    removeProgress()
  }
}

// --------------------------------------------------------------------------------------------- artefacts

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${value.toFixed(1)} ${units[unit]}`
}

function renderArtefacts(report: ArtefactReport): void {
  const table = document.createElement('table')
  const head = document.createElement('tr')
  for (const label of ['File', 'Size', 'Fingerprint (SHA-256)', 'Built']) {
    const cell = document.createElement('th')
    cell.textContent = label
    head.append(cell)
  }
  table.append(head)
  for (const artefact of report.artefacts) {
    const row = document.createElement('tr')
    const name = document.createElement('td')
    name.textContent = artefact.title
    const size = document.createElement('td')
    size.textContent = artefact.exists ? formatBytes(artefact.sizeBytes) : '—'
    const hash = document.createElement('td')
    hash.className = 'mono'
    hash.textContent = artefact.sha256 ?? '—'
    const state = document.createElement('td')
    const pill = document.createElement('span')
    pill.className = `pill ${artefact.exists ? 'yes' : 'no'}`
    pill.textContent = artefact.exists ? 'yes' : 'missing'
    state.append(pill)
    row.append(name, size, hash, state)
    table.append(row)
  }
  const container = $('artefacts')
  container.innerHTML = ''
  container.append(table)
  if (report.missing.length > 0) {
    const note = document.createElement('div')
    note.className = 'callout bad'
    note.textContent = report.missing.join(' ')
    container.prepend(note)
  }
}

async function refreshArtefacts(): Promise<void> {
  try {
    renderArtefacts(await window.studio.artefacts.verify())
  } catch (error) {
    showError('artefacts', error instanceof Error ? error.message : String(error))
  }
}

async function refreshDrives(): Promise<void> {
  const container = $('drives')
  container.innerHTML = ''
  const drives = await window.studio.drives.list()
  if (drives.length === 0) {
    const note = document.createElement('p')
    note.className = 'muted'
    note.textContent = 'No other drive found. Plug in the USB drive and press Refresh.'
    container.append(note)
    return
  }
  for (const drive of drives) {
    const button = document.createElement('button')
    button.className = 'drive'
    button.innerHTML = ''
    const name = document.createElement('b')
    name.textContent = drive.label
    const path = document.createElement('span')
    path.className = 'muted'
    path.textContent = drive.path
    button.append(name, path)
    button.addEventListener('click', async () => {
      const result = await window.studio.artefacts.copyToDrive(drive.path)
      const box = $('copy-result')
      box.innerHTML = ''
      const note = document.createElement('div')
      note.className = result.ok ? 'callout' : 'callout bad'
      note.textContent = result.message
      box.append(note)
    })
    container.append(button)
  }
}

// --------------------------------------------------------------------------------------------- vendor

function renderKeys(result: { publicKeyPem: string; fingerprint: string; privateKeyPem?: string }): void {
  const container = $('key-result')
  container.innerHTML = ''
  const heading = document.createElement('div')
  heading.className = 'callout'
  heading.innerHTML = '<strong>Public key</strong> — this is the half that goes into builds. Its fingerprint is '
    + `<span class="mono">${result.fingerprint}</span>.`
  const box = document.createElement('div')
  box.className = 'keybox'
  box.textContent = result.publicKeyPem
  const warning = document.createElement('div')
  warning.className = 'callout bad'
  warning.innerHTML = '<strong>The private key has not been saved yet.</strong> Press "Save the private key" and choose a safe place. Upload it to the Vendor Cloud as a secret. Never put it in a build, an email or this folder.'
  const save = document.createElement('button')
  save.className = 'primary'
  save.textContent = 'Save the private key…'
  container.append(heading, box, warning, save)
  // The private key is held only in this closure, and dropped as soon as it is written to disk.
  const pending = result.privateKeyPem
  save.addEventListener('click', async () => {
    const keyId = ($('key-id') as HTMLInputElement).value.trim()
    const path = await window.studio.dialog.savePrivateKey(pending ?? '', keyId)
    if (path) {
      warning.className = 'callout'
      warning.innerHTML = `<strong>Saved</strong> to <span class="mono">${path}</span>. Upload it to the Vendor Cloud now and keep a backup somewhere safe.`
      save.remove()
    }
  })
}

// --------------------------------------------------------------------------------------------- start

async function start(): Promise<void> {
  settings = await window.studio.settings.read()
  renderSettings()

  // The currency list comes from the main process, which reads the same table the app uses. If it cannot be read the
  // select stays empty rather than offering a currency the build does not know about.
  currencies = await window.studio.app.currencies()
  renderCurrencySelect()

  const info = await window.studio.app.info()
  $('app-version').textContent = `Version ${info.version}`
  unbindLog = window.studio.log.onLine((line) => appendLog(line))
  void unbindLog

  if (settings.projectPath) {
    const detected = await window.studio.project.detect(settings.projectPath)
    $('project-info').textContent = detected.ok
      ? `${detected.name} ${detected.version} — this looks right.`
      : detected.message ?? 'That folder does not look right.'
  }
  showTab('welcome')
}

// --------------------------------------------------------------------------------------------- wiring

$('start-check').addEventListener('click', () => { void runCheck() })
$('run-check').addEventListener('click', () => { void runCheck() })

$('install-missing').addEventListener('click', async () => {
  const checks = await window.studio.check.run()
  const missing = checks.checks.filter((check) => check.state === 'missing-installable' && check.required).map((check) => check.id)
  ;($('install-missing') as HTMLButtonElement).disabled = true
  ;($('install-missing') as HTMLButtonElement).textContent = 'Installing…'
  try {
    const result = await window.studio.tools.install(missing)
    if (!result.ok) {
      showError('check-errors', 'Some tools could not be installed automatically.', result.results.filter((r) => !r.ok).map((r) => r.message))
    }
  } finally {
    await runCheck()
  }
})

$('browse-installer').addEventListener('click', async () => {
  const path = await window.studio.dialog.pickFile('Choose the installer you downloaded')
  const box = $('check-errors')
  if (path) box.innerHTML = `<div class="callout">Chosen: <span class="mono">${path}</span>. Run it, then press "Check again".</div>`
})

$('pick-project').addEventListener('click', async () => {
  const folder = await window.studio.dialog.pickFolder(settings.projectPath)
  if (!folder) return
  const detected = await window.studio.project.detect(folder)
  if (!detected.ok) {
    showError('project-error', detected.message ?? 'That folder does not look like the Infoflex project.')
    return
  }
  settings = await window.studio.settings.write({ ...settings, projectPath: folder })
  ;($('project-path') as HTMLInputElement).value = folder
  ;($('project-info') as HTMLElement).textContent = `${detected.name} ${detected.version} — this looks right.`
  $('project-error').innerHTML = ''
})

$('do-everything').addEventListener('click', () => {
  if (!settings.projectPath) {
    // Send the vendor to the screen with the thing that is missing, rather than an error they cannot act on.
    showTab('project')
    showError('project-error', 'Choose the project folder first.')
    return
  }
  void runBuild('do-everything')
})
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-build]')) {
  button.addEventListener('click', () => {
    if (!settings.projectPath) {
      showTab('project')
      showError('project-error', 'Choose the project folder first.')
      return
    }
    void runBuild(button.dataset.build ?? 'do-everything')
  })
}
$('cancel-build').addEventListener('click', () => { void window.studio.build.cancel() })
$('retry-build').addEventListener('click', () => { void runBuild(lastGroup) })
$('open-log').addEventListener('click', () => { void window.studio.log.open() })
$('copy-errors').addEventListener('click', async () => {
  const text = await window.studio.log.copy()
  await navigator.clipboard.writeText(text)
  ;($('copy-errors') as HTMLButtonElement).textContent = 'Copied'
  window.setTimeout(() => { ;($('copy-errors') as HTMLButtonElement).textContent = 'Copy error details' }, 2000)
})

$('refresh-output').addEventListener('click', () => { void refreshArtefacts() })
$('open-folder').addEventListener('click', () => { void window.studio.artefacts.openFolder() })
$('refresh-drives').addEventListener('click', () => { void refreshDrives() })

$('unlock-vendor').addEventListener('click', async () => {
  const password = ($('vendor-password') as HTMLInputElement).value
  if (!password) return
  const result = await window.studio.vendor.unlock(password)
  // Clear the field whatever happened: a password left in a box is a password on a screen.
  ;($('vendor-password') as HTMLInputElement).value = ''
  if (result.ok) {
    $('vendor-locked').classList.add('hidden')
    $('vendor-unlocked').classList.remove('hidden')
    $('unlock-error').innerHTML = ''
  } else {
    showError('unlock-error', result.message ?? 'That password is not correct.')
  }
})

// The policy page is a separate local file so it works by double-clicking, with no Electron and no build step. It
// is opened in the vendor's own browser rather than an in-app view, so nothing of Build Studio's window is exposed to
// a page whose whole job is handling the master password.
$('open-policy-page').addEventListener('click', () => { void window.studio.app.openPolicyPage() })

$('generate-keys').addEventListener('click', async () => {
  const keyId = ($('key-id') as HTMLInputElement).value.trim()
  const result = await window.studio.vendor.generateKeys(keyId)
  if (!result.ok || !result.publicKeyPem || !result.fingerprint) {
    showError('key-result', result.message ?? 'The key could not be generated.')
    return
  }
  renderKeys({ publicKeyPem: result.publicKeyPem, fingerprint: result.fingerprint, privateKeyPem: result.privateKeyPem })
})

$('save-notes').addEventListener('click', async () => {
  settings = await window.studio.settings.write(collectSettings())
  ;($('notes-result') as HTMLElement).textContent = 'Saved.'
})

$('pick-output').addEventListener('click', async () => {
  const folder = await window.studio.dialog.pickFolder(settings.projectPath)
  if (!folder) return
  ;($('output-path') as HTMLInputElement).value = folder
})
$('pick-cert').addEventListener('click', async () => {
  const path = await window.studio.dialog.pickFile('Choose the code-signing certificate')
  if (path) ($('cert-path') as HTMLInputElement).value = path
})

$('save-settings').addEventListener('click', async () => {
  const next = collectSettings()
  const problems: string[] = []
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(next.buildProfile.appVersion)) problems.push('The version must look like 1.4.2.')
  if (next.buildProfile.licenseServerUrl) {
    try {
      const url = new URL(next.buildProfile.licenseServerUrl)
      const local = ['localhost', '127.0.0.1'].includes(url.hostname)
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) problems.push('The Vendor Cloud address must start with https://')
    } catch {
      problems.push('The Vendor Cloud address does not look like an address.')
    }
  }
  if (problems.length > 0) {
    showError('settings-problems', 'These settings need fixing.', problems)
    return
  }
  $('settings-problems').innerHTML = ''
  settings = await window.studio.settings.write(next)
  const saved = $('settings-saved')
  saved.textContent = 'Saved.'
  window.setTimeout(() => { saved.textContent = '' }, 2500)
})

void start()
