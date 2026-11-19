import { describe, expect, it } from 'vitest'
import {
  compareVersions, evaluateProbe, formatGigabytes, runSystemCheck, sortChecks, summarise, type ToolCheck,
} from './system-check'
import { REQUIRED_DISK_BYTES, findTool } from './prerequisites'

/**
 * The system check's three states, which the brief defines by what they mean to the vendor:
 * a green tick (ready), an orange arrow (missing but installable by clicking), and a red cross (blocked).
 *
 * The distinction between the last two is the whole point of the screen. An optional tool that is absent must not
 * block a build, and a required tool that cannot be installed automatically must be red rather than promising an
 * install that will never happen.
 */

describe('comparing versions', () => {
  it('compares dotted versions numerically, not as text', () => {
    // The classic bug: "v9.0.0" > "v20.0.0" as strings, so an old Node would look new enough.
    expect(compareVersions('v20.18.1', 'v20.0.0')).toBeGreaterThan(0)
    expect(compareVersions('v9.0.0', 'v20.0.0')).toBeLessThan(0)
    expect(compareVersions('v20.0.0', 'v20.0.0')).toBe(0)
    expect(compareVersions('20.1', '20.1.0')).toBe(0)
    expect(compareVersions('v18.19.0', 'v20.0.0')).toBeLessThan(0)
  })

  it('treats a missing segment as zero rather than NaN', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(compareVersions('1.2.1', '1.2')).toBeGreaterThan(0)
  })
})

