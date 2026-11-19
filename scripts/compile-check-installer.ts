import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildStubs } from './nsis-stub-builder.ts'
import { inspectPe, type PeArtifact } from '../installer/src/pe-artifact.ts'

/**
 * Compiles the real installer/nsis/installer.nsi with a real makensis, and reports what NSIS itself says.
 *
 * WHY THIS EXISTS
 *
 * `installer:check` is a static checker: it reads the script and enforces the rules a person can enforce by reading.
 * It cannot know NSIS's own grammar. That gap was not theoretical. Running this for the first time found six defects,
 * every one of which would have stopped the installer compiling, and every one of which `installer:check` reported as
 * fine:
 *
 *   1. `${NSD_LB_SetCurSel}`    — not an nsDialogs macro (it is NSD_LB_SetSelectionIndex)
 *   2. `${NSD_LB_GetCurSel}`    — not an nsDialogs macro (it is NSD_LB_GetSelectionIndex)
 *   3. `${NSD_DisableWindow}`   — does not exist at all (WM_ENABLE, or NSD_EnableWindow's opposite, by hand)
 *   4. `${ElseIfNot} ${RunningX64}` — RunningX64 comes from x64.nsh, which was never included
 *   5. `${AtLeastWin10}`        — WinVer.nsh never defines it (Windows 10 and 11 both report major 10)
 *   6. `${GetFileSize}`         — not a FileFunc macro (it is GetSize), plus a comment ending in a backslash that
 *                                silently swallowed the next line (a backslash escapes a newline in NSIS)
 *
 * The root cause of 1-3 and 6 was the static checker's own allowlist: it had been written from memory and listed macro
 * names that no NSIS header defines, so it blessed exactly the calls that would fail.
 *
 * WHAT IT PROVES, AND WHAT IT DOES NOT
 *
 * It proves the script parses, every macro, page, function and instruction resolves, AND that makensis can write a
 * complete Windows installer: the stubs are cross-compiled from NSIS's own sources by scripts/nsis-stub-builder.ts, so
 * the final byte-write succeeds and the output is a real i386 PE. The bytes of that PE are checked, not assumed.
 *
 * What it still does not prove: that electron-builder's own template agrees with us, and that the resulting installer
 * runs. There is no Windows here to run it on. Those remain on the manual checklist.
 *
 * One local patch to the NSIS install is applied: MUI2's ChangeUI calls and the InstProgressFlags directive are
 * stubbed, because both open a Windows .exe and rewrite its dialog resources, which needs a Windows resource compiler
 * "--codepage" mode NSIS does not have. Neither has anything to do with the file under test.
 *
 * Usage: npx tsx scripts/compile-check-installer.ts
  *
 * THE FOURTH BUILD
 *
 * `uninstaller-pass` is not another flavour of the installer. electron-builder compiles the installer twice, and the
 * second pass -- the one that defines BUILD_UNINSTALLER -- is the only path that reaches `uninstaller.nsh`, which owns
 * the single `!insertmacro customUnInstall` and defines `Function un.onInit`. Every other build here is an installer
 * pass, so the first three shapes together still never compiled the uninstaller.
 *
 * Compiling it found that this script defined its own `Function un.onInit`, which collides with the template's and
 * aborted the uninstaller build outright -- while the installer half built perfectly. That is the reason this build
 * exists and the reason its harness reproduces the template's `un.onInit`: a check that compiles only what builds
 * today would have gone on reporting success.
 *
*/

const NSIS_VERSION = 'v310'
const WORK = '/tmp/infoflex-nsis-build'
const DIST = join(WORK, 'dist')
const MAKENSIS = join(DIST, 'bin', 'makensis')
const NSISDIR = join(DIST, 'share', 'nsis')

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  return execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe', ...options, maxBuffer: 64 * 1024 * 1024 })
}

