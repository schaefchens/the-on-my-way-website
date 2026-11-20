<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Http;

use Omw\Api\App;
use Omw\Api\Tests\TestCase;
use PHPUnit\Framework\Attributes\DataProvider;
use Psr\Container\ContainerInterface;
use Psr\Http\Message\ResponseInterface;
use RuntimeException;
use Slim\App as SlimApp;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Factory\StreamFactory;

/**
 * Drives the real Slim app (middleware, routing, error handler) with PSR-7 requests.
 */
final class AppTest extends TestCase
{
    public function testHealthReturnsOkAndVersion(): void
    {
        $response = $this->request('GET', '/api/v1/health');

        self::assertSame(200, $response->getStatusCode());
        self::assertStringStartsWith('application/json', $response->getHeaderLine('Content-Type'));
        self::assertSame('no-store', $response->getHeaderLine('Cache-Control'));
        self::assertSame(
            ['ok' => true, 'version' => App::VERSION, 'contractVersion' => App::CONTRACT_VERSION],
            self::json($response),
        );
    }

    public function testUnknownRouteIsAJsonNotFound(): void
    {
        $response = $this->request('GET', '/api/v1/nope');

        self::assertSame(404, $response->getStatusCode());
        $body = self::json($response);
        self::assertSame('not_found', $body['error']['code']);
        self::assertIsString($body['error']['message']);
    }

    public function testWrongMethodIs405WithAllowHeader(): void
    {
        $response = $this->request('POST', '/api/v1/health');

        self::assertSame(405, $response->getStatusCode());
        self::assertSame('method_not_allowed', self::json($response)['error']['code']);
        self::assertStringContainsString('GET', $response->getHeaderLine('Allow'));
    }

    /** @return iterable<string, array{string, string, string}> */
    public static function protectedEndpoints(): iterable
    {
        yield 'backend capture mirror' => ['PUT', '/api/v1/backend/captures/wa:3EB0C431D2A7F8E1', 'unauthorized'];
        yield 'backend changes' => ['GET', '/api/v1/backend/changes?after=0', 'unauthorized'];
        yield 'backend heartbeat' => ['POST', '/api/v1/backend/heartbeat', 'unauthorized'];
        yield 'backend published' => ['POST', '/api/v1/backend/published', 'unauthorized'];
        yield 'backend backup' => ['GET', '/api/v1/backend/backup/latest', 'unauthorized'];
        yield 'admin login without body' => ['POST', '/api/v1/admin/session', 'unauthorized'];
        yield 'admin captures' => ['GET', '/api/v1/admin/captures', 'unauthorized'];
        yield 'admin day' => ['PATCH', '/api/v1/admin/days/2026-11-18', 'unauthorized'];
        yield 'admin settings' => ['GET', '/api/v1/admin/settings', 'unauthorized'];
        yield 'admin status' => ['GET', '/api/v1/admin/status', 'unauthorized'];
        yield 'admin doctor' => ['GET', '/api/v1/admin/doctor', 'unauthorized'];
        yield 'web cron without CRON_KEY' => ['GET', '/api/v1/cron', 'not_found'];
    }

    #[DataProvider('protectedEndpoints')]
    public function testEndpointsAreProtected(string $method, string $path, string $code): void
    {
        $response = $this->request($method, $path);

        self::assertSame($code === 'not_found' ? 404 : 401, $response->getStatusCode());
        self::assertSame($code, self::json($response)['error']['code']);
    }

    public function testMethodOverrideHeader(): void
    {
        // PATCH /api/v1/admin/settings exists, POST does not: the override must reach the router.
        self::assertSame(405, $this->request('POST', '/api/v1/admin/settings')->getStatusCode());
        self::assertSame(401, $this->request('POST', '/api/v1/admin/settings', ['X-Http-Method-Override' => 'PATCH'])->getStatusCode());
    }

    public function testMethodOverrideNeverComesFromTheBody(): void
    {
        // Bodies cannot override the method: JSON stays an object (no array "_METHOD" lookup) and
        // form bodies are not parsed at all, so a cross-site form post cannot become a PATCH.
        $json = $this->request('POST', '/api/v1/admin/settings', ['Content-Type' => 'application/json'], '{"_METHOD":"PATCH"}');
        self::assertSame(405, $json->getStatusCode());
        $form = $this->request('POST', '/api/v1/admin/settings', ['Content-Type' => 'application/x-www-form-urlencoded'], '_METHOD=PATCH');
        self::assertSame(405, $form->getStatusCode());
    }

