import { useEffect, useState, type FormEvent } from 'react'
import { decimalToMinor } from '@shared/currency/money'
import { parseMoney, formatMoney, type CurrencyDefinition } from '@shared/currency'
import type { CreateUserInput, PublicUser, UpdateUserInput, UserPermissions, UserRole } from '@shared/auth/types'
import type { InfoflexBridge } from '@shared/bridge'
import type { MoneyDisplayOptions } from '@shared/currency/money'
import type { Edition } from '../../../editions'
import { defaultPermissions } from '@shared/auth/policy'

interface Props {
  bridge: InfoflexBridge
  usersCurrency: CurrencyDefinition
  display: MoneyDisplayOptions
  edition: Edition | null
  currentUser: PublicUser
}

interface UserFormState {
  fullName: string
  username: string
  role: UserRole
  permissions: UserPermissions
  isActive: boolean
  password: string
  confirmPassword: string
  maxDiscount: string
  returnLimit: string
}

const emptyForm = (): UserFormState => ({
  fullName: '',
  username: '',
  role: 'CASHIER',
  permissions: defaultPermissions('CASHIER'),
  isActive: true,
  password: '',
  confirmPassword: '',
  maxDiscount: '0',
  returnLimit: '0',
})

export function UserManagement({ bridge, usersCurrency, display, edition, currentUser }: Props) {
  const [users, setUsers] = useState<PublicUser[]>([])
  const [form, setForm] = useState<UserFormState>(emptyForm)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [passwordResetId, setPasswordResetId] = useState<string | null>(null)
  const [resetPassword, setResetPassword] = useState('')
  const [resetConfirm, setResetConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')

  async function refreshUsers(): Promise<void> {
    setUsers(await bridge.listUsers())
  }

  useEffect(() => {
    void refreshUsers().catch((caught: unknown) => setError(errorMessage(caught)))
  }, [bridge])

  function updateForm<K extends keyof UserFormState>(key: K, value: UserFormState[K]): void {
    setForm((current) => ({ ...current, [key]: value }))
  }

  function updatePermission<K extends keyof UserPermissions>(key: K, value: UserPermissions[K]): void {
    setForm((current) => ({ ...current, permissions: { ...current.permissions, [key]: value } }))
  }

  function startCreate(): void {
    setEditingId(null)
    setForm(emptyForm())
    setError('')
    setStatus('')
  }

  function startEdit(user: PublicUser): void {
    setEditingId(user.id)
    setForm({
      fullName: user.fullName,
      username: user.username,
      role: user.role,
      permissions: { ...user.permissions },
      isActive: user.isActive,
      password: '',
      confirmPassword: '',
      maxDiscount: (user.permissions.maxDiscountBasisPoints / 100).toFixed(2).replace(/\.00$/u, ''),
      returnLimit: formatMajor(user.permissions.returnLimitMinor, usersCurrency, display),
    })
    setError('')
    setStatus('')
  }

  function changeRole(role: UserRole): void {
    setForm((current) => ({
      ...current,
      role,
      permissions: {
        ...defaultPermissions(role),
        maxDiscountBasisPoints: current.permissions.maxDiscountBasisPoints,
        allowCreditSales: current.permissions.allowCreditSales,
        returnLimitMinor: current.permissions.returnLimitMinor,
      },
    }))
  }

  async function submitUser(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setError('')
    setStatus('')
    let permissions: UserPermissions
    try {
      permissions = { ...form.permissions, maxDiscountBasisPoints: parseDiscount(form.maxDiscount) }
      permissions.returnLimitMinor = parseMoney(form.returnLimit || '0', usersCurrency, display)
    } catch (caught) {
      setError(errorMessage(caught))
      return
    }
    setBusy(true)
    try {
      if (editingId) {
        const input: UpdateUserInput = {
          fullName: form.fullName,
          username: form.username,
          role: form.role,
          permissions,
          isActive: form.isActive,
        }
        await bridge.updateUser(editingId, input)
        setStatus('User changes saved. Host permissions take effect immediately.')
      } else {
        const input: CreateUserInput = {
          fullName: form.fullName,
          username: form.username,
          password: form.password,
          confirmPassword: form.confirmPassword,
          role: form.role,
          permissions,
        }
        await bridge.createUser(input)
        setStatus('User created.')
      }
      await refreshUsers()
      startCreate()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  async function deactivate(user: PublicUser): Promise<void> {
    if (!window.confirm(`Deactivate ${user.fullName}? Their existing desktop session will stop working.`)) return
    setError('')
    setStatus('')
    try {
      await bridge.deactivateUser(user.id)
      await refreshUsers()
      setStatus('User deactivated.')
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  async function unlock(user: PublicUser): Promise<void> {
    setError('')
    try {
      await bridge.unlockUser(user.id)
      await refreshUsers()
      setStatus(`${user.fullName} can sign in again.`)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  async function submitPasswordReset(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!passwordResetId) return
    setError('')
    setStatus('')
    try {
      await bridge.resetPassword(passwordResetId, resetPassword, resetConfirm)
      setPasswordResetId(null)
      setResetPassword('')
      setResetConfirm('')
      await refreshUsers()
      setStatus('Password reset. Existing sessions for that user were signed out.')
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  const supervisorsAvailable = edition === 'SUPERMARKET' || edition === 'BOTH'

  return (
    <div className="user-management">
      <div className="management-heading"><div><span className="eyebrow eyebrow--gold">ADMIN · DESKTOP ONLY</span><h2>User management</h2><p>Create accounts, control shop permissions, and revoke access. Role checks are enforced by the host for every action.</p></div><div className="management-heading__actions"><button className="secondary-button" onClick={() => void refreshUsers().catch((caught: unknown) => setError(errorMessage(caught)))} type="button">Refresh list</button><button className="secondary-button" onClick={startCreate} type="button">+ New user</button></div></div>
      {error && <div className="form-error" role="alert"><span>!</span>{error}</div>}
      {status && <div className="success-message" role="status">{status}</div>}

      <section className="management-card">
        <div className="management-card__header"><div><span className="section-number">{editingId ? 'EDIT' : 'NEW'}</span><div><h3>{editingId ? 'Edit user' : 'Create a user'}</h3><p>{editingId ? 'Changes are enforced on the next host request.' : 'Cashier wholesale permission starts ON by default and can be switched off here.'}</p></div></div></div>
        <form className="user-form-grid" onSubmit={(event) => void submitUser(event)}>
          <label className="field"><span>Full name</span><input required maxLength={120} value={form.fullName} onChange={(event) => updateForm('fullName', event.target.value)} /></label>
          <label className="field"><span>Username</span><input required maxLength={32} autoCapitalize="none" value={form.username} onChange={(event) => updateForm('username', event.target.value.toLowerCase())} /></label>
          <label className="field"><span>Role</span><select value={form.role} onChange={(event) => changeRole(event.target.value as UserRole)}><option value="CASHIER">Cashier</option>{supervisorsAvailable && <option value="SUPERVISOR">Supervisor</option>}<option value="ADMIN">Admin</option></select></label>
          {editingId && <label className="permission-check"><input type="checkbox" checked={form.isActive} onChange={(event) => updateForm('isActive', event.target.checked)} /><span>Account active</span></label>}
          {!editingId && <>
            <label className="field"><span>Initial password</span><input required type="password" autoComplete="new-password" value={form.password} onChange={(event) => updateForm('password', event.target.value)} /></label>
            <label className="field"><span>Confirm password</span><input required type="password" autoComplete="new-password" value={form.confirmPassword} onChange={(event) => updateForm('confirmPassword', event.target.value)} /></label>
          </>}
          <div className="permission-grid field--wide">
            <label className="permission-check"><input type="checkbox" checked={form.permissions.allowWholesale} onChange={(event) => updatePermission('allowWholesale', event.target.checked)} /><span>Can make wholesale sales</span></label>
            <label className="field"><span>Maximum discount (%)</span><input inputMode="decimal" value={form.maxDiscount} onChange={(event) => updateForm('maxDiscount', event.target.value)} placeholder="0" /></label>
            <label className="permission-check"><input type="checkbox" checked={form.permissions.allowCreditSales} onChange={(event) => updatePermission('allowCreditSales', event.target.checked)} /><span>Can sell on credit</span></label>
            <label className="field"><span>Return limit ({usersCurrency.code})</span><input inputMode="decimal" value={form.returnLimit} onChange={(event) => updateForm('returnLimit', event.target.value)} placeholder="0" /><small>Enter an amount using the shop currency display settings.</small></label>
          </div>
          <div className="user-form-actions field--wide"><button className="primary-button" type="submit" disabled={busy}>{busy ? 'Saving…' : editingId ? 'Save user changes' : 'Create user'}</button>{editingId && <button className="text-button" type="button" onClick={startCreate}>Cancel edit</button>}</div>
        </form>
      </section>

      <section className="management-card">
        <div className="management-card__header"><div><span className="eyebrow eyebrow--gold">SHOP ACCOUNTS</span><h3>Users ({users.length})</h3></div></div>
        {users.length === 0 ? <p className="empty-list">No user accounts were found.</p> : <div className="user-list">{users.map((user) => <article className="user-row" key={user.id}>
          <div className="user-row__identity"><span className="user-avatar">{user.fullName.split(/\s+/u).slice(0, 2).map((part) => part[0] ?? '').join('').toUpperCase()}</span><div><strong>{user.fullName}</strong><span>@{user.username}</span><small>{user.role[0] + user.role.slice(1).toLowerCase()} · {user.isActive ? 'Active' : 'Deactivated'}{user.isLocked ? ' · Locked' : ''}</small>{user.role !== 'ADMIN' && <em>Mobile app: not available for this role.</em>}</div></div>
          <div className="user-row__permissions"><span>Wholesale: {user.role === 'ADMIN' || user.permissions.allowWholesale ? 'On' : 'Off'}</span><span>Max discount: {(user.permissions.maxDiscountBasisPoints / 100).toFixed(2).replace(/\.00$/u, '')}%</span><span>Credit: {user.role === 'ADMIN' || user.permissions.allowCreditSales ? 'On' : 'Off'}</span><span>Return limit: {formatMoney(user.permissions.returnLimitMinor, usersCurrency, display)}</span></div>
          <div className="user-row__actions"><button className="text-button" type="button" onClick={() => startEdit(user)}>Edit</button>{user.isLocked && <button className="text-button" type="button" onClick={() => void unlock(user)}>Unlock</button>}<button className="text-button" type="button" onClick={() => { setPasswordResetId(user.id); setResetPassword(''); setResetConfirm('') }}>Reset password</button>{user.isActive && user.id !== currentUser.id && <button className="text-button text-button--danger" type="button" onClick={() => void deactivate(user)}>Deactivate</button>}</div>
          {passwordResetId === user.id && <form className="password-reset-row" onSubmit={(event) => void submitPasswordReset(event)}><label className="field"><span>New password</span><input required minLength={10} type="password" value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} /></label><label className="field"><span>Confirm password</span><input required type="password" value={resetConfirm} onChange={(event) => setResetConfirm(event.target.value)} /></label><button className="secondary-button" type="submit">Save new password</button><button className="text-button" type="button" onClick={() => setPasswordResetId(null)}>Cancel</button></form>}
        </article>)}</div>}
      </section>
    </div>
  )
}

function parseDiscount(value: string): number {
  try {
    const basisPoints = decimalToMinor(value.trim() || '0', 2)
    if (basisPoints < 0n || basisPoints > 10_000n) throw new Error('Maximum discount must be between 0% and 100%.')
    return Number(basisPoints)
  } catch (caught) {
    throw caught instanceof Error ? caught : new Error('Enter a valid maximum discount percentage.')
  }
}

function formatMajor(minor: bigint, currency: CurrencyDefinition, display: MoneyDisplayOptions): string {
  const factor = 10n ** BigInt(currency.decimalPlaces)
  const whole = minor / factor
  const fraction = currency.decimalPlaces ? (minor % factor).toString().padStart(currency.decimalPlaces, '0') : ''
  return currency.decimalPlaces ? `${whole}${display.decimalSeparator}${fraction}` : whole.toString()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The user change could not be saved.'
}
