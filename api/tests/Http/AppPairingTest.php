<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Http;

use DI\Container;
use Omw\Api\Domain\Alerts\Notification;
use Omw\Api\Domain\Alerts\Notifier;
use Omw\Api\Domain\App\AppRateLimiter;
use Omw\Api\Domain\Auth\ApiTokens;
use Omw\Api\Infra\Clock;

/**
 * "Connect a phone": pairing codes (single use, 1-24 h, rate-limited), the capture token's narrow
 * reach (Q4 a: never the admin or backend routes), the owner's alert, Disconnect and expiry.
 */
final class AppPairingTest extends ApiTestCase
{
    use AppTestHelpers;

    /** @var list<Notification> */
    private array $sent = [];

    protected function setUp(): void
    {
        parent::setUp();
        $sent = &$this->sent;
        $container = $this->container();
        self::assertInstanceOf(Container::class, $container);
        $container->set(Notifier::class, new class ($sent) implements Notifier {
            /** @var list<Notification> */
            private array $sent;

            /** @param list<Notification> $sent */
            public function __construct(array &$sent)
            {
                $this->sent = &$sent;
            }

            public function send(Notification $notification): int
            {
                $this->sent[] = $notification;

                return count($this->sent) > 0 ? 1 : 0;
            }
        });
    }

    public function testATypedCodeOrTheLinkConnectsAPhoneOnce(): void
    {
        $created = $this->admin('POST', '/api/v1/admin/app-pairings', new \stdClass());
        self::assertSame(201, $created->getStatusCode(), (string) $created->getBody());
        $code = self::json($created);
        self::assertMatchesRegularExpression('/^omw:\/\/pair#[0-9A-HJKMNP-TV-Z]{26}$/', $code['link']);
        self::assertMatchesRegularExpression('/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/', $code['typedCode']);
        self::assertSame('2026-11-20T11:00:00.000Z', $code['expiresAt'], 'valid 1 h by default');

        $link = substr((string) $code['link'], strlen('omw://pair#'));
        $paired = $this->request('POST', '/api/v1/app/pair', self::pairBody($link));
        self::assertSame(201, $paired->getStatusCode(), (string) $paired->getBody());
        $body = self::json($paired);
        self::assertSame(['capture'], $body['info']['scopes']);
        self::assertSame('Pixel 8a', $body['info']['name']);
        self::assertSame('2027-05-19T10:00:00.000Z', $body['info']['expiresAt']);
        self::assertCount(1, $this->sent);
        self::assertStringContainsString('Pixel 8a', $this->sent[0]->message);

        // Single use: neither form works again.
        self::assertError($this->request('POST', '/api/v1/app/pair', self::pairBody($link)), 401, 'pairing_invalid');
        self::assertError($this->request('POST', '/api/v1/app/pair', self::pairBody(str_replace('-', '', (string) $code['typedCode']))), 401, 'pairing_invalid');

        $token = (string) $body['token'];
        self::assertSame(200, $this->phone($token, 'GET', '/api/v1/app/hints')->getStatusCode());
    }

    public function testCodesExpireAndANewCodeCancelsTheOpenOne(): void
    {
        $first = self::json($this->admin('POST', '/api/v1/admin/app-pairings', ['ttlMinutes' => 5]));
        $second = self::json($this->admin('POST', '/api/v1/admin/app-pairings', ['ttlMinutes' => 24 * 60]));
        self::assertSame('2026-11-21T10:00:00.000Z', $second['expiresAt']);
        self::assertError($this->request('POST', '/api/v1/app/pair', self::pairBody(str_replace('-', '', (string) $first['typedCode']))), 401, 'pairing_invalid');
        self::assertSame('2026-11-21T10:00:00.000Z', self::json($this->admin('GET', '/api/v1/admin/app-phones'))['openPairing']['expiresAt']);

        Clock::advance('+25 hours');
        self::assertError($this->request('POST', '/api/v1/app/pair', self::pairBody(str_replace('-', '', (string) $second['typedCode']))), 410, 'pairing_expired');
        self::assertNull(self::json($this->admin('GET', '/api/v1/admin/app-phones'))['openPairing']);

        self::assertError($this->admin('POST', '/api/v1/admin/app-pairings', ['ttlMinutes' => 2]), 422, 'validation_failed');
        self::assertError($this->admin('POST', '/api/v1/admin/app-pairings', ['ttlMinutes' => 24 * 60 + 1]), 422, 'validation_failed');
        self::assertSame([], $this->sent);
    }

    public function testGuessingCodesIsRateLimited(): void
    {
        $code = self::json($this->admin('POST', '/api/v1/admin/app-pairings', new \stdClass()));
        for ($i = 0; $i < AppRateLimiter::PAIR_FAILURES_PER_IP; ++$i) {
            self::assertError($this->request('POST', '/api/v1/app/pair', self::pairBody(sprintf('ZZZZZZ%02d', $i))), 401, 'pairing_invalid');
        }
        $blocked = $this->request('POST', '/api/v1/app/pair', self::pairBody(str_replace('-', '', (string) $code['typedCode'])));
        self::assertError($blocked, 429, 'rate_limited');
        self::assertGreaterThan(0, (int) $blocked->getHeaderLine('Retry-After'));
        // Another address is not blocked by this one.
        $other = $this->request('POST', '/api/v1/app/pair', self::pairBody(str_replace('-', '', (string) $code['typedCode'])), [], [], ['REMOTE_ADDR' => '198.51.100.9']);
        self::assertSame(201, $other->getStatusCode(), (string) $other->getBody());
    }

