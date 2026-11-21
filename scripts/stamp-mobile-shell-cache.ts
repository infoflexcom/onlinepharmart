import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { shellAssetPaths, shellCacheName } from './mobile-shell-cache'

/**
 * Rewrites the built service worker so an installed phone gets the app it was built with:
 * the pre-cache list gains the content-hashed entry assets, and the cache name is derived from the
 * shell content so a rebuilt app replaces the previous cache instead of serving stale bytes forever.
 * Run after `vite build --config mobile/vite.config.ts`; it is idempotent for unchanged input.
 */
const outDirectory = resolve(process.cwd(), 'out/mobile')
const workerPath = resolve(outDirectory, 'service-worker.js')
const source = readFileSync(workerPath, 'utf8')
const indexHtml = readFileSync(resolve(outDirectory, 'index.html'), 'utf8')
const manifest = readFileSync(resolve(outDirectory, 'manifest.webmanifest'), 'utf8')

const shellMatch = source.match(/const SHELL_PATHS = (\[[^\]]*\])/u)
if (!shellMatch) throw new Error('The mobile service worker no longer declares SHELL_PATHS; update this stamping step.')
const declaredShell = JSON.parse(shellMatch[1]!.replace(/'/g, '"')) as string[]

// Keep the static icons/manifest from the source worker and add the built entry assets, which carry
// their own content hash in the filename and are therefore safe to cache indefinitely.
const assets = shellAssetPaths(indexHtml)
const shell = [...new Set([...declaredShell, ...assets])]
if (assets.length === 0) throw new Error('No built /assets/* entry points were found in out/mobile/index.html.')

const cacheName = shellCacheName({ shell, indexHtml, manifest })
const stamped = source
  .replace(/const CACHE_NAME = '[^']*'/u, `const CACHE_NAME = '${cacheName}'`)
  .replace(/const SHELL_PATHS = \[[^\]]*\]/u, `const SHELL_PATHS = ${JSON.stringify(shell).replace(/"/g, "'")}`)

if (!stamped.includes(`'${cacheName}'`) || !stamped.includes(`'${assets[0]!}'`)) {
  throw new Error('The mobile service worker no longer declares CACHE_NAME/SHELL_PATHS; update this stamping step.')
}
writeFileSync(workerPath, stamped)
console.log(`mobile shell cache: ${cacheName} (${shell.length} pre-cached paths)`)
