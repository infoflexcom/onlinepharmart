/** Minimal Electron safeStorage surface, isolated so the host service is testable without Electron. */
export interface MobileSafeStorage {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}
