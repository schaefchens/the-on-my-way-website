<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Domain\Access;

use Omw\Api\Domain\Access\FollowerData;
use Omw\Api\Domain\Access\Followers;
use Omw\Api\Infra\Db;
use Omw\Api\Tests\Http\AccessTestCase;

/**
 * Domain\Access\FollowerData (D12): the view and the export content, and delete: rows erased,
 * store ops, the owner notice for a follower's own deletion only.
 */
final class FollowerDataTest extends AccessTestCase
{
    public function testViewExportAndDelete(): void
    {
        $this->bootAccess();
        $this->initStoreDirect();
        $version = $this->publishNoticeDirect();
        $created = $this->service(Followers::class)->create('Oma', 'owner memo');
        $t = substr($created['link']['url'], strlen(self::SITE . '/_/join/#t='));
        $fid = $created['fid'];
        $k = (string) $this->join($t, $version)['deviceKey'];
        $did = (string) $this->appDb()->scalar('SELECT id FROM devices WHERE follower_id = ?', [$fid]);
        $data = $this->service(FollowerData::class);

        $view = $data->view($fid, $did);
        self::assertSame($version, $view['noticeVersion']);
        self::assertStringNotContainsString('owner memo', json_encode($view, JSON_THROW_ON_ERROR), 'the owner\'s note is not personal data shown to the follower');
        $export = $data->export($fid);
        self::assertSame(['id', 'label', 'state', 'createdAt', 'lastSeenAt', 'decidedAt', 'revokedAt', 'revokedBy'], array_keys($export['devices'][0]));
        self::assertSame(self::NOW, $export['follower']['linkCreatedAt']);
        self::assertSame('Traveler', $export['consents'][0]['notice']['controller']['name']);

        $max = $data->delete($fid, 'follower');
        $db = $this->appDb();
        self::assertSame([
            ['op' => 'put', 'path' => "t/$fid"],
            ['op' => 'delete_tree', 'path' => "s/$fid"],
            ['op' => 'delete', 'path' => "h/$did"],
        ], $db->all('SELECT op, path FROM store_ops WHERE id > ? - 3 ORDER BY id', [$max]));
        self::assertSame(1, (int) $db->scalar("SELECT COUNT(*) FROM owner_notices WHERE kind = 'follower_deleted'"));
        self::assertSame(['status' => 'ended'], $this->call('me/data', $k));
    }

