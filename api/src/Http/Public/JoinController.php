<?php

declare(strict_types=1);

namespace Omw\Api\Http\Public;

use Omw\Api\Domain\Access\Devices;
use Omw\Api\Domain\Access\Followers;
use Omw\Api\Domain\Access\Tokens;
use Omw\Api\Domain\Access\UserAgentLabel;
use Omw\Api\Infra\Db;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * Joining (spec-wave5 §1.1–§1.3, §3.4):
 *   POST /public/join/check   JoinCheckRequest {t, k?} -> JoinCheckResponse
 *   POST /public/join         JoinRequest {t?, resume?, k?, consentVersion?, locale} -> JoinResponse
 *   POST /public/device/poll  DeviceKeyRequest {k} -> DevicePollResponse
 *
 * Unknown, rotated and revoked links all answer `invalid`; unknown, declined and revoked keys
 * `ended`. The device key is returned once (deviceKey) when a device is created; the session
 * value only inside an `active` answer with handoff "/_/h/" (never the key, never in a URL).
 */
final class JoinController
{
    public function __construct(
        private readonly PublicBody $body,
        private readonly PublicSupport $s,
        private readonly Followers $followers,
        private readonly Devices $devices,
        private readonly Db $db,
    ) {
    }

    public function check(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $body = $this->body->read($request, 'JoinCheckRequest');
        $t = (string) $body->t;
        $this->s->limit([['ip', PublicSupport::ip($request), 60, 600], ['link', Tokens::hash($t), 30, 3600]]);
        $f = $this->followers->byLinkHash(Tokens::hash($t));
        if ($f === null) {
            return $this->s->answer($response, ['status' => 'invalid'], 'JoinCheckResponse');
        }
        $fid = (string) $f['id'];
        if ($this->s->state->isLocked()) {
            return $this->unavailable($response, 'locked', 'JoinCheckResponse');
        }
        if ($this->s->state->isRestoring()) {
            return $this->unavailable($response, 'restoring', 'JoinCheckResponse');
        }
        $device = is_string($body->k ?? null) ? $this->devices->byKey($body->k) : null;
        if ($device !== null && $device['follower_id'] === $fid) {
            if ($device['state'] === 'active') {
                $flags = $this->s->noticeFlags($device);

                return $this->s->answer($response, ['status' => 'known_device', 'noticeRequired' => $flags !== null && $flags['required']], 'JoinCheckResponse');
            }
            if ($device['state'] === 'pending') {
                return $this->s->answer($response, ['status' => 'pending_device'], 'JoinCheckResponse');
            }
        }
        $notice = $this->s->notices->current();
        if ($notice === null) {
            return $this->unavailable($response, 'notice_missing', 'JoinCheckResponse');
        }
        $mustWait = $this->devices->mustWait($fid);
        if ($mustWait && $this->devices->pendingCount($fid) >= Devices::MAX_PENDING) {
            return $this->unavailable($response, 'too_many_pending', 'JoinCheckResponse');
        }

        return $this->s->answer($response, [
            'status' => 'ok',
            'follower' => ['name' => (string) $f['name']],
            'notice' => $notice,
            'deviceMustWait' => $mustWait,
        ], 'JoinCheckResponse');
    }

    public function join(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $body = $this->body->read($request, 'JoinRequest');
        $resume = ($body->resume ?? null) === true;
        $t = is_string($body->t ?? null) ? $body->t : null;
        $k = is_string($body->k ?? null) ? $body->k : null;
        $consentVersion = is_int($body->consentVersion ?? null) ? $body->consentVersion : null;
        // JoinRequest shape (the JSON Schema cannot express it): new device = t + consentVersion;
        // resume = resume + k, without t and consentVersion.
        if ($resume ? ($k === null || $t !== null || $consentVersion !== null) : ($t === null || $consentVersion === null)) {
            throw PublicBody::invalid('A new device sends t and consentVersion; a resume sends resume and k only.');
        }
        $limits = [['ip', PublicSupport::ip($request), 60, 600]];
        if ($t !== null) {
            $limits[] = ['link', Tokens::hash($t), 30, 3600];
        }
        $this->s->limit($limits);

        if ($resume) {
            \assert($k !== null);

            return $this->resume($response, $k);
        }
        \assert($t !== null && $consentVersion !== null);
        $f = $this->followers->byLinkHash(Tokens::hash($t));
        if ($f === null) {
            return $this->s->answer($response, ['status' => 'invalid'], 'JoinResponse');
        }
        $fid = (string) $f['id'];
        $known = $k !== null ? $this->devices->byKey($k) : null;
        if ($known !== null && $known['follower_id'] === $fid) {
            if ($known['state'] === 'active') {
                \assert($k !== null);

                return $this->resume($response, $k);
            }
            if ($known['state'] === 'pending') {
                return $this->s->answer($response, ['status' => 'pending', 'pollAfterMs' => PublicSupport::pendingPollMs($known)], 'JoinResponse');
            }
        }
        if ($this->s->state->isLocked()) {
            return $this->unavailable($response, 'locked', 'JoinResponse');
        }
        if ($this->s->state->isRestoring()) {
            return $this->unavailable($response, 'restoring', 'JoinResponse');
        }
        $notice = $this->s->notices->current();
        if ($notice === null) {
            return $this->unavailable($response, 'notice_missing', 'JoinResponse');
        }
        if ($consentVersion !== $notice['version']) {
            return $this->s->answer($response, ['status' => 'consent_outdated', 'notice' => $notice], 'JoinResponse');
        }
        $this->s->limit([['join_ip', PublicSupport::ip($request), 10, 3600]]);
        $label = UserAgentLabel::of($request->getHeaderLine('User-Agent'));
        $locale = (string) $body->locale;

        $created = $this->db->write(function () use ($fid, $label, $locale, $consentVersion): ?array {
            $first = !$this->devices->mustWait($fid);
            if (!$first && $this->devices->pendingCount($fid) >= Devices::MAX_PENDING) {
                return null;
            }
            $device = $this->devices->create($fid, $label, $first);
            $this->s->consents->record($fid, $device['did'], $consentVersion, $locale);
            $sid = $first ? $this->s->sessions->issue($fid, $device['did'])['sid'] : null;

            return $device + ['first' => $first, 'sid' => $sid];
        });
        if ($created === null) {
            return $this->unavailable($response, 'too_many_pending', 'JoinResponse');
        }
        if (!$created['first'] || $created['sid'] === null) {
            $this->s->alertPendingDevicesSoon();

            return $this->s->answer($response, ['status' => 'pending', 'pollAfterMs' => 5000, 'deviceKey' => $created['key']], 'JoinResponse');
        }
        $out = $this->s->handOut($fid, $created['did'], $created['sid'], $created['key'], ['deviceKey' => $created['key']]);

        return PublicSupport::withCookies($this->s->answer($response, $out['data'], 'JoinResponse'), $out['cookies']);
    }

