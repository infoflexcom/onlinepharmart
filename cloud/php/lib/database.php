<?php
/**
 * The PHP build's schema and data access.
 *
 * MySQL in production, SQLite in the automated tests — both speak PDO, and the only MySQL-specific syntax used
 * here is `AUTO_INCREMENT`/`ENGINE`, which the schema picks between by driver name. Every statement is
 * parameterised: the portal's search box is the only place user text reaches SQL, and it never reaches it as
 * a fragment.
 *
 * The tables hold licence and contact data only. There is no column anywhere for a sale, a price, a stock
 * level or an amount, which `cloud/php/tests/schema.test.php` asserts column by column.
 */

declare(strict_types=1);

require_once __DIR__ . '/licence.php';

const IFX_SCHEMA_VERSION = 1;

function ifx_open_database(string $dsn, string $user, string $password): PDO
{
    $options = [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ];
    $pdo = new PDO($dsn, $user, $password, $options);
    $pdo->exec('PRAGMA foreign_keys = ON');
    return $pdo;
}

function ifx_is_sqlite(PDO $pdo): bool
{
    return $pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite';
}

/** The DDL for both drivers. Kept in one function so the two can never drift apart. */
function ifx_schema_statements(PDO $pdo): array
{
    $id = ifx_is_sqlite($pdo) ? 'TEXT PRIMARY KEY' : 'VARCHAR(36) NOT NULL PRIMARY KEY';
    $key = ifx_is_sqlite($pdo) ? 'TEXT' : 'VARCHAR(191)';
    $text = ifx_is_sqlite($pdo) ? 'TEXT' : 'TEXT';
    $short = ifx_is_sqlite($pdo) ? 'TEXT' : 'VARCHAR(64)';
    $auto = ifx_is_sqlite($pdo) ? 'INTEGER PRIMARY KEY AUTOINCREMENT' : 'INT AUTO_INCREMENT PRIMARY KEY';
    $suffix = ifx_is_sqlite($pdo) ? '' : ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

    return [
        "CREATE TABLE IF NOT EXISTS vendor_users (
            id $id,
            email $key NOT NULL UNIQUE,
            display_name $short NOT NULL,
            role $short NOT NULL,
            password_hash $text NOT NULL,
            totp_secret $short NOT NULL,
            totp_confirmed_at $short NULL,
            totp_last_step INTEGER NULL,
            failed_logins INTEGER NOT NULL DEFAULT 0,
            locked_until $short NULL,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at $short NOT NULL,
            last_login_at $short NULL
        )$suffix",

        "CREATE TABLE IF NOT EXISTS sessions (
            id $id,
            vendor_user_id $key NOT NULL,
            token_hash $short NOT NULL UNIQUE,
            csrf_token $short NOT NULL,
            ip_address $short NULL,
            user_agent $text NULL,
            created_at $short NOT NULL,
            last_seen_at $short NOT NULL,
            expires_at $short NOT NULL
        )$suffix",

        "CREATE TABLE IF NOT EXISTS customers (
            id $id,
            business_name $key NOT NULL,
            contact_name $short NOT NULL DEFAULT '',
            phone $short NOT NULL DEFAULT '',
            email $key NOT NULL DEFAULT '',
            notes $text NOT NULL,
            created_at $short NOT NULL,
            updated_at $short NOT NULL
        )$suffix",

        "CREATE TABLE IF NOT EXISTS licenses (
            id $id,
            license_key $key NOT NULL UNIQUE,
            customer_id $key NOT NULL,
            edition $short NOT NULL,
            starts_at $short NOT NULL,
            ends_at $short NOT NULL,
            status $short NOT NULL,
            max_admin_phones INTEGER NOT NULL DEFAULT 1,
            mobile_lan INTEGER NOT NULL DEFAULT 1,
            mobile_internet INTEGER NOT NULL DEFAULT 0,
            default_currency $short NULL,
            lock_currency INTEGER NOT NULL DEFAULT 0,
            grace_days INTEGER NOT NULL DEFAULT 0,
            machine_id $short NULL,
            machine_bound_at $short NULL,
            source $short NOT NULL DEFAULT 'online',
            onsite_reported_at $short NULL,
            onsite_owner_machine $short NULL,
            revision INTEGER NOT NULL DEFAULT 0,
            delivered_revision INTEGER NOT NULL DEFAULT -1,
            last_checkin_at $short NULL,
            last_app_version $short NULL,
            last_platform $short NULL,
            notify_now_at $short NULL,
            reminder_stage INTEGER NULL,
            created_at $short NOT NULL,
            updated_at $short NOT NULL
        )$suffix",

        "CREATE TABLE IF NOT EXISTS license_history (
            id $auto,
            license_id $key NOT NULL,
            actor $short NOT NULL,
            action $short NOT NULL,
            detail_json $text NOT NULL,
            created_at $short NOT NULL
        )$suffix",

        "CREATE TABLE IF NOT EXISTS checkins (
            id $auto,
            license_id $key NOT NULL,
            machine_id $short NOT NULL,
            app_version $short NOT NULL DEFAULT '',
            platform $short NOT NULL DEFAULT '',
            checked_at $short NOT NULL,
            online INTEGER NOT NULL DEFAULT 1,
            ip_address $short NULL
        )$suffix",

        "CREATE TABLE IF NOT EXISTS audit_log (
            id $auto,
            actor $short NOT NULL,
            action $short NOT NULL,
            target $short NULL,
            ip_address $short NULL,
            detail_json $text NOT NULL,
            created_at $short NOT NULL
        )$suffix",

        "CREATE TABLE IF NOT EXISTS activation_attempts (
            id $auto,
            license_key_hash $short NOT NULL,
            ip_address $short NULL,
            outcome $short NOT NULL,
            machine_id $short NULL,
            created_at $short NOT NULL
        )$suffix",

        "CREATE TABLE IF NOT EXISTS schema_migrations (
            id INTEGER NOT NULL PRIMARY KEY,
            name $short NOT NULL,
            applied_at $short NOT NULL
        )$suffix",

        'CREATE INDEX IF NOT EXISTS licenses_customer ON licenses(customer_id)',
        'CREATE INDEX IF NOT EXISTS licenses_ends ON licenses(ends_at)',
        'CREATE INDEX IF NOT EXISTS checkins_license ON checkins(license_id, checked_at)',
        'CREATE INDEX IF NOT EXISTS audit_created ON audit_log(created_at)',
        'CREATE INDEX IF NOT EXISTS attempts_created ON activation_attempts(created_at)',
    ];
}

