<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Http;

use Omw\Api\Domain\Auth\LoginThrottle;
use Omw\Api\Domain\Auth\Users;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;

/**
 * Login throttling (review L1-01, L1-07): the check and the record are one atomic step, so
 * interleaved attempts count each other; a known device (an IP with a successful login for the
 * e-mail within 30 days) is exempt from the per-e-mail block but not from the per-IP limit.
 */
final class LoginThrottleTest extends ApiTestCase
{
    private const IP = '198.51.100.20';

    public function testInterleavedAttemptsNeverExceedThePerIpLimit(): void
    {
        $this->createAdmin();
        $throttle = $this->service(LoginThrottle::class);
        $admitted = 0;
        // Two throttle steps before any password check, over and over (what concurrent requests
        // look like): every begin() sees the provisional failures of the others.
        for ($i = 0; $i < 15; ++$i) {
            $a = $throttle->begin(self::IP, "guess$i@example.org");
            $b = $throttle->begin(self::IP, "guess$i@example.org");
            foreach ([$a, $b] as $attempt) {
                if ($attempt['attemptId'] !== null) {
                    ++$admitted;
                } else {
                    self::assertGreaterThan(0, $attempt['retryAfter']);
                }
            }
            Clock::advance('+1 second');
        }
        self::assertSame(LoginThrottle::MAX_PER_IP, $admitted);
        self::assertSame(LoginThrottle::MAX_PER_IP, $this->failures(self::IP));
    }

    public function testInterleavedAttemptsAcrossIpsNeverExceedThePerEmailLimit(): void
    {
        $this->createAdmin();
        $throttle = $this->service(LoginThrottle::class);
        $admitted = 0;
        for ($i = 0; $i < 25; ++$i) {
            foreach ([$throttle->begin("192.0.2.$i", self::ADMIN_EMAIL), $throttle->begin("203.0.113.$i", self::ADMIN_EMAIL)] as $attempt) {
                $admitted += $attempt['attemptId'] === null ? 0 : 1;
            }
        }
        self::assertSame(LoginThrottle::MAX_PER_EMAIL, $admitted);
        self::assertSame(LoginThrottle::MAX_PER_EMAIL, (int) $this->service(Db::class)->scalar('SELECT COUNT(*) FROM login_attempts WHERE email = ? AND success = 0', [self::ADMIN_EMAIL]));
    }

    public function testASuccessfulLoginFlipsItsProvisionalRow(): void
    {
        $this->createAdmin();
        self::assertSame(200, $this->loginFrom(self::IP)->getStatusCode());
        $rows = $this->service(Db::class)->all('SELECT email, ip, success FROM login_attempts');
        self::assertSame([['email' => self::ADMIN_EMAIL, 'ip' => self::IP, 'success' => 1]], $rows);
    }

    public function testAKnownDeviceLogsInWhileTheEmailIsBlocked(): void
    {
        $this->createAdmin();
        $this->loggedInBefore(self::IP); // the owner logged in from home once

        Clock::advance('+2 days');
        for ($i = 0; $i < LoginThrottle::MAX_PER_EMAIL; ++$i) {
            self::assertError($this->loginFrom('203.0.113.' . ($i + 1), "guess $i"), 401, 'unauthorized');
        }
        // The e-mail is blocked for unknown IPs, even with the right password ...
        self::assertError($this->loginFrom('192.0.2.50'), 429, 'rate_limited');
        // ... but not for the owner's known device.
        self::assertSame(200, $this->loginFrom(self::IP)->getStatusCode());
    }

    public function testTheKnownDeviceStillHasThePerIpLimit(): void
    {
        $this->createAdmin();
        $this->loggedInBefore(self::IP);
        Clock::advance('+1 minute'); // only failures after the last success count
        for ($i = 0; $i < LoginThrottle::MAX_PER_IP; ++$i) {
            self::assertError($this->loginFrom(self::IP, "typo $i"), 401, 'unauthorized');
        }
        self::assertError($this->loginFrom(self::IP), 429, 'rate_limited');
    }

    public function testAKnownDeviceExpiresAfter30Days(): void
    {
        $this->createAdmin();
        $this->loggedInBefore(self::IP);
        Clock::advance('+' . (LoginThrottle::KNOWN_DEVICE_DAYS + 1) . ' days');
        for ($i = 0; $i < LoginThrottle::MAX_PER_EMAIL; ++$i) {
            $this->loginFrom('203.0.113.' . ($i + 1), "guess $i");
        }
        self::assertError($this->loginFrom(self::IP), 429, 'rate_limited');
    }

