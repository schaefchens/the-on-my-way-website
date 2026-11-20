<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Http;

use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;

/**
 * GET/PATCH /admin/captures: filters, paging, effective visibility (publish modes incl.
 * publish.mode_since), effective local date (overrides, Day.tz fixes across DST), annotations
 * with optimistic concurrency and the change feed.
 */
final class AdminCapturesTest extends ApiTestCase
{
    public function testListIsNewestFirstWithCursorPaging(): void
    {
        for ($i = 1; $i <= 7; ++$i) {
            $this->putCapture('3EB0LIST' . $i, sprintf('2026-11-1%dT05:00:00Z', $i), ['kind' => $i % 2 === 0 ? 'video' : 'photo']);
        }
        $seen = [];
        $cursor = null;
        do {
            $page = self::json($this->admin('GET', '/api/v1/admin/captures?limit=3' . ($cursor !== null ? '&cursor=' . $cursor : '')));
            foreach ($page['items'] as $item) {
                $seen[] = $item['sourceKey'];
            }
            $cursor = $page['nextCursor'];
        } while ($cursor !== null);
        self::assertSame(['wa:3EB0LIST7', 'wa:3EB0LIST6', 'wa:3EB0LIST5', 'wa:3EB0LIST4', 'wa:3EB0LIST3', 'wa:3EB0LIST2', 'wa:3EB0LIST1'], $seen);

        $videos = self::json($this->admin('GET', '/api/v1/admin/captures?kind=video'));
        self::assertSame(['wa:3EB0LIST6', 'wa:3EB0LIST4', 'wa:3EB0LIST2'], array_column($videos['items'], 'sourceKey'));
        self::assertNull($videos['nextCursor']);

        self::assertError($this->admin('GET', '/api/v1/admin/captures?limit=0'), 422, 'validation_failed');
        self::assertError($this->admin('GET', '/api/v1/admin/captures?limit=abc'), 422, 'validation_failed');
        self::assertError($this->admin('GET', '/api/v1/admin/captures?kind=sticker'), 422, 'validation_failed');
        self::assertError($this->admin('GET', '/api/v1/admin/captures?date=2026-02-30'), 422, 'validation_failed');
        self::assertError($this->admin('GET', '/api/v1/admin/captures?cursor=%%%'), 422, 'validation_failed');
        self::assertError($this->admin('GET', '/api/v1/admin/captures?foo=1'), 422, 'validation_failed');
        self::assertError($this->admin('GET', '/api/v1/admin/captures/wa%3ANOPE'), 404, 'not_found');
    }

    public function testDateFilterUsesTheEffectiveDateIncludingDayTimeZoneFixes(): void
    {
        // 18:30 UTC = 01:30 next day in Ho Chi Minh (+7), 19:30 same day in Berlin (+1).
        $late = $this->putCapture('3EB0DATE1', '2026-11-15T18:30:00Z');
        $this->putCapture('3EB0DATE2', '2026-11-16T03:00:00Z');
        self::assertSame([$late, 'wa:3EB0DATE2'], array_reverse(array_column(self::json($this->admin('GET', '/api/v1/admin/captures?date=2026-11-16'))['items'], 'sourceKey')));

        // The owner fixes the zone of 2026-11-16 to Berlin: the late capture moves to the 15th.
        self::assertSame(200, $this->admin('PATCH', '/api/v1/admin/days/2026-11-16', ['tz' => 'Europe/Berlin'])->getStatusCode());
        $on16 = self::json($this->admin('GET', '/api/v1/admin/captures?date=2026-11-16'))['items'];
        self::assertSame(['wa:3EB0DATE2'], array_column($on16, 'sourceKey'));
        $on15 = self::json($this->admin('GET', '/api/v1/admin/captures?date=2026-11-15'))['items'];
        self::assertSame([$late], array_column($on15, 'sourceKey'));
        self::assertSame('Europe/Berlin', $on15[0]['effectiveTz']);
        self::assertSame('2026-11-16', $on15[0]['localDate'], 'the stored date stays');

        // A localDateOverride wins over the Day.tz fix and keeps the capture's zone.
        $this->admin('PATCH', '/api/v1/admin/captures/' . rawurlencode($late), ['localDateOverride' => '2026-11-20']);
        $moved = self::json($this->admin('GET', '/api/v1/admin/captures?date=2026-11-20'))['items'];
        self::assertSame([$late], array_column($moved, 'sourceKey'));
        self::assertSame('Asia/Ho_Chi_Minh', $moved[0]['effectiveTz']);
    }

