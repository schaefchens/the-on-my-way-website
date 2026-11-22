<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Http;

use Omw\Api\Domain\Access\StoreApplier;
use Omw\Api\Infra\Clock;

/**
 * The site's access as a whole (spec-wave5 §3.5): lock / unlock with the password (counted like
 * a login, unlocked_at), retry, store-init (once, never overwriting the marker), the access status
 * and the counts-only summary in /admin/status, owner notices.
 */
final class AdminAccessTest extends AccessTestCase
{
    public function testStoreInitWritesTheMarkerOnce(): void
    {
        $this->bootAccess();
        $status = self::json($this->admin('GET', '/api/v1/admin/access'));
        self::assertNull($status['storeId']);
        self::assertSame('direct', $status['writer']['mode']);
        self::assertSame(self::SITE, $status['siteOrigin']);
        self::assertSame('headers', $status['cookieMode']);

        $init = self::json($this->admin('POST', '/api/v1/admin/access/store-init', new \stdClass()));
        self::assertTrue($init['effect']['applied']);
        $marker = StoreApplier::parseMarker($this->storeRead('.omw-store.json'));
        self::assertNotNull($marker);
        $storeId = $marker['storeId'];
        self::assertSame("Require all denied\nOptions -Indexes\n", $this->storeRead('.htaccess'));
        self::assertSame($storeId, self::json($this->admin('GET', '/api/v1/admin/access'))['storeId']);

        // Again: the same store id, the marker stays.
        $this->admin('POST', '/api/v1/admin/access/store-init', new \stdClass());
        self::assertSame($storeId, StoreApplier::parseMarker($this->storeRead('.omw-store.json'))['storeId'] ?? null);

        // The store is wiped (a webspace restore from before the store existed): writers stop
        // until the owner initialises again; then the same store id comes back.
        @unlink($this->storeDir() . '/.omw-store.json');
        $this->admin('POST', '/api/v1/admin/access/lock', ['locked' => true]);
        self::assertFalse($this->storeHas('locked'));
        $status = self::json($this->admin('GET', '/api/v1/admin/access'));
        self::assertSame(1, $status['pendingOps']);
        self::assertStringStartsWith('store_unverified', (string) $status['writer']['error']);
        $this->admin('POST', '/api/v1/admin/access/store-init', new \stdClass());
        self::assertTrue($this->storeHas('locked'));
        self::assertSame($storeId, StoreApplier::parseMarker($this->storeRead('.omw-store.json'))['storeId'] ?? null);
    }

    public function testLockAndUnlockWithThePassword(): void
    {
        $this->bootAccess();
        $this->initStore();
        $lock = self::json($this->admin('POST', '/api/v1/admin/access/lock', ['locked' => true]));
        self::assertTrue($lock['effect']['applied']);
        self::assertTrue($lock['status']['locked']);
        self::assertSame('admin', $lock['status']['lockedBy']);
        $file = json_decode((string) $this->storeRead('locked'), true);
        self::assertSame(['at' => self::NOW, 'by' => 'admin'], $file);
        self::assertSame(200, $this->admin('POST', '/api/v1/admin/access/lock', ['locked' => true])->getStatusCode(), 'idempotent');

        self::assertError($this->admin('POST', '/api/v1/admin/access/lock', ['locked' => false]), 422, 'validation_failed');
        self::assertError($this->admin('POST', '/api/v1/admin/access/lock', ['locked' => false, 'password' => 'wrong password!!']), 403, 'forbidden');
        self::assertTrue($this->storeHas('locked'));
        self::assertSame(1, (int) $this->appDb()->scalar('SELECT COUNT(*) FROM login_attempts WHERE success = 0'), 'counted like a login');

        Clock::advance('+1 minute');
        $unlock = self::json($this->admin('POST', '/api/v1/admin/access/lock', ['locked' => false, 'password' => self::ADMIN_PASSWORD]));
        self::assertFalse($unlock['status']['locked']);
        self::assertFalse($this->storeHas('locked'));
        self::assertSame(Clock::nowIso(), $this->appDb()->scalar('SELECT unlocked_at FROM access_state'));
    }

    public function testUnlockAttemptsAreRateLimited(): void
    {
        $this->bootAccess();
        $this->initStore();
        $this->admin('POST', '/api/v1/admin/access/lock', ['locked' => true]);
        Clock::advance('+1 second'); // failures after the login's own success
        for ($i = 0; $i < \Omw\Api\Domain\Auth\LoginThrottle::MAX_PER_IP; ++$i) {
            $this->admin('POST', '/api/v1/admin/access/lock', ['locked' => false, 'password' => 'wrong password!!']);
        }
        self::assertError($this->admin('POST', '/api/v1/admin/access/lock', ['locked' => false, 'password' => self::ADMIN_PASSWORD]), 429, 'rate_limited');
        self::assertTrue($this->storeHas('locked'));
    }

    public function testRetryClearsTheBlockAndStatusFeedsHome(): void
    {
        $this->bootAccess();
        $this->initStore();
        $this->appDb()->exec("UPDATE access_state SET writer_blocked_at = ?, writer_error = 'auth: The SFTP login was refused'", [self::NOW]);
        $this->admin('POST', '/api/v1/admin/access/lock', ['locked' => true]);
        self::assertFalse($this->storeHas('locked'), 'blocked: nothing is written');
        $status = self::json($this->admin('GET', '/api/v1/admin/status'));
        self::assertTrue($status['access']['writer']['blocked']);
        self::assertSame(1, $status['access']['pendingOps']);
        self::assertArrayNotHasKey('pending', $status['access'], 'no names in the persisted summary');

        $retry = self::json($this->admin('POST', '/api/v1/admin/access/retry', new \stdClass()));
        self::assertFalse($retry['writer']['blocked']);
        self::assertSame(0, $retry['pendingOps']);
        self::assertTrue($this->storeHas('locked'));
        self::assertNotNull($retry['lastReconcile'], 'retry also reconciles');
    }

    public function testMacModeReportsPendingEffects(): void
    {
        $this->boot(['SITE_ORIGIN' => self::SITE]);
        $this->admin('POST', '/api/v1/admin/access/store-init', new \stdClass());
        $lock = self::json($this->admin('POST', '/api/v1/admin/access/lock', ['locked' => true]));
        self::assertSame(['applied' => false, 'via' => 'mac', 'pendingOps' => 2], $lock['effect']);
    }

    public function testOwnerNotices(): void
    {
        $this->bootAccess();
        $this->migrate();
        $notices = $this->service(\Omw\Api\Domain\Access\OwnerNotices::class);
        $a = $notices->add('follower_deleted', ['at' => self::NOW]);
        $notices->add('restore_reconciled', ['devices' => 1, 'people' => [], 'tombstoned' => 0]);
        $list = self::json($this->admin('GET', '/api/v1/admin/notices'));
        self::assertSame(['restore_reconciled', 'follower_deleted'], array_column($list['items'], 'kind'));
        self::assertSame(2, self::json($this->admin('GET', '/api/v1/admin/status'))['access']['unreadNotices']);
        self::assertSame(204, $this->admin('POST', '/api/v1/admin/notices/read', ['ids' => [$a]])->getStatusCode());
        self::assertSame(1, self::json($this->admin('GET', '/api/v1/admin/status'))['access']['unreadNotices']);
        self::assertError($this->admin('POST', '/api/v1/admin/notices/read', ['ids' => []]), 422, 'validation_failed');
    }
}
