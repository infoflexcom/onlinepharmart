/**
 * The HTML primitives every portal page is built from: escaping, the document shell, the brand bar, status
 * pills and forms. There is no template engine here on purpose — the whole portal is a few hundred lines of
 * tagged-template HTML, which is easier to audit for escaping than a template language with its own semantics.
 */

/** Escapes for element text and quoted attributes. Every page value passes through here or `attribute`. */
export function e(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      default: return '&#39;'
    }
  })
}

/** Builds a hidden CSRF field. Every state-changing form in the portal must include one. */
export function csrfField(token: string): string {
  return `<input type="hidden" name="_csrf" value="${e(token)}">`
}

export interface PageOptions {
  title: string
  /** The session's CSRF token, needed by the brand bar's sign-out form. */
  csrf?: string
  /** Inner HTML of the page. */
  body: string
  /** Signed-in pages show the brand bar and the section navigation. */
  vendor?: { displayName: string; role: string; email: string }
  active?: string
  /** Set on the sign-in and setup pages, which have no chrome. */
  bare?: boolean
}

const NAV: Array<{ id: string; href: string; label: string }> = [
  { id: 'dashboard', href: '/portal', label: 'Dashboard' },
  { id: 'customers', href: '/portal/customers', label: 'Customers' },
  { id: 'licenses', href: '/portal/licenses', label: 'Licences' },
  { id: 'onsite', href: '/portal/onsite', label: 'On-site' },
  { id: 'relay', href: '/portal/relay', label: 'Relay' },
  { id: 'team', href: '/portal/team', label: 'Team' },
  { id: 'audit', href: '/portal/audit', label: 'Audit log' },
]

export function renderPage(options: PageOptions): string {
  const nav = !options.bare && options.vendor
    ? `<nav class="nav" aria-label="Portal sections">${NAV.map((item) =>
        `<a href="${item.href}"${options.active === item.id ? ' class="active" aria-current="page"' : ''}>${e(item.label)}</a>`).join('')}</nav>`
    : ''
  const brand = options.vendor
    ? `<header class="brandbar">
        <img src="/portal/assets/logo.png" alt="Infoflex">
        <span class="tag">Vendor Portal</span>
        <span class="spacer"></span>
        <span class="small" style="color:#cfd9e8">${e(options.vendor.displayName)} · ${e(options.vendor.role === 'OWNER' ? 'Owner' : 'Staff')}</span>
        <form method="post" action="/portal/logout">${csrfField(options.csrf ?? '')}<button class="link" type="submit" style="color:#fff">Sign out</button></form>
      </header>`
    : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light">
<meta name="robots" content="noindex, nofollow">
<title>${e(options.title)} · Infoflex Vendor Portal</title>
<link rel="icon" href="/portal/assets/favicon.png">
<link rel="apple-touch-icon" href="/portal/assets/favicon.png">
<link rel="stylesheet" href="/portal/assets/portal.css">
</head>
<body>
${brand}
${options.bare ? options.body : `<main class="shell">${nav}${options.body}</main>`}
<footer class="foot">Infoflex Vendor Portal · Strategy | Consulting | Innovation<br>
This portal stores licence and customer-contact data only. It never receives shop sales, stock or customer records.</footer>
</body>
</html>`
}

export function statusPill(status: string): string {
  const label = status === 'expiring' ? 'Expiring' : status.charAt(0).toUpperCase() + status.slice(1)
  return `<span class="pill pill-${e(status)}">${e(label)}</span>`
}

export function notice(kind: 'ok' | 'error' | 'info', message: string): string {
  const cls = kind === 'ok' ? ' notice ok' : kind === 'error' ? ' notice error' : ' notice'
  return `<div class="${cls.trim()}" role="${kind === 'error' ? 'alert' : 'status'}">${e(message)}</div>`
}