    /**
     * F5 (D12): the erasure also removes the person's store-op history (paths name her id and her
     * devices' ids; their times show when each device joined, resumed and was removed) and her id
     * from the reconcile report and the restore notices. Only this deletion's own ops remain;
     * another person's history is untouched.
     */
    public function testDeleteErasesTheStoreOpHistory(): void
    {
        $this->bootAccess();
        $this->initStoreDirect();
        $version = $this->publishNoticeDirect();
        $followers = $this->service(Followers::class);
        $oma = $followers->create('Oma', null);
        $opa = $followers->create('Opa', null);
        $tOma = substr($oma['link']['url'], strlen(self::SITE . '/_/join/#t='));
        $tOpa = substr($opa['link']['url'], strlen(self::SITE . '/_/join/#t='));
        $fid = $oma['fid'];
        $other = $opa['fid'];
        $k1 = (string) $this->join($tOma, $version)['deviceKey'];
        $this->call('me/hello', $k1);                                        // clears the handoff marker
        self::assertSame('active', self::json($this->pub('join', ['resume' => true, 'k' => $k1, 'locale' => 'de']))['status']);
        $k2 = (string) $this->join($tOma, $version, null, self::UA_ANDROID)['deviceKey'];
        $kOpa = (string) $this->join($tOpa, $version)['deviceKey'];
        $db = $this->appDb();
        $dids = array_map(static fn (array $r): string => (string) $r['id'], $db->all('SELECT id FROM devices WHERE follower_id = ? ORDER BY id', [$fid]));
        self::assertCount(2, $dids);
        $first = (string) $db->scalar("SELECT id FROM devices WHERE follower_id = ? AND state = 'active'", [$fid]);
        $this->service(\Omw\Api\Domain\Access\Devices::class)->revoke($first, 'owner');
        $this->service(\Omw\Api\Domain\Access\StoreApplier::class)->applyNow(8.0);
        $didOpa = (string) $db->scalar('SELECT id FROM devices WHERE follower_id = ?', [$other]);
        $mentions = static fn (Db $db, string $id): int => (int) $db->scalar('SELECT COUNT(*) FROM store_ops WHERE instr(path, ?) > 0', [$id]);
        self::assertGreaterThanOrEqual(6, $mentions($db, $fid));
        $opaBefore = $db->all('SELECT id, op, path, applied_at FROM store_ops WHERE instr(path, ?) > 0 OR instr(path, ?) > 0 ORDER BY id', [$other, $didOpa]);
        self::assertNotSame([], $opaBefore);
        $db->exec('UPDATE access_state SET reconcile_report = ? WHERE id = 1', [json_encode([
            'at' => self::NOW, 'mode' => 'normal', 'deleted' => 0,
            'missing' => [['fid' => $fid, 'did' => $dids[0]], ['fid' => $other, 'did' => $didOpa]],
            'orphans' => [['fid' => $fid, 'did' => $dids[1]]],
            'imported' => ['adopted ' . $fid . '.' . $dids[0], 'lock (admin)'],
        ], JSON_THROW_ON_ERROR)]);
        $this->service(\Omw\Api\Domain\Access\OwnerNotices::class)->add('restore_reconciled', ['devices' => 2, 'people' => [$fid, $other], 'tombstoned' => 0]);

        $max = $this->service(FollowerData::class)->delete($fid, 'owner');

        $rows = $db->all('SELECT id, op, path FROM store_ops WHERE instr(path, ?) > 0 OR ' . implode(' OR ', array_fill(0, count($dids), 'instr(path, ?) > 0')) . ' ORDER BY id', [$fid, ...$dids]);
        $expected = [['op' => 'put', 'path' => "t/$fid"], ['op' => 'delete_tree', 'path' => "s/$fid"]];
        foreach ($dids as $did) {
            $expected[] = ['op' => 'delete', 'path' => "h/$did"];
        }
        self::assertSame($expected, array_map(static fn (array $r): array => ['op' => $r['op'], 'path' => $r['path']], $rows));
        self::assertSame($max, (int) $rows[count($rows) - 1]['id']);
        self::assertSame($opaBefore, $db->all('SELECT id, op, path, applied_at FROM store_ops WHERE instr(path, ?) > 0 OR instr(path, ?) > 0 ORDER BY id', [$other, $didOpa]), 'another person keeps her history');
        $report = (string) $db->scalar('SELECT reconcile_report FROM access_state');
        self::assertStringNotContainsString($fid, $report);
        self::assertStringContainsString($other, $report);
        self::assertStringContainsString('lock (admin)', $report);
        $notice = (string) $db->scalar("SELECT data FROM owner_notices WHERE kind = 'restore_reconciled'");
        self::assertSame([$other], json_decode($notice, true)['people']);

        // The erasure's own ops still reach the store; the person's sessions are gone.
        $this->service(\Omw\Api\Domain\Access\StoreApplier::class)->applyNow(8.0);
        self::assertSame(0, $this->service(\Omw\Api\Domain\Access\StoreOps::class)->pendingCount());
        self::assertSame([], $this->sessionFiles($fid));
        self::assertStringContainsString('"deleted"', (string) $this->storeRead("t/$fid"));
        self::assertSame(['status' => 'ended'], $this->call('me/data', $k2));
        self::assertSame('active', $this->call('me/hello', $kOpa)['status']);
    }
}
