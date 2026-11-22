<?php

declare(strict_types=1);

namespace Omw\Api\Http\Public;

use Omw\Api\Domain\Access\Devices;
use Omw\Api\Domain\Access\FollowerData;
use Omw\Api\Domain\Access\StoreLayout;
use Omw\Api\Domain\Access\Tokens;
use Omw\Api\Http\ApiException;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * The device's own routes (spec-wave5 §3.4); the device proves itself with its key k in the body:
 *   POST /public/me/hello    DeviceKeyRequest -> MeHelloResponse   (active devices)
 *   POST /public/me/notice   DeviceKeyRequest -> MeNoticeResponse  (active / waiting devices)
 *   POST /public/me/consent  MeConsentRequest -> MeHelloResponse   (active / waiting devices; a waiting
 *                                                                  device gets `pending`, never the name)
 *   POST /public/me/data     DeviceKeyRequest -> MeDataResponse    (D12 rights)
 *   POST /public/me/export   DeviceKeyRequest -> FollowerDataExport | MeSimpleResponse{ended}
 *   POST /public/me/signout  DeviceKeyRequest -> MeSimpleResponse  (active → revoked, waiting → declined)
 *   POST /public/me/delete   MeDeleteRequest  -> MeSimpleResponse  (full D12 rights)
 *
 * Who may read, export and delete is decided only by FollowerData::rightsOf(). A waiting
 * (forwarded-link) device never sees the person's name or other devices and cannot erase her.
 *
 * After a restore of the API database (§3.8.6) the device rows cannot be trusted until the
 * restored_api reconcile ran (a device removed after the backup is "active" again), so every
 * route refuses while AccessState::isRestoring(): hello, notice and consent answer
 * `unavailable`/`restoring` (their contracts carry it), data, export, signout and delete answer
 * 503 `busy` with Retry-After (their contracts have no such status; the page offers "try again").
 */
final class MeController
{
    public const LAST_SEEN_HOURS = 6;
    /** Retry-After (seconds) of the 503 answered while a restore is being reconciled. */
    public const RESTORING_RETRY_SECONDS = 60;

    public function __construct(
        private readonly PublicBody $body,
        private readonly PublicSupport $s,
        private readonly Devices $devices,
        private readonly FollowerData $data,
        private readonly Db $db,
    ) {
    }

    public function hello(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $k = $this->key($request, 'DeviceKeyRequest', 'me', 60);
        if ($this->s->state->isRestoring()) {
            return $this->s->answer($response, ['status' => 'unavailable', 'reason' => 'restoring'], 'MeHelloResponse');
        }
        $d = $this->devices->byKey($k);
        if (!self::activePerson($d)) {
            return $this->s->answer($response, ['status' => 'ended'], 'MeHelloResponse');
        }
        \assert($d !== null);
        if ($this->s->state->isLocked()) {
            return $this->s->answer($response, ['status' => 'unavailable', 'reason' => 'locked'], 'MeHelloResponse');
        }
        $did = (string) $d['id'];
        $seen = $d['last_seen_at'];
        $op = $this->db->write(function () use ($did, $seen): int {
            if (!is_string($seen) || $seen < Clock::iso(Clock::now()->modify('-' . self::LAST_SEEN_HOURS . ' hours'))) {
                $this->db->exec('UPDATE devices SET last_seen_at = ? WHERE id = ?', [Clock::nowIso(), $did]);
            }

            return $this->s->sessions->clearHandoff($did);
        });
        if ($op > 0) {
            $this->s->applier->applyNow(8.0);
        }
        $out = $this->s->answer($response, $this->helloAnswer($d), 'MeHelloResponse');
        if ($this->s->config->access->isParent()) {
            $out = PublicSupport::withCookies($out, $this->refreshParentCookies($request, $d, $k));
        }

        return $out;
    }

