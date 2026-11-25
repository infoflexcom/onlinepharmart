import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { InfoflexBridge } from '@shared/bridge'
import type { PublicUser } from '@shared/auth/types'

/**
 * Users and Seats — the Admin's screen for who may sign in.
 *
 * Two ideas from the brief shape everything here:
 *
 * 1. **A seat is not an account until it has a password.** First-run setup creates seats in a "needs password" state.
 *    They are visible, nameable and countable, but nobody can sign in as one. The screen shows that state plainly
 *    rather than hiding the row until it is usable, because a seat the Admin cannot see is a seat nobody will prepare.
 * 2. **Only the Admin creates or changes these.** There is no self sign-up and no password recovery anywhere in the
 *    product, so this screen is the only route to a working login — and the server refuses every action on it to any
 *    other role, whatever the interface shows.
 *
 * The counters are read from the server (`getTeamSnapshot`) rather than computed here. A number the screen worked out
 * for itself could disagree with the number the server refuses on, and the customer would see a count they cannot
 * reconcile with the error they got.
 */

interface Props {
  bridge: InfoflexBridge
  currentUser: PublicUser
}

type SeatView = Awaited<ReturnType<InfoflexBridge['getTeamSnapshot']>>['seats'][number]
type SeatCount = Awaited<ReturnType<InfoflexBridge['getTeamSnapshot']>>['counts'][number]
type SizedRole = 'ACCOUNT' | 'USER' | 'SUPERVISOR'

const SIZED: ReadonlyArray<{ role: SizedRole; label: string }> = [
  { role: 'ACCOUNT', label: 'Account' },
  { role: 'USER', label: 'User' },
  { role: 'SUPERVISOR', label: 'Supervisor' },
]

