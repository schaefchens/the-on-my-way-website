<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Domain\Access;

use Omw\Api\Domain\Access\Devices;
use Omw\Api\Domain\Access\Followers;
use Omw\Api\Http\ApiException;
use Omw\Api\Infra\Clock;
use Omw\Api\Tests\Http\AccessTestCase;

/**
 * Domain\Access\Devices (spec-wave5 §3.3 Devices): the first-device rule (a revoked device still
 * counts as "had one"), approve / decline, the active-device cap, revoke ops, pending expiry.
 */
final class DevicesTest extends AccessTestCase
{
    public function testFirstDeviceRuleAndCap(): void
    {
        $this->bootAccess(['ACCESS_MAX_DEVICES' => '1']);
        $this->migrate();
        $fid = $this->service(Followers::class)->create('Oma', null)['fid'];
        $devices = $this->service(Devices::class);
        self::assertFalse($devices->mustWait($fid));
        $first = $devices->create($fid, 'iPhone · Safari', true);
        self::assertTrue($devices->mustWait($fid));
        $devices->revoke($first['did'], 'owner');
        self::assertTrue($devices->mustWait($fid), 'a revoked device still counts: a new one waits');

        $second = $devices->create($fid, 'Android · Chrome', false);
        self::assertSame('pending', $devices->byKey($second['key'])['state'] ?? null);
        self::assertSame(1, $devices->pendingCount($fid));
        $devices->approve($second['did']);
        $devices->approve($second['did']); // idempotent
        $third = $devices->create($fid, 'Mac · Safari', false);
        try {
            $devices->approve($third['did']);
            self::fail('cap ignored');
        } catch (ApiException $e) {
            self::assertSame('device_limit', $e->errorCode);
            self::assertSame(409, $e->status);
        }
        $devices->decline($third['did']);
        self::assertSame('declined', $devices->byId($third['did'])['state'] ?? null);
        $this->expectException(ApiException::class);
        $devices->approve($third['did']);
    }

    public function testRevokeOpsAndPendingExpiry(): void
    {
        $this->bootAccess();
        $this->migrate();
        $fid = $this->service(Followers::class)->create('Oma', null)['fid'];
        $devices = $this->service(Devices::class);
        $d = $devices->create($fid, 'x', true);
        $devices->revoke($d['did'], 'follower');
        $ops = $this->appDb()->all('SELECT op, path FROM store_ops ORDER BY id');
        self::assertSame([
            ['op' => 'put', 'path' => "t/$fid.{$d['did']}"],
            ['op' => 'delete_prefix', 'path' => "s/$fid/{$d['did']}."],
            ['op' => 'delete', 'path' => "h/{$d['did']}"],
        ], $ops);
        self::assertSame(0, $devices->revoke($d['did'], 'owner'), 'already revoked');

        $p = $devices->create($fid, 'y', false);
        Clock::advance('+13 days');
        self::assertSame(0, $devices->expirePending());
        Clock::advance('+2 days');
        self::assertSame(1, $devices->expirePending());
        $row = $devices->byId($p['did']);
        self::assertNotNull($row);
        self::assertSame(['declined', null], [$row['state'], $row['revoked_by']]);
    }
}
