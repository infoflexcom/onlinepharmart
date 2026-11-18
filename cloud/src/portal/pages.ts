import { CURRENCIES, getCurrency } from '../../../src/currency/catalog'
import type { CustomerRow, LicenseHistoryEntry, LicenseView } from '../license-service'
import { e, statusPill } from './html'

/**
 * The portal's page bodies. Each function returns HTML for the inside of the shell; the router in
 * `router.ts` owns the session, CSRF and form handling.
 *
 * Nothing in this file formats an amount, because the cloud never receives one. Where the brief asks for the
 * currency, the page shows the ISO code and the symbol from the built-in catalogue — both of which are
 * public reference data, not shop data, and both of which help the vendor pick the right entry.
 */

export function dashboardPage(input: {
  csrf: string
  licenses: LicenseView[]
  buckets: { in7: LicenseView[]; in14: LicenseView[]; in30: LicenseView[] }
  relayOnline: number
  onSiteCount: number
  mailConfigured: boolean
}): string {
  const active = input.licenses.filter((license) => license.effective_status === 'active' || license.effective_status === 'expiring')
  const online = input.licenses.filter((license) => license.online_now).length
  return `
<h1>Dashboard</h1>
<p class="muted">Licences, renewals and the relay at a glance. Times are the server's clock (UTC in the logs).</p>

<div class="kpi">
  <div class="card"><div class="label">Active licences</div><div class="big">${active.length}</div><small>${input.licenses.length} in total</small></div>
  <div class="card"><div class="label">Expiring in 30 days</div><div class="big">${input.buckets.in30.length}</div><small>${input.buckets.in7.length} within 7 days</small></div>
  <div class="card"><div class="label">Checked in now</div><div class="big">${online}</div><small>within the last 5 minutes</small></div>
  <div class="card"><div class="label">Relay online</div><div class="big">${input.relayOnline}</div><small>${input.onSiteCount} on-site licence${input.onSiteCount === 1 ? '' : 's'}</small></div>
</div>

${input.buckets.in30.length > 0 ? `
<section class="card">
  <h2>Expiring soon</h2>
  <p class="muted">Renew from here — the shop unlocks by itself at its next check-in, with nothing typed at the customer.</p>
  <div class="table-wrap"><table class="responsive">
    <thead><tr><th>Customer</th><th>Ends</th><th>Days left</th><th>Bucket</th><th></th></tr></thead>
    <tbody>${input.buckets.in30.map((license) => `
      <tr>
        <td data-label="Customer"><a href="/portal/licenses/${e(license.id)}">${e(license.customer_name)}</a></td>
        <td data-label="Ends" class="nowrap">${e(license.ends_at.slice(0, 10))}</td>
        <td data-label="Days left">${license.days_remaining}</td>
        <td data-label="Bucket">${license.days_remaining <= 7 ? '<span class="pill pill-expired">7 days</span>' : license.days_remaining <= 14 ? '<span class="pill pill-expiring">14 days</span>' : '<span class="pill pill-expiring">30 days</span>'}</td>
        <td data-label=""><a class="button" href="/portal/licenses/${e(license.id)}#renew">Renew</a></td>
      </tr>`).join('')}</tbody>
  </table></div>
</section>` : '<div class="card"><h2>Nothing is expiring in the next 30 days</h2><p class="muted">Every active licence has more than a month to run.</p></div>'}

<section class="card">
  <h2>Expiry reminders</h2>
  ${input.mailConfigured
    ? `<p>The portal sends a reminder to the vendor inbox at 30, 14 and 7 days before a licence ends, and again when one has expired. Configure the customer-facing copy in the e-mail settings of your deployment.</p>`
    : `<div class="warn-box"><strong>E-mail is not configured.</strong> Add <span class="mono">INFOFLEX_CLOUD_SMTP_HOST</span> and the other SMTP variables to send reminders. The dashboard buckets above work without e-mail, and the portal never sends anything else.</div>`}
</section>

${relayWarning(input.relayOnline)}
`
}

function relayWarning(relayOnline: number): string {
  if (relayOnline > 0) return ''
  return `<section class="card"><h2>Internet relay</h2>
    <p class="muted">No shop PC is currently connected to the relay. The relay is optional: a shop on the same Wi-Fi as the Admin's phone works without it.</p>
    <p><a class="button" href="/portal/relay">Relay status</a></p></section>`
}

export function customersPage(input: { csrf: string; customers: Array<CustomerRow & { license_count: number; active_count: number }>; search: string }): string {
  return `
<h1>Customers</h1>
<div class="searchbar">
  <form method="get" action="/portal/customers" style="display:flex;gap:.5rem;flex:1;flex-wrap:wrap">
    <input type="search" name="q" value="${e(input.search)}" placeholder="Search business, contact, e-mail or phone" aria-label="Search customers">
    <button type="submit">Search</button>
  </form>
  <a class="button primary" href="/portal/licenses/new">New customer and licence</a>
</div>
${input.customers.length === 0
  ? '<div class="empty">No customers yet. Create one to issue its first licence.</div>'
  : `<div class="table-wrap"><table class="responsive">
      <thead><tr><th>Business</th><th>Contact</th><th>Currency</th><th>Licences</th><th></th></tr></thead>
      <tbody>${input.customers.map((customer) => `
        <tr>
          <td data-label="Business"><a href="/portal/customers/${e(customer.id)}">${e(customer.business_name)}</a></td>
          <td data-label="Contact">${e(customer.contact_name || '—')}<br><small>${e(customer.email || customer.phone || '')}</small></td>
          <td data-label="Currency">${customer.default_currency ? `<span class="key">${e(customer.default_currency)}</span> ${currencyHint(customer.default_currency)}${customer.lock_currency ? '<br><small>currency locked</small>' : ''}` : '<small class="muted">not set</small>'}</td>
          <td data-label="Licences">${customer.license_count} <small class="muted">(${customer.active_count} active)</small></td>
          <td data-label=""><a class="button" href="/portal/customers/${e(customer.id)}">Open</a></td>
        </tr>`).join('')}</tbody>
    </table></div>`}`
}

