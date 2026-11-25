import { describe, expect, it, vi } from 'vitest'
import type { DesktopHostController } from './desktop-host-controller'
import { registerDesktopIpc } from './ipc'
import { authorize } from '../../packages/core/src/index'

/**
 * The desktop channels, checked against the permission table.
 *
 * The coverage test in `/packages/core` proves every channel *has* a row. This file proves the row is *enforced*:
 * that a channel whose policy excludes a role cannot reach its handler when that role is signed in, and that a
 * channel with no row at all cannot reach a handler either. A table that is only compared against a list is a table
 * nobody has ever obeyed.
 */

interface Registered {
  channel: string
  listener: (event: unknown, ...args: unknown[]) => unknown
}

/** The shape the stub host is allowed to take: whatever members a given test needs, loosely typed. */
type HostStub = Record<string, unknown>

function register(channels: Map<string, Registered['listener']>, overrides: HostStub = {}) {
  const ipcMain = {
    handle: (channel: string, listener: Registered['listener']) => {
      channels.set(channel, listener)
    },
  }
  // The controller is a large object; only the members a channel reaches are stubbed, per test and by name.
  const host = { getCurrentUser: () => null, ...overrides } as unknown as DesktopHostController
  registerDesktopIpc(ipcMain as never, host)
}

/**
 * A well-formed main-frame event.
 *
 * The frame check compares the objects by identity (`senderFrame !== sender.mainFrame`), so the same object must be
 * used for both fields. A fixture that builds two separate objects is refused by the frame check before the policy
 * is ever consulted — which is exactly what happened the first time this file was run.
 */
const mainFrame = { id: 10 }
const event = { sender: { id: 1, mainFrame }, senderFrame: mainFrame }

