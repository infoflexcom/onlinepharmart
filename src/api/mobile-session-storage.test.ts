import { IDBFactory } from 'fake-indexeddb'
import { afterEach, describe, expect, it } from 'vitest'
import type { MobileSessionCredentials } from '../shared/mobile/types'
import { clearSession, readSession, verifySessionStorage, writeSession } from '../../mobile/src/session-store'

const originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')

function installIndexedDb(value: IDBFactory | undefined): void {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, writable: true, value })
}

afterEach(() => {
  if (originalIndexedDb) Object.defineProperty(globalThis, 'indexedDB', originalIndexedDb)
  else Reflect.deleteProperty(globalThis, 'indexedDB')
})

describe('PWA browser session storage', () => {
  it('probes writable IndexedDB and persists, reads, then clears opaque session credentials', async () => {
    installIndexedDb(new IDBFactory())
    const credentials: MobileSessionCredentials = {
      deviceId: 'device-1',
      accessToken: 'access-token-value',
      refreshToken: 'refresh-token-value',
      accessTokenExpiresAt: '2026-11-17T12:15:00.000Z',
      refreshTokenExpiresAt: '2027-02-15T12:00:00.000Z',
  loginRequired: false,
    }

    await expect(readSession()).resolves.toBeNull()
    await writeSession(credentials)
    await expect(verifySessionStorage()).resolves.toBeUndefined()
    await expect(readSession()).resolves.toEqual(credentials)
    await expect(clearSession()).resolves.toBe(true)
    await expect(readSession()).resolves.toBeNull()
  })

  it('fails closed when IndexedDB is unavailable', async () => {
    installIndexedDb(undefined)

    await expect(readSession()).rejects.toThrow()
    await expect(verifySessionStorage()).rejects.toThrow()
    await expect(clearSession()).resolves.toBe(false)
  })
})
