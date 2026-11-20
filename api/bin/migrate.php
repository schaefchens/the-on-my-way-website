#!/usr/bin/env php
<?php

/**
 * Applies pending database migrations (creates var/ and the database on first run).
 *
 *   php bin/migrate.php            apply pending migrations
 *   php bin/migrate.php --status   list migrations and whether they are applied
 */

declare(strict_types=1);

use Omw\Api\Cli\Console;
use Omw\Api\Infra\Migrator;
use Omw\Api\Infra\Paths;

require __DIR__ . '/bootstrap.php';

omw_cli_run(static function (): int {
    $cli = Console::fromGlobals();
    if ($cli->has('help')) {
        Console::out('Usage: php bin/migrate.php [--status]');

        return 0;
    }
    $cli->rejectUnknown(['status', 'help']);

    $config = Console::config();
    (new Paths($config))->ensureVar();
    $db = Console::db($config);
    $migrator = new Migrator($db, $config->migrationsDir());

    Console::out(sprintf('Database: %s (journal_mode=%s)', $config->dbPath, $db->effectiveJournalMode()));

    if ($cli->has('status')) {
        $applied = $migrator->applied();
        $modified = $migrator->modified();
        foreach (array_keys($migrator->available()) as $version) {
            $state = isset($applied[$version]) ? 'applied ' . $applied[$version]['applied_at'] : 'PENDING';
            if (in_array($version, $modified, true)) {
                $state .= ' (file changed since!)';
            }
            Console::out(sprintf('  %-40s %s', $version, $state));
        }

        return 0;
    }

    $done = $migrator->migrate(static function (string $version): void {
        Console::out('  applied ' . $version);
    });
    Console::out($done === [] ? 'Nothing to migrate.' : sprintf('Applied %d migration(s).', count($done)));

    foreach ($migrator->modified() as $version) {
        Console::err("Warning: applied migration $version was changed on disk.");
    }

    return 0;
});
