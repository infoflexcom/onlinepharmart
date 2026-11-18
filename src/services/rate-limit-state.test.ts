import { describe, expect, it } from 'vitest'
import { rememberRateLimitState } from './rate-limit-state'

describe('bounded rate-limit state', () => {
  it('prunes expired entries without expiring a block that is still active', () => {
    const states = new Map<string, { windowStartedAt: number; blockedUntil: number }>()
    for (let index = 0; index < 2_000; index += 1) {
      states.set(`expired-${index}`, { windowStartedAt: 0, blockedUntil: 0 })
    }
    states.set('blocked', { windowStartedAt: 0, blockedUntil: 2_500 })

    rememberRateLimitState(states, 'new-client', { windowStartedAt: 2_000, blockedUntil: 0 }, 2_000, 1_000)

    expect(states.size).toBe(2)
    expect(states.has('blocked')).toBe(true)
    expect(states.has('new-client')).toBe(true)
  })

  it('keeps the map capped under a burst of distinct blocked clients', () => {
    const states = new Map<string, { windowStartedAt: number; blockedUntil: number }>()
    for (let index = 0; index < 2_000; index += 1) {
      states.set(`blocked-${index}`, { windowStartedAt: 10, blockedUntil: 100 })
    }

    rememberRateLimitState(states, 'new-client', { windowStartedAt: 10, blockedUntil: 0 }, 10, 1_000)

    expect(states.size).toBe(2_000)
    expect(states.has('new-client')).toBe(true)
    expect(states.has('blocked-0')).toBe(false)
    expect(states.has('blocked-1')).toBe(true)
  })
})
