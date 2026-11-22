<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Http;

use Omw\Api\Domain\Access\StoreLayout;
use Omw\Api\Domain\Access\Tokens;
use Omw\Api\Infra\Clock;

/**
 * Public join routes (spec-wave5 §1.1–§1.3, §3.4): statuses, identical answers for unknown,
 * rotated and revoked links, the first-device rule, pending devices, resume, the store files,
 * CORS on every answer, text/plain bodies, 413 before parsing, the global cap.
 */
final class PublicJoinTest extends AccessTestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        $this->bootAccess();
    }

    public function testFirstDeviceJoinsAndGetsAHandoffWithoutAnySecretInIt(): void
    {
        [$fid, $t, $version] = $this->setUpPerson('Oma');

        $check = self::json($this->pub('join/check', ['t' => $t]));
        self::assertSame('ok', $check['status']);
        self::assertSame(['name' => 'Oma'], $check['follower']);
        self::assertFalse($check['deviceMustWait']);
        self::assertSame($version, $check['notice']['version']);
        self::assertArrayHasKey('de', $check['notice']['texts']);

        $join = $this->join($t, $version);
        self::assertSame('active', $join['status']);
        self::assertSame('/_/h/', $join['handoff']);
        $session = (string) $join['session'];
        $k = (string) $join['deviceKey'];
        self::assertMatchesRegularExpression('/^' . $fid . '\.[a-z2-7]{8}\.[A-Za-z0-9_-]{43}$/', $session);
        self::assertTrue(Tokens::isToken($k));
        self::assertStringNotContainsString($k, $session, 'the key is never part of a handoff');

        // The store has the session file and the handoff marker; the database only hashes.
        $parts = StoreLayout::parseGateSession($session);
        self::assertNotNull($parts);
        self::assertTrue($this->storeHas(self::sessionPath($session)));
        self::assertTrue($this->storeHas('h/' . $parts['did']));
        $db = $this->appDb();
        $row = $db->one('SELECT * FROM devices WHERE id = ?', [$parts['did']]);
        self::assertNotNull($row);
        self::assertSame('active', $row['state']);
        self::assertSame(1, (int) $row['first']);
        self::assertSame(Tokens::hash($parts['sid']), $row['session_hash']);
        self::assertNull($row['pending_sid'], 'the clear sid is dropped once handed out');
        self::assertSame(Tokens::hash($k), $row['key_hash']);
        self::assertSame('iPhone · Safari', $row['label']);
        $dump = json_encode([$db->all('SELECT * FROM devices'), $db->all('SELECT * FROM store_ops'), $db->all('SELECT * FROM followers')]);
        self::assertStringNotContainsString($parts['sid'], (string) $dump, 'no usable sid stays in the database');
        self::assertStringNotContainsString($k, (string) $dump);
        self::assertSame(1, (int) $db->scalar('SELECT COUNT(*) FROM consents WHERE follower_id = ? AND notice_version = ?', [$fid, $version]));

        // Hello clears the one-time handoff marker.
        $hello = $this->call('me/hello', $k);
        self::assertSame('active', $hello['status']);
        self::assertSame(['name' => 'Oma'], $hello['follower']);
        self::assertSame(['version' => $version, 'required' => false], $hello['notice']);
        self::assertFalse($this->storeHas('h/' . $parts['did']));

        // Reopening the link on this device: known device, nothing new is created.
        $again = self::json($this->pub('join/check', ['t' => $t, 'k' => $k]));
        self::assertSame(['status' => 'known_device', 'noticeRequired' => false], $again);
        self::assertSame(1, (int) $db->scalar('SELECT COUNT(*) FROM devices WHERE follower_id = ?', [$fid]));
    }

    public function testUnknownRotatedAndRevokedLinksAllAnswerInvalid(): void
    {
        [$fid, $t, $version] = $this->setUpPerson();
        $unknown = self::json($this->pub('join/check', ['t' => Tokens::token()]));
        self::assertSame(['status' => 'invalid'], $unknown);

        $rotated = self::json($this->admin('POST', "/api/v1/admin/followers/$fid/link", new \stdClass()));
        self::assertSame(['status' => 'invalid'], self::json($this->pub('join/check', ['t' => $t])));
        self::assertSame(['status' => 'invalid'], $this->join($t, $version));
        $t2 = substr((string) $rotated['link']['url'], strlen(self::SITE . '/_/join/#t='));
        self::assertSame('ok', self::json($this->pub('join/check', ['t' => $t2]))['status']);

        $this->admin('POST', "/api/v1/admin/followers/$fid/revoke", new \stdClass());
        self::assertSame(['status' => 'invalid'], self::json($this->pub('join/check', ['t' => $t2])));
    }

    public function testLaterDevicesWaitAndReopeningDoesNotCreateDuplicates(): void
    {
        [$fid, $t, $version] = $this->setUpPerson();
        $first = $this->join($t, $version);
        self::assertSame('active', $first['status']);

        $check = self::json($this->pub('join/check', ['t' => $t]));
        self::assertTrue($check['deviceMustWait']);
        $second = $this->join($t, $version, null, self::UA_ANDROID);
        self::assertSame('pending', $second['status']);
        $k2 = (string) $second['deviceKey'];
        self::assertArrayNotHasKey('session', $second);

        // Reopening the link on the waiting device, three times: still one pending device.
        for ($i = 0; $i < 3; ++$i) {
            self::assertSame(['status' => 'pending_device'], self::json($this->pub('join/check', ['t' => $t, 'k' => $k2])));
            $again = $this->join($t, $version, $k2);
            self::assertSame('pending', $again['status']);
            self::assertArrayNotHasKey('deviceKey', $again);
        }
        $db = $this->appDb();
        self::assertSame(1, (int) $db->scalar("SELECT COUNT(*) FROM devices WHERE follower_id = ? AND state = 'pending'", [$fid]));
        self::assertSame('pending', $this->call('device/poll', $k2)['status']);

        // The owner allows it: the next poll issues the session.
        $did2 = (string) $db->scalar("SELECT id FROM devices WHERE follower_id = ? AND state = 'pending'", [$fid]);
        $approve = $this->admin('POST', "/api/v1/admin/devices/$did2/approve", new \stdClass());
        self::assertSame(200, $approve->getStatusCode(), (string) $approve->getBody());
        Clock::advance('+5 seconds');
        $poll = $this->call('device/poll', $k2);
        self::assertSame('active', $poll['status']);
        self::assertSame('/_/h/', $poll['handoff']);
        self::assertTrue($this->storeHas(self::sessionPath((string) $poll['session'])));
        Clock::advance('+5 seconds');
        self::assertSame(['status' => 'active', 'handoff' => '/'], $this->call('device/poll', $k2), 'a device with an applied session just goes to /');
    }

    public function testThreePendingDevicesAtMost(): void
    {
        [, $t, $version] = $this->setUpPerson();
        $this->join($t, $version);
        for ($i = 0; $i < 3; ++$i) {
            self::assertSame('pending', $this->join($t, $version)['status']);
        }
        self::assertSame(['status' => 'unavailable', 'reason' => 'too_many_pending'], self::json($this->pub('join/check', ['t' => $t])));
        self::assertSame(['status' => 'unavailable', 'reason' => 'too_many_pending'], $this->join($t, $version));
    }

    public function testConsentAndNoticeRules(): void
    {
        $this->initStore();
        [, $t] = $this->invite();
        self::assertSame(['status' => 'unavailable', 'reason' => 'notice_missing'], self::json($this->pub('join/check', ['t' => $t])));
        $version = $this->publishNotice();
        $outdated = $this->join($t, $version + 1);
        self::assertSame('consent_outdated', $outdated['status']);
        self::assertSame($version, $outdated['notice']['version']);
    }

    public function testJoinRequestShapeIsEnforced(): void
    {
        [, $t, $version] = $this->setUpPerson();
        $k = Tokens::token();
        foreach ([
            ['t' => $t, 'locale' => 'de'],                                           // no consentVersion
            ['consentVersion' => $version, 'locale' => 'de'],                        // no t
            ['resume' => true, 'locale' => 'de'],                                    // resume without k
            ['resume' => true, 'k' => $k, 't' => $t, 'locale' => 'de'],             // resume with t
            ['resume' => true, 'k' => $k, 'consentVersion' => $version, 'locale' => 'de'],
        ] as $body) {
            self::assertError($this->pub('join', $body), 400, 'validation_failed');
        }
        self::assertError($this->pub('join/check', '{"t":"short"}'), 400, 'validation_failed');
        self::assertError($this->pub('join/check', 'not json'), 400, 'validation_failed');
        self::assertError($this->pub('join/check', '[]'), 400, 'validation_failed');
    }

    public function testResumeAndLockAndEnded(): void
    {
        [$fid, $t, $version] = $this->setUpPerson();
        $join = $this->join($t, $version);
        $k = (string) $join['deviceKey'];
        $old = (string) $join['session'];

        Clock::advance('+1 minute');
        $resume = self::json($this->pub('join', ['resume' => true, 'k' => $k, 'locale' => 'de']));
        self::assertSame('active', $resume['status']);
        self::assertNotSame($old, $resume['session']);
        self::assertFalse($this->storeHas(self::sessionPath($old)), 'a new session replaces the old file');
        self::assertTrue($this->storeHas(self::sessionPath((string) $resume['session'])));

        $this->admin('POST', '/api/v1/admin/access/lock', ['locked' => true]);
        self::assertTrue($this->storeHas('locked'));
        self::assertSame(['status' => 'unavailable', 'reason' => 'locked'], self::json($this->pub('join', ['resume' => true, 'k' => $k, 'locale' => 'de'])));
        self::assertSame(['status' => 'unavailable', 'reason' => 'locked'], self::json($this->pub('join/check', ['t' => $t])));
        self::assertSame(['status' => 'unavailable', 'reason' => 'locked'], $this->call('me/hello', $k));

        self::assertSame(['status' => 'ended'], self::json($this->pub('join', ['resume' => true, 'k' => Tokens::token(), 'locale' => 'de'])));
        $this->admin('POST', '/api/v1/admin/access/lock', ['locked' => false, 'password' => self::ADMIN_PASSWORD]);
        $this->admin('POST', "/api/v1/admin/followers/$fid/revoke", new \stdClass());
        self::assertSame(['status' => 'ended'], self::json($this->pub('join', ['resume' => true, 'k' => $k, 'locale' => 'de'])));
        self::assertSame(['status' => 'ended'], $this->call('device/poll', $k));
        self::assertSame([], $this->sessionFiles($fid));
    }

    public function testActivatingWhileTheWriterIsBusyThenPollHandsOut(): void
    {
        [$fid, $t, $version] = $this->setUpPerson();
        // Another process holds the store lock: the request must not wait for it.
        $lock = fopen($this->tmpDir() . '/var/cache/store.lock', 'c');
        self::assertNotFalse($lock);
        flock($lock, LOCK_EX);
        try {
            $join = $this->join($t, $version);
            self::assertSame('activating', $join['status']);
            self::assertSame(3000, $join['pollAfterMs']);
            $k = (string) $join['deviceKey'];
            self::assertSame('activating', $this->call('device/poll', $k)['status']);
            self::assertNotNull($this->appDb()->scalar('SELECT pending_sid FROM devices WHERE follower_id = ?', [$fid]));
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
        Clock::advance('+3 seconds');
        $poll = $this->call('device/poll', $k);
        self::assertSame('active', $poll['status']);
        self::assertSame('/_/h/', $poll['handoff']);
        self::assertTrue($this->storeHas(self::sessionPath((string) $poll['session'])));
        self::assertNull($this->appDb()->scalar('SELECT pending_sid FROM devices WHERE follower_id = ?', [$fid]));
    }

    public function testCorsOnEveryAnswerIncludingErrorsAndLimits(): void
    {
        [, $t] = $this->setUpPerson();
        foreach ([
            $this->pub('join/check', ['t' => $t]),
            $this->pub('join/check', 'nope'),
            $this->pub('join/check', str_repeat('x', 9000)),
        ] as $res) {
            self::assertSame(self::SITE, $res->getHeaderLine('Access-Control-Allow-Origin'), (string) $res->getBody());
            self::assertSame('Content-Disposition, Retry-After', $res->getHeaderLine('Access-Control-Expose-Headers'));
            self::assertSame('', $res->getHeaderLine('Access-Control-Allow-Credentials'));
        }
        self::assertSame(413, $this->pub('join/check', str_repeat('x', 9000))->getStatusCode());

        // 60 per 10 minutes per IP across join/check, join and panic.
        for ($i = 0; $i < 60; ++$i) {
            $this->pub('join/check', ['t' => Tokens::token()], [], [], '198.51.100.99');
        }
        $limited = $this->pub('join/check', ['t' => Tokens::token()], [], [], '198.51.100.99');
        self::assertError($limited, 429, 'rate_limited');
        self::assertGreaterThan(0, (int) $limited->getHeaderLine('Retry-After'));
        self::assertSame(self::SITE, $limited->getHeaderLine('Access-Control-Allow-Origin'));
        self::assertSame(200, $this->pub('join/check', ['t' => Tokens::token()], [], [], '198.51.100.98')->getStatusCode());

        // Other origins get no CORS headers (the answer itself is the same).
        $evil = $this->pub('join/check', ['t' => Tokens::token()], ['Origin' => 'https://evil.example']);
        self::assertSame('', $evil->getHeaderLine('Access-Control-Allow-Origin'));
    }

    public function testLinkLimitAndGlobalCap(): void
    {
        [, $t] = $this->setUpPerson();
        for ($i = 0; $i < 30; ++$i) {
            self::assertSame(200, $this->pub('join/check', ['t' => $t], [], [], '198.51.100.' . (10 + $i))->getStatusCode());
        }
        self::assertError($this->pub('join/check', ['t' => $t], [], [], '198.51.100.200'), 429, 'rate_limited');

        // The global cap: fill the hour's bucket directly, then every public POST answers 503 busy.
        $limiter = $this->service(\Omw\Api\Infra\RateLimiter::class);
        while ($limiter->count('pub', '', 3600) < 1200) {
            $limiter->hit('pub', '', 100000, 3600);
        }
        $busy = $this->pub('join/check', ['t' => Tokens::token()], [], [], '198.51.100.201');
        self::assertError($busy, 503, 'busy');
        self::assertSame('60', $busy->getHeaderLine('Retry-After'));
        self::assertSame(self::SITE, $busy->getHeaderLine('Access-Control-Allow-Origin'));
        self::assertNotNull($this->appDb()->scalar("SELECT value FROM meta WHERE key = 'public_flood_at'"));
    }

    public function testApplicationJsonIsAcceptedAndPreflightStillWorks(): void
    {
        [, $t] = $this->setUpPerson();
        $res = $this->pub('join/check', ['t' => $t], ['Content-Type' => 'application/json']);
        self::assertSame('ok', self::json($res)['status']);
        $form = $this->pub('join/check', 't=x', ['Content-Type' => 'application/x-www-form-urlencoded']);
        self::assertError($form, 400, 'validation_failed');
        $pre = $this->request('OPTIONS', '/api/v1/public/join', null, ['Origin' => self::SITE, 'Access-Control-Request-Method' => 'POST']);
        self::assertSame(204, $pre->getStatusCode());
        self::assertSame(self::SITE, $pre->getHeaderLine('Access-Control-Allow-Origin'));
    }
}
