<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Cli;

use Omw\Api\Domain\Auth\ApiTokens;
use Omw\Api\Domain\Auth\Passwords;
use Omw\Api\Tests\TestCase;

/**
 * End-to-end runs of the bin/ scripts in child processes against a scratch var/ directory.
 */
final class BinScriptsTest extends TestCase
{
    public function testMigrateCreatesTheDatabaseAndIsIdempotent(): void
    {
        $first = $this->runBin('migrate.php');
        self::assertSame(0, $first['code'], $first['stderr']);
        self::assertStringContainsString('applied 0001_init', $first['stdout']);
        self::assertStringContainsString('journal_mode=wal', $first['stdout']);
        self::assertFileExists($this->tmpDir() . '/var/app.sqlite');
        self::assertFileExists($this->tmpDir() . '/var/.htaccess');

        $second = $this->runBin('migrate.php');
        self::assertSame(0, $second['code']);
        self::assertStringContainsString('Nothing to migrate.', $second['stdout']);

        $status = $this->runBin('migrate.php', ['--status']);
        self::assertMatchesRegularExpression('/0001_init\s+applied /', $status['stdout']);
    }

    public function testScriptsRefuseToRunBeforeMigrations(): void
    {
        $result = $this->runBin('create-token.php', ['--kind=backend', '--name=x']);

        self::assertSame(1, $result['code']);
        self::assertStringContainsString('bin/migrate.php', $result['stderr']);
    }

    public function testCreateAdminWithPasswordFromStdin(): void
    {
        $this->runBin('migrate.php');

        $result = $this->runBin('create-admin.php', ['--email=Owner@Example.com', '--password-stdin'], stdin: "correct horse battery\n");
        self::assertSame(0, $result['code'], $result['stderr']);
        self::assertStringContainsString('owner@example.com created', $result['stdout']);

        $hash = $this->migratedDb($this->config())->scalar('SELECT password_hash FROM users WHERE email = ?', ['owner@example.com']);
        self::assertIsString($hash);
        self::assertTrue(Passwords::verify('correct horse battery', $hash));

        $again = $this->runBin('create-admin.php', ['--email=owner@example.com', '--password-stdin'], stdin: 'another long password');
        self::assertSame(1, $again['code'], 'existing user without --reset');

        $reset = $this->runBin('create-admin.php', ['--email=owner@example.com', '--password-stdin', '--reset'], stdin: 'another long password');
        self::assertSame(0, $reset['code'], $reset['stderr']);

        $weak = $this->runBin('create-admin.php', ['--email=second@example.com', '--password-stdin'], stdin: 'short');
        self::assertSame(1, $weak['code']);
    }

    public function testCreateTokenPrintsTheTokenOnceOnStdout(): void
    {
        $this->runBin('migrate.php');

        $result = $this->runBin('create-token.php', ['--kind=backend', '--name=home-mac']);
        self::assertSame(0, $result['code'], $result['stderr']);
        $token = trim($result['stdout']);
        self::assertTrue(ApiTokens::looksLikeToken($token), $token);
        self::assertStringNotContainsString($token, $result['stderr']);

        $stored = $this->migratedDb($this->config())->scalar('SELECT token_hash FROM api_tokens WHERE name = ?', ['home-mac']);
        self::assertSame(hash('sha256', $token), $stored);

        $list = $this->runBin('create-token.php', ['--list']);
        self::assertStringContainsString('home-mac', $list['stdout']);
        self::assertStringNotContainsString($token, $list['stdout']);

        self::assertSame(2, $this->runBin('create-token.php', ['--kind=app', '--name=phone'])['code'], 'app token needs --user');
        self::assertSame(1, $this->runBin('create-token.php', ['--bogus'])['code']);
        self::assertSame(0, $this->runBin('create-token.php', ['--revoke=1'])['code']);
    }

    public function testCronMigratesRunsAllJobsAndSkipsWhenLocked(): void
    {
        // No database yet: cron applies the migrations itself (no shell needed after a deploy).
        $result = $this->runBin('cron.php', ['--verbose']);
        self::assertSame(0, $result['code'], $result['stderr']);
        self::assertStringContainsString('alerts: {"opened":[]', $result['stdout']);
        self::assertStringContainsString('cleanup: {"changeLogCompacted":0', $result['stdout']);
        self::assertFileExists($this->tmpDir() . '/var/app.sqlite');

        $json = $this->runBin('cron.php', ['--json', '--only=backup', '--force-backup']);
        self::assertSame(0, $json['code'], $json['stderr']);
        $data = json_decode($json['stdout'], true);
        self::assertIsArray($data);
        self::assertTrue($data['ok']);
        self::assertSame(['backup'], array_keys($data['jobs']));
        // The forced backup exists. (The first run above may have made one too: it is due once the
        // local hour passed BACKUP_HOUR, and a second-precision name may or may not differ.)
        $created = $data['jobs']['backup']['created'] ?? null;
        self::assertIsString($created);
        self::assertFileExists($this->tmpDir() . '/var/backups/' . $created);

        $lock = fopen($this->tmpDir() . '/var/cache/cron.lock', 'c');
        self::assertNotFalse($lock);
        self::assertTrue(flock($lock, LOCK_EX | LOCK_NB));
        try {
            $locked = $this->runBin('cron.php', ['--verbose']);
            self::assertSame(0, $locked['code']);
            self::assertStringContainsString('still in progress', $locked['stdout']);
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
        self::assertSame(1, $this->runBin('cron.php', ['--bogus'])['code']);
    }
}
