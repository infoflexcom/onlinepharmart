<?php
/**
 * The PHP build's licence rules: activation, check-in, renewal, suspension, rebinding, offline files.
 *
 * Same contract as the Node service, because the desktop app cannot tell the two apart:
 *   - activation binds the first machine and refuses a second until the vendor rebinds;
 *   - a change bumps `revision`, and a check-in only hands back a token when `revision` has moved past what the
 *     PC already holds, so a renewal reaches the shop on its next poll with no password typed at the till;
 *   - suspend and expire are separate: the vendor's decision is `status`, the calendar is nobody's decision.
 */

declare(strict_types=1);

require_once __DIR__ . '/licence.php';
require_once __DIR__ . '/database.php';

const IFX_ACTIVATION_LIMIT_IP = 12;
const IFX_ACTIVATION_LIMIT_KEY = 10;
const IFX_ACTIVATION_WINDOW_MINUTES = 15;

class IfxLicenceError extends RuntimeException
{
    public function __construct(public readonly string $reason, string $message)
    {
        parent::__construct($message);
    }
}

final class IfxService
{
    /**
     * `$signer` is a test seam only: it lets the suite run on a PHP build without Ed25519 while still exercising
     * the envelope and payload. Production constructs the service with four arguments and signs with OpenSSL.
     *
     * @param null|callable(string):array{0:string,1:string} $signer
     */
    public function __construct(
        private readonly PDO $pdo,
        private readonly string $privateKeyPem,
        private readonly string $keyId,
        private readonly ?Closure $clock = null,
        private readonly mixed $signer = null,
    ) {
    }

    private function sign(array $claims, string $issuedAt): string
    {
        return ifx_sign_token($this->claimsFor($claims, $issuedAt), $this->privateKeyPem, $this->keyId,
            is_callable($this->signer) ? $this->signer : null);
    }

    private function nowIso(): string
    {
        return $this->clock === null ? ifx_now() : gmdate('Y-m-d\TH:i:s', (int) floor(($this->clock)() / 1000)) . '.000Z';
    }

    private function nowSeconds(): int
    {
        return $this->clock === null ? time() : (int) floor(($this->clock)() / 1000);
    }

    // ---------------------------------------------------------------- customers and licences

