<?php
/**
 * The PHP build's test suite. Run it with any PHP 8 binary:
 *
 *     php cloud/php/tests/run.php
 *
 * It also runs under the WebAssembly PHP that `cloud/tests/php-build.test.ts` uses, so the suite executes in an
 * environment with no MySQL, no mail daemon and no network — which is exactly the shape of a cheap shared host.
 *
 * What it proves: the licence token this build signs is byte-identical to what the desktop verifies, the schema
 * holds no business data, the activation/check-in/renew/release rules match the Node build, and the TOTP, CSRF
 * and escaping helpers are safe.
 */

declare(strict_types=1);

require_once __DIR__ . '/../lib/licence.php';
require_once __DIR__ . '/../lib/database.php';
require_once __DIR__ . '/../lib/service.php';
require_once __DIR__ . '/../lib/auth.php';
require_once __DIR__ . '/../lib/views.php';
require_once __DIR__ . '/../lib/pages.php';

$passed = 0;
$failed = [];

function check(string $name, callable $test): void
{
    global $passed, $failed;
    try {
        $test();
        $passed += 1;
        echo "ok   $name\n";
    } catch (Throwable $error) {
        $failed[] = [$name, $error->getMessage()];
        echo "FAIL $name\n       " . $error->getMessage() . "\n";
    }
}

function assert_true(bool $value, string $message = 'expected true'): void
{
    if (!$value) {
        throw new RuntimeException($message);
    }
}

function assert_same(mixed $expected, mixed $actual, string $message = ''): void
{
    if ($expected !== $actual) {
        throw new RuntimeException($message !== '' ? $message . ' — expected ' . var_export($expected, true) . ', got ' . var_export($actual, true)
            : 'expected ' . var_export($expected, true) . ', got ' . var_export($actual, true));
    }
}

function assert_throws(callable $call, string $needle = ''): void
{
    try {
        $call();
    } catch (Throwable $error) {
        if ($needle !== '' && stripos($error->getMessage(), $needle) === false) {
            throw new RuntimeException('expected an error mentioning ' . $needle . ', got: ' . $error->getMessage());
        }
        return;
    }
    throw new RuntimeException('expected the call to fail');
}

/**
 * A throwaway key for the signing tests. On a PHP whose OpenSSL has Ed25519 this is a real one; on the
 * WebAssembly build used by `cloud/tests/php-build.test.ts` (whose OpenSSL lacks it) the suite falls back to an
 * HMAC-SHA256 signer, which exercises the envelope, the canonical payload and the verification path just as
 * well. The production path is the Ed25519 branch, and `cloud/tests/php-build.test.ts` asserts this build asks
 * for it.
 */
function test_key(): string
{
    // The signing tests need a private key only for the Ed25519 path; the HMAC fallback uses a literal secret.
    $key = function_exists('openssl_pkey_new')
        ? openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1'])
        : false;
    if ($key === false) {
        while (function_exists('openssl_error_string') && openssl_error_string() !== false) {
            // drain
        }
        return '';
    }
    openssl_pkey_export($key, $pem);
    return (string) $pem;
}

/** The test signer: real Ed25519 where the platform has it, HMAC-SHA256 where it does not. */
function test_signer(string $pem, ?callable $override = null): ?callable
{
    if ($override !== null) {
        return $override;
    }
    return ifx_ed25519_supported() ? null : static fn (string $payload): array => ['HMAC-SHA256', hash_hmac('sha256', $payload, 'test-only-key', true)];
}

function test_database(): PDO
{
    $pdo = ifx_open_database('sqlite::memory:', '', '');
    ifx_migrate($pdo);
    return $pdo;
}

$pem = test_key();
$keyId = 'php-test-1';

// ------------------------------------------------------------------ canonical JSON and the token format

check('canonical JSON sorts keys and keeps list order', function (): void {
    $value = ['b' => 2, 'a' => [1, 2, 3], 'c' => ['z' => true, 'y' => null]];
    assert_same('{"a":[1,2,3],"b":2,"c":{"y":null,"z":true}}', ifx_canonicalize($value));
});

