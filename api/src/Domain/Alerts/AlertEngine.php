<?php

declare(strict_types=1);

namespace Omw\Api\Domain\Alerts;

use DateTimeImmutable;
use Omw\Api\Config;
use Omw\Api\Domain\BackendStatus;
use Omw\Api\Domain\Settings;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;
use Psr\Log\LoggerInterface;
use stdClass;
use Throwable;

/**
 * Alert state machine, run by cron (bin/cron.php or the web-cron endpoint) every few minutes.
 *
 * Per kind there is at most one open alert (alerts_one_open_per_kind):
 *
 *   condition true,  no open alert   -> open it, notify ("ALERT …")
 *   condition true,  open alert      -> re-notify every ALERT_REPEAT_MINUTES (message refreshed)
 *   condition false, open alert      -> resolve it; if anything was delivered for it, send a
 *                                       "resolved" notice (retried on later runs until it went out)
 *
 * A notification that fails on every configured channel is retried on the next run (the
 * alert's last_notified_at is not advanced). With no channel configured the alert is still
 * recorded and shown in the admin status.
 *
 * Kinds: heartbeat_stale (critical), wa_logged_out (critical), wa_banned (critical),
 * publish_failing (warning; critical when the Mac's post-deploy gate check found the gate open).
 * publish_failing only looks at targets the backend still reports (BackendStatus: stale targets
 * were removed or renamed); when it resolves because its failing targets went stale, the alert's
 * message says so ("no longer reported").
 *
 * Access (spec-wave5 §3.9; messages never contain names): devices_pending (warning, resolves when
 * none waits), access_store_failing (critical: a store op pending for 10 minutes or an SFTP auth
 * block), access_store_unverified (critical: marker missing or foreign, heartbeat storeDir differs
 * from ACCESS_STORE_DIR, store proof or gate check failed), access_store_mismatch (warning: the
 * last reconcile found active sessions without a file), site_origin_mismatch (warning),
 * public_flood (warning: the global public cap was hit within the hour), site_gate_open
 * (critical: the API's own anonymous probe got through).
 */
final class AlertEngine
{
    public const KINDS = [
        'heartbeat_stale', 'wa_logged_out', 'wa_banned', 'publish_failing',
        'devices_pending', 'access_store_failing', 'access_store_unverified', 'access_store_mismatch',
        'site_origin_mismatch', 'public_flood', 'site_gate_open',
    ];

    /** A store op pending this long raises access_store_failing. */
    public const STORE_FAILING_MINUTES = 10;

    public function __construct(
        private readonly Db $db,
        private readonly BackendStatus $status,
        private readonly Settings $settings,
        private readonly Notifier $notifier,
        private readonly Config $config,
        private readonly ?LoggerInterface $logger = null,
    ) {
    }

