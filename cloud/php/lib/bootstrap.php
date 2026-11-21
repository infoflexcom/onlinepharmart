<?php
/**
 * One file every entry script includes: configuration, database, session, and the signed-in vendor.
 *
 * The session cookie is set here rather than by PHP's defaults so that HttpOnly, SameSite=Strict and (on a real
 * domain) Secure are guaranteed on every response.
 */

declare(strict_types=1);

require_once __DIR__ . '/licence.php';
require_once __DIR__ . '/database.php';
require_once __DIR__ . '/service.php';
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/views.php';
require_once __DIR__ . '/pages.php';

function ifx_config(): array
{
    static $config = null;
    if ($config !== null) {
        return $config;
    }
    $path = getenv('INFOFLEX_PHP_CONFIG') ?: dirname(__DIR__) . '/config.php';
    if (!is_file($path)) {
        http_response_code(503);
        header('Content-Type: text/plain; charset=utf-8');
        echo "Infoflex Cloud (PHP) is installed but not configured.\n\n"
            . "Copy config.example.php to config.php next to it and fill in the database and signing settings.\n";
        exit;
    }
    $loaded = require $path;
    if (!is_array($loaded)) {
        throw new RuntimeException('config.php must return an array.');
    }
    date_default_timezone_set((string) ($loaded['timezone'] ?? 'UTC'));
    $config = $loaded;
    return $config;
}

function ifx_database(): PDO
{
    static $pdo = null;
    if ($pdo !== null) {
        return $pdo;
    }
    $config = ifx_config();
    $pdo = ifx_open_database((string) $config['dsn'], (string) ($config['db_user'] ?? ''), (string) ($config['db_password'] ?? ''));
    ifx_migrate($pdo);
    return $pdo;
}

function ifx_key_pem(array $config): string
{
    $path = (string) ($config['signing_key_path'] ?? '');
    if ($path === '' || !is_readable($path)) {
        throw new RuntimeException('The signing key file is missing or unreadable. Set signing_key_path in config.php.');
    }
    $pem = file_get_contents($path);
    if (!is_string($pem) || !str_contains($pem, 'PRIVATE KEY')) {
        throw new RuntimeException('The signing key file does not contain a PEM private key.');
    }
    return $pem;
}

function ifx_service(): IfxService
{
    static $service = null;
    if ($service !== null) {
        return $service;
    }
    $config = ifx_config();
    $service = new IfxService(ifx_database(), ifx_key_pem($config), (string) ($config['signing_key_id'] ?? 'infoflex-cloud-1'));
    return $service;
}

function ifx_start_session(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }
    $config = ifx_config();
    session_name('infoflex_portal_phpsess');
    session_set_cookie_params([
        'lifetime' => 0,
        'path' => '/',
        'httponly' => true,
        'samesite' => 'Strict',
        'secure' => (bool) ($config['secure_cookies'] ?? true),
    ]);
    session_start();
}

function ifx_current_vendor(): ?array
{
    ifx_start_session();
    $token = $_COOKIE[IFX_SESSION_COOKIE] ?? null;
    if (!is_string($token) || $token === '') {
        return null;
    }
    return ifx_authenticate(ifx_database(), $token, null, (int) (ifx_config()['session_minutes'] ?? 30));
}

/** Every signed-in page starts here; a visitor without a session is sent to the login page. */
function ifx_require_vendor(): array
{
    $vendor = ifx_current_vendor();
    if ($vendor === null) {
        ifx_redirect('/login.php');
    }
    return $vendor;
}

function ifx_post_csrf_ok(): bool
{
    if (!ifx_csrf_check(is_string($_POST['csrf'] ?? null) ? $_POST['csrf'] : null)) {
        http_response_code(403);
        header('Content-Type: text/html; charset=utf-8');
        echo '<p>That form expired. Reload the page and try again.</p>';
        return false;
    }
    return true;
}
