/**
 * The System Check page's rules.
 *
 * The brief is specific about the honest reporting: a green tick only when the thing is genuinely present, an
 * orange arrow when it is missing but downloadable, a red cross when the machine cannot run the app at all or
 * when a missing item cannot be fixed automatically. That means the *status* has to be computed from a real
 * observation, not from a hope, and the download size has to be a real number so the customer is not surprised.
 */

export type CheckStatus = 'ok' | 'missing' | 'blocked' | 'info'

export interface CheckObservation {
  /** The raw fact the installer managed to observe, or null when it could not look. */
  detectedVersion: string | null
  /** False when the probe itself failed (no registry access, WMI off, and so on). */
  probeSucceeded: boolean
}

export interface SystemRequirement {
  id: string
  title: string
  /** What the machine needs, in the customer's words. */
  required: string
  /** Download size shown next to a missing item, or null when nothing is downloaded. */
  downloadBytes: number | null
  /** True when the app simply cannot run without it; false for informational rows. */
  mandatory: boolean
}

export interface CheckResult {
  id: string
  title: string
  required: string
  status: CheckStatus
  /** "Not found", "Windows 10 (19045)", the installed version, and so on. */
  detail: string
  downloadBytes: number | null
}

/**
 * Windows 10 build 10240 is the first Windows 10; anything below is Windows 8.1 or older and cannot run the app.
 * The app needs 64-bit Windows because the bundled SQLite and Electron are x64 only.
 */
export const MINIMUM_WINDOWS_BUILD = 10240
export const MINIMUM_WINDOWS_LABEL = 'Windows 10 or later (64-bit)'
/** The brief's floor, and comfortably above the unpacked app plus its data. */
export const MINIMUM_DISK_BYTES = 1_000_000_000

export function evaluateWindows(input: {
  platform: 'win32' | 'other'
  major: number | null
  build: number | null
  is64Bit: boolean
}): CheckResult {
  const base = { id: 'windows', title: 'Windows version', required: MINIMUM_WINDOWS_LABEL, downloadBytes: null }
  if (input.platform !== 'win32') {
    return { ...base, status: 'blocked', detail: 'This installer is for Windows. Nothing was changed on this computer.' }
  }
  if (!input.is64Bit) {
    return { ...base, status: 'blocked', detail: 'This is a 32-bit Windows. Infoflex needs 64-bit Windows 10 or later.' }
  }
  if (input.major === null || input.build === null) {
    return { ...base, status: 'blocked', detail: 'Windows could not report its version. Contact support before installing.' }
  }
  if (input.major < 10 || (input.major === 10 && input.build < MINIMUM_WINDOWS_BUILD)) {
    return { ...base, status: 'blocked', detail: `Windows ${input.major} (build ${input.build}) is too old. Update to Windows 10 or later.` }
  }
  const label = input.major === 10 && input.build >= 22000 ? 'Windows 11' : 'Windows 10'
  return { ...base, status: 'ok', detail: `${label} (build ${input.build})` }
}

export function evaluateDisk(freeBytes: number | null): CheckResult {
  const base = { id: 'disk', title: 'Free disk space', required: 'At least 1 GB', downloadBytes: null }
  if (freeBytes === null) return { ...base, status: 'missing', detail: 'Free space could not be measured.' }
  const gigabytes = freeBytes / 1_000_000_000
  const shown = `${gigabytes.toFixed(gigabytes >= 10 ? 0 : 1)} GB free`
  if (freeBytes < MINIMUM_DISK_BYTES) {
    return { ...base, status: 'blocked', detail: `${shown} — free at least ${(MINIMUM_DISK_BYTES / 1_000_000_000).toFixed(0)} GB and try again.` }
  }
  return { ...base, status: 'ok', detail: shown }
}

/**
 * Visual C++ 2015-2022 x64 runtime. Detected from the registry, which is what the brief asks for: the presence
 * key is the uninstall entry Microsoft writes, so a machine that has it from any installer is recognised.
 */
export function evaluateVcRuntime(input: CheckObservation): CheckResult {
  const base = {
    id: 'vcredist',
    title: 'Microsoft Visual C++ 2015-2022 Redistributable (x64)',
    required: '14.0 or later',
    downloadBytes: VC_RUNTIME_DOWNLOAD_BYTES,
  }
  if (!input.probeSucceeded) {
    return { ...base, status: 'missing', detail: 'Not found — the installer will offer to install it.' }
  }
  if (!input.detectedVersion) return { ...base, status: 'missing', detail: 'Not found' }
  return { ...base, status: 'ok', detail: `Installed (${input.detectedVersion})` }
}

/** The x64 redistributable is about 25 MB; shown so the customer knows what the download will cost. */
export const VC_RUNTIME_DOWNLOAD_BYTES = 25_000_000

export function evaluateFirewall(input: { state: 'on' | 'off' | 'unknown' }): CheckResult {
  const base = { id: 'firewall', title: 'Windows Firewall', required: 'Information only', downloadBytes: null }
  if (input.state === 'unknown') return { ...base, status: 'info', detail: 'The firewall state could not be read.' }
  if (input.state === 'off') {
    return { ...base, status: 'info', detail: 'Windows Firewall is off. The Admin phone can still connect, but this is less safe.' }
  }
  return { ...base, status: 'info', detail: 'On. The Admin phone needs a private-network rule, which Infoflex adds if you tick it.' }
}

export function evaluatePrinter(input: { printers: number | null }): CheckResult {
  const base = { id: 'printer', title: 'Receipt printer', required: 'Optional', downloadBytes: null }
  if (input.printers === null) return { ...base, status: 'info', detail: 'Printers could not be listed. You can add one later in Windows.' }
  if (input.printers === 0) {
    return { ...base, status: 'info', detail: 'No printer is installed yet. You can add one later; Infoflex prints to any Windows printer.' }
  }
  return { ...base, status: 'info', detail: `${input.printers} printer${input.printers === 1 ? '' : 's'} installed.` }
}

const MANDATORY_ORDER = ['windows', 'disk', 'vcredist', 'firewall', 'printer'] as const

export interface SystemCheckSummary {
  results: CheckResult[]
  /** True when every mandatory row is green; the installer refuses to continue otherwise. */
  canContinue: boolean
  /** Human sentence naming what must be fixed first. */
  blocker: string | null
}

export function summarizeSystemCheck(results: CheckResult[]): SystemCheckSummary {
  const ordered = [...results].sort((a, b) => MANDATORY_ORDER.indexOf(a.id as never) - MANDATORY_ORDER.indexOf(b.id as never))
  const blocked = ordered.find((result) => result.status === 'blocked')
  if (blocked) {
    return { results: ordered, canContinue: false, blocker: `${blocked.title}: ${blocked.detail}` }
  }
  return { results: ordered, canContinue: true, blocker: null }
}

/**
 * "No internet" is not a dead end: the customer gets three buttons from the brief.
 * This decides which of them can actually work, so a button is never offered when it cannot succeed.
 */
export function downloadFailureOptions(input: { offlineInstallerAvailable: boolean }): {
  retry: boolean
  browse: boolean
  useOfflineInstaller: boolean
} {
  return {
    // Retrying is always allowed: a flaky connection often recovers, and after three failures the UI stops offering it.
    retry: true,
    browse: true,
    useOfflineInstaller: input.offlineInstallerAvailable,
  }
}

/** Three attempts, then the UI must stop offering Retry and point at Browse or the offline build. */
export const MAX_DOWNLOAD_ATTEMPTS = 3

export function retryAllowed(attemptsUsed: number): boolean {
  return attemptsUsed < MAX_DOWNLOAD_ATTEMPTS
}
