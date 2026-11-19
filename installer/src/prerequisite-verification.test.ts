import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Nothing the installer *executes* may go unverified.
 *
 * THIS TEST EXISTS BECAUSE THE INSTALLER GOT IT WRONG
 *
 * The online build downloads the Visual C++ redistributable on its download page, and that page checks the file's
 * SHA-256 and its publisher before it is used. Then `InstallPrerequisites` ran the same file with `ExecWait` and
 * checked nothing at all — no checksum, no signature. The two paths looked equally careful in the source, and the
 * difference was invisible because the verification lives in a different function from the thing it protects.
 *
 * The consequence was worse than a missing check, because of the direction it failed in. `download-allowlist.ts` ships
 * the redistributable's digest as all zeros, deliberately, so that an unpinned build cannot pass verification. The
 * download page therefore *refuses* every download in this build. The unverified install path, having no check to fail,
 * was the one that still ran the binary. The safety measure protected the wrong path.
 *
 * So the rule encoded here is about `ExecWait`: any executable the installer launches must first have its digest
 * compared against `${VCREDIST_SHA256}` by the bundled helper. This is a static reading of the script; the compile check
 * proves it still parses, and this proves it still checks.
 */

const SCRIPT = readFileSync('installer/nsis/installer.nsi', 'utf8')

/** The body of a function, by name, without its trailing FunctionEnd. */
function functionBody(name: string): string {
  const start = SCRIPT.indexOf(`Function ${name}`)
  expect(start, `${name} is gone; this test is now checking nothing`).toBeGreaterThan(-1)
  const end = SCRIPT.indexOf('FunctionEnd', start)
  return SCRIPT.slice(start, end)
}

/** Every executable path the script launches, with the function it is launched from. */
function executedPrograms(): Array<{ fn: string; line: string }> {
  const found: Array<{ fn: string; line: string }> = []
  const functionPattern = /^Function (\w+)$/gmu
  const starts = [...SCRIPT.matchAll(functionPattern)].map((match) => ({ name: match[1]!, index: match.index! }))
  for (const [index, entry] of starts.entries()) {
    const body = SCRIPT.slice(entry.index, starts[index + 1]?.index ?? SCRIPT.length)
    for (const match of body.matchAll(/^.*\b(?:ExecWait|nsExec::Exec(?:ToStack|ToLog)?)\b.*$/gmu)) {
      found.push({ fn: entry.name, line: match[0].trim() })
    }
  }
  return found
}

describe('every binary the installer runs is verified first', () => {
  it('checks the redistributable in InstallPrerequisites, which it did not used to', () => {
    const body = functionBody('InstallPrerequisites')
    expect(body, 'InstallPrerequisites executes vc_redist.x64.exe').toMatch(/ExecWait/u)
    expect(
      body,
      'InstallPrerequisites must compare the digest before ExecWait; it once ran the file with no check at all',
    ).toMatch(/--sha256\s+"\$\{VCREDIST_SHA256\}"/u)
  })

  it('refuses to run it when the digest does not match', () => {
    // Verifying and then running anyway would be worse than not verifying: it would look careful.
    const body = functionBody('InstallPrerequisites')
    const check = body.indexOf('--sha256')
    const exec = body.indexOf('ExecWait')
    expect(check, 'the digest check must come before the ExecWait').toBeLessThan(exec)
    // The mismatch branch must abandon the install of that component rather than falling through to ExecWait.
    const between = body.slice(check, exec)
    expect(between, 'a failed digest must not fall through to ExecWait').toMatch(/Return/u)
  })

  it('names the failure in the log rather than skipping silently', () => {
    // A prerequisite that silently does not install is how a customer ends up with an app that will not start and no
    // idea why. The offline build is the one that matters here: it carries the file, so a mismatch means the file the
    // vendor shipped is wrong, not that the download was attacked.
    const body = functionBody('InstallPrerequisites')
    const mismatch = body.slice(body.indexOf('--sha256'), body.indexOf('ExecWait'))
    expect(mismatch, 'the mismatch branch must say something').toMatch(/DetailPrint|MessageBox/u)
  })

  it('leaves no ExecWait anywhere unverified except where the program is trusted by construction', () => {
    // A blanket assertion would be wrong: netsh is resolved from the system directory by Windows, not from a file we
    // downloaded, and the helper itself is part of our own signed payload. Anything else -- and in particular anything
    // that arrived over the network or from a file the customer chose -- must be checked first.
    //
    // The check is per function and ordered, not per line: the verification is a separate statement earlier in the same
    // function, so a line-level test would demand the digest appear on the ExecWait line itself and would be satisfied
    // by nothing a person would actually write.
    const trusted = ['netsh', 'password-check.exe']
    const offenders = executedPrograms()
      .filter(({ line }) => !trusted.some((name) => line.includes(name)))
      .filter(({ fn }) => {
        const body = functionBody(fn)
        const check = body.indexOf('--sha256')
        const exec = body.indexOf('ExecWait')
        // Verified: a digest comparison exists, and it happens before the launch.
        return !(check > -1 && check < exec)
      })
      .map(({ fn, line }) => `${fn}: ${line}`)
    expect(offenders, 'these launches are of a file that was not verified first').toEqual([])
  })

  it('verifies files the customer chooses, not just downloaded ones', () => {
    // "Browse for the file myself" is the easiest path to smuggle an arbitrary executable into the install, so it is
    // held to the same standard. This one was already right; it is asserted so it stays right.
    expect(functionBody('DownloadBrowseClicked')).toMatch(/--sha256\s+"\$\{VCREDIST_SHA256\}"/u)
  })
})

describe('the offline build does not depend on a define only the harness supplied', () => {
  it('guards PREREQUISITE_VCREDIST, which no real build defined', () => {
    // The harness defined PREREQUISITE_VCREDIST so its own `File` command would resolve. The real offline build defined
    // it nowhere, and failed with `File: "${PREREQUISITE_VCREDIST}" -> no files found` on line 786 -- a build-stopping
    // error that the harness could never reveal, because the harness was the thing supplying the missing value.
    expect(SCRIPT, 'the File command must be conditional on the define existing').toMatch(
      /!ifdef PREREQUISITE_VCREDIST[\s\S]{0,400}?File \/oname=\$PLUGINSDIR\\vc_redist\.x64\.exe "\$\{PREREQUISITE_VCREDIST\}"/u,
    )
  })

  it('does not define PREREQUISITE_VCREDIST in the installer script itself', () => {
    // A default here would be a path that does not exist on the build machine, which is the same failure with an extra
    // step. The value belongs to the build configuration.
    expect(SCRIPT).not.toMatch(/^\s*!define PREREQUISITE_VCREDIST/mu)
  })
})

describe('an unpinned digest must not leave a usable install path', () => {
  it('fails every verification when the digest is all zeros, which is what ships', () => {
    // The point of the zero digest is that an unpinned build cannot install an unverified binary. That only holds if
    // every path that reaches the binary goes through a check -- which is exactly what this file asserts above.
    const generator = readFileSync('installer/src/generate-installer-script.ts', 'utf8')
    expect(generator).toContain('VCREDIST_SHA256')
    const allowlist = readFileSync('installer/src/download-allowlist.ts', 'utf8')
    expect(allowlist, 'the all-zeros digest is the deliberate release-time default').toContain(`sha256: '${'0'.repeat(64)}'`)
  })
})
