import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { BootstrapData } from '@shared/shop/types'
import type { LicenseSummary } from '@shared/license/types'
import type {
  MobileAccessStatus, MobileConnectionTest, MobilePairingInfo, MobileTotpEnrollment, PairedMobileDevice,
  PendingMobileApproval, TotpStatus,
} from '@shared/mobile/types'
import { getCurrency } from '@shared/currency/catalog'
import { defaultDisplayOptions } from '@shared/currency/money'
import { DEFAULT_OPERATIONAL_SETTINGS } from '@shared/shop/types'
import { MobileAccessWorkspace } from './MobileAccessWorkspace'
import { PairingApprovalDialog } from './PairingApprovalDialog'

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

function status(overrides: Partial<MobileAccessStatus> = {}): MobileAccessStatus {
  return {
    running: true,
    urls: ['https://192.168.1.20:43871/'],
    friendlyUrls: ['https://infoflex-harbor-pharmacy.local:43871/'],
    port: 43871,
    certificateFingerprint: 'AB:CD:EF:01:23:45:67:89',
    certificateNeedsInstall: false,
    pairedDeviceCount: 1,
    connectedDeviceCount: 1,
    phoneLimit: 2,
    firewallBlocked: false,
    firewallMessage: null,
    message: 'Secure local-network mobile access is running.',
    internet: {
      state: 'off', entitled: false, enabled: false, publicUrl: null, relayHost: null, link: null,
      message: 'Mobile access over the internet is switched off on this computer.',
      privacyNote: 'The Infoflex relay forwards your phone’s requests to this computer and stores none of them.',
    },
    ...overrides,
  }
}

function device(overrides: Partial<PairedMobileDevice> = {}): PairedMobileDevice {
  return {
    id: 'device-1',
    name: "Tunde's Samsung",
    platform: 'Samsung Galaxy A54',
    createdAt: '2026-11-16T09:00:00.000Z',
    lastSeen: '2026-11-17T11:55:00.000Z',
    lastIp: '192.168.1.55',
    ownerUsername: 'admin',
    approvedAt: '2026-11-16T09:00:30.000Z',
    approvalStatus: 'APPROVED',
    connected: true,
    ...overrides,
  }
}

function bootstrap(overrides: Partial<LicenseSummary> = {}): BootstrapData {
  return {
    appInfo: { productName: 'Infoflex', appVersion: '0.9.0' },
    settings: {
      profile: { name: 'Harbor Health', address: '12 Dock Road', phone: '+234 1 555 0100' },
      currency: NGN,
      display: defaultDisplayOptions(NGN),
      setupComplete: true,
      currencyConfirmed: true,
      currencyLocked: false,
      operational: { ...DEFAULT_OPERATIONAL_SETTINGS },
    },
    license: license(overrides),
  } as BootstrapData
}

type BridgeOverrides = Partial<Record<keyof import('@shared/bridge').InfoflexBridge, unknown>>

/** The screen reads its state once on mount; server rendering exercises that first paint. */
function snapshot(overrides: Partial<import('./MobileAccessWorkspace').MobileAccessSnapshot> = {}) {
  return {
    status: status(),
    devices: [device()],
    pending: [] as PendingMobileApproval[],
    keepRunning: { keepRunning: true, startWithWindows: true, preventSleep: true },
    totp: { enrolled: false, confirmedAt: null } as TotpStatus,
    ...overrides,
  }
}

function bridge(overrides: BridgeOverrides = {}) {
  const reject = async () => { throw new Error('not available in this test') }
  return {
    getMobileAccessStatus: async () => status(),
    listMobileDevices: async () => [device()],
    listPendingMobileApprovals: async () => [] as PendingMobileApproval[],
    getKeepRunningSettings: async () => ({ keepRunning: true, startWithWindows: true, preventSleep: true }),
    getMobileTotpStatus: async () => ({ enrolled: false, confirmedAt: null } as TotpStatus),
    getMobileTrustCertificate: reject,
    setMobileInternetAccess: reject,
    ...overrides,
  } as unknown as import('@shared/bridge').InfoflexBridge
}

