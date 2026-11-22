<?php

declare(strict_types=1);

namespace Omw\Api\Domain\Access;

use InvalidArgumentException;

/**
 * PHP port of the pure access helpers of packages/contracts/src/access.ts (spec-wave5 §0.3, §2.2,
 * §4.1), pinned by fixtures/vectors/access-paths.json (tests/Domain/VectorsTest): the site-store
 * layout, which op may name which path, the ACCESS_STORE_DIR rule, gate cookie values and names,
 * and the personal / panic link URLs.
 *
 * Store paths are relative to the store root, never start with "/" and never contain a "." or
 * ".." segment. Every writer call checks its path here before touching the filesystem.
 */
final class StoreLayout
{
    public const FID = '[a-z2-7]{12}';
    public const DID = '[a-z2-7]{8}';
    public const TOKEN = '[A-Za-z0-9_-]{43}';

    public const MARKER = '.omw-store.json';
    public const LOCKED = 'locked';
    public const HTACCESS = '.htaccess';
    /** Exact bytes of the store's deny-all .htaccess (F3; harmless outside the docroot). */
    public const HTACCESS_CONTENT = "Require all denied\nOptions -Indexes\n";

    /** What a session path looks like after its op was applied (the database keeps no usable sid). */
    public const REDACTED = '<redacted>';

    /** @var array<string, string> kind => regex (contract STORE_PATH_PATTERNS, same order) */
    public const PATTERNS = [
        'marker' => '#^\.omw-store\.json$#D',
        'locked' => '#^locked$#D',
        'htaccess' => '#^\.htaccess$#D',
        'session' => '#^s/' . self::FID . '/' . self::DID . '\.' . self::TOKEN . '$#D',
        'sessionDir' => '#^s/' . self::FID . '$#D',
        'sessionPrefix' => '#^s/' . self::FID . '/' . self::DID . '\.$#D',
        'handoff' => '#^h/' . self::DID . '$#D',
        'personTombstone' => '#^t/' . self::FID . '$#D',
        'deviceTombstone' => '#^t/' . self::FID . '\.' . self::DID . '$#D',
        'stray' => '#^[sh]/[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}(?:/[A-Za-z0-9_-][A-Za-z0-9._-]{0,99})?$#D',
    ];

    /** @var array<string, list<string>> op => path kinds it may name (contract STORE_OP_PATH_KINDS) */
    public const OP_PATH_KINDS = [
        'init' => ['marker'],
        'put' => ['marker', 'locked', 'session', 'handoff', 'personTombstone', 'deviceTombstone'],
        'delete' => ['locked', 'session', 'handoff', 'stray'],
        'delete_prefix' => ['sessionPrefix'],
        'delete_tree' => ['sessionDir', 'stray'],
    ];

    public const OPS = ['init', 'put', 'delete', 'delete_prefix', 'delete_tree'];

    /** Kind of a store-relative path, or null when it is none of the layout's paths. */
    public static function kind(string $path): ?string
    {
        if (strlen($path) > 200) {
            return null;
        }
        foreach (self::PATTERNS as $kind => $regex) {
            if (preg_match($regex, $path) === 1) {
                return $kind;
            }
        }

        return null;
    }

    public static function isValidPath(string $path): bool
    {
        return self::kind($path) !== null;
    }

    /**
     * True when $op may name $path. A put of the marker must be non-exclusive (the only file that
     * is ever rewritten); every other put must be exclusive.
     */
    public static function isValidOpPath(string $op, string $path, bool $exclusive = true): bool
    {
        $kind = self::kind($path);
        if ($kind === null || !in_array($kind, self::OP_PATH_KINDS[$op] ?? [], true)) {
            return false;
        }
        if ($op === 'put') {
            return $kind === 'marker' ? !$exclusive : $exclusive;
        }

        return true;
    }

    /** ACCESS_STORE_DIR: absolute, safe inside a RewriteCond test string, no "..", no "//", no trailing slash. */
    public static function isSafeStoreDir(string $dir): bool
    {
        return preg_match('#^/[A-Za-z0-9._/-]*[A-Za-z0-9._-]$#D', $dir) === 1
            && !str_contains($dir, '//')
            && !in_array('..', explode('/', $dir), true);
    }

    public static function session(string $fid, string $did, string $sid): string
    {
        return 's/' . $fid . '/' . $did . '.' . $sid;
    }

    public static function sessionDir(string $fid): string
    {
        return 's/' . $fid;
    }

