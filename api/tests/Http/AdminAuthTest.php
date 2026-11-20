<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Http;

use Omw\Api\Domain\Auth\ApiTokens;
use Omw\Api\Domain\Auth\Csrf;
use Omw\Api\Domain\Auth\LoginThrottle;
use Omw\Api\Domain\Auth\Sessions;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;

/**
 * Admin session login/logout, generic 401s, login rate limiting, cookie attributes, CSRF,
 * app bearer tokens, sliding session expiry.
 */
final class AdminAuthTest extends ApiTestCase
{
    public function testLoginSetsAHostOnlySecureCookieAndReturnsMe(): void
    {
        $this->createAdmin();
        $response = $this->request('POST', '/api/v1/admin/session', ['email' => 'Owner@Example.ORG', 'password' => self::ADMIN_PASSWORD]);

        self::assertSame(200, $response->getStatusCode(), (string) $response->getBody());
        $me = self::json($response);
        self::assertSame(self::ADMIN_EMAIL, $me['email']);
        self::assertSame('Owner', $me['displayName']);
        $cookie = $response->getHeaderLine('Set-Cookie');
        self::assertStringStartsWith(Sessions::COOKIE . '=omw_', $cookie);
        foreach (['Path=/', 'Secure', 'HttpOnly', 'SameSite=Strict', 'Max-Age=2592000'] as $attribute) {
            self::assertStringContainsString($attribute, $cookie);
        }
        self::assertStringNotContainsString('Domain=', $cookie);
        $token = self::cookieValue($response, Sessions::COOKIE);
        self::assertSame(Csrf::tokenFor($token), $me['csrfToken']);
        self::assertSame('no-store', $response->getHeaderLine('Cache-Control'));

        // /me with the cookie; same CSRF token (derived, stable).
        $meAgain = $this->request('GET', '/api/v1/admin/me', null, [], [Sessions::COOKIE => $token]);
        self::assertSame(200, $meAgain->getStatusCode());
        self::assertSame($me['csrfToken'], self::json($meAgain)['csrfToken']);

        // Only a sha256 of the session token is stored.
        $db = $this->service(Db::class);
        self::assertSame(ApiTokens::hash($token), $db->scalar("SELECT token_hash FROM api_tokens WHERE kind = 'session'"));
        self::assertSame(self::NOW, $db->scalar('SELECT last_login_at FROM users'));
    }

    public function testEveryLoginFailureIsTheSameGeneric401(): void
    {
        $this->createAdmin();
        $cases = [
            ['email' => self::ADMIN_EMAIL, 'password' => 'wrong password'],
            ['email' => 'nobody@example.org', 'password' => self::ADMIN_PASSWORD],
            ['email' => 'not-an-email', 'password' => 'x'],
            ['email' => self::ADMIN_EMAIL],
            ['email' => self::ADMIN_EMAIL, 'password' => self::ADMIN_PASSWORD, 'extra' => true],
            '[]',
            '{broken',
        ];
        $bodies = [];
        foreach ($cases as $case) {
            $response = $this->request('POST', '/api/v1/admin/session', $case);
            self::assertError($response, 401, 'unauthorized');
            self::assertSame([], $response->getHeader('Set-Cookie'));
            $bodies[] = (string) $response->getBody();
        }
        self::assertCount(1, array_unique($bodies), 'no account enumeration via messages');
        self::assertSame(count($cases), (int) $this->service(Db::class)->scalar('SELECT COUNT(*) FROM login_attempts WHERE success = 0'));
    }

