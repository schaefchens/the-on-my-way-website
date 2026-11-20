#!/usr/bin/env php
<?php

/**
 * Creates the owner account (or resets its password).
 *
 *   php bin/create-admin.php --email=you@example.com [--name="Your Name"]
 *   php bin/create-admin.php --email=you@example.com --reset          new password, revokes sessions
 *   printf '%s' "$PW" | php bin/create-admin.php --email=... --password-stdin
 *
 * Without --password-stdin the password is prompted for (twice, hidden).
 * --password=... also works but ends up in the shell history; avoid it.
 */

declare(strict_types=1);

use Omw\Api\Cli\Console;
use Omw\Api\Domain\Auth\Passwords;
use Omw\Api\Domain\Auth\Users;

require __DIR__ . '/bootstrap.php';

omw_cli_run(static function (): int {
    $cli = Console::fromGlobals();
    if ($cli->has('help')) {
        Console::out('Usage: php bin/create-admin.php --email=EMAIL [--name=NAME] [--reset] [--password-stdin | --password=PW]');

        return 0;
    }
    $cli->rejectUnknown(['email', 'name', 'reset', 'password-stdin', 'password', 'help']);

    $config = Console::config();
    $db = Console::db($config);
    Console::requireMigrated($config, $db);
    $users = new Users($db);

    $email = $cli->option('email') ?? ($cli->positional()[0] ?? null);
    if ($email === null && Console::interactive()) {
        $email = Console::prompt('E-mail: ');
    }
    if ($email === null || $email === '') {
        Console::err('Missing --email=...');

        return 2;
    }
    $email = Users::normalizeEmail($email);
    $existing = $users->findByEmail($email);
    if ($existing !== null && !$cli->has('reset')) {
        Console::err("User $email already exists. Use --reset to set a new password.");

        return 1;
    }
    if ($existing === null && $cli->has('reset')) {
        Console::err("No user $email to reset.");

        return 1;
    }

    if ($cli->has('password-stdin')) {
        $password = Console::readStdin();
    } elseif ($cli->option('password') !== null) {
        Console::err('Warning: --password=... is visible in the process list and shell history.');
        $password = (string) $cli->option('password');
    } else {
        if (!Console::interactive()) {
            Console::err('No terminal to prompt for a password: use --password-stdin.');

            return 2;
        }
        $password = Console::promptHidden('Password: ');
        if ($password !== Console::promptHidden('Repeat password: ')) {
            Console::err('Passwords do not match.');

            return 1;
        }
    }
    $weakness = Passwords::weakness($password);
    if ($weakness !== null) {
        Console::err($weakness);

        return 1;
    }

    $hash = Passwords::hash($password);
    if ($existing !== null) {
        $users->setPassword($existing['id'], $hash);
        Console::out(sprintf('Password of %s updated (%s); existing sessions revoked.', $email, Passwords::algorithmName()));
    } else {
        $id = $users->create($email, $hash, $cli->option('name'));
        Console::out(sprintf('Admin user #%d %s created (%s).', $id, $email, Passwords::algorithmName()));
    }

    return 0;
});
