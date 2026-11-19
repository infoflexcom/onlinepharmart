import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'

/**
 * Checks this installer against electron-builder's actual NSIS template, rather than against our belief about it.
 *
 * WHY THIS IS SEPARATE FROM `npm run installer:compile`
 *
 * That check compiles `installer/nsis/harness/harness.nsi`, which stands in for electron-builder's template: it defines
 * the same macros, inserts the hooks at the same points and provides the same variables. It is a good stand-in and it
 * found six real defects. But by construction it cannot catch a disagreement *with the template itself* — if the harness
 * inserts a hook where electron-builder does not, both agree and both are wrong.
 *
 * The template is not a guess: it ships inside `node_modules/app-builder-lib`, so it is right here and can be read. What
 * follows pins the parts of the contract that fail *silently* when they are wrong:
 *
 *  - electron-builder inserts every hook behind `!ifmacrodef`. A misspelled macro name is not an error: the hook is
 *    skipped, the installer builds, and the password page or the currency write simply never happens. Nothing in a
 *    compile log says so.
 *  - Hook order decides when our code runs. `customInstall` runs after the payload and the shortcuts; `customUnInstall`
 *    runs before electron-builder deletes the files. Code placed against the wrong hook still compiles.
 *
 * If `node_modules` is absent this file skips rather than failing, because the template is a dependency, not a source
 * file. It is worth knowing when it skipped: a skipped contract test is not a passing one.
 */

const TEMPLATE_DIR = 'node_modules/app-builder-lib/templates/nsis'
const available = existsSync(`${TEMPLATE_DIR}/installer.nsi`)

/** electron-builder's own sources, all of them — hooks are inserted from more than one file. */
function templateSource(): string {
  if (!available) return ''
  return ['installer.nsi', 'assistedInstaller.nsh', 'installSection.nsh', 'uninstaller.nsh', 'oneClick.nsh', 'common.nsh']
    .filter((name) => existsSync(`${TEMPLATE_DIR}/${name}`))
    .map((name) => readFileSync(`${TEMPLATE_DIR}/${name}`, 'utf8'))
    .join('\n')
}

/**
 * Macros this script defines for its own use, not as electron-builder hooks.
 *
 * The template calls a hook by name via `!ifmacrodef`; anything else we define is ours alone, and listing it here is a
 * deliberate act rather than a wildcard. Each entry needs a reason, because an unexplained name here would silently
 * disable the typo check that the surrounding tests exist for.
 */
const INTERNAL_MACROS = new Set([
  // Shared by the system-check page, the silent branch of .onInit and the upgrade path, so the three cannot disagree
  // about whether the VC++ runtime is present. Not a hook: nothing in electron-builder knows it by name.
  'DetectVcRuntime',
])

/** The macros we define that electron-builder may call. */
function ourMacros(): string[] {
  const text = readFileSync('installer/nsis/installer.nsi', 'utf8')
  return [...text.matchAll(/^!macro ([A-Za-z_0-9]+)$/gmu)]
    .map((match) => match[1]!)
    .filter((name) => !INTERNAL_MACROS.has(name))
}

/** Every macro name electron-builder guards with `!ifmacrodef`. */
function hookNames(): string[] {
  return [...new Set([...templateSource().matchAll(/!ifmacrodef ([A-Za-z_0-9]+)/gu)].map((match) => match[1]!))]
}

describe.skipIf(!available)('our hooks match electron-builder’s template', () => {
  it('defines only macros the template actually calls', () => {
    // The reverse of the check below, and the one that catches a typo on our side: `!macro customInstal` would sit
    // there looking correct while the template called `customInstall` and found nothing.
    const hooks = hookNames()
    const orphans = ourMacros().filter((name) => !hooks.includes(name))
    expect(orphans, 'these macros are defined but electron-builder never calls them — check the spelling').toEqual([])
  })

  it('defines every hook the template would otherwise skip', () => {
    // The five we rely on. If the template starts calling a sixth that we do not define, this fails and we look it up
    // rather than shipping a build where a step silently does not happen.
    const required = ['customWelcomePage', 'customPageAfterChangeDir', 'customFinishPage', 'customInstall', 'customUnInstall']
    const defined = ourMacros()
    for (const name of required) {
      expect(defined, `the installer no longer defines ${name}`).toContain(name)
      expect(hookNames(), `electron-builder no longer calls ${name}`).toContain(name)
    }
  })

  it('puts the page hooks where the template inserts them, in page order', () => {
    // Our four custom pages live in customPageAfterChangeDir. If the template ever inserts it before the directory page
    // or after the install page, the pages would appear in the wrong place and nothing would error.
    const assisted = readFileSync(`${TEMPLATE_DIR}/assistedInstaller.nsh`, 'utf8')
    const welcome = assisted.indexOf('!insertmacro customWelcomePage')
    const directory = assisted.indexOf('!insertmacro MUI_PAGE_DIRECTORY')
    const custom = assisted.indexOf('!insertmacro customPageAfterChangeDir')
    const instfiles = assisted.indexOf('!insertmacro MUI_PAGE_INSTFILES')
    const finish = assisted.indexOf('!insertmacro customFinishPage')
    expect(welcome, 'customWelcomePage must come before the directory page').toBeLessThan(directory)
    expect(directory, 'customPageAfterChangeDir must follow the directory page').toBeLessThan(custom)
    expect(custom, 'customPageAfterChangeDir must precede the install-files page').toBeLessThan(instfiles)
    expect(instfiles, 'customFinishPage must follow the install-files page').toBeLessThan(finish)
  })

  it('runs customInstall after the payload and the shortcuts are in place', () => {
    // Our customInstall writes the currency registry keys and install-config.json. Running it before the payload landed
    // would leave a config pointing at a directory that does not exist yet; the template gets this right and the
    // ordering is not ours to assume.
    const section = readFileSync(`${TEMPLATE_DIR}/installSection.nsh`, 'utf8')
    const payload = section.indexOf('!insertmacro installApplicationFiles')
    const shortcuts = section.indexOf('!insertmacro addDesktopLink')
    const hook = section.indexOf('!insertmacro customInstall')
    expect(payload).toBeGreaterThan(-1)
    expect(shortcuts, 'the desktop shortcut is created before customInstall').toBeLessThan(hook)
    expect(payload, 'the payload is copied before customInstall').toBeLessThan(hook)
  })

  it('runs customUnInstall before electron-builder deletes the files', () => {
    // Our uninstall hook runs netsh and deletes registry keys. After the delete would still work for the registry, but
    // it is the ordering the template promises and it is what the firewall rule depends on being reached at all.
    const uninstaller = readFileSync(`${TEMPLATE_DIR}/uninstaller.nsh`, 'utf8')
    const hook = uninstaller.indexOf('!insertmacro customUnInstall')
    const deleteFiles = uninstaller.indexOf('# delete the installed files')
    expect(hook).toBeGreaterThan(-1)
    expect(deleteFiles).toBeGreaterThan(-1)
    expect(hook, 'customUnInstall must run before the installed files are removed').toBeLessThan(deleteFiles)
  })
})

describe('the template test says when it did not run', () => {
  it('is only skipped when the dependency is genuinely absent', () => {
    // A silently skipped contract test reads as a passing one in the summary line. This does not fail the suite -- the
    // template is a dependency and `npm ci` may not have run -- but it records why, so a green run is not mistaken for
    // proof that the contract was checked.
    if (!available) console.warn('electron-builder template not installed; the hook contract was NOT checked')
    expect(typeof available).toBe('boolean')
  })
})
