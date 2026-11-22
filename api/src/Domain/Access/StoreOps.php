<?php

declare(strict_types=1);

namespace Omw\Api\Domain\Access;

use LogicException;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;

/**
 * The outbox of store operations (spec-wave5 §3.8.2), applied strictly in id order by one holder
 * of the lease (Domain\Access\StoreApplier for the API, the Mac through the backend routes).
 *
 * {@see enqueue()} runs inside the caller's write transaction, together with the state change it
 * belongs to. Ops: init (the marker, only if none exists), put (exclusive, except the marker),
 * delete, delete_prefix ("s/<fid>/<did>."), delete_tree. Every path is checked against
 * StoreLayout per op kind. Once applied, a session put's path is redacted to
 * "s/<fid>/<did>.<redacted>", so the database keeps no usable session id.
 */
final class StoreOps
{
    public function __construct(private readonly Db $db)
    {
    }

    /** @return int the new op id */
    public function enqueue(string $op, string $path, ?string $content = null, bool $exclusive = true): int
    {
        if (!in_array($op, StoreLayout::OPS, true) || !StoreLayout::isValidOpPath($op, $path, $exclusive)) {
            throw new LogicException(sprintf('Invalid store op %s %s', $op, StoreLayout::redact($path)));
        }
        if ($op !== 'put' && $op !== 'init') {
            $content = null;
        }

        return $this->db->write(function () use ($op, $path, $content, $exclusive): int {
            $epoch = (string) $this->db->scalar('SELECT epoch FROM access_state WHERE id = 1');
            $this->db->exec(
                'INSERT INTO store_ops (epoch, op, path, content, exclusive, created_at) VALUES (?, ?, ?, ?, ?, ?)',
                [$epoch, $op, $path, $content, $exclusive ? 1 : 0, Clock::nowIso()],
            );

            return (int) $this->db->pdo()->lastInsertId();
        });
    }

    /**
     * JSON of a tombstone or lock file: {"s":"revoked","at":"…"} / {"at":"…","by":"admin"}.
     *
     * @param array<string, mixed> $data
     */
    public static function json(array $data): string
    {
        return json_encode($data, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
    }

    public function pendingCount(): int
    {
        return (int) $this->db->scalar('SELECT COUNT(*) FROM store_ops WHERE applied_at IS NULL');
    }

    public function oldestPendingAt(): ?string
    {
        $at = $this->db->scalar('SELECT MIN(created_at) FROM store_ops WHERE applied_at IS NULL');

        return is_string($at) ? $at : null;
    }

    public function maxId(): int
    {
        return (int) $this->db->scalar('SELECT COALESCE(MAX(id), 0) FROM store_ops');
    }

    /** Number of pending ops with an id up to $maxId (0 = every op of an action is in the store). */
    public function pendingUpTo(int $maxId): int
    {
        return (int) $this->db->scalar('SELECT COUNT(*) FROM store_ops WHERE applied_at IS NULL AND id <= ?', [$maxId]);
    }

    /**
     * Pending ops in id order.
     *
     * @return list<array{id: int, epoch: string, op: string, path: string, content: string|null, exclusive: bool, created_at: string, attempts: int}>
     */
    public function pending(int $limit = 200, int $afterId = 0): array
    {
        $out = [];
        foreach ($this->db->all(
            'SELECT id, epoch, op, path, content, exclusive, created_at, attempts FROM store_ops WHERE applied_at IS NULL AND id > ? ORDER BY id LIMIT ?',
            [$afterId, $limit],
        ) as $row) {
            $out[] = [
                'id' => (int) $row['id'],
                'epoch' => (string) $row['epoch'],
                'op' => (string) $row['op'],
                'path' => (string) $row['path'],
                'content' => $row['content'] === null ? null : (string) $row['content'],
                'exclusive' => (int) $row['exclusive'] === 1,
                'created_at' => (string) $row['created_at'],
                'attempts' => (int) $row['attempts'],
            ];
        }

        return $out;
    }

    /** The first pending init op, if any (applied before anything else while the marker is missing). */
    public function pendingInit(): ?int
    {
        $id = $this->db->scalar("SELECT MIN(id) FROM store_ops WHERE applied_at IS NULL AND op = 'init'");

        return $id === null ? null : (int) $id;
    }

    /**
     * Marks ops applied (by "api" or "mac") in one short transaction and advances last_applied_op.
     *
     * @param list<int> $ids
     */
    public function markApplied(array $ids, string $by): void
    {
        if ($ids === []) {
            return;
        }
        $now = Clock::nowIso();
        $this->db->write(function () use ($ids, $by, $now): void {
            foreach ($ids as $id) {
                $row = $this->db->one('SELECT path FROM store_ops WHERE id = ? AND applied_at IS NULL', [$id]);
                if ($row === null) {
                    continue;
                }
                $this->db->exec(
                    'UPDATE store_ops SET applied_at = ?, applied_by = ?, path = ?, last_error = NULL WHERE id = ?',
                    [$now, $by, StoreLayout::redact((string) $row['path']), $id],
                );
            }
            $this->db->exec(
                'UPDATE access_state SET last_applied_op = MAX(last_applied_op, ?), last_applied_at = ?, updated_at = ? WHERE id = 1',
                [max($ids), $now, $now],
            );
        });
    }

    public function markFailed(int $id, string $error): void
    {
        $this->db->write(fn (): int => $this->db->exec(
            'UPDATE store_ops SET attempts = attempts + 1, last_error = ? WHERE id = ?',
            [mb_substr(StoreLayout::redactText($error), 0, 500), $id],
        ));
    }

    /** True when a pending op touches the device's sessions or handoff marker (its issue is not applied yet). */
    public function pendingForDevice(string $fid, string $did): bool
    {
        $prefix = StoreLayout::sessionPrefix($fid, $did);

        return $this->db->scalar(
            'SELECT 1 FROM store_ops WHERE applied_at IS NULL AND (substr(path, 1, ?) = ? OR path = ? OR path = ?) LIMIT 1',
            [strlen($prefix), $prefix, StoreLayout::handoff($did), StoreLayout::sessionDir($fid)],
        ) !== null;
    }

    /**
     * Ops newer than $id (op kind and path), used by the reconciler to skip paths an op enqueued
     * after the listing touches.
     *
     * @return list<array{op: string, path: string}>
     */
    public function touchedAfter(int $id): array
    {
        return array_map(
            static fn (array $r): array => ['op' => (string) $r['op'], 'path' => (string) $r['path']],
            $this->db->all('SELECT op, path FROM store_ops WHERE id > ? ORDER BY id', [$id]),
        );
    }

    /** Removes applied ops older than $beforeIso (cron). */
    public function prune(string $beforeIso): int
    {
        return $this->db->write(fn (): int => $this->db->exec('DELETE FROM store_ops WHERE applied_at IS NOT NULL AND applied_at < ?', [$beforeIso]));
    }
}
