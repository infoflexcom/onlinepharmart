import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, readdirSync, copyFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Builds NSIS's Windows installer stubs on a Linux host, so `makensis` can produce a real `.exe`.
 *
 * WHY THIS EXISTS
 *
 * NSIS's own build treats the stubs as a Windows-only artefact: `SKIPSTUBS=all` is the documented POSIX recipe, and the
 * official release tarball does not ship prebuilt stubs. Without them `makensis` parses the whole script, resolves every
 * macro, and then dies at the final byte-write with "PE file contains invalid DOS header" -- because there is no stub to
 * glue onto the payload. That is where `compile-check-installer.ts` used to stop, and it is why the previous phase
 * could say "the script compiles" but never "the installer builds".
 *
 * The stubs are ordinary Windows executables (`Source/exehead`), so building them needs a Windows compiler. There is no
 * mingw-w64 in this sandbox, and no package manager to install one. What there IS is Zig, published to PyPI as
 * `ziglang`, and `zig cc -target x86-windows-gnu` is a complete clang+lld cross-compiler with a working rc. So the
 * stubs are cross-compiled with Zig, driven through the command names NSIS's SCons expects.
 *
 * WHY IT IS SHAPED LIKE THIS
 *
 * Zig is not a GNU toolchain, and NSIS's build was written against GNU ld. Rather than patch NSIS's SConstruct (which
 * would mean the build under test is not the build upstream ships), this file writes small `i686-w64-mingw32-*` shell
 * shims into a private bin directory and puts that directory first on PATH. Every translation a shim performs is
 * documented at its site, and every one of them is either cosmetic (map files, padding) or a spelling difference
 * between GNU ld and lld for the same intent (entry point). None changes what the stub does.
 *
 * The one substantive adjustment is `-fno-sanitize=all -fno-stack-check`: Zig enables UBSan and stack probing by
 * default, and the stub is linked `-nostdlib`, so there is nothing to satisfy `__ubsan_handle_*` or `__alloca`. NSIS
 * builds these files with a bare gcc and no such instrumentation; turning it off restores that.
 *
 * WHAT THIS DOES NOT DO
 *
 * The stubs are x86 only. A 64-bit stub would need the same treatment for `x86_64-w64-mingw32`, and NSIS does not build
 * one by default on any host. Nothing here is a claim about the stubs being byte-identical to the ones NSIS ships: they
 * are built from the same sources with the same feature flags, which is what matters for the payload format.
 */

/** Where the NSIS source tree, the Zig toolchain and the built stubs live. Nothing here is written into the repo. */
export const NSIS_WORK = '/tmp/infoflex-nsis-build'

const SHIM_DIR = join(NSIS_WORK, 'mingw-shim')
const ZIG_DIR = join(NSIS_WORK, 'zig')
const ZIG = join(ZIG_DIR, 'ziglang', 'zig')
const CACHE = join(NSIS_WORK, 'zig-cache')

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  return execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe', ...options, maxBuffer: 64 * 1024 * 1024 })
}

function have(command: string): boolean {
  try {
    execFileSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Fetches Zig from PyPI. It is published as a plain wheel with the toolchain inside, so this is a download and an
 * unzip -- not a build. PyPI is used because it is the one host that serves a complete Windows-targeting compiler
 * here, and because pinning the version keeps the stubs reproducible.
 */
function ensureZig(): void {
  if (existsSync(ZIG)) return
  mkdirSync(ZIG_DIR, { recursive: true })
  if (!have('pip3')) throw new Error('pip3 is needed once to fetch the Zig toolchain from PyPI')
  // `pip download --no-deps` rather than a hand-built URL: PyPI's file host names wheels by hash, so the filename is
  // not predictable, and pip is what knows the real one. --no-deps because ziglang has none and a dependency resolve
  // is only another way for this to fail on a network this sandbox does not fully have.
  run('pip3', ['download', '--no-deps', '-d', ZIG_DIR, 'ziglang==0.17.1'])
  const wheel = readdirSync(ZIG_DIR).find((name) => name.endsWith('.whl'))
  if (!wheel) throw new Error('pip did not download the ziglang wheel')
  // A wheel is a zip. Extracting it is the whole install: there is no build step and no post-install script.
  run('python3', ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])',
    join(ZIG_DIR, wheel), ZIG_DIR])
  if (!existsSync(ZIG)) throw new Error('zig did not unpack where expected')
  chmodSync(ZIG, 0o755)
}

/**
 * Writes the compiler and resource-compiler shims.
 *
 * Both export a cache directory because Zig refuses to start without one and reports it as "AppDataDirUnavailable",
 * which reads like a Windows problem and is really just an unset HOME: SCons probes `--version` from an environment
 * that does not carry the parent shell's exports.
 */
