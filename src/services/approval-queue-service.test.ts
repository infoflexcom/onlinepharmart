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

  it('lets a supervisor decide returns, discounts and voids, but not credit', () => {
    const { service } = setup()
    const credit = service.raise({ kind: 'CREDIT', actor: CASHIER, currencyCode: 'NGN', amountMinor: 500n, payload: {} })
    const discount = service.raise({ kind: 'DISCOUNT', actor: CASHIER, currencyCode: 'NGN', amountMinor: 500n, payload: {} })

    // A supervisor's queue excludes the credit request entirely.
    expect(service.listPending(SUPERVISOR).map((request) => request.id)).toEqual([discount.id])
    expect(() => service.resolve(credit.id, 'APPROVE', SUPERVISOR)).toThrow(/Only an Admin can decide/u)
    expect(service.resolve(discount.id, 'APPROVE', SUPERVISOR).status).toBe('APPROVED')
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
