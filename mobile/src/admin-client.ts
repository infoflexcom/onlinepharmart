import type { MobileApiError } from '../../src/shared/mobile/admin-types'

/**
 * One place for every call the Admin screens make.
 *
 * Two rules live here so no screen has to remember them:
 *  1. Writes are refused by this client while the phone believes it is offline, so nothing financial is ever
 *     queued and retried later by a background task. Reads may fail and be retried — they change nothing.
 *  2. A 409 with `reloadRequired` becomes a `StaleScreenError`, which every screen renders as the one
 *     sentence "This item was changed, reload" instead of overwriting whatever the desktop just saved.
 */

export class StaleScreenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StaleScreenError'
  }
}

export class OfflineError extends Error {
  constructor() {
    super('The phone is offline. Connect to the shop network, then try again. Nothing was saved.')
    this.name = 'OfflineError'
  }
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
    this.name = 'ApiError'
  }
}

export interface MobileAdminClientOptions {
  /** Injected so a test can drive the client without a browser. */
  fetchImpl?: typeof fetch
  isOnline?: () => boolean
}

export class MobileAdminClient {
  private readonly fetchImpl: typeof fetch
  private readonly isOnline: () => boolean

  constructor(options: MobileAdminClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args))
    this.isOnline = options.isOnline ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine))
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path)
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body)
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    if (method !== 'GET' && !this.isOnline()) throw new OfflineError()
    let response: Response
    try {
      response = await this.fetchImpl(`/api/v1/mobile/admin${path}`, {
        method,
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'error',
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch {
      throw new OfflineError()
    }
    if (response.ok) {
      if (response.status === 204) return undefined as T
      return await response.json() as T
    }
    const payload = await response.json().catch((): MobileApiError => ({ message: '' }))
    const message = payload.message || `The host could not complete that (${response.status}).`
    if (response.status === 409 && payload.reloadRequired) throw new StaleScreenError(message)
    throw new ApiError(message, response.status, payload.code)
  }
}
