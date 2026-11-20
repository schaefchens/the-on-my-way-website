<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Http;

use Omw\Api\Infra\Db;
use Slim\Psr7\Factory\StreamFactory;
use Slim\Psr7\UploadedFile;

/**
 * Days (summaries of every date with content, detail, patch with tz fixes) and trips
 * (upsert, overlap 422, concurrency, delete).
 */
final class AdminDaysTripsTest extends ApiTestCase
{
    public function testDaySummariesCoverEveryDateWithContent(): void
    {
        $photo = $this->putCapture('3EB0DAY1', '2026-11-16T02:00:00Z');
        $this->putCapture('3EB0DAY2', '2026-11-16T05:00:00Z', ['kind' => 'video']);
        $this->putCapture('3EB0DAY3', '2026-11-16T06:00:00Z', ['kind' => 'text', 'media' => null, 'mediaState' => 'none',
            'text' => ['body' => 'Hello', 'bg' => '#112233ff', 'fg' => '#ffffffff', 'font' => 'SYSTEM']]);
        $this->admin('PATCH', '/api/v1/admin/captures/' . rawurlencode($photo), ['visibility' => 'hidden']);
        $this->admin('POST', '/api/v1/admin/posts', ['publicId' => 'p_01JDAYS0001', 'kind' => 'note', 'origLocale' => 'de', 'occurredAt' => '2026-11-16T08:00:00Z', 'tz' => 'Asia/Ho_Chi_Minh', 'visibility' => 'pending', 'content' => ['de' => ['body' => 'x']]]);
        $this->admin('PATCH', '/api/v1/admin/days/2026-11-20', ['title' => ['de' => 'Ruhetag']]);
        $this->admin('PUT', '/api/v1/admin/trips/vietnam-2026', ['slug' => 'vietnam-2026', 'title' => ['de' => 'Vietnam'], 'startDate' => '2026-11-14', 'endDate' => '2026-11-18']);

        // The video's poster becomes the cover preview.
        $poster = new UploadedFile((new StreamFactory())->createStream("\xFF\xD8\xFF\xE0" . str_repeat("\0", 40)), 'p.jpg', 'image/jpeg', 44);
        $this->request('POST', '/api/v1/backend/captures/wa%3A3EB0DAY2/preview', ['role' => 'poster'], ['Authorization' => 'Bearer ' . $this->backendToken()], [], [], ['file' => $poster]);

        $days = self::json($this->admin('GET', '/api/v1/admin/days'))['items'];
        self::assertSame(['2026-11-16', '2026-11-20'], array_column($days, 'localDate'));
        $d16 = $days[0];
        self::assertNull($d16['day']);
        self::assertSame(['captures' => 3, 'posts' => 1, 'public' => 2, 'hidden' => 1, 'pending' => 1], $d16['counts']);
        self::assertSame('2026-11-16T02:00:00.000Z', $d16['firstAt']);
        self::assertSame('2026-11-16T08:00:00.000Z', $d16['lastAt']);
        self::assertSame('wa:3EB0DAY2', $d16['coverSourceKey'], 'first PUBLIC photo/video');
        self::assertStringContainsString('/poster?v=', (string) $d16['coverPreviewUrl']);
        self::assertSame('vietnam-2026', $d16['trip']);
        self::assertSame(0, $d16['changeSeq']);

        $d20 = $days[1];
        self::assertSame(['de' => 'Ruhetag'], $d20['day']['title']);
        self::assertSame(['captures' => 0, 'posts' => 0, 'public' => 0, 'hidden' => 0, 'pending' => 0], $d20['counts']);
        self::assertNull($d20['firstAt']);
        self::assertNull($d20['coverSourceKey']);
        self::assertNull($d20['trip']);
        self::assertGreaterThan(0, $d20['changeSeq']);
    }

