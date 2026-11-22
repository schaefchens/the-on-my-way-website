#!/usr/bin/env php
<?php

/**
 * "Connect a phone" from the command line (local development and the emulator; the owner uses
 * the admin's Settings › Connect a phone). Prints the omw:// link on stdout and the typed code on
 * stderr; a new code cancels the open one.
 *
 *   php bin/app-pairing.php [--user=EMAIL] [--ttl-minutes=60]
 *   php bin/app-pairing.php --list             connected phones
 *   php bin/app-pairing.php --disconnect=ID    revoke a phone's capture token
 */

declare(strict_types=1);

use Omw\Api\Cli\Console;
use Omw\Api\Domain\App\AppPhones;
use Omw\Api\Domain\App\AppRules;
use Omw\Api\Domain\Auth\Users;

require __DIR__ . '/bootstrap.php';

omw_cli_run(static function (): int {
    $cli = Console::fromGlobals();
    if ($cli->has('help')) {
        Console::out('Usage: php bin/app-pairing.php [--user=EMAIL] [--ttl-minutes=5..1440] | --list | --disconnect=ID');

        return 0;
    }
    $cli->rejectUnknown(['user', 'ttl-minutes', 'list', 'disconnect', 'help']);

    $config = Console::config();
    $db = Console::db($config);
    Console::requireMigrated($config, $db);
    $container = Omw\Api\App::buildContainer($config, 'cli');
    $phones = $container->get(AppPhones::class);
    \assert($phones instanceof AppPhones);

    if ($cli->has('list')) {
        foreach ($phones->list() as $p) {
            Console::out(sprintf(
                '#%-4d %-24s %-8s app=%-20s entries=%d (inbox %d) last_used=%s%s',
                $p['id'], $p['name'], $p['platform'], $p['appVersion'], $p['entries']['total'], $p['entries']['inInbox'],
                $p['lastUsedAt'] ?? '-', $p['revokedAt'] !== null ? ' DISCONNECTED=' . $p['revokedAt'] : '',
            ));
        }

        return 0;
    }
    $disconnect = $cli->option('disconnect');
    if ($disconnect !== null) {
        if (!ctype_digit($disconnect) || !$phones->revoke((int) $disconnect)) {
            Console::err("No phone #$disconnect (see --list).");

            return 1;
        }
        Console::err("Phone #$disconnect disconnected.");

        return 0;
    }

    $users = new Users($db);
    $email = $cli->option('user');
    $userId = null;
    if ($email !== null) {
        $userId = $users->findByEmail($email)['id'] ?? null;
    } else {
        $id = $db->scalar('SELECT id FROM users ORDER BY id LIMIT 1');
        $userId = $id === null ? null : (int) $id;
    }
    if ($userId === null) {
        Console::err('No owner account (php bin/create-admin.php first, or --user=EMAIL).');

        return 1;
    }
    $ttl = $cli->option('ttl-minutes', (string) AppRules::PAIRING_TTL_DEFAULT) ?? (string) AppRules::PAIRING_TTL_DEFAULT;
    if (!ctype_digit($ttl) || (int) $ttl < AppRules::PAIRING_TTL_MIN || (int) $ttl > AppRules::PAIRING_TTL_MAX) {
        Console::err(sprintf('--ttl-minutes must be %d..%d.', AppRules::PAIRING_TTL_MIN, AppRules::PAIRING_TTL_MAX));

        return 2;
    }
    $created = $phones->createPairing($userId, (int) $ttl);
    Console::err(sprintf('Pairing code %s (valid until %s, single use). Link:', $created['typedCode'], $created['expiresAt']));
    Console::out($created['link']);

    return 0;
});
