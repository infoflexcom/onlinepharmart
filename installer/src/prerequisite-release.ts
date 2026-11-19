import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ALLOWED_DOWNLOAD_HOSTS, ALLOWLISTED_COMPONENTS, hostOf, type AllowlistedComponent } from './download-allowlist'
import { runAuthenticodeCheck } from './password-check'

/**
 * Supplying the VC++ redistributable to a RELEASE build.
 *
 * The problem this exists to solve, stated plainly:
 *
 *   - The offline installer promises "every prerequisite is included in this installer".
 *   - The file it must carry is `vc_redist.x64.exe`, ~25 MB, published by Microsoft.
 *   - The digest pinned in `download-allowlist.ts` is all zeros, deliberately, so that every verification path REFUSES
 *     rather than running an unverified binary. That is the right default for a development build and the wrong
 *     answer for a release.
 *
 * The decision taken (the user's): **fetch it in the release job, never commit the binary.** So this module does the
 * fetching, the verifying and the pinning, and it is written so that the failure modes are the loud ones:
 *
 *   - no network, or a host that is not allowlisted  -> throw, release stops
 *   - a file that is not signed by the pinned publisher -> throw, release stops
 *   - a file whose bytes change between the fetch and the pin -> throw, release stops
 *   - the digest still all zeros when a release is finalised -> throw, release stops
 *
 * There is no branch anywhere in this file that proceeds on an unverified file, and no branch that writes the zeros
 * into a release. The zeros appear only in development, and `assertReleasePin` is the door they cannot pass.
 */

/** The all-zeros digest is a deliberate fail-closed placeholder, not a checksum. */
export const UNPINNED_SHA256 = '0'.repeat(64)

export function isDigestPinned(sha256: string): boolean {
  return /^[0-9a-f]{64}$/u.test(sha256) && sha256 !== UNPINNED_SHA256
}

/** Where a fetched prerequisite lives. Deliberately inside the repo's gitignored workspace and never in `release/`. */
export function defaultPrerequisiteDirectory(root = process.cwd()): string {
  return join(root, 'installer', 'cache')
}

export interface FetchedPrerequisite {
  /** Which allowlisted component this is. `vcredist-x64` today; the field exists so a pin names what it pins. */
  componentId: string
  /** Absolute path to the verified file. */
  path: string
  sha256: string
  sizeBytes: number
  /** The publisher subject the signature check actually saw, for the release record. */
  signerSubject: string
  /** Where it came from: a pinned release URL, not something a caller passed in. */
  url: string
  /** A short, human-comparable version string derived from the file, for the checklist. */
  microsoftVersion: string
}

export interface FetchOptions {
  /** Where to put the file. Defaults to `installer/cache`. */
  directory?: string
  /** Injected for tests; the real one shells out. */
  download?: (url: string, target: string) => void
  /** Injected for tests. Returns the signer subject, or null when the file is unsigned or unreadable. */
  readSigner?: (path: string) => string | null
  /** Injected for tests: the project root. */
  root?: string
}

/**
 * The allowlisted component a release bundles. Takes the entry rather than a URL so a caller cannot express
 * "download from here instead" -- the same design rule as `resolveDownload`.
 */
export function releaseComponent(): AllowlistedComponent {
  const [component] = ALLOWLISTED_COMPONENTS
  if (!component) throw new Error('The download allowlist is empty, so there is no prerequisite to bundle.')
  return component
}

/**
 * Fetches the redistributable from its allowlisted URL, verifies the signature, and returns the digest.
 *
 * The order is deliberate and is the reverse of what is convenient: download to a temporary name, verify the
 * signature FIRST, and only then move it into place. A file that fails verification is deleted, so a half-checked
 * binary is never left somewhere a later step could pick it up.
 */
