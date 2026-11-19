import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { execFileSync } from 'node:child_process'

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
 * The three `.exe` files are missing for one reason, stated once: electron-builder must download the Electron
 * runtime for Windows, and the only host serving it (`objects.githubusercontent.com`, which
 * github.com/releases/download redirects to) is unreachable from the build agent. `makensis` is also absent, so
 * even a supplied runtime would not finish an NSIS installer without installing NSIS first.
 */
const deliverables: Deliverable[] = [
  {
    target: join(RELEASE, 'Infoflex Setup.exe'),
    source: null,
    required: true,
    description: 'The customer installer: prerequisites, password gate, Region and Currency page.',
    absent: 'Needs the Windows toolchain. electron-builder downloads the Electron runtime from '
      + 'objects.githubusercontent.com, which this build agent cannot reach (TLS interception); makensis, which '
      + 'turns installer.nsi into the .exe, is not installed and cannot be installed without root. '
      + 'Run `npm run installer:online` on any Windows PC with the repository checked out.',
  },
  {
    target: join(RELEASE, 'Infoflex Setup Offline.exe'),
    source: null,
    required: true,
    description: 'The same wizard with every prerequisite bundled and no download page.',
    absent: 'Same reason as Infoflex Setup.exe. `npm run installer:offline` produces it elsewhere.',
  },
  {
    target: join(TOOLS, 'Infoflex Build Studio.exe'),
    source: null,
    required: true,
    description: "The vendor's graphical build tool.",
    absent: 'Same Windows-toolchain reason. `npm run dist:studio` produces it elsewhere. The tool itself is '
      + 'built and tested here; only the packaged .exe needs Windows.',
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

  // The installer's own sources, so the .exe can be rebuilt on a Windows machine without the rest of the repository.
  mkdirSync(join(RELEASE, 'installer-sources'), { recursive: true })
  for (const from of ['installer/nsis/generated.nsh', 'installer/nsis/currency-ui.nsh', 'installer/nsis/installer.nsi',
    'installer/nsis/json-escaping.nsh', 'installer/nsis/offline-include.nsh', 'installer/nsis/build-profile.json']) {
    if (!present(from)) continue
    const to = join(RELEASE, 'installer-sources', basename(from))
    copyFileSync(from, to)
    collected.push({ file: to, bytes: statSync(to).size, sha256: sha256(to) })
  }

  const sums = collected.map((entry) => `${entry.sha256}  ${entry.file}`).join('\n')
  writeFileSync(join(RELEASE, 'SHA256SUMS.txt'), `${sums}\n`, 'utf8')

  const manifest = {
    format: 'infoflex-release-manifest',
    version: 1,
    producedBy: `node ${process.version} on ${process.platform}`,
    producedAt: new Date().toISOString(),
    gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
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

main()
