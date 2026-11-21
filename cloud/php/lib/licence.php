<?php
/**
 * Shared helpers for the PHP build: canonical JSON, the licence token format, dates, money-free formatting.
 *
 * This file deliberately has no dependencies, so it can be unit-tested on its own. It mirrors
 * `src/license/crypto.ts` byte for byte: a token signed here must verify in the desktop app, and that is the
 * one thing in this build that cannot be approximated.
 */

declare(strict_types=1);

const IFX_EDITION_PHARMACY = 'PHARMACY';
const IFX_EDITION_SUPERMARKET = 'SUPERMARKET';
const IFX_EDITION_BOTH = 'BOTH';
const IFX_EDITIONS = [IFX_EDITION_PHARMACY, IFX_EDITION_SUPERMARKET, IFX_EDITION_BOTH];

const IFX_SOURCE_ONLINE = 'online';
const IFX_SOURCE_FILE = 'file';
const IFX_SOURCE_ONSITE = 'onsite';

/** JSON with object keys sorted the way the desktop's `canonicalize` sorts them. */
function ifx_canonicalize(mixed $value): string
{
    if ($value === null || is_bool($value) || is_int($value) || is_float($value) || is_string($value)) {
        return ifx_json_scalar($value);
    }
    if (is_array($value) && array_is_list($value)) {
        $parts = [];
        foreach ($value as $item) {
            $parts[] = ifx_canonicalize($item);
        }
        return '[' . implode(',', $parts) . ']';
    }
    if (is_array($value)) {
        $keys = array_keys($value);
        // The desktop sorts with `localeCompare(.., 'en')`, which is a plain code-unit order for these keys.
        usort($keys, static fn ($a, $b) => strcmp((string) $a, (string) $b));
        $parts = [];
        foreach ($keys as $key) {
            $parts[] = ifx_json_scalar((string) $key) . ':' . ifx_canonicalize($value[$key]);
        }
        return '{' . implode(',', $parts) . '}';
    }
    throw new InvalidArgumentException('A licence claim has a value JSON cannot represent.');
}

function ifx_json_scalar(mixed $value): string
{
    // JSON_UNESCAPED_* matches JavaScript's JSON.stringify for the ASCII claim names and values we emit.
    $encoded = json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION);
    if ($encoded === false) {
        throw new InvalidArgumentException('A licence claim could not be encoded.');
    }
    return $encoded;
}

function ifx_base64url_encode(string $bytes): string
{
    return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
}

function ifx_base64url_decode(string $text): string
{
    if ($text === '' || preg_match('/^[A-Za-z0-9_-]+$/', $text) !== 1) {
        throw new InvalidArgumentException('The base64url text is not valid.');
    }
    $padded = str_pad(strtr($text, '-_', '+/'), (int) (ceil(strlen($text) / 4) * 4), '=');
    $decoded = base64_decode($padded, true);
    if ($decoded === false) {
        throw new InvalidArgumentException('The base64url text is not valid.');
    }
    return $decoded;
}

/**
 * The exact claim shape the desktop verifies. Order does not matter (canonicalisation sorts), but every field
 * must be present and of the right type, because the desktop rejects anything else.
 */
function ifx_license_claims(array $input): array
{
    $edition = strtoupper((string) ($input['edition'] ?? ''));
    if (!in_array($edition, IFX_EDITIONS, true)) {
        throw new InvalidArgumentException('The edition is not valid.');
    }
    $currency = $input['defaultCurrencyCode'] ?? null;
    if ($currency !== null) {
        $currency = strtoupper(trim((string) $currency));
        if (preg_match('/^[A-Z0-9]{3,8}$/', $currency) !== 1) {
            throw new InvalidArgumentException('The default currency code is not valid.');
        }
    }
    if (($input['lockCurrency'] ?? false) === true && $currency === null) {
        throw new InvalidArgumentException('A locked currency needs a currency code.');
    }
    $status = (string) ($input['status'] ?? 'active');
    if (!in_array($status, ['active', 'suspended', 'revoked'], true)) {
        throw new InvalidArgumentException('The licence status is not valid.');
    }
    $source = (string) ($input['source'] ?? IFX_SOURCE_ONLINE);
    if (!in_array($source, [IFX_SOURCE_ONLINE, IFX_SOURCE_FILE, IFX_SOURCE_ONSITE], true)) {
        throw new InvalidArgumentException('The licence source is not valid.');
    }
    return [
        'licenseId' => (string) $input['licenseId'],
        'machineId' => (string) $input['machineId'],
        'edition' => $edition,
        'startsAt' => ifx_iso_instant((string) $input['startsAt']),
        'endsAt' => ifx_iso_instant((string) $input['endsAt']),
        'issuedAt' => ifx_iso_instant((string) $input['issuedAt']),
        'status' => $status,
        'source' => $source,
        'defaultCurrencyCode' => $currency,
        'lockCurrency' => ($input['lockCurrency'] ?? false) === true,
        'features' => [
            'mobileLan' => ($input['features']['mobileLan'] ?? false) === true,
            'mobileInternet' => ($input['features']['mobileInternet'] ?? false) === true,
        ],
        'adminPhoneLimit' => (int) ($input['adminPhoneLimit'] ?? 1),
        'graceDays' => (int) ($input['graceDays'] ?? 0),
    ];
}

