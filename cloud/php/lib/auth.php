<?php
/**
 * Vendor sign-in for the PHP build: argon2id (with a bcrypt fallback on a host that lacks it), mandatory TOTP,
 * a lockout after repeated failures, and sessions whose token is stored only as a hash.
 *
 * The portal is the one place a human password reaches a server, so the rules are the same as the Node build and
 * are tested the same way: two factors or no entry, one use per code, and a session that dies on its own.
 */

declare(strict_types=1);

require_once __DIR__ . '/licence.php';
require_once __DIR__ . '/database.php';

const IFX_MAX_FAILED_LOGINS = 8;
const IFX_LOCKOUT_MINUTES = 15;
const IFX_SESSION_COOKIE = 'infoflex_portal_php';

function ifx_password_hash(string $password): string
{
    ifx_assert_strong_password($password);
    $algo = defined('PASSWORD_ARGON2ID') ? PASSWORD_ARGON2ID : PASSWORD_BCRYPT;
    $hash = password_hash($password, $algo);
    if (!is_string($hash) || $hash === '') {
        throw new RuntimeException('The password could not be stored.');
    }
    return $hash;
}

/**
 * A stand-in hash so an unknown e-mail costs the same time as a wrong password. It is generated per process from
 * random bytes: the source holds no hash, and it cannot match a real password because nobody knows it.
 */
function ifx_dummy_hash(): string
{
    static $hash = null;
    if ($hash === null) {
        $hash = password_hash(ifx_base64url_encode(random_bytes(32)), PASSWORD_BCRYPT);
    }
    return $hash;
}

function ifx_create_user(PDO $pdo, array $input, string $actor): array
{
    $email = trim((string) ($input['email'] ?? ''));
    if (preg_match('/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/', $email) !== 1 || strlen($email) > 200) {
        throw new InvalidArgumentException('Enter a valid email address.');
    }
    if (ifx_find_user_by_email($pdo, $email) !== null) {
        throw new InvalidArgumentException('That email already has a vendor account.');
    }
    $name = trim((string) ($input['displayName'] ?? ''));
    if ($name === '') {
        throw new InvalidArgumentException('Enter the name.');
    }
    $role = ($input['role'] ?? 'STAFF') === 'OWNER' ? 'OWNER' : 'STAFF';
    $id = ifx_uuid();
    $pdo->prepare(
        'INSERT INTO vendor_users (id, email, display_name, role, password_hash, totp_secret, totp_confirmed_at,
            failed_logins, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, 1, ?)'
    )->execute([
        $id, $email, ifx_clip($name, 0, 120), $role, ifx_password_hash((string) ($input['password'] ?? '')),
        ifx_totp_secret(), ifx_now(),
    ]);
    ifx_audit($pdo, $actor, 'vendor_user.created', $id, ['email' => $email, 'role' => $role]);
    return ifx_find_user_by_email($pdo, $email) ?? [];
}

function ifx_confirm_totp(PDO $pdo, string $userId, string $code, int|float|null $nowMs = null): void
{
    $statement = $pdo->prepare('SELECT * FROM vendor_users WHERE id = ?');
    $statement->execute([$userId]);
    $user = $statement->fetch();
    if ($user === false) {
        throw new InvalidArgumentException('That account no longer exists.');
    }
    $step = ifx_totp_verify((string) $user['totp_secret'], $code, $nowMs, null);
    if ($step === null) {
        throw new InvalidArgumentException('That authentication code is not correct. Check your authenticator app and try again.');
    }
    $pdo->prepare('UPDATE vendor_users SET totp_confirmed_at = ?, totp_last_step = ? WHERE id = ?')
        ->execute([ifx_now(), $step, $userId]);
    ifx_audit($pdo, (string) $user['email'], 'vendor_user.totp_confirmed', $userId, []);
}

/**
 * Sign-in. Returns ['ok' => true, 'user' => …, 'token' => …] or ['ok' => false, 'message' => …, 'reason' => …].
 * Every failure is written to the audit log with the address it came from.
 */
