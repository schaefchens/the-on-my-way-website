<?php

declare(strict_types=1);

namespace Omw\Api\Domain\Auth;

use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;

/**
 * Login rate limiting on top of login_attempts.
 *
 * - per client IP: at most {@see MAX_PER_IP} failed logins per {@see IP_WINDOW} seconds;
 * - per e-mail (any IP): at most {@see MAX_PER_EMAIL} failed logins per {@see EMAIL_WINDOW}
 *   seconds (slows down distributed guessing against the single owner account). The per-e-mail
 *   block does not apply to a known device: an IP that logged in successfully as that e-mail
 *   within {@see KNOWN_DEVICE_DAYS} days. So guessing from elsewhere cannot lock the owner out
 *   of their usual connection; the per-IP limit still applies to it.
 *
 * Only failures after the last successful login of that IP / e-mail count. Requests rejected by
 * the limiter are not recorded, so a lockout always ends after the window.
 *
 * Atomicity: {@see begin()} checks the limits AND records the attempt as a provisional failure in
 * one BEGIN IMMEDIATE transaction, before the (slow) password check; {@see succeeded()} flips it
 * afterwards. Concurrent attempts therefore always count each other: however many arrive at
 * once, at most MAX_PER_IP of them per window ever reach password_verify().
 */
final class LoginThrottle
{
    public const MAX_PER_IP = 10;
    public const IP_WINDOW = 15 * 60;
    public const MAX_PER_EMAIL = 30;
    public const EMAIL_WINDOW = 60 * 60;
    public const KNOWN_DEVICE_DAYS = 30;

    public function __construct(private readonly Db $db)
    {
    }

    /**
     * Starts one login attempt: in a single write transaction, computes the wait and, when the
     * attempt is allowed, records it as a failure (success = 0).
     *
     * @return array{attemptId: int|null, retryAfter: int} attemptId null = refused (retryAfter > 0, nothing recorded)
     */
    public function begin(string $ip, ?string $email): array
    {
        $email = self::normalize($email);

        return $this->db->write(function () use ($ip, $email): array {
            $wait = $this->retryAfter($ip, $email);
            if ($wait > 0) {
                return ['attemptId' => null, 'retryAfter' => $wait];
            }

            return ['attemptId' => $this->insert($ip, $email, false), 'retryAfter' => 0];
        });
    }

    /** Marks an attempt from {@see begin()} as a successful login. */
    public function succeeded(int $attemptId): void
    {
        $this->db->write(fn (): int => $this->db->exec('UPDATE login_attempts SET success = 1 WHERE id = ?', [$attemptId]));
    }

    /** Seconds until the next attempt is allowed (0 = allowed now). Read-only; logins use {@see begin()}. */
    public function retryAfter(string $ip, ?string $email): int
    {
        $email = self::normalize($email);
        $wait = $this->wait('ip', $ip, self::MAX_PER_IP, self::IP_WINDOW);
        if ($email !== null && !$this->isKnownDevice($ip, $email)) {
            $wait = max($wait, $this->wait('email', $email, self::MAX_PER_EMAIL, self::EMAIL_WINDOW));
        }

        return $wait;
    }

    /** True when $ip had a successful login as $email within {@see KNOWN_DEVICE_DAYS} days. */
    public function isKnownDevice(string $ip, string $email): bool
    {
        $email = self::normalize($email);
        if ($email === null) {
            return false;
        }
        $from = Clock::iso(Clock::now()->modify('-' . self::KNOWN_DEVICE_DAYS . ' days'));

        return $this->db->scalar(
            'SELECT 1 FROM login_attempts WHERE ip = ? AND email = ? AND success = 1 AND attempted_at > ? LIMIT 1',
            [$ip, $email, $from],
        ) !== null;
    }

    /** Records a finished attempt in one step (CLI tools and tests; logins use {@see begin()}). */
    public function record(string $ip, ?string $email, bool $success): void
    {
        $email = self::normalize($email);
        $this->db->write(fn (): int => $this->insert($ip, $email, $success));
    }

    /** Deletes attempts older than $olderThanIso (cron cleanup). */
    public function prune(string $olderThanIso): int
    {
        return $this->db->write(fn (): int => $this->db->exec('DELETE FROM login_attempts WHERE attempted_at < ?', [$olderThanIso]));
    }

    /** The e-mail as stored in login_attempts: trimmed, lowercase, at most 254 characters; null when empty. */
    private static function normalize(?string $email): ?string
    {
        if ($email === null) {
            return null;
        }
        $email = mb_substr(mb_strtolower(trim($email)), 0, 254);

        return $email === '' ? null : $email;
    }

    private function insert(string $ip, ?string $email, bool $success): int
    {
        $this->db->exec(
            'INSERT INTO login_attempts (email, ip, success, attempted_at) VALUES (?, ?, ?, ?)',
            [$email, $ip, $success ? 1 : 0, Clock::nowIso()],
        );

        return (int) $this->db->pdo()->lastInsertId();
    }

    private function wait(string $column, string $value, int $max, int $window): int
    {
        $now = Clock::now();
        $from = Clock::iso($now->modify("-$window seconds"));
        $lastSuccess = $this->db->scalar(
            "SELECT MAX(attempted_at) FROM login_attempts WHERE $column = ? AND success = 1",
            [$value],
        );
        if (is_string($lastSuccess) && $lastSuccess > $from) {
            $from = $lastSuccess;
        }
        $nth = $this->db->scalar(
            "SELECT attempted_at FROM login_attempts WHERE $column = ? AND success = 0 AND attempted_at > ?
             ORDER BY attempted_at DESC LIMIT 1 OFFSET " . ($max - 1),
            [$value, $from],
        );
        if (!is_string($nth)) {
            return 0;
        }
        $until = (new \DateTimeImmutable($nth))->modify("+$window seconds");
        $seconds = $until->getTimestamp() - $now->getTimestamp();

        return max(1, $seconds);
    }
}
