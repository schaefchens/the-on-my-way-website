<?php

declare(strict_types=1);

namespace Omw\Api\Domain\App;

use Omw\Api\Domain\Time;
use stdClass;

/**
 * PHP port of the pure rules of packages/contracts/src/app.ts, checked against the shared vectors
 * (fixtures/vectors/app-{entries,time,canonical,pairing,chunks}.json, tests/Domain/AppRulesTest):
 *
 * - {@see entryProblems()}: appEntryProblems(), the cross-field rules JSON Schema cannot express;
 * - {@see correctOccurredAt()}: correctAppOccurredAt() (clock skew, 24 h clamp, 30-day "Hold back");
 * - {@see canonicalJson()} / {@see entryHash()}: the idempotency key of POST /app/entries;
 * - {@see normalizePairingCode()}: what she typed or a link carried;
 * - {@see parseUploadChecksum()}: the tus "Upload-Checksum: sha256 <base64>" header.
 */
final class AppRules
{
    public const KIB = 1024;
    public const MIB = 1024 * 1024;
    public const GIB = 1024 * 1024 * 1024;

    /** APP_LIMITS */
    public const CAPTION_CHARS = 1024;
    public const TEXT_CHARS = 700;
    public const ALT_CHARS = 1000;
    public const VIDEO_SECONDS = 60;
    public const VOICE_SECONDS = 60;
    public const PHOTO_MAX_LONG_SIDE = 2880;
    public const PHOTO_MAX_SHORT_SIDE = 1600;
    public const VIDEO_MAX_LONG_SIDE = 1920;
    public const MEDIA_MAX_BYTES = 100 * self::MIB;
    public const PREVIEW_MAX_BYTES = 512 * self::KIB;
    public const ORIGINAL_MAX_BYTES = 4 * self::GIB;
    public const FILES_PER_ENTRY = 3;
    public const LIST_IDS = 50;

    /** APP_CHUNKS */
    public const CHUNK_MIN_BYTES = 256 * self::KIB;
    public const CHUNK_MAX_BYTES = 8 * self::MIB;

    /** APP_TIME_RULES */
    public const MAX_SKEW_MS = 24 * 60 * 60 * 1000;
    public const HOLD_BACK_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

    public const MEDIA_KINDS = ['photo', 'video', 'voice'];
    public const MEDIA_MIMETYPES = ['photo' => 'image/jpeg', 'video' => 'video/mp4', 'voice' => 'audio/mp4'];
    public const PREVIEW_MIMETYPE = 'image/jpeg';
    public const ORIGINAL_MIMETYPES = [
        'photo' => ['image/jpeg', 'image/heic', 'image/heif', 'image/png', 'image/webp', 'image/avif', 'image/dng'],
        'video' => ['video/mp4', 'video/quicktime', 'video/3gpp', 'video/webm'],
    ];
    public const ROLES = ['media', 'preview', 'original'];

    /** Client ULID (Crockford base32, uppercase). */
    public const ULID_RE = '/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/D';

    /** APP_PAIRING */
    public const LINK_PREFIX = 'omw://pair#';
    public const LINK_CODE_CHARS = 26;
    public const TYPED_CODE_CHARS = 8;
    public const PAIRING_TTL_DEFAULT = 60;
    public const PAIRING_TTL_MIN = 5;
    public const PAIRING_TTL_MAX = 24 * 60;
    public const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

    public static function isEntryId(mixed $value): bool
    {
        return is_string($value) && preg_match(self::ULID_RE, $value) === 1;
    }

    public static function sourceKey(string $entryId): string
    {
        return 'app:' . $entryId;
    }

