import { describe, expect, it, vi } from 'vitest'
import { singleFlight } from './single-flight'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('singleFlight', () => {
  it('shares one in-flight call between concurrent callers and starts fresh afterwards', async () => {
    const gate = deferred<string>()
    const run = vi.fn(async () => await gate.promise)
    const call = singleFlight(run)

    const first = call()
    const second = call()
    const third = call()
    // The host rotates refresh credentials on use; a second concurrent rotation is a replay that
    // revokes the device, so exactly one underlying call may be made.
    expect(run).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
    expect(third).toBe(first)

    gate.resolve('rotated')
    await expect(first).resolves.toBe('rotated')
    expect(run).toHaveBeenCalledTimes(1)

    await call()
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('clears the in-flight slot after a rejection so a later attempt can retry', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('ok')
    const call = singleFlight(run)

    await expect(call()).rejects.toThrow(/offline/u)
    await expect(call()).resolves.toBe('ok')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('treats a synchronous throw as a rejected call without poisoning later attempts', async () => {
    const run = vi.fn()
      .mockImplementationOnce(() => { throw new Error('sync failure') })
      .mockResolvedValueOnce('recovered')
    const call = singleFlight(run)

    await expect(call()).rejects.toThrow(/sync failure/u)
    await expect(call()).resolves.toBe('recovered')
  })
})
