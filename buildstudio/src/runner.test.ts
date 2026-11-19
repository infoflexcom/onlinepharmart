import type { ChildProcess } from 'node:child_process'
import type { spawn } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { createLineSplitter, killTree, resolveExecutable, runCommand } from './runner'

/**
 * The process runner. These run real child processes — `node` itself, which is guaranteed present where the tests
 * run — because the behaviour being tested is exactly the behaviour of a real process: streams arriving in chunks,
 * a non-zero exit, and a cancel that actually stops work.
 *
 * The Windows half is tested too, by passing the platform in: `killTree` takes it as a parameter so `taskkill /T /F`
 * and its fallback are exercised here rather than only on the machine this tool is for. What still needs a real
 * Windows machine is whether Windows honours them — which is a question no test in this repository can answer.
 */

function collect(): { lines: string[]; onLine: (line: string, stream: 'stdout' | 'stderr') => void } {
  const lines: string[] = []
  return { lines, onLine: (line) => { lines.push(line) } }
}

describe('resolving the executable', () => {
  it('uses npm.cmd on Windows, where the bare name is not on PATH', () => {
    expect(resolveExecutable('npm', 'win32')).toBe('npm.cmd')
    expect(resolveExecutable('npm', 'linux')).toBe('npm')
    // Anything that is not npm is left alone: the comment field spells out why this is a one-case rule.
    expect(resolveExecutable('node', 'win32')).toBe('node')
  })
})

describe('splitting child output into lines', () => {
  it('holds a partial line until its newline arrives', () => {
    const out: string[] = []
    const split = createLineSplitter((line) => out.push(line))
    split('first hal')
    expect(out).toEqual([])
    split('f second\nsecond\n')
    expect(out).toEqual(['first half second', 'second'])
  })

  it('handles CRLF, which is what npm emits on Windows', () => {
    const out: string[] = []
    const split = createLineSplitter((line) => out.push(line))
    split('one\r\ntwo\r\n')
    expect(out).toEqual(['one', 'two'])
  })

  it('flushes a final line with no newline, so nothing is lost at exit', () => {
    const out: string[] = []
    const split = createLineSplitter((line) => out.push(line))
    split('no newline at the end')
    split('', true)
    expect(out).toEqual(['no newline at the end'])
  })

  it('drops blank lines rather than filling the window with gaps', () => {
    const out: string[] = []
    const split = createLineSplitter((line) => out.push(line))
    split('a\n\n   \nb\n')
    expect(out).toEqual(['a', 'b'])
  })
})

