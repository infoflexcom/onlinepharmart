import { createHash } from 'node:crypto'
import type { LicenseService } from '../license-service'
import { verifyLicenseToken } from '../../../src/license/crypto'
import { deriveGrantKey, verifyPhoneGrant as verifyGrant } from '../../../src/shared/relay/protocol'

/**
 * Who may open a relay tunnel.
 *
 * A host proves itself with the very licence token it already holds: the relay verifies the signature against
 * the vendor's public key, checks that the token is bound to the machine claiming it, then asks the live
 * database whether the licence is still active, still has internet access enabled and has not expired. A token
 * that is valid but for a suspended licence is refused, which is what makes suspend take effect on the relay
 * without the host doing anything.
 *
 * The result is cached for a short window so a busy shop does not hit SQLite on every heartbeat, but never for
 * longer than a minute — a suspended licence stops relaying promptly.
 */
export interface RelayAuthorisation {
  licenseId: string
  shopId: string
  /** The machine the licence is bound to; every frame is attributed to it. */
  machineId: string
  displayName: string
  expiresAt: string
}

export interface RelayVerifierOptions {
  service: LicenseService
  publicKeyPem: string
  keyId: string
  /** Shared with the host, used to sign the short-lived links the till shows as a QR code. */
  grantSecret: string
  now?: () => number
  /** How long a successful check is trusted. Deliberately short: suspension must bite quickly. */
  cacheMs?: number
  maxCacheEntries?: number
}

const SHOP_ID_PATTERN = /^[a-z0-9]{6,40}$/u

/**
 * The public shop address is derived from the licence id, so the vendor never has to invent or remember one and
 * a host cannot type somebody else's shop. Short and lowercase, because it is typed on a phone.
 */
export function shopSlugFor(licenseId: string): string {
  return createHash('sha256').update(`infoflex-relay-shop:${licenseId}`).digest('hex').slice(0, 12)
}

export class RelayVerifier {
  private readonly cache = new Map<string, { value: RelayAuthorisation | null; expires: number; reason: string }>()

  constructor(private readonly options: RelayVerifierOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  /**
   * Validates a `hello` frame. Returns either an authorisation or a plain reason, because the reason is shown to
   * the host in its own log and must not hint at another shop's data.
   */
  authorise(input: { shopId: string; token: string; machineId: string; appVersion: string }): { ok: true; value: RelayAuthorisation } | { ok: false; reason: string } {
    const shopId = String(input.shopId ?? '').trim().toLowerCase()
    if (!SHOP_ID_PATTERN.test(shopId)) return { ok: false, reason: 'That shop address is not valid.' }
    const cacheKey = `${shopId}:${createHash('sha256').update(input.token).digest('hex').slice(0, 32)}`
    const cached = this.cache.get(cacheKey)
    if (cached && cached.expires > this.now()) {
      return cached.value ? { ok: true, value: cached.value } : { ok: false, reason: cached.reason }
    }
    const outcome = this.check(shopId, input)
    const ttl = (this.options.cacheMs ?? 30_000) * (outcome.ok ? 1 : 0.5)
    if (this.cache.size > (this.options.maxCacheEntries ?? 5_000)) this.cache.clear()
    this.cache.set(cacheKey, outcome.ok ? { value: outcome.value, expires: this.now() + ttl, reason: '' } : { value: null, expires: this.now() + ttl, reason: outcome.reason })
    return outcome
  }

  /** Drops a cached decision, so a portal suspend applies to an already-open tunnel immediately. */
  forget(licenseId: string): void {
    for (const [key, entry] of this.cache) {
      if (entry.value?.licenseId === licenseId) this.cache.delete(key)
    }
  }

  clear(): void {
    this.cache.clear()
  }

  private check(shopId: string, input: { shopId: string; token: string; machineId: string; appVersion: string }): { ok: true; value: RelayAuthorisation } | { ok: false; reason: string } {
    let claims: ReturnType<typeof verifyLicenseToken>['claims']
    try {
      claims = verifyLicenseToken(input.token, {
        machineId: String(input.machineId ?? '').trim(),
        trustedEd25519Keys: { [this.options.keyId]: this.options.publicKeyPem },
      }).claims
    } catch {
      return { ok: false, reason: 'The relay could not verify this installation’s licence.' }
    }
    const view = this.options.service.findLicenseByKeyOrId(claims.licenseId)
    if (!view) return { ok: false, reason: 'That licence is no longer issued.' }
    if (view.id !== claims.licenseId) return { ok: false, reason: 'The relay could not verify this installation’s licence.' }
    if (view.machine_id && view.machine_id !== claims.machineId) {
      return { ok: false, reason: 'This licence is now bound to a different computer.' }
    }
    // The shop address is derived from the licence, so a host cannot claim somebody else's name.
    if (shopId !== shopSlugFor(view.id)) {
      return { ok: false, reason: `The shop address for this licence is ${shopSlugFor(view.id)}.` }
    }
    if (view.effective_status !== 'active') {
      return { ok: false, reason: view.effective_status === 'suspended' ? 'This licence is suspended.' : 'This licence has expired.' }
    }
    if (!view.mobile_internet) return { ok: false, reason: 'Internet access is switched off for this licence.' }
    return {
      ok: true,
      value: {
        licenseId: view.id,
        shopId,
        machineId: claims.machineId,
        displayName: view.customer_name,
        expiresAt: view.ends_at,
      },
    }
  }
  /**
   * A phone presents a short-lived grant minted by the host, which the relay verifies with the shared secret.
   * The verification itself lives in `src/shared/relay/protocol.ts`, because the shop PC mints what the relay
   * checks and one copy of the rule is the only way the two cannot disagree.
   */
  verifyPhoneGrant(grant: string, shopId: string): { ok: true; machineId: string; expiresAt: number } | { ok: false; reason: string } {
    return verifyGrant(deriveGrantKey(this.options.grantSecret, shopId), grant, shopId, this.now())
  }

  /** The per-shop key handed to a host in its `welcome` frame; nothing else can mint this shop's links. */
  grantKeyFor(shopId: string): string {
    return deriveGrantKey(this.options.grantSecret, shopId)
  }

}
