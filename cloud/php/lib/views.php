<?php
/**
 * The PHP build's HTML. One small set of functions, the same navy/gold styling as the Node portal, and the same
 * behaviour on a phone: tables become cards below 720px.
 *
 * Every value that comes out of the database passes through `ifx_e()`. There is no template engine and no
 * string interpolation of raw values, so an HTML-escaping mistake would have to be typed by hand.
 */

declare(strict_types=1);

require_once __DIR__ . '/licence.php';
require_once __DIR__ . '/database.php';

/**
 * The currency codes the portal may set, copied from `src/currency/catalog.ts`. Only the code, name and decimal
 * places travel: the cloud never holds a symbol, a rate or an amount. `cloud/php/tests/catalog.test.php` fails if
 * this list and the application's own catalogue ever disagree.
 */
const IFX_CURRENCIES = [
    ['NGN', 'Nigerian naira', 2],
    ['USD', 'US dollar', 2],
    ['EUR', 'Euro', 2],
    ['GBP', 'British pound', 2],
    ['GHS', 'Ghanaian cedi', 2],
    ['KES', 'Kenyan shilling', 2],
    ['ZAR', 'South African rand', 2],
    ['XOF', 'West African CFA franc', 0],
    ['XAF', 'Central African CFA franc', 0],
    ['UGX', 'Ugandan shilling', 0],
    ['TZS', 'Tanzanian shilling', 2],
    ['RWF', 'Rwandan franc', 0],
    ['ETB', 'Ethiopian birr', 2],
    ['EGP', 'Egyptian pound', 2],
    ['MAD', 'Moroccan dirham', 2],
    ['TND', 'Tunisian dinar', 3],
    ['DZD', 'Algerian dinar', 2],
    ['ZMW', 'Zambian kwacha', 2],
    ['MWK', 'Malawian kwacha', 2],
    ['BWP', 'Botswana pula', 2],
    ['NAD', 'Namibian dollar', 2],
    ['MZN', 'Mozambican metical', 2],
    ['AOA', 'Angolan kwanza', 2],
    ['GMD', 'Gambian dalasi', 2],
    ['SLE', 'Sierra Leonean leone', 2],
    ['LRD', 'Liberian dollar', 2],
    ['CDF', 'Congolese franc', 2],
    ['SDG', 'Sudanese pound', 2],
    ['SSP', 'South Sudanese pound', 2],
    ['CAD', 'Canadian dollar', 2],
    ['AUD', 'Australian dollar', 2],
    ['NZD', 'New Zealand dollar', 2],
    ['INR', 'Indian rupee', 2],
    ['PKR', 'Pakistani rupee', 2],
    ['BDT', 'Bangladeshi taka', 2],
    ['LKR', 'Sri Lankan rupee', 2],
    ['AED', 'UAE dirham', 2],
    ['SAR', 'Saudi riyal', 2],
    ['QAR', 'Qatari riyal', 2],
    ['KWD', 'Kuwaiti dinar', 3],
    ['BHD', 'Bahraini dinar', 3],
    ['OMR', 'Omani rial', 3],
    ['JOD', 'Jordanian dinar', 3],
    ['TRY', 'Turkish lira', 2],
    ['CNY', 'Chinese yuan', 2],
    ['JPY', 'Japanese yen', 0],
    ['KRW', 'South Korean won', 0],
    ['SGD', 'Singapore dollar', 2],
    ['MYR', 'Malaysian ringgit', 2],
    ['IDR', 'Indonesian rupiah', 2],
    ['PHP', 'Philippine peso', 2],
    ['THB', 'Thai baht', 2],
    ['BRL', 'Brazilian real', 2],
    ['MXN', 'Mexican peso', 2],
];

