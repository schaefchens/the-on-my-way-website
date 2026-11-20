<?php

declare(strict_types=1);

namespace Omw\Api\Infra;

use Omw\Api\Config;
use Omw\Api\Http\ApiException;
use Psr\Log\LoggerInterface;
use RuntimeException;
use Throwable;

/**
 * Automatic setup on the first request after a deploy (no SSH on the host):
 *
 * Fast path (every request): compare var/cache/schema.stamp with a fingerprint of the deployed
 * migration files and the database file (path + inode), and check that var/bootstrap.json is
 * absent. That is a directory listing of migrations/, two stat() calls and one small read.
 *
 * Slow path: under an exclusive flock on var/cache/setup.lock (so migrations never run
 * concurrently; other requests wait up to $lockTimeout seconds, then get 503 + Retry-After), the
 * fingerprint is re-checked, pending migrations are applied, the stamp is rewritten atomically,
 * and var/bootstrap.json is consumed ({@see Bootstrapper}).
 *
 * A restored database file has a new inode, so the stamp no longer matches and its migration
 * state is checked again.
 */
final class AutoMigrator
{
    public const STAMP = 'cache/schema.stamp';
    public const LOCK = 'cache/setup.lock';

    public function __construct(
        private readonly Config $config,
        private readonly Paths $paths,
        private readonly Migrator $migrator,
        private readonly Bootstrapper $bootstrapper,
        private readonly ?LoggerInterface $logger = null,
        private readonly float $lockTimeout = 20.0,
    ) {
    }

    /** @return bool true when this call did any work (migrated, wrote the stamp or bootstrapped) */
    public function ensure(): bool
    {
        if ($this->upToDate()) {
            return false;
        }

        $this->paths->ensureVar();
        $lock = @fopen($this->paths->var(self::LOCK), 'c');
        if ($lock === false) {
            throw new RuntimeException('Cannot open ' . $this->paths->var(self::LOCK));
        }
        try {
            if (!self::acquire($lock, $this->lockTimeout)) {
                throw (new ApiException(503, 'maintenance', 'Setup in progress, try again in a few seconds.'))
                    ->withHeaders(['Retry-After' => '5']);
            }
            try {
                return $this->runLocked();
            } finally {
                flock($lock, LOCK_UN);
            }
        } finally {
            fclose($lock);
        }
    }

    /** True when the stamp matches and there is nothing to bootstrap (no locking, no DB access). */
    public function upToDate(): bool
    {
        if (is_file($this->paths->var(Bootstrapper::FILE))) {
            return false;
        }
        $stamp = @file_get_contents($this->paths->var(self::STAMP));

        return is_string($stamp) && $stamp !== '' && $stamp === $this->fingerprint();
    }

    /**
     * Fingerprint of the deployed migrations and the database file. Changes when a deploy adds a
     * migration and when the database file is replaced (restore) or created.
     */
    public function fingerprint(): string
    {
        $files = glob($this->migrator->directory() . '/*.sql') ?: [];
        $names = array_map('basename', $files);
        sort($names, SORT_STRING);
        clearstatcache(true, $this->config->dbPath);
        $inode = is_file($this->config->dbPath) ? (string) @fileinode($this->config->dbPath) : 'none';

        return sha1(implode("\n", $names) . '|' . $this->config->dbPath . '|' . $inode);
    }

    private function runLocked(): bool
    {
        $did = false;
        $stampFile = $this->paths->var(self::STAMP);
        $stamp = @file_get_contents($stampFile);
        if (!is_string($stamp) || $stamp !== $this->fingerprint()) {
            $started = microtime(true);
            $applied = $this->migrator->migrate();
            if ($applied !== []) {
                $this->logger?->notice('Applied database migrations', [
                    'versions' => $applied,
                    'ms' => (int) round((microtime(true) - $started) * 1000),
                ]);
            }
            Fs::writeAtomic($stampFile, $this->fingerprint());
            $did = true;
        }
        if (is_file($this->paths->var(Bootstrapper::FILE))) {
            try {
                $this->bootstrapper->consume();
            } catch (Throwable $e) {
                // Never block the app because of a broken bootstrap file; it was set aside.
                $this->logger?->error('Bootstrap failed: {error}', ['error' => $e->getMessage()]);
            }
            $did = true;
        }

        return $did;
    }

    /** @param resource $lock */
    private static function acquire($lock, float $timeout): bool
    {
        $deadline = microtime(true) + $timeout;
        do {
            if (flock($lock, LOCK_EX | LOCK_NB)) {
                return true;
            }
            usleep(50_000);
        } while (microtime(true) < $deadline);

        return false;
    }
}