function ifx_migrate(PDO $pdo): void
{
    foreach (ifx_schema_statements($pdo) as $statement) {
        $pdo->exec($statement);
    }
    $applied = $pdo->prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE id = ?');
    $applied->execute([IFX_SCHEMA_VERSION]);
    if ((int) $applied->fetch()['n'] === 0) {
        $pdo->prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)')
            ->execute([IFX_SCHEMA_VERSION, 'core licence and vendor tables', ifx_now()]);
    }
}

/** Every table and column the PHP build is allowed to have; the schema test asserts this exactly. */
function ifx_allowed_columns(): array
{
    return [
        'vendor_users' => ['id', 'email', 'display_name', 'role', 'password_hash', 'totp_secret', 'totp_confirmed_at', 'totp_last_step', 'failed_logins', 'locked_until', 'is_active', 'created_at', 'last_login_at'],
        'sessions' => ['id', 'vendor_user_id', 'token_hash', 'csrf_token', 'ip_address', 'user_agent', 'created_at', 'last_seen_at', 'expires_at'],
        'customers' => ['id', 'business_name', 'contact_name', 'phone', 'email', 'notes', 'created_at', 'updated_at'],
        'licenses' => [
            'id', 'license_key', 'customer_id', 'edition', 'starts_at', 'ends_at', 'status', 'max_admin_phones',
            'mobile_lan', 'mobile_internet', 'default_currency', 'lock_currency', 'grace_days', 'machine_id',
            'machine_bound_at', 'source', 'onsite_reported_at', 'onsite_owner_machine', 'revision',
            'delivered_revision', 'last_checkin_at', 'last_app_version', 'last_platform', 'notify_now_at',
            'reminder_stage', 'created_at', 'updated_at',
        ],
        'license_history' => ['id', 'license_id', 'actor', 'action', 'detail_json', 'created_at'],
        'checkins' => ['id', 'license_id', 'machine_id', 'app_version', 'platform', 'checked_at', 'online', 'ip_address'],
        'audit_log' => ['id', 'actor', 'action', 'target', 'ip_address', 'detail_json', 'created_at'],
        'activation_attempts' => ['id', 'license_key_hash', 'ip_address', 'outcome', 'machine_id', 'created_at'],
        'schema_migrations' => ['id', 'name', 'applied_at'],
    ];
}

function ifx_now(): string
{
    return gmdate('Y-m-d\TH:i:s') . '.000Z';
}

function ifx_uuid(): string
{
    $bytes = random_bytes(16);
    $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
    $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
}

// ---------------------------------------------------------------------------- audit and history

