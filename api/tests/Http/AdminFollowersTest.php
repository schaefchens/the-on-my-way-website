<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Http;

use Omw\Api\Domain\Access\Followers;

/**
 * People and devices in the admin (spec-wave5 §3.5): create (link once), list, patch, rotate,
 * revoke (D2/D8), export, delete (tombstone), device approve/decline/remove, the device cap,
 * config_missing without SITE_ORIGIN, the service follower never listed.
 */
final class AdminFollowersTest extends AccessTestCase
{
    public function testCreateListPatchAndTheLinkIsShownOnce(): void
    {
        $this->bootAccess();
        $created = $this->admin('POST', '/api/v1/admin/followers', ['name' => 'Oma', 'note' => 'Mum\'s side']);
        self::assertSame(201, $created->getStatusCode(), (string) $created->getBody());
        $body = self::json($created);
        $fid = (string) $body['follower']['id'];
        self::assertMatchesRegularExpression('/^[a-z2-7]{12}$/', $fid);
        self::assertSame(['createdAt' => self::NOW], $body['follower']['link']);
        self::assertSame([], $body['follower']['devices']);
        self::assertNull($body['follower']['consent']);
        $t = substr((string) $body['link']['url'], strlen(self::SITE . '/_/join/#t='));

        $get = self::json($this->admin('GET', "/api/v1/admin/followers/$fid"));
        self::assertStringNotContainsString($t, json_encode($get, JSON_THROW_ON_ERROR), 'the link is never shown again');
        self::assertStringNotContainsString($t, json_encode($this->appDb()->all('SELECT * FROM followers'), JSON_THROW_ON_ERROR));

        $patched = self::json($this->admin('PATCH', "/api/v1/admin/followers/$fid", ['name' => 'Oma Erna', 'note' => null]));
        self::assertSame('Oma Erna', $patched['name']);
        self::assertNull($patched['note']);
        self::assertError($this->admin('PATCH', "/api/v1/admin/followers/$fid", ['name' => "two\nlines"]), 422, 'validation_failed');
        self::assertError($this->admin('POST', '/api/v1/admin/followers', ['name' => ' padded ']), 422, 'validation_failed');

        \Omw\Api\Infra\Clock::advance('+1 minute');
        $this->admin('POST', '/api/v1/admin/followers', ['name' => 'Opa']);
        $this->service(Followers::class)->service();
        $list = self::json($this->admin('GET', '/api/v1/admin/followers'));
        self::assertSame(['Opa', 'Oma Erna'], array_column($list['items'], 'name'), 'newest first, no service follower');
        self::assertError($this->admin('GET', '/api/v1/admin/followers/aaaaaaaaaaaa'), 404, 'not_found');
    }

    public function testConfigMissingWithoutSiteOrigin(): void
    {
        $this->boot();
        self::assertError($this->admin('POST', '/api/v1/admin/followers', ['name' => 'Oma']), 409, 'config_missing');
    }

    public function testRevokeKeepsDataAndDeleteLeavesATombstone(): void
    {
        $this->bootAccess();
        [$fid, $t, $version] = $this->setUpPerson();
        $first = $this->join($t, $version);
        $second = $this->join($t, $version, null, self::UA_ANDROID);
        self::assertSame('pending', $second['status']);

        $revoke = self::json($this->admin('POST', "/api/v1/admin/followers/$fid/revoke", new \stdClass()));
        self::assertSame(['applied' => true, 'via' => 'direct', 'pendingOps' => 0], $revoke['effect']);
        self::assertSame('revoked', $revoke['follower']['state']);
        self::assertNull($revoke['follower']['link']);
        $states = array_column($revoke['follower']['devices'], 'state');
        sort($states);
        self::assertSame(['declined', 'revoked'], $states);
        $revokedDevice = array_values(array_filter($revoke['follower']['devices'], static fn (array $d): bool => $d['state'] === 'revoked'))[0];
        self::assertSame($revoke['follower']['revokedAt'], $revokedDevice['revokedAt'], 'ended together with the person');
        self::assertSame([], $this->sessionFiles($fid));
        self::assertSame('{"s":"revoked","at":"' . self::NOW . '"}', $this->storeRead("t/$fid"));
        self::assertSame(['status' => 'ended'], $this->call('me/hello', (string) $first['deviceKey']));
        // Idempotent; data stays (D8).
        self::assertSame(200, $this->admin('POST', "/api/v1/admin/followers/$fid/revoke", new \stdClass())->getStatusCode());
        self::assertSame(2, (int) $this->appDb()->scalar('SELECT COUNT(*) FROM consents WHERE follower_id = ?', [$fid]), 'one per join');
        self::assertError($this->admin('POST', "/api/v1/admin/followers/$fid/link", new \stdClass()), 409, 'conflict');

        $export = $this->admin('GET', "/api/v1/admin/followers/$fid/export");
        self::assertSame(200, $export->getStatusCode());
        self::assertStringStartsWith('attachment;', $export->getHeaderLine('Content-Disposition'));
        self::assertSame('revoked', self::json($export)['follower']['state']);

        self::assertError($this->admin('POST', "/api/v1/admin/followers/$fid/delete", ['confirm' => false]), 422, 'validation_failed');
        $deleted = self::json($this->admin('POST', "/api/v1/admin/followers/$fid/delete", ['confirm' => true]));
        self::assertTrue($deleted['effect']['applied']);
        self::assertError($this->admin('GET', "/api/v1/admin/followers/$fid"), 404, 'not_found');
        $list = self::json($this->admin('GET', '/api/v1/admin/followers'));
        self::assertSame([['id' => $fid, 'state' => 'deleted', 'deletedAt' => self::NOW, 'deletedBy' => 'owner']], $list['tombstones']);
        self::assertSame('{"s":"deleted","at":"' . self::NOW . '"}', $this->storeRead("t/$fid"), 'revoked → deleted in the store');
        self::assertSame(0, (int) $this->appDb()->scalar("SELECT COUNT(*) FROM owner_notices WHERE kind = 'follower_deleted'"), 'no notice for the owner\'s own action');
    }

