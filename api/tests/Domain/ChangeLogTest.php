<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Domain;

use LogicException;
use Omw\Api\Domain\ChangeLog;
use Omw\Api\Http\ApiException;
use Omw\Api\Infra\Db;
use Omw\Api\Infra\SchemaValidator;
use Omw\Api\Tests\TestCase;

final class ChangeLogTest extends TestCase
{
    private Db $db;
    private ChangeLog $log;
    private SchemaValidator $schemas;

    protected function setUp(): void
    {
        parent::setUp();
        $this->db = $this->migratedDb($this->config());
        $this->schemas = SchemaValidator::fromRoot(self::rootDir());
        $this->log = new ChangeLog($this->db, $this->schemas);
    }

    /**
     * @param array<string, mixed> $extra
     * @return array<string, mixed>
     */
    private static function day(array $extra = []): array
    {
        return array_merge(['localDate' => '2026-11-15', 'title' => ['de' => 'Laternen'], 'updatedAt' => '2026-11-15T08:00:00.000Z'], $extra);
    }

    private function append(string $entity, string $key, string $op, mixed $data): int
    {
        return $this->db->write(fn (): int => $this->log->append($entity, $key, $op, $data));
    }

    public function testAppendsValidItemsAndServesThemAsAContractPage(): void
    {
        $seeded = $this->log->maxSeq();
        $daySeq = $this->append('day', '2026-11-15', 'upsert', self::day(['placeName' => null, 'tz' => 'Asia/Ho_Chi_Minh']));
        $this->append('setting', 'publish.mode', 'upsert', 'review');
        $this->append('post', 'p_gone0001', 'delete', null);

        self::assertSame($seeded + 3, $this->log->maxSeq());
        self::assertSame($daySeq, $this->log->latestSeq('day', '2026-11-15'));
        self::assertSame(0, $this->log->latestSeq('day', '2026-11-16'));

        $page = $this->log->page($seeded, 2);
        self::assertSame([], $this->schemas->errors($page, 'ChangesResponse'));
        self::assertSame($this->log->feedId(), $page->feedId);
        self::assertTrue($page->hasMore);
        self::assertSame($seeded + 2, $page->nextSeq);
        self::assertCount(2, $page->items);

        $rest = $this->log->page($page->nextSeq);
        self::assertFalse($rest->hasMore);
        self::assertSame('delete', $rest->items[0]->op);
        self::assertObjectNotHasProperty('data', $rest->items[0]);
        $empty = $this->log->page($rest->nextSeq);
        self::assertSame([], $empty->items);
        self::assertSame($rest->nextSeq, $empty->nextSeq);
        // The seeded settings validate too (ChangeItem + per-key value schema).
        self::assertSame([], $this->schemas->errors($this->log->page(0, 1000), 'ChangesResponse'));
    }

    /** @return iterable<string, array{string, string, mixed}> */
    public static function invalidChanges(): iterable
    {
        yield 'ftp ntfy url' => ['setting', 'alerts.ntfy_url', 'ftp://ntfy.example/t'];
        yield 'file url' => ['setting', 'alerts.ntfy_url', 'file:///etc/passwd'];
        yield 'unknown setting' => ['setting', 'site.colour', 'pink'];
        yield 'default locale not a locale' => ['setting', 'site.default_locale', 'fr'];
        yield 'duplicate locales' => ['setting', 'site.locales', ['de', 'de']];
        yield 'empty title is [] not {}' => ['day', '2026-11-15', self::day(['title' => []])];
        yield 'bad country' => ['day', '2026-11-15', self::day(['countryCode' => 'vn'])];
        yield 'story without title' => ['post', 'p_story0001', [
            'publicId' => 'p_story0001', 'kind' => 'story', 'occurredAt' => '2026-11-15T12:00:00Z', 'tz' => 'Asia/Ho_Chi_Minh',
            'localDate' => '2026-11-15', 'content' => ['de' => ['body' => '# Hi']], 'origLocale' => 'de',
            'visibility' => 'public', 'updatedAt' => '2026-11-15T12:00:00Z',
        ]];
        yield 'upsert without data' => ['trip', 'vietnam-2026', null];
    }

