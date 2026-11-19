import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
 * It proves the script parses and every macro, page, function and instruction resolves. It uses the real NSIS headers.
 * It does **not** produce an installer: that needs a Windows resource compiler for the UI and the installer stub, and
 * neither exists here, so a dummy stub is used and the build stops at the final byte-write ("PE file contains invalid
 * DOS header") -- after every check that matters. It also cannot prove electron-builder's template agrees with us.
 *
 * Two local patches to the NSIS install are applied, and they are the only two: MUI2's ChangeUI calls and the
 * InstProgressFlags directive are stubbed, because both open a Windows .exe and rewrite its dialog resources. Neither
 * has anything to do with the file under test.
 *
 * Usage: npx tsx scripts/compile-check-installer.ts
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

interface Result { label: string; output: string; blocking: string[] }

/** Compiles the harness, twice: once for the online build and once for the offline build. */
function compile(label: string, defines: string[]): Result {
  const root = process.cwd()
  const resources = join(WORK, 'resources')
  mkdirSync(resources, { recursive: true })
  if (!existsSync(join(resources, 'password-check.exe'))) {
    writeFileSync(join(resources, 'password-check.exe'), 'placeholder')
  }
  run('cp', ['-f', join(root, 'build/installer-sidebar.bmp'), join(resources, 'installer-sidebar.bmp')])

  try {
    const output = run(MAKENSIS, [
      ...defines,
      // -V2 is not cosmetic: without it makensis prints errors and still exits 0, so execFileSync never throws and a
      // compile failure looks like success. This is the difference between a check and a decoration.
      '-V2',
      '-INPUTCHARSET', 'UTF8',
      '-X!addincludedir ' + join(root, 'installer/nsis'),
      '-DBUILD_RESOURCES_DIR=' + resources,
      join(root, 'installer/nsis/harness/harness.nsi'),
    ], { cwd: root, env: { ...process.env, NSISDIR } })
    return { label, output, blocking: [] }
  } catch (error) {
    // Both streams: makensis writes "Error initializing CEXEBuild" to stderr and script errors to stdout. Reading only
    // one of them is how this check first reported success while compiling nothing at all.
    const stdout = String((error as { stdout?: string }).stdout ?? '')
    const stderr = String((error as { stderr?: string }).stderr ?? '')
    const output = `${stdout}${stderr}`
    return { label, output, blocking: blockingErrors(output) }
  }
}

/**
 * Separates the errors that matter from the one that does not.
 *
 * The dummy stub is one byte, so the final write always fails with "PE file contains invalid DOS header". Every check
 * of the script itself has already run by then, so that message is expected and is not a failure of the script.
 */
function blockingErrors(output: string): string[] {
  return output.split('\n').map((line) => line.trim()).filter((line) =>
    // `Error initializing CEXEBuild` is the one that matters most: it means makensis never even began, and the run
    // proves nothing. It is on stderr and was invisible to the first version of this function.
    /^(Invalid command|!include: error|!insertmacro:|Error: |Error in |Usage:|File: |Error initializing)/u.test(line)
    && !/invalid DOS header/u.test(line)
    && !/aborting creation process/u.test(line),
  )
}

function main(): void {
  ensureMakensis()
  prepareIncludes()

  const online = compile('online', [])
  const offline = compile('offline', ['-DINFOPLEX_OFFLINE=1'])

  let failed = false
  for (const result of [online, offline]) {
    const warnings = result.output.split('\n').filter((line) => /^warning 6050|^warning 60\d\d/u.test(line.trim()))
    // -V2 suppresses the "Processed N file" line, so the proof that the script got all the way through is the dummy
    // stub failing at the final write. Reaching that point means every page, function, macro and instruction resolved.
    const compiled = /invalid DOS header/u.test(result.output)
    if (result.blocking.length === 0 && !compiled) {
      failed = true
      console.log(`\n${result.label}: makensis produced no compile output at all, so nothing was checked.`)
      console.log(`  ${result.output.split('\n').filter((line) => line.trim()).slice(-3).join('\n  ')}`)
      continue
    }
    if (result.blocking.length === 0) {
      console.log(`\n${result.label}: NSIS accepted the script.`)
      console.log('  Every page, function, macro and instruction resolved, and both hooks compiled.')
      console.log('  It stopped at the final write ("invalid DOS header") because the stub is a placeholder.')
      for (const warning of warnings) console.log(`  ${warning.trim()}`)
    } else {
      failed = true
      console.log(`\n${result.label}: NSIS rejected the script.`)
      for (const problem of result.blocking) console.log(`  ${problem}`)
    }
  }

  if (failed) {
    console.log('\nThe installer script does not compile. Nothing else in this phase can be trusted until it does.')
    process.exitCode = 1
    return
  }
  console.log('\nBoth builds compile. See docs/DECISIONS.md for what this does and does not prove.')
}

main()