    /**
     * @param list<string>|null $only evaluate only these kinds (e.g. devices_pending right after a join)
     * @return array{opened: list<string>, repeated: list<string>, resolved: list<string>, failed: list<string>}
     */
    public function run(?DateTimeImmutable $now = null, ?array $only = null): array
    {
        $now ??= Clock::now();
        $nowIso = Clock::iso($now);
        $result = ['opened' => [], 'repeated' => [], 'resolved' => [], 'failed' => []];
        $conditions = $this->conditions($now);
        $repeatBefore = Clock::iso($now->modify('-' . $this->config->alertRepeatMinutes . ' minutes'));

        foreach (self::KINDS as $kind) {
            if ($only !== null && !in_array($kind, $only, true)) {
                continue;
            }
            $condition = $conditions[$kind] ?? null;
            $open = $this->db->one("SELECT * FROM alerts WHERE kind = ? AND state = 'open'", [$kind]);

            if ($condition !== null && $open === null) {
                $id = $this->db->write(function () use ($kind, $condition, $nowIso): int {
                    $this->db->exec(
                        "INSERT INTO alerts (kind, severity, state, message, details, opened_at) VALUES (?, ?, 'open', ?, ?, ?)",
                        [$kind, $condition['severity'], $condition['message'], json_encode($condition['details'], JSON_THROW_ON_ERROR), $nowIso],
                    );

                    return (int) $this->db->pdo()->lastInsertId();
                });
                $result['opened'][] = $kind;
                if (!$this->notify($id, new Notification($kind, $condition['severity'], self::title($kind, false), $condition['message'], false, $nowIso), $nowIso)) {
                    $result['failed'][] = $kind;
                }
            } elseif ($condition !== null && $open !== null) {
                $id = (int) $open['id'];
                if ($open['message'] !== $condition['message'] || $open['severity'] !== $condition['severity']) {
                    $this->db->write(fn (): int => $this->db->exec(
                        'UPDATE alerts SET message = ?, severity = ?, details = ? WHERE id = ?',
                        [$condition['message'], $condition['severity'], json_encode($condition['details'], JSON_THROW_ON_ERROR), $id],
                    ));
                }
                $last = $open['last_notified_at'];
                if ($last === null || (string) $last <= $repeatBefore) {
                    if ($this->notify($id, new Notification($kind, $condition['severity'], self::title($kind, false), $condition['message'], false, (string) $open['opened_at']), $nowIso)) {
                        $result['repeated'][] = $kind;
                    } else {
                        $result['failed'][] = $kind;
                    }
                }
            } elseif ($open !== null) {
                $note = $this->resolveNote($kind, $open);
                $this->db->write(fn (): int => $this->db->exec(
                    "UPDATE alerts SET state = 'resolved', resolved_at = ?, message = ? WHERE id = ?",
                    [$nowIso, (string) $open['message'] . ($note === null ? '' : ' ' . $note), (int) $open['id']],
                ));
                $result['resolved'][] = $kind;
            }
        }

        // "Resolved" notices (also retries of ones that could not be delivered before).
        $pending = $this->db->all(
            "SELECT * FROM alerts WHERE state = 'resolved' AND resolved_notified_at IS NULL AND notify_count > 0 AND resolved_at >= ?",
            [Clock::iso($now->modify('-2 days'))],
        );
        foreach ($pending as $alert) {
            $notification = new Notification(
                (string) $alert['kind'],
                (string) $alert['severity'],
                self::title((string) $alert['kind'], true),
                'Resolved: ' . (string) $alert['message'],
                true,
                (string) $alert['resolved_at'],
            );
            try {
                $this->notifier->send($notification);
                $this->db->write(fn (): int => $this->db->exec('UPDATE alerts SET resolved_notified_at = ? WHERE id = ?', [$nowIso, (int) $alert['id']]));
            } catch (Throwable $e) {
                $this->logger?->error('Resolved notice for {kind} failed: {error}', ['kind' => $alert['kind'], 'error' => $e->getMessage()]);
                $result['failed'][] = (string) $alert['kind'];
            }
        }

        if ($result['opened'] !== [] || $result['resolved'] !== []) {
            $this->logger?->notice('Alerts changed', $result);
        }

        return $result;
    }

    /**
     * Current conditions: kind => {severity, message, details} for every kind that is firing.
     *
     * @return array<string, array{severity: string, message: string, details: array<string, mixed>}>
     */
    public function conditions(DateTimeImmutable $now): array
    {
        $out = [];
        $heartbeat = $this->status->lastHeartbeat();
        if ($heartbeat !== null) {
            $staleMinutes = $this->settings->get('alerts.heartbeat_stale_minutes');
            $staleMinutes = is_int($staleMinutes) ? $staleMinutes : 15;
            $age = (int) floor(($now->getTimestamp() - (new DateTimeImmutable($heartbeat['receivedAt']))->getTimestamp()) / 60);
            if ($age >= $staleMinutes) {
                $out['heartbeat_stale'] = [
                    'severity' => 'critical',
                    'message' => sprintf('No heartbeat from the backend for %d minutes (last one at %s). Captures and publishing may have stopped.', $age, $heartbeat['receivedAt']),
                    'details' => ['lastSeenAt' => $heartbeat['receivedAt'], 'minutes' => $age],
                ];
            }
            $wa = $heartbeat['heartbeat']->wa ?? null;
            $waState = $heartbeat['waState'];
            if ($waState === 'logged_out') {
                $out['wa_logged_out'] = [
                    'severity' => 'critical',
                    'message' => 'WhatsApp logged the backend out (linked device removed or expired). Relink it in the control UI.',
                    'details' => ['since' => $heartbeat['receivedAt']],
                ];
            }
            if ($waState === 'banned') {
                $until = $wa instanceof stdClass && is_string($wa->until ?? null) ? $wa->until : null;
                $out['wa_banned'] = [
                    'severity' => 'critical',
                    'message' => 'WhatsApp temporarily banned the observer account' . ($until !== null ? " until $until" : '') . '. Capturing is paused.',
                    'details' => ['until' => $until],
                ];
            }
        }

        $threshold = $this->config->publishFailThreshold;
        $failing = [];
        foreach ($this->status->publishStatus() as $target) {
            if ((int) $target['consecutiveFailures'] >= $threshold) {
                $failing[] = $target;
            }
        }
        if ($failing !== []) {
            $parts = [];
            foreach ($failing as $t) {
                $parts[] = sprintf(
                    '%s failed %d times in a row%s',
                    (string) $t['target'],
                    (int) $t['consecutiveFailures'],
                    is_string($t['error'] ?? null) ? ' (' . mb_substr((string) $t['error'], 0, 200) . ')' : '',
                );
            }
            $out['publish_failing'] = [
                'severity' => 'warning',
                'message' => 'Publishing keeps failing: ' . implode('; ', $parts) . '.',
                'details' => ['targets' => array_map(static fn (array $t): string => (string) $t['target'], $failing)],
            ];
        }

        return $this->accessConditions($now, $heartbeat, $out);
    }

