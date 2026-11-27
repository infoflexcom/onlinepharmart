import type { ShopSettings } from '../shared/shop/types'

/**
 * The discount ceiling, in one place.
 *
 * Two readers need the same answer: the till, which holds a sale that discounts above it and asks the Admin about the
 * excess, and the audit, which reports one that got through or came close. When each computed the cap itself, "above the
 * cap" on the audit screen meant "above a number the audit invented", and a change to the till's rule would have silently
 * moved the meaning of a finding without a single test failing. So the rule lives here and both sides import it.
 *
 * The till also states the ceiling to the cashier, in words, before a discount is typed. Stating it from this module is
 * what keeps the third reader honest: a screen that re-derived the number to display would drift from the one enforced
 * the moment either moved.
 */

export type DiscountCapSource = 'USER_PERMISSION' | 'SHOP_SETTINGS'

export interface DiscountCap {
  /** Basis points, 0–10 000. The stricter of the two ceilings always wins. */
  limitBasisPoints: number
  /** Which ceiling produced it, in the words the refusal and the audit row both use. */
  setBy: DiscountCapSource
  /** The same ceiling as a percentage, for a sentence a person reads. */
  limitPercent: number
}

/**
 * An Admin's own permission is the whole price. Every other role's comes from their permission row, so the number is
 * the Admin's decision about that person and not a constant in this file.
 */
export function actorDiscountBasisPoints(role: string, permissionBasisPoints: number): number {
  return role === 'ADMIN' ? 10_000 : permissionBasisPoints
}

/** Shop-wide discount ceiling from Settings, 0–10 000 basis points; any discount when unset. */
export function shopDiscountLimit(settings: ShopSettings): number {
  const limit = settings.operational?.discountLimitBasisPoints
  return typeof limit === 'number' && Number.isInteger(limit) && limit >= 0 && limit <= 10_000 ? limit : 10_000
}

export function resolveDiscountCap(actorBasisPoints: number, shopBasisPoints: number): DiscountCap {
  const limitBasisPoints = Math.min(actorBasisPoints, shopBasisPoints)
  // The shop ceiling is only named when it is the tighter one. When both allow the same, the person's own permission is
  // the honest answer: the shop setting is not stopping anything.
  const setBy: DiscountCapSource = shopBasisPoints < actorBasisPoints ? 'SHOP_SETTINGS' : 'USER_PERMISSION'
  return { limitBasisPoints, setBy, limitPercent: limitBasisPoints / 100 }
}

/** The most that may be taken off this gross, in minor units. Integer arithmetic, truncating like the till always has. */
export function maximumDiscountFor(grossSubtotalMinor: bigint, limitBasisPoints: number): bigint {
  return (grossSubtotalMinor * BigInt(limitBasisPoints)) / 10_000n
}
