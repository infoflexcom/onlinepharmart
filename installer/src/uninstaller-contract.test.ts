import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The uninstaller, which this phase found had never once been compiled.
 *
 * WHY THIS FILE EXISTS
 *
 * electron-builder builds the installer twice. The second pass re-runs makensis with `BUILD_UNINSTALLER` defined, and
 * only that pass includes `uninstaller.nsh` — the file that owns the `!insertmacro customUnInstall` call. Until this
 * phase, nothing in this repository ever compiled that pass: the harness has three shapes (online, offline,
 * offline-wrapper) and all three are installer passes.
 *
 * What was hiding there, found by finally compiling it:
 *
 *   1. This script defined `Function un.onInit`. electron-builder's `uninstaller.nsh` defines it too, and this script
 *      is layered into that same compile via `nsis.include`, so the uninstaller could not build at all:
 *      `Error: Function named "un.onInit" already exists.` The installer half still built perfectly, which is why
 *      nobody noticed.
 *
 *   2. That function deleted `$APPDATA\Infoflex` to honour "remove my data". Under `perMachine: true` the template has
 *      already run `SetShellVarContext all`, so `$APPDATA` was `C:\ProgramData` — the delete pointed at a folder that
 *      never held the database. Choosing "remove everything" would have kept everything, and said otherwise.
 *
 *   3. `install-config.json`, which the installer writes into ProgramData, was never removed.
 *
 * Each test below pins one of those, and each fails if the defect returns. The compile itself is pinned by
 * `scripts/compile-check-installer.ts`, whose fourth build (`uninstaller-pass`) reproduces electron-builder's layering
 * — including the template's own `un.onInit` — so the collision is a build failure and not just a missing assertion.
 */

const script = readFileSync(join(process.cwd(), 'installer/nsis/installer.nsi'), 'utf8')
const harness = readFileSync(join(process.cwd(), 'installer/nsis/harness/uninstaller-pass.nsi'), 'utf8')

/**
 * The body of a `!macro name` / `Function name` block, or '' when it does not exist.
 *
 * Comments are stripped first, and that is not tidiness. The first version of the context test passed against a script
 * whose `SetShellVarContext current` had been deleted, because the string still appeared in the explanatory comment
 * above it -- a test satisfied by prose. Every assertion below reads code, so the input has to be code.
 */
function blockOf(source: string, name: string): string {
  const opener = new RegExp(`^(?:!macro|Function)\\s+${name}\\s*$`, 'mu')
  const match = opener.exec(source)
  if (!match) return ''
  const rest = source.slice(match.index)
  const end = /^(?:!macroend|FunctionEnd)\s*$/mu.exec(rest)
  const body = end ? rest.slice(0, end.index) : ''
  return body
    .split('\n')
    .filter((line) => !line.trimStart().startsWith(';'))
    .join('\n')
}

