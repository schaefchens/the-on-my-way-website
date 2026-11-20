#!/usr/bin/env php
<?php

/**
 * Checks whether this host can run the API: PHP version and extensions, SQLite features,
 * writable var/, WAL support on this filesystem, upload limits, free disk, migrations, setup.
 *
 *   php bin/doctor.php           human-readable; exit code 1 if any check fails
 *   php bin/doctor.php --json    machine-readable
 */

declare(strict_types=1);

use Omw\Api\Cli\Console;
use Omw\Api\Infra\Doctor;
use Omw\Api\Infra\DoctorCheck;

require __DIR__ . '/bootstrap.php';

omw_cli_run(static function (): int {
    $cli = Console::fromGlobals();
    if ($cli->has('help')) {
        Console::out('Usage: php bin/doctor.php [--json]');

        return 0;
    }
    $cli->rejectUnknown(['json', 'help']);

    $config = Console::config();
    $checks = (new Doctor($config))->run();
    $failed = Doctor::hasFailures($checks);

    if ($cli->has('json')) {
        Console::out((string) json_encode([
            'ok' => !$failed,
            'checks' => array_map(static fn (DoctorCheck $c): array => $c->toArray(), $checks),
        ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));

        return $failed ? 1 : 0;
    }

    foreach ($checks as $check) {
        Console::out(sprintf('[%-4s] %-15s %s', strtoupper($check->status->value), $check->name, $check->message));
        if ($check->hint !== null) {
            Console::out(str_repeat(' ', 23) . '-> ' . $check->hint);
        }
    }
    Console::out($failed ? 'Doctor: FAILED' : 'Doctor: OK');

    return $failed ? 1 : 0;
});
