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
  // Written into the project by a build, beside build-profile.json.
  'buildprofile.generated.json',
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
      // Named only to record that it does not exist; see the test below.
      if (path === 'vendor-config.json') return false
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
    // Case-insensitive: the phrase may start a table cell.
    expect(readFileSync('docs/PHASES.md', 'utf8')).toMatch(new RegExp(`the ${words[planLength]!}-step plan`, 'iu'))
  })

  it('keeps the Windows gate covering every area that can only be checked by hand', () => {
    // Phase 14's DONE WHEN items are proved in software and owed on hardware. The owed half is worthless if the
    // checklist does not actually say what to click, so the five areas that can *only* be checked on a real machine
    // are asserted to be present as titled sections. This is the guard against Gate 6 quietly shrinking.
    const checklist = readFileSync('docs/RELEASE-CHECKLIST.md', 'utf8')
    const gate = checklist.slice(checklist.indexOf('## Phase 14 — Build Studio on a Windows'))
    expect(gate.length, 'the phase 14 gate section is missing').toBeGreaterThan(2000)

    for (const heading of [
      '### The system check, row by row',
      '### Installing the missing tools',
      '### The one-click build on a PC with no developer tools',
      '### The licence key generator',
      '### The build profile reaching the customer',
    ]) {
      expect(gate, `Gate 6 has no "${heading}" section`).toContain(heading)
    }

    // The 3-year / no-limit comparison must be a real comparison on one machine, naming both sides.
    expect(gate).toMatch(/3-year versus no-limit/
    )
    expect(gate).toContain('**No limit**')
    expect(gate).toContain('must be **refused**')
    expect(gate).toContain('must be **accepted**')

    // The clean-machine build must be described as clean: no Node, no makensis, launched from the Start Menu.
    expect(gate).toMatch(/fresh Windows 11 VM[^\n]*no Node, no Git, no Python/)
    expect(gate).toContain('from the Start Menu')

    // Every step is a checkbox the person can tick, and there are enough of them to be a real script.
    const steps = gate.match(/^- \[ \]/gmu) ?? []
    expect(steps.length).toBeGreaterThan(40)
  })

  it('never documents a file that is stated not to exist', () => {
    // PHASES.md records that a `vendor-config.json` was asked for and never existed. That sentence names a path, and
    // the path check rightly flags it — so the exemption is made here, narrowly and by name, rather than by loosening
    // the rule for everything. Any *other* mention of a file the docs call missing still fails.
    const phases = readFileSync('docs/PHASES.md', 'utf8')
    const denied = [...phases.matchAll(/\*\*There is no such file, and there never was\*\*/gu)]
    expect(denied.length).toBe(1)
    const introduced = /asks about a `([a-z-]+\.json)`/u.exec(phases)?.[1]
    expect(introduced).toBe('vendor-config.json')
    // And nothing in the tree may be named that, or the correction above would be the wrong way round.
    expect(execFileSync('git', ['ls-files'], { encoding: 'utf8' })).not.toContain('vendor-config.json')
  })

  it('does not call Build Studio planned, now that it exists', () => {
    const readme = readFileSync('README.md', 'utf8')
    expect(readme).not.toMatch(/planned graphical Build Studio/u)
    // But it must stay honest about what has not been proven.
    expect(readme).toMatch(/never launched in Electron|never been launched|never opened in Electron/u)
  })
})
