<?php
declare(strict_types=1);

require_once __DIR__ . '/../lib/bootstrap.php';

$vendor = ifx_require_vendor();
if ($vendor['user']['role'] !== 'OWNER') {
    ifx_redirect('/team.php');
}
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST' || !ifx_post_csrf_ok()) {
    exit;
}
$pdo = ifx_database();
$actor = (string) $vendor['user']['email'];
$action = is_string($_GET['do'] ?? null) ? (string) $_GET['do'] : '';

try {
    if ($action === 'new') {
        $user = ifx_create_user($pdo, [
            'email' => $_POST['email'] ?? '', 'displayName' => $_POST['displayName'] ?? '',
            'password' => $_POST['password'] ?? '', 'role' => $_POST['role'] ?? 'STAFF',
        ], $actor);
        $_SESSION['pending_user'] = ['secret' => $user['totp_secret'], 'email' => $user['email'], 'id' => $user['id']];
    } elseif ($action === 'reset-totp') {
        ifx_reset_totp($pdo, (string) ($_POST['userId'] ?? ''), $actor);
        ifx_flash('Two-factor was reset. That account must set it up again before signing in.');
    } elseif ($action === 'toggle') {
        $userId = (string) ($_POST['userId'] ?? '');
        if ($userId === (string) $vendor['user']['id']) {
            throw new InvalidArgumentException('You cannot disable your own account.');
        }
        $statement = $pdo->prepare('SELECT is_active FROM vendor_users WHERE id = ?');
        $statement->execute([$userId]);
        $current = (int) $statement->fetch()['is_active'];
        $pdo->prepare('UPDATE vendor_users SET is_active = ? WHERE id = ?')->execute([$current === 1 ? 0 : 1, $userId]);
        ifx_audit($pdo, $actor, 'vendor_user.toggled', $userId, ['active' => $current !== 1]);
    }
} catch (Throwable $failure) {
    ifx_flash($failure->getMessage());
}
ifx_redirect('/team.php');
