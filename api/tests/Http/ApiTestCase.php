<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Http;

use Omw\Api\App;
use Omw\Api\Domain\Auth\ApiTokens;
use Omw\Api\Domain\Auth\Passwords;
use Omw\Api\Domain\Auth\Sessions;
use Omw\Api\Domain\Auth\Users;
use Omw\Api\Domain\Ids;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;
use Omw\Api\Tests\TestCase;
use Psr\Container\ContainerInterface;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\UploadedFileInterface;
use Slim\App as SlimApp;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Factory\StreamFactory;

/**
 * Drives the real Slim app (middleware, routing, auth, error handler) with PSR-7 requests.
 * APP_ENV=test makes the Responder validate every contract response against api/schemas, so
 * each endpoint test is also a contract test. The clock is frozen (Clock::freeze).
 */
abstract class ApiTestCase extends TestCase
{
    public const NOW = '2026-11-20T10:00:00.000Z';
    public const ADMIN_EMAIL = 'owner@example.org';
    public const ADMIN_PASSWORD = 'correct horse battery staple';

    /** @var SlimApp<ContainerInterface>|null */
    private ?SlimApp $app = null;
    private ?ContainerInterface $container = null;
    protected ?string $sessionCookie = null;
    protected ?string $csrf = null;
    protected ?string $backendToken = null;

    protected function setUp(): void
    {
        parent::setUp();
        Clock::freeze(self::NOW);
    }

    protected function tearDown(): void
    {
        Clock::unfreeze();
        $this->container?->get(Db::class)->close();
        $this->app = null;
        $this->container = null;
        parent::tearDown();
    }

    /** @param array<string, string> $env */
    protected function boot(array $env = []): void
    {
        $config = $this->config(array_merge(['BASE_PATH' => ''], $env));
        $this->container = App::buildContainer($config);
        $this->app = App::create($config, [], $this->container);
    }

    /** @return SlimApp<ContainerInterface> */
    protected function app(): SlimApp
    {
        if ($this->app === null) {
            $this->boot();
        }
        \assert($this->app !== null);

        return $this->app;
    }

    protected function container(): ContainerInterface
    {
        $this->app();
        \assert($this->container !== null);

        return $this->container;
    }

    /**
     * @template T of object
     * @param class-string<T> $class
     * @return T
     */
    protected function service(string $class): object
    {
        $this->app();
        \assert($this->container !== null);
        $service = $this->container->get($class);
        self::assertInstanceOf($class, $service);

        return $service;
    }

    protected function migrate(): void
    {
        // Any request runs the automatic setup (migrations) first.
        $this->request('GET', '/api/v1/health');
    }

    /**
     * @param array<string, mixed>|object|string|null   $body    arrays/objects are sent as JSON
     * @param array<string, string>                     $headers
     * @param array<string, string>                     $cookies
     * @param array<string, mixed>                      $server
     * @param array<string, UploadedFileInterface>|null $files   multipart upload (with $body as form fields)
     */
    protected function request(
        string $method,
        string $uri,
        array|object|string|null $body = null,
        array $headers = [],
        array $cookies = [],
        array $server = [],
        ?array $files = null,
    ): ResponseInterface {
        $request = (new ServerRequestFactory())->createServerRequest($method, $uri, $server + ['REMOTE_ADDR' => '203.0.113.7']);
        parse_str((string) parse_url($uri, PHP_URL_QUERY), $query);
        $request = $request->withQueryParams($query)->withCookieParams($cookies);
        if ($files !== null) {
            $request = $request->withUploadedFiles($files)->withParsedBody(is_array($body) ? $body : [])
                ->withHeader('Content-Type', 'multipart/form-data; boundary=x');
        } elseif ($body !== null) {
            $json = is_string($body) ? $body : json_encode($body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION);
            $request = $request->withBody((new StreamFactory())->createStream($json))
                ->withHeader('Content-Type', 'application/json')
                ->withHeader('Content-Length', (string) strlen($json));
        }
        foreach ($headers as $name => $value) {
            $request = $request->withHeader($name, $value);
        }

        return $this->app()->handle($request);
    }

    // ---------------------------------------------------------------------------------------
    // Backend

