<?php

declare(strict_types=1);

namespace Omw\Api\Cli;

use Omw\Api\Config;
use Omw\Api\Infra\Db;
use Omw\Api\Infra\LoggerFactory;
use Omw\Api\Infra\Migrator;
use RuntimeException;

/**
 * Tiny helpers shared by the bin/*.php scripts (no framework on purpose: they must run on any host).
 */
final class Console
{
    /** @var array<string, string|true> */
    private array $options = [];

    /** @var list<string> */
    private array $positional = [];

    /**
     * @param list<string> $argv including the script name
     */
    public function __construct(array $argv)
    {
        foreach (array_slice($argv, 1) as $arg) {
            if (str_starts_with($arg, '--')) {
                $eq = strpos($arg, '=');
                if ($eq === false) {
                    $this->options[substr($arg, 2)] = true;
                } else {
                    $this->options[substr($arg, 2, $eq - 2)] = substr($arg, $eq + 1);
                }
            } else {
                $this->positional[] = $arg;
            }
        }
    }

    public static function fromGlobals(): self
    {
        $argv = $_SERVER['argv'] ?? [];
        $args = [];
        if (is_array($argv)) {
            foreach ($argv as $arg) {
                $args[] = (string) $arg;
            }
        }

        return new self($args);
    }

    public static function rootDir(): string
    {
        return dirname(__DIR__, 2);
    }

    public static function config(): Config
    {
        return Config::fromEnvironment(self::rootDir());
    }

    public static function db(Config $config): Db
    {
        return Db::fromConfig($config, LoggerFactory::create($config, 'cli'));
    }

    /** Fails unless the database exists and all migrations are applied. */
    public static function requireMigrated(Config $config, Db $db): void
    {
        if (!is_file($config->dbPath)) {
            throw new RuntimeException("No database at {$config->dbPath}. Run: php bin/migrate.php");
        }
        $pending = (new Migrator($db, $config->migrationsDir()))->pending();
        if ($pending !== []) {
            throw new RuntimeException('Pending migrations (' . implode(', ', $pending) . '). Run: php bin/migrate.php');
        }
    }

    public function has(string $name): bool
    {
        return isset($this->options[$name]);
    }

    public function option(string $name, ?string $default = null): ?string
    {
        $value = $this->options[$name] ?? null;
        if ($value === true) {
            throw new RuntimeException("--$name needs a value (--$name=...).");
        }

        return $value ?? $default;
    }

    /** @return list<string> */
    public function positional(): array
    {
        return $this->positional;
    }

    /** @param list<string> $allowed */
    public function rejectUnknown(array $allowed): void
    {
        $unknown = array_diff(array_keys($this->options), $allowed);
        if ($unknown !== []) {
            throw new RuntimeException('Unknown option(s): --' . implode(', --', $unknown));
        }
    }

    public static function out(string $line = ''): void
    {
        fwrite(STDOUT, $line . PHP_EOL);
    }

    public static function err(string $line): void
    {
        fwrite(STDERR, $line . PHP_EOL);
    }

    public static function interactive(): bool
    {
        return stream_isatty(STDIN);
    }

    public static function prompt(string $label): string
    {
        fwrite(STDERR, $label);
        $line = fgets(STDIN);

        return $line === false ? '' : rtrim($line, "\r\n");
    }

    /** Reads a line without echo when attached to a terminal. */
    public static function promptHidden(string $label): string
    {
        fwrite(STDERR, $label);
        $tty = self::interactive() && function_exists('shell_exec');
        if ($tty) {
            shell_exec('stty -echo 2>/dev/null');
        }
        try {
            $line = fgets(STDIN);
        } finally {
            if ($tty) {
                shell_exec('stty echo 2>/dev/null');
                fwrite(STDERR, PHP_EOL);
            }
        }

        return $line === false ? '' : rtrim($line, "\r\n");
    }

    /** Whole of STDIN, minus one trailing newline (for --password-stdin). */
    public static function readStdin(): string
    {
        $data = stream_get_contents(STDIN);

        return $data === false ? '' : (string) preg_replace('/\r?\n\z/', '', $data);
    }
}
