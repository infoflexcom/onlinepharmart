import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The documentation, checked against the tree.
 *
 * Twice now a document has described something that was not true of the code: the licence policy exporter was
 * documented at a path that had become the Build Studio window, and the schema table named a migration file that
 * never existed and credited it with recovery-code hashes no migration creates. Neither was caught by anything —
 * prose is not compiled, and a link in Markdown is not a reference a build can fail on.
 *
 * These tests are that missing check. They are deliberately about *facts a reader would rely on* — a file they are
 * told to open, a command they are told to run, a migration the schema table lists — rather than about wording.
 */

const DOCS = [
  'README.md',
  ...readdirSync('docs').filter((name) => name.endsWith('.md')).map((name) => `docs/${name}`),
  'buildstudio/README.md',
  'installer/README.md',
  'cloud/README.md',
  'src/license/README.md',
  'mobile/README.md',
]

/** Every tracked file, and every basename in it, so a bare filename in prose resolves. */
const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean)
const knownBasenames = new Set(tracked.map((path) => basename(path)))

/** Names that appear in prose as a file the tool writes at runtime, not one in the repository. */
const RUNTIME_FILES = new Set([
  'build-studio-settings.json', 'install-config.json', 'mobile-api-identity.json',
  'config.php', '.manifest.json', 'build-profile.json',
])

/** Files produced by a build rather than committed; `build-studio.ts` copies or writes each of them. */
const GENERATED = new Set(['preload.js', 'ui.js', 'main.js'])

function documentedFiles(): Array<{ path: string; source: string }> {
  const found: Array<{ path: string; source: string }> = []
  const pattern = /`([A-Za-z0-9_./@-]+\.(?:ts|tsx|js|json|md|nsh|nsi|html|zip|bmp|ico|yml|php|css))`/gu
  for (const source of DOCS) {
    if (!existsSync(source)) continue
    const text = readFileSync(source, 'utf8')
    for (const match of text.matchAll(pattern)) found.push({ path: match[1]!, source })
  }
  return found
}

describe('the documentation describes this repository', () => {
  it('only points at files that exist, or that the build produces', () => {
    const missing = documentedFiles().filter(({ path }) => {
      if (path.startsWith('http') || path.startsWith('~')) return false
      if (RUNTIME_FILES.has(basename(path)) || GENERATED.has(basename(path))) return false
      if (existsSync(path)) return false
      // A bare filename is fine when a file of that name exists somewhere tracked.
      return !knownBasenames.has(basename(path))
    })
    expect(
      [...new Set(missing.map(({ path, source }) => `${path} (in ${source})`))],
      'these documented files are neither in the tree nor produced by a build',
    ).toEqual([])
  })

  it('only tells the reader to run npm scripts that exist', () => {
    const scripts = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
    const referenced = new Set<string>()
    for (const source of DOCS) {
      if (!existsSync(source)) continue
      for (const match of readFileSync(source, 'utf8').matchAll(/npm run ([a-z0-9:_-]+)/gu)) referenced.add(match[1]!)
    }
    const unknown = [...referenced].filter((name) => !(name in scripts.scripts))
    expect(unknown, 'documented npm scripts that package.json does not have').toEqual([])
    // And the list is not empty, which would make the assertion above vacuous.
    expect(referenced.size).toBeGreaterThan(15)
  })

  it('lists every migration, by its real file name, in the schema table', () => {
    const table = readFileSync('docs/SCHEMA.md', 'utf8')
    const files = readdirSync('src/db/migrations').filter((name) => /^\d{3}_/u.test(name))
    expect(files.length).toBeGreaterThan(10)
    for (const file of files) {
      // The table's second column names the file. A row pointing at a renamed migration is how the schema document
      // came to describe a file that did not exist.
      expect(table, `migration ${file} is not named in docs/SCHEMA.md`).toContain(`\`${file}\``)
      const version = Number(file.slice(0, 3))
      expect(table, `migration ${file} has no row numbered ${version}`).toMatch(
        new RegExp(`^\\| ${version} \\| \`${file}\` \\|`, 'mu'),
      )
    }
  })

  it('describes no migration that is not there', () => {
    const table = readFileSync('docs/SCHEMA.md', 'utf8')
    const named = [...table.matchAll(/^\| \d+ \| `(\d{3}_[a-z_]+\.ts)` \|/gmu)].map((match) => match[1]!)
    expect(named.length).toBeGreaterThan(10)
    for (const file of named) expect(existsSync(`src/db/migrations/${file}`), `${file} is in the table but not on disk`).toBe(true)
  })

  it('counts Build Studio\'s screens and build steps the way the code does', () => {
    // Both counts were wrong in two documents at once: the window has seven panels, and the plan has eleven steps.
    // A number in prose is the easiest thing to leave behind, so it is read from the code and compared with the words.
    const html = readFileSync('buildstudio/index.html', 'utf8')
    const panels = new Set([...html.matchAll(/data-panel="([a-z]+)"/gu)].map((match) => match[1]!))
    const tabs = new Set([...html.matchAll(/data-tab="([a-z]+)"/gu)].map((match) => match[1]!))
    expect([...panels]).toEqual([...tabs])

    const steps = readFileSync('buildstudio/src/build-steps.ts', 'utf8')
    const planLength = Number(/export const BUILD_STEPS: readonly StepSpec\[\] = \[([\s\S]*?)\n\]/u.exec(steps)?.[1]
      ?.match(/^\s{2}\{/gmu)?.length)
    expect(planLength).toBeGreaterThan(5)

    const words: Record<number, string> = {
      3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten', 11: 'eleven', 12: 'twelve',
    }
    const studio = readFileSync('buildstudio/README.md', 'utf8')
    expect(studio).toContain(`sees ${words[panels.size]!} screens`)
    expect(readFileSync('docs/PHASES.md', 'utf8')).toContain(`the ${words[planLength]!}-step plan`)
  })

  it('does not call Build Studio planned, now that it exists', () => {
    const readme = readFileSync('README.md', 'utf8')
    expect(readme).not.toMatch(/planned graphical Build Studio/u)
    // But it must stay honest about what has not been proven.
    expect(readme).toMatch(/never launched in Electron|never been launched|never opened in Electron/u)
  })
})
