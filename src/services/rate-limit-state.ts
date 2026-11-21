export interface RateLimitState {
  windowStartedAt: number
  blockedUntil: number
}

const MAX_TRACKED_CLIENTS = 2_000

/** Bounds rate-limit maps, preserving active blocks unless hard-cap eviction is unavoidable. */
export function rememberRateLimitState<T extends RateLimitState>(
  states: Map<string, T>,
  key: string,
  state: T,
  now: number,
  windowMs: number,
): void {
  // Refresh insertion order so overflow eviction favors the least recently observed client.
  states.delete(key)
  states.set(key, state)
  if (states.size <= MAX_TRACKED_CLIENTS) return

  for (const [candidate, candidateState] of states) {
    if (now >= candidateState.blockedUntil && now - candidateState.windowStartedAt >= windowMs) {
      states.delete(candidate)
    }
  }

  while (states.size > MAX_TRACKED_CLIENTS) {
    const oldestUnblocked = [...states].find(([candidate, candidateState]) =>
      candidate !== key && now >= candidateState.blockedUntil,
    )?.[0]
    const oldest = oldestUnblocked ?? states.keys().next().value
    if (oldest === undefined) break
    states.delete(oldest)
  }
}