    /**
     * appEntryProblems(): the entry has passed the JSON Schema (AppEntryCreate) already.
     *
     * @return list<array{path: list<string|int>, message: string}>
     */
    public static function entryProblems(stdClass $entry): array
    {
        $out = [];
        $add = static function (string $message, string|int ...$path) use (&$out): void {
            $out[] = ['path' => array_values($path), 'message' => $message];
        };
        $kind = (string) ($entry->kind ?? '');
        $media = isset($entry->media) && $entry->media instanceof stdClass ? $entry->media : null;
        $files = isset($entry->files) && is_array($entry->files) ? $entry->files : [];
        $isMedia = in_array($kind, self::MEDIA_KINDS, true);
        $hasText = isset($entry->text);

        if ($kind === 'text' && !$hasText) {
            $add('kind "text" requires text', 'text');
        }
        if ($kind !== 'text' && $hasText) {
            $add('only kind "text" may carry text', 'text');
        }
        if ($isMedia && $media === null) {
            $add(sprintf('kind "%s" requires media', $kind), 'media');
        }
        if (!$isMedia && $media !== null) {
            $add(sprintf('kind "%s" must not carry media', $kind), 'media');
        }
        if (property_exists($entry, 'caption') && $kind !== 'photo' && $kind !== 'video') {
            $add('only photo and video carry a caption', 'caption');
        }

        if ($media !== null) {
            $visual = $kind === 'photo' || $kind === 'video';
            $width = isset($media->width) && is_int($media->width) ? $media->width : null;
            $height = isset($media->height) && is_int($media->height) ? $media->height : null;
            $seconds = isset($media->seconds) && (is_int($media->seconds) || is_float($media->seconds)) ? (float) $media->seconds : null;
            if ($visual && ($width === null || $height === null)) {
                $add(sprintf('kind "%s" requires width and height', $kind), 'media');
            }
            if ($kind === 'voice' && ($width !== null || $height !== null)) {
                $add('voice has no width or height', 'media');
            }
            if (($kind === 'video' || $kind === 'voice') && $seconds === null) {
                $add(sprintf('kind "%s" requires seconds', $kind), 'media', 'seconds');
            }
            if ($kind === 'photo' && $seconds !== null) {
                $add('a photo has no duration', 'media', 'seconds');
            }
            $maxSeconds = $kind === 'video' ? self::VIDEO_SECONDS : self::VOICE_SECONDS;
            if ($seconds !== null && $seconds > $maxSeconds) {
                $add(sprintf('at most %d s', $maxSeconds), 'media', 'seconds');
            }
            if (property_exists($media, 'ptt') && $kind !== 'voice') {
                $add('only voice is push-to-talk', 'media', 'ptt');
            }
            if (property_exists($media, 'accessibilityLabel') && !$visual) {
                $add('only photo and video carry alt text', 'media', 'accessibilityLabel');
            }
            if ($width !== null && $height !== null) {
                $long = max($width, $height);
                $short = min($width, $height);
                if ($kind === 'photo' && ($long > self::PHOTO_MAX_LONG_SIDE || $short > self::PHOTO_MAX_SHORT_SIDE)) {
                    $add(sprintf('photo larger than %d×%d', self::PHOTO_MAX_LONG_SIDE, self::PHOTO_MAX_SHORT_SIDE), 'media');
                }
                if ($kind === 'video' && $long > self::VIDEO_MAX_LONG_SIDE) {
                    $add(sprintf('video long side above %d', self::VIDEO_MAX_LONG_SIDE), 'media');
                }
            }
        }

        $roles = [];
        foreach (array_values($files) as $i => $file) {
            if (!$file instanceof stdClass) {
                continue;
            }
            $role = (string) ($file->role ?? '');
            $mimetype = (string) ($file->mimetype ?? '');
            $bytes = is_int($file->bytes ?? null) ? $file->bytes : 0;
            if (isset($roles[$role])) {
                $add(sprintf('duplicate role "%s"', $role), 'files', $i, 'role');
            }
            $roles[$role] = true;
            if (!$isMedia) {
                $add(sprintf('kind "%s" has no files', $kind), 'files', $i);
                continue;
            }
            if ($role === 'media') {
                $want = self::MEDIA_MIMETYPES[$kind];
                if ($mimetype !== $want) {
                    $add(sprintf('kind "%s" needs %s', $kind, $want), 'files', $i, 'mimetype');
                }
                if ($bytes > self::MEDIA_MAX_BYTES) {
                    $add('media file too large', 'files', $i, 'bytes');
                }
            } elseif ($role === 'preview') {
                if ($kind === 'voice') {
                    $add('voice has no preview', 'files', $i, 'role');
                }
                if ($mimetype !== self::PREVIEW_MIMETYPE) {
                    $add('preview must be image/jpeg', 'files', $i, 'mimetype');
                }
                if ($bytes > self::PREVIEW_MAX_BYTES) {
                    $add('preview too large', 'files', $i, 'bytes');
                }
            } else {
                if ($kind === 'voice') {
                    $add('voice has no original', 'files', $i, 'role');
                } elseif (!in_array($mimetype, self::ORIGINAL_MIMETYPES[$kind] ?? [], true)) {
                    $add('unsupported original ' . $mimetype, 'files', $i, 'mimetype');
                }
                if ($bytes > self::ORIGINAL_MAX_BYTES) {
                    $add('original too large', 'files', $i, 'bytes');
                }
            }
        }
        if ($isMedia && !isset($roles['media'])) {
            $add(sprintf('kind "%s" requires a media file', $kind), 'files');
        }

        return $out;
    }

