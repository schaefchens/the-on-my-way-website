<?php

declare(strict_types=1);

namespace Omw\Api\Http\Backend;

use Omw\Api\Config;
use Omw\Api\Domain\Access\AccessState;
use Omw\Api\Domain\Access\Followers;
use Omw\Api\Domain\Access\OwnerNotices;
use Omw\Api\Domain\Access\Reconciler;
use Omw\Api\Domain\Access\Sessions;
use Omw\Api\Domain\Access\StoreApplier;
use Omw\Api\Domain\Access\StoreLayout;
use Omw\Api\Domain\Access\StoreOps;
use Omw\Api\Domain\Access\Tokens;
use Omw\Api\Http\ApiException;
use Omw\Api\Http\Input;
use Omw\Api\Http\Responder;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use stdClass;

/**
 * The Mac as fallback store writer (spec-wave5 §3.6, §3.8.4), Bearer backend token:
 *   POST /backend/access/claim     AccessClaimRequest -> AccessClaim (60 s lease when free or expired; ≤ 200 ops)
 *   POST /backend/access/renew     AccessRenewRequest -> AccessLease (null = lost: stop at once)
 *   POST /backend/access/listing   StoreListingUpload -> AccessClaim (reconcile on the Mac's listing)
 *   POST /backend/access/ack       AccessAck -> 204; 409 conflict when the epoch changed or the lease was lost
 *   GET  /backend/access/service-session[?rotate=1]  ServiceSession; 503 busy until the ops are applied
 *
 * While the Mac holds the lease the API applies nothing. Ops are idempotent and applied in id
 * order by one holder at a time, so a lost ack only means the API re-applies from its own
 * last_applied_op.
 */
final class AccessSyncController
{
    public const LEASE_SECONDS = 60;
    public const MAX_OPS = 200;
    /** A reconcile is due when the last one is older than this (one cron interval). */
    public const RECONCILE_EVERY_SECONDS = 300;

    public function __construct(
        private readonly Input $input,
        private readonly Responder $responder,
        private readonly Db $db,
        private readonly Config $config,
        private readonly StoreOps $ops,
        private readonly StoreApplier $applier,
        private readonly Reconciler $reconciler,
        private readonly AccessState $state,
        private readonly Followers $followers,
        private readonly Sessions $sessions,
        private readonly OwnerNotices $notices,
    ) {
    }

    public function claim(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $this->input->body($request, 'AccessClaimRequest');
        $lease = $this->db->write(function (): ?string {
            $row = $this->state->row();
            $now = Clock::now();
            $holder = $row['lease_holder'] ?? null;
            $until = $row['lease_until'] ?? null;
            if ($holder === 'api' && is_string($until) && $until > Clock::iso($now)) {
                return null;
            }

            return $this->setMacLease();
        });

        return $this->responder->json($response, $this->claimDto($lease), 'AccessClaim');
    }

    public function renew(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $body = $this->input->body($request, 'AccessRenewRequest');
        $lease = $this->db->write(fn (): ?string => $this->holdsMacLease((string) $body->epoch) ? $this->setMacLease() : null);

        return $this->responder->json($response, ['lease' => $lease === null ? null : ['until' => $lease]], 'AccessLease');
    }

    public function listing(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $body = $this->input->body($request, 'StoreListingUpload');
        $listing = self::listingArray($body->listing);
        if (!$this->db->write(fn (): bool => $this->holdsMacLease((string) $body->epoch))) {
            throw ApiException::conflict('The lease was lost or the epoch changed; claim again.');
        }
        $this->reconciler->run($listing, (int) $this->state->row()['last_applied_op']);
        $lease = $this->db->write(fn (): ?string => $this->holdsMacLease((string) $body->epoch) ? $this->setMacLease() : null);

        return $this->responder->json($response, $this->claimDto($lease), 'AccessClaim');
    }

