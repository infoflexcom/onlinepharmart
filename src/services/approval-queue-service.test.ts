import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrateDatabase } from '../db/migrate'
import type { PublicUser } from '../shared/auth/types'
import { ApprovalQueueService } from './approval-queue-service'

const NOW = new Date('2026-11-17T12:00:00.000Z')

function user(role: PublicUser['role'], id = `user-${role.toLowerCase()}`, fullName = `${role} User`): PublicUser {
  return {
    id, fullName, username: id, role, isActive: true, isLocked: false,
    permissions: { allowWholesale: true, maxDiscountBasisPoints: 500, allowCreditSales: true, returnLimitMinor: 1_000n },
  }
}

const ADMIN = user('ADMIN', 'admin-1', 'Harbor Admin')
const SUPERVISOR = user('SUPERVISOR', 'supervisor-1', 'Sade Supervisor')
const CASHIER = user('CASHIER', 'cashier-1', 'Ada Cashier')

function setup() {
  const database = new Database(':memory:')
  migrateDatabase(database)
  for (const account of [ADMIN, SUPERVISOR, CASHIER]) {
    database.prepare('INSERT INTO users (id, full_name, username, password_hash, role) VALUES (?, ?, ?, ?, ?)')
      .run(account.id, account.fullName, account.username, 'hash', account.role)
  }
  let counter = 0
  const service = new ApprovalQueueService(database, () => NOW, () => `request-${++counter}`)
  return { database, service }
}

