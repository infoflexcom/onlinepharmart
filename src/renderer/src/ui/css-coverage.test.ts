import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every class a renderer component asks for must be styled somewhere.
 *
 * Why this test exists: the Users and Seats screen and the setup's team-size step were written with 31 class names that
 * no stylesheet defined. Nothing failed. `tsc` does not check CSS, the build bundles happily, and the screens render —
 * as unstyled HTML: no table borders, no badges, a modal with no backdrop, steppers with no buttons sized. It is the
 * quietest possible way to ship a broken screen, and it was only found by hand.
 *
 * The list of components is **derived** from the tree rather than written out, because a hand-written list of screens
 * would stop covering exactly the screen somebody adds next — the one most likely to get this wrong.
 */

const RENDERER = join('src', 'renderer', 'src')

/**
 * Classes this test tolerates as unstyled, with the reason for each.
 *
 * Every entry is pre-existing debt in a file this phase did not touch. They are listed rather than fixed so that this
 * phase stays about seats and sign-in; the point of writing them down is that the list can only shrink. A new
 * unstyled class anywhere fails the test instead of joining this list silently.
 */
const KNOWN_UNSTYLED: Record<string, string> = {
  'InventoryWorkspace.tsx': 'Five card classes from the inventory phase, never styled; layout still works from the grid.',
  'MobileAccessWorkspace.tsx': 'Four BEM classes and modifiers from the mobile phase, never styled.',
  'PosWorkspace.tsx': 'pos-product-search and pos-receipt-backdrop: the search works, the backdrop is unstyled.',
  'LicenseScreen.tsx': 'vendor-policy-recovery: the recovery panel is unstyled but functional.',
  'PosReceiptDocument.tsx': 'pos-receipt-powered-by: a print-document footer with no rule.',
  'ReportsWorkspace.tsx': 'report-shifts-card: the shifts card is unstyled but laid out by its parent.',
}

/** Files this phase built or rebuilt. These get no allowance at all. */
const PHASE_17_SCREENS = ['UsersAndSeats.tsx', 'SetupScreen.tsx', 'LoginScreen.tsx', 'AppShell.tsx']

function walk(directory: string, extension: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) found.push(...walk(path, extension))
    else if (path.endsWith(extension)) found.push(path)
  }
  return found.sort()
}

/**
 * Pull class names out of one `className` value.
 *
 * A className expression mixes two kinds of string literal: the classes to apply, and the values being compared
 * against — `tab === 'onsite' ? 'is-active' : ''`. Only the first kind is a class. Comparison operands are stripped
 * before extraction, otherwise every state literal in a component is reported as an unstyled class and the test is
 * useless. (The first version of this scan did exactly that and named 22 "missing" classes, 8 of which were `onsite`,
 * `grace` and `RETAIL`.)
 */
function classesIn(value: string): Set<string> {
  let text = value
  text = text.replace(/[!=]==?\s*(["'])[^"']*\1/gu, ' ')
  text = text.replace(/\.includes\(\s*(["'])[^"']*\1\s*\)/gu, ' ')
  text = text.replace(/\bcase\s+(["'])[^"']*\1/gu, ' ')
  const classes = new Set<string>()
  for (const [, single, double] of text.matchAll(/'([^']*)'|"([^"]*)"/gu)) {
    for (const token of `${single ?? ''}${double ?? ''}`.split(/\s+/u)) {
      // Template interpolation (`${variant}`) is not a literal class name and cannot be checked statically.
      if (/^[A-Za-z][A-Za-z0-9_-]*$/u.test(token)) classes.add(token)
    }
  }
  return classes
}

function unstyledClasses(): Map<string, string[]> {
  const css = walk(RENDERER, '.css').map((file) => readFileSync(file, 'utf8')).join('\n')
  // Every `.name` in every stylesheet counts as defined, including ones only reached through a compound selector.
  const defined = new Set([...css.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/gu)].map((match) => match[1]))

  const report = new Map<string, string[]>()
  for (const file of walk(RENDERER, '.tsx')) {
    if (file.endsWith('.test.tsx')) continue
    const source = readFileSync(file, 'utf8')
    const used = new Set<string>()
    for (const match of source.matchAll(/className=(\{[\s\S]*?\}|"[^"]*")/gu)) {
      for (const name of classesIn(match[1]!)) used.add(name)
    }
    const missing = [...used].filter((name) => !defined.has(name)).sort()
    if (missing.length > 0) report.set(relative(RENDERER, file).split(sep).pop()!, missing)
  }
  return report
}

describe('every class the renderer asks for is styled', () => {
  const report = unstyledClasses()

  it('styles every class on the screens this phase built', () => {
    for (const screen of PHASE_17_SCREENS) {
      expect(report.get(screen), `${screen} uses classes no stylesheet defines`).toBeUndefined()
    }
  })

  it('adds no unstyled class beyond the documented pre-existing debt', () => {
    const unexpected = [...report.keys()].filter((file) => !(file in KNOWN_UNSTYLED))
    expect(
      unexpected,
      `These components use classes no stylesheet defines. Style them, or the screen renders as bare HTML: ${unexpected.join(', ')}`,
    ).toEqual([])
  })

  it('keeps the debt list honest: every entry is still unstyled, and only those classes', () => {
    // A stale allowlist is worse than none, because it reads as a decision rather than as an omission. If a class here
    // gets styled, or a new one appears in a listed file, this says so and the entry must be updated or removed.
    for (const [file, reason] of Object.entries(KNOWN_UNSTYLED)) {
      expect(reason.trim().length, `${file} has no reason recorded`).toBeGreaterThan(20)
      const missing = report.get(file)
      expect(missing, `${file} is listed as carrying unstyled classes but now has none — remove it from KNOWN_UNSTYLED`)
        .toBeDefined()
      expect(missing!.length, `${file}'s unstyled classes changed; update KNOWN_UNSTYLED`).toBeGreaterThan(0)
    }
    const listed = Object.keys(KNOWN_UNSTYLED).sort()
    const actual = [...report.keys()].sort()
    expect(actual, 'the set of components with unstyled classes changed').toEqual(listed)
  })

  it('finds the stylesheets it is checking, so an empty scan cannot pass', () => {
    // Without this, a typo in the path would make the test compare nothing against nothing and report success.
    const cssFiles = walk(RENDERER, '.css')
    expect(cssFiles.length).toBeGreaterThanOrEqual(3)
    expect(cssFiles.some((file) => file.endsWith('seats.css')), 'seats.css is not where the scan looks').toBe(true)
    const components = walk(RENDERER, '.tsx').filter((file) => !file.endsWith('.test.tsx'))
    // Nineteen today. The number is not the point; a scan that found one file would be as green as one that found all
    // of them, and the assertion is here so that cannot happen.
    expect(components.length, 'the component scan found almost nothing — the path is wrong').toBeGreaterThan(10)
    expect(components.some((file) => file.endsWith('UsersAndSeats.tsx')), 'UsersAndSeats.tsx is not being scanned').toBe(true)
  })
})
