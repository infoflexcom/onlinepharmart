/**
 * The six automatic audit checks, as one pure function.
 *
 * These rules used to live inside `DailyAuditService.runChecks`, which was fine while the service was the only reader.
 * It is not: the browser preview builds the same report from its own in-memory day so that the audit screen can be
 * looked at without a licence, and a preview that re-spelled the thresholds would demo an audit that is not the
 * product's audit. So the rules moved here, take only rows, touch no database, and both callers pass them what they
 * read.
 *
 * Two properties are load-bearing and worth stating where the next reader will see them:
 *
 * - **Nothing here queries anything.** Every check judges rows the caller has already read and is about to show, so a
 *   finding can never be about a row the screen is hiding. Check 6 is the one that needs a database read; the caller
 *   does the read and passes the result in.
 * - **The thresholds are the shared constants**, not numbers written next to the rules. A test asserts the severity of
 *   each band, so a threshold that moves moves the test with it rather than silently changing what "serious" means.
 */
import { formatMoney } from '../currency/money'
import type { MoneyDisplayOptions } from '../currency/money'
import type { CurrencyDefinition } from '../currency/catalog'
import type {
  AuditCashTie,
  AuditDiscountRow,
  AuditFinding,
  AuditReprintRow,
  AuditVoidRow,
} from '../shared/audit/types'
import {
  AFTER_MIDNIGHT_CUTOFF_HOUR,
  DISCOUNT_NEAR_CAP_BASIS_POINTS,
  REPRINT_FINDING_THRESHOLD,
  VOID_FINDING_THRESHOLD,
} from '../shared/audit/types'

/**
 * How serious a cash difference has to be before it is called serious rather than merely worth a look.
 *
 * One percent of what the drawer should have held. An absolute figure would be wrong in both directions: in a shop
 * taking ₦5,000 a day, ₦500 short is a catastrophe, and in one taking ₦5,000,000 it is a coin that rolled under the
 * counter. Proportional is the only rule that means the same thing in Lagos and in Tokyo.
 */
export const CASH_DIFFERENCE_SERIOUS_BASIS_POINTS = 100n

/** The least a sale can be worth, in the check's own words, before it is one of the ones being judged. */
export interface AuditCheckSale {
  receiptNumber: string
  /** Local clock time, HH:MM:SS. */
  clockTime: string
  totalMinor: bigint
}

/** What check 6 needs, already read out of the immutable `order_events` log by whoever has the database. */
export interface OrderEditedAfterAttempt {
  orderNumber: string
  summary: string
}

export interface AuditCheckInput {
  currency: CurrencyDefinition
  display: MoneyDisplayOptions
  sales: AuditCheckSale[]
  voids: AuditVoidRow[]
  discounts: AuditDiscountRow[]
  reprints: AuditReprintRow[]
  cashTie: AuditCashTie
  ordersEditedAfterPaymentAttempt: OrderEditedAfterAttempt[]
}

