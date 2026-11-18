import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const requireFromProject = createRequire(resolve(process.cwd(), 'package.json'))
const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>
  build: { npmRebuild?: boolean; asarUnpack?: string[] }
}

describe('native dependency packaging contract', () => {
  it('pins an N-API better-sqlite3 so Windows packages do not need an Electron-ABI rebuild', () => {
    // better-sqlite3 v13 moved to N-API and ships prebuilt binaries for every supported platform,
    // including win32-x64. That is what lets electron-builder produce a Windows package without
    // node-gyp cross-compiling on a non-Windows build machine.
    const declared = packageJson.dependencies['better-sqlite3']!
    const installed = (requireFromProject('better-sqlite3/package.json') as { version: string }).version
    const major = Number(installed.split('.')[0])
    expect(major, `better-sqlite3 ${installed} predates the N-API prebuilds (v13)`).toBeGreaterThanOrEqual(13)
    expect(declared).toMatch(/^\^?13\./u)
    expect(packageJson.build.npmRebuild).toBe(false)
    // Native binaries cannot be loaded from inside the asar archive.
    expect(packageJson.build.asarUnpack).toContain('**/*.node')
  })

  it('ships a win32-x64 prebuilt binary that is real PE x64 N-API code', () => {
    const packageRoot = resolve(requireFromProject.resolve('better-sqlite3/package.json'), '..')
    const binary = readFileSync(resolve(packageRoot, 'prebuilds/win32-x64.node'))
    const peOffset = binary.indexOf(Buffer.from('PE\0\0'))
    expect(peOffset, 'win32-x64 prebuild must be a PE image').toBeGreaterThan(0)
    expect(binary.readUInt16LE(peOffset + 4)).toBe(0x8664)
    // N-API entry points make the binary usable across Electron versions, not just one ABI.
    expect(binary.includes(Buffer.from('napi_'))).toBe(true)
  })
})