    public function testTheCaptureTokenReachesNothingButTheAppRoutes(): void
    {
        $token = $this->pairPhone();
        self::assertSame(401, $this->phone($token, 'GET', '/api/v1/admin/captures')->getStatusCode());
        self::assertSame(401, $this->phone($token, 'GET', '/api/v1/admin/tokens')->getStatusCode());
        self::assertSame(401, $this->phone($token, 'PATCH', '/api/v1/admin/settings', ['publish.mode' => 'instant'])->getStatusCode());
        self::assertSame(401, $this->phone($token, 'GET', '/api/v1/backend/changes')->getStatusCode());
        self::assertSame(401, $this->phone($token, 'GET', '/api/v1/backend/app/entries')->getStatusCode());
        self::assertSame(401, $this->phone($token, 'GET', '/api/v1/admin/app-phones')->getStatusCode());

        // And the other tokens do not reach the app routes.
        self::assertError($this->phone($this->backendToken(), 'GET', '/api/v1/app/hints'), 403, 'forbidden');
        $users = $this->service(\Omw\Api\Infra\Db::class)->scalar('SELECT id FROM users LIMIT 1');
        $adminApp = $this->service(ApiTokens::class)->create('app', 'admin app', null, (int) $users)['token'];
        self::assertError($this->phone($adminApp, 'GET', '/api/v1/app/hints'), 403, 'forbidden');
        self::assertError($this->request('GET', '/api/v1/app/hints'), 401, 'unauthorized');
        self::assertError($this->phone('omw_' . str_repeat('A', 43), 'GET', '/api/v1/app/hints'), 401, 'unauthorized');
    }

    public function testDisconnectRevokesThePhone(): void
    {
        $token = $this->pairPhone();
        $this->phone($token, 'POST', '/api/v1/app/entries', self::textEntry('01JD3ZQ8X4V7N2K5M9P0R6S8TW'));
        $list = self::json($this->admin('GET', '/api/v1/admin/app-phones'));
        self::assertCount(1, $list['items']);
        $phone = $list['items'][0];
        self::assertSame('Pixel 8a', $phone['name']);
        self::assertSame(['total' => 1, 'inInbox' => 1], $phone['entries']);
        self::assertSame(self::NOW, $phone['lastUsedAt']);
        self::assertTrue($list['archiveOnly']);
        self::assertSame(1024 * 1024 * 1024, $list['inbox']['maxBytes']);

        self::assertSame(204, $this->admin('DELETE', '/api/v1/admin/app-phones/' . $phone['id'])->getStatusCode());
        self::assertSame(204, $this->admin('DELETE', '/api/v1/admin/app-phones/' . $phone['id'])->getStatusCode(), 'twice');
        self::assertError($this->admin('DELETE', '/api/v1/admin/app-phones/999'), 404, 'not_found');
        self::assertError($this->phone($token, 'GET', '/api/v1/app/hints'), 401, 'token_revoked');
        self::assertNotNull(self::json($this->admin('GET', '/api/v1/admin/app-phones'))['items'][0]['revokedAt']);
        // Its entries stay in the inbox for the archive.
        self::assertCount(1, self::json($this->backend('GET', '/api/v1/backend/app/entries'))['items']);
    }

    public function testTheTokenExpiresUnlessUsedAndRequestsAreLimited(): void
    {
        $token = $this->pairPhone();
        $busy = $this->pairPhone('Second');
        for ($i = 0; $i < AppRateLimiter::REQUESTS_PER_PHONE; ++$i) {
            $this->phone($busy, 'GET', '/api/v1/app/hints');
        }
        $limited = $this->phone($busy, 'GET', '/api/v1/app/hints');
        self::assertError($limited, 429, 'rate_limited');
        self::assertGreaterThan(0, (int) $limited->getHeaderLine('Retry-After'));
        self::assertSame(200, $this->phone($token, 'GET', '/api/v1/app/hints')->getStatusCode(), 'per phone');
        Clock::advance('+61 seconds');
        self::assertSame(200, $this->phone($busy, 'GET', '/api/v1/app/hints')->getStatusCode(), 'the window ends');

        Clock::advance('+170 days');
        self::assertSame(200, $this->phone($token, 'GET', '/api/v1/app/hints')->getStatusCode(), 'use slides the expiry');
        Clock::advance('+170 days');
        self::assertSame(200, $this->phone($token, 'GET', '/api/v1/app/hints')->getStatusCode());
        Clock::advance('+181 days');
        self::assertError($this->phone($token, 'GET', '/api/v1/app/hints'), 401, 'unauthorized');
    }
}
