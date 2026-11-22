<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Infra;

use Omw\Api\Domain\Access\StoreApplier;
use Omw\Api\Tests\Http\AccessTestCase;
use RuntimeException;

/**
 * Concurrency of the store applier (spec-wave5 §3.8.3, §8.3): `php -S` with 4 workers and a slow
 * writer (2 s per op), 5 parallel first-device joins. None waits for the store lock (all but the
 * lock holder answer "activating" within about a second), the holder drains ops the others
 * enqueued meanwhile, and every op is applied exactly once, in id order.
 */
final class StoreApplierConcurrencyTest extends AccessTestCase
{
    private const SLOW_MS = 2000;

    /** @var list<resource> */
    private array $procs = [];

    protected function tearDown(): void
    {
        foreach ($this->procs as $proc) {
            // PHP_CLI_SERVER_WORKERS forks workers: stop them with their master.
            $pid = proc_get_status($proc)['pid'];
            if ($pid > 0) {
                exec('pkill -TERM -P ' . $pid);
            }
            proc_terminate($proc);
            proc_close($proc);
        }
        $this->procs = [];
        parent::tearDown();
    }

    public function testParallelJoinsNeverWaitForTheStoreLock(): void
    {
        if (!function_exists('curl_multi_init')) {
            self::markTestSkipped('curl is needed for parallel requests');
        }
        $this->bootAccess();
        $this->initStoreDirect();
        $version = $this->publishNoticeDirect();
        $followers = $this->service(\Omw\Api\Domain\Access\Followers::class);
        $links = [];
        for ($i = 0; $i < 5; ++$i) {
            $created = $followers->create('Person ' . $i, null);
            $links[] = substr($created['link']['url'], strlen(self::SITE . '/_/join/#t='));
        }
        $this->appDb()->close();

        $log = $this->tmpDir() . '/ops.log';
        $port = $this->serve($log);
        $mh = curl_multi_init();
        $handles = [];
        foreach ($links as $t) {
            $ch = curl_init("http://127.0.0.1:$port/api/v1/public/join");
            \assert($ch !== false);
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => json_encode(['t' => $t, 'consentVersion' => $version, 'locale' => 'de'], JSON_THROW_ON_ERROR),
                CURLOPT_HTTPHEADER => ['Content-Type: text/plain;charset=UTF-8', 'Origin: ' . self::SITE],
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT => 60,
            ]);
            curl_multi_add_handle($mh, $ch);
            $handles[] = $ch;
        }
        do {
            $status = curl_multi_exec($mh, $running);
            if ($running > 0) {
                curl_multi_select($mh, 0.2);
            }
        } while ($running > 0 && $status === CURLM_OK);

        $fast = 0;
        $statuses = [];
        foreach ($handles as $ch) {
            $body = (string) curl_multi_getcontent($ch);
            self::assertSame(200, curl_getinfo($ch, CURLINFO_RESPONSE_CODE), $body . (string) @file_get_contents($this->tmpDir() . '/server.log'));
            $answer = json_decode($body, true, 16, JSON_THROW_ON_ERROR);
            \assert(is_array($answer));
            $statuses[] = $answer['status'];
            $seconds = (float) curl_getinfo($ch, CURLINFO_TOTAL_TIME);
            if ($seconds < 1.8) {
                ++$fast;
                self::assertSame('activating', $answer['status'], 'a request that did not get the lock answers at once');
            }
            curl_multi_remove_handle($mh, $ch);
        }
        curl_multi_close($mh);
        self::assertGreaterThanOrEqual(4, $fast, 'only the lock holder spends time on the store: ' . json_encode($statuses));

        // The holder applied ops (its own and ones enqueued by the others) until its 8 s deadline.
        $lines = array_values(array_filter(explode("\n", (string) @file_get_contents($log))));
        self::assertGreaterThanOrEqual(3, count($lines));
        self::assertLessThanOrEqual(5, count($lines));
        self::assertCount(1, array_unique(array_map(static fn (string $l): string => explode(' ', $l)[0], $lines)), 'one process (the lock holder) applied them');

        // Finish the queue and compare: every op once, in id order.
        $this->bootAccess();
        $this->service(StoreApplier::class)->applyNow(20.0);
        $db = $this->appDb();
        self::assertSame(0, (int) $db->scalar('SELECT COUNT(*) FROM store_ops WHERE applied_at IS NULL'));
        $byId = array_map(
            static fn (array $r): string => $r['op'] . ' ' . $r['path'],
            $db->all("SELECT op, path FROM store_ops WHERE op <> 'init' ORDER BY id"),
        );
        self::assertCount(15, $byId, '5 joins × (delete_prefix, put session, put handoff)');
        $applied = array_map(static fn (string $l): string => substr($l, strpos($l, ' ') + 1), $lines);
        foreach ($applied as $i => $line) {
            self::assertSame($byId[$i], $line, "op #$i applied in id order");
        }
        self::assertSame(count($applied), count(array_unique($applied)), 'no op applied twice');
    }

    private function serve(string $log): int
    {
        $probe = stream_socket_server('tcp://127.0.0.1:0');
        if ($probe === false) {
            throw new RuntimeException('no free port');
        }
        $port = (int) explode(':', (string) stream_socket_get_name($probe, false))[1];
        fclose($probe);
        $env = array_merge(getenv(), self::testEnv($this->tmpDir()), [
            'BASE_PATH' => '',
            'SITE_ORIGIN' => self::SITE,
            'ACCESS_STORE_MODE' => 'direct',
            'ACCESS_STORE_DIR' => $this->storeDir(),
            'PHP_CLI_SERVER_WORKERS' => '4',
            'OMW_TEST_SLOW_MS' => (string) self::SLOW_MS,
            'OMW_TEST_OP_LOG' => $log,
        ]);
        $docroot = $this->tmpDir() . '/docroot';
        @mkdir($docroot);
        $cmd = [PHP_BINARY, '-S', "127.0.0.1:$port", '-t', $docroot, self::rootDir() . '/tests/Support/concurrency-router.php'];
        $proc = proc_open($cmd, [0 => ['file', '/dev/null', 'r'], 1 => ['file', '/dev/null', 'w'], 2 => ['file', $this->tmpDir() . '/server.log', 'w']], $pipes, self::rootDir(), $env);
        if (!is_resource($proc)) {
            throw new RuntimeException('cannot start php -S');
        }
        $this->procs[] = $proc;
        for ($i = 0; $i < 100; ++$i) {
            $socket = @stream_socket_client("tcp://127.0.0.1:$port", $errno, $errstr, 0.2);
            if ($socket !== false) {
                fclose($socket);

                return $port;
            }
            usleep(50_000);
        }
        throw new RuntimeException("php -S did not come up on $port");
    }
}
