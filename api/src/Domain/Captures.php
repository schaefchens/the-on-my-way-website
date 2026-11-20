<?php

declare(strict_types=1);

namespace Omw\Api\Domain;

use Omw\Api\Http\ApiException;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;
use Omw\Api\Infra\Fs;
use Omw\Api\Infra\Paths;
use stdClass;

/**
 * The capture mirror (primary copy: backend) and the owner's annotations of captures.
 *
 * Backend side: {@see mirror()} (PUT, idempotent, never touches annotations; revoked_at sticky),
 * {@see revoke()}, {@see storePreview()}.
 *
 * Revoked statuses (deleted on WhatsApp) keep no private preview/poster while ingest.on_revoke
 * is "hide" (the default): the revoke clears preview_path/poster_path in its transaction and
 * deletes the files after the commit, later uploads for it are discarded, and the cron sweep
 * {@see purgeRevokedPreviews()} catches rows revoked before this rule (or while "keep" was set).
 * With "keep" the previews stay, like the capture itself.
 *
 * Admin side: contract CaptureListItem with the effective visibility/date/zone computed by
 * {@see Policy} from the settings, the annotation and the Day.tz fix of the stored local date.
 *
 * Instants are stored in the canonical "YYYY-MM-DDTHH:MM:SS.mmmZ" form so ordering by string
 * equals ordering by time.
 */
final class Captures
{
    public const ROLES = ['preview', 'poster'];
    public const PREVIEW_MIME_TYPES = ['image/webp' => 'webp', 'image/jpeg' => 'jpg'];
    public const PREVIEW_MAX_BYTES = 512 * 1024;
    public const DEFAULT_LIMIT = 50;

    /**
     * How far (in days) a Day.tz fix can move an item away from its stored local date: zone
     * offsets span UTC-12..UTC+14, so re-dating can shift the calendar date by up to two days.
     * Date filters therefore read stored dates within ±FIX_WINDOW_DAYS and compute the exact
     * effective date in PHP (contracts policy: Placement).
     */
    public const FIX_WINDOW_DAYS = 2;

    private const SELECT = <<<'SQL'
        SELECT c.source_key, c.public_id, c.kind, c.occurred_at, c.tz, c.local_date, c.caption, c.text_json,
               c.media_json, c.media_state, c.preview_path, c.poster_path, c.revoked_at,
               a.source_key AS a_key, a.description AS a_description, a.orig_locale AS a_orig_locale,
               a.visibility AS a_visibility, a.local_date_override AS a_override, a.updated_at AS a_updated_at,
               (SELECT MAX(cl.seq) FROM change_log cl WHERE cl.entity = 'annotation' AND cl.entity_key = c.source_key) AS change_seq
        FROM captures c LEFT JOIN annotations a ON a.source_key = c.source_key
        SQL;

    public function __construct(
        private readonly Db $db,
        private readonly ChangeLog $changes,
        private readonly Settings $settings,
        private readonly Paths $paths,
    ) {
    }

    // -----------------------------------------------------------------------------------------
    // Backend

