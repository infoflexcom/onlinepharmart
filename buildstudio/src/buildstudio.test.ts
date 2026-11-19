import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  BUILD_STEPS, STEP_GROUPS, explainFailure, findStep, progressPercent, redactSecrets, stepsForGroup, totalWeight,
} from './build-steps'
import { OFFICIAL_DOWNLOAD_HOSTS, TOOLS, findTool, planDownload, requiredTools } from './prerequisites'
import {
  containsPrivateKey, generateLicenceKeyPair, keyPairProblems, publicKeyFingerprint, trustedKeysForBuild,
} from './licence-keys'
import { defaultBuildProfile, ONSITE_PERIOD_CHOICES } from '../../installer/src/build-profile'

const scratch = mkdtempSync(join(tmpdir(), 'buildstudio-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe('the tools a build machine needs', () => {
  it('lists every tool the brief names, marking Git and Python optional', () => {
    const ids = TOOLS.map((tool) => tool.id)
    for (const id of ['nodejs', 'npm', 'vs-build-tools', 'python', 'git', 'nsis', 'internet', 'disk']) {
      expect(ids).toContain(id)
    }
    // The brief says Git "only if truly needed". Build Studio copies files and runs npm, so it is not.
    expect(findTool('git')!.required).toBe(false)
    expect(findTool('python')!.required).toBe(false)
    expect(findTool('nodejs')!.required).toBe(true)
    expect(findTool('vs-build-tools')!.required).toBe(true)
  })

  it('says why each tool matters, in words a non-programmer can act on', () => {
    for (const tool of TOOLS) {
      expect(tool.why.length, tool.id).toBeGreaterThan(30)
      expect(tool.why, tool.id).not.toMatch(/^A tool\.?$/u)
    }
  })

  it('downloads only from official hosts, over HTTPS', () => {
    for (const tool of TOOLS) {
      const result = planDownload(tool.id)
      if (result.ok) {
        const host = new URL(result.plan.url).hostname
        expect(OFFICIAL_DOWNLOAD_HOSTS, tool.id).toContain(host)
        expect(new URL(result.plan.url).protocol, tool.id).toBe('https:')
        expect(result.plan.publisher.length, tool.id).toBeGreaterThan(0)
      }
    }
  })

  it('refuses a download from any host that is not allowlisted', () => {
    // The table above is the only source today, so this is checking the guard rather than the data — which is the
    // point: it is what would catch a bad row added next year.
    const result = planDownload('nodejs', { allowlistedHosts: ['example.com'] })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/not an official address/iu)
      expect(result.page).toBeTruthy()
    }
  })

  it('never plans a download for something that is bundled or comes with another tool', () => {
    const nsis = planDownload('nsis')
    expect(nsis.ok).toBe(false)
    if (!nsis.ok) expect(nsis.reason).toMatch(/included|nothing to download/iu)

    const npm = planDownload('npm')
    expect(npm.ok).toBe(false)
    if (!npm.ok) expect(npm.reason).toMatch(/comes with Node\.js/iu)

    for (const id of ['internet', 'disk'] as const) {
      const result = planDownload(id)
      expect(result.ok, id).toBe(false)
      if (!result.ok) expect(result.reason.length, id).toBeGreaterThan(10)
    }
  })

  it('installs silently, so no installer window or terminal appears', () => {
    for (const id of ['nodejs', 'vs-build-tools', 'python'] as const) {
      const result = planDownload(id)
      expect(result.ok, id).toBe(true)
      if (result.ok) {
        const args = result.plan.silentArguments.join(' ')
        expect(args, id).toMatch(/\/qn|--quiet|\/quiet/iu)
      }
    }
  })

  it('has a required set that can actually be satisfied', () => {
    const required = requiredTools()
    expect(required.length).toBeGreaterThan(0)
    // Every required tool must be obtainable, or the check could never go green.
    for (const tool of required) {
      const acquisition = tool.acquisition.kind
      expect(['download', 'installed-with', 'bundled', 'manual'], tool.id).toContain(acquisition)
    }
  })
})

