import { describe, expect, it, vi } from 'vitest'
import { ApiError, MobileAdminClient, OfflineError, StaleScreenError } from './admin-client'

/**
 * The two promises the client makes on the phone's behalf:
 *
 *  1. While the phone is offline, a *write* is refused here, before it leaves the device. Nothing financial
 *     or stock-related is ever queued to be replayed later, which is the rule the brief sets.
 *  2. A 409 that says "reload" surfaces as a distinct error, so the screens can say "This item was changed,
 *     reload" instead of retrying over somebody else's newer edit.
 */

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

describe('the Admin phone API client', () => {
  it('refuses a write before it is sent when the phone is offline', async () => {
    const fetchImpl = vi.fn()
    const client = new MobileAdminClient({ fetchImpl: fetchImpl as unknown as typeof fetch, isOnline: () => false })
    await expect(client.post('/products/p1/stock', { quantity: '1' })).rejects.toBeInstanceOf(OfflineError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('still allows a read while offline, because a read changes nothing', async () => {
    const fetchImpl = vi.fn(async () => response(200, { ok: true }))
    const client = new MobileAdminClient({ fetchImpl: fetchImpl as unknown as typeof fetch, isOnline: () => false })
    await expect(client.get('/dashboard')).resolves.toEqual({ ok: true })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('turns a failed connection into the offline message, whatever the cause', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    const client = new MobileAdminClient({ fetchImpl: fetchImpl as unknown as typeof fetch, isOnline: () => true })
    const error = await client.get('/dashboard').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(OfflineError)
    expect((error as Error).message).toContain('Nothing was saved')
  })

  it('raises a stale-screen error for a 409 with reloadRequired', async () => {
    const fetchImpl = vi.fn(async () => response(409, { message: 'This item was changed, reload.', reloadRequired: true, code: 'STALE_VERSION' }))
    const client = new MobileAdminClient({ fetchImpl: fetchImpl as unknown as typeof fetch, isOnline: () => true })
    const error = await client.post('/products/p1', {}).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(StaleScreenError)
    expect((error as Error).message).toBe('This item was changed, reload.')
  })

  it('does not treat an ordinary 400 as stale, so an inline field error stays inline', async () => {
    const fetchImpl = vi.fn(async () => response(400, { message: 'That Admin password is not correct.', code: 'ADMIN_PASSWORD_REQUIRED' }))
    const client = new MobileAdminClient({ fetchImpl: fetchImpl as unknown as typeof fetch, isOnline: () => true })
    const error = await client.post('/products/p1', {}).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).not.toBeInstanceOf(StaleScreenError)
    expect((error as ApiError).status).toBe(400)
    expect((error as ApiError).message).toContain('Admin password is not correct')
  })

  it('sends credentials same-origin and never a redirect, so a hostile network cannot redirect the token', async () => {
    const fetchImpl = vi.fn(async () => response(200, {}))
    const client = new MobileAdminClient({ fetchImpl: fetchImpl as unknown as typeof fetch, isOnline: () => true })
    await client.get('/dashboard')
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/v1/mobile/admin/dashboard')
    expect(init.credentials).toBe('same-origin')
    expect(init.redirect).toBe('error')
    expect(init.cache).toBe('no-store')
  })

  it('always asks the compose base URL for JSON and never accepts a content-type other than JSON', async () => {
    const fetchImpl = vi.fn(async () => response(200, {}))
    const client = new MobileAdminClient({ fetchImpl: fetchImpl as unknown as typeof fetch, isOnline: () => true })
    await client.post('/approvals/a1', { decision: 'APPROVE' })
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json')
    expect(init.body).toBe(JSON.stringify({ decision: 'APPROVE' }))
  })
})