/** "2027-01-01" or "2027-01-01T00:00:00+00:00" → "2027-01-01T00:00:00.000Z", the only form the app accepts. */
function ifx_iso_instant(string $value): string
{
    $text = trim($value);
    $date = null;
    if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $text) === 1) {
        $date = new DateTimeImmutable($text . 'T00:00:00', new DateTimeZone('UTC'));
    } else {
        try {
            $date = (new DateTimeImmutable($text))->setTimezone(new DateTimeZone('UTC'));
        } catch (Exception) {
            $date = null;
        }
    }
    if ($date === null) {
        throw new InvalidArgumentException('A licence date is not valid.');
    }
    return $date->format('Y-m-d\TH:i:s') . '.000Z';
}

/**
 * Signs a licence token.
 *
 * The desktop verifies a JSON envelope whose payload is the canonical claims JSON and whose signature is a
 * detached Ed25519 signature over those exact bytes. PHP's OpenSSL has supported that since 1.1.1, so the call is
 * `openssl_sign($payload, $signature, $key, 0)` — the `0` means "no digest", which is what Ed25519 requires.
 *
 * `$signer` exists so the test suite can exercise the envelope and the canonical payload on a PHP build whose
 * OpenSSL lacks Ed25519 (the WebAssembly build used by `cloud/tests/php-build.test.ts` is one). Nothing in
 * production passes it: `api.php` and the portal always take the OpenSSL path.
 */
function ifx_sign_token(array $claims, string $privateKeyPem, string $keyId, ?callable $signer = null): string
{
    $payload = ifx_canonicalize(ifx_license_claims($claims));
    $algorithm = 'Ed25519';
    if ($signer !== null) {
        [$algorithm, $signature] = $signer($payload);
    } else {
        $key = openssl_pkey_get_private($privateKeyPem);
        if ($key === false) {
            throw new RuntimeException('The signing key could not be read.');
        }
        $signature = '';
        if (!openssl_sign($payload, $signature, $key, 0)) {
            throw new RuntimeException('The licence could not be signed. This PHP build’s OpenSSL does not support Ed25519 — the deployment guide lists the PHP versions that do.');
        }
    }
    $envelope = [
        'format' => 'infoflex-license',
        'version' => 1,
        'algorithm' => $algorithm,
        'keyId' => $keyId,
        'payload' => ifx_base64url_encode($payload),
        'signature' => ifx_base64url_encode($signature),
    ];
    return ifx_json_scalar($envelope);
}

/**
 * True when this PHP's OpenSSL can actually sign Ed25519. Every PHP 8.1+ host with the openssl extension can;
 * this exists so the setup page can say so plainly instead of failing at the first licence.
 */
function ifx_ed25519_supported(): bool
{
    static $supported = null;
    if ($supported !== null) {
        return $supported;
    }
    if (!function_exists('openssl_sign') || !function_exists('openssl_pkey_new')) {
        $supported = false;
        return $supported;
    }
    // OpenSSL 3 lists ED25519 among its curves; OpenSSL 1.1.1 does not, so a key-type constant is the better
    // signal when PHP is new enough to define one.
    if (defined('OPENSSL_KEYTYPE_ED25519')) {
        $key = openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_ED25519]);
        while (openssl_error_string() !== false) {
            // Drain the error queue so a failed probe does not surface as a later warning.
        }
        $supported = $key !== false;
        return $supported;
    }
    $curves = openssl_get_curve_names() ?: [];
    $supported = in_array('ED25519', array_map('strtoupper', $curves), true);
    return $supported;
}