    public function testDstLocalDates(): void
    {
        // Berlin spring-forward night: 00:59Z = 01:59 CET, 01:00Z = 03:00 CEST, 22:00Z = 00:00 next day.
        $this->putCapture('3EB0DST1', '2026-03-29T00:59:00Z', ['tz' => 'Europe/Berlin', 'localDate' => '2026-03-29']);
        $this->putCapture('3EB0DST2', '2026-03-29T22:00:00Z', ['tz' => 'Europe/Berlin', 'localDate' => '2026-03-30']);
        // Fixing the 29th to New York re-dates the first capture to the 28th (19:59 EST... EDT).
        $this->admin('PATCH', '/api/v1/admin/days/2026-03-29', ['tz' => 'America/New_York']);
        $first = self::json($this->admin('GET', '/api/v1/admin/captures/wa%3A3EB0DST1'));
        self::assertSame('2026-03-28', $first['effectiveLocalDate']);
        $second = self::json($this->admin('GET', '/api/v1/admin/captures/wa%3A3EB0DST2'));
        self::assertSame('2026-03-30', $second['effectiveLocalDate'], 'the fix applies to the stored date only');
    }

    public function testEffectiveVisibilityFollowsThePublishPolicy(): void
    {
        $old = $this->putCapture('3EB0VIS1', '2026-11-19T10:00:00Z');
        self::assertSame('public', self::json($this->admin('GET', '/api/v1/admin/captures/' . rawurlencode($old)))['effectiveVisibility']);

        // Switching to review at NOW only affects captures from NOW on (publish.mode_since).
        $settings = self::json($this->admin('PATCH', '/api/v1/admin/settings', ['publish.mode' => 'review']));
        self::assertSame(self::NOW, $settings['publish.mode_since']);
        $new = $this->putCapture('3EB0VIS2', '2026-11-20T10:30:00Z');
        self::assertSame('public', self::json($this->admin('GET', '/api/v1/admin/captures/' . rawurlencode($old)))['effectiveVisibility']);
        self::assertSame('pending', self::json($this->admin('GET', '/api/v1/admin/captures/' . rawurlencode($new)))['effectiveVisibility']);
        self::assertSame([$new], array_column(self::json($this->admin('GET', '/api/v1/admin/captures?visibility=pending'))['items'], 'sourceKey'));

        // Delayed by 60 min: pending until occurredAt + 60 min.
        Clock::advance('+1 hour');
        $this->admin('PATCH', '/api/v1/admin/settings', ['publish.mode' => 'delayed', 'publish.delay_minutes' => 60]);
        $recent = $this->putCapture('3EB0VIS3', '2026-11-20T11:05:00Z');
        self::assertSame('pending', self::json($this->admin('GET', '/api/v1/admin/captures/' . rawurlencode($recent)))['effectiveVisibility']);
        Clock::advance('+64 minutes'); // 12:04: one minute short of 11:05 + 60 min
        $almost = self::json($this->admin('GET', '/api/v1/admin/captures/' . rawurlencode($recent)));
        self::assertSame('pending', $almost['effectiveVisibility']);
        Clock::advance('+1 minute');
        $due = self::json($this->admin('GET', '/api/v1/admin/captures/' . rawurlencode($recent)));
        self::assertSame('public', $due['effectiveVisibility']);

        // An owner override always wins.
        $this->admin('PATCH', '/api/v1/admin/captures/' . rawurlencode($old), ['visibility' => 'hidden']);
        self::assertSame('hidden', self::json($this->admin('GET', '/api/v1/admin/captures/' . rawurlencode($old)))['effectiveVisibility']);
    }

