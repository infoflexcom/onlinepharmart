import { useEffect, useState } from 'react'
import { formatMoney } from '@shared/currency/money'
import type { AppPage, NavigationItem, PublicUser } from '@shared/auth/types'
import type { InfoflexBridge } from '@shared/bridge'
import type { BootstrapData, ShopSettings } from '@shared/shop/types'
import { UsersAndSeats } from './UsersAndSeats'
import { SettingsScreen } from './SettingsScreen'
import { InventoryWorkspace } from './InventoryWorkspace'
import { PosWorkspace } from './PosWorkspace'
import { OrderWorkflow } from './OrderWorkflow'
import { ReturnsWorkspace } from './ReturnsWorkspace'
import { ReportsWorkspace } from './ReportsWorkspace'
import { MobileAccessWorkspace } from './MobileAccessWorkspace'
import { MobileApprovalWatcher } from './MobileApprovalWatcher'

interface Props {
  bridge: InfoflexBridge
  bootstrap: BootstrapData
  onLogout: () => void
  onSettingsUpdated: (settings: ShopSettings) => void
}

export function AppShell({ bridge, bootstrap, onLogout, onSettingsUpdated }: Props) {
  const [navigation, setNavigation] = useState<NavigationItem[]>([])
  const [activePage, setActivePage] = useState<AppPage>('dashboard')
  const [message, setMessage] = useState('')
  const user = bootstrap.currentUser!

  useEffect(() => {
    let active = true
    void bridge.getNavigation().then((items) => {
      if (!active) return
      setNavigation(items)
      if (!items.some(({ id }) => id === activePage)) setActivePage(items[0]?.id ?? 'dashboard')
    }).catch((error: unknown) => setMessage(errorMessage(error)))
    return () => { active = false }
  }, [bridge, user.id, user.role, activePage])

  async function navigate(page: AppPage): Promise<void> {
    setMessage('')
    try {
      const result = await bridge.openPage(page)
      setActivePage(result.page)
    } catch (error) {
      setMessage(errorMessage(error))
    }
  }

  return (
    <main className="app-shell">
      <aside className="app-sidebar">
        <div className="shell-brand"><img src="/branding/logo-transparent.png" alt="Infoflex" /><div><strong>{bootstrap.appInfo.productName}</strong><span>RETAIL MANAGEMENT</span></div></div>
        <div className="sidebar-role"><span className={`role-dot role-dot--${user.role.toLowerCase()}`} />{roleLabel(user.role)}</div>
        <nav className="shell-nav" aria-label="Main navigation">
          {navigation.map((item) => <button key={item.id} className={activePage === item.id ? 'shell-nav__item is-active' : 'shell-nav__item'} onClick={() => void navigate(item.id)}><NavGlyph page={item.id} /><span>{item.label}</span></button>)}
        </nav>
        <div className="sidebar-bottom"><span>Strategy | Consulting | Innovation</span><span>Version {bootstrap.appInfo.appVersion}</span></div>
      </aside>
      <section className="shell-main">
        <header className="shell-topbar">
          <div className="shell-page-title"><span>{bootstrap.appInfo.productName}</span><h1>{navigation.find(({ id }) => id === activePage)?.label ?? 'Dashboard'}</h1>{user.role !== 'ADMIN' && <small className="mobile-availability-note">Mobile app: not available for this role.</small>}</div>
          <div className="shell-user-area"><div className="shell-store-name">{bootstrap.settings.profile.name}</div><div className="shell-user-menu"><span className="user-avatar">{initials(user.fullName)}</span><div><strong>{user.fullName}</strong><small>{roleLabel(user.role)}</small></div><button type="button" className="logout-button" onClick={onLogout}>Sign out</button></div></div>
        </header>
        <div className="shell-content">
          {/* A phone waiting for approval raises this dialog on any screen, not only Mobile Access. */}
          <MobileApprovalWatcher bridge={bridge} enabled={user.role === 'ADMIN'} />
          {message && <div className="form-error shell-message" role="alert"><span>!</span>{message}</div>}
          {activePage === 'pos'
            ? <PosWorkspace bridge={bridge} bootstrap={bootstrap} user={user} onNavigate={(page) => void navigate(page)} />
            : activePage === 'orders'
            ? <OrderWorkflow bridge={bridge} bootstrap={bootstrap} user={user} />
            : activePage === 'products'
            ? <InventoryWorkspace bridge={bridge} bootstrap={bootstrap} user={user} mode="products" onNavigate={(page) => void navigate(page)} />
            : activePage === 'stock'
              ? <InventoryWorkspace bridge={bridge} bootstrap={bootstrap} user={user} mode="stock" onNavigate={(page) => void navigate(page)} />
              : activePage === 'returns'
                ? <ReturnsWorkspace bridge={bridge} bootstrap={bootstrap} user={user} />
                : activePage === 'users' && user.role === 'ADMIN'
                ? <UsersAndSeats bridge={bridge} currentUser={user} />
                : activePage === 'reports'
                  ? <ReportsWorkspace bridge={bridge} bootstrap={bootstrap} user={user} />
                  : activePage === 'mobile' && user.role === 'ADMIN'
                    ? <MobileAccessWorkspace bridge={bridge} bootstrap={bootstrap} />
                : activePage === 'settings' && user.role === 'ADMIN'
                  ? <SettingsScreen bridge={bridge} settings={bootstrap.settings} license={bootstrap.license} onSaved={onSettingsUpdated} onNavigate={(page) => void navigate(page)} />
                  : <PlaceholderPage page={activePage} user={user} bootstrap={bootstrap} />}
        </div>
      </section>
    </main>
  )
}

