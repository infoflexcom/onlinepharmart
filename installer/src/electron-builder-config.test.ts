import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'

/**
 * Ties the electron-builder config to the hooks this installer needs, because the two are joined by a single boolean
 * and nothing in the build says so.
 *
 * THE TRAP
 *
 * electron-builder picks one of two page templates: `assistedInstaller.nsh` when `oneClick` is false, `oneClick.nsh`
 * when it is true. Only the assisted template calls `customWelcomePage`, `customPageAfterChangeDir` or
 * `customFinishPage` — `oneClick.nsh` is 18 lines and calls none of them.
 *
 * So setting `oneClick: true` deletes the vendor password gate and the Region and Currency page from the installer, and
 * the build still succeeds. There is no warning: every hook is inserted behind `!ifmacrodef`, which is silent when the
 * macro is never reached, and the macros are perfectly well defined — they are just never inserted. Nothing in
 * `npm run installer:compile` would notice either, because the harness inserts the hooks itself rather than reading
 * this config.
 *
 * That is exactly the shape of the defects this suite has been finding all phase: a build that succeeds while the thing
 * the build was for does not happen. It costs one test to close.
 *
 * `customInstall` and `customUnInstall` are safe either way — `installSection.nsh` and `uninstaller.nsh` are included by
 * both templates, so the registry writes and the firewall removal survive a one-click build. That is why the test below
 * can be specific rather than vague about which setting matters.
 */

interface PackageJson {
  build?: {
    nsis?: {
      oneClick?: boolean
      include?: string
      perMachine?: boolean
      [key: string]: unknown
    }
  }
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as PackageJson
const nsis = pkg.build?.nsis

/** True when electron-builder's own template files are installed, so the claims below can be re-derived from them. */
const TEMPLATE = 'node_modules/app-builder-lib/templates/nsis'
const available = existsSync(`${TEMPLATE}/assistedInstaller.nsh`) && existsSync(`${TEMPLATE}/oneClick.nsh`)

describe('the installer config keeps the pages we wrote', () => {
  it('is not a one-click installer, which would silently drop the password page and the currency page', () => {
    // The whole vendor gate depends on this. `oneClick: true` builds cleanly and ships an installer with no password.
    expect(nsis?.oneClick, 'oneClick:true removes every custom Page from the installer').toBe(false)
  })

  it('includes our script, from the path the repo actually has', () => {
    expect(nsis?.include).toBe('installer/nsis/installer.nsi')
    expect(existsSync(nsis!.include!), 'the include path in package.json points at nothing').toBe(true)
  })

  it('installs per machine, because our script writes to HKLM', () => {
    // InstallApplication writes HKLM\Software\Infoflex, and the firewall rule needs elevation. A per-user install would
    // fail at those writes at run time -- not at build time -- so the setting is part of the contract.
    expect(nsis?.perMachine).toBe(true)

    // The elevation itself is the template's job, not ours: electron-builder emits RequestExecutionLevel from
    // perMachine/oneClick, and our script deliberately leaves it alone. What ties the setting to our code is the HKLM
    // writes and the executable name the firewall rule uses.
    const script = readFileSync('installer/nsis/installer.nsi', 'utf8')
    expect(script, 'the script no longer writes HKLM, so the per-machine requirement may be stale').toContain('HKLM')
    expect(script, 'the script no longer sets the firewall rule, so the elevation requirement may be stale')
      .toContain('netsh advfirewall')
  })
})

describe('the offline build includes a wrapper, and the wrapper is what gets compiled', () => {
  it('points the offline configuration at offline-include.nsh, not at installer.nsi', () => {
    // The two configurations differ in one file. offline-include.nsh sets INFOPLEX_OFFLINE and includes installer.nsi,
    // so the shipping offline build never includes installer.nsi directly. For a whole phase the compile check built
    // "the offline build" by defining the variable itself, which meant this file was never compiled by anything.
    const offline = JSON.parse(readFileSync('electron-builder.installer-offline.json', 'utf8')) as {
      nsis?: { include?: string }
    }
    expect(offline.nsis?.include).toBe('installer/nsis/offline-include.nsh')
    expect(existsSync('installer/nsis/offline-include.nsh')).toBe(true)
  })

  it('has the wrapper include installer.nsi, so there is one set of pages', () => {
    const wrapper = readFileSync('installer/nsis/offline-include.nsh', 'utf8')
    expect(wrapper).toContain('!include "installer.nsi"')
    expect(wrapper).toContain('INFOPLEX_OFFLINE')
    // A wrapper that grew pages of its own would be a second copy of the installer that no test of installer.nsi covers.
    expect(wrapper, 'the wrapper must not define pages or functions of its own').not.toMatch(/^\s*(Page |Function )/mu)
  })

  it('compiles the wrapper as its own build, so a typo in it cannot reach a vendor', () => {
    // This is the actual guard: the wrapper being referenced is not enough, it has to be compiled.
    const check = readFileSync('scripts/compile-check-installer.ts', 'utf8')
    expect(check, 'the compile check must build the wrapper the offline config ships').toContain(
      '-DHARNESS_ENTRY=offline-include.nsh',
    )
    expect(readFileSync('installer/nsis/harness/harness.nsi', 'utf8')).toContain('!include "${HARNESS_ENTRY}"')
  })
})

describe('shortcuts point at the executable electron-builder actually wrote', () => {
  it('never builds an executable path from PRODUCT_NAME', () => {
    // electron-builder sanitises the product name into a file name: `Infoflex:Pharmart` becomes `InfoflexPharmart.exe`
    // while PRODUCT_NAME keeps the colon. A shortcut built from PRODUCT_NAME would therefore point at a file that does
    // not exist -- for the desktop, the Start menu, the finish-page "Run" box and the autostart registry value alike.
    // The install would succeed and every shortcut would silently do nothing.
    const script = readFileSync('installer/nsis/installer.nsi', 'utf8')
    // The one legitimate use is the fallback define itself, which only applies when electron-builder has supplied
    // nothing at all. It is excluded by name rather than by "any line that defines something", so a shortcut that
    // happened to be indented inside a block would still be caught.
    const offenders = script
      .split('\n')
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => /\$\{PRODUCT_NAME\}\.exe/u.test(line) && !line.trimStart().startsWith(';'))
      .filter(({ line }) => !/^\s*!define APP_EXECUTABLE_FILENAME "\$\{PRODUCT_NAME\}\.exe"$/u.test(line))
    expect(
      offenders.map(({ line, number }) => `${number}: ${line.trim()}`),
      'these refer to an .exe named from PRODUCT_NAME instead of APP_EXECUTABLE_FILENAME',
    ).toEqual([])
  })

  it('uses electron-builder’s APP_EXECUTABLE_FILENAME for every executable it points at', () => {
    const script = readFileSync('installer/nsis/installer.nsi', 'utf8')
    expect(script).toContain('CreateShortCut "$SMPROGRAMS\\${PRODUCT_NAME}.lnk" "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"')
    expect(script).toContain('CreateShortCut "$DESKTOP\\${PRODUCT_NAME}.lnk" "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"')
    expect(script).toContain('MUI_FINISHPAGE_RUN "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"')
    expect(script).toMatch(/CurrentVersion\\Run" "\$\{PRODUCT_NAME\}" '"\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}" --hidden'/u)
  })

  it('falls back only when electron-builder has not supplied the name', () => {
    // The fallback keeps the script compilable standalone. It must be guarded by !ifndef, or the real build would use
    // the guess instead of the value electron-builder passed.
    const script = readFileSync('installer/nsis/installer.nsi', 'utf8')
    const define = script.slice(script.indexOf('!ifndef APP_EXECUTABLE_FILENAME'), script.indexOf('!endif', script.indexOf('!ifndef APP_EXECUTABLE_FILENAME')))
    expect(define).toContain('PRODUCT_FILENAME')
  })
})

