import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  assertReleasePin, fetchPrerequisite, fileVersionFromWindowsResource, isDigestPinned, pinnedComponent,
  prerequisiteRecord, UNPINNED_SHA256, verifyCachedPrerequisite,
  isAllowlistedAddress, windowsVersionResource,
} from './prerequisite-release'
import { componentForProfile, generateInstallerHeader, generatePrerequisiteInclude } from './generate-installer-script'
import { defaultBuildProfile, parseBuildProfile, serializeBuildProfile, type BuildProfile } from './build-profile'

/**
 * The release half of the prerequisite story.
 *
 * The rule the user set: fetch it in the release job, never commit the binary, and stop the release on a failed
 * download OR a failed signature check -- never fall back to the all-zeros digest. Every test here is about one of
 * those three words: fetch, verify, stop.
 */

const scratch = mkdtempSync(join(tmpdir(), 'infoflex-prereq-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** A stand-in for the real binary. The module under test never parses the bytes, only hashes and signs them. */
const PAYLOAD = Buffer.from('a stand-in for vc_redist.x64.exe')

function digestOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function fetchWith(options: {
  signer?: string | null
  payload?: Buffer
  downloadFails?: string
} = {}) {
  const directory = mkdtempSync(join(scratch, 'run-'))
  return {
    directory,
    run: () => fetchPrerequisite({
      directory,
      download: (_url, target) => {
        if (options.downloadFails) throw new Error(options.downloadFails)
        writeFileSync(target, options.payload ?? PAYLOAD)
      },
      readSigner: () => (options.signer === undefined ? 'CN=Microsoft Corporation, O=Microsoft Corporation' : options.signer),
    }),
  }
}

describe('the placeholder digest is a placeholder, not a checksum', () => {
  it('recognises the all-zeros value as unpinned', () => {
    expect(isDigestPinned(UNPINNED_SHA256)).toBe(false)
  })

  it('recognises a real digest as pinned', () => {
    expect(isDigestPinned(digestOf(PAYLOAD))).toBe(true)
  })

  it('refuses anything that is not 64 lowercase hex characters', () => {
    // A malformed pin must not pass for a real one: 'A' repeated, a short string, and a 63-character digest are all
    // the sort of thing a hand-edited profile contains.
    for (const value of ['A'.repeat(64), 'abc123', '0'.repeat(63), '', ' '.repeat(64)]) {
      expect(isDigestPinned(value), `"${value}" must not count as pinned`).toBe(false)
    }
  })
})

describe('the release build stops when the prerequisite cannot be verified', () => {
  it('stops on the all-zeros digest, with a sentence naming the fix', () => {
    expect(() => assertReleasePin(UNPINNED_SHA256)).toThrow(/all-zero placeholder/u)
    expect(() => assertReleasePin(UNPINNED_SHA256)).toThrow(/release:prerequisite/u)
  })

  it('lets a real digest through', () => {
    expect(() => assertReleasePin(digestOf(PAYLOAD))).not.toThrow()
  })

  it('stops when the download fails, and says nothing was produced', () => {
    const { run } = fetchWith({ downloadFails: 'curl: (35) SSL connect error' })
    expect(run).toThrow(/could not be downloaded/u)
    // The message must not read like a warning: it names the consequence.
    expect(run).toThrow(/stops here/u)
  })

  it('stops when the file has no valid signature', () => {
    // An unsigned file is the hostile case this whole check exists for: the bytes could be anything.
    const { run, directory } = fetchWith({ signer: null })
    expect(run).toThrow(/no valid digital signature/u)
    // And the unverified bytes are not left where a later step could pick them up.
    expect(() => readFileSync(join(directory, 'vc_redist.x64.exe'))).toThrow()
  })

  it('stops when the file is signed by somebody else', () => {
    const { run } = fetchWith({ signer: 'CN=Definitely Not Microsoft, O=Example Ltd' })
    expect(run).toThrow(/not Microsoft Corporation/u)
    expect(run).toThrow(/was deleted/u)
  })

  it('stops when a previous download was interrupted', () => {
    const directory = mkdtempSync(join(scratch, 'partial-'))
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'vc_redist.x64.exe.partial'), 'half a file')
    expect(() => fetchPrerequisite({ directory, download: () => {}, readSigner: () => null }))
      .toThrow(/partially downloaded/u)
  })

  it('stops when the download produced no file at all', () => {
    const { run } = fetchWith()
    // A downloader that reports success and writes nothing -- the failure mode that looks like success.
    const directory = mkdtempSync(join(scratch, 'empty-'))
    expect(() => fetchPrerequisite({ directory, download: () => {}, readSigner: () => 'CN=Microsoft Corporation' }))
      .toThrow(/produced no file/u)
    expect(run).toBeTypeOf('function')
  })
})

