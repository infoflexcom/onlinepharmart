import type { MobileKeepRunningSettings } from '../shared/mobile/types'

/** The slice of Electron's app we need; injected so the decision logic is testable without Electron. */
export interface LoginItemSurface {
  setLoginItemSettings(settings: { openAtLogin: boolean; args?: string[]; path?: string }): void
  getLoginItemSettings(settings?: { args?: string[] }): { openAtLogin: boolean }
}

export interface PowerSaveSurface {
  start(type: 'prevent-app-suspension' | 'prevent-display-sleep', description: string): number
  stop(id: number): void
}

export interface TraySurface {
  destroy(): void
}

/**
 * Owns the "keep running" behaviour. The rules are simple and deliberate:
 *
 * - Closing the main window hides it to the tray while mobile access is on, so the Admin's phone keeps working.
 * - Optional start-with-Windows uses the normal login-item mechanism, never a scheduled task or registry edit.
 * - While a phone is connected the PC is kept awake; the blocker is released the moment it disconnects, and the
 *   phone is warned before the PC sleeps rather than being dropped without explanation.
 */
export class KeepRunningController {
  private blockerId: number | null = null
  private tray: TraySurface | null = null
  private settings: MobileKeepRunningSettings = { keepRunning: true, startWithWindows: true, preventSleep: true }

  constructor(
    private readonly app: LoginItemSurface,
    private readonly power: PowerSaveSurface | null = null,
  ) {}

  getSettings(): MobileKeepRunningSettings {
    let startWithWindows = this.settings.startWithWindows
    try {
      startWithWindows = this.app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin
    } catch {
      // Keep the stored preference if Windows will not answer.
    }
    return { ...this.settings, startWithWindows }
  }

  apply(input: MobileKeepRunningSettings): MobileKeepRunningSettings {
    this.settings = { ...input }
    this.setStartWithWindows(input.startWithWindows)
    if (!input.preventSleep) this.releaseSleepBlocker()
    return this.getSettings()
  }

  setStartWithWindows(enabled: boolean): void {
    try {
      this.app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] })
      this.settings.startWithWindows = enabled
    } catch {
      this.settings.startWithWindows = false
    }
  }

  /** Called when a phone connects. Idempotent: repeated calls never stack blockers. */
  holdSleep(activePhoneCount: number): void {
    if (!this.settings.preventSleep || !this.power) return
    if (activePhoneCount <= 0) {
      this.releaseSleepBlocker()
      return
    }
    if (this.blockerId !== null) return
    try {
      this.blockerId = this.power.start(
        'prevent-app-suspension',
        'Infoflex keeps the shop computer awake while the Admin phone is connected.',
      )
    } catch {
      this.blockerId = null
    }
  }

  releaseSleepBlocker(): void {
    if (this.blockerId === null || !this.power) {
      this.blockerId = null
      return
    }
    try {
      this.power.stop(this.blockerId)
    } catch {
      // Nothing useful to do; the OS releases it when the app exits.
    }
    this.blockerId = null
  }

  /** True when closing the window must hide it instead of quitting. */
  shouldHideToTray(mobileAccessRunning: boolean): boolean {
    return mobileAccessRunning && this.settings.keepRunning
  }

  attachTray(tray: TraySurface): void {
    this.tray?.destroy()
    this.tray = tray
  }

  destroyTray(): void {
    this.tray?.destroy()
    this.tray = null
  }

  /** Called on quit so the PC is never left permanently awake by a crash-free shutdown. */
  dispose(): void {
    this.releaseSleepBlocker()
    this.destroyTray()
  }
}

/** Shown on the phone and the desktop before Windows suspends the machine. */
export const SLEEP_WARNING = 'The shop computer is about to sleep, so the phone will lose its connection. Keep the computer plugged in and awake, or set "Stop the computer sleeping" in Mobile Access.'
