<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Http;

use Omw\Api\Domain\Settings;
use Omw\Api\Infra\Db;

/**
 * The profile settings site.author, site.intro and site.avatar: validation (contract schema plus
 * the avatar's capture rule), clearing with null, and their change-feed items.
 */
final class SiteProfileSettingsTest extends ApiTestCase
{
    private const AUTHOR = 'Lea';
    private const INTRO = ['de' => 'Hallo ihr Lieben! Schön, dass ihr mit mir unterwegs seid.', 'en' => 'So glad you’re coming along!'];

    public function testSetReadAnnounceAndClear(): void
    {
        $defaults = self::json($this->admin('GET', '/api/v1/admin/settings'));
        foreach (['site.author', 'site.intro', 'site.avatar'] as $key) {
            self::assertArrayNotHasKey($key, $defaults, 'optional, no default');
        }

        // The owner's explicit choice wins over the item's own visibility: a photo hidden from the
        // timeline can still be the portrait.
        $photo = $this->putCapture('3EB0PORTRAIT01', '2026-11-18T02:00:00.000Z');
        $hide = $this->admin('PATCH', '/api/v1/admin/captures/' . rawurlencode($photo), ['visibility' => 'hidden']);
        self::assertSame(200, $hide->getStatusCode(), (string) $hide->getBody());

        $seq = $this->maxSeq();
        $avatar = ['sourceKey' => $photo, 'focus' => ['x' => 0.5, 'y' => 0.35]];
        $patched = self::json($this->admin('PATCH', '/api/v1/admin/settings', [
            'site.author' => self::AUTHOR, 'site.intro' => self::INTRO, 'site.avatar' => $avatar,
        ]));
        self::assertSame(self::AUTHOR, $patched['site.author']);
        self::assertSame(self::INTRO, $patched['site.intro']);
        self::assertSame($avatar, $patched['site.avatar']);
        self::assertSame($patched, self::json($this->admin('GET', '/api/v1/admin/settings')));

        $items = $this->changesAfter($seq);
        self::assertSame(['site.author', 'site.intro', 'site.avatar'], array_column($items, 'key'), 'contract order');
        self::assertSame(['upsert', 'upsert', 'upsert'], array_column($items, 'op'));
        self::assertSame(['value' => self::AUTHOR], $items[0]['data']);
        self::assertSame(['value' => self::INTRO], $items[1]['data']);
        self::assertSame(['value' => $avatar], $items[2]['data']);

        // Re-sending the same values (other key order) is no change: nothing on the feed.
        $seq = $this->maxSeq();
        $same = $this->admin('PATCH', '/api/v1/admin/settings', [
            'site.intro' => array_reverse(self::INTRO, true),
            'site.avatar' => ['focus' => ['y' => 0.35, 'x' => 0.5], 'sourceKey' => $photo],
        ]);
        self::assertSame(200, $same->getStatusCode(), (string) $same->getBody());
        self::assertSame([], $this->changesAfter($seq));

        // A focus is optional; changing only the portrait announces only site.avatar.
        $other = $this->putCapture('3EB0PORTRAIT02', '2026-11-18T03:00:00.000Z');
        $changed = self::json($this->admin('PATCH', '/api/v1/admin/settings', ['site.avatar' => ['sourceKey' => $other]]));
        self::assertSame(['sourceKey' => $other], $changed['site.avatar']);
        $items = $this->changesAfter($seq);
        self::assertSame([['site.avatar', 'upsert', ['value' => ['sourceKey' => $other]]]], array_map(
            static fn (array $i): array => [$i['key'], $i['op'], $i['data'] ?? null],
            $items,
        ));

        // null clears each key -> tombstones; clearing again announces nothing.
        $seq = $this->maxSeq();
        $cleared = self::json($this->admin('PATCH', '/api/v1/admin/settings', [
            'site.author' => null, 'site.intro' => null, 'site.avatar' => null,
        ]));
        foreach (['site.author', 'site.intro', 'site.avatar'] as $key) {
            self::assertArrayNotHasKey($key, $cleared);
        }
        $items = $this->changesAfter($seq);
        self::assertSame(['site.author', 'site.intro', 'site.avatar'], array_column($items, 'key'));
        self::assertSame(['delete', 'delete', 'delete'], array_column($items, 'op'));
        foreach ($items as $item) {
            self::assertArrayNotHasKey('data', $item);
        }
        $seq = $this->maxSeq();
        self::assertSame(200, $this->admin('PATCH', '/api/v1/admin/settings', ['site.author' => null])->getStatusCode());
        self::assertSame([], $this->changesAfter($seq));
    }

