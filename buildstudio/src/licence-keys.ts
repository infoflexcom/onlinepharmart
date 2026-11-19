import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto'

/**
 * The vendor's licence signing key pair.
 *
 * The rule this file exists to keep: **the private key never leaves the vendor's machine, and the public key is the
 * only half that goes into a build.** Getting this wrong is not a bug that shows up in testing — a private key
 * compiled into an installer means anybody who downloads that installer can mint their own licences for every other
 * customer. So the two halves are separate types with separate export functions, and no function here returns both
 * at once by accident.
 *
 * The key pair is Ed25519 (the brief names it), and the public half is written in the PEM subject-public-key-info
 * form the app already trusts through `trustedEd25519Keys`.
 */

export interface GeneratedKeyPair {
  /** What the app and the Vendor Cloud call this key. Shown in logs and in the policy file. */
  keyId: string
  /** PEM, `-----BEGIN PRIVATE KEY-----`. Goes to the Vendor Cloud as a secret and nowhere else. */
  privateKeyPem: string
  /** PEM, `-----BEGIN PUBLIC KEY-----`. Goes into builds and into the policy file. */
  publicKeyPem: string
  /** SHA-256 of the public key, so two people comparing key files can check they match without reading PEM. */
  publicKeyFingerprint: string
}

export const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,40}$/u

/**
 * Generates a new signing key pair.
 *
 * `keyId` is chosen by the vendor because it identifies the key in licence tokens; an unmemorable random id makes
 * rotating keys on a live system worse. It is validated rather than trusted, because it ends up inside a file name
 * and inside tokens.
 */
export function generateLicenceKeyPair(keyId: string): GeneratedKeyPair {
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new Error('The key name must be 3-41 characters: lowercase letters, numbers and dashes, starting with a letter or number.')
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  return {
    keyId,
    privateKeyPem,
    publicKeyPem,
    publicKeyFingerprint: publicKeyFingerprint(publicKeyPem),
  }
}

/** SHA-256 over the DER of a public key, base64url, for people who have to compare two keys by eye. */
export function publicKeyFingerprint(publicKeyPem: string): string {
  const key = createPublicKey(publicKeyPem)
  const der = key.export({ type: 'spki', format: 'der' })
  return createHash('sha256').update(der).digest('base64url')
}

export interface KeyPairProblem {
  field: 'privateKey' | 'publicKey'
  message: string
}

/**
 * Checks that a pair really is a pair.
 *
 * Worth doing because the two halves are handled on different machines at different times: a vendor can paste the
 * wrong public key into a build while the matching private key sits on the cloud, and the only symptom would be
 * every licence failing to verify at a customer's shop, months later. Comparing them now is cheap.
 */
export function keyPairProblems(input: { privateKeyPem: string; publicKeyPem: string }): KeyPairProblem[] {
  const problems: KeyPairProblem[] = []
  let privateKey: KeyObject | null = null
  try {
    privateKey = createPrivateKey(input.privateKeyPem)
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      problems.push({ field: 'privateKey', message: 'That is not an Ed25519 private key.' })
    }
  } catch {
    problems.push({ field: 'privateKey', message: 'That is not a usable private key file.' })
  }

  let publicKey: KeyObject | null = null
  try {
    publicKey = createPublicKey(input.publicKeyPem)
    if (publicKey.asymmetricKeyType !== 'ed25519') {
      problems.push({ field: 'publicKey', message: 'That is not an Ed25519 public key.' })
    }
  } catch {
    problems.push({ field: 'publicKey', message: 'That is not a usable public key file.' })
  }

  if (privateKey && publicKey && problems.length === 0) {
    // Deriving the public half from the private one is the only way to be certain they match.
    const derived = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString()
    if (derived.trim() !== input.publicKeyPem.trim()) {
      problems.push({ field: 'publicKey', message: 'This public key does not belong to that private key, so licences signed with it would not be accepted.' })
    }
  }
  return problems
}

/** What a build embeds: an id-to-public-key map, the only shape the app trusts. */
export function trustedKeysForBuild(pair: Pick<GeneratedKeyPair, 'keyId' | 'publicKeyPem'>): Record<string, string> {
  return { [pair.keyId]: pair.publicKeyPem }
}

/**
 * Refuses to hand a private key to anything that writes a build.
 *
 * The Build screen, the log writer and the policy exporter all pass their text through this first. A private key in
 * a log is nearly as bad as one in an installer, because logs get attached to support emails.
 */
export function containsPrivateKey(text: string): boolean {
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(text)
}

/**
 * The signable licence payload shape, for the Activation helper's explanation.
 *
 * Build Studio does not issue licences — the Vendor Cloud does — but the vendor needs to know what will be signed,
 * and an accurate list here is what the helper screen shows instead of vague prose.
 */
export const LICENCE_CLAIM_FIELDS: ReadonlyArray<{ field: string; meaning: string }> = [
  { field: 'licenseId', meaning: 'A unique id for this licence.' },
  { field: 'machineId', meaning: 'The fingerprint of the shop computer it is bound to.' },
  { field: 'edition', meaning: 'PHARMACY, SUPERMARKET or BOTH.' },
  { field: 'startsAt / endsAt', meaning: 'The dates the licence runs between.' },
  { field: 'defaultCurrencyCode', meaning: 'The currency the customer should start with, if the vendor sets one.' },
  { field: 'lockCurrency', meaning: 'Whether the customer is forbidden from changing that currency.' },
  { field: 'features', meaning: 'Which modules are switched on for this customer.' },
  { field: 'adminPhoneLimit', meaning: 'How many Admin phones may be paired.' },
]
