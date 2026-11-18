<?php
/**
 * The PHP build's portal screens. Each function returns the page body; the entry scripts handle the request,
 * check the session and the CSRF token, and then render.
 *
 * The forms are the same forms as the Node portal, field for field, because the deploy guide walks a
 * non-technical vendor through them and two different layouts would mean two different guides.
 */

declare(strict_types=1);

require_once __DIR__ . '/views.php';

function ifx_dashboard_body(array $licenses, array $expiring, bool $mailEnabled): string
{
    $active = count(array_filter($licenses, static fn (array $l) => $l['effective_status'] === 'active'));
    $suspended = count(array_filter($licenses, static fn (array $l) => $l['effective_status'] === 'suspended'));
    $online = count(array_filter($licenses, static fn (array $l) => (bool) $l['online_now']));
    $onsite = count(array_filter($licenses, static fn (array $l) => ($l['source'] ?? '') === IFX_SOURCE_ONSITE));

    $buckets = '';
    foreach ([7, 14, 30] as $days) {
        $rows = array_values(array_filter($expiring, static function (array $license) use ($days): bool {
            $remaining = ifx_days_remaining((string) $license['ends_at']);
            return $remaining > ($days === 7 ? 0 : ($days === 14 ? 7 : 14)) && $remaining <= $days;
        }));
        $items = '';
        foreach ($rows as $license) {
            $items .= '<tr><td data-label="Customer">' . ifx_e((string) $license['customer_name']) . '</td>'
                . '<td data-label="Ends">' . ifx_e(substr((string) $license['ends_at'], 0, 10)) . '</td>'
                . '<td data-label="Days">' . ifx_days_remaining((string) $license['ends_at']) . '</td></tr>';
        }
        $buckets .= '<h2>Ending within ' . $days . ' days</h2>'
            . ($items === ''
                ? '<div class="card"><p class="muted small">Nothing ending in this window.</p></div>'
                : '<div class="card" style="overflow-x:auto"><table><thead><tr><th>Customer</th><th>Ends</th><th>Days left</th></tr></thead><tbody>' . $items . '</tbody></table></div>');
    }

    return '<h1>Dashboard</h1>'
        . '<div class="kpis">'
        . '<div class="kpi"><span>Active</span><strong>' . $active . '</strong></div>'
        . '<div class="kpi"><span>Suspended</span><strong>' . $suspended . '</strong></div>'
        . '<div class="kpi"><span>Seen recently</span><strong>' . $online . '</strong></div>'
        . '<div class="kpi"><span>On-site</span><strong>' . $onsite . '</strong></div>'
        . '</div>'
        . ($mailEnabled ? '' : '<div class="notice">E-mail reminders are not configured. Renewals are shown here instead — see the deploy guide to switch reminders on.</div>')
        . '<div class="toolbar"><a class="primary" style="text-decoration:none;display:inline-block;padding:.7rem 1.1rem;border-radius:10px;background:var(--navy);color:#fff;font-weight:600" href="/licence-new.php">New licence</a>'
        . '<a href="/licenses.php?filter=expiring" class="small">See everything expiring</a></div>'
        . $buckets;
}

function ifx_licenses_body(array $licenses, string $search, string $filter): string
{
    $tabs = ['', 'active', 'expiring', 'expired', 'suspended', 'online', 'onsite'];
    $links = '';
    foreach ($tabs as $tab) {
        $label = $tab === '' ? 'All' : ucfirst($tab);
        $url = '/licenses.php?filter=' . rawurlencode($tab) . ($search !== '' ? '&q=' . rawurlencode($search) : '');
        $on = $filter === $tab ? ' style="font-weight:700;text-decoration:underline"' : '';
        $links .= '<a href="' . ifx_e($url) . '"' . $on . '>' . ifx_e($label) . '</a>';
    }
    return '<h1>Licences</h1>'
        . '<div class="toolbar"><form method="get" action="/licenses.php">'
        . '<input type="hidden" name="filter" value="' . ifx_e($filter) . '">'
        . '<input type="text" name="q" value="' . ifx_e($search) . '" placeholder="Search customer or key" style="min-width:220px">'
        . '<button class="neutral" type="submit">Search</button></form>'
        . '<a href="/licenses-csv.php?q=' . rawurlencode($search) . '&filter=' . rawurlencode($filter) . '">Export CSV</a></div>'
        . '<p class="small">' . $links . '</p>'
        . ifx_license_rows($licenses);
}