/** Every finding the day earned, in the order the checks are written. An empty list is a clean day. */
export function runAuditChecks(input: AuditCheckInput): AuditFinding[] {
  const findings: AuditFinding[] = []
  const money = (amount: bigint): string => formatMoney(amount, input.currency, input.display)

  // 1. The drawer did not hold what it should have.
  if (input.cashTie.counted && input.cashTie.differenceMinor !== null && input.cashTie.differenceMinor !== 0n) {
    const difference = input.cashTie.differenceMinor
    const absolute = difference < 0n ? -difference : difference
    const expected = input.cashTie.expectedCashMinor
    // Proportional, per the constant above. A day with no expectation at all cannot be judged proportionally, and an
    // unexpected naira in an empty drawer is treated as serious rather than waved through by a division by zero.
    const serious = expected <= 0n
      || absolute * 10_000n >= expected * CASH_DIFFERENCE_SERIOUS_BASIS_POINTS
    findings.push({
      code: 'CASH_DIFFERENCE',
      severity: serious ? 'SERIOUS' : 'CONCERN',
      headline: difference < 0n
        ? `The drawer was short by ${money(absolute)}`
        : `The drawer was over by ${money(absolute)}`,
      detail: `Expected ${money(input.cashTie.expectedCashMinor)}, counted ${money(input.cashTie.countedCashMinor ?? 0n)}.`
        + ` Opening float ${money(input.cashTie.openingFloatMinor)}, cash sales ${money(input.cashTie.cashSalesMinor)},`
        + ` cash refunds ${money(input.cashTie.cashRefundsMinor)},`
        + ` drawer events ${money(input.cashTie.drawerAdjustmentsMinor)},`
        + ` debtor cash ${money(input.cashTie.debtorCashMinor)}. Currency ${input.cashTie.currencyCode}.`,
      count: 1,
      amountMinor: difference,
    })
  }

  // 2. More reprints than a normal day produces.
  if (input.reprints.length >= REPRINT_FINDING_THRESHOLD) {
    const busiest = input.reprints.reduce((best, row) => Math.max(best, row.copyNo), 0)
    findings.push({
      code: 'MANY_REPRINTS',
      severity: input.reprints.length >= REPRINT_FINDING_THRESHOLD * 2 ? 'SERIOUS' : 'CONCERN',
      headline: `${input.reprints.length} duplicate print${input.reprints.length === 1 ? '' : 's'} on this day`,
      detail: `The highest copy number was ${busiest}. Every duplicate in the print log carries the reason given and`
        + ' who gave it; a receipt printed again for no reason is a receipt somebody wanted a second copy of.',
      count: input.reprints.length,
      amountMinor: null,
    })
  }

  // 3. Sales that did not complete.
  if (input.voids.length >= VOID_FINDING_THRESHOLD) {
    const total = input.voids.reduce((sum, row) => sum + row.totalMinor, 0n)
    findings.push({
      code: 'MANY_VOIDS',
      severity: 'SERIOUS',
      headline: `${input.voids.length} sale${input.voids.length === 1 ? '' : 's'} not completed`,
      detail: `Worth ${money(total)} together. A finished sale in this product is reversed by a return, never by a`
        + ' void, so a row in this section is either an abandoned draft or something that needs explaining.',
      count: input.voids.length,
      amountMinor: total,
    })
  }

  // 4. Discounts at or over the cap that applied to the person who gave them.
  const aboveCap = input.discounts.filter((row) => row.aboveCap)
  const nearCap = input.discounts.filter((row) => !row.aboveCap && row.nearCap)
  if (aboveCap.length > 0) {
    const discount = aboveCap.reduce((sum, row) => sum + row.discountMinor, 0n)
    findings.push({
      code: 'DISCOUNT_ABOVE_THRESHOLD',
      severity: 'SERIOUS',
      headline: `${aboveCap.length} sale${aboveCap.length === 1 ? '' : 's'} discounted past the cap`,
      detail: `Receipts ${aboveCap.map((row) => row.receiptNumber).join(', ')}, ${money(discount)} taken off between`
        + ' them. A discount past the cap needs an Admin approval, and the approval is in the audit log if it was'
        + ' given.',
      count: aboveCap.length,
      amountMinor: discount,
    })
  } else if (nearCap.length > 0) {
    const discount = nearCap.reduce((sum, row) => sum + row.discountMinor, 0n)
    findings.push({
      code: 'DISCOUNT_ABOVE_THRESHOLD',
      severity: 'NOTE',
      headline: `${nearCap.length} sale${nearCap.length === 1 ? '' : 's'} discounted close to the cap`,
      detail: `Receipts ${nearCap.map((row) => row.receiptNumber).join(', ')}, ${money(discount)} taken off between`
        + ` them, each within ${Number(DISCOUNT_NEAR_CAP_BASIS_POINTS / 100n)}% of the cap that applied to it.`,
      count: nearCap.length,
      amountMinor: discount,
    })
  }

  // 5. Sales rung up in the small hours.
  const lateSales = input.sales.filter((sale) => hourOf(sale.clockTime) < AFTER_MIDNIGHT_CUTOFF_HOUR)
  if (lateSales.length > 0) {
    const total = lateSales.reduce((sum, sale) => sum + sale.totalMinor, 0n)
    findings.push({
      code: 'SALES_AFTER_MIDNIGHT',
      severity: 'CONCERN',
      headline: `${lateSales.length} sale${lateSales.length === 1 ? '' : 's'} recorded before`
        + ` ${String(AFTER_MIDNIGHT_CUTOFF_HOUR).padStart(2, '0')}:00`,
      detail: `Receipts ${lateSales.map((sale) => `${sale.receiptNumber} at ${sale.clockTime}`).join(', ')},`
        + ` ${money(total)} together. These fall on the next business day, so they are not in the day close that was`
        + ' counted for this one.',
      count: lateSales.length,
      amountMinor: total,
    })
  }

  // 6. An order changed after somebody tried to take its payment.
  if (input.ordersEditedAfterPaymentAttempt.length > 0) {
    const edited = input.ordersEditedAfterPaymentAttempt
    findings.push({
      code: 'ORDER_EDITED_AFTER_PAYMENT_ATTEMPT',
      severity: 'SERIOUS',
      headline: `${edited.length} order${edited.length === 1 ? '' : 's'} changed after a payment attempt`,
      detail: edited.map((row) => `${row.orderNumber}: ${row.summary}`).join(' · '),
      count: edited.length,
      amountMinor: null,
    })
  }

  return findings
}

/** The hour of a local clock time, or 24 for anything that is not one — which puts it outside every band. */
export function hourOf(clockTime: string): number {
  const hour = Number(clockTime.slice(0, 2))
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 24
}
