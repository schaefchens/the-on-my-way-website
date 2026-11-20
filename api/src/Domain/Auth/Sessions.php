<?php

declare(strict_types=1);

namespace Omw\Api\Domain\Auth;

use Omw\Api\Http\ApiException;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;
use Psr\Log\LoggerInterface;

/**
 * Admin login: checks the owner's password (rate limited, generic failures) and issues a
 * session token (api_tokens kind "session") that lives in the __Host- cookie.
 */
final class Sessions
{
    /** HttpOnly session cookie; the __Host- prefix forces Secure, Path=/ and no Domain. */
    public const COOKIE = '__Host-omw_session';

    /**
     * Verified against when the e-mail is unknown, so a login for an unknown account costs the
     * same time as a wrong password (no account enumeration by timing).
     */
    private const DUMMY_ARGON2ID = '$argon2id$v=19$m=65536,t=4,p=1$RzZlMXJ0RWx5OTNibER6ZQ$VsJrhWT7LcklumBGvbBjl0MoB46+ZeT6hKcF5ujuio4';
    private const DUMMY_BCRYPT = '$2y$12$DSWaaXKhKx3Yw9edqoJnQufg0864nntyB2bDhx9jHMdch4vhS9VMK';

    public function __construct(
        private readonly Db $db,
        private readonly ApiTokens $tokens,
        private readonly LoginThrottle $throttle,
        private readonly int $sessionDays,
        private readonly ?LoggerInterface $logger = null,
    ) {
    }

    /**
     * @return array{token: string, expiresAt: string, userId: int, email: string, displayName: string|null}
     *
     * @throws ApiException 401 for every kind of failure, 429 when rate limited
     */
    public function login(?string $email, ?string $password, string $ip): array
    {
        $normalized = is_string($email) ? mb_strtolower(trim($email)) : null;
        // Check the limits and record this attempt as a failure in ONE transaction, before the
        // slow password check: concurrent attempts then count each other (LoginThrottle).
        $attempt = $this->throttle->begin($ip, $normalized);
        if ($attempt['attemptId'] === null) {
            $this->logger?->warning('Login rate limited', ['ip' => $ip]);
            throw new ApiException(429, 'rate_limited', 'Too many failed logins. Try again later.', ['retryAfter' => $attempt['retryAfter']]);
        }

        $user = null;
        if ($normalized !== null && $normalized !== '' && strlen($normalized) <= 254) {
            $row = $this->db->one('SELECT id, email, password_hash, display_name FROM users WHERE email = ?', [$normalized]);
            $user = $row;
        }
        $hash = $user !== null ? (string) $user['password_hash'] : (Passwords::argon2idAvailable() ? self::DUMMY_ARGON2ID : self::DUMMY_BCRYPT);
        $ok = is_string($password) && $password !== '' && strlen($password) <= 4096 && Passwords::verify($password, $hash) && $user !== null;

        if (!$ok || $user === null || !is_string($password)) {
            $this->logger?->notice('Failed admin login', ['ip' => $ip]); // already recorded by begin()
            throw self::invalid();
        }

        $this->throttle->succeeded($attempt['attemptId']);
        $userId = (int) $user['id'];
        $now = Clock::nowIso();
        $this->db->write(function () use ($userId, $hash, $password, $now): void {
            $this->db->exec('UPDATE users SET last_login_at = ? WHERE id = ?', [$now, $userId]);
            if (Passwords::needsRehash($hash)) {
                $this->db->exec('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [Passwords::hash($password), $now, $userId]);
            }
        });

        $expiresAt = $this->expiry();
        $created = $this->tokens->create('session', 'admin session', null, $userId, $expiresAt);
        $this->logger?->info('Admin login', ['ip' => $ip, 'userId' => $userId]);

        return [
            'token' => $created['token'],
            'expiresAt' => $expiresAt,
            'userId' => $userId,
            'email' => (string) $user['email'],
            'displayName' => $user['display_name'] === null ? null : (string) $user['display_name'],
        ];
    }

    /** Expiry of a session that is (re)issued now (sliding window of SESSION_DAYS). */
    public function expiry(): string
    {
        return Clock::iso(Clock::now()->modify('+' . $this->sessionDays . ' days'));
    }

    public function maxAgeSeconds(): int
    {
        return $this->sessionDays * 86400;
    }

    /**
     * True when a session with this expiry should be extended (less than SESSION_DAYS - 1 day
     * left), which also re-sends the cookie with a fresh Max-Age.
     */
    public function shouldExtend(?string $expiresAt): bool
    {
        if ($expiresAt === null) {
            return false;
        }

        return $expiresAt < Clock::iso(Clock::now()->modify('+' . ($this->sessionDays - 1) . ' days'));
    }

    public static function invalid(): ApiException
    {
        return new ApiException(401, 'unauthorized', 'Invalid e-mail or password.');
    }

    /** Set-Cookie value for a session token. */
    public static function cookie(string $token, int $maxAge): string
    {
        return sprintf('%s=%s; Max-Age=%d; Path=/; Secure; HttpOnly; SameSite=Strict', self::COOKIE, $token, $maxAge);
    }

    /** Set-Cookie value that deletes the session cookie. */
    public static function clearCookie(): string
    {
        return sprintf('%s=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Secure; HttpOnly; SameSite=Strict', self::COOKIE);
    }
}
