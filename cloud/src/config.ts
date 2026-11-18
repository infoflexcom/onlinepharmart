import { readFileSync } from 'node:fs'

/**
 * The cloud's whole configuration, and every secret it needs. Nothing here has a usable default for a
 * secret: a missing signing key, database key or relay secret stops the service at start-up with a plain
 * instruction rather than running half-configured and signing licences with a fallback.
 *
 * Secrets are read from environment variables only. `INFOFLEX_CLOUD_*_FILE` variants exist because a
 * container or a managed host usually injects a file (a Docker secret) rather than a long environment
 * string, and reading a file keeps the value out of `ps`, out of crash dumps and out of process listings.
 */
export interface CloudConfig {
  environment: 'development' | 'production'
  databasePath: string
  /** PEM Ed25519 private key used to sign licences. Never leaves the server. */
  signingPrivateKeyPem: string
  signingKeyId: string
  /** Public key handed to clients at /api/license/config; also what Build Studio pins. */
  signingPublicKeyPem: string
  sessionSecret: string
  /** Base URL customers' PCs and phones use, e.g. https://licence.example.com. */
  publicBaseUrl: string
  /** Domain the relay serves shop subdomains from, e.g. relay.example.com. */
  relayDomain: string
  relaySharedSecret: string
  /** Token lifetime for the portal session cookie. */
  portalSessionMinutes: number
  /** Where automatic database backups are written (a mounted volume in production). */
  backupDirectory: string
  backupKeep: number
  smtp: SmtpConfig | null
  /** Emails that may be promoted to Owner; used once when the first account is created. */
  bootstrapOwnerEmail: string | null
  trustProxy: boolean
}

export interface SmtpConfig {
  host: string
  port: number
  secure: boolean
  user: string
  password: string
  from: string
  /** Vendor inbox for expiry reminders. */
  vendorRecipient: string | null
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (value) return value
  const filePath = env[`${name}_FILE`]?.trim()
  if (filePath) {
    try {
      const fromFile = readFileSync(filePath, 'utf8').trim()
      if (fromFile) return fromFile
    } catch {
      throw new ConfigError(`${name}_FILE points at ${filePath}, which could not be read.`)
    }
  }
  throw new ConfigError(
    `${name} is not set. Add it to the server's environment variables (or set ${name}_FILE to a file that holds it).`,
  )
}

function optional(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim()
  return value ? value : null
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be a whole number between ${min} and ${max}.`)
  }
  return value
}

/**
 * Loads and validates the configuration. `overrides` lets the tests and the portal's own setup tool build a
 * config without a process environment; production calls this with `process.env` and nothing else.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<CloudConfig> = {}): CloudConfig {
  const environment = (optional(env, 'NODE_ENV') === 'production' ? 'production' : 'development') as CloudConfig['environment']
  const smtpHost = optional(env, 'INFOFLEX_CLOUD_SMTP_HOST')

  const config: CloudConfig = {
    environment,
    databasePath: overrides.databasePath ?? optional(env, 'INFOFLEX_CLOUD_DATABASE') ?? 'infoflex-cloud.sqlite',
    signingPrivateKeyPem: overrides.signingPrivateKeyPem ?? required(env, 'INFOFLEX_CLOUD_SIGNING_KEY'),
    signingKeyId: overrides.signingKeyId ?? optional(env, 'INFOFLEX_CLOUD_SIGNING_KEY_ID') ?? 'infoflex-cloud-1',
    signingPublicKeyPem: overrides.signingPublicKeyPem ?? '',
    sessionSecret: overrides.sessionSecret ?? required(env, 'INFOFLEX_CLOUD_SESSION_SECRET'),
    publicBaseUrl: overrides.publicBaseUrl ?? optional(env, 'INFOFLEX_CLOUD_PUBLIC_URL') ?? 'http://localhost:8080',
    relayDomain: overrides.relayDomain ?? optional(env, 'INFOFLEX_CLOUD_RELAY_DOMAIN') ?? '',
    relaySharedSecret: overrides.relaySharedSecret ?? optional(env, 'INFOFLEX_CLOUD_RELAY_SECRET') ?? '',
    portalSessionMinutes: overrides.portalSessionMinutes ?? integer(env, 'INFOFLEX_CLOUD_SESSION_MINUTES', 30, 5, 480),
    backupDirectory: overrides.backupDirectory ?? optional(env, 'INFOFLEX_CLOUD_BACKUP_DIR') ?? 'backups',
    backupKeep: overrides.backupKeep ?? integer(env, 'INFOFLEX_CLOUD_BACKUP_KEEP', 14, 1, 365),
    smtp: overrides.smtp !== undefined
      ? overrides.smtp
      : smtpHost
        ? {
            host: smtpHost,
            port: integer(env, 'INFOFLEX_CLOUD_SMTP_PORT', 587, 1, 65535),
            secure: optional(env, 'INFOFLEX_CLOUD_SMTP_SECURE') === 'true',
            user: optional(env, 'INFOFLEX_CLOUD_SMTP_USER') ?? '',
            password: required(env, 'INFOFLEX_CLOUD_SMTP_PASSWORD'),
            from: optional(env, 'INFOFLEX_CLOUD_MAIL_FROM') ?? 'licences@infoflex.example',
            vendorRecipient: optional(env, 'INFOFLEX_CLOUD_VENDOR_EMAIL'),
          }
        : null,
    bootstrapOwnerEmail: overrides.bootstrapOwnerEmail ?? optional(env, 'INFOFLEX_CLOUD_OWNER_EMAIL'),
    trustProxy: overrides.trustProxy ?? optional(env, 'INFOFLEX_CLOUD_TRUST_PROXY') === 'true',
  }
  if (!config.signingPrivateKeyPem.includes('PRIVATE KEY')) {
    throw new ConfigError('INFOFLEX_CLOUD_SIGNING_KEY must be a PEM Ed25519 private key.')
  }
  if (config.sessionSecret.length < 32) {
    throw new ConfigError('INFOFLEX_CLOUD_SESSION_SECRET must be at least 32 characters of random text.')
  }
  if (config.environment === 'production') {
    if (!config.publicBaseUrl.startsWith('https://')) {
      throw new ConfigError('INFOFLEX_CLOUD_PUBLIC_URL must be an https:// address in production.')
    }
    if (config.relayDomain && !config.relaySharedSecret) {
      throw new ConfigError('Set INFOFLEX_CLOUD_RELAY_SECRET before enabling the relay domain.')
    }
  }
  return config
}

/** The public key that matches the private key. Derived rather than trusted from the environment. */
export function derivePublicKey(createPublicKey: typeof import('node:crypto').createPublicKey, privateKeyPem: string): string {
  return createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' }).toString()
}
