import { readFileSync, writeFileSync } from 'node:fs'
import { writeGeneratedIncludes } from '../installer/src/write-installer-script'
import {
  BUILD_PROFILE_FILENAME, defaultBuildProfile, parseBuildProfile, serializeBuildProfile, type BuildProfile,
} from '../installer/src/build-profile'

/**
 * Writes the generated NSIS includes.
 *
 * The build profile — the currency this build preselects, whether it is locked, the on-site term cap — is read from
 * `build-profile.json` in the project root if it is there. Build Studio writes that file, and ALSO passes the values
 * in `INFOFLEX_BUILD_PROFILE_FILE` so a build of somebody else's checkout cannot pick up a stale profile by accident.
 *
 * Falling back to the default profile keeps `npm run installer:script` working on a fresh checkout, which is what
 * every other npm script and the test suite expect.
 */

/** Where the profile is read from: the explicit environment override, else the project root. */
export function profilePath(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.INFOFLEX_BUILD_PROFILE_FILE ?? BUILD_PROFILE_FILENAME
}

function readProfile(path: string): BuildProfile {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    // No profile is not an error: it is a plain development build.
    return defaultBuildProfile()
  }
  const profile = parseBuildProfile(text)
  if (!profile) {
    // A malformed profile is an error. Silently building the wrong currency is the failure mode to avoid.
    throw new Error(`${path} is not a valid build profile. Fix it, or delete it to build the defaults.`)
  }
  return profile
}

const profile = readProfile(profilePath())
const directory = process.argv[2] ?? 'installer/nsis'
for (const written of writeGeneratedIncludes(directory, profile)) {
  console.log(`Wrote ${written.path} (${written.bytes} bytes).`)
}

// A copy beside the generated includes, which electron-builder packs into `resources/` so the app reads the same
// profile the installer was given. Written on every run, so a build never inherits a stale one.
writeFileSync(`${directory}/build-profile.json`, serializeBuildProfile(profile), 'utf8')
console.log(`Build profile: ${profile.appVersion}, ${profile.defaultCurrencyCode}${profile.lockCurrency ? ' (locked)' : ''}, on-site limit ${profile.maximumOnsitePeriodYears ?? 'none'}.`)
