#!/usr/bin/env php
<?php

// Periodic jobs; run every 5 minutes, crontab example:
//   */5 * * * * php /path/to/api/bin/cron.php
// Hosts without a CLI cron call the web-cron endpoint instead (GET /api/v1/cron with CRON_KEY,
// see docs/HOSTING.md). Both run Infra\CronRunner: a non-blocking flock on var/cache/cron.lock
// makes overlapping runs exit immediately; pending migrations are applied first.
//
// Jobs: alerts (heartbeat stale, WhatsApp logged out/banned, publishing failing -> e-mail/ntfy,
// repeated until resolved, then a "resolved" notice), backup (nightly VACUUM INTO var/backups with
// retention), cleanup (change_log compaction, old login attempts/sessions, orphan previews, logs).
//
//   php bin/cron.php [--verbose] [--only=alerts,backup,cleanup] [--force-backup] [--json]

declare(strict_types=1);

use Omw\Api\App;
use Omw\Api\Cli\Console;
use Omw\Api\Infra\CronRunner;

require __DIR__ . '/bootstrap.php';

omw_cli_run(static function (): int {
    $cli = Console::fromGlobals();
    $cli->rejectUnknown(['verbose', 'help', 'only', 'force-backup', 'json']);
    if ($cli->has('help')) {
        Console::out('Usage: php bin/cron.php [--verbose] [--only=alerts,backup,cleanup] [--force-backup] [--json]');

        return 0;
    }
    $only = $cli->option('only');
    $jobs = $only === null ? null : array_values(array_filter(array_map('trim', explode(',', $only)), static fn (string $j): bool => $j !== ''));

    $container = App::buildContainer(Console::config(), 'cron');
    $runner = $container->get(CronRunner::class);
    if (!$runner instanceof CronRunner) {
        throw new LogicException('CronRunner missing from the container.');
    }
    $result = $runner->run(null, $jobs, $cli->has('force-backup'));

    if ($cli->has('json')) {
        Console::out((string) json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    } elseif ($cli->has('verbose')) {
        if ($result['skipped'] !== null) {
            Console::out('Another cron run is still in progress; skipping.');
        }
        foreach ($result['jobs'] as $name => $jobResult) {
            Console::out($name . ': ' . json_encode($jobResult, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
        }
    }

    return $result['ok'] ? 0 : 1;
});
