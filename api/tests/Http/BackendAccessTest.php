<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Http;

use Omw\Api\Domain\Access\StoreLayout;
use Omw\Api\Domain\Access\StoreOps;
use Omw\Api\Domain\Alerts\AlertEngine;
use Omw\Api\Infra\Clock;

/**
 * The Mac as fallback writer and the backend's access reports (spec-wave5 §3.6): claim with the
 * store id and at most 200 ops, renew, a lost lease → 409 on ack, listing (reconcile on the Mac's
 * listing), service-session incl. rotate=1, changes.access.needsWriter, heartbeat site (storeDir
 * and origin mismatch alerts), publish report gateCheck (stored and alerted).
 */
final class BackendAccessTest extends AccessTestCase
{
    private function macMode(): void
    {
        $this->boot(['SITE_ORIGIN' => self::SITE]); // ACCESS_STORE_MODE=none: the Mac writes
        $this->migrate();
    }

    public function testClaimRenewAndAck(): void
    {
        $this->macMode();
        $init = self::json($this->admin('POST', '/api/v1/admin/access/store-init', new \stdClass()));
        self::assertSame(['applied' => false, 'via' => 'mac', 'pendingOps' => 1], $init['effect']);
        $this->admin('POST', '/api/v1/admin/access/lock', ['locked' => true]);

        $changes = self::json($this->backend('GET', '/api/v1/backend/changes'));
        self::assertSame(['needsWriter' => true], $changes['access']);

        $claim = self::json($this->backend('POST', '/api/v1/backend/access/claim', ['holder' => 'mac']));
        self::assertNotNull($claim['lease']);
        self::assertSame(Clock::iso(Clock::now()->modify('+60 seconds')), $claim['lease']['until']);
        $storeId = (string) $this->appDb()->scalar('SELECT store_id FROM access_state');
        self::assertSame($storeId, $claim['storeId']);
        self::assertSame(['init', 'put'], array_column($claim['ops'], 'op'));
        self::assertSame([StoreLayout::MARKER, StoreLayout::LOCKED], array_column($claim['ops'], 'path'));
        $epoch = (string) $claim['epoch'];

        // ACCESS_STORE_MODE=none: the API never writes (StoreApplierTest covers the lease against an API writer).
        self::assertSame('none', $this->service(\Omw\Api\Domain\Access\StoreApplier::class)->applyNow(8.0)['reason']);

        Clock::advance('+50 seconds');
        $renew = self::json($this->backend('POST', '/api/v1/backend/access/renew', ['epoch' => $epoch]));
        self::assertSame(Clock::iso(Clock::now()->modify('+60 seconds')), $renew['lease']['until']);
        self::assertSame(['lease' => null], self::json($this->backend('POST', '/api/v1/backend/access/renew', ['epoch' => str_repeat('0', 16)])));

        $last = (int) $claim['ops'][1]['id'];
        self::assertSame(204, $this->backend('POST', '/api/v1/backend/access/ack', ['epoch' => $epoch, 'appliedThrough' => $last])->getStatusCode());
        $db = $this->appDb();
        self::assertSame(0, (int) $db->scalar('SELECT COUNT(*) FROM store_ops WHERE applied_at IS NULL'));
        self::assertSame('mac', $db->scalar('SELECT applied_by FROM store_ops WHERE id = ?', [$last]));
        self::assertNull($db->scalar('SELECT lease_holder FROM access_state'), 'released');
        $lock = self::json($this->admin('POST', '/api/v1/admin/access/lock', ['locked' => true]));
        self::assertSame(['applied' => true, 'via' => 'mac', 'pendingOps' => 0], $lock['effect'], 'already in effect');
    }

    public function testALostLeaseMakesTheAckConflict(): void
    {
        $this->macMode();
        $this->admin('POST', '/api/v1/admin/access/store-init', new \stdClass());
        $claim = self::json($this->backend('POST', '/api/v1/backend/access/claim', ['holder' => 'mac']));
        Clock::advance('+61 seconds');
        self::assertError($this->backend('POST', '/api/v1/backend/access/ack', ['epoch' => $claim['epoch'], 'appliedThrough' => 1]), 409, 'conflict');
        self::assertSame(1, (int) $this->appDb()->scalar('SELECT COUNT(*) FROM store_ops WHERE applied_at IS NULL'), 'the API re-applies from its own state');

        // A claim while the API holds an unexpired lease gets none.
        $this->appDb()->exec("UPDATE access_state SET lease_holder = 'api', lease_until = ?", [Clock::iso(Clock::now()->modify('+30 seconds'))]);
        $none = self::json($this->backend('POST', '/api/v1/backend/access/claim', ['holder' => 'mac']));
        self::assertNull($none['lease']);
        self::assertSame([], $none['ops']);
    }