    public function testDayDetailAndPatch(): void
    {
        $this->putCapture('3EB0DET1', '2026-11-16T02:00:00Z');
        $empty = self::json($this->admin('GET', '/api/v1/admin/days/2026-11-17'));
        self::assertNull($empty['day']);
        self::assertSame([], $empty['captures']);
        self::assertSame(0, $empty['changeSeq']);
        self::assertError($this->admin('GET', '/api/v1/admin/days/2026-02-30'), 422, 'validation_failed');
        self::assertError($this->admin('GET', '/api/v1/admin/days/20261117'), 404, 'not_found');

        $url = '/api/v1/admin/days/2026-11-16';
        self::assertError($this->admin('PATCH', $url, ['placeName' => 'Hội An', 'ifUpdatedAt' => self::NOW]), 409, 'conflict');
        $patched = self::json($this->admin('PATCH', $url, [
            'title' => ['de' => 'Laternen', 'en' => 'Lanterns'], 'origLocale' => 'de', 'placeName' => 'Hội An', 'countryCode' => 'VN',
            'lat' => 15.88, 'lng' => 108.33, 'coverSourceKey' => 'wa:3EB0DET1',
        ]));
        self::assertSame('Hội An', $patched['day']['placeName']);
        self::assertSame(15.88, $patched['day']['lat']);
        self::assertCount(1, $patched['captures']);
        self::assertGreaterThan(0, $patched['changeSeq']);

        $cleared = self::json($this->admin('PATCH', $url, ['placeName' => null, 'ifUpdatedAt' => $patched['day']['updatedAt']]));
        self::assertNull($cleared['day']['placeName']);
        self::assertSame(['de' => 'Laternen', 'en' => 'Lanterns'], $cleared['day']['title'], 'absent = unchanged');

        foreach ([['countryCode' => 'vn'], ['lat' => 91], ['tz' => 'Mars/Base'], ['tz' => '+07:00'], ['title' => ['xx' => 'y']], ['nope' => 1]] as $bad) {
            self::assertError($this->admin('PATCH', $url, $bad), 422, 'validation_failed');
        }

        // The feed carries the Day DTO.
        $feed = self::json($this->backend('GET', '/api/v1/backend/changes?after=0&limit=1000'));
        $dayItems = array_values(array_filter($feed['items'], static fn (array $i): bool => $i['entity'] === 'day'));
        self::assertSame(['2026-11-16', '2026-11-16'], array_column($dayItems, 'key'));
        self::assertNull($dayItems[1]['data']['placeName']);

        // Patching a never-edited day with only nulls stores nothing.
        self::assertNull(self::json($this->admin('PATCH', '/api/v1/admin/days/2026-11-17', ['title' => null]))['day']);
    }

    /**
     * Regression: a Day.tz fix re-dates POSTS too (contracts policy Placement; the generator uses
     * effectiveLocalDate(post, null, Day.tz of its stored date)), so the admin's day views and
     * the posts date filter must place them on the same day the site does.
     */
    public function testDayTimeZoneFixMovesPostsLikeTheGenerator(): void
    {
        // 23:30Z = 00:30 CET on 2026-03-29 (stored local date), 23:30 UTC on 2026-03-28.
        $this->admin('POST', '/api/v1/admin/posts', ['publicId' => 'p_01JFIXPOST01', 'kind' => 'note', 'origLocale' => 'de',
            'occurredAt' => '2026-03-28T23:30:00Z', 'tz' => 'Europe/Berlin', 'content' => ['de' => ['body' => 'Mitternacht']]]);
        self::assertSame(['p_01JFIXPOST01'], array_column(self::json($this->admin('GET', '/api/v1/admin/days/2026-03-29'))['posts'], 'publicId'));

        $this->admin('PATCH', '/api/v1/admin/days/2026-03-29', ['tz' => 'UTC']);

        self::assertSame([], self::json($this->admin('GET', '/api/v1/admin/days/2026-03-29'))['posts']);
        $d28 = self::json($this->admin('GET', '/api/v1/admin/days/2026-03-28'));
        self::assertSame(['p_01JFIXPOST01'], array_column($d28['posts'], 'publicId'));
        self::assertSame('2026-03-29', $d28['posts'][0]['localDate'], 'the stored local date is unchanged');

        $days = [];
        foreach (self::json($this->admin('GET', '/api/v1/admin/days'))['items'] as $summary) {
            $days[$summary['localDate']] = $summary['counts']['posts'];
        }
        self::assertSame(['2026-03-28' => 1, '2026-03-29' => 0], $days);

        self::assertSame(['p_01JFIXPOST01'], array_column(self::json($this->admin('GET', '/api/v1/admin/posts?date=2026-03-28'))['items'], 'publicId'));
        self::assertSame([], self::json($this->admin('GET', '/api/v1/admin/posts?date=2026-03-29'))['items']);
    }