export function UsersAndSeats({ bridge, currentUser }: Props) {
  const [seats, setSeats] = useState<SeatView[]>([])
  const [counts, setCounts] = useState<SeatCount[]>([])
  const [summary, setSummary] = useState<Array<{ role: string; summary: string }>>([])
  const [settings, setSettings] = useState({
    supervisorSeesCost: false, singleLoginPerAccount: true, allowAdminOnClients: false, orderExpiryMinutes: 120,
  })
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  /** The seat whose password form is open, or the seat being renamed. */
  const [passwordSeat, setPasswordSeat] = useState<SeatView | null>(null)
  const [renaming, setRenaming] = useState<SeatView | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const snapshot = await bridge.getTeamSnapshot()
    setSeats(snapshot.seats)
    setCounts(snapshot.counts)
    setSettings({
      supervisorSeesCost: snapshot.supervisorSeesCost,
      singleLoginPerAccount: snapshot.singleLoginPerAccount,
      allowAdminOnClients: snapshot.allowAdminOnClients,
      orderExpiryMinutes: snapshot.orderExpiryMinutes,
    })
    setSummary(await bridge.getRoleSummary())
  }, [bridge])

  useEffect(() => {
    void refresh().catch((caught: unknown) => setError(message(caught)))
  }, [refresh])

  async function run(action: () => Promise<void>, done: string): Promise<void> {
    setBusy(true)
    setError('')
    setStatus('')
    try {
      await action()
      await refresh()
      setStatus(done)
    } catch (caught) {
      // The refusal text comes from the server and names the number in the way ("1 active Account account uses a
      // seat…"). Showing it verbatim is the point: a screen that replaced it with "could not save" would hide the one
      // fact the Admin needs.
      setError(message(caught))
    } finally {
      setBusy(false)
    }
  }

  async function changeCount(role: SizedRole, delta: number): Promise<void> {
    const current = counts.find((entry) => entry.role === role)
    const next = Math.max(0, (current?.seats ?? 0) + delta)
    await run(() => bridge.setSeatCount({ role, seats: next }).then(() => undefined), `${label(role)} seats set to ${next}.`)
  }

  async function submitRename(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!renaming) return
    const form = new FormData(event.currentTarget)
    const fullName = String(form.get('fullName') ?? '')
    await run(() => bridge.renameSeat(renaming.id, fullName), 'Seat renamed.')
    setRenaming(null)
  }

  async function submitPassword(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!passwordSeat) return
    const form = new FormData(event.currentTarget)
    const password = String(form.get('password') ?? '')
    const confirmPassword = String(form.get('confirmPassword') ?? '')
    await run(
      () => bridge.setSeatPassword(passwordSeat.id, password, confirmPassword),
      `Password set. ${passwordSeat.fullName} can now sign in on a client PC.`,
    )
    setPasswordSeat(null)
  }

  return (
    <div className="page">
      <header className="page-heading">
        <div>
          <span className="eyebrow">ADMIN ONLY · SERVER</span>
          <h1>Users and Seats</h1>
          <p>Who may sign in, on which PC, and with what limits. Only the Admin creates accounts and sets passwords.</p>
        </div>
      </header>

      {error && <div className="form-error" role="alert"><span>!</span>{error}</div>}
      {status && <div className="form-status" role="status">{status}</div>}

      <section className="panel" aria-labelledby="counts-heading">
        <div className="panel__heading"><h2 id="counts-heading">Seats</h2><p>A seat is one person's sign-in. Changing a count adds or removes seats; it never changes an existing person's account.</p></div>
        <div className="seat-counts">
          {SIZED.map(({ role, label: roleLabel }) => {
            const entry = counts.find((candidate) => candidate.role === role)
            const atCap = entry?.licenceCap !== null && entry?.licenceCap !== undefined && (entry?.seats ?? 0) >= entry.licenceCap
            const atFloor = (entry?.seats ?? 0) <= entry!.activeAccounts
            return (
              <div className="seat-count" key={role}>
                <span className="seat-count__role">{roleLabel}</span>
                <strong className="seat-count__value">{entry?.seats ?? 0}</strong>
                <span className="seat-count__detail">
                  {entry?.activeAccounts ?? 0} in use
                  {entry?.licenceCap !== null && entry?.licenceCap !== undefined && ` · licence allows ${entry.licenceCap}`}
                </span>
                <div className="seat-count__controls">
                  <button type="button" className="secondary-button" disabled={busy || atFloor} title={atFloor ? 'Every seat is held by an active account.' : undefined} onClick={() => void changeCount(role, -1)}>Remove one</button>
                  <button type="button" className="secondary-button" disabled={busy || atCap} title={atCap ? 'Your licence does not allow more of this role.' : undefined} onClick={() => void changeCount(role, 1)}>Add one</button>
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <section className="panel" aria-labelledby="seats-heading">
        <div className="panel__heading"><h2 id="seats-heading">People</h2><p>A seat shown as <b>Needs password</b> cannot sign in. Give it a name and a password before that person starts.</p></div>
        <table className="data-table">
          <thead>
            <tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th>Last login</th><th>PC</th><th><span className="visually-hidden">Actions</span></th></tr>
          </thead>
          <tbody>
            {seats.length === 0 && <tr><td colSpan={7}>No seats yet. Add a seat above to create one.</td></tr>}
            {seats.map((seat) => (
              <tr key={seat.id}>
                <td>{seat.fullName}</td>
                <td><code>{seat.username}</code></td>
                <td>{label(seat.role as SizedRole)}</td>
                <td>
                  {seat.needsPassword
                    ? <span className="badge badge--warning">Needs password</span>
                    : seat.isActive ? <span className="badge badge--ok">Active</span> : <span className="badge">Inactive</span>}
                  {seat.isLocked && <span className="badge badge--danger">Locked</span>}
                </td>
                <td>{seat.lastLoginAt ? new Date(seat.lastLoginAt).toLocaleString() : 'Never'}</td>
                <td>{seat.lastPc ?? '—'}</td>
                <td className="row-actions">
                  <button type="button" className="link-button" disabled={busy} onClick={() => setRenaming(seat)}>Rename</button>
                  <button type="button" className="link-button" disabled={busy} onClick={() => setPasswordSeat(seat)}>
                    {seat.needsPassword ? 'Set password' : 'Reset password'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel" aria-labelledby="toggles-heading">
        <div className="panel__heading"><h2 id="toggles-heading">Shop-wide sign-in rules</h2><p>These apply to everybody, on every PC.</p></div>
        <label className="toggle">
          <input type="checkbox" checked={settings.supervisorSeesCost} disabled={busy}
            onChange={(event) => void run(() => bridge.updateTeamSettings({ supervisorSeesCost: event.target.checked }), 'Saved.')} />
          <span><b>Supervisor can see cost</b><small>Off by default. A Supervisor sees stock quantities either way; this adds buying cost and margin.</small></span>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={settings.singleLoginPerAccount} disabled={busy}
            onChange={(event) => void run(() => bridge.updateTeamSettings({ singleLoginPerAccount: event.target.checked }), 'Saved.')} />
          <span><b>One active login per account</b><small>On by default. Signing in on a second PC ends the first session.</small></span>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={settings.allowAdminOnClients} disabled={busy}
            onChange={(event) => void run(() => bridge.updateTeamSettings({ allowAdminOnClients: event.target.checked }), 'Saved.')} />
          <span><b>Allow Admin sign-in on client PCs</b><small>Off by default. The Admin signs in on the server; turning this on lets the Admin also sign in at a till.</small></span>
        </label>
        <label className="field field--inline">
          <span>Unpaid orders expire after (minutes)</span>
          <input type="number" min={1} max={10080} value={settings.orderExpiryMinutes} disabled={busy}
            onChange={(event) => void run(() => bridge.updateTeamSettings({ orderExpiryMinutes: Number(event.target.value) }), 'Saved.')} />
        </label>
      </section>

      <section className="panel" aria-labelledby="roles-heading">
        <div className="panel__heading"><h2 id="roles-heading">What each role can do</h2><p>Fixed. These are the rules the server enforces, not a preference.</p></div>
        <dl className="role-summary">
          {summary.map((entry) => (
            <div key={entry.role}>
              <dt>{label(entry.role as SizedRole)}</dt>
              <dd>{entry.summary}</dd>
            </div>
          ))}
        </dl>
        <p className="panel__footnote">Signed in as {currentUser.fullName}. Only the Admin can change anything on this screen.</p>
      </section>

      {renaming && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="rename-heading">
          <form className="modal" onSubmit={submitRename}>
            <h2 id="rename-heading">Name this seat</h2>
            <p>The name appears on the audit trail beside everything this person does.</p>
            <label className="field"><span>Full name</span><input name="fullName" required maxLength={120} defaultValue={renaming.fullName} autoFocus /></label>
            <div className="form-actions">
              <button type="button" className="secondary-button" onClick={() => setRenaming(null)}>Cancel</button>
              <button type="submit" className="primary-button" disabled={busy}>{busy ? 'Saving…' : 'Save name'}</button>
            </div>
          </form>
        </div>
      )}

      {passwordSeat && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="password-heading">
          <form className="modal" onSubmit={submitPassword}>
            <h2 id="password-heading">{passwordSeat.needsPassword ? 'Set a password' : 'Reset the password'}</h2>
            <p>For <b>{passwordSeat.fullName}</b> ({passwordSeat.username}). You will need to tell them this password yourself: the product has no password email and no recovery link.</p>
            <label className="field"><span>Password</span><input name="password" type="password" required autoComplete="new-password" /></label>
            <label className="field"><span>Confirm password</span><input name="confirmPassword" type="password" required autoComplete="new-password" /></label>
            <p className="field-hint">At least 8 characters with a letter and a number. Three unrelated words is strong and easy to type at a counter.</p>
            <div className="form-actions">
              <button type="button" className="secondary-button" onClick={() => setPasswordSeat(null)}>Cancel</button>
              <button type="submit" className="primary-button" disabled={busy}>{busy ? 'Saving…' : 'Save password'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}

function label(role: SizedRole | string): string {
  return role === 'ACCOUNT' ? 'Account' : role === 'USER' ? 'User' : role === 'SUPERVISOR' ? 'Supervisor' : 'Admin'
}

function message(caught: unknown): string {
  return caught instanceof Error ? caught.message : 'Something went wrong. Try again.'
}
