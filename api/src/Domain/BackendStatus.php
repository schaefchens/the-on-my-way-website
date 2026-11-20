<?php

declare(strict_types=1);

namespace Omw\Api\Domain;

use DateTimeImmutable;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;
use stdClass;

/**
 * Heartbeats and publish reports of the backend, and the admin's status view (contract
 * StatusResponse). received_at is always the API's own clock: alerting never trusts the
 * backend's clock.
 *
 * Publish targets: the backend reports every target after each deploy (ok or failed). A target
 * whose last report is more than {@see STALE_TARGET_DAYS} days older than the newest report of
 * another target was removed or renamed in the backend: it is "stale", left out of
 * StatusResponse.publish and of the publish_failing alert, and cron deletes its row once its last
 * report is {@see STALE_TARGET_PRUNE_DAYS} days old. With a single target (or when the backend
 * stopped reporting altogether) nothing is stale: that is heartbeat_stale's business.
 */
final class BackendStatus
{
    /** Resolved alerts stay visible in the status view this long. */
    public const RESOLVED_VISIBLE_HOURS = 24;

    public const STALE_TARGET_DAYS = 7;
    public const STALE_TARGET_PRUNE_DAYS = 30;

    public function __construct(private readonly Db $db)
    {
    }

    /** POST /backend/heartbeat (body schema-valid against Heartbeat). */
    public function recordHeartbeat(stdClass $heartbeat): void
    {
        $state = isset($heartbeat->wa) && $heartbeat->wa instanceof stdClass && is_string($heartbeat->wa->state ?? null) ? $heartbeat->wa->state : null;
        $version = is_string($heartbeat->backendVersion ?? null) ? $heartbeat->backendVersion : null;
        $this->db->write(fn (): int => $this->db->exec(
            'INSERT INTO backend_status (id, heartbeat, wa_state, backend_version, received_at) VALUES (1, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET heartbeat = excluded.heartbeat, wa_state = excluded.wa_state,
                backend_version = excluded.backend_version, received_at = excluded.received_at',
            [Captures::encode($heartbeat), $state, $version, Clock::nowIso()],
        ));
    }

    /**
     * POST /backend/published (body schema-valid against PublishedReport). Reports older than
     * the stored one of the same target (by "at") are ignored, so retries never roll back.
     *
     * @return bool false when the report was older than the stored one
     */
    public function recordPublished(stdClass $report): bool
    {
        $target = (string) $report->target;
        $at = Time::toIsoUtc((string) $report->at);
        $ok = $report->ok === true;

        return $this->db->write(function () use ($report, $target, $at, $ok): bool {
            $row = $this->db->one('SELECT at, last_ok_at, consecutive_failures FROM publish_status WHERE target = ?', [$target]);
            if ($row !== null && Time::millis((string) $row['at']) > Time::millis($at)) {
                return false;
            }
            $sameReport = $row !== null && Time::millis((string) $row['at']) === Time::millis($at);
            $failures = $ok ? 0 : ($row === null ? 1 : (int) $row['consecutive_failures'] + ($sameReport ? 0 : 1));
            $lastOk = $ok ? $at : ($row['last_ok_at'] ?? null);
            $this->db->exec(
                'INSERT INTO publish_status (target, report, version, ok, at, last_ok_at, consecutive_failures, received_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (target) DO UPDATE SET report = excluded.report, version = excluded.version, ok = excluded.ok,
                    at = excluded.at, last_ok_at = excluded.last_ok_at, consecutive_failures = excluded.consecutive_failures,
                    received_at = excluded.received_at',
                [$target, Captures::encode($report), (int) $report->version, $ok ? 1 : 0, $at, $lastOk, $failures, Clock::nowIso()],
            );

            return true;
        });
    }

    /** @return array{heartbeat: stdClass, receivedAt: string, waState: string|null}|null */
    public function lastHeartbeat(): ?array
    {
        $row = $this->db->one('SELECT heartbeat, received_at, wa_state FROM backend_status WHERE id = 1');
        if ($row === null) {
            return null;
        }
        $heartbeat = Captures::decode((string) $row['heartbeat']);

        return $heartbeat instanceof stdClass
            ? ['heartbeat' => $heartbeat, 'receivedAt' => (string) $row['received_at'], 'waState' => $row['wa_state'] === null ? null : (string) $row['wa_state']]
            : null;
    }

