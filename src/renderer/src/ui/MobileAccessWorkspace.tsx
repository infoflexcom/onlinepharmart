import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { InfoflexBridge } from '@shared/bridge'
import type { BootstrapData } from '@shared/shop/types'
import type {
  MobileAccessStatus, MobileConnectionTest, MobileInternetStatus, MobileKeepRunningSettings, MobilePairingInfo,
  MobileTotpEnrollment, PairedMobileDevice, PendingMobileApproval, TotpStatus,
} from '@shared/mobile/types'
import { encodeQr, qrToSvg } from '@shared/qr/qr-code'
import { PairingApprovalDialog } from './PairingApprovalDialog'
import './mobile-access.css'

export interface MobileAccessSnapshot {
  status: MobileAccessStatus | null
  devices: PairedMobileDevice[]
  pending: PendingMobileApproval[]
  keepRunning: MobileKeepRunningSettings | null
  totp: TotpStatus | null
  /** A pairing window already open, so a test or a reload can render the code straight away. */
  pairing?: MobilePairingInfo | null
  /** An authenticator set-up already started, for the same reason. */
  enrollment?: MobileTotpEnrollment | null
}

interface Props {
  bridge: InfoflexBridge
  bootstrap: BootstrapData
  /**
   * Optional first paint. The screen refreshes from the host immediately either way; supplying a snapshot just
   * avoids a flash of "checking…" when the caller already has the state (and makes the screen renderable
   * without side effects).
   */
  initialSnapshot?: MobileAccessSnapshot
}

const POLL_MS = 4_000

/** The word on the badge. Deliberately the same words the docs and the portal use. */
function internetLabel(state: MobileInternetStatus['state']): string {
  switch (state) {
    case 'connected': return 'Live'
    case 'connecting': return 'Connecting'
    case 'waiting': return 'Waiting'
    case 'refused': return 'Refused'
    case 'off': return 'Off'
    default: return 'Not available'
  }
}

