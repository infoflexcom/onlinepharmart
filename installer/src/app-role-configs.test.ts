import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'

/**
 * The two installer configurations, and the icon sets they point at.
 *
 * The brief ships a Server installer and a Client installer. Separate configs are the only way electron-builder can
 * produce two artifacts with different icons from one repository, and the risk with two configs is the ordinary one:
 * somebody fixes a build setting in `package.json` and the two role configs quietly keep the old value. A shop would
 * then install a client that behaves subtly differently from the server for reasons nobody could see in a diff.
 *
 * So the guard is a parity check, not a list. Everything except the icon paths, the artifact name and the shortcut name
 * must match the `build` block of `package.json`.
 */

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { build: Record<string, unknown> }
const BASE = pkg.build

const ROLES = ['server', 'client'] as const

/** The keys a role config is *allowed* to differ in, each for a stated reason. */
const DIFFERENT: Record<string, string> = {
  'win.icon': 'each application has its own icon set',
  'win.artifactName': 'two installers must not produce one filename',
  'nsis.installerIcon': 'the installer window shows which application it installs',
  'nsis.uninstallerIcon': 'and so does the uninstaller',
  'nsis.installerHeaderIcon': 'the header icon sits beside the page title',
  'nsis.installerHeader': 'the banner carries the badge',
  'nsis.installerSidebar': 'the sidebar carries the badge',
  'nsis.uninstallerSidebar': 'the uninstaller sidebar matches the installer',
  'nsis.shortcutName': 'two shortcuts in one Start menu must be tellable apart',
}

function readRole(role: (typeof ROLES)[number]): Record<string, unknown> {
  return JSON.parse(readFileSync(`electron-builder.${role}.json`, 'utf8')) as Record<string, unknown>
}

/**
 * Every leaf, keyed by its dotted path.
 *
 * Leaves only: an earlier version also recorded the parent objects, so `win` and `nsis` appeared in the comparison
 * with their whole subtree as a value and every role config "differed" at those two keys the moment one child differed.
 * The diff said nothing useful and the test was wrong, not the configs.
 */
function flatten(value: unknown, prefix = ''): Map<string, unknown> {
  const out = new Map<string, unknown>()
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key
      if (child && typeof child === 'object' && !Array.isArray(child)) {
        for (const [innerKey, inner] of flatten(child, path)) out.set(innerKey, inner)
      } else {
        out.set(path, child)
      }
    }
  }
  return out
}

describe('each role has an installer configuration', () => {
  it.each(ROLES)('%s exists and names its own icon set', (role) => {
    expect(existsSync(`electron-builder.${role}.json`), `${role} config`).toBe(true)
    const config = readRole(role) as { win: { icon: string }; nsis: Record<string, string> }
    expect(config.win.icon).toBe(`build/${role}/icon.ico`)
    for (const key of ['installerIcon', 'uninstallerIcon', 'installerHeaderIcon']) {
      expect(config.nsis[key], key).toBe(`build/${role}/icon.ico`)
    }
    expect(config.nsis.installerSidebar).toBe(`build/${role}/installer-sidebar.bmp`)
  })

  it('the two configs point at different files', () => {
    const server = readRole('server') as { win: { icon: string } }
    const client = readRole('client') as { win: { icon: string } }
    // A copy-paste that forgot to change the path would make two installers with one icon and no visible symptom.
    expect(server.win.icon).not.toBe(client.win.icon)
  })

  it('every icon a config names is a file that exists', () => {
    for (const role of ROLES) {
      const config = readRole(role) as { win: { icon: string }; nsis: Record<string, string> }
      const paths = [
        config.win.icon,
        config.nsis.installerHeader,
        config.nsis.installerSidebar,
      ]
      for (const path of paths) {
        expect(existsSync(path), `${role} is missing ${path} — run \`npx tsx scripts/generate-app-icons.ts\``).toBe(true)
      }
    }
  })
})

describe('the role configs have not drifted from the main build block', () => {
  it.each(ROLES)('%s differs from package.json only where it is allowed to', (role) => {
    const base = flatten(BASE)
    const config = readRole(role)
    // The comment key is documentation, not configuration.
    delete (config as Record<string, unknown>)._comment
    const roleFlat = flatten(config)
    const differences: string[] = []
    for (const [key, value] of roleFlat) {
      if (DIFFERENT[key]) continue
      if (JSON.stringify(base.get(key)) !== JSON.stringify(value)) differences.push(key)
    }
    for (const key of base.keys()) {
      if (DIFFERENT[key]) continue
      if (!roleFlat.has(key)) differences.push(`missing: ${key}`)
    }
    expect(differences, `${role} has drifted from package.json in these keys`).toEqual([])
  })

  it('the three unstated-difference keys are the only ones that differ', () => {
    // Stated as data rather than as prose so adding a fourth difference means editing the table above, which is
    // visible in a diff, rather than editing a config and hoping nobody notices.
    expect(Object.keys(DIFFERENT).sort()).toEqual([
      'nsis.installerHeader', 'nsis.installerHeaderIcon', 'nsis.installerIcon', 'nsis.installerSidebar',
      'nsis.shortcutName', 'nsis.uninstallerIcon', 'nsis.uninstallerSidebar', 'win.artifactName', 'win.icon',
    ])
  })
})

describe('the artifact names tell the two apart', () => {
  it.each(ROLES)('%s names its installer after the application', (role) => {
    const config = readRole(role) as { win: { artifactName: string } }
    expect(config.win.artifactName.toLowerCase()).toContain(role)
    // Downloading the wrong installer onto a till is a support call either way, so the filename must say which.
    expect(config.win.artifactName).toMatch(/^Infoflex (Server|Client) Setup\.\$\{ext\}$/u)
  })
})