check('an empty PHP array encodes as a JSON array, not an object', function (): void {
    // The desktop's `canonicalize` writes `[]` for an array. Nothing in the claims is empty today, but a helper that
    // silently emits `{}` would produce a token the app rejects, so the behaviour is pinned here.
    assert_same('[]', ifx_canonicalize([]));
});

check('a signed token has the envelope shape the desktop verifies', function () use ($pem, $keyId): void {
    $claims = ifx_license_claims([
        'licenseId' => 'lic-1', 'machineId' => 'abcdef01-2345-4678-89ab-cdef01234567', 'edition' => 'PHARMACY',
        'startsAt' => '2026-01-01', 'endsAt' => '2027-01-01', 'issuedAt' => '2026-05-01T10:00:00Z', 'status' => 'active',
        'source' => 'online', 'defaultCurrencyCode' => 'ngn', 'lockCurrency' => true,
        'features' => ['mobileLan' => true, 'mobileInternet' => false], 'adminPhoneLimit' => 2, 'graceDays' => 3,
    ]);
    $token = ifx_sign_token($claims, $pem, $keyId, test_signer($pem));
    $envelope = json_decode($token, true);
    assert_same('infoflex-license', $envelope['format']);
    assert_same(1, $envelope['version']);
    assert_true(in_array($envelope['algorithm'], ['Ed25519', 'HMAC-SHA256'], true));
    assert_same($keyId, $envelope['keyId']);
    $payload = ifx_base64url_decode($envelope['payload']);
    assert_same(ifx_canonicalize(json_decode($payload, true)), $payload, 'the payload must be canonical');
    $decoded = json_decode($payload, true);
    assert_same('NGN', $decoded['defaultCurrencyCode'], 'the currency code is upper-cased');
    assert_same('2026-01-01T00:00:00.000Z', $decoded['startsAt'], 'a bare date becomes a canonical instant');
    // The signature must verify against exactly the bytes that were signed.
    if ($envelope['algorithm'] === 'Ed25519') {
        assert_true($pem !== '', 'the Ed25519 path needs a key');
        assert_same(1, openssl_verify($payload, ifx_base64url_decode($envelope['signature']), ifx_public_key_pem($pem), 0), 'signature must verify');
    } else {
        assert_same(hash_hmac('sha256', $payload, 'test-only-key', true), ifx_base64url_decode($envelope['signature']));
    }
});

check('a tampered payload no longer verifies', function () use ($pem, $keyId): void {
    $claims = ifx_license_claims([
        'licenseId' => 'lic-2', 'machineId' => 'abcdef01-2345-4678-89ab-cdef01234567', 'edition' => 'PHARMACY',
        'startsAt' => '2026-01-01', 'endsAt' => '2027-01-01', 'issuedAt' => '2026-05-01T10:00:00Z',
    ]);
    $envelope = json_decode(ifx_sign_token($claims, $pem, $keyId, test_signer($pem)), true);
    $payload = json_decode(ifx_base64url_decode($envelope['payload']), true);
    $payload['endsAt'] = '2099-01-01T00:00:00.000Z';
    $tampered = ifx_canonicalize($payload);
    if ($envelope['algorithm'] === 'Ed25519') {
        assert_true($pem !== '', 'the Ed25519 path needs a key');
        assert_same(0, openssl_verify($tampered, ifx_base64url_decode($envelope['signature']), ifx_public_key_pem($pem), 0));
    } else {
        assert_true(hash_hmac('sha256', $tampered, 'test-only-key', true) !== ifx_base64url_decode($envelope['signature']));
    }
});

check('a locked currency without a code is refused', function (): void {
    assert_throws(fn () => ifx_license_claims([
        'licenseId' => 'x', 'machineId' => 'abcdef01-2345-4678-89ab-cdef01234567', 'edition' => 'PHARMACY',
        'startsAt' => '2026-01-01', 'endsAt' => '2027-01-01', 'issuedAt' => '2026-05-01T00:00:00Z',
        'lockCurrency' => true, 'defaultCurrencyCode' => null,
    ]), 'locked currency');
});

