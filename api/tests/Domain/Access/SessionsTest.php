<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Domain\Access;

use Omw\Api\Domain\Access\Devices;
use Omw\Api\Domain\Access\Followers;
use Omw\Api\Domain\Access\Sessions;
use Omw\Api\Domain\Access\StoreApplier;
use Omw\Api\Domain\Access\Tokens;
use Omw\Api\Http\ApiException;
use Omw\Api\Infra\Clock;
use Omw\Api\Tests\Http\AccessTestCase;

/**
 * Domain\Access\Sessions (spec-wave5 §3.3 Sessions): issue ops (delete_prefix, exclusive put, the
 * handoff marker; none in F2 and for the service session), redaction once applied, 6 issues per
 * device per hour, the 30-minute pending sid, one-time marker clearing (hello) and the cron TTL.
 */
final class SessionsTest extends AccessTestCase
{
    public function testIssueOpsRedactionAndTheHourlyCap(): void
    {
        $this->bootAccess();
        $this->initStoreDirect();
        $fid = $this->service(Followers::class)->create('Oma', null)['fid'];
        $d = $this->service(Devices::class)->create($fid, 'x', true);
        $sessions = $this->service(Sessions::class);
        $db = $this->appDb();
        $before = (int) $db->scalar('SELECT MAX(id) FROM store_ops');
        $issued = $sessions->issue($fid, $d['did']);
        $ops = $db->all('SELECT op, path, exclusive FROM store_ops WHERE id > ? ORDER BY id', [$before]);
        self::assertSame([
            ['op' => 'delete_prefix', 'path' => "s/$fid/{$d['did']}.", 'exclusive' => 1],
            ['op' => 'put', 'path' => "s/$fid/{$d['did']}.{$issued['sid']}", 'exclusive' => 1],
            ['op' => 'put', 'path' => "h/{$d['did']}", 'exclusive' => 1],
        ], $ops);
        $row = $db->one('SELECT * FROM devices WHERE id = ?', [$d['did']]);
        self::assertNotNull($row);
        self::assertSame([Tokens::hash($issued['sid']), $issued['sid'], self::NOW, self::NOW], [$row['session_hash'], $row['pending_sid'], $row['session_at'], $row['handoff_at']]);

        $this->service(StoreApplier::class)->applyNow(8.0);
        self::assertSame("s/$fid/{$d['did']}.<redacted>", $db->scalar('SELECT path FROM store_ops WHERE id = ?', [$issued['maxOp'] - 1]));
        self::assertStringNotContainsString($issued['sid'], json_encode($db->all('SELECT * FROM store_ops'), JSON_THROW_ON_ERROR));

        for ($i = 0; $i < 5; ++$i) {
            $sessions->issue($fid, $d['did']);
        }
        try {
            $sessions->issue($fid, $d['did']);
            self::fail('seventh issue within an hour');
        } catch (ApiException $e) {
            self::assertSame(429, $e->status);
        }
        $sessions->issue($fid, $d['did'], true); // the service session is not limited
    }

    public function testParentModeAndServiceSessionsHaveNoHandoffMarker(): void
    {
        $this->bootAccess(['SITE_ORIGIN' => 'https://www.example.org', 'ACCESS_COOKIE_MODE' => 'parent', 'ACCESS_COOKIE_DOMAIN' => 'example.org']);
        $this->migrate();
        $fid = $this->service(Followers::class)->create('Oma', null)['fid'];
        $d = $this->service(Devices::class)->create($fid, 'x', true);
        $this->service(Sessions::class)->issue($fid, $d['did']);
        self::assertSame(0, (int) $this->appDb()->scalar("SELECT COUNT(*) FROM store_ops WHERE path LIKE 'h/%'"));
        self::assertNull($this->appDb()->scalar('SELECT handoff_at FROM devices WHERE id = ?', [$d['did']]));
        $cookies = $this->service(Sessions::class)->parentCookies($fid, $d['did'], str_repeat('s', 43), str_repeat('k', 43));
        self::assertStringStartsWith("omw=$fid.{$d['did']}." . str_repeat('s', 43) . '; Domain=example.org; Path=/; Max-Age=34560000; Secure; HttpOnly; SameSite=Lax', $cookies[0]);
    }

    public function testAPendingSidExpiresAfterThirtyMinutesAndHandoffsAfterTen(): void
    {
        $this->bootAccess();
        [$fid, $t, $version] = $this->setUpPerson();
        $lock = fopen($this->tmpDir() . '/var/cache/store.lock', 'c');
        self::assertNotFalse($lock);
        flock($lock, LOCK_EX);
        $join = $this->join($t, $version);
        flock($lock, LOCK_UN);
        fclose($lock);
        self::assertSame('activating', $join['status']);
        $db = $this->appDb();
        $first = (string) $db->scalar('SELECT pending_sid FROM devices WHERE follower_id = ?', [$fid]);
        Clock::advance('+31 minutes');
        $poll = $this->call('device/poll', (string) $join['deviceKey']);
        self::assertSame('active', $poll['status']);
        self::assertStringNotContainsString($first, (string) $poll['session'], 'a stale pending sid is discarded and issued again');

        $did = (string) $db->scalar('SELECT id FROM devices WHERE follower_id = ?', [$fid]);
        self::assertTrue($this->storeHas("h/$did"));
        $sessions = $this->service(Sessions::class);
        Clock::advance('+9 minutes');
        self::assertSame(0, $sessions->expireHandoffs());
        Clock::advance('+2 minutes');
        self::assertSame(1, $sessions->expireHandoffs());
        self::assertSame(0, $sessions->clearHandoff($did), 'nothing left to clear');
    }
}
