import { useMemo, useState, type ChangeEvent, type FormEvent } from 'react'
import { CURRENCIES } from '@shared/currency/catalog'
import type { InfoflexBridge } from '@shared/bridge'
import type { LicenseSummary, OnsiteActivationInput } from '@shared/license/types'
import type { ShopSettings } from '@shared/shop/types'
import { addYearsToDateInput, todayDateInput } from '../../../license/dates'

interface Props {
  bridge: InfoflexBridge
  summary: LicenseSummary
  settings: ShopSettings
  productName: string
  appVersion: string
  onUpdated: () => Promise<void>
}

type ActivationTab = 'online' | 'file' | 'onsite'

export function LicenseScreen({ bridge, summary, settings, productName, appVersion, onUpdated }: Props) {
  const [tab, setTab] = useState<ActivationTab>('online')
  const [activationKey, setActivationKey] = useState('')
  const [serverUrl, setServerUrl] = useState(summary.licenseServerUrl ?? '')
  const [masterPassword, setMasterPassword] = useState('')
  const [edition, setEdition] = useState<OnsiteActivationInput['edition']>(summary.edition ?? 'PHARMACY')
  const [startsOn, setStartsOn] = useState(todayDateInput())
  const [endsOn, setEndsOn] = useState(() => addYearsToDateInput(todayDateInput(), 1))
  const transactionLocked = settings.currencyLocked
  const [defaultCurrency, setDefaultCurrency] = useState<string>(() => transactionLocked
    ? settings.currency.code
    : summary.defaultCurrencyCode ?? '')
  const [lockCurrency, setLockCurrency] = useState(summary.lockCurrency)
  const [mobileLan, setMobileLan] = useState(summary.features.mobileLan)
  const [mobileInternet, setMobileInternet] = useState(summary.features.mobileInternet)
  const [adminPhoneLimit, setAdminPhoneLimit] = useState(summary.adminPhoneLimit || 1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const maxEndDate = useMemo(() => {
    if (summary.maximumOnsitePeriodYears === null) return undefined
    try { return addYearsToDateInput(startsOn, summary.maximumOnsitePeriodYears) } catch { return undefined }
  }, [startsOn, summary.maximumOnsitePeriodYears])

  async function refreshSummary(): Promise<void> {
    await onUpdated()
    const next = await bridge.getLicenseStatus()
    if (!transactionLocked && next.defaultCurrencyCode) setDefaultCurrency(next.defaultCurrencyCode)
    setLockCurrency(next.lockCurrency)
    setMobileLan(next.features.mobileLan)
    setMobileInternet(next.features.mobileInternet)
    setAdminPhoneLimit(next.adminPhoneLimit)
    setServerUrl(next.licenseServerUrl ?? '')
  }

  async function submitOnline(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setError('')
    setSuccess('')
    setBusy(true)
    const key = activationKey
    try {
      await bridge.activateOnline({ activationKey: key, serverUrl })
      setActivationKey('')
      setSuccess('License activated and verified on this machine.')
      await refreshSummary()
    } catch (caught) {
      setActivationKey('')
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  async function importLicense(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setError('')
    setSuccess('')
    if (!file.name.toLowerCase().endsWith('.lic') || file.size > 32_768) {
      setError('Choose a signed .lic file no larger than 32 KB.')
      return
    }
    setBusy(true)
    try {
      await bridge.importLicenseFile(await file.text())
      setSuccess('The signed license file was verified and bound to this machine.')
      await refreshSummary()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  async function importVendorPolicy(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setError('')
    setSuccess('')
    if (file.size > 64_000 || !/\.(json|iflpolicy)$/iu.test(file.name)) {
      setError('Choose a Build Studio policy JSON file no larger than 64 KB.')
      return
    }
    setBusy(true)
    try {
      await bridge.importVendorPolicyFile(await file.text())
      setSuccess('The vendor policy was imported. Only its salted password hash was saved.')
      await refreshSummary()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  async function submitOnsite(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setError('')
    setSuccess('')
    const password = masterPassword
    setBusy(true)
    try {
      await bridge.activateOnsite({
        masterPassword: password,
        edition,
        startsOn,
        endsOn,
        defaultCurrencyCode: defaultCurrency || null,
        lockCurrency,
        features: { mobileLan, mobileInternet },
        adminPhoneLimit,
      })
      setMasterPassword('')
      setSuccess('On-site license issued and authenticated for this machine.')
      await refreshSummary()
    } catch (caught) {
      setMasterPassword('')
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  async function manualCheckIn(): Promise<void> {
    setError('')
    setSuccess('')
    setBusy(true)
    try {
      const result = await bridge.checkInLicense()
      if (result.message.startsWith('License check-in completed')) setSuccess(result.message)
      else setError(result.message)
      await refreshSummary()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="license-screen">
      <section className="license-card">
        <img className="license-logo" src="/branding/logo-transparent.png" alt="Infoflex" />
        <span className="eyebrow eyebrow--gold">{productName.toUpperCase()} · VERSION {appVersion}</span>
        <h1>{summary.status === 'unactivated' ? 'Activate Infoflex' : 'License access is locked'}</h1>
        <p className="license-intro">{summary.status === 'unactivated'
          ? 'Activate this installation before setup or sign-in. The license is verified by the desktop host and bound to this machine.'
          : summary.message}</p>
        <div className="license-protection-note"><strong>Your shop data is safe.</strong> Expiry, suspension, and activation failures do not delete, change, encrypt, or upload sales or stock data. If a sale is in progress, finish it before the end date; a lock interrupts access but does not remove data.</div>

        {summary.status === 'machine_mismatch' && <div className="license-recovery license-recovery-action" role="alert">
          <strong>This license is bound to another machine.</strong>
          <p>{summary.vendorConfigured
            ? 'Use the on-site / offline flow to issue a license for this machine. The installed policy is intact, so importing it again will not change the binding; the vendor master password is required.'
            : 'Open the on-site / offline flow to import the trusted Build Studio policy first, or ask the vendor for a signed license file issued for this machine.'}</p>
          <button className="secondary-button" type="button" disabled={busy} onClick={() => setTab('onsite')}>Open on-site recovery</button>
        </div>}

        {summary.licenseId && <div className="license-summary">
          <div><span>License</span><strong>{summary.licenseId}</strong></div>
          {summary.edition && <div><span>Edition</span><strong>{editionLabel(summary.edition)}</strong></div>}
          {summary.endsAt && <div><span>Ends</span><strong>{summary.endsAt.slice(0, 10)} (end date is exclusive)</strong></div>}
          {summary.source && <div><span>Source</span><strong>{summary.source === 'onsite' ? 'On-site offline' : summary.source === 'file' ? 'Signed .lic file' : 'Online'}</strong></div>}
        </div>}

        <div className="license-tabs" role="tablist" aria-label="License activation methods">
          <button type="button" role="tab" aria-selected={tab === 'online'} className={tab === 'online' ? 'is-active' : ''} onClick={() => setTab('online')}>Online key</button>
          <button type="button" role="tab" aria-selected={tab === 'file'} className={tab === 'file' ? 'is-active' : ''} onClick={() => setTab('file')}>License file</button>
          <button type="button" role="tab" aria-selected={tab === 'onsite'} className={tab === 'onsite' ? 'is-active' : ''} onClick={() => setTab('onsite')}>On-site / offline</button>
        </div>

        {tab === 'online' && <form className="license-form" onSubmit={(event) => void submitOnline(event)}>
          {!summary.vendorConfigured && <p className="field-help">For production activation, import the Build Studio policy under On-site / offline first so the host has the trusted Ed25519 public key. Only the unpackaged local development mock can supply a temporary key itself.</p>}
          <label className="field"><span>License service URL <b>*</b></span><input type="url" required readOnly={Boolean(summary.licenseServerUrl)} value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="https://license.example.com" autoComplete="url" />{summary.licenseServerUrl && <small>This endpoint is pinned by the installed vendor configuration.</small>}</label>
          <label className="field"><span>Vendor activation key <b>*</b></span><input type="password" required value={activationKey} onChange={(event) => setActivationKey(event.target.value)} autoComplete="off" spellCheck={false} /></label>
          <p className="field-help">The activation key is sent only to the configured license service and is never written to local history or logs. Local mock testing uses the Mock License Console URL.</p>
          <button className="primary-button" type="submit" disabled={busy || !activationKey.trim() || !serverUrl.trim()}>{busy ? 'Checking…' : 'Activate online'} <span>→</span></button>
          {summary.licenseId && <button className="secondary-button" type="button" disabled={busy} onClick={() => void manualCheckIn()}>{busy ? 'Checking…' : 'Check for renewal / unlock'}</button>}
        </form>}

        {tab === 'file' && <div className="license-form">
          {!summary.vendorConfigured && <p className="field-help">Import the Build Studio policy under On-site / offline first so the host can verify the vendor’s trusted Ed25519 key.</p>}
          <p className="field-help">Import a vendor-signed Ed25519 <code>.lic</code> file. The host verifies its signature and machine binding before saving it.</p>
          <label className="license-file-picker">Choose signed license file<input type="file" accept=".lic,application/json,text/plain" disabled={busy} onChange={(event) => void importLicense(event)} /></label>
          {summary.licenseId && <button className="secondary-button" type="button" disabled={busy} onClick={() => void manualCheckIn()}>Check for renewal / unlock</button>}
        </div>}

        {tab === 'onsite' && <div className="onsite-workflow">
          {!summary.vendorConfigured && <div className="license-form vendor-setup">
            <div><h2>Import Build Studio vendor policy</h2><p>On-site activation and any maximum term are controlled by your vendor’s Build Studio policy. This desktop stores only the salted password hash and enforces the imported period limit.</p></div>
            <label className="license-file-picker">Import authorized vendor policy<input type="file" accept=".json,.iflpolicy,application/json" disabled={busy} onChange={(event) => void importVendorPolicy(event)} /></label>
            <small>Policy import does not change shop data. The exported policy contains public keys only; signing private keys are never included.</small>
          </div>}

          {summary.vendorConfigured && summary.status === 'tampered' && <div className="license-form vendor-policy-recovery">
            <h2>Rebind this installation</h2>
            <p>Import the same Build Studio policy used for this site after restoring or moving the computer. This rebinds license authentication only; license history and all shop data remain untouched.</p>
            <label className="license-file-picker">Reimport authorized vendor policy<input type="file" accept=".json,.iflpolicy,application/json" disabled={busy} onChange={(event) => void importVendorPolicy(event)} /></label>
          </div>}

          {summary.vendorConfigured && <>
            <form className="license-form onsite-form" onSubmit={(event) => void submitOnsite(event)}>
              <div className="onsite-heading"><div><h2>{summary.licenseId ? 'Renew or rebind on-site' : 'Create offline license'}</h2><p>Requires the vendor master password. This flow works without Internet access.</p></div><span className="onsite-limit">{summary.maximumOnsitePeriodYears === null ? 'No period cap' : `Max ${summary.maximumOnsitePeriodYears} years`}</span></div>
              <div className="field-grid">
                <label className="field"><span>Edition <b>*</b></span><select value={edition} onChange={(event) => setEdition(event.target.value as OnsiteActivationInput['edition'])}><option value="PHARMACY">Pharmacy</option><option value="SUPERMARKET">Supermarket</option><option value="BOTH">Pharmacy and Supermarket</option></select></label>
                <label className="field"><span>Start date <b>*</b></span><input type="date" required value={startsOn} onChange={(event) => setStartsOn(event.target.value)} /></label>
                <div className="field field--wide"><span>Term shortcuts</span><div className="license-term-shortcuts">{[1, 2, 3, 5].map((years) => <button key={years} type="button" className="secondary-button" disabled={busy} onClick={() => { try { setEndsOn(addYearsToDateInput(startsOn, years)) } catch (caught) { setError(errorMessage(caught)) } }}>{years} {years === 1 ? 'year' : 'years'}</button>)}</div></div>
                <label className="field"><span>Custom end date <b>*</b></span><input type="date" required min={startsOn} max={maxEndDate} value={endsOn} onChange={(event) => setEndsOn(event.target.value)} /><small>End date is exclusive: access locks at 00:00 UTC on this date.</small></label>
                <label className="field"><span>Default currency</span><select value={defaultCurrency} disabled={transactionLocked} onChange={(event) => setDefaultCurrency(event.target.value)}><option value="">No default</option>{CURRENCIES.map((currency) => <option key={currency.code} value={currency.code}>{currency.code} — {currency.name}</option>)}</select>{transactionLocked && <small className="locked-note">This shop has recorded a transaction. Currency is preserved as {settings.currency.code}.</small>}</label>
                <label className="field field--wide license-checkbox"><input type="checkbox" checked={lockCurrency} disabled={busy || !defaultCurrency || transactionLocked} onChange={(event) => setLockCurrency(event.target.checked)} /><span>Lock this default currency for shop setup</span></label>
                <fieldset className="license-feature-set field--wide"><legend>Mobile access</legend><label className="license-checkbox"><input type="checkbox" checked={mobileLan} onChange={(event) => setMobileLan(event.target.checked)} /><span>Local network (LAN)</span></label><label className="license-checkbox"><input type="checkbox" checked={mobileInternet} onChange={(event) => setMobileInternet(event.target.checked)} /><span>Internet access</span></label></fieldset>
                <label className="field"><span>Admin-phone limit <b>*</b></span><input type="number" min={1} max={100} step={1} required value={adminPhoneLimit} onChange={(event) => setAdminPhoneLimit(Number(event.target.value))} /><small>Limit is enforced by the host for phone pairing.</small></label>
                <label className="field"><span>Vendor master password <b>*</b></span><input type="password" required value={masterPassword} onChange={(event) => setMasterPassword(event.target.value)} autoComplete="current-password" /></label>
              </div>
              <button className="primary-button" type="submit" disabled={busy || !masterPassword || !startsOn || !endsOn}>{busy ? 'Verifying…' : summary.licenseId ? 'Renew / rebind license' : 'Activate offline'} <span>→</span></button>
            </form>
            <button className="secondary-button" type="button" disabled={busy || !summary.licenseId} onClick={() => void manualCheckIn()}>Report / check for renewal when online</button>
          </>}
        </div>}

        {error && <div className="form-error" role="alert"><span>!</span>{error}</div>}
        {success && <div className="license-success" role="status">{success}</div>}
        <div className="license-recovery"><strong>After expiry:</strong> restore the system clock if it was changed, connect to the license service and check in, import a valid signed file, or have the vendor renew/rebind on site. Your local database remains untouched.</div>
        <small className="license-version">Version {appVersion}</small>
      </section>
    </main>
  )
}

function editionLabel(edition: OnsiteActivationInput['edition']): string {
  if (edition === 'PHARMACY') return 'Pharmacy'
  if (edition === 'SUPERMARKET') return 'Supermarket'
  return 'Pharmacy and Supermarket'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'This license action could not be completed.'
}