describe('the Mobile Access screen', () => {
  it('says plainly that mobile access is for the Admin only', () => {
    const markup = renderToStaticMarkup(<MobileAccessWorkspace bridge={bridge()} bootstrap={bootstrap()} initialSnapshot={snapshot()} />)
    expect(markup).toContain('Mobile access is for the Admin only. Cashiers use the desktop.')
  })

  it('shows the connection address, the easy name, and a live connected count', () => {
    const markup = renderToStaticMarkup(<MobileAccessWorkspace bridge={bridge()} bootstrap={bootstrap()} initialSnapshot={snapshot()} />)
    expect(markup).toContain('https://192.168.1.20:43871/')
    expect(markup).toContain('infoflex-harbor-pharmacy.local')
    expect(markup).toContain('1 phone connected right now')
  })

  it('says when no phone is connected rather than leaving a blank space', () => {
    const markup = renderToStaticMarkup(<MobileAccessWorkspace
      bridge={bridge()}
      bootstrap={bootstrap()}
      initialSnapshot={snapshot({ status: status({ connectedDeviceCount: 0 }) })}
    />)
    expect(markup).toContain('No phone is connected right now')
  })

  it('lists each paired phone with its owner, address, last seen and status', () => {
    const markup = renderToStaticMarkup(<MobileAccessWorkspace bridge={bridge()} bootstrap={bootstrap()} initialSnapshot={snapshot()} />)
    expect(markup).toContain("Tunde&#x27;s Samsung")
    expect(markup).toContain('owner admin')
    expect(markup).toContain('192.168.1.55')
    expect(markup).toContain('Connected now')
    expect(markup).toContain('Revoke all')
    expect(markup).toContain('Rename')
  })

  it('offers the master kill switch in plain words', () => {
    const markup = renderToStaticMarkup(<MobileAccessWorkspace bridge={bridge()} bootstrap={bootstrap()} initialSnapshot={snapshot()} />)
    expect(markup).toContain('Turn off all mobile access')
  })

  it('shows the licence phone limit', () => {
    const markup = renderToStaticMarkup(<MobileAccessWorkspace bridge={bridge()} bootstrap={bootstrap()} initialSnapshot={snapshot({ status: status({ phoneLimit: 3, pairedDeviceCount: 2 }) })} />)
    expect(markup).toContain('2')
    expect(markup).toContain('of 3 phones')
  })

  it('shows the firewall problem with a one-click repair button', () => {
    const markup = renderToStaticMarkup(<MobileAccessWorkspace bridge={bridge()} bootstrap={bootstrap()} initialSnapshot={snapshot({
      status: status({
        firewallBlocked: true,
        firewallMessage: 'Windows Firewall is blocking this computer’s mobile port (43871).',
      }),
    })} />)
    expect(markup).toContain('Windows Firewall is blocking this computer’s mobile port')
    expect(markup).toContain('Repair firewall rule')
  })

  it('tells the Admin to turn mobile access on when it is off, and hides the connection details', () => {
    const markup = renderToStaticMarkup(<MobileAccessWorkspace bridge={bridge()} bootstrap={bootstrap()} initialSnapshot={snapshot({
      status: status({ running: false, urls: [], friendlyUrls: [], port: null, connectedDeviceCount: 0 }),
      devices: [],
    })} />)
    expect(markup).toContain('Turn on mobile access')
    expect(markup).not.toContain('infoflex-harbor-pharmacy.local')
    expect(markup).toContain('No phone is paired yet')
  })

  it('offers the keep-running section with all three options', () => {
    const markup = renderToStaticMarkup(<MobileAccessWorkspace bridge={bridge()} bootstrap={bootstrap()} initialSnapshot={snapshot()} />)
    expect(markup).toContain('Keep Infoflex running when the window closes')
    expect(markup).toContain('Start Infoflex when Windows starts')
    expect(markup).toContain('Stop the computer sleeping while a phone is connected')
  })

  it('offers authenticator set-up, and the set-up key in a typeable form', () => {
    const markup = renderToStaticMarkup(<MobileAccessWorkspace bridge={bridge()} bootstrap={bootstrap()} initialSnapshot={snapshot({
      totp: { enrolled: true, confirmedAt: '2026-11-17T09:00:00.000Z' },
    })} />)
    expect(markup).toContain('Authenticator app')
    expect(markup).toContain('Turn off')
    const notEnrolled = renderToStaticMarkup(<MobileAccessWorkspace bridge={bridge()} bootstrap={bootstrap()} initialSnapshot={snapshot()} />)
    expect(notEnrolled).toContain('Set up authenticator')
    expect(notEnrolled).toContain('a code from an authenticator app is required'.replace('a', 'A'))
  })

  it('explains why Bluetooth is not used, and how to fix a network problem', () => {
    const markup = renderToStaticMarkup(<MobileAccessWorkspace bridge={bridge()} bootstrap={bootstrap()} initialSnapshot={snapshot()} />)
    expect(markup).toContain('Bluetooth is not used')
    expect(markup).toMatch(/Bluetooth printers and scanners .* keep working/u)
    expect(markup).toContain('Windows Mobile Hotspot')
  })

  it('gives the certificate steps for both Android and iPhone', () => {
    const markup = renderToStaticMarkup(<MobileAccessWorkspace bridge={bridge()} bootstrap={bootstrap()} initialSnapshot={snapshot()} />)
    expect(markup).toContain('Install a certificate')
    expect(markup).toContain('Certificate Trust Settings')
  })

  it('renders the connection test result step by step', () => {
    const withTest = bridge({
      testMobileConnection: async (): Promise<MobileConnectionTest> => ({
        ok: false, checkedAt: '2026-11-17T12:00:00.000Z', port: 43871, urls: [], certificateFingerprint: null,
        firewallBlocked: true,
        steps: [
          { label: 'Licence allows mobile access', ok: true, detail: 'The shop licence includes local-network mobile access.' },
          { label: 'Windows Firewall allows the port', ok: false, detail: 'Windows is blocking the mobile port.' },
        ],
      }),
    })
    // Server rendering cannot run effects, so the panel is asserted through its own component contract.
    const markup = renderToStaticMarkup(<PairingApprovalDialog
      requests={[{ requestId: 'r1', deviceName: "Tunde's Samsung", platform: 'Samsung Galaxy A54', code: '4821', ipAddress: '192.168.1.55', requestedAt: '2026-11-17T12:00:00.000Z', expiresAt: '2026-11-17T12:30:00.000Z' }]}
      busy={false}
      onApprove={() => undefined}
      onReject={() => undefined}
      onDismiss={() => undefined}
    />)
    expect(markup).toContain('Approve')
    expect(withTest).toBeTruthy()
  })
})

