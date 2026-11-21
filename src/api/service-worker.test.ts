import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const workerSource = readFileSync(resolve(process.cwd(), 'mobile/public/service-worker.js'), 'utf8')

describe('mobile service-worker cache policy', () => {
  it('pre-caches only the static app shell and ignores API, write, and cross-origin requests', async () => {
    const handlers = new Map<string, (event: Record<string, unknown>) => void>()
    const addAll = vi.fn(async () => undefined)
    const cache = { addAll, put: vi.fn(async () => undefined) }
    const match = vi.fn(async () => undefined)
    const open = vi.fn(async () => cache)
    const fetch = vi.fn()
    const skipWaiting = vi.fn(async () => undefined)
    const self = {
      location: { origin: 'https://pharmacy.test' },
      addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => handlers.set(type, listener),
      skipWaiting,
    }
    runInNewContext(workerSource, {
      self,
      caches: { open, match, keys: async () => ['infoflex-mobile-shell-v1'], delete: vi.fn() },
      fetch,
      URL,
    })

    let installWork: Promise<unknown> | undefined
    handlers.get('install')!({ waitUntil: (work: Promise<unknown>) => { installWork = work } })
    await installWork
    // Read from the worker itself so the source list and the stamped build list stay in sync.
    const declaredShell = JSON.parse(workerSource.match(/const SHELL_PATHS = (\[[^\]]*\])/u)![1]!.replace(/'/g, '"')) as string[]
    expect(addAll).toHaveBeenCalledWith(declaredShell)
    expect(declaredShell).toContain('/icons/icon-180.png')
    expect(skipWaiting).toHaveBeenCalledOnce()

    for (const request of [
      { method: 'GET', url: 'https://pharmacy.test/api/v1/admin/reports/summary' },
      { method: 'POST', url: 'https://pharmacy.test/assets/index.js' },
      { method: 'GET', url: 'https://other.test/assets/index.js' },
    ]) {
      const respondWith = vi.fn()
      handlers.get('fetch')!({ request, respondWith })
      expect(respondWith).not.toHaveBeenCalled()
    }
    expect(match).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('caches successful same-origin static assets only', async () => {
    const handlers = new Map<string, (event: Record<string, unknown>) => void>()
    const storedResponse = { staticAsset: true }
    const response = { ok: true, type: 'basic', clone: () => storedResponse }
    const put = vi.fn(async () => undefined)
    const cache = { addAll: vi.fn(), put }
    const open = vi.fn(async () => cache)
    const fetch = vi.fn(async () => response)
    const match = vi.fn(async () => undefined)
    const self = {
      location: { origin: 'https://pharmacy.test' },
      addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => handlers.set(type, listener),
      skipWaiting: vi.fn(),
    }
    runInNewContext(workerSource, { self, caches: { open, match }, fetch, URL })

    let assetResponse: Promise<unknown> | undefined
    handlers.get('fetch')!({
      request: { method: 'GET', url: 'https://pharmacy.test/assets/index-abc123.js' },
      respondWith: (responsePromise: Promise<unknown>) => { assetResponse = responsePromise },
    })

    await expect(assetResponse).resolves.toBe(response)
    await new Promise((resolveWork) => setTimeout(resolveWork, 0))
    expect(match).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledOnce()
    expect(put).toHaveBeenCalledWith(
      { method: 'GET', url: 'https://pharmacy.test/assets/index-abc123.js' },
      storedResponse,
    )
  })

  it('falls back to the cached shell only for offline navigations, never for missing assets', async () => {
    const handlers = new Map<string, (event: Record<string, unknown>) => void>()
    const shell = { shell: true }
    const match = vi.fn(async (request: unknown) => (request === '/' ? shell : undefined))
    const self = {
      location: { origin: 'https://pharmacy.test' },
      addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => handlers.set(type, listener),
      skipWaiting: vi.fn(),
    }
    runInNewContext(workerSource, {
      self,
      caches: { open: vi.fn(async () => ({ put: vi.fn() })), match },
      fetch: vi.fn(async () => { throw new Error('offline') }),
      URL,
      Response: { error: () => ({ type: 'error' }) },
    })

    const respond = (request: Record<string, unknown>): Promise<unknown> => {
      let work: Promise<unknown> | undefined
      handlers.get('fetch')!({ request, respondWith: (value: Promise<unknown>) => { work = value } })
      expect(work).toBeDefined()
      return work!
    }

    await expect(respond({ method: 'GET', mode: 'navigate', url: 'https://pharmacy.test/' })).resolves.toBe(shell)
    expect(match).toHaveBeenCalledWith('/')

    match.mockClear()
    await expect(respond({ method: 'GET', mode: 'cors', url: 'https://pharmacy.test/assets/index-offline.js' }))
      .resolves.toEqual({ type: 'error' })
    expect(match).not.toHaveBeenCalledWith('/')
  })
})
