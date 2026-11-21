<?php
declare(strict_types=1);

require_once __DIR__ . '/../lib/bootstrap.php';

$vendor = ifx_require_vendor();
ifx_page('Audit log', ifx_audit_body(ifx_service()->listAudit(300)), $vendor['user'], 'audit');
