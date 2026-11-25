/**
 * Money, re-exported — not reimplemented.
 *
 * The brief keeps the existing currency module: `formatMoney`, `parseMoney`, rounding and the lock guard. Copying
 * it here would create a second implementation that could round differently, and a shop that rounds differently in
 * the client and the server is a shop whose receipts do not reconcile.
 *
 * So this file has no money logic in it at all. It points at the one implementation in `src/currency/`, which is
 * itself free of I/O and therefore legitimately shareable. `packages/core/test/no-io.test.ts` asserts that the
 * chain this pulls in imports no `node:`, `electron`, `fastify` or `better-sqlite3` module.
 */
export * from '../../../src/currency/money'
export * from '../../../src/currency/parse'
export * from '../../../src/currency/lock-guard'
export type { CurrencyDefinition } from '../../../src/currency/catalog'
