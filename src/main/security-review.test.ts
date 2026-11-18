import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { registerDesktopIpc } from './ipc'
import type { DesktopHostController } from './desktop-host-controller'

const ROOT = join(__dirname, '../..')
const SRC = join(ROOT, 'src')
const MOBILE_SRC = join(ROOT, 'mobile/src')

function read(path: string): string {
  return readFileSync(path, 'utf8')
}

function walk(directory: string, filter: (path: string) => boolean): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry)
    if (statSync(full).isDirectory()) {
      found.push(...walk(full, filter))
    } else if (filter(full)) {
      found.push(full)
    }
  }
  return found
}

const productionFiles = (directory: string): string[] =>
  walk(directory, (path) => path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.includes('/node_modules/'))

/** Every `host.method(...)` the IPC layer exposes, in registration order. */
function ipcHandlers(): Array<{ channel: string; method: string }> {
  const source = read(join(SRC, 'main/ipc.ts'))
  const handlers: Array<{ channel: string; method: string }> = []
  const pattern = /handle\('([^']+)',\s*(?:async\s*)?\([^)]*\)\s*=>\s*(?:\{[\s\S]*?\b)?host\.([a-zA-Z]+)\(/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) handlers.push({ channel: match[1], method: match[2] })
  // Multi-statement arrow bodies (restore) still call host.<method> inside the braces.
  for (const block of source.matchAll(/handle\('([^']+)',[^)]*\)\s*=>\s*\{([\s\S]*?)\n  \}\)/g)) {
    const call = /\bhost\.([a-zA-Z]+)\(/.exec(block[2])
    if (call && !handlers.some((handler) => handler.channel === block[1])) {
      handlers.push({ channel: block[1], method: call[1] })
    }
  }
  return handlers
}

function methodBody(controllerSource: string, method: string): string | null {
  const start = controllerSource.search(new RegExp(`\\n  (?:async )?${method}\\(`))
  if (start === -1) return null
  // The opening brace is the last one on the declaration line, so a return type like `{ page: AppPage }`
  // is not mistaken for the body.
  const declarationEnd = controllerSource.indexOf('\n', start + 1)
  const declaration = controllerSource.slice(start, declarationEnd)
  const open = declaration.lastIndexOf('{')
  if (open === -1) return null
  const absoluteOpen = start + open
  let depth = 0
  for (let index = absoluteOpen; index < controllerSource.length; index += 1) {
    if (controllerSource[index] === '{') depth += 1
    else if (controllerSource[index] === '}') {
      depth -= 1
      if (depth === 0) return controllerSource.slice(absoluteOpen, index + 1)
    }
  }
  return null
}

/**
 * Every host controller guard. A method must call at least one of these before doing work; the list is
 * deliberately explicit so a new unguarded helper cannot slip through review unnoticed.
 */
