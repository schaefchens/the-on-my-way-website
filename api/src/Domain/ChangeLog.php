<?php

declare(strict_types=1);

namespace Omw\Api\Domain;

use LogicException;
use Omw\Api\Http\ApiException;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;
use Omw\Api\Infra\SchemaValidator;
use stdClass;

/**
 * The owner change feed (change_log, contract ChangesResponse) — the only writer of change_log.
 *
 * - append() must run inside the caller's Db::write() transaction together with the entity write,
 *   and validates the item against api/schemas/ChangeItem.json (+ the setting's value schema)
 *   BEFORE inserting, so the backend never receives an item it cannot parse.
 * - page() builds GET /api/v1/backend/changes; `after` beyond the newest seq is a 409 "feed_reset"
 *   (the database was restored/reinstalled; the backend rebuilds its mirror).
 * - compact() deletes superseded rows (the latest row per entity+key, tombstones included, always
 *   survives, so every cursor stays correct).
 */
final class ChangeLog
{
    public const ENTITIES = ['post', 'annotation', 'day', 'trip', 'setting'];

    /**
     * Soft size limit of one feed page (sum of the stored item data). A page ends early (hasMore)
     * once it is reached, but always carries at least one item, so a run of long stories (up to
     * 100k characters per locale each) can never push a page past PHP's memory_limit and wedge
     * the backend's sync on that page.
     */
    public const PAGE_BYTES = 2 * 1024 * 1024;

    public function __construct(
        private readonly Db $db,
        private readonly SchemaValidator $schemas,
    ) {
    }

    public function feedId(): string
    {
        $id = $this->db->scalar("SELECT value FROM meta WHERE key = 'feed_id'");
        if (!is_string($id) || $id === '') {
            throw new LogicException('meta.feed_id missing (run the migrations).');
        }

        return $id;
    }

    public function maxSeq(): int
    {
        return (int) ($this->db->scalar('SELECT MAX(seq) FROM change_log') ?? 0);
    }

    /**
     * Appends one validated item; returns its seq. $data: the entity DTO for "upsert" (decoded
     * JSON: objects as stdClass, or assoc arrays), null for "delete". For settings, $data is the
     * setting's VALUE (stored as {"value": …}).
     *
     * @throws ApiException 422 when the item does not match the contract
     */
    public function append(string $entity, string $key, string $op, mixed $data): int
    {
        if (!$this->db->pdo()->inTransaction()) {
            throw new LogicException('ChangeLog::append() must run inside Db::write() with the entity write.');
        }
        if (!in_array($op, ['upsert', 'delete'], true)) {
            throw new LogicException("Unknown op $op.");
        }
        $payload = null;
        if ($op === 'upsert') {
            $payload = $entity === 'setting' ? (object) ['value' => SchemaValidator::toJsonValue($data)] : SchemaValidator::toJsonValue($data);
        }

        $item = (object) ['seq' => 1, 'entity' => $entity, 'key' => $key, 'op' => $op];
        if ($payload !== null) {
            $item->data = $payload;
        }
        $errors = $this->schemas->errors($item, 'ChangeItem');
        if ($errors === [] && $entity === 'setting' && $payload instanceof stdClass) {
            $errors = $this->schemas->errors($payload->value, 'Settings', '/properties/' . $key);
        }
        if ($errors !== []) {
            throw ApiException::validation("Change of $entity \"$key\" does not match the contract.", ['errors' => $errors]);
        }

        $this->db->exec(
            'INSERT INTO change_log (entity, entity_key, op, data, created_at) VALUES (?, ?, ?, ?, ?)',
            [$entity, $key, $op, $payload === null ? null : json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION), Clock::nowIso()],
        );

        return (int) $this->db->pdo()->lastInsertId();
    }

    /**
     * Body of GET /api/v1/backend/changes?after=&limit= (contract ChangesResponse).
     *
     * @throws ApiException 409 feed_reset when $after is beyond the newest seq
     */
    public function page(int $after, int $limit = 200): stdClass
    {
        $limit = max(1, min(1000, $limit));
        $max = $this->maxSeq();
        if ($after > $max) {
            throw new ApiException(409, 'feed_reset', 'The change feed was reset; pull again from seq 0.', ['maxSeq' => $max, 'feedId' => $this->feedId()]);
        }
        // Rows are fetched one by one (not fetchAll): together with PAGE_BYTES this bounds memory.
        $stmt = $this->db->pdo()->prepare('SELECT seq, entity, entity_key, op, data FROM change_log WHERE seq > ? ORDER BY seq LIMIT ?');
        $stmt->execute([$after, $limit + 1]);
        $items = [];
        $next = $after;
        $bytes = 0;
        $hasMore = false;
        $count = 0;
        while (is_array($row = $stmt->fetch(\PDO::FETCH_ASSOC))) {
            $data = is_string($row['data'] ?? null) ? $row['data'] : null;
            $size = $data === null ? 0 : strlen($data);
            if ($count === $limit || ($count > 0 && $bytes + $size > self::PAGE_BYTES)) {
                $hasMore = true;
                break;
            }
            ++$count;
            $bytes += $size;
            $item = (object) [
                'seq' => (int) $row['seq'],
                'entity' => (string) $row['entity'],
                'key' => (string) $row['entity_key'],
                'op' => (string) $row['op'],
            ];
            if ($data !== null) {
                // Decode as objects: "{}" must stay an object on the wire.
                $item->data = json_decode($data, false, 64, JSON_THROW_ON_ERROR);
            }
            $items[] = $item;
            $next = $item->seq;
        }
        $stmt->closeCursor();

        return (object) ['feedId' => $this->feedId(), 'items' => $items, 'nextSeq' => $next, 'hasMore' => $hasMore];
    }

    /** change_log seq of the latest write of one entity (0 = never written), for admin DTOs (changeSeq). */
    public function latestSeq(string $entity, string $key): int
    {
        return (int) ($this->db->scalar('SELECT MAX(seq) FROM change_log WHERE entity = ? AND entity_key = ?', [$entity, $key]) ?? 0);
    }

    /**
     * Deletes rows superseded by a newer row of the same entity+key that were created before
     * $olderThanIso. Returns the number of deleted rows.
     */
    public function compact(string $olderThanIso): int
    {
        return $this->db->write(fn (): int => $this->db->exec(
            'DELETE FROM change_log
             WHERE created_at < ?
               AND seq < (SELECT MAX(c2.seq) FROM change_log c2
                          WHERE c2.entity = change_log.entity AND c2.entity_key = change_log.entity_key)',
            [$olderThanIso],
        ));
    }
}
