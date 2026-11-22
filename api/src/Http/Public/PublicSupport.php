<?php

declare(strict_types=1);

namespace Omw\Api\Http\Public;

use Omw\Api\Config;
use Omw\Api\Domain\Access\AccessState;
use Omw\Api\Domain\Access\Consents;
use Omw\Api\Domain\Access\PrivacyNotices;
use Omw\Api\Domain\Access\Sessions;
use Omw\Api\Domain\Access\StoreApplier;
use Omw\Api\Domain\Access\StoreOps;
use Omw\Api\Domain\Access\Tokens;
use Omw\Api\Domain\Alerts\AlertEngine;
use Omw\Api\Domain\Access\OwnerNotices;
use Omw\Api\Http\ApiException;
use Omw\Api\Http\Input;
use Omw\Api\Http\Responder;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\RateLimiter;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * What the public controllers share: rate limits (§3.7), the session hand-out after an issue
 * (§3.3 Sessions 4–5), notice flags, poll intervals and the work done after the response.
 */
final class PublicSupport
{
    public const ACTIVATING_POLL_MS = 3000;

    public function __construct(
        public readonly Responder $responder,
        public readonly RateLimiter $limiter,
        public readonly AccessState $state,
        public readonly StoreApplier $applier,
        public readonly StoreOps $ops,
        public readonly Sessions $sessions,
        public readonly PrivacyNotices $notices,
        public readonly Consents $consents,
        public readonly Config $config,
        private readonly AlertEngine $alerts,
        private readonly OwnerNotices $ownerNotices,
        private readonly ?LoggerInterface $logger = null,
    ) {
    }

    /**
     * @param list<array{0: string, 1: string, 2: int, 3: int}> $limits [kind, subject, limit, windowSeconds]
     *
     * @throws ApiException 429 rate_limited (+ Retry-After)
     */
    public function limit(array $limits): void
    {
        $wait = $this->limiter->hitAll($limits);
        if ($wait > 0) {
            throw new ApiException(429, 'rate_limited', 'Too many attempts. Please try again later.', ['retryAfter' => $wait]);
        }
    }

    public static function ip(ServerRequestInterface $request): string
    {
        return Input::clientIp($request);
    }

    /** @param array<string, mixed> $data */
    public function answer(ResponseInterface $response, array $data, string $schema): ResponseInterface
    {
        return $this->responder->json($response, $data, $schema);
    }

    /**
     * Poll interval of a waiting device: quick at first, then slower (the daily poll cap is 1200).
     *
     * @param array<string, mixed> $device
     */
    public static function pendingPollMs(array $device): int
    {
        $age = Clock::now()->getTimestamp() - (new \DateTimeImmutable((string) $device['created_at']))->getTimestamp();

        return match (true) {
            $age < 600 => 5000,
            $age < 3600 => 20_000,
            default => 60_000,
        };
    }

    /**
     * After a session issue (the transaction committed): apply the ops now (non-blocking) and hand
     * out the session when every op is in the store; otherwise "activating".
     *
     * @param array<string, mixed> $extra added to the answer (deviceKey for a new device)
     * @return array{data: array<string, mixed>, cookies: list<string>}
     */
    public function handOut(string $fid, string $did, string $sid, string $k, array $extra = []): array
    {
        $this->applier->applyNow(8.0);
        if ($this->ops->pendingForDevice($fid, $did)) {
            return ['data' => ['status' => 'activating', 'pollAfterMs' => self::ACTIVATING_POLL_MS] + $extra, 'cookies' => []];
        }
        $this->sessions->clearPendingSid($did);
        if ($this->config->access->isParent()) {
            return ['data' => ['status' => 'active', 'handoff' => '/'] + $extra, 'cookies' => $this->sessions->parentCookies($fid, $did, $sid, $k)];
        }

        return ['data' => ['status' => 'active', 'handoff' => '/_/h/', 'session' => $fid . '.' . $did . '.' . $sid] + $extra, 'cookies' => []];
    }

    /** @param list<string> $cookies */
    public static function withCookies(ResponseInterface $response, array $cookies): ResponseInterface
    {
        foreach ($cookies as $cookie) {
            $response = $response->withAddedHeader('Set-Cookie', $cookie);
        }

        return $response;
    }

    /**
     * notice flags for an answer: the current version and whether this person (active device) or
     * this device (waiting device) still has to confirm it.
     *
     * @param array<string, mixed> $device
     * @return array{version: int, required: bool}|null
     */
    public function noticeFlags(array $device): ?array
    {
        $current = $this->notices->currentVersion();
        if ($current === null) {
            return null;
        }
        $confirmed = $device['state'] === 'pending'
            ? $this->consents->highestVersionForDevice((string) $device['id'])
            : $this->consents->highestVersion((string) $device['follower_id']);

        return ['version' => $current, 'required' => $confirmed === null || $confirmed < $current];
    }

    /** Hashed key subject for the per-key limits. */
    public static function keySubject(string $k): string
    {
        return Tokens::hash($k);
    }

    /** Runs $work after the response went out (PHP-FPM); elsewhere cron does it within 5 minutes. */
    public function afterResponse(callable $work): void
    {
        if (!function_exists('fastcgi_finish_request')) {
            return;
        }
        $logger = $this->logger;
        register_shutdown_function(static function () use ($work, $logger): void {
            fastcgi_finish_request();
            try {
                $work();
            } catch (Throwable $e) {
                $logger?->warning('Work after the response failed: {error}', ['error' => $e->getMessage()]);
            }
        });
    }

    public function alertPendingDevicesSoon(): void
    {
        $alerts = $this->alerts;
        $this->afterResponse(static fn (): mixed => $alerts->run(null, ['devices_pending']));
    }

    public function deliverNoticesSoon(): void
    {
        $notices = $this->ownerNotices;
        $this->afterResponse(static fn (): int => $notices->deliver());
    }
}
