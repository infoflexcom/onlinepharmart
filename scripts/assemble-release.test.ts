import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { deliverables } from './assemble-release.ts'

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
