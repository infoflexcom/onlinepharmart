/**
 * The tools a build machine needs, what each one is for, and how to get it.
 *
 * Build Studio's promise is that a non-programmer can prepare a Windows machine by clicking. That makes two things
 * non-negotiable, and both are enforced here in plain data rather than in the UI:
 *
 *   1. **Every download is from a hard-coded official address.** There is no function here that takes a URL. A
 *      caller can name a tool; it cannot name an address, which means a typo or a copied link cannot redirect the
 *      download to a mirror somebody else controls.
 *   2. **Every tool states whether it is actually required.** The brief says "Git, only if truly needed". Build
 *      Studio does not need Git to build: it copies files and runs npm. Listing an unnecessary tool as required
 *      would send a vendor to install something for no reason, and worse, would make a machine look "not ready"
 *      when it is.
 *
 * The system check itself (does this machine have Node 20?) is a separate function, because the answer depends on
 * the machine and this file is the part that must never change.
 */

export type ToolId =
  | 'nodejs'
  | 'npm'
  | 'vs-build-tools'
  | 'python'
  | 'git'
  | 'nsis'
  | 'internet'
  | 'disk'

/** How a missing tool is obtained. `bundled` means the build toolchain supplies it, so nothing is downloaded. */
export type Acquisition =
  | { kind: 'bundled'; note: string }
  | { kind: 'installed-with'; tool: ToolId }
  | {
    kind: 'download'
    /** The official page a person is sent to when the automatic install cannot run. */
    page: string
    /** The exact file, when there is one. Only allowlisted hosts, and only over HTTPS. */
    url: string
    /** The publisher the Authenticode signature must name, when it is a Windows executable. */
    publisher: string
    /** Arguments that make the installer quiet — no windows, no prompts, no terminal. */
    silentArguments: string[]
    /** Shown in the progress list before the download starts. */
    approximateSizeMb: number
  }
  | { kind: 'manual'; reason: string }

export interface ToolSpec {
  id: ToolId
  title: string
  /** What breaks without it, in the vendor's language rather than a developer's. */
  why: string
  required: boolean
  acquisition: Acquisition
  /** How to recognise a working copy: the command to run and what its version output looks like. */
  probe: { command: string; args: string[]; minimum?: string } | null
}

/**
 * The official hosts any automatic download may touch.
 *
 * Kept as a literal list for the same reason the installer's is: a check that derives its allowlist from the table
 * it is checking proves nothing.
 */
export const OFFICIAL_DOWNLOAD_HOSTS: readonly string[] = [
  'nodejs.org',
  'aka.ms',
  'download.microsoft.com',
  'download.visualstudio.microsoft.com',
  'www.python.org',
  'python.org',
]

export const TOOLS: readonly ToolSpec[] = [
  {
    id: 'nodejs',
    title: 'Node.js 20 or newer',
    why: 'Runs the application and its build scripts.',
    required: true,
    acquisition: {
      kind: 'download',
      page: 'https://nodejs.org/en/download',
      url: 'https://nodejs.org/dist/v20.18.1/node-v20.18.1-x64.msi',
      publisher: 'OpenJS Foundation',
      silentArguments: ['/qn', '/norestart'],
      approximateSizeMb: 30,
    },
    probe: { command: 'node', args: ['--version'], minimum: 'v20.0.0' },
  },
  {
    id: 'npm',
    title: 'npm',
    why: 'Installs the project dependencies. It comes with Node.js, so a missing npm means a broken Node install.',
    required: true,
    acquisition: { kind: 'installed-with', tool: 'nodejs' },
    probe: { command: 'npm', args: ['--version'] },
  },
  {
    id: 'vs-build-tools',
    title: 'Visual Studio Build Tools with "Desktop development with C++"',
    why: 'Compiles the native database module. Without it the app builds but will not start on a customer PC.',
    required: true,
    acquisition: {
      kind: 'download',
      page: 'https://visualstudio.microsoft.com/visual-cpp-build-tools/',
      // The bootstrapper downloads the real payload itself, from Microsoft.
      url: 'https://aka.ms/vs/17/release/vs_buildtools.exe',
      publisher: 'Microsoft Corporation',
      // --quiet with a workload: no UI at all. --wait would block; Build Studio watches the process instead.
      silentArguments: [
        '--quiet', '--wait', '--norestart', '--nocache',
        '--add', 'Microsoft.VisualStudio.Workload.VCTools',
        '--includeRecommended',
      ],
      approximateSizeMb: 3_500,
    },
    probe: null,
  },
  {
    id: 'python',
    title: 'Python 3',
    why: 'A few of the build tools prefer it. If it is missing the build uses a bundled alternative; install it only if a build asks.',
    required: false,
    acquisition: {
      kind: 'download',
      page: 'https://www.python.org/downloads/windows/',
      url: 'https://www.python.org/ftp/python/3.12.7/python-3.12.7-amd64.exe',
      publisher: 'Python Software Foundation',
      silentArguments: ['/quiet', 'InstallAllUsers=1', 'PrependPath=1', 'Include_test=0'],
      approximateSizeMb: 25,
    },
    probe: { command: 'python', args: ['--version'] },
  },
  {
    id: 'git',
    title: 'Git',
    why: 'Only needed to fetch a project from a source repository. A project folder copied onto this computer does not need it.',
    required: false,
    acquisition: {
      kind: 'download',
      page: 'https://git-scm.com/download/win',
      url: 'https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/Git-2.47.1-64-bit.exe',
      publisher: 'Johannes Schindelin',
      silentArguments: ['/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-'],
      approximateSizeMb: 60,
    },
    probe: { command: 'git', args: ['--version'] },
  },
  {
    id: 'nsis',
    title: 'NSIS (the installer maker)',
    why: 'Turns the installer script into Infoflex Setup.exe. It comes with the project, so nothing is downloaded.',
    required: false,
    acquisition: {
      // electron-builder ships its own makensis; this is why the check is "is it available", not "install NSIS".
      kind: 'bundled',
      note: 'Bundled with the project. Build Studio does not download it.',
    },
    probe: null,
  },
  {
    id: 'internet',
    title: 'Internet connection',
    why: 'Needed to install missing tools and to fetch the project dependencies the first time.',
    required: false,
    acquisition: { kind: 'manual', reason: 'Nothing to install: this is the connection itself.' },
    probe: null,
  },
  {
    id: 'disk',
    title: 'Free disk space',
    why: 'About 12 GB is needed: the build tools, the project, and two installers.',
    required: true,
    acquisition: { kind: 'manual', reason: 'Free up space on this computer, or choose another drive for the build output.' },
    probe: null,
  },
]