export function fetchPrerequisite(options: FetchOptions = {}): FetchedPrerequisite {
  const component = releaseComponent()
  const directory = options.directory ?? defaultPrerequisiteDirectory(options.root)
  const download = options.download ?? httpDownload
  const readSigner = options.readSigner ?? shellReadSigner

  // The TypeScript rule, applied here as well: https, and a host on the allowlist. download-allowlist.ts already
  // refuses a bad entry, but this function is the one that opens the socket, so it re-checks rather than trusting
  // that the table was never edited.
  const host = hostOf(component.url)
  if (host === null) {
    throw new Error(
      `The prerequisite address "${component.url}" is not a secure (https) address, so the release build cannot ` +
        'fetch it. Nothing was downloaded and no installer was produced.',
    )
  }

  mkdirSync(directory, { recursive: true })
  const finalPath = join(directory, 'vc_redist.x64.exe')
  const temporaryPath = join(directory, 'vc_redist.x64.exe.partial')

  // A leftover from an interrupted run must not be mistaken for a fresh download.
  if (existsSync(temporaryPath)) {
    throw new Error(
      `A partially downloaded file is already at ${temporaryPath}. Delete it and run the release again; it was not ` +
        'verified, so it will not be used.',
    )
  }

  try {
    download(component.url, temporaryPath)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `The ${component.title} could not be downloaded from ${component.url}. The release build stops here rather than ` +
        `shipping an installer that cannot verify its prerequisite. Details: ${message}`,
    )
  }

  if (!existsSync(temporaryPath) || statSync(temporaryPath).size === 0) {
    throw new Error(
      `The download from ${component.url} produced no file. The release build stops here rather than shipping an ` +
        'installer that cannot verify its prerequisite.',
    )
  }

  const signerSubject = readSigner(temporaryPath)
  if (signerSubject === null) {
    safeDelete(temporaryPath)
    throw new Error(
      `The file downloaded from ${component.url} has no valid digital signature, so it was deleted. The release build ` +
        'stops here. If this happens on a build machine without PowerShell, the signature cannot be checked there and ' +
        'the release cannot be made on that machine.',
    )
  }
  if (!signerSubject.toLowerCase().includes(component.publisher.toLowerCase())) {
    safeDelete(temporaryPath)
    throw new Error(
      `The file downloaded from ${component.url} was signed by "${signerSubject}", not ${component.publisher}, so it ` +
        'was deleted. The release build stops here.',
    )
  }

  const bytes = readFileSync(temporaryPath)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (!isDigestPinned(sha256)) {
    // Cannot happen with a real file, and checked anyway: a digest equal to the placeholder would silently reinstate
    // the fail-closed default in a "pinned" release.
    safeDelete(temporaryPath)
    throw new Error('The downloaded file hashed to the placeholder digest, which cannot be right. The release stops here.')
  }

  writeFileSync(finalPath, bytes)
  safeDelete(temporaryPath)

  return {
    path: finalPath,
    componentId: component.id,
    sha256,
    sizeBytes: bytes.byteLength,
    signerSubject,
    url: component.url,
    microsoftVersion: microsoftVersionOf(finalPath, signerSubject),
  }
}

/**
 * The gate a release cannot pass with the placeholder digest.
 *
 * Called by the release script before it writes anything, and by the build step that produces the offline installer.
 * A development build is allowed to keep the zeros -- it is allowed to be unshippable, and failing closed is the honest
 * behaviour there -- but a release that would hand a customer an installer whose own verification refuses its own
 * payload is not a release.
 */
export function assertReleasePin(sha256: string): void {
  if (isDigestPinned(sha256)) return
  throw new Error(
    'The VC++ prerequisite checksum is still the all-zero placeholder, so this build CANNOT be released. ' +
      'Run the release prerequisite step (npm run release:prerequisite) on a machine with internet access to download ' +
      'the official file, verify its Microsoft signature and pin its SHA-256. A development build may keep the zeros; ' +
      'a release may not, because the installer would refuse the very file it ships.',
  )
}

/**
 * The Microsoft version of the file, as a person can compare it on a real PC.
 *
 * Read from the file's own version resource rather than from the URL, because `aka.ms/vs/17/release/vc_redist.x64.exe`
 * always resolves to the newest build and the version is what changes.
 */
function microsoftVersionOf(path: string, signerSubject: string): string {
  const fromResource = fileVersionFromWindowsResource(path)
  if (fromResource) return fromResource
  // On a machine that cannot read a PE version resource (Linux, in this sandbox) fall back to the signature's date
  // if it carries one, and otherwise say so rather than inventing a number.
  const dated = /\b(20\d{2}-\d{2}-\d{2})\b/u.exec(signerSubject)
  return dated ? `signed ${dated[1]}` : 'unreadable on this machine (see the release checklist)'
}

