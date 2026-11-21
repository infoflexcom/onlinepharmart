import { createHash } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { BUILD_STEPS, type ArtefactSpec } from './build-steps'

/**
 * What was actually built: its path, its size, and its SHA-256.
 *
 * The output screen has to be honest. A list assembled from "the steps that were meant to run" would show a file
 * that is not there, and a vendor copying to a USB drive would carry an empty folder to a customer. So the list is
 * built by looking on the disk, and a step that reported success but produced nothing appears as a problem rather
 * than as an artefact.
 *
 * The checksum is also what makes "Verify installer" meaningful: a vendor can read the fingerprint off the output
 * screen and compare it with the one on the USB drive they handed over.
 */

export interface Artefact {
  /** What the vendor calls it. */
  title: string
  /** Absolute path, for "Open folder". */
  path: string
  /** The path relative to the project, for the log. */
  relativePath: string
  exists: boolean
  sizeBytes: number
  /** Hex SHA-256, or null when the file is missing. */
  sha256: string | null
}

/** Every artefact any step can produce, with `{version}` in paths resolved. */
export function declaredArtefacts(version: string): ArtefactSpec[] {
  return BUILD_STEPS.flatMap((step) => step.produces)
    .map((artefact) => ({ ...artefact, path: artefact.path.replace(/\{version\}/gu, version) }))
}

/** SHA-256 of a file, streamed so a 100 MB installer does not have to be held in memory. */
export async function sha256File(path: string): Promise<string | null> {
  if (!existsSync(path)) return null
  return new Promise((resolve) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', () => resolve(null))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

export async function inspectArtefact(projectRoot: string, spec: ArtefactSpec, version: string): Promise<Artefact> {
  const relativePath = spec.path.replace(/\{version\}/gu, version)
  const path = join(projectRoot, relativePath)
  const exists = existsSync(path)
  const sizeBytes = exists ? statSync(path).size : 0
  return {
    title: spec.title,
    path,
    relativePath,
    exists,
    sizeBytes,
    sha256: exists ? await sha256File(path) : null,
  }
}

export interface ArtefactReport {
  artefacts: Artefact[]
  /** Steps that produced nothing, in plain words. Empty means everything the build promised is on disk. */
  missing: string[]
}

export async function inspectAllArtefacts(projectRoot: string, version: string): Promise<ArtefactReport> {
  const artefacts: Artefact[] = []
  const missing: string[] = []
  for (const spec of declaredArtefacts(version)) {
    const artefact = await inspectArtefact(projectRoot, spec, version)
    artefacts.push(artefact)
    if (!artefact.exists) missing.push(`${artefact.title} was not produced.`)
  }
  return { artefacts, missing }
}

/** A human size: "1.4 MB" rather than 1468006. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

/** The drives a vendor could copy an installer to, described as Windows shows them. */
export interface DriveChoice {
  path: string
  label: string
}

/**
 * The drive letters Windows currently has, as roots.
 *
 * Separated from the IPC handler because that handler is unreachable off Windows, and this is the part with a rule
 * in it: a drive letter that exists but whose media has been removed throws when it is looked at (an empty card
 * reader is the everyday case), and that must not stop the list being built.
 */
export function windowsDriveRoots(
  platform: NodeJS.Platform,
  look: (path: string) => { exists: boolean; isDirectory: boolean },
): string[] {
  if (platform !== 'win32') return []
  const roots: string[] = []
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`
    try {
      const info = look(root)
      if (info.exists && info.isDirectory) roots.push(root)
    } catch {
      // A drive with no media throws; it is simply not a choice.
    }
  }
  return roots
}

/**
 * Filters the filesystem roots down to removable-looking drives.
 *
 * On Windows the roots are letters; A and B are never used and C is almost always the system drive, so they are
 * excluded. This cannot tell a USB stick from a second fixed disk without the Win32 API, so the label says "drive"
 * rather than claiming to be certain — the vendor picks from a list and knows which one they plugged in.
 */
export function removableDriveChoices(roots: string[], platform: NodeJS.Platform = process.platform): DriveChoice[] {
  if (platform !== 'win32') return roots.map((root) => ({ path: root, label: root }))
  return roots
    .filter((root) => /^[A-Za-z]:[\\/]?$/u.test(root))
    .filter((root) => !/^[ABab]:/u.test(root))
    .filter((root) => !/^[Cc]:/u.test(root))
    .map((root) => ({ path: root.endsWith('\\') ? root : `${root}\\`, label: `${root.replace(/[\\/:]/gu, '').toUpperCase()} drive` }))
}
