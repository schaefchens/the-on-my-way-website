<?php

declare(strict_types=1);

namespace Omw\Api\Domain\App;

use InvalidArgumentException;
use Omw\Api\Config;
use Omw\Api\Infra\Doctor;

/**
 * Settings of the app inbox (app-plan §3.6), from the environment (api/.env is loaded by
 * {@see Config::fromEnvironment()} first). Kept out of {@see Config} so the shared config class
 * does not change; under APP_ENV=test the process environment is ignored (defaults only, tests
 * pass their own instance).
 *
 *   APP_INBOX_MAX_BYTES   disk budget of var/app-inbox (default 1 GiB; at most ~10 % of the
 *                         account quota: a full quota takes SQLite, the admin and the sync down)
 *   APP_TRANSFER_SLOTS    concurrent chunk uploads + backend downloads (default 1; after the host
 *                         probe: PHP workers - 2, at least 1)
 *   APP_CHUNK_MAX_BYTES   largest chunk announced to the phone (default 8 MiB, never above
 *                         post_max_size)
 */
final class AppInboxConfig
{
    public const KEYS = ['APP_INBOX_MAX_BYTES', 'APP_TRANSFER_SLOTS', 'APP_CHUNK_MAX_BYTES'];
    public const DEFAULT_MAX_BYTES = AppRules::GIB;
    public const STALE_SLOT_HOURS = 72;
    public const TOKEN_DAYS = 180;
    public const PAGE_SIZE = 20;

    public function __construct(
        public readonly int $maxBytes = self::DEFAULT_MAX_BYTES,
        public readonly int $transferSlots = 1,
        private readonly int $chunkMaxSetting = AppRules::CHUNK_MAX_BYTES,
    ) {
    }

    /**
     * @param array<string, string> $env
     */
    public static function fromArray(array $env): self
    {
        $int = static function (string $key, int $default, int $min, int $max) use ($env): int {
            $value = trim($env[$key] ?? '');
            if ($value === '') {
                return $default;
            }
            if (preg_match('/^\d{1,15}$/D', $value) !== 1 || (int) $value < $min || (int) $value > $max) {
                throw new InvalidArgumentException(sprintf('%s must be an integer between %d and %d, got "%s".', $key, $min, $max, $value));
            }

            return (int) $value;
        };

        return new self(
            maxBytes: $int('APP_INBOX_MAX_BYTES', self::DEFAULT_MAX_BYTES, 16 * AppRules::MIB, 1024 * AppRules::GIB),
            transferSlots: $int('APP_TRANSFER_SLOTS', 1, 1, 16),
            chunkMaxSetting: $int('APP_CHUNK_MAX_BYTES', AppRules::CHUNK_MAX_BYTES, AppRules::CHUNK_MIN_BYTES, AppRules::CHUNK_MAX_BYTES),
        );
    }

    public static function fromEnvironment(Config $config): self
    {
        if ($config->env === 'test') {
            return new self();
        }
        $env = [];
        foreach (self::KEYS as $key) {
            $value = $_SERVER[$key] ?? $_ENV[$key] ?? getenv($key);
            if (is_string($value)) {
                $env[$key] = $value;
            }
        }

        return self::fromArray($env);
    }

    /** Chunk bounds the server announces (AppEntryState.chunk, AppHints.chunk). */
    public function chunkMaxBytes(): int
    {
        $max = $this->chunkMaxSetting;
        $postMax = Doctor::iniBytes((string) ini_get('post_max_size'));
        if ($postMax > 0) {
            // A request body above post_max_size never reaches PHP intact.
            $max = min($max, $postMax - 64 * AppRules::KIB);
        }
        $max -= $max % (64 * AppRules::KIB);

        return max(AppRules::CHUNK_MIN_BYTES, $max);
    }

    public function chunkMinBytes(): int
    {
        return AppRules::CHUNK_MIN_BYTES;
    }

    /** The largest single file the inbox takes: half the budget, at most the contract's limit for its role. */
    public function fileMaxBytes(?string $role = null): int
    {
        $half = intdiv($this->maxBytes, 2);

        return match ($role) {
            'media' => min($half, AppRules::MEDIA_MAX_BYTES),
            'preview' => min($half, AppRules::PREVIEW_MAX_BYTES),
            default => min($half, AppRules::ORIGINAL_MAX_BYTES),
        };
    }
}