    public function ack(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $body = $this->input->body($request, 'AccessAck');
        $epoch = (string) $body->epoch;
        $through = (int) $body->appliedThrough;
        $failed = $body->failed ?? null;
        $ok = $this->db->write(function () use ($epoch): bool {
            if (!$this->holdsMacLease($epoch)) {
                return false;
            }
            $this->db->exec("UPDATE access_state SET lease_holder = NULL, lease_until = NULL, updated_at = ? WHERE id = 1 AND lease_holder = 'mac'", [Clock::nowIso()]);

            return true;
        });
        if (!$ok) {
            throw ApiException::conflict('The lease was lost or the epoch changed; the API re-applies from its own state.');
        }
        $ids = array_map(
            static fn (array $r): int => (int) $r['id'],
            $this->db->all('SELECT id FROM store_ops WHERE applied_at IS NULL AND id <= ? ORDER BY id', [$through]),
        );
        $this->ops->markApplied($ids, 'mac');
        if ($failed instanceof stdClass) {
            $error = (string) $failed->error;
            $this->ops->markFailed((int) $failed->opId, 'mac: ' . $error);
            if ($error === 'store_mismatch') {
                $this->db->write(fn (): int => $this->db->exec(
                    'UPDATE access_state SET writer_error = ?, updated_at = ? WHERE id = 1',
                    ['store_unverified: the Mac found no store marker with this store id', Clock::nowIso()],
                ));
                if (!$this->notices->hasUnread('store_mismatch')) {
                    $this->notices->add('store_mismatch');
                }
            }
        } elseif ($ids !== [] && $this->config->access->storeMode === 'none' && $this->state->storeUnverified()) {
            $this->db->write(fn (): int => $this->db->exec("UPDATE access_state SET writer_error = NULL, updated_at = ? WHERE id = 1 AND writer_error LIKE 'store_unverified%'", [Clock::nowIso()]));
        }

        return $this->responder->noContent($response);
    }

    public function serviceSession(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $origin = $this->config->siteOrigin;
        if (!StoreLayout::isOrigin($origin)) {
            throw new ApiException(409, 'config_missing', 'SITE_ORIGIN is not configured on the API.');
        }
        $rotate = ($request->getQueryParams()['rotate'] ?? null) === '1';
        $service = $this->followers->service();
        $fid = $service['fid'];
        $did = $service['did'];
        $device = $this->db->one('SELECT pending_sid, session_at FROM devices WHERE id = ?', [$did]) ?? [];
        $pending = is_string($device['pending_sid'] ?? null) && !Sessions::pendingSidExpired($device) ? $device['pending_sid'] : null;
        // The API never keeps a delivered sid: unless an issue is still waiting for its ops, every
        // call (and every rotate=1) issues a fresh session, which rotates the previous one.
        if ($pending === null || $rotate) {
            $pending = $this->sessions->issue($fid, $did, true)['sid'];
        }
        $this->applier->applyNow(8.0);
        if ($this->ops->pendingForDevice($fid, $did)) {
            throw (new ApiException(503, 'busy', 'The service session is not in the store yet; retry in a few seconds.'))->withHeaders(['Retry-After' => '5']);
        }
        $this->sessions->clearPendingSid($did);
        $sessionAt = (string) ($this->db->scalar('SELECT session_at FROM devices WHERE id = ?', [$did]) ?? Clock::nowIso());

        return $this->responder->json($response, [
            'cookieName' => StoreLayout::gateCookies($origin, $this->config->access->cookieMode)['session'],
            'cookieValue' => StoreLayout::gateCookieValue($fid, $did, $pending),
            'expiresAt' => Clock::iso((new \DateTimeImmutable($sessionAt))->modify('+' . Sessions::SERVICE_SESSION_HOURS . ' hours')),
        ], 'ServiceSession');
    }

    /** True when access_state says the Mac writer is needed (ChangesResponse.access.needsWriter). */
    public static function needsWriter(Db $db, Config $config): bool
    {
        if (!$config->access->apiWrites()) {
            return true;
        }
        $row = $db->one('SELECT writer_blocked_at FROM access_state WHERE id = 1');
        if (($row['writer_blocked_at'] ?? null) !== null) {
            return true;
        }
        $oldest = $db->scalar('SELECT MIN(created_at) FROM store_ops WHERE applied_at IS NULL');

        return is_string($oldest) && $oldest < Clock::iso(Clock::now()->modify('-60 seconds'));
    }