/** Builds makensis from source once. The sandbox has gcc and Python, so this is a compile rather than a download. */
function ensureMakensis(): void {
  if (existsSync(MAKENSIS)) {
    console.log(`makensis present at ${MAKENSIS}`)
    return
  }
  if (!existsSync(WORK)) mkdirSync(WORK, { recursive: true })
  console.log('Building makensis from source. This takes about a minute the first time.')

  const nsisSource = join(WORK, 'nsis')
  if (!existsSync(nsisSource)) {
    download(`https://codeload.github.com/nsis-dev/nsis/tar.gz/refs/tags/${NSIS_VERSION}`, join(WORK, 'nsis.tar.gz'))
    run('tar', ['xzf', join(WORK, 'nsis.tar.gz'), '-C', WORK])
    run('mv', [join(WORK, `nsis-${NSIS_VERSION.slice(1)}`), nsisSource])
  }

  // zlib: the sandbox has libz.so but not zlib.h, and NSIS's SCons build refuses to continue without it.
  const zlibPrefix = join(WORK, 'zlib')
  if (!existsSync(join(zlibPrefix, 'include', 'zlib.h'))) {
    const zlibSource = join(WORK, 'zlib-src')
    if (!existsSync(zlibSource)) {
      download('https://codeload.github.com/madler/zlib/tar.gz/refs/tags/v1.3.1', join(WORK, 'zlib.tar.gz'))
      mkdirSync(zlibSource, { recursive: true })
      run('tar', ['xzf', join(WORK, 'zlib.tar.gz'), '-C', zlibSource, '--strip-components=1'])
    }
    run('./configure', [`--prefix=${zlibPrefix}`], { cwd: zlibSource })
    run('make', ['-j4'], { cwd: zlibSource })
    run('make', ['install'], { cwd: zlibSource })
  }

  // Every NSIS environment is cloned from defenv, and the zlib configure check runs on one of those clones, so the
  // include path has to be on defenv before SCons/Config/gnu runs.
  const sconstruct = join(nsisSource, 'SConstruct')
  const text = readFileSync(sconstruct, 'utf8')
  if (!text.includes('infoflex-compile-check')) {
    writeFileSync(sconstruct, text.replace(
      "tools = defenv['TOOLS']",
      `tools = defenv['TOOLS']\n# infoflex-compile-check: zlib was built into a private prefix; see scripts/compile-check-installer.ts\ndefenv.Append(CPPPATH = ['${zlibPrefix}/include'], LIBPATH = ['${zlibPrefix}/lib'])`,
    ), 'utf8')
  }

  // The default target stops at makensis. `install` would go on to compile the Windows plugins (AdvSplash, etc.), which
  // need <windows.h> and are irrelevant here -- only the compiler is being used.
  run('scons', ['-Q', 'SKIPUTILS=all', 'SKIPSTUBS=all', `PREFIX=${DIST}`, `BUILD_PREFIX=${DIST}`], {
    cwd: nsisSource,
    env: { ...process.env, CPATH: join(zlibPrefix, 'include'), LIBRARY_PATH: join(zlibPrefix, 'lib') },
  })
  if (!existsSync(MAKENSIS)) {
    // The compiler is built in-tree; place it where the rest of the script expects it.
    const built = join(nsisSource, 'build/urelease/makensis/makensis')
    if (!existsSync(built)) throw new Error('makensis did not build')
    mkdirSync(join(DIST, 'bin'), { recursive: true })
    run('cp', [built, MAKENSIS])
  }
  // makensis reads these two at start-up and reports the utterly unhelpful "Error initializing CEXEBuild: can't open
  // file" if either is missing. The default scons target does not install them, so they are copied here.
  mkdirSync(join(DIST, 'etc'), { recursive: true })
  const conf = join(nsisSource, 'nsisconf.nsh')
  if (existsSync(conf) && !existsSync(join(DIST, 'etc/nsisconf.nsh'))) {
    run('cp', [conf, join(DIST, 'etc/nsisconf.nsh')])
  }
}

function download(url: string, to: string): void {
  run('curl', ['-sL', '--max-time', '180', '-o', to, url])
  if (!existsSync(to)) throw new Error(`could not download ${url}`)
}

