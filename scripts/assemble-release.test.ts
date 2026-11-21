import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { deliverables, missingInstallerSources, requiredInstallerSources } from './assemble-release.ts'

/**
 * The release manifest tells the customer why an `.exe` is missing. Twice now that explanation has gone stale in the
 * direction that matters: it named `makensis` as a blocker long after `makensis` was building from source here, and it
 * said the compiler "cannot be installed without root" after the stubs had been cross-compiled with Zig.
 *
 * A wrong reason is worse than no reason. It sends the reader to work around a solved problem, and it makes the
 * remaining, real blocker look like one of several vague toolchain issues instead of the single specific thing it is:
 * the Windows Electron runtime cannot be downloaded here.
 *
 * These tests hold the stated reasons to the state of this repository. They cannot prove the network is down; they can
 * prove the reasons do not contradict work that is demonstrably done.
 */

const SOURCE = readFileSync('scripts/assemble-release.ts', 'utf8')

/** The `absent` explanations, keyed by the file they explain. */
const reasons = new Map(deliverables.filter((d) => d.absent).map((d) => [d.target, d.absent!] as const))

describe('the release manifest explains a missing .exe with a reason that is still true', () => {
  it('no longer blames makensis, which builds from source here', () => {
    // `npm run installer:compile` builds makensis and produces a real installer. Any reason that still names it as a
    // blocker is describing a solved problem.
    for (const [file, reason] of reasons) {
      expect(reason, `${file} still names makensis as a blocker`).not.toMatch(/makensis/u)
      expect(reason, `${file} still claims the compiler cannot be installed`).not.toMatch(/cannot be installed|without root/iu)
    }
  })

  it('names the Electron runtime, which is the one wall still standing', () => {
    const installer = [...reasons.entries()].find(([file]) => file.endsWith('Infoflex Setup.exe'))
    expect(installer, 'the online installer has no stated reason').toBeDefined()
    expect(installer![1]).toMatch(/electron-v45\.3\.3-win32-x64\.zip|Electron runtime/iu)
    expect(installer![1]).toMatch(/objects\.githubusercontent\.com/u)
  })

  it('points at the command that would produce the file on a machine that can reach the runtime', () => {
    // A reason without a next step is a dead end for whoever reads the release folder.
    expect(reasons.get('release/Infoflex Setup.exe')).toMatch(/installer:online/u)
    expect(reasons.get('release/Infoflex Setup Offline.exe')).toMatch(/installer:offline/u)
    expect(reasons.get('tools/Infoflex Build Studio.exe')).toMatch(/dist:studio/u)
  })

  it('does not say it needs a "Windows toolchain", which was the vague phrasing that hid the real blocker', () => {
    for (const [file, reason] of reasons) {
      expect(reason, `${file} says "Windows toolchain", which is not a reason a reader can act on`)
        .not.toMatch(/Windows toolchain/iu)
    }
  })

  it('keeps the reasons in one place, so they cannot disagree with each other', () => {
    // Two copies of an explanation drift. The offline and Build Studio entries defer to the first instead.
    const online = reasons.get('release/Infoflex Setup.exe')!
    const offline = reasons.get('release/Infoflex Setup Offline.exe')!
    expect(offline, 'the offline reason should defer rather than repeat').toMatch(/Same reason/u)
    expect(offline.length).toBeLessThan(online.length)
  })
})

describe('the reasons are data, not prose in a function nobody can check', () => {
  it('exports the deliverables so the reasons can be tested', () => {
    expect(deliverables.length).toBeGreaterThanOrEqual(4)
    expect(SOURCE).toContain('export const deliverables')
  })

  it('only builds the manifest when run as a script', () => {
    // Without this guard, importing the module to read `deliverables` would assemble a release folder.
    expect(SOURCE).toMatch(/import\.meta\.url === `file:\/\/\$\{process\.argv\[1\]\}`/u)
  })
})

/**
 * The prerequisite gate.
 *
 * These read the script's source rather than running it, because running it writes a release folder. That is a weaker
 * kind of test and it is labelled as such: the *behaviour* of the gate was verified by running
 * `npm run release:assemble` (it prints RELEASE STOPPED and exits 1) and `-- --allow-unpinned` (it assembles and warns).
 * What these pin is that neither route can be quietly removed, and that the unpinned route cannot be reached by accident.
 */