    public function testKnownDevicesAreBoundToTheEmail(): void
    {
        $this->createAdmin();
        $this->service(Users::class)->create('second@example.org', \Omw\Api\Domain\Auth\Passwords::hash(self::ADMIN_PASSWORD));
        self::assertSame(200, $this->loginFrom(self::IP, self::ADMIN_PASSWORD, 'second@example.org')->getStatusCode());
        Clock::advance('+1 minute');
        for ($i = 0; $i < LoginThrottle::MAX_PER_EMAIL; ++$i) {
            $this->loginFrom('203.0.113.' . ($i + 1), "guess $i");
        }
        // A login as someone else does not make the IP a known device of the owner.
        self::assertError($this->loginFrom(self::IP), 429, 'rate_limited');
    }

    public function testChangingTheEmailKeepsSessionsAndKnownDevices(): void
    {
        $this->login();
        $this->cheapHash(); // the login upgraded it to Argon2id
        $this->loggedInBefore(self::IP);
        $result = $this->service(Users::class)->changeEmail(self::ADMIN_EMAIL, 'Hidden.Owner@Example.org');
        self::assertTrue($result['changed']);

        self::assertSame(200, $this->admin('GET', '/api/v1/admin/me')->getStatusCode(), 'the existing session still works');
        self::assertSame('hidden.owner@example.org', self::json($this->admin('GET', '/api/v1/admin/me'))['email']);
        self::assertError($this->loginFrom('192.0.2.1'), 401, 'unauthorized'); // old e-mail
        self::assertSame(200, $this->loginFrom('192.0.2.1', self::ADMIN_PASSWORD, 'hidden.owner@example.org')->getStatusCode());
        $this->cheapHash();

        // The home IP stays a known device for the new e-mail.
        Clock::advance('+1 minute');
        for ($i = 0; $i < LoginThrottle::MAX_PER_EMAIL; ++$i) {
            $this->loginFrom('198.18.0.' . ($i + 1), "guess $i", 'hidden.owner@example.org');
        }
        self::assertError($this->loginFrom('192.0.2.99', self::ADMIN_PASSWORD, 'hidden.owner@example.org'), 429, 'rate_limited');
        self::assertSame(200, $this->loginFrom(self::IP, self::ADMIN_PASSWORD, 'hidden.owner@example.org')->getStatusCode());
    }

    public function testChangeEmailValidation(): void
    {
        $this->createAdmin();
        $users = $this->service(Users::class);
        $users->create('other@example.org', 'x');
        foreach ([['nobody@example.org', 'new@example.org'], [self::ADMIN_EMAIL, 'not-an-email'], [self::ADMIN_EMAIL, 'OTHER@example.org']] as [$from, $to]) {
            try {
                $users->changeEmail($from, $to);
                self::fail("accepted $from -> $to");
            } catch (\InvalidArgumentException) {
            }
        }
        self::assertSame(['id' => 1, 'changed' => false], $users->changeEmail(self::ADMIN_EMAIL, strtoupper(self::ADMIN_EMAIL)));
        self::assertNotNull($users->findByEmail(self::ADMIN_EMAIL));
    }

    /**
     * The admin with a cheap bcrypt hash: these tests run well over a hundred password checks
     * (a successful login upgrades it to the real algorithm, see Sessions::login()).
     */
    protected function createAdmin(string $email = self::ADMIN_EMAIL, string $password = self::ADMIN_PASSWORD): int
    {
        $this->migrate();

        return $this->service(Users::class)->create($email, password_hash($password, PASSWORD_BCRYPT, ['cost' => 4]), 'Owner');
    }

    /** The rows a successful login leaves (see testASuccessfulLoginFlipsItsProvisionalRow), without a password check. */
    private function loggedInBefore(string $ip, string $email = self::ADMIN_EMAIL): void
    {
        $this->service(LoginThrottle::class)->record($ip, $email, true);
    }

    private function cheapHash(): void
    {
        $this->service(Db::class)->exec('UPDATE users SET password_hash = ?', [password_hash(self::ADMIN_PASSWORD, PASSWORD_BCRYPT, ['cost' => 4])]);
    }

    private function loginFrom(string $ip, string $password = self::ADMIN_PASSWORD, string $email = self::ADMIN_EMAIL): \Psr\Http\Message\ResponseInterface
    {
        return $this->request('POST', '/api/v1/admin/session', ['email' => $email, 'password' => $password], [], [], ['REMOTE_ADDR' => $ip]);
    }

    private function failures(string $ip): int
    {
        return (int) $this->service(Db::class)->scalar('SELECT COUNT(*) FROM login_attempts WHERE ip = ? AND success = 0', [$ip]);
    }
}