    protected function backendToken(): string
    {
        if ($this->backendToken === null) {
            $this->migrate();
            $this->backendToken = $this->service(ApiTokens::class)->create('backend', 'test')['token'];
        }

        return $this->backendToken;
    }

    /** @param array<string, mixed>|object|string|null $body */
    protected function backend(string $method, string $uri, array|object|string|null $body = null): ResponseInterface
    {
        return $this->request($method, $uri, $body, ['Authorization' => 'Bearer ' . $this->backendToken()]);
    }

    /**
     * A valid CaptureMirror body.
     *
     * @param array<string, mixed> $extra
     * @return array<string, mixed>
     */
    protected static function capture(string $msgId, string $occurredAt, array $extra = []): array
    {
        $sourceKey = 'wa:' . $msgId;

        return array_merge([
            'contractVersion' => 1,
            'sourceKey' => $sourceKey,
            'publicId' => Ids::publicIdForSourceKey($sourceKey),
            'kind' => 'photo',
            'occurredAt' => $occurredAt,
            'tz' => 'Asia/Ho_Chi_Minh',
            'localDate' => \Omw\Api\Domain\Time::localDateFor($occurredAt, 'Asia/Ho_Chi_Minh'),
            'caption' => 'Lanterns',
            'media' => ['w' => 1080, 'h' => 1350, 'color' => '#aa3355'],
            'mediaState' => 'ok',
        ], $extra);
    }

    /** @param array<string, mixed> $extra */
    protected function putCapture(string $msgId, string $occurredAt, array $extra = []): string
    {
        $body = self::capture($msgId, $occurredAt, $extra);
        $response = $this->backend('PUT', '/api/v1/backend/captures/' . rawurlencode((string) $body['sourceKey']), $body);
        self::assertContains($response->getStatusCode(), [201, 204], (string) $response->getBody());

        return (string) $body['sourceKey'];
    }

    // ---------------------------------------------------------------------------------------
    // Admin

    protected function createAdmin(string $email = self::ADMIN_EMAIL, string $password = self::ADMIN_PASSWORD): int
    {
        $this->migrate();

        return $this->service(Users::class)->create($email, Passwords::hash($password), 'Owner');
    }

    protected function login(): void
    {
        $this->createAdmin();
        $response = $this->request('POST', '/api/v1/admin/session', ['email' => self::ADMIN_EMAIL, 'password' => self::ADMIN_PASSWORD]);
        self::assertSame(200, $response->getStatusCode(), (string) $response->getBody());
        $this->sessionCookie = self::cookieValue($response, Sessions::COOKIE);
        $this->csrf = (string) self::json($response)['csrfToken'];
    }

    /**
     * Admin request with the session cookie and (for mutating methods) the CSRF header.
     *
     * @param array<string, mixed>|object|string|null $body
     * @param array<string, string>                   $headers
     */
    protected function admin(string $method, string $uri, array|object|string|null $body = null, array $headers = []): ResponseInterface
    {
        if ($this->sessionCookie === null) {
            $this->login();
        }
        if (!in_array($method, ['GET', 'HEAD'], true)) {
            $headers += ['X-CSRF-Token' => (string) $this->csrf];
        }

        return $this->request($method, $uri, $body, $headers, [Sessions::COOKIE => (string) $this->sessionCookie]);
    }

    // ---------------------------------------------------------------------------------------
    // Assertions

    /** @return array<string, mixed> */
    protected static function json(ResponseInterface $response): array
    {
        $data = json_decode((string) $response->getBody(), true, 64, JSON_THROW_ON_ERROR);
        self::assertIsArray($data);

        /** @var array<string, mixed> $data */
        return $data;
    }

    protected static function assertError(ResponseInterface $response, int $status, string $code): void
    {
        self::assertSame($status, $response->getStatusCode(), (string) $response->getBody());
        $body = self::json($response);
        self::assertIsArray($body['error'] ?? null);
        self::assertSame($code, $body['error']['code'], (string) $response->getBody());
    }

    protected static function cookieValue(ResponseInterface $response, string $name): string
    {
        foreach ($response->getHeader('Set-Cookie') as $line) {
            if (str_starts_with($line, $name . '=')) {
                return explode(';', substr($line, strlen($name) + 1))[0];
            }
        }
        self::fail("No Set-Cookie for $name");
    }
}