    public function notice(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $k = $this->key($request, 'DeviceKeyRequest', 'me', 60);
        if ($this->s->state->isRestoring()) {
            return $this->s->answer($response, ['status' => 'unavailable', 'reason' => 'restoring'], 'MeNoticeResponse');
        }
        $d = $this->devices->byKey($k);
        if (!self::activeOrPending($d)) {
            return $this->s->answer($response, ['status' => 'ended'], 'MeNoticeResponse');
        }
        \assert($d !== null);
        $notice = $this->s->notices->current();
        if ($notice === null) {
            return $this->s->answer($response, ['status' => 'unavailable', 'reason' => 'notice_missing'], 'MeNoticeResponse');
        }
        $confirmed = $d['state'] === 'pending'
            ? $this->s->consents->highestVersionForDevice((string) $d['id'])
            : $this->s->consents->highestVersion((string) $d['follower_id']);

        return $this->s->answer($response, ['status' => 'ok', 'notice' => $notice, 'confirmedVersion' => $confirmed], 'MeNoticeResponse');
    }

    public function consent(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $body = $this->body->read($request, 'MeConsentRequest');
        $k = (string) $body->k;
        $this->s->limit([['me', PublicSupport::keySubject($k), 60, 3600]]);
        if ($this->s->state->isRestoring()) {
            return $this->s->answer($response, ['status' => 'unavailable', 'reason' => 'restoring'], 'MeHelloResponse');
        }
        $d = $this->devices->byKey($k);
        if (!self::activeOrPending($d)) {
            return $this->s->answer($response, ['status' => 'ended'], 'MeHelloResponse');
        }
        \assert($d !== null);
        $current = $this->s->notices->currentVersion();
        if ($current === null) {
            return $this->s->answer($response, ['status' => 'unavailable', 'reason' => 'notice_missing'], 'MeHelloResponse');
        }
        // Only the current version is recorded; a stale one leaves notice.required true, so the
        // page fetches the newer text and asks again.
        if ((int) $body->version === $current) {
            $this->s->consents->record((string) $d['follower_id'], (string) $d['id'], $current, (string) $body->locale);
        }
        if ($d['state'] === 'pending') {
            // A waiting device (limited D12 rights): its confirmation stays on this device until
            // the owner approves it (Consents), and the answer carries no name.
            return $this->s->answer($response, ['status' => 'pending', 'notice' => $this->s->noticeFlags($d)], 'MeHelloResponse');
        }

        return $this->s->answer($response, $this->helloAnswer($d), 'MeHelloResponse');
    }

    public function data(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $k = $this->key($request, 'DeviceKeyRequest', 'me', 60);
        $this->refuseWhileRestoring();
        $d = $this->devices->byKey($k);
        $rights = FollowerData::rightsOf($d);
        if ($rights === 'none' || $d === null) {
            return $this->s->answer($response, ['status' => 'ended'], 'MeDataResponse');
        }
        if ($rights === 'limited') {
            return $this->s->answer($response, ['status' => 'limited', 'device' => [
                'label' => (string) $d['label'],
                'state' => (string) $d['state'],
                'createdAt' => (string) $d['created_at'],
            ]], 'MeDataResponse');
        }

        return $this->s->answer($response, ['status' => 'ok', 'data' => $this->data->view((string) $d['follower_id'], (string) $d['id'])], 'MeDataResponse');
    }

    public function export(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $k = $this->key($request, 'DeviceKeyRequest', 'export', 6);
        $this->refuseWhileRestoring();
        $d = $this->devices->byKey($k);
        if (FollowerData::rightsOf($d) !== 'full' || $d === null) {
            return $this->s->answer($response, ['status' => 'ended'], 'MeSimpleResponse');
        }
        $export = $this->data->export((string) $d['follower_id']);

        return $this->s->answer($response, $export, 'FollowerDataExport')
            ->withHeader('Content-Disposition', 'attachment; filename="on-my-way-data-' . substr(Clock::nowIso(), 0, 10) . '.json"');
    }

