import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { getCurrency } from '@shared/currency/catalog'
import { defaultDisplayOptions } from '@shared/currency/money'
import { DEFAULT_OPERATIONAL_SETTINGS, type ShopProfile, type ShopSettings } from '@shared/shop/types'
import type { PosReceiptRecord } from '@shared/pos/types'
import type { LicenseSummary } from '@shared/license/types'
import { PosReceiptDocument } from './PosReceiptDocument'
import { ReceiptPreviewPanel } from './SettingsPanels'
import { SettingsScreen } from './SettingsScreen'

const NGN = getCurrency('NGN')!

function license(overrides: Partial<LicenseSummary> = {}): LicenseSummary {
  return {
    status: 'active', canUse: true, licenseId: 'lic-1', source: 'online', edition: 'BOTH',
    startsAt: '2026-01-01', endsAt: '2027-01-01', defaultCurrencyCode: null, lockCurrency: false,
    features: { mobileLan: true, mobileInternet: false }, adminPhoneLimit: 2, graceDays: 7,
    lastOnlineCheck: '2026-11-17T08:00:00.000Z', reportedToPortal: true, vendorConfigured: true,
    maximumOnsitePeriodYears: 5, licenseServerUrl: null, message: '',
    ...overrides,
  }
}

function settings(overrides: Partial<ShopSettings> = {}): ShopSettings {
  return {
    profile: { name: 'Harbor Health', address: '12 Dock Road', phone: '+234 1 555 0100' },
    currency: NGN,
    display: defaultDisplayOptions(NGN),
    setupComplete: true,
    currencyConfirmed: true,
    currencyLocked: false,
    operational: { ...DEFAULT_OPERATIONAL_SETTINGS },
    ...overrides,
  }
}

function receipt(overrides: Partial<PosReceiptRecord> = {}): PosReceiptRecord {
  return {
    id: 1,
    receiptNumber: 'R-0000000042',
    status: 'COMPLETED',
    saleType: 'RETAIL',
    createdAt: '2026-11-17T10:00:00.000Z',
    currency: NGN,
    display: defaultDisplayOptions(NGN),
    store: { name: 'Harbor Health', address: '12 Dock Road', phone: '+234 1 555 0100' },
    customer: null,
    cashier: 'Jane Admin',
    workstation: 'TILL-PC',
    items: [],
    payments: [{ id: 'p1', method: 'CASH', amountMinor: 250_000n, reference: '' } as never],
    subtotalMinor: 250_000n,
    promotionDiscountMinor: 0n,
    promotionName: '',
    manualDiscountMinor: 0n,
    loyaltyDiscountMinor: 0n,
    loyaltyPointsEarned: 0,
    loyaltyPointsRedeemed: 0,
    discountMinor: 0n,
    taxMinor: 0n,
    totalMinor: 250_000n,
    paidMinor: 250_000n,
    creditMinor: 0n,
    tenderedMinor: 0n,
    changeMinor: 0n,
    prescriptionAcknowledged: false,
    warnings: [],
    duplicate: false,
    printCount: 1,
    ...overrides,
  }
}

describe('settings live receipt preview', () => {
  it('shows the edited store name as it will be typed on the next receipt', () => {
    const shop = settings({ profile: { name: 'Green Cross Chemist', address: '', phone: '' } })
    const html = renderToStaticMarkup(<ReceiptPreviewPanel settings={shop} profile={shop.profile} display={shop.display} />)
    expect(html).toContain('Green Cross Chemist')
    expect(html).not.toContain('Harbor Health')
  })

  it('falls back to a placeholder instead of an empty receipt when the name is blank', () => {
    const shop = settings({ profile: { name: '', address: '', phone: '' } })
    const html = renderToStaticMarkup(<ReceiptPreviewPanel settings={shop} profile={shop.profile} display={shop.display} />)
    expect(html).toContain('Your store name')
  })

  it('follows the display options without changing the amount', () => {
    const codeShop = settings({
      display: { amountDisplay: 'code', symbolPosition: 'after', thousandsSeparator: ',', decimalSeparator: '.' },
    })
    const html = renderToStaticMarkup(<ReceiptPreviewPanel settings={codeShop} profile={codeShop.profile} display={codeShop.display} />)
    expect(html).toContain('2,500.00 NGN')
  })

  it('shows VAT only when it is switched on', () => {
    const off = renderToStaticMarkup(
      <ReceiptPreviewPanel settings={settings()} profile={settings().profile} display={settings().display} />,
    )
    expect(off).not.toMatch(/VAT \d/)

    const on = settings({ operational: { ...DEFAULT_OPERATIONAL_SETTINGS, vatEnabled: true, vatRateBasisPoints: 750 } })
    const html = renderToStaticMarkup(<ReceiptPreviewPanel settings={on} profile={on.profile} display={on.display} />)
    expect(html).toContain('VAT 7.5%')
  })

  it('names the chosen paper size on the preview', () => {
    const shop = settings({ operational: { ...DEFAULT_OPERATIONAL_SETTINGS, documentLayout: 'THERMAL_58' } })
    const html = renderToStaticMarkup(<ReceiptPreviewPanel settings={shop} profile={shop.profile} display={shop.display} />)
    expect(html).toContain('58 mm thermal till roll')
    expect(html).toContain('receipt-live-preview--thermal_58')
  })

  it('prints the footer, thank-you note, and the Infoflex line only when switched on', () => {
    const profile: ShopProfile = { name: 'Harbor Health', address: '', phone: '', receiptFooter: 'No refunds after 7 days', thankYouNote: 'Thank you' }
    const withBrand = settings({ profile })
    const html = renderToStaticMarkup(<ReceiptPreviewPanel settings={withBrand} profile={profile} display={withBrand.display} />)
    expect(html).toContain('No refunds after 7 days')
    expect(html).toContain('Thank you')
    expect(html).toContain('Powered by Infoflex')

    const withoutBrand = settings({ profile, operational: { ...DEFAULT_OPERATIONAL_SETTINGS, showPoweredBy: false } })
    const hidden = renderToStaticMarkup(<ReceiptPreviewPanel settings={withoutBrand} profile={profile} display={withoutBrand.display} />)
    expect(hidden).not.toContain('Powered by Infoflex')
  })
})

