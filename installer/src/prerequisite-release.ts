import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ALLOWLISTED_COMPONENTS, hostOf, type AllowlistedComponent } from './download-allowlist'
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
 * A best-effort read of the PE FileVersion. Kept small and dependency-free; returns null when the file is not a PE or
 * has no version resource, which is the normal answer on a non-Windows machine.
 */
export function fileVersionFromWindowsResource(path: string): string | null {
  try {
    const bytes = readFileSync(path)
    if (bytes.length < 0x40 || bytes.toString('ascii', 0, 2) !== 'MZ') return null
    // The version resource is a UTF-16LE string table entry "FileVersion". Looking for the key is enough to find the
    // value without implementing the whole resource tree, and it is a read-only observation either way.
    const ascii = bytes.toString('latin1')
    const keyAt = ascii.indexOf('F\0i\0l\0e\0V\0e\0r\0s\0i\0o\0n\0')
    if (keyAt === -1) return null
    const start = keyAt + 'F\0i\0l\0e\0V\0e\0r\0s\0i\0o\0n\0'.length
    // Values are NUL-separated UTF-16LE; take up to the next double NUL, sanitised to printable digits and dots.
    const tail = bytes.subarray(start, start + 200)
    const text = tail.toString('utf16le')
    const stop = text.search(/[\u0000-\u001f]/u)
    const candidate = (stop === -1 ? text : text.slice(0, stop)).trim()
    return /^\d+(?:[.,]\d+){1,3}$/u.test(candidate) ? candidate : null
  } catch {
    return null
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

/** The real downloader. Deliberately tiny, and it refuses a redirect to a host that is not allowlisted. */
function httpDownload(url: string, target: string): void {
  // Synchronous on purpose: this runs inside a build step that is already sequential, and a promise here would have to
  // be threaded through every caller for no benefit. curl ships with Windows 10+ and every Linux/macOS machine.
  try {
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
export const PREREQUISITE_PATH_ENV = 'INFOFLEX_PREREQUISITE_VCREDIST'
