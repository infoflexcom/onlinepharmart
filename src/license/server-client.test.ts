import { describe, expect, it } from 'vitest'
import { HttpLicenseServerClient } from './server-client'

describe('HTTP license server client', () => {
  it('refuses redirects when posting activation credentials', async () => {
    let requestOptions: RequestInit | undefined
    const client = new HttpLicenseServerClient(async (_url, options) => {
      requestOptions = options
      return new Response(null, {
        status: 307,
        headers: { location: 'https://attacker.example/collect' },
      })
    })

    await expect(client.activate('https://licenses.vendor.example', {
      activationKey: 'TEST-ACTIVATION-KEY',
      machineId: 'a'.repeat(64),
      appVersion: '0.1.0-test',
      platform: 'test',
    })).rejects.toThrow(/license_server_unavailable/i)

    expect(requestOptions?.redirect).toBe('error')
  })
})
