import { REQUIRED_DISK_BYTES, TOOLS, type ToolId, type ToolSpec } from './prerequisites'

/**
 * Is this computer ready to build?
 *
 * Each row is one of three states, and the brief is specific about their meaning:
 *
 *   - **green tick** — present and new enough;
 *   - **orange arrow** — missing but obtainable by clicking Install (and, for an optional tool, fine to leave);
 *   - **red cross** — missing and not obtainable automatically, or present but too old to work.
 *
 * The distinction that matters is orange versus red. An optional tool that is missing is orange with "not needed";
 * a *required* tool that cannot be downloaded is red, because the only way forward is a manual step the vendor must
 * be told about. Collapsing the two would either block a build that would have worked, or promise an install that
 * cannot happen.
 */

export type CheckState = 'ok' | 'missing-installable' | 'blocked'

export interface ToolCheck {
  id: ToolId
  title: string
  required: boolean
  state: CheckState
  /** What the row says. One sentence, no jargon. */
  message: string
  /** The version found, when there is one. */
  version: string | null
  /** Row order in the window: red first, then orange, then green, so the vendor sees what to fix. */
  rank: number
}

const RANK: Record<CheckState, number> = { blocked: 0, 'missing-installable': 1, ok: 2 }

/** Compares two dotted version strings, returning a negative/zero/positive number like a comparator. */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] => value.replace(/^v/iu, '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  const a = parse(left)
  const b = parse(right)
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/** Turns one probe result into a row. Kept pure so every branch is testable without Windows. */
export function evaluateProbe(input: {
  tool: ToolSpec
  found: boolean
  versionOutput: string | null
  canInstall: boolean
}): ToolCheck {
  const { tool, found, versionOutput, canInstall } = input
  const version = versionOutput ? versionOutput.trim().split(/\s+/u).at(-1) ?? null : null
  const base = { id: tool.id, title: tool.title, required: tool.required, version }

  if (!found) {
    if (tool.required && !canInstall) {
      return {
        ...base, state: 'blocked', rank: RANK.blocked,
        message: `${tool.title} is missing and Build Studio cannot install it for you. ${tool.acquisition.kind === 'manual' ? tool.acquisition.reason : 'Install it from the official website, then press Check again.'}`,
      }
    }
    return {
      ...base, state: 'missing-installable', rank: RANK['missing-installable'],
      message: tool.required
        ? `${tool.title} is missing. Press "Install everything that's missing".`
        : `${tool.title} is missing. It is not needed for a normal build.`,
    }
  }

  const minimum = tool.probe?.minimum
  if (minimum && version && compareVersions(version, minimum) < 0) {
    return {
      ...base, state: tool.required && !canInstall ? 'blocked' : 'missing-installable',
      rank: tool.required && !canInstall ? RANK.blocked : RANK['missing-installable'],
      message: `${tool.title} is version ${version}, which is too old. ${minimum} or newer is needed.`,
    }
  }

  return { ...base, state: 'ok', rank: RANK.ok, message: `${tool.title} is ready${version ? ` (version ${version})` : ''}.` }
}

/** Sorts rows so the ones needing attention come first. */
export function sortChecks(checks: ToolCheck[]): ToolCheck[] {
  return [...checks].sort((left, right) => left.rank - right.rank)
}

/** The one-line verdict above the list. */
export function summarise(checks: ToolCheck[]): { ready: boolean; headline: string } {
  const blocked = checks.filter((check) => check.state === 'blocked')
  const installable = checks.filter((check) => check.state === 'missing-installable' && check.required)
  if (blocked.length > 0) {
    return {
      ready: false,
      headline: `${blocked.length === 1 ? 'One thing needs' : `${blocked.length} things need`} your attention before a build can start.`,
    }
  }
  if (installable.length > 0) {
    return {
      ready: false,
      headline: `${installable.length === 1 ? 'One tool is' : `${installable.length} tools are`} missing. Press "Install everything that's missing".`,
    }
  }
  return { ready: true, headline: 'This computer is ready to build.' }
}

/** Ticked means "these parts are installed"; null means the question was not asked. */
export type PartialInstallProbe = (tool: ToolSpec) => Promise<boolean | null>

export interface SystemCheckOptions {
  /** Probes a command's version output, or null when the command is not found. */
  probe: (tool: ToolSpec) => Promise<string | null>
  /**
   * For a tool with no version command of its own (the C++ build tools), whether its parts are present.
   *
   * Optional because the honest answer needs the Windows registry, which only the Electron main process can read.
   * When it is absent the row says so and does not block the build — the build itself is the real test, and
   * refusing to start because a question could not be asked would be worse than starting and reporting accurately.
   */
  probePartialInstall?: PartialInstallProbe
  /** Bytes free on the drive the build output will be written to. */
  freeDiskBytes: () => Promise<bigint>
  /** Whether an automatic install is possible for this tool. */
  canInstall: (tool: ToolSpec) => boolean
}

export async function runSystemCheck(options: SystemCheckOptions): Promise<{ checks: ToolCheck[]; ready: boolean; headline: string }> {
  const checks: ToolCheck[] = []
  for (const tool of TOOLS) {
    if (tool.id === 'disk') {
      const free = await options.freeDiskBytes()
      const enough = free >= REQUIRED_DISK_BYTES
      checks.push({
        id: tool.id, title: tool.title, required: true, version: null,
        state: enough ? 'ok' : 'blocked', rank: enough ? RANK.ok : RANK.blocked,
        message: enough
          ? `There is ${formatGigabytes(free)} GB free, which is plenty.`
          : `There is only ${formatGigabytes(free)} GB free. Free up at least 12 GB, or choose another drive in Settings.`,
      })
      continue
    }
    if (tool.id === 'internet') {
      // Informational: an offline machine can still build, it just cannot install tools or fetch dependencies.
      checks.push({
        id: tool.id, title: tool.title, required: false, version: null,
        state: 'ok', rank: RANK.ok,
        message: 'Checked when needed. Build Studio tells you if a download fails.',
      })
      continue
    }
    if (tool.id === 'nsis') {
      // Bundled with the project; reported ready so the row exists without a download.
      checks.push({
        id: tool.id, title: tool.title, required: false, version: null,
        state: 'ok', rank: RANK.ok,
        message: tool.acquisition.kind === 'bundled' ? tool.acquisition.note : 'Ready.',
      })
      continue
    }
    if (!tool.probe) {
      // The C++ build tools have no version command of their own, so presence is either asked of the registry or
      // established by the build. It must never be reported as missing on a machine that has it: that would send a
      // vendor to reinstall 3.5 GB for nothing, and would make a ready computer look unready forever.
      const installed = options.probePartialInstall ? await options.probePartialInstall(tool) : null
      if (installed === true) {
        checks.push({
          id: tool.id, title: tool.title, required: tool.required, version: null, state: 'ok', rank: RANK.ok,
          message: `${tool.title} is installed.`,
        })
      } else if (installed === false) {
        const state: CheckState = options.canInstall(tool) ? 'missing-installable' : 'blocked'
        checks.push({
          id: tool.id, title: tool.title, required: tool.required, version: null, state, rank: RANK[state],
          message: options.canInstall(tool)
            ? `${tool.title} is not installed. Press "Install everything that's missing".`
            : `${tool.title} is not installed and cannot be installed automatically.`,
        })
      } else {
        // Unasked. Optional, and deliberately not blocking: the build is the real test.
        checks.push({
          id: tool.id, title: tool.title, required: false, version: null, state: 'ok', rank: RANK.ok,
          message: `${tool.title} is checked while building, because it has no version command of its own.`,
        })
      }
      continue
    }
    const output = await options.probe(tool)
    checks.push(evaluateProbe({ tool, found: output !== null, versionOutput: output, canInstall: options.canInstall(tool) }))
  }
  const sorted = sortChecks(checks)
  return { checks: sorted, ...summarise(sorted) }
}

export function formatGigabytes(bytes: bigint): string {
  return (Number(bytes) / (1024 ** 3)).toFixed(1)
}
