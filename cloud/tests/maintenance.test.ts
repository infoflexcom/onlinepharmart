import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/database'
import { listBackups, pruneBackups, restoreBackup, takeBackup } from '../src/backups'
import { REMINDER_STAGES, runReminders, scheduleReminders } from '../src/reminders'
import { LicenseService } from '../src/license-service'
import { buildIdentity } from './helpers'
import type { Mailer } from '../src/mailer'

/**
 * The two jobs nobody watches: the nightly backup and the expiry reminder. Both are the kind of thing that
 * silently stops working, so each has a test that fails if it stops.
 */
const DAY = 86_400_000
const directories: string[] = []

function tempDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'infoflex-cloud-'))
  directories.push(path)
  return path
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function buildService(nowRef: { now: number }) {
  const database = openDatabase(':memory:')
  const identity = buildIdentity()
  const service = new LicenseService(database, identity, { now: () => nowRef.now })
  return { database, service }
}

function fakeMailer(result = true): Mailer & { sent: Array<{ to: string; subject: string }> } {
  const sent: Array<{ to: string; subject: string }> = []
  return {
    sent,
    async send(to: string, subject: string) {
      sent.push({ to, subject })
      return result
    },
  }
}

describe('automatic backups', () => {
  it('writes a readable snapshot and prunes the oldest beyond the keep count', () => {
    const directory = tempDirectory()
    const nowRef = { now: Date.parse('2026-06-01T00:00:00.000Z') }
    const { database, service } = buildService(nowRef)
    try {
      service.createCustomer({ businessName: 'Backed Up Ltd' }, 'test')
      for (let day = 0; day < 4; day += 1) {
        nowRef.now += DAY
        takeBackup({ database, directory, keep: 2, now: () => nowRef.now })
      }
      const backups = listBackups(directory)
      expect(backups).toHaveLength(2)
      // Newest first, and every filename is one we recognise.
      expect(backups.map((entry) => entry.name)).toEqual([...backups.map((entry) => entry.name)].sort().reverse())
      expect(backups[0]!.bytes).toBeGreaterThan(0)
    } finally {
      database.close()
    }
  })

  it('keeps an unrelated file in the backup directory', () => {
    const directory = tempDirectory()
    writeFileSync(join(directory, 'notes.txt'), 'the vendor’s own file')
    expect(pruneBackups(directory, 1)).toEqual([])
    expect(readdirSync(directory)).toContain('notes.txt')
  })

  it('restores a snapshot over a live database and refuses a foreign file', () => {
    const directory = tempDirectory()
    const target = join(directory, 'live.sqlite')
    const source = openDatabase(target)
    const identity = buildIdentity()
    const service = new LicenseService(source, identity)
    service.createCustomer({ businessName: 'Restored Ltd' }, 'test')
    const snapshot = takeBackup({ database: source, directory: join(directory, 'snaps'), keep: 3 })
    source.close()

    const restored = restoreBackup({ backupPath: snapshot.path, databasePath: target })
    expect(restored.restored).toBe(target)
    const reopened = openDatabase(target)
    try {
      const names = (reopened.prepare('SELECT business_name FROM customers').all() as Array<{ business_name: string }>)
        .map((row) => row.business_name)
      expect(names).toContain('Restored Ltd')
    } finally {
      reopened.close()
    }

    const bogus = join(directory, 'bogus.sqlite')
    writeFileSync(bogus, 'not a database at all')
    expect(() => restoreBackup({ backupPath: bogus, databasePath: target })).toThrow(/not an Infoflex Cloud database/u)
  })

  it('runs the scheduled job at start-up without throwing', async () => {
    const directory = tempDirectory()
    const { database } = buildService({ now: Date.now() })
    try {
      const lines: string[] = []
      const stop = (await import('../src/backups')).scheduleBackups({
        database, directory, keep: 2, intervalMs: 60_000, log: (message) => lines.push(message),
      })
      stop()
      expect(lines.some((line) => line.startsWith('[backup]'))).toBe(true)
    } finally {
      database.close()
    }
  })
})

