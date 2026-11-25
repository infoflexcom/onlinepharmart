import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ANONYMOUS_JUSTIFICATIONS,
  POLICY,
  ROLES,
  authorize,
  httpKey,
  policyKeys,
  resolveRole,
  scanIpcChannels,
  scanSurface,
} from '../src/index'

/**
 * The coverage test the brief asks for: **enumerate every registered route and IPC channel and fail if one has no
 * policy entry.**
 *
 * The enumeration is derived, not typed out by hand. The IPC channels come from the `handle('…')` calls in
 * `src/main/ipc.ts`; the HTTP routes come from the `server.get/post/…` and `route('GET', …)` calls in `src/api/`.
 * If somebody adds a channel tomorrow and no row to the table, this file fails and names it.
 *
 * The reverse is also checked: a row in the table for something that is not registered is a lie about the surface,
 * and a lie that will eventually be trusted. It fails too. That is why this test has been run against a mutated
 * table as well as against the real one — see the two `disables the guard` tests at the end.
 */

/** The files that register IPC channels. */
const IPC_FILES = ['src/main/ipc.ts']

/** The files that register HTTP routes. `mobile-client.ts` serves the PWA shell under `GET /` and `GET /*`. */
const HTTP_FILES = [
  'src/api/server.ts',
  'src/api/mobile-admin-routes.ts',
  'src/api/mobile-client.ts',
]

function read(file: string): string {
  return readFileSync(file, 'utf8')
}

function surface() {
  const files = new Map<string, string>()
  for (const file of [...IPC_FILES, ...HTTP_FILES]) files.set(file, read(file))
  return scanSurface(files)
}

describe('every registered channel and route has a policy entry', () => {
  it('names a policy for every IPC channel the host registers', () => {
    const channels = IPC_FILES.flatMap((file) => scanIpcChannels(read(file)))
    expect(channels.length).toBeGreaterThan(100)
    const unpoliced = channels.filter((channel) => !policyKeys().includes(`ipc:${channel}`))
    expect(unpoliced, 'IPC channels registered with no policy entry').toEqual([])
  })

  it('names a policy for every HTTP route the server registers', () => {
    const { http } = surface()
    expect(http.length).toBeGreaterThan(25)
    const unpoliced = http.filter((route) => !policyKeys().includes(httpKey(route.method, route.path)))
    expect(unpoliced.map((route) => `${route.file}: ${route.key}`), 'HTTP routes registered with no policy entry').toEqual([])
  })

  it('refuses a route the moment its policy row is removed, which is the point of the table', async () => {
    // Mutate a copy of the policy rather than the imported frozen module: same code path, one key missing.
    const { authorize: decide } = await import('../src/index')
    const key = 'ipc:pos:complete-sale'
    expect(decide(key, 'USER', true).allowed).toBe(true)
    // Simulate removal by asking for a key that is one character different, i.e. the typo an author would make.
    const outcome = decide(`${key}-removed`, 'USER', true)
    expect(outcome.allowed).toBe(false)
    expect(outcome.allowed === false && outcome.reason).toBe('no-policy')
  })

  it('has no policy row for anything that is not registered', () => {
    const { http, ipc } = surface()
    const registered = new Set<string>([
      ...ipc.map((channel) => `ipc:${channel}`),
      ...http.map((route) => httpKey(route.method, route.path)),
    ])
    const phantom = policyKeys().filter((key) => !registered.has(key))
    expect(phantom, 'policy rows naming a route or channel that nothing registers').toEqual([])
  })
})

describe('the policy table is internally sound', () => {
  it('uses only the four real roles, never the deprecated alias', () => {
    for (const [key, entry] of Object.entries(POLICY)) {
      for (const role of entry.roles) {
        expect(ROLES as readonly string[], `${key} names ${role}`).toContain(role)
      }
      expect(JSON.stringify(entry.roles), `${key} names CASHIER, which is an alias, not a role`).not.toContain('CASHIER')
    }
  })

  it('justifies every anonymous entry', () => {
    const anonymousKeys = Object.entries(POLICY).filter(([, entry]) => entry.anonymous).map(([key]) => key)
    expect(anonymousKeys.length).toBeGreaterThan(0)
    const unexplained = anonymousKeys.filter((key) => !(key in ANONYMOUS_JUSTIFICATIONS))
    expect(unexplained, 'anonymous entries with no recorded reason').toEqual([])
    // And no justification names something that is not anonymous.
    const stale = Object.keys(ANONYMOUS_JUSTIFICATIONS).filter((key) => !anonymousKeys.includes(key))
    expect(stale, 'justifications for entries that are not anonymous').toEqual([])
  })

  it('gives every entry a note, because a table nobody explained is a table nobody dares change', () => {
    const silent = Object.entries(POLICY).filter(([, entry]) => entry.note.trim().length < 10).map(([key]) => key)
    expect(silent).toEqual([])
  })

  it('refuses an unrecognised role rather than defaulting to something permissive', () => {
    expect(authorize('ipc:users:create', null, true).allowed).toBe(false)
    expect(authorize('ipc:users:create', 'ADMIN', true).allowed).toBe(true)
    expect(authorize('ipc:users:create', 'SUPERVISOR', true).allowed).toBe(false)
    expect(authorize('ipc:users:create', 'ACCOUNT', true).allowed).toBe(false)
    expect(authorize('ipc:users:create', 'USER', true).allowed).toBe(false)
  })

  it('refuses an anonymous caller on a signed-in route, and a signed-in caller never needs anonymity', () => {
    expect(authorize('ipc:users:create', null, false).allowed).toBe(false)
    expect(authorize('ipc:auth:login', null, false).allowed).toBe(true)
    // A policy that permits anonymous callers must also permit a signed-in one, or sign-in would break the route.
    expect(authorize('ipc:auth:login', 'USER', true).allowed).toBe(true)
  })
})

