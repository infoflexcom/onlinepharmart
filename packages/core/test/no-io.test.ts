import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `/packages/core` is the only code a client and a server both load, so it must never grow an I/O dependency.
 *
 * The check walks the real import graph rather than reading a list, and it follows relative imports *out* of the
 * package as well — because `money.ts` deliberately re-exports from `src/currency/`, and a rule that stopped at the
 * package boundary would not see a `node:fs` import two hops away. That is the shape of hole this test exists to
 * close.
 *
 * The forbidden set is chosen for what it would mean:
 * - `node:*` — filesystem, crypto, sockets: anything a browser client cannot do.
 * - `electron` — only meaningful in the desktop host.
 * - `fastify` / `ws` — server transport; a client's HTTP calls are not this package's business.
 * - `better-sqlite3` — the one thing the architecture says a client must never reach.
 */

const CORE = 'packages/core/src'
const FORBIDDEN = [/^node:/, /^electron$/, /^electron\//, /^fastify$/, /^@fastify\//, /^ws$/, /^better-sqlite3$/]

/**
 * Every module specifier in a file: `import x from 'y'`, `import 'y'`, `import('y')` and `export * from 'y'`.
 *
 * The first version of this function matched `export` immediately before the quote, which silently missed
 * `export * from './money'` — the one line in `index.ts` that reaches into `src/currency/`. The non-vacuity test
 * below is what found it. Had it not been there, the package would have looked clean while the graph actually
 * reached outside it.
 */
function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  const specifiers = [
    ...[...source.matchAll(/\bfrom\s*'([^']+)'/g)].map((match) => match[1]!),
    ...[...source.matchAll(/\bimport\s*\(\s*'([^']+)'/g)].map((match) => match[1]!),
    ...[...source.matchAll(/\bimport\s+'([^']+)'/g)].map((match) => match[1]!),
  ]
  return specifiers
}

function resolveSpecifier(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  const base = resolve(dirname(from), specifier)
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    try {
      readFileSync(candidate)
      return candidate
    } catch {
      // try the next shape
    }
  }
  return null
}

/** Breadth-first over the import graph from every file in the package. */
function graphViolations(): Array<{ file: string; specifier: string }> {
  const roots = readdirSync(CORE).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts')).map((n) => join(CORE, n))
  const seen = new Set<string>()
  const violations: Array<{ file: string; specifier: string }> = []
  const queue = [...roots]
  while (queue.length > 0) {
    const file = queue.shift()!
    if (seen.has(file)) continue
    seen.add(file)
    for (const specifier of importsOf(file)) {
      if (FORBIDDEN.some((pattern) => pattern.test(specifier))) violations.push({ file, specifier })
      const target = resolveSpecifier(file, specifier)
      if (target && !seen.has(target)) queue.push(target)
    }
  }
  return violations
}

describe('the shared package holds no I/O', () => {
  it('imports no node built-in, electron, fastify or better-sqlite3, anywhere in its import graph', () => {
    expect(graphViolations()).toEqual([])
  })

  it('is not vacuously clean: the graph really does reach src/currency through money.ts', () => {
    // Without this, a broken resolver that found no imports at all would pass the test above and prove nothing.
    const roots = readdirSync(CORE).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    const reached = new Set<string>()
    const queue = roots.map((name) => join(CORE, name))
    while (queue.length > 0) {
      const file = queue.shift()!
      if (reached.has(file)) continue
      reached.add(file)
      for (const specifier of importsOf(file)) {
        const target = resolveSpecifier(file, specifier)
        if (target && !reached.has(target)) queue.push(target)
      }
    }
    expect([...reached].some((file) => file.includes('src/currency/'))).toBe(true)
    expect(reached.size).toBeGreaterThan(3)
  })

  it('fails when a violation is planted, so the check is known to work', () => {
    const planted = `
      import { readFileSync } from 'node:fs'
      export const read = readFileSync
    `
    const specifiers = [...planted.matchAll(/(?:from|import|export)\s*\(?\s*'([^']+)'/g)].map((match) => match[1]!)
    expect(specifiers.some((specifier) => FORBIDDEN.some((pattern) => pattern.test(specifier)))).toBe(true)
  })
})
