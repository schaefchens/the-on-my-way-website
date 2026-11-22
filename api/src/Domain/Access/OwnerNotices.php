<?php

declare(strict_types=1);

namespace Omw\Api\Domain\Access;

use Omw\Api\Domain\Alerts\Notification;
use Omw\Api\Domain\Alerts\Notifier;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * One-shot notices to the owner that never carry a name (spec-wave5 §3.9): "a follower deleted
 * their data", "a restore was reconciled", "the Mac found another store". Shown in the admin
 * (GET /admin/notices) and pushed through the alert channels once (cron, or right after the
 * response of me/delete).
 */
final class OwnerNotices
{
    public const KINDS = ['follower_deleted', 'restore_reconciled', 'store_mismatch'];

    public function __construct(
        private readonly Db $db,
        private readonly Notifier $notifier,
        private readonly ?LoggerInterface $logger = null,
    ) {
    }

    /** @param array<string, mixed>|null $data never names */
    public function add(string $kind, ?array $data = null): int
    {
        return $this->db->write(function () use ($kind, $data): int {
            $this->db->exec(
                'INSERT INTO owner_notices (kind, data, created_at) VALUES (?, ?, ?)',
                [$kind, $data === null ? null : json_encode($data, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES), Clock::nowIso()],
            );

            return (int) $this->db->pdo()->lastInsertId();
        });
    }

    public function hasUnread(string $kind): bool
    {
        return $this->db->scalar('SELECT 1 FROM owner_notices WHERE kind = ? AND read_at IS NULL LIMIT 1', [$kind]) !== null;
    }

    public function unreadCount(): int
    {
        return (int) $this->db->scalar('SELECT COUNT(*) FROM owner_notices WHERE read_at IS NULL');
    }

    /** @return list<array{id: int, kind: string, createdAt: string, readAt: string|null}> newest first */
    public function list(int $limit = 100): array
    {
        return array_map(static fn (array $r): array => [
            'id' => (int) $r['id'],
            'kind' => (string) $r['kind'],
            'createdAt' => (string) $r['created_at'],
            'readAt' => $r['read_at'] === null ? null : (string) $r['read_at'],
        ], $this->db->all('SELECT id, kind, created_at, read_at FROM owner_notices ORDER BY id DESC LIMIT ?', [$limit]));
    }

    /** @param list<int> $ids */
    public function markRead(array $ids): void
    {
        $now = Clock::nowIso();
        $this->db->write(function () use ($ids, $now): void {
            foreach ($ids as $id) {
                $this->db->exec('UPDATE owner_notices SET read_at = ? WHERE id = ? AND read_at IS NULL', [$now, $id]);
            }
        });
    }

    /** Pushes undelivered notices (no names); a notice is retried while every channel fails. */
    public function deliver(): int
    {
        $delivered = 0;
        foreach ($this->db->all('SELECT id, kind, created_at FROM owner_notices WHERE delivered_at IS NULL ORDER BY id LIMIT 20') as $row) {
            $kind = (string) $row['kind'];
            [$title, $message] = self::text($kind);
            try {
                $this->notifier->send(new Notification('notice_' . $kind, 'warning', $title, $message, false, (string) $row['created_at']));
            } catch (Throwable $e) {
                $this->logger?->warning('Owner notice {kind} could not be delivered: {error}', ['kind' => $kind, 'error' => $e->getMessage()]);

                continue;
            }
            $this->db->write(fn (): int => $this->db->exec('UPDATE owner_notices SET delivered_at = ? WHERE id = ?', [Clock::nowIso(), (int) $row['id']]));
            ++$delivered;
        }

        return $delivered;
    }

    /** @return array{0: string, 1: string} */
    private static function text(string $kind): array
    {
        return match ($kind) {
            'follower_deleted' => ['[On My Way] Eine Person hat ihre Daten gelöscht', 'Eine eingeladene Person hat ihre Daten gelöscht. Ihr Zugang ist beendet.'],
            'restore_reconciled' => ['[On My Way] Zugänge nach einer Wiederherstellung geprüft', 'Nach einer Wiederherstellung wurden Zugänge abgeglichen und die persönlichen Links zurückgesetzt. Details unter Admin → Personen.'],
            default => ['[On My Way] Website-Speicher passt nicht', 'Der Mac hat einen anderen Website-Speicher gefunden. Bitte prüfe die Einrichtung.'],
        };
    }
}