    public function signout(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $k = $this->key($request, 'DeviceKeyRequest', 'danger', 5);
        $this->refuseWhileRestoring();
        $d = $this->devices->byKey($k);
        if (!self::activeOrPending($d)) {
            return $this->s->answer($response, ['status' => 'ended'], 'MeSimpleResponse');
        }
        \assert($d !== null);
        $op = $this->devices->revoke((string) $d['id'], 'follower');
        if ($op > 0) {
            $this->s->applier->applyNow(8.0);
        }

        return $this->s->answer($response, ['status' => 'signed_out'], 'MeSimpleResponse');
    }

    public function delete(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $body = $this->body->read($request, 'MeDeleteRequest');
        $k = (string) $body->k;
        $this->s->limit([['danger', PublicSupport::keySubject($k), 5, 3600]]);
        $this->refuseWhileRestoring();
        $d = $this->devices->byKey($k);
        if (FollowerData::rightsOf($d) !== 'full' || $d === null) {
            return $this->s->answer($response, ['status' => 'ended'], 'MeSimpleResponse');
        }
        $this->data->delete((string) $d['follower_id'], 'follower');
        $this->s->applier->applyNow(8.0);
        $this->s->deliverNoticesSoon();

        return $this->s->answer($response, ['status' => 'deleted'], 'MeSimpleResponse');
    }

    /**
     * The routes whose contracts have no `unavailable` status refuse a restore window with 503.
     *
     * @throws ApiException 503 busy (+ Retry-After)
     */
    private function refuseWhileRestoring(): void
    {
        if ($this->s->state->isRestoring()) {
            throw (new ApiException(503, 'busy', 'Access is being checked after a restore. Please try again in a few minutes.'))
                ->withHeaders(['Retry-After' => (string) self::RESTORING_RETRY_SECONDS]);
        }
    }

    /** Reads {k} (or another body with k), applies the per-key limit and returns k. */
    private function key(ServerRequestInterface $request, string $schema, string $kind, int $perHour): string
    {
        $k = (string) $this->body->read($request, $schema)->k;
        $this->s->limit([[$kind, PublicSupport::keySubject($k), $perHour, 3600]]);

        return $k;
    }

    /**
     * @param array<string, mixed> $d
     * @return array<string, mixed>
     */
    private function helloAnswer(array $d): array
    {
        return [
            'status' => 'active',
            'follower' => ['name' => (string) $d['f_name']],
            'device' => ['id' => (string) $d['id'], 'label' => (string) $d['label']],
            'notice' => $this->s->noticeFlags($d),
        ];
    }

    /**
     * F2: re-sets both cookies when the request's own session cookie (sent with credentials)
     * hashes to the device's current session.
     *
     * @param array<string, mixed> $d
     * @return list<string>
     */
    private function refreshParentCookies(ServerRequestInterface $request, array $d, string $k): array
    {
        $value = $request->getCookieParams()['omw'] ?? null;
        $parts = is_string($value) ? StoreLayout::parseGateSession($value) : null;
        if ($parts === null || $parts['fid'] !== $d['follower_id'] || $parts['did'] !== $d['id']
            || !is_string($d['session_hash']) || !hash_equals($d['session_hash'], Tokens::hash($parts['sid']))) {
            return [];
        }

        return $this->s->sessions->parentCookies($parts['fid'], $parts['did'], $parts['sid'], $k);
    }

    /** @param array<string, mixed>|null $d */
    private static function activePerson(?array $d): bool
    {
        return $d !== null && $d['f_kind'] === 'person' && $d['f_state'] === 'active' && $d['state'] === 'active';
    }

    /** @param array<string, mixed>|null $d */
    private static function activeOrPending(?array $d): bool
    {
        return $d !== null && $d['f_kind'] === 'person' && $d['f_state'] === 'active' && in_array($d['state'], ['active', 'pending'], true);
    }
}
