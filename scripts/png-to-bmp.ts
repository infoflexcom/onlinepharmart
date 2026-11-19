import { readFileSync, writeFileSync } from 'node:fs'
import { deflateSync as _unused } from 'node:zlib'
import { inflateSync } from 'node:zlib'

/**
 * Converts a PNG into the uncompressed 24-bit BMP that NSIS's MUI banner and sidebar require.
 *
 * Written by hand rather than pulled from a package: this runs once per release on the build machine, the input
 * is a fixed pair of brand images, and a dependency that only exists to do it would be one more thing to trust.
 * Supports 8- and 16-bit truecolour with or without alpha, which is what the brand assets are; anything else is
 * refused loudly rather than silently mangled.
 */

interface DecodedPng { width: number; height: number; channels: number; pixels: Buffer }

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

export function decodePng(bytes: Buffer): DecodedPng {
  if (!bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error('Not a PNG file.')
  }
  let position = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat: Buffer[] = []
  while (position < bytes.length) {
    const length = bytes.readUInt32BE(position)
    const type = bytes.subarray(position + 4, position + 8).toString('latin1')
    const data = bytes.subarray(position + 8, position + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]!
      colorType = data[9]!
      interlace = data[12]!
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    position += 12 + length
  }
  if (!width || !height) throw new Error('The PNG has no size.')
  if (bitDepth !== 8 && bitDepth !== 16) throw new Error(`Unsupported PNG bit depth ${bitDepth}.`)
  if (colorType !== 2 && colorType !== 6 && colorType !== 0) {
    throw new Error(`Unsupported PNG colour type ${colorType}; palette images must be re-saved as truecolour.`)
  }
  if (interlace !== 0) throw new Error('Interlaced PNGs are not supported; re-save without interlacing.')

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1
  const bytesPerSample = bitDepth / 8
  const bytesPerPixel = channels * bytesPerSample
  const stride = width * bytesPerPixel
  const raw = inflateSync(Buffer.concat(idat))
  const out = Buffer.alloc(stride * height)
  let previous = Buffer.alloc(stride)
  let offset = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[offset]!
    offset += 1
    const line = Buffer.from(raw.subarray(offset, offset + stride))
    offset += stride
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bytesPerPixel ? line[x - bytesPerPixel]! : 0
      const up = previous[x]!
      const upLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel]! : 0
      if (filter === 1) line[x] = (line[x]! + left) & 0xff
      else if (filter === 2) line[x] = (line[x]! + up) & 0xff
      else if (filter === 3) line[x] = (line[x]! + ((left + up) >> 1)) & 0xff
      else if (filter === 4) line[x] = (line[x]! + paeth(left, up, upLeft)) & 0xff
      else if (filter !== 0) throw new Error(`Unknown PNG filter ${filter}.`)
    }
    line.copy(out, y * stride)
    previous = line
  }
  return { width, height, channels, pixels: out }
}

/** Drops alpha and takes the high byte of a 16-bit sample, producing bottom-up BGR rows as BMP requires. */
export function encodeBmp24(image: DecodedPng): Buffer {
  const { width, height, channels, pixels } = image
  const sampleBytes = channels * 2
  const sixteenBit = pixels.length === width * height * sampleBytes && channels <= 4 && sampleBytes >= 2
    && pixels.length !== width * height * channels
  const rowBytes = width * 3
  const padding = (4 - (rowBytes % 4)) % 4
  const pixelData = Buffer.alloc((rowBytes + padding) * height)
  for (let y = 0; y < height; y += 1) {
    const targetRow = height - 1 - y
    for (let x = 0; x < width; x += 1) {
      let r: number
      let g: number
      let b: number
      if (channels === 1) {
        const index = y * width + x
        r = g = b = pixels[index * (sixteenBit ? 2 : 1)]!
      } else if (sixteenBit) {
        const index = (y * width + x) * channels * 2
        r = pixels[index]!
        g = pixels[index + 2]!
        b = pixels[index + 4]!
      } else {
        const index = (y * width + x) * channels
        r = pixels[index]!
        g = pixels[index + 1]!
        b = pixels[index + 2]!
      }
      const target = targetRow * (rowBytes + padding) + x * 3
      pixelData[target] = b
      pixelData[target + 1] = g
      pixelData[target + 2] = r
    }
  }
  const headerSize = 54
  const header = Buffer.alloc(headerSize)
  header.write('BM', 0, 'latin1')
  header.writeUInt32LE(headerSize + pixelData.length, 2)
  header.writeUInt32LE(headerSize, 10)
  header.writeUInt32LE(40, 14)
  header.writeInt32LE(width, 18)
  header.writeInt32LE(height, 22)
  header.writeUInt16LE(1, 26)
  header.writeUInt16LE(24, 28)
  header.writeUInt32LE(pixelData.length, 34)
  header.writeInt32LE(2835, 38)
  header.writeInt32LE(2835, 42)
  return Buffer.concat([header, pixelData])
}

export function pngToBmp(source: string, target: string): { width: number; height: number; bytes: number } {
  const image = decodePng(readFileSync(source))
  const bmp = encodeBmp24(image)
  writeFileSync(target, bmp)
  return { width: image.width, height: image.height, bytes: bmp.length }
}

if (process.argv[1] && process.argv[1].endsWith('png-to-bmp.ts')) {
  for (const [source, target] of [
    ['build/installer-banner.png', 'build/installer-banner.bmp'],
    ['build/installer-sidebar.png', 'build/installer-sidebar.bmp'],
  ]) {
    const result = pngToBmp(source!, target!)
    console.log(`${target}: ${result.width}x${result.height}, ${result.bytes} bytes`)
  }
}
