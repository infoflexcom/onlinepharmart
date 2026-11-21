/**
 * A small QR Code encoder for the one thing this app needs: putting a short URL on screen so a phone's
 * normal camera app can open it.
 *
 * Scope is deliberately narrow — byte mode, error-correction level M, versions 1–10 (up to 213 bytes) — which
 * comfortably covers `https://192.168.1.20:43871/`. Implementing it here avoids a runtime dependency in the
 * desktop bundle, and the output is covered by tests against known-good matrices.
 *
 * Algorithm follows ISO/IEC 18004: data encoding, Reed–Solomon error correction, module placement, and mask
 * selection by penalty score.
 */

/** Error-correction level M: about 15% recovery, the usual choice for a printed or on-screen URL. */
const ECC_CODEWORDS_PER_BLOCK_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26]
const NUM_ERROR_CORRECTION_BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5]

export interface QrMatrix {
  size: number
  /** Row-major modules; true is a dark module. */
  modules: boolean[][]
}

export function encodeQr(text: string): QrMatrix {
  const data = new TextEncoder().encode(text)
  const version = chooseVersion(data.length)
  const bits = buildDataCodewords(data, version)
  const codewords = addErrorCorrection(bits, version)
  return buildMatrix(version, codewords)
}

/** Smallest version (1–10) whose data capacity can hold this many bytes at level M. */
function chooseVersion(byteLength: number): number {
  for (let version = 1; version <= 10; version += 1) {
    const capacityBits = numDataCodewords(version) * 8
    // 4-bit mode indicator + character count (8 bits for versions 1–9, 16 bits from version 10).
    const headerBits = 4 + (version < 10 ? 8 : 16)
    if (headerBits + byteLength * 8 <= capacityBits) return version
  }
  throw new Error('That address is too long to show as a QR code. Type it instead.')
}

function numRawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (version >= 7) result -= 36
  }
  return result
}

function numDataCodewords(version: number): number {
  return Math.floor(numRawDataModules(version) / 8) - ECC_CODEWORDS_PER_BLOCK_M[version]! * NUM_ERROR_CORRECTION_BLOCKS_M[version]!
}

/** Mode indicator, character count, data bytes, terminator and pad bytes. */
function buildDataCodewords(data: Uint8Array, version: number): number[] {
  const bits: number[] = []
  const push = (value: number, length: number): void => {
    for (let index = length - 1; index >= 0; index -= 1) bits.push((value >>> index) & 1)
  }
  push(0b0100, 4) // byte mode
  push(data.length, version < 10 ? 8 : 16)
  for (const byte of data) push(byte, 8)

  const capacity = numDataCodewords(version) * 8
  push(0, Math.min(4, capacity - bits.length))
  push(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8)

  const codewords: number[] = []
  for (let index = 0; index < bits.length; index += 8) {
    let byte = 0
    for (let offset = 0; offset < 8; offset += 1) byte = (byte << 1) | bits[index + offset]!
    codewords.push(byte)
  }
  return codewords
}

/** Splits into blocks, computes Reed–Solomon parity, and interleaves — exactly as the standard requires. */
function addErrorCorrection(data: number[], version: number): number[] {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS_M[version]!
  const eccLen = ECC_CODEWORDS_PER_BLOCK_M[version]!
  const rawCodewords = Math.floor(numRawDataModules(version) / 8)
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks)
  const shortBlockLen = Math.floor(rawCodewords / numBlocks)

  const divisor = reedSolomonDivisor(eccLen)
  const blocks: Array<{ data: number[]; ecc: number[] }> = []
  for (let block = 0, offset = 0; block < numBlocks; block += 1) {
    const dataLen = shortBlockLen - eccLen + (block < numShortBlocks ? 0 : 1)
    const chunk = data.slice(offset, offset + dataLen)
    offset += dataLen
    blocks.push({ data: chunk, ecc: reedSolomonRemainder(chunk, divisor) })
  }

  const result: number[] = []
  const maxDataLen = shortBlockLen - eccLen + 1
  for (let index = 0; index < maxDataLen; index += 1) {
    for (const block of blocks) if (index < block.data.length) result.push(block.data[index]!)
  }
  for (let index = 0; index < eccLen; index += 1) {
    for (const block of blocks) result.push(block.ecc[index]!)
  }
  return result
}