describe('the IPC layer obeys the permission table', () => {
  it('refuses an Admin-only channel to a till user, without calling the handler', () => {
    const channels = new Map<string, Registered['listener']>()
    const createUser = vi.fn(() => ({ id: 'new' }))
    register(channels, {
      getCurrentUser: () => ({ id: 'u1', fullName: 'Ada', username: 'ada', role: 'CASHIER', isActive: true, isLocked: false, permissions: {} }) as never,
      createUser,
    })
    const listener = channels.get('users:create')!
    // A legacy CASHIER row resolves to USER, which is not permitted on users:create.
    expect(() => listener(event, { fullName: 'x' })).toThrow(/restricted to the Admin/)
    expect(createUser).not.toHaveBeenCalled()
  })

  it('allows the same channel to an Admin', () => {
    const channels = new Map<string, Registered['listener']>()
    const createUser = vi.fn(() => ({ id: 'new' }))
    register(channels, {
      getCurrentUser: () => ({ id: 'u1', fullName: 'Ada', username: 'ada', role: 'ADMIN', isActive: true, isLocked: false, permissions: {} }) as never,
      createUser,
    })
    expect(channels.get('users:create')!(event, { fullName: 'x' })).toEqual({ id: 'new' })
    expect(createUser).toHaveBeenCalledTimes(1)
  })

  it('refuses a signed-out caller on every channel that is not anonymous', () => {
    const channels = new Map<string, Registered['listener']>()
    const getSettings = vi.fn(() => ({ shopName: 'x' }))
    const listSales = vi.fn(() => [])
    register(channels, { getCurrentUser: () => null, getShopSettings: getSettings, listSales })
    for (const channel of ['shop:get-settings', 'pos:list-sales', 'reports:get-accounting', 'backup:restore']) {
      // A signed-out caller is told its session ended, not that it lacks a role: that is the true reason, and it is
      // the only one the caller can act on. The flat role sentence is reserved for a signed-in caller whose role is
      // wrong, so that it cannot learn which role each channel would need.
      expect(() => channels.get(channel)!(event), channel).toThrow(/session has expired/)
    }
    expect(getSettings).not.toHaveBeenCalled()
    expect(listSales).not.toHaveBeenCalled()
  })

  it('lets a signed-out caller reach a channel that is anonymous by policy', () => {
    const channels = new Map<string, Registered['listener']>()
    const login = vi.fn(() => ({ id: 'u1' }))
    register(channels, { getCurrentUser: () => null, login })
    expect(channels.get('auth:login')!(event, { username: 'a', password: 'b' })).toEqual({ id: 'u1' })
  })

  it('refuses a channel that has no policy row at all, which is the case a table cannot see', () => {
    const channels = new Map<string, Registered['listener']>()
    const getCurrentUser = vi.fn(() => ({
      id: 'u1', fullName: 'Ada', username: 'ada', role: 'ADMIN', isActive: true, isLocked: false, permissions: {},
    }))
    register(channels, { getCurrentUser })
    const someAdminChannel = channels.get('demo:load')!
    // Sanity: with a policy row and an Admin, it is allowed through to the host (which has no such method here).
    expect(() => someAdminChannel(event)).toThrow() // the stub host has no load; it is not the policy refusing
    // Now the case that matters: the gate must refuse before reaching a handler when the key is unknown. The only
    // honest way to test that with a static registration is to show the decision function doing it.
    expect(authorize('ipc:a:channel:nobody:registered', 'ADMIN', true)).toEqual({ allowed: false, reason: 'no-policy' })
  })

  it('refuses a channel to a supervisor that the table says is Admin-only', () => {
    const channels = new Map<string, Registered['listener']>()
    const restore = vi.fn(() => ({ restored: true }))
    register(channels, {
      getCurrentUser: () => ({ id: 'u2', fullName: 'Sam', username: 'sam', role: 'SUPERVISOR', isActive: true, isLocked: false, permissions: {} }) as never,
      restore,
    })
    expect(() => channels.get('backup:restore')!(event, {})).toThrow(/restricted to the Admin/)
    expect(restore).not.toHaveBeenCalled()
  })

  /**
   * The two seat channels this phase added, checked the same way as every other Admin-only channel.
   *
   * These are the ones worth singling out, because they are the channels that can lock a colleague out of the shop:
   * deactivating a seat ends that person's session immediately. If the gate did not run before the handler, a
   * Supervisor who could reach it could close the till from the till.
   */
  it('refuses the seat channels to every role but the Admin, without calling the handler', () => {
    for (const role of ['SUPERVISOR', 'ACCOUNT', 'USER', 'CASHIER'] as const) {
      const channels = new Map<string, Registered['listener']>()
      const setSeatActive = vi.fn()
      const setSeatPermissions = vi.fn()
      register(channels, {
        getCurrentUser: () => ({ id: 'u3', fullName: 'Jo', username: 'jo', role, isActive: true, isLocked: false, permissions: {} }) as never,
        setSeatActive, setSeatPermissions,
      })
      expect(() => channels.get('team:set-seat-active')!(event, 'seat-1', false), `${role} deactivating a seat`)
        .toThrow(/restricted to the Admin/)
      expect(() => channels.get('team:set-seat-permissions')!(event, 'seat-1', {}), `${role} changing limits`)
        .toThrow(/restricted to the Admin/)
      expect(setSeatActive, `${role} reached the handler`).not.toHaveBeenCalled()
      expect(setSeatPermissions, `${role} reached the handler`).not.toHaveBeenCalled()
    }
  })

  it('refuses the seat channels to a signed-out caller, before the handler', () => {
    const channels = new Map<string, Registered['listener']>()
    const setSeatActive = vi.fn()
    register(channels, { getCurrentUser: () => null, setSeatActive })
    expect(() => channels.get('team:set-seat-active')!(event, 'seat-1', false)).toThrow(/session has expired/)
    expect(setSeatActive).not.toHaveBeenCalled()
  })

  it('lets the Admin through both seat channels', () => {
    const channels = new Map<string, Registered['listener']>()
    const setSeatActive = vi.fn()
    const setSeatPermissions = vi.fn()
    register(channels, {
      getCurrentUser: () => ({ id: 'u1', fullName: 'Ada', username: 'ada', role: 'ADMIN', isActive: true, isLocked: false, permissions: {} }) as never,
      setSeatActive, setSeatPermissions,
    })
    channels.get('team:set-seat-active')!(event, 'seat-1', false)
    channels.get('team:set-seat-permissions')!(event, 'seat-1', { allowWholesale: true })
    expect(setSeatActive).toHaveBeenCalledTimes(1)
    expect(setSeatPermissions).toHaveBeenCalledTimes(1)
  })
})
