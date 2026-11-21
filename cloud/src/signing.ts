import { createPublicKey, sign as signDetached } from 'node:crypto'
import { canonicalLicenseClaims } from '../../src/license/crypto'
import type { Edition } from '../../src/editions'
import type { LicenseClaims, LicenseSource, SignedLicenseStatus } from '../../src/shared/license/types'

/**
 * The cloud's signing surface, kept in one small file so the private key never has to travel further than here.
 *
 * Tokens are byte-for-byte the format the desktop already verifies (`src/license/crypto.ts`): a JSON envelope
 * whose payload is the canonical claims JSON and whose signature is a detached Ed25519 signature over those
 * bytes. Nothing in this file invents a second format — if the desktop's verifier changes, this must change
 * with it, which is exactly why the tests sign with this module and verify with the desktop's own verifier.
 */
export interface SigningIdentity {
  keyId: string
  privateKeyPem: string
  publicKeyPem: string
}

export interface LicenseRecordClaims {
  licenseId: string
  machineId: string
  edition: Edition
  startsAt: string
  endsAt: string
  issuedAt: string
  status: SignedLicenseStatus
  source: LicenseSource
  defaultCurrencyCode: string | null
  lockCurrency: boolean
  features: { mobileLan: boolean; mobileInternet: boolean }
  adminPhoneLimit: number
  graceDays: number
}

export function loadSigningIdentity(privateKeyPem: string, keyId: string): SigningIdentity {
  if (!/^[A-Za-z0-9._-]{1,100}$/u.test(keyId)) throw new Error('The signing key id must be short and safe (A-Z, 0-9, dot, dash, underscore).')
  const publicKeyPem = createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' }).toString()
  // A key that is not Ed25519 would silently produce tokens the desktop cannot verify.
  if (createPublicKey(privateKeyPem).asymmetricKeyType !== 'ed25519') {
    throw new Error('The signing key must be an Ed25519 private key.')
  }
  return { keyId, privateKeyPem, publicKeyPem }
}

/** Builds the signed token for a licence row. This is the only place a licence token is produced. */
export function signLicenseToken(identity: SigningIdentity, claims: LicenseClaims): string {
  const payload = canonicalLicenseClaims(claims)
  return JSON.stringify({
    format: 'infoflex-license',
    version: 1,
    algorithm: 'Ed25519',
    keyId: identity.keyId,
    payload: payload.toString('base64url'),
    signature: signDetached(null, payload, identity.privateKeyPem).toString('base64url'),
  })
}

/** What the app needs at /api/license/config to know which key it should trust. */
export function publicKeyResponse(identity: SigningIdentity): { mode: string; keyId: string; publicKey: string } {
  return { mode: 'infoflex-cloud', keyId: identity.keyId, publicKey: identity.publicKeyPem }
}
