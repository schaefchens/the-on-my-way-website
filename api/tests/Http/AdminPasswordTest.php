<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Http;

use Omw\Api\Domain\Auth\ApiTokens;
use Omw\Api\Domain\Auth\LoginThrottle;
use Omw\Api\Domain\Auth\Passwords;
use Omw\Api\Domain\Auth\Sessions;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;

/**
 * Change password (owner addition, spec-wave5 §3.12): wrong current password → 403
 * wrong_password and a failed login; the 12-character minimum; other sessions end and the
 * current one stays; app tokens stay with revokeAppTokens false and end with true; backend
 * tokens always stay; 429 at the login limits; app tokens may not change the password.
 */
final class AdminPasswordTest extends ApiTestCase
{
    private const NEW = 'a brand new passphrase';

    public function testChangesThePasswordAndEndsOtherSessions(): void
    {
        $this->login();
        $tokens = $this->service(ApiTokens::class);
        $db = $this->service(Db::class);
        $userId = (int) $db->scalar('SELECT id FROM users');
        $other = $tokens->create('session', 'other phone', null, $userId, Clock::iso(Clock::now()->modify('+30 days')))['token'];
        $app = $tokens->create('app', 'shortcut', null, $userId)['token'];
        $backend = $tokens->create('backend', 'mac')['token'];

        $res = $this->admin('PUT', '/api/v1/admin/me/password', ['currentPassword' => self::ADMIN_PASSWORD, 'newPassword' => self::NEW, 'revokeAppTokens' => false]);
        self::assertSame(204, $res->getStatusCode(), (string) $res->getBody());
        self::assertTrue(Passwords::verify(self::NEW, (string) $db->scalar('SELECT password_hash FROM users')));
        self::assertSame(200, $this->admin('GET', '/api/v1/admin/me')->getStatusCode(), 'the current session stays');
        self::assertError($this->request('GET', '/api/v1/admin/me', null, [], [Sessions::COOKIE => $other]), 401, 'unauthorized');
        self::assertSame(200, $this->request('GET', '/api/v1/admin/me', null, ['Authorization' => 'Bearer ' . $app])->getStatusCode(), 'app tokens stay');
        self::assertSame(200, $this->request('GET', '/api/v1/backend/changes', null, ['Authorization' => 'Bearer ' . $backend])->getStatusCode());

        // Old password no longer works; the new one does.
        self::assertError($this->request('POST', '/api/v1/admin/session', ['email' => self::ADMIN_EMAIL, 'password' => self::ADMIN_PASSWORD], [], [], ['REMOTE_ADDR' => '192.0.2.1']), 401, 'unauthorized');
        self::assertSame(200, $this->request('POST', '/api/v1/admin/session', ['email' => self::ADMIN_EMAIL, 'password' => self::NEW], [], [], ['REMOTE_ADDR' => '192.0.2.2'])->getStatusCode());

        // revokeAppTokens: true ends app tokens, never backend tokens.
        $res = $this->admin('PUT', '/api/v1/admin/me/password', ['currentPassword' => self::NEW, 'newPassword' => 'another new passphrase', 'revokeAppTokens' => true]);
        self::assertSame(204, $res->getStatusCode(), (string) $res->getBody());
        self::assertError($this->request('GET', '/api/v1/admin/me', null, ['Authorization' => 'Bearer ' . $app]), 401, 'unauthorized');
        self::assertSame(200, $this->request('GET', '/api/v1/backend/changes', null, ['Authorization' => 'Bearer ' . $backend])->getStatusCode());
    }

    public function testRefusals(): void
    {
        $this->login();
        Clock::advance('+1 second');
        $db = $this->service(Db::class);
        $res = $this->admin('PUT', '/api/v1/admin/me/password', ['currentPassword' => 'not my password', 'newPassword' => self::NEW, 'revokeAppTokens' => false]);
        self::assertError($res, 403, 'wrong_password');
        self::assertSame(1, (int) $db->scalar('SELECT COUNT(*) FROM login_attempts WHERE success = 0'), 'recorded as a failed login');

        self::assertError($this->admin('PUT', '/api/v1/admin/me/password', ['currentPassword' => self::ADMIN_PASSWORD, 'newPassword' => 'elevenchars', 'revokeAppTokens' => false]), 422, 'validation_failed');
        self::assertError($this->admin('PUT', '/api/v1/admin/me/password', ['currentPassword' => self::ADMIN_PASSWORD, 'newPassword' => self::ADMIN_PASSWORD, 'revokeAppTokens' => false]), 422, 'validation_failed');
        self::assertError($this->admin('PUT', '/api/v1/admin/me/password', ['currentPassword' => self::ADMIN_PASSWORD, 'newPassword' => 'OWNER@example.org', 'revokeAppTokens' => false]), 422, 'validation_failed');
        self::assertError($this->admin('PUT', '/api/v1/admin/me/password', ['currentPassword' => self::ADMIN_PASSWORD, 'newPassword' => self::NEW]), 422, 'validation_failed');
        // CSRF is required like for every mutating admin request.
        self::assertError($this->request('PUT', '/api/v1/admin/me/password', ['currentPassword' => self::ADMIN_PASSWORD, 'newPassword' => self::NEW, 'revokeAppTokens' => false], [], [Sessions::COOKIE => (string) $this->sessionCookie]), 403, 'csrf');
        self::assertSame(12, Passwords::MIN_LENGTH);
        self::assertNotNull(Passwords::weakness('elevenchars'));
        self::assertNull(Passwords::weakness('twelve chars'));
    }

    public function testRateLimitedLikeALogin(): void
    {
        $this->login();
        Clock::advance('+1 second');
        for ($i = 0; $i < LoginThrottle::MAX_PER_IP; ++$i) {
            $this->admin('PUT', '/api/v1/admin/me/password', ['currentPassword' => 'wrong password ' . $i, 'newPassword' => self::NEW, 'revokeAppTokens' => false]);
        }
        $limited = $this->admin('PUT', '/api/v1/admin/me/password', ['currentPassword' => self::ADMIN_PASSWORD, 'newPassword' => self::NEW, 'revokeAppTokens' => false]);
        self::assertError($limited, 429, 'rate_limited');
        self::assertGreaterThan(0, (int) $limited->getHeaderLine('Retry-After'));
    }

    public function testAppTokensCannotChangeThePassword(): void
    {
        $userId = $this->createAdmin();
        $app = $this->service(ApiTokens::class)->create('app', 'shortcut', null, $userId)['token'];
        self::assertError($this->request('PUT', '/api/v1/admin/me/password', ['currentPassword' => self::ADMIN_PASSWORD, 'newPassword' => self::NEW, 'revokeAppTokens' => false], ['Authorization' => 'Bearer ' . $app]), 403, 'forbidden');
    }
}
