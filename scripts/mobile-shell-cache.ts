/**
 * Derives the service-worker cache name from the content of the files it stores, so a rebuilt app
 * gets a new cache and drops the previous one. The shell is served cache-first for responsiveness,
 * which means a fixed cache name would pin an installed phone to whatever build it first saw and
 * shipped fixes could never reach it.
 *
 * The name must change only when cached bytes change; hashed `/assets/*` filenames already carry
 * their own content hash and are fetched at runtime rather than pre-cached.
 */
import { createHash } from 'node:crypto'

export function shellCacheName(input: { shell: readonly string[]; indexHtml: string; manifest: string }): string {
  const hash = createHash('sha256')
  for (const path of input.shell) hash.update(`shell\u0000${path}\u0000`)
  hash.update(`index\u0000${input.indexHtml}\u0000`)
  hash.update(`manifest\u0000${input.manifest}\u0000`)
  return `infoflex-mobile-shell-${hash.digest('hex').slice(0, 12)}`
}

/**
 * The built entry document references content-hashed scripts and styles. They must be pre-cached
 * with the shell, otherwise an installed app cannot start without the desktop host (the fetch
 * handler only falls back to the HTML shell for navigations, never for script/style requests).
 */
export function shellAssetPaths(indexHtml: string): string[] {
  const paths = new Set<string>()
  for (const match of indexHtml.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/gu)) {
    paths.add(match[1]!)
  }
  return [...paths].sort()
}