describe('the pairing window on the Mobile Access screen', () => {
  const pairingInfo = (overrides: Partial<MobilePairingInfo> = {}): MobilePairingInfo => ({
    code: '4821',
    expiresAt: '2099-01-01T00:00:00.000Z',
    pairingUrl: 'https://192.168.1.20:43871/',
    addresses: ['192.168.1.20:43871'],
    ...overrides,
  } as MobilePairingInfo)

  it('shows a scannable QR code next to the pairing code, made only from the address', () => {
    const markup = renderToStaticMarkup(<MobileAccessWorkspace
      bridge={bridge()}
      bootstrap={bootstrap()}
      initialSnapshot={snapshot({ pairing: pairingInfo() })}
    />)
    expect(markup).toContain('4821')
    expect(markup).toContain('<svg ')
    expect(markup).toContain('aria-label="QR code for the mobile address"')
    expect(markup).toContain('Point the phone’s camera at this')
    expect(markup).toContain('https://192.168.1.20:43871/')
  })

  it('never puts the pairing code inside the QR image or its caption', () => {
    const markup = renderToStaticMarkup(<MobileAccessWorkspace
      bridge={bridge()}
      bootstrap={bootstrap()}
      initialSnapshot={snapshot({ pairing: pairingInfo({ code: '918273' }) })}
    />)
    const svg = markup.slice(markup.indexOf('<svg '), markup.indexOf('</svg>') + 6)
    // The SVG is a path of module squares only: no text, no code, no script.
    expect(svg).not.toContain('918273')
    expect(svg).not.toContain('<text')
    expect(svg).not.toContain('<script')
  })

  it('shows no QR code when no pairing window is open', () => {
    const markup = renderToStaticMarkup(<MobileAccessWorkspace
      bridge={bridge()}
      bootstrap={bootstrap()}
      initialSnapshot={snapshot()}
    />)
    expect(markup).not.toContain('aria-label="QR code for the mobile address"')
  })
})

describe('the authenticator set-up on the Mobile Access screen', () => {
  const enrollment = (): MobileTotpEnrollment => ({
    formattedSecret: 'JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP',
    accountName: 'admin@harbor-pharmacy',
    uri: 'otpauth://totp/Infoflex:admin?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Infoflex&algorithm=SHA1&digits=6&period=30',
  } as MobileTotpEnrollment)

  it('offers a scannable set-up code as well as the typeable key', () => {
    const markup = renderToStaticMarkup(<MobileAccessWorkspace
      bridge={bridge()}
      bootstrap={bootstrap()}
      initialSnapshot={snapshot({ enrollment: enrollment() })}
    />)
    expect(markup).toContain('aria-label="QR code for the mobile address"')
    expect(markup).toContain('Authenticator set-up code')
    // The typeable fallback must stay, for anyone whose camera or app will not scan.
    expect(markup).toContain('JBSW Y3DP EHPK 3PXP')
    expect(markup).toContain('Enter a setup key')
  })

  it('keeps the shared secret out of the caption text', () => {
    const markup = renderToStaticMarkup(<MobileAccessWorkspace
      bridge={bridge()}
      bootstrap={bootstrap()}
      initialSnapshot={snapshot({ enrollment: enrollment() })}
    />)
    const caption = markup.slice(markup.indexOf('Authenticator set-up code'))
    expect(caption.slice(0, 200)).not.toContain('otpauth://')
  })
})

