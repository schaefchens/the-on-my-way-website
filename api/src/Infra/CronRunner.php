<?php

declare(strict_types=1);

namespace Omw\Api\Infra;

use DateTimeImmutable;
use Omw\Api\Config;
use Omw\Api\Domain\Access\AccessJob;
use Omw\Api\Domain\Alerts\AlertEngine;
use Omw\Api\Domain\Settings;
use Psr\Log\LoggerInterface;
use RuntimeException;
use Throwable;

/**
 * The periodic jobs (every ~5 minutes), shared by bin/cron.php and the web-cron endpoint
 * GET|POST /api/v1/cron. A non-blocking flock on var/cache/cron.lock makes overlapping runs
 * return immediately ("skipped"). The last result is kept in var/cache/cron-last.json (doctor).
 *
 * Jobs: alerts (every run), access (store ops, reconcile, handoff/pending expiry, owner notices,
 * rate-limit salt, optional gate probe; Domain\Access\AccessJob), backup (once per local day after
 * BACKUP_HOUR + retention), cleanup (compaction, pruning, orphan previews, old logs).
 *
 * While the maintenance flag (Config::maintenanceFlag(), "/.maintenance") exists nothing runs
 * ("skipped": "maintenance"): a deploy may be replacing PHP files, or a restore may be swapping
 * the database file (opening it then could recreate a -wal of the OLD database next to the
 * restored one, or consume var/bootstrap.json before the new database is in place).
 */
final class CronRunner
{
    public const LOCK = 'cache/cron.lock';
    public const LAST = 'cache/cron-last.json';

    public function __construct(
        private readonly Config $config,
        private readonly Paths $paths,
        private readonly AutoMigrator $migrator,
        private readonly AlertEngine $alerts,
        private readonly Backups $backups,
        private readonly Maintenance $maintenance,
        private readonly Settings $settings,
        private readonly AccessJob $access,
        private readonly ?LoggerInterface $logger = null,
    ) {
    }

    /**
     * @param list<string>|null $only run only these jobs (alerts, access, backup, cleanup); null = all
     * @return array{ok: bool, at: string, skipped: string|null, jobs: array<string, mixed>, durationMs: int}
     */
    public function run(?DateTimeImmutable $now = null, ?array $only = null, bool $forceBackup = false): array
    {
        $now ??= Clock::now();
        $started = microtime(true);
        if ($this->config->inMaintenance()) {
            $this->logger?->info('cron skipped: maintenance flag present');

            return ['ok' => true, 'at' => Clock::iso($now), 'skipped' => 'maintenance', 'jobs' => [], 'durationMs' => 0];
        }
        $this->paths->ensureVar();
        $lock = @fopen($this->paths->var(self::LOCK), 'c');
        if ($lock === false) {
            throw new RuntimeException('Cannot open ' . $this->paths->var(self::LOCK));
        }
        try {
            if (!flock($lock, LOCK_EX | LOCK_NB)) {
                $this->logger?->info('cron skipped: a previous run still holds the lock');

                return ['ok' => true, 'at' => Clock::iso($now), 'skipped' => 'locked', 'jobs' => [], 'durationMs' => 0];
            }
            try {
                $this->migrator->ensure();
                $jobs = [];
                $ok = true;
                foreach ($this->jobs($now, $forceBackup) as $name => $job) {
                    if ($only !== null && !in_array($name, $only, true)) {
                        continue;
                    }
                    try {
                        $jobs[$name] = $job();
                    } catch (Throwable $e) {
                        $ok = false;
                        $jobs[$name] = ['error' => $e->getMessage()];
                        $this->logger?->error('cron job {job} failed: {error}', ['job' => $name, 'error' => $e->getMessage(), 'exception' => $e]);
                    }
                }
                $result = [
                    'ok' => $ok,
                    'at' => Clock::iso($now),
                    'skipped' => null,
                    'jobs' => $jobs,
                    'durationMs' => (int) round((microtime(true) - $started) * 1000),
                ];
                try {
                    Fs::writeAtomic($this->paths->var(self::LAST), (string) json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
                } catch (Throwable) {
                    // informational only
                }
                $this->logger?->debug('cron run', $result);

                return $result;
            } finally {
                flock($lock, LOCK_UN);
            }
        } finally {
            fclose($lock);
        }
    }

    /** @return array{at: string, ok: bool}|null result of the last finished run */
    public function last(): ?array
    {
        $data = @file_get_contents($this->paths->var(self::LAST));
        $last = is_string($data) ? json_decode($data, true) : null;

        return is_array($last) && is_string($last['at'] ?? null) ? ['at' => $last['at'], 'ok' => ($last['ok'] ?? false) === true] : null;
    }

    /** @return array<string, callable(): mixed> */
    private function jobs(DateTimeImmutable $now, bool $forceBackup): array
    {
        return [
            'alerts' => fn (): array => $this->alerts->run($now),
            'access' => fn (): array => $this->access->run($now),
            'backup' => function () use ($now, $forceBackup): array {
                $tz = (string) $this->settings->get('timezone.current');
                if (!$forceBackup && !$this->backups->due($now, $tz, $this->config->backupHour)) {
                    return ['created' => null, 'pruned' => $this->backups->prune($this->config->backupKeep, $now)];
                }
                $backup = $this->backups->create($now, $tz);

                return ['created' => $backup['name'], 'bytes' => $backup['bytes'], 'pruned' => $this->backups->prune($this->config->backupKeep, $now)];
            },
            'cleanup' => fn (): array => $this->maintenance->run($now),
        ];
    }
}
