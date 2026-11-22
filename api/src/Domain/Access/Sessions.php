<?php

declare(strict_types=1);

namespace Omw\Api\Domain\Access;

use Omw\Api\Config;
use Omw\Api\Http\ApiException;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;
use Omw\Api\Infra\RateLimiter;

/**
 * Gate sessions (spec-wave5 §3.3 Sessions): a session is the store file s/<fid>/<did>.<sid>;
 * the cookie value is "<fid>.<did>.<sid>". Only sha256(sid) is stored (session_hash); the clear
 * sid lives in devices.pending_sid just until the store ops of its issue are applied and the
 * value was handed to the device once (§3.8.3), and is discarded after 30 minutes.
 *
 * Issue (inside the caller's transaction): ops delete_prefix s/<fid>/<did>. + put the new
 * session (exclusive) + put the handoff marker h/<did> (not with ACCESS_COOKIE_MODE=parent, F2,
 * and not for the service session). At most 6 issues per device per hour.
 */
final class Sessions
{
    public const ISSUES_PER_HOUR = 6;
    public const PENDING_SID_MINUTES = 30;
    public const SERVICE_SESSION_HOURS = 24;
    public const HANDOFF_TTL_MINUTES = 10;

    public function __construct(
        private readonly Db $db,
        private readonly StoreOps $ops,
        private readonly RateLimiter $limiter,
        private readonly Config $config,
    ) {
    }

    /**
     * @return array{sid: string, maxOp: int}
     *
     * @throws ApiException 429 when the device issued too many sessions this hour
     */
    public function issue(string $fid, string $did, bool $service = false): array
    {
        return $this->db->write(function () use ($fid, $did, $service): array {
            if (!$service) {
                $wait = $this->limiter->hit('issue', $did, self::ISSUES_PER_HOUR, 3600);
                if ($wait > 0) {
                    throw new ApiException(429, 'rate_limited', 'Too many attempts. Please try again later.', ['retryAfter' => $wait]);
                }
            }
            $sid = Tokens::token();
            $now = Clock::nowIso();
            $handoff = !$service && !$this->config->access->isParent();
            $this->ops->enqueue('delete_prefix', StoreLayout::sessionPrefix($fid, $did));
            $max = $this->ops->enqueue('put', StoreLayout::session($fid, $did, $sid), '');
            if ($handoff) {
                $max = $this->ops->enqueue('put', StoreLayout::handoff($did), '');
            }
            $this->db->exec(
                'UPDATE devices SET session_hash = ?, session_at = ?, handoff_at = ?, pending_sid = ? WHERE id = ?',
                [Tokens::hash($sid), $now, $handoff ? $now : null, $sid, $did],
            );

            return ['sid' => $sid, 'maxOp' => $max];
        });
    }

    /** Forgets the clear sid once the device received it. */
    public function clearPendingSid(string $did): void
    {
        $this->db->write(fn (): int => $this->db->exec('UPDATE devices SET pending_sid = NULL WHERE id = ?', [$did]));
    }

    /**
     * True when the device's pending sid is older than 30 minutes (then it is discarded and issued again).
     *
     * @param array<string, mixed> $device
     */
    public static function pendingSidExpired(array $device): bool
    {
        $at = $device['session_at'] ?? null;

        return !is_string($at) || $at < Clock::iso(Clock::now()->modify('-' . self::PENDING_SID_MINUTES . ' minutes'));
    }

    /**
     * F2 (ACCESS_COOKIE_MODE=parent): the two cookies the API sets itself instead of a handoff.
     *
     * @return list<string> Set-Cookie values
     */
    public function parentCookies(string $fid, string $did, string $sid, string $k): array
    {
        $access = $this->config->access;
        $names = StoreLayout::gateCookies($this->config->siteOrigin, 'parent');
        $common = '; Domain=' . $access->cookieDomain . '; Path=/; Max-Age=34560000' . ($names['secure'] ? '; Secure' : '');

        return [
            $names['session'] . '=' . StoreLayout::gateCookieValue($fid, $did, $sid) . $common . '; HttpOnly; SameSite=Lax',
            $names['key'] . '=' . $k . $common . '; SameSite=Strict',
        ];
    }

    /**
     * Cron: handoff markers older than 10 minutes are deleted (JS-less visits).
     *
     * @return int number of markers
     */
    public function expireHandoffs(): int
    {
        $before = Clock::iso(Clock::now()->modify('-' . self::HANDOFF_TTL_MINUTES . ' minutes'));

        return $this->db->write(function () use ($before): int {
            $rows = $this->db->all('SELECT id FROM devices WHERE handoff_at IS NOT NULL AND handoff_at < ?', [$before]);
            foreach ($rows as $row) {
                $this->ops->enqueue('delete', StoreLayout::handoff((string) $row['id']));
                $this->db->exec('UPDATE devices SET handoff_at = NULL WHERE id = ?', [(string) $row['id']]);
            }

            return count($rows);
        });
    }

    /** One-time handoff: the SPA said hello after the handoff (§2.3.3). @return int op id (0 = nothing to do) */
    public function clearHandoff(string $did): int
    {
        return $this->db->write(function () use ($did): int {
            if ($this->db->exec('UPDATE devices SET handoff_at = NULL WHERE id = ? AND handoff_at IS NOT NULL', [$did]) === 0) {
                return 0;
            }

            return $this->ops->enqueue('delete', StoreLayout::handoff($did));
        });
    }
}
