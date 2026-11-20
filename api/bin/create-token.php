#!/usr/bin/env php
<?php

/**
 * Creates, lists and revokes API tokens. A new token is printed ONCE on stdout (everything else
 * goes to stderr), so it can be captured: TOKEN=$(php bin/create-token.php --kind=backend --name=home)
 *
 *   php bin/create-token.php --kind=backend --name=home-mac [--expires-days=N]
 *   php bin/create-token.php --kind=app --user=you@example.com --name=iphone
 *   php bin/create-token.php --list [--all]
 *   php bin/create-token.php --revoke=ID
 *
 * Kinds: backend (scope "backend", for the Node backend), app (scope "admin", bound to a user).
 * Scopes are fixed per kind (--scopes is only accepted when it names exactly those).
 * Session tokens are only created by the admin login and never listed here.
 */

declare(strict_types=1);

use Omw\Api\Cli\Console;
use Omw\Api\Domain\Auth\ApiTokens;
use Omw\Api\Domain\Auth\Users;
use Omw\Api\Infra\Clock;

require __DIR__ . '/bootstrap.php';

omw_cli_run(static function (): int {
    $cli = Console::fromGlobals();
    if ($cli->has('help')) {
        Console::out('Usage: php bin/create-token.php --kind=backend|app --name=NAME [--user=EMAIL] [--scopes=a,b] [--expires-days=N]');
        Console::out('       php bin/create-token.php --list [--all] | --revoke=ID');

        return 0;
    }
    $cli->rejectUnknown(['kind', 'name', 'user', 'scopes', 'expires-days', 'list', 'all', 'revoke', 'help']);

    $config = Console::config();
    $db = Console::db($config);
    Console::requireMigrated($config, $db);
    $tokens = new ApiTokens($db);

    if ($cli->has('list')) {
        foreach ($tokens->list($cli->has('all')) as $t) {
            Console::out(sprintf(
                '#%-4d %-8s %-20s %-14s scopes=%-14s created=%s last_used=%s%s%s',
                $t['id'], $t['kind'], $t['name'], $t['hint'], implode(',', $t['scopes']),
                $t['createdAt'], $t['lastUsedAt'] ?? '-',
                $t['expiresAt'] !== null ? ' expires=' . $t['expiresAt'] : '',
                $t['revokedAt'] !== null ? ' REVOKED=' . $t['revokedAt'] : '',
            ));
        }

        return 0;
    }

    $revoke = $cli->option('revoke');
    if ($revoke !== null) {
        if (!ctype_digit($revoke)) {
            Console::err('--revoke needs a numeric token id (see --list).');

            return 2;
        }
        if (!$tokens->revoke((int) $revoke)) {
            Console::err("No active token #$revoke.");

            return 1;
        }
        Console::err("Token #$revoke revoked.");

        return 0;
    }

    $kind = $cli->option('kind', 'backend') ?? 'backend';
    if (!in_array($kind, ['backend', 'app'], true)) {
        Console::err('--kind must be backend or app (session tokens come from the admin login).');

        return 2;
    }
    $name = trim($cli->option('name', '') ?? '');
    if ($name === '') {
        Console::err('Missing --name=... (e.g. the machine or app the token is for).');

        return 2;
    }

    $userId = null;
    $email = $cli->option('user');
    if ($email !== null) {
        $user = (new Users($db))->findByEmail($email);
        if ($user === null) {
            Console::err("No user $email.");

            return 1;
        }
        $userId = $user['id'];
    } elseif ($kind === 'app') {
        Console::err('App tokens need --user=EMAIL.');

        return 2;
    }

    $scopesOpt = $cli->option('scopes');
    $scopes = $scopesOpt === null ? null : array_values(array_filter(array_map('trim', explode(',', $scopesOpt)), static fn (string $s): bool => $s !== ''));

    $expiresAt = null;
    $days = $cli->option('expires-days');
    if ($days !== null) {
        if (!ctype_digit($days) || (int) $days < 1) {
            Console::err('--expires-days must be a positive integer.');

            return 2;
        }
        $expiresAt = Clock::iso(Clock::now()->modify('+' . (int) $days . ' days'));
    }

    $created = $tokens->create($kind, $name, $scopes, $userId, $expiresAt);
    Console::err(sprintf('Created %s token #%d "%s"%s. Store it now; it cannot be shown again:', $kind, $created['id'], $name, $expiresAt !== null ? " (expires $expiresAt)" : ''));
    Console::out($created['token']);

    return 0;
});
