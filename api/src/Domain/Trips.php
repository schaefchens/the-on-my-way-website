<?php

declare(strict_types=1);

namespace Omw\Api\Domain;

use Omw\Api\Http\ApiException;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;
use stdClass;

/**
 * Trips (contract Trip / TripUpsert / AdminTrip). PUT replaces the whole trip (absent optional
 * fields are cleared). Date ranges of different trips must not overlap (422 with the slugs).
 */
final class Trips
{
    public function __construct(
        private readonly Db $db,
        private readonly ChangeLog $changes,
    ) {
    }

    /** @return list<array<string, mixed>> AdminTrip, ordered by start date then slug */
    public function list(): array
    {
        return array_map(self::dto(...), $this->db->all(self::SELECT . ' ORDER BY t.start_date, t.slug'));
    }

    /** @return array<string, mixed> AdminTrip */
    public function get(string $slug): array
    {
        $row = $this->db->one(self::SELECT . ' WHERE t.slug = ?', [$slug]);

        return $row === null ? throw ApiException::notFound('No such trip.') : self::dto($row);
    }

    /**
     * @return array{trip: array<string, mixed>, created: bool}
     */
    public function upsert(string $slug, stdClass $body): array
    {
        if (($body->slug ?? null) !== $slug) {
            throw ApiException::validation('slug in the body must match the URL.');
        }
        $start = (string) $body->startDate;
        $end = (string) $body->endDate;
        if ($end < $start) {
            throw ApiException::validation('endDate must not be before startDate.', ['errors' => ['/endDate: must not be before startDate']]);
        }

        return $this->db->write(function () use ($slug, $body, $start, $end): array {
            $row = $this->db->one('SELECT * FROM trips WHERE slug = ?', [$slug]);
            if (isset($body->ifUpdatedAt) && is_string($body->ifUpdatedAt)
                && ($row === null || !Captures::sameInstant((string) $row['updated_at'], $body->ifUpdatedAt))) {
                throw ApiException::conflict('The trip was changed meanwhile (ifUpdatedAt is stale).');
            }
            $overlaps = Policy::overlappingTrips(['slug' => $slug, 'startDate' => $start, 'endDate' => $end], $this->ranges());
            if ($overlaps !== []) {
                throw ApiException::validation(
                    'The date range overlaps other trips: ' . implode(', ', $overlaps) . '.',
                    ['errors' => ['/startDate: overlaps ' . implode(', ', $overlaps)], 'overlaps' => $overlaps],
                );
            }
            $next = [
                'title' => Captures::encode($body->title),
                'description' => isset($body->description) ? Captures::encode($body->description) : null,
                'orig_locale' => isset($body->origLocale) && is_string($body->origLocale) ? $body->origLocale : null,
                'start_date' => $start,
                'end_date' => $end,
                'cover_source_key' => isset($body->coverSourceKey) && is_string($body->coverSourceKey) ? $body->coverSourceKey : null,
            ];
            if ($row !== null) {
                $same = true;
                foreach ($next as $column => $value) {
                    $stored = $row[$column];
                    if (in_array($column, ['title', 'description'], true) && is_string($stored)) {
                        $stored = Captures::encode(Captures::decode($stored));
                    }
                    if ($stored !== $value) {
                        $same = false;
                        break;
                    }
                }
                if ($same) {
                    return ['trip' => $this->get($slug), 'created' => false];
                }
            }
            $now = Clock::nowIsoAfter($row === null ? null : (string) $row['updated_at']);
            $this->db->exec(
                'INSERT INTO trips (slug, title, description, orig_locale, start_date, end_date, cover_source_key, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (slug) DO UPDATE SET title = excluded.title, description = excluded.description,
                    orig_locale = excluded.orig_locale, start_date = excluded.start_date, end_date = excluded.end_date,
                    cover_source_key = excluded.cover_source_key, updated_at = excluded.updated_at',
                [$slug, $next['title'], $next['description'], $next['orig_locale'], $start, $end, $next['cover_source_key'], $now, $now],
            );
            $trip = $this->get($slug);
            $wire = $trip;
            unset($wire['changeSeq']);
            $seq = $this->changes->append('trip', $slug, 'upsert', $wire);
            $trip['changeSeq'] = $seq;

            return ['trip' => $trip, 'created' => $row === null];
        });
    }

    /** Idempotent delete (true when a trip was deleted by this call). */
    public function delete(string $slug): bool
    {
        return $this->db->write(function () use ($slug): bool {
            if ($this->db->exec('DELETE FROM trips WHERE slug = ?', [$slug]) === 0) {
                return false;
            }
            $this->changes->append('trip', $slug, 'delete', null);

            return true;
        });
    }

    /** @return list<array{slug: string, startDate: string, endDate: string}> */
    public function ranges(): array
    {
        $out = [];
        foreach ($this->db->all('SELECT slug, start_date, end_date FROM trips') as $row) {
            $out[] = ['slug' => (string) $row['slug'], 'startDate' => (string) $row['start_date'], 'endDate' => (string) $row['end_date']];
        }

        return $out;
    }

    private const SELECT = <<<'SQL'
        SELECT t.*, (SELECT MAX(cl.seq) FROM change_log cl WHERE cl.entity = 'trip' AND cl.entity_key = t.slug) AS change_seq
        FROM trips t
        SQL;

    /**
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    private static function dto(array $row): array
    {
        return [
            'slug' => (string) $row['slug'],
            'title' => Captures::decode((string) $row['title']),
            'description' => $row['description'] === null ? null : Captures::decode((string) $row['description']),
            'origLocale' => $row['orig_locale'] === null ? null : (string) $row['orig_locale'],
            'startDate' => (string) $row['start_date'],
            'endDate' => (string) $row['end_date'],
            'coverSourceKey' => $row['cover_source_key'] === null ? null : (string) $row['cover_source_key'],
            'updatedAt' => (string) $row['updated_at'],
            'changeSeq' => (int) ($row['change_seq'] ?? 0),
        ];
    }
}
