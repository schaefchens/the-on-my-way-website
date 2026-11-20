<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Http;

use DI\Container;
use InvalidArgumentException;
use Omw\Api\Config;
use Omw\Api\Domain\Auth\Sessions;
use Omw\Api\Http\SessionCookie;
use PHPUnit\Framework\Attributes\DataProvider;
use Psr\Http\Message\ResponseInterface;

/**
 * The local-http fallback of the admin session cookie (Http\SessionCookie): only with
 * APP_ENV=development + DEV_INSECURE_COOKIE=true + PHP's built-in server + plain http + a loopback
 * client. Every other combination keeps the __Host- cookie, and production refuses the flag.
 */
final class DevSessionCookieTest extends ApiTestCase
{
    private const LOOPBACK = ['REMOTE_ADDR' => '127.0.0.1'];

    public function testTheFlagIsRefusedOutsideDevelopment(): void
    {
        foreach (['production', 'test'] as $env) {
            try {
                Config::fromArray(self::rootDir(), ['APP_ENV' => $env, 'DEV_INSECURE_COOKIE' => 'true']);
                self::fail("DEV_INSECURE_COOKIE accepted with APP_ENV=$env");
            } catch (InvalidArgumentException $e) {
                self::assertStringContainsString('DEV_INSECURE_COOKIE', $e->getMessage());
            }
        }
        // Production default and an explicit "false" are fine.
        self::assertFalse(Config::fromArray(self::rootDir(), ['APP_ENV' => 'production', 'DEV_INSECURE_COOKIE' => 'false'])->devInsecureCookie);
        self::assertTrue(Config::fromArray(self::rootDir(), ['APP_ENV' => 'development', 'DEV_INSECURE_COOKIE' => 'true'])->devInsecureCookie);
    }

    public function testDevCookieRoundTripOnTheBuiltInServer(): void
    {
        $this->bootDev(sapi: 'cli-server');
        $this->createAdmin();

        $login = $this->request('POST', '/api/v1/admin/session', ['email' => self::ADMIN_EMAIL, 'password' => self::ADMIN_PASSWORD], [], [], self::LOOPBACK);
        self::assertSame(200, $login->getStatusCode(), (string) $login->getBody());
        $setCookie = $login->getHeaderLine('Set-Cookie');
        self::assertStringStartsWith(SessionCookie::DEV_NAME . '=omw_', $setCookie);
        foreach (['Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=2592000'] as $attribute) {
            self::assertStringContainsString($attribute, $setCookie);
        }
        self::assertStringNotContainsString('Secure', $setCookie);
        self::assertStringNotContainsString(Sessions::COOKIE, $setCookie);
        $token = self::cookieValue($login, SessionCookie::DEV_NAME);
        $csrf = (string) self::json($login)['csrfToken'];

        $cookies = [SessionCookie::DEV_NAME => $token];
        self::assertSame(200, $this->request('GET', '/api/v1/admin/me', null, [], $cookies, self::LOOPBACK)->getStatusCode());
        // The __Host- name is not read in this mode.
        self::assertError($this->request('GET', '/api/v1/admin/me', null, [], [Sessions::COOKIE => $token], self::LOOPBACK), 401, 'unauthorized');
        // CSRF is still enforced.
        $noCsrf = $this->request('PATCH', '/api/v1/admin/settings', ['publish.mode' => 'instant'], [], $cookies, self::LOOPBACK);
        self::assertError($noCsrf, 403, 'csrf');

        $logout = $this->request('DELETE', '/api/v1/admin/session', null, ['X-CSRF-Token' => $csrf], $cookies, self::LOOPBACK);
        self::assertSame(204, $logout->getStatusCode());
        self::assertStringStartsWith(SessionCookie::DEV_NAME . '=; Max-Age=0', $logout->getHeaderLine('Set-Cookie'));
        self::assertError($this->request('GET', '/api/v1/admin/me', null, [], $cookies, self::LOOPBACK), 401, 'unauthorized');
    }

    /** @return iterable<string, array{string, array<string, string>, string}> */
    public static function secureCases(): iterable
    {
        yield 'php-fpm (any real web server)' => ['fpm-fcgi', self::LOOPBACK, 'http://127.0.0.1/api/v1/admin/session'];
        yield 'apache module' => ['apache2handler', self::LOOPBACK, 'http://127.0.0.1/api/v1/admin/session'];
        yield 'remote client' => ['cli-server', ['REMOTE_ADDR' => '192.168.1.20'], 'http://192.168.1.10/api/v1/admin/session'];
        yield 'https' => ['cli-server', self::LOOPBACK, 'https://127.0.0.1/api/v1/admin/session'];
        yield 'HTTPS server param' => ['cli-server', self::LOOPBACK + ['HTTPS' => 'on'], 'http://127.0.0.1/api/v1/admin/session'];
    }

    /** @param array<string, string> $server */
    #[DataProvider('secureCases')]
    public function testEverythingElseKeepsTheHostCookie(string $sapi, array $server, string $uri): void
    {
        $this->bootDev(sapi: $sapi);
        $this->createAdmin();
        $login = $this->request('POST', $uri, ['email' => self::ADMIN_EMAIL, 'password' => self::ADMIN_PASSWORD], [], [], $server);
        self::assertSame(200, $login->getStatusCode(), (string) $login->getBody());
        $this->assertSecureCookie($login);
    }

    public function testDevelopmentWithoutTheFlagKeepsTheHostCookie(): void
    {
        $this->boot(['APP_ENV' => 'development']);
        $this->setSapi('cli-server');
        $this->createAdmin();
        $login = $this->request('POST', '/api/v1/admin/session', ['email' => self::ADMIN_EMAIL, 'password' => self::ADMIN_PASSWORD], [], [], self::LOOPBACK);
        $this->assertSecureCookie($login);
    }

    public function testLoopbackDetection(): void
    {
        foreach (['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1'] as $ip) {
            self::assertTrue(SessionCookie::isLoopback($ip), $ip);
        }
        foreach (['0.0.0.0', '10.0.0.1', '128.0.0.1', '::2', '127.0.0.1.example.org', '', 'localhost'] as $ip) {
            self::assertFalse(SessionCookie::isLoopback($ip), $ip);
        }
    }

    private function bootDev(string $sapi): void
    {
        $this->boot(['APP_ENV' => 'development', 'DEV_INSECURE_COOKIE' => 'true']);
        $this->setSapi($sapi);
    }

    /** Replaces the SessionCookie service with one that sees $sapi as PHP_SAPI. */
    private function setSapi(string $sapi): void
    {
        $container = $this->container();
        self::assertInstanceOf(Container::class, $container);
        $container->set(SessionCookie::class, new SessionCookie($this->service(Config::class), $sapi));
    }

    private function assertSecureCookie(ResponseInterface $login): void
    {
        $setCookie = $login->getHeaderLine('Set-Cookie');
        self::assertStringStartsWith(Sessions::COOKIE . '=omw_', $setCookie);
        self::assertStringContainsString('Secure', $setCookie);
    }
}