export function MobileAccessWorkspace({ bridge, bootstrap, initialSnapshot }: Props) {
  const [status, setStatus] = useState<MobileAccessStatus | null>(initialSnapshot?.status ?? null)
  const [devices, setDevices] = useState<PairedMobileDevice[]>(initialSnapshot?.devices ?? [])
  const [pairing, setPairing] = useState<MobilePairingInfo | null>(initialSnapshot?.pairing ?? null)
  const [pending, setPending] = useState<PendingMobileApproval[]>(initialSnapshot?.pending ?? [])
  // The SVG is generated from the address only; it never contains the pairing code or any secret.
  const pairingQr = useMemo(() => {
    if (!pairing) return null
    try {
      return qrToSvg(encodeQr(pairing.pairingUrl), { size: 168, border: 4 })
    } catch {
      return null // address too long for the encoder: the typed address below still works
    }
  }, [pairing])
  const [dismissed, setDismissed] = useState<string[]>([])
  const [keepRunning, setKeepRunning] = useState<MobileKeepRunningSettings | null>(initialSnapshot?.keepRunning ?? null)
  const [connection, setConnection] = useState<MobileConnectionTest | null>(null)
  const [enrollment, setEnrollment] = useState<MobileTotpEnrollment | null>(initialSnapshot?.enrollment ?? null)
  const [totp, setTotp] = useState<TotpStatus | null>(initialSnapshot?.totp ?? null)
  const [totpCode, setTotpCode] = useState('')
  // The authenticator set-up code, so the Admin can scan instead of typing 32 characters.
  const totpQr = useMemo(() => {
    if (!enrollment) return null
    try {
      return qrToSvg(encodeQr(enrollment.uri), { size: 148, border: 4 })
    } catch {
      return null // fall back to the typeable key below
    }
  }, [enrollment])
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [clock, setClock] = useState(Date.now())
  const pollRef = useRef<number | null>(null)

  const mobileLan = bootstrap.license.canUse && bootstrap.license.features.mobileLan
  // Licence entitlement decides whether the switch exists at all; the Admin's own switch decides whether it runs.
  const internet: MobileInternetStatus = status?.internet ?? {
    state: 'unavailable', entitled: bootstrap.license.features.mobileInternet, enabled: false, publicUrl: null, relayHost: null, link: null,
    message: 'Checking internet access…',
    privacyNote: 'The Infoflex relay forwards your phone’s requests to this computer and stores none of them. Like any secure web server it can read them in transit. Your Admin login, this phone’s approval and your authenticator code are still required.',
  }
  // The QR is the same encoder the pairing code uses; the link itself is minted by the host on every read.
  const internetQr = useMemo(() => {
    if (!internet.link) return null
    try {
      return qrToSvg(encodeQr(internet.link.url), { size: 168, border: 4 })
    } catch {
      return null // the address is typeable below
    }
  }, [internet.link])
  const phoneLimit = status?.phoneLimit ?? bootstrap.license.adminPhoneLimit
  const running = status?.running === true
  // Only show an approval prompt the Admin has not already dealt with during this visit.
  const visiblePending = useMemo(
    () => pending.filter((request) => !dismissed.includes(request.requestId)),
    [pending, dismissed],
  )

  const reload = useCallback(async () => {
    const [nextStatus, nextDevices, nextPending] = await Promise.all([
      bridge.getMobileAccessStatus(),
      bridge.listMobileDevices(),
      bridge.listPendingMobileApprovals(),
    ])
    setStatus(nextStatus)
    setDevices(nextDevices)
    setPending(nextPending)
    return nextStatus
  }, [bridge])

  useEffect(() => {
    let active = true
    void Promise.all([
      bridge.getMobileAccessStatus(),
      bridge.listMobileDevices(),
      bridge.listPendingMobileApprovals(),
      bridge.getKeepRunningSettings(),
      bridge.getMobileTotpStatus(),
    ])
      .then(([nextStatus, nextDevices, nextPending, nextKeepRunning, nextTotp]) => {
        if (!active) return
        setStatus(nextStatus)
        setDevices(nextDevices)
        setPending(nextPending)
        setKeepRunning(nextKeepRunning)
        setTotp(nextTotp)
      })
      .catch((reason: unknown) => {
        if (active) setError(errorMessage(reason))
      })
    return () => { active = false }
  }, [bridge])

  // Two clocks: a one-second tick for the pairing countdown, and a slower poll so a phone that scans the
  // QR while the Admin is looking at this screen shows its approval prompt without pressing Refresh.
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    pollRef.current = window.setInterval(() => {
      void Promise.all([bridge.listPendingMobileApprovals(), bridge.getMobileAccessStatus()])
        .then(([nextPending, nextStatus]) => {
          setPending(nextPending)
          setStatus(nextStatus)
        })
        .catch(() => undefined)
    }, POLL_MS)
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current)
    }
  }, [bridge])

  async function run(action: () => Promise<void>, successMessage: string): Promise<void> {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await action()
      setMessage(successMessage)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  function toggleInternet(): void {
    const next = !internet.enabled
    if (next && !window.confirm('Allow the Admin’s phone to reach this computer over the internet?\n\nThe Infoflex relay will forward your phone’s requests and stores none of them, but it can read them in transit. Your Admin login, this phone’s approval and your authenticator code are still required. You can switch this off at any time.')) return
    void run(async () => {
      setStatus(await bridge.setMobileInternetAccess(next))
    }, next
      ? 'Internet access is on. Scan the link with the Admin phone; it still needs approval here and an authenticator code.'
      : 'Internet access is off. The phone still works on the shop network.')
  }

  function start(): void {
    void run(async () => {
      setPairing(null)
      setStatus(await bridge.startMobileAccess())
      setDevices(await bridge.listMobileDevices())
    }, 'Mobile access is on. The Admin phone can reach this computer on the shop network.')
  }

  function stop(): void {
    void run(async () => {
      setPairing(null)
      setStatus(await bridge.stopMobileAccess())
    }, 'Mobile access is off. No phone can reach this computer now.')
  }

  function turnOffEverything(): void {
    if (!window.confirm('Turn off all mobile access? Every paired phone is signed out and must be paired again before it can reconnect.')) return
    void run(async () => {
      setPairing(null)
      setStatus(await bridge.turnOffAllMobileAccess())
      setDevices([])
      setPending([])
    }, 'All mobile access is off and every phone has been signed out.')
  }

  function createPairing(): void {
    void run(async () => {
      setDismissed([])
      setPairing(await bridge.beginMobilePairing())
    }, 'Scan the code or type the address on the Admin phone. Approve it here when it appears.')
  }

  function approve(request: PendingMobileApproval): void {
    void run(async () => {
      setPending(await bridge.approveMobileDevice(request.requestId))
      setDismissed((current) => [...current, request.requestId])
      setDevices(await bridge.listMobileDevices())
      setStatus(await bridge.getMobileAccessStatus())
    }, `“${request.deviceName}” is approved. The Admin can now sign in on that phone.`)
  }

  function reject(request: PendingMobileApproval): void {
    void run(async () => {
      setPending(await bridge.rejectMobileDevice(request.requestId))
      setDismissed((current) => [...current, request.requestId])
    }, `“${request.deviceName}” was not approved. The phone cannot connect.`)
  }

  function revoke(device: PairedMobileDevice): void {
    if (!window.confirm(`Revoke “${device.name}”? The phone is signed out immediately and must be approved again.`)) return
    void run(async () => {
      setDevices(await bridge.revokeMobileDevice(device.id))
      setStatus(await bridge.getMobileAccessStatus())
    }, `${device.name} was revoked.`)
  }

  function revokeAll(): void {
    if (!window.confirm('Revoke every paired phone? All of them must be approved again before they can connect.')) return
    void run(async () => {
      setDevices(await bridge.revokeAllMobileDevices())
      setStatus(await bridge.getMobileAccessStatus())
    }, 'Every paired phone has been revoked.')
  }

  function saveRename(): void {
    if (!renaming?.name.trim()) {
      setError('Enter a name for this phone.')
      return
    }
    const target = renaming
    void run(async () => {
      setDevices(await bridge.renameMobileDevice(target.id, target.name.trim()))
      setRenaming(null)
    }, 'Phone name saved.')
  }

  function testConnection(): void {
    void run(async () => {
      setConnection(await bridge.testMobileConnection())
      setStatus(await bridge.getMobileAccessStatus())
    }, 'Connection test finished. Read the results below.')
  }

  function repairFirewall(): void {
    void run(async () => {
      setStatus(await bridge.repairMobileFirewall())
      setConnection(await bridge.testMobileConnection())
    }, 'Windows Firewall now allows the mobile port on private networks.')
  }

  function exportCertificate(): void {
    void run(async () => {
      const pem = await bridge.getMobileTrustCertificate()
      const url = URL.createObjectURL(new Blob([pem], { type: 'application/x-x509-ca-cert' }))
      const link = document.createElement('a')
      link.href = url
      link.download = 'infoflex-mobile-root-ca.crt'
      document.body.append(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 2_000)
    }, 'Certificate saved. Copy it to the phone and install it before opening the mobile address.')
  }

  function confirmCertificate(): void {
    void run(async () => {
      setStatus(await bridge.acknowledgeMobileCertificateInstalled())
    }, 'Certificate installation recorded. The fingerprint stays available to check against the phone.')
  }

  function regenerateCertificate(): void {
    if (!window.confirm('Create a new certificate? Phones that trusted the old one must install the new one before they can connect.')) return
    void run(async () => {
      setPairing(null)
      setStatus(await bridge.regenerateMobileCertificate())
    }, 'A new certificate is ready. Install it on the phone before connecting again.')
  }

  function beginTotp(): void {
    void run(async () => {
      setEnrollment(await bridge.startMobileTotpEnrollment())
      setTotpCode('')
    }, 'Scan the code with Google Authenticator, Microsoft Authenticator, or Authy, then enter the six digits.')
  }

  function confirmTotp(): void {
    if (!/^\d{6}$/u.test(totpCode.trim())) {
      setError('Enter the six digits shown in the authenticator app.')
      return
    }
    void run(async () => {
      setTotp(await bridge.confirmMobileTotp(totpCode.trim()))
      setEnrollment(null)
      setTotpCode('')
    }, 'Authenticator set up. Remote phone sign-ins now ask for a code.')
  }

  function disableTotp(): void {
    if (!window.confirm('Turn off the authenticator? Remote sign-ins will no longer ask for a code, which is less safe.')) return
    void run(async () => {
      setTotp(await bridge.disableMobileTotp())
    }, 'The authenticator has been turned off.')
  }

  function updateKeepRunning(patch: Partial<MobileKeepRunningSettings>): void {
    if (!keepRunning) return
    const next = { ...keepRunning, ...patch }
    setKeepRunning(next)
    void run(async () => {
      setKeepRunning(await bridge.setKeepRunningSettings(next))
    }, 'Keep-running options saved.')
  }

  const remainingSeconds = pairing ? Math.max(0, Math.ceil((Date.parse(pairing.expiresAt) - clock) / 1_000)) : 0

  return (
    <section className="mobile-access" aria-labelledby="mobile-access-title">
      <header className="mobile-access__hero">
        <div>
          <span className="mobile-access__eyebrow">SECURE ADMIN ACCESS</span>
          <h2 id="mobile-access-title">The Admin’s phone on this network</h2>
          <p>Let the shop Admin review reports and approve returns from a phone. Mobile access is off until an Admin turns it on, and only an Admin account can use it.</p>
        </div>
        <span className={running ? 'mobile-access__state is-running' : 'mobile-access__state'}>
          <i aria-hidden="true" />{running ? 'On' : 'Off'}
        </span>
      </header>

      {!mobileLan && <div className="mobile-access__notice is-warning" role="status">
        This shop’s licence does not include mobile access. The phone feature cannot be turned on.
      </div>}

      {error && <div className="mobile-access__notice is-error" role="alert">{error}</div>}
      {message && <div className="mobile-access__notice is-success" role="status">{message}</div>}

      <div className="mobile-access__grid">
        <article className="mobile-access__card mobile-access__card--status">
          <div className="mobile-access__card-heading">
            <div><span className="mobile-access__eyebrow">HOST</span><h3>Allow the Admin’s phone on this network</h3></div>
            <span className="mobile-access__number">
              {status?.pairedDeviceCount ?? devices.length}<small> of {phoneLimit} phone{phoneLimit === 1 ? '' : 's'}</small>
            </span>
          </div>
          <p>{status?.message ?? 'Checking mobile access…'}</p>
          <div className="mobile-access__actions">
            {!running
              ? <button type="button" className="mobile-access__button is-primary" disabled={busy || !mobileLan} onClick={start}>Turn on mobile access</button>
              : <>
                <button type="button" className="mobile-access__button" disabled={busy || devices.length >= phoneLimit} onClick={createPairing}>Pair a phone</button>
                <button type="button" className="mobile-access__button" disabled={busy} onClick={testConnection}>Test connection</button>
                <button type="button" className="mobile-access__button is-danger" disabled={busy} onClick={stop}>Turn off</button>
              </>}
          </div>

          {running && <div className="mobile-access__connections">
            <p className="mobile-access__live" role="status">
              <i aria-hidden="true" />
              <span>
                {status && status.connectedDeviceCount > 0
                  ? `${status.connectedDeviceCount} phone${status.connectedDeviceCount === 1 ? '' : 's'} connected right now`
                  : 'No phone is connected right now'}
              </span>
            </p>
            {status?.urls.map((url) => <p className="mobile-access__url" key={url}><span>Address</span><code>{url}</code></p>)}
            {status?.friendlyUrls.map((url) => <p className="mobile-access__url" key={url}><span>Easy name</span><code>{url}</code></p>)}
            {pairing && <div className="mobile-access__pairing" role="status">
              <div>
                <span className="mobile-access__eyebrow">PAIRING CODE</span>
                <strong>{pairing.code}</strong>
                <small>Expires in {formatCountdown(remainingSeconds)}</small>
              </div>
              {pairingQr && <figure className="mobile-access__qr">
                <div aria-hidden="true" dangerouslySetInnerHTML={{ __html: pairingQr }} />
                <figcaption>Point the phone’s camera at this to open the sign-in page.</figcaption>
              </figure>}
              <p>On the phone: open <code>{pairing.pairingUrl}</code> (or type <code>{pairing.addresses[0]}</code>), enter this code, then approve the phone here.</p>
            </div>}
          </div>}

          {status?.firewallBlocked && <div className="mobile-access__notice is-warning" role="alert">
            <p>{status.firewallMessage ?? 'Windows Firewall is blocking this computer’s mobile port.'}</p>
            <button type="button" className="mobile-access__button is-primary" disabled={busy} onClick={repairFirewall}>Repair firewall rule</button>
          </div>}

          {connection && <div className="mobile-access__test" role="status">
            <h4>{connection.ok ? 'Everything looks ready' : 'One step still needs attention'}</h4>
            <ul>
              {connection.steps.map((step) => <li key={step.label} className={step.ok ? 'is-ok' : 'is-bad'}>
                <span aria-hidden="true">{step.ok ? '✓' : '!'}</span>
                <div><strong>{step.label}</strong><small>{step.detail}</small></div>
              </li>)}
            </ul>
          </div>}

          <small className="mobile-access__footnote">
            Mobile access is for the Admin only. Cashiers use the desktop. Access expires after 15 minutes and refreshes rotate, so a revoked phone cannot reconnect.
          </small>
        </article>

        <article className="mobile-access__card">
          <div className="mobile-access__card-heading">
            <div><span className="mobile-access__eyebrow">HTTPS TRUST</span><h3>Phone certificate</h3></div>
            <span className="mobile-access__lock" aria-hidden="true">TLS</span>
          </div>
          <p>The phone must trust this computer’s certificate before the browser will open the secure address. The private key is protected by Windows and never leaves this computer.</p>
          {status?.certificateFingerprint && <div className="mobile-access__fingerprint"><span>Certificate fingerprint (SHA-256)</span><code>{status.certificateFingerprint}</code></div>}
          <div className="mobile-access__actions">
            <button type="button" className="mobile-access__button" disabled={busy || !running} onClick={exportCertificate}>Save certificate</button>
            {status?.certificateNeedsInstall && <button type="button" className="mobile-access__button is-primary" disabled={busy || !running} onClick={confirmCertificate}>I installed it on the phone</button>}
            <button type="button" className="mobile-access__text-button" disabled={busy || !mobileLan} onClick={regenerateCertificate}>New certificate…</button>
          </div>
          <ol className="mobile-access__instructions">
            <li>Press <b>Save certificate</b> and send the file to the phone (email it to yourself, or use a USB cable).</li>
            <li><b>Android:</b> open Settings → Security → Encryption &amp; credentials → Install a certificate → CA certificate. Confirm with your PIN.</li>
            <li><b>iPhone:</b> tap the file, allow the profile download, then Settings → General → VPN &amp; Device Management → install it. Finally open Settings → General → About → Certificate Trust Settings and switch on full trust.</li>
            <li>Compare the fingerprint above with the phone before trusting it.</li>
          </ol>
          {status?.certificateNeedsInstall && <p className="mobile-access__trust-warning">Certificate trust is not yet confirmed. Finish installing it before pairing.</p>}
        </article>

        <article className="mobile-access__card mobile-access__card--internet">
          <div className="mobile-access__card-heading">
            <div><span className="mobile-access__eyebrow">AWAY FROM THE SHOP</span><h3>Mobile access over the internet</h3></div>
            <span className={internet.state === 'connected' ? 'mobile-access__state is-running' : 'mobile-access__state'}>
              <i aria-hidden="true" />{internetLabel(internet.state)}
            </span>
          </div>
          {!internet.entitled
            ? <p>This shop’s licence does not include mobile access over the internet. On the shop’s own network the phone still works.</p>
            : <>
              <p>The Admin’s phone can reach this computer from mobile data, at an address like <code>{internet.publicUrl ?? `https://<shop>.${internet.relayHost ?? 'your vendor'}`}</code>. It works only while this computer is switched on and connected, and only while the licence is active.</p>
              {internet.publicUrl && <p className="mobile-access__url"><span>Internet address</span><code>{internet.publicUrl}</code></p>}
              <div className="mobile-access__actions">
                <button
                  type="button"
                  className={internet.enabled ? 'mobile-access__button is-danger' : 'mobile-access__button is-primary'}
                  disabled={busy || !running}
                  onClick={toggleInternet}
                >
                  {internet.enabled ? 'Switch off internet access' : 'Allow over the internet'}
                </button>
              </div>
              <p className="mobile-access__privacy-note">{internet.privacyNote}</p>
              <p><small>{internet.message}</small></p>
              {internet.link && <div className="mobile-access__pairing" role="status">
                <div>
                  <span className="mobile-access__eyebrow">PHONE LINK</span>
                  <strong>{internet.state === 'connected' ? 'Ready' : 'Waiting'}</strong>
                  <small>Expires {new Date(internet.link.expiresAt).toLocaleTimeString()} — a new link is made each time this screen loads.</small>
                </div>
                {internetQr && <figure className="mobile-access__qr">
                  <div aria-hidden="true" dangerouslySetInnerHTML={{ __html: internetQr }} />
                  <figcaption>Scan this on the Admin phone. It signs the phone in only to this shop, and the Admin still signs in with a password and authenticator code.</figcaption>
                </figure>}
              </div>}
            </>}
        </article>
      </div>

      <article className="mobile-access__card mobile-access__devices">
        <div className="mobile-access__card-heading">
          <div><span className="mobile-access__eyebrow">APPROVED PHONES</span><h3>Paired devices</h3></div>
          <div className="mobile-access__actions">
            <button type="button" className="mobile-access__text-button" disabled={busy} onClick={() => void reload().catch((reason: unknown) => setError(errorMessage(reason)))}>Refresh</button>
            {devices.length > 0 && <button type="button" className="mobile-access__text-button is-danger" disabled={busy} onClick={revokeAll}>Revoke all</button>}
          </div>
        </div>
        {devices.length === 0
          ? <p className="mobile-access__empty">No phone is paired yet. Turn on mobile access and press <b>Pair a phone</b>.</p>
          : <ul className="mobile-access__device-list">{devices.map((device) => <li key={device.id}>
            <div className="mobile-access__device-icon" aria-hidden="true">▯</div>
            <div className="mobile-access__device-info">
              {renaming?.id === device.id
                ? <form className="mobile-access__rename" onSubmit={(event) => { event.preventDefault(); saveRename() }}>
                  <input
                    aria-label="Phone name"
                    maxLength={80}
                    value={renaming.name}
                    onChange={(event) => setRenaming({ id: device.id, name: event.target.value })}
                  />
                  <button type="submit" className="mobile-access__button is-primary" disabled={busy}>Save</button>
                  <button type="button" className="mobile-access__text-button" onClick={() => setRenaming(null)}>Cancel</button>
                </form>
                : <>
                  <strong>{device.name}</strong>
                  <span>{device.platform} · owner {device.ownerUsername} · added {formatDate(device.createdAt)}</span>
                  <small>
                    {device.connected ? 'Connected now' : device.lastSeen ? `Last seen ${formatDate(device.lastSeen)}` : 'Not signed in yet'}
                    {device.lastIp ? ` · ${device.lastIp}` : ''}
                    {' · '}{device.approvalStatus === 'APPROVED' ? 'Approved' : 'Waiting for approval'}
                  </small>
                </>}
            </div>
            <div className="mobile-access__actions">
              {renaming?.id !== device.id && <button type="button" className="mobile-access__text-button" disabled={busy} onClick={() => setRenaming({ id: device.id, name: device.name })}>Rename</button>}
              <button type="button" className="mobile-access__button is-danger" disabled={busy} onClick={() => revoke(device)}>Revoke</button>
            </div>
          </li>)}</ul>}
      </article>

      <div className="mobile-access__grid">
        <article className="mobile-access__card">
          <div className="mobile-access__card-heading">
            <div><span className="mobile-access__eyebrow">SIGN-IN CODE</span><h3>Authenticator app</h3></div>
            <span className={totp?.enrolled ? 'mobile-access__state is-running' : 'mobile-access__state'}>{totp?.enrolled ? 'On' : 'Off'}</span>
          </div>
          <p>A code from an authenticator app is required whenever the Admin signs in to this phone over the Internet. On the shop network it is optional but recommended.</p>
          {!totp?.enrolled && !enrollment && <div className="mobile-access__actions">
            <button type="button" className="mobile-access__button is-primary" disabled={busy} onClick={beginTotp}>Set up authenticator</button>
          </div>}
          {enrollment && <div className="mobile-access__totp" role="group" aria-label="Authenticator set-up">
            <p>In your authenticator app, scan this with <b>Add account</b> → <b>Scan a QR code</b>. If the camera will not cooperate, choose <b>Enter a setup key</b> and type the key underneath.</p>
            {totpQr && <figure className="mobile-access__qr mobile-access__qr--setup">
              <div aria-hidden="true" dangerouslySetInnerHTML={{ __html: totpQr }} />
              <figcaption>Authenticator set-up code</figcaption>
            </figure>}
            <code className="mobile-access__secret">{enrollment.formattedSecret}</code>
            <p className="mobile-access__hint">Account: <b>{enrollment.accountName}</b> · Type: time-based</p>
            <form className="mobile-access__rename" onSubmit={(event) => { event.preventDefault(); confirmTotp() }}>
              <input
                aria-label="Six-digit authenticator code"
                inputMode="numeric"
                maxLength={6}
                placeholder="123456"
                value={totpCode}
                onChange={(event) => setTotpCode(event.target.value.replace(/\D/gu, ''))}
              />
              <button type="submit" className="mobile-access__button is-primary" disabled={busy}>Confirm code</button>
              <button type="button" className="mobile-access__text-button" onClick={() => { setEnrollment(null); setTotpCode('') }}>Cancel</button>
            </form>
          </div>}
          {totp?.enrolled && <div className="mobile-access__actions">
            <span className="mobile-access__footnote">Set up on {totp.confirmedAt ? formatDate(totp.confirmedAt) : 'this computer'}.</span>
            <button type="button" className="mobile-access__text-button is-danger" disabled={busy} onClick={disableTotp}>Turn off</button>
          </div>}
        </article>

        <article className="mobile-access__card">
          <div className="mobile-access__card-heading">
            <div><span className="mobile-access__eyebrow">KEEP RUNNING</span><h3>Staying available</h3></div>
          </div>
          <p>Mobile access only works while Infoflex is running and the computer is awake.</p>
          <ul className="mobile-access__toggles">
            <li>
              <label>
                <input
                  type="checkbox"
                  checked={keepRunning?.keepRunning ?? true}
                  disabled={busy || !keepRunning}
                  onChange={(event) => updateKeepRunning({ keepRunning: event.target.checked })}
                />
                <span><strong>Keep Infoflex running when the window closes</strong><small>Infoflex keeps working from the taskbar tray so the phone stays connected.</small></span>
              </label>
            </li>
            <li>
              <label>
                <input
                  type="checkbox"
                  checked={keepRunning?.startWithWindows ?? true}
                  disabled={busy || !keepRunning}
                  onChange={(event) => updateKeepRunning({ startWithWindows: event.target.checked })}
                />
                <span><strong>Start Infoflex when Windows starts</strong><small>Recommended, so mobile access is available after a restart.</small></span>
              </label>
            </li>
            <li>
              <label>
                <input
                  type="checkbox"
                  checked={keepRunning?.preventSleep ?? true}
                  disabled={busy || !keepRunning}
                  onChange={(event) => updateKeepRunning({ preventSleep: event.target.checked })}
                />
                <span><strong>Stop the computer sleeping while a phone is connected</strong><small>The computer stays awake only while a phone is actually connected.</small></span>
              </label>
            </li>
          </ul>
          {!keepRunning?.preventSleep && <p className="mobile-access__trust-warning">If the computer sleeps, the phone loses its connection until the computer wakes.</p>}
        </article>
      </div>

      <article className="mobile-access__card">
        <div className="mobile-access__card-heading">
          <div><span className="mobile-access__eyebrow">NETWORK HELP</span><h3>If the phone cannot find this computer</h3></div>
        </div>
        <ol className="mobile-access__instructions">
          <li><b>Same Wi-Fi:</b> check the phone is on the same network as this computer, not mobile data.</li>
          <li><b>Hotspot instead:</b> turn on <b>Windows Mobile Hotspot</b> (Settings → Network &amp; Internet → Mobile hotspot) and join that Wi-Fi from the phone. The address above changes — reopen this page to read the new one.</li>
          <li><b>Phone hotspot:</b> or turn on the phone’s own hotspot and connect this computer to it. The address changes again.</li>
          <li><b>Bluetooth is not used</b> for mobile access: iPhone web apps cannot use it, and it is too slow and unreliable for approvals. Bluetooth printers and scanners on this computer keep working normally.</li>
        </ol>
        <div className="mobile-access__actions">
          <button type="button" className="mobile-access__button is-danger" disabled={busy} onClick={turnOffEverything}>Turn off all mobile access</button>
        </div>
      </article>

      <p className="mobile-access__privacy">
        Mobile access is for the Admin only. Cashiers use the desktop. Every phone action is recorded with the phone name and its network address.
      </p>

      {visiblePending.length > 0 && running && <PairingApprovalDialog
        requests={visiblePending}
        busy={busy}
        onApprove={approve}
        onReject={reject}
        onDismiss={(request) => setDismissed((current) => [...current, request.requestId])}
      />}
    </section>
  )
}

function formatCountdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : 'That mobile access action could not be completed.'
}
