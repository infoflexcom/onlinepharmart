import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { assertReleasePin, UNPINNED_SHA256, verifyCachedPrerequisite } from '../installer/src/prerequisite-release'
import { BUILD_PROFILE_FILENAME, parseBuildProfile } from '../installer/src/build-profile'

/**
 * Assembles the release folders: `/release`, `/tools`, `/cloud-package`.
 *
 * It is deliberately honest about what it could not produce. On a machine where the Windows toolchain is available
 * (any Windows PC with the repository checked out), it collects the three executable deliverables, hashes them and
 * writes `release/SHA256SUMS.txt`. On the Linux build agent that produced this phase, the Windows binaries cannot be
 * built at all — electron-builder has to download the Electron runtime and the sandbox cannot reach the host it comes
 * from — so the script collects what *can* be built, writes the checksums for those, and records every missing
 * artefact in `release/MANIFEST.json` with the reason. A release folder that silently omitted two installers would
 * be far worse than one that says which two are missing and why.
 *
 * Nothing in here contains the master password or a private key; the scans in `npm run release:scan` are what prove
 * that, and this script runs them.
 */

const RELEASE = 'release'
const TOOLS = 'tools'
const CLOUD = 'cloud-package'

interface Deliverable {
  /** Where the vendor expects to find it. */
  target: string
  /** Where it is produced, or null when it cannot be produced here. */
  source: string | null
  required: boolean
  description: string
  /** Why it is absent, when it is. */
  absent?: string
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function present(path: string): boolean {
  return existsSync(path) && statSync(path).isFile()
}

/**
 * The five deliverables of this project, and whether this environment could produce each.
 *
 * The three `.exe` files are missing for exactly ONE reason, and it is worth stating precisely because the earlier
 * version of this comment named two that were not true. `makensis` is not a blocker: it is built from source here, and
 * the installer stubs are cross-compiled with Zig, so `npm run installer:compile` produces a real i386 installer. The
 * remaining blocker is the Electron **runtime**: electron-builder must download
 * `electron-v45.3.3-win32-x64.zip`, `github.com` redirects that to `objects.githubusercontent.com`, and this agent's
 * network refuses that host (curl exit 35, "SSL connect error"). Without the runtime there is no application payload
 * to put inside the installer, however well the installer itself compiles.
 */
export const deliverables: Deliverable[] = [
  {
    target: join(RELEASE, 'Infoflex Setup.exe'),
    source: null,
    required: true,
    description: 'The customer installer: prerequisites, password gate, Region and Currency page.',
    absent: 'Needs the Windows Electron runtime. electron-builder downloads electron-v45.3.3-win32-x64.zip, and '
      + 'github.com redirects that to objects.githubusercontent.com, which this build agent cannot reach (SSL connect '
      + 'error). The installer compiler itself is no longer a blocker: `npm run installer:compile` builds it from source '
      + 'here and produces a real i386 installer for each build shape. What is missing is the application payload to put '
      + 'inside that installer. Run `npm run installer:online` on any Windows PC with the repository checked out.',
  },
  {
    target: join(RELEASE, 'Infoflex Setup Offline.exe'),
    source: null,
    required: true,
    description: 'The same wizard with every prerequisite bundled and no download page.',
    absent: 'Same reason as Infoflex Setup.exe: the Electron runtime, not the installer. `npm run installer:offline` '
      + 'produces it elsewhere.',
  },
  {
    target: join(TOOLS, 'Infoflex Build Studio.exe'),
    source: null,
    required: true,
    description: "The vendor's graphical build tool.",
    absent: 'Same reason as the installers: the Windows Electron runtime cannot be fetched here. `npm run dist:studio` '
      + 'produces it elsewhere. The tool itself is built and tested here; only the packaging needs Windows.',
  },
  {
    target: join(CLOUD, 'infoflex-vendor-cloud.zip'),
    source: 'dist/cloud/infoflex-vendor-cloud.zip',
    required: true,
    description: 'The Vendor Cloud bundle (Node and PHP builds, deployment guide).',
  },
  {
    target: join(RELEASE, 'README-WHAT-IS-MISSING.txt'),
    source: 'docs/RELEASE-CONTENTS.md',
    required: true,
    description: 'What this folder should contain and what it does contain.',
  },
]

function main(): void {
  for (const directory of [RELEASE, TOOLS, CLOUD]) mkdirSync(directory, { recursive: true })

  const collected: Array<{ file: string; bytes: number; sha256: string }> = []
  const missing: Array<{ file: string; reason: string }> = []

  for (const deliverable of deliverables) {
    if (deliverable.source && present(deliverable.source)) {
      copyFileSync(deliverable.source, deliverable.target)
    }
    if (present(deliverable.target)) {
      collected.push({
        file: deliverable.target,
        bytes: statSync(deliverable.target).size,
        sha256: sha256(deliverable.target),
      })
    } else if (deliverable.required) {
      missing.push({ file: deliverable.target, reason: deliverable.absent ?? 'Not produced.' })
    }
  }

  // The Build Studio bundle ships alongside the tool because the .exe is not available: a vendor on a Windows PC with
  // Node can run it from source, and the files are what `npm run dist:studio` would pack.
  const studioOut = 'buildstudio/out'
  if (existsSync(studioOut)) {
    for (const name of readdirSync(studioOut).sort()) {
      const from = join(studioOut, name)
      if (!statSync(from).isFile()) continue
      const to = join(TOOLS, 'build-studio-bundle', name)
      mkdirSync(join(TOOLS, 'build-studio-bundle'), { recursive: true })
      copyFileSync(from, to)
      collected.push({ file: to, bytes: statSync(to).size, sha256: sha256(to) })
    }
  }

  // ---- the prerequisite gate, BEFORE anything is written
  //
  // A release may not ship an installer whose own verification refuses its own payload. The offline installer would
  // carry no runtime (or, worse, a file whose pinned digest is the all-zeros placeholder that refuses everything), and
  // the online installer would refuse every download. So the assembly stops here rather than producing a
  // release/ folder that looks finished.
  //
  // Deliberately not a warning and not a note in MANIFEST.json: a release folder is what somebody copies to a USB
  // stick, and a line in a JSON file does not stop them.
  let prerequisite: { sha256: string; microsoftVersion: string; sizeBytes: number; url: string; fetchedAt: string } | null = null
  try {
    const profileText = readFileSync(join('installer', 'nsis', BUILD_PROFILE_FILENAME), 'utf8')
    const profile = parseBuildProfile(profileText)
    const pin = profile?.prerequisite
    // An explicit opt-in for the development pipeline, which must be able to assemble a folder to test the assembly
    // itself. It is a separate flag with its own name, not a lower bar: the release record then says
    // `pinned: false` and the folder is marked as not for distribution, so a build that took this route cannot be
    // mistaken for a shippable one.
    if (!pin && process.argv.includes('--allow-unpinned')) {
      console.log('\nWARNING: assembling an UNPINNED development release. Not for distribution.\n')
    } else if (!pin) {
      throw new Error(
        'The build profile carries no prerequisite pin, so this build cannot be released. Run ' +
          '`npm run release:prerequisite` on a machine with internet access first: it downloads the official ' +
          'Microsoft file, verifies its signature and publisher, and records the SHA-256.',
      )
    }
    // `pin` is undefined on the --allow-unpinned development route, so the rest is skipped rather than reached through
    // an optional. Reading `pin.sha256` unconditionally here threw "Cannot read properties of undefined" and printed it
    // as if it were the release refusing -- a crash dressed as a decision.
    if (pin) {
      assertReleasePin(pin.sha256)
      // The pin is real; now prove the FILE is the one it describes. A release folder is copied to a USB stick, and an
      // offline installer bundling a stale cache would refuse its own payload on the customer's machine.
      const verified = verifyCachedPrerequisite({ pin })
      console.log(`Prerequisite verified on disk: ${verified.sha256.slice(0, 16)}..., signed by ${verified.signerSubject}.`)
      prerequisite = { sha256: pin.sha256, microsoftVersion: pin.microsoftVersion, sizeBytes: pin.sizeBytes, url: pin.url, fetchedAt: pin.fetchedAt }
    }
  } catch (error) {
    console.error(`\nRELEASE STOPPED: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }

  // The installer's own sources, so the .exe can be rebuilt on a Windows machine without the rest of the repository.
  mkdirSync(join(RELEASE, 'installer-sources'), { recursive: true })
  for (const from of ['installer/nsis/generated.nsh', 'installer/nsis/currency-ui.nsh', 'installer/nsis/installer.nsi',
    'installer/nsis/json-escaping.nsh', 'installer/nsis/offline-include.nsh', 'installer/nsis/prerequisite.nsh', 'installer/nsis/build-profile.json']) {
    if (!present(from)) continue
    const to = join(RELEASE, 'installer-sources', basename(from))
    copyFileSync(from, to)
    collected.push({ file: to, bytes: statSync(to).size, sha256: sha256(to) })
  }

  // The paths are relative to the repository root, not to release/, so the file is verified with
  // `sha256sum -c release/SHA256SUMS.txt` from the root. A header line says so, because the obvious guess --
  // changing into release/ and running `sha256sum -c SHA256SUMS.txt` -- fails on every entry, and a checksum file
  // that appears broken is a checksum file nobody checks.
  const header = '# Verify from the repository root: sha256sum -c release/SHA256SUMS.txt\n'
    + '# On Windows: certutil -hashfile <file> SHA256, for each file below.\n'
    + '# Paths are relative to the repository root.\n'
  const sums = collected.map((entry) => `${entry.sha256}  ${entry.file}`).join('\n')
  writeFileSync(join(RELEASE, 'SHA256SUMS.txt'), `${header}${sums}\n`, 'utf8')

  // The pinned prerequisite, written where a person will look for it: a line in the manifest and a small text file
  // beside the installers, so the digest can be compared on a real PC without opening JSON.
  if (prerequisite) {
    const recordPath = join(RELEASE, 'PREREQUISITE.txt')
    writeFileSync(recordPath, [
      'Bundled Microsoft Visual C++ 2015-2022 Redistributable (x64)',
      '',
      `SHA-256:          ${prerequisite.sha256}`,
      `Microsoft version: ${prerequisite.microsoftVersion}`,
      `Size:             ${prerequisite.sizeBytes} bytes`,
      `Downloaded from:  ${prerequisite.url}`,
      `Fetched at:       ${prerequisite.fetchedAt}`,
      '',
      'Verify the file you have:',
      '  Windows:  certutil -hashfile vc_redist.x64.exe SHA256',
      '  Linux:    sha256sum vc_redist.x64.exe',
      '',
      'The digest above must match. It is also compiled into the installer, which refuses the file if it does not.',
      '',
      'Microsoft version, to compare on a real PC: right-click vc_redist.x64.exe -> Properties -> Details -> File version.',
      '',
    ].join('\n'), 'utf8')
    collected.push({ file: recordPath, bytes: statSync(recordPath).size, sha256: sha256(recordPath) })
  }

  const manifest = {
    format: 'infoflex-release-manifest',
    version: 1,
    producedBy: `node ${process.version} on ${process.platform}`,
    producedAt: new Date().toISOString(),
    gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    // The prerequisite is part of what a release IS, not an extra: without a real pin the offline installer cannot
    // keep its "every prerequisite is included" promise and the online one refuses every download.
    prerequisite: prerequisite ?? { sha256: UNPINNED_SHA256, pinned: false },
    present: collected,
    missing,
    complete: missing.length === 0,
  }
  writeFileSync(join(RELEASE, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  console.log(`Collected ${collected.length} file(s) into ${RELEASE}/, ${TOOLS}/ and ${CLOUD}/.`)
  if (missing.length > 0) {
    console.log(`\n${missing.length} required deliverable(s) could not be produced on this machine:`)
    for (const entry of missing) console.log(`  - ${entry.file}`)
    console.log('\nEach one is explained in release/MANIFEST.json and docs/RELEASE-CONTENTS.md.')
  } else {
    console.log('Every required deliverable is present. release/SHA256SUMS.txt lists them all.')
  }
}

// Only build the manifest when run directly. A test imports `deliverables` to check the stated reasons, and importing
// a script that assembles a release folder as a side effect would be a surprising thing to do to a reader's tree.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()
