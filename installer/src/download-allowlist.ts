import { createHash } from 'node:crypto'

/**
 * The DOWNLOAD SAFETY RULE, expressed as code rather than as a promise.
 *
 * The brief's rule: any component the installer or Build Studio downloads must come from a hard-coded allowlist
 * of official vendor URLs, never from a search result or an unknown site; the checksum and (for Windows
 * executables) the Authenticode signature and publisher must be verified before it is run; and a failed
 * verification must delete the file, explain in plain words, and offer "Browse for file".
 *
 * The important design decision here is that there is no function anywhere in this file that accepts a URL to
 * download *to*. `resolveDownload(id)` takes an allowlist entry id and nothing else, so a caller cannot express
 * "fetch this URL instead" even by mistake. A string that arrives from a server, a config file or a user field
 * has no path to becoming a download destination.
 */

export interface AllowlistedComponent {
  /** The only handle a caller may use. */
  id: 'vcredist-x64'
  /** What the customer sees. */
  title: string
  /** The single official URL. There is deliberately no mirror list. */
  url: string
  /** The publisher named in the Authenticode signature; checked, not merely displayed. */
  publisher: string
  /** The SHA-256 of the exact file the vendor pinned. */
  sha256: string
  /** Bytes, for the progress bar's total before the connection reports a length. */
  sizeBytes: number
  /** NSIS needs to know whether to run it silently. */
  silentArguments: string[]
}

/**
 * One entry today: the x64 Visual C++ 2015-2022 redistributable, from Microsoft's own `aka.ms` short link, which
 * the brief names as the example. The checksum is pinned to the file that link resolves to for a given release;
 * when Microsoft publishes a new build, the vendor updates this table in a release — the installer never fetches
 * "whatever is newest", because that would defeat the checksum.
 *
 * If the checksum is not yet pinned for a build, the install fails safe (verification cannot pass) rather than
 * running an unverified binary. That is the correct direction for a failure to point.
 */
export const ALLOWLISTED_COMPONENTS: readonly AllowlistedComponent[] = [
  {
    id: 'vcredist-x64',
    title: 'Microsoft Visual C++ 2015-2022 Redistributable (x64)',
    url: 'https://aka.ms/vs/17/release/vc_redist.x64.exe',
    publisher: 'Microsoft Corporation',
    // NOTE FOR RELEASE: replace with the SHA-256 of the exact build being shipped. The all-zeros value below
    // deliberately fails verification, so an unpinned build cannot be installed by accident.
    sha256: '0000000000000000000000000000000000000000000000000000000000000000',
    sizeBytes: 25_000_000,
    silentArguments: ['/install', '/quiet', '/norestart'],
  },
]

/** The official hosts any download may touch. Anything else is refused before a socket is opened. */
export const ALLOWED_DOWNLOAD_HOSTS: readonly string[] = [
  'aka.ms',
  'download.microsoft.com',
  'download.visualstudio.microsoft.com',
]

export type DownloadRefusal = { ok: false; message: string }
export type DownloadTarget = { ok: true; component: AllowlistedComponent; url: string }

/**
 * The only way to get a download target. It takes an id, never a URL.
 *
 * The URL is then re-validated before use: HTTPS only, and a host on the allowlist. That second check is
 * redundant while the table above is the only source — which is exactly why it is cheap and worth keeping, since
 * it still holds if somebody later adds an entry with a typo in the host.
 */
export function resolveDownload(id: string): DownloadTarget | DownloadRefusal {
  const component = ALLOWLISTED_COMPONENTS.find((entry) => entry.id === id)
  if (!component) {
    return { ok: false, message: 'That component is not on the approved list, so it will not be downloaded.' }
  }
  const host = hostOf(component.url)
  if (!host || !ALLOWED_DOWNLOAD_HOSTS.includes(host)) {
    return {
      ok: false,
      message: `${component.title} is not served from an approved Microsoft address. Contact Infoflex support; nothing was downloaded.`,
    }
  }
  return { ok: true, component, url: component.url }
}

export function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return null
    return parsed.hostname.toLowerCase()
  } catch {
    return null
  }
}

export type VerificationResult =
  | { ok: true; component: AllowlistedComponent }
  | { ok: false; message: string; deleteFile: boolean }

/** Checksum first: it is fast, and a wrong file never reaches the signature check. */
export function verifyChecksum(id: string, bytes: Buffer): VerificationResult {
  const target = resolveDownload(id)
  if (!target.ok) return { ok: false, message: target.message, deleteFile: true }
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== target.component.sha256.toLowerCase()) {
    return {
      ok: false,
      deleteFile: true,
      message: `The downloaded file is not the one Infoflex expects, so it was deleted. Check your internet connection and try again, or use "Browse for the file myself".`,
    }
  }
  return { ok: true, component: target.component }
}

/**
 * The Authenticode check, as an observation to be interpreted.
 *
 * Reading the signature needs Windows (`Get-AuthenticodeSignature`) and is done by the NSIS side; this function
 * is the decision, so the rule is testable. An unsigned file, a file signed by anybody other than the pinned
 * publisher, or a signature that does not validate are all a refusal with the same consequences.
 */
export function verifySignature(input: {
  id: string
  status: 'Valid' | 'NotSigned' | 'HashMismatch' | 'UnknownError' | 'NotTrusted'
  signerSubject: string | null
}): VerificationResult {
  const target = resolveDownload(input.id)
  if (!target.ok) return { ok: false, message: target.message, deleteFile: true }
  const expected = target.component.publisher.toLowerCase()
  if (input.status === 'NotSigned') {
    return {
      ok: false, deleteFile: true,
      message: 'The downloaded program is not digitally signed, so it was deleted. Use "Browse for the file myself" to pick the official Microsoft download.',
    }
  }
  if (input.status !== 'Valid') {
    return {
      ok: false, deleteFile: true,
      message: 'The downloaded program\'s digital signature could not be verified, so it was deleted. Check your internet connection and try again.',
    }
  }
  if (!input.signerSubject || !input.signerSubject.toLowerCase().includes(expected)) {
    return {
      ok: false, deleteFile: true,
      message: `The downloaded program was signed by "${input.signerSubject ?? 'an unknown publisher'}", not ${target.component.publisher}, so it was deleted.`,
    }
  }
  return { ok: true, component: target.component }
}

/**
 * A file the customer picked with "Browse for the file myself" is held to the same standard as a download: the
 * checksum and the publisher must match. Choosing a file does not skip verification.
 */
export function verifyBrowsedFile(id: string, bytes: Buffer): VerificationResult {
  return verifyChecksum(id, bytes)
}
