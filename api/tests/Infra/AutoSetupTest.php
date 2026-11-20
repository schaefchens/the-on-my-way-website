<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Infra;

use Omw\Api\Domain\Auth\ApiTokens;
use Omw\Api\Domain\Auth\Passwords;
use Omw\Api\Http\ApiException;
use Omw\Api\Infra\AutoMigrator;
use Omw\Api\Infra\Bootstrapper;
use Omw\Api\Infra\Db;
use Omw\Api\Infra\Migrator;
use Omw\Api\Infra\Paths;
use Omw\Api\Tests\Http\ApiTestCase;
use RuntimeException;

/**
 * Zero-shell setup: automatic migrations on the first request (stamp fast path, flock, never
 * concurrent) and one-time consumption of var/bootstrap.json.
 */
final class AutoSetupTest extends ApiTestCase
{
    public function testFirstRequestMigratesAndWritesTheStamp(): void
    {
        $config = $this->config();
        self::assertFileDoesNotExist($config->dbPath);
        $response = $this->request('GET', '/api/v1/health');
        self::assertSame(200, $response->getStatusCode());
        self::assertFileExists($config->dbPath);
        self::assertFileExists($config->varDir . '/' . AutoMigrator::STAMP);
        self::assertSame([], (new Migrator($this->service(Db::class), $config->migrationsDir()))->pending());

        // Fast path afterwards; a replaced database file (restore) is checked again.
        $migrator = $this->service(AutoMigrator::class);
        self::assertTrue($migrator->upToDate());
        self::assertFalse($migrator->ensure());
        $this->service(Db::class)->close();
        rename($config->dbPath, $config->dbPath . '.old');
        copy($config->dbPath . '.old', $config->dbPath);
        self::assertFalse($migrator->upToDate(), 'new inode');
        self::assertTrue($migrator->ensure());
        self::assertTrue($migrator->upToDate());
    }

    public function testANewMigrationFileInvalidatesTheStamp(): void
    {
        $this->migrate();
        $migrator = $this->service(AutoMigrator::class);
        $before = $migrator->fingerprint();

        // Simulate a deploy that adds a migration (in a copy of the migrations dir).
        $dir = $this->tmpDir() . '/migrations';
        mkdir($dir);
        foreach (glob(self::rootDir() . '/migrations/*.sql') ?: [] as $file) {
            copy($file, $dir . '/' . basename($file));
        }
        file_put_contents($dir . '/9999_test_extra.sql', "CREATE TABLE extra (id INTEGER PRIMARY KEY);\n");
        $config = $this->config();
        $paths = new Paths($config);
        $db = $this->service(Db::class);
        $auto = new AutoMigrator($config, $paths, new Migrator($db, $dir), new Bootstrapper($db, $paths));
        self::assertNotSame($before, $auto->fingerprint());
        self::assertFalse($auto->upToDate());
        self::assertTrue($auto->ensure());
        self::assertNotNull($db->scalar("SELECT name FROM sqlite_master WHERE name = 'extra'"));
        self::assertFalse($auto->ensure());
    }

