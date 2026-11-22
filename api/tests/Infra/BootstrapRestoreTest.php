<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Infra;

use Omw\Api\Domain\Access\StoreLayout;
use Omw\Api\Infra\Backups;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\CronRunner;
use Omw\Api\Infra\Db;
use Omw\Api\Tests\Http\AccessTestCase;

/**
 * A restore of the API database (spec-wave5 §3.8.6, HOSTING §8): rotateFeedId also rotates the
 * access epoch; joins, polls, resumes and approvals answer `restoring` until the restored_api
 * reconcile ran; the store's tombstones are re-imported (revoked stays revoked, a deleted person
 * is erased again); fids the database does not know are tombstoned; sessions of devices that
 * joined after the backup are removed and reported as orphans; the owner gets one notice.
 */
final class BootstrapRestoreTest extends AccessTestCase
{
    public function testRestoreReconcile(): void
    {
        $this->bootAccess(['BACKUP_HOUR' => '0']);
        $this->initStore();
        $version = $this->publishNotice();
        [$keep, $tKeep] = $this->invite('Anna');
        [$revokeLater, $tRevoke] = $this->invite('Ben');
        [$deleteLater, $tDelete] = $this->invite('Clara');
        $kKeep = (string) $this->join($tKeep, $version)['deviceKey'];
        $this->join($tRevoke, $version);
        $kDelete = (string) $this->join($tDelete, $version)['deviceKey'];
        $keepSession = $this->sessionFiles($keep);
        self::assertCount(1, $keepSession);
        $panicUrl = (string) self::json($this->admin('POST', '/api/v1/admin/access/panic-link', new \stdClass()))['url'];
        $panicKey = substr($panicUrl, (int) strpos($panicUrl, '#k=') + 3);

        // The nightly backup.
        $backup = $this->service(Backups::class)->create(Clock::now(), 'Europe/Berlin');

        // After the backup: Ben is revoked, Clara deletes herself, Dora is invited and joins,
        // Anna's second device joins and is allowed.
        Clock::advance('+1 hour');
        $this->admin('POST', "/api/v1/admin/followers/$revokeLater/revoke", new \stdClass());
        self::assertSame('deleted', self::json($this->pub('me/delete', ['k' => $kDelete, 'confirm' => 'delete-all-my-data']))['status']);
        [$newPerson, $tNew] = $this->invite('Dora');
        $this->join($tNew, $version);
        $k2 = (string) $this->join($tKeep, $version, null, self::UA_ANDROID)['deviceKey'];
        $did2 = (string) $this->appDb()->scalar("SELECT id FROM devices WHERE follower_id = ? AND state = 'pending'", [$keep]);
        $this->admin('POST', "/api/v1/admin/devices/$did2/approve", new \stdClass());
        self::assertSame('active', $this->call('device/poll', $k2)['status']);
        self::assertCount(2, $this->sessionFiles($keep));
        // Anna's link leaked and was replaced after the backup (F3).
        $rotated = (string) self::json($this->admin('POST', "/api/v1/admin/followers/$keep/link", new \stdClass()))['link']['url'];
        self::assertSame('invalid', self::json($this->pub('join/check', ['t' => $tKeep]))['status']);

        // Restore (docs/HOSTING.md §8): the snapshot replaces the database, bootstrap.json rotates.
        $db = $this->service(Db::class);
        $db->close();
        $dbPath = $this->tmpDir() . '/var/app.sqlite';
        foreach (['-wal', '-shm'] as $suffix) {
            @unlink($dbPath . $suffix);
        }
        copy($backup['path'], $dbPath);
        file_put_contents($this->tmpDir() . '/var/bootstrap.json', '{"version": 1, "rotateFeedId": true}');
        Clock::advance('+1 hour');
        $this->migrate();
        self::assertFileDoesNotExist($this->tmpDir() . '/var/bootstrap.json');
        $state = $db->one('SELECT epoch, reconciled_epoch FROM access_state');
        self::assertNotNull($state);
        self::assertNotSame($state['epoch'], $state['reconciled_epoch'], 'restoring');

        // Frozen until the reconcile ran.
        self::assertSame(['status' => 'unavailable', 'reason' => 'restoring'], self::json($this->pub('join/check', ['t' => $tKeep])));
        self::assertSame(['status' => 'unavailable', 'reason' => 'restoring'], self::json($this->pub('join', ['resume' => true, 'k' => $kKeep, 'locale' => 'de'])));
        self::assertSame(['status' => 'unavailable', 'reason' => 'restoring'], $this->call('device/poll', $kKeep));
        self::assertTrue(self::json($this->admin('GET', '/api/v1/admin/status'))['access']['restoring']);

        // The next cron run reconciles.
        $result = $this->service(CronRunner::class)->run(null, ['access']);
        self::assertTrue($result['jobs']['access']['reconciled'], (string) json_encode($result));
        $state = $db->one('SELECT epoch, reconciled_epoch, reconcile_report FROM access_state');
        self::assertNotNull($state);
        self::assertSame($state['epoch'], $state['reconciled_epoch']);
        $report = json_decode((string) $state['reconcile_report'], true);
        self::assertIsArray($report);
        self::assertSame('restored_api', $report['mode']);

        // Ben stays out, Clara is erased again, Dora's fid is never reused.
        self::assertSame('revoked', $db->scalar('SELECT state FROM followers WHERE id = ?', [$revokeLater]));
        $clara = $db->one('SELECT * FROM followers WHERE id = ?', [$deleteLater]);
        self::assertNotNull($clara);
        self::assertSame(['deleted', null, 'restore'], [$clara['state'], $clara['name'], $clara['deleted_by']]);
        self::assertSame(0, (int) $db->scalar('SELECT COUNT(*) FROM devices WHERE follower_id = ?', [$deleteLater]));
        $dora = $db->one('SELECT * FROM followers WHERE id = ?', [$newPerson]);
        self::assertNotNull($dora);
        self::assertSame(['deleted', 'restore'], [$dora['state'], $dora['deleted_by']]);

        // Devices that joined after the backup lose access (orphans), and are reported.
        $orphans = array_map(static fn (array $o): string => $o['fid'], $report['orphans']);
        sort($orphans);
        $expected = [$keep, $newPerson];
        sort($expected);
        self::assertSame($expected, $orphans);
        self::assertSame($keepSession, $this->sessionFiles($keep), 'Anna keeps her first device, the second one is gone');
        self::assertSame([], $this->sessionFiles($newPerson));
        self::assertSame([], $this->sessionFiles($revokeLater));
        self::assertSame(['status' => 'ended'], $this->call('me/hello', $k2));
        self::assertSame('active', $this->call('me/hello', $kKeep)['status']);
        self::assertSame(1, (int) $db->scalar("SELECT COUNT(*) FROM owner_notices WHERE kind = 'restore_reconciled'"));
        self::assertStringNotContainsString('Anna', (string) $db->scalar("SELECT data FROM owner_notices WHERE kind = 'restore_reconciled'"));

        // F3: the store keeps no record of a link rotation, so the reconcile resets every
        // personal link and the panic link: the link replaced after the backup must not work again.
        self::assertSame('invalid', self::json($this->pub('join/check', ['t' => $tKeep]))['status'], 'the leaked, replaced link');
        self::assertSame('invalid', self::json($this->pub('join/check', ['t' => substr($rotated, (int) strpos($rotated, '#t=') + 3)]))['status']);
        self::assertSame(0, (int) $db->scalar("SELECT COUNT(*) FROM followers WHERE link_hash IS NOT NULL OR link_created_at IS NOT NULL"));
        self::assertNull(self::json($this->admin('GET', "/api/v1/admin/followers/$keep"))['link']);
        self::assertNull($db->scalar('SELECT panic_hash FROM access_state'));
        self::assertSame(['ok' => true], self::json($this->pub('panic', ['key' => $panicKey])));
        self::assertSame(0, (int) $db->scalar('SELECT locked FROM access_state'), 'the old panic link no longer locks');
        self::assertFalse(self::json($this->admin('GET', '/api/v1/admin/access'))['panicLink']);
        $data = json_decode((string) $db->scalar("SELECT data FROM owner_notices WHERE kind = 'restore_reconciled'"), true);
        self::assertIsArray($data);
        self::assertSame(['links' => 1, 'panicLink' => true], array_intersect_key($data, ['links' => 0, 'panicLink' => 0]));

        // Connected devices keep working; a new link from the owner works for joins again; the
        // marker carries the new epoch.
        self::assertSame('active', $this->call('me/hello', $kKeep)['status']);
        $fresh = (string) self::json($this->admin('POST', "/api/v1/admin/followers/$keep/link", new \stdClass()))['link']['url'];
        $tFresh = substr($fresh, (int) strpos($fresh, '#t=') + 3);
        self::assertSame('known_device', self::json($this->pub('join/check', ['t' => $tFresh, 'k' => $kKeep]))['status']);
        $marker = json_decode((string) $this->storeRead(StoreLayout::MARKER), true);
        self::assertSame($state['epoch'], $marker['epoch'] ?? null);
    }