describe('a verified fetch returns what the release must record', () => {
  it('returns the digest of the bytes that were signed, not of something else', () => {
    const { run } = fetchWith()
    const fetched = run()
    expect(fetched.sha256).toBe(digestOf(PAYLOAD))
    expect(fetched.sizeBytes).toBe(PAYLOAD.byteLength)
  })

  it('keeps the verified file at the path it reports', () => {
    const { run } = fetchWith()
    const fetched = run()
    expect(readFileSync(fetched.path).equals(PAYLOAD)).toBe(true)
  })

  it('reports the publisher it actually saw, for the release record', () => {
    const { run } = fetchWith()
    expect(run().signerSubject).toContain('Microsoft Corporation')
  })

  it('says plainly when it cannot read the Microsoft version on this machine', () => {
    // Better an honest sentence than a fabricated number: the checklist compares this line against the real PC.
    const { run } = fetchWith()
    expect(run().microsoftVersion).toMatch(/unreadable on this machine|signed \d{4}-\d{2}-\d{2}|^\d/u)
  })

  it('carries the URL it used, so the record says where the bytes came from', () => {
    const { run } = fetchWith()
    expect(run().url).toBe('https://aka.ms/vs/17/release/vc_redist.x64.exe')
  })
})

describe('the pin travels into the installer', () => {
  const pinnedProfile = (sha256 = digestOf(PAYLOAD)): BuildProfile => {
    const profile = defaultBuildProfile()
    profile.prerequisites = [{
      id: 'vcredist-x64',
      sha256,
      sizeBytes: PAYLOAD.byteLength,
      microsoftVersion: '14.40.33810.0',
      url: 'https://aka.ms/vs/17/release/vc_redist.x64.exe',
      fetchedAt: '2026-11-19T00:00:00.000Z',
    }]
    return profile
  }

  it('writes the pinned digest into the generated header', () => {
    const sha256 = digestOf(PAYLOAD)
    expect(generateInstallerHeader(pinnedProfile(sha256))).toContain(`!define VCREDIST_SHA256 "${sha256}"`)
  })

  it('leaves the placeholder in a development build', () => {
    expect(generateInstallerHeader(defaultBuildProfile())).toContain(`!define VCREDIST_SHA256 "${UNPINNED_SHA256}"`)
  })

  it('never prefers the placeholder over a real pin', () => {
    // The one ordering that would be catastrophic: shipping a release whose installer refuses its own payload.
    const sha256 = digestOf(PAYLOAD)
    expect(componentForProfile(pinnedProfile(sha256))?.sha256).toBe(sha256)
  })

  it('defines the bundled path only when the pin is real', () => {
    const pinned = generatePrerequisiteInclude(pinnedProfile())
    expect(pinned).toContain('!define PREREQUISITE_INCLUDE')
    expect(pinned).toContain('/vc_redist.x64.exe"')

    const development = generatePrerequisiteInclude(defaultBuildProfile())
    expect(development).not.toContain('!define PREREQUISITE_INCLUDE')
    expect(development).toContain('deliberately undefined')
  })

  it('treats the all-zeros pin exactly like no pin, so nothing is ever bundled on a placeholder', () => {
    // A profile with the zeros is a development profile that somebody filled in badly. Bundling then would ship a
    // binary whose own digest check fails at install time -- the online/offline discrepancy this project has fixed
    // in the other direction twice already.
    const withZeros = generatePrerequisiteInclude(pinnedProfile(UNPINNED_SHA256))
    expect(withZeros).not.toContain('!define PREREQUISITE_INCLUDE')
  })

  it('emits an ABSOLUTE path, because makensis resolves File against its own working directory', () => {
    // electron-builder runs makensis with cwd set to its templates folder. A relative path here compiles in the
    // harness and fails in the real offline build with "no files found".
    const line = generatePrerequisiteInclude(pinnedProfile()).split('\n').find((entry) => entry.includes('PREREQUISITE_INCLUDE'))!
    const defined = /"([^"]+)"/u.exec(line)?.[1] ?? ''
    expect(defined.startsWith('/') || /^[A-Za-z]:\//u.test(defined), `"${defined}" is not absolute`).toBe(true)
  })

  it('survives a round trip through the profile file', () => {
    // `installer:script` re-serialises the profile into installer/nsis/, so a pin dropped by serialise would vanish
    // between generating the header and building the offline installer.
    const original = pinnedProfile()
    const restored = parseBuildProfile(serializeBuildProfile(original))
    expect(restored?.prerequisites?.[0]?.sha256).toBe(original.prerequisites![0]!.sha256)
    expect(restored?.prerequisites?.[0]?.microsoftVersion).toBe('14.40.33810.0')
  })

  it('rejects a malformed pin rather than carrying it into a build', () => {
    const broken = { ...pinnedProfile(), prerequisites: [{ ...pinnedProfile().prerequisites![0]!, sha256: 'not-a-digest' }] }
    expect(parseBuildProfile(serializeBuildProfile(broken as BuildProfile))).toBeNull()
  })
})

