<?php
/**
 * The PHP build's configuration. Copy this file to `config.php` on the server and fill it in.
 *
 * `config.php` is the only file that holds a secret, it is never committed, and the deploy guide tells the
 * vendor to keep it outside the web root if their host allows it. The signing key is a *path*, not the key
 * itself, so the private key never appears in a PHP file, in the source tree, or in an editor buffer.
 */

return [
    // ---- database ---------------------------------------------------------------------------------------
    // MySQL (or MariaDB) is what the deploy guide assumes. `sqlite:` DSNs are accepted so the automated tests
    // can run the same code without a database server; production should use mysql.
    'dsn' => 'mysql:host=localhost;dbname=infoflex_licences;charset=utf8mb4',
    'db_user' => 'infoflex',
    'db_password' => '',

    // ---- signing ----------------------------------------------------------------------------------------
    // Absolute path to the Ed25519 private key in PEM form, readable only by the web-server user.
    // Generate it once with:  openssl genpkey -algorithm ed25519 -out /path/outside/webroot/licence-key.pem
    'signing_key_path' => '',
    'signing_key_id' => 'infoflex-cloud-1',

    // ---- site -------------------------------------------------------------------------------------------
    // No trailing slash. Used for the offline-licence download link and in reminder e-mails.
    'public_url' => 'https://licences.example.com',
    'timezone' => 'UTC',
    'session_minutes' => 30,

    // Only this address may create the first Owner; set it before the first visit, then it is ignored.
    'bootstrap_owner_email' => '',

    // ---- cookies ----------------------------------------------------------------------------------------
    // Set true on a real domain over HTTPS. False lets the tests and a local XAMPP run work over http.
    'secure_cookies' => true,

    // ---- optional mail ----------------------------------------------------------------------------------
    // Leave 'enabled' false and the expiry reminders are shown in the portal only.
    'mail' => [
        'enabled' => false,
        'from' => 'licences@example.com',
        'vendor_recipient' => '',
        // PHP's mail() is used by default. On a host with no mail daemon, use an SMTP relay instead.
        'transport' => 'mail',
        'smtp_host' => '',
        'smtp_port' => 587,
        'smtp_user' => '',
        'smtp_password' => '',
    ],
];
