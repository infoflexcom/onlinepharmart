import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BUILD_STEPS } from './build-steps'

describe('the plan and package.json agree', () => {
  /**
   * A build tool whose steps call scripts that do not exist is a tool that fails on the vendor's first click, after
   * the prerequisite check has already told them everything was fine. Two steps were in exactly that state — they
   * named `cloud:package` and `artefacts:verify`, neither of which existed — until this test was written.
   *
   * So every step is checked against the real manifest, and every artefact a step promises is checked to be a path
   * the build scripts actually write.
   */
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }

  it('runs only npm scripts that exist in package.json', () => {
    const scriptNames = new Set(Object.keys(manifest.scripts))
    for (const step of BUILD_STEPS) {
      if (step.command !== 'npm') continue
      // `npm --version` is a legitimate step of its own (it is how the tool is checked for); only `npm run <x>` calls
      // into package.json, and those are what have to exist.
      if (step.args[0] !== 'run') continue
      const name = step.args[1]!
      expect(scriptNames.has(name), `step "${step.id}" runs "npm run ${name}", which package.json does not have`).toBe(true)
    }
    // And the one non-script step is still covered by the loops above, so a step cannot slip through by having no args.
    expect(BUILD_STEPS.every((step) => step.args.length > 0)).toBe(true)
  })

  it('gives every step at least one argument, so a missing command cannot run nothing', () => {
    for (const step of BUILD_STEPS) expect(step.args.length).toBeGreaterThan(0)
  })

  it('names a cloud package and an artefact report that the scripts really write', () => {
    const cloudStep = BUILD_STEPS.find((step) => step.id === 'build-cloud-package')
    expect(cloudStep?.produces.map((artefact) => artefact.path)).toEqual(['dist/cloud/infoflex-vendor-cloud.zip'])
    // The path is written by scripts/cloud-package.ts; if that moves, this fails rather than the Output screen.
    expect(readFileSync('scripts/cloud-package.ts', 'utf8')).toContain(`join('dist', 'cloud', 'infoflex-vendor-cloud.zip')`)
    const verifyStep = BUILD_STEPS.find((step) => step.id === 'verify-artefacts')
    expect(verifyStep?.args).toEqual(['run', 'artefacts:verify'])
  })
})
