/**
 * `@infoflex/core` — the code a shop server and a shop client both need, and that neither owns.
 *
 * Three things live here, and the boundary is deliberate:
 *
 * - `roles` — the four-role vocabulary and the deprecated-alias resolution.
 * - `policy` — the single table saying who may do what, plus the decision function.
 * - `surface` — reading the registered IPC channels and HTTP routes out of the code that registers them.
 * - `money` — re-exported pointers at `src/currency/`, not a second implementation.
 *
 * What may **not** live here: anything that opens a file, a socket or a database. A shared package that reaches for
 * the filesystem cannot be loaded by a browser client, and one that reaches for SQLite is exactly the thing this
 * architecture exists to prevent. `no-io.test.ts` enforces this by walking the import graph.
 */
export * from './roles'
export * from './capabilities'
export * from './policy'
export * from './surface'
export * from './money'
