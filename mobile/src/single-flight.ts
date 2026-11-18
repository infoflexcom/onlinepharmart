/**
 * Wraps an async operation so concurrent callers share one in-flight run instead of starting
 * another. Single-use refresh credentials make this a security requirement, not an optimisation:
 * two simultaneous rotations would replay an already-rotated token, which the host treats as theft
 * and answers by revoking the phone.
 */
export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null
  return () => {
    if (inFlight) return inFlight
    let started: Promise<T>
    try {
      started = run()
    } catch (error) {
      return Promise.reject(error)
    }
    inFlight = started.finally(() => {
      inFlight = null
    })
    return inFlight
  }
}
