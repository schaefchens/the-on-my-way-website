<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Http;

use Omw\Api\Domain\Access\StoreLayout;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\CronRunner;

/**
 * Privacy of the logs (spec-wave5 §8.3 LogPrivacyTest): join, hello, data, export, delete,
 * revoke, a failing store writer and cron run with LOG_LEVEL=debug, and no log record contains a
 * follower name, a link secret, a device key or a session id.
 */
final class LogPrivacyTest extends AccessTestCase
{
    public function testNoNamesOrSecretsInTheLogs(): void
    {
        $this->bootAccess(['LOG_LEVEL' => 'debug']);
        [$fidA, $tA, $version] = $this->setUpPerson('Oma Erna Zauberhaft');
        [$fidB, $tB] = $this->invite('Opa Hans Wunderlich');
        $secrets = ['Oma Erna Zauberhaft', 'Opa Hans Wunderlich', 'Zauberhaft', 'Wunderlich', $tA, $tB];

        $a = $this->join($tA, $version);
        $kA = (string) $a['deviceKey'];
        $secrets[] = $kA;
        $secrets[] = StoreLayout::parseGateSession((string) $a['session'])['sid'] ?? '';
        $this->call('me/hello', $kA);
        $this->call('me/data', $kA);
        $this->pub('me/export', ['k' => $kA]);

        $b = $this->join($tB, $version);
        $kB = (string) $b['deviceKey'];
        $secrets[] = $kB;
        $secrets[] = StoreLayout::parseGateSession((string) $b['session'])['sid'] ?? '';
        $pending = $this->join($tB, $version);
        $secrets[] = (string) $pending['deviceKey'];

        // A store that refuses writes: the applier logs the failure (paths redacted).
        Clock::advance('+1 minute');
        rename($this->storeDir() . '/h', $this->storeDir() . '/h-moved');
        file_put_contents($this->storeDir() . '/h', 'not a directory');
        $resumed = self::json($this->pub('join', ['resume' => true, 'k' => $kA, 'locale' => 'de']));
        self::assertSame('activating', $resumed['status']);
        $sid = (string) $this->appDb()->scalar('SELECT pending_sid FROM devices WHERE follower_id = ? AND pending_sid IS NOT NULL', [$fidA]);
        self::assertNotSame('', $sid);
        $secrets[] = $sid;
        $this->service(CronRunner::class)->run(null, ['access']);
        unlink($this->storeDir() . '/h');
        rename($this->storeDir() . '/h-moved', $this->storeDir() . '/h');
        Clock::advance('+2 minutes');
        $this->service(CronRunner::class)->run(null, ['access']);

        self::assertSame('deleted', self::json($this->pub('me/delete', ['k' => $kA, 'confirm' => 'delete-all-my-data']))['status']);
        $this->admin('POST', "/api/v1/admin/followers/$fidB/revoke", new \stdClass());
        $this->service(CronRunner::class)->run();

        $logs = '';
        foreach (glob($this->tmpDir() . '/var/logs/*.log') ?: [] as $file) {
            $logs .= (string) file_get_contents($file);
        }
        self::assertNotSame('', $logs, 'debug logging is on');
        self::assertStringContainsString('Store op', $logs, 'the failing writer was logged');
        foreach (array_filter($secrets) as $secret) {
            self::assertStringNotContainsString($secret, $logs, 'secret or name in the logs');
        }
    }
}