    public function testDevicesApproveDeclineRemoveAndTheCap(): void
    {
        $this->bootAccess(['ACCESS_MAX_DEVICES' => '2']);
        [$fid, $t, $version] = $this->setUpPerson();
        $this->join($t, $version);
        $k2 = (string) $this->join($t, $version)['deviceKey'];
        $k3 = (string) $this->join($t, $version)['deviceKey'];
        $db = $this->appDb();
        // By device key (two joins within one second share created_at, so no ORDER BY gives the join order).
        $idOf = static fn (string $k): string => (string) $db->scalar("SELECT id FROM devices WHERE key_hash = ? AND state = 'pending'", [hash('sha256', $k)]);
        $pending = [$idOf($k2), $idOf($k3)];
        self::assertSame(2, (int) $db->scalar("SELECT COUNT(*) FROM devices WHERE follower_id = ? AND state = 'pending'", [$fid]));
        self::assertNotSame('', $pending[0]);
        self::assertNotSame('', $pending[1]);

        $status = self::json($this->admin('GET', '/api/v1/admin/access'));
        self::assertSame(2, $status['pendingDevices']);
        self::assertSame('Oma', $status['pending'][0]['name']);

        $approve = self::json($this->admin('POST', "/api/v1/admin/devices/{$pending[0]}/approve", new \stdClass()));
        self::assertSame('active', $approve['device']['state']);
        self::assertSame('Oma', $approve['follower']['name']);
        self::assertError($this->admin('POST', "/api/v1/admin/devices/{$pending[1]}/approve", new \stdClass()), 409, 'device_limit');

        $decline = self::json($this->admin('POST', "/api/v1/admin/devices/{$pending[1]}/decline", new \stdClass()));
        self::assertSame('declined', $decline['device']['state']);
        self::assertSame(['status' => 'ended'], $this->call('device/poll', $k3));

        $poll = $this->call('device/poll', $k2);
        self::assertSame('active', $poll['status']);
        $remove = self::json($this->admin('POST', "/api/v1/admin/devices/{$pending[0]}/revoke", new \stdClass()));
        self::assertSame('revoked', $remove['device']['state']);
        self::assertSame('owner', $remove['device']['revokedBy']);
        self::assertTrue($remove['effect']['applied']);
        self::assertFalse($this->storeHas(self::sessionPath((string) $poll['session'])));
        self::assertTrue($this->storeHas("t/$fid.{$pending[0]}"));
        self::assertError($this->admin('POST', '/api/v1/admin/devices/aaaaaaaa/approve', new \stdClass()), 404, 'not_found');
    }

    public function testPendingDevicesExpireAfterFourteenDays(): void
    {
        $this->bootAccess();
        [$fid, $t, $version] = $this->setUpPerson();
        $this->join($t, $version);
        $this->join($t, $version);
        \Omw\Api\Infra\Clock::advance('+15 days');
        $this->service(\Omw\Api\Infra\CronRunner::class)->run(null, ['access']);
        $row = $this->appDb()->one("SELECT state, revoked_by, decided_at FROM devices WHERE follower_id = ? AND first = 0", [$fid]);
        self::assertNotNull($row);
        self::assertSame('declined', $row['state']);
        self::assertNull($row['revoked_by']);
        self::assertNotNull($row['decided_at']);
    }
}