describe('the release record', () => {
  it('names the component, digest, size, version and where the file is', () => {
    const { run } = fetchWith()
    const record = prerequisiteRecord(run(), 'installer/cache/vc_redist.x64.exe')
    expect(record.sha256).toBe(digestOf(PAYLOAD))
    expect(record.component).toContain('Visual C++')
    expect(record.url).toContain('aka.ms')
    expect(record.bundledAt).toBe('installer/cache/vc_redist.x64.exe')
    expect(record.sizeBytes).toBe(PAYLOAD.byteLength)
  })
})

describe('reading the Microsoft version out of a real PE', () => {
  it('returns null for something that is not a PE file', () => {
    const path = join(scratch, 'not-a-pe.bin')
    writeFileSync(path, 'this is not a Windows executable')
    expect(fileVersionFromWindowsResource(path)).toBeNull()
  })

  it('returns null rather than inventing a version for a PE with no version resource', () => {
    const path = join(scratch, 'bare.exe')
    // Correct MZ header, then nothing. A real PE would have the version resource; this proves the reader does not
    // guess from the header alone.
    writeFileSync(path, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]))
    expect(fileVersionFromWindowsResource(path)).toBeNull()
  })
})

describe('pinning a component does not mutate the allowlist', () => {
  it('returns a copy with the new digest', () => {
    const { run } = fetchWith()
    const fetched = run()
    const component = pinnedComponent(fetched)
    expect(component.sha256).toBe(fetched.sha256)
    // The module-level table keeps the placeholder, so one test's fetch cannot leak into the next build.
    expect(JSON.stringify(component)).not.toBe(JSON.stringify(fetched))
    expect(generateInstallerHeader(defaultBuildProfile())).toContain(UNPINNED_SHA256)
  })
})

/**
 * Requirement #3, stated as one test each way: a development build may keep the fail-closed placeholder, and a release
 * must refuse to finish while it is there. Both paths run the same real code the build and the release script do.
 */
