<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Http;

use Omw\Api\Domain\Access\Tokens;
use Omw\Api\Infra\Clock;

/**
 * The device's own routes (spec-wave5 §3.4): hello (last seen, one-time handoff), notice and
 * consent after a changed text, your data, export, sign out, delete me (and a second call
 * answering ended); F2 cookies.
 */
final class PublicMeTest extends AccessTestCase
{
    /** @return array{0: string, 1: string, 2: int} [fid, k, version] */
    private function joined(string $name = 'Oma'): array
    {
        [$fid, $t, $version] = $this->setUpPerson($name);
        $join = $this->join($t, $version);
        self::assertSame('active', $join['status']);

        return [$fid, (string) $join['deviceKey'], $version];
    }

    public function testHelloUpdatesLastSeenAtMostEverySixHours(): void
    {
        $this->bootAccess();
        [$fid, $k] = $this->joined();
        $seen = [];
        $this->call('me/hello', $k);
        $seen[] = $this->lastSeen($fid);
        Clock::advance('+2 hours');
        $this->call('me/hello', $k);
        $seen[] = $this->lastSeen($fid);
        Clock::advance('+5 hours');
        $this->call('me/hello', $k);
        $seen[] = $this->lastSeen($fid);
        self::assertSame([self::NOW, self::NOW, Clock::nowIso()], $seen);
        self::assertSame(['status' => 'ended'], $this->call('me/hello', Tokens::token()));
    }

    public function testAChangedNoticeMustBeConfirmedAgain(): void
    {
        $this->bootAccess();
        [$fid, $k, $v1] = $this->joined();
        $v2 = $this->publishNotice();
        self::assertSame($v1 + 1, $v2);
        $hello = $this->call('me/hello', $k);
        self::assertSame(['version' => $v2, 'required' => true], $hello['notice']);
        $notice = $this->call('me/notice', $k);
        self::assertSame('ok', $notice['status']);
        self::assertSame($v2, $notice['notice']['version']);
        self::assertSame($v1, $notice['confirmedVersion']);
        self::assertSame(['status' => 'known_device', 'noticeRequired' => true], self::json($this->pub('join/check', [
            't' => $this->rotate($fid), 'k' => $k,
        ])));

        // A stale version is not recorded; the current one is.
        $stale = self::json($this->pub('me/consent', ['k' => $k, 'version' => $v1, 'locale' => 'de']));
        self::assertTrue($stale['notice']['required']);
        $ok = self::json($this->pub('me/consent', ['k' => $k, 'version' => $v2, 'locale' => 'en']));
        self::assertSame('active', $ok['status']);
        self::assertSame(['version' => $v2, 'required' => false], $ok['notice']);
        self::assertSame(1, (int) $this->appDb()->scalar('SELECT COUNT(*) FROM consents WHERE follower_id = ? AND notice_version = ? AND locale = ?', [$fid, $v2, 'en']));
    }

    public function testYourDataExportAndDeleteMe(): void
    {
        $this->bootAccess();
        [$fid, $k, $version] = $this->joined('Oma Erna');
        $data = $this->call('me/data', $k);
        self::assertSame('ok', $data['status']);
        self::assertSame(['id' => $fid, 'name' => 'Oma Erna', 'since' => self::NOW, 'state' => 'active'], $data['data']['follower']);
        self::assertCount(1, $data['data']['devices']);
        self::assertTrue($data['data']['devices'][0]['thisDevice']);
        self::assertSame([['version' => $version, 'confirmedAt' => self::NOW, 'locale' => 'de']], $data['data']['consents']);
        self::assertSame([['key' => 'devices', 'count' => 1], ['key' => 'consents', 'count' => 1]], $data['data']['categories']);

        $export = $this->pub('me/export', ['k' => $k]);
        self::assertSame('attachment; filename="on-my-way-data-2026-11-20.json"', $export->getHeaderLine('Content-Disposition'));
        $body = self::json($export);
        self::assertSame('omw-follower-data/1', $body['format']);
        self::assertSame('Datenschutzhinweise', $body['consents'][0]['notice']['texts']['de']['title']);

        self::assertError($this->pub('me/delete', ['k' => $k, 'confirm' => 'yes']), 400, 'validation_failed');
        $deleted = self::json($this->pub('me/delete', ['k' => $k, 'confirm' => 'delete-all-my-data']));
        self::assertSame(['status' => 'deleted'], $deleted);
        $db = $this->appDb();
        $row = $db->one('SELECT * FROM followers WHERE id = ?', [$fid]);
        self::assertNotNull($row);
        self::assertSame('deleted', $row['state']);
        self::assertNull($row['name']);
        self::assertSame('follower', $row['deleted_by']);
        self::assertSame($row['deleted_at'], $row['created_at'], 'the invitation date is not kept');
        self::assertSame(0, (int) $db->scalar('SELECT COUNT(*) FROM devices WHERE follower_id = ?', [$fid]));
        self::assertSame(0, (int) $db->scalar('SELECT COUNT(*) FROM consents WHERE follower_id = ?', [$fid]));
        self::assertSame(1, (int) $db->scalar("SELECT COUNT(*) FROM owner_notices WHERE kind = 'follower_deleted'"));
        self::assertStringNotContainsString('Oma', (string) $db->scalar("SELECT data FROM owner_notices WHERE kind = 'follower_deleted'"));
        self::assertSame([], $this->sessionFiles($fid));
        self::assertSame('{"s":"deleted","at":"' . self::NOW . '"}', $this->storeRead('t/' . $fid));

        self::assertSame(['status' => 'ended'], self::json($this->pub('me/delete', ['k' => $k, 'confirm' => 'delete-all-my-data'])), 'a second call');
        self::assertSame(['status' => 'ended'], $this->call('me/data', $k));
        $list = self::json($this->admin('GET', '/api/v1/admin/followers'));
        self::assertSame([['id' => $fid, 'state' => 'deleted', 'deletedAt' => self::NOW, 'deletedBy' => 'follower']], $list['tombstones']);
    }

