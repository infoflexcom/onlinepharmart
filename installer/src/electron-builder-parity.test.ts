import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Guards the difference between "the harness builds" and "the build builds".
 *
 * electron-builder runs makensis with `-WX` unless the config sets `warningsAsErrors: false`, and this project does not
 * set it. That means a single warning stops `npm run build` on the vendor's machine.
 *
 * `npm run installer:compile` spent a whole phase not passing `-WX`, so the harness built cleanly while the real build
 * would have failed on its first warning. The harness was agreeing with itself. Both facts are now pinned here, because
 * either one silently un-doing the other puts us back in that state:
 *
 *  1. The compile check must pass `-WX`, so it fails where the real build fails.
 *  2. The script must therefore suppress the warnings it provokes on purpose — by number, never `disable all`, which
 *     would also hide the warnings that matter.
 *  3. The harness must re-enable the one warning that is evidence: 6010 reports a discarded function body, and a page
 *     function disappearing silently is the defect this suite already caught once.
 */

const CHECK = readFileSync('scripts/compile-check-installer.ts', 'utf8')
const SCRIPT = readFileSync('installer/nsis/installer.nsi', 'utf8')
const HARNESS = readFileSync('installer/nsis/harness/harness.nsi', 'utf8')

/** The warning codes a file explicitly disables, in order. */
function disabledWarnings(text: string): number[] {
  return [...text.matchAll(/^!pragma warning disable (\d{4})$/gmu)].map((match) => Number(match[1]))
}

describe('the compile check fails where the real build fails', () => {
  it('passes -WX, as electron-builder does', () => {
    // Without this the harness can pass on warnings the real build treats as fatal.
    expect(CHECK, 'the compile check must build with -WX to match electron-builder').toContain("'-WX'")
  })

  it('does not turn warnings as errors off in the electron-builder config', () => {
    // Setting warningsAsErrors:false would make -WX disappear from the real build too, which is the other way to make
    // the two agree -- and the one that ships a script nobody has proved is warning-clean.
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { build?: { nsis?: Record<string, unknown> } }
    expect(pkg.build?.nsis?.warningsAsErrors).toBeUndefined()
  })

  it('suppresses the warnings it provokes one code at a time, never all of them', () => {
    // `disable all` would defeat -WX entirely and is the easy mistake to make here.
    expect(SCRIPT).not.toMatch(/^!pragma warning disable all$/mu)
    expect(disabledWarnings(SCRIPT).sort()).toEqual([6001, 6010, 6020])
  })

  it('explains every suppressed code, so none is folklore', () => {
    for (const code of disabledWarnings(SCRIPT)) {
      expect(SCRIPT, `warning ${code} is suppressed with no explanation`).toMatch(new RegExp(`^;\\s+${code}\\s+\\S`, 'mu'))
    }
  })

  it('re-enables 6010 in the harness, because it is the only signal that a function was discarded', () => {
    expect(HARNESS, 'the harness must turn 6010 back on or a missing page function goes unreported').toMatch(
      /^!pragma warning enable 6010$/mu,
    )
  })
})
