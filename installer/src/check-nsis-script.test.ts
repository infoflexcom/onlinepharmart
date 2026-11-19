import { describe, expect, it } from 'vitest'
import { checkNsisFile, checkNsisScript } from './check-nsis-script'

/**
 * The static NSIS checker, and the real installer script through it.
 *
 * `makensis` cannot run in this build environment, so this is the only mechanical examination the actual
 * deliverable's source receives here. It is therefore itself worth testing: a checker that passes everything is
 * worse than none, because it would give false confidence about a file that ships to customers.
 */

describe('the NSIS static checker', () => {
  it('catches a call to a function that was never declared', () => {
    const problems = checkNsisScript(`
      Function MyPage
        Call DoNotExist
      FunctionEnd
    `)
    expect(problems).toHaveLength(1)
    expect(problems[0]!.message).toMatch(/DoNotExist/)
  })

  it('accepts a call to a declared function', () => {
    expect(checkNsisScript(`
      Function Helper
      FunctionEnd
      Function MyPage
        Call Helper
      FunctionEnd
    `)).toEqual([])
  })

  it('catches unbalanced conditionals, loops and functions', () => {
    expect(checkNsisScript('${If} $0 == "1"\n${EndIf}\n')).toEqual([])
    expect(checkNsisScript('${If} $0 == "1"\n').some((p) => /never closed/.test(p.message))).toBe(true)
    expect(checkNsisScript('${EndIf}\n').some((p) => /does not match/.test(p.message))).toBe(true)
    expect(checkNsisScript('${Do}\n${Loop}\n')).toEqual([])
    expect(checkNsisScript('Function A\nFunction B\nFunctionEnd\n').length).toBeGreaterThan(0)
    // Else/ElseIf belong to the open If rather than opening a block of their own.
    expect(checkNsisScript('${If} $0 == "1"\n${Else}\n${EndIf}\n')).toEqual([])
    expect(checkNsisScript('${Else}\n').some((p) => /Else/.test(p.message))).toBe(true)
  })

  it('knows the macros electron-builder inserts itself, and demands the rest be inserted', () => {
    // customWelcomePage/customFinishPage are inserted by electron-builder's template.
    expect(checkNsisScript('!macro customWelcomePage\n!macroend\n')).toEqual([])
    // A page macro of our own that nobody inserts means the page silently never appears.
    const definedOnly = checkNsisScript('Function Real\nFunctionEnd\n!macro myPage\n!macroend\n')
    expect(definedOnly.some((p) => /never inserted/.test(p.message))).toBe(true)
    // And an insertion with no definition fails at compile time.
    const insertedOnly = checkNsisScript('Function Real\nFunctionEnd\n!insertmacro myPage\n')
    expect(insertedOnly.some((p) => /never defined/.test(p.message))).toBe(true)
    // MUI's own macros are legitimately inserted without being defined in this file.
    expect(checkNsisScript('!insertmacro MUI_PAGE_WELCOME\n')).toEqual([])
  })

  it('catches a define redefined with a different value', () => {
    expect(checkNsisScript('!define A "1"\n!define A "1"\n')).toEqual([])
    expect(checkNsisScript('!define A "1"\n!define A "2"\n').some((p) => /already defined/.test(p.message))).toBe(true)
  })

  it('ignores commented-out code', () => {
    expect(checkNsisScript('; Call DoesNotExist\n; ${EndIf}\n')).toEqual([])
  })
})