    /** Full delete_prefix path "s/<fid>/<did>." (all sessions of one device). */
    public static function sessionPrefix(string $fid, string $did): string
    {
        return 's/' . $fid . '/' . $did . '.';
    }

    public static function handoff(string $did): string
    {
        return 'h/' . $did;
    }

    public static function personTombstone(string $fid): string
    {
        return 't/' . $fid;
    }

    public static function deviceTombstone(string $fid, string $did): string
    {
        return 't/' . $fid . '.' . $did;
    }

    /**
     * The path with a session id replaced by {@see REDACTED} ("s/<fid>/<did>.<redacted>"); every
     * other path unchanged. Used for logs, error texts and applied ops.
     */
    public static function redact(string $path): string
    {
        return (string) preg_replace('#^(s/' . self::FID . '/' . self::DID . '\.)' . self::TOKEN . '$#D', '$1' . self::REDACTED, $path);
    }

    /** Replaces every 43-char token in a free text (error messages) by "<redacted>". */
    public static function redactText(string $text): string
    {
        return (string) preg_replace('#(?<![A-Za-z0-9_-])' . self::TOKEN . '(?![A-Za-z0-9_-])#', self::REDACTED, $text);
    }

    /** @return array{fid: string, did: string, sid: string}|null */
    public static function parseSessionPath(string $path): ?array
    {
        if (preg_match('#^s/(' . self::FID . ')/(' . self::DID . ')\.(' . self::TOKEN . ')$#D', $path, $m) !== 1) {
            return null;
        }

        return ['fid' => $m[1], 'did' => $m[2], 'sid' => $m[3]];
    }

    /** "<fid>.<did>.<sid>" (throws on a malformed part). */
    public static function gateCookieValue(string $fid, string $did, string $sid): string
    {
        if (!Tokens::isFollowerId($fid) || !Tokens::isDeviceId($did) || !Tokens::isToken($sid)) {
            throw new InvalidArgumentException('Invalid follower id, device id or session id.');
        }

        return $fid . '.' . $did . '.' . $sid;
    }

    /** @return array{fid: string, did: string, sid: string}|null */
    public static function parseGateSession(string $value): ?array
    {
        if (preg_match('#^(' . self::FID . ')\.(' . self::DID . ')\.(' . self::TOKEN . ')$#D', $value, $m) !== 1) {
            return null;
        }

        return ['fid' => $m[1], 'did' => $m[2], 'sid' => $m[3]];
    }

    /** "https://host[:port]" lowercase, no path (contract Origin). */
    public static function isOrigin(string $origin): bool
    {
        return preg_match('#^https?://[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$#D', $origin) === 1;
    }

    public static function personalLinkUrl(string $siteOrigin, string $linkSecret): string
    {
        if (!self::isOrigin($siteOrigin) || !Tokens::isToken($linkSecret)) {
            throw new InvalidArgumentException('Invalid site origin or link secret.');
        }

        return $siteOrigin . '/_/join/#t=' . $linkSecret;
    }

    public static function panicLinkUrl(string $siteOrigin, string $key): string
    {
        if (!self::isOrigin($siteOrigin) || !Tokens::isToken($key)) {
            throw new InvalidArgumentException('Invalid site origin or panic key.');
        }

        return $siteOrigin . '/_/panic/#k=' . $key;
    }

    /** True for "localhost" and 127.0.0.0/8. */
    public static function isLoopbackHost(string $host): bool
    {
        $octet = '(?:25[0-5]|2[0-4]\d|1?\d?\d)';

        return preg_match('/^(?:localhost|127\.' . $octet . '\.' . $octet . '\.' . $octet . ')$/D', $host) === 1;
    }

    /**
     * Gate cookie names and the Secure attribute (contract gateCookies): the __Host- names only
     * for https + "headers"; Secure whenever the origin is https.
     *
     * @return array{session: string, key: string, transfer: string, handoff: string, resume: string, secure: bool}
     */
    public static function gateCookies(string $siteOrigin, string $cookieMode): array
    {
        if (!self::isOrigin($siteOrigin)) {
            throw new InvalidArgumentException('Invalid site origin.');
        }
        $secure = str_starts_with($siteOrigin, 'https:');
        $prefix = $secure && $cookieMode === 'headers' ? '__Host-' : '';

        return [
            'session' => $prefix . 'omw',
            'key' => $prefix . 'omw_k',
            'transfer' => $prefix . 'omw_s',
            'handoff' => $prefix . 'omw_h',
            'resume' => $prefix . 'omw_r',
            'secure' => $secure,
        ];
    }
}