describe('one tool, three outcomes', () => {
  const node = findTool('nodejs')!

  it('is a green tick when present and new enough', () => {
    const check = evaluateProbe({ tool: node, found: true, versionOutput: 'v20.18.1', canInstall: true })
    expect(check.state).toBe('ok')
    expect(check.message).toMatch(/ready/iu)
    expect(check.version).toBe('v20.18.1')
  })

  it('is an orange arrow when missing but installable', () => {
    const check = evaluateProbe({ tool: node, found: false, versionOutput: null, canInstall: true })
    expect(check.state).toBe('missing-installable')
    expect(check.message).toMatch(/Install everything that's missing/iu)
  })

  it('is a red cross when missing and not installable', () => {
    const check = evaluateProbe({ tool: node, found: false, versionOutput: null, canInstall: false })
    expect(check.state).toBe('blocked')
    expect(check.message).toMatch(/cannot install it for you/iu)
  })

  it('spots an old version and says which version is needed', () => {
    const check = evaluateProbe({ tool: node, found: true, versionOutput: 'v18.19.0', canInstall: true })
    expect(check.state).toBe('missing-installable')
    expect(check.message).toMatch(/too old/iu)
    expect(check.message).toContain('v20.0.0')
  })

  it('does not block a build over an optional tool', () => {
    const git = findTool('git')!
    const check = evaluateProbe({ tool: git, found: false, versionOutput: null, canInstall: false })
    expect(check.required).toBe(false)
    // Absent and unobtainable, but optional: still not a red cross, because it is not needed.
    expect(check.state).not.toBe('blocked')
    expect(check.message).toMatch(/not needed/iu)
  })
})

describe('ordering and the verdict', () => {
  const row = (state: ToolCheck['state'], required: boolean, id: string): ToolCheck => ({
    id: id as ToolCheck['id'], title: id, required, state, message: id, version: null,
    rank: state === 'blocked' ? 0 : state === 'missing-installable' ? 1 : 2,
  })

  it('puts what needs fixing first', () => {
    const sorted = sortChecks([row('ok', true, 'a'), row('blocked', true, 'b'), row('missing-installable', true, 'c')])
    expect(sorted.map((check) => check.state)).toEqual(['blocked', 'missing-installable', 'ok'])
  })

  it('says the computer is ready only when nothing required is outstanding', () => {
    expect(summarise([row('ok', true, 'node'), row('ok', true, 'vs')])).toEqual({
      ready: true, headline: 'This computer is ready to build.',
    })
    // An optional tool that is missing does not stop a build.
    expect(summarise([row('ok', true, 'node'), row('missing-installable', false, 'git')]).ready).toBe(true)
  })

  it('names the next action rather than only the problem', () => {
    const blocked = summarise([row('blocked', true, 'vs')])
    expect(blocked.ready).toBe(false)
    expect(blocked.headline).toMatch(/attention/iu)

    const installable = summarise([row('missing-installable', true, 'node')])
    expect(installable.ready).toBe(false)
    expect(installable.headline).toMatch(/Install everything that's missing/iu)
  })

  it('counts correctly in each wording', () => {
    expect(summarise([row('blocked', true, 'a')]).headline).toMatch(/^One thing needs/iu)
    expect(summarise([row('blocked', true, 'a'), row('blocked', true, 'b')]).headline).toMatch(/^2 things need/iu)
    expect(summarise([row('missing-installable', true, 'a')]).headline).toMatch(/^One tool is/iu)
    expect(summarise([row('missing-installable', true, 'a'), row('missing-installable', true, 'b')]).headline)
      .toMatch(/^2 tools are/iu)
  })
})

describe('a whole check against a described machine', () => {
  it('reports a ready machine as ready', async () => {
    const result = await runSystemCheck({
      probe: async (tool) => (tool.id === 'python' || tool.id === 'git' ? null : tool.id === 'nodejs' ? 'v20.18.1' : '10.0.0'),
      freeDiskBytes: async () => REQUIRED_DISK_BYTES * 2n,
      canInstall: () => true,
      probePartialInstall: async () => true,
    })
    expect(result.ready).toBe(true)
    expect(result.checks.some((check) => check.state === 'blocked')).toBe(false)
  })

  it('reports a nearly-full disk as blocked, with the amount free', async () => {
    const result = await runSystemCheck({
      probe: async () => 'v20.18.1',
      freeDiskBytes: async () => 2n * 1024n * 1024n * 1024n,
      canInstall: () => true,
    })
    expect(result.ready).toBe(false)
    const disk = result.checks.find((check) => check.id === 'disk')!
    expect(disk.state).toBe('blocked')
    expect(disk.message).toContain('2.0 GB')
    expect(disk.message).toMatch(/12 GB/iu)
  })

  it('reports the C++ tools by the registry answer, and blocks only when they are absent and unobtainable', async () => {
    const base = { probe: async () => 'v20.18.1', freeDiskBytes: async () => REQUIRED_DISK_BYTES * 2n }
    const installed = await runSystemCheck({ ...base, canInstall: () => true, probePartialInstall: async () => true })
    expect(installed.checks.find((c) => c.id === 'vs-build-tools')!.state).toBe('ok')
    expect(installed.ready).toBe(true)

    const absent = await runSystemCheck({ ...base, canInstall: () => true, probePartialInstall: async () => false })
    const row = absent.checks.find((c) => c.id === 'vs-build-tools')!
    expect(row.state).toBe('missing-installable')
    expect(row.message).toMatch(/not installed/iu)

    const unobtainable = await runSystemCheck({ ...base, canInstall: () => false, probePartialInstall: async () => false })
    expect(unobtainable.checks.find((c) => c.id === 'vs-build-tools')!.state).toBe('blocked')
  })

  it('does not block a build when the C++ tools question cannot be asked', async () => {
    // Refusing to start because a question could not be answered is worse than starting and reporting accurately.
    const result = await runSystemCheck({
      probe: async () => 'v20.18.1', freeDiskBytes: async () => REQUIRED_DISK_BYTES * 2n, canInstall: () => true,
    })
    expect(result.checks.find((c) => c.id === 'vs-build-tools')!.state).toBe('ok')
    expect(result.ready).toBe(true)
  })

  it('never downloads anything itself: NSIS is reported from the bundle', async () => {
    const result = await runSystemCheck({
      probe: async () => 'v20.18.1', freeDiskBytes: async () => REQUIRED_DISK_BYTES * 2n, canInstall: () => true,
    })
    const nsis = result.checks.find((check) => check.id === 'nsis')!
    expect(nsis.message).toMatch(/Bundled|included/iu)
  })

  it('formats disk sizes to one decimal, as the row shows them', () => {
    expect(formatGigabytes(REQUIRED_DISK_BYTES * 2n)).toBe('24.0')
    expect(formatGigabytes(1024n * 1024n * 1024n)).toBe('1.0')
  })
})
