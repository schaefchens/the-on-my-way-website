<?php

declare(strict_types=1);

namespace Omw\Api\Domain;

use Omw\Api\Http\ApiException;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;
use Omw\Api\Infra\SchemaValidator;
use stdClass;

/**
 * Owner-authored notes and stories (contract Post / AdminPost / PostCreate / PostUpdate).
 *
 * - Creating is idempotent per client-chosen publicId: a known publicId returns the stored post.
 * - local_date is always derived: localDateFor(occurredAt, tz).
 * - Placement on a day follows contracts policy (Placement) exactly like the generator does: a
 *   Day.tz fix of the post's STORED local date re-dates it in that zone. Date filters (list,
 *   day views) therefore use the effective local date, not the stored one.
 * - Every write appends the Post DTO (or a tombstone) to change_log in the same transaction.
 */
final class Posts
{
    public const DEFAULT_LIMIT = 50;

    public function __construct(
        private readonly Db $db,
        private readonly ChangeLog $changes,
        private readonly Settings $settings,
        private readonly SchemaValidator $schemas,
    ) {
    }

    /**
     * @return array{post: array<string, mixed>, created: bool}
     */
    public function create(stdClass $body): array
    {
        $publicId = (string) $body->publicId;
        $kind = (string) $body->kind;
        if (!property_exists($body->content, (string) $body->origLocale)) {
            throw ApiException::validation('content must contain origLocale.', ['errors' => ['/content: must contain origLocale']]);
        }
        if (isset($body->tz)) {
            $body = clone $body;
            $body->tz = Time::canonicalTimeZone($body->tz)
                ?? throw ApiException::validation('tz is not a known IANA time zone.', ['errors' => ['/tz: unknown time zone']]);
        }

        return $this->db->write(function () use ($body, $publicId, $kind): array {
            $existing = $this->find($publicId);
            if ($existing !== null) {
                return ['post' => $existing, 'created' => false];
            }
            $now = Clock::nowIso();
            $occurredAt = isset($body->occurredAt) && is_string($body->occurredAt) ? Time::toIsoUtc($body->occurredAt) : $now;
            $tz = isset($body->tz) && is_string($body->tz)
                ? $body->tz
                : (Time::canonicalTimeZone($this->settings->get('timezone.current')) ?? (string) Settings::DEFAULTS['timezone.current']);
            $post = [
                'publicId' => $publicId,
                'kind' => $kind,
                'occurredAt' => $occurredAt,
                'tz' => $tz,
                'localDate' => Time::localDateFor($occurredAt, $tz),
                'origLocale' => (string) $body->origLocale,
                'visibility' => isset($body->visibility) && is_string($body->visibility) ? $body->visibility : 'public',
                'content' => $body->content,
                'updatedAt' => $now,
            ];
            $this->db->exec(
                'INSERT INTO posts (public_id, kind, occurred_at, tz, local_date, content, orig_locale, visibility, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [$publicId, $kind, $post['occurredAt'], $tz, $post['localDate'], Captures::encode($post['content']), $post['origLocale'], $post['visibility'], $now, $now],
            );
            $seq = $this->changes->append('post', $publicId, 'upsert', self::wire($post));

            return ['post' => $post + ['changeSeq' => $seq], 'created' => true];
        });
    }

    /** @return array<string, mixed> AdminPost */
    public function get(string $publicId): array
    {
        return $this->find($publicId) ?? throw ApiException::notFound('No such post.');
    }

