<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Http;

use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;

/**
 * Posts CRUD: idempotent create per publicId, defaults (now, timezone.current, public),
 * derived local dates, kind-specific content, ifUpdatedAt conflicts, replayed deletes.
 */
final class AdminPostsTest extends ApiTestCase
{
    public function testCreateIsIdempotentPerPublicId(): void
    {
        $body = ['publicId' => 'p_01JNOTE0001', 'kind' => 'note', 'origLocale' => 'de', 'content' => ['de' => ['body' => 'Angekommen!']]];
        $created = $this->admin('POST', '/api/v1/admin/posts', $body);
        self::assertSame(201, $created->getStatusCode(), (string) $created->getBody());
        $post = self::json($created);
        self::assertSame(self::NOW, $post['occurredAt']);
        self::assertSame('Europe/Berlin', $post['tz'], 'defaults to timezone.current');
        self::assertSame('2026-11-20', $post['localDate']);
        self::assertSame('public', $post['visibility']);
        self::assertGreaterThan(0, $post['changeSeq']);

        // Replay (offline queue): 200 with the stored post, no second insert, no feed entry.
        $db = $this->service(Db::class);
        $seq = (int) $db->scalar('SELECT MAX(seq) FROM change_log');
        Clock::advance('+5 minutes');
        $replay = $this->admin('POST', '/api/v1/admin/posts', ['content' => ['de' => ['body' => 'changed']]] + $body);
        self::assertSame(200, $replay->getStatusCode());
        self::assertSame($post, self::json($replay));
        self::assertSame($seq, (int) $db->scalar('SELECT MAX(seq) FROM change_log'));
        self::assertSame(1, (int) $db->scalar('SELECT COUNT(*) FROM posts'));
    }

    public function testCreateDerivesTheLocalDateInTheGivenZone(): void
    {
        $story = $this->admin('POST', '/api/v1/admin/posts', [
            'publicId' => 'p_01JSTORY001', 'kind' => 'story', 'origLocale' => 'en', 'visibility' => 'pending',
            'occurredAt' => '2026-11-15T18:30:00Z', 'tz' => 'Asia/Ho_Chi_Minh',
            'content' => ['en' => ['title' => 'Hội An', 'body' => "# Lanterns\n\nEverywhere."], 'de' => ['title' => 'Hội An', 'body' => 'Überall.']],
        ]);
        self::assertSame(201, $story->getStatusCode(), (string) $story->getBody());
        $post = self::json($story);
        self::assertSame('2026-11-16', $post['localDate']);
        self::assertSame('2026-11-15T18:30:00.000Z', $post['occurredAt']);
        self::assertSame('Hội An', $post['content']['en']['title'], 'UTF-8 survives');
    }

    public function testCreateValidation(): void
    {
        $base = ['publicId' => 'p_01JBAD00001', 'kind' => 'note', 'origLocale' => 'de', 'content' => ['de' => ['body' => 'x']]];
        self::assertError($this->admin('POST', '/api/v1/admin/posts', ['origLocale' => 'en'] + $base), 422, 'validation_failed');
        self::assertError($this->admin('POST', '/api/v1/admin/posts', ['content' => (object) []] + $base), 422, 'validation_failed');
        self::assertError($this->admin('POST', '/api/v1/admin/posts', ['kind' => 'story'] + $base), 422, 'validation_failed');
        self::assertError($this->admin('POST', '/api/v1/admin/posts', ['tz' => 'Europe/Nowhere'] + $base), 422, 'validation_failed');
        self::assertError($this->admin('POST', '/api/v1/admin/posts', ['publicId' => 'x_123'] + $base), 422, 'validation_failed');
        self::assertError($this->admin('POST', '/api/v1/admin/posts', ['kind' => 'story', 'content' => ['de' => ['title' => '  ', 'body' => 'x']]] + $base), 422, 'validation_failed');
        self::assertError($this->admin('POST', '/api/v1/admin/posts', ['visibility' => 'secret'] + $base), 422, 'validation_failed');
        self::assertSame(0, (int) $this->service(Db::class)->scalar('SELECT COUNT(*) FROM posts'));
    }