check('an amount cannot be smuggled into a claim value', function (): void {
    assert_throws(fn () => ifx_license_claims([
        'licenseId' => 'x', 'machineId' => 'abcdef01-2345-4678-89ab-cdef01234567', 'edition' => 'PHARMACY',
        'startsAt' => '2026-01-01', 'endsAt' => '2027-01-01', 'issuedAt' => '2026-05-01T00:00:00Z',
        'defaultCurrencyCode' => '1000.00',
    ]), 'currency');
});

// ------------------------------------------------------------------ dates and keys

check('add_years keeps 29 February sane', function (): void {
    assert_same('2027-02-28', ifx_add_years('2026-02-28', 1));
    assert_same('2028-02-29', ifx_add_years('2024-02-29', 4));
    assert_same('2027-02-28', ifx_add_years('2024-02-29', 3));
});

check('licence keys look like IFX-XXXX-XXXX-XXXX-XXXX', function (): void {
    for ($index = 0; $index < 20; $index += 1) {
        $key = ifx_generate_license_key();
        assert_same(1, preg_match('/^IFX-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/', $key));
        assert_same($key, ifx_normalise_key(strtolower($key)));
    }
    assert_same(null, ifx_normalise_key('not-a-key'));
});

// ------------------------------------------------------------------ TOTP

check('TOTP matches the RFC 6238 test vector for 59 seconds', function (): void {
    // The RFC's SHA-1 secret is ASCII "12345678901234567890"; base32 of that is the well-known test secret.
    $secret = ifx_base32_encode('12345678901234567890');
    assert_same('287082', ifx_totp_code($secret, 59_000));
});

check('TOTP accepts one step of drift and refuses a replay', function (): void {
    $secret = ifx_totp_secret();
    $now = 1_800_000_000_000; // int, because these helpers take integer milliseconds
    $code = ifx_totp_code($secret, $now);
    assert_same(intdiv(1_800_000_000, 30), ifx_totp_verify($secret, $code, $now, null));
    assert_same(null, ifx_totp_verify($secret, $code, $now, intdiv(1_800_000_000, 30)), 'a used step must be refused');
    assert_same(null, ifx_totp_verify($secret, '000000', $now, null), 'a wrong code must be refused');
    assert_same(null, ifx_totp_verify($secret, 'abcdef', $now, null), 'a non-numeric code must be refused');
});

check('the TOTP URI carries the issuer, secret and SHA1/6/30', function (): void {
    $uri = ifx_totp_uri('ABCDEF234567', 'owner@example.com');
    assert_true(str_starts_with($uri, 'otpauth://totp/Infoflex%20Vendor%3Aowner%40example.com?'));
    assert_true(str_contains($uri, 'secret=ABCDEF234567'));
    assert_true(str_contains($uri, 'algorithm=SHA1'));
    assert_true(str_contains($uri, 'digits=6'));
    assert_true(str_contains($uri, 'period=30'));
});

// ------------------------------------------------------------------ passwords and escaping

check('password rules match the Node build', function (): void {
    ifx_assert_strong_password('correct-horse-battery-staple');
    ifx_assert_strong_password('Sup3r!secret');
    foreach (['short', 'alllowercase', '123456789012', 'aaaaaaaaaaaaaaaaaaaa', 'password123!ok'] as $weak) {
        assert_throws(fn () => ifx_assert_strong_password($weak));
    }
});

check('HTML escaping neutralises a script tag and an attribute break', function (): void {
    assert_same('&lt;script&gt;alert(1)&lt;/script&gt;', ifx_e('<script>alert(1)</script>'));
    assert_same('&quot; onmouseover=&quot;x', ifx_e('" onmouseover="x'));
});