describe('expiry reminders', () => {
  it('sends one reminder per stage, and only once', async () => {
    const nowRef = { now: Date.parse('2026-06-01T00:00:00.000Z') }
    const { database, service } = buildService(nowRef)
    try {
      const mailer = fakeMailer()
      const { license } = service.createLicense({
        customer: { businessName: 'Reminder Ltd', email: 'owner@reminder.example', contactName: 'Ada' },
        edition: 'PHARMACY', startsAt: '2026-01-01', endsAt: '2026-06-28', // 27 days out
        maxAdminPhones: 1, mobileLan: true, mobileInternet: false, defaultCurrencyCode: null, lockCurrency: false,
      }, 'test')

      const first = await runReminders({ database, service, mailer, vendorRecipient: null, now: () => nowRef.now })
      expect(first.sent).toHaveLength(1)
      expect(first.sent[0]!.stage).toBe(30)
      expect(mailer.sent[0]!.to).toBe('owner@reminder.example')
      expect(mailer.sent[0]!.subject).toContain('27 days')

      // The same tick again sends nothing: the stage is recorded.
      const again = await runReminders({ database, service, mailer, vendorRecipient: null, now: () => nowRef.now })
      expect(again.sent).toHaveLength(0)

      // Twelve days later the 14-day reminder goes out, and not the 30-day one again.
      nowRef.now += 15 * DAY
      const second = await runReminders({ database, service, mailer, vendorRecipient: null, now: () => nowRef.now })
      expect(second.sent.map((entry) => entry.stage)).toEqual([14])

      // A renewal clears the reminder, so the next term's reminders start fresh.
      service.renewLicense(license.id, { endsAt: '2027-06-28' }, 'test')
      nowRef.now = Date.parse('2027-06-05T00:00:00.000Z')
      const third = await runReminders({ database, service, mailer, vendorRecipient: null, now: () => nowRef.now })
      expect(third.sent.map((entry) => entry.stage)).toEqual([REMINDER_STAGES[0]])
    } finally {
      database.close()
    }
  })

  it('falls back to the vendor inbox when a customer has no e-mail', async () => {
    const nowRef = { now: Date.parse('2026-06-01T00:00:00.000Z') }
    const { database, service } = buildService(nowRef)
    try {
      const mailer = fakeMailer()
      service.createLicense({
        customer: { businessName: 'No Mail Ltd' }, edition: 'PHARMACY', startsAt: '2026-01-01', endsAt: '2026-06-20',
        maxAdminPhones: 1, mobileLan: true, mobileInternet: false, defaultCurrencyCode: null, lockCurrency: false,
      }, 'test')
      const result = await runReminders({ database, service, mailer, vendorRecipient: 'vendor@example.com', now: () => nowRef.now })
      expect(result.sent[0]!.to).toBe('vendor@example.com')
    } finally {
      database.close()
    }
  })

  it('leaves the reminder due when mail is not configured or the send fails', async () => {
    const nowRef = { now: Date.parse('2026-06-01T00:00:00.000Z') }
    const { database, service } = buildService(nowRef)
    try {
      service.createLicense({
        customer: { businessName: 'Queued Ltd', email: 'q@example.com' }, edition: 'PHARMACY',
        startsAt: '2026-01-01', endsAt: '2026-06-10',
        maxAdminPhones: 1, mobileLan: true, mobileInternet: false, defaultCurrencyCode: null, lockCurrency: false,
      }, 'test')
      const none = await runReminders({ database, service, mailer: null, vendorRecipient: null, now: () => nowRef.now })
      expect(none.sent).toHaveLength(0)
      expect(none.skipped).toBeGreaterThan(0)

      const failing = await runReminders({ database, service, mailer: fakeMailer(false), vendorRecipient: null, now: () => nowRef.now })
      expect(failing.failed).toHaveLength(1)
      const stage = database.prepare('SELECT reminder_stage FROM licenses').get() as { reminder_stage: number | null }
      // Nothing was claimed, so tomorrow's tick tries again rather than silently skipping the last week.
      expect(stage.reminder_stage).toBeNull()
    } finally {
      database.close()
    }
  })

  it('keeps the scheduler quiet on a quiet day', async () => {
    const nowRef = { now: Date.parse('2026-06-01T00:00:00.000Z') }
    const { database, service } = buildService(nowRef)
    try {
      const log = vi.fn()
      const stop = scheduleReminders({ database, service, mailer: null, vendorRecipient: null, intervalMs: 60_000, log, now: () => nowRef.now })
      await new Promise((resolve) => setTimeout(resolve, 30))
      stop()
      expect(log).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })
})
