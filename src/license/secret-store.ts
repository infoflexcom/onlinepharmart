import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface LicenseSecretStore {
  readExisting(): Buffer | null
  getOrCreate(): Buffer
  /** Explicit recovery used only when an authorized vendor policy is reimported after rebinding. */
  reset(): Buffer
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

/** Windows Electron safeStorage is backed by the current OS account; the secret never enters SQLite. */
export class ElectronLicenseSecretStore implements LicenseSecretStore {
  constructor(private readonly filePath: string, private readonly safeStorage: SafeStorageLike) {}

  readExisting(): Buffer | null {
    if (!existsSync(this.filePath)) return null
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('Windows secure storage is unavailable.')
    try {
      const encrypted = readFileSync(this.filePath)
      const decoded = Buffer.from(this.safeStorage.decryptString(encrypted), 'base64url')
      if (decoded.length !== 32) throw new Error('The local license authenticator is damaged.')
      return decoded
    } catch {
      throw new Error('The local license authenticator is damaged or belongs to another OS account.')
    }
  }

  getOrCreate(): Buffer {
    const existing = this.readExisting()
    if (existing) return existing
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('Windows secure storage is unavailable; activation cannot be stored safely.')
    const key = randomBytes(32)
    const encrypted = this.safeStorage.encryptString(key.toString('base64url'))
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, encrypted, { mode: 0o600, flag: 'wx' })
    return key
  }

  reset(): Buffer {
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('Windows secure storage is unavailable; activation cannot be stored safely.')
    const key = randomBytes(32)
    const encrypted = this.safeStorage.encryptString(key.toString('base64url'))
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, encrypted, { mode: 0o600, flag: 'w' })
    return key
  }
}

/** Test-only key source; production Electron always uses OS-protected storage. */
export class MemoryLicenseSecretStore implements LicenseSecretStore {
  private value: Buffer | null = null

  readExisting(): Buffer | null {
    return this.value ? Buffer.from(this.value) : null
  }

  getOrCreate(): Buffer {
    this.value ??= randomBytes(32)
    return Buffer.from(this.value)
  }

  reset(): Buffer {
    this.value = randomBytes(32)
    return Buffer.from(this.value)
  }
}
