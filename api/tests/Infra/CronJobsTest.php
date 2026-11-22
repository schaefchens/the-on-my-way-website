<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Infra;

use DateTimeImmutable;
use Omw\Api\Domain\Auth\LoginThrottle;
use Omw\Api\Infra\Backups;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\CronRunner;
use Omw\Api\Infra\Db;
use Omw\Api\Infra\Maintenance;
use Omw\Api\Domain\Access\StoreLayout;
use Omw\Api\Infra\HttpClient;
use Omw\Api\Tests\Http\AccessTestCase;
use Omw\Api\Tests\Support\FakeHttpClient;

/**
 * Nightly backups (VACUUM INTO, one per local day, retention), cleanup, the cron runner and the
 * web-cron endpoint (secret key, constant-time compare, disabled without CRON_KEY), and the access
 * job (spec-wave5 §3.9): handoff marker TTL, the anonymous gate probe once per hour and the store
 * proof once per 6 hours (new session 302, old session 200).
 */
final class CronJobsTest extends AccessTestCase
{
    private const KEY = 'test-cron-key-0123456789abcdef';

    public function testBackupsAreNightlyPerLocalDayAndPruned(): void
    {
        $this->migrate();
        $backups = $this->service(Backups::class);
        // 01:00 UTC = 02:00 Berlin: before BACKUP_HOUR (3).
        self::assertFalse($backups->due(new DateTimeImmutable('2026-11-20T01:00:00Z'), 'Europe/Berlin', 3));
        self::assertTrue($backups->due(new DateTimeImmutable('2026-11-20T02:00:00Z'), 'Europe/Berlin', 3));
        $first = $backups->create(new DateTimeImmutable('2026-11-20T02:00:00Z'), 'Europe/Berlin');
        self::assertSame('2026-11-20', $first['localDate']);
        self::assertFalse($backups->due(new DateTimeImmutable('2026-11-20T22:00:00Z'), 'Europe/Berlin', 3));
        self::assertTrue($backups->due(new DateTimeImmutable('2026-11-21T02:00:00Z'), 'Europe/Berlin', 3));

        // The snapshot is a complete, consistent database (opened read-only: the hash must stay valid).
        self::assertSame(hash_file('sha256', $first['path']), $first['sha256']);
        copy($first['path'], $this->tmpDir() . '/restore-test.sqlite');
        $copy = new Db($this->tmpDir() . '/restore-test.sqlite');
        self::assertSame(14, (int) $copy->scalar('SELECT COUNT(*) FROM settings')); // 0001 (10) + 0002 (4)
        self::assertSame('ok', $copy->scalar('PRAGMA integrity_check'));
        $copy->close();
        self::assertSame(hash_file('sha256', $first['path']), $first['sha256']);

        for ($d = 21; $d <= 25; ++$d) {
            $backups->create(new DateTimeImmutable("2026-11-{$d}T02:00:00Z"), 'Europe/Berlin');
        }
        self::assertSame(3, $backups->prune(3, new DateTimeImmutable('2026-11-25T03:00:00Z')));
        self::assertSame(['2026-11-25', '2026-11-24', '2026-11-23'], array_column($backups->all(), 'localDate'));
        self::assertSame('2026-11-25', $backups->latest()['localDate'] ?? null);
    }

    public function testMaintenanceCleansUp(): void
    {
        $this->migrate();
        $db = $this->service(Db::class);
        $throttle = $this->service(LoginThrottle::class);
        Clock::freeze('2026-09-01T00:00:00Z');
        $throttle->record('203.0.113.1', 'x@example.org', false);
        Clock::freeze(self::NOW);
        $throttle->record('203.0.113.1', 'x@example.org', false);

        // An orphan preview (older than an hour) goes, a referenced one stays.
        $key = $this->putCapture('3EB0CLEAN1', '2026-11-18T02:00:00Z');
        $this->service(\Omw\Api\Domain\Captures::class)->storePreview($key, 'preview', "RIFF\0\0\0\0WEBPVP8 " . str_repeat("\0", 20), 'image/webp');
        $orphan = $this->tmpDir() . '/var/previews/zz/e_orphan_preview_00000000.webp';
        mkdir(dirname($orphan), 0775, true);
        file_put_contents($orphan, 'x');
        touch($orphan, Clock::now()->getTimestamp() - 7200); // two hours before the frozen clock

        $result = $this->service(Maintenance::class)->run(Clock::now());
        self::assertSame(1, $result['loginAttemptsPruned']);
        self::assertSame(1, $result['previewFilesRemoved']);
        self::assertFileDoesNotExist($orphan);
        self::assertCount(1, glob($this->tmpDir() . '/var/previews/*/*') ?: []);
        self::assertSame(1, (int) $db->scalar('SELECT COUNT(*) FROM login_attempts'));
    }

