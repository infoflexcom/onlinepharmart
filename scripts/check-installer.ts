import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { checkNsisScript, type ScriptProblem } from '../installer/src/check-nsis-script'

/**
 * Everything that can be verified about the installer without Windows.
 *
 * Run by `npm run installer:check` and by `check:phase13`. It is deliberately a build gate rather than a test,
 * because two of its checks are about files on disk that only exist after the generator has run:
 *
 *   1. the generated includes are present and current;
 *   2. the `.nsi` and both includes pass the static checker;
 *   3. no installer source or generated output contains the vendor master password;
 *   4. the BMP brand assets NSIS needs are real 24-bit bitmaps.
 *
 * What it cannot do — compile the script, launch the wizard, click through it — is recorded in
 * `docs/PHASES.md` and is a manual checklist item, not something this pretends to cover.
 */

const failures: string[] = []
const notes: string[] = []

function fail(message: string): void {
  failures.push(message)
}

function walk(directory: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else out.push(path)
  }
  return out
}

// ---- 1. generated includes exist
const includeFiles = ['installer/nsis/generated.nsh', 'installer/nsis/currency-ui.nsh']
for (const file of includeFiles) {
  try {
    const text = readFileSync(file, 'utf8')
    if (!text.includes('GENERATED')) fail(`${file} does not look generated; run npm run installer:script.`)
    if (text.length < 1000) fail(`${file} is suspiciously small.`)
    notes.push(`${file}: ${text.split('\n').length} lines`)
  } catch {
    fail(`${file} is missing. Run npm run installer:script.`)
  }
}

// ---- 2. the NSIS script passes the static checker
const scriptFiles = ['installer/nsis/installer.nsi', ...includeFiles]
// The checker reads the companion includes, so an unknown macro is caught even in a file full of includes.
const companionScripts: Record<string, string> = {}
for (const file of includeFiles) {
  try {
    companionScripts[file.replace('installer/nsis/', '')] = readFileSync(file, 'utf8')
  } catch {
    // Reported by the presence check above.
  }
}
for (const file of scriptFiles) {
  let problems: ScriptProblem[]
  try {
    problems = checkNsisScript(readFileSync(file, 'utf8'), { companionScripts })
  } catch {
    fail(`${file} could not be read.`)
    continue
  }
  for (const problem of problems) fail(`${file}:${problem.line} — ${problem.message}`)
  notes.push(`${file}: ${problems.length} structural problems`)
}

// ---- 3. no master password anywhere in the installer's own sources or output
//
// The scan covers what gets compiled or shipped: the .nsi and its includes, and the generator that feeds them.
// The test files are deliberately excluded, because they contain the *pattern* ("/Handywife/iu") as the thing
// they are asserting must not appear — a guard that could not tell a pattern from a secret would push the tests
// towards not checking at all, which is the wrong trade.
const shippedSources = [
  ...walk('installer/nsis'),
  ...walk('installer/src').filter((file) => !file.endsWith('.test.ts')),
  'package.json',
  'electron-builder.installer-online.json',
  'electron-builder.installer-offline.json',
]
const masterPassword = process.env.INFOFLEX_MASTER_PASSWORD?.trim() ?? null
for (const file of shippedSources) {
  const text = readFileSync(file, 'utf8')
  if (/Handywife/iu.test(text)) fail(`${file} contains the vendor master password.`)
  if (masterPassword && text.toLowerCase().includes(masterPassword.toLowerCase())) {
    fail(`${file} contains the vendor master password in plain text.`)
  }
}
notes.push(`scanned ${shippedSources.length} shipped installer files for the master password`)
if (!masterPassword) {
  // Without the secret in the environment only the known password shape can be searched for. Say so rather than
  // implying the scan was exhaustive.
  notes.push('INFOFLEX_MASTER_PASSWORD is not set, so the scan used the known password shape only')
}

// ---- 4. the BMP brand assets NSIS needs
for (const file of ['build/installer-banner.bmp', 'build/installer-sidebar.bmp', 'build/icon.ico']) {
  try {
    const bytes = readFileSync(file)
    if (file.endsWith('.bmp')) {
      if (bytes.subarray(0, 2).toString('latin1') !== 'BM') fail(`${file} is not a BMP.`)
      if (bytes.readUInt16LE(28) !== 24) fail(`${file} is not a 24-bit BMP.`)
    } else {
      // .ico: reserved 0, type 1
      if (bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) fail(`${file} is not an icon file.`)
    }
    notes.push(`${file}: ${bytes.length} bytes`)
  } catch {
    fail(`${file} is missing. Run npm run installer:assets.`)
  }
}

for (const note of notes) console.log(`  ${note}`)
if (failures.length > 0) {
  console.error('')
  for (const failure of failures) console.error(`FAIL ${failure}`)
  console.error(`\n${failures.length} installer problem${failures.length === 1 ? '' : 's'} found.`)
  process.exit(1)
}
console.log('\nInstaller sources are consistent. Compiling them still needs Windows or Wine — see docs/PHASES.md.')
