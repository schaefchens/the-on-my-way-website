<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Domain;

use Omw\Api\Config;
use Omw\Api\Domain\Alerts\ChannelNotifier;
use Omw\Api\Domain\Alerts\Notification;
use Omw\Api\Domain\ChangeLog;
use Omw\Api\Domain\Settings;
use Omw\Api\Infra\HttpClient;
use Omw\Api\Infra\PublicAddressGuard;
use Omw\Api\Infra\SchemaValidator;
use Omw\Api\Tests\TestCase;
use PHPUnit\Framework\Attributes\DataProvider;
use RuntimeException;

/**
 * ntfy delivery (review L1-02): NTFY_TOKEN only goes to NTFY_SERVER's origin; in production an
 * admin-set URL must resolve to public addresses only (every A/AAAA record), and the request is
 * pinned to the vetted addresses.
 */
final class ChannelNotifierTest extends TestCase
{
    private const TOKEN = 'l1-ntfy-secret-token-0123456789';

    /** @var array<string, list<string>> host => addresses the fake resolver answers */
    private array $dns = [
        'ntfy.sh' => ['159.203.148.75', '2604:a880:400:d1::9d6:6001'],
        'ntfy.example.org' => ['93.184.216.34'],
        'mixed.example.org' => ['93.184.216.34', '10.1.2.3'],
        'rebind.example.org' => ['2606:4700::6810:84e5', '::ffff:127.0.0.1'],
        'internal.example.org' => ['192.168.178.1'],
        'localhost' => ['127.0.0.1', '::1'],
    ];

    /**
     * @return iterable<string, array{0: string, 1: array<string, string>, 2: bool}>
     */
    public static function tokenCases(): iterable
    {
        yield 'default server' => ['https://ntfy.sh/omw-alerts', [], true];
        yield 'default server, explicit port and FQDN dot' => ['https://NTFY.sh.:443/omw-alerts', [], true];
        yield 'another server' => ['https://ntfy.example.org/omw-alerts', [], false];
        yield 'same host over http' => ['http://ntfy.sh/omw-alerts', [], false];
        yield 'same host, other port' => ['https://ntfy.sh:8443/omw-alerts', [], false];
        yield 'look-alike host' => ['https://ntfy.sh.example.org/omw-alerts', [], false];
        yield 'own server configured' => ['https://ntfy.example.org/omw-alerts', ['NTFY_SERVER' => 'https://ntfy.example.org/'], true];
        yield 'own server configured, ntfy.sh is foreign now' => ['https://ntfy.sh/omw-alerts', ['NTFY_SERVER' => 'https://ntfy.example.org'], false];
    }

    /** @param array<string, string> $env */
    #[DataProvider('tokenCases')]
    public function testTheTokenGoesOnlyToTheConfiguredServer(string $url, array $env, bool $withToken): void
    {
        $http = new RecordingHttpClient();
        $this->notifier($url, ['NTFY_TOKEN' => self::TOKEN] + $env, $http)->send(self::alert());

        self::assertCount(1, $http->requests);
        $headers = $http->requests[0]['headers'];
        if ($withToken) {
            self::assertSame('Bearer ' . self::TOKEN, $headers['Authorization'] ?? null);
        } else {
            self::assertArrayNotHasKey('Authorization', $headers);
            self::assertStringNotContainsString(self::TOKEN, (string) json_encode($http->requests));
        }
    }

    /**
     * @return iterable<string, array{0: string, 1: string}>
     */
    public static function refusedUrls(): iterable
    {
        yield 'loopback literal' => ['http://127.0.0.1:19103/topic', 'is a loopback address'];
        yield 'loopback name' => ['http://localhost:19103/topic', 'resolves to a loopback address'];
        yield 'one private record among public ones' => ['https://mixed.example.org/topic', 'private (RFC 1918) address (10.1.2.3)'];
        yield 'IPv4-mapped loopback in AAAA' => ['https://rebind.example.org/topic', 'loopback (embedded in IPv6)'];
        yield 'RFC 1918' => ['https://internal.example.org/topic', 'private (RFC 1918)'];
        yield 'link-local metadata' => ['http://169.254.169.254/latest', 'link-local'];
        yield 'CGNAT' => ['http://100.64.0.1/topic', 'carrier-grade NAT'];
        yield 'ULA' => ['http://[fd12:3456::1]/topic', 'unique-local'];
        yield 'IPv6 loopback' => ['http://[::1]:19103/topic', 'loopback'];
        yield 'unspecified' => ['http://0.0.0.0:19103/topic', 'unspecified'];
        yield 'shorthand IPv4' => ['http://127.1:19103/topic', 'invalid host name'];
        yield 'decimal IPv4' => ['http://2130706433:19103/topic', 'invalid host name'];
        yield 'user info' => ['https://user:pass@ntfy.sh/topic', 'user name or password'];
        yield 'unresolvable' => ['https://nowhere.example.org/topic', 'does not resolve'];
    }