    /**
     * Contract TargetPublishStatus per target that is still reported (not stale), ordered by
     * target name.
     *
     * @return list<array<string, mixed>>
     */
    public function publishStatus(): array
    {
        $stale = array_flip($this->staleTargets());
        $out = [];
        foreach ($this->db->all('SELECT * FROM publish_status ORDER BY target') as $row) {
            if (isset($stale[(string) $row['target']])) {
                continue;
            }
            $report = Captures::decode((string) $row['report']);
            if (!$report instanceof stdClass) {
                continue;
            }
            $item = get_object_vars($report);
            $item['lastOkAt'] = $row['last_ok_at'] === null ? null : (string) $row['last_ok_at'];
            $item['consecutiveFailures'] = (int) $row['consecutive_failures'];
            $item['receivedAt'] = (string) $row['received_at'];
            $out[] = $item;
        }

        return $out;
    }

    /**
     * Targets the backend no longer reports (see the class comment), ordered by name.
     *
     * @return list<string>
     */
    public function staleTargets(): array
    {
        $rows = $this->db->all('SELECT target, received_at FROM publish_status ORDER BY target');
        if (count($rows) < 2) {
            return [];
        }
        $newest = max(array_map(static fn (array $r): int => Time::millis((string) $r['received_at']), $rows));
        $limit = self::STALE_TARGET_DAYS * 86_400_000;
        $out = [];
        foreach ($rows as $row) {
            if ($newest - Time::millis((string) $row['received_at']) > $limit) {
                $out[] = (string) $row['target'];
            }
        }

        return $out;
    }

    /**
     * Names of all targets with a stored report (stale ones included).
     *
     * @return list<string>
     */
    public function knownTargets(): array
    {
        return array_map(static fn (array $r): string => (string) $r['target'], $this->db->all('SELECT target FROM publish_status ORDER BY target'));
    }

    /**
     * Cron: deletes the rows of stale targets whose last report is older than
     * {@see STALE_TARGET_PRUNE_DAYS} days. Returns the number of rows deleted.
     */
    public function pruneStaleTargets(DateTimeImmutable $now): int
    {
        $stale = $this->staleTargets();
        if ($stale === []) {
            return 0;
        }
        $before = Clock::iso($now->modify('-' . self::STALE_TARGET_PRUNE_DAYS . ' days'));

        return $this->db->write(function () use ($stale, $before): int {
            $deleted = 0;
            foreach ($stale as $target) {
                $deleted += $this->db->exec('DELETE FROM publish_status WHERE target = ? AND received_at < ?', [$target, $before]);
            }

            return $deleted;
        });
    }

    /** @return array<string, mixed> StatusResponse */
    public function status(): array
    {
        $heartbeat = $this->lastHeartbeat();
        $alerts = [];
        $visibleFrom = Clock::iso(Clock::now()->modify('-' . self::RESOLVED_VISIBLE_HOURS . ' hours'));
        foreach ($this->db->all(
            "SELECT kind, severity, message, opened_at, resolved_at FROM alerts
             WHERE state = 'open' OR resolved_at >= ? ORDER BY state = 'open' DESC, opened_at DESC",
            [$visibleFrom],
        ) as $row) {
            $alerts[] = [
                'kind' => (string) $row['kind'],
                'severity' => (string) $row['severity'],
                'message' => (string) $row['message'],
                'since' => (string) $row['opened_at'],
                'resolvedAt' => $row['resolved_at'] === null ? null : (string) $row['resolved_at'],
            ];
        }

        return [
            'backend' => $heartbeat['heartbeat'] ?? null,
            'lastSeenAt' => $heartbeat['receivedAt'] ?? null,
            'publish' => $this->publishStatus(),
            'alerts' => $alerts,
        ];
    }
}
