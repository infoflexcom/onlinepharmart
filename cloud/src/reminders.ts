import type Database from 'better-sqlite3'
import type { LicenseService } from './license-service'
import type { Mailer } from './mailer'

/**
 * Expiry reminders.
 *
 * A licence that quietly lapses locks a shop out of its own till, so the vendor should hear about it while
 * there is still time to invoice and renew. Three points are useful: 30 days (start the conversation),
 * 14 days (chase it) and 7 days (last week). Each is sent once per licence per term.
 *
 * "Once" is recorded by stamping `licenses.reminder_stage`, so a restart or a scheduler tick that runs twice
 * cannot spam a customer. The dashboard shows the same three buckets, so the vendor sees what the mail says.
 */
export interface ReminderOptions {
  database: Database.Database
  service: LicenseService
  mailer: Mailer | null
  /** The vendor's own inbox; when absent, reminders are shown in the portal only. */
  vendorRecipient: string | null
  fromName?: string
  now?: () => number
  log?: (message: string) => void
}

export const REMINDER_STAGES = [30, 14, 7] as const
export type ReminderStage = (typeof REMINDER_STAGES)[number]

export interface ReminderResult {
  sent: Array<{ licenseId: string; stage: ReminderStage; to: string }>
  skipped: number
  failed: Array<{ licenseId: string; stage: ReminderStage; reason: string }>
}

/**
 * Sends every reminder that is due. Safe to call repeatedly: the stage is advanced before the next tick.
 */
export async function runReminders(options: ReminderOptions): Promise<ReminderResult> {
  const result: ReminderResult = { sent: [], skipped: 0, failed: [] }
  const stageColumn = options.database.prepare(`SELECT 1 FROM pragma_table_info('licenses') WHERE name = 'reminder_stage'`).get()
  if (!stageColumn) {
    // The column arrives with the schema; a database older than it simply never sends reminders.
    return result
  }
  const log = options.log ?? ((message: string) => process.stdout.write(`${message}\n`))
  const rows = options.database.prepare(`
    SELECT l.id AS id, l.ends_at AS ends_at, l.reminder_stage AS stage,
           c.business_name AS business_name, c.email AS email, c.contact_name AS contact_name
    FROM licenses l JOIN customers c ON c.id = l.customer_id
    WHERE l.status = 'active' AND l.ends_at > ? AND l.ends_at <= ?
  `).all(new Date((options.now ?? Date.now)()).toISOString(), new Date((options.now ?? Date.now)() + 31 * 86_400_000).toISOString()) as Array<{
    id: string; ends_at: string; stage: number | null; business_name: string; email: string | null; contact_name: string | null
  }>

  for (const row of rows) {
    const days = Math.ceil((Date.parse(row.ends_at) - (options.now ?? Date.now)()) / 86_400_000)
    // The tightest stage whose window has been entered: at 12 days out the 14-day reminder is due, not the
    // 30-day one, so a licence first seen late does not arrive as a stale warning.
    const stage = [...REMINDER_STAGES].reverse().find((candidate) => days <= candidate)
    if (!stage) continue
    // A licence already reminded at a tighter stage never repeats the looser ones.
    if (row.stage !== null && row.stage <= stage) {
      result.skipped += 1
      continue
    }
    const recipient = row.email && row.email.includes('@') ? row.email : options.vendorRecipient
    if (!recipient || !options.mailer) {
      // Without mail configured the dashboard is the reminder channel; advance nothing so it stays visible.
      result.skipped += 1
      continue
    }
    const subject = `${row.business_name}: your Infoflex licence ends in ${days} day${days === 1 ? '' : 's'}`
    const body = [
      `Hello ${row.contact_name || row.business_name},`,
      '',
      `Your Infoflex licence ends on ${row.ends_at.slice(0, 10)} — ${days} day${days === 1 ? '' : 's'} from now.`,
      options.fromName ? `Contact ${options.fromName} to renew.` : 'Contact your supplier to renew.',
      '',
      'If the term is not extended, the till will stop accepting sales after the end date.',
    ].join('\n')
    const ok = await options.mailer.send(recipient, subject, body)
    if (ok) {
      options.database.prepare('UPDATE licenses SET reminder_stage = ? WHERE id = ?').run(stage, row.id)
      options.service.audit('system', 'license.reminder_sent', row.id, { stage, to: recipient })
      result.sent.push({ licenseId: row.id, stage, to: recipient })
    } else {
      log(`[reminders] could not send the ${stage}-day reminder for ${row.id}`)
      result.failed.push({ licenseId: row.id, stage, reason: 'The mail server did not accept the message.' })
    }
  }
  return result
}

/** Runs reminders once a day, and immediately at start-up so a restart does not delay a due reminder. */
export function scheduleReminders(options: ReminderOptions & { intervalMs?: number }): () => void {
  const run = () => {
    void runReminders(options).catch((error: unknown) => {
      const log = options.log ?? ((message: string) => process.stdout.write(`${message}\n`))
      log(`[reminders] failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  run()
  const timer = setInterval(run, options.intervalMs ?? 24 * 60 * 60 * 1_000)
  timer.unref()
  return () => clearInterval(timer)
}
