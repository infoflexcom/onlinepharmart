import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Guards the static checker against the failure that actually shipped.
 *
 * `installer:check` once blessed `${NSD_LB_GetCurSel}`, `${NSD_LB_SetCurSel}`, `${NSD_DisableWindow}` and
 * `${GetFileSize}`. None of those exist in any NSIS header. The checker passed; the installer would not compile.
 *
 * The cause was an allowlist written from memory. This test cannot fix that in general — a list of somebody else's
 * macro names can always drift — but it does two things that would have caught every one of the four:
 *
 *  1. Every macro the installer uses must appear in the checker's allowlist. A typo in the script is caught by
 *     `installer:check`; a typo in the *allowlist* is caught here.
 *  2. The names that were wrong are named explicitly, so nobody re-adds them from memory a second time.
 *
 * `npm run installer:compile` is the real proof: it compiles both builds with a real makensis. This test is the fast
 * guard that runs in the ordinary suite, where makensis is not available.
 */

const SCRIPT = readFileSync('installer/nsis/installer.nsi', 'utf8')
const CHECKER = readFileSync('installer/src/check-nsis-script.ts', 'utf8')

/** The macros this installer invokes, in `${Name}` form. */
function usedMacros(): string[] {
  return [...new Set([...SCRIPT.matchAll(/\$\{([A-Z][A-Za-z0-9_]*)\}/gu)].map((match) => match[1]!))]
}

describe('the installer only uses macros that exist', () => {
  it('names the four that did not exist, so they cannot come back', () => {
    // Each of these was in the checker's allowlist and in the script, and each is a hard NSIS compile error. If any
    // reappears in the script, this fails with the reason attached.
    const invented = ['NSD_LB_GetCurSel', 'NSD_LB_SetCurSel', 'NSD_DisableWindow', 'GetFileSize']
    const used = usedMacros()
    for (const name of invented) {
      expect(used, `${name} does not exist in any NSIS header, but the installer calls it`).not.toContain(name)
      expect(CHECKER, `${name} does not exist, but the checker's allowlist still blesses it`).not.toContain(`'${name}'`)
    }
  })

  it('uses the real nsDialogs list-box macros', () => {
    // The replacements: get and set the selected row of a list box.
    expect(SCRIPT).toContain('${NSD_LB_GetSelectionIndex}')
    expect(SCRIPT).toContain('${NSD_LB_SetSelectionIndex}')
  })

  it('includes the header that defines RunningX64', () => {
    // RunningX64 comes from x64.nsh. It is NOT in WinVer.nsh, which is what the checker's map claimed, so the
    // ${ElseIfNot} ${RunningX64} branch was a compile error and the checks page could never have been built.
    expect(SCRIPT).toContain('${RunningX64}')
    expect(SCRIPT, 'RunningX64 is used, so x64.nsh must be included').toContain('!include "x64.nsh"')
  })

  it('defines AtLeastWin10 itself, because WinVer.nsh never does', () => {
    // NSIS defines AtLeastWin8 and AtLeastWin11. Windows 10 and 11 both report major version 10, so there is no
    // AtLeastWin10 to use, and the installer has to supply one.
    expect(SCRIPT).toContain('${AtLeastWin10}')
    expect(SCRIPT).toMatch(/!define AtLeastWin10/u)
  })

  it('has no comment ending in a backslash', () => {
    // A backslash at the end of an NSIS line escapes the newline, so the NEXT line is silently swallowed. One such
    // comment ate the `StrCmp $1 '\'` branch of EscapeJson, which meant a backslash was never doubled and every
    // Windows path written into install-config.json produced invalid JSON.
    const bad = SCRIPT.split('\n')
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => /^\s*;.*\\$/u.test(line.trimEnd()) || /^\s*;.*\\\s*$/u.test(line))
    expect(bad.map(({ line, number }) => `${number}: ${line}`), 'a comment ending in a backslash eats the next line')
      .toEqual([])
  })
})
