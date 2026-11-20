<?php

declare(strict_types=1);

namespace Omw\Api\Tests;

use FilesystemIterator;
use Omw\Api\Config;
use Omw\Api\Infra\Db;
use Omw\Api\Infra\Migrator;
use PHPUnit\Framework\TestCase as BaseTestCase;
use RecursiveDirectoryIterator;
use RecursiveIteratorIterator;
use RuntimeException;
use SplFileInfo;

/**
 * Base class: every test gets its own scratch directory below api/var/tests/ (git-ignored;
 * never the system temp dir) that is removed afterwards.
 */
abstract class TestCase extends BaseTestCase
{
    private ?string $tmp = null;

    /** @var list<Db> */
    private array $dbs = [];

    protected function tearDown(): void
    {
        foreach ($this->dbs as $db) {
            $db->close();
        }
        $this->dbs = [];
        if ($this->tmp !== null) {
            self::removeTree($this->tmp);
            @rmdir(dirname($this->tmp)); // var/tests/, once the last test is done
            $this->tmp = null;
        }
        parent::tearDown();
    }

    protected static function rootDir(): string
    {
        return dirname(__DIR__);
    }

    protected function tmpDir(): string
    {
        if ($this->tmp === null) {
            $dir = self::rootDir() . '/var/tests/' . bin2hex(random_bytes(6));
            if (!mkdir($dir, 0775, true) && !is_dir($dir)) {
                throw new RuntimeException('Cannot create ' . $dir);
            }
            $this->tmp = $dir;
        }

        return $this->tmp;
    }

    /**
     * Test config: everything below the scratch dir, nothing read from api/.env or the process env.
     *
     * @param array<string, string> $env
     */
    protected function config(array $env = []): Config
    {
        return Config::fromArray(self::rootDir(), array_merge(self::testEnv($this->tmpDir()), $env));
    }

    /** @return array<string, string> */
    protected static function testEnv(string $tmp): array
    {
        return [
            'APP_ENV' => 'test',
            'APP_DEBUG' => 'false',
            'VAR_DIR' => $tmp . '/var',
            'DB_PATH' => $tmp . '/var/app.sqlite',
            'DB_JOURNAL_MODE' => 'WAL',
            'LOG_LEVEL' => 'debug',
            'LOG_PATH' => $tmp . '/var/logs/app.log',
            'MAIL_DSN' => '',
        ];
    }

    protected function db(Config $config): Db
    {
        $db = Db::fromConfig($config);
        $this->dbs[] = $db;

        return $db;
    }

    protected function migratedDb(Config $config): Db
    {
        $db = $this->db($config);
        (new Migrator($db, $config->migrationsDir()))->migrate();

        return $db;
    }

    /**
     * Runs a bin/ script in a child PHP process with the test env.
     *
     * @param list<string>          $args
     * @param array<string, string> $env  extra env vars (on top of the test env)
     * @return array{code: int, stdout: string, stderr: string}
     */
    protected function runBin(string $script, array $args = [], array $env = [], ?string $stdin = null): array
    {
        $fullEnv = array_merge(getenv(), self::testEnv($this->tmpDir()), $env);
        $cmd = array_merge([PHP_BINARY, self::rootDir() . '/bin/' . $script], $args);
        $proc = proc_open($cmd, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, self::rootDir(), $fullEnv);
        if (!is_resource($proc)) {
            throw new RuntimeException('Cannot start ' . $script);
        }
        if ($stdin !== null) {
            fwrite($pipes[0], $stdin);
        }
        fclose($pipes[0]);
        $stdout = (string) stream_get_contents($pipes[1]);
        $stderr = (string) stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        $code = proc_close($proc);

        return ['code' => $code, 'stdout' => $stdout, 'stderr' => $stderr];
    }

    private static function removeTree(string $dir): void
    {
        if (!is_dir($dir)) {
            return;
        }
        $it = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS),
            RecursiveIteratorIterator::CHILD_FIRST,
        );
        /** @var SplFileInfo $file */
        foreach ($it as $file) {
            $file->isDir() && !$file->isLink() ? rmdir($file->getPathname()) : unlink($file->getPathname());
        }
        rmdir($dir);
    }
}