    /** @return array<string, mixed> AdminPost */
    public function update(string $publicId, stdClass $patch): array
    {
        if (isset($patch->tz)) {
            $patch = clone $patch;
            $patch->tz = Time::canonicalTimeZone($patch->tz)
                ?? throw ApiException::validation('tz is not a known IANA time zone.', ['errors' => ['/tz: unknown time zone']]);
        }

        return $this->db->write(function () use ($publicId, $patch): array {
            $current = $this->find($publicId) ?? throw ApiException::notFound('No such post.');
            if (isset($patch->ifUpdatedAt) && is_string($patch->ifUpdatedAt) && !Captures::sameInstant((string) $current['updatedAt'], $patch->ifUpdatedAt)) {
                throw ApiException::conflict('The post was changed meanwhile (ifUpdatedAt is stale).');
            }
            $next = $current;
            unset($next['changeSeq']);
            foreach (['tz', 'origLocale', 'visibility', 'content'] as $field) {
                if (property_exists($patch, $field)) {
                    $next[$field] = $patch->{$field};
                }
            }
            if (property_exists($patch, 'occurredAt') && is_string($patch->occurredAt)) {
                $next['occurredAt'] = Time::toIsoUtc($patch->occurredAt);
            }
            $next['localDate'] = Time::localDateFor((string) $next['occurredAt'], (string) $next['tz']);
            if (!property_exists($next['content'], (string) $next['origLocale'])) {
                throw ApiException::validation('content must contain origLocale.', ['errors' => ['/content: must contain origLocale']]);
            }
            $before = $current;
            unset($before['changeSeq'], $before['updatedAt']);
            $compare = $next;
            unset($compare['updatedAt']);
            if (Captures::encode($before) === Captures::encode($compare)) {
                return $current; // no-op
            }
            $next['updatedAt'] = Clock::nowIsoAfter((string) $current['updatedAt']);
            $wire = self::wire($next);
            $errors = $this->schemas->errors(SchemaValidator::toJsonValue($wire), 'Post');
            if ($errors !== []) {
                throw ApiException::validation('content does not match the post kind "' . $current['kind'] . '".', ['errors' => $errors]);
            }
            $this->db->exec(
                'UPDATE posts SET occurred_at = ?, tz = ?, local_date = ?, content = ?, orig_locale = ?, visibility = ?, updated_at = ?
                 WHERE public_id = ?',
                [$next['occurredAt'], $next['tz'], $next['localDate'], Captures::encode($next['content']), $next['origLocale'], $next['visibility'], $next['updatedAt'], $publicId],
            );
            $seq = $this->changes->append('post', $publicId, 'upsert', $wire);

            return $next + ['changeSeq' => $seq];
        });
    }

    /** DELETE: idempotent (true when a post was deleted by this call). */
    public function delete(string $publicId): bool
    {
        return $this->db->write(function () use ($publicId): bool {
            if ($this->db->exec('DELETE FROM posts WHERE public_id = ?', [$publicId]) === 0) {
                return false;
            }
            $this->changes->append('post', $publicId, 'delete', null);

            return true;
        });
    }

    /**
     * GET /admin/posts (contract PostListQuery -> PostListResponse), newest first.
     *
     * @return array{items: list<array<string, mixed>>, nextCursor: string|null}
     */
    public function list(stdClass $query): array
    {
        $limit = isset($query->limit) && is_int($query->limit) ? $query->limit : self::DEFAULT_LIMIT;
        $date = isset($query->date) && is_string($query->date) ? $query->date : null;
        $where = [];
        $params = [];
        foreach (['kind' => 'p.kind', 'visibility' => 'p.visibility'] as $field => $column) {
            if (isset($query->{$field}) && is_string($query->{$field})) {
                $where[] = "$column = ?";
                $params[] = $query->{$field};
            }
        }
        $dayTz = [];
        if ($date !== null) {
            // Candidates by stored date; the effective date (Day.tz fix) is checked below.
            $where[] = 'p.local_date BETWEEN ? AND ?';
            array_push($params, Time::addDays($date, -Captures::FIX_WINDOW_DAYS), Time::addDays($date, Captures::FIX_WINDOW_DAYS));
            $dayTz = Captures::dayTzFixes($this->db);
        }
        $cursor = isset($query->cursor) && is_string($query->cursor) ? Captures::decodeCursor($query->cursor) : null;

        $items = [];
        $more = false;
        $batch = $date === null ? $limit + 1 : max(50, $limit * 2);
        while (true) {
            $w = $where;
            $p = $params;
            if ($cursor !== null) {
                $w[] = '(p.occurred_at < ? OR (p.occurred_at = ? AND p.public_id < ?))';
                array_push($p, $cursor[0], $cursor[0], $cursor[1]);
            }
            $rows = $this->db->all(
                self::SELECT . ($w === [] ? '' : ' WHERE ' . implode(' AND ', $w)) . ' ORDER BY p.occurred_at DESC, p.public_id DESC LIMIT ' . $batch,
                $p,
            );
            foreach ($rows as $row) {
                $cursor = [(string) $row['occurred_at'], (string) $row['public_id']];
                $post = self::dto($row);
                if ($date !== null && self::effectiveLocalDate($post, $dayTz) !== $date) {
                    continue;
                }
                if (count($items) === $limit) {
                    $more = true;
                    break 2;
                }
                $items[] = $post;
            }
            if (count($rows) < $batch) {
                break;
            }
        }
        $last = $items === [] ? null : $items[count($items) - 1];

        return [
            'items' => $items,
            'nextCursor' => $more && $last !== null ? Captures::encodeCursor((string) $last['occurredAt'], (string) $last['publicId']) : null,
        ];
    }