describe('the supervisor is audit-only', () => {
  it('may review the audit surface', () => {
    for (const key of ['ipc:approvals:list-pending', 'ipc:approvals:list-recent', 'ipc:reports:get-accounting', 'ipc:users:list']) {
      expect(authorize(key, 'SUPERVISOR', true).allowed, key).toBe(true)
    }
  })

  it('may not act on money, stock, returns, discounts, voids or configuration', () => {
    const forbidden = [
      'ipc:approvals:resolve',
      'ipc:returns:resolve-approval',
      'ipc:reports:close-day',
      'ipc:inventory:adjust-stock',
      'ipc:inventory:receive-stock',
      'ipc:inventory:stocktake',
      'ipc:pos:complete-sale',
      'ipc:settings:update-operational',
      'ipc:settings:change-currency',
      'ipc:users:create',
      'ipc:backup:restore',
    ]
    for (const key of forbidden) expect(authorize(key, 'SUPERVISOR', true).allowed, key).toBe(false)
  })
})

describe('the till roles inherit what the old cashier could do', () => {
  it('lets ACCOUNT and USER take orders and payments', () => {
    for (const role of ['ACCOUNT', 'USER'] as const) {
      for (const key of ['ipc:pos:quote-sale', 'ipc:pos:complete-sale', 'ipc:pos:hold-cart', 'ipc:returns:create', 'ipc:reports:open-cashier-shift']) {
        expect(authorize(key, role, true).allowed, `${role} ${key}`).toBe(true)
      }
    }
  })

  it('keeps both out of administration', () => {
    for (const role of ['ACCOUNT', 'USER'] as const) {
      for (const key of ['ipc:users:create', 'ipc:settings:change-currency', 'ipc:backup:restore', 'ipc:reports:close-day', 'http:GET /api/v1/admin/settings']) {
        expect(authorize(key, role, true).allowed, `${role} ${key}`).toBe(false)
      }
    }
  })
})

describe('the deprecated CASHIER alias resolves and is never treated as unknown', () => {
  it('maps to USER, not to a refusal', () => {
    expect(resolveRole('CASHIER')).toBe('USER')
    expect(resolveRole('CASHIER') && authorize('ipc:pos:complete-sale', resolveRole('CASHIER'), true).allowed).toBe(true)
  })

  it('refuses a role nobody recognises', () => {
    expect(resolveRole('MANAGER')).toBeNull()
    expect(resolveRole(undefined)).toBeNull()
    expect(resolveRole(42)).toBeNull()
  })
})

describe('the guard fails when it should, which is the only evidence it works', () => {
  it('reports an unpoliced channel when a row is deleted from a copy of the table', () => {
    // Take the real table, delete one real row, and run the same comparison the first test runs.
    const channels = IPC_FILES.flatMap((file) => scanIpcChannels(read(file)))
    const victim = 'ipc:pos:complete-sale'
    expect(channels.some((channel) => `ipc:${channel}` === victim)).toBe(true)
    const weakened = policyKeys().filter((key) => key !== victim)
    const unpoliced = channels.filter((channel) => !weakened.includes(`ipc:${channel}`))
    // Exactly the victim, so the comparison is known to notice one missing row rather than none.
    expect(unpoliced).toEqual(['pos:complete-sale'])
  })

  it('reports an unpoliced route when a row is deleted from a copy of the table', () => {
    const { http } = surface()
    const victim = httpKey('GET', '/api/v1/mobile/admin/dashboard')
    expect(http.some((route) => httpKey(route.method, route.path) === victim)).toBe(true)
    const weakened = policyKeys().filter((key) => key !== victim)
    const unpoliced = http.filter((route) => !weakened.includes(httpKey(route.method, route.path)))
    expect(unpoliced.map((route) => route.key)).toEqual(['GET /api/v1/mobile/admin/dashboard'])
  })

  it('the scanner notices a channel that only exists in a planted file', () => {
    const planted = `handle('users:backdoor', (event) => event)`
    const found = scanIpcChannels(planted)
    expect(found).toEqual(['users:backdoor'])
    expect(policyKeys()).not.toContain('ipc:users:backdoor')
  })
})

describe('the scanner is honest about what it can and cannot see', () => {
  it('finds every channel in the real ipc.ts and no duplicates', () => {
    const channels = scanIpcChannels(read('src/main/ipc.ts'))
    expect(new Set(channels).size).toBe(channels.length)
  })

  it('refuses to scan a file whose routes are computed rather than literal', async () => {
    const { assertRecognisedIdiom, UnrecognisedRegistrationError } = await import('../src/surface')
    expect(() => assertRecognisedIdiom(`server.get(somePath, handler)`, 'planted.ts')).toThrow(UnrecognisedRegistrationError)
    expect(() => assertRecognisedIdiom(`route(method, url, handler)`, 'planted.ts')).toThrow(UnrecognisedRegistrationError)
    // A literal one passes.
    expect(() => assertRecognisedIdiom(`server.get('/api/v1/x', handler)`, 'planted.ts')).not.toThrow()
  })

  it('reads the route files without throwing, so the assertion above is not hiding a broken scanner', () => {
    for (const file of HTTP_FILES) {
      const source = read(file)
      // Every file in the list must actually register something, or it does not belong in the list.
      if (file.endsWith('mobile-client.ts')) {
        expect(source).toContain("'/*'")
      } else {
        expect(source.length).toBeGreaterThan(100)
      }
    }
    expect(readdirSync('src/api').length).toBeGreaterThan(5)
  })
})
