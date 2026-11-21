<?php
declare(strict_types=1);

require_once __DIR__ . '/../lib/bootstrap.php';

$vendor = ifx_require_vendor();
$search = is_string($_GET['q'] ?? null) ? (string) $_GET['q'] : '';
$filter = is_string($_GET['filter'] ?? null) ? (string) $_GET['filter'] : '';
ifx_page('Licences', ifx_licenses_body(ifx_list_licenses(ifx_database(), $search, $filter), $search, $filter), $vendor['user'], 'licenses');
