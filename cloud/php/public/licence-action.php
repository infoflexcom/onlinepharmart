<?php
/**
 * Every state-changing licence action. CSRF-checked, audited, and redirected so a refresh cannot repeat it.
 */
declare(strict_types=1);

require_once __DIR__ . '/../lib/bootstrap.php';

$vendor = ifx_require_vendor();
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    ifx_redirect('/licenses.php');
}
if (!ifx_post_csrf_ok()) {
    exit;
}
$id = is_string($_GET['id'] ?? null) ? (string) $_GET['id'] : '';
$action = is_string($_GET['do'] ?? null) ? (string) $_GET['do'] : '';
$actor = (string) $vendor['user']['email'];
$service = ifx_service();
$pdo = ifx_database();

try {
    switch ($action) {
        case 'renew':
            $service->renew($id, (string) ($_POST['endsAt'] ?? ''), $actor, isset($_POST['notifyNow']));
            break;
        case 'entitlements':
            $service->setEntitlements($id, [
                'maxAdminPhones' => $_POST['maxAdminPhones'] ?? 1,
                'graceDays' => $_POST['graceDays'] ?? 0,
                'defaultCurrencyCode' => $_POST['defaultCurrencyCode'] ?? '',
                'lockCurrency' => isset($_POST['lockCurrency']),
                'mobileLan' => isset($_POST['mobileLan']),
                'mobileInternet' => isset($_POST['mobileInternet']),
                'edition' => $_POST['edition'] ?? IFX_EDITION_PHARMACY,
            ], $actor);
            break;
        case 'suspend':
            $service->setStatus($id, 'suspended', $actor);
            break;
        case 'unsuspend':
            $service->setStatus($id, 'active', $actor);
            break;
        case 'revoke':
            $service->setStatus($id, 'revoked', $actor);
            break;
        case 'rebind':
            $service->rebind($id, $actor);
            break;
        case 'activation-code':
            $code = strtoupper(bin2hex(random_bytes(4)));
            $code = substr($code, 0, 4) . '-' . substr($code, 4, 4);
            ifx_history($pdo, $id, $actor, 'license.activation_code', ['expiresInMinutes' => 15]);
            ifx_audit($pdo, $actor, 'license.activation_code', $id, []);
            $_SESSION['activation_code'] = $code;
            break;
        default:
            http_response_code(400);
            echo 'Unknown action.';
            exit;
    }
} catch (Throwable $failure) {
    ifx_page('Could not complete', '<div class="card"><div class="notice error">' . ifx_e($failure->getMessage())
        . '</div><p><a href="/licence.php?id=' . ifx_e(rawurlencode($id)) . '">Back to the licence</a></p></div>', $vendor['user'], 'licenses');
    exit;
}
ifx_redirect('/licence.php?id=' . rawurlencode($id));