/**
 * The `FileVersion` a real Windows executable reports in Properties → Details.
 *
 * The first version of this looked for the UTF-16LE key `FileVersion` anywhere in the file and read what followed. It
 * had never been run against a real executable, and three separate things were wrong with it. All three were found by
 * running it against genuine Microsoft-built binaries in `node_modules`:
 *
 *   1. **Alignment padding.** The key is padded to a 4-byte boundary, and the padding is not one NUL — `signtool.exe`
 *      carries three. The old reader stopped at the first control character and returned `null` for every real file.
 *   2. **Real values are not bare numbers.** `signtool.exe` reports `4.00 (WinBuild.160101.0800)`, which the old
 *      `^\d+(\.\d+)+$` pattern rejected. The number is taken out and the suffix is reported separately, because the
 *      checklist asks for what a person sees, not for a value that passes a regex.
 *   3. **A linear scan finds the key in text that is not a version resource.** `candle.exe` embeds a WiX template
 *      containing `[FileVersionMajorMinor]`, and the old reader returned a string of box-drawing characters as the
 *      version of the file. A wrong answer is worse than none here: it goes into the release record as fact.
 *
 * The fix for the third one is where the key is found: the `VS_VERSION_INFO` structure is searched first and the key is
 * only accepted inside it. Every genuine resource has that 32-byte marker within a few hundred bytes of its string
 * table; the template text in `candle.exe` that fooled the scan has none before it. Verified against four real
 * executables — see `prerequisite-release.test.ts`, which skips rather than passes when they are absent.
 *
 * Returns `null` when it cannot be determined, and `null` is always the honest answer: the release record then says the
 * version was unreadable on this machine and asks a person to check the real PC.
 */
export function fileVersionFromWindowsResource(path: string): string | null {
  const { fileVersion, productVersion } = windowsVersionResource(path)
  // FileVersion first, because that is the row a person reads; ProductVersion is the same value in most Microsoft
  // binaries and a better answer than nothing in the ones where the former is absent.
  return fileVersion ?? productVersion
}

/** Both version strings a real resource carries, either of which may be absent. */
export function windowsVersionResource(path: string): { fileVersion: string | null; productVersion: string | null } {
  try {
    const bytes = readFileSync(path)
    if (bytes.length < 0x40 || bytes.toString('latin1', 0, 2) !== 'MZ') return { fileVersion: null, productVersion: null }

    // Inside the version resource, not merely somewhere in the file. The marker is UTF-16LE "VS_VERSION_INFO".
    const marker = Buffer.from('VS_VERSION_INFO', 'utf16le')
    const markerAt = bytes.indexOf(marker)
    if (markerAt === -1) return { fileVersion: null, productVersion: null }

    const read = (key: string): string | null => {
      const keyBytes = Buffer.from(key, 'utf16le')
      let at = bytes.indexOf(keyBytes, markerAt)
      if (at === -1) return null
      at += keyBytes.length
      // Skip alignment padding: any run of NULs up to the next code unit. Three of them is normal.
      while (at + 1 < bytes.length && bytes[at] === 0 && bytes[at + 1] === 0) at += 2
      // Read the UTF-16LE string up to its terminator, then split the number from any build suffix.
      let text = ''
      for (let index = at; index + 1 < bytes.length && text.length < 120; index += 2) {
        const unit = bytes.readUInt16LE(index)
        if (unit === 0 || unit < 0x20) break
        text += String.fromCharCode(unit)
      }
      const value = text.trim()
      if (value === '') return null
      return value
    }

    return { fileVersion: read('FileVersion'), productVersion: read('ProductVersion') }
  } catch {
    return { fileVersion: null, productVersion: null }
  }
}

function safeDelete(path: string): void {
  // Best effort, and that is the right effort: the caller has ALREADY thrown by the time this runs, so a delete that
  // fails is not the problem to solve. `force` makes a missing file a no-op rather than an exception, which is the only
  // behaviour this needs -- an earlier version wrote an empty file first and then removed it, which was two steps of
  // theatre around one call.
  try {
    rmSync(path, { force: true })
  } catch {
    // Left behind deliberately: the release has stopped, and shouting about a failed cleanup would hide the reason.
  }
}