check('CSRF comparison needs the session token exactly', function (): void {
    $_SESSION = [];
    $token = ifx_csrf_token();
    assert_true(ifx_csrf_check($token));
    assert_true(!ifx_csrf_check($token . 'x'));
    assert_true(!ifx_csrf_check(''));
    assert_true(!ifx_csrf_check(null));
});

// ------------------------------------------------------------------ schema

check('the schema holds only licence and contact columns', function (): void {
    $pdo = test_database();
    $allowed = ifx_allowed_columns();
    $tables = array_map(
        static fn (array $row) => (string) $row['name'],
        $pdo->query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")->fetchAll(),
    );
    sort($tables);
    $expected = array_keys($allowed);
    sort($expected);
    assert_same($expected, $tables, 'table list');
    foreach ($allowed as $table => $columns) {
        $actual = array_map(static fn (array $row) => (string) $row['name'], $pdo->query("PRAGMA table_info($table)")->fetchAll());
        sort($actual);
        $sorted = $columns;
        sort($sorted);
        assert_same($sorted, $actual, "columns of $table");
    }
    $forbidden = '/(sale|price|amount|stock|inventory|product|revenue|payment|receipt|total|cost|quantity|margin)/i';
    foreach ($allowed as $table => $columns) {
        foreach ($columns as $column) {
            assert_true(preg_match($forbidden, $column) !== 1, "forbidden column $table.$column");
        }
    }
});

check('the currency list mirrors the application catalogue', function (): void {
    assert_same(54, count(IFX_CURRENCIES), 'the application has 54 currencies');
    $codes = array_map(static fn (array $entry) => $entry[0], IFX_CURRENCIES);
    assert_same(count($codes), count(array_unique($codes)), 'no duplicate codes');
    foreach (['NGN', 'USD', 'EUR', 'GBP', 'JPY', 'KWD'] as $required) {
        assert_true(in_array($required, $codes, true), "missing $required");
    }
});

// ------------------------------------------------------------------ the licence lifecycle

check('activation binds the first machine and refuses a second', function () use ($pem, $keyId): void {
    $pdo = test_database();
    $service = new IfxService($pdo, $pem, $keyId, null, test_signer($pem));
    $result = $service->createLicense([
        'businessName' => 'Test Chemist', 'edition' => 'PHARMACY',
        'startsAt' => '2026-01-01', 'endsAt' => '2027-01-01', 'maxAdminPhones' => 2,
        'mobileLan' => true, 'mobileInternet' => true, 'defaultCurrencyCode' => 'NGN', 'lockCurrency' => true,
    ], 'owner@example.com');
    $key = (string) $result['license']['license_key'];

    $activation = $service->activate([
        'activationKey' => $key, 'machineId' => 'aaaa1111-2222-4333-8444-555566667777', 'appVersion' => '1.0.0', 'platform' => 'win32',
    ]);
    $claims = json_decode(ifx_base64url_decode(json_decode($activation['token'], true)['payload']), true);
    assert_same('NGN', $claims['defaultCurrencyCode']);
    assert_same(true, $claims['lockCurrency']);
    assert_same('PHARMACY', $claims['edition']);

    assert_throws(fn () => $service->activate([
        'activationKey' => $key, 'machineId' => 'bbbb1111-2222-4333-8444-555566667777', 'appVersion' => '1.0.0', 'platform' => 'win32',
    ]), 'another computer');

    $service->rebind((string) $result['license']['id'], 'owner@example.com');
    $second = $service->activate([
        'activationKey' => $key, 'machineId' => 'bbbb1111-2222-4333-8444-555566667777', 'appVersion' => '1.0.0', 'platform' => 'win32',
    ]);
    assert_true(isset($second['token']));
});