    #[\PHPUnit\Framework\Attributes\DataProvider('invalidChanges')]
    public function testRejectsItemsTheBackendCouldNotParse(string $entity, string $key, mixed $data): void
    {
        $before = $this->log->maxSeq();
        try {
            $this->append($entity, $key, 'upsert', $data);
            self::fail('accepted an invalid change');
        } catch (ApiException $e) {
            self::assertSame(422, $e->status);
        }
        self::assertSame($before, $this->log->maxSeq(), 'nothing written');
    }

    public function testMustRunInsideTheEntityTransaction(): void
    {
        $this->expectException(LogicException::class);
        $this->log->append('setting', 'publish.mode', 'upsert', 'review');
    }

    public function testAfterBeyondTheNewestSeqIsAFeedReset(): void
    {
        try {
            $this->log->page($this->log->maxSeq() + 5);
            self::fail('no feed_reset');
        } catch (ApiException $e) {
            self::assertSame(409, $e->status);
            self::assertSame('feed_reset', $e->errorCode);
        }
    }

    /**
     * Regression: pages are bounded by size, not only by count, so a run of long stories cannot
     * exhaust memory_limit (and wedge the backend's sync on that page). Every item still arrives.
     */
    public function testPagesAreBoundedBySizeButAlwaysMakeProgress(): void
    {
        $body = str_repeat('Lorem ipsum dolor sit amet. ', 3500); // ~98k characters (< 100k contract max)
        $keys = [];
        for ($i = 1; $i <= 50; ++$i) {
            $id = sprintf('p_long%04d', $i);
            $keys[] = $id;
            $this->append('post', $id, 'upsert', [
                'publicId' => $id, 'kind' => 'story', 'occurredAt' => '2026-11-15T08:00:00.000Z', 'tz' => 'UTC', 'localDate' => '2026-11-15',
                'origLocale' => 'de', 'visibility' => 'public', 'updatedAt' => '2026-11-15T08:00:00.000Z',
                'content' => ['de' => ['title' => 'T', 'body' => $body], 'en' => ['title' => 'T', 'body' => $body]],
            ]);
        }

        $seen = [];
        $after = $this->log->maxSeq() - 50;
        $pages = 0;
        do {
            $page = $this->log->page($after, 1000);
            ++$pages;
            self::assertNotSame([], $page->items, 'every page makes progress');
            self::assertLessThanOrEqual(ChangeLog::PAGE_BYTES + 250_000, strlen((string) json_encode($page)));
            self::assertSame([], $this->schemas->errors(SchemaValidator::toJsonValue($page), 'ChangesResponse'));
            foreach ($page->items as $item) {
                $seen[] = $item->key;
            }
            $after = $page->nextSeq;
        } while ($page->hasMore);
        self::assertSame($keys, $seen);
        self::assertGreaterThan(1, $pages);

        // The count limit still applies on its own.
        $one = $this->log->page($this->log->maxSeq() - 50, 1);
        self::assertSame(['p_long0001'], array_column(json_decode((string) json_encode($one->items), true), 'key'));
        self::assertTrue($one->hasMore);
    }

    public function testCompactionKeepsTheLatestRowPerKey(): void
    {
        $this->append('day', '2026-11-15', 'upsert', self::day());
        $this->append('day', '2026-11-15', 'upsert', self::day(['placeName' => 'Hội An']));
        $last = $this->append('day', '2026-11-15', 'delete', null);
        $other = $this->append('day', '2026-11-16', 'upsert', self::day(['localDate' => '2026-11-16']));

        self::assertSame(0, $this->log->compact('2000-01-01T00:00:00.000Z'), 'young rows are kept');
        self::assertSame(2, $this->log->compact('2999-01-01T00:00:00.000Z'));
        $rows = $this->db->all("SELECT seq, op FROM change_log WHERE entity = 'day' ORDER BY seq");
        self::assertSame([['seq' => $last, 'op' => 'delete'], ['seq' => $other, 'op' => 'upsert']], $rows);
        self::assertSame($other, $this->log->maxSeq());
    }
}
