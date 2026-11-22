<?php

declare(strict_types=1);

namespace Omw\Api\Domain\Access;

use Omw\Api\Config;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;

/**
 * The single access_state row (spec-wave5 §3.2): lock, epoch, writer state, the newest gate
 * check, and the counts-only AccessSummary for the admin's status (persisted in IndexedDB, so it
 * never contains a name).
 *
 * Lock (Q6): {@see lock()} writes the store's `locked` file through an op; {@see unlock()} (after
 * the password check of the caller) deletes it and records unlocked_at, which the sticky-lock rule
 * of the reconciler compares with the lock file's own time (§3.3 Lock 4).
 */
final class AccessState
{
    public function __construct(
        private readonly Db $db,
        private readonly Config $config,
        private readonly StoreOps $ops,
    ) {
    }

    /** @return array<string, mixed> */
    public function row(): array
    {
        return $this->db->one('SELECT * FROM access_state WHERE id = 1') ?? [];
    }

    public function isLocked(): bool
    {
        return (int) ($this->row()['locked'] ?? 0) === 1;
    }

    /** True from a restore of the API database until its restored_api reconcile ran (§3.8.6). */
    public function isRestoring(): bool
    {
        $row = $this->row();

        return ($row['reconciled_epoch'] ?? null) !== ($row['epoch'] ?? null);
    }

    /**
     * Locks the site for everyone (idempotent: an existing lock keeps its time and author).
     *
     * @return int the highest op id of this action (0 = nothing to write)
     */
    public function lock(string $by): int
    {
        return $this->db->write(function () use ($by): int {
            if ($this->isLocked()) {
                return 0;
            }
            $now = Clock::nowIso();
            $this->db->exec('UPDATE access_state SET locked = 1, locked_at = ?, locked_by = ?, updated_at = ? WHERE id = 1', [$now, $by, $now]);

            return $this->ops->enqueue('put', StoreLayout::LOCKED, StoreOps::json(['at' => $now, 'by' => $by]));
        });
    }

    /** Unlocks (the caller verified the owner's password). @return int highest op id */
    public function unlock(): int
    {
        return $this->db->write(function (): int {
            $now = Clock::nowIso();
            $this->db->exec('UPDATE access_state SET locked = 0, locked_at = NULL, locked_by = NULL, unlocked_at = ?, updated_at = ? WHERE id = 1', [$now, $now]);

            return $this->ops->enqueue('delete', StoreLayout::LOCKED);
        });
    }

    public function setPanicHash(?string $hash): void
    {
        $this->db->write(fn (): int => $this->db->exec('UPDATE access_state SET panic_hash = ?, updated_at = ? WHERE id = 1', [$hash, Clock::nowIso()]));
    }

    public function panicMatches(string $key): bool
    {
        $hash = $this->row()['panic_hash'] ?? null;

        return is_string($hash) && hash_equals($hash, Tokens::hash($key));
    }

    /**
     * Stores the newest gate check (the Mac's post-deploy check or the API's own probe).
     *
     * @param array{at: string, by: string, result: string, detail: string|null} $check
     */
    public function recordGateCheck(array $check): void
    {
        $this->db->write(function () use ($check): void {
            $current = $this->gateCheck();
            if ($current !== null && $current['at'] > $check['at']) {
                return;
            }
            $this->db->exec('UPDATE access_state SET gate_check = ?, updated_at = ? WHERE id = 1', [json_encode($check, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES), Clock::nowIso()]);
        });
    }

    /** @return array{at: string, by: string, result: string, detail: string|null}|null */
    public function gateCheck(): ?array
    {
        $raw = $this->row()['gate_check'] ?? null;
        $data = is_string($raw) ? json_decode($raw, true) : null;
        if (!is_array($data) || !is_string($data['at'] ?? null) || !is_string($data['by'] ?? null) || !is_string($data['result'] ?? null)) {
            return null;
        }

        return ['at' => $data['at'], 'by' => $data['by'], 'result' => $data['result'], 'detail' => is_string($data['detail'] ?? null) ? $data['detail'] : null];
    }

    /** @return array<string, mixed>|null StoreReport of the last reconcile */
    public function reconcileReport(): ?array
    {
        $raw = $this->row()['reconcile_report'] ?? null;
        $data = is_string($raw) ? json_decode($raw, true) : null;

        return is_array($data) ? $data : null;
    }

    /** True when the writer refuses the store (marker missing or foreign, heartbeat storeDir differs). */
    public function storeUnverified(): bool
    {
        $error = $this->row()['writer_error'] ?? null;

        return is_string($error) && str_starts_with($error, 'store_unverified');
    }

    /** @return array<string, mixed> contract AccessSummary (counts only) */
    public function summary(): array
    {
        $row = $this->row();
        $report = $this->reconcileReport();
        $version = $this->db->scalar('SELECT MAX(version) FROM privacy_notice_versions');

        return [
            'locked' => (int) ($row['locked'] ?? 0) === 1,
            'lockedAt' => self::str($row['locked_at'] ?? null),
            'lockedBy' => self::str($row['locked_by'] ?? null),
            'pendingDevices' => (int) $this->db->scalar(
                "SELECT COUNT(*) FROM devices d JOIN followers f ON f.id = d.follower_id WHERE d.state = 'pending' AND f.kind = 'person' AND f.state = 'active'",
            ),
            'pendingOps' => $this->ops->pendingCount(),
            'oldestPendingOpAt' => $this->ops->oldestPendingAt(),
            'writer' => [
                'mode' => $this->config->access->storeMode,
                'blocked' => ($row['writer_blocked_at'] ?? null) !== null,
                'error' => self::str($row['writer_error'] ?? null) === null ? null : mb_substr((string) $row['writer_error'], 0, 500),
            ],
            'restoring' => ($row['reconciled_epoch'] ?? null) !== ($row['epoch'] ?? null),
            'mismatch' => is_array($report['missing'] ?? null) && $report['missing'] !== [],
            'unreadNotices' => (int) $this->db->scalar('SELECT COUNT(*) FROM owner_notices WHERE read_at IS NULL'),
            'noticeVersion' => $version === null ? null : (int) $version,
        ];
    }

    private static function str(mixed $value): ?string
    {
        return is_string($value) ? $value : null;
    }
}
