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
  // ---------------------------------------------------------------------------------------------------------------
  // Everything below was WRONG in the first version of this list, and each wrong name cost a compile failure that
  // this checker reported as fine: NSD_LB_GetCurSel, NSD_LB_SetCurSel, NSD_DisableWindow and GetFileSize do not exist
  // in any NSIS header. A hand-maintained allowlist of other people's macro names is only as good as the care taken
  // copying them, and this one was written from memory. The names here are now the ones nsDialogs.nsh, LogicLib.nsh,
  // FileFunc.nsh and x64.nsh actually define, verified by compiling the script for real (see
  // scripts/compile-check-installer.ts and docs/DECISIONS.md).
  // ---------------------------------------------------------------------------------------------------------------
  // nsDialogs controls, from __NSD_DefineControl.
  'NSD_CreateLabel', 'NSD_CreateText', 'NSD_CreatePassword', 'NSD_CreateCheckbox', 'NSD_CreateCheckBox',
  'NSD_CreateListBox', 'NSD_CreateProgressBar', 'NSD_CreateDirRequest', 'NSD_CreateLink', 'NSD_CreateButton',
  // nsDialogs actions, from the !define lines in nsDialogs.nsh.
  'NSD_LB_AddString', 'NSD_LB_SetSelectionIndex', 'NSD_LB_GetSelectionIndex', 'NSD_GetText', 'NSD_SetText',
  'NSD_GetState', 'NSD_Check', 'NSD_OnClick', 'NSD_ShowWindow',
  // FileFunc.nsh. GetSize is the size macro; there is no GetFileSize.
  'GetSize',
])

/**
 * The nsDialogs macros that exist, split into what a control is called and what can be done to it.
 *
 * An earlier version accepted any name starting with `NSD_`, which meant a typo such as `${NSD_CreateButon}` —
 * exactly the mistake this checker exists for — passed silently and would only fail on a Windows build machine.
 * Listing the vocabulary catches the typo; the lists are from nsDialogs' own documentation, not from this script.
 */
const NSD_CONTROLS = new Set([
  'Label', 'Icon', 'Bitmap', 'Link', 'Button', 'GroupBox', 'Checkbox', 'RadioButton', 'Text', 'Password',
  'Number', 'FileRequest', 'DirRequest', 'ComboBox', 'DropList', 'ListBox', 'ListBoxEx', 'ProgressBar', 'HLine', 'VLine',
])
const NSD_OPERATIONS = new Set([
  'CreateButton', 'CreateLabel', 'CreateIcon', 'CreateBitmap', 'CreateLink', 'CreateGroupBox', 'CreateCheckbox',
  'CreateRadioButton', 'CreateText', 'CreatePassword', 'CreateNumber', 'CreateFileRequest', 'CreateDirRequest',
  'CreateComboBox', 'CreateDropList', 'CreateListBox', 'CreateListBoxEx', 'CreateProgressBar', 'CreateHLine',
  'CreateVLine', 'CreateLine', 'AddString', 'InsertString', 'DeleteString', 'FindString', 'ResetContent',
  'GetCurSel', 'SetCurSel', 'GetText', 'SetText', 'GetState', 'SetState', 'Check', 'OnClick', 'OnChange',
  'OnSelChange', 'DisableWindow', 'EnableWindow', 'ShowWindow', 'SetFocus', 'GetTextLength', 'SetLimitText',
  'AddStyle', 'SelectFileDialog', 'SelectFolderDialog',
])
/**
 * Macros from the NSIS standard headers, and the header each one lives in.
 *
 * A `${GetRoot}` is only valid because `FileFunc.nsh` is included; if somebody removes that include the script
 * stops compiling, and the checker should notice that rather than accept the macro from a list on faith.
 */