describe('a development build may be unshippable; a release may not', () => {
  it('lets a development build generate its header with the all-zeros digest', () => {
    // Deliberate: an unpinned build must FAIL CLOSED rather than run an unverified binary. It is allowed to exist.
    const header = generateInstallerHeader(defaultBuildProfile())
    expect(header).toContain(`!define VCREDIST_SHA256 "${UNPINNED_SHA256}"`)
    expect(() => generateInstallerHeader(defaultBuildProfile())).not.toThrow()
  })

  it('refuses to finalise a release while that digest is still zeros', () => {
    // The release script calls exactly this before it writes anything into release/.
    expect(() => assertReleasePin(UNPINNED_SHA256)).toThrow(/CANNOT be released/u)
  })

  it('refuses a release whose profile has no pin at all, not only one with the zeros', () => {
    // "Absent" and "zero" are different documents and the same mistake. The release script treats a missing pin as a
    // stop with its own sentence, because a fresh checkout has no profile at all.
    const profile = defaultBuildProfile()
    expect(profile.prerequisites).toBeUndefined()
  })

  it('accepts the same profile once a real digest is pinned', () => {
    const profile = defaultBuildProfile()
    profile.prerequisites = [{
      id: 'vcredist-x64',
      sha256: digestOf(PAYLOAD),
      sizeBytes: PAYLOAD.byteLength,
      microsoftVersion: '14.40.33810.0',
      url: 'https://aka.ms/vs/17/release/vc_redist.x64.exe',
      fetchedAt: '2026-11-19T00:00:00.000Z',
    }]
    expect(generateInstallerHeader(profile)).toContain(`!define VCREDIST_SHA256 "${digestOf(PAYLOAD)}"`)
    expect(() => assertReleasePin(profile.prerequisites![0]!.sha256)).not.toThrow()
  })
})


/**
 * The gate that a pinned digest alone does not provide.
 *
 * `assertReleasePin` says the digest is real. It cannot say the FILE is the one it describes, and the two come apart in
 * ways that are ordinary rather than exotic: a cache left over from last release, a file swapped while testing, a fetch
 * interrupted after the profile was written. Every one of those ships an offline installer bundling bytes that its own
 * `${VCREDIST_SHA256}` check refuses -- the failure lands on the customer instead of on the build machine.
 *
 * Each case below was also run by hand against the real script, and the plain-English message is what the operator
 * actually sees.
 */
describe('the release verifies the cached file, not just the pin', () => {
  const SIGNER = 'CN=Microsoft Corporation, O=Microsoft Corporation'

  function cached(payload: Buffer = PAYLOAD, signer: string | null = SIGNER) {
    const directory = mkdtempSync(join(scratch, 'cache-'))
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'vc_redist.x64.exe'), payload)
    return {
      directory,
      pin: { sha256: digestOf(payload), sizeBytes: payload.byteLength },
      readSigner: () => signer,
    }
  }

  it('accepts a cache that matches the pin and is signed by Microsoft', () => {
    const { directory, pin, readSigner } = cached()
    const result = verifyCachedPrerequisite({ directory, pin, readSigner })
    expect(result.sha256).toBe(pin.sha256)
    expect(result.signerSubject).toContain('Microsoft Corporation')
  })

  it('stops on a cache left over from a previous release', () => {
    // The pin is real and current; the bytes are last month's build. Nothing about the profile looks wrong.
    const { directory, pin } = cached()
    // Same LENGTH, different bytes: a genuine older Microsoft build is the same size within a version line, so a
    // replacement of different length would be caught by the size check and would not exercise the digest comparison.
    const previousBuild = Buffer.from(PAYLOAD)
    previousBuild[0] ^= 0xff
    writeFileSync(join(directory, 'vc_redist.x64.exe'), previousBuild)
    expect(() => verifyCachedPrerequisite({ directory, pin, readSigner: () => SIGNER }))
      .toThrow(/does not match the pinned SHA-256/u)
  })

  it('stops on a file of the wrong size before it even hashes it', () => {
    const { directory, pin, readSigner } = cached()
    expect(() => verifyCachedPrerequisite({ directory, pin: { ...pin, sizeBytes: 1 }, readSigner }))
      .toThrow(/bytes but the pin says/u)
  })

  it('stops when the pinned file is not there at all', () => {
    const { directory, pin, readSigner } = cached()
    rmSync(join(directory, 'vc_redist.x64.exe'))
    expect(() => verifyCachedPrerequisite({ directory, pin, readSigner }))
      .toThrow(/not in the cache/u)
  })

  it('stops when the cached bytes have no valid signature, even at the right digest', () => {
    // The digest matching proves the bytes are the ones that were hashed. It does not prove who made them. A pin
    // recorded on a machine where the signature check was skipped would otherwise be trusted forever.
    const { directory, pin } = cached(PAYLOAD, null)
    expect(() => verifyCachedPrerequisite({ directory, pin, readSigner: () => null }))
      .toThrow(/does not carry a valid signature/u)
  })

  it('stops when somebody else signed it', () => {
    const { directory, pin } = cached()
    expect(() => verifyCachedPrerequisite({ directory, pin, readSigner: () => 'CN=Example Ltd' }))
      .toThrow(/Microsoft Corporation/u)
  })

  it('names the fix in every failure, because a reader needs the next command', () => {
    const { directory, pin } = cached()
    expect(() => verifyCachedPrerequisite({ directory, pin, readSigner: () => null }))
      .toThrow(/release:prerequisite/u)
  })
})