export function customerPage(input: { csrf: string; customer: CustomerRow; licenses: LicenseView[] }): string {
  return `
<p><a href="/portal/customers">← All customers</a></p>
<h1>${e(input.customer.business_name)}</h1>
<p class="muted">${e(input.customer.contact_name || 'No contact name')} · ${e(input.customer.email || 'no e-mail')} · ${e(input.customer.phone || 'no phone')}</p>

<div class="grid-2">
  <section class="card">
    <h2>Contact details</h2>
    <form method="post" action="/portal/customers/${e(input.customer.id)}">
      <input type="hidden" name="_csrf" value="${e(input.csrf)}">
      <label class="field"><span>Business name</span><input type="text" name="businessName" value="${e(input.customer.business_name)}" required maxlength="160"></label>
      <label class="field"><span>Contact name</span><input type="text" name="contactName" value="${e(input.customer.contact_name)}" maxlength="120"></label>
      <label class="field"><span>E-mail</span><input type="email" name="email" value="${e(input.customer.email)}" maxlength="160"></label>
      <label class="field"><span>Phone</span><input type="tel" name="phone" value="${e(input.customer.phone)}" maxlength="40"></label>
      <label class="field"><span>Notes</span><textarea name="notes" maxlength="2000">${e(input.customer.notes)}</textarea></label>
      <button class="primary" type="submit">Save details</button>
    </form>
  </section>

  <section class="card">
    <h2>Licences</h2>
    ${input.licenses.length === 0 ? '<p class="muted">No licences for this customer yet.</p>' : `
      <div class="table-wrap"><table class="responsive">
        <thead><tr><th>Key</th><th>Edition</th><th>Status</th><th>Ends</th><th></th></tr></thead>
        <tbody>${input.licenses.map((license) => `
          <tr>
            <td data-label="Key"><span class="key">${e(license.license_key)}</span>${license.source === 'onsite' ? ' <span class="pill pill-onsite">on-site</span>' : ''}</td>
            <td data-label="Edition">${e(editionLabel(license.edition))}</td>
            <td data-label="Status">${statusPill(license.effective_status)}</td>
            <td data-label="Ends" class="nowrap">${e(license.ends_at.slice(0, 10))}</td>
            <td data-label=""><a class="button" href="/portal/licenses/${e(license.id)}">Open</a></td>
          </tr>`).join('')}</tbody>
      </table></div>`}
    <p style="margin-top:1rem"><a class="button primary" href="/portal/customers/${e(input.customer.id)}/licenses/new">Add another licence</a></p>
  </section>
</div>`
}

export function licensesPage(input: { csrf: string; licenses: LicenseView[]; search: string; filter: string }): string {
  const filters: Array<[string, string]> = [
    ['', 'All'], ['active', 'Active'], ['expiring', 'Expiring 30 days'], ['expired', 'Expired'],
    ['suspended', 'Suspended'], ['online', 'Online now'], ['onsite', 'On-site activated'], ['relay', 'Relay online'],
  ]
  return `
<h1>Licences</h1>
<div class="tabs">${filters.map(([value, label]) =>
  `<a href="/portal/licenses?filter=${e(value)}&q=${encodeURIComponent(input.search)}"${input.filter === value ? ' class="on"' : ''}>${e(label)}</a>`).join('')}</div>
<div class="searchbar">
  <form method="get" action="/portal/licenses" style="display:flex;gap:.5rem;flex:1;flex-wrap:wrap">
    <input type="hidden" name="filter" value="${e(input.filter)}">
    <input type="search" name="q" value="${e(input.search)}" placeholder="Search customer, key, contact or e-mail" aria-label="Search licences">
    <button type="submit">Search</button>
  </form>
  <a class="button" href="/portal/licenses/export.csv?filter=${encodeURIComponent(input.filter)}&q=${encodeURIComponent(input.search)}">Export CSV</a>
  <a class="button primary" href="/portal/licenses/new">New licence</a>
</div>
${input.licenses.length === 0 ? '<div class="empty">No licences match that filter.</div>' : `
<div class="table-wrap"><table class="responsive">
  <thead><tr><th>Customer</th><th>Key</th><th>Edition</th><th>Status</th><th>Ends</th><th>Currency</th><th>Device</th><th></th></tr></thead>
  <tbody>${input.licenses.map((license) => `
    <tr>
      <td data-label="Customer"><a href="/portal/licenses/${e(license.id)}">${e(license.customer_name)}</a></td>
      <td data-label="Key"><span class="key">${e(license.license_key)}</span>${license.source === 'onsite' ? '<br><small class="pill pill-onsite">on-site</small>' : ''}</td>
      <td data-label="Edition">${e(editionLabel(license.edition))}</td>
      <td data-label="Status">${statusPill(license.effective_status)}${license.online_now ? '<br><span class="pill pill-online">online</span>' : ''}</td>
      <td data-label="Ends" class="nowrap">${e(license.ends_at.slice(0, 10))}<br><small class="muted">${license.days_remaining >= 0 ? `${license.days_remaining} days` : 'expired'}</small></td>
      <td data-label="Currency">${license.default_currency ? `<span class="key">${e(license.default_currency)}</span>${license.lock_currency ? '<br><small>locked</small>' : ''}` : '<small class="muted">customer choice</small>'}</td>
      <td data-label="Device">${license.machine_id ? `<span class="mono small">${e(license.machine_id.slice(0, 12))}…</span>` : '<small class="muted">unbound</small>'}</td>
      <td data-label=""><a class="button" href="/portal/licenses/${e(license.id)}">Open</a></td>
    </tr>`).join('')}</tbody>
</table></div>`}`
}