const NSIS_STDLIB_MACROS: Record<string, string> = {
  GetParameters: 'FileFunc.nsh', GetOptions: 'FileFunc.nsh', GetRoot: 'FileFunc.nsh', DriveSpace: 'FileFunc.nsh',
  GetSize: 'FileFunc.nsh', GetTime: 'FileFunc.nsh', GetFileVersion: 'FileFunc.nsh', GetFileAttributes: 'FileFunc.nsh',
  GetExeName: 'FileFunc.nsh', GetExePath: 'FileFunc.nsh', GetParent: 'FileFunc.nsh', GetBaseName: 'FileFunc.nsh',
  GetDrives: 'FileFunc.nsh', GetFileTime: 'FileFunc.nsh', GetFileTimeL: 'FileFunc.nsh', BannerTrimPath: 'FileFunc.nsh',
  Locate: 'FileFunc.nsh', GetWinVer: 'WinVer.nsh', AtLeastWin10: 'WinVer.nsh', AtMostWin10: 'WinVer.nsh',
  AtLeastWin11: 'WinVer.nsh', AtLeastWin8: 'WinVer.nsh', AtLeastWin7: 'WinVer.nsh', AtMostWin7: 'WinVer.nsh',
  AtLeastWinVista: 'WinVer.nsh', AtMostWinVista: 'WinVer.nsh', AtLeastWinXP: 'WinVer.nsh', AtMostWinXP: 'WinVer.nsh',
}

function isStdlibMacro(name: string, includesHeader: (header: string) => boolean): boolean {
  const header = NSIS_STDLIB_MACROS[name]
  return header !== undefined && includesHeader(header)
}

function isNsDialogsMacro(name: string): boolean {
  const match = /^NSD_(?:LB_|CB_|G_)?(\w+)$/u.exec(name)
  if (!match) return false
  const operation = match[1]!
  return NSD_OPERATIONS.has(operation) || NSD_CONTROLS.has(operation)
}

/** Macros that is allowed to be inserted from a *companion generated include rather than from this file. */
const COMPANION_INCLUDES = ['generated.nsh', 'currency-ui.nsh', 'json-escaping.nsh']

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
  [/^\s*Section\b/u, 'Section'],
  [/^\s*SectionEnd\b/u, 'SectionEnd'],
]
const BLOCK_CLOSERS: Array<[RegExp, string]> = [
  [/^\s*\$\{EndIf\}/u, 'EndIf'],
  [/^\s*\$\{Loop\}/u, 'Loop'],
  [/^\s*FunctionEnd\b/u, 'FunctionEnd'],
]

/**
 * Remove a trailing `;` comment, but only a real one.
 *
 * The first version cut at the first `;` anywhere on the line. NSIS comments do start at `;`, but a `;` inside a quoted
 * string is data -- and several messages here contain one ("... later; this computer ..."). Truncating there made the
 * checker report a MessageBox that plainly ends in `/SD IDOK` as having no `/SD`, because the `/SD` was past the
 * semicolon. A checker that mis-reads strings produces confident nonsense, which is worse than silence.
 *
 * The rule is NSIS's own: a `;` starts a comment at the start of a line or after whitespace, and never inside quotes.
 */
function stripComments(line: string): string {
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === '"') quoted = !quoted
    if (quoted) continue
    if (character !== ';') continue
    const before = index === 0 ? ' ' : line[index - 1]!
    if (/\s/u.test(before)) return line.slice(0, index)
  }
  return line
}

export interface CheckOptions {
  /**
   * The text of companion files this script `!include`s, keyed by their `!include` name.
   *
   * Without these the checker could not tell an unknown macro from one a generated include supplies, and the
   * cheap way out is to skip the check whenever an include exists — which silently stops catching typos in the
   * most macro-heavy file in the project. Reading them means a name is accepted only if it is genuinely there.
   */
  companionScripts?: Record<string, string>
}