    public function testMutatingAdminRequestsMustBeJson(): void
    {
        $form = $this->request('POST', '/api/v1/admin/session', ['Content-Type' => 'application/x-www-form-urlencoded'], 'email=a%40b.c&password=x');
        self::assertSame(415, $form->getStatusCode());
        self::assertSame('unsupported_media_type', self::json($form)['error']['code']);
        $patch = $this->request('PATCH', '/api/v1/admin/settings', ['Content-Type' => 'text/plain'], '{}');
        self::assertSame(415, $patch->getStatusCode());
        // JSON bodies and bodyless requests pass through to the handlers (here: auth fails).
        self::assertSame(401, $this->request('POST', '/api/v1/admin/session', ['Content-Type' => 'application/json; charset=utf-8'], '{}')->getStatusCode());
        self::assertSame(204, $this->request('DELETE', '/api/v1/admin/session')->getStatusCode());
        self::assertSame(401, $this->request('GET', '/api/v1/admin/me')->getStatusCode());
    }

    public function testBodyDetectionFollowsHttpFraming(): void
    {
        $factory = new ServerRequestFactory();
        $input = (new StreamFactory())->createStreamFromResource(fopen('php://input', 'rb') ?: throw new RuntimeException('no php://input'));
        $bodyless = $factory->createServerRequest('DELETE', '/x')->withBody($input);
        self::assertFalse(\Omw\Api\Http\RequireJsonBody::hasBody($bodyless), 'php://input without Content-Length: no body');
        self::assertTrue(\Omw\Api\Http\RequireJsonBody::hasBody($bodyless->withHeader('Content-Length', '2')));
        self::assertFalse(\Omw\Api\Http\RequireJsonBody::hasBody($bodyless->withHeader('Content-Length', '0')));
        self::assertTrue(\Omw\Api\Http\RequireJsonBody::hasBody($bodyless->withHeader('Transfer-Encoding', 'chunked')));
    }

    public function testSecurityHeaders(): void
    {
        foreach (['/api/v1/health', '/api/v1/nope', '/api/v1/admin/me'] as $path) {
            $response = $this->request('GET', $path);
            self::assertSame('nosniff', $response->getHeaderLine('X-Content-Type-Options'), $path);
            self::assertSame('same-origin', $response->getHeaderLine('Referrer-Policy'), $path);
            self::assertSame('DENY', $response->getHeaderLine('X-Frame-Options'), $path);
            self::assertStringContainsString("frame-ancestors 'none'", $response->getHeaderLine('Content-Security-Policy'), $path);
            self::assertSame('', $response->getHeaderLine('Strict-Transport-Security'), 'no HSTS over plain http');
            self::assertSame('', $response->getHeaderLine('Access-Control-Allow-Origin'), 'never CORS outside /public');
        }
        $https = $this->request('GET', 'https://api.example.org/api/v1/health');
        self::assertSame('max-age=31536000', $https->getHeaderLine('Strict-Transport-Security'));
    }

    public function testCorsOnlyForTheSiteOriginOnPublicEndpoints(): void
    {
        $app = App::create($this->config(['BASE_PATH' => '', 'SITE_ORIGIN' => 'https://www.example.org/de/']));
        $preflight = ['Origin' => 'https://www.example.org', 'Access-Control-Request-Method' => 'POST'];

        $ok = $this->request('OPTIONS', '/api/v1/public/hearts', $preflight, app: $app);
        self::assertSame(204, $ok->getStatusCode());
        self::assertSame('https://www.example.org', $ok->getHeaderLine('Access-Control-Allow-Origin'));
        self::assertSame('GET, POST', $ok->getHeaderLine('Access-Control-Allow-Methods'));
        self::assertSame('', $ok->getHeaderLine('Access-Control-Allow-Credentials'));

        $evil = $this->request('OPTIONS', '/api/v1/public/hearts', ['Origin' => 'https://evil.example'] + $preflight, app: $app);
        self::assertSame(204, $evil->getStatusCode());
        self::assertSame('', $evil->getHeaderLine('Access-Control-Allow-Origin'));
        self::assertSame('Origin', $evil->getHeaderLine('Vary'));

        // Admin and backend routes never answer preflights with CORS headers.
        $admin = $this->request('OPTIONS', '/api/v1/admin/settings', $preflight, app: $app);
        self::assertSame('', $admin->getHeaderLine('Access-Control-Allow-Origin'));
    }

