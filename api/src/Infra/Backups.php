<?php

declare(strict_types=1);

namespace Omw\Api\Infra;

use DateTimeImmutable;
use DateTimeZone;
use RuntimeException;

/**
 * Nightly database snapshots with SQLite's VACUUM INTO (consistent, compact, no lock on readers):
 * var/backups/app-<UTC timestamp>.sqlite plus a sidecar .json {createdAt, localDate, bytes, sha256}.
 * The backend downloads the newest one (GET /api/v1/backend/backup/latest) and keeps it at home.
 *
 * One backup per local day (settings "timezone.current") once the local hour reaches
 * BACKUP_HOUR; the newest BACKUP_KEEP snapshots are kept.
 */
final class Backups
{
    public const DIR = 'backups';
    private const NAME_RE = '/^app-(\d{8}T\d{6}Z)\.sqlite$/';

    public function __construct(
        private readonly Db $db,
        private readonly Paths $paths,
    ) {
    }

    public function due(DateTimeImmutable $now, string $tz, int $hour): bool
    {
        $local = $now->setTimezone(new DateTimeZone($tz));
        if ((int) $local->format('G') < $hour) {
            return false;
        }
        $latest = $this->latest();

        return $latest === null || $latest['localDate'] < $local->format('Y-m-d');
    }

    /** @return array{name: string, path: string, createdAt: string, localDate: string, bytes: int, sha256: string} */
    public function create(DateTimeImmutable $now, string $tz): array
    {
        $dir = $this->paths->var(self::DIR);
        Paths::ensureDir($dir);
        $name = 'app-' . $now->setTimezone(new DateTimeZone('UTC'))->format('Ymd\THis\Z') . '.sqlite';
        $path = $dir . '/' . $name;
        $tmp = $dir . '/.tmp-' . bin2hex(random_bytes(6)) . '.sqlite';
        $pdo = $this->db->pdo();
        if ($pdo->inTransaction()) {
            throw new RuntimeException('VACUUM INTO cannot run inside a transaction.');
        }
        try {
            $pdo->exec('VACUUM INTO ' . $pdo->quote($tmp));
            @chmod($tmp, 0600);
            if (!@rename($tmp, $path)) {
                throw new RuntimeException('Cannot move the backup to ' . $path);
            }
        } finally {
            Fs::remove($tmp);
        }
        $meta = [
            'name' => $name,
            'path' => $path,
            'createdAt' => Clock::iso($now),
            'localDate' => $now->setTimezone(new DateTimeZone($tz))->format('Y-m-d'),
            'bytes' => (int) filesize($path),
            'sha256' => (string) hash_file('sha256', $path),
        ];
        Fs::writeAtomic($path . '.json', (string) json_encode([
            'createdAt' => $meta['createdAt'], 'localDate' => $meta['localDate'], 'bytes' => $meta['bytes'], 'sha256' => $meta['sha256'],
        ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), 0600);

        return $meta;
    }

    /**
     * Snapshots, newest first.
     *
     * @return list<array{name: string, path: string, createdAt: string, localDate: string, bytes: int, sha256: string}>
     */
    public function all(): array
    {
        $dir = $this->paths->var(self::DIR);
        $out = [];
        foreach (glob($dir . '/app-*.sqlite') ?: [] as $path) {
            if (preg_match(self::NAME_RE, basename($path)) !== 1) {
                continue;
            }
            $meta = is_file($path . '.json') ? json_decode((string) file_get_contents($path . '.json'), true) : null;
            if (!is_array($meta) || !is_string($meta['sha256'] ?? null) || !is_string($meta['createdAt'] ?? null) || !is_string($meta['localDate'] ?? null)) {
                continue; // incomplete (crashed while writing the sidecar): not offered, pruned later
            }
            $out[] = [
                'name' => basename($path),
                'path' => $path,
                'createdAt' => $meta['createdAt'],
                'localDate' => $meta['localDate'],
                'bytes' => (int) filesize($path),
                'sha256' => $meta['sha256'],
            ];
        }
        usort($out, static fn (array $a, array $b): int => strcmp($b['name'], $a['name']));

        return $out;
    }

    /** @return array{name: string, path: string, createdAt: string, localDate: string, bytes: int, sha256: string}|null */
    public function latest(): ?array
    {
        return $this->all()[0] ?? null;
    }

    /** Keeps the newest $keep snapshots; also removes leftovers without a sidecar. Returns the number of deleted snapshots. */
    public function prune(int $keep, DateTimeImmutable $now): int
    {
        $deleted = 0;
        foreach (array_slice($this->all(), $keep) as $old) {
            if (Fs::remove($old['path'])) {
                Fs::remove($old['path'] . '.json');
                ++$deleted;
            }
        }
        $cutoff = $now->getTimestamp() - 3600;
        $dir = $this->paths->var(self::DIR);
        foreach (array_merge(glob($dir . '/app-*.sqlite') ?: [], glob($dir . '/.tmp-*') ?: []) as $path) {
            $orphan = str_contains(basename($path), '.tmp-') || !is_file($path . '.json');
            if ($orphan && (int) @filemtime($path) < $cutoff && Fs::remove($path)) {
                ++$deleted;
            }
        }

        return $deleted;
    }
}
