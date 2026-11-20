<?php

declare(strict_types=1);

namespace Omw\Api\Infra;

use DateTimeImmutable;
use FilesystemIterator;
use Omw\Api\Domain\Auth\ApiTokens;
use Omw\Api\Domain\Auth\LoginThrottle;
use Omw\Api\Domain\BackendStatus;
use Omw\Api\Domain\Captures;
use Omw\Api\Domain\ChangeLog;
use RecursiveDirectoryIterator;
use RecursiveIteratorIterator;
use SplFileInfo;

/**
 * Periodic cleanup (cron):
 * - change_log compaction: rows superseded by a newer row of the same entity+key for more than
 *   {@see COMPACT_AFTER_HOURS} hours are deleted; the latest row per key (tombstones included)
 *   always survives, so every cursor stays correct (contracts ChangesResponse);
 * - login_attempts and dead session tokens older than {@see KEEP_DAYS} days;
 * - previews/posters of revoked captures while ingest.on_revoke = hide (Captures::purgeRevokedPreviews);
 * - preview files no capture references any more (replaced or orphaned uploads), temp files;
 * - publish_status rows of targets the backend stopped reporting, 30 days after their last report
 *   (BackendStatus::pruneStaleTargets);
 * - log files older than {@see KEEP_DAYS} days (Monolog's rotation keeps 14 per channel anyway).
 */
final class Maintenance
{
    public const COMPACT_AFTER_HOURS = 24;
    public const KEEP_DAYS = 30;

    public function __construct(
        private readonly Db $db,
        private readonly Paths $paths,
        private readonly ChangeLog $changes,
        private readonly ApiTokens $tokens,
        private readonly LoginThrottle $throttle,
        private readonly Captures $captures,
        private readonly BackendStatus $status,
    ) {
    }

    /** @return array<string, int> */
    public function run(DateTimeImmutable $now): array
    {
        $keepFrom = Clock::iso($now->modify('-' . self::KEEP_DAYS . ' days'));

        return [
            'changeLogCompacted' => $this->changes->compact(Clock::iso($now->modify('-' . self::COMPACT_AFTER_HOURS . ' hours'))),
            'loginAttemptsPruned' => $this->throttle->prune($keepFrom),
            'sessionsPruned' => $this->tokens->pruneSessions($keepFrom),
            'revokedPreviewsRemoved' => $this->captures->purgeRevokedPreviews(),
            'previewFilesRemoved' => $this->orphanPreviews($now),
            'staleTargetsPruned' => $this->status->pruneStaleTargets($now),
            'logFilesRemoved' => $this->oldLogs($now),
        ];
    }

    private function orphanPreviews(DateTimeImmutable $now): int
    {
        $root = $this->paths->var('previews');
        if (!is_dir($root)) {
            return 0;
        }
        $referenced = [];
        foreach ($this->db->all('SELECT preview_path AS p FROM captures WHERE preview_path IS NOT NULL UNION SELECT poster_path FROM captures WHERE poster_path IS NOT NULL') as $row) {
            $referenced[(string) $row['p']] = true;
        }
        $cutoff = $now->getTimestamp() - 3600; // never race an upload that is being stored right now
        $removed = 0;
        $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
        /** @var SplFileInfo $file */
        foreach ($it as $file) {
            $rel = substr($file->getPathname(), strlen($root) + 1);
            if ($file->isDir()) {
                @rmdir($file->getPathname()); // only succeeds when empty

                continue;
            }
            if ($file->getFilename() === '.htaccess' || isset($referenced[$rel]) || $file->getMTime() >= $cutoff) {
                continue;
            }
            if (Fs::remove($file->getPathname())) {
                ++$removed;
            }
        }

        return $removed;
    }

    private function oldLogs(DateTimeImmutable $now): int
    {
        $cutoff = $now->getTimestamp() - self::KEEP_DAYS * 86400;
        $removed = 0;
        foreach (glob($this->paths->var('logs') . '/*.log') ?: [] as $file) {
            if ((int) @filemtime($file) < $cutoff && Fs::remove($file)) {
                ++$removed;
            }
        }

        return $removed;
    }
}
