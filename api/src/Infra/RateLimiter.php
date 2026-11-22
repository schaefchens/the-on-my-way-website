<?php

declare(strict_types=1);

namespace Omw\Api\Infra;

/**
 * Sliding-window rate limits on rate_events (spec-wave5 §3.7). Subjects (IPs, key and link
 * hashes, device ids) are never stored: a bucket is
 * "<kind>:" + the first 32 hex chars of sha256(subject + meta.rl_salt); the salt rotates once per
 * UTC day (cron) and rows older than 48 h are pruned.
 *
 * Check-and-record is one BEGIN IMMEDIATE transaction, so concurrent requests always count each
 * other. A refused request is not recorded (a limit always ends after its window); every allowed
 * one is, whatever its outcome (an invalid link counts like a valid one).
 */
final class RateLimiter
{
    public const PRUNE_HOURS = 48;

    public function __construct(private readonly Db $db)
    {
    }

    /**
     * @return int 0 = allowed (and recorded); otherwise the seconds to wait (nothing recorded)
     */
    public function hit(string $kind, string $subject, int $limit, int $windowSeconds): int
    {
        return $this->hitAll([[$kind, $subject, $limit, $windowSeconds]]);
    }

    /**
     * Several limits at once: all are checked, and only when every one allows the request are
     * all of them recorded.
     *
     * @param list<array{0: string, 1: string, 2: int, 3: int}> $limits [kind, subject, limit, windowSeconds]
     * @return int 0 = allowed; else the longest wait in seconds
     */
    public function hitAll(array $limits): int
    {
        if ($limits === []) {
            return 0;
        }

        return $this->db->write(function () use ($limits): int {
            $salt = $this->salt();
            $now = Clock::now();
            $nowIso = Clock::iso($now);
            $wait = 0;
            $buckets = [];
            foreach ($limits as [$kind, $subject, $limit, $window]) {
                $bucket = self::bucket($kind, $subject, $salt);
                $buckets[] = $bucket;
                $from = Clock::iso($now->modify("-$window seconds"));
                $nth = $this->db->scalar(
                    'SELECT at FROM rate_events WHERE bucket = ? AND at > ? ORDER BY at DESC LIMIT 1 OFFSET ' . max(0, $limit - 1),
                    [$bucket, $from],
                );
                if (is_string($nth)) {
                    $until = (new \DateTimeImmutable($nth))->getTimestamp() + $window;
                    $wait = max($wait, max(1, $until - $now->getTimestamp()));
                }
            }
            if ($wait > 0) {
                return $wait;
            }
            foreach ($buckets as $bucket) {
                $this->db->exec('INSERT INTO rate_events (bucket, at) VALUES (?, ?)', [$bucket, $nowIso]);
            }

            return 0;
        });
    }

    /** Events in a bucket within the window (alerts, tests). */
    public function count(string $kind, string $subject, int $windowSeconds): int
    {
        $from = Clock::iso(Clock::now()->modify("-$windowSeconds seconds"));

        return (int) $this->db->scalar('SELECT COUNT(*) FROM rate_events WHERE bucket = ? AND at > ?', [self::bucket($kind, $subject, $this->salt()), $from]);
    }

    /** Cron: a new salt once per UTC day (resets every window at UTC midnight, an accepted residual). */
    public function rotateSaltDaily(): bool
    {
        $today = Clock::now()->format('Y-m-d');

        return $this->db->write(function () use ($today): bool {
            if ($this->db->scalar("SELECT value FROM meta WHERE key = 'rl_salt_day'") === $today) {
                return false;
            }
            $this->db->exec("UPDATE meta SET value = lower(hex(randomblob(16))) WHERE key = 'rl_salt'");
            $this->db->exec(
                "INSERT INTO meta (key, value) VALUES ('rl_salt_day', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                [$today],
            );

            return true;
        });
    }

    public function prune(): int
    {
        $before = Clock::iso(Clock::now()->modify('-' . self::PRUNE_HOURS . ' hours'));

        return $this->db->write(fn (): int => $this->db->exec('DELETE FROM rate_events WHERE at < ?', [$before]));
    }

    private function salt(): string
    {
        $salt = $this->db->scalar("SELECT value FROM meta WHERE key = 'rl_salt'");

        return is_string($salt) ? $salt : '';
    }

    private static function bucket(string $kind, string $subject, string $salt): string
    {
        return $kind . ':' . substr(hash('sha256', $subject . $salt), 0, 32);
    }
}
