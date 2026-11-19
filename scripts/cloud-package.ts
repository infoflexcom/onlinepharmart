import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'

/**
 * Packs the Vendor Cloud into one zip the vendor can upload.
 *
 * The point is that the vendor never has to assemble this by hand: containing the source, the Docker files, the
 * deployment guide and the PHP build, in the same order every time, so a support call can ask about "the cloud
 * package for version X" and get the same file. Nothing secret is included — `cloud/.env` is refused rather than
 * packed, because a package with the licence signing secrets inside it is a package that gets emailed around.
 *
 * The zip is written by hand rather than with a dependency: `zlib` is already here, and the format for stored and
 * deflated entries is small enough to be certain about. `unzip -t` proves the result, and
 * `cloud-package.test.ts` reads it back with an independent reader.
 */

const OUTPUT = join('dist', 'cloud', 'infoflex-vendor-cloud.zip')

/** Included, relative to the project root. Directories are walked; files are taken as they are. */
const INCLUDE = [
  'cloud/src',
  'cloud/php',
  'cloud/docs',
  'cloud/assets',
  'cloud/tests',
  'cloud/Dockerfile',
  'cloud/Caddyfile',
  'cloud/docker-compose.yml',
  'cloud/README.md',
  'cloud/.env.example',
]

/** Never packed, even if a future include list is broader. */
const REFUSE = [/(?:^|\/)\.env(?!\.example)$/u, /(?:^|\/)node_modules\//u, /\.log$/u, /\.sqlite/u, /PRIVATE KEY/u]

interface Entry { name: string; data: Buffer; modified: Date }

function walk(path: string, into: Entry[]): void {
  const info = statSync(path)
  if (info.isDirectory()) {
    for (const child of readdirSync(path).sort()) walk(join(path, child), into)
    return
  }
  const name = relative('.', path).split('\\').join('/')
  if (REFUSE.some((pattern) => pattern.test(name))) {
    console.log(`Skipped ${name}: never goes in a package.`)
    return
  }
  into.push({ name, data: readFileSync(path), modified: info.mtime })
}

/** MS-DOS date and time, which is what a zip directory entry carries. */
function dosDateTime(date: Date): { time: number; date: number } {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, date: day }
}

/** One zip, deflated where that helps and stored where it does not. */
function buildZip(entries: Entry[]): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const deflated = deflateRawSync(entry.data, { level: 9 })
    const useDeflate = deflated.length < entry.data.length
    const payload = useDeflate ? deflated : entry.data
    const crc = crc32(entry.data)
    const name = Buffer.from(entry.name, 'utf8')
    const { time, date } = dosDateTime(entry.modified)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // Version needed: 2.0, which covers deflate.
    local.writeUInt16LE(0x0800, 6) // UTF-8 file names.
    local.writeUInt16LE(useDeflate ? 8 : 0, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, payload)

    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(20, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(0x0800, 8)
    record.writeUInt16LE(useDeflate ? 8 : 0, 10)
    record.writeUInt16LE(time, 12)
    record.writeUInt16LE(date, 14)
    record.writeUInt32LE(crc, 16)
    record.writeUInt32LE(payload.length, 20)
    record.writeUInt32LE(entry.data.length, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt32LE(offset, 42)
    central.push(record, name)

    offset += local.length + name.length + payload.length
  }

  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

function main(): void {
  const entries: Entry[] = []
  for (const path of INCLUDE) {
    if (!existsSync(path)) {
      // A missing optional file must not stop the package; a missing source folder is a broken checkout.
      console.log(`Not found, skipped: ${path}`)
      continue
    }
    walk(path, entries)
  }
  if (entries.length === 0) throw new Error('Nothing to pack: is this the project folder?')

  const zip = buildZip(entries)
  mkdirSync(dirname(OUTPUT), { recursive: true })
  writeFileSync(OUTPUT, zip)
  const bytes = entries.reduce((total, entry) => total + entry.data.length, 0)
  console.log(`Wrote ${OUTPUT}: ${entries.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB unpacked, ${(zip.length / 1024).toFixed(0)} KB packed.`)
}

main()