export function licenseDetailPage(input: {
  csrf: string
  license: LicenseView
  customer: CustomerRow
  history: LicenseHistoryEntry[]
  checkIns: Array<{ machine_id: string; app_version: string; platform: string; checked_at: string; ip_address: string | null }>
  relay: { status: string; last_seen_at: string | null; connected_at: string | null } | null
  activationCode: string | null
  offlineMachine: string
}): string {
  const license = input.license
  return `
<p><a href="/portal/licenses">← All licences</a></p>
<h1>${e(input.customer.business_name)}</h1>
<p>${statusPill(license.effective_status)} ${license.online_now ? '<span class="pill pill-online">online now</span>' : ''} ${license.source === 'onsite' ? '<span class="pill pill-onsite">on-site activation</span>' : ''}</p>

<section class="card">
  <h2>Licence key</h2>
  <p><span class="key" style="font-size:1.15rem">${e(license.license_key)}</span></p>
  <p class="muted small">The customer types this into the app's activation screen. Edition: <strong>${e(editionLabel(license.edition))}</strong> · Term ${e(license.starts_at.slice(0, 10))} → ${e(license.ends_at.slice(0, 10))} · ${license.days_remaining >= 0 ? `${license.days_remaining} days left` : `expired ${Math.abs(license.days_remaining)} days ago`}</p>
  <p class="muted small">Default currency: ${license.default_currency ? `<span class="key">${e(license.default_currency)}</span> ${currencyHint(license.default_currency)}${license.lock_currency ? ' — <strong>locked</strong>, the customer cannot change it' : ' — suggested to the customer, who may change it'}` : 'none (the customer chooses)'}</p>
  <p class="muted small">Mobile: local network ${license.mobile_lan ? 'allowed' : 'off'} · Internet ${license.mobile_internet ? 'allowed' : 'off'} · ${license.max_admin_phones} Admin phone${license.max_admin_phones === 1 ? '' : 's'} · grace ${license.grace_days} day${license.grace_days === 1 ? '' : 's'}</p>
  <p class="muted small">Machine: ${license.machine_id ? `<span class="mono">${e(license.machine_id)}</span>` : '<em>not yet bound — the first activation binds it</em>'}</p>
</section>

${relayCard(input.relay)}

<section class="card" id="renew">
  <h2>Renew or reactivate</h2>
  <p class="muted">Takes effect at the customer's next check-in — no password is typed at the shop. Use “Notify now” to push it within a minute instead of waiting for the daily poll.</p>
  <form method="post" action="/portal/licenses/${e(license.id)}/renew">
    <input type="hidden" name="_csrf" value="${e(input.csrf)}">
    <div class="grid-2">
      <label class="field"><span>New end date</span><input type="date" name="endsAt" value="${e(addYears(license.ends_at.slice(0, 10), 1))}" required></label>
      <label class="field"><span>Start date (leave as is to keep the term)</span><input type="date" name="startsAt" value="${e(license.starts_at.slice(0, 10))}"></label>
    </div>
    <div class="button-row" style="margin-bottom:.7rem">
      ${[1, 2, 3, 5].map((years) => `<button type="submit" name="quickYears" value="${years}" class="button">${years} year${years === 1 ? '' : 's'}</button>`).join('')}
    </div>
    <label class="check"><input type="checkbox" name="notifyNow" value="1" checked><span>Notify now (push the change at the next poll, within about a minute)</span></label>
    <button class="primary" type="submit">Save new term</button>
  </form>
</section>

<section class="card">
  <h2>Edition and entitlements</h2>
  <form method="post" action="/portal/licenses/${e(license.id)}/entitlements">
    <input type="hidden" name="_csrf" value="${e(input.csrf)}">
    <div class="grid-2">
      <label class="field"><span>Edition</span>
        <select name="edition">
          ${(['PHARMACY', 'SUPERMARKET', 'BOTH'] as const).map((edition) =>
            `<option value="${edition}"${license.edition === edition ? ' selected' : ''}>${e(editionLabel(edition))}</option>`).join('')}
        </select>
      </label>
      <label class="field"><span>Admin phone limit</span><input type="number" name="maxAdminPhones" min="1" max="100" value="${license.max_admin_phones}" required></label>
      <label class="field"><span>Grace period after expiry (days)</span><input type="number" name="graceDays" min="0" max="30" value="${license.grace_days}"></label>
      <label class="field"><span>Default currency</span>
        <select name="defaultCurrencyCode">${currencyOptions(license.default_currency)}</select>
      </label>
    </div>
    <label class="check"><input type="checkbox" name="mobileLan" value="1"${license.mobile_lan ? ' checked' : ''}><span>Allow mobile access on the shop's local network</span></label>
    <label class="check"><input type="checkbox" name="mobileInternet" value="1"${license.mobile_internet ? ' checked' : ''}><span>Allow mobile access over the Internet (through the relay)</span></label>
    <label class="check"><input type="checkbox" name="lockCurrency" value="1"${license.lock_currency ? ' checked' : ''}><span>Lock the currency for this customer</span></label>
    <button class="primary" type="submit">Save entitlements</button>
  </form>
</section>

<section class="card">
  <h2>Suspend and reactivate</h2>
  <p class="muted">A suspended licence stops working at the shop's next check-in, after its grace period. Data is untouched; reactivating restores access.</p>
  <div class="actions">
    ${license.status === 'active'
      ? `<form method="post" action="/portal/licenses/${e(license.id)}/suspend"><input type="hidden" name="_csrf" value="${e(input.csrf)}"><button class="danger" type="submit">Suspend licence</button></form>`
      : license.status === 'suspended'
        ? `<form method="post" action="/portal/licenses/${e(license.id)}/unsuspend"><input type="hidden" name="_csrf" value="${e(input.csrf)}"><button class="primary" type="submit">Reactivate licence</button></form>`
        : '<p class="muted small">This licence is revoked and cannot be changed. Issue a new licence instead.</p>'}
    ${license.status !== 'revoked' ? `<form method="post" action="/portal/licenses/${e(license.id)}/revoke" onsubmit="return confirm('Revoke this licence permanently? The shop will be locked at its next check-in.')"><input type="hidden" name="_csrf" value="${e(input.csrf)}"><button class="danger" type="submit">Revoke permanently</button></form>` : ''}
  </div>
</section>

<section class="card">
  <h2>Machine binding</h2>
  <p class="muted">Only the vendor can rebind. Rebinding clears the old machine so the next activation from a new PC is accepted.</p>
  <form method="post" action="/portal/licenses/${e(license.id)}/rebind" onsubmit="return confirm('Rebind this licence? The current PC will be locked out at its next check-in until it activates again.')">
    <input type="hidden" name="_csrf" value="${e(input.csrf)}">
    <button class="danger" type="submit">Reset machine binding</button>
  </form>
</section>

<section class="card">
  <h2>Offline licence file</h2>
  <p class="muted">For a shop with no Internet. Enter the machine ID the customer reads from the app's activation screen (or ask them to send it), and download a signed <span class="mono">.lic</span> file. The file is bound to that machine; another PC will reject it.</p>
  <form method="get" action="/portal/licenses/${e(license.id)}/file">
    <label class="field"><span>Machine ID</span><input type="text" name="machine" value="${e(input.offlineMachine)}" placeholder="64 hex characters" pattern="[A-Fa-f0-9-]{16,128}" required></label>
    <button class="primary" type="submit">Download licence file</button>
  </form>
</section>

<section class="card">
  <h2>Activation code</h2>
  <p class="muted">A one-time code for a phone call or a WhatsApp message when the customer cannot copy the key.</p>
  ${input.activationCode ? `<p><span class="key" style="font-size:1.2rem">${e(input.activationCode)}</span></p><p class="muted small">Valid for 15 minutes. Do not write it down.</p>` : ''}
  <form method="post" action="/portal/licenses/${e(license.id)}/activation-code">
    <input type="hidden" name="_csrf" value="${e(input.csrf)}">
    <button type="submit">Generate activation code</button>
  </form>
</section>

<section class="card">
  <h2>Recent check-ins</h2>
  ${input.checkIns.length === 0 ? '<p class="muted">This licence has not checked in yet.</p>' : `
    <div class="table-wrap"><table class="responsive">
      <thead><tr><th>When</th><th>App version</th><th>Platform</th><th>Machine</th><th>Address</th></tr></thead>
      <tbody>${input.checkIns.map((row) => `
        <tr>
          <td data-label="When">${e(row.checked_at.slice(0, 19).replace('T', ' '))}</td>
          <td data-label="App version">${e(row.app_version || '—')}</td>
          <td data-label="Platform">${e(row.platform || '—')}</td>
          <td data-label="Machine"><span class="mono small">${e(row.machine_id.slice(0, 12))}…</span></td>
          <td data-label="Address"><span class="mono small">${e(row.ip_address ?? '—')}</span></td>
        </tr>`).join('')}</tbody>
    </table></div>`}
</section>

<section class="card">
  <h2>History</h2>
  ${input.history.length === 0 ? '<p class="muted">No history yet.</p>' : `
    <div class="table-wrap"><table class="responsive">
      <thead><tr><th>When</th><th>Action</th><th>By</th><th>Detail</th></tr></thead>
      <tbody>${input.history.map((entry) => `
        <tr>
          <td data-label="When">${e(entry.created_at.slice(0, 19).replace('T', ' '))}</td>
          <td data-label="Action">${e(entry.action)}</td>
          <td data-label="By">${e(entry.actor)}</td>
          <td data-label="Detail"><small class="mono">${e(JSON.stringify(entry.detail))}</small></td>
        </tr>`).join('')}</tbody>
    </table></div>`}
</section>`
}

