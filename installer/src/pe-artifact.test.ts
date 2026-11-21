import { describe, expect, it } from 'vitest'
import { inspectPe } from './pe-artifact.ts'

/**
 * Pins the rules that decide whether `npm run installer:compile` proved anything.
 *
 * Each case below is a real way a build can look successful and not be. NSIS exits 0 on a failed compile unless -V2 is
 * passed, and even a clean -V2 run only proves the script parsed; the artefact is the only evidence. Two of these
 * cases are not hypothetical: the console-subsystem one is a defect this check actually caught (dropping
 * `-Wl,--subsystem,windows` from the stub link), and the "no PE signature" one is what a placeholder stub produced
 * before the stubs were really cross-compiled.
 */

/** Builds a minimal PE32 header with the given overrides, for exercising one rule at a time. */
function pe(overrides: {
  machine?: number
  subsystem?: number
  sections?: number
  optionalHeaderSize?: number
  signature?: string
  dosMagic?: string
  peOffset?: number
  length?: number
} = {}): Buffer {
  const peOffset = overrides.peOffset ?? 0x80
  const length = overrides.length ?? 0x200
  const data = Buffer.alloc(length)
  data.write(overrides.dosMagic ?? 'MZ', 0, 'latin1')
  // peOffset 0 means "leave e_lfanew zeroed", which requires skipping the PE header too -- otherwise the signature
  // would land at offset 0 and overwrite the MZ this case is trying to test.
  if (peOffset !== 0) data.writeUInt32LE(peOffset, 0x3c)
  if (peOffset !== 0 && peOffset + 24 <= length) {
    data.write(overrides.signature ?? 'PE\0\0', peOffset, 'latin1')
    data.writeUInt16LE(overrides.machine ?? 0x014c, peOffset + 4)
    data.writeUInt16LE(overrides.sections ?? 7, peOffset + 6)
    data.writeUInt16LE(overrides.optionalHeaderSize ?? 224, peOffset + 20)
    const subsystemOffset = peOffset + 24 + 68
    if (subsystemOffset + 2 <= length) data.writeUInt16LE(overrides.subsystem ?? 2, subsystemOffset)
  }
  return data
}

describe('the produced installer is checked by its own header', () => {
  it('accepts a well-formed i386 GUI PE32', () => {
    expect(inspectPe(pe())).toEqual({ bytes: 0x200, peOffset: 0x80, machine: 0x014c, subsystem: 2, sections: 7 })
  })

  it('rejects a file that does not start with MZ', () => {
    // A one-byte placeholder stub used to end the build exactly here, as "PE file contains invalid DOS header".
    expect(() => inspectPe(pe({ dosMagic: 'XX' }))).toThrow(/does not start with MZ/u)
  })

  it('rejects a file too small to have a header', () => {
    expect(() => inspectPe(Buffer.from('not an installer'))).toThrow(/only 16 bytes/u)
  })

  it('rejects a DOS header pointing past the end of the file', () => {
    expect(() => inspectPe(pe({ peOffset: 0x10000 }))).toThrow(/past the end/u)
  })

  it('rejects a DOS header with no PE offset at all', () => {
    expect(() => inspectPe(pe({ peOffset: 0 }))).toThrow(/no PE offset/u)
  })

  it('rejects a file with no PE signature where the DOS header points', () => {
    expect(() => inspectPe(pe({ signature: 'NE\0\0' }))).toThrow(/not a Windows executable/u)
  })

  it('rejects an x64 stub, which cannot run as a 32-bit installer', () => {
    expect(() => inspectPe(pe({ machine: 0x8664 }))).toThrow(/machine is x86-64, expected 0x14c/u)
  })

  it('rejects a console-subsystem build, which would flash a terminal at the vendor', () => {
    // This is not hypothetical: it is what the stubs became when -Wl,--subsystem,windows was dropped from the link.
    expect(() => inspectPe(pe({ subsystem: 3 }))).toThrow(/subsystem is console, expected 2/u)
  })

  it('rejects a PE32+ optional header, which would mean a 64-bit build', () => {
    expect(() => inspectPe(pe({ optionalHeaderSize: 240 }))).toThrow(/expected 224 for PE32/u)
  })

  it('rejects a header that declares no sections', () => {
    expect(() => inspectPe(pe({ sections: 0 }))).toThrow(/zero sections/u)
  })

  it('rejects a truncated optional header instead of throwing a RangeError', () => {
    // With the PE header at 0x100, the subsystem field starts at 0x15c: past the 0x100-byte floor that the size check
    // applies, and past the end of a 0x15c-byte file. The floor has to be cleared first or that check answers instead.
    expect(() => inspectPe(pe({ peOffset: 0x100, length: 0x15c }))).toThrow(/truncated before the subsystem/u)
  })
})
