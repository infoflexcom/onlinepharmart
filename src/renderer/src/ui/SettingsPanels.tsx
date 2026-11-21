import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { InfoflexBridge } from '@shared/bridge'
import type { DemoDatasetState } from '@shared/demo/types'
import type { CurrencyDefinition } from '@shared/currency/catalog'
import { formatMoney, type MoneyDisplayOptions } from '@shared/currency/money'
import type { LicenseSummary } from '@shared/license/types'
import {
  DEFAULT_OPERATIONAL_SETTINGS,
  PAYMENT_METHOD_SETTINGS,
  type BackupStatus,
  type DocumentLayout,
  type OperationalSettings,
  type PaymentMethodSetting,
  type ShopProfile,
  type ShopSettings,
} from '@shared/shop/types'

const PAYMENT_LABELS: Record<PaymentMethodSetting, string> = {
  CASH: 'Cash',
  TRANSFER: 'Bank transfer',
  CARD: 'POS / Card',
  CREDIT: 'Credit (on account)',
}

const LAYOUT_LABELS: Record<DocumentLayout, string> = {
  THERMAL_80: '80 mm thermal till roll',
  THERMAL_58: '58 mm thermal till roll',
  A4_RECEIPT: 'A4 receipt',
}

interface SharedProps {
  bridge: InfoflexBridge
  settings: ShopSettings
  onSaved: (settings: ShopSettings) => void
}

