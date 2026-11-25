import { useMemo, useState, type ChangeEvent, type FormEvent } from 'react'
import { CUSTOM_CURRENCY_OPTION, CURRENCIES, createCustomCurrency, getCurrency, type CurrencyDefinition } from '@shared/currency/catalog'
import { defaultDisplayOptions, formatMoney, type MoneyDisplayOptions } from '@shared/currency/money'
import type { InfoflexBridge } from '@shared/bridge'
import type { FirstRunInput, ShopSettings, SetupContext, TeamSizeInput } from '@shared/shop/types'

interface Props {
  bridge: InfoflexBridge
  settings: ShopSettings
  context: SetupContext
  productName: string
  onComplete: () => void
}

/**
 * The three roles the Admin sizes, with the explanation the brief asks for in plain words.
 *
 * The role names come from `SIZED_ROLES` rather than being written here, so renaming a role or adding a fourth is one
 * edit; only the sentences, which are editorial, live in this file.
 */
const TEAM_ROLES: ReadonlyArray<{ key: 'account' | 'user' | 'supervisor'; label: string; summary: string }> = [
  {
    key: 'account',
    label: 'Account',
    summary: 'Takes payment and finalises orders. Prints receipts and invoices, processes returns, and counts their own cash at the end of the day.',
  },
  {
    key: 'user',
    label: 'User',
    summary: 'Picks goods and builds an order for the Account to finish. Cannot print, take payment or process returns.',
  },
  {
    key: 'supervisor',
    label: 'Supervisor',
    summary: 'Reads the audit trail and checks stock. Writes nothing except audit notes. Cannot sell or approve.',
  },
]