function ifx_licence_body(array $license, array $customer, array $history, array $checkins, ?string $activationCode): string
{
    $id = rawurlencode((string) $license['id']);
    $csrf = ifx_e(ifx_csrf_token());
    $historyRows = '';
    foreach ($history as $entry) {
        $historyRows .= '<tr><td data-label="When">' . ifx_e((string) $entry['created_at']) . '</td>'
            . '<td data-label="Who">' . ifx_e((string) $entry['actor']) . '</td>'
            . '<td data-label="What">' . ifx_e((string) $entry['action']) . '</td></tr>';
    }
    $checkinRows = '';
    foreach ($checkins as $entry) {
        $checkinRows .= '<tr><td data-label="When">' . ifx_e((string) $entry['checked_at']) . '</td>'
            . '<td data-label="Version">' . ifx_e((string) $entry['app_version']) . '</td>'
            . '<td data-label="Platform">' . ifx_e((string) $entry['platform']) . '</td></tr>';
    }

    return '<h1>' . ifx_e((string) $customer['business_name']) . '</h1>'
        . '<div class="card">'
        . '<p><span class="key">' . ifx_e((string) $license['license_key']) . '</span> ' . ifx_pill((string) $license['effective_status']) . '</p>'
        . '<p class="small">' . ifx_e(ucfirst(strtolower((string) $license['edition']))) . ' · '
        . ifx_e(substr((string) $license['starts_at'], 0, 10)) . ' to ' . ifx_e(substr((string) $license['ends_at'], 0, 10))
        . ' · ' . (int) $license['days_remaining'] . ' days left</p>'
        . '<p class="small muted">Default currency: ' . ($license['default_currency']
            ? '<span class="key">' . ifx_e((string) $license['default_currency']) . '</span>'
              . ((int) $license['lock_currency'] === 1 ? ' — <strong>locked</strong>, the customer cannot change it' : ' — the customer may change it')
            : 'none (the customer chooses)') . '</p>'
        . '<p class="small muted">Admin phones: ' . (int) $license['max_admin_phones']
        . ' · Mobile on the shop network: ' . ((int) $license['mobile_lan'] === 1 ? 'on' : 'off')
        . ' · Mobile over the internet: ' . ((int) $license['mobile_internet'] === 1 ? 'on' : 'off')
        . ' · Grace: ' . (int) $license['grace_days'] . ' days</p>'
        . '<p class="small muted">Machine: ' . ($license['machine_id'] ? '<span class="key">' . ifx_e((string) $license['machine_id']) . '</span>' : 'not yet activated') . '</p>'
        . '<p class="small muted">Last seen: ' . ifx_e((string) ($license['last_checkin_at'] ?? 'never'))
        . ' · App ' . ifx_e((string) ($license['last_app_version'] ?? '—')) . '</p>'
        . '</div>'

        . '<h2>Renew or extend</h2><div class="card"><form method="post" action="/licence-action.php?id=' . $id . '&do=renew">'
        . '<input type="hidden" name="csrf" value="' . $csrf . '">'
        . '<label class="field"><span>New end date</span><input type="date" name="endsAt" value="' . ifx_e(ifx_add_years(substr((string) $license['ends_at'], 0, 10), 1)) . '" required></label>'
        . '<label class="check" style="margin-bottom:.8rem"><input type="checkbox" name="notifyNow" value="1"><span>Notify now — the till picks this up on its next check</span></label>'
        . '<button class="primary" type="submit">Save the new end date</button></form>'
        . '<p class="small muted">Quick select: '
        . '<a href="#" onclick="return false">1 year</a> · 2 · 3 · 5 — type the date, or use the date picker.</p></div>'

        . '<h2>Entitlements</h2><div class="card"><form method="post" action="/licence-action.php?id=' . $id . '&do=entitlements">'
        . '<input type="hidden" name="csrf" value="' . $csrf . '">'
        . '<label class="field"><span>Edition</span><select name="edition">' . ifx_edition_options((string) $license['edition']) . '</select></label>'
        . '<div class="grid2">'
        . '<label class="field"><span>Admin phones allowed</span><input type="number" name="maxAdminPhones" min="1" max="100" value="' . (int) $license['max_admin_phones'] . '"></label>'
        . '<label class="field"><span>Grace period (days)</span><input type="number" name="graceDays" min="0" max="30" value="' . (int) $license['grace_days'] . '"></label>'
        . '</div>'
        . '<label class="field"><span>DEFAULT CURRENCY</span><select name="defaultCurrencyCode">' . ifx_currency_options($license['default_currency'] === null ? null : (string) $license['default_currency']) . '</select></label>'
        . '<label class="check" style="margin-bottom:.8rem"><input type="checkbox" name="lockCurrency" value="1"' . ((int) $license['lock_currency'] === 1 ? ' checked' : '') . '><span>Lock currency for this customer (they cannot change it)</span></label>'
        . '<label class="check" style="margin-bottom:.4rem"><input type="checkbox" name="mobileLan" value="1"' . ((int) $license['mobile_lan'] === 1 ? ' checked' : '') . '><span>Allow the Admin phone on the shop’s own network</span></label>'
        . '<label class="check" style="margin-bottom:.8rem"><input type="checkbox" name="mobileInternet" value="1"' . ((int) $license['mobile_internet'] === 1 ? ' checked' : '') . '><span>Allow the Admin phone over the internet</span></label>'
        . '<button class="primary" type="submit">Save</button></form></div>'

        . '<h2>Access</h2><div class="card"><div class="toolbar">'
        . '<form method="post" action="/licence-action.php?id=' . $id . '&do=' . ($license['status'] === 'suspended' ? 'unsuspend' : 'suspend') . '">'
        . '<input type="hidden" name="csrf" value="' . $csrf . '">'
        . '<button class="' . ($license['status'] === 'suspended' ? 'primary' : 'danger') . '" type="submit">'
        . ($license['status'] === 'suspended' ? 'Unsuspend' : 'Suspend') . '</button></form>'
        . '<form method="post" action="/licence-action.php?id=' . $id . '&do=rebind">'
        . '<input type="hidden" name="csrf" value="' . $csrf . '">'
        . '<button class="neutral" type="submit">Reset machine binding</button></form>'
        . '<form method="post" action="/licence-action.php?id=' . $id . '&do=activation-code">'
        . '<input type="hidden" name="csrf" value="' . $csrf . '">'
        . '<button class="neutral" type="submit">Generate activation code</button></form>'
        . '</div>'
        . ($activationCode !== null ? '<div class="notice ok"><strong>Activation code:</strong> <span class="key">' . ifx_e($activationCode) . '</span> — give it to the shop over the phone. It is shown once.</div>' : '')
        . '<form method="get" action="/licence-file.php"><input type="hidden" name="id" value="' . ifx_e((string) $license['id']) . '">'
        . '<label class="field"><span>Offline licence file — the machine ID the app shows</span>'
        . '<input type="text" name="machine" required placeholder="e.g. 3f2a…"></label>'
        . '<button class="neutral" type="submit">Download .lic</button></form></div>'

        . '<h2>Check-ins</h2><div class="card" style="overflow-x:auto"><table><thead><tr><th>When</th><th>App version</th><th>Platform</th></tr></thead><tbody>'
        . ($checkinRows === '' ? '<tr><td colspan="3" class="muted small">No check-ins yet.</td></tr>' : $checkinRows)
        . '</tbody></table></div>'
        . '<h2>History</h2><div class="card" style="overflow-x:auto"><table><thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead><tbody>'
        . ($historyRows === '' ? '<tr><td colspan="3" class="muted small">Nothing yet.</td></tr>' : $historyRows)
        . '</tbody></table></div>';
}