    /**
     * @param array{heartbeat: stdClass, receivedAt: string, waState: string|null}|null $heartbeat
     * @param array<string, array{severity: string, message: string, details: array<string, mixed>}> $out
     * @return array<string, array{severity: string, message: string, details: array<string, mixed>}>
     */
    private function accessConditions(DateTimeImmutable $now, ?array $heartbeat, array $out): array
    {
        $state = $this->db->one('SELECT * FROM access_state WHERE id = 1');
        if ($state === null) {
            return $out;
        }
        $pending = (int) $this->db->scalar(
            "SELECT COUNT(*) FROM devices d JOIN followers f ON f.id = d.follower_id WHERE d.state = 'pending' AND f.kind = 'person' AND f.state = 'active'",
        );
        if ($pending > 0) {
            $out['devices_pending'] = [
                'severity' => 'warning',
                'message' => $pending === 1 ? '📱 1 neues Gerät wartet auf deine Bestätigung.' : sprintf('📱 %d neue Geräte warten auf deine Bestätigung.', $pending),
                'details' => ['count' => $pending],
            ];
        }

        $oldest = $this->db->scalar('SELECT MIN(created_at) FROM store_ops WHERE applied_at IS NULL');
        $blocked = $state['writer_blocked_at'] ?? null;
        if ($blocked !== null || (is_string($oldest) && $oldest <= Clock::iso($now->modify('-' . self::STORE_FAILING_MINUTES . ' minutes')))) {
            $out['access_store_failing'] = [
                'severity' => 'critical',
                'message' => $blocked !== null
                    ? 'The website store writer is blocked: the SFTP login was refused. Check the login, then press "Retry" in the admin.'
                    : sprintf('Access changes are not reaching the website (oldest pending since %s). Revocations and locks are not in effect yet.', (string) $oldest),
                'details' => ['oldestPendingAt' => $oldest, 'blocked' => $blocked !== null],
            ];
        }

        $unverified = [];
        $error = $state['writer_error'] ?? null;
        if (is_string($error) && str_starts_with($error, 'store_unverified')) {
            $unverified[] = mb_substr($error, 0, 200);
        }
        $site = $heartbeat !== null && ($heartbeat['heartbeat']->site ?? null) instanceof stdClass ? $heartbeat['heartbeat']->site : null;
        if ($site !== null && $this->config->access->storeMode === 'direct' && is_string($site->storeDir ?? null) && $site->storeDir !== $this->config->access->storeDir) {
            $unverified[] = 'the backend\'s store folder differs from the API\'s ACCESS_STORE_DIR';
        }
        $check = is_string($state['gate_check'] ?? null) ? json_decode($state['gate_check'], true) : null;
        $check = is_array($check) ? $check : [];
        if (($check['result'] ?? null) === 'store_unverified') {
            $unverified[] = 'gate check: ' . (is_string($check['detail'] ?? null) ? $check['detail'] : 'store unverified');
        }
        if ($this->db->scalar("SELECT value FROM meta WHERE key = 'store_proof_failed_at'") !== null && ($check['result'] ?? null) !== 'store_unverified') {
            $unverified[] = 'the last store proof failed';
        }
        if ($unverified !== []) {
            $out['access_store_unverified'] = [
                'severity' => 'critical',
                'message' => 'The website store is not verified: ' . implode('; ', $unverified) . '. Revocations may not take effect.',
                'details' => ['reasons' => $unverified],
            ];
        }

        $report = is_string($state['reconcile_report'] ?? null) ? json_decode($state['reconcile_report'], true) : null;
        $missing = is_array($report) && is_array($report['missing'] ?? null) ? count($report['missing']) : 0;
        if ($missing > 0) {
            $out['access_store_mismatch'] = [
                'severity' => 'warning',
                'message' => sprintf('%d device session(s) are missing from the website store; those devices rejoin automatically with their key.', $missing),
                'details' => ['missing' => $missing],
            ];
        }

        if ($site !== null && is_string($site->origin ?? null) && $this->config->siteOrigin !== '' && $site->origin !== $this->config->siteOrigin) {
            $out['site_origin_mismatch'] = [
                'severity' => 'warning',
                'message' => sprintf('The backend publishes for %s, but the API\'s SITE_ORIGIN is %s.', $site->origin, $this->config->siteOrigin),
                'details' => ['backend' => $site->origin, 'api' => $this->config->siteOrigin],
            ];
        }

        $flood = $this->db->scalar("SELECT value FROM meta WHERE key = 'public_flood_at'");
        if (is_string($flood) && $flood > Clock::iso($now->modify('-1 hour'))) {
            $out['public_flood'] = [
                'severity' => 'warning',
                'message' => 'The public join routes were flooded; joins are refused for up to an hour. Viewing the site is not affected.',
                'details' => ['at' => $flood],
            ];
        }

        if (($check['result'] ?? null) === 'gate_open') {
            $detail = is_string($check['detail'] ?? null) ? ' (' . $check['detail'] . ')' : '';
            if (($check['by'] ?? null) === 'api') {
                $out['site_gate_open'] = [
                    'severity' => 'critical',
                    'message' => 'The website answered an anonymous request with content: the access gate is open' . $detail . '.',
                    'details' => ['at' => $check['at'] ?? null],
                ];
            } else {
                $out['publish_failing'] = [
                    'severity' => 'critical',
                    'message' => 'The post-deploy check found the access gate open' . $detail . '. Publish again or lock the site.',
                    'details' => ['targets' => [], 'gateCheck' => $check['at'] ?? null],
                ];
            }
        }

        return $out;
    }