    public function testLoginIsRateLimitedPerIp(): void
    {
        $this->createAdmin();
        for ($i = 0; $i < LoginThrottle::MAX_PER_IP; ++$i) {
            self::assertError($this->request('POST', '/api/v1/admin/session', ['email' => "x$i@example.org", 'password' => 'nope']), 401, 'unauthorized');
            Clock::advance('+10 seconds');
        }
        // Even the right password is refused now (429 + Retry-After), and the refusal is not recorded.
        $limited = $this->request('POST', '/api/v1/admin/session', ['email' => self::ADMIN_EMAIL, 'password' => self::ADMIN_PASSWORD]);
        self::assertError($limited, 429, 'rate_limited');
        $retryAfter = (int) $limited->getHeaderLine('Retry-After');
        self::assertGreaterThan(0, $retryAfter);
        self::assertLessThanOrEqual(LoginThrottle::IP_WINDOW, $retryAfter);
        self::assertSame(LoginThrottle::MAX_PER_IP, (int) $this->service(Db::class)->scalar('SELECT COUNT(*) FROM login_attempts'));

        // Another IP is not affected; the limit ends after the window.
        $other = $this->request('POST', '/api/v1/admin/session', ['email' => self::ADMIN_EMAIL, 'password' => self::ADMIN_PASSWORD], [], [], ['REMOTE_ADDR' => '198.51.100.1']);
        self::assertSame(200, $other->getStatusCode());
        Clock::advance('+' . $retryAfter . ' seconds');
        self::assertSame(200, $this->request('POST', '/api/v1/admin/session', ['email' => self::ADMIN_EMAIL, 'password' => self::ADMIN_PASSWORD])->getStatusCode());
    }

    public function testLoginIsRateLimitedPerEmailAcrossIps(): void
    {
        $this->createAdmin();
        for ($i = 0; $i < LoginThrottle::MAX_PER_EMAIL; ++$i) {
            $ip = '198.51.100.' . ($i + 1);
            self::assertError($this->request('POST', '/api/v1/admin/session', ['email' => self::ADMIN_EMAIL, 'password' => "guess $i"], [], [], ['REMOTE_ADDR' => $ip]), 401, 'unauthorized');
        }
        self::assertError($this->request('POST', '/api/v1/admin/session', ['email' => self::ADMIN_EMAIL, 'password' => self::ADMIN_PASSWORD], [], [], ['REMOTE_ADDR' => '192.0.2.99']), 429, 'rate_limited');
        Clock::advance('+61 minutes');
        self::assertSame(200, $this->request('POST', '/api/v1/admin/session', ['email' => self::ADMIN_EMAIL, 'password' => self::ADMIN_PASSWORD], [], [], ['REMOTE_ADDR' => '192.0.2.99'])->getStatusCode());
    }

    public function testAdminEndpointsNeedASession(): void
    {
        $this->migrate();
        foreach (['/api/v1/admin/me', '/api/v1/admin/captures', '/api/v1/admin/settings', '/api/v1/admin/status', '/api/v1/admin/days', '/api/v1/admin/doctor'] as $path) {
            self::assertError($this->request('GET', $path), 401, 'unauthorized');
        }
        $stale = $this->request('GET', '/api/v1/admin/me', null, [], [Sessions::COOKIE => 'omw_' . str_repeat('x', 43)]);
        self::assertError($stale, 401, 'unauthorized');
        self::assertStringContainsString('Max-Age=0', $stale->getHeaderLine('Set-Cookie'), 'a dead cookie is cleared');
    }

    public function testMutatingRequestsNeedTheCsrfHeader(): void
    {
        $this->login();
        $cookies = [Sessions::COOKIE => (string) $this->sessionCookie];
        $body = ['site.title' => 'Hi'];
        self::assertError($this->request('PATCH', '/api/v1/admin/settings', $body, [], $cookies), 403, 'csrf');
        self::assertError($this->request('PATCH', '/api/v1/admin/settings', $body, ['X-CSRF-Token' => 'nope'], $cookies), 403, 'csrf');
        self::assertSame(200, $this->request('PATCH', '/api/v1/admin/settings', $body, ['X-CSRF-Token' => (string) $this->csrf], $cookies)->getStatusCode());
        // Safe methods need none.
        self::assertSame(200, $this->request('GET', '/api/v1/admin/settings', null, [], $cookies)->getStatusCode());
        // The CSRF token of another session does not work.
        self::assertError($this->request('PATCH', '/api/v1/admin/settings', $body, ['X-CSRF-Token' => Csrf::tokenFor('omw_other')], $cookies), 403, 'csrf');
    }