function ifx_new_licence_body(array $customers, ?string $error, array $preset = []): string
{
    $csrf = ifx_e(ifx_csrf_token());
    $today = ifx_today();
    $options = '';
    foreach ($customers as $customer) {
        $selected = ($preset['customerId'] ?? '') === $customer['id'] ? ' selected' : '';
        $options .= '<option value="' . ifx_e((string) $customer['id']) . '"' . $selected . '>' . ifx_e((string) $customer['business_name']) . '</option>';
    }
    return '<h1>New licence</h1>'
        . ($error !== null ? '<div class="notice error" role="alert">' . ifx_e($error) . '</div>' : '')
        . '<form method="post" action="/licence-new.php" class="card">'
        . '<input type="hidden" name="csrf" value="' . $csrf . '">'
        . '<label class="field"><span>Business name</span><input type="text" name="businessName" required maxlength="160" value="' . ifx_e((string) ($preset['businessName'] ?? '')) . '"></label>'
        . '<div class="grid2">'
        . '<label class="field"><span>Contact name</span><input type="text" name="contactName" maxlength="120"></label>'
        . '<label class="field"><span>Phone</span><input type="text" name="phone" maxlength="40" inputmode="tel"></label>'
        . '</div>'
        . '<div class="grid2">'
        . '<label class="field"><span>E-mail (for renewal reminders)</span><input type="email" name="email" maxlength="160"></label>'
        . '<label class="field"><span>Edition</span><select name="edition">' . ifx_edition_options((string) ($preset['edition'] ?? IFX_EDITION_PHARMACY)) . '</select></label>'
        . '</div>'
        . '<div class="grid2">'
        . '<label class="field"><span>Starts</span><input type="date" name="startsAt" value="' . ifx_e($today) . '" required></label>'
        . '<label class="field"><span>Ends</span><input type="date" name="endsAt" value="' . ifx_e(ifx_add_years($today, 1)) . '" required></label>'
        . '</div>'
        . '<p class="small muted">Quick select: 1 year · 2 years · 3 years · 5 years — type the end date above with the date picker.</p>'
        . '<label class="field"><span>DEFAULT CURRENCY</span><select name="defaultCurrencyCode">' . ifx_currency_options((string) ($preset['defaultCurrencyCode'] ?? 'NGN')) . '</select>'
        . '<span class="muted small">The till preselects this at setup. The customer can still change it unless you lock it below.</span></label>'
        . '<label class="check" style="margin-bottom:.8rem"><input type="checkbox" name="lockCurrency" value="1"><span>Lock currency for this customer (they cannot change it)</span></label>'
        . '<div class="grid2">'
        . '<label class="field"><span>Admin phones allowed</span><input type="number" name="maxAdminPhones" min="1" max="100" value="1"></label>'
        . '<label class="field"><span>Grace period (days)</span><input type="number" name="graceDays" min="0" max="30" value="0"></label>'
        . '</div>'
        . '<label class="check" style="margin-bottom:.4rem"><input type="checkbox" name="mobileLan" value="1" checked><span>Allow the Admin phone on the shop’s own network</span></label>'
        . '<label class="check" style="margin-bottom:1rem"><input type="checkbox" name="mobileInternet" value="1"><span>Allow the Admin phone over the internet (off unless you tick it)</span></label>'
        . '<button class="primary" type="submit" style="width:100%">Create licence</button></form>';
}