/** GF(2^8) arithmetic with the QR polynomial 0x11D. */
function reedSolomonDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let index = 0; index < degree; index += 1) {
    for (let coefficient = 0; coefficient < result.length; coefficient += 1) {
      result[coefficient] = multiply(result[coefficient]!, root)
      if (coefficient + 1 < result.length) result[coefficient] ^= result[coefficient + 1]!
    }
    root = multiply(root, 0x02)
  }
  return result
}

function reedSolomonRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0)
  for (const byte of data) {
    const factor = byte ^ result.shift()!
    result.push(0)
    divisor.forEach((coefficient, index) => {
      result[index] ^= multiply(coefficient, factor)
    })
  }
  return result
}

function multiply(left: number, right: number): number {
  let product = 0
  for (let index = 7; index >= 0; index -= 1) {
    product = (product << 1) ^ ((product >>> 7) * 0x11d)
    product ^= ((right >>> index) & 1) * left
  }
  return product & 0xff
}

function buildMatrix(version: number, codewords: number[]): QrMatrix {
  const size = version * 4 + 17
  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const isFunction: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))

  const setFunction = (x: number, y: number, dark: boolean): void => {
    modules[y]![x] = dark
    isFunction[y]![x] = true
  }

  // Timing patterns
  for (let index = 0; index < size; index += 1) {
    setFunction(6, index, index % 2 === 0)
    setFunction(index, 6, index % 2 === 0)
  }
  drawFinder(0, 0)
  drawFinder(size - 7, 0)
  drawFinder(0, size - 7)
  drawAlignmentPatterns()
  drawFormatBits(0)
  drawVersion()

  // Place the data bits in the zig-zag order the standard defines.
  let bitIndex = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let offset = 0; offset < 2; offset += 1) {
        const x = right - offset
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vertical : vertical
        if (isFunction[y]![x]) continue
        const bit = bitIndex < codewords.length * 8
          ? ((codewords[bitIndex >>> 3]! >>> (7 - (bitIndex & 7))) & 1) === 1
          : false
        modules[y]![x] = bit
        bitIndex += 1
      }
    }
  }

  // Choose the mask with the lowest penalty, then write the format bits for it.
  let bestMask = 0
  let lowestPenalty = Number.POSITIVE_INFINITY
  for (let mask = 0; mask < 8; mask += 1) {
    applyMask(mask)
    drawFormatBits(mask)
    const penalty = penaltyScore()
    if (penalty < lowestPenalty) {
      lowestPenalty = penalty
      bestMask = mask
    }
    applyMask(mask) // XOR again to undo
  }
  applyMask(bestMask)
  drawFormatBits(bestMask)
  return { size, modules }

  function drawFinder(left: number, top: number): void {
    for (let dy = -1; dy <= 7; dy += 1) {
      for (let dx = -1; dx <= 7; dx += 1) {
        const x = left + dx
        const y = top + dy
        if (x < 0 || x >= size || y < 0 || y >= size) continue
        const dark = (dx >= 0 && dx <= 6 && (dy === 0 || dy === 6))
          || (dy >= 0 && dy <= 6 && (dx === 0 || dx === 6))
          || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4)
        setFunction(x, y, dark)
      }
    }
  }

  function drawAlignmentPatterns(): void {
    if (version === 1) return
    const positions = alignmentPositions(version)
    for (const y of positions) {
      for (const x of positions) {
        // Skip the three corners already occupied by finder patterns.
        if ((x === 6 && y === 6) || (x === 6 && y === size - 7) || (x === size - 7 && y === 6)) continue
        for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            setFunction(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
          }
        }
      }
    }
  }

  function drawFormatBits(mask: number): void {
    // Level M is 0b00 in the format field.
    const data = (0b00 << 3) | mask
    let remainder = data
    for (let index = 0; index < 10; index += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537)
    const bits = ((data << 10) | remainder) ^ 0x5412

    const bit = (index: number): boolean => ((bits >>> index) & 1) === 1
    for (let index = 0; index <= 5; index += 1) setFunction(8, index, bit(index))
    setFunction(8, 7, bit(6))
    setFunction(8, 8, bit(7))
    setFunction(7, 8, bit(8))
    for (let index = 9; index < 15; index += 1) setFunction(14 - index, 8, bit(index))

    for (let index = 0; index < 8; index += 1) setFunction(size - 1 - index, 8, bit(index))
    for (let index = 8; index < 15; index += 1) setFunction(8, size - 15 + index, bit(index))
    setFunction(8, size - 8, true) // the always-dark module
  }

  function drawVersion(): void {
    if (version < 7) return
    let remainder = version
    for (let index = 0; index < 12; index += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25)
    const bits = (version << 12) | remainder
    for (let index = 0; index < 18; index += 1) {
      const dark = ((bits >>> index) & 1) === 1
      const a = size - 11 + (index % 3)
      const b = Math.floor(index / 3)
      setFunction(a, b, dark)
      setFunction(b, a, dark)
    }
  }

  function applyMask(mask: number): void {
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (isFunction[y]![x]) continue
        let invert: boolean
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break
          case 1: invert = y % 2 === 0; break
          case 2: invert = x % 3 === 0; break
          case 3: invert = (x + y) % 3 === 0; break
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break
        }
        if (invert) modules[y]![x] = !modules[y]![x]
      }
    }
  }

  function penaltyScore(): number {
    let penalty = 0
    const lines: boolean[][] = []
    for (let y = 0; y < size; y += 1) lines.push(modules[y]!)
    for (let x = 0; x < size; x += 1) lines.push(modules.map((row) => row[x]!))

    for (const line of lines) {
      // Rule 1: runs of five or more.
      let run = 1
      for (let index = 1; index < size; index += 1) {
        if (line[index] === line[index - 1]) {
          run += 1
        } else {
          if (run >= 5) penalty += 3 + (run - 5)
          run = 1
        }
      }
      if (run >= 5) penalty += 3 + (run - 5)
      // Rule 3: finder-like 1:1:3:1:1 patterns with four light modules on one side.
      for (let index = 0; index + 10 < size; index += 1) {
        const pattern = line.slice(index, index + 11)
        if (matchesFinderLike(pattern)) penalty += 40
      }
    }
    // Rule 2: 2x2 blocks of one colour.
    for (let y = 0; y < size - 1; y += 1) {
      for (let x = 0; x < size - 1; x += 1) {
        const colour = modules[y]![x]
        if (colour === modules[y]![x + 1] && colour === modules[y + 1]![x] && colour === modules[y + 1]![x + 1]) penalty += 3
      }
    }
    // Rule 4: deviation from half dark.
    const dark = modules.flat().filter(Boolean).length
    const percent = (dark * 100) / (size * size)
    penalty += Math.floor(Math.abs(percent - 50) / 5) * 10
    return penalty
  }
}