function relayCard(relay: { status: string; last_seen_at: string | null; connected_at: string | null } | null): string {
  if (!relay) {
    return `<section class="card"><h2>Internet relay</h2><p class="muted">This shop has never connected to the relay. It does not need to: the Admin's phone reaches the PC over the shop Wi-Fi.</p></section>`
  }
  return `<section class="card"><h2>Internet relay</h2>
    <p>${relay.status === 'online' ? '<span class="pill pill-online">connected</span>' : '<span class="pill pill-offline">offline</span>'}
    ${relay.last_seen_at ? `<span class="muted small">last seen ${e(relay.last_seen_at.slice(0, 19).replace('T', ' '))}</span>` : ''}</p>
    <p class="muted small">The relay forwards encrypted frames only. It cannot read the shop's traffic and stores no business data.</p>
  </section>`
}

export function newLicensePage(input: {
  csrf: string
  customers: CustomerRow[]
  today: string
  oneYear: string
  preselectedCustomerId: string | null
  error: string | null
}): string {
  return `
<p><a href="/portal/licenses">← All licences</a></p>
<h1>New customer and licence</h1>
${input.error ? `<div class="notice error" role="alert">${e(input.error)}</div>` : ''}
<form method="post" action="/portal/licenses/new">
  <input type="hidden" name="_csrf" value="${e(input.csrf)}">
  <section class="card">
    <h2>Customer</h2>
    <div class="grid-2">
      <label class="field"><span>Business name</span><input type="text" name="businessName" required maxlength="160" placeholder="Harbor Health Pharmacy"></label>
      <label class="field"><span>Contact name</span><input type="text" name="contactName" maxlength="120"></label>
      <label class="field"><span>E-mail</span><input type="email" name="email" maxlength="160"></label>
      <label class="field"><span>Phone</span><input type="tel" name="phone" maxlength="40"></label>
    </div>
    <label class="field"><span>Notes (never used for shop data)</span><textarea name="notes" maxlength="2000"></textarea></label>
  </section>

  <section class="card">
    <h2>Licence</h2>
    <div class="grid-2">
      <label class="field"><span>Edition</span>
        <select name="edition">
          <option value="PHARMACY">Infoflex Pharm (pharmacy)</option>
          <option value="SUPERMARKET">Infoflex Mart (supermarket)</option>
          <option value="BOTH">Both editions</option>
        </select>
      </label>
      <label class="field"><span>Start date</span><input type="date" name="startsAt" value="${e(input.today)}" required></label>
      <label class="field"><span>End date</span><input type="date" name="endsAt" value="${e(input.oneYear)}" required></label>
      <label class="field"><span>Quick select</span>
        <div class="button-row" id="quicks">
          ${[1, 2, 3, 5].map((years) => `<button type="button" class="button" data-years="${years}">${years} year${years === 1 ? '' : 's'}</button>`).join('')}
        </div>
      </label>
      <label class="field"><span>Admin phones</span><input type="number" name="maxAdminPhones" min="1" max="100" value="1" required></label>
      <label class="field"><span>Grace period after expiry (days)</span><input type="number" name="graceDays" min="0" max="30" value="3"></label>
    </div>
    <label class="check"><input type="checkbox" name="mobileLan" value="1" checked><span>Allow mobile access on the shop's local network</span></label>
    <label class="check"><input type="checkbox" name="mobileInternet" value="1" checked><span>Allow mobile access over the Internet (through the relay)</span></label>
    <label class="check"><input type="checkbox" name="sendWelcome" value="1" checked><span>E-mail the welcome message with the activation key (requires e-mail settings)</span></label>
  </section>

  <section class="card">
    <h2>Currency</h2>
    <p class="muted">The local currency of the shop. The app preselects it on the setup screen. It is a CODE only — the cloud never stores an amount.</p>
    <div class="grid-2">
      <label class="field"><span>DEFAULT CURRENCY</span><select name="defaultCurrencyCode">${currencyOptions('NGN')}</select>
        <span class="muted small">The till preselects this at setup. The customer can still change it unless you lock it below.</span></label>
      <label class="field"><span>&nbsp;</span><span class="check" style="margin:0"><input type="checkbox" name="lockCurrency" value="1"><span>Lock currency for this customer (they cannot change it)</span></span></label>
    </div>
  </section>

  <button class="primary" type="submit" style="min-height:52px;font-size:1.05rem">Create customer and licence</button>
</form>
<script>
(function () {
  var starts = document.querySelector('input[name=startsAt]');
  var ends = document.querySelector('input[name=endsAt]');
  function addYears(dateValue, years) {
    if (!dateValue) return '';
    var d = new Date(dateValue + 'T00:00:00Z');
    var day = d.getUTCDate(), month = d.getUTCMonth(), year = d.getUTCFullYear() + years;
    var candidate = new Date(Date.UTC(year, month, day));
    if (candidate.getUTCMonth() !== month) candidate = new Date(Date.UTC(year, month + 1, 0));
    return candidate.toISOString().slice(0, 10);
  }
  document.querySelectorAll('#quicks button').forEach(function (button) {
    button.addEventListener('click', function () {
      ends.value = addYears(starts.value, Number(button.getAttribute('data-years')));
    });
  });
})();
</script>`
}