/** Installs the bits of the NSIS tree the install step skips, and stubs the two resource-editing directives. */
function prepareIncludes(): void {
  const source = join(WORK, 'nsis')
  for (const [from, to] of [
    ['Include', 'Include'],
    ['Contrib/Graphics', 'Contrib/Graphics'],
    ['Contrib/UIs', 'Contrib/UIs'],
    ['Contrib/Language files', 'Contrib/Language files'],
    ['Contrib/Modern UI 2', 'Contrib/Modern UI 2'],
    ['Contrib/nsDialogs', 'Contrib/nsDialogs'],
  ] as const) {
    const target = join(NSISDIR, to)
    if (!existsSync(target) && existsSync(join(source, from))) mkdirSync(target, { recursive: true })
  }
  // Copied once, not on every run: a blanket re-copy would silently undo the patches below on the second invocation,
  // which is how this script first failed -- with a MUI error the run before it had not produced.
  // Also re-prepare when the tree looks incomplete (an Include dir without nsDialogs.nsh), so a half-cleaned state
  // repairs itself rather than failing with a message about MUI.
  const marker = join(NSISDIR, '.compile-check-prepared')
  if (!existsSync(marker) || !existsSync(join(NSISDIR, 'Include/nsDialogs.nsh'))) {
    run('mkdir', ['-p', join(NSISDIR, 'Include')])
    run('cp', ['-r', `${join(source, 'Contrib')}/.`, `${join(NSISDIR, 'Contrib')}/`])
    run('cp', [join(source, 'Contrib/nsDialogs/nsDialogs.nsh'), join(NSISDIR, 'Include/nsDialogs.nsh')])
    run('cp', ['-r', `${join(source, 'Include')}/.`, `${join(NSISDIR, 'Include')}/`])
    writeFileSync(marker, 'patched\n')
  }

  // Two directives open the installer's own UI .exe and rewrite its dialog resources: `ChangeUI` (MUI2) and
  // `InstProgressFlags`. Both need a Windows resource compiler. They are cosmestic, and unrelated to the file under
  // test, so they are commented out **in this private copy** with a marker that says so. Nothing in the repository is
  // touched.
  const interfaceNsh = join(NSISDIR, 'Contrib/Modern UI 2/Interface.nsh')
  const patched = readFileSync(interfaceNsh, 'utf8')
    .replace(/^(\s*)ChangeUI all/gmu, '$1; ChangeUI all [compile-check: needs a Windows resource compiler]')
    .replace(/^(\s*)ChangeUI IDD_/gmu, '$1; ChangeUI IDD_ [compile-check: needs a Windows resource compiler]')
  writeFileSync(interfaceNsh, patched, 'utf8')
  const installFiles = join(NSISDIR, 'Contrib/Modern UI 2/Pages/InstallFiles.nsh')
  writeFileSync(installFiles, readFileSync(installFiles, 'utf8')
    .replace(/^(\s*)InstProgressFlags/gmu, '$1; InstProgressFlags [compile-check: needs a Windows resource compiler]'), 'utf8')

  // A one-byte stub and hand-built plugin DLLs. NSIS reads the stub only when it writes the final file -- after every
  // parse, macro and instruction check -- and reads plugin DLLs to learn their exported names. Both are placeholders.
  mkdirSync(join(NSISDIR, 'Stubs'), { recursive: true })
  writeFileSync(join(NSISDIR, 'Stubs/zlib-x86-unicode'), 'X')
  // `Stubs/uninst` is an icon, not a uninstaller binary, and makensis loads it while initialising. Without it every
  // run fails with the useless "Error initializing CEXEBuild: can't open file" before reading a single line of script.
  const uninstIcon = join(source, 'Source/exehead/uninst.ico')
  if (existsSync(uninstIcon)) run('cp', ['-f', uninstIcon, join(NSISDIR, 'Stubs/uninst')])
  const plugins = join(NSISDIR, 'Plugins/x86-unicode')
  mkdirSync(plugins, { recursive: true })
  const exports: Record<string, string[]> = {
    nsDialogs: ['Create', 'CreateControl', 'CreateTimer', 'GetUserData', 'KillTimer', 'On', 'SelectFileDialog',
      'SelectFolderDialog', 'SetRTL', 'SetUserData', 'Show', 'OnClick', 'OnChange', 'OnNotify', 'OnBack', 'OnNext'],
    System: ['Alloc', 'Call', 'Free', 'Int', 'Int64Op', 'Store', 'StrAlloc'],
    nsExec: ['Exec', 'ExecToLog', 'ExecToStack'],
    NSISdl: ['download'],
  }
  for (const [dll, names] of Object.entries(exports)) {
    writeFileSync(join(plugins, `${dll}.dll`), minimalPeWithExports(names))
  }
}