    /**
     * PUT /backend/captures/{sourceKey}: creates or updates the mirror row. Returns true when the
     * row was created. The body must already be valid against CaptureMirror.
     */
    public function mirror(string $sourceKey, stdClass $body): bool
    {
        if (($body->sourceKey ?? null) !== $sourceKey) {
            throw ApiException::validation('sourceKey in the body must match the URL.');
        }
        if (!Time::isValidTimeZone($body->tz ?? null)) {
            throw ApiException::validation('tz is not a known IANA time zone.', ['errors' => ['/tz: unknown time zone']]);
        }
        if (($body->publicId ?? null) !== Ids::publicIdForSourceKey($sourceKey)) {
            throw ApiException::validation('publicId does not match the sourceKey (D4).');
        }
        $row = [
            'public_id' => (string) $body->publicId,
            'kind' => (string) $body->kind,
            'occurred_at' => Time::toIsoUtc((string) $body->occurredAt),
            'tz' => (string) $body->tz,
            'local_date' => (string) $body->localDate,
            'caption' => isset($body->caption) && is_string($body->caption) ? $body->caption : null,
            'text_json' => isset($body->text) ? self::encode($body->text) : null,
            'media_json' => isset($body->media) ? self::encode($body->media) : null,
            'media_state' => (string) $body->mediaState,
            'contract_version' => (int) $body->contractVersion,
        ];
        $revokedAt = isset($body->revokedAt) && is_string($body->revokedAt) ? Time::toIsoUtc($body->revokedAt) : null;

        $result = $this->db->write(function () use ($sourceKey, $row, $revokedAt): array {
            $clash = $this->db->scalar('SELECT source_key FROM captures WHERE public_id = ? AND source_key <> ?', [$row['public_id'], $sourceKey]);
            if ($clash !== null) {
                throw ApiException::conflict('Another capture already has this publicId.');
            }
            $existing = $this->db->one('SELECT * FROM captures WHERE source_key = ?', [$sourceKey]);
            $now = Clock::nowIso();
            if ($existing === null) {
                $this->db->exec(
                    'INSERT INTO captures (source_key, public_id, kind, occurred_at, tz, local_date, caption, text_json, media_json,
                                           media_state, revoked_at, contract_version, mirrored_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [$sourceKey, $row['public_id'], $row['kind'], $row['occurred_at'], $row['tz'], $row['local_date'], $row['caption'],
                        $row['text_json'], $row['media_json'], $row['media_state'], $revokedAt, $row['contract_version'], $now, $now],
                );

                return ['created' => true, 'files' => []];
            }
            $row['revoked_at'] = $existing['revoked_at'] ?? $revokedAt; // sticky
            $changed = false;
            foreach ($row as $column => $value) {
                if ((string) ($existing[$column] ?? '') !== (string) ($value ?? '') || ($existing[$column] === null) !== ($value === null)) {
                    $changed = true;
                    break;
                }
            }
            if ($changed) {
                $this->db->exec(
                    'UPDATE captures SET public_id = ?, kind = ?, occurred_at = ?, tz = ?, local_date = ?, caption = ?, text_json = ?,
                            media_json = ?, media_state = ?, contract_version = ?, revoked_at = ?, updated_at = ?
                     WHERE source_key = ?',
                    [$row['public_id'], $row['kind'], $row['occurred_at'], $row['tz'], $row['local_date'], $row['caption'], $row['text_json'],
                        $row['media_json'], $row['media_state'], $row['contract_version'], $row['revoked_at'], $now, $sourceKey],
                );
            }
            // A revoke can also arrive through the mirror (revokedAt in the PUT body).
            $files = $row['revoked_at'] !== null && $this->hidesRevoked() ? $this->detachPreviews($sourceKey) : [];

            return ['created' => false, 'files' => $files];
        });
        $this->unlinkPreviews($result['files']);

        return $result['created'];
    }

    /**
     * POST /backend/captures/{sourceKey}/revoke (sticky: the first revoke time wins). With
     * ingest.on_revoke = hide the private preview and poster go too (paths cleared in this
     * transaction, files deleted after the commit; already missing files are fine).
     */
    public function revoke(string $sourceKey, string $at): void
    {
        $at = Time::toIsoUtc($at);
        $files = $this->db->write(function () use ($sourceKey, $at): array {
            if (!$this->exists($sourceKey)) {
                throw self::notMirrored();
            }
            $this->db->exec(
                'UPDATE captures SET revoked_at = ?, updated_at = ? WHERE source_key = ? AND revoked_at IS NULL',
                [$at, Clock::nowIso(), $sourceKey],
            );

            return $this->hidesRevoked() ? $this->detachPreviews($sourceKey) : [];
        });
        $this->unlinkPreviews($files);
    }

    /**
     * Cron sweep (idempotent): while ingest.on_revoke = hide, removes the previews/posters of
     * revoked captures that still have some (revoked before previews were deleted on revoke, or
     * while "keep" was set). Returns the number of files removed.
     */
    public function purgeRevokedPreviews(): int
    {
        $removed = 0;
        while (true) {
            $files = $this->db->write(function (): array {
                if (!$this->hidesRevoked()) {
                    return [];
                }
                $files = [];
                foreach ($this->db->all(
                    'SELECT source_key FROM captures WHERE revoked_at IS NOT NULL AND (preview_path IS NOT NULL OR poster_path IS NOT NULL) LIMIT 200',
                ) as $row) {
                    array_push($files, ...$this->detachPreviews((string) $row['source_key']));
                }

                return $files;
            });
            if ($files === []) {
                return $removed;
            }
            $removed += $this->unlinkPreviews($files);
        }
    }

