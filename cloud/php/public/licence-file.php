<?php
declare(strict_types=1);

require_once __DIR__ . '/../lib/bootstrap.php';

$vendor = ifx_require_vendor();
$id = is_string($_GET['id'] ?? null) ? (string) $_GET['id'] : '';
$machine = is_string($_GET['machine'] ?? null) ? trim((string) $_GET['machine']) : '';
try {
    $file = ifx_service()->offlineFile($id, $machine, (string) $vendor['user']['email']);
} catch (Throwable $failure) {
    ifx_page('Could not download', '<div class="card"><div class="notice error">' . ifx_e($failure->getMessage())
        . '</div><p><a href="/licence.php?id=' . ifx_e(rawurlencode($id)) . '">Back to the licence</a></p></div>', $vendor['user'], 'licenses');
    exit;
}
header('Content-Type: application/octet-stream');
header('Content-Disposition: attachment; filename="' . $file['fileName'] . '"');
header('Cache-Control: no-store');
echo $file['token'];