    /**
     * Why an open alert resolves when it is not simply "the condition cleared": for
     * publish_failing, the failing targets that are no longer reported (stale or deleted).
     *
     * @param array<string, mixed> $open
     */
    private function resolveNote(string $kind, array $open): ?string
    {
        if ($kind !== 'publish_failing') {
            return null;
        }
        $details = is_string($open['details'] ?? null) ? json_decode($open['details'], true) : null;
        $targets = is_array($details) && is_array($details['targets'] ?? null) ? array_filter($details['targets'], 'is_string') : [];
        $reported = array_diff($this->status->knownTargets(), $this->status->staleTargets());
        $gone = array_values(array_diff($targets, $reported));
        if ($gone === []) {
            return null;
        }
        sort($gone, SORT_STRING);

        return sprintf('Target%s no longer reported: %s.', count($gone) > 1 ? 's' : '', implode(', ', $gone));
    }

    private function notify(int $id, Notification $notification, string $nowIso): bool
    {
        try {
            $delivered = $this->notifier->send($notification);
        } catch (Throwable $e) {
            $this->logger?->error('Alert {kind} could not be delivered: {error}', ['kind' => $notification->kind, 'error' => $e->getMessage()]);

            return false;
        }
        $this->db->write(fn (): int => $this->db->exec(
            'UPDATE alerts SET last_notified_at = ?, notify_count = notify_count + ? WHERE id = ?',
            [$nowIso, $delivered > 0 ? 1 : 0, $id],
        ));

        return true;
    }

    private static function title(string $kind, bool $resolved): string
    {
        $what = match ($kind) {
            'heartbeat_stale' => 'Backend heartbeat missing',
            'wa_logged_out' => 'WhatsApp logged out',
            'wa_banned' => 'WhatsApp ban',
            'publish_failing' => 'Publishing failing',
            'devices_pending' => 'Neues Gerät wartet',
            'access_store_failing' => 'Access changes not applied',
            'access_store_unverified' => 'Website store not verified',
            'access_store_mismatch' => 'Website store differs',
            'site_origin_mismatch' => 'Site origin differs',
            'public_flood' => 'Public routes flooded',
            'site_gate_open' => 'Access gate open',
            default => $kind,
        };

        return ($resolved ? '[On My Way] Resolved: ' : '[On My Way] ALERT: ') . $what;
    }
}
