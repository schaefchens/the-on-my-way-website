<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Http;

use Omw\Api\Domain\Auth\ApiTokens;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;

/**
 * Settings (validation incl. time zones and locales, publish.mode_since, clearing optional keys,
 * change feed), tokens (list/create/revoke), status and doctor.
 */
final class AdminSettingsTokensTest extends ApiTestCase
{
    public function testSettingsDefaultsAndPatch(): void
    {
        $defaults = self::json($this->admin('GET', '/api/v1/admin/settings'));
        self::assertSame('instant', $defaults['publish.mode']);
        self::assertSame('1970-01-01T00:00:00.000Z', $defaults['publish.mode_since']);
        self::assertArrayNotHasKey('alerts.email', $defaults);

        $db = $this->service(Db::class);
        $seq = (int) $db->scalar('SELECT MAX(seq) FROM change_log');
        $patched = self::json($this->admin('PATCH', '/api/v1/admin/settings', [
            'timezone.current' => 'Asia/Ho_Chi_Minh', 'alerts.email' => 'me@example.org', 'site.locales' => ['de', 'en', 'ar'], 'publish.mode' => 'instant',
        ]));
        self::assertSame('Asia/Ho_Chi_Minh', $patched['timezone.current']);
        self::assertSame('me@example.org', $patched['alerts.email']);
        self::assertSame('1970-01-01T00:00:00.000Z', $patched['publish.mode_since'], 'mode unchanged -> mode_since unchanged');
        $keys = array_column(self::json($this->backend('GET', '/api/v1/backend/changes?after=' . $seq))['items'], 'key');
        sort($keys);
        self::assertSame(['alerts.email', 'site.locales', 'timezone.current'], $keys, 'only changed keys are announced');

        // instant -> review sets publish.mode_since (announced on the feed BEFORE the mode).
        Clock::advance('+1 minute');
        $seq = (int) $db->scalar('SELECT MAX(seq) FROM change_log');
        $review = self::json($this->admin('PATCH', '/api/v1/admin/settings', ['publish.mode' => 'review']));
        self::assertSame('2026-11-20T10:01:00.000Z', $review['publish.mode_since']);
        $items = self::json($this->backend('GET', '/api/v1/backend/changes?after=' . $seq))['items'];
        self::assertSame(['publish.mode_since', 'publish.mode'], array_column($items, 'key'));
        self::assertSame(['value' => '2026-11-20T10:01:00.000Z'], $items[0]['data']);

        // null clears optional keys -> tombstone on the feed.
        $seq = (int) $db->scalar('SELECT MAX(seq) FROM change_log');
        $cleared = self::json($this->admin('PATCH', '/api/v1/admin/settings', ['alerts.email' => null]));
        self::assertArrayNotHasKey('alerts.email', $cleared);
        $items = self::json($this->backend('GET', '/api/v1/backend/changes?after=' . $seq))['items'];
        self::assertSame([['seq' => $seq + 1, 'entity' => 'setting', 'key' => 'alerts.email', 'op' => 'delete']], $items);
    }

    public function testSettingsValidation(): void
    {
        $bad = [
            ['timezone.current' => 'Mars/Olympus'],
            ['timezone.current' => '+07:00'],
            ['timezone.current' => 'CEST'],
            ['publish.mode_since' => self::NOW],
            ['publish.mode' => 'later'],
            ['publish.delay_minutes' => -1],
            ['site.locales' => []],
            ['site.locales' => ['de', 'de']],
            ['site.default_locale' => 'ar'],
            ['site.locales' => ['en'], 'site.default_locale' => 'de'],
            ['alerts.email' => 'not-an-email'],
            ['alerts.ntfy_url' => 'ftp://ntfy.sh/topic'],
            ['alerts.heartbeat_stale_minutes' => 0],
            ['unknown.key' => 1],
            ['publish.mode' => null],
        ];
        foreach ($bad as $patch) {
            self::assertError($this->admin('PATCH', '/api/v1/admin/settings', $patch), 422, 'validation_failed');
        }
        self::assertSame(200, $this->admin('PATCH', '/api/v1/admin/settings', ['site.locales' => ['en'], 'site.default_locale' => 'en'])->getStatusCode());
        self::assertSame(200, $this->admin('PATCH', '/api/v1/admin/settings', ['timezone.current' => 'UTC'])->getStatusCode());
        self::assertSame(200, $this->admin('PATCH', '/api/v1/admin/settings', ['alerts.ntfy_url' => 'https://ntfy.sh/omw-test'])->getStatusCode());
    }