// ---------------------------------------------------------------------------- dates

function ifx_today(): string
{
    return gmdate('Y-m-d');
}

function ifx_add_years(string $dateText, int $years): string
{
    $date = DateTimeImmutable::createFromFormat('!Y-m-d', $dateText, new DateTimeZone('UTC'));
    if ($date === false) {
        return $dateText;
    }
    $target = $date->setDate((int) $date->format('Y') + $years, (int) $date->format('m'), (int) $date->format('d'));
    // 29 February in a non-leap year rolls to 1 March; step back to the last day of the month instead.
    if ($target->format('m') !== $date->format('m')) {
        $target = $target->modify('last day of previous month');
    }
    return $target->format('Y-m-d');
}

function ifx_days_remaining(string $endsAt, ?int $nowMs = null): int
{
    $end = strtotime($endsAt);
    $now = $nowMs === null ? time() : (int) floor($nowMs / 1000);
    if ($end === false) {
        return 0;
    }
    return (int) ceil(($end - $now) / 86400);
}

// ---------------------------------------------------------------------------- licences

function ifx_generate_license_key(): string
{
    $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    $blocks = [];
    for ($block = 0; $block < 4; $block += 1) {
        $text = '';
        for ($index = 0; $index < 4; $index += 1) {
            $text .= $alphabet[random_int(0, strlen($alphabet) - 1)];
        }
        $blocks[] = $text;
    }
    return 'IFX-' . implode('-', $blocks);
}

function ifx_normalise_key(string $key): ?string
{
    $text = strtoupper(preg_replace('/\s+/', '', trim($key)) ?? '');
    return preg_match('/^IFX-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/', $text) === 1 ? $text : null;
}

function ifx_machine_id_valid(string $machineId): bool
{
    return preg_match('/^[a-fA-F0-9-]{16,128}$/', $machineId) === 1;
}

// ---------------------------------------------------------------------------- TOTP

function ifx_base32_decode(string $secret): string
{
    $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    $bits = 0;
    $value = 0;
    $output = '';
    foreach (str_split(strtoupper(preg_replace('/\s+/', '', $secret) ?? '')) as $character) {
        $index = strpos($alphabet, $character);
        if ($index === false) {
            continue;
        }
        $value = ($value << 5) | $index;
        $bits += 5;
        if ($bits >= 8) {
            $bits -= 8;
            $output .= chr(($value >> $bits) & 0xff);
        }
    }
    return $output;
}

function ifx_base32_encode(string $bytes): string
{
    $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    $bits = 0;
    $value = 0;
    $output = '';
    for ($index = 0; $index < strlen($bytes); $index += 1) {
        $value = ($value << 8) | ord($bytes[$index]);
        $bits += 8;
        while ($bits >= 5) {
            $bits -= 5;
            $output .= $alphabet[($value >> $bits) & 0x1f];
        }
    }
    if ($bits > 0) {
        $output .= $alphabet[($value << (5 - $bits)) & 0x1f];
    }
    return $output;
}

/**
 * Milliseconds to whole seconds.
 *
 * A millisecond timestamp does not fit a 32-bit PHP integer, so nothing after this point handles milliseconds:
 * seconds fit until the year 2038 and the rest of the build uses them.
 */
function ifx_millis_to_seconds(int|float|null $atMs): int
{
    $millis = $atMs ?? microtime(true) * 1000;
    return (int) floor($millis / 1000);
}

function ifx_totp_secret(): string
{
    return ifx_base32_encode(random_bytes(20));
}

/**
 * The current code for a secret. `$atMs` is a millisecond timestamp; a float is accepted because that is what
 * `microtime(true) * 1000` produces, and it is truncated to whole milliseconds first.
 */
function ifx_totp_code(string $secret, int|float|null $atMs = null): string
{
    $counter = intdiv(ifx_millis_to_seconds($atMs), 30);
    $key = ifx_base32_decode($secret);
    $binary = pack('N2', 0, $counter);
    $digest = hash_hmac('sha1', $binary, $key, true);
    $offset = ord($digest[strlen($digest) - 1]) & 0x0f;
    $number = ((ord($digest[$offset]) & 0x7f) << 24)
        | (ord($digest[$offset + 1]) << 16)
        | (ord($digest[$offset + 2]) << 8)
        | ord($digest[$offset + 3]);
    return str_pad((string) ($number % 1000000), 6, '0', STR_PAD_LEFT);
}