function ifx_team_body(array $users, string $csrf, bool $isOwner, ?array $newSecret, ?string $notice): string
{
    $rows = '';
    foreach ($users as $user) {
        $rows .= '<tr><td data-label="Name">' . ifx_e((string) $user['display_name']) . '</td>'
            . '<td data-label="E-mail">' . ifx_e((string) $user['email']) . '</td>'
            . '<td data-label="Role">' . ifx_e((string) $user['role']) . '</td>'
            . '<td data-label="2FA">' . ($user['totp_confirmed_at'] ? 'on' : '<strong>not set up</strong>') . '</td>'
            . '<td data-label="Active">' . ((int) $user['is_active'] === 1 ? 'yes' : 'no') . '</td>'
            . '<td data-label="Actions">' . ($isOwner
                ? '<form method="post" action="/team-action.php?do=reset-totp"><input type="hidden" name="csrf" value="' . $csrf . '">'
                  . '<input type="hidden" name="userId" value="' . ifx_e((string) $user['id']) . '">'
                  . '<button class="neutral" type="submit">Reset 2FA</button></form>'
                : '<span class="muted small">Owner only</span>') . '</td></tr>';
    }
    $setup = '';
    if ($newSecret !== null) {
        $setup = '<div class="card"><h2>Finish two-factor for the new account</h2>'
            . '<p>Type this key into the authenticator app, then have them confirm with a code before signing in.</p>'
            . '<p class="key">' . ifx_e($newSecret['secret']) . '</p>'
            . '<p class="small muted">' . ifx_e($newSecret['uri']) . '</p></div>';
    }
    return '<h1>Team</h1>'
        . ($notice !== null ? '<div class="notice">' . ifx_e($notice) . '</div>' : '')
        . $setup
        . '<div class="card" style="overflow-x:auto"><table><thead><tr><th>Name</th><th>E-mail</th><th>Role</th><th>2FA</th><th>Active</th><th>Actions</th></tr></thead><tbody>'
        . $rows . '</tbody></table></div>'
        . ($isOwner ? '<h2>Add an account</h2><div class="card"><form method="post" action="/team-action.php?do=new">'
            . '<input type="hidden" name="csrf" value="' . $csrf . '">'
            . '<label class="field"><span>Name</span><input type="text" name="displayName" required maxlength="120"></label>'
            . '<label class="field"><span>E-mail</span><input type="email" name="email" required maxlength="200"></label>'
            . '<label class="field"><span>Password (at least 12 characters)</span><input type="password" name="password" required minlength="12"></label>'
            . '<label class="field"><span>Role</span><select name="role"><option value="STAFF">Staff</option><option value="OWNER">Owner</option></select></label>'
            . '<button class="primary" type="submit">Create account</button></form></div>' : '');
}