    public function createCustomer(array $input, string $actor): array
    {
        $name = trim((string) ($input['businessName'] ?? ''));
        if ($name === '') {
            throw new InvalidArgumentException('Enter the business name.');
        }
        $id = ifx_uuid();
        $now = ifx_now();
        $this->pdo->prepare(
            'INSERT INTO customers (id, business_name, contact_name, phone, email, notes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )->execute([
            $id, ifx_clip($name, 0, 160), ifx_clip(trim((string) ($input['contactName'] ?? '')), 0, 120),
            ifx_clip(trim((string) ($input['phone'] ?? '')), 0, 40), ifx_clip(trim((string) ($input['email'] ?? '')), 0, 160),
            ifx_clip((string) ($input['notes'] ?? ''), 0, 2000), $now, $now,
        ]);
        ifx_audit($this->pdo, $actor, 'customer.created', $id, ['businessName' => $name]);
        return ifx_get_customer($this->pdo, $id) ?? [];
    }

    public function createLicense(array $input, string $actor): array
    {
        $customer = $this->createCustomer($input['customer'] ?? $input, $actor);
        $start = ifx_iso_instant((string) ($input['startsAt'] ?? ifx_today()));
        $end = ifx_iso_instant((string) ($input['endsAt'] ?? ifx_add_years(ifx_today(), 1)));
        if (strtotime($end) <= strtotime($start)) {
            throw new InvalidArgumentException('The end date must be after the start date.');
        }
        $edition = strtoupper((string) ($input['edition'] ?? IFX_EDITION_PHARMACY));
        if (!in_array($edition, IFX_EDITIONS, true)) {
            throw new InvalidArgumentException('Choose a valid edition.');
        }
        $currency = trim((string) ($input['defaultCurrencyCode'] ?? ''));
        $currency = $currency === '' ? null : strtoupper($currency);
        if ($currency !== null && preg_match('/^[A-Z0-9]{3,8}$/', $currency) !== 1) {
            throw new InvalidArgumentException('Choose a valid default currency.');
        }
        $lock = ($input['lockCurrency'] ?? false) === true;
        if ($lock && $currency === null) {
            throw new InvalidArgumentException('A locked currency needs a default currency. Choose one, or untick Lock currency.');
        }
        $id = ifx_uuid();
        $now = ifx_now();
        $this->pdo->prepare(
            'INSERT INTO licenses (id, license_key, customer_id, edition, starts_at, ends_at, status, max_admin_phones,
                mobile_lan, mobile_internet, default_currency, lock_currency, grace_days, machine_id, source, revision,
                delivered_revision, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, \'active\', ?, ?, ?, ?, ?, ?, NULL, \'online\', 0, -1, ?, ?)'
        )->execute([
            $id, $this->freshKey(), $customer['id'], $edition, $start, $end,
            max(1, min(100, (int) ($input['maxAdminPhones'] ?? 1))),
            ($input['mobileLan'] ?? true) === true ? 1 : 0,
            ($input['mobileInternet'] ?? false) === true ? 1 : 0,
            $currency, $lock ? 1 : 0,
            max(0, min(30, (int) ($input['graceDays'] ?? 0))), $now, $now,
        ]);
        ifx_history($this->pdo, $id, $actor, 'license.created', ['edition' => $edition, 'endsAt' => $end]);
        ifx_audit($this->pdo, $actor, 'license.created', $id, ['customerId' => $customer['id'], 'edition' => $edition]);
        return ['customer' => $customer, 'license' => ifx_get_license($this->pdo, $id) ?? []];
    }

    private function freshKey(): string
    {
        for ($attempt = 0; $attempt < 5; $attempt += 1) {
            $key = ifx_generate_license_key();
            $check = $this->pdo->prepare('SELECT 1 FROM licenses WHERE license_key = ?');
            $check->execute([$key]);
            if ($check->fetch() === false) {
                return $key;
            }
        }
        throw new RuntimeException('Could not generate a unique licence key. Try again.');
    }

    /** Every mutation goes through here so `revision` (the poll watermark) is never forgotten. */
    private function touch(string $id): void
    {
        $this->pdo->prepare('UPDATE licenses SET revision = revision + 1, updated_at = ? WHERE id = ?')
            ->execute([ifx_now(), $id]);
    }

    public function renew(string $id, string $endsAt, string $actor, bool $notifyNow = false): void
    {
        $license = ifx_get_license($this->pdo, $id);
        if ($license === null) {
            throw new IfxLicenceError('not_found', 'That licence no longer exists.');
        }
        $end = ifx_iso_instant($endsAt);
        if (strtotime($end) <= strtotime((string) $license['starts_at'])) {
            throw new InvalidArgumentException('The end date must be after the start date.');
        }
        $this->pdo->prepare(
            "UPDATE licenses SET ends_at = ?, status = CASE WHEN status = 'revoked' THEN 'revoked' ELSE 'active' END,
                revision = revision + 1, reminder_stage = NULL, notify_now_at = ?, updated_at = ? WHERE id = ?"
        )->execute([$end, $notifyNow ? ifx_now() : $license['notify_now_at'], ifx_now(), $id]);
        ifx_history($this->pdo, $id, $actor, 'license.renewed', ['endsAt' => $end, 'notifyNow' => $notifyNow]);
        ifx_audit($this->pdo, $actor, 'license.renewed', $id, ['endsAt' => $end]);
    }

    public function setStatus(string $id, string $status, string $actor): void
    {
        if (!in_array($status, ['active', 'suspended', 'revoked'], true)) {
            throw new InvalidArgumentException('That status is not valid.');
        }
        $this->pdo->prepare('UPDATE licenses SET status = ?, revision = revision + 1, notify_now_at = ?, updated_at = ? WHERE id = ?')
            ->execute([$status, ifx_now(), ifx_now(), $id]);
        ifx_history($this->pdo, $id, $actor, 'license.' . $status, []);
        ifx_audit($this->pdo, $actor, 'license.' . $status, $id, []);
    }

    /** The only way a licence moves to another computer: a vendor decision, recorded and audited. */
    public function rebind(string $id, string $actor): void
    {
        $license = ifx_get_license($this->pdo, $id);
        if ($license === null) {
            throw new IfxLicenceError('not_found', 'That licence no longer exists.');
        }
        $this->pdo->prepare('UPDATE licenses SET machine_id = NULL, machine_bound_at = NULL, revision = revision + 1, updated_at = ? WHERE id = ?')
            ->execute([ifx_now(), $id]);
        ifx_history($this->pdo, $id, $actor, 'license.machine_rebound', ['previousMachine' => $license['machine_id']]);
        ifx_audit($this->pdo, $actor, 'license.machine_rebound', $id, []);
    }

    public function setEntitlements(string $id, array $input, string $actor): void
    {
        $currency = trim((string) ($input['defaultCurrencyCode'] ?? ''));
        $currency = $currency === '' ? null : strtoupper($currency);
        $lock = ($input['lockCurrency'] ?? false) === true;
        if ($lock && $currency === null) {
            throw new InvalidArgumentException('A locked currency needs a default currency.');
        }
        $this->pdo->prepare(
            'UPDATE licenses SET max_admin_phones = ?, mobile_lan = ?, mobile_internet = ?, grace_days = ?,
                default_currency = ?, lock_currency = ?, edition = ?, revision = revision + 1, updated_at = ? WHERE id = ?'
        )->execute([
            max(1, min(100, (int) ($input['maxAdminPhones'] ?? 1))),
            ($input['mobileLan'] ?? false) === true ? 1 : 0,
            ($input['mobileInternet'] ?? false) === true ? 1 : 0,
            max(0, min(30, (int) ($input['graceDays'] ?? 0))),
            $currency, $lock ? 1 : 0,
            in_array(strtoupper((string) ($input['edition'] ?? '')), IFX_EDITIONS, true)
                ? strtoupper((string) $input['edition'])
                : 'PHARMACY',
            ifx_now(), $id,
        ]);
        ifx_history($this->pdo, $id, $actor, 'license.entitlements_changed', []);
        ifx_audit($this->pdo, $actor, 'license.entitlements_changed', $id, []);
    }

    // ---------------------------------------------------------------- the device API

    /**
     * Activation. The key is looked up, the machine binding applied on first use only, and the new revision
     * delivered immediately so the PC's first check-in is a no-op.
     */
    public function activate(array $input): array
    {
        $key = ifx_normalise_key((string) ($input['activationKey'] ?? ''));
        $machineId = (string) ($input['machineId'] ?? '');
        if ($key === null) {
            $this->recordAttempt(hash('sha256', strtoupper((string) ($input['activationKey'] ?? ''))), 'invalid_format', null, $input['ipAddress'] ?? null);
            throw new IfxLicenceError('invalid_key', 'Enter a valid activation key.');
        }
        if (!ifx_machine_id_valid($machineId)) {
            throw new IfxLicenceError('invalid', 'The machine ID is missing or not valid.');
        }
        $this->assertWithinLimits($key, $input['ipAddress'] ?? null);

        $statement = $this->pdo->prepare('SELECT * FROM licenses WHERE license_key = ?');
        $statement->execute([$key]);
        $license = $statement->fetch();
        if ($license === false) {
            $this->recordAttempt(hash('sha256', $key), 'unknown_key', $machineId, $input['ipAddress'] ?? null);
            throw new IfxLicenceError('unknown_key', 'The activation key was not accepted.');
        }
        $failure = $this->bindingFailure($license, $machineId);
        if ($failure !== null) {
            $this->recordAttempt(hash('sha256', $key), $failure, $machineId, $input['ipAddress'] ?? null);
            throw new IfxLicenceError($failure, ifx_activation_message($failure));
        }

        $now = ifx_now();
        $this->pdo->beginTransaction();
        try {
            $statement = $this->pdo->prepare('SELECT * FROM licenses WHERE id = ?');
            $statement->execute([$license['id']]);
            $fresh = (array) $statement->fetch();
            $bindMachine = ($fresh['machine_id'] ?? null) === null ? $machineId : $fresh['machine_id'];
            $this->pdo->prepare(
                'UPDATE licenses SET machine_id = ?, machine_bound_at = COALESCE(machine_bound_at, ?), last_checkin_at = ?,
                    last_app_version = ?, last_platform = ?, delivered_revision = revision, updated_at = ? WHERE id = ?'
            )->execute([
                $bindMachine, $now, $now, ifx_clip((string) ($input['appVersion'] ?? ''), 0, 64),
                ifx_clip((string) ($input['platform'] ?? ''), 0, 80), $now, $fresh['id'],
            ]);
            $this->recordCheckin((string) $fresh['id'], $machineId, (string) ($input['appVersion'] ?? ''), (string) ($input['platform'] ?? ''), $now, $input['ipAddress'] ?? null);
            $fresh['machine_id'] = $bindMachine;
            $token = $this->sign($fresh, $now);
            ifx_history($this->pdo, (string) $fresh['id'], 'device', 'license.activated', ['machineId' => $machineId]);
            ifx_audit($this->pdo, 'device', 'license.activated', (string) $fresh['id'], ['machineId' => $machineId]);
            $this->recordAttempt(hash('sha256', $key), 'activated', $machineId, $input['ipAddress'] ?? null);
            $this->pdo->commit();
            return ['token' => $token, 'serverNow' => $now, 'licenseId' => $fresh['id']];
        } catch (Throwable $error) {
            $this->pdo->rollBack();
            throw $error;
        }
    }

    public function checkIn(array $input): array
    {
        $machineId = (string) ($input['machineId'] ?? '');
        if (!ifx_machine_id_valid($machineId)) {
            throw new IfxLicenceError('invalid', 'The machine ID is missing or not valid.');
        }
        $statement = $this->pdo->prepare('SELECT * FROM licenses WHERE id = ?');
        $statement->execute([(string) ($input['licenseId'] ?? '')]);
        $license = $statement->fetch();
        if ($license === false) {
            throw new IfxLicenceError('not_found', 'That licence no longer exists.');
        }

        if (($input['source'] ?? '') === IFX_SOURCE_ONSITE) {
            $license = $this->reconcileOnsite($license, $machineId, $input);
        }
        if ($license['machine_id'] !== null && $license['machine_id'] !== '' && $license['machine_id'] !== $machineId) {
            throw new IfxLicenceError('conflict', 'This licence is bound to a different machine. Ask the vendor to rebind it.');
        }
        $now = ifx_now();
        $this->pdo->prepare(
            'UPDATE licenses SET machine_id = COALESCE(NULLIF(machine_id, \'\'), ?),
                machine_bound_at = COALESCE(machine_bound_at, ?), last_checkin_at = ?, last_app_version = ?, last_platform = ?,
                updated_at = ? WHERE id = ?'
        )->execute([
            $machineId, $now, $now, ifx_clip((string) ($input['appVersion'] ?? ''), 0, 64),
            ifx_clip((string) ($input['platform'] ?? ''), 0, 80), $now, $license['id'],
        ]);
        $this->recordCheckin((string) $license['id'], $machineId, (string) ($input['appVersion'] ?? ''), (string) ($input['platform'] ?? ''), $now, $input['ipAddress'] ?? null);

        if ((int) $license['delivered_revision'] >= (int) $license['revision']) {
            return ['updated' => false, 'reported' => true, 'token' => null, 'serverNow' => $now];
        }
        $this->pdo->prepare('UPDATE licenses SET delivered_revision = revision, notify_now_at = NULL WHERE id = ?')
            ->execute([$license['id']]);
        $license['machine_id'] = $license['machine_id'] ?: $machineId;
        return ['updated' => true, 'reported' => true, 'token' => $this->sign($license, $now), 'serverNow' => $now];
    }

    /** An on-site licence's first report records what the PC issued; after that the vendor's edits win. */
    private function reconcileOnsite(array $license, string $machineId, array $input): array
    {
        $reported = $input['onsiteLicense'] ?? null;
        if (!is_array($reported)) {
            throw new IfxLicenceError('invalid', 'The on-site licence report is incomplete.');
        }
        if ($license['source'] !== IFX_SOURCE_ONSITE) {
            throw new IfxLicenceError('invalid', 'This licence is not an on-site licence.');
        }
        if (!in_array((string) $license['status'], ['active', 'suspended'], true)) {
            throw new IfxLicenceError('revoked', 'This licence has been revoked by the vendor.');
        }
        if (($license['machine_id'] ?? null) !== null && $license['machine_id'] !== '' && $license['machine_id'] !== $machineId) {
            throw new IfxLicenceError('conflict', 'This on-site licence was reported from a different machine.');
        }
        if ($license['onsite_reported_at'] === null) {
            $features = is_array($reported['features'] ?? null) ? $reported['features'] : [];
            $edition = strtoupper((string) ($reported['edition'] ?? IFX_EDITION_PHARMACY));
            $this->pdo->prepare(
                'UPDATE licenses SET starts_at = ?, ends_at = ?, edition = ?, grace_days = ?, max_admin_phones = ?,
                    mobile_lan = ?, mobile_internet = ?, onsite_reported_at = ?, onsite_owner_machine = ?, last_checkin_at = ?
                 WHERE id = ?'
            )->execute([
                ifx_iso_instant((string) ($reported['startsAt'] ?? $license['starts_at'])),
                ifx_iso_instant((string) ($reported['endsAt'] ?? $license['ends_at'])),
                in_array($edition, IFX_EDITIONS, true) ? $edition : IFX_EDITION_PHARMACY,
                max(0, min(30, (int) ($reported['graceDays'] ?? 0))),
                max(1, min(100, (int) ($reported['adminPhoneLimit'] ?? 1))),
                !empty($features['mobileLan']) ? 1 : 0,
                !empty($features['mobileInternet']) ? 1 : 0,
                ifx_now(), $machineId, ifx_now(), $license['id'],
            ]);
            ifx_history($this->pdo, (string) $license['id'], 'device', 'license.onsite_reported', ['machineId' => $machineId]);
            ifx_audit($this->pdo, 'device', 'license.onsite_reported', (string) $license['id'], ['machineId' => $machineId]);
            $statement = $this->pdo->prepare('SELECT * FROM licenses WHERE id = ?');
            $statement->execute([$license['id']]);
            $license = (array) $statement->fetch();
        }
        return $license;
    }

    public function claimsFor(array $license, string $issuedAt): array
    {
        return ifx_license_claims([
            'licenseId' => (string) $license['id'],
            'machineId' => (string) $license['machine_id'],
            'edition' => (string) $license['edition'],
            'startsAt' => (string) $license['starts_at'],
            'endsAt' => (string) $license['ends_at'],
            'issuedAt' => $issuedAt,
            'status' => (string) $license['status'],
            'source' => (string) $license['source'],
            'defaultCurrencyCode' => $license['default_currency'] === null || $license['default_currency'] === '' ? null : (string) $license['default_currency'],
            'lockCurrency' => (int) $license['lock_currency'] === 1,
            'features' => [
                'mobileLan' => (int) $license['mobile_lan'] === 1,
                'mobileInternet' => (int) $license['mobile_internet'] === 1,
            ],
            'adminPhoneLimit' => (int) $license['max_admin_phones'],
            'graceDays' => (int) $license['grace_days'],
        ]);
    }

    /** The offline `.lic` file is the same signed token, for a machine the vendor names in advance. */
    public function offlineFile(string $id, string $machineId, string $actor): array
    {
        if (!ifx_machine_id_valid($machineId)) {
            throw new InvalidArgumentException('Enter the machine ID exactly as the app shows it.');
        }
        $license = ifx_get_license($this->pdo, $id);
        if ($license === null) {
            throw new IfxLicenceError('not_found', 'That licence no longer exists.');
        }
        if ($license['status'] === 'revoked') {
            throw new IfxLicenceError('invalid', 'A revoked licence cannot be downloaded.');
        }
        $this->pdo->prepare('UPDATE licenses SET machine_id = ?, machine_bound_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
            ->execute([$machineId, ifx_now(), ifx_now(), $id]);
        ifx_history($this->pdo, $id, $actor, 'license.file_downloaded', ['machineId' => $machineId]);
        ifx_audit($this->pdo, $actor, 'license.file_downloaded', $id, ['machineId' => $machineId]);
        $license['machine_id'] = $machineId;
        $token = $this->sign($license, ifx_now());
        $label = preg_replace('/[^A-Z0-9-]/', '', (string) $license['license_key']);
        return ['token' => $token, 'fileName' => 'infoflex-' . $label . '-' . substr($machineId, 0, 8) . '.lic'];
    }

    private function bindingFailure(array $license, string $machineId): ?string
    {
        if ($license['status'] === 'revoked') {
            return 'revoked';
        }
        if ($license['status'] === 'suspended') {
            return 'suspended';
        }
        $now = strtotime(ifx_now()) ?: time();
        if ((strtotime((string) $license['starts_at']) ?: 0) > $now) {
            return 'not_yet_valid';
        }
        if ((strtotime((string) $license['ends_at']) ?: 0) <= $now) {
            return 'expired';
        }
        if (($license['machine_id'] ?? null) !== null && $license['machine_id'] !== '' && $license['machine_id'] !== $machineId) {
            return 'machine_conflict';
        }
        return null;
    }

    private function assertWithinLimits(string $key, ?string $ip): void
    {
        $window = gmdate('Y-m-d\TH:i:s', $this->nowSeconds() - IFX_ACTIVATION_WINDOW_MINUTES * 60) . '.000Z';
        $hashed = hash('sha256', $key);
        $statement = $this->pdo->prepare('SELECT COUNT(*) AS n FROM activation_attempts WHERE license_key_hash = ? AND created_at > ?');
        $statement->execute([$hashed, $window]);
        if ((int) $statement->fetch()['n'] >= IFX_ACTIVATION_LIMIT_KEY) {
            throw new IfxLicenceError('rate_limited', 'Too many activation attempts. Wait fifteen minutes and try again.');
        }
        if ($ip !== null) {
            $statement = $this->pdo->prepare('SELECT COUNT(*) AS n FROM activation_attempts WHERE ip_address = ? AND created_at > ?');
            $statement->execute([$ip, $window]);
            if ((int) $statement->fetch()['n'] >= IFX_ACTIVATION_LIMIT_IP) {
                throw new IfxLicenceError('rate_limited', 'Too many activation attempts from this connection. Wait fifteen minutes.');
            }
        }
    }

    private function recordAttempt(string $keyHash, string $outcome, ?string $machineId, ?string $ip): void
    {
        $this->pdo->prepare('INSERT INTO activation_attempts (license_key_hash, ip_address, outcome, machine_id, created_at) VALUES (?, ?, ?, ?, ?)')
            ->execute([$keyHash, $ip, $outcome, $machineId, ifx_now()]);
    }

    private function recordCheckin(string $licenseId, string $machineId, string $appVersion, string $platform, string $checkedAt, ?string $ip): void
    {
        $this->pdo->prepare('INSERT INTO checkins (license_id, machine_id, app_version, platform, checked_at, online, ip_address) VALUES (?, ?, ?, ?, ?, 1, ?)')
            ->execute([$licenseId, $machineId, $appVersion, $platform, $checkedAt, $ip]);
    }

    public function listCheckins(string $licenseId, int $limit = 25): array
    {
        $statement = $this->pdo->prepare('SELECT * FROM checkins WHERE license_id = ? ORDER BY checked_at DESC LIMIT ' . max(1, min(200, $limit)));
        $statement->execute([$licenseId]);
        return $statement->fetchAll();
    }

    public function listAudit(int $limit = 200): array
    {
        $rows = $this->pdo->query('SELECT * FROM audit_log ORDER BY id DESC LIMIT ' . max(1, min(1000, $limit)))->fetchAll();
        foreach ($rows as $index => $row) {
            $rows[$index]['detail'] = json_decode((string) $row['detail_json'], true) ?: [];
        }
        return $rows;
    }

    public function listHistory(string $licenseId, int $limit = 50): array
    {
        $statement = $this->pdo->prepare('SELECT * FROM license_history WHERE license_id = ? ORDER BY id DESC LIMIT ' . max(1, min(200, $limit)));
        $statement->execute([$licenseId]);
        $rows = $statement->fetchAll();
        foreach ($rows as $index => $row) {
            $rows[$index]['detail'] = json_decode((string) $row['detail_json'], true) ?: [];
        }
        return $rows;
    }
}

function ifx_activation_message(string $reason): string
{
    return match ($reason) {
        'suspended' => 'This licence is suspended. Contact your supplier.',
        'revoked' => 'This licence has been revoked.',
        'not_yet_valid' => 'This licence is not valid yet.',
        'expired' => 'This licence has passed its end date.',
        'machine_conflict' => 'This licence is already in use on another computer. Ask your supplier to move it.',
        default => 'The activation key was not accepted.',
    };
}
