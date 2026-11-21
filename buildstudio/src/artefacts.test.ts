import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import {
  declaredArtefacts, formatBytes, inspectAllArtefacts, inspectArtefact, removableDriveChoices, sha256File,
  windowsDriveRoots,
} from './artefacts'

const scratch = mkdtempSync(join(tmpdir(), 'bs-artefacts-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe('the artefacts a build promises', () => {
  it('names both installers and the cloud package', () => {
    const titles = declaredArtefacts('1.0.0').map((artefact) => artefact.title)
    expect(titles).toEqual(expect.arrayContaining([
      'Infoflex Setup.exe', 'Infoflex Setup Offline.exe', 'Vendor Cloud package',
    ]))
  })

  it('reports a file that is really there, with its true size and fingerprint', async () => {
    const root = mkdtempSync(join(scratch, 'present-'))
    mkdirSync(join(root, 'dist/online'), { recursive: true })
    const contents = Buffer.from('pretend this is an installer')
    writeFileSync(join(root, 'dist/online/Infoflex Setup.exe'), contents)
    const expected = createHash('sha256').update(contents).digest('hex')

    const artefact = await inspectArtefact(root, { path: 'dist/online/Infoflex Setup.exe', title: 'Infoflex Setup.exe' }, '1.0.0')
    expect(artefact.exists).toBe(true)
    expect(artefact.sizeBytes).toBe(contents.length)
    expect(artefact.sha256).toBe(expected)
  })

  it('reports a missing file as missing rather than inventing a row', async () => {
    // The output screen must not list a file that is not there, or a vendor carries an empty folder to a customer.
    const root = mkdtempSync(join(scratch, 'absent-'))
    const report = await inspectAllArtefacts(root, '1.0.0')
    expect(report.artefacts).toHaveLength(declaredArtefacts('1.0.0').length)
    expect(report.missing.length).toBe(report.artefacts.length)
    for (const artefact of report.artefacts) {
      expect(artefact.exists).toBe(false)
      expect(artefact.sha256).toBeNull()
      expect(artefact.sizeBytes).toBe(0)
    }
    expect(report.missing[0]).toMatch(/was not produced/iu)
  })

  it('reports nothing missing when every promised file exists', async () => {
    const root = mkdtempSync(join(scratch, 'all-'))
    for (const spec of declaredArtefacts('1.0.0')) {
      const path = join(root, spec.path)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, 'built')
    }
    const report = await inspectAllArtefacts(root, '1.0.0')
    expect(report.missing).toEqual([])
    expect(report.artefacts.every((artefact) => artefact.exists)).toBe(true)
  })

  it('substitutes the version into a path when one is used', () => {
    const specs = declaredArtefacts('2.3.4')
    expect(specs.some((spec) => spec.path.includes('2.3.4'))).toBe(specs.some((spec) => spec.path.includes('{version}')))
    for (const spec of specs) expect(spec.path).not.toContain('{version}')
  })
})

describe('hashing and sizes', () => {
  it('returns null for a file that is not there instead of throwing', async () => {
    expect(await sha256File(join(scratch, 'nope.bin'))).toBeNull()
  })

  it('formats sizes the way a person reads them', () => {
    expect(formatBytes(512)).toBe('512 bytes')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1024 * 1024 * 3.25)).toBe('3.3 MB')
    expect(formatBytes(1024 ** 3 * 2)).toBe('2.0 GB')
  })
})

describe('choosing a USB drive', () => {
  it('offers Windows drive letters except A, B and the system drive', () => {
    const choices = removableDriveChoices(['C:\\', 'D:\\', 'E:\\', 'A:\\'], 'win32')
    expect(choices.map((choice) => choice.path)).toEqual(['D:\\', 'E:\\'])
    expect(choices[0]!.label).toBe('D drive')
  })

  it('says "drive" rather than claiming to know it is removable', () => {
    // Without the Win32 API this cannot tell a USB stick from a second fixed disk, and a label that pretended to
    // would be a lie the vendor acts on.
    for (const choice of removableDriveChoices(['D:\\'], 'win32')) {
      expect(choice.label).not.toMatch(/USB|removable/iu)
    }
  })

  it('returns the roots unchanged on a non-Windows machine', () => {
    expect(removableDriveChoices(['/media/usb'], 'linux')).toEqual([{ path: '/media/usb', label: '/media/usb' }])
  })
})

describe('finding the drives on a Windows machine', () => {
  /**
   * This code only runs on the machine the tool ships to, so on a Linux build machine it is dead until it is given
   * the platform. It is worth covering because the everyday case is awkward: a card reader with no card still has a
   * letter, and looking at it throws. That must not empty the list.
   */
  const present = (drives: string[]) => (path: string) => {
    if (/^(?:C|D|E):\\$/u.test(path) && drives.includes(path[0]!.toUpperCase())) return { exists: true, isDirectory: true }
    if (path.startsWith('E:')) throw new Error('There is no disk in the drive.')
    return { exists: false, isDirectory: false }
  }

  it('lists every letter that exists and is a directory', () => {
    const roots = windowsDriveRoots('win32', present(['C', 'D']))
    expect(roots).toEqual(['C:\\', 'D:\\'])
  })

  it('skips a letter whose media has been removed instead of failing the whole list', () => {
    // E: throws on every look, exactly as an empty card reader does.
    const roots = windowsDriveRoots('win32', present(['C', 'D']))
    expect(roots).not.toContain('E:\\')
    expect(roots).toHaveLength(2)
  })

  it('offers a removable drive as a choice, labelled so the vendor recognises it', () => {
    const choices = removableDriveChoices(windowsDriveRoots('win32', present(['C', 'D'])), 'win32')
    // The system drive is not offered: copying an installer onto C:\ is not what the USB button is for.
    expect(choices).toEqual([{ path: 'D:\\', label: 'D drive' }])
  })

  it('returns nothing away from Windows rather than inventing drive letters', () => {
    expect(windowsDriveRoots('linux', () => ({ exists: true, isDirectory: true }))).toEqual([])
    expect(windowsDriveRoots('darwin', () => ({ exists: true, isDirectory: true }))).toEqual([])
  })
})