function PlaceholderPage({ page, user, bootstrap }: { page: AppPage; user: PublicUser; bootstrap: BootstrapData }) {
  const salesAllowed = user.role === 'ADMIN' || user.role === 'SUPERVISOR' || user.role === 'CASHIER'
  return (
    <section className="shell-placeholder">
      <div className="placeholder-icon"><NavGlyph page={page} /></div>
      <span className="eyebrow eyebrow--gold">{bootstrap.appInfo.productName.toUpperCase()}</span>
      <h2>{pageLabel(page)}</h2>
      <p>This page is ready in the application shell. Operational {pageLabel(page).toLowerCase()} workflows are delivered in their later product phase.</p>
      {page === 'dashboard' && <div className="dashboard-summary"><div><span>Store</span><strong>{bootstrap.settings.profile.name}</strong></div><div><span>Currency</span><strong>{bootstrap.settings.currency.code} · {formatMoney(123456789n, bootstrap.settings.currency, bootstrap.settings.display)}</strong></div><div><span>Signed in as</span><strong>{user.fullName} · {roleLabel(user.role)}</strong></div></div>}
      {page === 'pos' && <div className="dashboard-summary"><div><span>Retail sales</span><strong>Desktop only</strong></div><div><span>Wholesale permission</span><strong>{user.role === 'ADMIN' ? 'Enabled' : user.permissions.allowWholesale ? 'Enabled' : 'Disabled'}</strong></div><div><span>Current amount style</span><strong>{bootstrap.settings.display.amountDisplay === 'symbol' ? 'Currency symbol' : 'ISO / custom code'}</strong></div></div>}
      {!salesAllowed && <p className="access-note">This role cannot access sales transactions.</p>}
    </section>
  )
}

function NavGlyph({ page }: { page: AppPage }) {
  const symbols: Partial<Record<AppPage, string>> = {
    dashboard: '◫', pos: '▣', products: '◈', stock: '▤', returns: '↶', customers: '◎', reports: '▥',
    users: '♙', mobile: '▯', settings: '⚙', departments: '▦', promotions: '✦', loyalty: '♡', shifts: '◷',
    batches: '⌁', approvals: '✓', orders: '⧉',
  }
  return <span className="nav-glyph" aria-hidden="true">{symbols[page] ?? '•'}</span>
}

function pageLabel(page: AppPage): string {
  const labels: Record<AppPage, string> = {
    dashboard: 'Dashboard', pos: 'Point of Sale', products: 'Products', stock: 'Stock / Purchases', returns: 'Returns',
    customers: 'Customers', reports: 'Reports', users: 'Users', mobile: 'Mobile Access', settings: 'Settings',
    departments: 'Departments', promotions: 'Promotions', loyalty: 'Loyalty', shifts: 'Shifts', batches: 'Batches / Expiry', approvals: 'Approvals',
    orders: 'Orders / Receipts',
  }
  return labels[page]
}

function roleLabel(role: PublicUser['role']): string {
  if (role === 'ADMIN') return 'Admin'
  if (role === 'SUPERVISOR') return 'Supervisor'
  return 'Cashier'
}

function initials(value: string): string {
  return value.trim().split(/\s+/u).slice(0, 2).map((part) => part[0] ?? '').join('').toUpperCase() || 'I'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'This action could not be completed.'
}
