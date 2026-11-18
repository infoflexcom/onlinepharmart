<?php
declare(strict_types=1);

require_once __DIR__ . '/../lib/bootstrap.php';

$vendor = ifx_require_vendor();
$licenses = array_values(array_filter(ifx_list_licenses(ifx_database()), static fn (array $l) => ($l['source'] ?? '') === IFX_SOURCE_ONSITE));
ifx_page('On-site licences', '<h1>On-site licences</h1><p class="small muted">These were issued on the shop’s own computer with the vendor master password. Once the till goes online and reports the licence, it appears here and can be suspended or replaced.</p>' . ifx_license_rows($licenses), $vendor['user'], 'onsite');
