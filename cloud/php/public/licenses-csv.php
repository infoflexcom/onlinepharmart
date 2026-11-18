<?php
declare(strict_types=1);

require_once __DIR__ . '/../lib/bootstrap.php';

$vendor = ifx_require_vendor();
$search = is_string($_GET['q'] ?? null) ? (string) $_GET['q'] : '';
$filter = is_string($_GET['filter'] ?? null) ? (string) $_GET['filter'] : '';
ifx_audit(ifx_database(), (string) $vendor['user']['email'], 'licence.csv_exported', null, []);
header('Content-Type: text/csv; charset=utf-8');
header('Content-Disposition: attachment; filename="infoflex-licences-' . ifx_today() . '.csv"');
header('Cache-Control: no-store');
echo ifx_csv(ifx_list_licenses(ifx_database(), $search, $filter));