    public function testSchemaValidation(): void
    {
        $photo = $this->putCapture('3EB0PORTRAIT03', '2026-11-18T02:00:00.000Z');
        $bad = [
            ['site.author' => ''],
            ['site.author' => ' Lea'],
            ['site.author' => 'Lea '],
            ['site.author' => "Le\na"],
            ['site.author' => "Le\ta"],
            ['site.author' => str_repeat('a', 61)],
            ['site.author' => 7],
            ['site.intro' => new \stdClass()],
            ['site.intro' => 'Hallo'],
            ['site.intro' => ['de' => '']],
            ['site.intro' => ['de' => ' Hallo']],
            ['site.intro' => ['de' => "Hallo\n"]],
            ['site.intro' => ['de' => "Hal\r\nlo"]],
            ['site.intro' => ['de' => str_repeat('x', 161)]],
            ['site.intro' => ['fr' => 'Salut']],
            ['site.avatar' => $photo],
            ['site.avatar' => ['sourceKey' => 'not a key']],
            ['site.avatar' => ['focus' => ['x' => 0.5, 'y' => 0.5]]],
            ['site.avatar' => ['sourceKey' => $photo, 'focus' => ['x' => 1.5, 'y' => 0.5]]],
            ['site.avatar' => ['sourceKey' => $photo, 'focus' => ['x' => 0.5]]],
            ['site.avatar' => ['sourceKey' => $photo, 'zoom' => 2]],
        ];
        $seq = $this->maxSeq();
        foreach ($bad as $patch) {
            self::assertError($this->admin('PATCH', '/api/v1/admin/settings', $patch), 422, 'validation_failed');
        }
        self::assertSame([], $this->changesAfter($seq), 'nothing written');

        $ok = [
            ['site.author' => 'Léa & Tom 🌸'],
            ['site.author' => str_repeat('a', 60)],
            ['site.intro' => ['de' => "Hallo ihr Lieben!\nSchön, dass ihr da seid."]],
            ['site.intro' => ['en' => '**plain text**, not markdown', 'ar' => 'مرحبا']],
            ['site.intro' => ['de' => str_repeat('x', 160)]],
            ['site.avatar' => ['sourceKey' => $photo, 'focus' => ['x' => 0, 'y' => 1]]],
        ];
        foreach ($ok as $patch) {
            $response = $this->admin('PATCH', '/api/v1/admin/settings', $patch);
            self::assertSame(200, $response->getStatusCode(), json_encode($patch) . ' ' . $response->getBody());
        }
    }

    public function testAvatarMustBeAUsableCapturedPhoto(): void
    {
        $video = $this->putCapture('3EB0VIDEO0001', '2026-11-18T02:00:00.000Z', [
            'kind' => 'video', 'media' => ['w' => 720, 'h' => 1280, 'duration' => 4],
        ]);
        $text = $this->putCapture('3EB0TEXT00001', '2026-11-18T02:10:00.000Z', [
            'kind' => 'text', 'media' => null, 'mediaState' => 'none',
            'text' => ['body' => 'Hallo', 'bg' => '#3b2341ff', 'fg' => '#ffffffff', 'font' => 'SYSTEM'],
        ]);
        $revoked = $this->putCapture('3EB0REVOKED01', '2026-11-18T02:20:00.000Z');
        $revoke = $this->backend('POST', '/api/v1/backend/captures/' . rawurlencode($revoked) . '/revoke', [
            'contractVersion' => 1, 'at' => '2026-11-18T02:30:00.000Z',
        ]);
        self::assertSame(204, $revoke->getStatusCode(), (string) $revoke->getBody());
        $lost = $this->putCapture('3EB0LOST00001', '2026-11-18T02:40:00.000Z', ['mediaState' => 'lost']);
        $unknown = 'wa:3EB0NOTMIRRORED';

        $seq = $this->maxSeq();
        $cases = [
            $unknown => 'no captured status',
            $video => 'not a photo',
            $text => 'not a photo',
            $revoked => 'deleted on WhatsApp',
            $lost => 'could not be downloaded',
        ];
        foreach ($cases as $sourceKey => $why) {
            $response = $this->admin('PATCH', '/api/v1/admin/settings', [
                'site.author' => 'Lea', 'site.avatar' => ['sourceKey' => $sourceKey],
            ]);
            self::assertError($response, 422, 'validation_failed');
            $error = self::json($response)['error'];
            self::assertIsArray($error);
            self::assertStringContainsString('site.avatar', (string) $error['message']);
            self::assertStringContainsString($why, (string) $error['message'], $sourceKey);
            self::assertSame(['errors' => ['/site.avatar/sourceKey: ' . substr((string) $error['message'], strlen('site.avatar: '))]], $error['details']);
        }
        self::assertSame([], $this->changesAfter($seq), 'a refused patch writes nothing, not even its valid keys');
        self::assertArrayNotHasKey('site.author', self::json($this->admin('GET', '/api/v1/admin/settings')));

        // A pending download is fine (the backend publishes the portrait once the photo is processed).
        $pending = $this->putCapture('3EB0PENDING01', '2026-11-18T02:50:00.000Z', ['mediaState' => 'pending']);
        self::assertSame(200, $this->admin('PATCH', '/api/v1/admin/settings', ['site.avatar' => ['sourceKey' => $pending]])->getStatusCode());
    }