function writeShims(): void {
  mkdirSync(SHIM_DIR, { recursive: true })

  const shims: Record<string, string> = {}

  // ---------------------------------------------------------------- compiler / linker
  shims['i686-w64-mingw32-g++'] = `#!/bin/sh
# Zig acting as a MinGW cross-compiler and linker for the NSIS stubs.
#
# Every adjustment below exists because NSIS's SCons build was written against GNU ld and Zig's linker is lld. Each is
# either cosmetic or a spelling difference for the same intent; none changes what the stub does.
#   -Wl,-Map,          map files are diagnostics only; lld spells this --Map and SCons never asks for that.
#   --file-alignment   section padding; the result is still a valid PE.
#   --exclude-libs     symbol visibility in a binary that is never loaded as a DLL.
#   -mwindows          Zig parses it and does nothing with it (its own warning says so). The real flag is
#                      -Wl,--subsystem,windows, which is kept. Getting this wrong is not cosmetic: the installer comes
#                      out as a console binary and flashes a terminal window at the vendor.
#   --subsystem,windows  kept; strip nothing.
#   -B pei-i386        names a GNU ld BFD backend; meaningless to lld.
#   -T <script>        NSIS's linker script is GNU-script syntax lld cannot parse. It only orders sections and asks for
#                      512-byte alignment, neither of which the PE loader requires.
#   -Wl,-e_NSISWinMainNOCRT   translated to lld's --entry= form. The stub must enter at NSIS's own CRT-less entry point.
export ZIG_GLOBAL_CACHE_DIR=${CACHE}
export ZIG_LOCAL_CACHE_DIR=${CACHE}
case "$1" in --version) echo "i686-w64-mingw32-g++ (zig)"; exit 0 ;; esac
NEW=""
skip=0
linking=1
for a in "$@"; do
  if [ "$skip" = "1" ]; then skip=0; continue; fi
  case "$a" in
    # SCons passes "-o out.o -c in.c", so compile versus link is decided by -c, not by the presence of -o.
    -c) linking=0; NEW="$NEW -c"; continue ;;
    # -mwindows is a no-op for Zig, so it is dropped; -Wl,--subsystem,windows is passed through and is what actually
    # selects the GUI subsystem.
    -mwindows) continue ;;
    -Wl,--file-alignment,*|-Wl,--exclude-libs,*|-Wl,-Map,*) continue ;;
    -Wl,-e_NSISWinMainNOCRT) NEW="$NEW -Wl,--entry=NSISWinMainNOCRT"; continue ;;
    -B|-T) skip=1; continue ;;
  esac
  NEW="$NEW
$a"
done
EXTRA=""
[ "$linking" = "1" ] && EXTRA=${join(NSIS_WORK, 'nsis-stub-crt.c')}
# -fno-sanitize/-fno-stack-check: Zig instruments by default and the stub is -nostdlib, so nothing would satisfy the
# helpers it emits. NSIS builds these with a bare gcc, which emits none of them.
exec ${ZIG} cc -target x86-windows-gnu -fno-sanitize=all -fno-stack-check -fno-stack-protector $NEW $EXTRA
`

  // gcc, ld, ar and strip all become the same driver. NSIS's SCons uses the prefix plus a tool name, so each name has
  // to exist; the driver dispatches on its own arguments, which are already in the forms Zig accepts.
  for (const tool of ['gcc', 'ld', 'strip']) {
    shims[`i686-w64-mingw32-${tool}`] = `#!/bin/sh
exec "$(dirname "$0")/i686-w64-mingw32-g++" "$@"
`
  }

  shims['i686-w64-mingw32-ar'] = `#!/bin/sh
export ZIG_GLOBAL_CACHE_DIR=${CACHE}
export ZIG_LOCAL_CACHE_DIR=${CACHE}
case "$1" in --version) echo "i686-w64-mingw32-ar (zig)"; exit 0 ;; esac
# Zig's COFF backend has no archiver; for the stubs the only use is listing a static library's members, and ls is a
# faithful answer to that. Nothing links against a .a here.
exec ls "$@"
`

  // ---------------------------------------------------------------- resource compiler
  shims['i686-w64-mingw32-windres'] = `#!/bin/sh
# Zig's rc is a drop-in for Microsoft's rc, which takes input and output POSITIONALLY (rc in.rc out.res). windres spells
# them -i and -o. This translates between the two, and pins the output machine type: Zig's rc defaults to x64, and an
# x64 .res on an x86 link fails with "machine type x64 conflicts with x86".
export ZIG_GLOBAL_CACHE_DIR=${CACHE}
export ZIG_LOCAL_CACHE_DIR=${CACHE}
case "$1" in --version) echo "i686-w64-mingw32-windres (zig)"; exit 0 ;; esac
args=""; infile=""; outfile=""; want=""
for a in "$@"; do
  case "$want" in
    in) infile="$a"; want=""; continue ;;
    out) outfile="$a"; want=""; continue ;;
  esac
  case "$a" in
    -i) want="in" ;;
    -o) want="out" ;;
    *) args="$args $a" ;;
  esac
done
# Zig's rc preprocesses with its own headers and needs the host's, for gcc's mm_malloc.h pulled in by <stdlib.h>.
exec ${ZIG} rc -:target i386 $args -I/usr/lib/gcc/x86_64-linux-gnu/12/include -- "$infile" "$outfile"
`

  for (const [name, body] of Object.entries(shims)) {
    const path = join(SHIM_DIR, name)
    writeFileSync(path, body, 'utf8')
    chmodSync(path, 0o755)
  }

  // The stub is linked -nostdlib and enters at NSISWinMainNOCRT, so no C runtime is used. Zig's driver still puts
  // startup objects on the link line, and those reference WinMain and __alloca. Neither is reachable from the NSIS
  // entry point; empty definitions cost a few bytes and keep the real CRT out. The asm() spellings are the exact
  // symbol names Zig's objects ask for, which the C names alone do not produce on i386.
  writeFileSync(join(NSIS_WORK, 'nsis-stub-crt.c'), `/* Filled in by scripts/nsis-stub-builder.ts. See the comment there. */
int winmain_unreachable(void *h, void *p, char *c) __asm__("_WinMain@16");
int winmain_unreachable(void *h, void *p, char *c) { (void)h; (void)p; (void)c; return 0; }
void *alloca_unreachable(unsigned int n) __asm__("__alloca");
void *alloca_unreachable(unsigned int n) { (void)n; return 0; }
`, 'utf8')
}