export function teamPage(input: { csrf: string; users: Array<{ id: string; email: string; display_name: string; role: string; is_active: number; totp_confirmed_at: string | null; last_login_at: string | null }>; isOwner: boolean; totpSetup: { secret: string; uri: string; qr: string } | null; newUserId: string | null; notice: string | null }): string {
  return `
<h1>Team</h1>
${input.notice ? `<div class="notice">${e(input.notice)}</div>` : ''}
<p class="muted">Owner accounts can do everything. Staff accounts can manage licences but cannot create accounts or reset another account's two-factor.</p>
${input.totpSetup ? `<section class="card">
  <h2>Finish two-factor setup</h2>
  <p>Scan this with your authenticator app, then enter the six-digit code to activate the account.</p>
  <img class="qr" src="${e(input.totpSetup.qr)}" alt="Two-factor setup QR code">
  <p class="muted small">Cannot scan? Type this key: <span class="key">${e(groupSecret(input.totpSetup.secret))}</span></p>
  <form method="post" action="/portal/team/totp">
    <input type="hidden" name="_csrf" value="${e(input.csrf)}">
    <input type="hidden" name="userId" value="${e(input.newUserId ?? '')}">
    <label class="field"><span>Six-digit code</span><input type="text" name="code" inputmode="numeric" pattern="[0-9 ]{6,9}" autocomplete="one-time-code" required></label>
    <button class="primary" type="submit">Activate two-factor</button>
  </form>
</section>` : ''}
<section class="card">
  <h2>Accounts</h2>
  <div class="table-wrap"><table class="responsive">
    <thead><tr><th>Name</th><th>E-mail</th><th>Role</th><th>Two-factor</th><th>Last sign-in</th><th></th></tr></thead>
    <tbody>${input.users.map((user) => `
      <tr>
        <td data-label="Name">${e(user.display_name)}${user.is_active ? '' : ' <span class="pill pill-revoked">disabled</span>'}</td>
        <td data-label="E-mail">${e(user.email)}</td>
        <td data-label="Role">${user.role === 'OWNER' ? 'Owner' : 'Staff'}</td>
        <td data-label="Two-factor">${user.totp_confirmed_at ? '<span class="pill pill-active">active</span>' : '<span class="pill pill-expiring">not set up</span>'}</td>
        <td data-label="Last sign-in">${user.last_login_at ? e(user.last_login_at.slice(0, 19).replace('T', ' ')) : '—'}</td>
        <td data-label="">${input.isOwner ? `
          <div class="actions">
            <form method="post" action="/portal/team/${e(user.id)}/reset-totp" onsubmit="return confirm('Reset two-factor for ${e(user.email)}? They will set it up again at their next sign-in.')"><input type="hidden" name="_csrf" value="${e(input.csrf)}"><button class="danger" type="submit">Reset 2FA</button></form>
            <form method="post" action="/portal/team/${e(user.id)}/toggle"><input type="hidden" name="_csrf" value="${e(input.csrf)}"><button type="submit">${user.is_active ? 'Disable' : 'Enable'}</button></form>
          </div>` : ''}</td>
      </tr>`).join('')}</tbody>
  </table></div>
</section>
${input.isOwner ? `<section class="card">
  <h2>Add an account</h2>
  <form method="post" action="/portal/team/new">
    <input type="hidden" name="_csrf" value="${e(input.csrf)}">
    <div class="grid-2">
      <label class="field"><span>Name</span><input type="text" name="displayName" required maxlength="120"></label>
      <label class="field"><span>E-mail</span><input type="email" name="email" required maxlength="200"></label>
      <label class="field"><span>Password (at least 12 characters)</span><input type="password" name="password" required minlength="12" autocomplete="new-password"></label>
      <label class="field"><span>Role</span><select name="role"><option value="STAFF">Staff</option><option value="OWNER">Owner</option></select></label>
    </div>
    <button class="primary" type="submit">Create account and show 2FA setup</button>
  </form>
</section>` : ''}`
}