export function SetupScreen({ bridge, settings, context, productName, onComplete }: Props) {
  const initialCurrency = context.initialCurrency
  const [fullName, setFullName] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [storeName, setStoreName] = useState(settings.profile.name)
  const [address, setAddress] = useState(settings.profile.address)
  const [phone, setPhone] = useState(settings.profile.phone)
  const [email, setEmail] = useState(settings.profile.email ?? '')
  const [licenceNumber, setLicenceNumber] = useState(settings.profile.licenceNumber ?? '')
  const [taxNumber, setTaxNumber] = useState(settings.profile.taxNumber ?? '')
  const [storeLogo, setStoreLogo] = useState(settings.profile.storeLogo ?? '')
  const [receiptFooter, setReceiptFooter] = useState(settings.profile.receiptFooter ?? '')
  const [thankYouNote, setThankYouNote] = useState(settings.profile.thankYouNote ?? '')
  const [currencyCode, setCurrencyCode] = useState(initialCurrency.kind === 'custom' ? CUSTOM_CURRENCY_OPTION : initialCurrency.code)
  const [customCode, setCustomCode] = useState(initialCurrency.kind === 'custom' ? initialCurrency.code : '')
  const [customName, setCustomName] = useState(initialCurrency.kind === 'custom' ? initialCurrency.name : '')
  const [customSymbol, setCustomSymbol] = useState(initialCurrency.kind === 'custom' ? initialCurrency.symbol : '')
  const [customDecimals, setCustomDecimals] = useState(initialCurrency.kind === 'custom' ? initialCurrency.decimalPlaces : 2)
  const [currencySearch, setCurrencySearch] = useState('')
  const [display, setDisplay] = useState<MoneyDisplayOptions>(settings.currencyConfirmed ? settings.display : defaultDisplayOptions(initialCurrency))
  const [currencyConfirmed, setCurrencyConfirmed] = useState(false)
  // Team size. Seeded from the setup context so the form arrives with a workable shop — one Account for the till and
  // one User for the floor — rather than with zeroes the customer has to notice and change.
  const [teamSize, setTeamSize] = useState<TeamSizeInput>(context.seatDefaults)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const selectedCurrency = useMemo(() => {
    if (currencyCode !== CUSTOM_CURRENCY_OPTION) return getCurrency(currencyCode)
    if (!customCode.trim() || !customName.trim() || !customSymbol.trim()) return undefined
    try {
      return createCustomCurrency({
        code: customCode,
        name: customName,
        symbol: customSymbol,
        decimalPlaces: customDecimals,
        symbolPosition: display.symbolPosition,
        thousandsSeparator: display.thousandsSeparator,
        decimalSeparator: display.decimalSeparator,
      })
    } catch {
      return undefined
    }
  }, [currencyCode, customCode, customName, customSymbol, customDecimals, display])

  const filteredCurrencies = CURRENCIES.filter((currency) => {
    const needle = currencySearch.trim().toLowerCase()
    return !needle || `${currency.code} ${currency.name}`.toLowerCase().includes(needle)
  })

  function selectCurrency(code: string): void {
    setCurrencyCode(code)
    setError('')
    if (code !== CUSTOM_CURRENCY_OPTION) {
      const currency = getCurrency(code)
      if (currency) setDisplay(defaultDisplayOptions(currency))
    }
  }

  function updateDisplay<K extends keyof MoneyDisplayOptions>(key: K, value: MoneyDisplayOptions[K]): void {
    setDisplay((current) => ({ ...current, [key]: value }))
  }

  async function chooseLogo(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 1_000_000) {
      setError('Choose a PNG, JPEG, or WebP logo smaller than 1 MB.')
      return
    }
    const dataUrl = await readFileDataUrl(file)
    setStoreLogo(dataUrl)
    setError('')
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setError('')
    if (!storeName.trim()) {
      setError('Enter your store name; it is required on customer documents.')
      document.getElementById('store-name')?.focus()
      return
    }
    if (!fullName.trim() || !username.trim() || !password || !confirmPassword) {
      setError('Complete every required Admin account field.')
      return
    }
    if (!selectedCurrency) {
      setError('Complete the custom currency details before continuing.')
      return
    }
    if (!currencyConfirmed) {
      setError('Confirm the shop currency before continuing.')
      return
    }
    if (context.currencyLocked && selectedCurrency.code !== context.initialCurrency.code) {
      setError('The shop currency is locked and cannot be changed.')
      return
    }

    setSaving(true)
    try {
      const input: FirstRunInput = {
        admin: { fullName, username, password, confirmPassword },
        profile: {
          name: storeName,
          address,
          phone,
          email,
          licenceNumber,
          taxNumber,
          storeLogo: storeLogo || null,
          receiptFooter,
          thankYouNote,
        },
        currency: selectedCurrency,
        display,
        currencyConfirmed,
        teamSize,
      }
      await bridge.completeFirstRun(input)
      onComplete()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  const passwordStrength = strengthLabel(password)

  return (
    <main className="setup-screen">
      <aside className="brand-panel" aria-label="Infoflex brand">
        <div className="brand-panel__content">
          <div className="brand-logo-wrap"><img src="/logo-source.png" alt="Infoflex — Strategy | Consulting | Innovation" /></div>
          <div className="brand-copy">
            <span className="eyebrow">{productName.toUpperCase()}</span>
            <h1>Good business<br />starts with a clear picture.</h1>
            <p>Set up your Admin account, store identity, and the currency used throughout this shop.</p>
          </div>
          <div className="brand-panel__footer"><span className="gold-rule" /><span>Strategy | Consulting | Innovation</span></div>
        </div>
      </aside>

      <section className="setup-area">
        <header className="topbar">
          <div className="compact-brand"><img src="/branding/logo-transparent.png" alt="" /><span>{productName}</span></div>
          <span className="setup-stage-badge">FIRST-RUN SETUP</span>
        </header>
        <div className="setup-content setup-content--wide">
          <div className="page-intro">
            <span className="eyebrow eyebrow--gold">WELCOME TO {productName.toUpperCase()}</span>
            <h2>Make this shop yours.</h2>
            <p>Set up the Admin who controls this installation, then enter the store details customers should see.</p>
          </div>

          <form className="setup-form" onSubmit={submit}>
            <section className="form-section" aria-labelledby="admin-heading">
              <div className="section-heading"><span className="section-number">01</span><div><h3 id="admin-heading">Admin account</h3><p>This is the first and highest-privilege user. There is no public sign-up or password recovery.</p></div></div>
              <div className="field-grid">
                <label className="field" htmlFor="admin-full-name"><span>Full name <b>*</b></span><input id="admin-full-name" required maxLength={120} autoComplete="name" value={fullName} onChange={(event) => setFullName(event.target.value)} /></label>
                <label className="field" htmlFor="admin-username"><span>Username <b>*</b></span><input id="admin-username" required maxLength={32} autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value.toLowerCase())} placeholder="3–32 letters, numbers, dot, _ or -" /></label>
                <label className="field" htmlFor="admin-password"><span>Password <b>*</b></span><input id="admin-password" required type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /><small className={`password-strength strength-${passwordStrength.toLowerCase()}`}>Strength: {passwordStrength} · use 10+ characters and a mix of character types.</small></label>
                <label className="field" htmlFor="admin-confirm-password"><span>Confirm password <b>*</b></span><input id="admin-confirm-password" required type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
              </div>
            </section>

            <section className="form-section" aria-labelledby="business-heading">
              <div className="section-heading"><span className="section-number">02</span><div><h3 id="business-heading">Store details</h3><p>The name and contact details are printed on customer documents and snapshotted on each sale and return.</p></div></div>
              <div className="field-grid">
                <label className="field field--wide" htmlFor="store-name"><span>{context.edition === 'PHARMACY' ? 'Pharmacy Name' : context.edition === 'SUPERMARKET' ? 'Supermarket Name' : 'Business Name'} <b>*</b></span><input id="store-name" required maxLength={120} autoComplete="organization" value={storeName} onChange={(event) => setStoreName(event.target.value)} placeholder="Enter the name your customers know" /></label>
                <label className="field field--wide" htmlFor="store-address"><span>Address</span><input id="store-address" maxLength={240} autoComplete="street-address" value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Street, area, city" /></label>
                <label className="field" htmlFor="store-phone"><span>Phone number(s)</span><input id="store-phone" maxLength={160} autoComplete="tel" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="Separate multiple numbers with commas" /></label>
                <label className="field" htmlFor="store-email"><span>Email</span><input id="store-email" type="email" maxLength={120} autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
                <label className="field" htmlFor="store-licence"><span>Regulatory / licence number</span><input id="store-licence" maxLength={100} value={licenceNumber} onChange={(event) => setLicenceNumber(event.target.value)} placeholder="Optional · PCN / NAFDAC" /></label>
                <label className="field" htmlFor="store-tax"><span>Tax / VAT number</span><input id="store-tax" maxLength={100} value={taxNumber} onChange={(event) => setTaxNumber(event.target.value)} placeholder="Optional" /></label>
                <label className="field field--wide" htmlFor="store-logo"><span>Store logo <small>Optional</small></span><input id="store-logo" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void chooseLogo(event)} /><small>PNG, JPEG or WebP up to 1 MB. The logo stays in this shop database.</small>{storeLogo && <div className="store-logo-preview"><img src={storeLogo} alt="Store logo preview" /><button type="button" className="text-button" onClick={() => setStoreLogo('')}>Remove logo</button></div>}</label>
                <label className="field" htmlFor="receipt-footer"><span>Receipt footer</span><input id="receipt-footer" maxLength={300} value={receiptFooter} onChange={(event) => setReceiptFooter(event.target.value)} placeholder="Optional" /></label>
                <label className="field" htmlFor="thank-you"><span>Thank-you note</span><input id="thank-you" maxLength={200} value={thankYouNote} onChange={(event) => setThankYouNote(event.target.value)} placeholder="Optional" /></label>
              </div>
              <div className="receipt-mini-preview" aria-live="polite">
                <span className="live-preview-label">RECEIPT HEADER PREVIEW</span>
                <strong>{storeName.trim() || 'Your store name'}</strong>
                {address.trim() && <span>{address}</span>}
                {phone.trim() && <span>{phone}</span>}
                <b>{selectedCurrency ? safeFormat(123456789n, selectedCurrency, display) : 'Complete currency details to preview'}</b>
                {receiptFooter.trim() && <small>{receiptFooter}</small>}
              </div>
            </section>

            <section className="form-section" aria-labelledby="currency-heading">
              <div className="section-heading"><span className="section-number">03</span><div><h3 id="currency-heading">Currency</h3><p>One currency is used for this shop. Amounts are stored as integer minor units and formatted from these settings.</p></div></div>
              <div className="field-grid field-grid--currency">
                {!context.currencyLocked && <label className="field field--wide" htmlFor="currency-search"><span>Search currencies</span><input id="currency-search" type="search" value={currencySearch} onChange={(event) => setCurrencySearch(event.target.value)} placeholder="Search by currency code or name" /></label>}
                <label className="field field--wide" htmlFor="currency"><span>Shop currency <b>*</b></span><select id="currency" value={currencyCode} onChange={(event) => selectCurrency(event.target.value)} disabled={context.currencyLocked}>
                  {filteredCurrencies.map((currency) => <option key={currency.code} value={currency.code}>{currency.code} — {currency.name}</option>)}
                  <option value={CUSTOM_CURRENCY_OPTION}>Custom currency…</option>
                </select>
                  {context.vendorCurrencyLocked && <small className="locked-note">Set by your vendor</small>}
                  {!context.vendorCurrencyLocked && context.currencyLocked && <small className="locked-note">Currency is locked because this shop already has a transaction.</small>}
                </label>
                {currencyCode === CUSTOM_CURRENCY_OPTION && !context.currencyLocked && <div className="custom-currency field--wide">
                  <label className="field" htmlFor="custom-code"><span>Currency code <b>*</b></span><input id="custom-code" required maxLength={8} value={customCode} onChange={(event) => setCustomCode(event.target.value.toUpperCase())} placeholder="e.g. CRD" /></label>
                  <label className="field" htmlFor="custom-name"><span>Currency name <b>*</b></span><input id="custom-name" required maxLength={80} value={customName} onChange={(event) => setCustomName(event.target.value)} /></label>
                  <label className="field" htmlFor="custom-symbol"><span>Symbol <b>*</b></span><input id="custom-symbol" required maxLength={12} value={customSymbol} onChange={(event) => setCustomSymbol(event.target.value)} /></label>
                  <label className="field" htmlFor="custom-decimals"><span>Decimal places</span><select id="custom-decimals" value={customDecimals} onChange={(event) => setCustomDecimals(Number(event.target.value))}>{[0, 1, 2, 3, 4].map((places) => <option key={places} value={places}>{places}</option>)}</select></label>
                </div>}
                <div className="display-options field--wide">
                  <div className="display-options__title"><span>Amount display</span><span className="live-preview-label">LIVE PREVIEW</span></div>
                  <div className="display-options__controls">
                    <label className="field"><span>Show</span><select value={display.amountDisplay} onChange={(event) => updateDisplay('amountDisplay', event.target.value as MoneyDisplayOptions['amountDisplay'])}><option value="symbol">Currency symbol</option><option value="code">ISO / custom code</option></select></label>
                    <label className="field"><span>Symbol position</span><select value={display.symbolPosition} onChange={(event) => updateDisplay('symbolPosition', event.target.value as MoneyDisplayOptions['symbolPosition'])}><option value="before">Before amount</option><option value="after">After amount</option></select></label>
                    <label className="field"><span>Thousands separator</span><select value={display.thousandsSeparator} onChange={(event) => updateDisplay('thousandsSeparator', event.target.value)}><option value=",">Comma</option><option value=".">Period</option><option value=" ">Space</option><option value=" ">Narrow space</option><option value="'">Apostrophe</option><option value="">None</option></select></label>
                    <label className="field"><span>Decimal separator</span><select value={display.decimalSeparator} onChange={(event) => updateDisplay('decimalSeparator', event.target.value)}><option value=".">Period</option><option value=",">Comma</option></select></label>
                  </div>
                  <div className="amount-preview"><span>Example amount</span><strong>{selectedCurrency ? safeFormat(123456789n, selectedCurrency, display) : 'Complete custom currency details to preview'}</strong></div>
                </div>
              </div>
              <label className="confirmation"><input type="checkbox" checked={currencyConfirmed} onChange={(event) => setCurrencyConfirmed(event.target.checked)} /><span>I confirm this is the currency for this shop. Currency locks after the first sale, purchase, return, or stock valuation.</span></label>
            </section>

            <section className="form-section" aria-labelledby="team-heading">
              <div className="section-heading"><span className="section-number">04</span><div><h3 id="team-heading">Team size</h3><p>How many people will use this shop? Each becomes a seat with its own sign-in. You can change these later, but not below the accounts already in use, and never above what your licence allows.</p></div></div>
              <div className="field-grid field-grid--team">
                {TEAM_ROLES.map((entry) => {
                  const cap = context.seatCaps[entry.key]
                  const value = teamSize[entry.key]
                  return (
                    <div className="seat-stepper" key={entry.key}>
                      <div className="seat-stepper__heading">
                        <strong>{entry.label}</strong>
                        {cap !== null && <span className="seat-cap">{cap === 0 ? 'Not on this licence' : `Up to ${cap}`}</span>}
                      </div>
                      <p className="seat-stepper__note">{entry.summary}</p>
                      <div className="seat-stepper__controls">
                        <button type="button" aria-label={`One fewer ${entry.label}`} disabled={saving || value <= 0} onClick={() => setTeamSize((current) => ({ ...current, [entry.key]: Math.max(0, current[entry.key] - 1) }))}>−</button>
                        <input
                          aria-label={`Number of ${entry.label} seats`}
                          type="number" min={0} max={cap ?? 500} inputMode="numeric" value={value}
                          onChange={(event) => {
                            const next = Number(event.target.value)
                            // Clamped at the cap rather than merely warned about: the server refuses either way, and a
                            // field that lets the customer type a refused number only to fail on submit wastes their time.
                            const clamped = Number.isFinite(next) ? Math.min(Math.max(Math.trunc(next), 0), cap ?? 500) : 0
                            setTeamSize((current) => ({ ...current, [entry.key]: clamped }))
                          }}
                        />
                        <button type="button" aria-label={`One more ${entry.label}`} disabled={saving || (cap !== null && value >= cap)} onClick={() => setTeamSize((current) => ({ ...current, [entry.key]: Math.min(current[entry.key] + 1, cap ?? 500) }))}>+</button>
                      </div>
                    </div>
                  )
                })}
              </div>
              <p className="seat-note">Each new seat starts with no password, shown as <b>Needs password</b> on the Users and Seats screen. A seat without a password cannot sign in. Give it a name and a password before that person starts.</p>
            </section>

            {error && <div className="form-error" role="alert"><span>!</span>{error}</div>}
            <div className="form-actions"><span className="required-note"><b>*</b> Required</span><button className="primary-button" type="submit" disabled={saving || !currencyConfirmed}>{saving ? 'Saving securely…' : 'Create Admin and continue'} <span aria-hidden="true">→</span></button></div>
          </form>
          <footer className="setup-footnote">Admin password is stored as a bcrypt salted hash. Shop information stays in the local host database.</footer>
        </div>
      </section>
    </main>
  )
}

function strengthLabel(value: string): 'Weak' | 'Fair' | 'Good' | 'Strong' {
  if (value.length < 10) return 'Weak'
  const categoryCount = [/[a-z]/.test(value), /[A-Z]/.test(value), /\d/.test(value), /[^A-Za-z0-9]/.test(value)].filter(Boolean).length
  if (categoryCount < 3) return 'Fair'
  if (value.length >= 16 && categoryCount === 4) return 'Strong'
  return 'Good'
}

function safeFormat(amount: bigint, currency: CurrencyDefinition, display: MoneyDisplayOptions): string {
  try { return formatMoney(amount, currency, display) } catch { return 'Check separator settings.' }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to save first-run settings. Please try again.'
}

function readFileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('The selected store logo could not be read.'))
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('The selected logo is not a supported image.'))
    reader.readAsDataURL(file)
  })
}