/**
 * A structurally valid PE32 DLL whose export table lists the given names.
 *
 * NSIS parses the export table to decide whether `Foo::Bar` is a call it should accept. A hand-built file is enough:
 * nothing here is ever loaded or executed, only read.
 */
function minimalPeWithExports(names: string[]): Buffer {
  const ALIGN = 0x200
  const align = (n: number): number => Math.ceil(n / ALIGN) * ALIGN
  const IMAGE_BASE = 0x10000000
  const EXP_RVA = 0x1000
  const RSRC_RVA = 0x2000

  const count = names.length
  const funcsOff = 40
  const namesOff = funcsOff + 4 * count
  const ordsOff = namesOff + 4 * count
  const strsOff = ordsOff + 2 * count
  const blob = Buffer.from(names.map((name) => `${name}\0`).join(''), 'latin1')
  const nameRvas: number[] = []
  let offset = 0
  for (const name of names) {
    nameRvas.push(EXP_RVA + strsOff + offset)
    offset += name.length + 1
  }

  const export_ = Buffer.alloc(strsOff + blob.length)
  export_.writeUInt32LE(0, 0)                       // Characteristics
  export_.writeUInt32LE(0, 4)                       // TimeDateStamp
  export_.writeUInt16LE(0, 8)                       // MajorVersion
  export_.writeUInt16LE(0, 10)                      // MinorVersion
  export_.writeUInt32LE(0, 12)                      // Name
  export_.writeUInt32LE(0, 16)                      // Base
  export_.writeUInt32LE(count, 20)                  // NumberOfFunctions
  export_.writeUInt32LE(count, 24)                  // NumberOfNames
  export_.writeUInt32LE(EXP_RVA + funcsOff, 28)     // AddressOfFunctions
  export_.writeUInt32LE(EXP_RVA + namesOff, 32)     // AddressOfNames
  export_.writeUInt32LE(EXP_RVA + ordsOff, 36)      // AddressOfNameOrdinals
  for (let index = 0; index < count; index += 1) {
    export_.writeUInt32LE(0, funcsOff + 4 * index)
    export_.writeUInt32LE(nameRvas[index]!, namesOff + 4 * index)
    export_.writeUInt16LE(index, ordsOff + 2 * index)
  }
  blob.copy(export_, strsOff)

  const rsrc = Buffer.concat([Buffer.alloc(16), Buffer.from([0, 0, 0, 0, 0, 0, 0, 0])])

  const dosHeader = Buffer.alloc(0x40)
  dosHeader.write('MZ', 0, 'latin1')
  dosHeader.writeUInt32LE(0x80, 0x3c)
  const stub = Buffer.alloc(0x80 - 0x40)

  const optOff = 0x80 + 4 + 20
  const sectOff = optOff + 224
  const raw1 = align(sectOff + 40 * 2)
  const raw2 = raw1 + align(export_.length)

  const coff = Buffer.alloc(20)
  coff.writeUInt16LE(0x014c, 0)                     // i386
  coff.writeUInt16LE(2, 2)                          // NumberOfSections
  coff.writeUInt16LE(224, 16)                       // SizeOfOptionalHeader
  coff.writeUInt16LE(0x2102, 18)                    // EXECUTABLE_IMAGE | 32BIT_MACHINE

  const opt = Buffer.alloc(224)
  opt.writeUInt16LE(0x10b, 0)                       // PE32
  opt.writeUInt32LE(IMAGE_BASE, 20)
  opt.writeUInt32LE(ALIGN, 32)                      // SectionAlignment
  opt.writeUInt32LE(ALIGN, 36)                      // FileAlignment
  opt.writeUInt32LE(RSRC_RVA + align(rsrc.length), 56)
  opt.writeUInt32LE(raw1, 60)
  opt.writeUInt16LE(3, 68)                          // subsystem: console
  opt.writeUInt32LE(16, 92)                         // NumberOfRvaAndSizes
  opt.writeUInt32LE(EXP_RVA, 96)                    // export directory
  opt.writeUInt32LE(export_.length, 100)
  opt.writeUInt32LE(RSRC_RVA, 96 + 16)              // resource directory
  opt.writeUInt32LE(rsrc.length, 96 + 20)

  const section = (name: string, size: number, rva: number, raw: number): Buffer => {
    const buffer = Buffer.alloc(40)
    buffer.write(name, 0, 'latin1')
    buffer.writeUInt32LE(align(size), 8)            // VirtualSize
    buffer.writeUInt32LE(rva, 12)
    buffer.writeUInt32LE(size, 16)                  // SizeOfRawData
    buffer.writeUInt32LE(raw, 20)
    buffer.writeUInt32LE(0x40000040, 36)            // READ | INITIALIZED_DATA
    return buffer
  }

  const head = Buffer.concat([dosHeader, stub, Buffer.from('PE\0\0', 'latin1'), coff, opt,
    section('.edata', export_.length, EXP_RVA, raw1), section('.rsrc', rsrc.length, RSRC_RVA, raw2)])
  const pad = (buffer: Buffer): Buffer => Buffer.concat([buffer, Buffer.alloc(align(buffer.length) - buffer.length)])
  return pad(Buffer.concat([head, Buffer.alloc(raw1 - head.length), export_, Buffer.alloc(raw2 - raw1 - export_.length), rsrc]))
}

