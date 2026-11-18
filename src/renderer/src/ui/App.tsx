import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BootstrapData } from '@shared/shop/types'
import { createPreviewBridge } from '../preview-bridge'
import { SetupScreen } from './SetupScreen'
import { LoginScreen } from './LoginScreen'
import { AppShell } from './AppShell'
import { LicenseScreen } from './LicenseScreen'
import './license.css'

export function App() {
  const bridge = useMemo(() => window.infoflex ?? createPreviewBridge(), [])
  const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    const next = await bridge.getBootstrap()
    setBootstrap(next)
    setError('')
    document.title = next.appInfo.productName
    return next
  }, [bridge])

  useEffect(() => {
    let active = true
    void bridge.getBootstrap()
      .then((next) => {
        if (!active) return
        setBootstrap(next)
        document.title = next.appInfo.productName
      })
      .catch((caught: unknown) => {
        if (active) setError(errorMessage(caught))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [bridge])

  // The host enforces license state on every operation; this polling only refreshes the display
  // when a scheduled check-in or expiry changes the host's state.
  useEffect(() => {
    const timer = window.setInterval(() => {
      void refresh().catch((caught: unknown) => setError(errorMessage(caught)))
    }, 10_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    if (!bootstrap?.currentUser) return
    let lastActivitySignal = 0
    const signalActivity = () => {
      const now = Date.now()
      if (now - lastActivitySignal < 15_000) return
      lastActivitySignal = now
      void bridge.touchSession()
    }
    const checkSession = window.setInterval(() => {
      void bridge.getCurrentUser().then((user) => {
        if (!user) {
          void refresh()
          return
        }
        setBootstrap((current) => current ? { ...current, currentUser: user } : current)
      }).catch(() => void refresh())
    }, 15_000)
    window.addEventListener('pointerdown', signalActivity, { passive: true })
    window.addEventListener('keydown', signalActivity)
    window.addEventListener('touchstart', signalActivity, { passive: true })
    return () => {
      window.clearInterval(checkSession)
      window.removeEventListener('pointerdown', signalActivity)
      window.removeEventListener('keydown', signalActivity)
      window.removeEventListener('touchstart', signalActivity)
    }
  }, [bootstrap?.currentUser?.id, bridge, refresh])

  if (loading) return <main className="loading-screen"><span className="loading-dot" />Loading {bootstrap?.appInfo.productName ?? 'Infoflex'}…</main>
  if (!bootstrap) return <StartupError error={error || 'Unable to load the application.'} />

  let screen
  if (!bootstrap.license.canUse) {
    screen = <LicenseScreen
      bridge={bridge}
      summary={bootstrap.license}
      settings={bootstrap.settings}
      productName={bootstrap.appInfo.productName}
      appVersion={bootstrap.appInfo.appVersion}
      onUpdated={async () => { await refresh() }}
    />
  } else if (!bootstrap.hasUsers) {
    screen = <SetupScreen
      bridge={bridge}
      settings={bootstrap.settings}
      context={bootstrap.setupContext}
      productName={bootstrap.appInfo.productName}
      onComplete={() => { void refresh().catch((caught: unknown) => setError(errorMessage(caught))) }}
    />
  } else if (!bootstrap.currentUser) {
    screen = <LoginScreen
      bridge={bridge}
      settings={bootstrap.settings}
      productName={bootstrap.appInfo.productName}
      appVersion={bootstrap.appInfo.appVersion}
      onLogin={() => { void refresh().catch((caught: unknown) => setError(errorMessage(caught))) }}
    />
  } else {
    screen = <AppShell
      bridge={bridge}
      bootstrap={bootstrap}
      onLogout={() => {
        void bridge.logout().then(() => refresh()).catch((caught: unknown) => setError(errorMessage(caught)))
      }}
      onSettingsUpdated={(settings) => setBootstrap((current) => current ? { ...current, settings } : current)}
    />
  }

  return <>
    {licenseWarning(bootstrap) && <LicenseBanner bootstrap={bootstrap} onCheckIn={() => {
      void bridge.checkInLicense().then(async () => { await refresh() }).catch((caught: unknown) => setError(errorMessage(caught)))
    }} />}
    {screen}
    {error && <div className="app-global-error" role="alert">{error}</div>}
  </>
}

function LicenseBanner({ bootstrap, onCheckIn }: { bootstrap: BootstrapData; onCheckIn: () => void }) {
  const license = bootstrap.license
  const endsInDays = license.endsAt ? Math.ceil((Date.parse(license.endsAt) - Date.now()) / 86_400_000) : null
  const message = license.status === 'grace'
    ? 'License expired. Offline grace is active; the host is checking for renewal.'
    : endsInDays !== null && endsInDays <= 7
      ? `License expires in ${Math.max(0, endsInDays)} day${endsInDays === 1 ? '' : 's'}. If a sale is in progress, finish it before expiry; a lock does not delete data.`
      : ''
  if (!message) return null
  return <aside className={`license-expiry-banner${license.status === 'grace' ? ' is-grace' : ''}`} role="status">
    <span>{message}</span><button type="button" onClick={onCheckIn}>Check for renewal</button>
  </aside>
}

function licenseWarning(bootstrap: BootstrapData): boolean {
  if (bootstrap.license.status === 'grace') return true
  if (bootstrap.license.status !== 'active' || !bootstrap.license.endsAt) return false
  return (Date.parse(bootstrap.license.endsAt) - Date.now()) / 86_400_000 <= 7
}

function StartupError({ error }: { error: string }) {
  return <main className="loading-screen" role="alert"><div className="startup-error"><strong>Infoflex could not start.</strong><span>{error}</span></div></main>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.'
}