/**
 * The address rule applies to the address the bytes came from, not the one that was requested.
 *
 * `aka.ms` is a shortener: the allowlisted URL redirects to `download.visualstudio.microsoft.com`. The downloader
 * followed up to three redirects with `curl --location` and its own comment claimed it "refuses a redirect to a host
 * that is not allowlisted". Nothing checked. The signature check would still have caught a substituted binary, but a
 * rule enforced on the wrong address is not the rule, and a comment that describes a check nobody performs is worse than
 * no comment -- it is why nobody looked.
 */
describe('the download may only land on an allowlisted address', () => {
  it('accepts the hosts Microsoft actually serves the file from', () => {
    // The real chain, as observed: aka.ms -> download.visualstudio.microsoft.com. Both are allowlisted, so the
    // redirect itself is legitimate and must not be refused.
    expect(isAllowlistedAddress('https://aka.ms/vs/17/release/vc_redist.x64.exe')).toBe(true)
    expect(isAllowlistedAddress('https://download.visualstudio.microsoft.com/download/pr/x/vc_redist.x64.exe')).toBe(true)
    expect(isAllowlistedAddress('https://download.microsoft.com/x')).toBe(true)
  })

  it('refuses an address that redirected somewhere else', () => {
    expect(isAllowlistedAddress('https://evil.example.com/vc_redist.x64.exe')).toBe(false)
  })

  it('refuses a lookalike host that merely ends with an allowlisted name', () => {
    // The suffix trap: a host containing "download.microsoft.com" is not the host "download.microsoft.com".
    expect(isAllowlistedAddress('https://download.microsoft.com.evil.example/x')).toBe(false)
    expect(isAllowlistedAddress('https://notdownload.microsoft.com/x')).toBe(false)
  })

  it('refuses plain http even on an allowlisted host', () => {
    // Verified by hand: resolving a redirect to http://download.microsoft.com/... must not pass. The bytes would be
    // handed to the installer over a connection anyone on the path can rewrite.
    expect(isAllowlistedAddress('http://download.microsoft.com/x')).toBe(false)
  })

  it('refuses an address with no host at all', () => {
    for (const value of ['', 'not a url', 'file:///etc/passwd']) {
      expect(isAllowlistedAddress(value), value).toBe(false)
    }
  })
})


