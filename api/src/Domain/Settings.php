<?php

declare(strict_types=1);

namespace Omw\Api\Domain;

use Omw\Api\Http\ApiException;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;
use Omw\Api\Infra\SchemaValidator;
use stdClass;

/**
 * Owner settings (contract Settings / SettingsPatch). One row per key in `settings`, value
 * JSON-encoded; every change is appended to change_log ("setting" entity) in the same
 * transaction.
 *
 * "publish.mode_since" is maintained here ({@see Policy::nextModeSince()}): it moves only when a
 * change could otherwise flip a public capture back to pending (instant -> delayed/review,
 * delayed -> review, a changed delay while delayed); review -> delayed and -> instant keep it.
 *
 * Rows and change-feed items are written in {@see WRITE_ORDER}: publish.mode_since, then
 * publish.delay_minutes, then publish.mode. A backend that has applied only a prefix of one
 * change (a feed page boundary, a failed next page) therefore never sees the new mode with the
 * old cut-off, which could unpublish the archive.
 *
 * Time-zone names are stored canonically ("asia/saigon" -> "Asia/Saigon", {@see Time::canonicalTimeZone()}).
 */
final class Settings
{
    /** Contract SETTINGS_DEFAULTS (optional keys without a default are absent). */
    public const DEFAULTS = [
        'publish.mode' => 'instant',
        'publish.mode_since' => Policy::MODE_SINCE_EPOCH,
        'publish.delay_minutes' => 720,
        'ingest.on_revoke' => 'hide',
        'timezone.current' => 'Europe/Berlin',
        'site.title' => 'On My Way',
        'site.locales' => ['de', 'en'],
        'site.default_locale' => 'de',
        'site.indexable' => false,
        'alerts.heartbeat_stale_minutes' => 15,
    ];

    /** Every key of the contract's Settings object, in contract order. */
    public const KEYS = [
        'publish.mode', 'publish.mode_since', 'publish.delay_minutes', 'ingest.on_revoke', 'timezone.current',
        'site.title', 'site.locales', 'site.default_locale', 'site.indexable', 'alerts.email', 'alerts.ntfy_url',
        'alerts.heartbeat_stale_minutes',
    ];

    /**
     * Order in which a patch writes rows and change-feed items: the publish cut-off first, the
     * mode last (see the class comment), everything else in contract order.
     */
    public const WRITE_ORDER = [
        'publish.mode_since', 'publish.delay_minutes', 'publish.mode', 'ingest.on_revoke', 'timezone.current',
        'site.title', 'site.locales', 'site.default_locale', 'site.indexable', 'alerts.email', 'alerts.ntfy_url',
        'alerts.heartbeat_stale_minutes',
    ];

    /** Keys a PATCH may clear with null (optional in the contract). */
    public const CLEARABLE = ['alerts.email', 'alerts.ntfy_url'];

    public function __construct(
        private readonly Db $db,
        private readonly ChangeLog $changes,
        private readonly SchemaValidator $schemas,
    ) {
    }

    /**
     * The complete settings object: stored values over the defaults; invalid stored values are
     * ignored and an inconsistent default locale falls back to the first site locale (contract
     * withSettingsDefaults()).
     *
     * @return array<string, mixed>
     */
    public function all(): array
    {
        $stored = [];
        foreach ($this->db->all('SELECT key, value FROM settings') as $row) {
            $stored[(string) $row['key']] = json_decode((string) $row['value'], false, 16, JSON_THROW_ON_ERROR);
        }
        $out = [];
        foreach (self::KEYS as $key) {
            if (array_key_exists($key, $stored) && $this->schemas->errors($stored[$key], 'Settings', '/properties/' . $key) === []
                && ($key !== 'timezone.current' || Time::isValidTimeZone($stored[$key]))) {
                $out[$key] = $stored[$key];
            } elseif (array_key_exists($key, self::DEFAULTS)) {
                $out[$key] = self::DEFAULTS[$key];
            }
        }
        $locales = is_array($out['site.locales'] ?? null) ? $out['site.locales'] : self::DEFAULTS['site.locales'];
        if (!in_array($out['site.default_locale'] ?? null, $locales, true)) {
            $out['site.default_locale'] = $locales[0] ?? 'de';
        }

        return $out;
    }

    public function get(string $key): mixed
    {
        return $this->all()[$key] ?? null;
    }

    /**
     * The subset the publish policy needs (contract PolicySettings).
     *
     * @return array<string, mixed>
     */
    public function policy(): array
    {
        $all = $this->all();

        return [
            'publish.mode' => $all['publish.mode'],
            'publish.delay_minutes' => $all['publish.delay_minutes'],
            'ingest.on_revoke' => $all['ingest.on_revoke'],
            'publish.mode_since' => $all['publish.mode_since'],
        ];
    }

    /**
     * Applies a validated SettingsPatch. Returns the complete settings afterwards.
     *
     * @return array<string, mixed>
     *
     * @throws ApiException 422 for schema violations, unknown time zones and inconsistent locales
     */
    public function patch(stdClass $patch): array
    {
        $errors = $this->schemas->errors($patch, 'SettingsPatch');
        if ($errors !== []) {
            throw ApiException::validation('Invalid settings.', ['errors' => $errors]);
        }
        $values = get_object_vars($patch);
        if (array_key_exists('timezone.current', $values)) {
            $values['timezone.current'] = Time::canonicalTimeZone($values['timezone.current'])
                ?? throw ApiException::validation('timezone.current is not a known IANA time zone.', ['errors' => ['/timezone.current: unknown time zone']]);
        }

        return $this->db->write(function () use ($values): array {
            $current = $this->all();
            $next = $current;
            foreach ($values as $key => $value) {
                if ($value === null && in_array($key, self::CLEARABLE, true)) {
                    unset($next[$key]);
                } else {
                    $next[$key] = $value;
                }
            }
            $problems = self::problems($next);
            if ($problems !== []) {
                throw ApiException::validation(implode('; ', $problems), ['errors' => $problems]);
            }
            $now = Clock::nowIso();
            $next['publish.mode_since'] = Policy::nextModeSince($current, $next, $now);

            foreach (self::WRITE_ORDER as $key) {
                $had = array_key_exists($key, $current);
                $has = array_key_exists($key, $next);
                if ($has && (!$had || !self::same($current[$key], $next[$key]))) {
                    $this->db->exec(
                        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
                         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
                        [$key, json_encode($next[$key], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), $now],
                    );
                    $this->changes->append('setting', $key, 'upsert', $next[$key]);
                } elseif (!$has && $had) {
                    $this->db->exec('DELETE FROM settings WHERE key = ?', [$key]);
                    $this->changes->append('setting', $key, 'delete', null);
                }
            }

            return $this->all();
        });
    }

    /**
     * Cross-field problems of a complete settings object (contract settingsProblems()).
     *
     * @param array<string, mixed> $settings
     * @return list<string>
     */
    public static function problems(array $settings): array
    {
        $problems = [];
        $locales = is_array($settings['site.locales'] ?? null) ? $settings['site.locales'] : [];
        if (!in_array($settings['site.default_locale'] ?? null, $locales, true)) {
            $problems[] = 'site.default_locale must be one of site.locales';
        }
        if (count($locales) !== count(array_unique($locales))) {
            $problems[] = 'site.locales must be unique';
        }

        return $problems;
    }

    private static function same(mixed $a, mixed $b): bool
    {
        return json_encode($a) === json_encode($b);
    }
}
