<?php

declare(strict_types=1);

namespace Omw\Api\Domain\App;

use Omw\Api\Http\ApiException;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;

/**
 * Fixed-window counters for the app routes (table app_rate_hits):
 *
 * - pairing: at most {@see PAIR_FAILURES_PER_IP} failed codes per IP per 15 min and
 *   {@see PAIR_FAILURES_TOTAL} failed codes per hour from anywhere (an 8-char code has 40 bits; with
 *   these limits and a 1-24 h lifetime guessing is hopeless). Like the admin login.
 * - per phone: at most {@see REQUESTS_PER_PHONE} requests per minute. The app itself keeps
 *   APP_REQUEST_BUDGET (10 per 10 s), so only a broken or stolen client ever sees the 429.
 *
 * Refused requests are not counted, so a lockout always ends with its window.
 */
final class AppRateLimiter
{
    public const PAIR_FAILURES_PER_IP = 10;
    public const PAIR_IP_WINDOW = 15 * 60;
    public const PAIR_FAILURES_TOTAL = 50;
    public const PAIR_TOTAL_WINDOW = 60 * 60;
    public const REQUESTS_PER_PHONE = 120;
    public const PHONE_WINDOW = 60;

    public function __construct(private readonly Db $db)
    {
    }

    /** @throws ApiException 429 while pairing is blocked for this IP (or everywhere) */
    public function checkPairing(string $ip): void
    {
        $wait = max(
            $this->wait('pair-ip:' . $ip, self::PAIR_FAILURES_PER_IP, self::PAIR_IP_WINDOW),
            $this->wait('pair-all', self::PAIR_FAILURES_TOTAL, self::PAIR_TOTAL_WINDOW),
        );
        if ($wait > 0) {
            throw self::limited($wait, 'Too many pairing attempts. Try again later.');
        }
    }

    public function pairingFailed(string $ip): void
    {
        $this->db->write(function () use ($ip): void {
            $this->hit('pair-ip:' . $ip, self::PAIR_IP_WINDOW);
            $this->hit('pair-all', self::PAIR_TOTAL_WINDOW);
        });
    }

    /** Counts one request of a phone; 429 above the limit. */
    public function phoneRequest(int $phoneId): void
    {
        $bucket = 'phone:' . $phoneId;
        $wait = $this->wait($bucket, self::REQUESTS_PER_PHONE, self::PHONE_WINDOW);
        if ($wait > 0) {
            throw self::limited($wait, 'Too many requests from this phone.');
        }
        $this->db->write(fn () => $this->hit($bucket, self::PHONE_WINDOW));
    }

    /** Deletes windows that ended (housekeeping). */
    public function prune(): int
    {
        $cutoff = Clock::iso(Clock::now()->modify('-' . self::PAIR_TOTAL_WINDOW . ' seconds'));

        return $this->db->write(fn (): int => $this->db->exec('DELETE FROM app_rate_hits WHERE window_start < ?', [$cutoff]));
    }

    private function windowStart(int $window): string
    {
        $now = Clock::now()->getTimestamp();

        return Clock::iso((new \DateTimeImmutable('@' . ($now - $now % $window))));
    }

    /** Seconds until the window ends when it is full, else 0. */
    private function wait(string $bucket, int $max, int $window): int
    {
        $start = $this->windowStart($window);
        $hits = (int) ($this->db->scalar('SELECT hits FROM app_rate_hits WHERE bucket = ? AND window_start = ?', [$bucket, $start]) ?? 0);
        if ($hits < $max) {
            return 0;
        }

        return max(1, (int) (strtotime($start) + $window - Clock::now()->getTimestamp()));
    }

    private function hit(string $bucket, int $window): void
    {
        $this->db->exec(
            'INSERT INTO app_rate_hits (bucket, window_start, hits) VALUES (?, ?, 1)
             ON CONFLICT (bucket, window_start) DO UPDATE SET hits = hits + 1',
            [$bucket, $this->windowStart($window)],
        );
    }

    private static function limited(int $seconds, string $message): ApiException
    {
        return (new ApiException(429, 'rate_limited', $message))->withHeaders(['Retry-After' => (string) $seconds]);
    }
}