/** The compression variants NSIS ships, and the names it looks for at build time. */
const COMPRESSIONS = ['bzip2', 'lzma', 'zlib'] as const
const VARIANTS = [
  { solid: '', unicode: true, name: (c: string) => `${c}-x86-unicode` },
  { solid: '', unicode: false, name: (c: string) => `${c}-x86-ansi` },
  { solid: '_solid', unicode: true, name: (c: string) => `${c}_solid-x86-unicode` },
  { solid: '_solid', unicode: false, name: (c: string) => `${c}_solid-x86-ansi` },
] as const

/**
 * Cross-compiles the stubs and installs them into the NSIS distribution's `Stubs/` directory.
 *
 * Returns true when every stub is a real PE, so the caller can decide whether a real installer is expected.
 */
export function buildStubs(nsisSource: string, nsisDir: string): boolean {
  ensureZig()
  writeShims()

  const zlibPrefix = join(NSIS_WORK, 'zlib')
  const buildDir = join(nsisSource, 'build/urelease')
  const needed = VARIANTS.flatMap((v) => COMPRESSIONS.map((c) => v.name(c)))
  const installed = join(nsisDir, 'Stubs')
  // Presence is not enough: an earlier version of this script left a one-byte placeholder named zlib-x86-unicode, and a
  // "does the file exist" check happily accepted it, then makensis failed at the final write. A stub is only a stub if
  // it starts with MZ.
  const isStub = (name: string): boolean => {
    const path = join(installed, name)
    return existsSync(path) && readFileSync(path).subarray(0, 2).toString('latin1') === 'MZ'
  }
  if (needed.every(isStub)) {
    console.log('stubs present')
    return true
  }

  console.log('Cross-compiling the NSIS stubs with Zig. This takes about a minute the first time.')
  run('scons', ['-Q', 'SKIPUTILS=all', `XGCC_W32_PREFIX=i686-w64-mingw32-`,
    `APPEND_CPPPATH=${join(zlibPrefix, 'include')}`, `APPEND_LIBPATH=${join(zlibPrefix, 'lib')}`,
    `PREFIX=${join(NSIS_WORK, 'dist')}`, `BUILD_PREFIX=${join(NSIS_WORK, 'dist')}`, 'stubs'], {
    cwd: nsisSource,
    env: {
      ...process.env,
      PATH: `${SHIM_DIR}:${process.env.PATH ?? ''}`,
      CPATH: join(zlibPrefix, 'include'),
      LIBRARY_PATH: join(zlibPrefix, 'lib'),
    },
  })

  mkdirSync(installed, { recursive: true })
  for (const variant of VARIANTS) {
    for (const compression of COMPRESSIONS) {
      const from = join(buildDir, `stub_${compression}${variant.solid}-x86-${variant.unicode ? 'unicode' : 'ansi'}`,
        `stub_${compression}.exe`)
      const to = join(installed, variant.name(compression))
      if (existsSync(from)) copyFileSync(from, to)
    }
  }

  // `Stubs/uninst` is an icon, not a binary. makensis loads it while initialising and reports "Error initializing
  // CEXEBuild: can't open file" if it is absent, without naming the file.
  const icon = join(nsisSource, 'Source/exehead/uninst.ico')
  if (existsSync(icon)) copyFileSync(icon, join(installed, 'uninst'))

  const ok = needed.every(isStub)
  if (!ok) console.log(`  stubs not produced: ${needed.filter((name) => !isStub(name)).join(', ')}`)
  return ok
}

/** Removes a stale build tree. SCons's configure cache is sticky, so a path change needs a clean to take effect. */
export function cleanStubBuild(nsisSource: string): void {
  for (const path of ['build/urelease', '.sconsign.dblite', 'config.log']) {
    rmSync(join(nsisSource, path), { recursive: true, force: true })
  }
}