const GUARD = /\brequires?[A-Z][a-zA-Z]*\(|\bassertLicenseUsable\(|\bisLicenseUsable\(/

/** Handlers that are deliberately open before sign-in, each with the reason it is safe. */
const PUBLIC_BY_DESIGN: Record<string, string> = {
  getBootstrap: 'returns only what an unauthenticated first-run screen needs, gated by licence state',
  getLicenseStatus: 'read-only licence summary; needed by the activation screen',
  importVendorPolicyFile: 'vendor policy import; requires the vendor master password hash to be accepted',
  activateOnline: 'licence activation; the licence server performs authentication',
  importLicenseFile: 'licence file import; the signed token is verified cryptographically',
  activateOnsite: 'on-site activation; requires the vendor master password',
  checkInLicense: 'licence check-in; uses the stored signed token, no user data',
  getCurrentUser: 'returns null when the session or licence is unusable',
  touchSession: 'returns false when the session or licence is unusable',
  logout: 'only ends the caller’s own session',
}

describe('security review: IPC permissions', () => {
  const controller = read(join(SRC, 'main/desktop-host-controller.ts'))
  const handlers = ipcHandlers()

  it('finds the whole IPC surface so nothing is reviewed by accident', () => {
    expect(handlers.length).toBeGreaterThan(70)
    expect(new Set(handlers.map((handler) => handler.channel)).size).toBe(handlers.length)
  })

  it('guards every host method an IPC channel can reach', () => {
    const unguarded: string[] = []
    for (const { channel, method } of handlers) {
      if (PUBLIC_BY_DESIGN[method]) continue
      const body = methodBody(controller, method)
      if (!body) {
        unguarded.push(`${channel} → ${method} (missing method)`)
        continue
      }
      if (!GUARD.test(body)) unguarded.push(`${channel} → ${method}`)
    }
    expect(unguarded).toEqual([])
  })

  it('keeps the deliberately public handlers from returning customer or payment records', () => {
    for (const method of Object.keys(PUBLIC_BY_DESIGN)) {
      const body = methodBody(controller, method)
      expect(body, `${method} should still exist`).not.toBeNull()
      // First-run bootstrap may read the store's own profile; nothing public may return sales data.
      expect(body, `${method} must not return sales, customers, or users`).not.toMatch(/listRecentPosSales|listPosCustomers|listUsers|getAccountingReport/)
    }
  })

  it('rejects IPC calls from sub-frames before the handler runs', () => {
    const source = read(join(SRC, 'main/ipc.ts'))
    expect(source).toMatch(/senderFrame\s*&&\s*event\.senderFrame\s*!==\s*event\.sender\.mainFrame/)
    expect(source).toMatch(/only available to the main application window/)
  })

  it('registers exactly the channels the preload bridge invokes', () => {
    const ipc = read(join(SRC, 'main/ipc.ts'))
    const preload = read(join(SRC, 'preload/index.ts'))
    const registered = new Set([...ipc.matchAll(/handle\('([^']+)'/g)].map((match) => match[1]))
    const invoked = new Set([...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((match) => match[1]))
    const missing = [...invoked].filter((channel) => !registered.has(channel))
    const unused = [...registered].filter((channel) => !invoked.has(channel))
    expect(missing).toEqual([])
    expect(unused).toEqual([])
  })

  it('exposes the settings and backup channels to the Admin only', () => {
    for (const method of ['updateStoreDetails', 'updateDisplaySettings', 'changeCurrency', 'updateIdleTimeout', 'updateReturnWindowDays', 'updateOperationalSettings', 'getBackupStatus', 'createManualBackup', 'listBackupFiles', 'restoreBackup']) {
      const body = methodBody(controller, method)
      expect(body, `${method} must exist`).not.toBeNull()
      expect(body, `${method} must call requireAdmin`).toMatch(/this\.requireAdmin\(senderId\)/)
    }
  })
})

describe('security review: API endpoints', () => {
  const server = read(join(SRC, 'api/server.ts'))

  it('protects every non-health route with an authorising pre-handler', () => {
    const routes = [...server.matchAll(/server\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)].map((match) => ({ method: match[1], path: match[2] }))
    expect(routes.length).toBeGreaterThanOrEqual(8)
    for (const route of routes) {
      // Both of these are deliberately public: health is a liveness probe, and /licence is the one message a
      // phone is allowed to see when the shop's licence has expired. Neither reads shop data.
      if (route.path === '/api/v1/health' || route.path === '/api/v1/licence') continue
      const index = server.indexOf(`'${route.path}'`)
      const nearby = server.slice(index, index + 260)
      expect(nearby, `${route.method.toUpperCase()} ${route.path} must have a pre-handler`).toMatch(/preHandler:\s*(authorizeAdmin|authorizePairing|authorizeMobileTransport)/)
    }
  })

  it('answers unauthenticated callers generically and rate-limits repeated failures', () => {
    expect(server).toMatch(/GENERIC_DENIAL/)
    expect(server).toMatch(/FAILURE_LIMIT/)
    expect(server).toMatch(/BLOCK_DURATION_MS/)
    expect(server).toMatch(/code\(429\)/)
  })

  it('never echoes raw error text or stack traces to a mobile client', () => {
    expect(server).toMatch(/function safeErrorMessage/)
    expect(server).not.toMatch(/reply\.send\(error\)/)
    expect(server).not.toMatch(/stack:/)
    // Every failure reply is built from the sanitised message helper.
    const replies = [...server.matchAll(/reply\.code\(\d{3}\)\.send\(([^)]*)\)/g)].map((match) => match[1].trim())
    expect(replies.length).toBeGreaterThan(5)
    for (const reply of replies) {
      // An empty body (204) leaks nothing; every other reply must be a fixed message.
      if (reply === '') continue
      expect(reply, `reply payload must be a fixed message: ${reply}`).toMatch(/GENERIC_DENIAL|safeErrorMessage\(error\)|message/i)
    }
  })
})

describe('security review: data handling', () => {
  const files = [...productionFiles(SRC), ...productionFiles(MOBILE_SRC)]

  it('builds every SQL statement with bound parameters, never string interpolation of values', () => {
    const offenders: string[] = []
    for (const file of files) {
      const source = read(file)
      for (const match of source.matchAll(/(?:prepare|exec)\(\s*`([^`]*)`/g)) {
        // Only identifiers from our own constants may be interpolated; never a `?`-bound value.
        for (const interpolation of match[1].matchAll(/\$\{([^}]*)\}/g)) {
          const expression = interpolation[1].trim()
          // Only trusted identifiers and schema-level constants may be interpolated; never a bound value.
          const allowlisted = /^(MIGRATION_TABLE|USER_SELECT|SALE_HEADER_SELECT|DEFAULT_CURRENCY_CODE|table|TABLE|.*_SELECT|.*_TABLE|name)$/.test(expression)
            || /^(columns|assignments|placeholders)$/.test(expression)
            || /isSafeIdentifier/.test(expression)
          if (!allowlisted) offenders.push(`${file}: ${expression}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('never writes a master password, token, or password hash to the console', () => {
    const offenders: string[] = []
    for (const file of files) {
      const source = read(file)
      for (const match of source.matchAll(/console\.(?:log|warn|error|info|debug)\(([\s\S]{0,400}?)\)\s*$/gm)) {
        if (/password|masterPassword|token|secret|hash/i.test(match[1])) offenders.push(`${file}: ${match[1].slice(0, 80)}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('keeps the master password stored only as a salted hash', () => {
    const files = productionFiles(SRC)
    const hashSource = files.map((file) => read(file)).join('\n')
    // The on-site activation password is verified through a salted scrypt hash, generated with a random salt.
    expect(hashSource).toMatch(/createMasterPasswordHash/)
    // PBKDF2-SHA256 with a random per-hash salt: a salted hash, never the password itself.
    expect(hashSource).toMatch(/pbkdf2Sync\(/)
    expect(hashSource).toMatch(/randomBytes\(16\)/)
    expect(hashSource).toMatch(/MASTER_PASSWORD_HASH_ITERATIONS/)
    // No code path may write the entered password itself into the licence tables.
    expect(hashSource).not.toMatch(/INSERT INTO license_vendor_config[\s\S]{0,400}masterPassword\b/)
    const mobile = productionFiles(MOBILE_SRC).map((file) => read(file)).join('\n')
    expect(mobile).not.toMatch(/masterPassword/)
  })

  it('validates input at the service boundary for the new settings and backup entry points', () => {
    const validation = read(join(SRC, 'shared/shop/validation.ts'))
    expect(validation).toMatch(/normalizeOperationalSettings/)
    expect(validation).toMatch(/normalizeShopProfile/)
    const backup = read(join(SRC, 'services/backup-service.ts'))
    expect(backup).toMatch(/isSafeIdentifier/)
    expect(backup).toMatch(/safeFileName/)
    expect(backup).toMatch(/MAX_RESTORE_BYTES/)
  })
})

describe('security review: the IPC registrar itself', () => {
  it('refuses a sub-frame sender before any handler runs', async () => {
    const channels = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const ipcMain = { handle: (channel: string, listener: (event: never, ...args: never[]) => unknown) => { channels.set(channel, listener as never) } }
    const host = { getLicenseStatus: () => ({ status: 'active' }) } as unknown as DesktopHostController
    registerDesktopIpc(ipcMain as never, host)

    const listener = channels.get('license:get-status')!
    expect(listener).toBeTypeOf('function')
    const mainFrame = { id: 1 }
    const frameEvent = { sender: { id: 7, mainFrame }, senderFrame: { id: 2 } }
    expect(() => listener(frameEvent)).toThrow(/main application window/)
    const goodEvent = { sender: { id: 7, mainFrame }, senderFrame: mainFrame }
    expect(listener(goodEvent)).toEqual({ status: 'active' })
  })
})