/**
 * Functions NSIS is allowed to find unreferenced in each build, and why.
 *
 * Warning 6010 ("zeroing code") is not noise to be filtered: it means NSIS discarded a function body. That is fine when
 * a function is deliberately compiled out of one build, and dangerous anywhere else -- the first version of this harness
 * silently lost every custom page this way, because the hook that inserts them was missing. An unreferenced function
 * that is not on this list is a failure, so a page or a handler dropping out of the build is loud rather than quiet.
 */
const EXPECTED_UNREFERENCED: Record<string, string[]> = {
  // Nothing is compiled out of the online build. The currency page's helper is unreferenced because the default build
  // profile does not lock the currency; the locked branch is the only caller.
  online: ['LoadDefaultCurrencyFields'],
  // The download page and its offline fallback exist only in the online build, by design (see installer.nsi's
  // `!if ${INFOPLEX_OFFLINE} == 0`).
  offline: ['LoadDefaultCurrencyFields', 'DownloadPageCreate', 'DownloadOfflineClicked'],
  // offline-include.nsh sets INFOPLEX_OFFLINE and includes installer.nsi, so the compiler sees exactly what the offline
  // build sees and drops exactly the same functions.
  'offline-wrapper': ['LoadDefaultCurrencyFields', 'DownloadPageCreate', 'DownloadOfflineClicked'],
  // The uninstaller pass inserts the page hooks, so the currency field loader (a custom-page callback) is referenced
  // here even though the plain online build never calls it. Nothing is expected to drop out of this build.
  'uninstaller-pass': [],
}

interface Result {
  label: string
  output: string
  blocking: string[]
  /** Absolute path to the installer this run wrote, when makensis got that far. */
  installer: string | null
  /** What the produced file actually is, once verified. */
  artifact: PeArtifact | null
}

