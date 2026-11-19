import { describe, expect, it } from 'vitest'
import { createLineSplitter, resolveExecutable, runCommand } from './runner'

/**
 * The process runner. These run real child processes — `node` itself, which is guaranteed present where the tests
 * run — because the behaviour being tested is exactly the behaviour of a real process: streams arriving in chunks,
 * a non-zero exit, and a cancel that actually stops work.
 *
 * What cannot be tested here is the Windows half: `windowsHide`, `npm.cmd`, and taskkill walking the process tree.
 * Those are marked in docs/PHASES.md as needing the Windows pass, and the functions are separated so the parts that
 * *can* be checked without Windows are checked.
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