    /** ingest.on_revoke: true for "hide" (the default). */
    private function hidesRevoked(): bool
    {
        return $this->settings->get('ingest.on_revoke') !== 'keep';
    }

    /**
     * Clears preview_path/poster_path of a capture (inside the caller's transaction) and returns
     * the files to delete once it committed.
     *
     * @return list<string> paths relative to var/previews/
     */
    private function detachPreviews(string $sourceKey): array
    {
        $row = $this->db->one('SELECT preview_path, poster_path FROM captures WHERE source_key = ?', [$sourceKey]);
        if ($row === null || ($row['preview_path'] === null && $row['poster_path'] === null)) {
            return [];
        }
        $this->db->exec('UPDATE captures SET preview_path = NULL, poster_path = NULL WHERE source_key = ?', [$sourceKey]);

        return array_values(array_filter([$row['preview_path'], $row['poster_path']], static fn (mixed $p): bool => is_string($p) && $p !== ''));
    }

    /**
     * Deletes preview files (after the transaction that detached them committed).
     *
     * @param list<string> $files paths relative to var/previews/
     * @return int files that existed and are gone now
     */
    private function unlinkPreviews(array $files): int
    {
        $removed = 0;
        foreach ($files as $rel) {
            if (str_contains($rel, '..')) {
                continue;
            }
            $path = $this->paths->var('previews/' . $rel);
            $existed = is_file($path);
            if (Fs::remove($path) && $existed) {
                ++$removed;
            }
        }

        return $removed;
    }

    public function exists(string $sourceKey): bool
    {
        return $this->db->scalar('SELECT 1 FROM captures WHERE source_key = ?', [$sourceKey]) !== null;
    }

    /**
     * Stores (or replaces) a private preview/poster. $bytes were checked by the caller (size and
     * sniffed MIME type). The file name contains a content hash, which is also the cache buster
     * of previewUrl/posterUrl. For a revoked capture under ingest.on_revoke = hide the upload is
     * accepted (the backend's queue moves on) but discarded.
     *
     * @return bool false when the upload was discarded
     */
    public function storePreview(string $sourceKey, string $role, string $bytes, string $mime): bool
    {
        if (!in_array($role, self::ROLES, true)) {
            throw ApiException::validation('role must be "preview" or "poster".');
        }
        $ext = self::PREVIEW_MIME_TYPES[$mime] ?? null;
        if ($ext === null) {
            throw new ApiException(415, 'unsupported_media_type', 'Previews must be WebP or JPEG.');
        }
        $capture = $this->db->one('SELECT public_id, revoked_at FROM captures WHERE source_key = ?', [$sourceKey]);
        if ($capture === null) {
            throw self::notMirrored();
        }
        if ($capture['revoked_at'] !== null && $this->hidesRevoked()) {
            return false;
        }
        $rel = sprintf('%s/%s_%s_%s.%s', substr(hash('sha256', $sourceKey), 0, 2), (string) $capture['public_id'], $role, substr(hash('sha256', $bytes), 0, 8), $ext);
        $abs = $this->paths->var('previews/' . $rel);
        Fs::writeAtomic($abs, $bytes, 0640);

        $column = $role === 'poster' ? 'poster_path' : 'preview_path';
        $result = $this->db->write(function () use ($sourceKey, $column, $rel): array {
            $row = $this->db->one("SELECT revoked_at, $column AS old FROM captures WHERE source_key = ?", [$sourceKey]);
            if ($row === null) {
                throw self::notMirrored(); // orphaned file: removed by the cron cleanup
            }
            if ($row['revoked_at'] !== null && $this->hidesRevoked()) {
                return ['stored' => false, 'remove' => $rel]; // revoked meanwhile: drop the new file
            }
            $this->db->exec("UPDATE captures SET $column = ? WHERE source_key = ?", [$rel, $sourceKey]);
            $old = $row['old'];

            return ['stored' => true, 'remove' => is_string($old) && $old !== $rel ? $old : null];
        });
        if ($result['remove'] !== null) {
            $this->unlinkPreviews([$result['remove']]);
        }

        return $result['stored'];
    }

