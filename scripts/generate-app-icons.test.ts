import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * The Server and Client icon sets.
 *
 * These assertions exist because of a specific failure: the first version of `scripts/generate-app-icons.ts` composed a
 * badge plate onto the logo and wrote a file **byte-identical to the input**. ImageMagick accepted every argument and
 * did nothing. Every check a person would make by hand — "does the file exist", "is it 512×512" — passed, and the
 * only visible symptom was an icon without a badge, which nobody notices until two icons sit side by side on a desktop.
 *
 * So the checks here are about *the difference between the two sets*, not about the files existing.
 */

const ROOT = join(import.meta.dirname, '..')
const ROLES = ['server', 'client'] as const

function icoSizes(path: string): number[] {
  // Read the ICO directory rather than trusting `identify`. `identify` reported 256×256 for every entry when the file
  // genuinely held seven sizes, and also reported seven entries when it held one; the directory is the file.
  const buffer = readFileSync(path)
  const count = buffer.readUInt16LE(4)
  const sizes: number[] = []
  for (let index = 0; index < count; index += 1) {
    const width = buffer[6 + index * 16]
    sizes.push(width === 0 ? 256 : width)
  }
  return sizes
}

describe('both applications have an icon set', () => {
  it.each(ROLES)('%s has a full-size PNG and an ICO', (role) => {
    const directory = join(ROOT, 'build', role)
    expect(existsSync(join(directory, 'icon-512.png')), `${role} 512 PNG`).toBe(true)
    expect(existsSync(join(directory, 'icon.ico')), `${role} ICO`).toBe(true)
    expect(existsSync(join(directory, 'installer-banner.png')), `${role} banner`).toBe(true)
    expect(existsSync(join(directory, 'installer-sidebar.png')), `${role} sidebar`).toBe(true)
  })

  it.each(ROLES)('%s has the small sizes the shell actually asks for', (role) => {
    for (const size of [16, 24, 32, 48, 64, 128, 256]) {
      const path = join(ROOT, 'build', role, `icon-${size}.png`)
      expect(existsSync(path), `${role} ${size}px`).toBe(true)
      expect(statSync(path).size, `${role} ${size}px is not empty`).toBeGreaterThan(0)
    }
  })
})

describe('the ICO holds every size Windows may ask for', () => {
  it.each(ROLES)('%s stores 16, 32, 48 and 256, not seven copies of 256', (role) => {
    const sizes = icoSizes(join(ROOT, 'build', role, 'icon.ico'))
    // The bug this catches: passing one source repeatedly with `-resize` between them produced a directory of seven
    // 256×256 entries. Windows draws a 16 px slot from the 256 px image and the icon is unreadable at the size most
    // people see it.
    expect(sizes).toEqual([16, 24, 32, 48, 64, 128, 256])
    expect(new Set(sizes).size, 'every entry is a different size').toBe(sizes.length)
  })
})

describe('the two sets are genuinely different', () => {
  it('the Server and Client 512 PNGs are not the same file', () => {
    const server = readFileSync(join(ROOT, 'build', 'server', 'icon-512.png'))
    const client = readFileSync(join(ROOT, 'build', 'client', 'icon-512.png'))
    // This is the assertion the first draft of the generator would have failed. An identical pair means the badge was
    // not drawn, which no file-existence check can detect.
    expect(server.equals(client)).toBe(false)
  })

  it('neither set is a copy of the unbadged source', () => {
    const source = readFileSync(join(ROOT, 'public', 'branding', 'app-icon.png'))
    for (const role of ROLES) {
      expect(readFileSync(join(ROOT, 'build', role, 'icon-512.png')).equals(source), `${role} is unbadged`).toBe(false)
    }
  })

  it('the badge is in the lower right, where a launcher badge belongs', () => {
    // Cropping the bottom-right quadrant and checking it is not uniform: if the badge were not drawn, that quadrant
    // would still hold the background gradient, which averages to one smooth colour.
    for (const role of ROLES) {
      const quadrant = join(ROOT, 'build', role, '.test-quadrant.png')
      try {
        execFileSync('convert', [
          join(ROOT, 'build', role, 'icon-512.png'),
          '-crop', '300x160+212+352', '+repage', quadrant,
        ])
        const deviation = execFileSync('identify', ['-format', '%[fx:standard_deviation]', quadrant]).toString().trim()
        expect(Number(deviation), `${role} badge quadrant looks empty`).toBeGreaterThan(0.08)
      } finally {
        // A test that leaves files in the tree makes `git status` noisy and, worse, makes the next person wonder whether
        // build/client/.test-quadrant.png is an asset they should keep.
        rmSync(quadrant, { force: true })
      }
    }
  })
})

describe('the source art is left alone', () => {
  it('has not been overwritten by a generated variant', () => {
    // The generator composes from `app-icon.png`; if it ever wrote back to the source, every regeneration would badge
    // the badge and the brand would erode a little with each build.
    const source = readFileSync(join(ROOT, 'public', 'branding', 'app-icon.png'))
    expect(source.length).toBeGreaterThan(1000)
    expect(source.equals(readFileSync(join(ROOT, 'build', 'server', 'icon-512.png')))).toBe(false)
  })
})