function groupSecret(secret: string): string {
  return (secret.match(/.{1,4}/gu) ?? []).join(' ')
}

export function onsitePage(input: { licenses: LicenseView[] }): string {
  return `
<h1>On-site licences</h1>
<p class="muted">Licences issued on a customer's PC with the vendor master password, reported to the portal at check-in. They can be suspended and replaced here like any other licence, but they never needed the Internet to be issued.</p>
${input.licenses.length === 0
  ? '<div class="empty">No on-site licence has been reported yet.</div>'
  : `<div class="table-wrap"><table class="responsive">
      <thead><tr><th>Customer</th><th>Reported</th><th>From machine</th><th>Term</th><th>Status</th><th></th></tr></thead>
      <tbody>${input.licenses.map((license) => `
        <tr>
          <td data-label="Customer"><a href="/portal/licenses/${e(license.id)}">${e(license.customer_name)}</a></td>
          <td data-label="Reported">${license.onsite_reported_at ? e(license.onsite_reported_at.slice(0, 19).replace('T', ' ')) : 'not reported'}</td>
          <td data-label="From machine"><span class="mono small">${e((license.onsite_owner_machine ?? license.machine_id ?? '—').slice(0, 16))}</span></td>
          <td data-label="Term">${e(license.starts_at.slice(0, 10))} → ${e(license.ends_at.slice(0, 10))}</td>
          <td data-label="Status">${statusPill(license.effective_status)}</td>
          <td data-label=""><a class="button" href="/portal/licenses/${e(license.id)}">Manage</a></td>
        </tr>`).join('')}</tbody>
    </table></div>`}`
}

