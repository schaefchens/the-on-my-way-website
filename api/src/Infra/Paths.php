<?php

declare(strict_types=1);

namespace Omw\Api\Infra;

use Omw\Api\Config;
use RuntimeException;

/**
 * Layout of the writable var/ directory:
 *
 *   var/app.sqlite   database (default DB_PATH)
 *   var/logs/        Monolog files
 *   var/previews/    private admin previews pushed by the backend
 *   var/backups/     nightly VACUUM INTO snapshots
 *   var/cache/       phpunit/phpstan caches, cron lock
 *   var/.htaccess    "Require all denied" (in case var/ ends up inside a web root)
 */
final class Paths
{
    public const SUBDIRS = ['logs', 'previews', 'backups', 'cache'];

    public const VAR_HTACCESS = <<<'HTACCESS'
        # Never serve anything from var/ (database, previews, backups, logs).
        Require all denied

        HTACCESS;

    public function __construct(private readonly Config $config)
    {
    }

    public function var(string $sub = ''): string
    {
        return $sub === '' ? $this->config->varDir : $this->config->varDir . '/' . ltrim($sub, '/');
    }

    /**
     * Creates var/ and its sub-directories and (re)writes var/.htaccess if missing.
     */
    public function ensureVar(): void
    {
        foreach (array_merge([''], self::SUBDIRS) as $sub) {
            self::ensureDir($this->var($sub));
        }

        $htaccess = $this->var('.htaccess');
        if (!is_file($htaccess) && @file_put_contents($htaccess, self::VAR_HTACCESS) === false) {
            throw new RuntimeException('Cannot write ' . $htaccess);
        }
    }

    public static function ensureDir(string $dir): void
    {
        if (is_dir($dir)) {
            return;
        }
        if (!@mkdir($dir, 0775, true) && !is_dir($dir)) {
            throw new RuntimeException('Cannot create directory ' . $dir);
        }
    }
}