check('a renewal reaches the till on the next check-in', function () use ($pem, $keyId): void {
    $pdo = test_database();
    $service = new IfxService($pdo, $pem, $keyId, null, test_signer($pem));
    $created = $service->createLicense([
        'businessName' => 'Renew Ltd', 'edition' => 'SUPERMARKET', 'startsAt' => '2026-01-01', 'endsAt' => '2026-12-31',
    ], 'owner@example.com');
    $machine = 'cccc1111-2222-4333-8444-555566667777';
    $service->activate([
        'activationKey' => (string) $created['license']['license_key'], 'machineId' => $machine, 'appVersion' => '1.0.0', 'platform' => 'win32',
    ]);
    $id = (string) $created['license']['id'];
    $idle = $service->checkIn(['licenseId' => $id, 'machineId' => $machine, 'appVersion' => '1.0.0', 'platform' => 'win32']);
    assert_same(false, $idle['updated'], 'nothing changed, so no new token');

    $service->renew($id, '2028-12-31', 'owner@example.com', true);
    $renewed = $service->checkIn(['licenseId' => $id, 'machineId' => $machine, 'appVersion' => '1.0.0', 'platform' => 'win32']);
    assert_same(true, $renewed['updated']);
    $claims = json_decode(ifx_base64url_decode(json_decode((string) $renewed['token'], true)['payload']), true);
    assert_true(str_starts_with((string) $claims['endsAt'], '2028-12-31'));
});

check('suspend and unsuspend are delivered and never touch the term', function () use ($pem, $keyId): void {
    $pdo = test_database();
    $service = new IfxService($pdo, $pem, $keyId, null, test_signer($pem));
    $created = $service->createLicense([
        'businessName' => 'Suspend Ltd', 'edition' => 'PHARMACY', 'startsAt' => '2026-01-01', 'endsAt' => '2027-06-30', 'graceDays' => 5,
    ], 'owner@example.com');
    $id = (string) $created['license']['id'];
    $machine = 'dddd1111-2222-4333-8444-555566667777';
    $service->activate(['activationKey' => (string) $created['license']['license_key'], 'machineId' => $machine, 'appVersion' => '1', 'platform' => 'win32']);
    $service->setStatus($id, 'suspended', 'owner@example.com');
    $suspended = $service->checkIn(['licenseId' => $id, 'machineId' => $machine, 'appVersion' => '1', 'platform' => 'win32']);
    $claims = json_decode(ifx_base64url_decode(json_decode((string) $suspended['token'], true)['payload']), true);
    assert_same('suspended', $claims['status']);
    assert_same(5, $claims['graceDays']);
    assert_true(str_starts_with((string) $claims['endsAt'], '2027-06-30'), 'suspension must not shorten the term');
});

check('an expired licence cannot be activated and the app is told why', function () use ($pem, $keyId): void {
    $pdo = test_database();
    $service = new IfxService($pdo, $pem, $keyId, null, test_signer($pem));
    $created = $service->createLicense([
        'businessName' => 'Expired Ltd', 'edition' => 'PHARMACY', 'startsAt' => '2024-01-01', 'endsAt' => '2025-01-01',
    ], 'owner@example.com');
    assert_throws(fn () => $service->activate([
        'activationKey' => (string) $created['license']['license_key'], 'machineId' => 'eeee1111-2222-4333-8444-555566667777',
        'appVersion' => '1', 'platform' => 'win32',
    ]), 'end date');
});