    /**
     * AdminPost placed on one local date (effective local date, see the class comment),
     * chronological.
     *
     * @param array<string, string>|null $dayTz Day.tz fixes by date (null = read them)
     * @return list<array<string, mixed>>
     */
    public function forDate(string $date, ?array $dayTz = null): array
    {
        $dayTz ??= Captures::dayTzFixes($this->db);
        $rows = $this->db->all(
            self::SELECT . ' WHERE p.local_date BETWEEN ? AND ? ORDER BY p.occurred_at, p.public_id',
            [Time::addDays($date, -Captures::FIX_WINDOW_DAYS), Time::addDays($date, Captures::FIX_WINDOW_DAYS)],
        );
        $out = [];
        foreach ($rows as $row) {
            $post = self::dto($row);
            if (self::effectiveLocalDate($post, $dayTz) === $date) {
                $out[] = $post;
            }
        }

        return $out;
    }

    /**
     * Effective local date of a post (contracts policy effectiveLocalDate(post, null, Day.tz of
     * its stored local date)); posts have no localDateOverride.
     *
     * @param array<string, mixed>  $post  AdminPost DTO
     * @param array<string, string> $dayTz Day.tz fixes by date
     */
    public static function effectiveLocalDate(array $post, array $dayTz): string
    {
        $stored = (string) $post['localDate'];

        return Policy::effectiveLocalDate((string) $post['occurredAt'], $stored, null, $dayTz[$stored] ?? null);
    }

    /** @return list<array<string, mixed>> every post (AdminPost), chronological */
    public function all(): array
    {
        return array_map(self::dto(...), $this->db->all(self::SELECT . ' ORDER BY p.occurred_at, p.public_id'));
    }

    private const SELECT = <<<'SQL'
        SELECT p.*, (SELECT MAX(cl.seq) FROM change_log cl WHERE cl.entity = 'post' AND cl.entity_key = p.public_id) AS change_seq
        FROM posts p
        SQL;

    /** @return array<string, mixed>|null */
    private function find(string $publicId): ?array
    {
        $row = $this->db->one(self::SELECT . ' WHERE p.public_id = ?', [$publicId]);

        return $row === null ? null : self::dto($row);
    }

    /**
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    private static function dto(array $row): array
    {
        return [
            'publicId' => (string) $row['public_id'],
            'kind' => (string) $row['kind'],
            'occurredAt' => (string) $row['occurred_at'],
            'tz' => (string) $row['tz'],
            'localDate' => (string) $row['local_date'],
            'origLocale' => (string) $row['orig_locale'],
            'visibility' => (string) $row['visibility'],
            'content' => Captures::decode((string) $row['content']),
            'updatedAt' => (string) $row['updated_at'],
            'changeSeq' => (int) ($row['change_seq'] ?? 0),
        ];
    }

    /**
     * The Post DTO as it goes onto the change feed (no changeSeq).
     *
     * @param array<string, mixed> $post
     * @return array<string, mixed>
     */
    private static function wire(array $post): array
    {
        unset($post['changeSeq']);

        return $post;
    }
}
