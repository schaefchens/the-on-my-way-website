<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Http;

use Omw\Api\Domain\Access\PrivacyNotices;

/**
 * Privacy notice (D11, Q7; spec-wave5 §3.3, §3.5): the template draft ({backupDays} = BACKUP_KEEP),
 * completeness (controller, de AND en always, every site.locales locale), the sha conflict,
 * immutable published versions, joins refused until a version exists.
 */
final class AdminPrivacyTest extends AccessTestCase
{
    public function testTemplateDraftAndCompleteness(): void
    {
        $this->bootAccess(['BACKUP_KEEP' => '21']);
        $state = self::json($this->admin('GET', '/api/v1/admin/privacy'));
        self::assertNull($state['current']);
        self::assertSame([], $state['versions']);
        self::assertSame(['name' => '', 'email' => ''], $state['draft']['controller']);
        self::assertSame(['controller.name', 'controller.email'], $state['problems']);
        self::assertStringContainsString('höchstens 21 Tagen', $state['draft']['texts']['de']['retention']);
        self::assertStringContainsString('at most 21 days', $state['draft']['texts']['en']['retention']);
        self::assertStringNotContainsString('{backupDays}', json_encode($state, JSON_THROW_ON_ERROR));
        self::assertSame(hash('sha256', PrivacyNotices::canonical(json_decode(json_encode($state['draft'], JSON_THROW_ON_ERROR), false))), $state['draftSha256']);

        // Incomplete: 422 notice_incomplete with the missing paths.
        $res = $this->admin('POST', '/api/v1/admin/privacy/publish', ['ifDraftSha256' => $state['draftSha256']]);
        self::assertError($res, 422, 'notice_incomplete');
        self::assertSame(['controller.name', 'controller.email'], self::json($res)['error']['details']['missing']);

        // de + en are required even when the site is German only; an empty English text blocks.
        $this->admin('PATCH', '/api/v1/admin/settings', ['site.locales' => ['de'], 'site.default_locale' => 'de']);
        $draft = $state['draft'];
        $draft['controller'] = ['name' => 'Traveler', 'email' => 'traveler@example.org', 'address' => ''];
        $draft['texts']['en']['rights'] = '  ';
        $put = self::json($this->admin('PUT', '/api/v1/admin/privacy/draft', $draft));
        self::assertSame(['texts.en.rights'], $put['problems']);
        self::assertError($this->admin('POST', '/api/v1/admin/privacy/publish', ['ifDraftSha256' => $put['draftSha256']]), 422, 'notice_incomplete');

        // Arabic in site.locales makes ar required too.
        $this->admin('PATCH', '/api/v1/admin/settings', ['site.locales' => ['de', 'en', 'ar']]);
        $draft['texts']['en']['rights'] = 'You can ask.';
        $put = self::json($this->admin('PUT', '/api/v1/admin/privacy/draft', $draft));
        self::assertContains('texts.ar.title', $put['problems']);
    }

    public function testPublishVersionsAndTheShaConflict(): void
    {
        $this->bootAccess();
        $state = self::json($this->admin('GET', '/api/v1/admin/privacy'));
        $draft = $state['draft'];
        $draft['controller'] = ['name' => 'Traveler', 'email' => 'traveler@example.org'];
        $put = self::json($this->admin('PUT', '/api/v1/admin/privacy/draft', $draft));
        self::assertSame([], $put['problems']);
        self::assertError($this->admin('POST', '/api/v1/admin/privacy/publish', ['ifDraftSha256' => $state['draftSha256']]), 409, 'conflict');

        $v1 = self::json($this->admin('POST', '/api/v1/admin/privacy/publish', ['ifDraftSha256' => $put['draftSha256']]));
        self::assertSame(1, $v1['current']['version']);
        self::assertEquals(['name' => 'Traveler', 'email' => 'traveler@example.org'], $v1['current']['controller']);
        self::assertSame(['de', 'en'], array_keys($v1['current']['texts']));
        self::assertCount(1, $v1['versions']);
        $stored = (string) $this->appDb()->scalar('SELECT notice FROM privacy_notice_versions WHERE version = 1');
        self::assertSame($v1['versions'][0]['sha256'], hash('sha256', $stored));

        $draft['texts']['de']['intro'] = 'Neu.';
        $put2 = self::json($this->admin('PUT', '/api/v1/admin/privacy/draft', $draft));
        $v2 = self::json($this->admin('POST', '/api/v1/admin/privacy/publish', ['ifDraftSha256' => $put2['draftSha256']]));
        self::assertSame(2, $v2['current']['version']);
        self::assertSame([2, 1], array_column($v2['versions'], 'version'));
        self::assertSame($stored, $this->appDb()->scalar('SELECT notice FROM privacy_notice_versions WHERE version = 1'), 'versions are immutable');
        self::assertSame(2, self::json($this->admin('GET', '/api/v1/admin/status'))['access']['noticeVersion']);
    }
}
