<?php

declare(strict_types=1);

namespace Omw\Api\Domain;

use DateTimeImmutable;
use DateTimeZone;
use InvalidArgumentException;

/**
 * PHP port of packages/contracts/src/time.ts (D6), checked against fixtures/vectors/time.json.
 *
 * - occurredAt: ISO-8601 UTC instant ("…Z")
 * - tz: IANA zone
 * - localDate: "YYYY-MM-DD" = calendar date of occurredAt in tz
 *
 * DST-correct because PHP converts with the zone's transition rules (bundled timezonedb).
 */
final class Time
{
    private const TZ_RE = '/^[A-Za-z][A-Za-z0-9_+\-\/]*$/D';
    private const DATE_RE = '/^(\d{4})-(\d{2})-(\d{2})$/D';
    private const ISO_UTC_RE = '/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/D';

    /** @var array<string, string>|null lowercase name => canonical name */
    private static ?array $zones = null;

    /** @var array<string, DateTimeZone> */
    private static array $zoneCache = [];

    /**
     * True for IANA zone names known to the zone database ("Europe/Berlin", "UTC", and the
     * backward-compatible aliases like "Asia/Saigon" that Intl accepts too). Rejects raw offsets
     * ("+07:00") and abbreviations ("CEST"), which PHP's DateTimeZone would otherwise accept.
     * Like Intl, the match is case-insensitive.
     */
    public static function isValidTimeZone(mixed $tz): bool
    {
        return self::canonicalTimeZone($tz) !== null;
    }

    /**
     * The zone database's own spelling of a valid zone name ("asia/saigon" -> "Asia/Saigon",
     * "utc" -> "UTC"), or null when {@see isValidTimeZone()} would reject it. Aliases stay aliases
     * (Intl keeps "Asia/Saigon" too); only the letter case is normalized. DateTimeZone::getName()
     * does not do this: it echoes the name as given.
     */
    public static function canonicalTimeZone(mixed $tz): ?string
    {
        if (!is_string($tz) || $tz === '' || strlen($tz) > 64 || preg_match(self::TZ_RE, $tz) !== 1) {
            return null;
        }
        if (self::$zones === null) {
            self::$zones = [];
            foreach (DateTimeZone::listIdentifiers(DateTimeZone::ALL_WITH_BC) as $id) {
                self::$zones[strtolower($id)] = $id;
            }
            self::$zones['utc'] ??= 'UTC';
        }

        return self::$zones[strtolower($tz)] ?? null;
    }

    public static function zone(string $tz): DateTimeZone
    {
        if (!self::isValidTimeZone($tz)) {
            throw new InvalidArgumentException("Invalid time zone: $tz");
        }

        return self::$zoneCache[$tz] ??= new DateTimeZone($tz);
    }

    public static function isIsoUtc(mixed $value): bool
    {
        if (!is_string($value) || preg_match(self::ISO_UTC_RE, $value) !== 1) {
            return false;
        }
        try {
            self::instant($value);

            return self::isValidLocalDate(substr($value, 0, 10));
        } catch (InvalidArgumentException) {
            return false;
        }
    }

    /** Parses an ISO-8601 instant (UTC "Z" form, or anything with an explicit offset). */
    public static function instant(string $iso): DateTimeImmutable
    {
        if (trim($iso) === '' || preg_match('/^\d{4}-\d{2}-\d{2}T/', $iso) !== 1) {
            throw new InvalidArgumentException("Invalid instant: $iso");
        }
        try {
            $at = new DateTimeImmutable($iso, new DateTimeZone('UTC'));
        } catch (\Exception) {
            throw new InvalidArgumentException("Invalid instant: $iso");
        }

        return $at->setTimezone(new DateTimeZone('UTC'));
    }

    /** Milliseconds since the epoch. */
    public static function millis(string $iso): int
    {
        $at = self::instant($iso);

        return (int) $at->format('U') * 1000 + (int) $at->format('v');
    }

    /** Canonical ISO UTC string with milliseconds ("2026-11-18T02:12:00.000Z"). */
    public static function toIsoUtc(string $iso): string
    {
        return self::instant($iso)->format('Y-m-d\TH:i:s.v\Z');
    }

    public static function fromMillis(int $ms): string
    {
        $seconds = intdiv($ms, 1000);
        $rest = $ms % 1000;
        if ($rest < 0) {
            $rest += 1000;
            --$seconds;
        }
        $at = (new DateTimeImmutable('@' . $seconds))->setTimezone(new DateTimeZone('UTC'));

        return $at->format('Y-m-d\TH:i:s') . sprintf('.%03dZ', $rest);
    }

    /** Calendar date "YYYY-MM-DD" of the instant in the given IANA zone. */
    public static function localDateFor(string $isoUtc, string $tz): string
    {
        return self::instant($isoUtc)->setTimezone(self::zone($tz))->format('Y-m-d');
    }

    /** Wall-clock time "HH:mm" (24h) of the instant in the given IANA zone. */
    public static function localTimeFor(string $isoUtc, string $tz): string
    {
        return self::instant($isoUtc)->setTimezone(self::zone($tz))->format('H:i');
    }

    /** UTC offset in minutes (east positive) of the zone at that instant, e.g. 420 for +07:00. */
    public static function utcOffsetMinutes(string $isoUtc, string $tz): int
    {
        return intdiv(self::instant($isoUtc)->setTimezone(self::zone($tz))->getOffset(), 60);
    }

    /** True for a real calendar date in "YYYY-MM-DD" form. */
    public static function isValidLocalDate(mixed $date): bool
    {
        if (!is_string($date) || preg_match(self::DATE_RE, $date, $m) !== 1) {
            return false;
        }

        return checkdate((int) $m[2], (int) $m[3], (int) $m[1]);
    }

    /** Calendar arithmetic on "YYYY-MM-DD" (no time zones involved). */
    public static function addDays(string $date, int $n): string
    {
        return self::dateValue($date)->modify(sprintf('%+d days', $n))->format('Y-m-d');
    }

    /** Whole days from $a to $b (b - a). */
    public static function daysBetween(string $a, string $b): int
    {
        $diff = self::dateValue($a)->diff(self::dateValue($b));
        $days = $diff->days === false ? 0 : $diff->days;

        return $diff->invert === 1 ? -$days : $days;
    }

    private static function dateValue(string $date): DateTimeImmutable
    {
        if (!self::isValidLocalDate($date)) {
            throw new InvalidArgumentException("Invalid local date: $date");
        }
        $value = DateTimeImmutable::createFromFormat('!Y-m-d', $date, new DateTimeZone('UTC'));
        if ($value === false) {
            throw new InvalidArgumentException("Invalid local date: $date");
        }

        return $value;
    }
}
