import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  assertReleasePin, fetchPrerequisite, isDigestPinned, prerequisiteRecord, readSignerSubject,
  verifyCachedPrerequisite,
  type FetchedPrerequisite,
} from '../installer/src/prerequisite-release'
import { BUILD_PROFILE_FILENAME, defaultBuildProfile, parseBuildProfile, type BuildProfile } from '../installer/src/build-profile'

/**
 * The release prerequisite step: fetch the VC++ redistributable, verify it, and pin its digest into the build.
 *
 * Modes:
 *
 *   npm run release:prerequisite            fetch, verify, write the pin into build-profile.json (repository root)
 *   npm run release:prerequisite -- --check refuse if the pin is the all-zeros placeholder (run by release:assemble)
 *   npm run release:prerequisite -- --record print the pinned record as JSON (used by the release assembly)
 *
 * The middle mode is the one that matters for the user's requirement #3: a release must not finish while the digest is
 * zeros. `release:assemble` calls it before it writes anything, so a developer who runs the release script from a
 * fresh clone gets a stop rather than a shippable-looking folder containing an installer that refuses its own payload.
 *
 * Nothing here commits the binary. The file lands in `installer/cache/`, which is gitignored, and the digest travels
 * in `build-profile.json`, which is a small text file that belongs in the tree.
 */

// The ROOT profile, not the copy under installer/nsis/. `installer:script` reads the root one and writes the nsis copy
// on every run, so a pin written into the copy is silently overwritten by the next build -- which is exactly what
// happened the first time this was wired up, and what made a pinned build look unpinned.
const PROFILE_PATH = BUILD_PROFILE_FILENAME

function readProfile(): BuildProfile {
  // A fresh clone has no root profile: `installer:script` writes one. Creating the default here rather than failing
  // means the release step works on the machine it is meant for -- a clean checkout on a networked build box -- and
  // the write below produces the first real pin.
  if (!existsSync(PROFILE_PATH)) {
    const created = defaultBuildProfile()
    writeFileSync(PROFILE_PATH, `${JSON.stringify(created, null, 2)}\n`, 'utf8')
    console.log(`No ${PROFILE_PATH} yet; started one from the defaults.`)
    return created
  }
  const text = readFileSync(PROFILE_PATH, 'utf8')
  const profile = parseBuildProfile(text)
  if (!profile) fail(`${PROFILE_PATH} is not a build profile this tool understands. Fix it, or delete it to start fresh.`)
  return profile
}

/**
 * The pin this tool cares about: the one for the allowlisted prerequisite component.
 *
 * Matched by id rather than taken as the first entry. The profile is a document a vendor can edit and the list exists
 * so more than one component can be pinned, so "the first one" is not a safe reading of it.
 */
function vcredistPin(profile: BuildProfile) {
  return profile.prerequisites?.find((entry) => entry.id === 'vcredist-x64')
}

function writeProfile(profile: BuildProfile): void {
  writeFileSync(PROFILE_PATH, `${JSON.stringify(profile, null, 2)}\n`, 'utf8')
}

/** Configuration that must not be silently missing: a deploy that loses this file should say so, not guess. */
function fail(message: string): never {
  console.error(`\nRELEASE STOPPED\n\n${message}\n`)
  process.exit(1)
}

