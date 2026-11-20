<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Http;

use DI\Container;
use Omw\Api\Domain\Time;
use Omw\Api\Infra\Db;
use Omw\Api\Infra\PublicAddressGuard;

/**
 * Settings hardening from the L1 review: alert URLs into the host's own network are refused in
 * production (422, schema unchanged), and time-zone names are stored canonically (W2-16).
 */
final class SettingsHardeningTest extends ApiTestCase
{
    public function testProductionRefusesPrivateAlertUrls(): void
    {
        $this->bootWithResolver('production', [
            'ntfy.sh' => ['159.203.148.75'],
            'intranet.example.org' => ['10.20.30.40'],
            'split.example.org' => ['93.184.216.34', 'fd00::5'],
        ]);
        foreach ([
            'http://127.0.0.1:19103/topic' => 'loopback',
            'http://[::1]/topic' => 'loopback',
            'https://intranet.example.org/topic' => 'private (RFC 1918)',
            'https://split.example.org/topic' => 'unique-local',
            'http://169.254.169.254/latest/meta-data' => 'link-local',
            'https://user:secret@ntfy.sh/topic' => 'user name or password',
        ] as $url => $reason) {
            $response = $this->admin('PATCH', '/api/v1/admin/settings', ['alerts.ntfy_url' => $url]);
            self::assertError($response, 422, 'validation_failed');
            self::assertStringContainsString($reason, (string) $response->getBody(), $url);
        }
        self::assertNull($this->service(Db::class)->scalar("SELECT value FROM settings WHERE key = 'alerts.ntfy_url'"));

        self::assertSame(200, $this->admin('PATCH', '/api/v1/admin/settings', ['alerts.ntfy_url' => 'https://ntfy.sh/omw-alerts'])->getStatusCode());
        // A host that does not resolve right now is accepted (delivery checks again).
        self::assertSame(200, $this->admin('PATCH', '/api/v1/admin/settings', ['alerts.ntfy_url' => 'https://ntfy.not-yet.example/topic'])->getStatusCode());
        self::assertSame(200, $this->admin('PATCH', '/api/v1/admin/settings', ['alerts.ntfy_url' => null])->getStatusCode());
    }

    public function testDevelopmentAcceptsLocalAlertUrls(): void
    {
        $this->bootWithResolver('development', []);
        self::assertSame(200, $this->admin('PATCH', '/api/v1/admin/settings', ['alerts.ntfy_url' => 'http://127.0.0.1:8090/topic'])->getStatusCode());
    }

    public function testTimeZoneNamesAreStoredCanonically(): void
    {
        $this->login();
        $db = $this->service(Db::class);
        $seq = (int) $db->scalar('SELECT MAX(seq) FROM change_log');
        $settings = self::json($this->admin('PATCH', '/api/v1/admin/settings', ['timezone.current' => 'asia/saigon']));
        self::assertSame('Asia/Saigon', $settings['timezone.current']);
        self::assertSame('"Asia/Saigon"', $db->scalar("SELECT value FROM settings WHERE key = 'timezone.current'"));
        $items = self::json($this->backend('GET', '/api/v1/backend/changes?after=' . $seq))['items'];
        self::assertSame([['value' => 'Asia/Saigon']], array_column($items, 'data'));
        self::assertSame('Asia/Saigon', self::json($this->admin('GET', '/api/v1/admin/settings'))['timezone.current']);

        $day = self::json($this->admin('PATCH', '/api/v1/admin/days/2026-11-18', ['tz' => 'ASIA/HO_CHI_MINH', 'title' => ['de' => 'Hội An']]));
        self::assertSame('Asia/Ho_Chi_Minh', $day['day']['tz']);
        self::assertSame('Asia/Ho_Chi_Minh', $db->scalar("SELECT tz FROM days WHERE local_date = '2026-11-18'"));

        $post = self::json($this->admin('POST', '/api/v1/admin/posts', [
            'publicId' => 'p_tzcanon01', 'kind' => 'note', 'origLocale' => 'de', 'tz' => 'europe/berlin', 'content' => ['de' => ['body' => 'Hallo']],
        ]));
        self::assertSame('Europe/Berlin', $post['tz']);
        $defaulted = self::json($this->admin('POST', '/api/v1/admin/posts', [
            'publicId' => 'p_tzcanon02', 'kind' => 'note', 'origLocale' => 'de', 'content' => ['de' => ['body' => 'Hallo']],
        ]));
        self::assertSame('Asia/Saigon', $defaulted['tz'], 'defaults to timezone.current');
        self::assertSame('UTC', self::json($this->admin('PATCH', '/api/v1/admin/posts/p_tzcanon01', ['tz' => 'utc']))['tz']);

        self::assertSame('UTC', Time::canonicalTimeZone('utc'));
        self::assertSame('America/Argentina/Buenos_Aires', Time::canonicalTimeZone('america/argentina/buenos_aires'));
        self::assertNull(Time::canonicalTimeZone('Mars/Olympus'));
        self::assertNull(Time::canonicalTimeZone('+07:00'));
        self::assertError($this->admin('PATCH', '/api/v1/admin/settings', ['timezone.current' => 'mars/olympus']), 422, 'validation_failed');
    }

    /** @param array<string, list<string>> $dns */
    private function bootWithResolver(string $env, array $dns): void
    {
        $this->boot(['APP_ENV' => $env]);
        $container = $this->container();
        self::assertInstanceOf(Container::class, $container);
        $container->set(PublicAddressGuard::class, new PublicAddressGuard(static fn (string $host): array => $dns[$host] ?? []));
    }
}
