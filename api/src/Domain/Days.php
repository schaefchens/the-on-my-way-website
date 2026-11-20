<?php

declare(strict_types=1);

namespace Omw\Api\Domain;

use Omw\Api\Http\ApiException;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;
use stdClass;

/**
 * Owner metadata of local days (contract Day / DayPatch / AdminDaySummary / AdminDayDetail).
 * A days row exists only once the owner edited the day; the admin lists every date with content.
 */
final class Days
{
    private const FIELDS = [
        'title' => 'title', 'summary' => 'summary', 'origLocale' => 'orig_locale', 'placeName' => 'place_name',
        'countryCode' => 'country_code', 'lat' => 'lat', 'lng' => 'lng', 'coverSourceKey' => 'cover_source_key', 'tz' => 'tz',
    ];
    private const JSON_FIELDS = ['title', 'summary'];

    public function __construct(
        private readonly Db $db,
        private readonly ChangeLog $changes,
        private readonly Captures $captures,
        private readonly Posts $posts,
        private readonly Trips $trips,
    ) {
    }

    /**
     * GET /admin/days: one AdminDaySummary per date with content (captures and posts by their
     * EFFECTIVE local date, i.e. with Day.tz fixes applied like the generator does ∪ days rows),
     * ascending.
     *
     * @return list<array<string, mixed>>
     */
    public function list(string $basePath): array
    {
        $days = $this->rows();
        /** @var array<string, array{captures: list<array<string, mixed>>, posts: list<array<string, mixed>>}> $byDate */
        $byDate = [];
        $allCaptures = $this->captures->all($basePath);
        foreach ($allCaptures as $item) {
            $byDate[(string) $item['effectiveLocalDate']]['captures'][] = $item;
        }
        $dayTz = Captures::dayTzFixes($this->db);
        foreach ($this->posts->all() as $post) {
            $byDate[Posts::effectiveLocalDate($post, $dayTz)]['posts'][] = $post;
        }
        foreach (array_keys($days) as $date) {
            $byDate[$date] ??= ['captures' => [], 'posts' => []];
        }
        ksort($byDate, SORT_STRING);
        $tripRanges = $this->trips->ranges();
        $coverPreviews = self::coverPreviewIndex($allCaptures);

        $out = [];
        foreach ($byDate as $date => $content) {
            $out[] = $this->summary(
                (string) $date,
                $days[$date] ?? null,
                $content['captures'] ?? [],
                $content['posts'] ?? [],
                $tripRanges,
                $coverPreviews,
            );
        }

        return $out;
    }

    /** @return array<string, mixed> AdminDayDetail */
    public function detail(string $date, string $basePath): array
    {
        self::assertDate($date);
        $row = $this->rows($date)[$date] ?? null;

        return [
            'localDate' => $date,
            'day' => $row === null ? null : self::dto($row),
            'captures' => $this->captures->forDate($date, $basePath),
            'posts' => $this->posts->forDate($date),
            'trip' => Policy::tripForDate($date, $this->trips->ranges()),
            'changeSeq' => $row === null ? 0 : (int) ($row['change_seq'] ?? 0),
        ];
    }

    /**
     * PATCH /admin/days/{date} (contract DayPatch, schema-valid) -> AdminDayDetail.
     *
     * @return array<string, mixed>
     */
    public function patch(string $date, stdClass $patch, string $basePath): array
    {
        self::assertDate($date);
        if (isset($patch->tz)) {
            $patch = clone $patch;
            $patch->tz = Time::canonicalTimeZone($patch->tz)
                ?? throw ApiException::validation('tz is not a known IANA time zone.', ['errors' => ['/tz: unknown time zone']]);
        }
        $this->db->write(function () use ($date, $patch): void {
            $row = $this->rows($date)[$date] ?? null;
            if (isset($patch->ifUpdatedAt) && is_string($patch->ifUpdatedAt)
                && ($row === null || !Captures::sameInstant((string) $row['updated_at'], $patch->ifUpdatedAt))) {
                throw ApiException::conflict('The day was changed meanwhile (ifUpdatedAt is stale).');
            }
            $current = [];
            foreach (self::FIELDS as $column) {
                $current[$column] = $row[$column] ?? null;
            }
            foreach (self::JSON_FIELDS as $column) {
                if (is_string($current[$column])) {
                    $current[$column] = Captures::encode(Captures::decode($current[$column]));
                }
            }
            $next = $current;
            foreach (self::FIELDS as $field => $column) {
                if (property_exists($patch, $field)) {
                    $value = $patch->{$field};
                    $next[$column] = in_array($field, self::JSON_FIELDS, true) && $value !== null ? Captures::encode($value) : $value;
                }
            }
            if ($row !== null && self::sameValues($current, $next)) {
                return;
            }
            if ($row === null && array_filter($next, static fn ($v): bool => $v !== null) === []) {
                return; // nothing to store for a day the owner never edited
            }
            $now = Clock::nowIsoAfter($row === null ? null : (string) $row['updated_at']);
            $this->db->exec(
                'INSERT INTO days (local_date, title, summary, orig_locale, place_name, country_code, lat, lng, cover_source_key, tz, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (local_date) DO UPDATE SET title = excluded.title, summary = excluded.summary, orig_locale = excluded.orig_locale,
                    place_name = excluded.place_name, country_code = excluded.country_code, lat = excluded.lat, lng = excluded.lng,
                    cover_source_key = excluded.cover_source_key, tz = excluded.tz, updated_at = excluded.updated_at',
                [$date, $next['title'], $next['summary'], $next['orig_locale'], $next['place_name'], $next['country_code'],
                    $next['lat'], $next['lng'], $next['cover_source_key'], $next['tz'], $now, $now],
            );
            $stored = $this->rows($date)[$date] ?? null;
            if ($stored === null) {
                throw new \LogicException('days row vanished');
            }
            $this->changes->append('day', $date, 'upsert', self::dto($stored));
        });

        return $this->detail($date, $basePath);
    }

