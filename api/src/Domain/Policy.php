<?php

declare(strict_types=1);

namespace Omw\Api\Domain;

/**
 * PHP port of packages/contracts/src/policy.ts (D11 publish policy, placement, trips), checked
 * against fixtures/vectors/{policy,placement,trips}.json.
 *
 * Capture visibility:
 *   1. annotation.visibility if set (owner override always wins)
 *   2. else revoked && ingest.on_revoke = hide  -> hidden
 *   3. else captures that occurred BEFORE publish.mode_since are evaluated as "instant" -> public
 *   4. else instant -> public; delayed -> public iff now >= occurredAt + delay, else pending;
 *      review -> pending
 *
 * publish.mode_since is maintained by the API ({@see nextModeSince()}, applied by
 * Settings::patch()) so that a mode or delay change never turns a public capture back to pending
 * and never releases what a holding mode keeps back; the only releases are the switch to
 * "instant" and review -> delayed (the review backlog older than the new delay; the admin asks
 * the owner first).
 *
 * Placement: annotation.localDateOverride > Day.tz of the STORED local date > stored values.
 * Trips: tripForDate() resolves overlaps by earliest start, then slug.
 *
 * Settings arrays use the contract keys ("publish.mode", "publish.delay_minutes",
 * "ingest.on_revoke", "publish.mode_since").
 */
final class Policy
{
    public const MODE_SINCE_EPOCH = '1970-01-01T00:00:00.000Z';

    /**
     * The publish mode that applies to a capture (older captures keep "instant").
     *
     * @param array<string, mixed> $settings
     */
    public static function modeForCapture(string $occurredAt, array $settings): string
    {
        $mode = is_string($settings['publish.mode'] ?? null) ? $settings['publish.mode'] : 'instant';
        if ($mode === 'instant') {
            return $mode;
        }
        $since = is_string($settings['publish.mode_since'] ?? null) ? $settings['publish.mode_since'] : self::MODE_SINCE_EPOCH;

        return Time::millis($occurredAt) < Time::millis($since) ? 'instant' : $mode;
    }

    /**
     * publish.mode_since after a settings change from $before to $after (complete settings, keys
     * as in the contract), at $nowIso. With t = now, s0 = the old mode_since, d0 = the old delay:
     *
     *   instant          -> delayed | review   t
     *   delayed          -> review             max(s0, t - d0 + 1 ms)
     *   delayed (d0)     -> delayed (d1 ≠ d0)  max(s0, t - d0 + 1 ms)
     *   review           -> delayed            s0 (the backlog older than the new delay is released)
     *   anything else (-> instant, no change)  s0
     *
     * Under "delayed" a capture is public iff occurredAt <= t - d0; rule 3 (occurredAt < mode_since
     * -> instant) keeps exactly those public, so the cut-off is t - d0 plus one millisecond (the
     * resolution of every stored instant).
     *
     * @param array<string, mixed> $before
     * @param array<string, mixed> $after
     */
    public static function nextModeSince(array $before, array $after, string $nowIso): string
    {
        $since = is_string($before['publish.mode_since'] ?? null) && Time::isIsoUtc($before['publish.mode_since'])
            ? Time::toIsoUtc($before['publish.mode_since'])
            : self::MODE_SINCE_EPOCH;
        $from = is_string($before['publish.mode'] ?? null) ? $before['publish.mode'] : 'instant';
        $to = is_string($after['publish.mode'] ?? null) ? $after['publish.mode'] : 'instant';
        $now = Time::millis($nowIso);

        if ($from === 'instant' && $to !== 'instant') {
            return Time::fromMillis($now);
        }
        $delayChanged = self::delayMillis($before) !== self::delayMillis($after);
        if ($from === 'delayed' && ($to === 'review' || ($to === 'delayed' && $delayChanged))) {
            return Time::fromMillis(max(Time::millis($since), $now - self::delayMillis($before) + 1));
        }

        return $since;
    }

