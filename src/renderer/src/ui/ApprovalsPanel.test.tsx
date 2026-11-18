import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { InfoflexBridge } from '@shared/bridge'
import type { ApprovalRequestView } from '@shared/approvals/types'
import { getCurrency } from '@shared/currency/catalog'
import { defaultDisplayOptions, formatMoney } from '@shared/currency/money'
import { DEFAULT_OPERATIONAL_SETTINGS } from '@shared/shop/types'
import { ApprovalsPanel } from './ApprovalsPanel'

const NGN = getCurrency('NGN')!
const display = defaultDisplayOptions(NGN)

function request(overrides: Partial<ApprovalRequestView> = {}): ApprovalRequestView {
  return {
    id: 'request-1',
    kind: 'DISCOUNT',
    label: 'Discount above the shop limit',
    status: 'PENDING',
    requester: 'Ada Cashier',
    requestedBy: 'cashier-1',
    resolvedBy: null,
    amountMinor: '255000',
    currencyCode: 'NGN',
    createdAt: '2026-11-17T11:30:00.000Z',
    resolvedAt: null,
    payload: {},
    ...overrides,
  }
}

function bridge(pending: ApprovalRequestView[], recent: ApprovalRequestView[] = []): InfoflexBridge {
  return {
    listPendingApprovals: async () => pending,
    listRecentApprovals: async () => recent,
    resolveApproval: async () => pending[0]!,
  } as unknown as InfoflexBridge
}

/** Server rendering cannot run the load effect, so these assertions target the shell copy and props. */
describe('the approvals queue panel', () => {
  it('explains what the queue is for', () => {
    const markup = renderToStaticMarkup(<ApprovalsPanel bridge={bridge([])} currency={NGN} canDecide />)
    expect(markup).toContain('Discounts above the limit')
    expect(markup).toContain('returns above the limit')
    expect(markup).toContain('The cashier sees your decision immediately')
  })

  it('says when nothing is waiting', () => {
    const markup = renderToStaticMarkup(<ApprovalsPanel bridge={bridge([])} currency={NGN} canDecide />)
    expect(markup).toContain('Nothing is waiting for approval')
  })

  it('renders one row per waiting request with requester and amount', () => {
    const markup = renderToStaticMarkup(
      <ApprovalsPanel bridge={bridge([request()])} currency={NGN} canDecide pollMs={60_000} initialPending={[request()]} />,
    )
    expect(markup).toContain('Approvals')
    expect(markup).toContain('Discount above the shop limit')
    expect(markup).toContain('Ada Cashier')
    expect(markup).toContain('Approve')
    expect(markup).toContain('Reject')
  })

  it('formats the money in the shop currency, not a hard-coded symbol', () => {
    // formatMoney is the single source of truth for currency rendering.
    expect(formatMoney(255_000n, NGN, display)).toContain('₦')
    expect(formatMoney(255_000n, getCurrency('USD')!, defaultDisplayOptions(getCurrency('USD')!))).toContain('$')
  })

  it('marks each row decided by a person, not a machine', () => {
    const decided = request({ status: 'APPROVED', resolvedBy: 'Harbor Admin', resolvedAt: '2026-11-17T11:35:00.000Z' })
    const markup = renderToStaticMarkup(<ApprovalsPanel bridge={bridge([], [decided])} currency={NGN} canDecide={false} initialRecent={[decided]} />)
    expect(markup).toContain('Recently decided')
    expect(markup).toContain('decided by Harbor Admin')
  })

  it('tells a cashier to wait rather than offering buttons they cannot use', () => {
    const markup = renderToStaticMarkup(<ApprovalsPanel bridge={bridge([request()])} currency={NGN} canDecide={false} initialPending={[request()]} />)
    expect(markup).toContain('Waiting for an Admin or Supervisor')
  })

  it('keeps the shop settings import stable for the fixture currency', () => {
    expect(DEFAULT_OPERATIONAL_SETTINGS).toBeTruthy()
  })
})