    /**
     * correctAppOccurredAt(): occurredAt + (serverNow - clientNow); a skew beyond 24 h or a result
     * in the future falls back to serverNow. The photo's EXIF time is never used.
     *
     * @return array{occurredAt: string, clamped: bool, heldBack: bool}
     */
    public static function correctOccurredAt(string $occurredAt, string $clientNow, string $serverNow): array
    {
        $occurred = Time::millis($occurredAt);
        $client = Time::millis($clientNow);
        $server = Time::millis($serverNow);
        $skew = $server - $client;
        $corrected = $occurred + $skew;
        $clamped = false;
        if (abs($skew) > self::MAX_SKEW_MS || $corrected > $server) {
            $corrected = $server;
            $clamped = true;
        }

        return [
            'occurredAt' => Time::fromMillis($corrected),
            'clamped' => $clamped,
            'heldBack' => $server - $corrected > self::HOLD_BACK_AFTER_MS,
        ];
    }

    /**
     * appCanonicalJson(): keys sorted (byte order of the UTF-8 keys, which equals UTF-16 order for
     * the ASCII keys entries use), no whitespace, JSON.stringify-compatible escaping, integers
     * without a fraction. Objects must be decoded as stdClass so "{}" stays an object.
     */
    public static function canonicalJson(mixed $value): string
    {
        if ($value instanceof stdClass) {
            $members = get_object_vars($value);
            ksort($members, SORT_STRING);
            $parts = [];
            foreach ($members as $key => $member) {
                $parts[] = self::encodeScalar((string) $key) . ':' . self::canonicalJson($member);
            }

            return '{' . implode(',', $parts) . '}';
        }
        if (is_array($value)) {
            return '[' . implode(',', array_map(static fn (mixed $v): string => self::canonicalJson($v), array_values($value))) . ']';
        }
        if (is_float($value) && floor($value) === $value && abs($value) < 2 ** 53) {
            return (string) (int) $value;
        }

        return self::encodeScalar($value);
    }

    /** sha256 hex of the canonical JSON of an entry (appEntryHash()). */
    public static function entryHash(stdClass $entry): string
    {
        return hash('sha256', self::canonicalJson($entry));
    }

    /**
     * normalizeAppPairingCode(): trim, drop spaces and dashes, upper-case, map O -> 0 and I/L -> 1;
     * null unless the result is 8 or 26 Crockford base32 characters.
     */
    public static function normalizePairingCode(string $input): ?string
    {
        $s = strtoupper(trim($input));
        $s = (string) preg_replace('/[\s\-]/u', '', $s);
        $s = strtr($s, ['O' => '0', 'I' => '1', 'L' => '1']);
        $length = strlen($s);
        if ($length !== self::TYPED_CODE_CHARS && $length !== self::LINK_CODE_CHARS) {
            return null;
        }
        if (strspn($s, self::CROCKFORD) !== $length) {
            return null;
        }

        return $s;
    }

    /** formatAppTypedPairingCode(): "ABCDEFGH" -> "ABCD-EFGH". */
    public static function formatTypedCode(string $code): string
    {
        return strlen($code) === self::TYPED_CODE_CHARS ? substr($code, 0, 4) . '-' . substr($code, 4) : $code;
    }

    /** A random code of $chars Crockford base32 characters (5 bits each). */
    public static function randomCode(int $chars): string
    {
        $out = '';
        $bytes = random_bytes(max(1, $chars));
        for ($i = 0; $i < $chars; ++$i) {
            $out .= self::CROCKFORD[ord($bytes[$i]) & 31];
        }

        return $out;
    }

    /** parseUploadChecksum(): "sha256 <base64 of 32 bytes>" -> lowercase hex; null for anything else. */
    public static function parseUploadChecksum(string $header): ?string
    {
        if (preg_match('/^sha256 ([A-Za-z0-9+\/]{42}[AEIMQUYcgkosw048]=)$/D', trim($header), $m) !== 1) {
            return null;
        }
        $raw = base64_decode($m[1], true);

        return is_string($raw) && strlen($raw) === 32 ? bin2hex($raw) : null;
    }

    public static function formatUploadChecksum(string $hex): string
    {
        return 'sha256 ' . base64_encode((string) hex2bin($hex));
    }

    private static function encodeScalar(mixed $value): string
    {
        return json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_LINE_TERMINATORS);
    }
}
