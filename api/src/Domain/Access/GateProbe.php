<?php

declare(strict_types=1);

namespace Omw\Api\Domain\Access;

use DateTimeImmutable;
use Omw\Api\Config;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;
use Omw\Api\Infra\HttpClient;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * The API's own look at the site (ACCESS_GATE_PROBE=true, P0b-6; spec-wave5 §3.9 step 6), the
 * primary detector while the Mac's checks are blind:
 * - once per hour: GET <SITE_ORIGIN>/<random 20>/data/x.json without cookies must be 403 with the
 *   body "Forbidden\n" (else gate_open → critical alert site_gate_open);
 * - once per 6 h, only when the API writes the store itself: the store proof. Two service
 *   sessions are issued one after the other (the second rotates the first); GET <SITE_ORIGIN>/
 *   with the new cookie must be 302 (the gate sends followers on) and with the old one 200 (the
 *   neutral page). Only that proves the writer writes the folder Apache reads; on success
 *   access_state.store_proof_at is set, else access_store_unverified (critical).
 * At most three requests per hour, none to a dot path. Results are stored like the Mac's gate
 * check (access_state.gate_check, by "api").
 */
final class GateProbe
{
    public const ANON_EVERY_SECONDS = 3600;
    public const PROOF_EVERY_SECONDS = 6 * 3600;

    public function __construct(
        private readonly Config $config,
        private readonly HttpClient $http,
        private readonly Db $db,
        private readonly AccessState $state,
        private readonly Followers $followers,
        private readonly Sessions $sessions,
        private readonly StoreApplier $applier,
        private readonly StoreOps $ops,
        private readonly ?LoggerInterface $logger = null,
    ) {
    }

    /** @return array<string, mixed> */
    public function run(DateTimeImmutable $now): array
    {
        $origin = $this->config->siteOrigin;
        if (!$this->config->access->gateProbe || !StoreLayout::isOrigin($origin)) {
            return ['skipped' => true];
        }
        $out = [];
        if ($this->due('gate_probe_at', self::ANON_EVERY_SECONDS, $now)) {
            $out['anonymous'] = $this->anonymous($origin, $now);
        }
        $proofAt = $this->state->row()['store_proof_at'] ?? null;
        $proofTried = $this->db->scalar("SELECT value FROM meta WHERE key = 'store_proof_tried_at'");
        $last = max(is_string($proofAt) ? $proofAt : '', is_string($proofTried) ? $proofTried : '');
        if ($this->config->access->apiWrites() && ($last === '' || $last < Clock::iso($now->modify('-' . self::PROOF_EVERY_SECONDS . ' seconds')))) {
            $this->setMeta('store_proof_tried_at', Clock::iso($now));
            $out['storeProof'] = $this->storeProof($origin, $now);
        }

        return $out;
    }

    private function anonymous(string $origin, DateTimeImmutable $now): string
    {
        $this->setMeta('gate_probe_at', Clock::iso($now));
        $folder = '';
        for ($i = 0; $i < 20; ++$i) {
            $folder .= 'abcdefghijklmnopqrstuvwxyz0123456789'[random_int(0, 35)];
        }
        try {
            $res = $this->http->request('GET', $origin . '/' . $folder . '/data/x.json', [], null, 10.0);
            $result = $res['status'] === 403 && $res['body'] === "Forbidden\n" ? 'ok' : 'gate_open';
            $detail = $result === 'ok' ? null : 'anonymous data request answered HTTP ' . $res['status'];
        } catch (Throwable $e) {
            $result = 'error';
            $detail = mb_substr($e->getMessage(), 0, 300);
        }
        $this->state->recordGateCheck(['at' => Clock::iso($now), 'by' => 'api', 'result' => $result, 'detail' => $detail]);

        return $result;
    }

    private function storeProof(string $origin, DateTimeImmutable $now): string
    {
        $cookie = StoreLayout::gateCookies($origin, $this->config->access->cookieMode)['session'];
        try {
            $service = $this->followers->service();
            $old = $this->issueApplied($service['fid'], $service['did']);
            $new = $this->issueApplied($service['fid'], $service['did']);
            if ($old === null || $new === null) {
                return 'skipped'; // the writer did not apply in time: try again at the next run
            }
            $accepted = $this->http->request('GET', $origin . '/', ['Cookie' => $cookie . '=' . $new], null, 10.0)['status'];
            $refused = $this->http->request('GET', $origin . '/', ['Cookie' => $cookie . '=' . $old], null, 10.0)['status'];
        } catch (Throwable $e) {
            $this->logger?->warning('Store proof failed: {error}', ['error' => StoreLayout::redactText($e->getMessage())]);

            return 'error';
        }
        if ($accepted === 302 && $refused === 200) {
            $this->db->write(fn (): int => $this->db->exec('UPDATE access_state SET store_proof_at = ?, updated_at = ? WHERE id = 1', [Clock::iso($now), Clock::nowIso()]));
            $this->db->write(fn (): int => $this->db->exec("DELETE FROM meta WHERE key = 'store_proof_failed_at'"));

            return 'ok';
        }
        $this->setMeta('store_proof_failed_at', Clock::iso($now));
        $this->state->recordGateCheck([
            'at' => Clock::iso($now),
            'by' => 'api',
            'result' => 'store_unverified',
            'detail' => sprintf('store proof: new session answered %d (want 302), old one %d (want 200)', $accepted, $refused),
        ]);

        return 'store_unverified';
    }

    /** Issues a service session and applies it; the cookie value, or null when not applied in time. */
    private function issueApplied(string $fid, string $did): ?string
    {
        $sid = $this->sessions->issue($fid, $did, true)['sid'];
        $this->applier->applyNow(20.0);
        if ($this->ops->pendingForDevice($fid, $did)) {
            return null;
        }
        $this->sessions->clearPendingSid($did);

        return StoreLayout::gateCookieValue($fid, $did, $sid);
    }

    private function due(string $key, int $seconds, DateTimeImmutable $now): bool
    {
        $at = $this->db->scalar('SELECT value FROM meta WHERE key = ?', [$key]);

        return !is_string($at) || $at <= Clock::iso($now->modify("-$seconds seconds"));
    }

    private function setMeta(string $key, string $value): void
    {
        $this->db->write(fn (): int => $this->db->exec(
            'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
            [$key, $value],
        ));
    }
}