    private function holdsMacLease(string $epoch): bool
    {
        $row = $this->state->row();

        return ($row['lease_holder'] ?? null) === 'mac' && ($row['epoch'] ?? null) === $epoch
            && is_string($row['lease_until'] ?? null) && $row['lease_until'] > Clock::nowIso();
    }

    private function setMacLease(): string
    {
        $now = Clock::now();
        $until = Clock::iso($now->modify('+' . self::LEASE_SECONDS . ' seconds'));
        $this->db->exec("UPDATE access_state SET lease_holder = 'mac', lease_until = ?, updated_at = ? WHERE id = 1", [$until, Clock::iso($now)]);

        return $until;
    }

    /** @return array<string, mixed> contract AccessClaim */
    private function claimDto(?string $lease): array
    {
        $row = $this->state->row();
        $ops = [];
        if ($lease !== null) {
            foreach ($this->ops->pending(self::MAX_OPS) as $op) {
                $ops[] = ['id' => $op['id'], 'op' => $op['op'], 'path' => $op['path'], 'content' => $op['content'], 'exclusive' => $op['exclusive']];
            }
        }
        $last = $row['last_reconcile_at'] ?? null;
        $due = !is_string($last) || $last < Clock::iso(Clock::now()->modify('-' . self::RECONCILE_EVERY_SECONDS . ' seconds'))
            || ($row['reconciled_epoch'] ?? null) !== ($row['epoch'] ?? null);
        $apiCanList = $this->config->access->apiWrites() && ($row['writer_blocked_at'] ?? null) === null;

        return [
            'lease' => $lease === null ? null : ['until' => $lease],
            'storeId' => is_string($row['store_id'] ?? null) ? $row['store_id'] : null,
            'epoch' => (string) ($row['epoch'] ?? ''),
            'ops' => $ops,
            // No listing while the init op is pending: there is no initialised store to reconcile
            // yet, and the Mac must write the marker before it may list or apply anything else.
            'listingWanted' => $lease !== null && $due && !$apiCanList && is_string($row['store_id'] ?? null)
                && $this->ops->pendingInit() === null,
        ];
    }

    /**
     * The uploaded listing as the reconciler's array; every path is checked against the layout.
     *
     * @return array{marker: string|null, locked: string|null, sessions: list<string>, handoffs: list<string>, tombstones: list<array{path: string, content: string}>, strays: list<string>}
     */
    private static function listingArray(mixed $listing): array
    {
        if (!$listing instanceof stdClass) {
            throw ApiException::validation('listing must be an object.');
        }
        $sessions = [];
        foreach ((array) $listing->sessions as $path) {
            if (!is_string($path) || StoreLayout::kind($path) !== 'session') {
                throw ApiException::validation('Invalid session path in the listing.');
            }
            $sessions[] = $path;
        }
        $handoffs = [];
        foreach ((array) $listing->handoffs as $did) {
            if (!Tokens::isDeviceId($did)) {
                throw ApiException::validation('Invalid handoff name in the listing.');
            }
            $handoffs[] = (string) $did;
        }
        $tombstones = [];
        foreach ((array) $listing->tombstones as $t) {
            $kind = $t instanceof stdClass && is_string($t->path ?? null) ? StoreLayout::kind($t->path) : null;
            if (!in_array($kind, ['personTombstone', 'deviceTombstone'], true) || !is_string($t->content ?? null)) {
                throw ApiException::validation('Invalid tombstone in the listing.');
            }
            $tombstones[] = ['path' => (string) $t->path, 'content' => $t->content];
        }
        $strays = [];
        foreach ((array) $listing->strays as $stray) {
            if (is_string($stray)) {
                $strays[] = $stray;
            }
        }

        return [
            'marker' => is_string($listing->marker ?? null) ? $listing->marker : null,
            'locked' => is_string($listing->locked ?? null) ? $listing->locked : null,
            'sessions' => $sessions,
            'handoffs' => $handoffs,
            'tombstones' => $tombstones,
            'strays' => $strays,
        ];
    }
}
