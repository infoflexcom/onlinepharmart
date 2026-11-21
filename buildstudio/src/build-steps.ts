/**
 * What "One-click: do everything" actually does, as an ordered list of steps.
 *
 * This is the part of Build Studio that must be right: everything else is a window around it. Keeping the steps as
 * data rather than as a script in the UI means the one-click run and the individual buttons run the *same* steps,
 * so "it worked when I pressed them one at a time" cannot diverge from "it failed when I pressed Do everything".
 *
 * Two decisions worth stating:
 *
 *   - **Steps declare what they produce.** The output screen lists artefacts by asking the completed steps, so a
 *     file that was never built cannot appear in the list, and a vendor copying to USB copies what exists.
 *   - **Every failure maps to a sentence a non-programmer can act on.** `explainFailure` is not decoration: the raw
 *     stderr of npm or electron-builder is unreadable to the person this tool is for, and "ELIFECYCLE errno 1" tells
 *     nobody what to do. The raw text is still kept, because a support call needs it.
 */

export type StepId =
  | 'check-tools'
  | 'install-dependencies'
  | 'fetch-prerequisite'
  | 'generate-installer-data'
  | 'typecheck'
  | 'test'
  | 'build-desktop'
  | 'build-mobile'
  | 'build-installer-online'
  | 'build-installer-offline'
  | 'build-cloud-package'
  | 'verify-artefacts'

export interface ArtefactSpec {
  /** Path relative to the project root. `{version}` is replaced from the build profile. */
  path: string
  /** What the vendor calls it. */
  title: string
}

export interface StepSpec {
  id: StepId
  title: string
  /** Shown under the title while it runs, so the progress window is never a bare bar. */
  detail: string
  /** The program and arguments, run in the project root with no shell and no visible window. */
  command: string
  args: string[]
  /** Rough share of the total time, used only for the percentage estimate. */
  weight: number
  produces: ArtefactSpec[]
}

/** The commands. `npm` is resolved through its `.cmd` on Windows by the process runner, not by a shell here. */
const NPM = 'npm'

export const BUILD_STEPS: readonly StepSpec[] = [
  {
    id: 'check-tools',
    title: 'Checking this computer',
    detail: 'Making sure the tools a build needs are installed.',
    command: NPM, args: ['--version'], weight: 1, produces: [],
  },
  {
    id: 'install-dependencies',
    title: 'Installing project files',
    detail: 'Copying in the libraries the application uses. This is the slow one the first time.',
    command: NPM, args: ['ci', '--no-audit', '--no-fund'], weight: 30, produces: [],
  },
  {
    // Before the installer data is generated, because the digest it fetches is written into that data. Running it
    // after would produce an installer pinned to the previous digest -- or to the all-zeros placeholder.
    id: 'fetch-prerequisite',
    title: 'Fetching the Microsoft component',
    detail: 'Downloading the official Visual C++ runtime, checking Microsoft signed it, and recording its fingerprint.',
    command: NPM, args: ['run', 'release:prerequisite'], weight: 4, produces: [],
  },
  {
    id: 'generate-installer-data',
    title: 'Preparing the installer data',
    detail: 'Writing the currency list and password hash the installer uses.',
    command: NPM, args: ['run', 'installer:script'], weight: 2, produces: [],
  },
  {
    id: 'typecheck',
    title: 'Checking the code',
    detail: 'Looking for mistakes before anything is packaged.',
    command: NPM, args: ['run', 'typecheck'], weight: 8, produces: [],
  },
  {
    id: 'test',
    title: 'Running the tests',
    detail: 'Checking the shop, the money and the licence behave correctly.',
    command: NPM, args: ['test', '--', '--reporter=dot'], weight: 20, produces: [],
  },
  {
    id: 'build-desktop',
    title: 'Building the desktop app',
    detail: 'Compiling the application that runs on the shop computer.',
    command: NPM, args: ['run', 'build'], weight: 14, produces: [],
  },
  {
    id: 'build-mobile',
    title: 'Building the Admin mobile app',
    detail: 'Building the phone app that gets bundled inside the desktop app.',
    command: NPM, args: ['run', 'build:mobile'], weight: 5, produces: [],
  },
  {
    id: 'build-installer-online',
    title: 'Building Infoflex Setup.exe',
    detail: 'The installer that downloads a missing component from Microsoft.',
    command: NPM, args: ['run', 'installer:online'], weight: 10,
    produces: [{ path: 'dist/online/Infoflex Setup.exe', title: 'Infoflex Setup.exe' }],
  },
  {
    id: 'build-installer-offline',
    title: 'Building Infoflex Setup Offline.exe',
    detail: 'The installer for shops with no internet, with everything inside it.',
    command: NPM, args: ['run', 'installer:offline'], weight: 10,
    produces: [{ path: 'dist/offline/Infoflex Setup Offline.exe', title: 'Infoflex Setup Offline.exe' }],
  },
  {
    id: 'build-cloud-package',
    title: 'Building the Vendor Cloud package',
    detail: 'Packing the licence server and its deployment guide for upload.',
    command: NPM, args: ['run', 'cloud:package'], weight: 6,
    produces: [{ path: 'dist/cloud/infoflex-vendor-cloud.zip', title: 'Vendor Cloud package' }],
  },
  {
    id: 'verify-artefacts',
    title: 'Checking the result',
    detail: 'Opening each built file and recording its size and fingerprint.',
    command: NPM, args: ['run', 'artefacts:verify'], weight: 2, produces: [],
  },
]