/** Compiles the harness, twice: once for the online build and once for the offline build. */
function compile(label: string, defines: string[], script = 'installer/nsis/harness/harness.nsi'): Result {
  const root = process.cwd()
  const resources = join(WORK, 'resources')
  mkdirSync(resources, { recursive: true })
  if (!existsSync(join(resources, 'password-check.exe'))) {
    writeFileSync(join(resources, 'password-check.exe'), 'placeholder')
  }
  run('cp', ['-f', join(root, 'build/installer-sidebar.bmp'), join(resources, 'installer-sidebar.bmp')])

  // Each build writes to its own directory. Sharing one would let the online build's successful output satisfy the
  // offline build's check, so an offline build that never ran would still look like it had produced an installer.
  const outdir = join(WORK, 'out', label)
  mkdirSync(outdir, { recursive: true })
  const expected = join(outdir, 'harness-output.exe')
  rmSync(expected, { force: true })

  try {
    const output = run(MAKENSIS, [
      ...defines,
      // -V2 is not cosmetic: without it makensis prints errors and still exits 0, so execFileSync never throws and a
      // compile failure looks like success. This is the difference between a check and a decoration.
      '-V2',
      // -WX is what electron-builder actually passes, and it was missing here for a whole phase. Without it this check
      // built cleanly while the real `npm run build` would have stopped on the first warning -- the harness agreeing
      // with itself rather than with the build it is supposed to stand in for. Any warning is now fatal, exactly as on
      // the vendor's machine, so the warning suppressions in installer.nsi are exercised rather than assumed.
      '-WX',
      '-INPUTCHARSET', 'UTF8',
      `-DHARNESS_OUTFILE=${expected}`,
      '-X!addincludedir ' + join(root, 'installer/nsis'),
      '-DBUILD_RESOURCES_DIR=' + resources,
      join(root, script),
    ], { cwd: root, env: { ...process.env, NSISDIR } })
    let artifact: PeArtifact | null = null
    if (existsSync(expected)) {
      try {
        artifact = inspectPe(readFileSync(expected))
      } catch (error) {
        return { label, output: `${output}\n${(error as Error).message}`, blocking: [(error as Error).message], installer: expected, artifact: null }
      }
    }
    return { label, output, blocking: [], installer: existsSync(expected) ? expected : null, artifact }
  } catch (error) {
    // Both streams: makensis writes "Error initializing CEXEBuild" to stderr and script errors to stdout. Reading only
    // one of them is how this check first reported success while compiling nothing at all.
    const stdout = String((error as { stdout?: string }).stdout ?? '')
    const stderr = String((error as { stderr?: string }).stderr ?? '')
    const output = `${stdout}${stderr}`
    return { label, output, blocking: blockingErrors(output), installer: null, artifact: null }
  }
}

/**
 * Separates the errors that matter from the ones that do not.
 *
 * Warnings are deliberately not listed here: NSIS emits 6001 and 6010 for perfectly good scripts, and a check that
 * fails on them is a check people turn off. The one error that matters most is `Error initializing CEXEBuild`, which
 * means makensis never even began and the run proves nothing; it goes to stderr and was invisible to the first version.
 */
function blockingErrors(output: string): string[] {
  return output.split('\n').map((line) => line.trim()).filter((line) =>
    /^(Invalid command|!include: error|!insertmacro:|Error: |Error in |Usage:|File: |Error initializing)/u.test(line),
  )
}