    public function testAnnotationPatchSemanticsAndConcurrency(): void
    {
        $key = $this->putCapture('3EB0ANN1', '2026-11-18T02:00:00Z');
        $url = '/api/v1/admin/captures/' . rawurlencode($key);
        $db = $this->service(Db::class);
        $seq0 = (int) $db->scalar('SELECT MAX(seq) FROM change_log');

        // Not annotated yet: an ifUpdatedAt cannot match.
        self::assertError($this->admin('PATCH', $url, ['visibility' => 'hidden', 'ifUpdatedAt' => self::NOW]), 409, 'conflict');

        $first = $this->admin('PATCH', $url, ['description' => ['de' => 'Laternen', 'en' => 'Lanterns'], 'origLocale' => 'de']);
        self::assertSame(200, $first->getStatusCode(), (string) $first->getBody());
        $item = self::json($first);
        self::assertSame(['de' => 'Laternen', 'en' => 'Lanterns'], $item['annotation']['description']);
        self::assertNull($item['annotation']['visibility']);
        self::assertSame(self::NOW, $item['annotation']['updatedAt']);
        self::assertSame($seq0 + 1, $item['changeSeq']);

        // Absent = unchanged, null = clear; a second write in the same millisecond still gets a newer updatedAt.
        $second = self::json($this->admin('PATCH', $url, ['visibility' => 'hidden', 'ifUpdatedAt' => $item['annotation']['updatedAt']]));
        self::assertSame(['de' => 'Laternen', 'en' => 'Lanterns'], $second['annotation']['description']);
        self::assertSame('hidden', $second['annotation']['visibility']);
        self::assertGreaterThan($item['annotation']['updatedAt'], $second['annotation']['updatedAt']);
        self::assertError($this->admin('PATCH', $url, ['visibility' => 'public', 'ifUpdatedAt' => $item['annotation']['updatedAt']]), 409, 'conflict');

        $third = self::json($this->admin('PATCH', $url, ['description' => null]));
        self::assertNull($third['annotation']['description']);
        self::assertSame('hidden', $third['annotation']['visibility']);

        // A no-op patch writes nothing.
        $seq = (int) $db->scalar('SELECT MAX(seq) FROM change_log');
        self::assertSame(200, $this->admin('PATCH', $url, ['visibility' => 'hidden'])->getStatusCode());
        self::assertSame($seq, (int) $db->scalar('SELECT MAX(seq) FROM change_log'));

        // The change feed carries the Annotation DTO.
        $feed = self::json($this->backend('GET', '/api/v1/backend/changes?after=' . $seq0));
        self::assertSame(['annotation', 'annotation', 'annotation'], array_column($feed['items'], 'entity'));
        $last = $feed['items'][2];
        self::assertSame($key, $last['key']);
        self::assertSame(['sourceKey' => $key, 'description' => null, 'origLocale' => 'de', 'visibility' => 'hidden', 'localDateOverride' => null, 'updatedAt' => $third['annotation']['updatedAt']], $last['data']);

        // Validation.
        self::assertError($this->admin('PATCH', $url, ['visibility' => 'secret']), 422, 'validation_failed');
        self::assertError($this->admin('PATCH', $url, ['localDateOverride' => '2026-13-01']), 422, 'validation_failed');
        self::assertError($this->admin('PATCH', $url, ['description' => ['fr' => 'Bonjour']]), 422, 'validation_failed');
        self::assertError($this->admin('PATCH', '/api/v1/admin/captures/wa%3ANOPE', ['visibility' => 'hidden']), 404, 'not_found');
        self::assertError($this->admin('PATCH', $url, 'visibility=hidden', ['Content-Type' => 'application/x-www-form-urlencoded']), 415, 'unsupported_media_type');
    }

    public function testEmptyPatchOnAnUnannotatedCaptureCreatesNothing(): void
    {
        $key = $this->putCapture('3EB0ANN2', '2026-11-18T02:00:00Z');
        $item = self::json($this->admin('PATCH', '/api/v1/admin/captures/' . rawurlencode($key), ['visibility' => null]));
        self::assertNull($item['annotation']);
        self::assertSame(0, $item['changeSeq']);
        self::assertSame(0, (int) $this->service(Db::class)->scalar('SELECT COUNT(*) FROM annotations'));
    }
}