    /**
     * F2: until the restored_api reconcile ran, the device rows cannot be trusted. A device the
     * owner removed after the backup is "active" again in the restored database: it must not get
     * the person's name, her data, her export, nor erase her. Every me/ route refuses; afterwards
     * the reconcile re-imports the removal and the device has limited rights again.
     */
    public function testYourDataRoutesRefuseWhileRestoring(): void
    {
        $this->bootAccess(['BACKUP_HOUR' => '0']);
        $this->initStore();
        $version = $this->publishNotice();
        [$fid, $t] = $this->invite('Oma Test');
        $kA = (string) $this->join($t, $version)['deviceKey'];
        $kB = (string) $this->join($t, $version, null, self::UA_ANDROID)['deviceKey'];
        $didB = (string) $this->appDb()->scalar("SELECT id FROM devices WHERE follower_id = ? AND state = 'pending'", [$fid]);
        $this->admin('POST', "/api/v1/admin/devices/$didB/approve", new \stdClass());
        self::assertSame('active', $this->call('device/poll', $kB)['status']);
        $backup = $this->service(Backups::class)->create(Clock::now(), 'Europe/Berlin');

        Clock::advance('+1 hour');
        $this->admin('POST', "/api/v1/admin/devices/$didB/revoke", new \stdClass());
        self::assertSame('limited', $this->call('me/data', $kB)['status']);

        $this->restore($backup['path']);
        foreach ([$kA, $kB] as $k) {
            foreach (['me/hello', 'me/notice'] as $route) {
                self::assertSame(['status' => 'unavailable', 'reason' => 'restoring'], $this->call($route, $k), $route);
            }
            $consent = $this->pub('me/consent', ['k' => $k, 'version' => $version, 'locale' => 'de']);
            self::assertSame(['status' => 'unavailable', 'reason' => 'restoring'], self::json($consent));
            foreach (['me/data' => ['k' => $k], 'me/export' => ['k' => $k], 'me/signout' => ['k' => $k], 'me/delete' => ['k' => $k, 'confirm' => 'delete-all-my-data']] as $route => $body) {
                $res = $this->pub($route, $body);
                self::assertError($res, 503, 'busy');
                self::assertSame((string) \Omw\Api\Http\Public\MeController::RESTORING_RETRY_SECONDS, $res->getHeaderLine('Retry-After'), $route);
                self::assertStringNotContainsString('Oma Test', (string) $res->getBody());
            }
        }
        // Nothing was changed by the refused routes.
        $db = $this->appDb();
        self::assertSame('active', $db->scalar('SELECT state FROM followers WHERE id = ?', [$fid]));
        self::assertSame(2, (int) $db->scalar("SELECT COUNT(*) FROM devices WHERE follower_id = ? AND state = 'active'", [$fid]));

        // The reconcile re-imports the removal (store tombstone): B is limited again, A has full rights.
        $this->service(CronRunner::class)->run(null, ['access']);
        self::assertSame('limited', $this->call('me/data', $kB)['status']);
        self::assertSame(['status' => 'ended'], $this->call('me/hello', $kB));
        $a = $this->call('me/data', $kA);
        self::assertSame('ok', $a['status']);
        self::assertSame('Oma Test', $a['data']['follower']['name']);
    }