    public function testJsonBodiesKeepObjects(): void
    {
        self::assertInstanceOf(\stdClass::class, App::decodeJsonBody('{}'));
        self::assertSame([], App::decodeJsonBody('[]'));
        self::assertNull(App::decodeJsonBody('1'));
        self::assertNull(App::decodeJsonBody('{nope'));
        $nested = App::decodeJsonBody('{"description":{}}');
        self::assertInstanceOf(\stdClass::class, $nested);
        self::assertInstanceOf(\stdClass::class, $nested->description);
    }

    public function testBasePathFromConfig(): void
    {
        $app = App::create($this->config(['BASE_PATH' => '/omw/']));

        self::assertSame(200, $this->request('GET', '/omw/api/v1/health', app: $app)->getStatusCode());
        self::assertSame(404, $this->request('GET', '/api/v1/health', app: $app)->getStatusCode());
    }

    /** @return iterable<string, array{array<string, string>, string}> */
    public static function basePaths(): iterable
    {
        yield 'web root' => [['SCRIPT_NAME' => '/index.php', 'REQUEST_URI' => '/api/v1/health'], ''];
        yield 'sub directory' => [['SCRIPT_NAME' => '/omw/public/index.php', 'REQUEST_URI' => '/omw/public/api/v1/health?x=1'], '/omw/public'];
        yield 'rewritten elsewhere' => [['SCRIPT_NAME' => '/omw/public/index.php', 'REQUEST_URI' => '/api/v1/health'], ''];
        yield 'cli' => [[], ''];
    }

    /** @param array<string, string> $server */
    #[DataProvider('basePaths')]
    public function testDetectBasePath(array $server, string $expected): void
    {
        self::assertSame($expected, App::detectBasePath($server));
    }

    public function testInternalErrorsDoNotLeakDetailsWithoutDebug(): void
    {
        $app = App::create($this->config());
        // Slim binds route closures to the container: they must not be static.
        $app->get('/boom', fn () => throw new RuntimeException('secret detail'));

        $response = $this->request('GET', '/boom', app: $app);

        self::assertSame(500, $response->getStatusCode());
        $body = self::json($response);
        self::assertSame('internal', $body['error']['code']);
        self::assertStringNotContainsString('secret', (string) $response->getBody());
        self::assertArrayNotHasKey('details', $body['error']);
        self::assertStringContainsString('secret detail', (string) file_get_contents($this->logFile()), 'logged instead');
    }

    public function testInternalErrorDetailsWithDebug(): void
    {
        $app = App::create($this->config(['APP_DEBUG' => 'true']));
        // Slim binds route closures to the container: they must not be static.
        $app->get('/boom', fn () => throw new RuntimeException('secret detail'));

        $body = self::json($this->request('GET', '/boom', app: $app));

        self::assertSame('internal', $body['error']['code']);
        self::assertSame('secret detail', $body['error']['details']['message']);
        self::assertSame(RuntimeException::class, $body['error']['details']['type']);
    }

    /**
     * @param array<string, string>              $headers
     * @param SlimApp<ContainerInterface>|null   $app
     */
    private function request(string $method, string $uri, array $headers = [], string $body = '', ?SlimApp $app = null): ResponseInterface
    {
        $app ??= App::create($this->config(['BASE_PATH' => '']));
        $request = (new ServerRequestFactory())->createServerRequest($method, $uri);
        foreach ($headers as $name => $value) {
            $request = $request->withHeader($name, $value);
        }
        if ($body !== '') {
            $request = $request->withBody((new StreamFactory())->createStream($body))
                ->withHeader('Content-Length', (string) strlen($body));
        }

        return $app->handle($request);
    }

    /** @return array<string, mixed> */
    private static function json(ResponseInterface $response): array
    {
        $data = json_decode((string) $response->getBody(), true, 32, JSON_THROW_ON_ERROR);
        self::assertIsArray($data);

        /** @var array<string, mixed> $data */
        return $data;
    }

    private function logFile(): string
    {
        $files = glob($this->tmpDir() . '/var/logs/app-*.log') ?: [];
        self::assertNotEmpty($files, 'log file written');

        return $files[0];
    }
}
