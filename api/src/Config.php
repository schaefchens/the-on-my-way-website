<?php

declare(strict_types=1);

namespace Omw\Api;

use Dotenv\Dotenv;
use InvalidArgumentException;
use Omw\Api\Infra\OutboundUrl;

/**
 * Immutable runtime configuration, read from environment variables (and api/.env).
 *
 * Real environment variables win over api/.env (Dotenv is loaded immutable).
 * Relative paths resolve against the api/ root directory.
 */
final class Config
{
    public const ENVIRONMENTS = ['production', 'development', 'test'];
    public const JOURNAL_MODES = ['WAL', 'DELETE'];
    public const LOG_LEVELS = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'];

    /**
     * @param string      $rootDir     absolute path of api/
     * @param string|null $basePath    URL prefix of the app; null = auto-detect from SCRIPT_NAME
     * @param string      $journalMode WAL|DELETE
     */
    public function __construct(
        public readonly string $rootDir,
        public readonly string $env,
        public readonly bool $debug,
        public readonly string $varDir,
        public readonly string $dbPath,
        public readonly string $journalMode,
        public readonly string $logPath,
        public readonly string $logLevel,
        public readonly ?string $basePath,
        public readonly string $mailDsn,
        public readonly string $mailFrom,
        public readonly string $cronKey = '',
        public readonly string $siteOrigin = '',
        public readonly string $appUrl = '',
        public readonly string $ntfyToken = '',
        public readonly int $backupKeep = 14,
        public readonly int $backupHour = 3,
        public readonly int $alertRepeatMinutes = 60,
        public readonly int $publishFailThreshold = 3,
        public readonly int $sessionDays = 30,
        public readonly bool $devInsecureCookie = false,
        public readonly string $ntfyServer = self::DEFAULT_NTFY_SERVER,
        public readonly AccessConfig $access = new AccessConfig(),
    ) {
    }

    /** Origin NTFY_TOKEN belongs to when NTFY_SERVER is not set. */
    public const DEFAULT_NTFY_SERVER = 'https://ntfy.sh';

    /**
     * Loads api/.env (if present, without overriding real env vars) and builds the config.
     */
    public static function fromEnvironment(string $rootDir): self
    {
        if (is_file($rootDir . '/.env')) {
            Dotenv::createImmutable($rootDir)->safeLoad();
        }

        $env = [];
        foreach (self::knownKeys() as $key) {
            $value = $_SERVER[$key] ?? $_ENV[$key] ?? getenv($key);
            if (is_string($value)) {
                $env[$key] = $value;
            }
        }

        return self::fromArray($rootDir, $env);
    }

    /**
     * Builds the config from an explicit key/value map (no .env, no process env). Used by tests.
     *
     * @param array<string, string> $env
     */
    public static function fromArray(string $rootDir, array $env): self
    {
        $rootDir = rtrim($rootDir, '/');
        $get = static fn (string $key, string $default = ''): string => trim($env[$key] ?? $default);

        $appEnv = strtolower($get('APP_ENV', 'production'));
        if (!in_array($appEnv, self::ENVIRONMENTS, true)) {
            throw new InvalidArgumentException(sprintf('APP_ENV must be one of %s, got "%s".', implode('|', self::ENVIRONMENTS), $appEnv));
        }

        $journalMode = strtoupper($get('DB_JOURNAL_MODE', 'WAL'));
        if (!in_array($journalMode, self::JOURNAL_MODES, true)) {
            throw new InvalidArgumentException(sprintf('DB_JOURNAL_MODE must be WAL or DELETE, got "%s".', $journalMode));
        }

        $logLevel = strtolower($get('LOG_LEVEL', 'info'));
        if (!in_array($logLevel, self::LOG_LEVELS, true)) {
            throw new InvalidArgumentException(sprintf('LOG_LEVEL must be one of %s, got "%s".', implode('|', self::LOG_LEVELS), $logLevel));
        }

        $varDir = self::resolvePath($rootDir, $get('VAR_DIR', 'var'));
        $dbPath = $get('DB_PATH');
        $dbPath = $dbPath === '' ? $varDir . '/app.sqlite' : self::resolvePath($rootDir, $dbPath);

        $logPath = $get('LOG_PATH');
        if ($logPath === '') {
            $logPath = $varDir . '/logs/app.log';
        } elseif (!str_starts_with($logPath, 'php://')) {
            $logPath = self::resolvePath($rootDir, $logPath);
        }

        // Local http development only (see Http\SessionCookie): refused outright outside
        // APP_ENV=development, so a production .env can never switch the __Host- cookie off.
        $devInsecureCookie = self::bool($get('DEV_INSECURE_COOKIE', 'false'));
        if ($devInsecureCookie && $appEnv !== 'development') {
            throw new InvalidArgumentException(sprintf('DEV_INSECURE_COOKIE=true is only allowed with APP_ENV=development, got APP_ENV=%s.', $appEnv));
        }

        $basePath = null;
        if (array_key_exists('BASE_PATH', $env)) {
            $basePath = rtrim(trim($env['BASE_PATH']), '/');
            if ($basePath !== '' && !str_starts_with($basePath, '/')) {
                $basePath = '/' . $basePath;
            }
        }

        return new self(
            rootDir: $rootDir,
            env: $appEnv,
            debug: self::bool($get('APP_DEBUG', 'false')),
            varDir: $varDir,
            dbPath: $dbPath,
            journalMode: $journalMode,
            logPath: $logPath,
            logLevel: $logLevel,
            basePath: $basePath,
            mailDsn: $get('MAIL_DSN'),
            mailFrom: $get('MAIL_FROM'),
            cronKey: $get('CRON_KEY'),
            siteOrigin: self::origin($get('SITE_ORIGIN')),
            appUrl: rtrim($get('APP_URL'), '/'),
            ntfyToken: $get('NTFY_TOKEN'),
            backupKeep: self::int($get('BACKUP_KEEP', '14'), 'BACKUP_KEEP', 1, 365),
            backupHour: self::int($get('BACKUP_HOUR', '3'), 'BACKUP_HOUR', 0, 23),
            alertRepeatMinutes: self::int($get('ALERT_REPEAT_MINUTES', '60'), 'ALERT_REPEAT_MINUTES', 5, 10080),
            publishFailThreshold: self::int($get('PUBLISH_FAIL_THRESHOLD', '3'), 'PUBLISH_FAIL_THRESHOLD', 1, 1000),
            sessionDays: self::int($get('SESSION_DAYS', '30'), 'SESSION_DAYS', 1, 365),
            devInsecureCookie: $devInsecureCookie,
            ntfyServer: self::ntfyServer($get('NTFY_SERVER', self::DEFAULT_NTFY_SERVER)),
            access: AccessConfig::fromEnv($rootDir, $env, self::origin($get('SITE_ORIGIN')), rtrim($get('APP_URL'), '/')),
        );
    }