function ifx_audit_body(array $entries): string
{
    $rows = '';
    foreach ($entries as $entry) {
        $rows .= '<tr><td data-label="When">' . ifx_e((string) $entry['created_at']) . '</td>'
            . '<td data-label="Who">' . ifx_e((string) $entry['actor']) . '</td>'
            . '<td data-label="What">' . ifx_e((string) $entry['action']) . '</td>'
            . '<td data-label="Where">' . ifx_e((string) ($entry['ip_address'] ?? '')) . '</td></tr>';
    }
    return '<h1>Audit log</h1><div class="card" style="overflow-x:auto"><table>'
        . '<thead><tr><th>When</th><th>Who</th><th>What</th><th>Where</th></tr></thead><tbody>' . $rows . '</tbody></table></div>';
}

function ifx_customers_body(array $customers, string $search): string
{
    $rows = '';
    foreach ($customers as $customer) {
        $rows .= '<tr><td data-label="Business"><a href="/customer.php?id=' . ifx_e(rawurlencode((string) $customer['id'])) . '">'
            . ifx_e((string) $customer['business_name']) . '</a></td>'
            . '<td data-label="Contact">' . ifx_e((string) $customer['contact_name']) . '</td>'
            . '<td data-label="Phone">' . ifx_e((string) $customer['phone']) . '</td>'
            . '<td data-label="E-mail">' . ifx_e((string) $customer['email']) . '</td>'
            . '<td data-label="Licences">' . (int) $customer['license_count'] . '</td></tr>';
    }
    return '<h1>Customers</h1><div class="toolbar"><form method="get" action="/customers.php">'
        . '<input type="text" name="q" value="' . ifx_e($search) . '" placeholder="Search customers" style="min-width:220px">'
        . '<button class="neutral" type="submit">Search</button></form></div>'
        . '<div class="card" style="overflow-x:auto"><table><thead><tr><th>Business</th><th>Contact</th><th>Phone</th><th>E-mail</th><th>Licences</th></tr></thead>'
        . '<tbody>' . ($rows === '' ? '<tr><td colspan="5" class="muted small">No customers yet.</td></tr>' : $rows) . '</tbody></table></div>';
}

function ifx_csv(array $licenses): string
{
    $lines = ['customer,licence_key,edition,status,starts,ends,days_remaining,admin_phones,mobile_lan,mobile_internet,default_currency,lock_currency,machine_id,source,last_checkin'];
    foreach ($licenses as $license) {
        $cells = [
            (string) $license['customer_name'], (string) $license['license_key'], (string) $license['edition'],
            (string) $license['effective_status'], substr((string) $license['starts_at'], 0, 10), substr((string) $license['ends_at'], 0, 10),
            (string) $license['days_remaining'], (string) $license['max_admin_phones'],
            (int) $license['mobile_lan'] === 1 ? 'yes' : 'no', (int) $license['mobile_internet'] === 1 ? 'yes' : 'no',
            (string) ($license['default_currency'] ?? ''), (int) $license['lock_currency'] === 1 ? 'yes' : 'no',
            (string) ($license['machine_id'] ?? ''), (string) $license['source'],
            (string) ($license['last_checkin_at'] ?? ''),
        ];
        $lines[] = implode(',', array_map(static function (string $value): string {
            return preg_match('/[",\r\n]/', $value) === 1 ? '"' . str_replace('"', '""', $value) . '"' : $value;
        }, $cells));
    }
    return "\u{FEFF}" . implode("\r\n", $lines) . "\r\n";
}
