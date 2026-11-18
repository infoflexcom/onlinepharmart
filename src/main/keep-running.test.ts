import { describe, expect, it, vi } from 'vitest'
import { KeepRunningController, SLEEP_WARNING } from './keep-running'
import { friendlyHostName } from '../shared/mobile/host-name'
import { createWindowsFirewallProbe, firewallMessage } from './mobile-firewall'

function surfaces() {
  const loginItems: Array<{ openAtLogin: boolean; args?: string[] }> = []
  const started: Array<{ type: string; description: string }> = []
  const stopped: number[] = []
  let nextId = 1
  return {
    loginItems, started, stopped,
    app: {
      setLoginItemSettings: (settings: { openAtLogin: boolean; args?: string[] }) => { loginItems.push(settings) },
      getLoginItemSettings: () => ({ openAtLogin: loginItems.at(-1)?.openAtLogin ?? true }),
    },
    power: {
      start: (type: 'prevent-app-suspension' | 'prevent-display-sleep', description: string) => {
        started.push({ type, description })
        return nextId++
      },
      stop: (id: number) => { stopped.push(id) },
    },
  }
}

describe('keep running from the tray', () => {
  it('hides to the tray on close only while mobile access is on', () => {
    const { app, power } = surfaces()
    const controller = new KeepRunningController(app, power)
    expect(controller.shouldHideToTray(true)).toBe(true)
    expect(controller.shouldHideToTray(false)).toBe(false)
    controller.apply({ keepRunning: false, startWithWindows: true, preventSleep: true })
    expect(controller.shouldHideToTray(true)).toBe(false)
  })

  it('registers start-with-Windows through the normal login item, never a registry edit', () => {
    const { app, loginItems } = surfaces()
    const controller = new KeepRunningController(app)
    controller.apply({ keepRunning: true, startWithWindows: true, preventSleep: true })
    expect(loginItems.at(-1)).toEqual({ openAtLogin: true, args: ['--hidden'] })
    controller.apply({ keepRunning: true, startWithWindows: false, preventSleep: true })
    expect(loginItems.at(-1)?.openAtLogin).toBe(false)
    expect(controller.getSettings().startWithWindows).toBe(false)
  })

  it('keeps the computer awake only while a phone is connected, and releases it straight after', () => {
    const { app, power, started, stopped } = surfaces()
    const controller = new KeepRunningController(app, power)
    controller.apply({ keepRunning: true, startWithWindows: true, preventSleep: true })

    controller.holdSleep(1)
    expect(started).toHaveLength(1)
    expect(started[0]!.type).toBe('prevent-app-suspension')
    // Repeated heartbeats must not stack blockers.
    controller.holdSleep(1)
    controller.holdSleep(3)
    expect(started).toHaveLength(1)

    controller.holdSleep(0)
    expect(stopped).toEqual([1])
    // And it can be re-acquired.
    controller.holdSleep(1)
    expect(started).toHaveLength(2)
  })

  it('never starts a sleep blocker when the Admin has turned prevention off', () => {
    const { app, power, started } = surfaces()
    const controller = new KeepRunningController(app, power)
    controller.apply({ keepRunning: true, startWithWindows: true, preventSleep: false })
    controller.holdSleep(2)
    expect(started).toHaveLength(0)
  })

  it('releases the blocker and the tray on quit', () => {
    const { app, power, stopped } = surfaces()
    const controller = new KeepRunningController(app, power)
    controller.holdSleep(1)
    const destroy = vi.fn()
    controller.attachTray({ destroy })
    controller.dispose()
    expect(stopped).toEqual([1])
    expect(destroy).toHaveBeenCalled()
    // A second dispose is harmless.
    controller.dispose()
  })

  it('tells a shop owner in plain words what happens when the computer sleeps', () => {
    expect(SLEEP_WARNING).toMatch(/about to sleep/u)
    expect(SLEEP_WARNING).toMatch(/Stop the computer sleeping/u)
  })
})