function ifx_audit(PDO $pdo, string $actor, string $action, ?string $target = null, array $detail = [], ?string $ip = null): void
{
    $pdo->prepare('INSERT INTO audit_log (actor, action, target, ip_address, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        ->execute([$actor, $action, $target, $ip, json_encode($detail, JSON_UNESCAPED_SLASHES) ?: '{}', ifx_now()]);
}

function ifx_history(PDO $pdo, string $licenseId, string $actor, string $action, array $detail = []): void
{
    $pdo->prepare('INSERT INTO license_history (license_id, actor, action, detail_json, created_at) VALUES (?, ?, ?, ?, ?)')
        ->execute([$licenseId, $actor, $action, json_encode($detail, JSON_UNESCAPED_SLASHES) ?: '{}', ifx_now()]);
}

// ---------------------------------------------------------------------------- queries

function ifx_find_user_by_email(PDO $pdo, string $email): ?array
{
    $statement = $pdo->prepare('SELECT * FROM vendor_users WHERE LOWER(email) = LOWER(?)');
    $statement->execute([trim($email)]);
    $row = $statement->fetch();
    return $row === false ? null : $row;
}

function ifx_count_users(PDO $pdo): int
{
    return (int) $pdo->query('SELECT COUNT(*) AS n FROM vendor_users')->fetch()['n'];
}

function ifx_list_licenses(PDO $pdo, string $search = '', string $filter = ''): array
{
    $term = '%' . str_replace(['%', '_'], '', trim($search)) . '%';
    $statement = $pdo->prepare(
        'SELECT l.*, c.business_name AS customer_name, c.email AS customer_email, c.contact_name AS customer_contact
         FROM licenses l JOIN customers c ON c.id = l.customer_id
         WHERE (? = \'%%\' OR c.business_name LIKE ? OR l.license_key LIKE ? OR c.contact_name LIKE ? OR c.email LIKE ?)
         ORDER BY l.ends_at ASC, c.business_name ASC'
    );
    $statement->execute([$term, $term, $term, $term, $term]);
    $rows = $statement->fetchAll();
    $now = time();
    $views = [];
    foreach ($rows as $row) {
        $views[] = ifx_license_view($pdo, $row, $now);
    }
    if ($filter === '') {
        return $views;
    }
    return array_values(array_filter($views, static fn (array $view) => ifx_matches_filter($view, $filter)));
}

function ifx_license_view(PDO $pdo, array $row, ?int $now = null): array
{
    $now ??= time();
    $end = strtotime((string) $row['ends_at']) ?: $now;
    $days = (int) ceil(($end - $now) / 86400);
    $status = (string) $row['status'];
    if ($status === 'suspended') {
        $effective = 'suspended';
    } elseif ($status === 'revoked') {
        $effective = 'revoked';
    } elseif ($end <= $now) {
        $effective = 'expired';
    } elseif ($days <= 30) {
        $effective = 'expiring';
    } else {
        $effective = 'active';
    }
    $lastCheckin = $row['last_checkin_at'] ?? null;
    $row['effective_status'] = $effective;
    $row['days_remaining'] = $days;
    $row['online_now'] = is_string($lastCheckin) && $lastCheckin !== '' && (time() - (strtotime($lastCheckin) ?: 0)) < 300;
    return $row;
}

function ifx_matches_filter(array $view, string $filter): bool
{
    return match ($filter) {
        'active' => $view['effective_status'] === 'active',
        'expiring' => $view['effective_status'] === 'expiring',
        'expired' => $view['effective_status'] === 'expired',
        'suspended' => $view['effective_status'] === 'suspended',
        'online' => (bool) $view['online_now'],
        'onsite' => ($view['source'] ?? '') === IFX_SOURCE_ONSITE,
        default => true,
    };
}

function ifx_get_license(PDO $pdo, string $id): ?array
{
    $statement = $pdo->prepare(
        'SELECT l.*, c.business_name AS customer_name, c.email AS customer_email, c.contact_name AS customer_contact
         FROM licenses l JOIN customers c ON c.id = l.customer_id WHERE l.id = ?'
    );
    $statement->execute([$id]);
    $row = $statement->fetch();
    return $row === false ? null : ifx_license_view($pdo, $row);
}

function ifx_get_customer(PDO $pdo, string $id): ?array
{
    $statement = $pdo->prepare('SELECT * FROM customers WHERE id = ?');
    $statement->execute([$id]);
    $row = $statement->fetch();
    return $row === false ? null : $row;
}

function ifx_list_customers(PDO $pdo, string $search = ''): array
{
    $term = '%' . str_replace(['%', '_'], '', trim($search)) . '%';
    $statement = $pdo->prepare(
        'SELECT c.*, (SELECT COUNT(*) FROM licenses l WHERE l.customer_id = c.id) AS license_count
         FROM customers c WHERE (? = \'%%\' OR c.business_name LIKE ? OR c.email LIKE ? OR c.phone LIKE ?)
         ORDER BY c.business_name ASC'
    );
    $statement->execute([$term, $term, $term, $term]);
    return $statement->fetchAll();
}

function ifx_expiring(PDO $pdo): array
{
    $statement = $pdo->prepare(
        "SELECT l.*, c.business_name AS customer_name FROM licenses l JOIN customers c ON c.id = l.customer_id
         WHERE l.status = 'active' AND l.ends_at > ? AND l.ends_at <= ? ORDER BY l.ends_at ASC"
    );
    $statement->execute([ifx_now(), gmdate('Y-m-d\TH:i:s', time() + 31 * 86400) . '.000Z']);
    return $statement->fetchAll();
}
