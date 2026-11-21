import type { MobileSessionCredentials } from '../../src/shared/mobile/types'

const DATABASE_NAME = 'infoflex-admin-mobile'
const STORE_NAME = 'secrets'
const SESSION_KEY = 'current-session'
const DEVICE_KEY = 'device-token'
const STORAGE_PROBE_KEY = '__storage_probe__'

export async function verifySessionStorage(): Promise<void> {
  const database = await openSessionDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      store.put('available', STORAGE_PROBE_KEY)
      store.delete(STORAGE_PROBE_KEY)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('Phone storage is read-only.'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Phone storage is read-only.'))
    })
  } finally {
    database.close()
  }
}

export async function readSession(): Promise<MobileSessionCredentials | null> {
  const database = await openSessionDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly')
      const request = transaction.objectStore(STORE_NAME).get(SESSION_KEY) as IDBRequest<MobileSessionCredentials | undefined>
      let value: MobileSessionCredentials | null = null
      request.onsuccess = () => { value = request.result ?? null }
      request.onerror = () => reject(request.error ?? new Error('Phone session could not be read.'))
      transaction.oncomplete = () => resolve(value)
      transaction.onerror = () => reject(transaction.error ?? new Error('Phone session could not be read.'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Phone session read was cancelled.'))
    })
  } finally {
    database.close()
  }
}

export async function writeSession(value: MobileSessionCredentials): Promise<void> {
  const database = await openSessionDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).put(value, SESSION_KEY)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('Phone session could not be saved.'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Phone session save was cancelled.'))
    })
  } finally {
    database.close()
  }
}

export async function clearSession(): Promise<boolean> {
  let database: IDBDatabase | null = null
  try {
    database = await openSessionDatabase()
    await new Promise<void>((resolve, reject) => {
      const transaction = database!.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).delete(SESSION_KEY)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('Phone session could not be cleared.'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Phone session could not be cleared.'))
    })
    return true
  } catch {
    return false
  } finally {
    database?.close()
  }
}

function openSessionDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME)
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close()
      resolve(request.result)
    }
    request.onerror = () => reject(request.error ?? new Error('Phone storage could not be opened.'))
    request.onblocked = () => reject(new Error('Close other Infoflex Mobile tabs and try again.'))
  })
}

/**
 * The device token proves *which approved phone* is signing in. It is separate from the session so signing
 * out does not force the Admin to re-pair, and it is useless on its own: login still needs the Admin's
 * username, password and (off the shop network) an authenticator code.
 */
export async function readDeviceToken(): Promise<string | null> {
  const database = await openSessionDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly')
      const request = transaction.objectStore(STORE_NAME).get(DEVICE_KEY) as IDBRequest<string | undefined>
      let value: string | null = null
      request.onsuccess = () => { value = request.result ?? null }
      request.onerror = () => reject(request.error ?? new Error('Phone pairing could not be read.'))
      transaction.oncomplete = () => resolve(value)
      transaction.onerror = () => reject(transaction.error ?? new Error('Phone pairing could not be read.'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Phone pairing read was cancelled.'))
    })
  } finally {
    database.close()
  }
}

export async function writeDeviceToken(value: string): Promise<void> {
  const database = await openSessionDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).put(value, DEVICE_KEY)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('Phone pairing could not be saved.'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Phone pairing save was cancelled.'))
    })
  } finally {
    database.close()
  }
}

export async function clearDeviceToken(): Promise<void> {
  let database: IDBDatabase | null = null
  try {
    database = await openSessionDatabase()
    await new Promise<void>((resolve) => {
      if (!database) return resolve()
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).delete(DEVICE_KEY)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => resolve()
      transaction.onabort = () => resolve()
    })
  } catch {
    // Losing the local copy is not a security problem: the host never trusts it without a password.
  } finally {
    database?.close()
  }
}
