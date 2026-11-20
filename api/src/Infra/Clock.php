<?php

declare(strict_types=1);

namespace Omw\Api\Infra;

use DateTimeImmutable;
use DateTimeInterface;
use DateTimeZone;

/**
 * Timestamps stored by the API: ISO-8601 UTC with millisecond precision, e.g. "2026-11-19T21:35:00.123Z"
 * (same shape as SQLite's strftime('%Y-%m-%dT%H:%M:%fZ', 'now') and JavaScript's Date#toISOString()).
 *
 * Tests can pin the clock with {@see freeze()} (and must call {@see unfreeze()} afterwards); every
 * API code path reads the time through this class, so a frozen clock drives rate limits, token
 * expiry, alert repeats and publish delays deterministically.
 */
final class Clock
{
    public const ISO_FORMAT = 'Y-m-d\TH:i:s.v\Z';

    private static ?DateTimeImmutable $frozen = null;

    public static function now(): DateTimeImmutable
    {
        return self::$frozen ?? new DateTimeImmutable('now', new DateTimeZone('UTC'));
    }

    public static function nowIso(): string
    {
        return self::iso(self::now());
    }

    public static function iso(DateTimeInterface $at): string
    {
        return DateTimeImmutable::createFromInterface($at)->setTimezone(new DateTimeZone('UTC'))->format(self::ISO_FORMAT);
    }

    /** Milliseconds since the epoch of the current time. */
    public static function nowMillis(): int
    {
        $now = self::now();

        return (int) $now->format('U') * 1000 + (int) $now->format('v');
    }

    /**
     * A write timestamp that is strictly later than $previousIso (when given), so optimistic
     * concurrency (ifUpdatedAt) can always tell two writes of the same row apart, even within
     * one millisecond.
     */
    public static function nowIsoAfter(?string $previousIso): string
    {
        $now = self::now();
        if ($previousIso !== null && $previousIso !== '') {
            try {
                $prev = new DateTimeImmutable($previousIso, new DateTimeZone('UTC'));
            } catch (\Exception) {
                return self::iso($now);
            }
            if (self::iso($now) <= self::iso($prev)) {
                return self::iso($prev->modify('+1 millisecond'));
            }
        }

        return self::iso($now);
    }

    /** Pins the clock (tests only). */
    public static function freeze(DateTimeInterface|string $at): void
    {
        self::$frozen = is_string($at)
            ? new DateTimeImmutable($at, new DateTimeZone('UTC'))
            : DateTimeImmutable::createFromInterface($at)->setTimezone(new DateTimeZone('UTC'));
    }

    /** Moves a frozen clock forward (tests only). */
    public static function advance(string $modifier): void
    {
        self::$frozen = self::now()->modify($modifier);
    }

    public static function unfreeze(): void
    {
        self::$frozen = null;
    }

    public static function isFrozen(): bool
    {
        return self::$frozen !== null;
    }
}
