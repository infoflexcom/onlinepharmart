/**
 * Reads a produced Windows executable the way Windows does, and refuses anything that is not a complete 32-bit GUI
 * installer.
 *
 * WHY THIS IS IN `src/` RATHER THAN IN THE SCRIPT
 *
 * It is the only part of `npm run installer:compile` that can be tested without a compiler, and it is the part that
 * decides whether the run proved anything. A check that reports "makensis printed no errors" is not a check: makensis
 * exits 0 on script errors unless -V2 is passed, and even with -V2 a clean run only means the script parsed. What turns
 * that into evidence is looking at the bytes that came out.
 *
 * The rules encoded here are the cheap, real ones:
 *
 *  - DOS magic `MZ`, or nothing will load it.
 *  - A PE signature at the offset the DOS header gives (`e_lfanew`), which is how the loader finds the rest.
 *  - Machine 0x014c (i386). NSIS stubs are x86; an x64 header would mean the stub was cross-compiled for the wrong
 *    target, which is a mistake that produces a working-looking file that cannot run on the vendor's machine.
 *  - Subsystem 2 (Windows GUI). This one has teeth: it caught a real defect. Dropping `-Wl,--subsystem,windows` from
 *    the stub link produced a console binary, which would have flashed a terminal window at the vendor during install.
 *  - A non-zero section count and a 224-byte optional header (PE32, not PE32+).
 *
 * It deliberately does not try to validate the resource section, the import table or the checksum. Those are the
 * loader's job on a real machine, and pretending to check them here would be the same mistake as the old macro
 * allowlist: a confident answer about something not actually examined.
 */

/** What a produced installer is, described by its own header. */
export interface PeArtifact {
  bytes: number
  /** Offset of the PE header, from the DOS header's `e_lfanew`. */
  peOffset: number
  /** IMAGE_FILE_HEADER.Machine. 0x014c is i386. */
  machine: number
  /** IMAGE_OPTIONAL_HEADER.Subsystem. 2 is IMAGE_SUBSYSTEM_WINDOWS_GUI. */
  subsystem: number
  sections: number
}

const IMAGE_FILE_MACHINE_I386 = 0x014c
const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2
/** PE32 optional header size. PE32+ (64-bit) is 240. */
const PE32_OPTIONAL_HEADER_SIZE = 224

/**
 * Parses and validates a PE32 executable, throwing with a specific reason when it is not one.
 *
 * The error messages name the field and the value, because this function's job is to explain a failure to whoever
 * reads the build log — "invalid installer" would send them looking in the wrong place.
 */
export function inspectPe(data: Buffer): PeArtifact {
  if (data.length < 0x100) throw new Error(`installer is only ${data.length} bytes`)
  if (data.subarray(0, 2).toString('latin1') !== 'MZ') throw new Error('installer does not start with MZ')

  const peOffset = data.readUInt32LE(0x3c)
  if (peOffset === 0) throw new Error('DOS header has no PE offset, so there is no PE header to read')
  if (peOffset + 24 > data.length) throw new Error(`PE header offset ${peOffset} is past the end of the file`)
  if (data.subarray(peOffset, peOffset + 4).toString('latin1') !== 'PE\0\0') {
    throw new Error('no PE signature at the DOS header offset, so this is not a Windows executable')
  }

  const machine = data.readUInt16LE(peOffset + 4)
  const sections = data.readUInt16LE(peOffset + 6)
  const optionalHeaderSize = data.readUInt16LE(peOffset + 20)

  if (machine !== IMAGE_FILE_MACHINE_I386) {
    const name = machine === 0x8664 ? 'x86-64' : `0x${machine.toString(16)}`
    throw new Error(`machine is ${name}, expected 0x14c (i386)`)
  }
  if (sections === 0) throw new Error('PE header declares zero sections')
  if (optionalHeaderSize !== PE32_OPTIONAL_HEADER_SIZE) {
    throw new Error(`optional header is ${optionalHeaderSize} bytes, expected 224 for PE32`)
  }

  // The subsystem sits after the 68-byte standard fields, inside the optional header. Reading it guarded rather than
  // in-line: a truncated file would otherwise throw a RangeError with no useful message.
  const subsystemOffset = peOffset + 24 + 68
  if (subsystemOffset + 2 > data.length) throw new Error('optional header is truncated before the subsystem field')
  const subsystem = data.readUInt16LE(subsystemOffset)
  if (subsystem !== IMAGE_SUBSYSTEM_WINDOWS_GUI) {
    const name = subsystem === 3 ? 'console' : String(subsystem)
    throw new Error(`subsystem is ${name}, expected 2 (Windows GUI): the installer would open a terminal window`)
  }

  return { bytes: data.length, peOffset, machine, subsystem, sections }
}