export function relayPage(input: {
  connections: Array<{ shop_id: string; license_id: string | null; status: string; connected_at: string | null; last_seen_at: string | null; frames: number; bytes_in: number; bytes_out: number; peer_address: string | null }>
  relayConfigured: boolean
  relayDomain: string
  linkSizeLimit: number
}): string {
  return `
<h1>Internet relay</h1>
${input.relayConfigured
  ? `<div class="notice ok">The relay is listening on <span class="key">${e(input.relayDomain)}</span>. Shop PCs dial out to it; no router or port forwarding is needed.</div>`
  : `<div class="notice error">The relay domain is not configured. Set <span class="mono">INFOFLEX_CLOUD_RELAY_DOMAIN</span> and <span class="mono">INFOFLEX_CLOUD_RELAY_SECRET</span> to enable it.</div>`}
<div class="kpi">
  <div class="card"><div class="label">Shops connected</div><div class="big">${input.connections.filter((row) => row.status === 'online').length}</div></div>
  <div class="card"><div class="label">Known shops</div><div class="big">${input.connections.length}</div></div>
  <div class="card"><div class="label">Frame cap per link</div><div class="big">${Math.round(input.linkSizeLimit / 1024)} KB</div><small>largest frame forwarded</small></div>
  <div class="card"><div class="label">Content visible</div><div class="big">None</div><small>end-to-end encrypted</small></div>
</div>
<section class="card">
  <h2>Connections</h2>
  <p class="muted">Status and byte counts only. The relay cannot read the frames it forwards: the phone and the shop PC agree a key during QR pairing and encrypt every message end to end.</p>
  ${input.connections.length === 0 ? '<div class="empty">No shop has connected to the relay yet.</div>' : `
    <div class="table-wrap"><table class="responsive">
      <thead><tr><th>Shop</th><th>Status</th><th>Connected</th><th>Last seen</th><th>Frames</th><th>Bytes in / out</th><th>Peer</th></tr></thead>
      <tbody>${input.connections.map((row) => `
        <tr>
          <td data-label="Shop"><span class="mono small">${e(row.shop_id)}</span></td>
          <td data-label="Status">${row.status === 'online' ? '<span class="pill pill-online">online</span>' : '<span class="pill pill-offline">offline</span>'}</td>
          <td data-label="Connected">${row.connected_at ? e(row.connected_at.slice(0, 19).replace('T', ' ')) : '—'}</td>
          <td data-label="Last seen">${row.last_seen_at ? e(row.last_seen_at.slice(0, 19).replace('T', ' ')) : '—'}</td>
          <td data-label="Frames">${row.frames}</td>
          <td data-label="Bytes in / out">${row.bytes_in} / ${row.bytes_out}</td>
          <td data-label="Peer"><span class="mono small">${e(row.peer_address ?? '—')}</span></td>
        </tr>`).join('')}</tbody>
    </table></div>`}
</section>
<section class="card">
  <h2>Limits</h2>
  <ul class="muted small">
    <li>Each shop PC may hold one relay link; extra attempts are refused.</li>
    <li>Frames larger than ${Math.round(input.linkSizeLimit / 1024)} KB are dropped, so a bulk export cannot be pushed through the relay.</li>
    <li>Per-connection bandwidth is capped and idle links are closed after 10 minutes.</li>
    <li>Only shops whose licence is active, has Internet access enabled, and whose Admin turned on “Allow Internet access” can connect.</li>
  </ul>
</section>`
}

export function auditPage(input: { entries: Array<{ actor: string; action: string; target: string | null; ip_address: string | null; detail: Record<string, unknown>; created_at: string }> }): string {
  return `
<h1>Audit log</h1>
<p class="muted">Every vendor action, sign-in attempt and device event. Kept for the life of the deployment; export with your database backup.</p>
${input.entries.length === 0 ? '<div class="empty">Nothing has been logged yet.</div>' : `
<div class="table-wrap"><table class="responsive">
  <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Address</th><th>Detail</th></tr></thead>
  <tbody>${input.entries.map((entry) => `
    <tr>
      <td data-label="When">${e(entry.created_at.slice(0, 19).replace('T', ' '))}</td>
      <td data-label="Actor">${e(entry.actor)}</td>
      <td data-label="Action">${e(entry.action)}</td>
      <td data-label="Target"><span class="mono small">${e(entry.target ?? '—')}</span></td>
      <td data-label="Address"><span class="mono small">${e(entry.ip_address ?? '—')}</span></td>
      <td data-label="Detail"><small class="mono">${e(JSON.stringify(entry.detail))}</small></td>
    </tr>`).join('')}</tbody>
</table></div>`}`
}