describe('the harness does not invent values the real build lacks', () => {
  it('defines no prerequisite path of its own', () => {
    // The harness used to define PREREQUISITE_VCREDIST so the offline branch's `File` command would resolve. Every real
    // offline build failed at that line, and the harness could never show it because the harness was the thing supplying
    // the missing value. A harness that fills in a gap is testing itself.
    const harness = readFileSync('installer/nsis/harness/harness.nsi', 'utf8')
    const definitions = [...harness.matchAll(/^\s*!define ([A-Z_0-9]+)/gmu)].map((match) => match[1]!)
    // These are the values electron-builder genuinely passes on its makensis command line, or that the harness must own
    // because they describe the harness itself. Anything else is a gap being papered over.
    const legitimate = new Set([
      'PRODUCT_NAME', 'PRODUCT_VERSION', 'APP_VERSION', 'APP_PACKAGE_NAME', 'INSTALL_MODE_PER_ALL_USERS',
      'BUILD_RESOURCES_DIR', 'HARNESS_OUTFILE', 'HARNESS_ENTRY',
      'MUI_UI', 'MUI_UI_HEADERIMAGE', 'MUI_UI_COMPONENTSPAGE_SMALLDESC', 'MUI_UI_COMPONENTSPAGE_NODESC',
    ])
    const invented = definitions.filter((name) => !legitimate.has(name))
    expect(invented, 'the harness defines values the real build does not, which can hide a build failure').toEqual([])
  })
})

describe.skipIf(!available)('the one-click claim is taken from electron-builder’s own templates', () => {
  it('confirms that only the assisted template inserts our page hooks', () => {
    // If a future electron-builder taught oneClick.nsh to call these hooks, the hard requirement above would relax --
    // and this test is how we would find out instead of guessing.
    const assisted = readFileSync(`${TEMPLATE}/assistedInstaller.nsh`, 'utf8')
    const oneClick = readFileSync(`${TEMPLATE}/oneClick.nsh`, 'utf8')
    for (const hook of ['customWelcomePage', 'customPageAfterChangeDir', 'customFinishPage']) {
      expect(assisted, `${hook} is expected in the assisted template`).toContain(`!insertmacro ${hook}`)
      expect(oneClick, `${hook} has appeared in oneClick.nsh; revisit the oneClick requirement`).not.toContain(hook)
    }
  })

  it('confirms that customInstall runs under both templates', () => {
    // Which is why the oneClick requirement is about pages only, and why the registry and firewall work is safe.
    const installer = readFileSync(`${TEMPLATE}/installer.nsi`, 'utf8')
    expect(installer).toContain('!include "installSection.nsh"')
    const section = readFileSync(`${TEMPLATE}/installSection.nsh`, 'utf8')
    expect(section).toContain('!insertmacro customInstall')
  })
})
