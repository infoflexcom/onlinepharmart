<?php
declare(strict_types=1);

require_once __DIR__ . '/../lib/bootstrap.php';

$vendor = ifx_require_vendor();
$id = is_string($_GET['id'] ?? null) ? (string) $_GET['id'] : '';
$license = ifx_get_license(ifx_database(), $id);
if ($license === null) {
    http_response_code(404);
    ifx_page('Not found', '<div class="card"><p>That licence no longer exists.</p><p><a href="/licenses.php">Back to licences</a></p></div>', $vendor['user'], 'licenses');
    exit;
}
$activationCode = $_SESSION['activation_code'] ?? null;
unset($_SESSION['activation_code']);
$customer = ifx_get_customer(ifx_database(), (string) $license['customer_id']) ?? ['business_name' => '', 'id' => ''];
ifx_page((string) $license['customer_name'], ifx_licence_body(
    $license,
    $customer,
    ifx_service()->listHistory($id, 50),
    ifx_service()->listCheckins($id, 25),
    is_string($activationCode) ? $activationCode : null,
), $vendor['user'], 'licenses');