    public function testAtMost200OpsPerClaim(): void
    {
        $this->macMode();
        $db = $this->appDb();
        $ops = $this->service(StoreOps::class);
        $db->write(function () use ($ops): void {
            for ($i = 0; $i < 210; ++$i) {
                $ops->enqueue('delete', StoreLayout::handoff(\Omw\Api\Domain\Access\Tokens::deviceId()));
            }
        });
        $claim = self::json($this->backend('POST', '/api/v1/backend/access/claim', ['holder' => 'mac']));
        self::assertCount(200, $claim['ops']);
    }

    public function testStoreMismatchFromTheMacRaisesTheAlert(): void
    {
        $this->macMode();
        $this->admin('POST', '/api/v1/admin/access/store-init', new \stdClass());
        $claim = self::json($this->backend('POST', '/api/v1/backend/access/claim', ['holder' => 'mac']));
        $first = (int) $claim['ops'][0]['id'];
        $res = $this->backend('POST', '/api/v1/backend/access/ack', ['epoch' => $claim['epoch'], 'appliedThrough' => 0, 'failed' => ['opId' => $first, 'error' => 'store_mismatch']]);
        self::assertSame(204, $res->getStatusCode(), (string) $res->getBody());
        self::assertTrue($this->service(\Omw\Api\Domain\Access\AccessState::class)->storeUnverified());
        self::assertArrayHasKey('access_store_unverified', $this->service(AlertEngine::class)->conditions(Clock::now()));
        self::assertSame(['store_mismatch'], array_column(self::json($this->admin('GET', '/api/v1/admin/notices'))['items'], 'kind'));
    }

    public function testListingRunsTheReconcileAndReturnsTheFixes(): void
    {
        $this->macMode();
        $this->admin('POST', '/api/v1/admin/access/store-init', new \stdClass());
        $claim = self::json($this->backend('POST', '/api/v1/backend/access/claim', ['holder' => 'mac']));
        // The init op comes first: no listing of a store that has no marker yet.
        self::assertSame(['init'], array_column($claim['ops'], 'op'));
        self::assertFalse($claim['listingWanted']);
        $epoch = (string) $claim['epoch'];
        $this->backend('POST', '/api/v1/backend/access/ack', ['epoch' => $epoch, 'appliedThrough' => (int) $claim['ops'][0]['id']]);

        $claim = self::json($this->backend('POST', '/api/v1/backend/access/claim', ['holder' => 'mac']));
        self::assertTrue($claim['listingWanted'], 'the reconcile is due once the store is initialised');
        $stray = 's/aaaaaaaaaaaa/bbbbbbbb.' . str_repeat('A', 43);
        $res = $this->backend('POST', '/api/v1/backend/access/listing', ['epoch' => $epoch, 'listing' => [
            'marker' => null, 'locked' => null, 'sessions' => [$stray], 'handoffs' => ['cccccccc'], 'tombstones' => [], 'strays' => ['s/junk'],
        ]]);
        self::assertSame(200, $res->getStatusCode(), (string) $res->getBody());
        $fixes = self::json($res);
        self::assertSame(['delete', 'delete', 'delete_tree'], array_column($fixes['ops'], 'op'));
        self::assertSame([$stray, 'h/cccccccc', 's/junk'], array_column($fixes['ops'], 'path'));
        self::assertNotNull($fixes['lease']);
        $report = self::json($this->admin('GET', '/api/v1/admin/access'))['lastReconcile'];
        self::assertSame('normal', $report['mode']);
        self::assertSame(3, $report['deleted']);

        self::assertError($this->backend('POST', '/api/v1/backend/access/listing', ['epoch' => $epoch, 'listing' => [
            'marker' => null, 'locked' => null, 'sessions' => ['s/../etc'], 'handoffs' => [], 'tombstones' => [], 'strays' => [],
        ]]), 422, 'validation_failed');
    }