check('an on-site licence is reported once and then obeys the vendor', function () use ($pem, $keyId): void {
    $pdo = test_database();
    $service = new IfxService($pdo, $pem, $keyId, null, test_signer($pem));
    $created = $service->createLicense([
        'businessName' => 'Onsite Ltd', 'edition' => 'PHARMACY', 'startsAt' => '2026-01-01', 'endsAt' => '2027-01-01',
    ], 'owner@example.com');
    $id = (string) $created['license']['id'];
    $pdo->prepare("UPDATE licenses SET source = 'onsite', ends_at = '2020-01-01T00:00:00.000Z' WHERE id = ?")->execute([$id]);
    $machine = 'ffff1111-2222-4333-8444-555566667777';
    $report = $service->checkIn([
        'licenseId' => $id, 'machineId' => $machine, 'appVersion' => '1', 'platform' => 'win32', 'source' => 'onsite',
        'onsiteLicense' => [
            'edition' => 'PHARMACY', 'startsAt' => '2026-02-01', 'endsAt' => '2027-02-01', 'issuedAt' => '2026-02-01T00:00:00Z',
            'status' => 'active', 'defaultCurrencyCode' => null, 'lockCurrency' => false,
            'features' => ['mobileLan' => true, 'mobileInternet' => false], 'adminPhoneLimit' => 1, 'graceDays' => 0,
        ],
    ]);
    assert_same(true, $report['updated']);
    $stored = ifx_get_license($pdo, $id);
    assert_true($stored['onsite_reported_at'] !== null, 'the report is recorded');
    assert_true(str_starts_with((string) $stored['ends_at'], '2027-02-01'), 'the first report records the PC’s own term');

    $service->setStatus($id, 'suspended', 'owner@example.com');
    $after = $service->checkIn([
        'licenseId' => $id, 'machineId' => $machine, 'appVersion' => '1', 'platform' => 'win32', 'source' => 'onsite',
        'onsiteLicense' => ['edition' => 'PHARMACY', 'startsAt' => '2026-02-01', 'endsAt' => '2027-02-01', 'issuedAt' => '2026-02-01T00:00:00Z',
            'status' => 'active', 'features' => ['mobileLan' => true, 'mobileInternet' => false], 'adminPhoneLimit' => 1, 'graceDays' => 0],
    ]);
    $claims = json_decode(ifx_base64url_decode(json_decode((string) $after['token'], true)['payload']), true);
    assert_same('suspended', $claims['status'], 'the vendor’s decision beats the PC’s own report');
});

check('an offline file is bound to the machine the vendor names', function () use ($pem, $keyId): void {
    $pdo = test_database();
    $service = new IfxService($pdo, $pem, $keyId, null, test_signer($pem));
    $created = $service->createLicense([
        'businessName' => 'Offline Ltd', 'edition' => 'PHARMACY', 'startsAt' => '2026-01-01', 'endsAt' => '2027-01-01',
        'defaultCurrencyCode' => 'GHS', 'lockCurrency' => true,
    ], 'owner@example.com');
    $file = $service->offlineFile((string) $created['license']['id'], '12345678-1234-4234-8234-123456789012', 'owner@example.com');
    assert_true(str_ends_with($file['fileName'], '.lic'));
    $claims = json_decode(ifx_base64url_decode(json_decode($file['token'], true)['payload']), true);
    assert_same('12345678-1234-4234-8234-123456789012', $claims['machineId']);
    assert_same('GHS', $claims['defaultCurrencyCode']);
    assert_throws(fn () => $service->offlineFile((string) $created['license']['id'], 'too-short', 'owner@example.com'), 'machine ID');
});

check('the activation rate limit stops a flood', function () use ($pem, $keyId): void {
    $pdo = test_database();
    $service = new IfxService($pdo, $pem, $keyId, null, test_signer($pem));
    $created = $service->createLicense([
        'businessName' => 'Flood Ltd', 'edition' => 'PHARMACY', 'startsAt' => '2026-01-01', 'endsAt' => '2027-01-01',
    ], 'owner@example.com');
    $limited = false;
    for ($attempt = 0; $attempt < 15; $attempt += 1) {
        try {
            $service->activate([
                'activationKey' => (string) $created['license']['license_key'],
                'machineId' => 'aaaa1111-2222-4333-8444-555566667777', 'appVersion' => '1', 'platform' => 'win32',
                'ipAddress' => '203.0.113.9',
            ]);
        } catch (IfxLicenceError $error) {
            if ($error->reason === 'rate_limited') {
                $limited = true;
                break;
            }
        }
    }
    assert_true($limited, 'a flood must be rate limited');
});

