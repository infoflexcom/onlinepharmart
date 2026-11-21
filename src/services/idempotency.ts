import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export interface IdempotentOutcome<T> {
  /** True when this call replayed a previously completed request instead of doing the work again. */
  replayed: boolean
  response: T
}

/** A key must be a short, opaque identifier; anything else is refused rather than trusted. */
export function normaliseKey(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error('The request key is not in a valid format. Reload the screen and try again.')
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (!/^[A-Za-z0-9:_-]{8,128}$/u.test(trimmed)) {
    throw new Error('The request key is not in a valid format. Reload the screen and try again.')
  }
  return trimmed
}

export function fingerprintOf(request: unknown): string {
  return createHash('sha256').update(stableStringify(request)).digest('hex')
}

/** Deterministic JSON so key order cannot make two identical requests look different. */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'bigint') return JSON.stringify(value.toString())
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`
}

/**
 * Makes a stock-changing operation safe to retry.
 *
 * The existing `idempotency_keys` table is reused: `route` holds the scope ("stock.adjust"),
 * `request_hash` holds a fingerprint of the request body, and `response_json` holds the original answer.
 * Reusing a key with a *different* body is a bug or an attack rather than a retry, so it is refused instead of
 * being silently answered with the old result. The claim and the work share one IMMEDIATE transaction, so two
 * concurrent retries cannot both perform the change.
 */
export class IdempotencyGuard {
  constructor(
    private readonly database: Database.Database,
    private readonly now: () => Date = () => new Date(),
    private readonly retentionDays = 7,
  ) {}

  run<T>(input: {
    scope: string
    key: string | null | undefined
    request: unknown
    actorId?: string | null
    execute: () => T
  }): IdempotentOutcome<T> {
    const supplied = normaliseKey(input.key)
    // With no key, behave exactly as before: one attempt, no ledger row.
    if (!supplied) return { replayed: false, response: input.execute() }

    const scope = input.scope.slice(0, 60)
    const key = `${scope}:${supplied}`.slice(0, 200)
    const requestHash = fingerprintOf(input.request)

    return this.database.transaction((): IdempotentOutcome<T> => {
      const existing = this.database.prepare(`
        SELECT request_hash, response_json, expires_at FROM idempotency_keys WHERE key = ?
      `).get(key) as { request_hash: string; response_json: string | null; expires_at: string } | undefined

      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new Error('This request key was already used for a different change. Start a fresh change instead of retrying the old one.')
        }
        if (existing.response_json === null) {
          throw new Error('This change is still being saved. Wait a moment, then refresh.')
        }
        return { replayed: true, response: JSON.parse(existing.response_json) as T }
      }

      const now = this.now()
      // Claim the key first: a concurrent retry sees the row and is told to wait rather than repeating the work.
      this.database.prepare(`
        INSERT INTO idempotency_keys (key, user_id, route, request_hash, response_json, expires_at, created_at)
        VALUES (?, ?, ?, ?, NULL, ?, ?)
      `).run(
        key, input.actorId ?? null, scope, requestHash,
        new Date(now.getTime() + this.retentionDays * 86_400_000).toISOString(), now.toISOString(),
      )

      const response = input.execute()
      this.database.prepare('UPDATE idempotency_keys SET response_json = ? WHERE key = ?')
        .run(JSON.stringify(response, jsonReplacer), key)
      this.database.prepare('DELETE FROM idempotency_keys WHERE expires_at < ?').run(now.toISOString())
      return { replayed: false, response }
    }).immediate()
  }
}

/** Generates a key for a form submission; the desktop's double-click protection uses this. */
export function newIdempotencyKey(): string {
  return randomUUID()
}

/** BigInt would otherwise throw inside JSON.stringify, and money/quantity integers are BigInt here. */
function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}