function ifx_css(): string
{
    return <<<'CSS'
:root{--navy:#1F3F73;--navy-dark:#162E55;--gold:#C9A24B;--off:#FBF9F4;--ink:#1a2433;--muted:#5a6779;--line:#e6e0d2;
--ok:#1f7a4d;--warn:#a86b12;--bad:#a3271f}
*{box-sizing:border-box}
body{margin:0;background:var(--off);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--navy)}
.brand{background:var(--navy);color:#fff;padding:.7rem 1rem;display:flex;align-items:center;gap:.75rem;flex-wrap:wrap}
.brand img{height:30px;width:auto;display:block}
.brand .who{margin-left:auto;font-size:.85rem;display:flex;align-items:center;gap:.6rem}
.brand form{display:inline}
button.link{background:none;border:0;color:#fff;text-decoration:underline;cursor:pointer;font:inherit;padding:0}
nav.tabs{background:var(--navy-dark);display:flex;overflow-x:auto;gap:.15rem;padding:0 .5rem}
nav.tabs a{color:#dfe6f2;text-decoration:none;padding:.7rem .8rem;font-size:.9rem;white-space:nowrap;border-bottom:3px solid transparent}
nav.tabs a.on{color:#fff;border-bottom-color:var(--gold);font-weight:600}
main{max-width:1080px;margin:0 auto;padding:1rem 1rem 4rem}
h1{font-size:1.4rem;margin:.3rem 0 1rem;color:var(--navy)}
h2{font-size:1.1rem;margin:1.6rem 0 .6rem;color:var(--navy)}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:1rem;margin-bottom:1rem}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.75rem;margin-bottom:1rem}
.kpi{background:#fff;border:1px solid var(--line);border-radius:14px;padding:.9rem}
.kpi span{display:block;font-size:.78rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.kpi strong{font-size:1.6rem;color:var(--navy)}
table{width:100%;border-collapse:collapse;font-size:.93rem}
th{text-align:left;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);padding:.5rem .6rem;border-bottom:1px solid var(--line)}
td{padding:.6rem;border-bottom:1px solid #f0ece2;vertical-align:top}
.pill{display:inline-block;border-radius:999px;padding:.1rem .55rem;font-size:.74rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.pill.active{background:#e3f3ea;color:var(--ok)}
.pill.expiring{background:#fbf0d9;color:var(--warn)}
.pill.expired,.pill.revoked{background:#fbe6e4;color:var(--bad)}
.pill.suspended{background:#eee7f7;color:#5b3fa0}
.pill.online{background:#e3f3ea;color:var(--ok)}
.pill.offline{background:#f1f1f1;color:var(--muted)}
.muted{color:var(--muted)}
.small{font-size:.85rem}
.key{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#f4f1e8;border-radius:6px;padding:.1rem .4rem;font-size:.85rem}
.field{display:block;margin-bottom:.8rem}
.field>span{display:block;font-size:.85rem;font-weight:600;margin-bottom:.25rem}
input[type=text],input[type=email],input[type=password],input[type=date],input[type=number],select,textarea{
width:100%;padding:.65rem .7rem;border:1px solid #cfc7b4;border-radius:10px;font:inherit;background:#fff;min-height:44px}
.check{display:flex;gap:.5rem;align-items:flex-start}
.check input{min-height:0;width:1.15rem;height:1.15rem;margin-top:.2rem}
button.primary,button.danger,button.neutral{font:inherit;font-weight:600;border-radius:10px;padding:.7rem 1.1rem;min-height:46px;cursor:pointer;border:1px solid transparent}
button.primary{background:var(--navy);color:#fff}
button.danger{background:#fff;color:var(--bad);border-color:#e0b3ae}
button.neutral{background:#fff;color:var(--navy);border-color:#c6d2e6}
.notice{border-radius:10px;padding:.7rem .9rem;margin-bottom:1rem;background:#eef2f9;border:1px solid #cfdcef}
.notice.ok{background:#e9f5ee;border-color:#bfe3cd}
.notice.error{background:#fbeae8;border-color:#e8c0bc;color:#7d1f18}
.auth-shell{min-height:100vh;display:grid;place-items:center;padding:1.5rem}
.auth-card{width:100%;max-width:420px;background:#fff;border:1px solid var(--line);border-radius:18px;padding:1.6rem;box-shadow:0 12px 30px rgba(31,63,115,.1)}
.auth-card .logo{height:38px;background:var(--navy);padding:.5rem .7rem;border-radius:10px;margin-bottom:1rem}
img.qr{display:block;margin:0 auto 1rem;width:220px;height:220px;image-rendering:pixelated}
.toolbar{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin-bottom:1rem}
.toolbar form{display:flex;gap:.4rem;flex-wrap:wrap}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:1rem}
@media (max-width:720px){
  table thead{display:none}
  table tr{display:block;border:1px solid var(--line);border-radius:12px;margin-bottom:.6rem;background:#fff;padding:.3rem .2rem}
  table td{display:flex;justify-content:space-between;gap:1rem;border:0;padding:.4rem .6rem}
  table td::before{content:attr(data-label);font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);flex:0 0 42%}
  main{padding:.75rem .75rem 3rem}
}
CSS;
}

function ifx_nav(string $active, array $user): string
{
    $items = [
        'dashboard' => ['/index.php', 'Dashboard'],
        'customers' => ['/customers.php', 'Customers'],
        'licenses' => ['/licenses.php', 'Licences'],
        'onsite' => ['/onsite.php', 'On-site'],
        'team' => ['/team.php', 'Team'],
        'audit' => ['/audit.php', 'Audit'],
    ];
    $links = '';
    foreach ($items as $key => [$href, $label]) {
        $class = $key === $active ? ' class="on"' : '';
        $links .= '<a href="' . ifx_e($href) . '"' . $class . '>' . ifx_e($label) . '</a>';
    }
    $csrf = ifx_e(ifx_csrf_token());
    return '<header class="brand">'
        . '<img src="/assets/logo.png" alt="Infoflex">'
        . '<div class="who"><span>' . ifx_e((string) $user['display_name']) . ' · ' . ifx_e((string) $user['role']) . '</span>'
        . '<form method="post" action="/logout.php"><input type="hidden" name="csrf" value="' . $csrf . '">'
        . '<button class="link" type="submit">Sign out</button></form></div></header>'
        . '<nav class="tabs">' . $links . '</nav>';
}

function ifx_page(string $title, string $body, array $user, string $active = ''): void
{
    ifx_headers();
    echo '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        . '<meta name="viewport" content="width=device-width,initial-scale=1">'
        . '<title>' . ifx_e($title) . ' · Infoflex Vendor</title>'
        . '<link rel="stylesheet" href="/assets/portal.css">'
        . '<link rel="icon" href="/assets/favicon.png"></head><body>';
    echo $user === [] ? $body : ifx_nav($active, $user) . '<main>' . $body . '</main>';
    echo '</body></html>';
}

function ifx_headers(): void
{
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: DENY');
    header('Referrer-Policy: no-referrer');
    header('Cache-Control: no-store, private');
    header("Content-Security-Policy: default-src 'none'; img-src 'self' data:; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; script-src 'none'");
}

function ifx_pill(string $status): string
{
    return '<span class="pill ' . ifx_e($status) . '">' . ifx_e(str_replace('_', ' ', $status)) . '</span>';
}

function ifx_currency_options(?string $selected): string
{
    $options = '<option value=""' . ($selected === null ? ' selected' : '') . '>No default — the customer chooses</option>';
    foreach (IFX_CURRENCIES as [$code, $name, $decimals]) {
        $options .= '<option value="' . ifx_e($code) . '"' . ($selected === $code ? ' selected' : '') . '>'
            . ifx_e($code . ' — ' . $name . ' (' . $decimals . ' dp)') . '</option>';
    }
    return $options;
}

function ifx_edition_options(string $selected): string
{
    $labels = [IFX_EDITION_PHARMACY => 'Pharmacy', IFX_EDITION_SUPERMARKET => 'Supermarket', IFX_EDITION_BOTH => 'Both'];
    $options = '';
    foreach ($labels as $value => $label) {
        $options .= '<option value="' . ifx_e($value) . '"' . ($selected === $value ? ' selected' : '') . '>' . ifx_e($label) . '</option>';
    }
    return $options;
}

function ifx_login_page(?string $error, ?string $notice = null): string
{
    return '<div class="auth-shell"><div class="auth-card">'
        . '<img class="logo" src="/assets/logo.png" alt="Infoflex">'
        . '<h1>Vendor Portal</h1><p>Sign in with your vendor account. Two-factor codes are required every time.</p>'
        . ($error ? '<div class="notice error" role="alert">' . ifx_e($error) . '</div>' : '')
        . ($notice ? '<div class="notice ok">' . ifx_e($notice) . '</div>' : '')
        . '<form method="post" action="/login.php">'
        . '<label class="field"><span>E-mail</span><input type="email" name="email" required autocomplete="username" autofocus></label>'
        . '<label class="field"><span>Password</span><input type="password" name="password" required autocomplete="current-password"></label>'
        . '<label class="field"><span>Authenticator code</span><input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" required placeholder="123 456"></label>'
        . '<button class="primary" type="submit" style="width:100%">Sign in</button></form>'
        . '<p class="small muted" style="text-align:center;margin-top:1rem">Forgot your password or lost your authenticator? Ask another Owner to reset it.</p>'
        . '</div></div>';
}

function ifx_license_rows(array $licenses): string
{
    if ($licenses === []) {
        return '<div class="card"><p class="muted">No licences match.</p></div>';
    }
    $rows = '';
    foreach ($licenses as $license) {
        $rows .= '<tr>'
            . '<td data-label="Customer"><a href="/licence.php?id=' . ifx_e(rawurlencode((string) $license['id'])) . '">'
            . ifx_e((string) $license['customer_name']) . '</a></td>'
            . '<td data-label="Key"><span class="key">' . ifx_e((string) $license['license_key']) . '</span></td>'
            . '<td data-label="Edition">' . ifx_e(ucfirst(strtolower((string) $license['edition']))) . '</td>'
            . '<td data-label="Status">' . ifx_pill((string) $license['effective_status']) . '</td>'
            . '<td data-label="Ends">' . ifx_e(substr((string) $license['ends_at'], 0, 10))
            . '<br><small class="muted">' . (int) $license['days_remaining'] . ' days</small></td>'
            . '<td data-label="Currency">' . ($license['default_currency']
                ? '<span class="key">' . ifx_e((string) $license['default_currency']) . '</span>' . ((int) $license['lock_currency'] === 1 ? '<br><small>locked</small>' : '')
                : '<small class="muted">customer choice</small>') . '</td>'
            . '<td data-label="App">' . ($license['online_now'] ? ifx_pill('online') : ifx_pill('offline'))
            . '<br><small class="muted">' . ifx_e((string) ($license['last_app_version'] ?? '—')) . '</small></td>'
            . '</tr>';
    }
    return '<div class="card" style="overflow-x:auto"><table><thead><tr>'
        . '<th>Customer</th><th>Key</th><th>Edition</th><th>Status</th><th>Ends</th><th>Currency</th><th>App</th>'
        . '</tr></thead><tbody>' . $rows . '</tbody></table></div>';
}
