import type { LicenseClaims, LicenseSource } from '../shared/license/types'

export interface LicenseServerMetadata {
  mode?: string
  keyId?: string
  publicKey?: string
  /**
   * `wss://relay.example.com` when the vendor runs the internet relay. The shop stores what the server
   * published; it never types an address of its own.
   */
  relayUrl?: string
}

export interface LicenseCheckInRequest {
  licenseId: string
  machineId: string
  appVersion: string
  platform: string
  checkedAt: string
  source: LicenseSource
  online: true
  onsiteLicense?: {
    licenseId: string
    machineId: string
    source: 'onsite'
    edition: LicenseClaims['edition']
    startsAt: string
    endsAt: string
    issuedAt: string
    status: LicenseClaims['status']
    defaultCurrencyCode: string | null
    lockCurrency: boolean
    features: LicenseClaims['features']
    adminPhoneLimit: number
    graceDays: number
  }
}

export interface LicenseCheckInResponse {
  updated: boolean
  reported?: boolean
  token: string | null
  serverNow?: string
}

export interface LicenseServerClient {
  getMetadata(serverUrl: string): Promise<LicenseServerMetadata>
  activate(serverUrl: string, input: {
    activationKey: string
    machineId: string
    appVersion: string
    platform: string
  }): Promise<{ token: string }>
  checkIn(serverUrl: string, input: LicenseCheckInRequest): Promise<LicenseCheckInResponse>
}

export class HttpLicenseServerClient implements LicenseServerClient {
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly timeoutMs = 8_000) {}

  async getMetadata(serverUrl: string): Promise<LicenseServerMetadata> {
    const response = await this.request(serverUrl, '/api/license/config', { method: 'GET' })
    if (!response.ok) throw new Error('license_server_unavailable')
    const body = await safeJson(response)
    if (!body || typeof body !== 'object') throw new Error('license_server_invalid_response')
    return body as LicenseServerMetadata
  }

  async activate(serverUrl: string, input: {
    activationKey: string
    machineId: string
    appVersion: string
    platform: string
  }): Promise<{ token: string }> {
    const response = await this.request(serverUrl, '/api/license/activate', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    if (response.status === 401 || response.status === 403) throw new Error('activation_rejected')
    if (!response.ok) throw new Error('license_server_unavailable')
    const body = await safeJson(response)
    if (!body || typeof body !== 'object' || typeof (body as Record<string, unknown>).token !== 'string') {
      throw new Error('license_server_invalid_response')
    }
    return { token: (body as { token: string }).token }
  }

  async checkIn(serverUrl: string, input: LicenseCheckInRequest): Promise<LicenseCheckInResponse> {
    const response = await this.request(serverUrl, '/api/license/check-in', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    if (!response.ok) throw new Error(response.status === 409 ? 'license_machine_conflict' : 'license_server_unavailable')
    const body = await safeJson(response)
    if (!body || typeof body !== 'object' || typeof (body as Record<string, unknown>).updated !== 'boolean') {
      throw new Error('license_server_invalid_response')
    }
    const record = body as Record<string, unknown>
    if (record.token !== null && typeof record.token !== 'string') throw new Error('license_server_invalid_response')
    if (record.reported !== undefined && typeof record.reported !== 'boolean') throw new Error('license_server_invalid_response')
    return {
      updated: record.updated as boolean,
      reported: record.reported as boolean | undefined,
      token: record.token as string | null,
      serverNow: typeof record.serverNow === 'string' ? record.serverNow : undefined,
    }
  }

  private async request(serverUrl: string, path: string, init: RequestInit): Promise<Response> {
    const base = new URL(serverUrl)
    const url = new URL(path.replace(/^\//u, ''), `${base.toString().replace(/\/$/u, '')}/`)
    const response = await this.fetcher(url, {
      ...init,
      headers: { 'content-type': 'application/json', accept: 'application/json', ...init.headers },
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    return response
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new Error('license_server_invalid_response')
  }
}