    public function testTokens(): void
    {
        self::assertSame(['items' => []], self::json($this->admin('GET', '/api/v1/admin/tokens')));

        $created = $this->admin('POST', '/api/v1/admin/tokens', ['kind' => 'backend', 'name' => 'home-mac']);
        self::assertSame(201, $created->getStatusCode(), (string) $created->getBody());
        $body = self::json($created);
        self::assertMatchesRegularExpression('/^omw_[A-Za-z0-9_-]{43}$/', $body['token']);
        self::assertSame(['backend'], $body['info']['scopes']);
        self::assertSame(200, $this->request('GET', '/api/v1/backend/changes', null, ['Authorization' => 'Bearer ' . $body['token']])->getStatusCode());

        $app = self::json($this->admin('POST', '/api/v1/admin/tokens', ['kind' => 'app', 'name' => 'iPhone', 'expiresAt' => '2027-01-01T00:00:00Z']));
        self::assertSame('2027-01-01T00:00:00.000Z', $app['info']['expiresAt']);
        self::assertSame(['admin'], $app['info']['scopes']);

        $list = self::json($this->admin('GET', '/api/v1/admin/tokens'))['items'];
        self::assertSame([$app['info']['id'], $body['info']['id']], array_column($list, 'id'), 'newest first, no sessions');

        self::assertError($this->admin('POST', '/api/v1/admin/tokens', ['kind' => 'session', 'name' => 'x']), 422, 'validation_failed');
        self::assertError($this->admin('POST', '/api/v1/admin/tokens', ['kind' => 'app', 'name' => '']), 422, 'validation_failed');
        self::assertError($this->admin('POST', '/api/v1/admin/tokens', ['kind' => 'app', 'name' => 'old', 'expiresAt' => '2020-01-01T00:00:00Z']), 422, 'validation_failed');

        self::assertSame(204, $this->admin('DELETE', '/api/v1/admin/tokens/' . $body['info']['id'])->getStatusCode());
        self::assertError($this->admin('DELETE', '/api/v1/admin/tokens/' . $body['info']['id']), 404, 'not_found');
        self::assertError($this->request('GET', '/api/v1/backend/changes', null, ['Authorization' => 'Bearer ' . $body['token']]), 401, 'unauthorized');

        // Session tokens cannot be revoked (or even seen) through this endpoint.
        $sessionId = (int) $this->service(Db::class)->scalar("SELECT id FROM api_tokens WHERE kind = 'session'");
        self::assertError($this->admin('DELETE', '/api/v1/admin/tokens/' . $sessionId), 404, 'not_found');
        self::assertSame(1, $this->service(ApiTokens::class)->countActive('session'));
    }

    public function testStatusWithoutBackend(): void
    {
        self::assertSame(['backend' => null, 'lastSeenAt' => null, 'publish' => [], 'alerts' => []], self::json($this->admin('GET', '/api/v1/admin/status')));
    }

    public function testDoctorEndpoint(): void
    {
        $response = $this->admin('GET', '/api/v1/admin/doctor');
        self::assertSame(200, $response->getStatusCode(), (string) $response->getBody());
        $doctor = self::json($response);
        self::assertIsBool($doctor['ok']);
        $names = array_column($doctor['checks'], 'name');
        foreach (['php_version', 'extensions', 'journal_mode', 'uploads', 'migrations', 'cron', 'http_exposure'] as $name) {
            self::assertContains($name, $names);
        }
    }
}