describe('the build steps', () => {
  it('is one order shared by the one-click run and the single buttons', () => {
    // "Do everything" must be exactly the whole list, not a second copy of it.
    expect(STEP_GROUPS['do-everything']).toEqual(BUILD_STEPS.map((step) => step.id))
    for (const [group, ids] of Object.entries(STEP_GROUPS)) {
      for (const id of ids) expect(() => findStep(id), `${group}/${id}`).not.toThrow()
    }
  })

  it('runs the steps a group needs in the right order', () => {
    const installers = stepsForGroup('build-installers').map((step) => step.id)
    // The installer data is generated before the installer is built, and verification is last.
    expect(installers.indexOf('generate-installer-data')).toBeLessThan(installers.indexOf('build-installer-online'))
    expect(installers.indexOf('build-desktop')).toBeLessThan(installers.indexOf('build-installer-online'))
    expect(installers.at(-1)).toBe('verify-artefacts')
  })

  it('names both installers the brief requires, and the cloud package', () => {
    const artefacts = BUILD_STEPS.flatMap((step) => step.produces)
    expect(artefacts.map((a) => a.title)).toEqual(
      expect.arrayContaining(['Infoflex Setup.exe', 'Infoflex Setup Offline.exe', 'Vendor Cloud package']),
    )
  })

  it('bundles the mobile app by building it before the installers', () => {
    const ids = BUILD_STEPS.map((step) => step.id)
    expect(ids.indexOf('build-mobile')).toBeLessThan(ids.indexOf('build-installer-online'))
  })

  it('estimates progress without ever leaving 0-100', () => {
    expect(progressPercent(0, 100)).toBe(0)
    expect(progressPercent(100, 100)).toBe(100)
    expect(progressPercent(50, 0)).toBe(0)
    expect(progressPercent(-5, 100)).toBe(0)
    expect(progressPercent(150, 100)).toBe(100)
    // Integer percentages, because "47.333%" is noise in a progress label.
    expect(Number.isInteger(progressPercent(1, 3))).toBe(true)
  })

  it('rejects an unknown action rather than silently doing nothing', () => {
    expect(() => stepsForGroup('make-me-a-coffee')).toThrow(/not a Build Studio action/iu)
    expect(() => findStep('nope' as never)).toThrow(/no build step/iu)
  })

  it('gives every step a positive weight so the estimate is meaningful', () => {
    expect(totalWeight(BUILD_STEPS)).toBeGreaterThan(0)
    for (const step of BUILD_STEPS) expect(step.weight, step.id).toBeGreaterThan(0)
  })
})

describe('explaining a failure in plain words', () => {
  const step = findStep('build-installer-online')

  it('recognises the failures this project has actually hit', () => {
    const cases: Array<[string, RegExp]> = [
      ['npm ERR! code ENOTFOUND registry.npmjs.org', /reach the internet/iu],
      ['error unable to verify the first certificate', /intercepting secure connections/iu],
      ['gyp ERR! find MSBuild not found', /C\+\+ build tools/iu],
      ['Error: makensis exited with code 1', /installer maker/iu],
      ['ENOSPC: no space left on device', /out of disk space/iu],
      ['EBUSY: resource busy or locked', /being used by another program/iu],
    ]
    for (const [output, expected] of cases) {
      const explanation = explainFailure({ step, output, exitCode: 1 })
      expect(explanation.cause, output).toMatch(expected)
      expect(explanation.fixes.length, output).toBeGreaterThan(0)
      // Every fix is a sentence someone can follow, not a restatement of the error.
      for (const fix of explanation.fixes) expect(fix.length, output).toBeGreaterThan(20)
    }
  })

  it('still says something useful for an unrecognised error', () => {
    const explanation = explainFailure({ step, output: 'something entirely unexpected', exitCode: 1 })
    expect(explanation.cause).toMatch(/stopped with an error/iu)
    expect(explanation.fixes.join(' ')).toMatch(/Retry/iu)
    expect(explanation.fixes.join(' ')).toMatch(/Copy error details/iu)
  })

  it('treats a failing test as a refusal to package a broken app', () => {
    const explanation = explainFailure({ step: findStep('test'), output: 'FAIL 1 test', exitCode: 1 })
    expect(explanation.cause).toMatch(/found a problem/iu)
    expect(explanation.cause).toMatch(/stopped/iu)
  })
})