describe('the DONE-WHEN settings flow', () => {
  /** A stand-in host: saves into the same settings object the shell would re-render with. */
  async function saveName(bridgeName: string, current: ShopSettings, typed: string): Promise<ShopSettings> {
    const bridge = {
      updateStoreDetails: async (profile: ShopProfile) => {
        if (!profile.name.trim()) throw new Error('Enter your store name; it is required on customer documents.')
        return { ...current, profile: { ...profile, name: profile.name.trim() } }
      },
    } as unknown as Parameters<typeof SettingsScreen>[0]['bridge']
    const saved = await bridge.updateStoreDetails({ ...current.profile, name: typed })
    expect(typeof bridgeName).toBe('string')
    return saved
  }

  it('renames the shop and renders the new name on the next receipt preview', async () => {
    const before = settings()
    expect(html(before)).toContain('Harbor Health')

    const after = await saveName('save', before, '  Green Cross Chemist  ')
    expect(after.profile.name).toBe('Green Cross Chemist')

    const nextPreview = renderToStaticMarkup(
      <ReceiptPreviewPanel settings={after} profile={after.profile} display={after.display} />,
    )
    expect(nextPreview).toContain('Green Cross Chemist')
    expect(nextPreview).not.toContain('Harbor Health')
    // The already-printed receipt is a historical document and keeps the old name.
    expect(renderToStaticMarkup(<PosReceiptDocument receipt={receipt()} layout="A4_RECEIPT" />)).toContain('Harbor Health')
  })

  it('refuses to save an empty store name', async () => {
    const before = settings()
    await expect(saveName('save', before, '   ')).rejects.toThrow(/store name/i)
  })

  it('renders the whole settings screen for the Admin without throwing', () => {
    const noop = async () => { throw new Error('not used') }
    const bridge = new Proxy({}, { get: () => noop }) as Parameters<typeof SettingsScreen>[0]['bridge']
    const markup = renderToStaticMarkup(
      <SettingsScreen
        bridge={bridge}
        settings={settings()}
        license={license()}
        onSaved={() => {}}
        onNavigate={() => {}}
      />,
    )
    expect(markup).toContain('Store details')
    expect(markup).toContain('How the next receipt looks')
    expect(markup).toContain('Licence status')
    expect(markup).toContain('Open Mobile Access')
    expect(markup).toContain('Restore from a backup')
    expect(markup).toContain('BACKUP &amp; RESTORE')
    expect(markup).toContain('Choose logo…')
  })

  it('shows the transaction-lock explanation when the currency is locked by trading', () => {
    const locked = settings({ currencyLocked: true, currencyLockedByVendor: false })
    expect(html(locked, true)).toContain('The currency is locked because transactions already exist.')
  })

  it('shows the vendor explanation when the vendor set the currency', () => {
    const locked = settings({ currencyLocked: true, currencyLockedByVendor: true })
    expect(html(locked, true)).toContain('The currency is locked because it was set by your vendor.')
  })
})

function html(shop: ShopSettings, wholeScreen = false): string {
  if (!wholeScreen) {
    return renderToStaticMarkup(<ReceiptPreviewPanel settings={shop} profile={shop.profile} display={shop.display} />)
  }
  const noop = async () => { throw new Error('not used') }
  const bridge = new Proxy({}, { get: () => noop }) as Parameters<typeof SettingsScreen>[0]['bridge']
  return renderToStaticMarkup(
    <SettingsScreen
      bridge={bridge}
      settings={shop}
      license={license()}
      onSaved={() => {}}
    />,
  )
}

describe('printed receipt honours the Infoflex line setting', () => {
  it('prints the line when the sale was taken with it switched on', () => {
    const html = renderToStaticMarkup(<PosReceiptDocument receipt={receipt({ showPoweredBy: true })} layout="THERMAL_80" />)
    expect(html).toContain('Powered by Infoflex')
  })

  it('omits it when the shop switched it off, and for older sales that predate the setting', () => {
    expect(renderToStaticMarkup(<PosReceiptDocument receipt={receipt({ showPoweredBy: false })} layout="THERMAL_80" />))
      .not.toContain('Powered by Infoflex')
    expect(renderToStaticMarkup(<PosReceiptDocument receipt={receipt()} layout="A4_RECEIPT" />))
      .toContain('Powered by Infoflex')
  })

  it('keeps printing the customer’s store name and never a hard-coded one', () => {
    const html = renderToStaticMarkup(
      <PosReceiptDocument receipt={receipt({ store: { name: 'Green Cross Chemist', address: '', phone: '' } })} layout="A4_RECEIPT" />,
    )
    expect(html).toContain('Green Cross Chemist')
    expect(html).not.toContain('Harbor Health')
  })
})
