<?php
/**
 * The public licence API for the PHP build — the same four calls, answers and error codes the desktop already
 * uses against the Node cloud and the mock server.
 *
 *   GET  /api.php?action=config      → {mode, keyId, publicKey}
 *   POST /api.php?action=activate    → {token, serverNow, licenseId}
 *   POST /api.php?action=check-in    → {updated, reported, token, serverNow}
 *   GET  /api.php?action=public-key  → {mode, keyId, publicKey}
 *
 * A body carrying shop business data is refused with 400 `business_data_not_permitted`, exactly as the Node
 * build does, so a client cannot start shipping sales to a licence server by accident.
 */

declare(strict_types=1);

require_once __DIR__ . '/service.php';

const IFX_BUSINESS_DATA_KEYS = [
    'sales', 'sale', 'stock', 'inventory', 'products', 'customers', 'users', 'payments', 'transactions',
    'revenue', 'prices', 'amounts', 'currencyAmounts', 'receipts', 'returns', 'employees', 'cashiers',
];

function ifx_api_respond(int $status, array $payload): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($payload, JSON_UNESCAPED_SLASHES);
    exit;
}

function ifx_api_business_data_guard(array $body): void
{
    $lower = array_map('strtolower', array_keys($body));
    foreach (IFX_BUSINESS_DATA_KEYS as $key) {
        if (in_array(strtolower($key), $lower, true)) {
            ifx_api_respond(400, [
                'error' => 'business_data_not_permitted',
                'message' => 'This service stores licence data only and does not accept shop business data.',
            ]);
        }
    }
}

function ifx_api_error(Throwable $error): never
{
    if ($error instanceof IfxLicenceError) {
        $status = match ($error->reason) {
            'rate_limited' => 429,
            'conflict' => 409,
            'not_found' => 404,
            'invalid', 'invalid_key' => 400,
            default => 403,
        };
        ifx_api_respond($status, ['error' => $error->reason, 'message' => $error->getMessage()]);
    }
    if ($error instanceof InvalidArgumentException) {
        ifx_api_respond(400, ['error' => 'invalid', 'message' => $error->getMessage()]);
    }
    error_log('infoflex-cloud: ' . $error->getMessage());
    ifx_api_respond(500, ['error' => 'server_error', 'message' => 'The licence service could not complete that request.']);
}

function ifx_api_request_body(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || trim($raw) === '') {
        return [];
    }
    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) {
        ifx_api_respond(400, ['error' => 'invalid', 'message' => 'The request body is not valid JSON.']);
    }
    return $decoded;
}

function ifx_api_client_ip(array $config): ?string
{
    // Only trust the forwarded header when the deployment says a proxy overwrites it; otherwise the socket wins.
    if (($config['trust_proxy'] ?? false) === true && !empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
        $parts = explode(',', (string) $_SERVER['HTTP_X_FORWARDED_FOR']);
        return trim($parts[0]);
    }
    return $_SERVER['REMOTE_ADDR'] ?? null;
}

function ifx_api_handle(IfxService $service, array $config, string $publicKeyPem, string $keyId): never
{
    $action = (string) ($_GET['action'] ?? '');
    $method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));

    if ($action === 'config' || $action === 'public-key') {
        header('Cache-Control: public, max-age=300');
        ifx_api_respond(200, ['mode' => 'infoflex-cloud', 'keyId' => $keyId, 'publicKey' => $publicKeyPem]);
    }

    if ($method !== 'POST') {
        ifx_api_respond(405, ['error' => 'method_not_allowed', 'message' => 'Use POST for this call.']);
    }
    $body = ifx_api_request_body();
    ifx_api_business_data_guard($body);

    try {
        if ($action === 'activate') {
            $result = $service->activate([
                'activationKey' => (string) ($body['activationKey'] ?? ''),
                'machineId' => (string) ($body['machineId'] ?? ''),
                'appVersion' => (string) ($body['appVersion'] ?? ''),
                'platform' => (string) ($body['platform'] ?? ''),
                'ipAddress' => ifx_api_client_ip($config),
            ]);
            ifx_api_respond(200, $result);
        }
        if ($action === 'check-in') {
            $onsite = is_array($body['onsiteLicense'] ?? null) ? $body['onsiteLicense'] : null;
            $result = $service->checkIn([
                'licenseId' => (string) ($body['licenseId'] ?? ''),
                'machineId' => (string) ($body['machineId'] ?? ''),
                'appVersion' => (string) ($body['appVersion'] ?? ''),
                'platform' => (string) ($body['platform'] ?? ''),
                'checkedAt' => (string) ($body['checkedAt'] ?? ''),
                'source' => in_array($body['source'] ?? '', ['online', 'file', 'onsite'], true) ? (string) $body['source'] : 'online',
                'ipAddress' => ifx_api_client_ip($config),
                'onsiteLicense' => $onsite,
            ]);
            ifx_api_respond(200, $result);
        }
    } catch (Throwable $error) {
        ifx_api_error($error);
    }
    ifx_api_respond(404, ['error' => 'not_found', 'message' => 'That licence call does not exist.']);
}