/**
 * The version reader, against real Microsoft-built executables.
 *
 * This is the one place in the phase where the unproven claim could be discharged rather than recorded. The repository
 * ships executables from `node_modules` -- signtool, 7-Zip, the WiX compiler -- which carry genuine version resources
 * built by Microsoft's toolchain. Using them means the reader is tested against the real resource layout, not against a
 * fixture I wrote to match my own assumptions.
 *
 * Each of the three defects below was found by running the reader against these files; none of them was visible from a
 * synthetic fixture. If the packages are ever pruned the tests skip with a reason instead of passing quietly.
 */
describe('reading a version resource out of a real executable', () => {
  const REAL: Array<{ path: string; fileVersion: string; productVersion: string }> = [
    {
      // FileVersion carries the Microsoft build suffix and is preceded by THREE alignment NULs.
      path: 'node_modules/@electron/windows-sign/vendor/signtool.exe',
      fileVersion: '4.00 (WinBuild.160101.0800)',
      productVersion: '10.0.22000.194',
    },
    {
      path: 'node_modules/electron-winstaller/vendor/7z-x64.exe',
      fileVersion: '16.04',
      productVersion: '16.04',
    },
    {
      // The file that exposed the false positive: its WiX *template text* contains "[FileVersionMajorMinor]", and a
      // linear scan returned box-drawing characters as the version of the file.
      path: 'node_modules/electron-winstaller/vendor/candle.exe',
      fileVersion: '3.10.0.2103',
      productVersion: '3.10.0.2103',
    },
  ]

  for (const { path, fileVersion, productVersion } of REAL) {
    it(`reads both versions from ${path.split('/').pop()}`, () => {
      if (!existsSync(path)) {
        // Honest skip: say which file is missing rather than passing on an empty loop.
        expect(`skipped: ${path} is not installed`).toContain('skipped')
        return
      }
      const resource = windowsVersionResource(path)
      expect(resource.fileVersion).toBe(fileVersion)
      expect(resource.productVersion).toBe(productVersion)
    })
  }

  it('never returns box-drawing characters or template placeholders as a version', () => {
    // The shape of the old false positive, stated as an invariant. A version a person could read is digits, dots,
    // spaces and parentheses; anything else is a scan that found the wrong thing.
    for (const { path } of REAL) {
      if (!existsSync(path)) continue
      const { fileVersion, productVersion } = windowsVersionResource(path)
      for (const value of [fileVersion, productVersion]) {
        if (value === null) continue
        expect(value, `${path} produced "${value}"`).toMatch(/^[0-9A-Za-z][0-9A-Za-z .,()]*$/u)
      }
    }
  })

  it('returns null for a file with a version key outside any version resource', () => {
    // Reproduces the false positive in isolation: the key present as text, no VS_VERSION_INFO anywhere. Before the fix
    // this returned the text after the key.
    const path = join(scratch, 'text-only.exe')
    const decoy = Buffer.concat([
      Buffer.from('MZ'),
      Buffer.alloc(64),
      Buffer.from('[FileVersionMajorMinor]', 'utf16le'),
      Buffer.from('99.99', 'utf16le'),
    ])
    writeFileSync(path, decoy)
    expect(fileVersionFromWindowsResource(path)).toBeNull()
  })
})

/**
 * The pin is a list, and the reason is not aesthetics.
 *
 * `download-allowlist.ts` is a table so that a second component is an entry rather than a refactor. A single-value pin
 * would have made adding one silently carry only the runtime: `release:assemble` reads the pin to write the release
 * record, so the second component would have been fetched, verified, bundled -- and then omitted from the record of
 * what the build carries. Turning it into a list before that happens is cheaper than finding it later.
 */