export const REQUIRED_DISK_BYTES = 12n * 1024n * 1024n * 1024n

/** The tools that are genuinely required before a build can be attempted. */
export function requiredTools(): ToolSpec[] {
  return TOOLS.filter((tool) => tool.required)
}

/** Looks a tool up by id. Returns null rather than throwing, so a stale id in a saved log is harmless. */
export function findTool(id: string): ToolSpec | null {
  return TOOLS.find((tool) => tool.id === id) ?? null
}

export interface DownloadPlan {
  tool: ToolId
  url: string
  publisher: string
  silentArguments: string[]
}

/**
 * The download a missing tool needs, or the reason no automatic download is possible.
 *
 * The refusal cases matter more than the happy path. A tool that is `bundled` must never produce a download, a
 * tool with no official file must send the vendor to a page instead of guessing, and any URL whose host is not on
 * the allowlist must be refused even though the table above is the only source — which is redundant today and is
 * exactly the check that would catch a bad row added tomorrow.
 */
export function planDownload(
  id: ToolId,
  options: { allowlistedHosts?: readonly string[] } = {},
): { ok: true; plan: DownloadPlan } | { ok: false; reason: string; page?: string } {
  const tool = findTool(id)
  if (!tool) return { ok: false, reason: `There is no tool called "${id}".` }
  const acquisition = tool.acquisition
  if (acquisition.kind === 'bundled') {
    return { ok: false, reason: `${tool.title} is included with the project, so there is nothing to download.` }
  }
  if (acquisition.kind === 'installed-with') {
    return { ok: false, reason: `${tool.title} comes with ${findTool(acquisition.tool)?.title ?? acquisition.tool}. Install that instead.` }
  }
  if (acquisition.kind === 'manual') {
    return { ok: false, reason: acquisition.reason }
  }
  const hosts = options.allowlistedHosts ?? OFFICIAL_DOWNLOAD_HOSTS
  let host: string
  try {
    const parsed = new URL(acquisition.url)
    if (parsed.protocol !== 'https:') {
      return { ok: false, reason: `${tool.title} would be downloaded over an insecure connection, so Build Studio will not do it.`, page: acquisition.page }
    }
    host = parsed.hostname
  } catch {
    return { ok: false, reason: `${tool.title} has no valid download address.`, page: acquisition.page }
  }
  if (!hosts.includes(host)) {
    return {
      ok: false,
      reason: `${tool.title} would be downloaded from ${host}, which is not an official address. Build Studio will not do that.`,
      page: acquisition.page,
    }
  }
  return {
    ok: true,
    plan: {
      tool: tool.id,
      url: acquisition.url,
      publisher: acquisition.publisher,
      silentArguments: [...acquisition.silentArguments],
    },
  }
}
