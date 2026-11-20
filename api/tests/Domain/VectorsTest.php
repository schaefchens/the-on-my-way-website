<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Domain;

use Omw\Api\Domain\Ids;
use Omw\Api\Domain\Policy;
use Omw\Api\Domain\Time;
use Omw\Api\Tests\TestCase;
use PHPUnit\Framework\Attributes\DataProvider;

/**
 * The PHP ports of the shared pure helpers against the vectors in fixtures/vectors/*.json, which
 * the TypeScript implementations (packages/contracts) are tested against too.
 */
final class VectorsTest extends TestCase
{
    /** @return array<string, mixed> */
    private static function vectors(string $name): array
    {
        $file = dirname(__DIR__, 3) . '/fixtures/vectors/' . $name . '.json';
        self::assertFileExists($file);
        $data = json_decode((string) file_get_contents($file), true, 64, JSON_THROW_ON_ERROR);
        self::assertIsArray($data);

        /** @var array<string, mixed> $data */
        return $data;
    }

    /** @return list<array<string, mixed>> */
    private static function cases(string $name): array
    {
        $cases = self::vectors($name)['cases'] ?? null;
        self::assertIsArray($cases);
        self::assertNotEmpty($cases);

        /** @var list<array<string, mixed>> $cases */
        return $cases;
    }

    public function testTimeVectors(): void
    {
        foreach (self::cases('time') as $i => $c) {
            $iso = (string) $c['isoUtc'];
            $tz = (string) $c['tz'];
            self::assertSame($c['localDate'], Time::localDateFor($iso, $tz), "time #$i localDate $iso $tz");
            self::assertSame($c['localTime'], Time::localTimeFor($iso, $tz), "time #$i localTime $iso $tz");
        }
    }

    public function testIdVectors(): void
    {
        foreach (self::cases('ids') as $c) {
            self::assertSame($c['publicId'], Ids::publicIdForSourceKey((string) $c['sourceKey']), (string) $c['sourceKey']);
        }
    }

    public function testPolicyVectors(): void
    {
        foreach (self::cases('policy') as $i => $c) {
            /** @var array<string, mixed> $settings */
            $settings = $c['settings'];
            /** @var array{occurredAt: string, revokedAt?: string|null} $capture */
            $capture = $c['capture'];
            /** @var array{visibility?: string|null}|null $annotation */
            $annotation = $c['annotation'];
            $actual = Policy::effectiveCaptureVisibility(
                $capture['occurredAt'],
                $capture['revokedAt'] ?? null,
                $annotation['visibility'] ?? null,
                $settings,
                (string) $c['now'],
            );
            self::assertSame($c['expected'], $actual, "policy #$i " . json_encode($c));
        }
    }

    /**
     * publish.mode_since across settings changes and what a switch releases (in particular
     * review -> delayed: exactly the waiting statuses at least as old as the new delay).
     */
    public function testModeSwitchVectors(): void
    {
        $data = self::vectors('mode-switch');
        /** @var list<array{label: string, occurredAt: string}> $captures */
        $captures = $data['captures'];
        $releasedByReviewToDelayed = 0;
        foreach (self::cases('mode-switch') as $i => $c) {
            /** @var array<string, mixed> $before */
            $before = $c['before'];
            /** @var array<string, mixed> $after */
            $after = $c['after'];
            $now = (string) $c['now'];
            $since = Policy::nextModeSince($before, $after, $now);
            $name = sprintf('mode-switch #%d %s -> %s', $i, (string) $before['publish.mode'], (string) $after['publish.mode']);
            self::assertSame($c['modeSince'], $since, $name);
            $afterSettings = array_merge($before, $after, ['publish.mode_since' => $since]);
            /** @var list<string> $visBefore */
            $visBefore = $c['visibilityBefore'];
            /** @var list<string> $visAfter */
            $visAfter = $c['visibilityAfter'];
            foreach ($captures as $j => $capture) {
                $was = Policy::effectiveCaptureVisibility($capture['occurredAt'], null, null, $before, $now);
                $is = Policy::effectiveCaptureVisibility($capture['occurredAt'], null, null, $afterSettings, $now);
                self::assertSame($visBefore[$j], $was, "$name {$capture['label']} before");
                self::assertSame($visAfter[$j], $is, "$name {$capture['label']} after");
                if ($before['publish.mode'] === 'review' && $after['publish.mode'] === 'delayed' && $was === 'pending' && $is === 'public') {
                    ++$releasedByReviewToDelayed;
                }
            }
        }
        self::assertGreaterThan(0, $releasedByReviewToDelayed);
    }

    public function testPlacementVectors(): void
    {
        foreach (self::cases('placement') as $i => $c) {
            /** @var array{occurredAt: string, tz: string, localDate: string} $item */
            $item = $c['item'];
            /** @var array{localDateOverride?: string|null}|null $annotation */
            $annotation = $c['annotation'];
            $override = $annotation['localDateOverride'] ?? null;
            $dayTz = is_string($c['dayTz']) ? $c['dayTz'] : null;
            self::assertSame($c['localDate'], Policy::effectiveLocalDate($item['occurredAt'], $item['localDate'], $override, $dayTz), "placement #$i date");
            self::assertSame($c['tz'], Policy::effectiveTz($item['tz'], $override, $dayTz), "placement #$i tz");
        }
    }