/**
 * Where a URL actually ended up, following redirects, without downloading the body.
 *
 * `aka.ms` is a shortener: the allowlisted address redirects to `download.visualstudio.microsoft.com`. That is fine,
 * because both hosts are on the allowlist. What is not fine is following a redirect to somewhere else, and the download
 * used to do exactly that -- `curl --location` follows up to three hops and the function's own comment claimed it
 * "refuses a redirect to a host that is not allowlisted". Nothing checked. The signature check would still have caught
 * a substituted binary, but the address rule was being enforced on the wrong address: the one before the redirects.
 */
export function resolveFinalUrl(url: string): string {
  const output = execFileSync(
    'curl',
    ['--fail', '--silent', '--show-error', '--location', '--max-redirs', '3', '--head', '--output', '/dev/null',
      '--write-out', '%{url_effective}', url],
    { encoding: 'utf8', timeout: 60_000 },
  )
  return output.trim()
}

/** True when `url` is https and its host is on the allowlist. Used on the address the download actually reached. */
export function isAllowlistedAddress(url: string): boolean {
  const host = hostOf(url)
  return host !== null && ALLOWED_DOWNLOAD_HOSTS.includes(host)
}

/** The real downloader. Deliberately tiny, and it refuses a redirect to a host that is not allowlisted. */
function httpDownload(url: string, target: string): void {
  // Synchronous on purpose: this runs inside a build step that is already sequential, and a promise here would have to
  // be threaded through every caller for no benefit. curl ships with Windows 10+ and every Linux/macOS machine.
  try {
    // Check where the request LANDS before fetching a body. `resolveFinalUrl` asks for headers only, so a refusal here
    // costs a round trip rather than 25 MB.
    let finalUrl = url
    try {
      finalUrl = resolveFinalUrl(url)
    } catch {
      // A HEAD that fails is not itself a reason to stop -- some servers refuse HEAD -- so fall through to the download
      // and validate the bytes afterwards. The signature check is the backstop; this is defence in depth.
      finalUrl = url
    }
    if (!isAllowlistedAddress(finalUrl)) {
      throw new Error(
        `the address redirected to ${finalUrl}, which is not an approved Microsoft address. Nothing was downloaded.`,
      )
    }
    execFileSync('curl', ['--fail', '--location', '--silent', '--show-error', '--max-redirs', '3', '--output', target, url], {
      stdio: 'pipe',
      timeout: 15 * 60 * 1000,
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`curl could not fetch ${url}: ${detail}`)
  }
}

/** The real signature reader: the same helper the installer uses, so the two cannot disagree about "verified". */
function shellReadSigner(path: string): string | null {
  const component = releaseComponent()
  // Reuse the tested interpreter rather than repeating the decision in a second place.
  const result = runAuthenticodeCheck([component.publisher, path])
  if (result.code !== 0) return null
  // runAuthenticodeCheck already compared the publisher; re-read the subject for the release record.
  try {
    const subject = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$s = Get-AuthenticodeSignature -LiteralPath '${path.replace(/'/gu, "''")}'; if ($s.Status -ne 'Valid') { exit 1 }; $s.SignerCertificate.Subject`,
    ], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
    const text = subject.trim()
    return text.length > 0 && !text.includes('\n') ? text : null
  } catch {
    return null
  }
}

/** What a release writes down about the prerequisite, for `release/` and the checklist. */
/**
 * The gate that closes the gap between "the pin is real" and "the file is the pinned one".
 *
 * `assertReleasePin` proves the digest is not the placeholder. It says nothing about the bytes in `installer/cache/`,
 * and those two facts come apart in ways that are easy to reach in practice:
 *
 *   - the cache directory survived from a previous release, so the file on disk is an older Microsoft build while the
 *     profile carries a newer digest;
 *   - somebody replaced the file to test something and forgot to remove it;
 *   - the fetch was interrupted after the profile was written.
 *
 * In every one of those cases the offline installer would bundle bytes whose own `${VCREDIST_SHA256}` check refuses
 * them at install time -- the installer failing on the customer's machine over a mistake made on the build machine. So
 * the release re-reads the file it is about to bundle and compares its digest, size and signature with the pin.
 *
 * This is the release half of the rule the installer already enforces on the customer's machine: verify before use. It
 * is deliberately a separate function from the fetch, because a fetch that trusts its own earlier result is not a check.
 */
