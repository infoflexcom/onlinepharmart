<?php
declare(strict_types=1);

require_once __DIR__ . '/../lib/bootstrap.php';

$pdo = ifx_database();
if (ifx_count_users($pdo) === 0) {
    ifx_redirect('/setup.php');
}
$config = ifx_config();
$error = null;
$notice = ifx_flash();

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $result = ifx_login($pdo, [
        'email' => $_POST['email'] ?? '', 'password' => $_POST['password'] ?? '', 'code' => $_POST['code'] ?? '',
        'ipAddress' => $_SERVER['REMOTE_ADDR'] ?? null, 'userAgent' => (string) ($_SERVER['HTTP_USER_AGENT'] ?? ''),
        'sessionMinutes' => (int) ($config['session_minutes'] ?? 30),
    ]);
    if ($result['ok'] === true) {
        ifx_start_session();
        session_regenerate_id(true);
        ifx_session_cookie($result['token'], (bool) ($config['secure_cookies'] ?? true), (int) ($config['session_minutes'] ?? 30));
        ifx_redirect('/index.php');
    }
    $error = (string) $result['message'];
}

ifx_headers();
echo '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    . '<title>Sign in · Infoflex Vendor</title><link rel="stylesheet" href="/assets/portal.css"><link rel="icon" href="/assets/favicon.png"></head><body>'
    . ifx_login_page($error, $notice) . '</body></html>';