    /** @return array{path: string, mime: string, version: string}|null */
    public function previewFile(string $sourceKey, string $role): ?array
    {
        $column = $role === 'poster' ? 'poster_path' : 'preview_path';
        $rel = $this->db->scalar("SELECT $column FROM captures WHERE source_key = ?", [$sourceKey]);
        if (!is_string($rel) || $rel === '' || str_contains($rel, '..')) {
            return null;
        }
        $path = $this->paths->var('previews/' . $rel);
        if (!is_file($path)) {
            return null;
        }

        return [
            'path' => $path,
            'mime' => str_ends_with($rel, '.webp') ? 'image/webp' : 'image/jpeg',
            'version' => self::versionOf($rel),
        ];
    }

    public static function notMirrored(): ApiException
    {
        return new ApiException(404, 'capture_not_mirrored', 'The capture has not been mirrored yet (PUT it first).');
    }

    // -----------------------------------------------------------------------------------------
    // Admin

    /**
     * GET /admin/captures (contract CaptureListQuery -> CaptureListResponse), newest first.
     *
     * @return array{items: list<array<string, mixed>>, nextCursor: string|null}
     */
    public function list(stdClass $query, string $basePath): array
    {
        $limit = isset($query->limit) && is_int($query->limit) ? $query->limit : self::DEFAULT_LIMIT;
        $date = isset($query->date) && is_string($query->date) ? $query->date : null;
        $visibility = isset($query->visibility) && is_string($query->visibility) ? $query->visibility : null;
        $cursor = isset($query->cursor) && is_string($query->cursor) ? self::decodeCursor($query->cursor) : null;

        $where = [];
        $params = [];
        if (isset($query->kind) && is_string($query->kind)) {
            $where[] = 'c.kind = ?';
            $params[] = $query->kind;
        }
        if ($date !== null) {
            // Candidates; the exact effective date is computed in PHP (a Day.tz fix can move an item
            // by up to two days, e.g. from UTC+14 to UTC-11, see FIX_WINDOW_DAYS).
            $where[] = '(a.local_date_override = ? OR (a.local_date_override IS NULL AND c.local_date BETWEEN ? AND ?))';
            array_push($params, $date, Time::addDays($date, -self::FIX_WINDOW_DAYS), Time::addDays($date, self::FIX_WINDOW_DAYS));
        }
        $ctx = $this->context();
        $items = [];
        $batch = max(50, $limit * 2);
        $more = false;
        while (true) {
            $w = $where;
            $p = $params;
            if ($cursor !== null) {
                $w[] = '(c.occurred_at < ? OR (c.occurred_at = ? AND c.source_key < ?))';
                array_push($p, $cursor[0], $cursor[0], $cursor[1]);
            }
            $rows = $this->db->all(
                self::SELECT . ($w === [] ? '' : ' WHERE ' . implode(' AND ', $w)) . ' ORDER BY c.occurred_at DESC, c.source_key DESC LIMIT ' . $batch,
                $p,
            );
            foreach ($rows as $row) {
                $cursor = [(string) $row['occurred_at'], (string) $row['source_key']];
                $item = $this->item($row, $ctx, $basePath);
                if (($date !== null && $item['effectiveLocalDate'] !== $date) || ($visibility !== null && $item['effectiveVisibility'] !== $visibility)) {
                    continue;
                }
                if (count($items) === $limit) {
                    $more = true;
                    break 2;
                }
                $items[] = $item;
            }
            if (count($rows) < $batch) {
                break;
            }
        }
        $last = $items === [] ? null : $items[count($items) - 1];

        return [
            'items' => $items,
            'nextCursor' => $more && $last !== null ? self::encodeCursor((string) $last['occurredAt'], (string) $last['sourceKey']) : null,
        ];
    }

    /** @return array<string, mixed> CaptureListItem */
    public function get(string $sourceKey, string $basePath): array
    {
        $row = $this->db->one(self::SELECT . ' WHERE c.source_key = ?', [$sourceKey]);
        if ($row === null) {
            throw ApiException::notFound('No such capture.');
        }

        return $this->item($row, $this->context(), $basePath);
    }

    /**
     * Captures whose EFFECTIVE local date is $date, chronological.
     *
     * @return list<array<string, mixed>>
     */
    public function forDate(string $date, string $basePath): array
    {
        $rows = $this->db->all(
            self::SELECT . ' WHERE (a.local_date_override = ? OR (a.local_date_override IS NULL AND c.local_date BETWEEN ? AND ?))
                            ORDER BY c.occurred_at, c.source_key',
            [$date, Time::addDays($date, -self::FIX_WINDOW_DAYS), Time::addDays($date, self::FIX_WINDOW_DAYS)],
        );
        $ctx = $this->context();
        $out = [];
        foreach ($rows as $row) {
            $item = $this->item($row, $ctx, $basePath);
            if ($item['effectiveLocalDate'] === $date) {
                $out[] = $item;
            }
        }

        return $out;
    }

