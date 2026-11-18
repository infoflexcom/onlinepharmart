import { useState, type ChangeEvent, type FormEvent } from 'react'
import { CUSTOM_CURRENCY_OPTION, CURRENCIES, createCustomCurrency, getCurrency, type CurrencyDefinition } from '@shared/currency/catalog'
import { formatMoney, type MoneyDisplayOptions } from '@shared/currency/money'
import type { InfoflexBridge } from '@shared/bridge'
import type { AppPage } from '@shared/auth/types'
import type { LicenseSummary } from '@shared/license/types'
import type { ShopProfile, ShopSettings } from '@shared/shop/types'
import { TRANSACTION_CURRENCY_LOCK_MESSAGE, VENDOR_CURRENCY_LOCK_MESSAGE } from '@shared/currency/lock-messages'
import { BackupPanel, LicensePanel, ReceiptPreviewPanel, ReceiptSettingsPanel } from './SettingsPanels'

interface Props {
  bridge: InfoflexBridge
  settings: ShopSettings
  license: LicenseSummary
  onSaved: (settings: ShopSettings) => void
  onNavigate?: (page: AppPage) => void
}

const MAX_LOGO_DATA_URL = 1_400_000

export function SettingsScreen({ bridge, settings, license, onSaved, onNavigate }: Props) {
  const [licenseSummary, setLicenseSummary] = useState<LicenseSummary>(license)
  const [profile, setProfile] = useState<ShopProfile>({ ...settings.profile })
  const [display, setDisplay] = useState<MoneyDisplayOptions>({ ...settings.display })
  const [currencyCode, setCurrencyCode] = useState(settings.currency.kind === 'custom' ? CUSTOM_CURRENCY_OPTION : settings.currency.code)
  const [customCode, setCustomCode] = useState(settings.currency.kind === 'custom' ? settings.currency.code : '')
  const [customName, setCustomName] = useState(settings.currency.kind === 'custom' ? settings.currency.name : '')
  const [customSymbol, setCustomSymbol] = useState(settings.currency.kind === 'custom' ? settings.currency.symbol : '')
  const [customDecimals, setCustomDecimals] = useState(settings.currency.decimalPlaces)
  const [currencyQuery, setCurrencyQuery] = useState('')
  const [idleTimeout, setIdleTimeout] = useState(settings.idleTimeoutMinutes ?? 15)
  const [returnWindowDays, setReturnWindowDays] = useState(settings.returnWindowDays ?? 7)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const visibleCurrencies = CURRENCIES.filter((currency) => {
    const query = currencyQuery.trim().toLowerCase()
    if (!query) return true
    return currency.code.toLowerCase().includes(query) || currency.name.toLowerCase().includes(query)
  })
  const selectedCurrency: CurrencyDefinition | undefined = currencyCode === CUSTOM_CURRENCY_OPTION
    ? safeCustomCurrency(customCode, customName, customSymbol, customDecimals, display)
    : getCurrency(currencyCode)

  function updateProfile<K extends keyof ShopProfile>(key: K, value: ShopProfile[K]): void {
    setProfile((current) => ({ ...current, [key]: value }))
  }

  /** Reads the picked image in the renderer only; the validated data URL is what gets stored. */
  async function chooseLogo(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setError('')
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setError('Choose a PNG, JPEG, or WebP image for the shop logo.')
      return
    }
    const dataUrl = await new Promise<string | undefined>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : undefined)
      reader.onerror = () => resolve(undefined)
      reader.readAsDataURL(file)
    })
    if (!dataUrl) {
      setError('That image could not be read. Try another file.')
      return
    }
    if (dataUrl.length > MAX_LOGO_DATA_URL) {
      setError('Choose a logo smaller than 1 MB.')
      return
    }
    updateProfile('storeLogo', dataUrl)
  }

  function updateDisplay<K extends keyof MoneyDisplayOptions>(key: K, value: MoneyDisplayOptions[K]): void {
    setDisplay((current) => ({ ...current, [key]: value }))
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setError('')
    setStatus('')
    setSaving(true)
    try {
      onSaved(await bridge.updateStoreDetails(profile))
      setStatus('Store details saved.')
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  async function saveDisplay(): Promise<void> {
    setError('')
    setStatus('')
    setSaving(true)
    try {
      onSaved(await bridge.updateDisplaySettings(display))
      setStatus('Amount display preferences saved.')
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  async function saveCurrency(): Promise<void> {
    if (!selectedCurrency) {
      setError('Complete the custom currency details.')
      return
    }
    if (selectedCurrency.code === settings.currency.code) {
      setStatus('This is already the selected currency.')
      return
    }
    if (!window.confirm('Changing the shop currency is allowed only before the first sale, purchase, return or stock valuation. Continue?')) return
    setError('')
    setStatus('')
    setSaving(true)
    try {
      const updated = await bridge.changeCurrency(selectedCurrency, true)
      onSaved(updated)
      setStatus('Shop currency updated.')
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  async function saveIdleTimeout(): Promise<void> {
    setError('')
    setStatus('')
    try {
      onSaved(await bridge.updateIdleTimeout(idleTimeout))
      setStatus('Automatic sign-out time saved.')
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  async function saveReturnWindow(): Promise<void> {
    setError('')
    setStatus('')
    setSaving(true)
    try {
      onSaved(await bridge.updateReturnWindowDays(returnWindowDays))
      setStatus('Return window saved. Each new return request records the policy applied at the time.')
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings-stack">
      <section className="management-card">
        <div className="management-card__header"><div><span className="eyebrow eyebrow--gold">ADMIN SETTINGS</span><h2>Store details</h2><p>Only an Admin can edit the store identity used on future documents.</p></div></div>
        <form className="settings-form-grid" onSubmit={(event) => void saveProfile(event)}>
          <label className="field field--wide"><span>Store name <b>*</b></span><input required maxLength={120} value={profile.name} onChange={(event) => updateProfile('name', event.target.value)} /></label>
          <label className="field field--wide"><span>Address</span><input maxLength={240} value={profile.address} onChange={(event) => updateProfile('address', event.target.value)} /></label>
          <label className="field"><span>Phone number(s)</span><input maxLength={160} value={profile.phone} onChange={(event) => updateProfile('phone', event.target.value)} /></label>
          <label className="field"><span>Email</span><input type="email" maxLength={120} value={profile.email ?? ''} onChange={(event) => updateProfile('email', event.target.value)} /></label>
          <label className="field"><span>Regulatory / licence number</span><input maxLength={100} value={profile.licenceNumber ?? ''} onChange={(event) => updateProfile('licenceNumber', event.target.value)} /></label>
          <label className="field"><span>Tax / VAT number</span><input maxLength={100} value={profile.taxNumber ?? ''} onChange={(event) => updateProfile('taxNumber', event.target.value)} /></label>
          <label className="field"><span>Receipt footer</span><input maxLength={300} value={profile.receiptFooter ?? ''} onChange={(event) => updateProfile('receiptFooter', event.target.value)} /></label>
          <label className="field"><span>Thank-you note</span><input maxLength={200} value={profile.thankYouNote ?? ''} onChange={(event) => updateProfile('thankYouNote', event.target.value)} /></label>
          <div className="field field--wide">
            <span>Shop logo</span>
            {profile.storeLogo
              ? <div className="store-logo-preview"><img src={profile.storeLogo} alt="Current shop logo" /><button type="button" className="text-button" onClick={() => updateProfile('storeLogo', null)}>Remove</button></div>
              : <small>No logo yet. A PNG, JPEG, or WebP under 1 MB prints on customer documents.</small>}
            <label className="file-pick-button">
              <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void chooseLogo(event)} />
              <span>{profile.storeLogo ? 'Replace logo…' : 'Choose logo…'}</span>
            </label>
          </div>
          <div className="settings-form-actions field--wide"><button className="primary-button" disabled={saving} type="submit">Save store details</button></div>
        </form>
      </section>

      <section className="management-card">
        <div className="management-card__header"><div><span className="eyebrow eyebrow--gold">CURRENCY</span><h2>Currency and amount display</h2><p>Display formatting can be changed at any time. The currency itself is locked once transactions exist, or when your vendor set it.</p></div></div>
        <div className="settings-form-grid">
          <label className="field"><span>Shop currency</span><select value={currencyCode} disabled={settings.currencyLocked} onChange={(event) => setCurrencyCode(event.target.value)}>{visibleCurrencies.map((currency) => <option key={currency.code} value={currency.code}>{currency.code} — {currency.name}</option>)}{visibleCurrencies.length === 0 && <option disabled value="">No currency matches that search</option>}<option value={CUSTOM_CURRENCY_OPTION}>Custom currency…</option></select>{settings.currencyLocked && <small className="locked-note">{settings.currencyLockedByVendor ? VENDOR_CURRENCY_LOCK_MESSAGE : TRANSACTION_CURRENCY_LOCK_MESSAGE}</small>}</label>
          <label className="field"><span>Search currencies</span><input type="search" placeholder="Type a code or name, e.g. NGN or naira" value={currencyQuery} disabled={settings.currencyLocked} onChange={(event) => setCurrencyQuery(event.target.value)} /></label>
          <p className="settings-note field--wide">{settings.currencyLocked ? 'The shop currency is read-only. Amount display preferences below can still be changed.' : `Showing ${visibleCurrencies.length} of ${CURRENCIES.length} currencies. Choosing one changes only how amounts are labelled, never an amount already stored.`}</p>
          {currencyCode === CUSTOM_CURRENCY_OPTION && !settings.currencyLocked && <div className="custom-currency field--wide">
            <label className="field"><span>Code</span><input maxLength={8} value={customCode} onChange={(event) => setCustomCode(event.target.value.toUpperCase())} /></label>
            <label className="field"><span>Name</span><input maxLength={80} value={customName} onChange={(event) => setCustomName(event.target.value)} /></label>
            <label className="field"><span>Symbol</span><input maxLength={12} value={customSymbol} onChange={(event) => setCustomSymbol(event.target.value)} /></label>
            <label className="field"><span>Decimal places</span><select value={customDecimals} onChange={(event) => setCustomDecimals(Number(event.target.value))}>{[0,1,2,3,4].map((places) => <option key={places} value={places}>{places}</option>)}</select></label>
          </div>}
          {!settings.currencyLocked && <div className="field field--wide"><span>Currency change</span><button className="secondary-button" type="button" disabled={saving} onClick={() => void saveCurrency()}>Save selected currency</button></div>}
          <div className="display-options field--wide">
            <div className="display-options__title"><span>Display preferences</span><span className="live-preview-label">LIVE PREVIEW · {selectedCurrency?.code ?? settings.currency.code}</span></div>
            <div className="display-options__controls">
              <label className="field"><span>Show</span><select value={display.amountDisplay} onChange={(event) => updateDisplay('amountDisplay', event.target.value as MoneyDisplayOptions['amountDisplay'])}><option value="symbol">Currency symbol</option><option value="code">ISO / custom code</option></select></label>
              <label className="field"><span>Position</span><select value={display.symbolPosition} onChange={(event) => updateDisplay('symbolPosition', event.target.value as MoneyDisplayOptions['symbolPosition'])}><option value="before">Before amount</option><option value="after">After amount</option></select></label>
              <label className="field"><span>Thousands</span><select value={display.thousandsSeparator} onChange={(event) => updateDisplay('thousandsSeparator', event.target.value)}><option value=",">Comma</option><option value=".">Period</option><option value=" ">Space</option><option value="">None</option></select></label>
              <label className="field"><span>Decimal</span><select value={display.decimalSeparator} onChange={(event) => updateDisplay('decimalSeparator', event.target.value)}><option value=".">Period</option><option value=",">Comma</option></select></label>
            </div>
            <div className="amount-preview"><span>Example amount</span><strong>{safeFormat(selectedCurrency ?? settings.currency, display)}</strong></div>
            <button className="secondary-button" type="button" disabled={saving} onClick={() => void saveDisplay()}>Save display preferences</button>
          </div>
        </div>
      </section>

      <section className="management-card">
        <div className="management-card__header"><div><span className="eyebrow eyebrow--gold">SECURITY</span><h2>Automatic sign-out</h2><p>Idle sessions are expired by the host, not just hidden by the screen.</p></div></div>
        <div className="idle-timeout-row"><label className="field"><span>Sign out after inactivity</span><select value={idleTimeout} onChange={(event) => setIdleTimeout(Number(event.target.value))}>{[1,5,10,15,30,60,120,240].map((minutes) => <option key={minutes} value={minutes}>{minutes} minute{minutes === 1 ? '' : 's'}</option>)}</select></label><button className="secondary-button" type="button" onClick={() => void saveIdleTimeout()}>Save timeout</button></div>
      </section>
      <section className="management-card">
        <div className="management-card__header"><div><span className="eyebrow eyebrow--gold">RETURNS</span><h2>Return window</h2><p>Cashier returns are accepted within this rolling window. Admins may record a reasoned override; high-value requests still require approval.</p></div></div>
        <div className="idle-timeout-row"><label className="field"><span>Return window (days)</span><input type="number" min={1} max={365} step={1} value={returnWindowDays} onChange={(event) => setReturnWindowDays(Number(event.target.value))} /></label><button className="secondary-button" type="button" disabled={saving} onClick={() => void saveReturnWindow()}>Save return window</button></div>
      </section>
      <ReceiptPreviewPanel settings={settings} profile={profile} display={display} />
      <ReceiptSettingsPanel bridge={bridge} settings={settings} onSaved={(next) => { onSaved(next); setStatus('Receipt settings saved.') }} />
      <LicensePanel bridge={bridge} license={licenseSummary} onChecked={setLicenseSummary} />

      <section className="management-card">
        <div className="management-card__header">
          <div><span className="eyebrow eyebrow--gold">MOBILE ACCESS</span><h2>Phones and tablets</h2><p>Pair a phone, set who can use it, and see which devices are connected.</p></div>
        </div>
        <div className="settings-form-actions">
          <button className="secondary-button" type="button" onClick={() => onNavigate?.('mobile')}>Open Mobile Access</button>
        </div>
      </section>

      <BackupPanel bridge={bridge} />

      {error && <div className="form-error" role="alert"><span>!</span>{error}</div>}
      {status && <div className="success-message" role="status">{status}</div>}
    </div>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Settings could not be saved. Please try again.'
}

function safeCustomCurrency(code: string, name: string, symbol: string, decimals: number, display: MoneyDisplayOptions): CurrencyDefinition | undefined {
  try {
    if (!code || !name || !symbol) return undefined
    return createCustomCurrency({ code, name, symbol, decimalPlaces: decimals, symbolPosition: display.symbolPosition, thousandsSeparator: display.thousandsSeparator, decimalSeparator: display.decimalSeparator })
  } catch { return undefined }
}

function safeFormat(currency: CurrencyDefinition, display: MoneyDisplayOptions): string {
  try { return formatMoney(123456789n, currency, display) } catch { return 'Check separator settings.' }
}
