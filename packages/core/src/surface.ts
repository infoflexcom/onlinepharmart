/**
 * Derives the surface a process actually registers — every IPC channel and every HTTP route — from the source
 * files that register them.
 *
 * This exists because the alternative is a hand-kept list, and a hand-kept list is how the installer's include
 * checker came to report "consistent" about a file it did not read. The rule this module enforces is the same one:
 * **the list of things to police is read from the code that registers them**, so a route added tomorrow is either
 * in the policy table or the test fails.
 *
 * It reads text rather than importing the modules on purpose. Importing `ipc.ts` would need an Electron
 * `IpcMain`, and importing `server.ts` would bind ports; neither is appropriate in a test whose subject is the
 * *shape* of the registrations. Reading is honest about what it is: a scanner, with the limitations noted below.
 *
 * Deliberately **not** a general-purpose parser. It understands exactly the two registration idioms in this
 * repository, and `assertRecognisedIdiom()` exists so that a third idiom cannot be introduced quietly and be
 * silently unseen.
 */

export interface HttpRegistration {
  method: string
  path: string
  /** `METHOD /path`, the form the policy table uses. */
  key: string
  file: string
}

export interface Surface {
  ipc: string[]
  http: HttpRegistration[]
}

/** Thrown when a file registers something in a shape this scanner does not understand. */
export class UnrecognisedRegistrationError extends Error {}

/**
 * Extract `handle('<channel>'` calls. The desktop IPC layer wraps every registration in a local `handle` helper, so
 * every channel in the product passes through exactly this line.
 */
export function scanIpcChannels(source: string): string[] {
  const found: string[] = []
  for (const match of source.matchAll(/\bhandle\(\s*'([^']+)'/g)) found.push(match[1]!)
  return found
}

/**
 * Extract Fastify registrations in two forms:
 *
 * - `server.get('/path'`, `server.post(`, `server.put(`, `server.patch(`, `server.delete(`
 * - `route('GET', '/path'`, the local wrapper `mobile-admin-routes.ts` uses
 *
 * Both are matched by their literal path, because a path built at runtime could not be policed by a table of
 * literal keys — and if one ever appears, `assertRecognisedIdiom` is there to say so rather than to miss it.
 */
export function scanHttpRoutes(source: string, file = ''): HttpRegistration[] {
  const found: HttpRegistration[] = []
  const verb = /\bserver\.(get|post|put|patch|delete)\(\s*'([^']+)'/g
  for (const match of source.matchAll(verb)) {
    found.push({ method: match[1]!.toUpperCase(), path: match[2]!, key: `${match[1]!.toUpperCase()} ${match[2]!}`, file })
  }
  const routed = /\broute\(\s*'(GET|POST|PUT|PATCH|DELETE)'\s*,\s*'([^']+)'/g
  for (const match of source.matchAll(routed)) {
    found.push({ method: match[1]!, path: match[2]!, key: `${match[1]!} ${match[2]!}`, file })
  }
  return found
}

/**
 * Fail loudly if a file contains a registration-shaped call the scanner did not understand.
 *
 * The two patterns that would slip through today are a computed path (`server.get(someVariable, …)`) and a verb the
 * scanner does not list. Both are caught here rather than being quietly absent from the surface — an absent route
 * is an unpoliced route, and an unpoliced route is refused at runtime but only *because it is absent*, which turns
 * a mistake into an outage instead of a test failure.
 */
export function assertRecognisedIdiom(source: string, file: string): void {
  // Every verb call must be followed by a quote; one that is not was not seen by the scanner as a named route.
  const verbCalls = [...source.matchAll(/\bserver\.(get|post|put|patch|delete)\(/g)].length
  const verbLiterals = [...source.matchAll(/\bserver\.(get|post|put|patch|delete)\(\s*'/g)].length
  const routeCalls = [...source.matchAll(/\broute\(/g)].length
  const routeLiterals = [...source.matchAll(/\broute\(\s*'(GET|POST|PUT|PATCH|DELETE)'\s*,\s*'/g)].length

  /**
   * `mobile-admin-routes.ts` legitimately registers no literals through `server.get`/`server.post` directly. It has
   * one `route(method, url, handler)` helper containing a two-branch dispatch — `server.get(url, …)` /
   * `server.post(url, …)` — and every actual route is named in a literal `route('GET', '/…')` call that the scanner
   * does read. So a small number of computed verb calls is *explained* by having that wrapper, and the count to
   * complain about is however many computed calls exceed the wrapper's own dispatch sites.
   *
   * This is the difference between "there is an idiom here I understand" and "there is a computed path I cannot
   * see". The wrapper's own dispatch is one site per verb it handles; anything beyond that is unseen.
   */
  const wrapperDispatch = routeLiterals > 0 ? 2 : 0
  const unexplainedVerbs = Math.max(0, verbCalls - verbLiterals - wrapperDispatch)
  const unexplainedRoute = Math.max(0, routeCalls - routeLiterals)

  const problems: string[] = []
  if (unexplainedVerbs > 0) problems.push(`${unexplainedVerbs} server.<verb>() call(s) with a computed path`)
  if (unexplainedRoute > 0) problems.push(`${unexplainedRoute} route() call(s) with a computed verb or path`)
  if (problems.length > 0) {
    throw new UnrecognisedRegistrationError(
      `${file} registers ${problems.join(' and ')}. Every route must be a literal so the permission policy can name it.`,
    )
  }
}

/** Assemble a surface from a map of file path → source text. */
export function scanSurface(files: ReadonlyMap<string, string>): Surface {
  const ipc: string[] = []
  const http: HttpRegistration[] = []
  for (const [file, source] of files) {
    ipc.push(...scanIpcChannels(source))
    assertRecognisedIdiom(source, file)
    http.push(...scanHttpRoutes(source, file))
  }
  return { ipc: [...new Set(ipc)].sort(), http }
}