    public function testServiceSession(): void
    {
        $this->bootAccess();
        $this->migrate();
        $this->initStoreDirect();
        $res = $this->backend('GET', '/api/v1/backend/access/service-session');
        self::assertSame(200, $res->getStatusCode(), (string) $res->getBody());
        $a = self::json($res);
        self::assertSame('__Host-omw', $a['cookieName']);
        self::assertSame(Clock::iso(Clock::now()->modify('+24 hours')), $a['expiresAt']);
        self::assertTrue($this->storeHas(self::sessionPath((string) $a['cookieValue'])));
        $parts = StoreLayout::parseGateSession((string) $a['cookieValue']);
        self::assertNotNull($parts);
        self::assertFalse($this->storeHas('h/' . $parts['did']), 'no handoff marker for the service session');

        $b = self::json($this->backend('GET', '/api/v1/backend/access/service-session?rotate=1'));
        self::assertNotSame($a['cookieValue'], $b['cookieValue']);
        self::assertFalse($this->storeHas(self::sessionPath((string) $a['cookieValue'])), 'rotated');
        self::assertTrue($this->storeHas(self::sessionPath((string) $b['cookieValue'])));
        $db = $this->appDb();
        self::assertNull($db->scalar('SELECT pending_sid FROM devices WHERE id = ?', [$parts['did']]), 'the API keeps no delivered sid');
        self::assertSame([], self::json($this->admin('GET', '/api/v1/admin/followers'))['items'], 'never listed');

        // The Mac writes: 503 busy until the ops are applied.
        $this->boot(['SITE_ORIGIN' => 'http://127.0.0.1:4173']);
        $busy = $this->backend('GET', '/api/v1/backend/access/service-session');
        self::assertError($busy, 503, 'busy');
        $again = $this->backend('GET', '/api/v1/backend/access/service-session');
        self::assertError($again, 503, 'busy');
        self::assertSame(1, (int) $this->appDb()->scalar("SELECT COUNT(*) FROM store_ops WHERE applied_at IS NULL AND op = 'put' AND path LIKE 's/%'"), 'a waiting issue is not repeated');
    }

    public function testHeartbeatSiteAndGateCheckReports(): void
    {
        $this->bootAccess();
        $this->migrate();
        $hb = BackendApiTest::heartbeat();
        $hb['site'] = ['origin' => 'https://other.example', 'access' => 'gate', 'cookieMode' => 'headers', 'storeDir' => '/elsewhere/store'];
        self::assertSame(204, $this->backend('POST', '/api/v1/backend/heartbeat', $hb)->getStatusCode());
        $conditions = $this->service(AlertEngine::class)->conditions(Clock::now());
        self::assertArrayHasKey('site_origin_mismatch', $conditions);
        self::assertArrayHasKey('access_store_unverified', $conditions);
        self::assertStringContainsString('store folder differs', $conditions['access_store_unverified']['message']);

        $report = ['contractVersion' => 1, 'version' => 7, 'at' => '2026-11-20T09:59:00Z', 'target' => 'sftp-main', 'ok' => true,
            'uploaded' => 12, 'deleted' => 1, 'feedSeq' => 10, 'capturesThrough' => '2026-11-20T09:00:00Z',
            'gateCheck' => ['at' => '2026-11-20T09:59:30Z', 'by' => 'mac', 'result' => 'gate_open', 'detail' => 'GET /x/data/a.json answered 200']];
        self::assertSame(204, $this->backend('POST', '/api/v1/backend/published', $report)->getStatusCode());
        $status = self::json($this->admin('GET', '/api/v1/admin/access'));
        self::assertSame('gate_open', $status['gateCheck']['result']);
        $conditions = $this->service(AlertEngine::class)->conditions(Clock::now());
        self::assertSame('critical', $conditions['publish_failing']['severity']);

        $report['gateCheck'] = ['at' => '2026-11-20T09:59:40Z', 'by' => 'mac', 'result' => 'ok', 'detail' => null];
        $report['at'] = '2026-11-20T09:59:40Z';
        $this->backend('POST', '/api/v1/backend/published', $report);
        self::assertArrayNotHasKey('publish_failing', $this->service(AlertEngine::class)->conditions(Clock::now()));
    }
}