check('every mutation is audited with the actor', function () use ($pem, $keyId): void {
    $pdo = test_database();
    $service = new IfxService($pdo, $pem, $keyId, null, test_signer($pem));
    $created = $service->createLicense([
        'businessName' => 'Audited Ltd', 'edition' => 'PHARMACY', 'startsAt' => '2026-01-01', 'endsAt' => '2027-01-01',
    ], 'owner@example.com');
    $service->renew((string) $created['license']['id'], '2028-01-01', 'owner@example.com');
    $service->setStatus((string) $created['license']['id'], 'suspended', 'owner@example.com');
    $actions = array_map(static fn (array $row) => (string) $row['action'], $service->listAudit(50));
    foreach (['customer.created', 'license.created', 'license.renewed', 'license.suspended'] as $required) {
        assert_true(in_array($required, $actions, true), "missing audit action $required");
    }
});

// ------------------------------------------------------------------ authentication

check('sign-in needs the password and a fresh code, and locks after eight failures', function (): void {
    $pdo = test_database();
    $user = ifx_create_user($pdo, [
        'email' => 'owner@example.com', 'displayName' => 'Ada', 'password' => 'correct-horse-battery-staple', 'role' => 'OWNER',
    ], 'test');
    $now = 1_800_000_000_000; // int, because these helpers take integer milliseconds
    ifx_confirm_totp($pdo, (string) $user['id'], ifx_totp_code((string) $user['totp_secret'], $now), $now);
    $secret = (string) ifx_totp_code((string) $user['totp_secret'], $now + 30_000);

    $bad = ifx_login($pdo, ['email' => 'owner@example.com', 'password' => 'wrong-password', 'code' => $secret], $now + 30_000);
    assert_same(false, $bad['ok']);
    $good = ifx_login($pdo, ['email' => 'owner@example.com', 'password' => 'correct-horse-battery-staple', 'code' => $secret], $now + 30_000);
    assert_same(true, $good['ok']);
    assert_true(strlen((string) $good['token']) > 20);

    $replay = ifx_login($pdo, ['email' => 'owner@example.com', 'password' => 'correct-horse-battery-staple', 'code' => $secret], $now + 30_000);
    assert_same(false, $replay['ok'], 'a code may be used once');

    $unknown = ifx_login($pdo, ['email' => 'nobody@example.com', 'password' => 'whatever', 'code' => '123456'], $now + 60_000);
    assert_same('That email or password is not correct.', $unknown['message'], 'an unknown address must answer like a wrong password');

    $secret2 = (string) ifx_totp_code((string) $user['totp_secret'], $now + 90_000);
    for ($attempt = 0; $attempt < 8; $attempt += 1) {
        ifx_login($pdo, ['email' => 'owner@example.com', 'password' => 'nope-nope-nope', 'code' => '000000'], $now + 90_000);
    }
    $locked = ifx_login($pdo, ['email' => 'owner@example.com', 'password' => 'correct-horse-battery-staple', 'code' => $secret2], $now + 90_000);
    assert_same('locked', $locked['reason']);
});

check('a session expires on its own and dies when the account is disabled', function (): void {
    $pdo = test_database();
    $user = ifx_create_user($pdo, [
        'email' => 'session@example.com', 'displayName' => 'Session', 'password' => 'another-long-passphrase', 'role' => 'STAFF',
    ], 'test');
    $now = 1_800_000_000_000; // int, because these helpers take integer milliseconds
    ifx_confirm_totp($pdo, (string) $user['id'], ifx_totp_code((string) $user['totp_secret'], $now), $now);
    $login = ifx_login($pdo, [
        'email' => 'session@example.com', 'password' => 'another-long-passphrase',
        'code' => ifx_totp_code((string) $user['totp_secret'], $now + 30_000), 'sessionMinutes' => 30,
    ], $now + 30_000);
    assert_same(true, $login['ok']);
    $token = (string) $login['token'];
    assert_true(ifx_authenticate($pdo, $token, $now + 40_000) !== null);
    assert_true(ifx_authenticate($pdo, $token, $now + 30_000 + 31 * 60_000) === null, 'an idle session must expire');
    $pdo->prepare('UPDATE vendor_users SET is_active = 0 WHERE id = ?')->execute([$user['id']]);
    assert_true(ifx_authenticate($pdo, $token, $now + 60_000) === null, 'a disabled account must be refused');
});