    public function testCronRunnerRunsAllJobsAndSkipsWhenLocked(): void
    {
        $this->boot(['BACKUP_HOUR' => '0']);
        $this->migrate();
        $runner = $this->service(CronRunner::class);
        $result = $runner->run();
        self::assertTrue($result['ok']);
        self::assertNull($result['skipped']);
        self::assertSame(['alerts', 'access', 'backup', 'cleanup'], array_keys($result['jobs']));
        self::assertIsString($result['jobs']['backup']['created']);
        self::assertSame(['at' => self::NOW, 'ok' => true], $runner->last());

        $lock = fopen($this->tmpDir() . '/var/' . CronRunner::LOCK, 'c');
        self::assertNotFalse($lock);
        flock($lock, LOCK_EX);
        try {
            self::assertSame('locked', $runner->run()['skipped']);
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
        self::assertSame(['alerts'], array_keys($runner->run(null, ['alerts'])['jobs']));
    }

    /**
     * Regression: a CLI cron (Hetzner cronjob manager) must not touch the database while a deploy
     * or a restore holds the maintenance flag: opening the old database between "delete -wal/-shm"
     * and "rename the snapshot into place" would recreate a WAL of the OLD database next to the
     * restored file, and var/bootstrap.json (rotateFeedId) would be consumed too early.
     */
    public function testCronSkipsEverythingWhileTheMaintenanceFlagExists(): void
    {
        $this->migrate();
        $root = $this->tmpDir() . '/deploy-root';
        mkdir($root, 0775, true);
        $config = \Omw\Api\Config::fromArray($root, self::testEnv($this->tmpDir()) + ['BACKUP_HOUR' => '0']);
        $runner = new CronRunner(
            $config,
            $this->service(\Omw\Api\Infra\Paths::class),
            $this->service(\Omw\Api\Infra\AutoMigrator::class),
            $this->service(\Omw\Api\Domain\Alerts\AlertEngine::class),
            $this->service(Backups::class),
            $this->service(Maintenance::class),
            $this->service(\Omw\Api\Domain\Settings::class),
            $this->service(\Omw\Api\Domain\Access\AccessJob::class),
        );
        $bootstrap = $this->tmpDir() . '/var/bootstrap.json';
        file_put_contents($bootstrap, '{"version": 1, "rotateFeedId": true}');
        file_put_contents($config->maintenanceFlag(), "restore\n");

        $skipped = $runner->run();
        self::assertSame('maintenance', $skipped['skipped']);
        self::assertSame([], $skipped['jobs']);
        self::assertFileExists($bootstrap, 'not consumed during maintenance');
        self::assertSame([], $this->service(Backups::class)->all());

        unlink($config->maintenanceFlag());
        $ran = $runner->run();
        self::assertNull($ran['skipped']);
        self::assertIsString($ran['jobs']['backup']['created']);
        self::assertFileDoesNotExist($bootstrap, 'consumed once maintenance is over');
    }

    public function testWebCronEndpoint(): void
    {
        // Disabled without CRON_KEY (or with a short one).
        $this->boot();
        self::assertError($this->request('GET', '/api/v1/cron?key=anything'), 404, 'not_found');
        $this->boot(['CRON_KEY' => 'too-short']);
        self::assertError($this->request('GET', '/api/v1/cron?key=too-short'), 404, 'not_found');

        $this->boot(['CRON_KEY' => self::KEY]);
        self::assertError($this->request('GET', '/api/v1/cron'), 403, 'forbidden');
        self::assertError($this->request('GET', '/api/v1/cron?key=' . substr(self::KEY, 0, -1) . 'x'), 403, 'forbidden');
        $viaHeader = $this->request('POST', '/api/v1/cron', null, ['X-Cron-Key' => self::KEY]);
        self::assertSame(200, $viaHeader->getStatusCode(), (string) $viaHeader->getBody());
        $body = self::json($viaHeader);
        self::assertTrue($body['ok']);
        self::assertSame(['alerts', 'access', 'backup', 'cleanup'], array_keys($body['jobs']));
        self::assertSame(200, $this->request('GET', '/api/v1/cron?key=' . self::KEY)->getStatusCode());

        // Cron multiplexers (Enoch's scheduled requests) send only "Authorization: Bearer <key>",
        // GET or an empty form-encoded POST.
        $viaBearer = $this->request('GET', '/api/v1/cron', null, ['Authorization' => 'Bearer ' . self::KEY, 'Accept' => 'application/json']);
        self::assertSame(200, $viaBearer->getStatusCode(), (string) $viaBearer->getBody());
        self::assertTrue(self::json($viaBearer)['ok']);
        $emptyPost = $this->request('POST', '/api/v1/cron', null, ['Authorization' => 'Bearer ' . self::KEY, 'Content-Type' => 'application/x-www-form-urlencoded']);
        self::assertSame(200, $emptyPost->getStatusCode(), (string) $emptyPost->getBody());
        self::assertError($this->request('GET', '/api/v1/cron', null, ['Authorization' => 'Bearer ' . substr(self::KEY, 0, -1) . 'x']), 403, 'forbidden');
        self::assertError($this->request('GET', '/api/v1/cron', null, ['Authorization' => 'Basic ' . base64_encode('x:' . self::KEY)]), 403, 'forbidden');
    }

    public function testTheAccessJobExpiresHandoffMarkersAndDeliversNotices(): void
    {
        $this->bootAccess();
        [, $t, $version] = $this->setUpPerson();
        $join = $this->join($t, $version);
        $did = StoreLayout::parseGateSession((string) $join['session'])['did'] ?? '';
        self::assertTrue($this->storeHas('h/' . $did));
        Clock::advance('+5 minutes');
        $early = $this->service(CronRunner::class)->run(null, ['access']);
        self::assertTrue($early['jobs']['access']['saltRotated']);
        self::assertTrue($this->storeHas('h/' . $did), 'still within 10 minutes');
        Clock::advance('+6 minutes');
        $this->service(\Omw\Api\Domain\Access\OwnerNotices::class)->add('follower_deleted', ['at' => Clock::nowIso()]);
        $result = $this->service(CronRunner::class)->run(null, ['access']);
        self::assertSame(1, $result['jobs']['access']['noticesDelivered']);
        self::assertNotNull($this->appDb()->scalar('SELECT delivered_at FROM owner_notices'));
        self::assertSame(1, $result['jobs']['access']['handoffsExpired']);
        self::assertFalse($this->storeHas('h/' . $did));
        self::assertNull($this->appDb()->scalar('SELECT handoff_at FROM devices WHERE id = ?', [$did]));
        self::assertFalse($result['jobs']['access']['saltRotated'], 'once per UTC day');
        self::assertSame(['skipped' => true], $result['jobs']['access']['probe'], 'ACCESS_GATE_PROBE is off by default');
    }

    public function testGateProbeHourlyAndStoreProofEverySixHours(): void
    {
        $store = $this->storeDir();
        $http = new FakeHttpClient(static function (string $method, string $url, array $headers) use ($store): array {
            // A tiny stand-in for the site host's gate: data paths without a cookie are 403; "/"
            // with a cookie naming an existing session file is 302, anything else the neutral page.
            if (str_contains($url, '/data/')) {
                return ['status' => 403, 'body' => "Forbidden\n"];
            }
            $cookie = $headers['Cookie'] ?? '';
            $value = str_starts_with($cookie, '__Host-omw=') ? substr($cookie, strlen('__Host-omw=')) : '';
            $parts = StoreLayout::parseGateSession($value);
            $ok = $parts !== null && is_file($store . '/' . StoreLayout::session($parts['fid'], $parts['did'], $parts['sid']));

            return $ok ? ['status' => 302, 'body' => ''] : ['status' => 200, 'body' => '<!doctype html>'];
        });
        $this->bootAccess(['ACCESS_GATE_PROBE' => 'true']);
        $container = $this->container();
        \assert($container instanceof \DI\Container);
        $container->set(HttpClient::class, $http);
        $this->initStoreDirect();

        $first = $this->service(CronRunner::class)->run(null, ['access'])['jobs']['access']['probe'];
        self::assertSame(['anonymous' => 'ok', 'storeProof' => 'ok'], $first);
        self::assertCount(3, $http->requests);
        self::assertMatchesRegularExpression('#^https://site\.example/[a-z0-9]{20}/data/x\.json$#', $http->requests[0]['url']);
        self::assertSame([], $http->requests[0]['headers'], 'no cookies on the anonymous probe');
        self::assertSame(self::NOW, $this->appDb()->scalar('SELECT store_proof_at FROM access_state'));
        foreach ($http->requests as $r) {
            self::assertStringNotContainsString('/.', $r['url'], 'never a dot path');
        }

        Clock::advance('+30 minutes');
        self::assertSame([], $this->service(CronRunner::class)->run(null, ['access'])['jobs']['access']['probe']);
        Clock::advance('+31 minutes');
        self::assertSame(['anonymous' => 'ok'], $this->service(CronRunner::class)->run(null, ['access'])['jobs']['access']['probe']);
        self::assertCount(4, $http->requests, 'at most three requests per hour');
        Clock::advance('+5 hours');
        self::assertSame(['anonymous' => 'ok', 'storeProof' => 'ok'], $this->service(CronRunner::class)->run(null, ['access'])['jobs']['access']['probe']);

        // A gate that lets an anonymous request through, and a writer that writes elsewhere.
        $open = new FakeHttpClient(static fn (): array => ['status' => 200, 'body' => '{"days":[]}']);
        $this->bootAccess(['ACCESS_GATE_PROBE' => 'true']);
        $container = $this->container();
        \assert($container instanceof \DI\Container);
        $container->set(HttpClient::class, $open);
        Clock::advance('+7 hours');
        $probe = $this->service(CronRunner::class)->run(null, ['access'])['jobs']['access']['probe'];
        self::assertSame(['anonymous' => 'gate_open', 'storeProof' => 'store_unverified'], $probe);
        $conditions = $this->service(\Omw\Api\Domain\Alerts\AlertEngine::class)->conditions(Clock::now());
        self::assertArrayHasKey('access_store_unverified', $conditions);
        self::assertSame('critical', $conditions['access_store_unverified']['severity']);
    }
}