    /**
     * days rows (with change_seq), keyed by date.
     *
     * @return array<string, array<string, mixed>>
     */
    private function rows(?string $date = null): array
    {
        $rows = $this->db->all(
            "SELECT d.*, (SELECT MAX(cl.seq) FROM change_log cl WHERE cl.entity = 'day' AND cl.entity_key = d.local_date) AS change_seq
             FROM days d" . ($date === null ? '' : ' WHERE d.local_date = ?'),
            $date === null ? [] : [$date],
        );
        $out = [];
        foreach ($rows as $row) {
            $out[(string) $row['local_date']] = $row;
        }

        return $out;
    }

    /**
     * @param array<string, mixed>|null                                        $row
     * @param list<array<string, mixed>>                                       $captures
     * @param list<array<string, mixed>>                                       $posts
     * @param list<array{slug: string, startDate: string, endDate: string}> $tripRanges
     * @param array<string, string|null>                                       $coverPreviews
     * @return array<string, mixed>
     */
    private function summary(string $date, ?array $row, array $captures, array $posts, array $tripRanges, array $coverPreviews): array
    {
        $counts = ['captures' => count($captures), 'posts' => count($posts), 'public' => 0, 'hidden' => 0, 'pending' => 0];
        $times = [];
        $firstPublicMedia = null;
        foreach ($captures as $c) {
            ++$counts[(string) $c['effectiveVisibility']];
            $times[] = (string) $c['occurredAt'];
            if ($firstPublicMedia === null && $c['effectiveVisibility'] === 'public' && in_array($c['kind'], ['photo', 'video'], true)) {
                $firstPublicMedia = (string) $c['sourceKey'];
            }
        }
        foreach ($posts as $p) {
            ++$counts[(string) $p['visibility']];
            $times[] = (string) $p['occurredAt'];
        }
        sort($times, SORT_STRING);
        $day = $row === null ? null : self::dto($row);
        $cover = $day !== null && is_string($day['coverSourceKey']) ? $day['coverSourceKey'] : $firstPublicMedia;

        return [
            'localDate' => $date,
            'day' => $day,
            'counts' => $counts,
            'firstAt' => $times === [] ? null : $times[0],
            'lastAt' => $times === [] ? null : $times[count($times) - 1],
            'coverSourceKey' => $cover,
            'coverPreviewUrl' => $cover === null ? null : ($coverPreviews[$cover] ?? null),
            'trip' => Policy::tripForDate($date, $tripRanges),
            'changeSeq' => $row === null ? 0 : (int) ($row['change_seq'] ?? 0),
        ];
    }

    /**
     * sourceKey -> preview URL usable as a cover (poster of videos, else the preview).
     *
     * @param list<array<string, mixed>> $captures
     * @return array<string, string|null>
     */
    private static function coverPreviewIndex(array $captures): array
    {
        $out = [];
        foreach ($captures as $c) {
            $poster = is_string($c['posterUrl']) ? $c['posterUrl'] : null;
            $preview = is_string($c['previewUrl']) ? $c['previewUrl'] : null;
            $out[(string) $c['sourceKey']] = in_array($c['kind'], ['video', 'gif'], true) ? ($poster ?? $preview) : ($preview ?? $poster);
        }

        return $out;
    }

    /**
     * Contract Day from a days row.
     *
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    public static function dto(array $row): array
    {
        return [
            'localDate' => (string) $row['local_date'],
            'title' => $row['title'] === null ? null : Captures::decode((string) $row['title']),
            'summary' => $row['summary'] === null ? null : Captures::decode((string) $row['summary']),
            'origLocale' => $row['orig_locale'] === null ? null : (string) $row['orig_locale'],
            'placeName' => $row['place_name'] === null ? null : (string) $row['place_name'],
            'countryCode' => $row['country_code'] === null ? null : (string) $row['country_code'],
            'lat' => $row['lat'] === null ? null : (float) $row['lat'],
            'lng' => $row['lng'] === null ? null : (float) $row['lng'],
            'coverSourceKey' => $row['cover_source_key'] === null ? null : (string) $row['cover_source_key'],
            'tz' => $row['tz'] === null ? null : (string) $row['tz'],
            'updatedAt' => (string) $row['updated_at'],
        ];
    }

    public static function assertDate(string $date): void
    {
        if (!Time::isValidLocalDate($date)) {
            throw ApiException::validation('Not a calendar date: ' . $date);
        }
    }

    /**
     * @param array<string, mixed> $a
     * @param array<string, mixed> $b
     */
    private static function sameValues(array $a, array $b): bool
    {
        foreach ($a as $key => $value) {
            $other = $b[$key] ?? null;
            if (is_numeric($value) && is_numeric($other)) {
                if ((float) $value !== (float) $other) {
                    return false;
                }
            } elseif ($value !== $other) {
                return false;
            }
        }

        return true;
    }
}
