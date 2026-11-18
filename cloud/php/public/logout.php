<?php
declare(strict_types=1);

require_once __DIR__ . '/../lib/bootstrap.php';

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST' && ifx_post_csrf_ok()) {
    $token = $_COOKIE[IFX_SESSION_COOKIE] ?? null;
    ifx_logout(ifx_database(), is_string($token) ? $token : null);
    ifx_session_cookie(null, (bool) (ifx_config()['secure_cookies'] ?? true));
    ifx_start_session();
    session_destroy();
}
ifx_redirect('/login.php');
