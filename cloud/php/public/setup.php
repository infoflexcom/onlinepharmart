<?php
/**
 * First run: create the Owner account, then enrol its authenticator. The deployment's own configuration may pin
 * the address this page accepts, so an unconfigured server cannot be seized by the first visitor.
 */
declare(strict_types=1);

require_once __DIR__ . '/../lib/bootstrap.php';

$pdo = ifx_database();
if (ifx_count_users($pdo) > 0) {
    ifx_redirect('/login.php');
}
$config = ifx_config();
$error = null;
$step = $_GET['step'] ?? 'owner';

if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['action'] ?? '') === 'owner') {
    $pinned = trim((string) ($config['bootstrap_owner_email'] ?? ''));
    if ($pinned !== '' && strcasecmp($pinned, trim((string) ($_POST['email'] ?? ''))) !== 0) {
        $error = 'This deployment only allows the pre-configured Owner e-mail here.';
    } elseif (($_POST['password'] ?? '') !== ($_POST['confirm'] ?? '')) {
        $error = 'The two passwords do not match.';
    } else {
        try {
            $user = ifx_create_user($pdo, [
                'email' => $_POST['email'] ?? '', 'displayName' => $_POST['displayName'] ?? '',
                'password' => $_POST['password'] ?? '', 'role' => 'OWNER',
            ], 'setup');
            $_SESSION['pending_owner'] = ['id' => $user['id'], 'secret' => $user['totp_secret'], 'email' => $user['email']];
            ifx_redirect('/setup.php?step=totp');
        } catch (Throwable $failure) {
            $error = $failure->getMessage();
        }
    }
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['action'] ?? '') === 'totp') {
    $pending = $_SESSION['pending_owner'] ?? null;
    if (!is_array($pending)) {
        ifx_redirect('/setup.php');
    }
    try {
        ifx_confirm_totp($pdo, (string) $pending['id'], (string) ($_POST['code'] ?? ''));
        unset($_SESSION['pending_owner']);
        ifx_flash('Two-factor is active. Sign in to continue.');
        ifx_redirect('/login.php');
    } catch (Throwable $failure) {
        $error = $failure->getMessage();
        $step = 'totp';
    }
}

ifx_headers();
$body = '<div class="auth-shell"><div class="auth-card">'
    . '<img class="logo" src="/assets/logo.png" alt="Infoflex">';
if ($step === 'totp' && isset($_SESSION['pending_owner'])) {
    $pending = $_SESSION['pending_owner'];
    $secret = (string) $pending['secret'];
    $uri = ifx_totp_uri($secret, (string) $pending['email']);
    $body .= '<h1>Set up two-factor</h1><p>Type this key into any authenticator app (Google Authenticator, Microsoft Authenticator, 1Password), then enter the six-digit code it shows.</p>'
        . ($error !== null ? '<div class="notice error" role="alert">' . ifx_e($error) . '</div>' : '')
        . '<p class="small">Setup key:</p><p class="key" style="word-break:break-all">' . ifx_e($secret) . '</p>'
        . '<p class="small muted" style="word-break:break-all">' . ifx_e($uri) . '</p>'
        . '<form method="post" action="/setup.php?step=totp">'
        . '<input type="hidden" name="action" value="totp">'
        . '<label class="field"><span>Six-digit code</span><input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" required autofocus></label>'
        . '<button class="primary" type="submit" style="width:100%">Activate two-factor</button></form>';
} else {
    $body .= '<h1>Create the first Owner</h1><p>This deployment has no vendor account yet. Create the Owner account, then set up two-factor authentication.</p>'
        . ($error !== null ? '<div class="notice error" role="alert">' . ifx_e($error) . '</div>' : '')
        . '<form method="post" action="/setup.php">'
        . '<input type="hidden" name="action" value="owner">'
        . '<label class="field"><span>Name</span><input type="text" name="displayName" required maxlength="120" autocomplete="name"></label>'
        . '<label class="field"><span>E-mail</span><input type="email" name="email" required maxlength="200" autocomplete="username"></label>'
        . '<label class="field"><span>Password (at least 12 characters)</span><input type="password" name="password" required minlength="12" autocomplete="new-password"></label>'
        . '<label class="field"><span>Repeat password</span><input type="password" name="confirm" required minlength="12" autocomplete="new-password"></label>'
        . '<button class="primary" type="submit" style="width:100%">Create Owner and continue</button></form>';
}
$body .= '</div></div>';
echo '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    . '<title>Set up · Infoflex Vendor</title><link rel="stylesheet" href="/assets/portal.css"></head><body>' . $body . '</body></html>';