/** The single buttons on the Build screen, each of which runs a contiguous slice of the full list. */
export const STEP_GROUPS: Record<string, StepId[]> = {
  'install-project-files': ['install-dependencies'],
  'run-tests': ['typecheck', 'test'],
  'test-run-app': ['build-desktop'],
  'build-mobile-app': ['generate-installer-data', 'build-mobile'],
  'build-installers': ['fetch-prerequisite', 'generate-installer-data', 'build-desktop', 'build-mobile', 'build-installer-online', 'build-installer-offline', 'verify-artefacts'],
  'build-cloud-package': ['build-cloud-package'],
  'do-everything': BUILD_STEPS.map((step) => step.id),
}

export function findStep(id: StepId): StepSpec {
  const step = BUILD_STEPS.find((candidate) => candidate.id === id)
  if (!step) throw new Error(`There is no build step called "${id}".`)
  return step
}

/** Expands a group id (a button) into the ordered steps it runs. */
export function stepsForGroup(group: string): StepSpec[] {
  const ids = STEP_GROUPS[group]
  if (!ids) throw new Error(`"${group}" is not a Build Studio action.`)
  return ids.map(findStep)
}

/**
 * The percentage for an estimate.
 *
 * Deliberately an estimate and labelled as one: weights are guesses, and a progress bar that claims to be exact
 * while installing Visual Studio Build Tools would sit at 47% for twenty minutes and look broken. The real
 * progress shown to the vendor is "step 4 of 11", which is true.
 */
export function progressPercent(completedWeights: number, totalWeights: number): number {
  if (totalWeights <= 0) return 0
  const percent = Math.floor((completedWeights / totalWeights) * 100)
  return Math.max(0, Math.min(100, percent))
}

export function totalWeight(steps: readonly StepSpec[]): number {
  return steps.reduce((sum, step) => sum + step.weight, 0)
}

export interface FailureExplanation {
  /** One sentence a non-programmer can act on. */
  cause: string
  /** Concrete things to try, in order. */
  fixes: string[]
}

/**
 * Turns a failed command into something the vendor can act on.
 *
 * The patterns are from real failures this project has hit, not invented ones: a missing network, a locked file
 * from a running copy of the app, a native module that needed the C++ tools, and the NSIS download failing because
 * the machine is behind an intercepting proxy.
 */
export function explainFailure(input: {
  step: StepSpec
  output: string
  exitCode: number | null
}): FailureExplanation {
  const text = input.output
  const has = (pattern: RegExp): boolean => pattern.test(text)

  if (has(/EACCES|EPERM|EBUSY|being used by another process/iu)) {
    return {
      cause: 'A file Build Studio needs is being used by another program.',
      fixes: [
        'Close Infoflex and Build Studio, then press Retry.',
        'If the project folder is inside OneDrive or Dropbox, pause the sync and try again.',
      ],
    }
  }
  if (has(/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|getaddrinfo|network|ECONNREFUSED/iu)) {
    return {
      cause: 'Build Studio could not reach the internet, which it needs to fetch the project libraries.',
      fixes: [
        'Check this computer is online, then press Retry.',
        'If this computer uses a company proxy, ask IT to allow npm and nsis downloads.',
      ],
    }
  }
  if (has(/unable to verify the first certificate|SELF_SIGNED_CERT|CERT_HAS_EXPIRED/iu)) {
    return {
      cause: 'Something on this network is intercepting secure connections, so downloads cannot be verified.',
      fixes: [
        'Ask IT whether a proxy inspects HTTPS traffic, and whether it can be turned off for this computer.',
        'Try a different network, such as a phone hotspot, then press Retry.',
      ],
    }
  }
  if (has(/gyp|MSBuild|vcbuild|node-gyp|Visual Studio/iu)) {
    return {
      cause: 'The compiled database module could not be built because the C++ build tools are missing or incomplete.',
      fixes: [
        'Press "Check my computer", then install the Visual Studio Build Tools it offers.',
        'In the installer, make sure "Desktop development with C++" is ticked.',
      ],
    }
  }
  if (has(/makensis|nsis/iu)) {
    return {
      cause: 'The installer maker could not be downloaded, so the installers were not produced.',
      fixes: [
        'Check this computer is online and press Retry. The installer maker is downloaded once and kept.',
        'If it keeps failing, the Vendor Cloud package and the app can still be built: press "Build project files" instead.',
      ],
    }
  }
  if (has(/ENOSPC|no space left/iu)) {
    return {
      cause: 'This computer has run out of disk space.',
      fixes: [
        'Free at least 12 GB, or choose another drive for the build output in Settings, then press Retry.',
      ],
    }
  }
  if (input.step.id === 'test' && input.exitCode !== 0) {
    return {
      cause: 'One of the automatic tests found a problem, so Build Studio stopped rather than packaging a broken app.',
      fixes: [
        'Press "Copy error details" and send them to the person who maintains Infoflex.',
        'The list of failing tests is in the details below; the first one is usually the cause.',
      ],
    }
  }
  return {
    cause: `${input.step.title} stopped with an error. The details are below.`,
    fixes: [
      'Press Retry once: a temporary problem such as a dropped connection often clears.',
      'If it happens again, press "Copy error details" and send them for support.',
    ],
  }
}

/** The line that must never appear in a log: the master password is never passed to a child process or printed. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let result = text
  for (const secret of secrets) {
    if (secret.length < 8) continue
    result = result.split(secret).join('[redacted]')
    // Case-insensitive pass, because a shell echo might not preserve case.
    const pattern = new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'giu')
    result = result.replace(pattern, '[redacted]')
  }
  return result
}
