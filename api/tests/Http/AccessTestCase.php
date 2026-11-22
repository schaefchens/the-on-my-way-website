<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Http;

use DI\Container;
use Omw\Api\Domain\Access\StoreLayout;
use Omw\Api\Infra\Db;
use Omw\Api\Infra\Store\StoreWriterFactory;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Factory\StreamFactory;

/**
 * Wave 5 access tests: the real app with SITE_ORIGIN, the direct store writer on a scratch
 * folder, helpers for public (site → API) requests, inviting people and publishing the notice.
 */
abstract class AccessTestCase extends ApiTestCase
{
    public const SITE = 'https://site.example';
    public const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
    public const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

    /** @param array<string, string> $env */
    protected function bootAccess(array $env = []): void
    {
        $this->boot(array_merge([
            'SITE_ORIGIN' => self::SITE,
            'ACCESS_STORE_MODE' => 'direct',
            'ACCESS_STORE_DIR' => $this->storeDir(),
        ], $env));
    }

    protected function storeDir(): string
    {
        return $this->tmpDir() . '/store';
    }

    protected function storeHas(string $rel): bool
    {
        clearstatcache();

        return file_exists($this->storeDir() . '/' . $rel);
    }

    protected function storeRead(string $rel): ?string
    {
        $data = @file_get_contents($this->storeDir() . '/' . $rel);

        return $data === false ? null : $data;
    }

    /** @return list<string> files below s/<fid>/ */
    protected function sessionFiles(string $fid): array
    {
        clearstatcache();
        $files = @scandir($this->storeDir() . '/s/' . $fid);

        return $files === false ? [] : array_values(array_diff($files, ['.', '..']));
    }

    protected function replaceWriters(StoreWriterFactory $factory): void
    {
        $container = $this->container();
        \assert($container instanceof Container);
        $container->set(StoreWriterFactory::class, $factory);
    }

    protected function appDb(): Db
    {
        return $this->service(Db::class);
    }

    /** Initialises the store ("Website-Speicher einrichten") through the admin route. */
    protected function initStore(): void
    {
        $res = $this->admin('POST', '/api/v1/admin/access/store-init', new \stdClass());
        self::assertSame(200, $res->getStatusCode(), (string) $res->getBody());
    }

    /** Store id + init op applied, without the admin login (fast). */
    protected function initStoreDirect(): void
    {
        $this->migrate();
        $db = $this->appDb();
        $ops = $this->service(\Omw\Api\Domain\Access\StoreOps::class);
        $db->write(function () use ($db, $ops): void {
            $storeId = \Omw\Api\Domain\Access\Tokens::hex16();
            $db->exec('UPDATE access_state SET store_id = ? WHERE id = 1', [$storeId]);
            $epoch = (string) $db->scalar('SELECT epoch FROM access_state WHERE id = 1');
            $ops->enqueue('init', StoreLayout::MARKER, \Omw\Api\Domain\Access\StoreApplier::markerJson($storeId, $epoch, 0));
        });
        $this->service(\Omw\Api\Domain\Access\StoreApplier::class)->applyNow(8.0);
    }

    /** Publishes the template notice with a controller, without the admin login (fast). */
    protected function publishNoticeDirect(): int
    {
        $notices = $this->service(\Omw\Api\Domain\Access\PrivacyNotices::class);
        $draft = $notices->draft();
        $draft->controller = (object) ['name' => 'Traveler', 'email' => 'traveler@example.org'];
        $notices->putDraft($draft);
        $notices->publish(hash('sha256', \Omw\Api\Domain\Access\PrivacyNotices::canonical($draft)));

        return (int) $notices->currentVersion();
    }

