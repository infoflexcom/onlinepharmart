/**
 * Optional extra check: decode the QR images the desktop draws with an independent decoder (`jsQR`), so the
 * matrices cannot pass our own tests while a real camera/app fails. Kept out of `npm test` (and out of the
 * dependency list) so the shipped bundle carries no QR-decoding weight; run it when the encoder changes:
 *
 *   npm install --no-save jsqr && npx tsx scripts/verify-qr-code.ts
 */
import { encodeQr } from '../src/shared/qr/qr-code'

const PAYLOADS = [
  'https://192.168.1.20:43871/',
  'https://10.0.0.5:43871/',
  'https://172.16.44.9:51234/',
  'https://infoflex-harbor-pharmacy.local:43871/',
  'https://192.168.100.200:65535/?shop=1',
  'otpauth://totp/Infoflex:admin?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Infoflex&algorithm=SHA1&digits=6&period=30',
  'otpauth://totp/Infoflex%20Pharmacy:amaka.okafor@infoflex-ng.com?secret=KRSXG5CTMVRXEZLUGE2TINLEGE2TINLENVSXG5CT&issuer=Infoflex%20Pharmacy&algorithm=SHA1&digits=6&period=30'
]

const SCALE = 5
const BORDER = 4

async function main(): Promise<void> {
  const module = await import('jsqr').catch(() => null)
  if (!module) {
    console.error('jsqr is not installed. Run: npm install --no-save jsqr')
    process.exit(2)
  }
  const decode = (module.default ?? module) as (
    data: Uint8ClampedArray, width: number, height: number
  ) => { data: string } | null

  let failures = 0
  for (const payload of PAYLOADS) {
    const matrix = encodeQr(payload)
    const dimension = (matrix.size + BORDER * 2) * SCALE
    const pixels = new Uint8ClampedArray(dimension * dimension * 4).fill(255)
    for (let y = 0; y < matrix.size; y += 1) {
      for (let x = 0; x < matrix.size; x += 1) {
        if (!matrix.modules[y]![x]) continue
        for (let dy = 0; dy < SCALE; dy += 1) {
          for (let dx = 0; dx < SCALE; dx += 1) {
            const index = (((y + BORDER) * SCALE + dy) * dimension + (x + BORDER) * SCALE + dx) * 4
            pixels[index] = 0
            pixels[index + 1] = 0
            pixels[index + 2] = 0
            pixels[index + 3] = 255
          }
        }
      }
    }
    const decoded = decode(pixels, dimension, dimension)?.data ?? ''
    const version = (matrix.size - 17) / 4
    if (decoded === payload) {
      console.log(`read ok   version ${version}  ${payload.slice(0, 52)}`)
    } else {
      failures += 1
      console.log(`FAILED    version ${version}  ${payload.slice(0, 52)}`)
      console.log(`            decoded: ${decoded.slice(0, 52) || '(nothing)'}`)
    }
  }
  console.log(failures === 0 ? `all ${PAYLOADS.length} payloads decoded` : `${failures} payloads failed`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