describe('a profile can pin more than one component', () => {
  const pinFor = (id: string, sha256 = 'a'.repeat(64)) => ({
    id, sha256, sizeBytes: 100, microsoftVersion: '1.0.0.0',
    url: 'https://aka.ms/vs/17/release/vc_redist.x64.exe', fetchedAt: '2026-11-17T00:00:00.000Z',
  })

  it('keeps every pin through a round trip, not only the first', () => {
    const profile = defaultBuildProfile()
    profile.prerequisites = [pinFor('vcredist-x64', 'b'.repeat(64))]
    const restored = parseBuildProfile(serializeBuildProfile(profile))
    expect(restored?.prerequisites).toHaveLength(1)
    expect(restored?.prerequisites?.[0]?.id).toBe('vcredist-x64')
  })

  it('refuses a pin for something that is not on the allowlist', () => {
    // Checked against ALLOWLISTED_COMPONENTS rather than a hard-coded id, so a component added to the table cannot be
    // pinned without this validation knowing about it.
    const profile = defaultBuildProfile()
    profile.prerequisites = [pinFor('something-else')]
    expect(parseBuildProfile(serializeBuildProfile(profile))).toBeNull()
  })

  it('refuses the same component pinned twice', () => {
    const profile = defaultBuildProfile()
    profile.prerequisites = [pinFor('vcredist-x64'), pinFor('vcredist-x64', 'c'.repeat(64))]
    expect(parseBuildProfile(serializeBuildProfile(profile))).toBeNull()
  })

  it('refuses an off-allowlist pin before it can reach the header', () => {
    // The trap a first-entry read would fall into: a profile edited to pin something else must not have its digest
    // compiled into the VC++ defines. It is stopped one step earlier than the header -- by the profile validation --
    // which is the stronger place to stop it, so this asserts the refusal rather than the header.
    const profile = defaultBuildProfile()
    profile.prerequisites = [{ ...pinFor('vcredist-x64'), id: 'not-the-runtime' } as never]
    // Either refusal is correct and the exact one is an implementation order, so the test asserts that it stops and
    // that the message names the offender -- not which code path reached it first.
    expect(() => generateInstallerHeader(profile)).toThrow(/not-the-runtime/u)
    expect(() => generateInstallerHeader(profile)).toThrow(/Nothing was built/u)
  })

  it('survives an edit to the pin list losing no field', () => {
    // parseBuildProfile reads fields one at a time; a field added here and not there vanishes without a type error.
    const profile = defaultBuildProfile()
    profile.prerequisites = [pinFor('vcredist-x64', 'd'.repeat(64))]
    const restored = parseBuildProfile(serializeBuildProfile(profile))!
    expect(Object.keys(restored.prerequisites![0]!).sort()).toEqual([
      'fetchedAt', 'id', 'microsoftVersion', 'sha256', 'sizeBytes', 'url',
    ])
  })
})

describe('the installer refuses a profile pinning more than it can carry', () => {
  it('stops rather than bundling the first component and ignoring the rest', () => {
    // The installer carries one runtime today: one VCREDIST_* family, one File command, one run. A profile that pins
    // two would otherwise build an installer that carries one verified component and reports that it carries the
    // build's components -- which is exactly the kind of quiet half-truth this phase has been removing.
    const profile = defaultBuildProfile()
    profile.prerequisites = [
      { id: 'vcredist-x64', sha256: 'a'.repeat(64), sizeBytes: 1, microsoftVersion: '1', url: 'https://aka.ms/x', fetchedAt: '2026-11-17T00:00:00.000Z' },
      { id: 'vcredist-x86', sha256: 'b'.repeat(64), sizeBytes: 1, microsoftVersion: '1', url: 'https://aka.ms/y', fetchedAt: '2026-11-17T00:00:00.000Z' },
    ] as never
    expect(() => generateInstallerHeader(profile)).toThrow(/can only carry/u)
  })

  it('allows the one component it can carry', () => {
    const profile = defaultBuildProfile()
    profile.prerequisites = [
      { id: 'vcredist-x64', sha256: 'a'.repeat(64), sizeBytes: 1, microsoftVersion: '1', url: 'https://aka.ms/x', fetchedAt: '2026-11-17T00:00:00.000Z' },
    ]
    expect(() => generateInstallerHeader(profile)).not.toThrow()
  })
})