    /**
     * @param array<string, mixed> $settings
     */
    public static function effectiveCaptureVisibility(
        string $occurredAt,
        ?string $revokedAt,
        ?string $visibilityOverride,
        array $settings,
        string $nowIso,
    ): string {
        if ($visibilityOverride !== null && $visibilityOverride !== '') {
            return $visibilityOverride;
        }
        if ($revokedAt !== null && $revokedAt !== '' && ($settings['ingest.on_revoke'] ?? 'hide') === 'hide') {
            return 'hidden';
        }

        return match (self::modeForCapture($occurredAt, $settings)) {
            'delayed' => Time::millis($nowIso) >= Time::millis($occurredAt) + self::delayMillis($settings) ? 'public' : 'pending',
            'review' => 'pending',
            default => 'public',
        };
    }

    /**
     * When a capture becomes public under the current settings (ISO UTC), or null.
     *
     * @param array<string, mixed> $settings
     */
    public static function capturePublishAt(string $occurredAt, ?string $revokedAt, ?string $visibilityOverride, array $settings): ?string
    {
        $occurred = Time::millis($occurredAt);
        if ($visibilityOverride !== null && $visibilityOverride !== '') {
            return $visibilityOverride === 'public' ? Time::fromMillis($occurred) : null;
        }
        if ($revokedAt !== null && $revokedAt !== '' && ($settings['ingest.on_revoke'] ?? 'hide') === 'hide') {
            return null;
        }

        return match (self::modeForCapture($occurredAt, $settings)) {
            'delayed' => Time::fromMillis($occurred + self::delayMillis($settings)),
            'review' => null,
            default => Time::fromMillis($occurred),
        };
    }

    /** Effective local date: override > Day.tz fix of the stored local date > stored local date. */
    public static function effectiveLocalDate(string $occurredAt, string $storedLocalDate, ?string $localDateOverride, ?string $dayTz): string
    {
        if ($localDateOverride !== null && $localDateOverride !== '') {
            return $localDateOverride;
        }
        if ($dayTz !== null && $dayTz !== '') {
            return Time::localDateFor($occurredAt, $dayTz);
        }

        return $storedLocalDate;
    }

    /** Effective zone used to show the item's wall-clock time. */
    public static function effectiveTz(string $storedTz, ?string $localDateOverride, ?string $dayTz): string
    {
        if ($localDateOverride !== null && $localDateOverride !== '') {
            return $storedTz;
        }

        return ($dayTz !== null && $dayTz !== '') ? $dayTz : $storedTz;
    }

    /**
     * Slug of the trip whose [startDate, endDate] contains $date, or null.
     *
     * @param list<array{slug: string, startDate: string, endDate: string}> $trips
     */
    public static function tripForDate(string $date, array $trips): ?string
    {
        usort($trips, [self::class, 'byStartThenSlug']);
        foreach ($trips as $trip) {
            if ($trip['startDate'] <= $date && $date <= $trip['endDate']) {
                return $trip['slug'];
            }
        }

        return null;
    }

    /**
     * @param array{slug: string, startDate: string, endDate: string} $a
     * @param array{slug: string, startDate: string, endDate: string} $b
     */
    public static function tripRangesOverlap(array $a, array $b): bool
    {
        return $a['startDate'] <= $b['endDate'] && $b['startDate'] <= $a['endDate'];
    }

    /**
     * Slugs of existing trips that $candidate would overlap (sorted).
     *
     * @param array{slug: string, startDate: string, endDate: string}       $candidate
     * @param list<array{slug: string, startDate: string, endDate: string}> $trips
     * @return list<string>
     */
    public static function overlappingTrips(array $candidate, array $trips): array
    {
        $out = [];
        foreach ($trips as $trip) {
            if ($trip['slug'] !== $candidate['slug'] && self::tripRangesOverlap($candidate, $trip)) {
                $out[] = $trip['slug'];
            }
        }
        sort($out, SORT_STRING);

        return $out;
    }

    /**
     * @param array{slug: string, startDate: string, endDate: string} $a
     * @param array{slug: string, startDate: string, endDate: string} $b
     */
    private static function byStartThenSlug(array $a, array $b): int
    {
        if ($a['startDate'] !== $b['startDate']) {
            return $a['startDate'] < $b['startDate'] ? -1 : 1;
        }

        return strcmp($a['slug'], $b['slug']) <=> 0;
    }

    /** @param array<string, mixed> $settings */
    private static function delayMillis(array $settings): int
    {
        $minutes = $settings['publish.delay_minutes'] ?? 0;

        return (is_int($minutes) || is_float($minutes)) && $minutes > 0 ? (int) round($minutes * 60_000) : 0;
    }
}
