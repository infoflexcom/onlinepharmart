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
  const start = CODE.indexOf(`Function ${name}`)
  expect(start, `${name} is gone; this test is now checking nothing`).toBeGreaterThan(-1)
  const end = CODE.indexOf('FunctionEnd', start)
  return CODE.slice(start, end)
}

/**
 * The script with its comment lines removed.
 *
 * Comments are stripped here for the same reason they are stripped in `uninstaller-contract.test.ts`: a test that
 * matches text will match prose. This suite originally scanned the raw file, and a comment explaining electron-builder's
 * own `ExecWait` of the previous uninstaller was reported as an unverified launch in `ConfigureStartup` -- a function
 * that has nothing to do with it. A test satisfied by a comment is a test that proves nothing.
 */
const CODE = SCRIPT.split('\n')
  .filter((line) => !line.trimStart().startsWith(';'))
  .join('\n')

/** Every executable path the script launches, with the function it is launched from. */
function executedPrograms(): Array<{ fn: string; line: string }> {
  const found: Array<{ fn: string; line: string }> = []
  const functionPattern = /^Function (\w+)$/gmu
  const starts = [...CODE.matchAll(functionPattern)].map((match) => ({ name: match[1]!, index: match.index! }))
  for (const [index, entry] of starts.entries()) {
    const body = CODE.slice(entry.index, starts[index + 1]?.index ?? CODE.length)
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

  it('refuses an offline build whose carried payload is missing, instead of installing anyway', () => {
    // The offline components page promises "every prerequisite is included in this installer". A build whose payload
    // was missing carried on and installed regardless -- the promise and the behaviour were never connected, and
    // $DownloadFailed (the template's own way of expressing this) is never set on the offline path because its
    // download page is !if-excluded. An installer built to be carried to a machine with no internet cannot quietly
    // leave the prerequisite behind.
    const body = functionBody('InstallPrerequisites')
    const missing = body.slice(body.indexOf('${IfNot} ${FileExists}'))
    expect(missing).not.toBe('')
    expect(missing).toMatch(/\$\{INFOPLEX_OFFLINE\} == 1/u)
    const offlineArm = missing.slice(missing.indexOf('${INFOPLEX_OFFLINE} == 1'))
    const beforeEnd = offlineArm.slice(0, offlineArm.indexOf('${EndIf}'))
    expect(beforeEnd, 'the offline arm must Abort, not fall through to installing').toMatch(/Abort/u)
    expect(beforeEnd).toMatch(/SetErrorLevel 4/u)
  })

  it('lets the ONLINE build carry on without the runtime, which it is allowed to do', () => {
    // The distinction is the whole point: online, the app asks for the runtime on first use and the download page has
    // already had its three attempts. Refusing there would break an install that works.
    const body = functionBody('InstallPrerequisites')
    const missing = body.slice(body.indexOf('${IfNot} ${FileExists}'))
    const afterOfflineArm = missing.slice(missing.indexOf('${EndIf}', missing.indexOf('${INFOPLEX_OFFLINE} == 1')))
    expect(afterOfflineArm).toMatch(/Return/u)
  })

// The signature check existed nowhere. download-allowlist.ts:121 said the read "is done by the NSIS side", the download
// page told the customer the files were "checked before they are run", and DownloadBrowseClicked's comment claimed
// "the same checksum and publisher check as a download". Only a SHA-256 comparison ever happened, and a checksum says
// nothing about who signed the file that is about to be executed.
describe('the redistributable is signature-checked on every path that can run it', () => {
  const script = readFileSync('installer/nsis/installer.nsi', 'utf8')
  const code = script
    .split('\n')
    .filter((line) => !line.trimStart().startsWith(';'))
    .join('\n')
  const fn = (name: string): string => {
    const start = code.indexOf(`Function ${name}`)
    if (start === -1) return ''
    return code.slice(start, code.indexOf('FunctionEnd', start))
  }

  it('has exactly one implementation, so the three paths cannot disagree', () => {
    const definitions = [...code.matchAll(/^Function CheckRedistSignature$/gmu)]
    expect(definitions).toHaveLength(1)
  })

  it('passes the pinned publisher to the helper, not a value read from the file', () => {
    // Comparing the file's own signature against itself would verify nothing.
    expect(fn('CheckRedistSignature')).toContain('--authenticode "${VCREDIST_PUBLISHER}"')
  })

  it('checks the signature on the download path before the file is accepted', () => {
    const leave = fn('DownloadPageLeave')
    const checksum = leave.indexOf('--sha256')
    const signature = leave.indexOf('Call CheckRedistSignature')
    expect(signature).toBeGreaterThan(checksum)
    // And the verified-badge text must not be reachable before the check.
    expect(leave.indexOf('The file is verified and correctly signed')).toBeGreaterThan(signature)
  })

  it('checks the signature on the browse path, which never did', () => {
    const browse = fn('DownloadBrowseClicked')
    expect(browse.indexOf('--sha256')).toBeGreaterThanOrEqual(0)
    expect(browse.indexOf('Call CheckRedistSignature')).toBeGreaterThan(browse.indexOf('--sha256'))
  })

  it('checks the signature immediately before the file is executed', () => {
    // InstallPrerequisites is the path that actually runs the redistributable. It used to check the digest and nothing
    // else -- the one unverified path being the one that executes.
    const prerequisites = fn('InstallPrerequisites')
    const signature = prerequisites.indexOf('Call CheckRedistSignature')
    const execute = prerequisites.indexOf('ExecWait')
    expect(signature).toBeGreaterThanOrEqual(0)
    expect(signature).toBeLessThan(execute)
  })

  it('refuses rather than continuing when the signature check fails', () => {
    for (const name of ['DownloadPageLeave', 'DownloadBrowseClicked', 'InstallPrerequisites']) {
      const body = fn(name)
      const check = body.indexOf('Call CheckRedistSignature')
      expect(check, `${name} does not check the signature`).toBeGreaterThanOrEqual(0)
      // Something must abort or return after a failed check, not fall through.
      const after = body.slice(check)
      expect(after, `${name} ignores a failed signature check`).toMatch(/Abort|Return/u)
    }
  })

  it('deletes the file when the signature does not match', () => {
    // A file that failed verification must not be left on disk for somebody to run by hand.
    expect(fn('DownloadPageLeave')).toContain('Delete "$PLUGINSDIR\\vc_redist.x64.exe"')
    expect(fn('InstallPrerequisites')).toContain('Delete "$PLUGINSDIR\\vc_redist.x64.exe"')
  })
})

// The allowlist was generated into the script and never read by it: ${ALLOWED_HOST_1..3} came from
// ALLOWED_DOWNLOAD_HOSTS and NSISdl::download was handed ${VCREDIST_URL} without asking where that was.
describe('the download host is checked in the installer, not only in TypeScript', () => {
  const script = readFileSync('installer/nsis/installer.nsi', 'utf8')
  const code = script
    .split('\n')
    .filter((line) => !line.trimStart().startsWith(';'))
    .join('\n')
  const leave = code.slice(code.indexOf('Function DownloadPageLeave'))
  const downloadAt = leave.indexOf('NSISdl::download')

  it('reads the generated allowlist defines', () => {
    for (const host of ['${ALLOWED_HOST_1}', '${ALLOWED_HOST_2}', '${ALLOWED_HOST_3}']) {
      expect(code, `${host} is generated and never used`).toContain(host)
    }
  })

  it('refuses before a socket is opened when the host is not on the list', () => {
    const firstHostCheck = leave.indexOf('${ALLOWED_HOST_1}')
    expect(firstHostCheck).toBeGreaterThanOrEqual(0)
    expect(firstHostCheck).toBeLessThan(downloadAt)
  })

  it('requires https', () => {
    const https = leave.indexOf('https://')
    expect(https).toBeGreaterThanOrEqual(0)
    expect(https).toBeLessThan(downloadAt)
  })
})

// The header carried the vendor's build version and the installer wrote electron-builder's packaging version into
// install-config.json instead -- so a build made for 2.3.4 recorded 0.1.0. The define existed for exactly this and was
// read by nothing, which is how the mismatch survived. The existing build-profile-wiring test caught it only when the
// define was temporarily deleted, which is what made it worth keeping rather than pruning.
describe('the installer records the version the vendor built for', () => {
  const script = readFileSync('installer/nsis/installer.nsi', 'utf8')
  const code = script
    .split('\n')
    .filter((line) => !line.trimStart().startsWith(';'))
    .join('\n')

  it('writes INSTALLER_APP_VERSION, not the packaging APP_VERSION, into install-config.json', () => {
    const line = code.split('\n').find((entry) => entry.includes('appVersion'))
    expect(line, 'no appVersion is written at all').toBeDefined()
    expect(line).toContain('${INSTALLER_APP_VERSION}')
    expect(line).not.toContain('${APP_VERSION}')
  })

  it('names both versions in the install log, so a support call can tell them apart', () => {
    expect(code).toContain('Vendor build version: ${INSTALLER_APP_VERSION}')
  })
})
})
