<?php

declare(strict_types=1);

namespace Omw\Api;

use InvalidArgumentException;
use Omw\Api\Domain\Access\StoreLayout;

/**
 * The access-gate part of the configuration (spec-wave5 §3.1), read by {@see Config::fromArray()}.
 *
 *   ACCESS_STORE_MODE        none (default: the Mac writes the store) | direct | sftp
 *   ACCESS_STORE_DIR         direct: absolute store path as Apache sees it (StoreLayout::isSafeStoreDir)
 *   ACCESS_STORE_SFTP_*      sftp: HOST, PORT (22), USER, KEY_FILE (+ KEY_PASSPHRASE) or PASSWORD,
 *                            HOSTKEYS ("SHA256:<43 base64>", comma-separated), ROOT (the store as this
 *                            SFTP user sees it), ALLOW_SITE_LOGIN (false: refuse a login that sees the
 *                            site docroot)
 *   ACCESS_STORE_DIR_MODE    octal, default 0711; ACCESS_STORE_FILE_MODE octal, default 0600
 *   ACCESS_COOKIE_MODE       headers (default) | co | parent; ACCESS_COOKIE_DOMAIN for parent (F2)
 *   ACCESS_MAX_DEVICES       active devices per person, 1..20 (default 5)
 *   ACCESS_GATE_PROBE        cron probes the site (anonymous check hourly, store proof every 6 h)
 *
 * Secrets (SFTP password, key passphrase) live only in this object and are never logged.
 */
final class AccessConfig
{
    public const STORE_MODES = ['none', 'direct', 'sftp'];
    public const COOKIE_MODES = ['headers', 'co', 'parent'];

    /** @var list<string> */
    public const KEYS = [
        'ACCESS_STORE_MODE', 'ACCESS_STORE_DIR', 'ACCESS_STORE_SFTP_HOST', 'ACCESS_STORE_SFTP_PORT',
        'ACCESS_STORE_SFTP_USER', 'ACCESS_STORE_SFTP_KEY_FILE', 'ACCESS_STORE_SFTP_KEY_PASSPHRASE',
        'ACCESS_STORE_SFTP_PASSWORD', 'ACCESS_STORE_SFTP_HOSTKEYS', 'ACCESS_STORE_SFTP_ROOT',
        'ACCESS_STORE_SFTP_ALLOW_SITE_LOGIN', 'ACCESS_STORE_DIR_MODE', 'ACCESS_STORE_FILE_MODE',
        'ACCESS_COOKIE_MODE', 'ACCESS_COOKIE_DOMAIN', 'ACCESS_MAX_DEVICES', 'ACCESS_GATE_PROBE',
    ];

    /**
     * @param list<string> $sftpHostKeys "SHA256:<43 base64>" pins
     */
    public function __construct(
        public readonly string $storeMode = 'none',
        public readonly string $storeDir = '',
        public readonly string $sftpHost = '',
        public readonly int $sftpPort = 22,
        public readonly string $sftpUser = '',
        public readonly string $sftpKeyFile = '',
        public readonly string $sftpKeyPassphrase = '',
        public readonly string $sftpPassword = '',
        public readonly array $sftpHostKeys = [],
        public readonly string $sftpRoot = '',
        public readonly bool $sftpAllowSiteLogin = false,
        public readonly int $dirMode = 0o711,
        public readonly int $fileMode = 0o600,
        public readonly string $cookieMode = 'headers',
        public readonly string $cookieDomain = '',
        public readonly int $maxDevices = 5,
        public readonly bool $gateProbe = false,
    ) {
    }

