<?php
/**
 * The four public licence calls. Everything else about this build is the portal.
 */
declare(strict_types=1);

require_once __DIR__ . '/../lib/bootstrap.php';
require_once __DIR__ . '/../lib/api.php';

$config = ifx_config();
ifx_api_handle(ifx_service(), $config, ifx_public_key_pem(ifx_key_pem($config)), (string) ($config['signing_key_id'] ?? 'infoflex-cloud-1'));
