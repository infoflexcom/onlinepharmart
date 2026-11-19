import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { decodePng, encodeBmp24, pngToBmp } from '../../scripts/png-to-bmp'

/**
 * The brand images the installer shows.
 *
 * NSIS's MUI banner and sidebar must be 24-bit BMP — it will not read a PNG — and a wrong or blank image is the
 * first thing a customer sees, so "the file exists" is not enough. These assert the transformation itself: the
 * image survives at the right size, the pixels are not blank, and the navy of the brand is actually present.
 */

const directory = mkdtempSync(join(tmpdir(), 'infoflex-bmp-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

function pixelsOf(bmp: Buffer): { width: number; height: number; at: (x: number, y: number) => [number, number, number] } {
  const dataOffset = bmp.readUInt32LE(10)
  const width = bmp.readInt32LE(18)
  const height = bmp.readInt32LE(22)
  const rowSize = Math.ceil((width * 3) / 4) * 4
  return {
    width,
    height,
    at(x, y) {
      // BMP rows run bottom-up.
      const index = dataOffset + (height - 1 - y) * rowSize + x * 3
      return [bmp[index + 2]!, bmp[index + 1]!, bmp[index]!]
    },
  }
}

/**
 * The brand navy *family*. The primary token is #1F3F73, but the sidebar art is a gradient whose dark stop is
 * #183760; both are "the navy" to a person looking at it, and a test that only accepted the exact primary token
 * would fail on the shipped artwork for no good reason. The bounds below are the two stops with a little room
 * for 16-bit to 8-bit rounding.
 */
function isBrandNavy([r, g, b]: [number, number, number]): boolean {
  return r >= 0x14 && r <= 0x2c && g >= 0x30 && g <= 0x4c && b >= 0x58 && b <= 0x80
}

describe('the installer brand images', () => {
  it('decodes the 16-bit source and writes a valid 24-bit BMP', () => {
    const target = join(directory, 'sidebar.bmp')
    const result = pngToBmp('build/installer-sidebar.png', target)
    expect(result.width).toBeGreaterThan(0)
    expect(result.height).toBeGreaterThan(0)
    const bmp = readFileSync(target)
    expect(bmp.subarray(0, 2).toString('latin1')).toBe('BM')
    expect(bmp.readUInt16LE(28)).toBe(24)
    const view = pixelsOf(bmp)
    expect(view.width).toBe(result.width)
    expect(view.height).toBe(result.height)
  })

  it('keeps the brand navy rather than producing a blank or black image', () => {
    const image = decodePng(readFileSync('build/installer-sidebar.png'))
    const view = pixelsOf(encodeBmp24(image))
    // Sample a grid; a real brand panel is mostly navy, so a blank or mis-decoded image fails here.
    let navy = 0
    let total = 0
    for (let y = 0; y < view.height; y += 7) {
      for (let x = 0; x < view.width; x += 7) {
        total += 1
        if (isBrandNavy(view.at(x, y))) navy += 1
      }
    }
    expect(total).toBeGreaterThan(100)
    expect(navy / total).toBeGreaterThan(0.3)
  })

  it('refuses a file that is not a PNG rather than emitting a corrupt BMP', () => {
    expect(() => decodePng(Buffer.from('this is not a png'))).toThrow(/not a png|no size/iu)
  })

  it('ships the banner and sidebar as BMP beside the PNG sources', () => {
    for (const name of ['installer-banner.bmp', 'installer-sidebar.bmp']) {
      const bmp = readFileSync(join('build', name))
      expect(bmp.subarray(0, 2).toString('latin1'), name).toBe('BM')
      expect(bmp.readUInt16LE(28), name).toBe(24)
    }
  })
})
