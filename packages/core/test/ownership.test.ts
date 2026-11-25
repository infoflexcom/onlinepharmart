import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { findClientDatabaseAccess, findUnclassifiedDatabaseAccess } from '../src/ownership'

/**
 * The static check the brief asks for: **prove only the Server imports the database module.**
 *
 * The file list comes from `git ls-files`, not from a hand-kept set of suspects, because a check that looks only
 * where somebody remembered to point it cannot find the import nobody remembered. The same closure is used to
 * build a mutated input for the "does it fail" tests below.
 */

/**
 * Every TypeScript source in the working tree, **tracked or not**.
 *
 * The first version of this used `git ls-files` alone, and was therefore blind to exactly the file that matters
 * most: a brand-new client file that nobody has staged yet. Planting such a file and finding the check still green
 * is how that was discovered. `git ls-files --others --exclude-standard` is unioned in so the scan covers what is
 * actually on disk, which is what will be committed and what a build would compile.
 */
function treeSources(): Map<string, string> {
  const run = (args: string[]): string[] =>
    execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean)
  const listed = [...run(['ls-files']), ...run(['ls-files', '--others', '--exclude-standard'])]
  const files = new Map<string, string>()
  for (const file of listed) {
    if (!/\.(ts|tsx)$/u.test(file)) continue
    if (/\.test\.tsx?$/u.test(file)) continue
    if (file.startsWith('node_modules/')) continue
    try {
      files.set(file, readFileSync(file, 'utf8'))
    } catch {
      // A listed file that is not on disk cannot be scanned; a deleted-but-staged file is not a security question.
    }
  }
  return files
}

describe('only the server opens the database', () => {
  it('finds no client-side file that imports the database module or better-sqlite3', () => {
    expect(findClientDatabaseAccess(treeSources())).toEqual([])
  })

  it('finds no unclassified file that imports the database, so every importer is on a declared side', () => {
    expect(findUnclassifiedDatabaseAccess(treeSources())).toEqual([])
  })

  it('is not vacuous: the scan really does see the server-side importers', () => {
    const files = treeSources()
    // Without this, a broken scanner that matched nothing at all would pass both tests above.
    expect(files.size).toBeGreaterThan(150)
    const serverImporters = [...files.entries()]
      .filter(([file]) => SERVER_DIRECTORIES_UNDER_TEST.some((directory) => file.startsWith(directory)))
      .filter(([, source]) => /from\s*'[^']*\/db'/u.test(source) || /better-sqlite3/u.test(source))
    expect(serverImporters.length).toBeGreaterThan(10)
    expect(serverImporters.map(([file]) => file)).toContain('src/db/index.ts')
    expect(serverImporters.map(([file]) => file)).toContain('src/db/sqlite-shop-repository.ts')
  })
})

const SERVER_DIRECTORIES_UNDER_TEST = ['src/db/', 'src/services/', 'src/api/', 'src/license/', 'src/main/']

describe('the ownership check fails when it should', () => {
  /**
   * Each test plants an import in a copy of the real source and asserts the check reports it. A guard that has never
   * been seen to fail is not evidence, and this one is the load-bearing guard of the whole architecture.
   */
  it('catches a renderer file importing the database module', () => {
    const files = treeSources()
    files.set('src/renderer/src/ui/Planted.tsx', `import { openShopDatabase } from '../../db'\nexport const x = openShopDatabase\n`)
    const findings = findClientDatabaseAccess(files)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.file).toBe('src/renderer/src/ui/Planted.tsx')
    expect(findings[0]!.why).toContain('database module')
  })

  it('catches a preload file importing better-sqlite3', () => {
    const files = treeSources()
    files.set('src/preload/planted.ts', `import Database from 'better-sqlite3'\nexport default Database\n`)
    const findings = findClientDatabaseAccess(files)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.why).toContain('better-sqlite3')
  })

  it('catches a phone app file importing the database by a longer relative path', () => {
    const files = treeSources()
    files.set('mobile/src/planted.ts', `import { openShopDatabase } from '../../src/db/index'\nexport const x = openShopDatabase\n`)
    // The mobile app reaching into src/ is the path a hurried change would take, so it must be caught.
    expect(findClientDatabaseAccess(files).map((finding) => finding.file)).toEqual(['mobile/src/planted.ts'])
  })

  it('catches a shared-package file importing better-sqlite3, which would ship SQLite to every client', () => {
    const files = treeSources()
    files.set('packages/core/src/planted.ts', `import Database from 'better-sqlite3'\nexport default Database\n`)
    expect(findClientDatabaseAccess(files).map((finding) => finding.file)).toEqual(['packages/core/src/planted.ts'])
  })

  it('reports a file outside every declared directory rather than silently allowing it', () => {
    const files = treeSources()
    files.set('tools/planted.ts', `import Database from 'better-sqlite3'\nexport default Database\n`)
    const findings = findUnclassifiedDatabaseAccess(files)
    expect(findings.map((finding) => finding.file)).toEqual(['tools/planted.ts'])
  })

  it('does not flag a test file that opens an in-memory database to check pure client logic', () => {
    const files = new Map<string, string>([
      ['src/renderer/src/ui/Thing.test.ts', `import Database from 'better-sqlite3'\nexport const d = Database\n`],
    ])
    expect(findClientDatabaseAccess(files)).toEqual([])
  })

  it('sees a require() as well as an import', () => {
    const files = new Map<string, string>([
      ['mobile/src/planted.ts', `const Database = require('better-sqlite3')\n`],
    ])
    expect(findClientDatabaseAccess(files)).toHaveLength(1)
  })

  it('sees a dynamic import, which is how a lazy client would smuggle the driver in', () => {
    const files = new Map<string, string>([
      ['src/renderer/src/planted.ts', `export const load = () => import('better-sqlite3')\n`],
    ])
    expect(findClientDatabaseAccess(files)).toHaveLength(1)
  })
})
