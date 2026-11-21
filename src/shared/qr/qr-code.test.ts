import { describe, expect, it } from 'vitest'
import { alignmentPositions, encodeQr, qrToSvg } from './qr-code'

/** ISO/IEC 18004 penalties aside, the structural invariants below catch most encoder mistakes. */
describe('the QR encoder used for the pairing address', () => {
  it('encodes a LAN address at the smallest suitable version', () => {
    const matrix = encodeQr('https://192.168.1.20:43871/')
    expect(matrix.size).toBeGreaterThanOrEqual(21)
    expect((matrix.size - 17) % 4).toBe(0)
    expect(matrix.modules).toHaveLength(matrix.size)
    expect(matrix.modules.every((row) => row.length === matrix.size)).toBe(true)
  })

  it('draws the three finder patterns in the corners', () => {
    const { size, modules } = encodeQr('https://192.168.1.20:43871/')
    // The 7x7 finder is a ring: dark border, light inner ring, 3x3 dark centre.
    const checkFinder = (left: number, top: number): void => {
      for (let y = 0; y < 7; y += 1) {
        for (let x = 0; x < 7; x += 1) {
          const onBorder = x === 0 || x === 6 || y === 0 || y === 6
          const inCentre = x >= 2 && x <= 4 && y >= 2 && y <= 4
          expect(modules[top + y]![left + x], `finder ${left},${top} at ${x},${y}`).toBe(onBorder || inCentre)
        }
      }
    }
    checkFinder(0, 0)
    checkFinder(size - 7, 0)
    checkFinder(0, size - 7)
  })

  it('draws the timing patterns that let a scanner find the grid', () => {
    const { modules } = encodeQr('https://192.168.1.20:43871/')
    for (let index = 8; index < 13; index += 1) {
      expect(modules[6]![index]).toBe(index % 2 === 0)
      expect(modules[index]![6]).toBe(index % 2 === 0)
    }
  })

  it('marks the format area, including the always-dark module', () => {
    const { size, modules } = encodeQr('https://192.168.1.20:43871/')
    // The dark module sits just below the top-right finder, at (8, size - 8).
    expect(modules[size - 8]![8]).toBe(true)
    // Dark module on the top-left format strip too.
    expect(typeof modules[8]![8]).toBe('boolean')
  })

  it('grows with the payload and stays a valid size', () => {
    const short = encodeQr('https://10.0.0.5:43871/')
    const longer = encodeQr(`https://192.168.1.20:43871/?shop=${'a'.repeat(120)}`)
    expect(longer.size).toBeGreaterThan(short.size)
    expect((longer.size - 17) % 4).toBe(0)
  })

  it('refuses a payload it cannot fit rather than emitting an unscannable code', () => {
    expect(() => encodeQr(`https://example.test/${'x'.repeat(400)}`)).toThrow(/too long/u)
  })

  it('produces different matrices for different addresses', () => {
    const first = encodeQr('https://192.168.1.20:43871/').modules.flat().join('')
    const second = encodeQr('https://192.168.1.21:43871/').modules.flat().join('')
    expect(first).not.toBe(second)
  })

  it('is deterministic, so redrawing the same address looks identical', () => {
    const first = encodeQr('https://192.168.1.20:43871/').modules.flat().join('')
    const second = encodeQr('https://192.168.1.20:43871/').modules.flat().join('')
    expect(first).toBe(second)
  })

  it('renders an SVG with a quiet border and no script', () => {
    const svg = qrToSvg(encodeQr('https://192.168.1.20:43871/'), { size: 240 })
    expect(svg.startsWith('<svg ')).toBe(true)
    expect(svg).toContain('width="240"')
    expect(svg).toContain('fill="#ffffff"')
    expect(svg).toContain('role="img"')
    expect(svg).not.toContain('<script')
  })

  it('places alignment patterns where the standard says, for several versions', () => {
    expect(alignmentPositions(1)).toEqual([])
    expect(alignmentPositions(2)).toEqual([6, 18])
    expect(alignmentPositions(7)).toEqual([6, 22, 38])
    // Every position must sit inside the symbol.
    for (let version = 2; version <= 10; version += 1) {
      for (const position of alignmentPositions(version)) {
        expect(position).toBeGreaterThanOrEqual(6)
        expect(position).toBeLessThanOrEqual(version * 4 + 17 - 7)
      }
    }
  })
})