describe('the release refuses to finish without a verified prerequisite', () => {
  it('calls the gate that rejects the all-zeros digest', () => {
    expect(SOURCE).toContain('assertReleasePin(pin.sha256)')
  })

  it('stops the process rather than warning', () => {
    // A warning leaves the folder on disk looking finished. The exit code is the only thing that stops a person
    // copying it to a USB stick.
    expect(SOURCE).toMatch(/console\.error\(`\\nRELEASE STOPPED:[\s\S]{0,400}process\.exit\(1\)/u)
  })

  it('refuses a profile with no pin, not only one with zeros in it', () => {
    expect(SOURCE).toContain('The build profile carries no prerequisite pin')
  })

  it('only assembles unpinned when asked by an explicit flag', () => {
    expect(SOURCE).toContain("process.argv.includes('--allow-unpinned')")
    // And the flag cannot be reached by the shippable script: the npm alias that passes it has its own name.
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts['release:assemble']).not.toContain('--allow-unpinned')
    expect(pkg.scripts['release:assemble:dev']).toContain('--allow-unpinned')
  })

  it('says the unpinned folder is not for distribution', () => {
    expect(SOURCE).toContain('Not for distribution')
    // And records it in the manifest it writes, so the folder carries the fact rather than the terminal scrollback.
    expect(SOURCE).toContain('pinned: false')
  })

  it('records the digest and the Microsoft version in the release folder', () => {
    expect(SOURCE).toContain('PREREQUISITE.txt')
    expect(SOURCE).toContain('Microsoft version:')
    expect(SOURCE).toContain('certutil -hashfile vc_redist.x64.exe SHA256')
  })
})

/**
 * Two ways this script used to print the wrong thing.
 *
 * Both were found by running it on a genuinely clean clone rather than on the working tree, which is the only place
 * either defect shows: the tree always has a profile by the time anyone looks.
 */
describe('the assembly fails with a sentence, not a Node error', () => {
  it('reads the profile from the root, where the pin is written', () => {
    // `installer:script` writes a copy under installer/nsis/ on every run. Reading that copy meant a clean checkout --
    // where it does not exist -- threw ENOENT and the catch printed it verbatim.  Observed on a fresh clone before the
    // fix: "RELEASE STOPPED: ENOENT: no such file or directory, open 'installer/nsis/build-profile.json'".
    expect(SOURCE).toContain("const profilePath = BUILD_PROFILE_FILENAME")
    expect(SOURCE).not.toContain("join('installer', 'nsis', BUILD_PROFILE_FILENAME), 'utf8'")
  })

  it('tolerates a checkout that has no profile yet', () => {
    expect(SOURCE).toMatch(/existsSync\(profilePath\) \? parseBuildProfile/u)
  })

  it('marks an unpinned folder inside the folder, where a person will see it', () => {
    // The terminal warning is gone by the time somebody copies release/ to a USB stick.
    expect(SOURCE).toContain('DO-NOT-DISTRIBUTE.txt')
    expect(SOURCE).toContain('THIS FOLDER IS NOT A RELEASE.')
  })
})

describe('the release never claims an override it does not implement', () => {
  it('does not tell the operator to move the file and set an environment variable', () => {
    // The success message said "the offline build reads the file from INFOFLEX_PREREQUISITE_VCREDIST or
    // installer/cache/". Nothing read that variable, so following the instruction produced a build bundling nothing.
    const script = readFileSync('scripts/release-prerequisite.ts', 'utf8')
    expect(script).not.toMatch(/reads the file from[\s\S]{0,40}PREREQUISITE_PATH_ENV/u)
    expect(script).toContain('There is no override')
  })
})

describe('every file the folder carries is in the checksum list', () => {
  it('writes SHA256SUMS after the records it must include, not before', () => {
    // Found by running it: PREREQUISITE.txt and DO-NOT-DISTRIBUTE.txt were created after the sums had been written, so
    // the two files whose whole purpose is to be checked were the two the checksum list omitted. Verified fixed by
    // building a folder and grepping SHA256SUMS.txt for DO-NOT-DISTRIBUTE.
    const sumsAt = SOURCE.indexOf("writeFileSync(join(RELEASE, 'SHA256SUMS.txt')")
    const warningAt = SOURCE.indexOf('DO-NOT-DISTRIBUTE.txt')
    const recordAt = SOURCE.indexOf("join(RELEASE, 'PREREQUISITE.txt')")
    expect(sumsAt).toBeGreaterThan(-1)
    expect(sumsAt, 'the sums must be written after the warning file is created').toBeGreaterThan(warningAt)
    expect(sumsAt, 'the sums must be written after the prerequisite record is created').toBeGreaterThan(recordAt)
  })
})

describe('the profile that records the pin is tracked, and its generated copy is not', () => {
  /**
   * Both halves have been wrong. The root profile is where the pin is written, so losing it means a release with no
   * record of its binary; the copy under installer/nsis/ is regenerated on every `installer:script` run, so tracking it
   * means a file that shows as modified after every build. A bare `!build-profile.json` negation fixed the first and
   * broke the second, which is the failure this pins.
   */
  const git = (args: string[]) => {
    try {
      return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      const failure = error as { status?: number; stdout?: string }
      if (failure.status === 1) return failure.stdout ?? ''
      throw error
    }
  }

  it('does not ignore the root profile', () => {
    expect(git(['check-ignore', 'build-profile.json']).trim()).toBe('')
  })

  it('still ignores the copy installer:script regenerates', () => {
    expect(git(['check-ignore', 'installer/nsis/build-profile.json']).trim()).not.toBe('')
  })
})

describe('the profile that travels with a release holds no secret', () => {
  it('has no field for a password, a key or a token', () => {
    // It is now committed, so this stopped being a matter of "nobody would put one there". The type is the guarantee:
    // a field that does not exist cannot be serialised into a file that goes into git. `licenseServerUrl` is validated
    // against embedded credentials (see build-profile.ts), and the rest is a currency code and a public digest.
    const profile = readFileSync('installer/src/build-profile.ts', 'utf8')
    // FIELD NAMES, not prose. The first version of this test scanned the whole interface including its comments and
    // failed on the word "password" inside an explanatory sentence -- a false positive that would have been "fixed" by
    // editing the sentence, which is the wrong direction.
    const body = profile.slice(profile.indexOf('export interface BuildProfile'), profile.indexOf('export interface BuildProfileProblem'))
    const fields = [...body.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*)\??:/gmu)].map((match) => match[1]!.toLowerCase())
    expect(fields.length, 'the field scan must find the fields, or it proves nothing').toBeGreaterThan(4)
    for (const forbidden of ['password', 'privatekey', 'secret', 'token', 'apikey', 'credential']) {
      expect(fields, `BuildProfile must not carry a ${forbidden} field`).not.toContain(forbidden)
    }
  })

  it('is the file a release actually records its pin in', () => {
    // Committed to the repository so this assertion can never pass vacuously against a missing file.
    const tracked = execFileSync('git', ['ls-files', 'build-profile.json'], { encoding: 'utf8' }).trim()
    expect(tracked, 'build-profile.json must be tracked, or the pin it records is not part of the release').toBe('build-profile.json')
  })
})

describe('pinning one component does not discard another', () => {
  it('merges into the list instead of replacing it', () => {
    // No test caught this when it was mutated to `slice(0, 0)`, because the write happens inside `main()` and running
    // it needs a fetch. So this is a structural test and is labelled one: it pins the shape of the merge, not its
    // behaviour. The behaviour is guarded a step earlier by the list itself -- `prerequisites` is an array precisely so
    // that an assignment cannot express "add one" -- and by the validation that refuses a duplicate id.
    const script = readFileSync('scripts/release-prerequisite.ts', 'utf8')
    expect(script).toMatch(/prerequisites = \[\s*\n\s*\.\.\.\(profile\.prerequisites \?\? \[\]\)\.filter/u)
    expect(script).not.toMatch(/profile\.prerequisites = \[\s*\n\s*\{/u)
  })

  it('records the component id the fetch actually used, not a literal', () => {
    // A hard-coded 'vcredist-x64' here would make every pin for a different component claim to be this one.
    const script = readFileSync('scripts/release-prerequisite.ts', 'utf8')
    expect(script).toContain('id: fetched.componentId')
    expect(script).not.toMatch(/id: 'vcredist-x64',\s*\n\s*sha256: fetched/u)
  })

  it('matches the pin it reads by component id', () => {
    const script = readFileSync('scripts/release-prerequisite.ts', 'utf8')
    expect(script).toContain("entry.id === 'vcredist-x64'")
    // And never takes the first entry: a list read positionally is a list that will be read wrong.
    expect(script).not.toMatch(/prerequisites\?\.\[0\]/u)
  })
})


/**
 * The rebuild kit.
 *
 * `release/installer-sources/` exists so the `.exe` can be rebuilt without the rest of the repository. It had two
 * defects, both pointing the same way -- a kit that looks complete and cannot rebuild what was shipped:
 *
 *   1. Every missing file was skipped (`if (!present(from)) continue`). `generated.nsh` and `prerequisite.nsh` are
 *      produced by `installer:script`, so a release assembled without that step shipped both installers and neither of
 *      the headers they were compiled from.
 *   2. The folder was never cleared, so a second release kept the first release's headers beside the second release's
 *      installers.
 *
 * These tests exercise the list and the completeness check directly. The copy itself cannot be run on a machine whose
 * cached prerequisite is not signed by Microsoft -- the signature gate stops the assembly first, correctly -- so this is
 * a test of the guard rather than of the copy, and it says so.
 */
describe('the installer sources a rebuild needs are required, not optional', () => {
  it('lists the two generated headers among the required sources', () => {
    const paths = requiredInstallerSources().map(([from]) => from)
    // The exact pair that was silently skippable, and the pair a rebuild of the installer cannot do without.
    expect(paths).toContain('installer/nsis/generated.nsh')
    expect(paths).toContain('installer/nsis/prerequisite.nsh')
    expect(paths).toContain('installer/nsis/installer.nsi')
  })

  it('reports a missing generated header instead of skipping it', () => {
    // Driven by an injected predicate, so the test states the behaviour rather than depending on the tree's state.
    const missing = missingInstallerSources(
      [['installer/nsis/generated.nsh', 'npm run installer:script']],
      () => false,
    )
    expect(missing).toHaveLength(1)
    // The message names the command that produces it, because "generated.nsh is missing" is not actionable alone.
    expect(missing[0]).toContain('npm run installer:script')
  })

  it('reports nothing when every source is present', () => {
    expect(missingInstallerSources([['a.nsh', 'somewhere']], () => true)).toEqual([])
  })

  it('is complete in this repository right now', () => {
    // The other direction: the list must not name a file this project never produces, or every release would stop.
    expect(missingInstallerSources(requiredInstallerSources())).toEqual([])
  })

  it('clears the old kit rather than merging into it', () => {
    // A stale header is not detectable after the fact -- it is simply a different digest in a file with the right name.
    const source = readFileSync('scripts/assemble-release.ts', 'utf8')
    const clearAt = source.indexOf('rmSync(sourcesDirectory, { recursive: true, force: true })')
    // Anchored on the sources-kit copy, not on the FIRST `copyFileSync` in the file -- which belongs to a different
    // copy (build-studio) and made the first version of this test pass for the wrong reason.
    const copyAt = source.indexOf('copyFileSync(from, to)', clearAt)
    expect(clearAt).toBeGreaterThan(-1)
    expect(copyAt).toBeGreaterThan(clearAt)
  })

  it('no longer skips an absent source', () => {
    // The CODE, not the prose: the string `if (!present(from)) continue` also appears in the comment that records the
    // defect, so a test that grepped the whole file would fail on its own explanation -- or, if written the other way
    // round, pass on it. Everything from the sources-kit marker onwards is the executable part.
    const source = readFileSync('scripts/assemble-release.ts', 'utf8')
    const code = source.slice(source.indexOf('const sourcesDirectory = join(RELEASE'))
    expect(code).not.toMatch(/if \(!present\(from\)\) continue/u)
    // And the guard that replaced it is there, with a non-zero exit.
    expect(code).toMatch(/missingSources[\s\S]{0,600}process\.exit\(1\)/u)
  })
})