describe('friendly host name', () => {
  it('turns a Windows computer name into a readable label', () => {
    expect(friendlyHostName('TUNDE-LAPTOP')).toBe('infoflex-tunde-laptop')
    expect(friendlyHostName('DESKTOP_4F2K9P')).toBe('infoflex-desktop-4f2k9p')
    expect(friendlyHostName('  ')).toBe('infoflex-pharmacy')
    expect(friendlyHostName('')).toBe('infoflex-pharmacy')
  })

  it('strips accents and collapses separators', () => {
    expect(friendlyHostName('Café--Pharmàcie')).toBe('infoflex-cafe-pharmacie')
    expect(friendlyHostName('a'.repeat(80))).toBe(`infoflex-${'a'.repeat(40)}`)
  })
})

describe('Windows Firewall detection and repair', () => {
  it('reports a missing rule as blocked, in plain language', async () => {
    const probe = createWindowsFirewallProbe({
      platform: 'win32',
      execute: async () => ({ stdout: 'MISSING', stderr: '' }),
    })
    const result = await probe.inspect(43871)
    expect(result.blocked).toBe(true)
    expect(result.message).toBe(firewallMessage(43871))
    expect(result.message).toMatch(/Repair firewall rule/u)
  })

  it('accepts a rule that allows the port on the private profile only', async () => {
    const probe = createWindowsFirewallProbe({
      platform: 'win32',
      execute: async () => ({ stdout: 'OK|Private|43871|Private', stderr: '' }),
    })
    expect(await probe.inspect(43871)).toEqual({ blocked: false, message: null })
  })

  it('treats a rule limited to the public profile as blocking, because the shop LAN is private', async () => {
    const probe = createWindowsFirewallProbe({
      platform: 'win32',
      execute: async () => ({ stdout: 'OK|Public|43871|Public', stderr: '' }),
    })
    expect((await probe.inspect(43871)).blocked).toBe(true)
  })

  it('creates a private-profile-only rule when repairing, and verifies it afterwards', async () => {
    const commands: string[] = []
    const probe = createWindowsFirewallProbe({
      platform: 'win32',
      execute: async (_file, args) => {
        const script = args.at(-1) ?? ''
        commands.push(script)
        if (script.includes('New-NetFirewallRule')) return { stdout: 'REPAIRED', stderr: '' }
        return { stdout: 'OK|Private|43871|Private', stderr: '' }
      },
    })
    const result = await probe.repair(43871)
    expect(result.blocked).toBe(false)
    expect(commands.some((script) => script.includes('-Profile Private'))).toBe(true)
    // The rule must never be opened to the public profile.
    expect(commands.every((script) => !script.includes('-Profile Any') && !script.includes('-Profile Public'))).toBe(true)
    expect(commands.some((script) => script.includes('New-NetFirewallRule'))).toBe(true)
  })

  it('explains a failed repair instead of pretending it worked', async () => {
    const probe = createWindowsFirewallProbe({
      platform: 'win32',
      execute: async (_file, args) => {
        if ((args.at(-1) ?? '').includes('New-NetFirewallRule')) throw new Error('Access is denied')
        return { stdout: 'MISSING', stderr: '' }
      },
    })
    await expect(probe.repair(43871)).rejects.toThrow(/could not be repaired.*Access is denied/u)
  })

  it('does not claim a blocked port off Windows, and refuses to repair there', async () => {
    const probe = createWindowsFirewallProbe({ platform: 'linux' })
    expect(await probe.inspect(43871)).toEqual({ blocked: false, message: null })
    expect((await probe.repair(43871)).blocked).toBe(true)
  })

  it('does not claim a blocked port when the firewall query itself fails', async () => {
    const probe = createWindowsFirewallProbe({
      platform: 'win32',
      execute: async () => { throw new Error('PowerShell is unavailable') },
    })
    expect(await probe.inspect(43871)).toEqual({ blocked: false, message: null })
  })
})