function ifx_login(PDO $pdo, array $input, int|float|null $nowMs = null): array
{
    // Seconds, not milliseconds: a millisecond timestamp overflows a 32-bit integer, and shared hosts are 32-bit.
    $nowSeconds = ifx_millis_to_seconds($nowMs);
    $nowMs = $nowSeconds * 1000;
    $email = trim((string) ($input['email'] ?? ''));
    $user = $email === '' ? null : ifx_find_user_by_email($pdo, $email);
    $hash = $user === null ? ifx_dummy_hash() : (string) $user['password_hash'];
    $passwordOk = password_verify((string) ($input['password'] ?? ''), $hash);
    $ip = $input['ipAddress'] ?? null;

    if ($user === null || !$passwordOk) {
        if ($user !== null) {
            ifx_record_failure($pdo, $user, $nowMs);
        }
        ifx_audit($pdo, $email === '' ? '(blank)' : $email, 'vendor.login.failed', $user['id'] ?? null, ['reason' => 'credentials'], $ip);
        return ['ok' => false, 'reason' => 'invalid', 'message' => 'That email or password is not correct.'];
    }
    if ($user['locked_until'] !== null && (strtotime((string) $user['locked_until']) ?: 0) * 1000 > $nowMs) {
        return ['ok' => false, 'reason' => 'locked', 'message' => 'Too many attempts. Try again in fifteen minutes.'];
    }
    if ((int) $user['is_active'] !== 1) {
        ifx_audit($pdo, (string) $user['email'], 'vendor.login.failed', (string) $user['id'], ['reason' => 'disabled'], $ip);
        return ['ok' => false, 'reason' => 'invalid', 'message' => 'That email or password is not correct.'];
    }
    if ($user['totp_confirmed_at'] === null) {
        ifx_audit($pdo, (string) $user['email'], 'vendor.login.failed', (string) $user['id'], ['reason' => 'totp_not_enrolled'], $ip);
        return ['ok' => false, 'reason' => 'totp_required', 'message' => 'This account has not finished setting up two-factor authentication.'];
    }
    $step = ifx_totp_verify(
        (string) $user['totp_secret'],
        (string) ($input['code'] ?? ''),
        $nowMs,
        $user['totp_last_step'] === null ? null : (int) $user['totp_last_step'],
    );
    if ($step === null) {
        ifx_record_failure($pdo, $user, $nowMs);
        ifx_audit($pdo, (string) $user['email'], 'vendor.login.failed', (string) $user['id'], ['reason' => 'totp'], $ip);
        return ['ok' => false, 'reason' => 'invalid', 'message' => 'That authentication code is not correct.'];
    }

    $token = ifx_base64url_encode(random_bytes(32));
    $csrf = ifx_base64url_encode(random_bytes(24));
    $minutes = (int) ($input['sessionMinutes'] ?? 30);
    $now = gmdate('Y-m-d\TH:i:s', (int) floor($nowMs / 1000)) . '.000Z';
    $pdo->prepare('UPDATE vendor_users SET failed_logins = 0, locked_until = NULL, totp_last_step = ?, last_login_at = ? WHERE id = ?')
        ->execute([$step, $now, $user['id']]);
    $pdo->prepare(
        'INSERT INTO sessions (id, vendor_user_id, token_hash, csrf_token, ip_address, user_agent, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )->execute([
        ifx_uuid(), $user['id'], hash('sha256', $token), $csrf, $ip,
        ifx_clip((string) ($input['userAgent'] ?? ''), 0, 300), $now, $now,
        gmdate('Y-m-d\TH:i:s', (int) floor($nowMs / 1000) + $minutes * 60) . '.000Z',
    ]);
    ifx_audit($pdo, (string) $user['email'], 'vendor.login.succeeded', (string) $user['id'], [], $ip);
    return ['ok' => true, 'user' => $user, 'token' => $token, 'csrf' => $csrf];
}

function ifx_record_failure(PDO $pdo, array $user, int|float $nowMs): void
{
    $failures = (int) $user['failed_logins'] + 1;
    $lockedUntil = $failures >= IFX_MAX_FAILED_LOGINS
        ? gmdate('Y-m-d\TH:i:s', (int) floor($nowMs / 1000) + IFX_LOCKOUT_MINUTES * 60) . '.000Z'
        : null;
    $pdo->prepare('UPDATE vendor_users SET failed_logins = ?, locked_until = ? WHERE id = ?')
        ->execute([$failures, $lockedUntil, $user['id']]);
}

/** Resolves the session cookie to a user, extending the session while it is in use. */
function ifx_authenticate(PDO $pdo, ?string $token, int|float|null $nowMs = null, int $minutes = 30): ?array
{
    if ($token === null || $token === '') {
        return null;
    }
    $nowMs = ifx_millis_to_seconds($nowMs) * 1000;
    $statement = $pdo->prepare('SELECT * FROM sessions WHERE token_hash = ?');
    $statement->execute([hash('sha256', $token)]);
    $session = $statement->fetch();
    if ($session === false) {
        return null;
    }
    if ((strtotime((string) $session['expires_at']) ?: 0) * 1000 <= $nowMs) {
        $pdo->prepare('DELETE FROM sessions WHERE id = ?')->execute([$session['id']]);
        return null;
    }
    $statement = $pdo->prepare('SELECT * FROM vendor_users WHERE id = ?');
    $statement->execute([$session['vendor_user_id']]);
    $user = $statement->fetch();
    if ($user === false || (int) $user['is_active'] !== 1) {
        return null;
    }
    $next = gmdate('Y-m-d\TH:i:s', (int) floor($nowMs / 1000) + $minutes * 60) . '.000Z';
    $pdo->prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
        ->execute([gmdate('Y-m-d\TH:i:s', (int) floor($nowMs / 1000)) . '.000Z', $next, $session['id']]);
    $session['csrf_token'] = (string) $session['csrf_token'];
    return ['user' => $user, 'session' => $session];
}

function ifx_logout(PDO $pdo, ?string $token): void
{
    if ($token === null || $token === '') {
        return;
    }
    $pdo->prepare('DELETE FROM sessions WHERE token_hash = ?')->execute([hash('sha256', $token)]);
}

/** The Owner's repair action when an authenticator is lost; it also ends that account's sessions. */
function ifx_reset_totp(PDO $pdo, string $userId, string $actor): string
{
    $secret = ifx_totp_secret();
    $pdo->prepare('UPDATE vendor_users SET totp_secret = ?, totp_confirmed_at = NULL, totp_last_step = NULL WHERE id = ?')
        ->execute([$secret, $userId]);
    $pdo->prepare('DELETE FROM sessions WHERE vendor_user_id = ?')->execute([$userId]);
    ifx_audit($pdo, $actor, 'vendor_user.totp_reset', $userId, []);
    return $secret;
}

function ifx_session_cookie(?string $token, bool $secure, int $minutes = 30): void
{
    if ($token === null) {
        setcookie(IFX_SESSION_COOKIE, '', [
            'expires' => time() - 3600, 'path' => '/', 'httponly' => true, 'samesite' => 'Strict', 'secure' => $secure,
        ]);
        return;
    }
    setcookie(IFX_SESSION_COOKIE, $token, [
        'expires' => time() + $minutes * 60, 'path' => '/', 'httponly' => true, 'samesite' => 'Strict', 'secure' => $secure,
    ]);
}
