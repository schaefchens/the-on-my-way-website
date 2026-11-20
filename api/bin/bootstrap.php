<?php

/**
 * Shared bootstrap of the bin/*.php CLI scripts.
 */

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit(1);
}

$autoload = dirname(__DIR__) . '/vendor/autoload.php';
if (!is_file($autoload)) {
    fwrite(STDERR, "Dependencies missing: run composer install in api/ first.\n");
    exit(1);
}
require $autoload;

set_error_handler(static function (int $severity, string $message, string $file, int $line): bool {
    if ((error_reporting() & $severity) === 0 || $severity === E_DEPRECATED || $severity === E_USER_DEPRECATED) {
        return false;
    }
    throw new ErrorException($message, 0, $severity, $file, $line);
});

/**
 * Runs $main and turns exceptions into a one-line error + exit code 1.
 *
 * @param callable(): int $main
 */
function omw_cli_run(callable $main): never
{
    try {
        exit($main());
    } catch (Throwable $e) {
        fwrite(STDERR, 'Error: ' . $e->getMessage() . PHP_EOL);
        if (getenv('OMW_CLI_TRACE') === '1') {
            fwrite(STDERR, $e->getTraceAsString() . PHP_EOL);
        }
        exit(1);
    }
}