    /** Restores a snapshot as docs/HOSTING.md §8 says (WAL/SHM removed, bootstrap rotateFeedId). */
    private function restore(string $snapshot): void
    {
        $db = $this->service(Db::class);
        $db->close();
        $dbPath = $this->tmpDir() . '/var/app.sqlite';
        foreach (['-wal', '-shm'] as $suffix) {
            @unlink($dbPath . $suffix);
        }
        copy($snapshot, $dbPath);
        file_put_contents($this->tmpDir() . '/var/bootstrap.json', '{"version": 1, "rotateFeedId": true}');
        Clock::advance('+1 hour');
        $this->migrate();
        self::assertTrue($this->service(\Omw\Api\Domain\Access\AccessState::class)->isRestoring());
    }

    public function testTheFirstAdminAccessViewReconcilesAtOnce(): void
    {
        $this->bootAccess();
        $this->initStore();
        $this->appDb()->exec('UPDATE access_state SET epoch = ?', ['0123456789abcdef']);
        self::assertTrue(self::json($this->admin('GET', '/api/v1/admin/status'))['access']['restoring']);
        $status = self::json($this->admin('GET', '/api/v1/admin/access'));
        self::assertFalse($status['restoring']);
        self::assertSame('restored_api', $status['lastReconcile']['mode']);
    }
}