function matchesFinderLike(line: boolean[]): boolean {
  const dark = [true, false, true, true, true, false, true]
  const startsDark = line[0] === true && line.slice(0, 7).every((value, index) => value === dark[index])
  const endsDark = line[3] === true && line.slice(3, 10).every((value, index) => value === dark[index])
  const lightBefore = startsDark && line.slice(7, 11).every((value) => value === false)
  const lightAfter = endsDark && line.slice(0, 4).every((value) => value === false)
  return lightBefore || lightAfter
}

export function alignmentPositions(version: number): number[] {
  if (version === 1) return []
  const size = version * 4 + 17
  const count = Math.floor(version / 7) + 2
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2
  const result = [6]
  for (let position = size - 7; result.length < count; position -= step) result.splice(1, 0, position)
  return result
}

/** Renders a matrix as a standalone SVG path, for the desktop screen. */
export function qrToSvg(matrix: QrMatrix, options: { border?: number; size?: number } = {}): string {
  const border = options.border ?? 4
  const dimension = matrix.size + border * 2
  const commands: string[] = []
  for (let y = 0; y < matrix.size; y += 1) {
    for (let x = 0; x < matrix.size; x += 1) {
      if (matrix.modules[y]![x]) commands.push(`M${x + border},${y + border}h1v1h-1z`)
    }
  }
  const sizeAttribute = options.size ? ` width="${options.size}" height="${options.size}"` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dimension} ${dimension}"${sizeAttribute} shape-rendering="crispEdges" role="img" aria-label="QR code for the mobile address"><rect width="${dimension}" height="${dimension}" fill="#ffffff"/><path d="${commands.join('')}" fill="#000000"/></svg>`
}
