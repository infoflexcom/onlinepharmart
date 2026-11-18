<?php
/**
 * Dashboard. New deployments with no vendor account are sent to the first-run page.
 */
declare(strict_types=1);

require_once __DIR__ . '/../lib/bootstrap.php';

if (ifx_count_users(ifx_database()) === 0) {
    ifx_redirect('/setup.php');
}
$vendor = ifx_require_vendor();
$licenses = ifx_list_licenses(ifx_database());
ifx_page('Dashboard', ifx_dashboard_body(
    $licenses,
    ifx_expiring(ifx_database()),
    (bool) ((ifx_config()['mail']['enabled'] ?? false) === true),
), $vendor['user'], 'dashboard');
