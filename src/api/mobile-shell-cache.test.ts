import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { shellAssetPaths, shellCacheName } from '../../scripts/mobile-shell-cache'

const shell = ['/', '/manifest.webmanifest', '/icons/icon-192.png']
const base = { shell, indexHtml: '<title>A</title>', manifest: '{"name":"A"}' }

describe('mobile shell cache versioning', () => {
  it('derives a stable, build-specific cache name', () => {
    expect(shellCacheName(base)).toBe(shellCacheName({ ...base, shell: [...shell] }))
    expect(shellCacheName(base)).toMatch(/^infoflex-mobile-shell-[0-9a-f]{12}$/u)
  })

  it('changes when any cached shell content or the shell list changes', () => {
    const original = shellCacheName(base)
    // A fixed cache name would pin an installed phone to its first cached build forever.
    expect(shellCacheName({ ...base, indexHtml: '<title>B</title>' })).not.toBe(original)
    expect(shellCacheName({ ...base, manifest: '{"name":"B"}' })).not.toBe(original)
    expect(shellCacheName({ ...base, shell: [...shell, '/icons/icon-180.png'] })).not.toBe(original)
  })

  it('is the name actually written into the built service worker', () => {
    const built = resolve(process.cwd(), 'out/mobile/service-worker.js')
    let source: string
    try {
      source = readFileSync(built, 'utf8')
    } catch {
      // `npm run build:mobile` has not run in this checkout; the derivation is still covered above.
      return
    }
    const declared = source.match(/const CACHE_NAME = '([^']+)'/u)?.[1]
    expect(declared).toMatch(/^infoflex-mobile-shell-[0-9a-f]{12}$/u)
    // A rebuild must not leave the previous build's shell reachable under the same key.
    expect(declared).not.toBe('infoflex-mobile-shell-v1')
  })
})

describe('mobile shell asset discovery', () => {
  it('collects the content-hashed entry script and stylesheet from the built document', () => {
    const html = '<script type="module" crossorigin src="/assets/index-abc123.js"></script>' +
      '<link rel="stylesheet" crossorigin href="/assets/index-def456.css">' +
      '<link rel="manifest" href="/manifest.webmanifest">'
    expect(shellAssetPaths(html)).toEqual(['/assets/index-abc123.js', '/assets/index-def456.css'])
  })

  it('finds the real built entry points and pre-caches them', () => {
    const builtIndex = resolve(process.cwd(), 'out/mobile/index.html')
    let html: string
    try {
      html = readFileSync(builtIndex, 'utf8')
    } catch {
      return
    }
    const assets = shellAssetPaths(html)
    // Without these the installed app cannot start while the desktop host is unreachable.
    expect(assets.some((path) => path.endsWith('.js'))).toBe(true)
    expect(assets.some((path) => path.endsWith('.css'))).toBe(true)
    const worker = readFileSync(resolve(process.cwd(), 'out/mobile/service-worker.js'), 'utf8')
    for (const asset of assets) expect(worker).toContain(`'${asset}'`)
  })
})