describe('the shipped installer script', () => {
  it('has no structural problems', () => {
    const problems = checkNsisFile('installer/nsis/installer.nsi')
    expect(problems.map((problem) => `${problem.line}: ${problem.message}`)).toEqual([])
  })

  it('never contains the master password', () => {
    // The script is compiled into a distributable; this is checked again at release.
    const text = require('node:fs').readFileSync('installer/nsis/installer.nsi', 'utf8') as string
    expect(text).not.toMatch(/Handywife/iu)
  })

  it('requires administrator rights, through the config that actually sets them', () => {
    // `installer.nsi` is an electron-builder *include*: the executable's RequestExecutionLevel is emitted by
    // electron-builder's own template from `perMachine`. Asserting the string in our include would be asserting a
    // line electron-builder ignores. What must be true is that the config asks for a machine-wide, elevating install.
    for (const config of ['electron-builder.installer-online.json', 'electron-builder.installer-offline.json']) {
      const parsed = JSON.parse(require('node:fs').readFileSync(config, 'utf8')) as { nsis: Record<string, unknown> }
      expect(parsed.nsis.perMachine, `${config} must install for all users`).toBe(true)
      expect(parsed.nsis.allowElevation, `${config} must be allowed to elevate`).toBe(true)
      // And the two builds must include OUR pages, not compile electron-builder's stock wizard.
      expect(parsed.nsis.include, `${config} does not include the Infoflex pages`).toMatch(/installer\.nsi|offline-include\.nsh$/u)
      // `script` would replace electron-builder's template entirely, losing the payload install.
      expect(parsed.nsis.script, `${config} must not replace electron-builder's installer script`).toBeUndefined()
      // `defines` is not an electron-builder NSIS option; it fails schema validation outright.
      expect(parsed.nsis.defines, `${config} uses a non-existent nsis option`).toBeUndefined()
    }

    // A GUI installer must not open a console window.
    const text = require('node:fs').readFileSync('installer/nsis/installer.nsi', 'utf8') as string
    expect(text).not.toMatch(/^!define\s+MUI_PAGE_WELCOME/u)
    expect(text).not.toMatch(/^Section\s+"Install"/mu)
  })
})

describe('macros invoked in \${...} form', () => {
  const script = (body: string): string => `
!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "FileFunc.nsh"
Name "test"
OutFile "test.exe"
${body}
Section "Main"
SectionEnd
`

  it('accepts a known nsDialogs control and operation', () => {
    const problems = checkNsisScript(script('Section\n\${NSD_CreateButton} 0 0 50% 14u "Go"\nPop $0\n\${NSD_SetText} $0 "Go"\n\${NSD_OnClick} $0 Somewhere\nSectionEnd'))
    expect(problems.filter((p) => /NSD_/u.test(p.message))).toEqual([])
  })

  it('rejects a misspelt nsDialogs control — the mistake this check exists for', () => {
    // A name-prefix rule would wave this through; only a vocabulary catches it.
    const problems = checkNsisScript(script('Section\n\${NSD_CreateButon} 0 0 50% 14u "Go"\nPop $0\nSectionEnd'))
    expect(problems.map((p) => p.message).join(' ')).toMatch(/NSD_CreateButon/u)
  })

  it('rejects a misspelt nsDialogs operation', () => {
    const problems = checkNsisScript(script('Section\n\${NSD_SetTxt} $0 "Go"\nSectionEnd'))
    expect(problems.map((p) => p.message).join(' ')).toMatch(/NSD_SetTxt/u)
  })

  it('accepts the LogicLib control macros', () => {
    const problems = checkNsisScript(script('Function f\n  \${If} $0 == "1"\n  \${ElseIf} $0 == "2"\n  \${Else}\n  \${EndIf}\nFunctionEnd\nSection\nSectionEnd'))
    expect(problems.filter((p) => /LogicLib/u.test(p.message))).toEqual([])
  })

  it('accepts a standard-header macro only while its header is included', () => {
    const withHeader = checkNsisScript(script('Section\n\${GetRoot} "C:\\a\\b" $0\nSectionEnd'))
    expect(withHeader.filter((p) => /GetRoot/u.test(p.message))).toEqual([])

    const withoutHeader = checkNsisScript(`
!include "LogicLib.nsh"
Name "test"
OutFile "test.exe"
Section
\${GetRoot} "C:\\a\\b" $0
SectionEnd
`)
    // Removing the include really would stop this compiling, so the checker must say so.
    expect(withoutHeader.map((p) => p.message).join(' ')).toMatch(/GetRoot/u)
  })

  it('does not mistake a !define used as \${NAME} for a missing macro', () => {
    const problems = checkNsisScript(script('!define Readme "readme.txt"\nSection\nFileOpen $0 "\${Readme}" w\nSectionEnd'))
    expect(problems.filter((p) => /Readme/u.test(p.message))).toEqual([])
  })

  it('accepts macros supplied by a companion include that was read', () => {
    const host = `
!include "generated.nsh"
Name "test"
OutFile "test.exe"
Section
\${CurrencyRow} $0
SectionEnd
`
    expect(checkNsisScript(host, { companionScripts: { 'generated.nsh': '!macro CurrencyRow\n!macroend\n' } })).toEqual([])
    // And still reports it when the companion does not define it.
    const missing = checkNsisScript(host, { companionScripts: { 'generated.nsh': '!macro SomethingElse\n!macroend\n' } })
    expect(missing.map((p) => p.message).join(' ')).toMatch(/CurrencyRow/u)
  })
})