describe('the approvals queue', () => {
  it('carries all four kinds of cashier request with money in integer minor units', () => {
    const { service } = setup()
    for (const kind of ['DISCOUNT', 'CREDIT', 'VOID', 'RETURN'] as const) {
      service.raise({
        kind, actor: CASHIER, currencyCode: 'NGN',
        amountMinor: 2_550n, payload: { saleId: 12, note: `${kind} request` },
      })
    }
    const pending = service.listPending(ADMIN)
    expect(pending.map((request) => request.kind)).toEqual(['DISCOUNT', 'CREDIT', 'VOID', 'RETURN'])
    expect(pending[0]).toMatchObject({
      label: 'Discount above the shop limit',
      requester: 'Ada Cashier',
      amountMinor: '2550',
      currencyCode: 'NGN',
      status: 'PENDING',
    })
    // Integer minor units survive as an exact string, never as a float.
    expect(pending.every((request) => typeof request.amountMinor === 'string')).toBe(true)
  })

  it('refuses a supervisor deciding anything, because the role is now audit-only', () => {
    const { service } = setup()
    const credit = service.raise({ kind: 'CREDIT', actor: CASHIER, currencyCode: 'NGN', amountMinor: 500n, payload: {} })
    const discount = service.raise({ kind: 'DISCOUNT', actor: CASHIER, currencyCode: 'NGN', amountMinor: 500n, payload: {} })
    const returned = service.raise({ kind: 'RETURN', actor: CASHIER, currencyCode: 'NGN', amountMinor: 500n, payload: {} })

    // All three used to be decidable by a Supervisor except credit. None of them is now: each one authorises a
    // movement of money or stock, and the role holds no operational authority.
    for (const request of [credit, discount, returned]) {
      expect(() => service.resolve(request.id, 'APPROVE', SUPERVISOR)).toThrow(/Only an Admin can decide/u)
    }
    // A supervisor's queue is empty, because it can decide nothing: a queue of work it may not do would be a lie.
    expect(service.listPending(SUPERVISOR)).toEqual([])
    // The Admin still decides all three.
    expect(service.resolve(discount.id, 'APPROVE', ADMIN).status).toBe('APPROVED')
  })

  it('refuses a cashier deciding any request, including their own', () => {
    const { service } = setup()
    const request = service.raise({ kind: 'DISCOUNT', actor: CASHIER, currencyCode: 'NGN', amountMinor: 1n, payload: {} })
    expect(() => service.resolve(request.id, 'APPROVE', CASHIER)).toThrow(/Only an Admin can decide/u)
    expect(service.listPending(ADMIN)).toHaveLength(1)
  })

  it('decides once only, so two Admins cannot both approve', () => {
    const { service } = setup()
    const request = service.raise({ kind: 'VOID', actor: CASHIER, currencyCode: 'NGN', payload: { saleId: 7 } })
    expect(service.resolve(request.id, 'APPROVE', ADMIN).status).toBe('APPROVED')
    expect(() => service.resolve(request.id, 'REJECT', ADMIN)).toThrow(/already decided/u)
    const recent = service.listRecent(ADMIN)
    expect(recent[0]).toMatchObject({ status: 'APPROVED', resolvedBy: 'Harbor Admin' })
  })

  it('notifies a subscriber when a request is raised and when it is decided', () => {
    const { service } = setup()
    const events: string[] = []
    service.subscribe((event) => events.push(`${event.type}:${event.request.kind}`))
    const request = service.raise({ kind: 'RETURN', actor: CASHIER, currencyCode: 'NGN', payload: {} })
    service.resolve(request.id, 'REJECT', ADMIN)
    expect(events).toEqual(['approval.created:RETURN', 'approval.resolved:RETURN'])
  })

  // A till that raises a request tells the cashier to press Complete again once the Admin accepts, so pressing it again
  // is the instructed thing to do. Pressing it *before* anybody has answered — twice, or nervously while a customer
  // waits — used to file a fresh request every time, and the Admin's queue and the phone's badge showed one question
  // several times over. Approving one of them left the rest pending against a sale that had already completed.
  it('keeps one request waiting when the same person asks the same question again', () => {
    const { service } = setup()
    const question = {
      kind: 'DISCOUNT' as const, actor: CASHIER, currencyCode: 'NGN', amountMinor: 500n,
      payload: { idempotencyKey: 'key-1', excessMinor: '500', subtotalMinor: '10000' },
    }
    const first = service.raise(question)
    const second = service.raise(question)
    const third = service.raise(question)
    // The same row handed back, so the till names the same request every time rather than a new id per attempt.
    expect(second.id).toBe(first.id)
    expect(third.id).toBe(first.id)
    expect(service.listPending(ADMIN)).toHaveLength(1)
  })

  it('announces a request once, however many times it is asked', () => {
    const { service } = setup()
    const events: string[] = []
    service.subscribe((event) => events.push(`${event.type}:${event.request.id}`))
    const question = { kind: 'CREDIT' as const, actor: CASHIER, currencyCode: 'NGN', amountMinor: 900n, payload: { idempotencyKey: 'key-2' } }
    const first = service.raise(question)
    service.raise(question)
    service.raise(question)
    // A second "created" for a row that already exists would ring the Admin's phone about work that is already on it.
    expect(events).toEqual([`approval.created:${first.id}`])
  })

  it('files a second request when the question is a different one', () => {
    const { service } = setup()
    service.raise({ kind: 'DISCOUNT', actor: CASHIER, currencyCode: 'NGN', amountMinor: 500n, payload: { idempotencyKey: 'key-3', excessMinor: '500' } })
    // A bigger excess is a different decision: an Admin who authorized 500 must not be shown it as 1,000, and a
    // cashier who raised the discount and tried again is asking something new.
    service.raise({ kind: 'DISCOUNT', actor: CASHIER, currencyCode: 'NGN', amountMinor: 1_000n, payload: { idempotencyKey: 'key-3', excessMinor: '1000' } })
    // Another checkout key is another sale, so it cannot hide behind the first one's request either.
    service.raise({ kind: 'DISCOUNT', actor: CASHIER, currencyCode: 'NGN', amountMinor: 500n, payload: { idempotencyKey: 'key-4', excessMinor: '500' } })
    const pending = service.listPending(ADMIN)
    expect(pending).toHaveLength(3)
    expect(pending.map((request) => request.amountMinor)).toEqual(['500', '1000', '500'])
  })

  it('files a separate request for a second person asking the same thing', () => {
    const { database, service } = setup()
    // Same display name on purpose. The payload carries the asker's name, so two people who happen to share one would
    // look identical to a comparison that forgot the person: what has to separate them is who asked, because an
    // approval only ever unlocks an attempt by the person it was filed for.
    const other = user('CASHIER', 'cashier-2', CASHIER.fullName)
    database.prepare('INSERT INTO users (id, full_name, username, password_hash, role) VALUES (?, ?, ?, ?, ?)')
      .run(other.id, other.fullName, other.username, 'hash', other.role)
    const question = { idempotencyKey: 'key-5', excessMinor: '500' }

    const first = service.raise({ kind: 'DISCOUNT', actor: CASHIER, currencyCode: 'NGN', amountMinor: 500n, payload: question })
    const second = service.raise({ kind: 'DISCOUNT', actor: other, currencyCode: 'NGN', amountMinor: 500n, payload: question })

    expect(second.id, 'the second cashier gets a decision that can reach them').not.toBe(first.id)
    const pending = service.listPending(ADMIN)
    expect(pending).toHaveLength(2)
    expect(pending.map((request) => request.requestedBy).sort()).toEqual([CASHIER.id, other.id].sort())
  })

  it('asks again once the Admin has answered, whichever way they answered', () => {
    const { service } = setup()
    const question = { kind: 'DISCOUNT' as const, actor: CASHIER, currencyCode: 'NGN', amountMinor: 500n, payload: { idempotencyKey: 'key-6', excessMinor: '500' } }
    const rejected = service.raise(question)
    service.resolve(rejected.id, 'REJECT', ADMIN)
    // A rejection is an answer, not a wall: asking again is how a cashier puts a case back to the Admin, and swallowing
    // the second attempt would leave them told to wait for a decision that has already been made against them.
    const askedAgain = service.raise(question)
    expect(askedAgain.id).not.toBe(rejected.id)
    expect(askedAgain.status).toBe('PENDING')
    expect(service.listPending(ADMIN)).toHaveLength(1)

    service.resolve(askedAgain.id, 'APPROVE', ADMIN)
    const afterApproval = service.raise(question)
    expect(afterApproval.id, 'an answered request is not a waiting one').not.toBe(askedAgain.id)
    expect(afterApproval.status).toBe('PENDING')
  })

  it('never matches a waiting request it cannot read', () => {
    const { database, service } = setup()
    const question = { kind: 'VOID' as const, actor: CASHIER, currencyCode: 'NGN', payload: { saleId: 7 } }
    const first = service.raise(question)
    // A row damaged in place — a truncated write, a hand edit, a payload from a version this one cannot parse. Guessing
    // that it is the same question would swallow a real request, so the safe direction is to file a new one.
    database.prepare('UPDATE approval_requests SET payload_json = ? WHERE id = ?').run('{ not json', first.id)
    const second = service.raise(question)
    expect(second.id).not.toBe(first.id)
    expect(service.listPending(ADMIN).map((request) => request.id)).toContain(second.id)
  })

  it('keeps the audit trail of who asked and who decided', () => {
    const { database, service } = setup()
    const request = service.raise({ kind: 'CREDIT', actor: CASHIER, currencyCode: 'NGN', amountMinor: 900n, payload: { customer: 'Walk-in' } })
    service.resolve(request.id, 'APPROVE', ADMIN)
    const actions = (database.prepare('SELECT actor, action FROM audit_log ORDER BY created_at').all() as Array<{ actor: string; action: string }>)
    expect(actions.map(({ action }) => action)).toEqual(['approvals.requested', 'approvals.approved'])
    expect(actions.map(({ actor }) => actor)).toEqual(['cashier-1', 'admin-1'])
  })

  it('refuses a decision on a request that does not exist', () => {
    const { service } = setup()
    expect(() => service.resolve('missing', 'APPROVE', ADMIN)).toThrow(/no longer exists/u)
  })
})
