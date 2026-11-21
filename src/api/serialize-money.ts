/**
 * Money on the wire is a decimal string of integer minor units, never a number.
 *
 * Every host service computes in `bigint` minor units. `JSON.stringify` throws on a BigInt, so any route that
 * hands a service result straight to Fastify must convert first. This converter is shared rather than copied
 * because the alternative is what actually happened: one route remembered to call it and every other route on
 * the same server did not, so the phone's reports screen answered 500 while the refusal tests (which never
 * reached a successful response) all passed.
 */
export function serializeBigInts(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(serializeBigInts)
  if (value && typeof value === 'object') {
    // A Buffer or a typed array is binary, not an object graph to walk.
    if (ArrayBuffer.isView(value)) return value
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, serializeBigInts(entry)]),
    )
  }
  return value
}
