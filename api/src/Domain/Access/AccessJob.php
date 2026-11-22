<?php

declare(strict_types=1);

namespace Omw\Api\Domain\Access;

use DateTimeImmutable;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\RateLimiter;

/**
 * Cron job "access" (spec-wave5 §3.9), run after "alerts" every ~5 minutes:
 *   1. expire handoff markers older than 10 minutes and decline devices waiting 14 days;
 *   2. apply pending store ops and reconcile (20 s; only when the API writes the store itself;
 *      with ACCESS_STORE_MODE=none the Mac does both through the backend routes);
 *   3. deliver undelivered owner notices (no names);
 *   4. rotate the rate-limit salt once per UTC day, prune rate events (48 h) and applied ops (7 days);
 *   5. the optional gate probe (ACCESS_GATE_PROBE).
 */
final class AccessJob
{
    public const APPLIED_OPS_KEEP_DAYS = 7;

    public function __construct(
        private readonly Sessions $sessions,
        private readonly Devices $devices,
        private readonly StoreApplier $applier,
        private readonly StoreOps $ops,
        private readonly OwnerNotices $notices,
        private readonly RateLimiter $limiter,
        private readonly GateProbe $probe,
    ) {
    }

    /** @return array<string, mixed> */
    public function run(DateTimeImmutable $now): array
    {
        $handoffs = $this->sessions->expireHandoffs();
        $declined = $this->devices->expirePending();
        $apply = $this->applier->applyNow(20.0, true);

        return [
            'handoffsExpired' => $handoffs,
            'pendingDeclined' => $declined,
            'applied' => $apply['applied'],
            'pendingOps' => $apply['pending'],
            'reconciled' => $apply['reconciled'],
            'writer' => $apply['reason'],
            'noticesDelivered' => $this->notices->deliver(),
            'saltRotated' => $this->limiter->rotateSaltDaily(),
            'rateEventsPruned' => $this->limiter->prune(),
            'opsPruned' => $this->ops->prune(Clock::iso($now->modify('-' . self::APPLIED_OPS_KEEP_DAYS . ' days'))),
            'probe' => $this->probe->run($now),
        ];
    }
}
