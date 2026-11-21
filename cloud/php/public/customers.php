<?php
declare(strict_types=1);

require_once __DIR__ . '/../lib/bootstrap.php';

$vendor = ifx_require_vendor();
$search = is_string($_GET['q'] ?? null) ? (string) $_GET['q'] : '';
ifx_page('Customers', ifx_customers_body(ifx_list_customers(ifx_database(), $search), $search), $vendor['user'], 'customers');