    /** @return list<string> */
    public static function knownKeys(): array
    {
        return [
            'APP_ENV', 'APP_DEBUG', 'BASE_PATH', 'VAR_DIR', 'DB_PATH', 'DB_JOURNAL_MODE',
            'LOG_PATH', 'LOG_LEVEL', 'MAIL_DSN', 'MAIL_FROM', 'CRON_KEY', 'SITE_ORIGIN', 'APP_URL',
            'NTFY_TOKEN', 'BACKUP_KEEP', 'BACKUP_HOUR', 'ALERT_REPEAT_MINUTES', 'PUBLISH_FAIL_THRESHOLD',
            'SESSION_DAYS', 'DEV_INSECURE_COOKIE', 'NTFY_SERVER',
            ...AccessConfig::KEYS,
        ];
    }

    public function migrationsDir(): string
    {
        return $this->rootDir . '/migrations';
    }

    /**
     * The maintenance flag in the deploy unit's root: while it exists, public/index.php answers
     * 503 and cron skips its jobs (scripts/deploy-api.ts uploads it while PHP files change; the
     * restore procedure in docs/HOSTING.md uses it while the database file is swapped).
     */
    public function maintenanceFlag(): string
    {
        return $this->rootDir . '/.maintenance';
    }

    public function inMaintenance(): bool
    {
        clearstatcache(true, $this->maintenanceFlag());

        return is_file($this->maintenanceFlag());
    }

    public function isProduction(): bool
    {
        return $this->env === 'production';
    }

    private static function resolvePath(string $rootDir, string $path): string
    {
        if ($path === '') {
            return $rootDir;
        }
        $path = rtrim($path, '/');

        return str_starts_with($path, '/') ? $path : $rootDir . '/' . $path;
    }

    /** Minimum length of CRON_KEY; shorter keys disable the web-cron endpoint. */
    public const MIN_CRON_KEY_LENGTH = 24;

    /** True when the HTTP web-cron endpoint is enabled (CRON_KEY set and long enough). */
    public function webCronEnabled(): bool
    {
        return strlen($this->cronKey) >= self::MIN_CRON_KEY_LENGTH;
    }

    private static function int(string $value, string $key, int $min, int $max): int
    {
        if (preg_match('/^-?\d+$/D', $value) !== 1 || (int) $value < $min || (int) $value > $max) {
            throw new InvalidArgumentException(sprintf('%s must be an integer between %d and %d, got "%s".', $key, $min, $max, $value));
        }

        return (int) $value;
    }

    /** "https://example.org/some/path" -> "https://example.org" ('' when empty). */
    private static function origin(string $value): string
    {
        if ($value === '') {
            return '';
        }
        $parts = parse_url($value);
        if (!is_array($parts) || !isset($parts['scheme'], $parts['host']) || !in_array(strtolower($parts['scheme']), ['http', 'https'], true)) {
            throw new InvalidArgumentException(sprintf('SITE_ORIGIN must be an http(s) URL, got "%s".', $value));
        }
        $origin = strtolower($parts['scheme']) . '://' . strtolower($parts['host']);
        if (isset($parts['port'])) {
            $origin .= ':' . $parts['port'];
        }

        return $origin;
    }

    /**
     * NTFY_SERVER: the ntfy server NTFY_TOKEN is for, as an origin ("https://ntfy.sh",
     * "https://ntfy.example.org:8443"). The token is sent only to alerts.ntfy_url's on that origin.
     */
    private static function ntfyServer(string $value): string
    {
        $origin = OutboundUrl::originOf($value === '' ? self::DEFAULT_NTFY_SERVER : $value);
        if ($origin === null) {
            throw new InvalidArgumentException(sprintf('NTFY_SERVER must be an http(s) URL such as https://ntfy.sh, got "%s".', $value));
        }

        return $origin;
    }

    private static function bool(string $value): bool
    {
        return in_array(strtolower($value), ['1', 'true', 'yes', 'on'], true);
    }
}