    /** Regression: a Day.tz fix can move an item by TWO days (UTC+14 -> UTC-11). */
    public function testDayTimeZoneFixCanMoveItemsByTwoDays(): void
    {
        // 00:30 on 2026-06-10 in Kiritimati (+14) = 2026-06-09T10:30Z = 23:30 on 2026-06-08 in Pago Pago (-11).
        $key = $this->putCapture('3EB0KIRI01', '2026-06-09T10:30:00Z', ['tz' => 'Pacific/Kiritimati', 'localDate' => '2026-06-10']);
        $this->admin('POST', '/api/v1/admin/posts', ['publicId' => 'p_01JFIXPOST02', 'kind' => 'note', 'origLocale' => 'en',
            'occurredAt' => '2026-06-09T10:30:00Z', 'tz' => 'Pacific/Kiritimati', 'content' => ['en' => ['body' => 'Dateline']]]);
        $this->admin('PATCH', '/api/v1/admin/days/2026-06-10', ['tz' => 'Pacific/Pago_Pago']);

        $detail = self::json($this->admin('GET', '/api/v1/admin/days/2026-06-08'));
        self::assertSame([$key], array_column($detail['captures'], 'sourceKey'));
        self::assertSame(['p_01JFIXPOST02'], array_column($detail['posts'], 'publicId'));
        self::assertSame([$key], array_column(self::json($this->admin('GET', '/api/v1/admin/captures?date=2026-06-08'))['items'], 'sourceKey'));
        self::assertSame(['p_01JFIXPOST02'], array_column(self::json($this->admin('GET', '/api/v1/admin/posts?date=2026-06-08'))['items'], 'publicId'));
        self::assertSame([], self::json($this->admin('GET', '/api/v1/admin/days/2026-06-10'))['captures']);
    }

    public function testTripsUpsertOverlapAndDelete(): void
    {
        $vn = ['slug' => 'vietnam-2026', 'title' => ['de' => 'Vietnam'], 'startDate' => '2026-11-14', 'endDate' => '2026-11-30', 'origLocale' => 'de'];
        $created = $this->admin('PUT', '/api/v1/admin/trips/vietnam-2026', $vn);
        self::assertSame(201, $created->getStatusCode(), (string) $created->getBody());
        $trip = self::json($created);
        self::assertSame(200, $this->admin('PUT', '/api/v1/admin/trips/vietnam-2026', $vn)->getStatusCode(), 'unchanged replay');

        $overlap = $this->admin('PUT', '/api/v1/admin/trips/laos', ['slug' => 'laos', 'title' => ['de' => 'Laos'], 'startDate' => '2026-11-30', 'endDate' => '2026-12-05']);
        self::assertError($overlap, 422, 'validation_failed');
        self::assertSame(['vietnam-2026'], self::json($overlap)['error']['details']['overlaps']);
        self::assertSame(201, $this->admin('PUT', '/api/v1/admin/trips/laos', ['slug' => 'laos', 'title' => ['de' => 'Laos'], 'startDate' => '2026-12-01', 'endDate' => '2026-12-05'])->getStatusCode());

        self::assertError($this->admin('PUT', '/api/v1/admin/trips/x', ['slug' => 'y'] + $vn), 422, 'validation_failed');
        self::assertError($this->admin('PUT', '/api/v1/admin/trips/vietnam-2026', ['endDate' => '2026-11-01'] + $vn), 422, 'validation_failed');
        self::assertError($this->admin('PUT', '/api/v1/admin/trips/Bad_Slug', ['slug' => 'Bad_Slug'] + $vn), 422, 'validation_failed');
        self::assertError($this->admin('PUT', '/api/v1/admin/trips/vietnam-2026', ['ifUpdatedAt' => '2020-01-01T00:00:00Z'] + $vn), 409, 'conflict');

        // PUT replaces: description set, then cleared by omission.
        $withDesc = self::json($this->admin('PUT', '/api/v1/admin/trips/vietnam-2026', ['description' => ['de' => 'Süden'], 'ifUpdatedAt' => $trip['updatedAt']] + $vn));
        self::assertSame(['de' => 'Süden'], $withDesc['description']);
        self::assertNull(self::json($this->admin('PUT', '/api/v1/admin/trips/vietnam-2026', $vn))['description']);

        self::assertSame(['vietnam-2026', 'laos'], array_column(self::json($this->admin('GET', '/api/v1/admin/trips'))['items'], 'slug'));
        $deleted = $this->admin('DELETE', '/api/v1/admin/trips/laos');
        self::assertSame(204, $deleted->getStatusCode());
        $again = $this->admin('DELETE', '/api/v1/admin/trips/laos');
        self::assertSame(204, $again->getStatusCode(), 'deleting again is fine');
        self::assertError($this->admin('GET', '/api/v1/admin/trips/laos'), 404, 'not_found');
        $ops = $this->service(Db::class)->all("SELECT op FROM change_log WHERE entity = 'trip' AND entity_key = 'laos' ORDER BY seq");
        self::assertSame(['upsert', 'delete'], array_column($ops, 'op'));
    }
}