describe('running a real command', () => {
  it('reports the exit code and forwards output', async () => {
    const { lines, onLine } = collect()
    const result = await runCommand({
      cwd: process.cwd(), command: process.execPath,
      args: ['-e', "console.log('hello from a child')"], secrets: [], onLine, onDone: () => {},
    }).done
    expect(result.exitCode).toBe(0)
    expect(result.cancelled).toBe(false)
    expect(lines.join('\n')).toContain('hello from a child')
  })

  it('reports a non-zero exit rather than throwing', async () => {
    const { lines, onLine } = collect()
    const result = await runCommand({
      cwd: process.cwd(), command: process.execPath,
      args: ['-e', 'process.exit(3)'], secrets: [], onLine, onDone: () => {},
    }).done
    expect(result.exitCode).toBe(3)
    expect(result.cancelled).toBe(false)
    void lines
  })

  it('redacts secrets before they reach the line feed', async () => {
    // The log is written from these lines, so redaction has to happen here and not at the display.
    const secret = 'zq7-Fictional-Guard-Sample-9182'
    const { lines, onLine } = collect()
    await runCommand({
      cwd: process.cwd(), command: process.execPath,
      args: ['-e', `console.log('the value is ${secret}')`], secrets: [secret], onLine, onDone: () => {},
    }).done
    const text = lines.join('\n')
    expect(text).not.toContain(secret)
    expect(text).toContain('[redacted]')
  })

  it('reports a missing executable instead of crashing the window', async () => {
    const { lines, onLine } = collect()
    const result = await runCommand({
      cwd: process.cwd(), command: 'definitely-not-a-real-program-xyz', args: [], secrets: [],
      onLine, onDone: () => {},
    }).done
    expect(result.exitCode).toBeNull()
    expect(lines.join('\n')).toMatch(/could not run/iu)
  })

  it('actually stops the work when cancelled', async () => {
    // A Cancel that greys out while the build runs on is worse than no Cancel.
    const { lines, onLine } = collect()
    let finished = false
    const command = runCommand({
      cwd: process.cwd(), command: process.execPath,
      args: ['-e', 'setTimeout(() => console.log("should not get here"), 30000)'],
      secrets: [], onLine, onDone: () => { finished = true },
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    const started = Date.now()
    command.cancel()
    const result = await command.done
    expect(result.cancelled).toBe(true)
    expect(finished).toBe(true)
    // It came back promptly rather than waiting out the child's 30 seconds.
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(lines.join('\n')).toMatch(/Cancelling/iu)
  })

  it('passes extra environment through to the child', async () => {
    const { lines, onLine } = collect()
    await runCommand({
      cwd: process.cwd(), command: process.execPath,
      args: ['-e', 'console.log("profile=" + process.env.INFOFLEX_BUILD_PROFILE)'],
      secrets: [], onLine, onDone: () => {}, env: { INFOFLEX_BUILD_PROFILE: 'ghs-locked' },
    }).done
    expect(lines.join('\n')).toContain('profile=ghs-locked')
  })
})

describe('cancelling a build on Windows', () => {
  /**
   * Every one of these branches is dead on the Linux build machine, and all of them run on the only machine this tool
   * is for. `kill()` on Windows signals only the immediate child; npm's real work is in grandchildren, which keep
   * running and keep the output files open — so Cancel has to mean `taskkill /T`.
   */
  const fakeChild = (pid: number | undefined) => ({
    pid,
    kill: vi.fn(),
  }) as unknown as { pid: number | undefined; kill: ReturnType<typeof vi.fn> } & ChildProcess

  it('walks the whole tree with taskkill, hidden, and does not plain-kill as well', () => {
    const child = fakeChild(4242)
    const spawnProcess = vi.fn(() => ({}) as unknown as ReturnType<typeof spawn>)
    killTree(child, { platform: 'win32', spawn: (spawnProcess as unknown) as typeof spawn })

    expect(spawnProcess).toHaveBeenCalledTimes(1)
    const [command, args, options] = spawnProcess.mock.calls[0] as unknown as [string, string[], { windowsHide: boolean; stdio: string }]
    expect(command).toBe('taskkill')
    // /T walks the tree and /F makes it actually stop. Both matter: /T alone can hang on a busy process.
    expect(args).toEqual(['/pid', '4242', '/T', '/F'])
    expect(options.windowsHide).toBe(true)
    expect(options.stdio).toBe('ignore')
    // taskkill does the work; a SIGTERM on the parent as well would be redundant and could race.
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('falls back to a plain kill when taskkill cannot be started at all', () => {
    const child = fakeChild(7)
    const spawnProcess = vi.fn(() => { throw new Error('taskkill is not on PATH') })
    killTree(child, { platform: 'win32', spawn: (spawnProcess as unknown) as typeof spawn })
    // A machine with no taskkill must still be able to cancel a build.
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('uses SIGTERM away from Windows, and never taskkill', () => {
    const child = fakeChild(11)
    const spawnProcess = vi.fn()
    killTree(child, { platform: 'darwin', spawn: (spawnProcess as unknown) as typeof spawn })
    expect(spawnProcess).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('does nothing at all when the process never started', () => {
    const child = fakeChild(undefined)
    const spawnProcess = vi.fn()
    killTree(child, { platform: 'win32', spawn: (spawnProcess as unknown) as typeof spawn })
    // A pid of 0 would make taskkill act on the wrong thing; nothing is the only safe answer.
    expect(spawnProcess).not.toHaveBeenCalled()
    expect(child.kill).not.toHaveBeenCalled()
  })
})