    /**
     * Every capture as CaptureListItem, chronological (day summaries).
     *
     * @return list<array<string, mixed>>
     */
    public function all(string $basePath): array
    {
        $ctx = $this->context();
        $out = [];
        foreach ($this->db->all(self::SELECT . ' ORDER BY c.occurred_at, c.source_key') as $row) {
            $out[] = $this->item($row, $ctx, $basePath);
        }

        return $out;
    }

    /**
     * PATCH /admin/captures/{sourceKey} (contract AnnotationPatch, already schema-valid).
     *
     * @return array<string, mixed> CaptureListItem
     */
    public function annotate(string $sourceKey, stdClass $patch, string $basePath): array
    {
        $this->db->write(function () use ($sourceKey, $patch): void {
            if (!$this->exists($sourceKey)) {
                throw ApiException::notFound('No such capture.');
            }
            $row = $this->db->one('SELECT * FROM annotations WHERE source_key = ?', [$sourceKey]);
            if (isset($patch->ifUpdatedAt) && is_string($patch->ifUpdatedAt)
                && ($row === null || !self::sameInstant((string) $row['updated_at'], $patch->ifUpdatedAt))) {
                throw ApiException::conflict('The annotation was changed meanwhile (ifUpdatedAt is stale).');
            }
            $current = [
                'description' => $row === null || $row['description'] === null ? null : self::encode(self::decode((string) $row['description'])),
                'orig_locale' => $row['orig_locale'] ?? null,
                'visibility' => $row['visibility'] ?? null,
                'local_date_override' => $row['local_date_override'] ?? null,
            ];
            $next = $current;
            $map = ['description' => 'description', 'origLocale' => 'orig_locale', 'visibility' => 'visibility', 'localDateOverride' => 'local_date_override'];
            foreach ($map as $field => $column) {
                if (property_exists($patch, $field)) {
                    $next[$column] = $field === 'description'
                        ? ($patch->description === null ? null : self::encode($patch->description))
                        : $patch->{$field};
                }
            }
            if ($next === $current && ($row !== null || array_filter($next, static fn ($v): bool => $v !== null) === [])) {
                return; // nothing changes
            }
            $now = Clock::nowIsoAfter($row === null ? null : (string) $row['updated_at']);
            $this->db->exec(
                'INSERT INTO annotations (source_key, description, orig_locale, visibility, local_date_override, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (source_key) DO UPDATE SET description = excluded.description, orig_locale = excluded.orig_locale,
                    visibility = excluded.visibility, local_date_override = excluded.local_date_override, updated_at = excluded.updated_at',
                [$sourceKey, $next['description'], $next['orig_locale'], $next['visibility'], $next['local_date_override'], $now, $now],
            );
            $this->changes->append('annotation', $sourceKey, 'upsert', self::annotationDto([
                'a_key' => $sourceKey,
                'a_description' => $next['description'],
                'a_orig_locale' => $next['orig_locale'],
                'a_visibility' => $next['visibility'],
                'a_override' => $next['local_date_override'],
                'a_updated_at' => $now,
            ]));
        });

        return $this->get($sourceKey, $basePath);
    }

    // -----------------------------------------------------------------------------------------
    // DTOs

    /**
     * Inputs shared by every item of one request: policy settings, "now" and the Day.tz fixes.
     *
     * @return array{policy: array<string, mixed>, now: string, dayTz: array<string, string>}
     */
    private function context(): array
    {
        return ['policy' => $this->settings->policy(), 'now' => Clock::nowIso(), 'dayTz' => self::dayTzFixes($this->db)];
    }

    /**
     * The owner's time-zone fixes (Day.tz), keyed by the local date they apply to.
     *
     * @return array<string, string>
     */
    public static function dayTzFixes(Db $db): array
    {
        $dayTz = [];
        foreach ($db->all('SELECT local_date, tz FROM days WHERE tz IS NOT NULL') as $row) {
            $dayTz[(string) $row['local_date']] = (string) $row['tz'];
        }

        return $dayTz;
    }

