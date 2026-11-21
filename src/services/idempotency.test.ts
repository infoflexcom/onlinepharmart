import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrateDatabase } from '../db/migrate'
import { fingerprintOf, IdempotencyGuard, normaliseKey, stableStringify } from './idempotency'

const NOW = new Date('2026-11-17T12:00:00.000Z')

function setup() {
  const database = new Database(':memory:')
  migrateDatabase(database)
  const guard = new IdempotencyGuard(database, () => NOW)
  return { database, guard }
}

describe('idempotency keys for stock changes', () => {
  it('applies the work once and returns the original answer on a retry', () => {
    const { guard } = setup()
    let calls = 0
    const work = () => { calls += 1; return { reference: 'ADJ-1', quantityDeltaMilli: '500' } }

    const first = guard.run({ scope: 'stock.adjust', key: 'key-00000001', request: { quantity: '0.5' }, execute: work })
    expect(first).toEqual({ replayed: false, response: { reference: 'ADJ-1', quantityDeltaMilli: '500' } })

    const retry = guard.run({ scope: 'stock.adjust', key: 'key-00000001', request: { quantity: '0.5' }, execute: work })
    expect(retry.replayed).toBe(true)
    expect(retry.response).toEqual(first.response)
    // The dangerous part: the work ran exactly once.
    expect(calls).toBe(1)
  })

  it('scopes keys so the same key in another operation is independent', () => {
    const { guard } = setup()
    guard.run({ scope: 'stock.adjust', key: 'shared-key-1', request: {}, execute: () => 'adjust' })
    const other = guard.run({ scope: 'stock.stocktake', key: 'shared-key-1', request: {}, execute: () => 'stocktake' })
    expect(other).toEqual({ replayed: false, response: 'stocktake' })
  })

  it('refuses to reuse one key for a different change', () => {
    const { guard } = setup()
    guard.run({ scope: 'stock.adjust', key: 'key-00000002', request: { quantity: '0.5' }, execute: () => 'ok' })
    expect(() => guard.run({
      scope: 'stock.adjust', key: 'key-00000002', request: { quantity: '9' }, execute: () => 'wrong',
    })).toThrow(/already used for a different change/u)
  })

  it('ignores the order of fields when comparing requests', () => {
    const { guard } = setup()
    guard.run({ scope: 'stock.adjust', key: 'key-00000003', request: { a: 1, b: 2 }, execute: () => 'ok' })
    const retry = guard.run({ scope: 'stock.adjust', key: 'key-00000003', request: { b: 2, a: 1 }, execute: () => 'ok' })
    expect(retry.replayed).toBe(true)
  })

  it('does not touch the ledger when no key is supplied', () => {
    const { database, guard } = setup()
    guard.run({ scope: 'stock.adjust', key: null, request: {}, execute: () => 'ok' })
    guard.run({ scope: 'stock.adjust', key: undefined, request: {}, execute: () => 'ok' })
    expect(database.prepare('SELECT COUNT(*) AS count FROM idempotency_keys').get()).toEqual({ count: 0 })
  })

  it('rolls the key claim back when the work fails, so a real retry can succeed', () => {
    const { database, guard } = setup()
    expect(() => guard.run({
      scope: 'stock.adjust', key: 'key-00000004', request: {}, execute: () => { throw new Error('stock conflict') },
    })).toThrow(/stock conflict/u)
    expect(database.prepare('SELECT COUNT(*) AS count FROM idempotency_keys').get()).toEqual({ count: 0 })
    expect(guard.run({ scope: 'stock.adjust', key: 'key-00000004', request: {}, execute: () => 'ok' }))
      .toEqual({ replayed: false, response: 'ok' })
  })

  it('rejects a key that is too short or contains unsafe characters', () => {
    expect(() => normaliseKey('a')).toThrow(/valid format/u)
    expect(() => normaliseKey('has spaces in it')).toThrow(/valid format/u)
    expect(() => normaliseKey('x'.repeat(200))).toThrow(/valid format/u)
    expect(normaliseKey('')).toBeNull()
    expect(normaliseKey(undefined)).toBeNull()
    expect(normaliseKey('Abc:123-xyz_9')).toBe('Abc:123-xyz_9')
  })

  it('fingerprints the same request identically and different requests differently', () => {
    expect(fingerprintOf({ a: 1, b: [2, 3] })).toBe(fingerprintOf({ b: [2, 3], a: 1 }))
    expect(fingerprintOf({ a: 1 })).not.toBe(fingerprintOf({ a: 2 }))
    expect(stableStringify({ z: 1, a: { y: 2, b: 3 } })).toBe('{"a":{"b":3,"y":2},"z":1}')
    expect(stableStringify({ amount: 10n })).toBe('{"amount":"10"}')
  })
})
