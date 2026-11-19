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

  it('requires administrator rights and never asks for a console', () => {
    const text = require('node:fs').readFileSync('installer/nsis/installer.nsi', 'utf8') as string
    expect(text).toContain('RequestExecutionLevel admin')
    // A GUI installer must not open a console window.
    expect(text).not.toMatch(/^!define\s+MUI_PAGE_WELCOME/u)
  })
})