    public function testWaitsForTheSetupLockAndAnswers503WhenItCannotGetIt(): void
    {
        $config = $this->config();
        $paths = new Paths($config);
        $paths->ensureVar();
        $lock = fopen($paths->var(AutoMigrator::LOCK), 'c');
        self::assertNotFalse($lock);
        self::assertTrue(flock($lock, LOCK_EX));
        try {
            $db = new Db($config->dbPath);
            $auto = new AutoMigrator($config, $paths, new Migrator($db, $config->migrationsDir()), new Bootstrapper($db, $paths), null, 0.3);
            $started = microtime(true);
            try {
                $auto->ensure();
                self::fail('expected a 503');
            } catch (ApiException $e) {
                self::assertSame(503, $e->status);
                self::assertSame('maintenance', $e->errorCode);
                self::assertSame('5', $e->headers['Retry-After']);
            }
            self::assertGreaterThanOrEqual(0.25, microtime(true) - $started, 'it waited for the lock');
            self::assertFileDoesNotExist($config->dbPath, 'nothing ran without the lock');
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
        // Over HTTP the same situation is a JSON 503 with Retry-After (checked via the error handler).
        self::assertSame(200, $this->request('GET', '/api/v1/health')->getStatusCode(), 'works once the lock is free');
    }

    public function testConcurrentFirstRequestsMigrateExactlyOnce(): void
    {
        $env = self::testEnv($this->tmpDir());
        $script = <<<'PHP'
            require $argv[1] . '/vendor/autoload.php';
            $config = Omw\Api\Config::fromArray($argv[1], json_decode($argv[2], true));
            $c = Omw\Api\App::buildContainer($config);
            echo $c->get(Omw\Api\Infra\AutoMigrator::class)->ensure() ? 'migrated' : 'noop';
            PHP;
        $procs = [];
        for ($i = 0; $i < 4; ++$i) {
            $proc = proc_open([PHP_BINARY, '-r', $script, self::rootDir(), (string) json_encode($env)], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
            self::assertIsResource($proc);
            $procs[] = [$proc, $pipes];
        }
        $outputs = [];
        foreach ($procs as [$proc, $pipes]) {
            $outputs[] = trim((string) stream_get_contents($pipes[1])) . trim((string) stream_get_contents($pipes[2]));
            fclose($pipes[1]);
            fclose($pipes[2]);
            proc_close($proc);
        }
        sort($outputs);
        self::assertSame(['migrated', 'noop', 'noop', 'noop'], $outputs, implode("\n", $outputs));
        $db = $this->db($this->config());
        self::assertSame(1, (int) $db->scalar("SELECT COUNT(*) FROM schema_migrations WHERE version = '0001_init'"));
        self::assertSame(10, (int) $db->scalar("SELECT COUNT(*) FROM change_log WHERE entity = 'setting'"), 'seed ran once');
    }

    public function testBootstrapIsConsumedOnce(): void
    {
        $config = $this->config();
        (new Paths($config))->ensureVar();
        $token = ApiTokens::generate();
        $bootstrap = [
            'version' => 1,
            'admin' => [
                'email' => 'Owner@On-My-Way.invalid',
                'passwordHash' => password_hash('a strong generated password', PASSWORD_ARGON2ID),
                'passwordHashFallback' => password_hash('a strong generated password', PASSWORD_BCRYPT),
                'displayName' => 'Owner',
            ],
            'tokens' => [['kind' => 'backend', 'name' => 'home', 'tokenHash' => ApiTokens::hash($token), 'hint' => substr($token, 0, 10) . '…']],
        ];
        $file = $config->varDir . '/' . Bootstrapper::FILE;
        file_put_contents($file, json_encode($bootstrap));

        // The very first request consumes it (after migrating).
        self::assertSame(200, $this->request('GET', '/api/v1/health')->getStatusCode());
        self::assertFileDoesNotExist($file);
        $login = $this->request('POST', '/api/v1/admin/session', ['email' => 'owner@on-my-way.invalid', 'password' => 'a strong generated password']);
        self::assertSame(200, $login->getStatusCode(), (string) $login->getBody());
        self::assertSame(200, $this->request('GET', '/api/v1/backend/changes', null, ['Authorization' => 'Bearer ' . $token])->getStatusCode());

        // Uploading the same file again changes nothing (same hash), and it is removed.
        $db = $this->service(Db::class);
        $hash = $db->scalar('SELECT password_hash FROM users');
        file_put_contents($file, json_encode($bootstrap));
        $this->request('GET', '/api/v1/health');
        self::assertFileDoesNotExist($file);
        self::assertSame($hash, $db->scalar('SELECT password_hash FROM users'));
        self::assertSame(1, (int) $db->scalar("SELECT COUNT(*) FROM api_tokens WHERE kind = 'backend'"));
    }

    public function testBootstrapCanResetThePasswordAndRotateTheFeedId(): void
    {
        $this->createAdmin('owner@example.org', 'the old password!');
        $db = $this->service(Db::class);
        $feedId = $db->scalar("SELECT value FROM meta WHERE key = 'feed_id'");
        $file = $this->config()->varDir . '/' . Bootstrapper::FILE;

        // Without "reset" an existing user keeps the password.
        file_put_contents($file, json_encode(['version' => 1, 'admin' => ['email' => 'owner@example.org', 'passwordHash' => Passwords::hash('the new password!!')]]));
        $this->request('GET', '/api/v1/health');
        self::assertTrue(Passwords::verify('the old password!', (string) $db->scalar('SELECT password_hash FROM users')));

        file_put_contents($file, json_encode(['version' => 1, 'admin' => ['email' => 'owner@example.org', 'passwordHash' => Passwords::hash('the new password!!'), 'reset' => true], 'rotateFeedId' => true]));
        $this->request('GET', '/api/v1/health');
        self::assertTrue(Passwords::verify('the new password!!', (string) $db->scalar('SELECT password_hash FROM users')));
        self::assertNotSame($feedId, $db->scalar("SELECT value FROM meta WHERE key = 'feed_id'"));
    }

    public function testBootstrapCanChangeTheAdminEmailOnHostsWithoutAShell(): void
    {
        $id = $this->createAdmin('owner@on-my-way.invalid', 'the old password!');
        $db = $this->service(Db::class);
        $session = $this->service(ApiTokens::class)->create('session', 'browser', null, $id);
        $file = $this->config()->varDir . '/' . Bootstrapper::FILE;
        $bootstrapper = new Bootstrapper($db, new Paths($this->config()));

        // The e-mail alone: sessions stay valid.
        file_put_contents($file, json_encode(['version' => 1, 'adminEmail' => ['from' => 'owner@on-my-way.invalid', 'to' => 'Hidden.Owner@Example.org']]));
        self::assertSame(['admin' => 'none', 'tokens' => 0, 'rotatedFeedId' => false, 'adminEmail' => 'changed'], $bootstrapper->consume());
        self::assertSame('hidden.owner@example.org', $db->scalar('SELECT email FROM users'));
        self::assertNull($db->scalar('SELECT revoked_at FROM api_tokens WHERE id = ?', [$session['id']]));

        // Re-uploaded (already applied) -> unchanged; unknown "from" -> skipped, never retried.
        file_put_contents($file, json_encode(['version' => 1, 'adminEmail' => ['from' => 'owner@on-my-way.invalid', 'to' => 'hidden.owner@example.org']]));
        $again = $bootstrapper->consume();
        self::assertNotNull($again);
        self::assertSame('unchanged', $again['adminEmail']);
        file_put_contents($file, json_encode(['version' => 1, 'adminEmail' => ['from' => 'ghost@example.org', 'to' => 'new@example.org']]));
        $unknown = $bootstrapper->consume();
        self::assertNotNull($unknown);
        self::assertSame('skipped', $unknown['adminEmail']);
        self::assertFileDoesNotExist($file);
        self::assertSame('hidden.owner@example.org', $db->scalar('SELECT email FROM users'));

        // Together with a password reset (both deploy flags): "admin" first (by the current
        // e-mail), then the e-mail; the reset revokes the sessions as always.
        file_put_contents($file, json_encode(['version' => 1,
            'admin' => ['email' => 'hidden.owner@example.org', 'passwordHash' => Passwords::hash('the new password!!'), 'reset' => true],
            'adminEmail' => ['from' => 'hidden.owner@example.org', 'to' => 'owner@example.org']]));
        self::assertSame(['admin' => 'password_reset', 'tokens' => 0, 'rotatedFeedId' => false, 'adminEmail' => 'changed'], $bootstrapper->consume());
        self::assertSame('owner@example.org', $db->scalar('SELECT email FROM users'));
        self::assertTrue(Passwords::verify('the new password!!', (string) $db->scalar('SELECT password_hash FROM users')));

        foreach (['{"version":1,"adminEmail":{"from":"a@b.example"}}', '{"version":1,"adminEmail":{"from":"a@b.example","to":"nope"}}'] as $raw) {
            try {
                Bootstrapper::parse($raw);
                self::fail('accepted: ' . $raw);
            } catch (\InvalidArgumentException) {
                self::addToAssertionCount(1);
            }
        }
    }

    public function testAnInvalidBootstrapFileIsSetAsideWithoutBlockingTheApp(): void
    {
        $config = $this->config();
        (new Paths($config))->ensureVar();
        file_put_contents($config->varDir . '/' . Bootstrapper::FILE, '{"version": 2}');
        self::assertSame(200, $this->request('GET', '/api/v1/health')->getStatusCode());
        self::assertFileDoesNotExist($config->varDir . '/' . Bootstrapper::FILE);
        self::assertCount(1, glob($config->varDir . '/bootstrap.json.invalid-*') ?: []);
        self::assertSame(200, $this->request('GET', '/api/v1/health')->getStatusCode());
    }

    public function testBootstrapParserRejectsBadInput(): void
    {
        foreach (['nope', '[]', '{"version":1,"admin":{"email":"x"}}', '{"version":1,"tokens":[{"kind":"session","tokenHash":"' . str_repeat('a', 64) . '"}]}', '{"version":1,"tokens":[{"kind":"backend","tokenHash":"short"}]}'] as $raw) {
            try {
                Bootstrapper::parse($raw);
                self::fail('accepted: ' . $raw);
            } catch (\InvalidArgumentException) {
                self::addToAssertionCount(1);
            }
        }
        try {
            Bootstrapper::parse('{"version":1,"tokens":[{"kind":"app","tokenHash":"' . str_repeat('a', 64) . '"}]}');
            self::fail('accepted an app token without an admin');
        } catch (\InvalidArgumentException) {
            self::addToAssertionCount(1);
        }

        // Regression: a parseable file that can never be applied (here: no password hash) is set
        // aside like an unparseable one, instead of being retried under the setup lock (and in a
        // write transaction) on every request.
        $db = $this->service(Db::class);
        $this->migrate();
        $file = $this->config()->varDir . '/' . Bootstrapper::FILE;
        file_put_contents($file, '{"version":1,"admin":{"email":"a@b.example","passwordHash":"plaintext"}}');
        try {
            (new Bootstrapper($db, new Paths($this->config())))->consume();
            self::fail('consumed a bootstrap file without a password hash');
        } catch (RuntimeException $e) {
            self::assertStringContainsString('not a password_hash() hash', $e->getMessage());
        }
        self::assertFileDoesNotExist($file);
        self::assertCount(1, glob($file . '.invalid-*') ?: []);
        self::assertSame(0, (int) $db->scalar('SELECT COUNT(*) FROM users'));
    }
}
