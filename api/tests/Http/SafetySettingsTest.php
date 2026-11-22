<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Http;

use Omw\Api\Domain\Settings;
use Omw\Api\Infra\Db;

/**
 * Wave 5 settings (spec-wave5 §4.2, seeded by migrations/0002_settings_w5.sql): release slots,
 * departure hold, "moved on", here-now and time precision. Defaults keep today's behaviour,
 * validation follows the contract (incl. ascending, unique slot times), changes are announced on
 * the change feed and publish.moved_on_at clears with null.
 */
final class SafetySettingsTest extends ApiTestCase
{
    public function testDefaultsAreSeededAndAnnounced(): void
    {
        $settings = self::json($this->admin('GET', '/api/v1/admin/settings'));
        self::assertSame(['enabled' => false, 'times' => ['08:00', '20:00']], $settings['publish.release_slots']);
        self::assertSame(['enabled' => false, 'maxDays' => 7], $settings['publish.departure_hold']);
        self::assertSame('city_badge', $settings['site.here_now']);
        self::assertSame('exact', $settings['site.time_precision']);
        self::assertArrayNotHasKey('publish.moved_on_at', $settings, 'optional, no default');

        $rows = $this->service(Db::class)->all(
            "SELECT entity_key, op, data FROM change_log WHERE entity = 'setting' AND entity_key IN
             ('publish.release_slots', 'publish.departure_hold', 'site.here_now', 'site.time_precision') ORDER BY seq",
        );
        self::assertSame(
            ['publish.departure_hold', 'publish.release_slots', 'site.here_now', 'site.time_precision'],
            array_column($rows, 'entity_key'),
            'a fresh backend mirrors the new keys from the feed',
        );
        foreach ($rows as $row) {
            $data = json_decode((string) $row['data'], true, 16, JSON_THROW_ON_ERROR);
            self::assertIsArray($data);
            self::assertSame('upsert', $row['op']);
            self::assertEquals(Settings::DEFAULTS[(string) $row['entity_key']], $data['value']);
        }
    }

    public function testPatchValidatesAndAnnounces(): void
    {
        $seq = $this->maxSeq();
        $patch = [
            'publish.release_slots' => ['enabled' => true, 'times' => ['07:30', '12:00', '19:45']],
            'publish.departure_hold' => ['enabled' => true, 'maxDays' => 3],
            'publish.moved_on_at' => '2026-11-20T08:00:00.000Z',
            'site.here_now' => 'country',
            'site.time_precision' => 'part_of_day',
        ];
        $response = $this->admin('PATCH', '/api/v1/admin/settings', $patch);
        self::assertSame(200, $response->getStatusCode(), (string) $response->getBody());
        $settings = self::json($response);
        foreach ($patch as $key => $value) {
            self::assertSame($value, $settings[$key], $key);
        }
        self::assertSame($settings, self::json($this->admin('GET', '/api/v1/admin/settings')));
        $items = $this->settingItemsAfter($seq);
        self::assertSame(
            ['publish.release_slots', 'publish.departure_hold', 'publish.moved_on_at', 'site.here_now', 'site.time_precision'],
            array_column($items, 'key'),
            'contract order',
        );

        // null clears "moved on" (a tombstone on the feed); the other new keys cannot be cleared.
        $seq = $this->maxSeq();
        $cleared = self::json($this->admin('PATCH', '/api/v1/admin/settings', ['publish.moved_on_at' => null]));
        self::assertArrayNotHasKey('publish.moved_on_at', $cleared);
        self::assertSame([['publish.moved_on_at', 'delete']], array_map(
            static fn (array $i): array => [$i['key'], $i['op']],
            $this->settingItemsAfter($seq),
        ));
        foreach (['publish.release_slots', 'publish.departure_hold', 'site.here_now', 'site.time_precision'] as $key) {
            self::assertError($this->admin('PATCH', '/api/v1/admin/settings', [$key => null]), 422, 'validation_failed');
        }
    }

    public function testInvalidValuesAreRefused(): void
    {
        $bad = [
            ['publish.release_slots' => ['enabled' => true, 'times' => ['20:00', '08:00']]],
            ['publish.release_slots' => ['enabled' => true, 'times' => ['08:00', '08:00']]],
            ['publish.release_slots' => ['enabled' => true, 'times' => []]],
            ['publish.release_slots' => ['enabled' => true, 'times' => ['8:00']]],
            ['publish.release_slots' => ['enabled' => true, 'times' => ['24:00']]],
            ['publish.release_slots' => ['enabled' => true, 'times' => ['01:00', '02:00', '03:00', '04:00', '05:00', '06:00', '07:00']]],
            ['publish.release_slots' => ['enabled' => true]],
            ['publish.departure_hold' => ['enabled' => true, 'maxDays' => 8]],
            ['publish.departure_hold' => ['enabled' => true, 'maxDays' => 0]],
            ['publish.departure_hold' => ['enabled' => 'yes', 'maxDays' => 3]],
            ['publish.moved_on_at' => '2026-11-20T09:00:00+01:00'],
            ['site.here_now' => 'badge'],
            ['site.time_precision' => 'hour'],
        ];
        $seq = $this->maxSeq();
        foreach ($bad as $patch) {
            self::assertError($this->admin('PATCH', '/api/v1/admin/settings', $patch), 422, 'validation_failed');
        }
        self::assertSame([], $this->settingItemsAfter($seq), 'nothing was written');
    }

    public function testProblemsMirrorTheContract(): void
    {
        $base = Settings::DEFAULTS;
        self::assertSame([], Settings::problems($base));
        foreach ([['20:00', '08:00'], ['08:00', '08:00']] as $times) {
            $settings = ['publish.release_slots' => (object) ['enabled' => true, 'times' => $times]] + $base;
            self::assertSame(['publish.release_slots times must be ascending and unique'], Settings::problems($settings));
        }
        $settings = ['publish.release_slots' => ['enabled' => false, 'times' => ['00:00', '23:59']]] + $base;
        self::assertSame([], Settings::problems($settings));
    }

    private function maxSeq(): int
    {
        $this->migrate();

        return (int) $this->service(Db::class)->scalar('SELECT MAX(seq) FROM change_log');
    }

    /** @return list<array<string, mixed>> */
    private function settingItemsAfter(int $seq): array
    {
        $items = self::json($this->backend('GET', '/api/v1/backend/changes?after=' . $seq))['items'];
        self::assertIsArray($items);

        /** @var list<array<string, mixed>> $items */
        return array_values(array_filter($items, static fn (array $i): bool => $i['entity'] === 'setting'));
    }
}
