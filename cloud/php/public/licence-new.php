<?php
declare(strict_types=1);

require_once __DIR__ . '/../lib/bootstrap.php';

$vendor = ifx_require_vendor();
$pdo = ifx_database();
$error = null;

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    if (!ifx_post_csrf_ok()) {
        exit;
    }
    try {
        $result = ifx_service()->createLicense([
            'businessName' => $_POST['businessName'] ?? '',
            'contactName' => $_POST['contactName'] ?? '',
            'phone' => $_POST['phone'] ?? '',
            'email' => $_POST['email'] ?? '',
            'edition' => $_POST['edition'] ?? IFX_EDITION_PHARMACY,
            'startsAt' => $_POST['startsAt'] ?? '',
            'endsAt' => $_POST['endsAt'] ?? '',
            'maxAdminPhones' => $_POST['maxAdminPhones'] ?? 1,
            'graceDays' => $_POST['graceDays'] ?? 0,
            'mobileLan' => isset($_POST['mobileLan']),
            'mobileInternet' => isset($_POST['mobileInternet']),
            'defaultCurrencyCode' => $_POST['defaultCurrencyCode'] ?? '',
            'lockCurrency' => isset($_POST['lockCurrency']),
        ], (string) $vendor['user']['email']);
        ifx_redirect('/licence.php?id=' . rawurlencode((string) $result['license']['id']));
    } catch (Throwable $failure) {
        $error = $failure->getMessage();
    }
}

ifx_page('New licence', ifx_new_licence_body(ifx_list_customers($pdo), $error, [
    'businessName' => (string) ($_POST['businessName'] ?? ''),
    'edition' => (string) ($_POST['edition'] ?? IFX_EDITION_PHARMACY),
    'defaultCurrencyCode' => (string) ($_POST['defaultCurrencyCode'] ?? 'NGN'),
]), $vendor['user'], 'licenses');