function main(): void {
  const args = process.argv.slice(2)

  if (args.includes('--check')) {
    const profile = readProfile()
    const sha256 = vcredistPin(profile)?.sha256 ?? ''
    if (!isDigestPinned(sha256)) {
      fail(
        'The VC++ prerequisite checksum is still the all-zero placeholder, so this build cannot be released.\n\n' +
          'An installer built from it would refuse the very file the offline installer ships, and the online ' +
          'installer would refuse every download. A development build may keep the zeros; a release may not.\n\n' +
          'Fix: run `npm run release:prerequisite` on a machine with internet access. It downloads the official ' +
          'Microsoft file, checks its signature and publisher, computes the SHA-256 and writes it into ' +
          `${PROFILE_PATH}.`,
      )
    }
    assertReleasePin(sha256)
    const pin = vcredistPin(profile)!
    // A real digest is necessary and not sufficient: the file about to be bundled must BE that file. Without this the
    // check passes on a stale cache and the offline installer ships bytes its own checksum refuses.
    // Every failure of this function is a release-stopping fact, and each one already carries a plain-English message
    // naming the fix. Route it through `fail` so the operator sees the sentence rather than a stack trace -- the first
    // run of this printed `throw new Error` with a Node call frame, which reads like a bug in the tool rather than a
    // statement about the build.
    let verified: ReturnType<typeof verifyCachedPrerequisite>
    try {
      verified = verifyCachedPrerequisite({ pin, readSigner: readSignerSubject })
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
    console.log('Release prerequisite is pinned, and the cached file matches it:')
    console.log(`  SHA-256:  ${pin.sha256}`)
    console.log(`  Version:  ${pin.microsoftVersion}`)
    console.log(`  Size:     ${pin.sizeBytes.toLocaleString('en-GB')} bytes`)
    console.log(`  Fetched:  ${pin.fetchedAt}`)
    console.log(`  From:     ${pin.url}`)
    console.log(`  On disk:  ${verified.path} (digest re-read and matched)`)
    console.log(`  Signed:   ${verified.signerSubject}`)
    return
  }

  if (args.includes('--record')) {
    const profile = readProfile()
    const pin = vcredistPin(profile)
    if (!pin || !isDigestPinned(pin.sha256)) {
      fail('There is no pinned prerequisite to record. Run `npm run release:prerequisite` first.')
    }
    const record = prerequisiteRecord(
      {
        path: join('installer', 'cache', 'vc_redist.x64.exe'),
        sha256: pin.sha256,
        sizeBytes: pin.sizeBytes,
        signerSubject: 'Microsoft Corporation (verified at fetch time)',
        url: pin.url,
        microsoftVersion: pin.microsoftVersion,
      } satisfies FetchedPrerequisite,
      join('installer', 'cache', 'vc_redist.x64.exe'),
    )
    console.log(JSON.stringify(record, null, 2))
    return
  }

  // ---- fetch, verify, pin
  let fetched: FetchedPrerequisite
  try {
    fetched = fetchPrerequisite()
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }

  const profile = readProfile()
  // Replace this component's entry, keeping any other component's pin intact. Assigning the whole list would make
  // pinning the runtime silently discard every other verified component.
  profile.prerequisites = [
    ...(profile.prerequisites ?? []).filter((entry) => entry.id !== fetched.componentId),
    {
      // The component's own id, from the allowlist entry the fetch used, not a literal.
      id: fetched.componentId,
      sha256: fetched.sha256,
      sizeBytes: fetched.sizeBytes,
      microsoftVersion: fetched.microsoftVersion,
      url: fetched.url,
      fetchedAt: new Date().toISOString(),
    },
  ]
  writeProfile(profile)

  if (!existsSync(fetched.path)) {
    fail(`The verified file is not where it was written (${fetched.path}). The release stops here.`)
  }

  console.log('\nThe VC++ redistributable is fetched, verified and pinned.')
  console.log(`  File:      ${fetched.path}  (not committed; see .gitignore)`)
  console.log(`  SHA-256:   ${fetched.sha256}`)
  console.log(`  Version:   ${fetched.microsoftVersion}`)
  console.log(`  Size:      ${fetched.sizeBytes.toLocaleString('en-GB')} bytes`)
  console.log(`  Signed by: ${fetched.signerSubject}`)
  console.log(`  From:      ${fetched.url}`)
  console.log(`\n  Pinned into ${PROFILE_PATH}.`)
  // This used to say "the offline build reads the file from INFOFLEX_PREREQUISITE_VCREDIST or installer/cache/". Nothing
  // read that variable, so the message offered an override that did not exist -- and an operator who moved the file and
  // set it would have got a build that silently bundled nothing. The path is now stated as what it is, and the
  // generated include is named so a reader can see where it lands.
  console.log(`  The offline build bundles it from ${join('installer', 'cache', 'vc_redist.x64.exe')}, via the generated`)
  console.log('  installer/nsis/prerequisite.nsh. There is no override: one path, so a build always carries the file the')
  console.log('  pin was verified against.')
  console.log(`\n  Compare on a real PC: right-click the file -> Properties -> Details -> "File version" should read ${fetched.microsoftVersion}.`)
}

main()
