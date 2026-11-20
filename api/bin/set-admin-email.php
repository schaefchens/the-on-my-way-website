#!/usr/bin/env php
<?php

/**
 * Changes the admin's login e-mail. Sessions and app tokens stay valid (they belong to the
 * user, not to the e-mail); the password is unchanged.
 *
 *   php bin/set-admin-email.php --to=new@example.org                 the only user
 *   php bin/set-admin-email.php --from=old@example.org --to=new@example.org
 *
 * The new e-mail must be a valid address that no other user has. Hosts without a shell: use
 * `scripts/deploy-api.ts --set-admin-email=new@example.org`, which uploads the same change as
 * var/bootstrap.json (applied by the app on the next request, see Infra\Bootstrapper).
 */

declare(strict_types=1);

use Omw\Api\Cli\Console;
use Omw\Api\Domain\Auth\Users;

require __DIR__ . '/bootstrap.php';

omw_cli_run(static function (): int {
    $cli = Console::fromGlobals();
    if ($cli->has('help')) {
        Console::out('Usage: php bin/set-admin-email.php --to=NEW_EMAIL [--from=CURRENT_EMAIL]');

        return 0;
    }
    $cli->rejectUnknown(['from', 'to', 'help']);
    if ($cli->positional() !== []) {
        Console::err('Unexpected argument(s): ' . implode(' ', $cli->positional()) . ' (use --to=… and --from=…).');

        return 2;
    }
    $to = $cli->option('to');
    if ($to === null || trim($to) === '') {
        Console::err('Missing --to=NEW_EMAIL.');

        return 2;
    }

    $config = Console::config();
    $db = Console::db($config);
    Console::requireMigrated($config, $db);
    $users = new Users($db);

    $from = $cli->option('from');
    if ($from === null) {
        $emails = array_map(static fn (array $row): string => (string) $row['email'], $db->all('SELECT email FROM users ORDER BY id LIMIT 2'));
        if (count($emails) !== 1) {
            Console::err($emails === [] ? 'There is no user yet (bin/create-admin.php creates one).' : 'There is more than one user: name the current e-mail with --from=….');

            return 1;
        }
        $from = $emails[0];
    }

    try {
        $result = $users->changeEmail($from, $to);
    } catch (InvalidArgumentException $e) {
        Console::err($e->getMessage());

        return 1;
    }
    $new = Users::normalizeEmail($to);
    Console::out($result['changed']
        ? sprintf('User #%d now logs in as %s (was %s); sessions and app tokens stay valid.', $result['id'], $new, Users::normalizeEmail($from))
        : sprintf('User #%d already logs in as %s; nothing changed.', $result['id'], $new));

    return 0;
});
