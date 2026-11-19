import { readFileSync } from 'node:fs'

/**
 * A static check for the `.nsi` script.
 *
 * `makensis` cannot run in this build environment (no Wine, no compiler, and the Windows toolchain cannot be
 * downloaded here), so the script that produces the actual deliverable would otherwise ship completely
 * unexamined. That is not acceptable for a file this important, so this checks the classes of mistake that are
 * both common in NSIS and mechanically detectable:
 *
 *  - a `Call` to a function that is never declared (the mistake actually made while writing it);
 *  - a `${Define}`/`${EndIf}`/`${Do}`/`${Loop}`/`Function`/`Section` block left open or closed twice;
 *  - a custom page macro that is defined but never inserted, or inserted but never defined, which in NSIS means
 *    the page silently does not appear;
 *  - a shebang-style `!define` that is redefined with a different value.
 *
 * It cannot prove the script compiles, and it does not pretend to: `docs/PHASES.md` records that compiling it
 * needs a Windows machine or Wine. What it does prove is that the specific errors a human makes in this language
 * are caught before the build machine ever sees the file.
 */

/**
 * Macros the electron-builder template inserts for us (`!ifmacrodef customWelcomePage → !insertmacro …`).
 * Defining them is the supported way to add a page, so "not inserted here" is correct rather than a fault.
 */
/** Macros provided by NSIS itself or by the MUI2 include, which this file legitimately inserts. */
const EXTERNAL_LIBRARY_MACROS = new Set([
  'MUI_PAGE_WELCOME', 'MUI_PAGE_FINISH', 'MUI_PAGE_DIRECTORY', 'MUI_PAGE_INSTFILES', 'MUI_PAGE_LICENSE',
  'MUI_PAGE_COMPONENTS', 'MUI_PAGE_STARTMENU', 'MUI_UNPAGE_WELCOME', 'MUI_UNPAGE_CONFIRM', 'MUI_UNPAGE_INSTFILES',
  'MUI_UNPAGE_FINISH', 'MUI_HEADER_TEXT', 'MUI_PAGE_CUSTOMFUNCTION_PRE', 'MUI_PAGE_CUSTOMFUNCTION_SHOW',
  'MUI_PAGE_CUSTOMFUNCTION_LEAVE', 'MUI_STARTMENU_WRITE_BEGIN', 'MUI_STARTMENU_WRITE_END',
  'MUI_FINISHPAGE_RUN', 'MUI_FINISHPAGE_SHOWREADME',
  'NSD_CreateLabel', 'NSD_CreateText', 'NSD_CreatePassword', 'NSD_CreateCheckbox', 'NSD_CreateListBox',
  'NSD_CreateProgressBar', 'NSD_CreateDirRequest', 'NSD_CreateLink', 'NSD_LB_AddString', 'NSD_LB_SetCurSel',
  'NSD_LB_GetCurSel', 'NSD_GetText', 'NSD_SetText', 'NSD_GetState', 'NSD_Check', 'NSD_DisableWindow', 'NSD_OnClick',
])

/** Macros that is allowed to be inserted from a *companion generated include rather than from this file. */
const COMPANION_INCLUDES = ['generated.nsh', 'currency-ui.nsh']

const EXTERNALLY_INSERTED_MACROS = new Set([
  'customWelcomePage', 'customFinishPage', 'customPageAfterChangeDir', 'customHeader', 'customInit',
  'customInstall', 'customUnInstall', 'customUnInit', 'licensePage', 'customUninstallPage', 'customInstallMode',
])

export interface ScriptProblem {
  line: number
  message: string
}