    public function testUpdateWithOptimisticConcurrency(): void
    {
        $post = self::json($this->admin('POST', '/api/v1/admin/posts', ['publicId' => 'p_01JUPD00001', 'kind' => 'note', 'origLocale' => 'de', 'content' => ['de' => ['body' => 'v1']]]));
        $url = '/api/v1/admin/posts/p_01JUPD00001';

        $v2 = $this->admin('PATCH', $url, ['content' => ['de' => ['body' => 'v2'], 'en' => ['body' => 'v2 en']], 'ifUpdatedAt' => $post['updatedAt']]);
        self::assertSame(200, $v2->getStatusCode(), (string) $v2->getBody());
        $updated = self::json($v2);
        self::assertSame('v2 en', $updated['content']['en']['body']);
        self::assertGreaterThan($post['updatedAt'], $updated['updatedAt']);
        self::assertGreaterThan($post['changeSeq'], $updated['changeSeq']);

        // Stale ifUpdatedAt -> 409; equal instants in another notation still match.
        self::assertError($this->admin('PATCH', $url, ['visibility' => 'hidden', 'ifUpdatedAt' => $post['updatedAt']]), 409, 'conflict');

        // Moving the post changes its local date; kind cannot change through content.
        $moved = self::json($this->admin('PATCH', $url, ['occurredAt' => '2026-11-15T23:30:00Z', 'tz' => 'Europe/Berlin']));
        self::assertSame('2026-11-16', $moved['localDate']);
        self::assertError($this->admin('PATCH', $url, ['content' => ['de' => ['title' => 'Now a story', 'body' => 'x']]]), 422, 'validation_failed');
        self::assertError($this->admin('PATCH', $url, ['origLocale' => 'ar']), 422, 'validation_failed');
        self::assertError($this->admin('PATCH', $url, ['kind' => 'story']), 422, 'validation_failed');
        self::assertError($this->admin('PATCH', '/api/v1/admin/posts/p_missing01', ['visibility' => 'hidden']), 404, 'not_found');

        // No-op patch: unchanged, no feed entry.
        $db = $this->service(Db::class);
        $seq = (int) $db->scalar('SELECT MAX(seq) FROM change_log');
        self::assertSame($moved, self::json($this->admin('PATCH', $url, ['visibility' => 'public'])));
        self::assertSame($seq, (int) $db->scalar('SELECT MAX(seq) FROM change_log'));
    }

    public function testDeleteIsIdempotentAndLeavesATombstone(): void
    {
        $this->admin('POST', '/api/v1/admin/posts', ['publicId' => 'p_01JDEL00001', 'kind' => 'note', 'origLocale' => 'de', 'content' => ['de' => ['body' => 'bye']]]);
        self::assertSame(204, $this->admin('DELETE', '/api/v1/admin/posts/p_01JDEL00001')->getStatusCode());
        self::assertSame(204, $this->admin('DELETE', '/api/v1/admin/posts/p_01JDEL00001')->getStatusCode(), 'replayed delete');
        self::assertSame(204, $this->admin('DELETE', '/api/v1/admin/posts/not-an-id')->getStatusCode());
        self::assertError($this->admin('GET', '/api/v1/admin/posts/p_01JDEL00001'), 404, 'not_found');
        $ops = $this->service(Db::class)->all("SELECT op FROM change_log WHERE entity = 'post' ORDER BY seq");
        self::assertSame(['upsert', 'delete'], array_column($ops, 'op'), 'exactly one tombstone');
    }

    public function testListFiltersAndPaging(): void
    {
        foreach (['p_01JLIST0001' => '2026-11-14T10:00:00Z', 'p_01JLIST0002' => '2026-11-15T10:00:00Z', 'p_01JLIST0003' => '2026-11-16T10:00:00Z'] as $id => $at) {
            $this->admin('POST', '/api/v1/admin/posts', ['publicId' => $id, 'kind' => 'note', 'origLocale' => 'de', 'occurredAt' => $at, 'tz' => 'UTC', 'content' => ['de' => ['body' => $id]]]);
        }
        $this->admin('POST', '/api/v1/admin/posts', ['publicId' => 'p_01JLIST0004', 'kind' => 'story', 'origLocale' => 'de', 'occurredAt' => '2026-11-15T12:00:00Z', 'tz' => 'UTC', 'visibility' => 'hidden', 'content' => ['de' => ['title' => 'T', 'body' => 'B']]]);

        $page1 = self::json($this->admin('GET', '/api/v1/admin/posts?limit=2'));
        self::assertSame(['p_01JLIST0003', 'p_01JLIST0004'], array_column($page1['items'], 'publicId'));
        self::assertIsString($page1['nextCursor']);
        $page2 = self::json($this->admin('GET', '/api/v1/admin/posts?limit=2&cursor=' . $page1['nextCursor']));
        self::assertSame(['p_01JLIST0002', 'p_01JLIST0001'], array_column($page2['items'], 'publicId'));
        self::assertNull($page2['nextCursor']);

        self::assertSame(['p_01JLIST0004', 'p_01JLIST0002'], array_column(self::json($this->admin('GET', '/api/v1/admin/posts?date=2026-11-15'))['items'], 'publicId'));
        self::assertSame(['p_01JLIST0004'], array_column(self::json($this->admin('GET', '/api/v1/admin/posts?kind=story'))['items'], 'publicId'));
        self::assertSame(['p_01JLIST0004'], array_column(self::json($this->admin('GET', '/api/v1/admin/posts?visibility=hidden'))['items'], 'publicId'));
        self::assertError($this->admin('GET', '/api/v1/admin/posts?kind=photo'), 422, 'validation_failed');
    }
}