function main(): void {
  ensureMakensis()
  prepareIncludes()

  // The stubs are built after prepareIncludes, because it is prepareIncludes that decides where NSISDIR lives.
  if (!buildStubs(join(WORK, 'nsis'), NSISDIR)) {
    // Not a soft failure. Without stubs makensis gets every check right and then fails at the final byte-write, so the
    // run would report a script error that is really a toolchain problem. Say which it is.
    console.log('The installer stubs could not be cross-compiled, so makensis cannot write an executable.')
    console.log(`  Look for build errors above, then check ${join(WORK, 'mingw-shim')} and ${join(WORK, 'zig')}.`)
    process.exitCode = 1
    return
  }

  const online = compile('online', [])
  const offline = compile('offline', ['-DINFOPLEX_OFFLINE=1'])
  // The third build is the one the shipping offline installer actually performs. electron-builder's `include` for that
  // configuration is offline-include.nsh, not installer.nsi, and compiling the second never compiled the first.
  const wrapper = compile('offline-wrapper', ['-DHARNESS_ENTRY=offline-include.nsh'])
  // The fourth build is electron-builder's second pass. It compiles the installer again with BUILD_UNINSTALLER defined,
  // and only that pass reaches uninstaller.nsh, which owns the single `!insertmacro customUnInstall`. Until this
  // existed, the macro that removes the firewall rule, the autostart entry and the registry key had never been compiled
  // by anything. It needs its own script because the uninstaller pass has a different NSIS environment.
  // PRODUCT_NAME is the one define electron-builder always supplies and this script needs at parse time (it names the
  // section, the uninstaller and the OutputFile). The real build passes it; the check must too, or it tests a build
  // nobody performs.
  const uninstaller = compile('uninstaller-pass', ['-DPRODUCT_NAME=Infoflex'],
    'installer/nsis/harness/uninstaller-pass.nsi')

  let failed = false
  for (const result of [online, offline, wrapper, uninstaller]) {
    if (result.blocking.length > 0) {
      failed = true
      console.log(`\n${result.label}: NSIS rejected the script.`)
      for (const problem of result.blocking) console.log(`  ${problem}`)
      continue
    }

    const warnings = result.output.split('\n')
      .map((line) => line.trim())
      .filter((line) => /^warning \d{4}/u.test(line))

    // 6010 names the function it discarded, so the check can hold each build to exactly the set it expects.
    const discarded = new Set<string>()
    for (const warning of warnings) {
      const match = /^warning 6010: \w+ function "(?<name>[^"]+)" not referenced/u.exec(warning)
      if (match?.groups?.name) discarded.add(match.groups.name)
    }
    const unexpected = [...discarded].filter((name) => !(EXPECTED_UNREFERENCED[result.label] ?? []).includes(name))
    const expectedButMissing = (EXPECTED_UNREFERENCED[result.label] ?? []).filter((name) => !discarded.has(name))

    if (!result.artifact) {
      // A clean exit with no artifact is the failure mode that matters most: it looks like success.
      failed = true
      console.log(`\n${result.label}: NSIS reported no errors but produced no installer.`)
      console.log(`  Expected a file at ${result.installer ?? join(WORK, 'out', result.label)}.`)
      continue
    }

    console.log(`\n${result.label}: built a ${result.artifact.bytes.toLocaleString('en-US')}-byte installer.`)
    console.log('  Every page, function, macro and instruction resolved, and both electron-builder hooks compiled.')
    console.log(`  Verified from its own header: MZ, PE at 0x${result.artifact.peOffset.toString(16)}, ` +
      `machine 0x014c (i386), subsystem 2 (Windows GUI), ${result.artifact.sections} sections.`)
    if (warnings.length > 0) console.log(`  ${warnings.length} warning(s): ${warnings.map((w) => w.split(':')[0]).join(', ')}`)

    if (unexpected.length > 0) {
      failed = true
      console.log(`  NSIS discarded function(s) this build is supposed to contain: ${unexpected.join(', ')}`)
      console.log('  A page or handler has dropped out of the script -- check the macro that inserts it.')
    }
    // The reverse direction matters too: a list of expected omissions that no longer omits anything is a stale list,
    // and a stale list is how a real omission gets pre-approved.
    if (expectedButMissing.length > 0) {
      console.log(`  Note: these were expected to be compiled out but were not: ${expectedButMissing.join(', ')}`)
      console.log('  Update EXPECTED_UNREFERENCED in this script if the script changed on purpose.')
      failed = true
    }

    // Reaching here twice means the two builds are genuinely separate artefacts, not one file checked twice.
    console.log(`  Artefact: ${result.installer}`)
  }

  if (failed) {
    console.log('\nThe installer does not build. Nothing else in this phase can be trusted until it does.')
    process.exitCode = 1
    return
  }
  console.log('\nAll four builds produced real installers. See docs/DECISIONS.md for what this does and does not prove.')
}

main()
