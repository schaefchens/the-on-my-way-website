<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Domain\Access;

use Omw\Api\Domain\Access\PrivacyNotices;
use Omw\Api\Domain\Settings;
use Omw\Api\Http\ApiException;
use Omw\Api\Tests\Http\AccessTestCase;

/**
 * Domain\Access\PrivacyNotices (D11, Q7): the lazily seeded draft, canonical JSON for the hashes,
 * completeness incl. de + en with site.locales = ['de'], versions, the sha conflict.
 */
final class PrivacyNoticesTest extends AccessTestCase
{
    public function testCanonicalJsonSortsKeysAndKeepsLists(): void
    {
        $value = json_decode('{"b":1,"a":{"d":[3,2,{"z":1,"y":2}],"c":"ä/x"}}', false);
        self::assertSame('{"a":{"c":"ä/x","d":[3,2,{"y":2,"z":1}]},"b":1}', PrivacyNotices::canonical($value));
        self::assertSame(PrivacyNotices::canonical(['b' => 1, 'a' => 2]), PrivacyNotices::canonical((object) ['a' => 2, 'b' => 1]));
    }

    public function testCompletenessAndPublishing(): void
    {
        $this->bootAccess();
        $this->migrate();
        $notices = $this->service(PrivacyNotices::class);
        $settings = $this->service(Settings::class);
        $settings->patch((object) ['site.locales' => ['de'], 'site.default_locale' => 'de']);
        self::assertSame(['de', 'en'], $notices->requiredLocales(), 'de and en always (D11)');
        $draft = $notices->draft();
        self::assertSame(['controller.name', 'controller.email'], $notices->problems($draft));
        $draft->controller = (object) ['name' => 'T', 'email' => 'not-an-email'];
        self::assertSame(['controller.email'], $notices->problems($draft));
        $draft->controller->email = 't@example.org';
        unset($draft->texts->en);
        self::assertSame(['texts.en.title', 'texts.en.intro', 'texts.en.collected', 'texts.en.audience', 'texts.en.purpose', 'texts.en.retention', 'texts.en.rights'], $notices->problems($draft));
        $notices->putDraft($draft);
        try {
            $notices->publish(hash('sha256', PrivacyNotices::canonical($draft)));
            self::fail('published an incomplete notice');
        } catch (ApiException $e) {
            self::assertSame('notice_incomplete', $e->errorCode);
        }

        $complete = $this->service(PrivacyNotices::class)->draft();
        $template = json_decode(str_replace('{backupDays}', '14', (string) file_get_contents(PrivacyNotices::TEMPLATE)), false);
        $complete->texts->en = $template->texts->en;
        $notices->putDraft($complete);
        try {
            $notices->publish(str_repeat('0', 64));
            self::fail('stale sha accepted');
        } catch (ApiException $e) {
            self::assertSame('conflict', $e->errorCode);
        }
        $notices->publish(hash('sha256', PrivacyNotices::canonical($complete)));
        self::assertSame(1, $notices->currentVersion());
        $current = $notices->current();
        self::assertNotNull($current);
        self::assertSame(['de', 'en'], array_keys($current['texts']));
        self::assertStringNotContainsString('{backupDays}', json_encode($current, JSON_THROW_ON_ERROR));
        self::assertSame($notices->notice(1), array_diff_key($current, ['version' => 1, 'publishedAt' => 1]));
    }
}