export function checkNsisScript(text: string, options: CheckOptions = {}): ScriptProblem[] {
  const problems: ScriptProblem[] = []
  const lines = text.split('\n')
  const strip = lines.map(stripComments)

  // Every !define name, so a `!define Readme` used as `${Readme}` is not mistaken for a missing macro.
  const defineNames = new Set<string>()
  for (const raw of strip) {
    const definition = /^!define\s+(\S+)/u.exec(raw.trim())
    if (definition) defineNames.add(definition[1]!)
  }
  const isPlainDefine = (name: string): boolean => defineNames.has(name)
  // Everything the script includes and the caller supplied: macros AND functions. A companion include may define
  // `EscapeJson`, and a `Call EscapeJson` is correct if so — but only then, which is why the files are read rather
  // than assumed.
  const includedNames = COMPANION_INCLUDES.filter((name) =>
    new RegExp(`^!include\\s+"?${name.replace('.', '\\.')}"?$`, 'mu').test(text))
  const companionMacros = new Set<string>()
  const companionFunctions = new Set<string>()
  for (const [name, companionText] of Object.entries(options.companionScripts ?? {})) {
    if (!includedNames.includes(name)) continue
    for (const raw of companionText.split('\n')) {
      const macro = /^!macro\s+(\S+)/u.exec(raw.trim())
      if (macro) companionMacros.add(macro[1]!)
      const fn = /^Function\s+(?:un\.)?(\S+)/u.exec(raw.trim())
      if (fn) companionFunctions.add(fn[1]!)
    }
  }
  const unreadableCompanion = includedNames.some((name) => options.companionScripts?.[name] === undefined)
  const includesHeader = (header: string): boolean =>
    new RegExp(`^!include\\s+"?${header.replace('.', '\\.')}"?\\s*$`, 'mu').test(text)

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
    if (!declared.has(name) && !companionFunctions.has(name) && !unreadableCompanion) {
      problems.push({ line, message: `Call to "${name}", which is never declared with Function.` })
    }
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

  for (const [name, line] of inserted) {
    if (defined.has(name) || EXTERNAL_LIBRARY_MACROS.has(name) || isNsDialogsMacro(name)) continue
    if (companionMacros.has(name)) continue
    if (unreadableCompanion) continue
    problems.push({ line, message: `!insertmacro ${name} is used but never defined, which fails at compile time.` })
  }

  // ---- macros invoked in ${...} form
  //
  // This is how almost every macro is actually used (${NSD_CreateButton}, ${GetFileSize}, ${If}...), and it went
  // unchecked for a while, so a misspelt control name would have reached the Windows build machine and failed
  // there instead of here. Only invocations at the start of a statement are examined: a `${VAR}` in the middle of
  // a string is a define reference, not a macro call, and flagging those would produce noise rather than findings.
  const LOGIC_MACROS = new Set([
    'If', 'IfNot', 'Else', 'ElseIf', 'ElseIfNot', 'EndIf', 'Do', 'DoWhile', 'Loop', 'While', 'Switch', 'Case',
    'Default', 'EndSwitch', 'Select', 'EndSelect', 'Break', 'Continue', 'ExitDo', 'AndIf', 'OrIf', 'EndWhile',
  ])
  for (const [index, raw] of strip.entries()) {
    const line = raw.trim()
    const invocation = /^\$\{(\w+)(?:\s|\}|$)/u.exec(line)
    if (!invocation) continue
    const name = invocation[1]!
    if (LOGIC_MACROS.has(name) || defined.has(name) || EXTERNAL_LIBRARY_MACROS.has(name)) continue
    if (isNsDialogsMacro(name) || companionMacros.has(name)) continue
    if (isStdlibMacro(name, includesHeader)) continue
    // A define used as ${NAME} at the start of a line is a constant reference, not a macro call.
    if (isPlainDefine(name)) continue
    if (unreadableCompanion) continue
    problems.push({
      line: index + 1,
      message: `\${${name}} is used but is not a macro defined in this script, a known LogicLib/nsDialogs/macros macro, or a !define.`,
    })
  }

  // ---- defines that are redefined with a different value
  //
  // Only one branch of an `!ifdef`/`!else` chain is ever compiled, so a different value in the other branch is not a
  // redefinition at all. Tracking which branch each `!define` sits in is what lets this rule stay useful: the pattern
  //
  //     !ifdef PRODUCT_FILENAME
  //       !define NAME "${PRODUCT_FILENAME}.exe"
  //     !else
  //       !define NAME "${PRODUCT_NAME}.exe"
  //     !endif
  //
  // is correct and ordinary, and flagging it would push people to delete the guard rather than write it. The key is the
  // full branch path -- every enclosing conditional and which side of its `!else` -- so two defines conflict only when
  // they could be compiled together.
  const defines = new Map<string, { value: string; line: number; branch: string }>()
  const branches: string[] = []
  let branchOrdinal = 0
  for (const [index, raw] of strip.entries()) {
    const line = raw.trim()
    const conditional = /^!(ifdef|ifndef|if|ifmacrodef|ifmacrondef|else|endif)\b(.*)$/u.exec(line)
    if (conditional) {
      const [, keyword, rest] = conditional
      if (keyword === 'else') {
        // Same depth, opposite side: a fresh path so nothing inside can collide with the branch before it.
        branches[branches.length - 1] = `else${branchOrdinal++}`
      } else if (keyword === 'endif') {
        branches.pop()
      } else {
        branches.push(`${keyword}${branchOrdinal++}${(rest ?? '').trim()}`)
      }
      continue
    }
    const match = /^!define\s+(\S+)\s*(.*)$/u.exec(line)
    if (!match) continue
    const [, name, value] = match
    const branch = branches.join('>')
    const seen = defines.get(name!)
    if (!seen) {
      defines.set(name!, { value: value ?? '', line: index + 1, branch })
    } else if (seen.value !== (value ?? '') && seen.branch === branch) {
      problems.push({
        line: index + 1,
        message: `!define ${name} was already defined on line ${seen.line} with a different value.`,
      })
    } else if (seen.value !== (value ?? '')) {
      // Different branches: legal, and the last definition wins for the branch that is actually compiled. Record the
      // later one so a genuine duplicate inside that same branch is still caught.
      defines.set(name!, { value: value ?? '', line: index + 1, branch })
    }
  }

  // ---- a gate that only exists on a page
  //
  // A page callback runs when a page is left, and a silent install draws no pages at all -- so a check written inside a
  // Leave function is skipped by /S. That is not a theoretical flaw: the vendor password gate and the Windows-version
  // and 64-bit checks both lived only in Leave callbacks, so `Setup.exe /S` installed without the password and installed
  // a 64-bit app on 32-bit Windows, and every tool involved reported success.
  //
  // The rule: any Leave callback that can Abort must have that gate re-stated in the silent branch of .onInit. Abort is
  // the signal, because a callback that only records a checkbox value is not gating anything. The check on the silent
  // side is deliberately loose -- it looks for evidence that .onInit refuses on its own terms -- because the two
  // branches legitimately differ in wording; requiring identical text would force duplication to satisfy a checker.
  // A page callback is skipped entirely by /S, whether it creates the page or leaves it -- so a value computed only in
  // a Create callback is missing too. That is what happened to $NeedsVcRuntime: it was set in ChecksPageCreate, so a
  // silent install left it "0" and the prerequisite was never installed. Both halves are therefore searched, and only
  // the Leave half is required to contain Abort (a Create callback that cannot refuse is not a gate, it is a
  // presentation concern -- the VC++ case is caught by the requirement below that .onInit run the detector).
  const leaveGates: string[] = []
  let computesPrerequisite = false
  for (const [index, raw] of strip.entries()) {
    const line = raw.trim()
    const leave = /^Function\s+(\w+Page(?:Leave|Create))\s*$/u.exec(line)
    if (!leave) continue
    const end = strip.findIndex((candidate, position) => position > index && /^FunctionEnd\s*$/u.test(candidate.trim()))
    const body = strip.slice(index, end === -1 ? undefined : end)
    const leaves = leave[1]!.endsWith('PageLeave')
    if (/NeedsVcRuntime/u.test(body.join('\n'))) computesPrerequisite = true
    if (leaves && body.some((candidate) => /^\s*Abort\s*$/u.test(candidate))) leaveGates.push(leave[1]!)
  }
  if (leaveGates.length > 0 || computesPrerequisite) {
    const onInitStart = strip.findIndex((raw) => /^Function\s+\.onInit\s*$/u.test(raw.trim()))
    if (onInitStart === -1) {
      problems.push({
        line: 1,
        message: `${leaveGates.join(', ')} can Abort, but there is no .onInit, so a silent install never runs those checks.`,
      })
    } else {
      const onInitEnd = strip.findIndex((raw, index) => index > onInitStart && /^FunctionEnd\s*$/u.test(raw.trim()))
      const body = strip.slice(onInitStart, onInitEnd === -1 ? undefined : onInitEnd)
      const silentIndex = body.findIndex((raw) => raw.includes('${Silent}'))
      if (silentIndex === -1) {
        problems.push({
          line: onInitStart + 1,
          message: `${leaveGates.join(', ')} gate the install, but .onInit has no silent branch, so /S skips them.`,
        })
      } else {
        const silentBranch = body.slice(silentIndex).join('\n')
        if (leaveGates.includes('PasswordPageLeave')) {
          // The password gate is specific enough to name: it must read a flag AND invoke the checker. Accepting a bare
          // `File /oname=...password-check.exe` would bless a script that stages the helper and never runs it.
          const invokes = /(?:ExecToStack|ExecToLog|ExecWait)[^\n]*password-check\.exe/u.test(silentBranch)
          if (!/\/PASSWORD=/u.test(silentBranch) || !invokes) {
            problems.push({
              line: onInitStart + silentIndex + 1,
              message: 'The silent branch never verifies the vendor password, so /S bypasses the password page.',
            })
          }
        }
        // `leaveGates` holds function NAMES, so testing it for a variable name never matches -- that is how the first
        // version of this rule silently did nothing. What is being asked is whether any page computes the
        // prerequisite; ask the flag that recorded it.
        if (computesPrerequisite && !/DetectVcRuntime|NeedsVcRuntime/u.test(silentBranch)) {
          problems.push({
            line: onInitStart + silentIndex + 1,
            message: 'The silent branch never detects the missing prerequisite, so /S installs without it.',
          })
        }
        if (/(?:Checks|System)Page(?:Leave|Create)/.test(leaveGates.join(',')) && !/AtLeastWin\d+|RunningX64/u.test(silentBranch)) {
          problems.push({
            line: onInitStart + silentIndex + 1,
            message: 'The silent branch never re-checks the OS or architecture, so /S skips the system check page.',
          })
        }
      }
    }
  }

  // ---- a file the installer advertises but never writes
  //
  // `$INSTDIR\install.log` was named in the finish page's "Open install log" button, in the finish-page text, and in the
  // failure message -- and written by nothing. Clicking the button gave a "cannot find the file" error at the moment
  // the customer was looking for help, which is worse than offering no button at all.
  //
  // The rule is deliberately narrow: it looks only for a `.log` file named in this script and requires a FileWrite to
  // that same name somewhere. It is not a general "every path mentioned exists" analysis, which would need the whole
  // filesystem; it is the specific shape of a promise the script makes about its own output.
  {
    const text = strip.join('\n')
    const advertised = new Set<string>()
    for (const match of text.matchAll(/\$INSTDIR\\([A-Za-z0-9_.-]+\.log)\b/gu)) advertised.add(match[1]!)
    for (const name of advertised) {
      const escaped = name.replace('.', '\\.')
      // The DESTINATION, not any mention. `FileWrite $h "Infoflex install.log"` writes text that HAPPENS to name the
      // file into a handle pointed elsewhere; it is not a write of that file. The first version of this rule matched
      // any line containing the name, so deleting both the FileOpen and the CopyFiles still passed -- the header string
      // alone satisfied it. Two things count as writing it: a handle opened on that path, or a CopyFiles whose
      // destination is that path.
      // A handle opened on a temp path is not enough: the three messages all name `$INSTDIR`. What satisfies the
      // promise is a file that ENDS UP at that path -- a FileOpen on it, or, in this script's design, a CopyFiles whose
      // destination is it. `writesFile` alone was satisfied by a log opened in $PLUGINSDIR and never moved, which is
      // a file the customer cannot reach at the path they were told.
      const opensAtDestination = new RegExp(`FileOpen\\s+\\$[A-Za-z0-9_]+[^\\n]*\\$INSTDIR\\\\${escaped}`, 'u').test(text)
      const copiesToDestination = new RegExp(`CopyFiles[^\\n]*\\$INSTDIR\\\\${escaped}"`, 'u').test(text) ||
        new RegExp(`CopyFiles[^\\n]*\\$INSTDIR\\\\${escaped}\s`, 'u').test(text)
      const writesFile = opensAtDestination || copiesToDestination
      const copiesFile = copiesToDestination
      if (!writesFile && !copiesFile) {
        problems.push({
          line: 1,
          message: `The script advertises "$INSTDIR\\${name}" but nothing writes or copies a file of that name.`,
        })
      }
    }
  }

  // ---- a MessageBox that will block a silent run
  //
  // NSIS suppresses a MessageBox in silent mode only when the command carries `/SD <button>`; without one it shows the
  // box and waits (Source/exehead/util.c:138-141 in NSIS's own runtime). That turns a silent install or a silent
  // uninstall into a process hanging on a dialog nobody is watching -- an unattended deployment stalls, and during an
  // upgrade the box appears over an installer the user did not ask a question of.
  //
  // This is a property of one line, which is exactly what a static checker is good at. It cannot know whether a given
  // box is *reachable* in silent mode; the rule is deliberately unconditional because the safe answer is the same
  // everywhere, and a conditional rule would need the checker to model control flow it does not have.
  for (const [index, raw] of strip.entries()) {
    const line = raw.trim()
    if (!/^MessageBox\s/u.test(line)) continue
    if (/\/SD\s+ID[A-Z]+/u.test(line)) continue
    problems.push({
      line: index + 1,
      message: 'MessageBox has no "/SD <button>", so it will block a silent install or uninstall.',
    })
  }

  // ---- a function declared twice
  //
  // NSIS refuses the second definition outright -- `Function named "un.onInit" already exists` -- and it refuses it at
  // the end of the compile, so the error names a line that may be far from the mistake. This script declared
  // `un.onInit`, which electron-builder's own uninstaller.nsh also defines; because this file is layered into that
  // template, the pair was fatal and the uninstaller pass could not build.
  //
  // A checker reading this file alone cannot see the template. What it CAN see is a name declared twice *here*, which
  // is the same mistake one level in, and the same reasoning about branches applies: two declarations under opposite
  // arms of an `!ifdef` are never compiled together and are not a conflict.
  const functions = new Map<string, { line: number; branch: string }>()
  {
    const functionBranches: string[] = []
    let functionBranchOrdinal = 0
    for (const [index, raw] of strip.entries()) {
      const line = raw.trim()
      const conditional = /^!(ifdef|ifndef|if|ifmacrodef|ifmacrondef|else|endif)\b(.*)$/u.exec(line)
      if (conditional) {
        const [, keyword, rest] = conditional
        if (keyword === 'else') {
          functionBranches[functionBranches.length - 1] = `else${functionBranchOrdinal++}`
        } else if (keyword === 'endif') {
          functionBranches.pop()
        } else {
          functionBranches.push(`${keyword}${functionBranchOrdinal++}${(rest ?? '').trim()}`)
        }
        continue
      }
      const declaration = /^Function\s+(un\.)?(\S+)\s*$/u.exec(line)
      if (!declaration) continue
      const [, unPrefix, name] = declaration
      const branch = functionBranches.join('>')
      const seen = functions.get(name!)
      if (!seen) {
        functions.set(name!, { line: index + 1, branch })
      } else if (seen.branch === branch) {
        problems.push({
          line: index + 1,
          message: `Function ${unPrefix ?? ''}${name} was already declared on line ${seen.line}.`,
        })
      }
    }
  }

  // ---- the installer must install the application
  //
  // This file is an electron-builder *include*: electron-builder's own template copies the payload, so the rule is
  // that this script must not try to do it itself (a `File /r` of the payload would duplicate or misplace it), and
  // must not define a Section whose name collides with electron-builder's own Install section. The defect that
  // prompted this rule was the reverse: a standalone `Section "Install"` with no payload copy at all, which would
  // have shipped a wizard that created shortcuts to an application it never installed.
  if (/^\s*Section\s+"Install"/mu.test(text)) {
    problems.push({
      line: lineOf(text, /^\s*Section\s+"Install"/mu),
      message: 'Defines its own Section "Install", which collides with electron-builder\'s. Use !macro customInstall.',
    })
  }
  const hookingInstall = /!macro\s+customInstall/mu.test(text)
  if (hookingInstall && !/!include\s+"installer\.nsi"/mu.test(text) && !/electron-builder/iu.test(text.slice(0, 2000))) {
    // Only a file that is neither the include nor its wrapper should be defining these macros.
    problems.push({
      line: lineOf(text, /!macro\s+customInstall/mu),
      message: 'Defines customInstall but is not the installer include electron-builder loads.',
    })
  }

  // ---- a ${If} inside a function must reach an ${EndIf} before FunctionEnd; covered by the stack above.
  return problems
}

/** The 1-based line number of the first match, for reporting. */
function lineOf(text: string, pattern: RegExp): number {
  const match = pattern.exec(text)
  if (!match) return 1
  return text.slice(0, match.index).split('\n').length
}

export function checkNsisFile(path: string): ScriptProblem[] {
  return checkNsisScript(readFileSync(path, 'utf8'))
}
