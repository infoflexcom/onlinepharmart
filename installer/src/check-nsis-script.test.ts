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

describe('the redefinition rule still catches a genuine duplicate', () => {
  it('flags two different values for one define in the same branch', () => {
    // The rule was narrowed to allow `!ifdef`/`!else` pairs, where only one branch is ever compiled. That narrowing
    // must not have made the rule blind: a real duplicate is still a compile error and still has to be reported.
    const script = [
      'OutFile "x.exe"',
      '!define SAME_BRANCH "one"',
      '!define SAME_BRANCH "two"',
      'Section',
      'SectionEnd',
    ].join('\n')
    const problems = checkNsisScript(script)
    expect(problems.some((problem) => /already defined/u.test(problem.message))).toBe(true)
  })

  it('allows the same value twice, which NSIS also allows', () => {
    const script = [
      'OutFile "x.exe"',
      '!define TWICE "same"',
      '!define TWICE "same"',
      'Section',
      'SectionEnd',
    ].join('\n')
    expect(checkNsisScript(script).filter((p) => /already defined/u.test(p.message))).toEqual([])
  })

  it('allows different values in the two arms of an !ifdef, which is the pattern this was narrowed for', () => {
    const script = [
      'OutFile "x.exe"',
      '!ifdef MAYBE',
      '  !define NAME "a"',
      '!else',
      '  !define NAME "b"',
      '!endif',
      'Section',
      'SectionEnd',
    ].join('\n')
    expect(checkNsisScript(script).filter((p) => /already defined/u.test(p.message))).toEqual([])
  })

  it('reports a function declared twice, which NSIS rejects at the end of the compile', () => {
    const script = [
      'OutFile "x.exe"',
      'Function Widget',
      'FunctionEnd',
      'Function Widget',
      'FunctionEnd',
      'Section',
      'SectionEnd',
    ].join('\n')
    const problems = checkNsisScript(script)
    expect(problems.some((problem) => /already declared/u.test(problem.message))).toBe(true)
  })

  it('reports an un.onInit declared twice, the exact shape that broke the uninstaller', () => {
    // This script defined it; electron-builder's uninstaller.nsh defines it as well. The checker cannot see the
    // template, but it can see the same name twice here -- and the fix is the same either way.
    const script = [
      'OutFile "x.exe"',
      'Function un.onInit',
      'FunctionEnd',
      'Function un.onInit',
      'FunctionEnd',
      'Section',
      'SectionEnd',
    ].join('\n')
    const problems = checkNsisScript(script)
    expect(problems.some((problem) => /already declared/u.test(problem.message))).toBe(true)
  })

  it('allows a function and a macro of the same name, which do not share a namespace', () => {
    const script = [
      'OutFile "x.exe"',
      '!macro Widget',
      '!macroend',
      'Function Widget',
      'FunctionEnd',
      'Section',
      'SectionEnd',
    ].join('\n')
    expect(checkNsisScript(script).filter((p) => /already declared/u.test(p.message))).toEqual([])
  })

  it('allows the same function name in opposite arms of an !ifdef', () => {
    const script = [
      'OutFile "x.exe"',
      '!ifdef MAYBE',
      '  Function Widget',
      '  FunctionEnd',
      '!else',
      '  Function Widget',
      '  FunctionEnd',
      '!endif',
      'Section',
      'SectionEnd',
    ].join('\n')
    expect(checkNsisScript(script).filter((p) => /already declared/u.test(p.message))).toEqual([])
  })

  it('reports a MessageBox with no /SD, which blocks a silent run', () => {
    const script = [
      'OutFile "x.exe"',
      'Section',
      '  MessageBox MB_ICONSTOP|MB_OK "Something went wrong."',
      'SectionEnd',
    ].join('\n')
    const problems = checkNsisScript(script)
    expect(problems.some((problem) => /no "\/SD/u.test(problem.message))).toBe(true)
  })

  it('accepts a MessageBox that names its silent default', () => {
    const script = [
      'OutFile "x.exe"',
      'Section',
      '  MessageBox MB_ICONSTOP|MB_OK "Something went wrong." /SD IDOK',
      'SectionEnd',
    ].join('\n')
    expect(checkNsisScript(script).filter((p) => /\/SD/u.test(p.message))).toEqual([])
  })

  it('reports a password page with no silent equivalent, which /S walks straight past', () => {
    // PasswordPageLeave must be capable of Abort for the gate to mean anything, and then .onInit must re-state it.
    const script = [
      'OutFile "x.exe"',
      '!macro pages',
      '  Page custom PasswordPageCreate PasswordPageLeave',
      '!macroend',
      'Function .onInit',
      '  ${If} ${Silent}',
      '  ${EndIf}',
      'FunctionEnd',
      'Function PasswordPageLeave',
      '  nsExec::ExecToStack \'"$PLUGINSDIR\\password-check.exe" a b c d\'',
      '  ${If} $0 != "0"',
      '    Abort',
      '  ${EndIf}',
      'FunctionEnd',
      'Section',
      'SectionEnd',
    ].join('\n')
    const problems = checkNsisScript(script)
    expect(problems.some((problem) => /bypasses the password page/u.test(problem.message))).toBe(true)
  })

  it('reports a system-check page whose refusal is skipped by /S', () => {
    const script = [
      'OutFile "x.exe"',
      '  Page custom ChecksPageCreate ChecksPageLeave',
      'Function .onInit',
      '  ${If} ${Silent}',
      '  ${EndIf}',
      'FunctionEnd',
      'Function ChecksPageLeave',
      '  ${IfNot} ${AtLeastWin10}',
      '    Abort',
      '  ${EndIf}',
      'FunctionEnd',
      'Section',
      'SectionEnd',
    ].join('\n')
    const problems = checkNsisScript(script)
    expect(problems.some((problem) => /skips the system check page/u.test(problem.message))).toBe(true)
  })

  it('ignores a Leave callback that cannot Abort, which gates nothing', () => {
    const script = [
      'OutFile "x.exe"',
      '  Page custom ComponentsPageCreate ComponentsPageLeave',
      'Function ComponentsPageLeave',
      '  ${NSD_GetState} $x $y',
      'FunctionEnd',
      'Section',
      'SectionEnd',
    ].join('\n')
    expect(checkNsisScript(script).filter((p) => /silent branch|gate the install/u.test(p.message))).toEqual([])
  })

  it('accepts a silent branch that actually runs the checker', () => {
    const script = [
      'OutFile "x.exe"',
      '  Page custom PasswordPageCreate PasswordPageLeave',
      'Function .onInit',
      '  ${If} ${Silent}',
      '    ${GetOptions} $R0 "/PASSWORD=" $1',
      '    nsExec::ExecToStack \'"$PLUGINSDIR\\password-check.exe" a b c d\'',
      '  ${EndIf}',
      'FunctionEnd',
      'Section',
      'SectionEnd',
    ].join('\n')
    expect(checkNsisScript(script).filter((p) => /password page/u.test(p.message))).toEqual([])
  })

  it('does not fire on a script with no password page at all', () => {
    // The rule is about this gate, not a general security review. A script without one is not a defect under it.
    const script = ['OutFile "x.exe"', 'Function .onInit', 'FunctionEnd', 'Section', 'SectionEnd'].join('\n')
    expect(checkNsisScript(script).filter((p) => /password/u.test(p.message))).toEqual([])
  })

  it('reads a semicolon inside a quoted message as data, not as a comment', () => {
    // The comment stripper cut at the first `;` on the line, so a message containing one -- several do -- was
    // truncated, and a MessageBox plainly ending in /SD IDOK was reported as having no /SD. A checker that mis-reads
    // string data produces confident nonsense.
    const script = [
      'OutFile "x.exe"',
      'Section',
      '  MessageBox MB_ICONSTOP|MB_OK "Windows 10 needed; nothing was changed." /SD IDOK',
      'SectionEnd',
    ].join('\n')
    expect(checkNsisScript(script).filter((p) => /\/SD/u.test(p.message))).toEqual([])
  })

  it('still strips a genuine trailing comment', () => {
    const script = [
      'OutFile "x.exe"',
      'Section',
      '  MessageBox MB_ICONSTOP|MB_OK "boom" ; /SD IDOK in a comment does not count',
      'SectionEnd',
    ].join('\n')
    expect(checkNsisScript(script).some((p) => /no "\/SD/u.test(p.message))).toBe(true)
  })

  it('reports a prerequisite computed only in a page callback, which /S never runs', () => {
    const script = [
      'OutFile "x.exe"',
      '  Page custom ChecksPageCreate ChecksPageLeave',
      'Function .onInit',
      '  ${If} ${Silent}',
      '  ${EndIf}',
      'FunctionEnd',
      'Function ChecksPageCreate',
      '  StrCpy $NeedsVcRuntime "0"',
      '  ReadRegStr $2 HKLM "SOFTWARE\\X" "Version"',
      'FunctionEnd',
      'Section',
      'SectionEnd',
    ].join('\n')
    const problems = checkNsisScript(script)
    expect(problems.some((problem) => /never detects the missing prerequisite/u.test(problem.message))).toBe(true)
  })

  it('accepts a silent branch that runs the detector', () => {
    const script = [
      'OutFile "x.exe"',
      '  Page custom ChecksPageCreate ChecksPageLeave',
      '!macro DetectVcRuntime',
      '  StrCpy $NeedsVcRuntime "1"',
      '!macroend',
      'Function .onInit',
      '  ${If} ${Silent}',
      '    !insertmacro DetectVcRuntime',
      '  ${EndIf}',
      'FunctionEnd',
      'Function ChecksPageCreate',
      '  !insertmacro DetectVcRuntime',
      'FunctionEnd',
      'Section',
      'SectionEnd',
    ].join('\n')
    expect(checkNsisScript(script).filter((p) => /prerequisite/u.test(p.message))).toEqual([])
  })

  // The generator emits a block of defines; the script must read them, because a define nobody reads is either dead
  // weight or the visible half of a promise the script does not keep -- which is what VCREDIST_PUBLISHER and the three
  // ALLOWED_HOST_* values turned out to be.
  it('reports a generated define the script never reads', () => {
    const script = ['OutFile "x.exe"', 'Section', 'SectionEnd'].join('\n')
    const problems = checkNsisScript(script, { generatedDefines: ['VCREDIST_URL', 'VCREDIST_PUBLISHER'] })
    expect(problems.map((problem) => problem.message).join('\n')).toMatch(/VCREDIST_PUBLISHER is never read/u)
  })

  it('accepts a generated define the script reads', () => {
    const script = ['OutFile "x.exe"', 'Section', '  DetailPrint "${VCREDIST_URL}"', 'SectionEnd'].join('\n')
    const problems = checkNsisScript(script, { generatedDefines: ['VCREDIST_URL'] })
    expect(problems.filter((problem) => /never read/u.test(problem.message))).toEqual([])
  })

  it('does not apply the rule when no generated defines are supplied, so small fixtures stay usable', () => {
    const script = ['OutFile "x.exe"', 'Section', 'SectionEnd'].join('\n')
    expect(checkNsisScript(script).filter((problem) => /never read/u.test(problem.message))).toEqual([])
  })

  // electron-builder inserts customInstall AFTER it has copied the payload (installSection.nsh:67 then :82), so a
  // refusal here must undo what has already been done.
  it('reports a refusal inside customInstall that leaves the app half-installed', () => {
    const script = [
      'OutFile "x.exe"',
      '!macro customInstall',
      '  Call InstallPrerequisites',
      '!macroend',
      'Function InstallPrerequisites',
      '  Abort',
      'FunctionEnd',
      'Section',
      'SectionEnd',
    ].join('\n')
    expect(checkNsisScript(script).map((p) => p.message).join('\n')).toMatch(/half-installed/u)
  })

  it('follows a called function to reach the Abort', () => {
    // The Abort is not lexically in the macro; a rule that only read the macro body would miss it.
    const script = [
      'OutFile "x.exe"',
      '!macro customInstall',
      '  Call Step',
      '!macroend',
      'Function Step',
      '  Call Deeper',
      'FunctionEnd',
      'Function Deeper',
      '  Abort',
      'FunctionEnd',
      'Section',
      'SectionEnd',
    ].join('\n')
    expect(checkNsisScript(script).map((p) => p.message).join('\n')).toMatch(/half-installed/u)
  })

  it('accepts a refusal that rolls the install back first', () => {
    const script = [
      'OutFile "x.exe"',
      '!macro customInstall',
      '  Call InstallPrerequisites',
      '!macroend',
      'Function InstallPrerequisites',
      '  Call RollBackPartialInstall',
      '  Abort',
      'FunctionEnd',
      'Function RollBackPartialInstall',
      '  RMDir /r "$INSTDIR"',
      'FunctionEnd',
      'Section',
      'SectionEnd',
    ].join('\n')
    expect(checkNsisScript(script).filter((p) => /half-installed|Nothing was installed/u.test(p.message))).toEqual([])
  })

  it('reports a "Nothing was installed" claim made before the rollback', () => {
    const script = [
      'OutFile "x.exe"',
      '!macro customInstall',
      '  Call InstallPrerequisites',
      '!macroend',
      'Function InstallPrerequisites',
      '  MessageBox MB_OK "Nothing was installed." /SD IDOK',
      '  Call RollBackPartialInstall',
      '  Abort',
      'FunctionEnd',
      'Function RollBackPartialInstall',
      'FunctionEnd',
      'Section',
      'SectionEnd',
    ].join('\n')
    expect(checkNsisScript(script).map((p) => p.message).join('\n')).toMatch(/before rolling the partial install back/u)
  })

  it('leaves the download page free to say nothing was installed, because there it is true', () => {
    // That page runs before the install section, so no payload exists. A rule that flagged it would make honest text
    // the thing to delete.
    const script = [
      'OutFile "x.exe"',
      '!macro customInstall',
      '!macroend',
      'Function DownloadPageLeave',
      '  ${NSD_SetText} $DownloadStatus "Nothing was installed. Nothing on this computer was changed."',
      'FunctionEnd',
      'Section',
      'SectionEnd',
    ].join('\n')
    expect(checkNsisScript(script).filter((p) => /Nothing was installed/u.test(p.message))).toEqual([])
  })

  // A page that collects an answer the installer ignores, and a bar that never moves. Both shipped.
  it('reports an editable folder box whose value goes into a register nothing reads', () => {
    const script = [
      'OutFile "x.exe"',
      'Section',
      '  ${NSD_CreateDirRequest} 0 112u 70% 12u "$INSTDIR"',
      '  Pop $0',
      'SectionEnd',
    ].join('\n')
    expect(checkNsisScript(script).map((problem) => problem.message).join('\n')).toMatch(/nothing reading it back/u)
  })

  it('reports a progress bar that nothing ever moves', () => {
    const script = [
      'OutFile "x.exe"',
      'Section',
      '  ${NSD_CreateProgressBar} 0 28u 100% 10u',
      '  Pop $DownloadProgress',
      'SectionEnd',
    ].join('\n')
    expect(checkNsisScript(script).map((problem) => problem.message).join('\n')).toMatch(/never sets its position/u)
  })

  it('accepts a text field that is read back with NSD_GetText', () => {
    const script = [
      'OutFile "x.exe"',
      'Section',
      '  ${NSD_CreateText} 34u 24u 30% 12u ""',
      '  Pop $2',
      '  ${NSD_GetText} $2 $CurrencyCodeOut',
      'SectionEnd',
    ].join('\n')
    expect(checkNsisScript(script).filter((p) => /nothing reading it back/u.test(p.message))).toEqual([])
  })

  it('accepts a greyed-out checkbox, which states a fact instead of collecting an answer', () => {
    const script = [
      'OutFile "x.exe"',
      'Section',
      '  ${NSD_CreateCheckbox} 0 18u 100% 12u "required"',
      '  Pop $0',
      '  ${NSD_Check} $0',
      '  SendMessage $0 ${WM_ENABLE} 0 0',
      'SectionEnd',
    ].join('\n')
    expect(checkNsisScript(script).filter((p) => /nothing reading it back/u.test(p.message))).toEqual([])
  })

  it('reports a Var that is declared and never read', () => {
    const script = ['OutFile "x.exe"', 'Var LaunchWanted', 'Section', '  StrCpy $0 "1"', 'SectionEnd'].join('\n')
    expect(checkNsisScript(script).map((problem) => problem.message).join('\n')).toMatch(/never uses it/u)
  })

  it('accepts a Var that is read somewhere', () => {
    const script = ['OutFile "x.exe"', 'Var LaunchWanted', 'Section', '  StrCpy $LaunchWanted "1"', 'SectionEnd'].join('\n')
    expect(checkNsisScript(script).filter((p) => /never uses it/u.test(p.message))).toEqual([])
  })

  // MUI's finish page runs MUI_FINISHPAGE_RUN with Exec unless a _FUNCTION is defined, and Exec inherits the
  // elevated token of a perMachine installer. A path in that define is therefore the defect, not the feature.
  it('reports a finish page that runs the application elevated', () => {
    const script = ['OutFile "x.exe"', '  !define MUI_FINISHPAGE_RUN "$INSTDIR\\App.exe"', 'Section', 'SectionEnd'].join('\n')
    const problems = checkNsisScript(script)
    expect(problems.map((problem) => problem.message).join('\n')).toMatch(/launches the application elevated/u)
  })

  it('reports a path in MUI_FINISHPAGE_RUN even when a run function is also defined, because MUI ignores the path', () => {
    const script = [
      'OutFile "x.exe"',
      '  !define MUI_FINISHPAGE_RUN "$INSTDIR\\App.exe"',
      '  !define MUI_FINISHPAGE_RUN_FUNCTION "LaunchAsUser"',
      'Section',
      'SectionEnd',
    ].join('\n')
    expect(checkNsisScript(script).some((problem) => /launches the application elevated/u.test(problem.message))).toBe(true)
  })

  it('accepts the empty MUI_FINISHPAGE_RUN plus a run function, which is the only correct combination', () => {
    const script = [
      'OutFile "x.exe"',
      '  !define MUI_FINISHPAGE_RUN',
      '  !define MUI_FINISHPAGE_RUN_FUNCTION "LaunchAsUser"',
      'Section',
      'SectionEnd',
    ].join('\n')
    expect(checkNsisScript(script).some((problem) => /MUI_FINISHPAGE_RUN/u.test(problem.message))).toBe(false)
  })

  it('does not confuse MUI_FINISHPAGE_RUN_FUNCTION for MUI_FINISHPAGE_RUN', () => {
    // The two names differ by a suffix, and a regex without a boundary reads the function's value as the path's.
    const script = ['OutFile "x.exe"', '  !define MUI_FINISHPAGE_RUN_FUNCTION "LaunchAsUser"', 'Section', 'SectionEnd'].join('\n')
    expect(checkNsisScript(script).some((problem) => /MUI_FINISHPAGE_RUN/u.test(problem.message))).toBe(false)
  })

  it('reports a log the finish page advertises but nothing writes', () => {
    const script = [
      'OutFile "x.exe"',
      '  !define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\\install.log"',
      'Section',
      'SectionEnd',
    ].join('\n')
    const problems = checkNsisScript(script)
    expect(problems.some((problem) => /but nothing writes or copies/u.test(problem.message))).toBe(true)
  })

  it('accepts a log that is actually copied to the advertised path', () => {
    const script = [
      'OutFile "x.exe"',
      '  !define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\\install.log"',
      'Section',
      '  CopyFiles /SILENT "$PLUGINSDIR\\install.log" "$INSTDIR\\install.log"',
      'SectionEnd',
    ].join('\n')
    expect(checkNsisScript(script).filter((p) => /writes or copies/u.test(p.message))).toEqual([])
  })

  it('does not count a log left in the temp directory as satisfying the promise', () => {
    // The customer is told the log is in $INSTDIR. A file written only to $PLUGINSDIR is not at that path, and a rule
    // satisfied by "somewhere a file with this name is written" would bless exactly the defect it exists to catch.
    const script = [
      'OutFile "x.exe"',
      '  !define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\\install.log"',
      'Function .onInit',
      '  FileOpen $0 "$PLUGINSDIR\\install.log" w',
      '  FileWrite $0 "header"',
      'FunctionEnd',
      'Section',
      'SectionEnd',
    ].join('\n')
    expect(checkNsisScript(script).some((p) => /writes or copies/u.test(p.message))).toBe(true)
  })
})

/**
 * The generated includes must be reachable from the packaged build, not only from the harness.
 *
 * `installer.nsi` `!include`s `prerequisite.nsh` by bare name. That resolves because NSIS searches the directory of the
 * including file first, and electron-builder compiles `nsis.include` from the project directory -- so the file beside
 * `installer.nsi` is found without being in `files[]`. This is the same harness-versus-build divergence that bit this
 * project three times (a define the harness passed with -D, a `File` path resolved against the wrong working directory,
 * and a generated header the harness supplied itself). So the assumption is written down and checked: the file exists
 * where the include will look for it.
 */
describe('every bare !include in installer.nsi resolves beside it', () => {
  const script = require('node:fs').readFileSync('installer/nsis/installer.nsi', 'utf8') as string

  it('has prerequisite.nsh beside installer.nsi, which is where NSIS looks first', () => {
    const includes = [...script.matchAll(/^!include\s+"([^"]+)"/gmu)].map((match) => match[1]!)
    // Only the project's own files: the vendor headers (FileFunc.nsh, x64.nsh, LogicLib.nsh) live in NSISDIR.
    const ours = includes.filter((name) => !/^(FileFunc|StrContains|x64|LogicLib|WinVer|MUI2|nsDialogs|StdUtils)\.nsh$/u.test(name))
    expect(ours.length, 'the include scan must find our own includes, or it proves nothing').toBeGreaterThan(3)
    for (const name of ours) {
      expect(
        require('node:fs').existsSync(`installer/nsis/${name}`),
        `installer.nsi includes "${name}", which must exist at installer/nsis/${name} for the real build`,
      ).toBe(true)
    }
  })
})