describe('secrets never reach a log', () => {
  it('redacts a secret wherever it appears, in any case', () => {
    const secret = 'zq7-Fictional-Guard-Sample-9182'
    const text = `before ${secret} middle ${secret.toUpperCase()} after`
    const redacted = redactSecrets(text, [secret])
    expect(redacted).not.toContain(secret)
    expect(redacted).not.toContain(secret.toUpperCase())
    expect(redacted.match(/\[redacted\]/gu)).toHaveLength(2)
    expect(redacted).toMatch(/^before .* middle .* after$/u)
  })

  it('ignores a very short secret, which would redact half the log', () => {
    expect(redactSecrets('abc abc', ['ab'])).toBe('abc abc')
  })
})

describe('the licence signing keys', () => {
  it('generates an Ed25519 pair whose halves match', () => {
    const pair = generateLicenceKeyPair('vendor-key-2026')
    expect(pair.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/u)
    expect(pair.publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----/u)
    expect(keyPairProblems({ privateKeyPem: pair.privateKeyPem, publicKeyPem: pair.publicKeyPem })).toEqual([])
    expect(publicKeyFingerprint(pair.publicKeyPem)).toBe(pair.publicKeyFingerprint)
  })

  it('catches a public key that does not belong to the private key', () => {
    // The failure this prevents is silent for months: every licence fails to verify at a customer's shop.
    const first = generateLicenceKeyPair('key-one')
    const second = generateLicenceKeyPair('key-two')
    const problems = keyPairProblems({ privateKeyPem: first.privateKeyPem, publicKeyPem: second.publicKeyPem })
    expect(problems).toHaveLength(1)
    expect(problems[0]!.field).toBe('publicKey')
    expect(problems[0]!.message).toMatch(/does not belong/iu)
  })

  it('rejects rubbish in either half rather than passing it on', () => {
    expect(keyPairProblems({ privateKeyPem: 'nope', publicKeyPem: 'nope' }).map((p) => p.field).sort())
      .toEqual(['privateKey', 'publicKey'])
  })

  it('validates the key name, because it ends up in tokens and file names', () => {
    for (const bad of ['', 'AB', 'Has Space', 'UPPER', '-leading']) {
      expect(() => generateLicenceKeyPair(bad), bad).toThrow(/key name/iu)
    }
  })

  it('embeds only the public half in a build', () => {
    const pair = generateLicenceKeyPair('vendor-key-2026')
    const trusted = trustedKeysForBuild(pair)
    expect(Object.keys(trusted)).toEqual(['vendor-key-2026'])
    const embedded = JSON.stringify(trusted)
    expect(embedded).toContain('BEGIN PUBLIC KEY')
    // The one assertion this whole file exists for.
    expect(embedded).not.toContain('PRIVATE KEY')
    expect(containsPrivateKey(embedded)).toBe(false)
    expect(containsPrivateKey(pair.privateKeyPem)).toBe(true)
  })
})

describe('the settings Build Studio embeds in a build', () => {
  it('offers exactly the on-site periods the brief lists, defaulting to no limit', () => {
    expect(ONSITE_PERIOD_CHOICES).toEqual([null, 1, 2, 3, 5, 10])
    expect(defaultBuildProfile().maximumOnsitePeriodYears).toBeNull()
  })

  it('defaults the build currency to Naira', () => {
    expect(defaultBuildProfile().defaultCurrencyCode).toBe('NGN')
  })
})