    public function testTripVectors(): void
    {
        $data = self::vectors('trips');
        /** @var list<array{slug: string, startDate: string, endDate: string}> $trips */
        $trips = $data['trips'];
        foreach (self::cases('trips') as $c) {
            self::assertSame($c['trip'], Policy::tripForDate((string) $c['date'], $trips), (string) $c['date']);
        }
    }

    public function testOverlappingTrips(): void
    {
        $trips = [
            ['slug' => 'a', 'startDate' => '2026-11-01', 'endDate' => '2026-11-10'],
            ['slug' => 'b', 'startDate' => '2026-11-11', 'endDate' => '2026-11-20'],
        ];
        self::assertSame([], Policy::overlappingTrips(['slug' => 'c', 'startDate' => '2026-11-21', 'endDate' => '2026-11-22'], $trips));
        self::assertSame(['a', 'b'], Policy::overlappingTrips(['slug' => 'c', 'startDate' => '2026-11-10', 'endDate' => '2026-11-11'], $trips));
        self::assertSame([], Policy::overlappingTrips(['slug' => 'a', 'startDate' => '2026-11-01', 'endDate' => '2026-11-10'], $trips), 'a trip never overlaps itself');
    }

    public function testCapturePublishAt(): void
    {
        $delayed = ['publish.mode' => 'delayed', 'publish.delay_minutes' => 60, 'ingest.on_revoke' => 'hide', 'publish.mode_since' => Policy::MODE_SINCE_EPOCH];
        self::assertSame('2026-11-18T03:00:00.000Z', Policy::capturePublishAt('2026-11-18T02:00:00Z', null, null, $delayed));
        self::assertNull(Policy::capturePublishAt('2026-11-18T02:00:00Z', '2026-11-18T02:05:00Z', null, $delayed));
        self::assertSame('2026-11-18T02:00:00.000Z', Policy::capturePublishAt('2026-11-18T02:00:00Z', null, 'public', $delayed));
        self::assertNull(Policy::capturePublishAt('2026-11-18T02:00:00Z', null, null, ['publish.mode' => 'review'] + $delayed));
    }

    /** @return iterable<string, array{mixed, bool}> */
    public static function timeZones(): iterable
    {
        yield 'berlin' => ['Europe/Berlin', true];
        yield 'utc' => ['UTC', true];
        yield 'alias' => ['Asia/Saigon', true];
        yield 'lowercase (Intl accepts it)' => ['europe/berlin', true];
        yield 'offset' => ['+07:00', false];
        yield 'abbreviation' => ['CEST', false];
        yield 'unknown' => ['Mars/Olympus', false];
        yield 'empty' => ['', false];
        yield 'not a string' => [7, false];
    }

    #[DataProvider('timeZones')]
    public function testTimeZoneValidation(mixed $tz, bool $valid): void
    {
        self::assertSame($valid, Time::isValidTimeZone($tz));
    }

    /**
     * Regression: in PCRE "$" also matches before a final "\n" (unlike the JS regexes of the
     * contracts and JSON Schema patterns), so "wa:abc\n" or "2026-01-01\n" used to pass.
     */
    public function testValidatorsRejectATrailingNewline(): void
    {
        self::assertFalse(Ids::isSourceKey("wa:3EB0\n"));
        self::assertFalse(Ids::isPostPublicId("p_abcd\n"));
        self::assertFalse(Ids::isSlug("vietnam\n"));
        self::assertFalse(Time::isValidLocalDate("2026-01-01\n"));
        self::assertFalse(Time::isValidTimeZone("UTC\n"));
        self::assertFalse(Time::isIsoUtc("2026-01-01T00:00:00Z\n"));
        self::assertFalse(\Omw\Api\Domain\Auth\ApiTokens::looksLikeToken('omw_' . str_repeat('a', 43) . "\n"));
        self::assertTrue(Ids::isSourceKey('wa:3EB0'));
        self::assertTrue(Time::isValidLocalDate('2026-01-01'));
    }

    public function testDateHelpers(): void
    {
        self::assertTrue(Time::isValidLocalDate('2028-02-29'));
        self::assertFalse(Time::isValidLocalDate('2026-02-29'));
        self::assertFalse(Time::isValidLocalDate('2026-2-01'));
        self::assertSame('2026-03-01', Time::addDays('2026-02-28', 1));
        self::assertSame('2026-12-31', Time::addDays('2027-01-01', -1));
        self::assertSame(3, Time::daysBetween('2026-11-15', '2026-11-18'));
        self::assertSame(-3, Time::daysBetween('2026-11-18', '2026-11-15'));
        self::assertSame(420, Time::utcOffsetMinutes('2026-11-18T00:00:00Z', 'Asia/Ho_Chi_Minh'));
        self::assertSame(120, Time::utcOffsetMinutes('2026-07-01T00:00:00Z', 'Europe/Berlin'));
        self::assertSame('2026-11-18T02:00:00.000Z', Time::toIsoUtc('2026-11-18T02:00:00Z'));
        self::assertTrue(Time::isIsoUtc('2026-11-18T02:00:00.123Z'));
        self::assertFalse(Time::isIsoUtc('2026-11-18T02:00:00+01:00'));
    }
}