    public function testALaterRevokeKeepsTheSetting(): void
    {
        $photo = $this->putCapture('3EB0PORTRAIT04', '2026-11-18T02:00:00.000Z');
        self::assertSame(200, $this->admin('PATCH', '/api/v1/admin/settings', ['site.avatar' => ['sourceKey' => $photo]])->getStatusCode());
        $seq = $this->maxSeq();
        $revoke = $this->backend('POST', '/api/v1/backend/captures/' . rawurlencode($photo) . '/revoke', [
            'contractVersion' => 1, 'at' => '2026-11-18T03:00:00.000Z',
        ]);
        self::assertSame(204, $revoke->getStatusCode(), (string) $revoke->getBody());
        self::assertSame(['sourceKey' => $photo], self::json($this->admin('GET', '/api/v1/admin/settings'))['site.avatar']);
        self::assertSame([], array_values(array_filter($this->changesAfter($seq), static fn (array $i): bool => $i['entity'] === 'setting')));
        // Unrelated patches still work (the stored avatar is not re-checked), and so does re-sending
        // the stored choice or moving its focus; picking that photo anew does not.
        self::assertSame(200, $this->admin('PATCH', '/api/v1/admin/settings', ['site.author' => 'Lea'])->getStatusCode());
        self::assertSame(200, $this->admin('PATCH', '/api/v1/admin/settings', ['site.avatar' => ['sourceKey' => $photo]])->getStatusCode());
        $moved = $this->admin('PATCH', '/api/v1/admin/settings', ['site.avatar' => ['sourceKey' => $photo, 'focus' => ['x' => 0.2, 'y' => 0.2]]]);
        self::assertSame(200, $moved->getStatusCode(), (string) $moved->getBody());
        self::assertSame(200, $this->admin('PATCH', '/api/v1/admin/settings', ['site.avatar' => null])->getStatusCode());
        self::assertError($this->admin('PATCH', '/api/v1/admin/settings', ['site.avatar' => ['sourceKey' => $photo]]), 422, 'validation_failed');
    }

    public function testKeyListsMatchTheContract(): void
    {
        $schema = json_decode((string) file_get_contents(dirname(__DIR__, 2) . '/schemas/Settings.json'), true, 64, JSON_THROW_ON_ERROR);
        self::assertIsArray($schema);
        self::assertIsArray($schema['properties']);
        self::assertIsArray($schema['required']);
        $keys = array_keys($schema['properties']);
        self::assertEqualsCanonicalizing($keys, Settings::KEYS);
        self::assertEqualsCanonicalizing(array_values(array_diff($keys, $schema['required'])), Settings::CLEARABLE);
        self::assertEqualsCanonicalizing(Settings::KEYS, Settings::WRITE_ORDER);
    }

    private function maxSeq(): int
    {
        return (int) $this->service(Db::class)->scalar('SELECT MAX(seq) FROM change_log');
    }

    /** @return list<array<string, mixed>> */
    private function changesAfter(int $seq): array
    {
        $items = self::json($this->backend('GET', '/api/v1/backend/changes?after=' . $seq))['items'];
        self::assertIsArray($items);

        /** @var list<array<string, mixed>> $items */
        return array_values(array_filter($items, static fn (array $i): bool => $i['entity'] === 'setting'));
    }
}