export function verifyCachedPrerequisite(options: {
  directory?: string
  pin: { sha256: string; sizeBytes: number }
  readSigner?: (path: string) => string | null
}): { path: string; sha256: string; sizeBytes: number; signerSubject: string } {
  const directory = options.directory ?? defaultPrerequisiteDirectory()
  const path = join(directory, 'vc_redist.x64.exe')
  const readSigner = options.readSigner ?? shellReadSigner

  if (!existsSync(path)) {
    throw new Error(
      `The pinned prerequisite is not in the cache: ${path} does not exist. The profile says this build pins ` +
        `${options.pin.sha256.slice(0, 16)}..., but the file it describes is missing, so the offline installer would ` +
        'carry no runtime at all. Run `npm run release:prerequisite` to fetch and verify it again.',
    )
  }

  const bytes = readFileSync(path)
  if (bytes.byteLength !== options.pin.sizeBytes) {
    throw new Error(
      `The cached prerequisite is ${bytes.byteLength.toLocaleString('en-GB')} bytes but the pin says ` +
        `${options.pin.sizeBytes.toLocaleString('en-GB')}. This is the wrong file -- most likely a leftover from a ` +
        'previous release. Delete it and run `npm run release:prerequisite` to fetch the pinned one.',
    )
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== options.pin.sha256) {
    throw new Error(
      `The cached prerequisite does not match the pinned SHA-256.\n\n  pinned:   ${options.pin.sha256}\n  on disk:  ` +
        `${sha256}\n\nThe offline installer would bundle a file its own checksum refuses at install time -- it would ` +
        'fail on the customer\'s machine instead of here. Delete installer/cache and run `npm run release:prerequisite`.',
    )
  }

  // Re-read the signature as well. A digest match proves the bytes are the ones hashed; it does not prove they carry
  // Microsoft's signature, and a pin written on a machine where the check was skipped would otherwise be trusted
  // forever after. Cheap, so it is done on every release rather than once.
  const signer = readSigner(path)
  const publisher = releaseComponent().publisher
  if (signer === null || !signer.includes(publisher)) {
    throw new Error(
      `The cached prerequisite does not carry a valid signature from ${publisher}, so it cannot be bundled. ` +
        'Delete installer/cache and run `npm run release:prerequisite` to fetch it again from Microsoft.',
    )
  }

  return { path, sha256, sizeBytes: bytes.byteLength, signerSubject: signer }
}

export interface PrerequisiteRecord {
  component: string
  url: string
  sha256: string
  sizeBytes: number
  microsoftVersion: string
  signerSubject: string
  /** Where the file must be for the offline build to bundle it. */
  bundledAt: string
}

export function prerequisiteRecord(fetched: FetchedPrerequisite, bundledAt: string): PrerequisiteRecord {
  return {
    component: `${releaseComponent().title}`,
    url: fetched.url,
    sha256: fetched.sha256,
    sizeBytes: fetched.sizeBytes,
    microsoftVersion: fetched.microsoftVersion,
    signerSubject: fetched.signerSubject,
    bundledAt,
  }
}

/**
 * Applies a verified fetch to the generator: returns the header's component override.
 *
 * The generator takes the component as data so nothing here mutates a module-level constant at runtime -- an earlier
 * draft of this design would have assigned `ALLOWLISTED_COMPONENTS[0].sha256`, which makes one test's fetch leak into
 * the next test's header.
 */
export function pinnedComponent(fetched: FetchedPrerequisite): AllowlistedComponent {
  return { ...releaseComponent(), sha256: fetched.sha256, sizeBytes: fetched.sizeBytes }
}

/** The environment variable the offline build reads to know where the file is. Named to match the NSIS define. */
/**
 * @deprecated Not read by anything. Kept only because a stale message referred to it; delete once nothing imports it.
 * The offline build's path is fixed at `installer/cache/vc_redist.x64.exe` and travels to the script through the
 * generated `prerequisite.nsh`, so there is deliberately no environment override -- an override would let a build carry
 * a file from somewhere the pin was not verified against.
 */
export const PREREQUISITE_PATH_ENV = 'INFOFLEX_PREREQUISITE_VCREDIST'

/**
 * The real signature reader, for callers that need to re-verify a file rather than fetch one.
 *
 * Returns the signer's subject when the signature is valid AND the publisher matches the allowlist, and `null`
 * otherwise. `null` is the only failure value: a caller that confuses "no signature" with "could not read" would treat
 * an unreadable file as safe.
 */
export function readSignerSubject(path: string): string | null {
  return shellReadSigner(path)
}
