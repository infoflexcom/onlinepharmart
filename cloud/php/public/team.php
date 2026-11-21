<?php
declare(strict_types=1);

require_once __DIR__ . '/../lib/bootstrap.php';

$vendor = ifx_require_vendor();
$pending = $_SESSION['pending_user'] ?? null;
unset($_SESSION['pending_user']);
$newSecret = null;
if (is_array($pending)) {
    $newSecret = ['secret' => (string) ($pending['secret'] ?? ''), 'uri' => ifx_totp_uri((string) ($pending['secret'] ?? ''), (string) ($pending['email'] ?? ''))];
}
$users = ifx_database()->query('SELECT id, email, display_name, role, is_active, totp_confirmed_at FROM vendor_users ORDER BY created_at ASC')->fetchAll();
$notice = ifx_flash();
ifx_page('Team', ifx_team_body($users, ifx_e(ifx_csrf_token()) === '' ? '' : ifx_csrf_token(), $vendor['user']['role'] === 'OWNER', $newSecret, $notice), $vendor['user'], 'team');