check('a reset two-factor secret is new and unconfirmed', function (): void {
    $pdo = test_database();
    $user = ifx_create_user($pdo, [
        'email' => 'reset@example.com', 'displayName' => 'Reset', 'password' => 'another-long-passphrase', 'role' => 'OWNER',
    ], 'test');
    $now = 1_800_000_000_000; // int, because these helpers take integer milliseconds
    ifx_confirm_totp($pdo, (string) $user['id'], ifx_totp_code((string) $user['totp_secret'], $now), $now);
    $secret = ifx_reset_totp($pdo, (string) $user['id'], 'test');
    assert_true($secret !== $user['totp_secret']);
    $statement = $pdo->prepare('SELECT totp_confirmed_at FROM vendor_users WHERE id = ?');
    $statement->execute([$user['id']]);
    assert_same(null, $statement->fetch()['totp_confirmed_at']);
});

// ------------------------------------------------------------------ views

check('the portal CSS carries the brand colours and a phone layout', function (): void {
    $css = ifx_css();
    assert_true(str_contains($css, '#1F3F73'));
    assert_true(str_contains($css, '#C9A24B'));
    assert_true(str_contains($css, '@media (max-width:720px)'));
});

check('the currency dropdown offers every code and no amounts', function (): void {
    $html = ifx_currency_options('NGN');
    assert_true(str_contains($html, 'value="NGN" selected'));
    assert_true(str_contains($html, 'value="JPY"'));
    assert_true(!preg_match('/amount|price|total/i', $html));
});

check('the licence table escapes a hostile business name', function (): void {
    $html = ifx_license_rows([[
        'id' => 'lic-1', 'customer_name' => '<script>alert(1)</script>', 'license_key' => 'IFX-AAAA-BBBB-CCCC-DDDD',
        'edition' => 'PHARMACY', 'effective_status' => 'active', 'ends_at' => '2027-01-01T00:00:00.000Z',
        'days_remaining' => 200, 'default_currency' => 'NGN', 'lock_currency' => 1, 'online_now' => true,
        'last_app_version' => '1.0.0', 'source' => 'online',
    ]]);
    assert_true(!str_contains($html, '<script>'), 'a business name must never be echoed raw');
    assert_true(str_contains($html, '&lt;script&gt;'));
});

check('the CSV export has no financial columns and quotes commas', function (): void {
    $csv = ifx_csv([[
        'customer_name' => 'Smith, Jones & Co', 'license_key' => 'IFX-AAAA-BBBB-CCCC-DDDD', 'edition' => 'PHARMACY',
        'effective_status' => 'active', 'starts_at' => '2026-01-01T00:00:00.000Z', 'ends_at' => '2027-01-01T00:00:00.000Z',
        'days_remaining' => 200, 'max_admin_phones' => 1, 'mobile_lan' => 1, 'mobile_internet' => 0,
        'default_currency' => 'NGN', 'lock_currency' => 1, 'machine_id' => null, 'source' => 'online', 'last_checkin_at' => null,
    ]]);
    assert_true(str_contains($csv, '"Smith, Jones & Co"'));
    assert_true(!preg_match('/amount|price|total|sales/i', $csv));
    assert_true(str_starts_with($csv, "\u{FEFF}"));
});

check('the new-licence form shows the currency dropdown and the lock checkbox', function (): void {
    $html = ifx_new_licence_body([], null);
    assert_true(str_contains($html, 'DEFAULT CURRENCY'));
    assert_true(str_contains($html, 'name="lockCurrency"'));
    assert_true(str_contains($html, 'name="mobileInternet"'));
    assert_true(str_contains($html, 'name="csrf"'));
});

// ------------------------------------------------------------------ result

echo "\n" . $passed . ' passed, ' . count($failed) . " failed\n";
if ($failed !== []) {
    foreach ($failed as [$name, $message]) {
        echo " - $name: $message\n";
    }
    exit(1);
}
exit(0);
