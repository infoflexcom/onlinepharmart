import { readFileSync } from 'node:fs'
import { inspectAllArtefacts, formatBytes } from '../buildstudio/src/artefacts'
import { parseBuildProfile } from '../installer/src/build-profile'

/**
 * The last step of a build: look at what is on the disk and record it.
 *
 * Run by `npm run artefacts:verify`, which Build Studio's final step calls. It exits non-zero when an artefact the
 * build promised is missing, which is what turns "the installer step said it succeeded" into something the build
 * machine can actually check.
 *
 * The report is written to `dist/artefacts.json` so a vendor can send one file with a support question.
 */

const projectRoot = process.cwd()

function version(): string {
  try {
    const profile = parseBuildProfile(readFileSync('build-profile.json', 'utf8'))
    if (profile) return profile.appVersion
  } catch {
    // No profile: a development build, which uses the package version.
  }
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { version?: string }
  return manifest.version ?? '0.0.0'
}

async function main(): Promise<void> {
  const appVersion = version()
  const report = await inspectAllArtefacts(projectRoot, appVersion)

  for (const artefact of report.artefacts) {
    if (artefact.exists) {
      console.log(`  ${artefact.title}: ${formatBytes(artefact.sizeBytes)}  sha256 ${artefact.sha256}`)
    } else {
      console.log(`  ${artefact.title}: MISSING (${artefact.relativePath})`)
    }
  }

  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync('dist', { recursive: true })
  writeFileSync('dist/artefacts.json', `${JSON.stringify({ format: 'infoflex-artefacts', version: 1, appVersion, ...report }, null, 2)}\n`, 'utf8')

  if (report.missing.length > 0) {
    console.error(`\n${report.missing.length} file(s) the build promised were not produced:`)
    for (const line of report.missing) console.error(`  - ${line}`)
    process.exitCode = 1
    return
  }
  console.log(`\nAll ${report.artefacts.length} artefacts are on disk. Written to dist/artefacts.json.`)
}

void main()