/**
 * Verifies a code with one step of drift either way and refuses a step that has already been used.
 * Returns the matched step, or null.
 */
function ifx_totp_verify(string $secret, string $code, int|float|null $atMs, ?int $lastUsedStep): ?int
{
    $text = preg_replace('/[\s-]/', '', $code) ?? '';
    if (preg_match('/^\d{6}$/', $text) !== 1) {
        return null;
    }
    $current = intdiv(ifx_millis_to_seconds($atMs), 30);
    for ($offset = -1; $offset <= 1; $offset += 1) {
        $step = $current + $offset;
        if ($step < 0 || ($lastUsedStep !== null && $step <= $lastUsedStep)) {
            continue;
        }
        if (hash_equals(ifx_totp_code($secret, $step * 30000), $text)) {
            return $step;
        }
    }
    return null;
}

function ifx_totp_uri(string $secret, string $account, string $issuer = 'Infoflex Vendor'): string
{
    $label = rawurlencode($issuer . ':' . $account);
    $query = http_build_query([
        'secret' => $secret,
        'issuer' => $issuer,
        'algorithm' => 'SHA1',
        'digits' => 6,
        'period' => 30,
    ], '', '&', PHP_QUERY_RFC3986);
    return 'otpauth://totp/' . $label . '?' . $query;
}

// ---------------------------------------------------------------------------- passwords and text

/** Same rule as the Node build: 12 characters with three classes, or a 20-character passphrase. */
function ifx_assert_strong_password(string $password): void
{
    if (strlen($password) < 12) {
        throw new InvalidArgumentException('Use at least 12 characters for the password.');
    }
    if (strlen($password) > 200) {
        throw new InvalidArgumentException('The password is too long.');
    }
    $classes = 0;
    foreach (['/[a-z]/', '/[A-Z]/', '/\d/', '/[^A-Za-z0-9]/'] as $pattern) {
        if (preg_match($pattern, $password) === 1) {
            $classes += 1;
        }
    }
    if ($classes < 3 && strlen($password) < 20) {
        throw new InvalidArgumentException('Use a mix of upper case, lower case, numbers and symbols, or a passphrase of at least 20 characters.');
    }
    if (count(array_unique(str_split(strtolower($password)))) < 5) {
        throw new InvalidArgumentException('That password repeats too few characters to be safe.');
    }
    if (preg_match('/^(password|letmein|qwerty|admin|welcome)/i', $password) === 1) {
        throw new InvalidArgumentException('That password is too easy to guess.');
    }
}

/**
 * Bounds a text value by characters where mbstring is available and by bytes where it is not. The PHP build must
 * run on a bare shared host, so no extension is assumed; a truncation landing mid-character is harmless here
 * because every consumer re-encodes or displays rather than slicing the value again.
 */
function ifx_clip(string $value, int $max): string
{
    if (function_exists('mb_substr')) {
        return mb_substr($value, 0, $max);
    }
    return substr($value, 0, $max);
}

function ifx_e(?string $value): string
{
    return htmlspecialchars((string) $value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function ifx_csrf_token(): string
{
    if (!isset($_SESSION['csrf']) || !is_string($_SESSION['csrf']) || $_SESSION['csrf'] === '') {
        $_SESSION['csrf'] = ifx_base64url_encode(random_bytes(24));
    }
    return $_SESSION['csrf'];
}

function ifx_csrf_check(?string $provided): bool
{
    $expected = $_SESSION['csrf'] ?? null;
    if (!is_string($expected) || !is_string($provided) || $provided === '') {
        return false;
    }
    return hash_equals($expected, $provided);
}

function ifx_redirect(string $location): never
{
    header('Location: ' . $location, true, 302);
    exit;
}

function ifx_flash(?string $message = null): ?string
{
    if ($message !== null) {
        $_SESSION['flash'] = $message;
        return null;
    }
    $value = $_SESSION['flash'] ?? null;
    unset($_SESSION['flash']);
    return is_string($value) ? $value : null;
}