    /**
     * @param array<string, string> $env
     * @param string                $siteOrigin normalised SITE_ORIGIN ('' when unset)
     * @param string                $appUrl     APP_URL without a trailing slash ('' when unset)
     */
    public static function fromEnv(string $rootDir, array $env, string $siteOrigin, string $appUrl): self
    {
        $get = static fn (string $key, string $default = ''): string => trim($env[$key] ?? $default);

        $mode = strtolower($get('ACCESS_STORE_MODE', 'none'));
        if (!in_array($mode, self::STORE_MODES, true)) {
            throw new InvalidArgumentException(sprintf('ACCESS_STORE_MODE must be none, direct or sftp, got "%s".', $mode));
        }
        if ($mode !== 'none' && $siteOrigin === '') {
            throw new InvalidArgumentException('ACCESS_STORE_MODE=' . $mode . ' needs SITE_ORIGIN (the site the store belongs to).');
        }

        $storeDir = $get('ACCESS_STORE_DIR');
        if ($storeDir !== '' && !StoreLayout::isSafeStoreDir($storeDir)) {
            throw new InvalidArgumentException(sprintf('ACCESS_STORE_DIR must be an absolute path of [A-Za-z0-9._/-] without "..", "//" or a trailing slash, got "%s".', $storeDir));
        }
        if ($mode === 'direct' && $storeDir === '') {
            throw new InvalidArgumentException('ACCESS_STORE_MODE=direct needs ACCESS_STORE_DIR.');
        }

        $port = $get('ACCESS_STORE_SFTP_PORT', '22');
        if (preg_match('/^\d{1,5}$/D', $port) !== 1 || (int) $port < 1 || (int) $port > 65535) {
            throw new InvalidArgumentException(sprintf('ACCESS_STORE_SFTP_PORT must be a port number, got "%s".', $port));
        }
        $hostKeys = [];
        foreach (explode(',', $get('ACCESS_STORE_SFTP_HOSTKEYS')) as $pin) {
            $pin = trim($pin);
            if ($pin === '') {
                continue;
            }
            if (preg_match('#^SHA256:[A-Za-z0-9+/]{43}$#D', $pin) !== 1) {
                throw new InvalidArgumentException('ACCESS_STORE_SFTP_HOSTKEYS must list "SHA256:<43 base64 characters>" pins, separated by commas.');
            }
            $hostKeys[] = $pin;
        }
        $sftpHost = $get('ACCESS_STORE_SFTP_HOST');
        if ($sftpHost !== '' && preg_match('/^[A-Za-z0-9.-]{1,253}$/D', $sftpHost) !== 1) {
            throw new InvalidArgumentException('ACCESS_STORE_SFTP_HOST must be a host name or IPv4 address.');
        }
        $sftpRoot = $get('ACCESS_STORE_SFTP_ROOT');
        if ($sftpRoot !== '' && !self::safeRelativeOrAbsolute($sftpRoot)) {
            throw new InvalidArgumentException('ACCESS_STORE_SFTP_ROOT must be a path of [A-Za-z0-9._/-] without "..", "//" or a trailing slash.');
        }
        $keyFile = $get('ACCESS_STORE_SFTP_KEY_FILE');
        if ($keyFile !== '' && !str_starts_with($keyFile, '/')) {
            $keyFile = rtrim($rootDir, '/') . '/' . $keyFile;
        }
        $password = $env['ACCESS_STORE_SFTP_PASSWORD'] ?? '';
        if ($mode === 'sftp') {
            if ($sftpHost === '' || $get('ACCESS_STORE_SFTP_USER') === '' || $sftpRoot === '') {
                throw new InvalidArgumentException('ACCESS_STORE_MODE=sftp needs ACCESS_STORE_SFTP_HOST, ACCESS_STORE_SFTP_USER and ACCESS_STORE_SFTP_ROOT.');
            }
            if ($keyFile === '' && $password === '') {
                throw new InvalidArgumentException('ACCESS_STORE_MODE=sftp needs ACCESS_STORE_SFTP_KEY_FILE (preferred) or ACCESS_STORE_SFTP_PASSWORD.');
            }
            if ($hostKeys === []) {
                throw new InvalidArgumentException('ACCESS_STORE_MODE=sftp needs ACCESS_STORE_SFTP_HOSTKEYS (the server\'s SHA256 host key pins).');
            }
        }

        $cookieMode = strtolower($get('ACCESS_COOKIE_MODE', 'headers'));
        if (!in_array($cookieMode, self::COOKIE_MODES, true)) {
            throw new InvalidArgumentException(sprintf('ACCESS_COOKIE_MODE must be headers, co or parent, got "%s".', $cookieMode));
        }
        $cookieDomain = strtolower($get('ACCESS_COOKIE_DOMAIN'));
        if ($cookieMode === 'parent') {
            self::checkParentDomain($cookieDomain, $siteOrigin, $appUrl);
        }

        return new self(
            storeMode: $mode,
            storeDir: $storeDir,
            sftpHost: $sftpHost,
            sftpPort: (int) $port,
            sftpUser: $get('ACCESS_STORE_SFTP_USER'),
            sftpKeyFile: $keyFile,
            sftpKeyPassphrase: $env['ACCESS_STORE_SFTP_KEY_PASSPHRASE'] ?? '',
            sftpPassword: $password,
            sftpHostKeys: $hostKeys,
            sftpRoot: $sftpRoot,
            sftpAllowSiteLogin: self::bool($get('ACCESS_STORE_SFTP_ALLOW_SITE_LOGIN', 'false')),
            dirMode: self::octal($get('ACCESS_STORE_DIR_MODE', '0711'), 'ACCESS_STORE_DIR_MODE'),
            fileMode: self::octal($get('ACCESS_STORE_FILE_MODE', '0600'), 'ACCESS_STORE_FILE_MODE'),
            cookieMode: $cookieMode,
            cookieDomain: $cookieMode === 'parent' ? $cookieDomain : '',
            maxDevices: self::int($get('ACCESS_MAX_DEVICES', '5'), 'ACCESS_MAX_DEVICES', 1, 20),
            gateProbe: self::bool($get('ACCESS_GATE_PROBE', 'false')),
        );
    }

