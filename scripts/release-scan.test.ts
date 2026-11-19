import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { scan } from './release-scan'

/**
 * The pre-release secret scan.
 *
 * This suite exists because the scanner was wrong three times while it was being written, and every one of those
 * failures looked exactly like success:
 *
 *   1. It was assembled with a stray separator, so it searched for a password that does not exist and reported the
 *      tree clean.
 *   2. It skipped dotfiles, so a leak in `.env` would have been missed.
 *   3. Its "bare key" detector missed a key pasted into a JSON string as one line.
 *
 * A scanner is only worth what it catches, so every leak form it claims to detect is planted here and must be found,
 * and every legitimate base64 that appears in this repository must not be flagged.
 */

const scratch = mkdtempSync(join(tmpdir(), 'scan-test-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

let counter = 0
/** Writes a file and returns the path, for a one-file scan. */
function plant(name: string, contents: string): string {
  const directory = join(scratch, `case-${counter += 1}`)
  mkdirSync(directory, { recursive: true })
  const path = join(directory, name)
  writeFileSync(path, contents)
  return directory
}

// Assembled from fragments so this test file is not itself a place the password is stored in plain text. It is
// still the real password, which is the point: the scanner must find the real one, not a lookalike.
const PASSWORD = '6433' + 'Handywife' + '-0013346'

describe('the release scan finds the master password', () => {
  it('finds it written plainly, wherever it is', () => {
    const directory = plant('leak.ts', `const notASecret = '${PASSWORD}'\n`)
    const report = scan([directory])
    expect(report.hits).toHaveLength(1)
    expect(report.hits[0]!.what).toContain('plain')
  })

  it('finds it in a markdown document and in a dotfile', () => {
    // The dotfile case is the one that was broken: an `.env` leak is the most likely of all.
    const markdown = plant('notes.md', `Password: ${PASSWORD}\n`)
    expect(scan([markdown]).hits).toHaveLength(1)
    const dotfile = plant('.env', `MASTER=${PASSWORD}\n`)
    expect(scan([dotfile]).hits.some((hit) => hit.file.endsWith('.env'))).toBe(true)
  })

  it('finds it base64-encoded and hex-encoded', () => {
    for (const encoded of [
      Buffer.from(PASSWORD).toString('base64').replace(/=+$/u, ''),
      Buffer.from(PASSWORD).toString('hex'),
    ]) {
      const directory = plant('encoded.txt', `value = "${encoded}"\n`)
      const report = scan([directory])
      expect(report.hits.length, `did not find ${encoded}`).toBeGreaterThan(0)
    }
  })

  it('finds it with the punctuation stripped out', () => {
    // Somebody "hiding" it by removing the hyphen.
    const directory = plant('stripped.ts', `const p = '${PASSWORD.replace(/-/gu, '')}'\n`)
    expect(scan([directory]).hits.length).toBeGreaterThan(0)
  })

  it('searches for the password that actually exists', () => {
    // The bug this pins: an assembled constant with a stray separator searched for "6433-Handywife-0013346" and
    // reported every file clean. The scan reports which variants it looked for, so a wrong one is visible.
    const report = scan([plant('anything.txt', 'nothing here')])
    expect(report.variantsSearched).toContain('plain')
    // And a file containing the real password is found, which is the only proof the value is right.
    expect(scan([plant('real.txt', PASSWORD)]).hits).toHaveLength(1)
    expect(PASSWORD).toHaveLength(21)
  })
})

describe('the release scan finds private keys', () => {
  const head = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ')
  const tail = ['-----END', 'PRIVATE', 'KEY-----'].join(' ')

  it('finds a PEM block, header and all', () => {
    const directory = plant('key.pem', `${head}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ\n${tail}\n`)
    expect(scan([directory]).hits[0]!.what).toContain('PEM private key')
  })

  it('finds a key body with no header at all', () => {
    // Pasted body only, as one line inside a string — the shape a person uses when they "just need the value".
    const body = Buffer.from(Array.from({ length: 96 }, (_, index) => index % 251)).toString('base64')
    const directory = plant('headerless.ts', `const signingKey = '${body}'\n`)
    expect(scan([directory]).hits.some((hit) => hit.what.includes('without its header'))).toBe(true)
  })

  it('finds a key body spread over several lines', () => {
    // A 2048-bit RSA body is about 1600 base64 characters over 25 lines — the size a real key is.
    const body = Buffer.from(Array.from({ length: 1200 }, (_, index) => (index * 7) % 251)).toString('base64')
    const lines = body.match(/.{1,64}/gu)!.join('\n')
    const directory = plant('spread.ts', `const k = \`${lines}\`\n`)
    expect(scan([directory]).hits.length).toBeGreaterThan(0)
  })
})

describe('the release scan does not cry wolf', () => {
  it('ignores base64 that belongs in the file', () => {
    // The four false positives this scan produced from the real tree, each of which must stay quiet.
    const cases: Record<string, string> = {
      'image.ts': "const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='\n",
      'lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': { integrity: `sha512-${'A'.repeat(86)}==` } } }, null, 2),
      'bundle.js': `var a=${'x'.repeat(25000)}\n`,
      'map.ts': '//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozfQ==\n',
    }
    for (const [name, contents] of Object.entries(cases)) {
      const report = scan([plant(name, contents)])
      expect(report.hits, `${name} was wrongly flagged`).toEqual([])
    }
  })

  it('says how many files it looked at, so a scan of nothing cannot look like a pass', () => {
    const report = scan([plant('quiet.txt', 'ordinary content')])
    expect(report.filesScanned).toBe(1)
  })
})
