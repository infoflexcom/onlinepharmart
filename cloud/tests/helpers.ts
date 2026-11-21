import { generateKeyPairSync, randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { createCloudServer, type CloudServer } from '../src/server'
import type { CloudConfig } from '../src/config'
import type { Mailer } from '../src/mailer'
import { generateTotp } from '../../src/services/totp'

/**
 * Shared set-up for the cloud tests. Each test gets its own in-memory database and a fresh signing key, so a
 * failure cannot leak into the next file, and nothing touches the filesystem or the network.
 */
export interface TestCloud {
  cloud: CloudServer
  app: FastifyInstance
  identity: NonNullable<ReturnType<typeof buildIdentity>>
  close: () => Promise<void>
}

export function buildIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    keyId: 'test-key-1',
  }
}

export function testConfig(overrides: Partial<CloudConfig> = {}): CloudConfig {
  return {
    environment: 'development',
    databasePath: ':memory:',
    signingPrivateKeyPem: 'unused-in-tests',
    signingKeyId: 'test-key-1',
    signingPublicKeyPem: '',
    sessionSecret: 'x'.repeat(48),
    publicBaseUrl: 'http://localhost:8080',
    relayDomain: '',
    relaySharedSecret: '',
    portalSessionMinutes: 30,
    backupDirectory: '/tmp/infoflex-cloud-test-backups',
    backupKeep: 2,
    smtp: null,
    bootstrapOwnerEmail: null,
    trustProxy: false,
    ...overrides,
  }
}

export async function createTestCloud(options: {
  now?: () => number
  relayDomain?: string
  mailer?: Mailer | null
  config?: Partial<CloudConfig>
} = {}): Promise<TestCloud> {
  const identity = buildIdentity()
  const config = testConfig({
    signingPrivateKeyPem: identity.privateKeyPem,
    signingKeyId: identity.keyId,
    relaySharedSecret: options.relayDomain ? randomBytes(32).toString('hex') : '',
    ...(options.config ?? {}),
  })
  if (options.relayDomain) config.relayDomain = options.relayDomain
  const cloud = await createCloudServer({
    config,
    databasePath: ':memory:',
    identity,
    mailer: options.mailer ?? null,
    now: options.now,
    background: false,
  })
  return { cloud, app: cloud.app, identity, close: cloud.stop }
}

// ------------------------------------------------------------------ portal sign-in helpers

export interface SignedIn {
  cookie: string
  csrf: string
  userId: string
}

/** Creates the first Owner through the service, enrols 2FA and returns a signed-in cookie. */
export async function signInOwner(cloud: CloudServer, input: { email?: string; password?: string; nowMs?: number } = {}): Promise<SignedIn> {
  const email = input.email ?? 'owner@example.com'
  const password = input.password ?? 'correct-horse-battery-staple'
  const user = await cloud.auth.createUser({ email, displayName: 'Owner', password, role: 'OWNER' }, 'test')
  const nowMs = input.nowMs ?? Date.now()
  cloud.auth.confirmTotpSetup(user.id, generateTotp(user.totp_secret, nowMs))
  const login = await cloud.auth.login({
    email, password, code: generateTotp(user.totp_secret, nowMs + 30_000), ipAddress: '127.0.0.1', userAgent: 'vitest',
  })
  if (!login.ok) throw new Error(`sign-in failed: ${login.message}`)
  return { cookie: `infoflex_portal=${login.token}`, csrf: login.csrfToken, userId: user.id }
}

/** Turns a `<form>` body into a urlencoded payload, keeping any cookie the reply set. */
export function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString()
}

export function readSetCookie(headers: Record<string, unknown>): string {
  const raw = headers['set-cookie']
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  return list.map((value) => String(value).split(';')[0]).join('; ')
}