    /** True when the API itself writes the store (direct or sftp). */
    public function apiWrites(): bool
    {
        return $this->storeMode !== 'none';
    }

    public function isParent(): bool
    {
        return $this->cookieMode === 'parent';
    }

    private static function checkParentDomain(string $domain, string $siteOrigin, string $appUrl): void
    {
        $labels = explode('.', $domain);
        if ($domain === '' || preg_match('/^[a-z0-9.-]+$/D', $domain) !== 1 || count($labels) < 2 || in_array('', $labels, true)
            || preg_match('/(?:^|\.)\d+$/D', $domain) === 1) {
            throw new InvalidArgumentException('ACCESS_COOKIE_MODE=parent needs ACCESS_COOKIE_DOMAIN, a parent domain with at least two labels (e.g. example.org).');
        }
        $hosts = ['SITE_ORIGIN' => $siteOrigin === '' ? null : parse_url($siteOrigin, PHP_URL_HOST)];
        $hosts['APP_URL'] = $appUrl === '' ? null : parse_url($appUrl, PHP_URL_HOST);
        if ($hosts['SITE_ORIGIN'] === null) {
            throw new InvalidArgumentException('ACCESS_COOKIE_MODE=parent needs SITE_ORIGIN.');
        }
        foreach ($hosts as $key => $host) {
            if (!is_string($host)) {
                continue;
            }
            $host = strtolower($host);
            if (preg_match('/(?:^|\.)\d+$/D', $host) === 1 || ($host !== $domain && !str_ends_with($host, '.' . $domain))) {
                throw new InvalidArgumentException(sprintf('ACCESS_COOKIE_DOMAIN "%s" must be a parent domain of the %s host "%s".', $domain, $key, $host));
            }
        }
    }

    private static function safeRelativeOrAbsolute(string $path): bool
    {
        return preg_match('#^/?[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$#D', $path) === 1 && !in_array('..', explode('/', $path), true);
    }

    private static function octal(string $value, string $key): int
    {
        if (preg_match('/^0?[0-7]{3}$/D', $value) !== 1) {
            throw new InvalidArgumentException(sprintf('%s must be an octal file mode such as 0711, got "%s".', $key, $value));
        }

        return (int) octdec($value);
    }

    private static function int(string $value, string $key, int $min, int $max): int
    {
        if (preg_match('/^\d+$/D', $value) !== 1 || (int) $value < $min || (int) $value > $max) {
            throw new InvalidArgumentException(sprintf('%s must be an integer between %d and %d, got "%s".', $key, $min, $max, $value));
        }

        return (int) $value;
    }

    private static function bool(string $value): bool
    {
        return in_array(strtolower($value), ['1', 'true', 'yes', 'on'], true);
    }
}
