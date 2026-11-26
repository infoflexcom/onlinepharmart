/**
 * Which figures make a day the day that was signed off.
 *
 * A sign-off is immutable, and so is a completed sale, so the day a Supervisor attested to should never change. Should.
 * A late return, a drawer event recorded after the count, a payment taken against an old balance — each of those is
 * legitimate and each of them moves a total. When one does, the screen has to say "the day you signed is not the day
 * that is there now" rather than carry on showing a verdict that no longer covers what it is displayed against.
 *
 * This module is the list of fields that answer "is it still the same day?", and nothing else. It is deliberately free
 * of `node:crypto` and of any database import so that the browser preview, which builds the same report from its own
 * in-memory day, can compare the same fields: one spelling of what matters, two callers. The service hashes the key
 * before storing it; the preview compares the key itself, because a hash buys nothing in a demo that never leaves the
 * tab and the renderer has no synchronous sha256 to hash with.
 *
 * Adding a field here is a decision, not a formality: too few and a real change goes unnoticed, too many and the warning
 * fires on something that moved nothing — a timestamp, a name — and the Supervisor learns to ignore it.
 */
import type { DailyAuditReport } from '../shared/audit/types'

/** The figures, as text, in a fixed order. Never re-sorted: the order is part of the comparison. */
export function auditDigestParts(report: DailyAuditReport): string[] {
  return [
    report.businessDate,
    report.currencyCode,
    report.account?.id ?? 'STORE',
    report.totals.grossSalesMinor.toString(),
    report.totals.totalSalesMinor.toString(),
    report.totals.netSalesMinor.toString(),
    report.totals.transactions.toString(),
    report.totals.discountsMinor.toString(),
    report.totals.returnsMinor.toString(),
    report.totals.refundsMinor.toString(),
    report.totals.creditSalesMinor.toString(),
    report.totals.debtorPaymentsMinor.toString(),
    report.cashTie.expectedCashMinor.toString(),
    report.cashTie.countedCashMinor?.toString() ?? 'UNCOUNTED',
    report.reconciliation.salesFromLedgerMinor.toString(),
    report.reconciliation.paymentsFromLedgerMinor.toString(),
    report.findings.map((finding) => `${finding.code}:${finding.count}`).join(','),
  ]
}

/**
 * The same figures as one string.
 *
 * The separator is a NUL, which cannot appear in a date, a currency code or a decimal figure, so no pair of different
 * days can produce the same key by one field's ending running into the next one's beginning.
 */
export function auditDigestKey(report: DailyAuditReport): string {
  return auditDigestParts(report).join('\u0000')
}