    public function testLogoutRevokesTheSession(): void
    {
        $this->login();
        $cookies = [Sessions::COOKIE => (string) $this->sessionCookie];
        self::assertError($this->request('DELETE', '/api/v1/admin/session', null, [], $cookies), 403, 'csrf');

        $logout = $this->request('DELETE', '/api/v1/admin/session', null, ['X-CSRF-Token' => (string) $this->csrf], $cookies);
        self::assertSame(204, $logout->getStatusCode());
        self::assertStringContainsString('Max-Age=0', $logout->getHeaderLine('Set-Cookie'));
        self::assertError($this->request('GET', '/api/v1/admin/me', null, [], $cookies), 401, 'unauthorized');

        // Logging out again (or without a cookie) is fine.
        self::assertSame(204, $this->request('DELETE', '/api/v1/admin/session', null, [], $cookies)->getStatusCode());
        self::assertSame(204, $this->request('DELETE', '/api/v1/admin/session')->getStatusCode());
    }

    public function testAppTokensUseBearerWithoutCsrf(): void
    {
        $userId = $this->createAdmin();
        $token = $this->service(ApiTokens::class)->create('app', 'iphone', null, $userId)['token'];
        $headers = ['Authorization' => 'Bearer ' . $token];

        $me = $this->request('GET', '/api/v1/admin/me', null, $headers);
        self::assertSame(200, $me->getStatusCode());
        self::assertSame(self::ADMIN_EMAIL, self::json($me)['email']);
        self::assertSame(200, $this->request('PATCH', '/api/v1/admin/settings', ['site.title' => 'From the app'], $headers)->getStatusCode());

        // A backend token is not an admin token.
        $backend = $this->service(ApiTokens::class)->create('backend', 'home')['token'];
        self::assertError($this->request('GET', '/api/v1/admin/me', null, ['Authorization' => 'Bearer ' . $backend]), 403, 'forbidden');
    }

    public function testSessionsSlideAndExpire(): void
    {
        $this->login();
        $cookies = [Sessions::COOKIE => (string) $this->sessionCookie];
        $db = $this->service(Db::class);
        self::assertSame('2026-12-20T10:00:00.000Z', $db->scalar("SELECT expires_at FROM api_tokens WHERE kind = 'session'"));

        // Within the first day: no extension, no cookie refresh.
        Clock::advance('+2 hours');
        self::assertSame([], $this->request('GET', '/api/v1/admin/me', null, [], $cookies)->getHeader('Set-Cookie'));

        // Later use extends the session and refreshes the cookie.
        Clock::advance('+3 days');
        $extended = $this->request('GET', '/api/v1/admin/me', null, [], $cookies);
        self::assertSame(200, $extended->getStatusCode());
        self::assertStringContainsString('Max-Age=2592000', $extended->getHeaderLine('Set-Cookie'));
        self::assertSame('2026-12-23T12:00:00.000Z', $db->scalar("SELECT expires_at FROM api_tokens WHERE kind = 'session'"));

        // Unused for longer than SESSION_DAYS: gone.
        Clock::advance('+31 days');
        self::assertError($this->request('GET', '/api/v1/admin/me', null, [], $cookies), 401, 'unauthorized');
    }

    public function testPasswordChangeRevokesSessions(): void
    {
        $this->login();
        $cookies = [Sessions::COOKIE => (string) $this->sessionCookie];
        $users = $this->service(\Omw\Api\Domain\Auth\Users::class);
        $user = $users->findByEmail(self::ADMIN_EMAIL);
        self::assertNotNull($user);
        $users->setPassword($user['id'], \Omw\Api\Domain\Auth\Passwords::hash('another long password'));
        self::assertError($this->request('GET', '/api/v1/admin/me', null, [], $cookies), 401, 'unauthorized');
    }
}
