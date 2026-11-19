import { spawn, type ChildProcess } from 'node:child_process'
import { redactSecrets } from './build-steps'

/**
 * Running a build command without a terminal, and reporting it as it happens.
 *
 * Three constraints shape this:
 *
 *   - **No console window may appear.** On Windows, spawning `npm` without `windowsHide` and without going through
 *     `npm.cmd` flashes a console. The brief is explicit that the vendor never sees a terminal, so both are handled
 *     here rather than left to the caller to remember.
 *   - **A cancel must actually stop the work.** A build is minutes long; a Cancel button that greys out while npm
 *     carries on is worse than no button. `tree-kill` semantics matter on Windows because npm spawns children.
 *   - **Output must be redacted on the way out, not on the way to the screen.** Anything already written to the log
 *     file cannot be un-written, so `redactSecrets` runs before a line is either shown or stored.
 */

export interface RunnerOptions {
  /** The project folder the command runs in. */
  cwd: string
  command: string
  args: string[]
  /** Strings that must never appear in a log or on screen. */
  secrets: readonly string[]
  onLine: (line: string, stream: 'stdout' | 'stderr') => void
  onDone: (result: { exitCode: number | null; cancelled: boolean }) => void
  /** Extra environment, e.g. the build profile vended to the child process. */
  env?: Record<string, string>
  /** How long without output before the line "still working" is worth saying. */
  idleNoticeMs?: number
  idleNotice?: (elapsedMs: number) => void
}

export interface RunningCommand {
  cancel: () => void
  done: Promise<{ exitCode: number | null; cancelled: boolean }>
}

/**
 * On Windows an npm script is `npm.cmd`; spawning the bare name fails with ENOENT in some environments because the
 * lookup is not done through a shell. This is the single place that difference lives.
 */
export function resolveExecutable(command: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32' && command === 'npm') return 'npm.cmd'
  return command
}

/** Splits child output into lines, keeping a partial last line for the next chunk. */
export function createLineSplitter(onLine: (line: string) => void): (chunk: string, flush?: boolean) => void {
  let buffer = ''
  return (chunk: string, flush = false): void => {
    buffer += chunk
    const parts = buffer.split(/\r?\n/u)
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      if (part.trim()) onLine(part)
    }
    if (flush && buffer.trim()) {
      onLine(buffer)
      buffer = ''
    }
  }
}

export function runCommand(options: RunnerOptions): RunningCommand {
  const executable = resolveExecutable(options.command)
  let cancelled = false
  let child: ChildProcess | null = null
  let idleTimer: NodeJS.Timeout | null = null
  let resolveDone: (value: { exitCode: number | null; cancelled: boolean }) => void = () => {}
  const done = new Promise<{ exitCode: number | null; cancelled: boolean }>((resolve) => { resolveDone = resolve })

  const clearIdle = (): void => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null } }
  const armIdle = (): void => {
    clearIdle()
    if (!options.idleNotice || !options.idleNoticeMs) return
    const started = Date.now()
    idleTimer = setTimeout(() => options.idleNotice?.(Date.now() - started), options.idleNoticeMs)
    idleTimer.unref?.()
  }

  try {
    child = spawn(executable, options.args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      // The three lines that keep a console window from appearing on Windows.
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    options.onLine(`Build Studio could not start ${executable}: ${message}`, 'stderr')
    resolveDone({ exitCode: null, cancelled: false })
    options.onDone({ exitCode: null, cancelled: false })
    return { cancel: () => {}, done }
  }

  armIdle()
  // Merge both streams into one line feed: the vendor reads one list in time order, not two interleaved ones.
  const forward = (stream: 'stdout' | 'stderr') => createLineSplitter((line) => {
    armIdle()
    options.onLine(redactSecrets(line, options.secrets), stream)
  })
  const out = forward('stdout')
  const err = forward('stderr')
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => out(chunk))
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => err(chunk))

  const finish = (exitCode: number | null): void => {
    clearIdle()
    out('', true)
    err('', true)
    const result = { exitCode, cancelled }
    resolveDone(result)
    options.onDone(result)
  }

  child.on('error', (error) => {
    options.onLine(`Build Studio could not run ${executable}: ${error.message}`, 'stderr')
    finish(null)
  })
  child.on('close', (code) => finish(code))

  return {
    done,
    cancel: () => {
      if (!child || cancelled) return
      cancelled = true
      clearIdle()
      options.onLine('Cancelling…', 'stdout')
      killTree(child)
    },
  }
}

/**
 * Ends a process and its children.
 *
 * `kill()` on Windows only signals the immediate child; npm's real work happens in grandchildren, which would keep
 * running and keep the output files open. taskkill /T walks the whole tree, which is what Cancel has to mean.
 */
export function killTree(
  child: ChildProcess,
  // Injected so the Windows path can be tested on a Linux build machine: the tool only ever ships to Windows, and a
  // Cancel that leaves half a build tree running is the failure that matters most there.
  options: { platform?: NodeJS.Platform; spawn?: typeof spawn } = {},
): void {
  if (!child.pid) return
  const platform = options.platform ?? process.platform
  const spawnProcess = options.spawn ?? spawn
  if (platform === 'win32') {
    try {
      // `windowsHide` and `stdio: 'ignore'`: the taskkill window must never appear.
      spawnProcess('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      return
    } catch {
      // Fall through to the plain kill below.
    }
  }
  try {
    child.kill('SIGTERM')
    // A build that ignores SIGTERM gets SIGKILL shortly after, so Cancel is never a no-op.
    setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } }, 5_000).unref?.()
  } catch {
    // The process had already exited.
  }
}