    public function poll(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $body = $this->body->read($request, 'DeviceKeyRequest');
        $k = (string) $body->k;
        $subject = PublicSupport::keySubject($k);
        $this->s->limit([['poll', $subject, 3, 9], ['poll_day', $subject, 1200, 86400]]);
        $d = $this->devices->byKey($k);
        if ($d === null || $d['f_kind'] !== 'person' || $d['f_state'] !== 'active' || !in_array($d['state'], ['active', 'pending'], true)) {
            return $this->s->answer($response, ['status' => 'ended'], 'DevicePollResponse');
        }
        if ($d['state'] === 'pending') {
            return $this->s->answer($response, ['status' => 'pending', 'pollAfterMs' => PublicSupport::pendingPollMs($d)], 'DevicePollResponse');
        }
        if ($this->s->state->isRestoring()) {
            return $this->unavailable($response, 'restoring', 'DevicePollResponse');
        }
        if ($this->s->state->isLocked()) {
            return $this->unavailable($response, 'locked', 'DevicePollResponse');
        }
        $fid = (string) $d['follower_id'];
        $did = (string) $d['id'];
        if (is_string($d['pending_sid']) && !\Omw\Api\Domain\Access\Sessions::pendingSidExpired($d)) {
            $out = $this->s->handOut($fid, $did, $d['pending_sid'], $k);

            return PublicSupport::withCookies($this->s->answer($response, $out['data'], 'DevicePollResponse'), $out['cookies']);
        }
        if ($d['session_hash'] !== null && !is_string($d['pending_sid'])) {
            return $this->s->answer($response, ['status' => 'active', 'handoff' => '/'], 'DevicePollResponse');
        }

        return $this->issue($response, $fid, $did, $k, 'DevicePollResponse');
    }

    private function resume(ResponseInterface $response, string $k): ResponseInterface
    {
        $d = $this->devices->byKey($k);
        if ($d === null || $d['f_kind'] !== 'person' || $d['f_state'] !== 'active' || !in_array($d['state'], ['active', 'pending'], true)) {
            return $this->s->answer($response, ['status' => 'ended'], 'JoinResponse');
        }
        if ($d['state'] === 'pending') {
            return $this->s->answer($response, ['status' => 'pending', 'pollAfterMs' => PublicSupport::pendingPollMs($d)], 'JoinResponse');
        }
        if ($this->s->state->isLocked()) {
            return $this->unavailable($response, 'locked', 'JoinResponse');
        }
        if ($this->s->state->isRestoring()) {
            return $this->unavailable($response, 'restoring', 'JoinResponse');
        }

        return $this->issue($response, (string) $d['follower_id'], (string) $d['id'], $k, 'JoinResponse');
    }

    private function issue(ResponseInterface $response, string $fid, string $did, string $k, string $schema): ResponseInterface
    {
        $sid = $this->s->sessions->issue($fid, $did)['sid'];
        $out = $this->s->handOut($fid, $did, $sid, $k);

        return PublicSupport::withCookies($this->s->answer($response, $out['data'], $schema), $out['cookies']);
    }

    private function unavailable(ResponseInterface $response, string $reason, string $schema): ResponseInterface
    {
        return $this->s->answer($response, ['status' => 'unavailable', 'reason' => $reason], $schema);
    }
}