export function loginPage(input: { error: string | null; notice: string | null }): string {
  return `<div class="auth-shell"><div class="auth-card">
  <img class="logo" src="/portal/assets/logo-white.png" alt="Infoflex" style="background:var(--navy);padding:.6rem;border-radius:10px">
  <h1>Vendor Portal</h1>
  <p>Sign in with your vendor account. Two-factor codes are required every time.</p>
  ${input.error ? `<div class="notice error" role="alert">${e(input.error)}</div>` : ''}
  ${input.notice ? `<div class="notice ok">${e(input.notice)}</div>` : ''}
  <form method="post" action="/portal/login">
    <label class="field"><span>E-mail</span><input type="email" name="email" required autocomplete="username" autofocus></label>
    <label class="field"><span>Password</span><input type="password" name="password" required autocomplete="current-password"></label>
    <label class="field"><span>Authenticator code</span><input type="text" name="code" inputmode="numeric" pattern="[0-9 ]{6,9}" autocomplete="one-time-code" required placeholder="123 456"></label>
    <button class="primary" type="submit" style="width:100%;min-height:50px">Sign in</button>
  </form>
  <p class="small muted" style="margin-top:1rem;text-align:center">Forgot your password or lost your authenticator? Ask another Owner to reset it.</p>
</div></div>`
}

/** The first-run page: the deployment has no vendor account yet. */
export function setupPage(input: { error: string | null; csrf: string }): string {
  return `<div class="auth-shell"><div class="auth-card">
  <img class="logo" src="/portal/assets/logo-white.png" alt="Infoflex" style="background:var(--navy);padding:.6rem;border-radius:10px">
  <h1>Create the first Owner</h1>
  <p>This deployment has no vendor account yet. Create the Owner account, then set up two-factor authentication.</p>
  ${input.error ? `<div class="notice error" role="alert">${e(input.error)}</div>` : ''}
  <form method="post" action="/portal/setup">
    <input type="hidden" name="_csrf" value="${e(input.csrf)}">
    <label class="field"><span>Name</span><input type="text" name="displayName" required maxlength="120" autocomplete="name"></label>
    <label class="field"><span>E-mail</span><input type="email" name="email" required maxlength="200" autocomplete="username"></label>
    <label class="field"><span>Password (at least 12 characters)</span><input type="password" name="password" required minlength="12" autocomplete="new-password"></label>
    <label class="field"><span>Repeat password</span><input type="password" name="confirm" required minlength="12" autocomplete="new-password"></label>
    <button class="primary" type="submit" style="width:100%;min-height:50px">Create Owner and continue to 2FA</button>
  </form>
</div></div>`
}

export function setupTotpPage(input: { csrf: string; userId: string; secret: string; qr: string; error: string | null }): string {
  return `<div class="auth-shell"><div class="auth-card">
  <img class="logo" src="/portal/assets/logo-white.png" alt="Infoflex" style="background:var(--navy);padding:.6rem;border-radius:10px">
  <h1>Set up two-factor</h1>
  <p>Scan this with any authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…), then type the six-digit code it shows.</p>
  ${input.error ? `<div class="notice error" role="alert">${e(input.error)}</div>` : ''}
  <img class="qr" src="${e(input.qr)}" alt="Two-factor setup QR code">
  <p class="small muted" style="text-align:center">Cannot scan? Type this key into the app:<br><span class="key">${e(groupSecret(input.secret))}</span></p>
  <form method="post" action="/portal/setup/totp">
    <input type="hidden" name="_csrf" value="${e(input.csrf)}">
    <input type="hidden" name="userId" value="${e(input.userId)}">
    <label class="field"><span>Six-digit code</span><input type="text" name="code" inputmode="numeric" pattern="[0-9 ]{6,9}" autocomplete="one-time-code" required autofocus></label>
    <button class="primary" type="submit" style="width:100%;min-height:50px">Activate two-factor</button>
  </form>
</div></div>`
}

export function currencyOptions(selected: string | null): string {
  const options = [`<option value=""${selected ? '' : ' selected'}>No default — the customer chooses</option>`]
  for (const currency of CURRENCIES) {
    options.push(`<option value="${e(currency.code)}"${selected === currency.code ? ' selected' : ''}>${e(currency.code)} — ${e(currency.name)} (${e(currency.symbol)}, ${currency.decimalPlaces} dp)</option>`)
  }
  return options.join('')
}

function currencyHint(code: string): string {
  const currency = getCurrency(code)
  return currency ? `<small class="muted">${e(currency.symbol)} · ${currency.decimalPlaces} dp</small>` : '<small class="muted">custom</small>'
}

export function editionLabel(edition: string): string {
  if (edition === 'PHARMACY') return 'Infoflex Pharm'
  if (edition === 'SUPERMARKET') return 'Infoflex Mart'
  return 'Both editions'
}

function addYears(dateText: string, years: number): string {
  const date = new Date(`${dateText}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) return dateText
  const target = new Date(Date.UTC(date.getUTCFullYear() + years, date.getUTCMonth(), date.getUTCDate()))
  // 29 February + whole years lands on 1 March; clamp back to the last day of the intended month.
  if (target.getUTCMonth() !== date.getUTCMonth()) target.setUTCDate(0)
  return target.toISOString().slice(0, 10)
}