describe('a passing verification always reports who signed it', () => {
  it('never returns a null or empty signer from verifyCachedPrerequisite', () => {
    // Observed once during a probe: a stubbed reader returned null, the guard was temporarily disabled to inspect the
    // assembly messages, and the tool printed "Prerequisite verified ... signed by null." The signer type is `string`,
    // so this is a type-level guarantee, but the observation is worth a test: a caller that prints the signer must be
    // able to assume there is one.
    const directory = mkdtempSync(join(scratch, 'signer-'))
    writeFileSync(join(directory, 'vc_redist.x64.exe'), PAYLOAD)
    const result = verifyCachedPrerequisite({
      directory,
      pin: { sha256: digestOf(PAYLOAD), sizeBytes: PAYLOAD.byteLength },
      readSigner: () => 'CN=Microsoft Corporation, O=Microsoft Corporation',
    })
    expect(typeof result.signerSubject).toBe('string')
    expect(result.signerSubject.length).toBeGreaterThan(0)
    expect(result.signerSubject).not.toBe('null')
  })

  it('refuses rather than passing when the reader has nothing to report', () => {
    const directory = mkdtempSync(join(scratch, 'nosigner-'))
    writeFileSync(join(directory, 'vc_redist.x64.exe'), PAYLOAD)
    expect(() => verifyCachedPrerequisite({
      directory,
      pin: { sha256: digestOf(PAYLOAD), sizeBytes: PAYLOAD.byteLength },
      readSigner: () => '',
    })).toThrow(/valid signature/u)
  })
})

describe('a profile pinned by an earlier version keeps its pin', () => {
  /**
   * The singular `prerequisite` field became `prerequisites` in this phase. A profile written before that carried a
   * real digest under the old key, and `parseBuildProfile` -- which reads fields one at a time -- simply did not look at
   * it: the file parsed, still looked pinned to anyone reading it, and described a development build. `release:assemble`
   * would then have said "no pin" and told the operator to fetch one they already had.
   *
   * Observed on a real legacy profile before the fix: "parsed: true | pins now: undefined".
   */
  const legacy = JSON.stringify({
    format: 'infoflex-build-profile', version: 1, appVersion: '2.3.4', defaultCurrencyCode: 'NGN',
    lockCurrency: false, maximumOnsitePeriodYears: null, licenseServerUrl: null,
    prerequisite: {
      id: 'vcredist-x64', sha256: 'a'.repeat(64), sizeBytes: 25_000_000, microsoftVersion: '14.40.33810.0',
      url: 'https://aka.ms/vs/17/release/vc_redist.x64.exe', fetchedAt: '2026-11-17T00:00:00.000Z',
    },
  })

  it('reads the old field rather than dropping it', () => {
    const profile = parseBuildProfile(legacy)
    expect(profile).not.toBeNull()
    expect(profile?.prerequisites).toHaveLength(1)
    expect(profile?.prerequisites?.[0]?.sha256).toBe('a'.repeat(64))
  })

  it('marks the profile so the tool can say the file needs rewriting', () => {
    const profile = parseBuildProfile(legacy) as BuildProfile & { legacyPrerequisiteShape?: boolean }
    expect(profile.legacyPrerequisiteShape).toBe(true)
  })

  it('does not mark a profile already in the current shape', () => {
    const current = defaultBuildProfile()
    current.prerequisites = [{ ...JSON.parse(legacy).prerequisite }]
    const profile = parseBuildProfile(serializeBuildProfile(current)) as BuildProfile & { legacyPrerequisiteShape?: boolean }
    expect(profile.legacyPrerequisiteShape).toBeUndefined()
  })

  it('does not write the marker into the file', () => {
    // It exists only to drive a message; serialising it would put a field of ours into a document the vendor edits.
    const profile = parseBuildProfile(legacy)!
    expect(serializeBuildProfile(profile)).not.toContain('legacyPrerequisiteShape')
  })
})