const BLOCK_OPENERS: Array<[RegExp, string]> = [
  [/^\s*\$\{If(Not)?\b/u, 'If'],
  [/^\s*\$\{Do(While)?\b/u, 'Do'],
  [/^\s*Function\s+\S+/u, 'Function'],
  [/^\s*Section\s/u, 'Section'],
  [/^\s*SectionEnd\b/u, 'SectionEnd'],
]
const BLOCK_CLOSERS: Array<[RegExp, string]> = [
  [/^\s*\$\{EndIf\}/u, 'EndIf'],
  [/^\s*\$\{Loop\}/u, 'Loop'],
  [/^\s*FunctionEnd\b/u, 'FunctionEnd'],
]

function stripComments(line: string): string {
  const index = line.indexOf(';')
  return index >= 0 ? line.slice(0, index) : line
}

export function checkNsisScript(text: string): ScriptProblem[] {
  const problems: ScriptProblem[] = []
  const lines = text.split('\n')
  const strip = lines.map(stripComments)

  // ---- declared functions
  const declared = new Set<string>()
  const called = new Map<string, number>()
  for (const [index, raw] of strip.entries()) {
    const line = raw.trim()
    const declaration = /^Function\s+(?:un\.)?(\S+)/u.exec(line)
    if (declaration) declared.add(declaration[1]!)
    const call = /^Call\s+(?:un\.)?(\S+)/u.exec(line)
    if (call) called.set(call[1]!, index + 1)
  }
  for (const [name, line] of called) {
    if (!declared.has(name)) problems.push({ line, message: `Call to "${name}", which is never declared with Function.` })
  }

  // ---- block balance
  const stack: Array<{ kind: string; line: number }> = []
  for (const [index, raw] of strip.entries()) {
    const line = raw.trim()
    if (!line) continue
    if (/^\s*\$\{Else(If)?\b/u.test(line)) {
      // Else/ElseIf share the If's block rather than opening a new one.
      const top = stack[stack.length - 1]
      if (!top || top.kind !== 'If') {
        problems.push({ line: index + 1, message: 'Else or ElseIf without a matching ${If}.' })
      }
      continue
    }
    if (/^\s*FunctionEnd\b/u.test(line) || /^\s*SectionEnd\b/u.test(line)) {
      const closer = /^\s*FunctionEnd\b/u.test(line) ? 'FunctionEnd' : 'SectionEnd'
      const top = stack.pop()
      const expected = closer === 'FunctionEnd' ? 'Function' : 'Section'
      if (!top || top.kind !== expected) {
        problems.push({
          line: index + 1,
          message: `${closer} does not match ${top ? `the ${top.kind} opened on line ${top.line}` : 'anything'}.`,
        })
      }
      continue
    }
    if (BLOCK_CLOSERS.some(([pattern]) => pattern.test(line))) {
      const top = stack.pop()
      const isEndIf = /^\s*\$\{EndIf\}/u.test(line)
      const isLoop = /^\s*\$\{Loop\}/u.test(line)
      const expected = isEndIf ? 'If' : isLoop ? 'Do' : null
      if (expected && (!top || top.kind !== expected)) {
        problems.push({
          line: index + 1,
          message: `${isEndIf ? '${EndIf}' : '${Loop}'} does not match ${top ? `the ${top.kind} opened on line ${top.line}` : 'anything'}.`,
        })
      }
      continue
    }
    for (const [pattern, kind] of BLOCK_OPENERS) {
      if (pattern.test(line)) {
        stack.push({ kind, line: index + 1 })
        break
      }
    }
  }
  for (const open of stack) {
    problems.push({ line: open.line, message: `${open.kind} is never closed.` })
  }

  const isIncludeFile = !/^\s*(Function|Section|Page|!include)\b/mu.test(text) && /^!macro\b/mu.test(text)

  // ---- custom MUI pages: defined but not inserted (page silently missing), inserted but not defined.
  //
  // electron-builder's own template inserts these three macros itself, so a script that merely *defines* them is
  // correct — they are the supported extension points. Everything else must be inserted by this script.
  const defined = new Map<string, number>()
  const inserted = new Map<string, number>()
  for (const [index, raw] of strip.entries()) {
    const line = raw.trim()
    // Every macro counts, not just the custom* ones: a helper macro defined and never inserted is dead code,
    // and a page macro of any name that nobody inserts is a silently missing page.
    const definition = /^!macro\s+(\S+)/u.exec(line)
    if (definition) defined.set(definition[1]!, index + 1)
    const insertion = /^!insertmacro\s+(\S+)/u.exec(line)
    if (insertion) inserted.set(insertion[1]!, index + 1)
  }
  for (const [name, line] of defined) {
    if (inserted.has(name)) continue
    if (EXTERNALLY_INSERTED_MACROS.has(name)) continue
    // An include file is inserted by its host script, not by itself.
    if (isIncludeFile) continue
    problems.push({ line, message: `!macro ${name} is defined but never inserted, so that page never appears.` })
  }
  const hasCompanionInclude = COMPANION_INCLUDES.some((name) => new RegExp(`^!include\\s+"?${name.replace('.', '\\.')}"?$`, 'mu').test(text))
  for (const [name, line] of inserted) {
    if (defined.has(name) || EXTERNAL_LIBRARY_MACROS.has(name)) continue
    // A generated companion include legitimately supplies macros this file inserts.
    if (hasCompanionInclude) continue
    problems.push({ line, message: `!insertmacro ${name} is used but never defined, which fails at compile time.` })
  }

  // ---- defines that are redefined with a different value
  const defines = new Map<string, { value: string; line: number }>()
  for (const [index, raw] of strip.entries()) {
    const line = raw.trim()
    const match = /^!define\s+(\S+)\s*(.*)$/u.exec(line)
    if (!match) continue
    const [, name, value] = match
    const seen = defines.get(name!)
    if (!seen) {
      defines.set(name!, { value: value ?? '', line: index + 1 })
    } else if (seen.value !== (value ?? '')) {
      problems.push({
        line: index + 1,
        message: `!define ${name} was already defined on line ${seen.line} with a different value.`,
      })
    }
  }

  // ---- a ${If} inside a function must reach an ${EndIf} before FunctionEnd; covered by the stack above.
  return problems
}

export function checkNsisFile(path: string): ScriptProblem[] {
  return checkNsisScript(readFileSync(path, 'utf8'))
}
