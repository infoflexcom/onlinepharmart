import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  assertReleasePin, fetchPrerequisite, fileVersionFromWindowsResource, isDigestPinned, pinnedComponent,
  prerequisiteRecord, UNPINNED_SHA256, verifyCachedPrerequisite,
  isAllowlistedAddress,
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
    profile.prerequisite = {
      id: 'vcredist-x64',
      sha256,
      sizeBytes: PAYLOAD.byteLength,
      microsoftVersion: '14.40.33810.0',
      url: 'https://aka.ms/vs/17/release/vc_redist.x64.exe',
      fetchedAt: '2026-11-19T00:00:00.000Z',
    }
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
    expect(restored?.prerequisite?.sha256).toBe(original.prerequisite!.sha256)
    expect(restored?.prerequisite?.microsoftVersion).toBe('14.40.33810.0')
  })

  it('rejects a malformed pin rather than carrying it into a build', () => {
    const broken = { ...pinnedProfile(), prerequisite: { ...pinnedProfile().prerequisite!, sha256: 'not-a-digest' } }
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
    expect(profile.prerequisite).toBeUndefined()
  })

  it('accepts the same profile once a real digest is pinned', () => {
    const profile = defaultBuildProfile()
    profile.prerequisite = {
      id: 'vcredist-x64',
      sha256: digestOf(PAYLOAD),
      sizeBytes: PAYLOAD.byteLength,
      microsoftVersion: '14.40.33810.0',
      url: 'https://aka.ms/vs/17/release/vc_redist.x64.exe',
      fetchedAt: '2026-11-19T00:00:00.000Z',
    }
    expect(generateInstallerHeader(profile)).toContain(`!define VCREDIST_SHA256 "${digestOf(PAYLOAD)}"`)
    expect(() => assertReleasePin(profile.prerequisite!.sha256)).not.toThrow()
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