    /**
     * @param array<string, mixed>                                                               $row
     * @param array{policy: array<string, mixed>, now: string, dayTz: array<string, string>} $ctx
     * @return array<string, mixed>
     */
    private function item(array $row, array $ctx, string $basePath): array
    {
        $sourceKey = (string) $row['source_key'];
        $occurredAt = (string) $row['occurred_at'];
        $revokedAt = $row['revoked_at'] === null ? null : (string) $row['revoked_at'];
        $override = $row['a_override'] === null ? null : (string) $row['a_override'];
        $visibilityOverride = $row['a_visibility'] === null ? null : (string) $row['a_visibility'];
        $dayTz = $ctx['dayTz'][(string) $row['local_date']] ?? null;

        return [
            'sourceKey' => $sourceKey,
            'publicId' => (string) $row['public_id'],
            'kind' => (string) $row['kind'],
            'occurredAt' => $occurredAt,
            'tz' => (string) $row['tz'],
            'localDate' => (string) $row['local_date'],
            'caption' => $row['caption'] === null ? null : (string) $row['caption'],
            'text' => $row['text_json'] === null ? null : self::decode((string) $row['text_json']),
            'media' => $row['media_json'] === null ? null : self::decode((string) $row['media_json']),
            'mediaState' => (string) $row['media_state'],
            'revokedAt' => $revokedAt,
            'annotation' => $row['a_key'] === null ? null : self::annotationDto($row),
            'previewUrl' => self::url($basePath, $sourceKey, 'preview', $row['preview_path']),
            'posterUrl' => self::url($basePath, $sourceKey, 'poster', $row['poster_path']),
            'effectiveVisibility' => Policy::effectiveCaptureVisibility($occurredAt, $revokedAt, $visibilityOverride, $ctx['policy'], $ctx['now']),
            'effectiveLocalDate' => Policy::effectiveLocalDate($occurredAt, (string) $row['local_date'], $override, $dayTz),
            'effectiveTz' => Policy::effectiveTz((string) $row['tz'], $override, $dayTz),
            'changeSeq' => (int) ($row['change_seq'] ?? 0),
        ];
    }

    /**
     * Contract Annotation from the a_* columns.
     *
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    public static function annotationDto(array $row): array
    {
        return [
            'sourceKey' => (string) $row['a_key'],
            'description' => $row['a_description'] === null ? null : self::decode((string) $row['a_description']),
            'origLocale' => $row['a_orig_locale'] === null ? null : (string) $row['a_orig_locale'],
            'visibility' => $row['a_visibility'] === null ? null : (string) $row['a_visibility'],
            'localDateOverride' => $row['a_override'] === null ? null : (string) $row['a_override'],
            'updatedAt' => (string) $row['a_updated_at'],
        ];
    }

    private static function url(string $basePath, string $sourceKey, string $role, mixed $path): ?string
    {
        if (!is_string($path) || $path === '') {
            return null;
        }

        return sprintf('%s/api/v1/admin/captures/%s/%s?v=%s', $basePath, rawurlencode($sourceKey), $role, self::versionOf($path));
    }

    private static function versionOf(string $relPath): string
    {
        return preg_match('/_([0-9a-f]{8})\.[a-z]+$/', $relPath, $m) === 1 ? $m[1] : substr(sha1($relPath), 0, 8);
    }

    public static function sameInstant(string $a, string $b): bool
    {
        try {
            return Time::millis($a) === Time::millis($b);
        } catch (\InvalidArgumentException) {
            return $a === $b;
        }
    }

    public static function encode(mixed $value): string
    {
        return json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
    }

    /** Decodes stored JSON with objects as stdClass ("{}" stays an object on the wire). */
    public static function decode(string $json): mixed
    {
        return json_decode($json, false, 64, JSON_THROW_ON_ERROR);
    }

    public static function encodeCursor(string $at, string $key): string
    {
        return rtrim(strtr(base64_encode(self::encode([$at, $key])), '+/', '-_'), '=');
    }

    /** @return array{0: string, 1: string} */
    public static function decodeCursor(string $cursor): array
    {
        $raw = base64_decode(strtr($cursor, '-_', '+/'), true);
        $value = is_string($raw) ? json_decode($raw, true, 4) : null;
        if (!is_array($value) || count($value) !== 2 || !is_string($value[0] ?? null) || !is_string($value[1] ?? null)) {
            throw ApiException::validation('Invalid cursor.');
        }

        return [$value[0], $value[1]];
    }
}