describe('the uninstaller hooks electron-builder actually calls', () => {
  it('does not define un.onInit, which the template already defines', () => {
    // electron-builder's uninstaller.nsh:5 defines `Function un.onInit`. Defining it here is a hard compile error, not
    // a shadowed duplicate -- NSIS refuses the second definition outright.
    expect(script).not.toMatch(/^\s*Function\s+un\.onInit\b/mu)
  })

  it('uses the customUnInit hook for the keep-my-data question', () => {
    const body = blockOf(script, 'customUnInit')
    expect(body).not.toBe('')
    expect(body).toMatch(/Keep your shop data/u)
  })

  it('switches to the per-user shell context before deleting the app data folder', () => {
    const body = blockOf(script, 'customUnInit')
    expect(body).not.toBe('')

    // The template runs `initMultiUser` -> `setInstallModePerAllUsers` -> `SetShellVarContext all` before this hook,
    // so $APPDATA here is C:\ProgramData unless the context is switched back. Find where each matters.
    const contextIndex = body.indexOf('SetShellVarContext current')
    expect(contextIndex).toBeGreaterThanOrEqual(0)

    const appDataIndex = body.indexOf('$APPDATA\\Infoflex')
    const localAppDataIndex = body.indexOf('$LOCALAPPDATA\\Infoflex')
    expect(appDataIndex).toBeGreaterThanOrEqual(0)
    expect(localAppDataIndex).toBeGreaterThanOrEqual(0)

    // Both deletes must come AFTER the switch, or they still resolve against C:\ProgramData.
    expect(appDataIndex).toBeGreaterThan(contextIndex)
    expect(localAppDataIndex).toBeGreaterThan(contextIndex)
  })

  it('names the data folder the app actually uses, not the product name', () => {
    // src/main/index.ts pins app.setName('Infoflex'), and Electron derives userData from the app name. The install
    // directory name is a different value, so this must be the literal -- not ${PRODUCT_NAME} and not ${APP_FILENAME}.
    const body = blockOf(script, 'customUnInit')
    expect(body).not.toMatch(/\$APPDATA\\\$\{(?:PRODUCT_NAME|APP_FILENAME|PRODUCT_FILENAME)\}/u)
    expect(body).toMatch(/\$APPDATA\\Infoflex/u)
  })

  it('never prompts during an upgrade, which electron-builder runs silently', () => {
    // electron-builder runs the OLD uninstaller before every install, silently, passing --updated
    // (installUtil.nsh:200-230). This hook runs during that. A MessageBox with no /SD is NOT suppressed in silent mode:
    // NSIS returns the /SD button only when one was given, and otherwise shows the box (Source/exehead/util.c:138-141).
    // So the keep-my-data question would have appeared over an upgrade, and the answer would have decided whether the
    // customer's database survived -- while --updated says it must survive regardless.
    const body = blockOf(script, 'customUnInit')
    expect(body).not.toBe('')

    const updatedCheck = body.indexOf('--updated')
    expect(updatedCheck).toBeGreaterThanOrEqual(0)

    const messageBoxIndex = body.indexOf('MessageBox')
    expect(messageBoxIndex).toBeGreaterThanOrEqual(0)

    // The upgrade test must come FIRST: a check after the prompt cannot prevent the prompt.
    expect(updatedCheck).toBeLessThan(messageBoxIndex)

    // And the upgrade path must abandon the hook outright, not fall through to the deletion.
    const between = body.slice(updatedCheck, messageBoxIndex)
    expect(between).toMatch(/Return/u)
  })

  it('gives every MessageBox a /SD so a silent uninstall cannot block on it', () => {
    // Without /SD, NSIS shows the box even in silent mode -- a deployment tool or support script would hang until
    // somebody clicked it. Pinned as a rule over the whole file, not just this hook, because the same mistake in the
    // installer's own pages blocks an unattended install for the same reason.
    const code = script
      .split('\n')
      .filter((line) => !line.trimStart().startsWith(';'))
      .join('\n')
    const messageBoxes = [...code.matchAll(/MessageBox\s+[^\n]*/gu)].map((match) => match[0])
    expect(messageBoxes.length).toBeGreaterThan(0)
    const withoutDefault = messageBoxes.filter((line) => !/\/SD\s+ID/u.test(line))
    expect(withoutDefault, 'these MessageBoxes have no /SD and will block a silent run').toEqual([])
  })

  it('removes the install-config.json the installer wrote to ProgramData', () => {
    const body = blockOf(script, 'customUnInstall')
    expect(body).not.toBe('')
    expect(body).toMatch(/\$\{INSTALLER_CONFIG_FILE\}/u)
    expect(body).toMatch(/\$\{INSTALLER_CONFIG_DIR\}/u)
  })

  it('still removes the firewall rule, the autostart value and our registry key', () => {
    // Pinned because these are the three things electron-builder does not know about, and they were the only things
    // the uninstaller did before this phase. A rewrite that lost one would leave it behind on every machine.
    const body = blockOf(script, 'customUnInstall')
    expect(body).toMatch(/netsh advfirewall firewall delete rule name="Infoflex Mobile Access"/u)
    expect(body).toMatch(/DeleteRegValue HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Run"/u)
    expect(body).toMatch(/DeleteRegKey HKLM "Software\\Infoflex"/u)
  })
})

describe('the vendor password gate cannot be skipped', () => {
  // The gate is checked in PasswordPageLeave, which is a page callback. A silent run draws no pages, so `${Silent}`
  // skipped the gate entirely: `Setup.exe /S` installed without the vendor password and let the caller choose the
  // currency from the command line. The gate was real for a double-click and absent for a typed flag.
  const onInit = (() => {
    const start = script.indexOf('Function .onInit')
    const end = script.indexOf('FunctionEnd', start)
    return start === -1 ? '' : script.slice(start, end)
      .split('\n')
      .filter((line) => !line.trimStart().startsWith(';'))
      .join('\n')
  })()

  it('verifies the password in the silent branch, not only on the password page', () => {
    expect(onInit).toMatch(/\$\{Silent\}/u)
    const silentBlock = onInit.slice(onInit.indexOf('${Silent}'))
    expect(silentBlock).toMatch(/\/PASSWORD=/u)
    // It must actually run the checker, not merely mention the flag.
    expect(silentBlock).toMatch(/password-check\.exe/u)
    expect(silentBlock).toMatch(/nsExec::ExecToStack/u)
  })

  it('refuses a silent install that supplies no password', () => {
    const silentBlock = onInit.slice(onInit.indexOf('${Silent}'))
    const flagRead = silentBlock.indexOf('/PASSWORD=')
    expect(flagRead).toBeGreaterThanOrEqual(0)
    const currencyRead = silentBlock.indexOf('/CURRENCY=')
    expect(currencyRead).toBeGreaterThan(flagRead)

    // The missing-flag branch, between reading the flag and reading the currency: it must Abort.
    expect(silentBlock.slice(flagRead, currencyRead)).toMatch(/Abort/u)

    // And a non-zero exit from the checker must Abort too, or the check is decorative. Look only at the region that
    // follows the silent-path invocation.
    const afterCheck = silentBlock.slice(silentBlock.indexOf('ExecToStack'))
    expect(afterCheck).toMatch(/\$0 != "0"/u)
    const failedBranch = afterCheck.slice(afterCheck.indexOf('$0 != "0"'))
    expect(failedBranch.slice(0, failedBranch.indexOf('${EndIf}'))).toMatch(/Abort/u)
  })

  it('requires the password BEFORE the currency can be chosen from the command line', () => {
    // Ordering matters: a currency parsed before the gate would be accepted on a run that then fails the gate, and any
    // later code that reads it has already been told a lie about who is installing.
    const silentBlock = onInit.slice(onInit.indexOf('${Silent}'))
    const password = silentBlock.indexOf('/PASSWORD=')
    const currency = silentBlock.indexOf('/CURRENCY=')
    expect(password).toBeGreaterThanOrEqual(0)
    expect(currency).toBeGreaterThanOrEqual(0)
    expect(password).toBeLessThan(currency)
  })

  it('re-checks the OS and architecture, which /S would otherwise skip', () => {
    // ChecksPageLeave is the only place these were enforced, and a silent run draws no pages. Without the silent
    // re-check, /S on 32-bit Windows installs a 64-bit application that cannot start, and reports success.
    const silentBlock = onInit.slice(onInit.indexOf('${Silent}'))
    const currencyRead = silentBlock.indexOf('/CURRENCY=')
    const beforeCurrency = silentBlock.slice(0, currencyRead)
    expect(beforeCurrency).toMatch(/AtLeastWin10/u)
    expect(beforeCurrency).toMatch(/RunningX64/u)
    // Both must refuse, not merely mention.
    expect(beforeCurrency.match(/Abort/gu)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  it('keeps the gate on the interactive page too, so the two paths agree', () => {
    const pageLeave = (() => {
      const start = script.indexOf('Function PasswordPageLeave')
      const end = script.indexOf('FunctionEnd', start)
      return start === -1 ? '' : script.slice(start, end)
    })()
    expect(pageLeave).toMatch(/nsExec::ExecToStack/u)
    expect(pageLeave).toMatch(/\$0 == "0"/u)
  })
})

describe('the uninstaller-pass build shape', () => {
  it('reproduces the template own un.onInit, which is what makes the collision visible', () => {
    // Without this function in the harness, the harness compiles while the shipping build does not -- the failure
    // mode the fourth build exists to prevent.
    expect(harness).toMatch(/^Function un\.onInit$/mu)
  })

  it('inserts both hooks the way the template does', () => {
    expect(harness).toMatch(/!ifmacrodef customUnInit\s*\n\s*!insertmacro customUnInit/u)
    expect(harness).toMatch(/!insertmacro customUnInstall/u)
  })

  it('is a fourth build in the compile check, not a file nobody runs', () => {
    const check = readFileSync(join(process.cwd(), 'scripts/compile-check-installer.ts'), 'utf8')
    expect(check).toMatch(/uninstaller-pass/u)
    expect(check).toMatch(/installer\/nsis\/harness\/uninstaller-pass\.nsi/u)
  })

  it('is not named like an uninstaller section, which NSIS would route to a different list', () => {
    // NSIS's add_section switches to uninstaller mode when a section is named "Uninstall" or begins with "un.".
    // The section then lands in ubuild_sections, and the installer pass reports `no sections specified` -- an error
    // that says nothing about the name being the cause.
    const sectionNames = [...harness.matchAll(/^Section\s+(?:"([^"]*)"|(\S+))\s*$/gmu)].map((m) => m[1] ?? m[2])
    expect(sectionNames.length).toBeGreaterThan(0)
    for (const name of sectionNames) {
      expect(name?.toLowerCase()).not.toBe('uninstall')
      expect(name?.toLowerCase().startsWith('un.')).toBe(false)
    }
  })
})
