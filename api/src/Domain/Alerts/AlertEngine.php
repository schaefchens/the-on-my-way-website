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
 * publish_failing (warning). publish_failing only looks at targets the backend still reports
 * (BackendStatus: stale targets were removed or renamed); when it resolves because its failing
 * targets went stale, the alert's message says so ("no longer reported").
 */
final class AlertEngine
{
    public const KINDS = ['heartbeat_stale', 'wa_logged_out', 'wa_banned', 'publish_failing'];

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
     * @return array{opened: list<string>, repeated: list<string>, resolved: list<string>, failed: list<string>}
     */
    public function run(?DateTimeImmutable $now = null): array
    {
        $now ??= Clock::now();
        $nowIso = Clock::iso($now);
        $result = ['opened' => [], 'repeated' => [], 'resolved' => [], 'failed' => []];
        $conditions = $this->conditions($now);
        $repeatBefore = Clock::iso($now->modify('-' . $this->config->alertRepeatMinutes . ' minutes'));

        foreach (self::KINDS as $kind) {
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
            default => $kind,
        };

        return ($resolved ? '[On My Way] Resolved: ' : '[On My Way] ALERT: ') . $what;
    }
}