    public function testSignOutRevokesThisDeviceOnly(): void
    {
        $this->bootAccess();
        [$fid, $k] = $this->joined();
        $db = $this->appDb();
        $did = (string) $db->scalar('SELECT id FROM devices WHERE follower_id = ?', [$fid]);
        self::assertSame(['status' => 'signed_out'], $this->call('me/signout', $k));
        self::assertSame('follower', $db->scalar('SELECT revoked_by FROM devices WHERE id = ?', [$did]));
        self::assertSame([], $this->sessionFiles($fid));
        self::assertTrue($this->storeHas("t/$fid.$did"));
        self::assertSame(['status' => 'ended'], $this->call('me/signout', $k));
        self::assertSame('active', $db->scalar('SELECT state FROM followers WHERE id = ?', [$fid]));
    }

    public function testParentCookieModeSetsTheCookiesItself(): void
    {
        $this->bootAccess([
            'SITE_ORIGIN' => 'https://www.example.org',
            'APP_URL' => 'https://api.example.org',
            'ACCESS_COOKIE_MODE' => 'parent',
            'ACCESS_COOKIE_DOMAIN' => 'example.org',
        ]);
        $this->initStore();
        $version = $this->publishNotice();
        $res = $this->admin('POST', '/api/v1/admin/followers', ['name' => 'Oma']);
        $url = (string) self::json($res)['link']['url'];
        $t = substr($url, strlen('https://www.example.org/_/join/#t='));
        $join = $this->pub('join', ['t' => $t, 'consentVersion' => $version, 'locale' => 'de'], ['Origin' => 'https://www.example.org']);
        $body = self::json($join);
        self::assertSame('active', $body['status']);
        self::assertSame('/', $body['handoff']);
        self::assertArrayNotHasKey('session', $body);
        self::assertSame('https://www.example.org', $join->getHeaderLine('Access-Control-Allow-Origin'));
        self::assertSame('true', $join->getHeaderLine('Access-Control-Allow-Credentials'));
        $cookies = $join->getHeader('Set-Cookie');
        self::assertCount(2, $cookies);
        self::assertMatchesRegularExpression('/^omw=[a-z2-7]{12}\.[a-z2-7]{8}\.[A-Za-z0-9_-]{43}; Domain=example\.org; Path=\/; Max-Age=34560000; Secure; HttpOnly; SameSite=Lax$/', $cookies[0]);
        self::assertSame('omw_k=' . $body['deviceKey'] . '; Domain=example.org; Path=/; Max-Age=34560000; Secure; SameSite=Strict', $cookies[1]);
        $session = substr(explode(';', $cookies[0])[0], 4);
        self::assertTrue($this->storeHas(self::sessionPath($session)));
        self::assertSame([], glob($this->storeDir() . '/h/*') ?: [], 'no handoff marker in F2');

        // hello re-sets both cookies only when the request's own session cookie is the current one.
        $k = (string) $body['deviceKey'];
        $hello = $this->pub('me/hello', ['k' => $k], ['Origin' => 'https://www.example.org'], ['omw' => $session]);
        self::assertCount(2, $hello->getHeader('Set-Cookie'));
        $stale = $this->pub('me/hello', ['k' => $k], ['Origin' => 'https://www.example.org'], ['omw' => substr($session, 0, -1) . 'x']);
        self::assertSame([], $stale->getHeader('Set-Cookie'));
        $data = $this->pub('me/data', ['k' => $k], ['Origin' => 'https://www.example.org']);
        self::assertSame('', $data->getHeaderLine('Access-Control-Allow-Credentials'), 'only join, poll and hello carry credentials');
    }

    private function lastSeen(string $fid): mixed
    {
        return $this->appDb()->scalar('SELECT last_seen_at FROM devices WHERE follower_id = ?', [$fid]);
    }

    private function rotate(string $fid): string
    {
        $link = self::json($this->admin('POST', "/api/v1/admin/followers/$fid/link", new \stdClass()))['link'];

        return substr((string) $link['url'], strlen(self::SITE . '/_/join/#t='));
    }
}