    #[DataProvider('refusedUrls')]
    public function testProductionRefusesNonPublicDestinations(string $url, string $reason): void
    {
        $http = new RecordingHttpClient();
        try {
            $this->notifier($url, ['APP_ENV' => 'production', 'NTFY_TOKEN' => self::TOKEN], $http)->send(self::alert());
            self::fail('sent to ' . $url);
        } catch (RuntimeException $e) {
            self::assertStringContainsString('ntfy:', $e->getMessage());
            self::assertStringContainsString($reason, $e->getMessage());
        }
        self::assertSame([], $http->requests, 'nothing left the host');
    }

    public function testProductionPinsTheRequestToTheVettedAddresses(): void
    {
        $http = new RecordingHttpClient();
        $this->notifier('https://ntfy.sh/omw-alerts#frag', ['APP_ENV' => 'production', 'NTFY_TOKEN' => self::TOKEN], $http)->send(self::alert());

        self::assertSame('https://ntfy.sh/omw-alerts', $http->requests[0]['url'], 'rebuilt from its parts, fragment dropped');
        self::assertSame($this->dns['ntfy.sh'], $http->requests[0]['pinnedIps']);
        self::assertSame('Bearer ' . self::TOKEN, $http->requests[0]['headers']['Authorization'] ?? null);
    }

    public function testDevelopmentAllowsLocalServersWithoutTheToken(): void
    {
        $http = new RecordingHttpClient();
        $this->notifier('http://127.0.0.1:19103/topic', ['APP_ENV' => 'development', 'NTFY_TOKEN' => self::TOKEN], $http)->send(self::alert());

        self::assertSame('http://127.0.0.1:19103/topic', $http->requests[0]['url']);
        self::assertNull($http->requests[0]['pinnedIps']);
        self::assertArrayNotHasKey('Authorization', $http->requests[0]['headers']);
    }

    public function testTheContainerWiresTheLoggerSoDeliveryErrorsAreRecorded(): void
    {
        $config = $this->config(['APP_ENV' => 'production']);
        $db = $this->migratedDb($config);
        $db->exec("INSERT INTO settings (key, value, updated_at) VALUES ('alerts.ntfy_url', '\"http://127.0.0.1:19103/topic\"', '2026-11-20T10:00:00.000Z')");
        $db->exec("INSERT INTO backend_status (id, heartbeat, wa_state, backend_version, received_at) VALUES (1, '{}', 'logged_out', 'x', '2026-11-20T10:00:00.000Z')");
        $container = \Omw\Api\App::buildContainer($config, 'cron');

        $result = $container->get(\Omw\Api\Infra\CronRunner::class);
        self::assertInstanceOf(\Omw\Api\Infra\CronRunner::class, $result);
        $run = $result->run(null, ['alerts']);
        self::assertSame(['wa_logged_out'], $run['jobs']['alerts']['failed'] ?? null);

        $log = implode('', array_map('file_get_contents', glob($config->varDir . '/logs/cron-*.log') ?: []));
        self::assertStringContainsString('ntfy: refused: 127.0.0.1 is a loopback address', $log);
        self::assertStringContainsString('Alert wa_logged_out could not be delivered', $log);
    }

    public function testInvalidNtfyServerIsAConfigError(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->config(['NTFY_SERVER' => 'ftp://ntfy.sh']);
    }

    /** @param array<string, string> $env */
    private function notifier(string $ntfyUrl, array $env, HttpClient $http): ChannelNotifier
    {
        $config = $this->config($env);
        $db = $this->migratedDb($config);
        $schemas = SchemaValidator::fromRoot(self::rootDir());
        $settings = new Settings($db, new ChangeLog($db, $schemas), $schemas);
        // Stored directly: the admin PATCH would already refuse some of these in production.
        $db->exec("INSERT INTO settings (key, value, updated_at) VALUES ('alerts.ntfy_url', ?, '2026-11-20T10:00:00.000Z')", [json_encode($ntfyUrl, JSON_UNESCAPED_SLASHES)]);
        self::assertSame($ntfyUrl, $settings->get('alerts.ntfy_url'));
        $guard = new PublicAddressGuard(fn (string $host): array => $this->dns[$host] ?? []);

        return new ChannelNotifier($config, $settings, $http, $guard);
    }

    private static function alert(): Notification
    {
        return new Notification('wa_logged_out', 'critical', '[On My Way] ALERT: WhatsApp logged out', 'Relink it.', false, '2026-11-20T10:00:00.000Z');
    }

    /** Keeps the test's Config type visible to static analysis. */
    public function testConfigDefaultsToNtfySh(): void
    {
        self::assertSame(Config::DEFAULT_NTFY_SERVER, $this->config()->ntfyServer);
        self::assertSame('https://ntfy.example.org:8443', $this->config(['NTFY_SERVER' => 'https://NTFY.example.org:8443/x'])->ntfyServer);
    }
}

/** Records requests instead of sending them. */
final class RecordingHttpClient extends HttpClient
{
    /** @var list<array{method: string, url: string, headers: array<string, string>, body: string|null, pinnedIps: list<string>|null}> */
    public array $requests = [];

    public function request(string $method, string $url, array $headers = [], ?string $body = null, float $timeout = 10.0, ?array $pinnedIps = null): array
    {
        $this->requests[] = ['method' => $method, 'url' => $url, 'headers' => $headers, 'body' => $body, 'pinnedIps' => $pinnedIps];

        return ['status' => 200, 'body' => '{}'];
    }
}
