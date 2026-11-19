import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

/**
 * The Vendor Cloud package.
 *
 * The vendor uploads this zip to a host and expects it to be the whole cloud. A zip that looks fine and cannot be
 * opened — or that carries a `.env` with the signing secrets in it — is the kind of failure nobody notices until
 * deployment. So the package is built here and read back with an independent reader written below: the central
 * directory is walked by hand, every entry's CRC checked and every deflated entry inflated.
 *
 * That reader is deliberately not the writer's code: `scripts/cloud-package.ts` writes the zip, this parses it.
 */

interface Entry { name: string; method: number; crc: number; compressedSize: number; size: number; offset: number }

/** Reads a zip's central directory the way a host or `unzip` would. */
function readZip(zip: Buffer): Entry[] {
  // Find the end-of-central-directory record by scanning back from the tail, past any comment.
  let end = -1
  for (let offset = zip.length - 22; offset >= 0; offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) { end = offset; break }
  }
  if (end < 0) throw new Error('No end-of-central-directory record: this is not a zip.')
  const count = zip.readUInt16LE(end + 10)
  let cursor = zip.readUInt32LE(end + 16)
  const entries: Entry[] = []
  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50) throw new Error(`Central directory entry ${index} is malformed.`)
    const nameLength = zip.readUInt16LE(cursor + 28)
    const extraLength = zip.readUInt16LE(cursor + 30)
    const commentLength = zip.readUInt16LE(cursor + 32)
    entries.push({
      name: zip.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'),
      method: zip.readUInt16LE(cursor + 10),
      crc: zip.readUInt32LE(cursor + 16),
      compressedSize: zip.readUInt32LE(cursor + 20),
      size: zip.readUInt32LE(cursor + 24),
      offset: zip.readUInt32LE(cursor + 42),
    })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** The bytes of one entry, inflated, with its CRC verified. */
function readEntry(zip: Buffer, entry: Entry): Buffer {
  const local = entry.offset
  if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error(`${entry.name}: local header is malformed.`)
  const nameLength = zip.readUInt16LE(local + 26)
  const extraLength = zip.readUInt16LE(local + 28)
  const start = local + 30 + nameLength + extraLength
  const payload = zip.subarray(start, start + entry.compressedSize)
  const data = entry.method === 0 ? payload : inflateRawSync(payload)
  expect(data.length, `${entry.name}: size disagrees with the directory`).toBe(entry.size)
  expect(crc32(data), `${entry.name}: CRC does not match its contents`).toBe(entry.crc)
  return data
}

describe('the Vendor Cloud package', () => {
  it('is a zip every reader can open, carrying the cloud and nothing secret', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'cloud-pack-'))
    try {
      execFileSync('npx', ['tsx', 'scripts/cloud-package.ts'], { stdio: 'pipe' })
      const path = 'dist/cloud/infoflex-vendor-cloud.zip'
      const zip = readFileSync(path)
      expect(statSync(path).size).toBeGreaterThan(100_000)

      const entries = readZip(zip)
      const names = entries.map((entry) => entry.name)
      // Note: the summary on the Output screen reads this file's size, so it must actually be the cloud.
      expect(names).toContain('cloud/Dockerfile')
      expect(names).toContain('cloud/docker-compose.yml')
      expect(names).toContain('cloud/docs/DEPLOYMENT.md')
      expect(names).toContain('cloud/.env.example')
      expect(names.some((name) => name.startsWith('cloud/src/'))).toBe(true)
      expect(names.some((name) => name.startsWith('cloud/php/'))).toBe(true)

      // The secrets never go in: `.env` itself, the databases, the logs and any private key.
      expect(names.filter((name) => /(?:^|\/)\.env$/u.test(name))).toEqual([])
      expect(names.filter((name) => /node_modules|\.sqlite|\.log$|PRIVATE KEY/u.test(name))).toEqual([])

      // Every entry must actually inflate and match its checksum — a zip that lists files it cannot produce is the
      // failure mode that only appears on the host.
      for (const entry of entries) readEntry(zip, entry)

      // And the one file that must match its source byte for byte, since the vendor deploys it.
      const dockerfile = entries.find((entry) => entry.name === 'cloud/Dockerfile')!
      expect(readEntry(zip, dockerfile).toString('utf8')).toBe(readFileSync('cloud/Dockerfile', 'utf8'))
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }, 60_000)
})
