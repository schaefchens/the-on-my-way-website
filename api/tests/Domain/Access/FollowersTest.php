<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Domain\Access;

use Omw\Api\Domain\Access\FollowerData;
use Omw\Api\Domain\Access\Followers;
use Omw\Api\Domain\Access\Tokens;
use Omw\Api\Http\ApiException;
use Omw\Api\Infra\Clock;
use Omw\Api\Tests\Http\AccessTestCase;

/**
 * Domain\Access\Followers (spec-wave5 §3.3): create (link hash only), rotate, revoke (devices end
 * together, ops), delete (tombstone shape incl. created_at = deleted_at), ids never reused.
 */
final class FollowersTest extends AccessTestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        $this->bootAccess();
        $this->migrate();
    }

    public function testCreateStoresOnlyTheLinkHash(): void
    {
        $f = $this->service(Followers::class);
        $created = $f->create('Oma', '');
        $t = substr($created['link']['url'], strlen(self::SITE . '/_/join/#t='));
        self::assertTrue(Tokens::isToken($t));
        $row = $f->get($created['fid']);
        self::assertSame(Tokens::hash($t), $row['link_hash']);
        self::assertNull($row['note'], 'an empty note is stored as none');
        self::assertSame($row, $f->byLinkHash(Tokens::hash($t)));

        $rotated = $f->rotateLink($created['fid']);
        self::assertNotSame($created['link']['url'], $rotated['url']);
        self::assertNull($f->byLinkHash(Tokens::hash($t)));
    }

    public function testRevokeEndsDevicesTogetherAndEnqueuesOps(): void
    {
        $f = $this->service(Followers::class);
        $fid = $f->create('Oma', null)['fid'];
        $db = $this->appDb();
        $db->exec("INSERT INTO devices (id, follower_id, state, first, key_hash, created_at, session_hash, session_at, handoff_at) VALUES ('aaaaaaaa', ?, 'active', 1, ?, ?, ?, ?, ?)", [$fid, str_repeat('1', 64), self::NOW, str_repeat('2', 64), self::NOW, self::NOW]);
        $db->exec("INSERT INTO devices (id, follower_id, state, first, key_hash, created_at) VALUES ('bbbbbbbb', ?, 'pending', 0, ?, ?)", [$fid, str_repeat('3', 64), self::NOW]);
        Clock::advance('+1 minute');
        $max = $f->revoke($fid);
        self::assertSame(0, $f->revoke($fid), 'idempotent');
        $row = $f->get($fid);
        self::assertSame(['revoked', null, Clock::nowIso()], [$row['state'], $row['link_hash'], $row['revoked_at']]);
        $a = $db->one("SELECT * FROM devices WHERE id = 'aaaaaaaa'");
        self::assertNotNull($a);
        self::assertSame(['revoked', 'owner', Clock::nowIso(), null, null], [$a['state'], $a['revoked_by'], $a['revoked_at'], $a['session_hash'], $a['handoff_at']]);
        self::assertSame('declined', $db->scalar("SELECT state FROM devices WHERE id = 'bbbbbbbb'"));
        $ops = $db->all('SELECT op, path, content FROM store_ops ORDER BY id');
        self::assertSame([
            ['op' => 'put', 'path' => "t/$fid", 'content' => '{"s":"revoked","at":"' . Clock::nowIso() . '"}'],
            ['op' => 'delete_tree', 'path' => "s/$fid", 'content' => null],
            ['op' => 'delete', 'path' => 'h/aaaaaaaa', 'content' => null],
            ['op' => 'delete', 'path' => 'h/bbbbbbbb', 'content' => null],
        ], $ops);
        self::assertSame($max, (int) $db->scalar('SELECT MAX(id) FROM store_ops'));
        $this->expectException(ApiException::class);
        $f->rotateLink($fid);
    }

    public function testDeleteLeavesAMinimalTombstoneAndIdsAreNeverReused(): void
    {
        $f = $this->service(Followers::class);
        $fid = $f->create('Oma', 'note')['fid'];
        Clock::advance('+1 day');
        $this->service(FollowerData::class)->delete($fid, 'owner');
        $row = $this->appDb()->one('SELECT * FROM followers WHERE id = ?', [$fid]);
        self::assertNotNull($row);
        self::assertSame(
            ['state' => 'deleted', 'name' => null, 'note' => null, 'link_hash' => null, 'link_created_at' => null, 'revoked_at' => null, 'deleted_by' => 'owner'],
            array_intersect_key($row, array_flip(['state', 'name', 'note', 'link_hash', 'link_created_at', 'revoked_at', 'deleted_by'])),
        );
        self::assertSame($row['deleted_at'], $row['created_at']);
        self::assertSame($row['deleted_at'], $row['updated_at']);
        self::assertSame(Clock::nowIso(), $row['deleted_at']);

        // The id stays taken: a tombstone row blocks it (the create loop checks ALL rows).
        $this->expectException(\PDOException::class);
        $this->appDb()->exec("INSERT INTO followers (id, state, name, created_at, updated_at) VALUES (?, 'active', 'X', ?, ?)", [$fid, self::NOW, self::NOW]);
    }

    public function testIdsHaveTheContractShape(): void
    {
        for ($i = 0; $i < 50; ++$i) {
            self::assertTrue(Tokens::isFollowerId(Tokens::followerId()));
            self::assertTrue(Tokens::isDeviceId(Tokens::deviceId()));
            self::assertTrue(Tokens::isToken(Tokens::token()));
            self::assertMatchesRegularExpression('/^[0-9a-f]{16}$/', Tokens::hex16());
        }
        self::assertSame('mzxw6ytboi', Tokens::base32('foobar'), 'RFC 4648 base32, lowercase, no padding');
    }
}