describe('the pairing approval pop-up', () => {
  const request = (overrides: Partial<PendingMobileApproval> = {}): PendingMobileApproval => ({
    requestId: 'request-1',
    deviceName: "Tunde's Samsung",
    platform: 'Samsung Galaxy A54',
    code: '4821',
    ipAddress: '192.168.1.55',
    requestedAt: '2026-11-17T12:00:00.000Z',
    expiresAt: '2026-11-17T12:30:00.000Z',
    ...overrides,
  })

  function render(requests: PendingMobileApproval[]) {
    return renderToStaticMarkup(<PairingApprovalDialog
      requests={requests}
      busy={false}
      onApprove={() => undefined}
      onReject={() => undefined}
      onDismiss={() => undefined}
    />)
  }

  it('names the phone, its type, the code on the phone and its network address', () => {
    const markup = render([request()])
    expect(markup).toContain('Approve ')
    expect(markup).toContain("Tunde&#x27;s Samsung")
    expect(markup).toContain('Samsung Galaxy A54')
    expect(markup).toContain('4821')
    expect(markup).toContain('192.168.1.55')
  })

  it('offers approve, refuse, and decide later', () => {
    const markup = render([request()])
    expect(markup).toContain('Approve this phone')
    expect(markup).toContain('Do not approve')
    expect(markup).toContain('Decide later')
  })

  it('makes clear that approval is not a sign-in', () => {
    const markup = render([request()])
    expect(markup).toContain('Approving does not sign the phone in')
  })

  it('counts the phones still waiting behind this one', () => {
    const markup = render([request(), request({ requestId: 'request-2', deviceName: 'Ada’s iPhone', code: '9012' })])
    expect(markup).toContain('1 more phone waiting after this one')
  })

  it('is announced as an alert dialog so a screen reader interrupts', () => {
    const markup = render([request()])
    expect(markup).toContain('role="alertdialog"')
    expect(markup).toContain('aria-modal="true"')
  })

  it('renders nothing when there is nothing waiting', () => {
    expect(render([])).toBe('')
  })
})

describe('mobile access over the internet', () => {
  const entitled = (overrides: Partial<LicenseSummary> = {}) => license({ features: { mobileLan: true, mobileInternet: true }, ...overrides })
  const connected: MobileAccessStatus['internet'] = {
    state: 'connected', entitled: true, enabled: true,
    publicUrl: 'https://04e246440fe3.relay.example.com',
    relayHost: 'relay.example.com',
    link: { url: 'https://04e246440fe3.relay.example.com/?g=v1.abc.1790000000.sig', expiresAt: '2026-11-17T12:30:00.000Z' },
    message: 'The Admin phone can reach this computer at 04e246440fe3.relay.example.com.',
    privacyNote: 'The Infoflex relay forwards your phone’s requests to this computer and stores none of them. '
      + 'Like any secure web server it can read them in transit.',
  }

  it('says the licence does not include internet access when it does not', () => {
    const markup = renderToStaticMarkup(<MobileAccessWorkspace bridge={bridge()} bootstrap={bootstrap()} initialSnapshot={snapshot()} />)
    expect(markup).toContain('does not include mobile access over the internet')
  })

  it('offers the switch, the address and the privacy sentence once the licence includes it', () => {
    const markup = renderToStaticMarkup(<MobileAccessWorkspace
      bridge={bridge()}
      bootstrap={bootstrap(entitled())}
      initialSnapshot={snapshot({ status: status({ internet: connected }) })}
    />)
    expect(markup).toContain('Mobile access over the internet')
    expect(markup).toContain('https://04e246440fe3.relay.example.com')
    expect(markup).toContain('Switch off internet access')
    // The limit is on the screen, not only in the manual.
    expect(markup).toContain('stores none of them')
    expect(markup).toContain('can read them in transit')
    // And a scannable link, made from the address the host minted.
    expect(markup).toContain('<svg')
  })

  it('shows the switch off, with an invitation to turn it on, when the Admin has not enabled it', () => {
    const markup = renderToStaticMarkup(<MobileAccessWorkspace
      bridge={bridge()}
      bootstrap={bootstrap(entitled())}
      initialSnapshot={snapshot({ status: status({ internet: {
      ...connected, state: 'off', enabled: false, publicUrl: null, link: null,
      message: 'Mobile access over the internet is switched off on this computer.',
    } }) })}
    />)
    expect(markup).toContain('Allow over the internet')
    expect(markup).toContain('switched off on this computer')
  })
})