    /** Fills the controller and publishes the template notice; returns the version. */
    protected function publishNotice(): int
    {
        $state = self::json($this->admin('GET', '/api/v1/admin/privacy'));
        $draft = $state['draft'];
        \assert(is_array($draft) && is_array($draft['controller']));
        $draft['controller']['name'] = 'Traveler';
        $draft['controller']['email'] = 'traveler@example.org';
        $put = $this->admin('PUT', '/api/v1/admin/privacy/draft', $draft);
        self::assertSame(200, $put->getStatusCode(), (string) $put->getBody());
        $sha = self::json($put)['draftSha256'];
        $pub = $this->admin('POST', '/api/v1/admin/privacy/publish', ['ifDraftSha256' => $sha]);
        self::assertSame(200, $pub->getStatusCode(), (string) $pub->getBody());
        $current = self::json($pub)['current'];
        \assert(is_array($current));

        return (int) $current['version'];
    }

    /**
     * Invites a person; returns [fid, t (link secret)].
     *
     * @return array{0: string, 1: string}
     */
    protected function invite(string $name = 'Oma'): array
    {
        $res = $this->admin('POST', '/api/v1/admin/followers', ['name' => $name]);
        self::assertSame(201, $res->getStatusCode(), (string) $res->getBody());
        $body = self::json($res);
        \assert(is_array($body['follower']) && is_array($body['link']));
        $url = (string) $body['link']['url'];
        self::assertStringStartsWith(self::SITE . '/_/join/#t=', $url);

        return [(string) $body['follower']['id'], substr($url, strlen(self::SITE . '/_/join/#t='))];
    }

    /**
     * Store ready, notice published, one person invited.
     *
     * @return array{0: string, 1: string, 2: int} [fid, t, version]
     */
    protected function setUpPerson(string $name = 'Oma'): array
    {
        $this->initStore();
        $version = $this->publishNotice();
        [$fid, $t] = $this->invite($name);

        return [$fid, $t, $version];
    }

    /**
     * A public request as the site sends it: POST, text/plain JSON, Origin = the site.
     *
     * @param array<string, mixed>|string $body
     * @param array<string, string>       $headers
     * @param array<string, string>       $cookies
     */
    protected function pub(string $path, array|string $body, array $headers = [], array $cookies = [], string $ip = '198.51.100.20'): ResponseInterface
    {
        $json = is_string($body) ? $body : json_encode($body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/api/v1/public/' . $path, ['REMOTE_ADDR' => $ip])
            ->withBody((new StreamFactory())->createStream($json))
            ->withHeader('Content-Type', 'text/plain;charset=UTF-8')
            ->withHeader('Content-Length', (string) strlen($json))
            ->withHeader('Origin', self::SITE)
            ->withHeader('User-Agent', self::UA_IPHONE)
            ->withCookieParams($cookies);
        foreach ($headers as $name => $value) {
            $request = $request->withHeader($name, $value);
        }

        return $this->app()->handle($request);
    }

    /**
     * Joins a new device with a personal link; returns the decoded answer.
     *
     * @return array<string, mixed>
     */
    protected function join(string $t, int $version, ?string $k = null, string $ua = self::UA_IPHONE, string $ip = '198.51.100.20'): array
    {
        $body = ['t' => $t, 'consentVersion' => $version, 'locale' => 'de'];
        if ($k !== null) {
            $body['k'] = $k;
        }
        $res = $this->pub('join', $body, ['User-Agent' => $ua], [], $ip);
        self::assertSame(200, $res->getStatusCode(), (string) $res->getBody());

        return self::json($res);
    }

    /** @return array<string, mixed> */
    protected function call(string $path, string $k): array
    {
        $res = $this->pub($path, ['k' => $k]);
        self::assertSame(200, $res->getStatusCode(), (string) $res->getBody());

        return self::json($res);
    }

    /** "<fid>.<did>.<sid>" → the store path of that session. */
    protected static function sessionPath(string $session): string
    {
        $p = StoreLayout::parseGateSession($session);
        self::assertNotNull($p, $session);

        return StoreLayout::session($p['fid'], $p['did'], $p['sid']);
    }
}