/** Receipts, VAT, discounts, printer, payment methods and edition options. */
export function ReceiptSettingsPanel({ bridge, settings, onSaved }: SharedProps) {
  const [form, setForm] = useState<OperationalSettings>({ ...settings.operational })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')

  useEffect(() => { setForm({ ...settings.operational }) }, [settings.operational])

  function update<K extends keyof OperationalSettings>(key: K, value: OperationalSettings[K]): void {
    setForm((current) => ({ ...current, [key]: value }))
  }

  function togglePayment(method: PaymentMethodSetting): void {
    setForm((current) => ({
      ...current,
      enabledPaymentMethods: current.enabledPaymentMethods.includes(method)
        ? current.enabledPaymentMethods.filter((entry) => entry !== method)
        : PAYMENT_METHOD_SETTINGS.filter((entry) => entry === method || current.enabledPaymentMethods.includes(entry)),
    }))
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setError('')
    setStatus('')
    setSaving(true)
    try {
      onSaved(await bridge.updateOperationalSettings(form))
      setStatus('Receipt and edition settings saved. New documents use them immediately.')
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="management-card">
      <div className="management-card__header">
        <div>
          <span className="eyebrow eyebrow--gold">RECEIPTS, TAX &amp; EDITION</span>
          <h2>Receipt layout, VAT, discounts and printer</h2>
          <p>These choices change what is printed and how tills behave. They never change an amount already recorded.</p>
        </div>
      </div>
      <form className="settings-form-grid" onSubmit={(event) => void save(event)}>
        <label className="field">
          <span>Receipt paper size</span>
          <select value={form.documentLayout} onChange={(event) => update('documentLayout', event.target.value as DocumentLayout)}>
            {(Object.keys(LAYOUT_LABELS) as DocumentLayout[]).map((layout) => (
              <option key={layout} value={layout}>{LAYOUT_LABELS[layout]}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Printer</span>
          <input maxLength={120} value={form.printerName} placeholder="Default printer" onChange={(event) => update('printerName', event.target.value)} />
        </label>

        <div className="settings-subpanel field--wide">
          <div className="settings-subpanel__title"><strong>Tax / VAT (optional)</strong><span>Leave this off if you do not charge VAT.</span></div>
          <div className="settings-toggle-row">
            <label className="field field--inline">
              <input type="checkbox" checked={form.vatEnabled} onChange={(event) => update('vatEnabled', event.target.checked)} />
              <span>Charge VAT on sales</span>
            </label>
            <label className="field field--inline">
              <input type="checkbox" checked={form.vatInclusive} disabled={!form.vatEnabled} onChange={(event) => update('vatInclusive', event.target.checked)} />
              <span>My prices already include VAT</span>
            </label>
            <label className="field">
              <span>VAT rate (%)</span>
              <input
                type="number" min={0} max={100} step={0.01} disabled={!form.vatEnabled}
                value={form.vatRateBasisPoints / 100}
                onChange={(event) => update('vatRateBasisPoints', Math.round(Number(event.target.value) * 100) || 0)}
              />
            </label>
          </div>
        </div>

        <div className="settings-subpanel field--wide">
          <div className="settings-subpanel__title"><strong>Payment methods on the till</strong><span>At least one must stay switched on.</span></div>
          <div className="settings-toggle-row">
            {PAYMENT_METHOD_SETTINGS.map((method) => (
              <label className="field field--inline" key={method}>
                <input type="checkbox" checked={form.enabledPaymentMethods.includes(method)} onChange={() => togglePayment(method)} />
                <span>{PAYMENT_LABELS[method]}</span>
              </label>
            ))}
          </div>
          <label className="field">
            <span>Discount limit per sale (%)</span>
            <input
              type="number" min={0} max={100} step={0.5}
              value={form.discountLimitBasisPoints / 100}
              onChange={(event) => update('discountLimitBasisPoints', Math.round(Number(event.target.value) * 100) || 0)}
            />
          </label>
        </div>

        <div className="settings-subpanel field--wide">
          <div className="settings-subpanel__title"><strong>Edition options</strong><span>Pharmacy expiry alerts, loyalty and supervisor controls.</span></div>
          <div className="settings-form-grid settings-form-grid--tight">
            <label className="field">
              <span>Expiry alert before (days)</span>
              <input type="number" min={1} max={3650} step={1} value={form.expiryAlertDays} onChange={(event) => update('expiryAlertDays', Number(event.target.value))} />
            </label>
            <label className="field">
              <span>Loyalty points per 100 spent</span>
              <input type="number" min={0} max={100} step={0.5} value={form.loyaltyRateBasisPoints} onChange={(event) => update('loyaltyRateBasisPoints', Math.round(Number(event.target.value)) || 0)} />
            </label>
            <label className="field">
              <span>Supervisor PIN length</span>
              <select value={form.supervisorPinLength} onChange={(event) => update('supervisorPinLength', Number(event.target.value))}>
                {[4, 5, 6, 7, 8].map((length) => <option key={length} value={length}>{length} digits</option>)}
              </select>
            </label>
            <label className="field field--inline">
              <input type="checkbox" checked={form.supervisorPinRequired} onChange={(event) => update('supervisorPinRequired', event.target.checked)} />
              <span>Supervisor PIN for overrides</span>
            </label>
            <label className="field field--inline">
              <input type="checkbox" checked={form.scaleEnabled} onChange={(event) => update('scaleEnabled', event.target.checked)} />
              <span>Weighing scale connected</span>
            </label>
            <label className="field">
              <span>Scale connection</span>
              <input maxLength={120} value={form.scalePort} disabled={!form.scaleEnabled} placeholder="e.g. COM3" onChange={(event) => update('scalePort', event.target.value)} />
            </label>
          </div>
        </div>

        <label className="field field--inline field--wide">
          <input type="checkbox" checked={form.showPoweredBy} onChange={(event) => update('showPoweredBy', event.target.checked)} />
          <span>Show "Powered by Infoflex" on customer documents</span>
        </label>

        <div className="settings-form-actions field--wide">
          <button className="primary-button" type="submit" disabled={saving}>Save receipt settings</button>
        </div>
      </form>
      {error && <div className="form-error" role="alert"><span>!</span>{error}</div>}
      {status && <div className="success-message" role="status">{status}</div>}
    </section>
  )
}

/** Live receipt preview built from one real document renderer, so what you see is what prints. */
export function ReceiptPreviewPanel({ settings, profile, display }: {
  settings: ShopSettings
  profile: ShopProfile
  display: MoneyDisplayOptions
}) {
  return (
    <section className="management-card">
      <div className="management-card__header">
        <div>
          <span className="eyebrow eyebrow--gold">LIVE PREVIEW</span>
          <h2>How the next receipt looks</h2>
          <p>Built with the same receipt renderer the till prints. Edit the fields above and this preview follows.</p>
        </div>
        <span className="live-preview-label">UPDATES AS YOU TYPE</span>
      </div>
      <div className={`receipt-live-preview receipt-live-preview--${settings.operational.documentLayout.toLowerCase()}`}>
        <ReceiptPreviewBody settings={settings} profile={profile} display={display} />
      </div>
    </section>
  )
}

function ReceiptPreviewBody({ settings, profile, display }: {
  settings: ShopSettings
  profile: ShopProfile
  display: MoneyDisplayOptions
}) {
  const currency = settings.currency
  const amount = (minor: bigint): string => safeFormat(currency, display, minor)
  const vatRate = settings.operational.vatRateBasisPoints / 100
  const sampleTotal = 250_000n
  const vatMinor = settings.operational.vatEnabled
    ? (settings.operational.vatInclusive
      ? (sampleTotal * BigInt(settings.operational.vatRateBasisPoints) / BigInt(10_000 + settings.operational.vatRateBasisPoints))
      : (sampleTotal * BigInt(settings.operational.vatRateBasisPoints) / 10_000n))
    : 0n
  return (
    <article className="receipt-live-preview__paper">
      {profile.storeLogo && <img src={profile.storeLogo} alt="" />}
      <strong>{profile.name.trim() || 'Your store name'}</strong>
      {profile.address.trim() && <span>{profile.address}</span>}
      {profile.phone.trim() && <span>{profile.phone}</span>}
      {profile.email?.trim() && <span>{profile.email}</span>}
      {profile.licenceNumber?.trim() && <span>Licence: {profile.licenceNumber}</span>}
      {profile.taxNumber?.trim() && <span>Tax ID: {profile.taxNumber}</span>}
      <span className="receipt-live-preview__title">SALES RECEIPT</span>
      <div className="receipt-live-preview__row"><span>Receipt</span><bdi>R-0000000042</bdi></div>
      <div className="receipt-live-preview__row"><span>Sample item × 1</span><bdi>{amount(sampleTotal)}</bdi></div>
      <div className="receipt-live-preview__row"><span>Subtotal</span><bdi>{amount(sampleTotal)}</bdi></div>
      {settings.operational.vatEnabled && <div className="receipt-live-preview__row"><span>VAT {vatRate}%</span><bdi>{amount(vatMinor)}</bdi></div>}
      <div className="receipt-live-preview__row receipt-live-preview__row--total"><strong>Total</strong><strong>{amount(settings.operational.vatEnabled && !settings.operational.vatInclusive ? sampleTotal + vatMinor : sampleTotal)}</strong></div>
      <div className="receipt-live-preview__row"><span>Payment</span><bdi>Cash</bdi></div>
      {profile.receiptFooter?.trim() && <small>{profile.receiptFooter}</small>}
      {profile.thankYouNote?.trim() && <small>{profile.thankYouNote}</small>}
      {settings.operational.showPoweredBy && <small className="receipt-live-preview__powered">Powered by Infoflex</small>}
      <footer>{currency.code} · R-0000000042 · {LAYOUT_LABELS[settings.operational.documentLayout]}</footer>
    </article>
  )
}

/** Read-only licence panel: everything the shop needs to know, and one button to re-check online. */
export function LicensePanel({ bridge, license, onChecked }: {
  bridge: InfoflexBridge
  license: LicenseSummary
  onChecked: (license: LicenseSummary) => void
}) {
  const [checking, setChecking] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const daysRemaining = license.endsAt ? daysUntil(license.endsAt) : null
  const sourceLabel = license.source === 'online' ? 'Online activation' : license.source === 'file' ? 'Licence file' : license.source === 'onsite' ? 'On-site activation' : 'Not activated'

  async function checkNow(): Promise<void> {
    setChecking(true)
    setMessage('')
    setError('')
    try {
      const result = await bridge.checkInLicense()
      const summary = await bridge.getLicenseStatus()
      onChecked(summary)
      setMessage(result.message || 'Licence checked online just now.')
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setChecking(false)
    }
  }

  return (
    <section className="management-card">
      <div className="management-card__header">
        <div>
          <span className="eyebrow eyebrow--gold">LICENCE</span>
          <h2>Licence status</h2>
          <p>Read-only. This panel reports what the licence says; it cannot change it.</p>
        </div>
        <span className={`license-badge license-badge--${license.status}`}>{license.status}</span>
      </div>
      <dl className="settings-facts">
        <div><dt>Edition</dt><dd>{editionLabel(license.edition)}</dd></div>
        <div><dt>Period</dt><dd>{license.startsAt || '—'} → {license.endsAt || 'Open-ended'}</dd></div>
        <div><dt>Days remaining</dt><dd>{daysRemaining === null ? '—' : daysRemaining < 0 ? 'Expired' : `${daysRemaining} day${daysRemaining === 1 ? '' : 's'}`}</dd></div>
        <div><dt>Source</dt><dd>{sourceLabel}</dd></div>
        <div><dt>Online status</dt><dd>{license.lastOnlineCheck ? 'Server reachable' : 'Never confirmed online'}</dd></div>
        <div><dt>Last check</dt><dd>{license.lastOnlineCheck ? new Date(license.lastOnlineCheck).toLocaleString() : '—'}</dd></div>
        <div><dt>Cashier seats</dt><dd>{license.adminPhoneLimit ? `${license.adminPhoneLimit} admin phone${license.adminPhoneLimit === 1 ? '' : 's'}` : '—'}</dd></div>
        <div><dt>Grace period</dt><dd>{license.graceDays ? `${license.graceDays} day${license.graceDays === 1 ? '' : 's'}` : 'None'}</dd></div>
      </dl>
      {license.message && <p className="settings-note">{license.message}</p>}
      <div className="settings-form-actions">
        <button className="secondary-button" type="button" disabled={checking} onClick={() => void checkNow()}>
          {checking ? 'Checking…' : 'Check online now'}
        </button>
      </div>
      {error && <div className="form-error" role="alert"><span>!</span>{error}</div>}
      {message && <div className="success-message" role="status">{message}</div>}
    </section>
  )
}

/** Backup, restore and the seven-day warning, all by button. Nothing here needs a command line. */
export function BackupPanel({ bridge }: { bridge: InfoflexBridge }) {
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [folder, setFolder] = useState('')
  const [files, setFiles] = useState<Array<{ fileName: string; createdAt: string; currencyCode: string }>>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const refresh = useCallback(async () => {
    try {
      const next = await bridge.getBackupStatus()
      setStatus(next)
      setFolder((current) => current || next.automaticFolder)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }, [bridge])

  useEffect(() => { void refresh() }, [refresh])

  async function backUpNow(): Promise<void> {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = await bridge.createManualBackup(folder)
      setStatus(result.status)
      setMessage(`Backup written to ${result.backup.fileName}. Copy it to a USB stick if it is not already there.`)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  async function chooseFolder(): Promise<void> {
    try {
      const chosen = await bridge.chooseBackupFolder()
      if (!chosen) return
      setFolder(chosen)
      setFiles(await bridge.listBackupFiles(chosen))
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  async function findFiles(): Promise<void> {
    setError('')
    try {
      setFiles(await bridge.listBackupFiles(folder))
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  async function restore(fileName: string): Promise<void> {
    if (!window.confirm(
      'Restoring replaces all shop data with the contents of this backup. '
      + 'Your licence and paired phones are kept, and a safety copy of the current data is made first. Continue?',
    )) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = await bridge.restoreBackup({ folder, fileName, confirmed: true })
      setStatus(result.status)
      setMessage(
        result.adoptedCurrency
          ? `Restored. This shop adopted ${result.currencyCode} from the backup. The app will restart to finish.`
          : 'Restored. The app will restart to finish.',
      )
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="management-card">
      <div className="management-card__header">
        <div>
          <span className="eyebrow eyebrow--gold">BACKUP &amp; RESTORE</span>
          <h2>Protect this shop's records</h2>
          <p>A full copy is made automatically once a day. You can also copy one to a USB stick or a shared folder now.</p>
        </div>
      </div>

      {status?.stale && <div className="settings-warning" role="alert"><span>!</span>{status.warning}</div>}
      {status && !status.stale && (
        <p className="settings-note">
          Last backup: {status.lastBackupAt ? new Date(status.lastBackupAt).toLocaleString() : '—'}
          {status.lastBackupFile ? ` · ${status.lastBackupFile}` : ''}
        </p>
      )}

      <div className="settings-form-grid">
        <label className="field field--wide">
          <span>Backup folder</span>
          <input value={folder} readOnly placeholder="Choose a folder" />
        </label>
        <div className="settings-form-actions field--wide">
          <button className="secondary-button" type="button" onClick={() => void chooseFolder()} disabled={busy}>Choose folder…</button>
          <button className="primary-button" type="button" onClick={() => void backUpNow()} disabled={busy || !folder}>
            {busy ? 'Working…' : 'Back up now'}
          </button>
        </div>
      </div>

      <div className="settings-subpanel">
        <div className="settings-subpanel__title">
          <strong>Restore from a backup</strong>
          <span>Only backups in the folder above are listed. Licence and paired phones are never touched.</span>
        </div>
        <button className="secondary-button" type="button" onClick={() => void findFiles()} disabled={busy || !folder}>Find backups in this folder</button>
        {files.length > 0 && (
          <ul className="backup-list">
            {files.map((file) => (
              <li key={file.fileName}>
                <div><strong>{file.fileName}</strong><small>{file.createdAt ? new Date(file.createdAt).toLocaleString() : 'Unknown date'}{file.currencyCode ? ` · ${file.currencyCode}` : ''}</small></div>
                <button className="secondary-button" type="button" disabled={busy} onClick={() => void restore(file.fileName)}>Restore this</button>
              </li>
            ))}
          </ul>
        )}
        {files.length === 0 && <small className="settings-note">No backups listed yet.</small>}
      </div>

      {status && status.recent.length > 0 && (
        <div className="settings-subpanel">
          <div className="settings-subpanel__title"><strong>Recent activity</strong><span>Newest first.</span></div>
          <ul className="backup-list backup-list--compact">
            {status.recent.slice(0, 6).map((entry) => (
              <li key={entry.id}>
                <div><strong>{entry.kind === 'RESTORE' ? 'Restore' : entry.kind === 'AUTOMATIC' ? 'Automatic backup' : 'Manual backup'}</strong><small>{new Date(entry.createdAt).toLocaleString()} · {entry.fileName}</small></div>
                <small>{entry.actor}</small>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && <div className="form-error" role="alert"><span>!</span>{error}</div>}
      {message && <div className="success-message" role="status">{message}</div>}
    </section>
  )
}

function editionLabel(edition: LicenseSummary['edition']): string {
  if (edition === 'PHARMACY') return 'Pharmacy'
  if (edition === 'SUPERMARKET') return 'Supermarket'
  if (edition === 'BOTH') return 'Pharmacy + Supermarket'
  return '—'
}

function daysUntil(iso: string): number | null {
  const end = new Date(iso).getTime()
  if (Number.isNaN(end)) return null
  return Math.ceil((end - Date.now()) / 86_400_000)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'That did not work. Please try again.'
}

function safeFormat(currency: CurrencyDefinition, display: MoneyDisplayOptions, minor: bigint = 123_456_789n): string {
  try { return formatMoney(minor, currency, display) } catch { return 'Check separator settings.' }
}

/**
 * The optional demonstration catalogue. Everything here is worded so an Admin knows two things before pressing
 * anything: the demo is not their data, and removing it before real use leaves the shop exactly as it was.
 */
export function DemoDataPanel({ bridge, edition }: { bridge: InfoflexBridge; edition: string | null }) {
  const [state, setState] = useState<DemoDatasetState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const refresh = useCallback(async () => {
    try {
      setState(await bridge.getDemoDataStatus())
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }, [bridge])

  useEffect(() => { void refresh() }, [refresh])

  async function load(): Promise<void> {
    if (!window.confirm(
      `Load the demonstration catalogue? It adds ${edition === 'SUPERMARKET' ? '60 supermarket' : edition === 'PHARMACY' ? '30 pharmacy' : '90'} products with opening stock, two sample cashiers and a supervisor, plus two example promotions.\n\nNo sale is created, so your currency stays unlocked and you can still change it.`,
    )) return
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await bridge.loadDemoData()
      setMessage(`Loaded ${result.products} products and ${result.users} sample accounts. Example price: ${result.samplePrice}.`)
      await refresh()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  async function remove(): Promise<void> {
    if (!window.confirm(
      'Remove the demonstration products and sample accounts? Anything you created yourself is kept. This cannot be undone.',
    )) return
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await bridge.removeDemoData()
      setMessage(`Removed ${result.products} demonstration products and ${result.users} sample accounts.`)
      await refresh()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="management-card">
      <div className="management-card__header">
        <div>
          <span className="eyebrow eyebrow--gold">DEMONSTRATION DATA</span>
          <h2>Try the app before you start</h2>
          <p>Optional sample products and staff accounts. Load them to explore, then remove them before you enter real stock.</p>
        </div>
      </div>
      {!state && <p className="settings-note">Checking the demonstration catalogue…</p>}
      {state && (
        <>
          <p className="settings-note">
            {state.loaded
              ? `${state.products} demonstration products and ${state.users} sample accounts are loaded. Prices are scaled to your shop currency (${state.currency}).`
              : 'No demonstration data is loaded. Your catalogue is entirely your own.'}
          </p>
          {state.loaded && state.demoUsers.length > 0 && (
            <ul className="settings-note">
              {state.demoUsers.map((user) => <li key={user.username}>Sample login <code>{user.username}</code> — {user.fullName} ({user.role === 'SUPERVISOR' ? 'Supervisor' : 'Cashier'})</li>)}
              <li>Sample password for these accounts: <code>Demo-Pass!2026</code>. Change or remove them before going live.</li>
            </ul>
          )}
          {state.inUse && state.inUseReason && (
            <div className="settings-warning" role="alert"><span>!</span>{state.inUseReason}</div>
          )}
          <div className="settings-form-actions">
            {!state.loaded && <button className="primary-button" type="button" disabled={busy} onClick={() => void load()}>{busy ? 'Loading…' : 'Load demonstration data'}</button>}
            {state.loaded && <button className="secondary-button" type="button" disabled={busy || state.inUse} onClick={() => void remove()}>{busy ? 'Removing…' : 'Remove demonstration data'}</button>}
          </div>
        </>
      )}
      {error && <div className="form-error" role="alert"><span>!</span>{error}</div>}
      {message && <div className="success-message" role="status">{message}</div>}
    </section>
  )
}

export { DEFAULT_OPERATIONAL_SETTINGS }
