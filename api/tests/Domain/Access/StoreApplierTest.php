<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Domain\Access;

use LogicException;
use Omw\Api\Domain\Access\StoreApplier;
use Omw\Api\Domain\Access\StoreLayout;
use Omw\Api\Domain\Access\StoreOps;
use Omw\Api\Domain\Access\Tokens;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;
use Omw\Api\Infra\Store\StoreWriterException;
use Omw\Api\Tests\Http\AccessTestCase;
use Omw\Api\Tests\Support\FakeStoreWriter;
use Omw\Api\Tests\Support\FakeWriterFactory;

/**
 * StoreApplier (spec-wave5 §3.8.3): id order, stop at the first failure, the lease against the
 * Mac, the per-op lease check, the store marker with storeId, refusal on a missing or foreign
 * marker, init only without a marker, the drain of ops enqueued during a run, and no open
 * transaction during any writer call (the fake asserts it on every call).
 */
final class StoreApplierTest extends AccessTestCase
{
    private const FID = 'abcdefgh2345';
    private const DID = 'qrst2345';

    private FakeStoreWriter $writer;
    private FakeWriterFactory $factory;
    private string $storeId;

    protected function setUp(): void
    {
        parent::setUp();
        $this->bootAccess();
        $this->migrate();
        $this->writer = new FakeStoreWriter($this->appDb());
        $this->factory = new FakeWriterFactory($this->service(\Omw\Api\Config::class), $this->writer);
        $this->replaceWriters($this->factory);
        $this->storeId = Tokens::hex16();
        $this->appDb()->exec('UPDATE access_state SET store_id = ? WHERE id = 1', [$this->storeId]);
    }

    private function applier(): StoreApplier
    {
        return $this->service(StoreApplier::class);
    }

    private function ops(): StoreOps
    {
        return $this->service(StoreOps::class);
    }

    private function epoch(): string
    {
        return (string) $this->appDb()->scalar('SELECT epoch FROM access_state WHERE id = 1');
    }

    private function writeMarker(?string $storeId = null, ?string $epoch = null): void
    {
        $this->writer->files[StoreLayout::MARKER] = StoreApplier::markerJson($storeId ?? $this->storeId, $epoch ?? $this->epoch(), 0);
    }

    private function enqueue(string $op, string $path, ?string $content = null): int
    {
        return $this->appDb()->write(fn (): int => $this->ops()->enqueue($op, $path, $content));
    }

    public function testInitWritesTheMarkerAndTheDenyFileThenOpsRunInIdOrder(): void
    {
        $sid = Tokens::token();
        $init = $this->enqueue('init', StoreLayout::MARKER, StoreApplier::markerJson($this->storeId, $this->epoch(), 0));
        $this->enqueue('delete_prefix', StoreLayout::sessionPrefix(self::FID, self::DID));
        $put = $this->enqueue('put', StoreLayout::session(self::FID, self::DID, $sid), '');
        $this->enqueue('put', StoreLayout::handoff(self::DID), '');
        $this->enqueue('put', StoreLayout::LOCKED, '{"at":"2026-11-20T10:00:00.000Z","by":"admin"}');

        $result = $this->applier()->applyNow(8.0);
        self::assertTrue($result['ran']);
        self::assertSame(4, $result['applied']);
        self::assertSame(0, $result['pending']);
        self::assertSame([
            'replace .htaccess',
            'put .omw-store.json',
            'delete_prefix s/' . self::FID . '/' . self::DID . '.',
            'put s/' . self::FID . '/' . self::DID . '.<redacted>',
            'put h/' . self::DID,
            'put locked',
            'replace .omw-store.json',
        ], $this->writer->calls);
        self::assertSame(StoreLayout::HTACCESS_CONTENT, $this->writer->files['.htaccess']);
        $marker = StoreApplier::parseMarker($this->writer->files[StoreLayout::MARKER]);
        self::assertNotNull($marker);
        self::assertSame($this->storeId, $marker['storeId']);
        self::assertSame($this->epoch(), $marker['epoch']);
        self::assertSame($put + 2, $marker['op']);
        self::assertArrayHasKey(StoreLayout::session(self::FID, self::DID, $sid), $this->writer->files);

        $db = $this->appDb();
        self::assertSame('s/' . self::FID . '/' . self::DID . '.<redacted>', $db->scalar('SELECT path FROM store_ops WHERE id = ?', [$put]), 'no usable sid stays in the database');
        self::assertSame('api', $db->scalar('SELECT applied_by FROM store_ops WHERE id = ?', [$init]));
        self::assertSame($put + 2, (int) $db->scalar('SELECT last_applied_op FROM access_state'));
        self::assertNull($db->scalar('SELECT lease_holder FROM access_state'), 'lease released');
        self::assertSame(['applied' => true, 'via' => 'direct', 'pendingOps' => 0], $this->applier()->effect($put));
    }

    public function testStopsAtTheFirstFailureAndContinuesInOrderLater(): void
    {
        $this->writeMarker();
        $a = $this->enqueue('put', StoreLayout::handoff('aaaaaaaa'), '');
        $b = $this->enqueue('put', StoreLayout::handoff('bbbbbbbb'), '');
        $c = $this->enqueue('put', StoreLayout::handoff('cccccccc'), '');
        $this->writer->failOn = 'h/bbbbbbbb';

        $result = $this->applier()->applyNow(8.0);
        self::assertSame(1, $result['applied']);
        self::assertSame(2, $result['pending']);
        $db = $this->appDb();
        self::assertNotNull($db->scalar('SELECT applied_at FROM store_ops WHERE id = ?', [$a]));
        self::assertSame(1, (int) $db->scalar('SELECT attempts FROM store_ops WHERE id = ?', [$b]));
        self::assertStringContainsString('h/bbbbbbbb', (string) $db->scalar('SELECT last_error FROM store_ops WHERE id = ?', [$b]));
        self::assertNull($db->scalar('SELECT applied_at FROM store_ops WHERE id = ?', [$c]), 'order matters: nothing after the failure');
        self::assertNotContains('put h/cccccccc', $this->writer->calls);
        self::assertSame(['applied' => false, 'via' => 'pending', 'pendingOps' => 2], $this->applier()->effect($b));
        self::assertNotNull($db->scalar('SELECT writer_error FROM access_state'));

        $this->writer->failOn = null;
        self::assertSame(2, $this->applier()->applyNow(8.0)['applied']);
        self::assertNull($db->scalar('SELECT writer_error FROM access_state'));
    }

    public function testTheMacLeaseKeepsTheApiOut(): void
    {
        $this->writeMarker();
        $this->enqueue('put', StoreLayout::handoff('aaaaaaaa'), '');
        $db = $this->appDb();
        $db->exec("UPDATE access_state SET lease_holder = 'mac', lease_until = ?", [Clock::iso(Clock::now()->modify('+30 seconds'))]);
        $result = $this->applier()->applyNow(8.0);
        self::assertFalse($result['ran']);
        self::assertSame('mac', $result['reason']);
        self::assertSame([], $this->writer->calls);
        self::assertSame('mac', $db->scalar('SELECT lease_holder FROM access_state'), 'the Mac keeps its lease');

        Clock::advance('+31 seconds'); // expired: the API takes over
        self::assertSame(1, $this->applier()->applyNow(8.0)['applied']);
    }

    public function testThePerOpLeaseCheckRenewsAndStopsWhenTheLeaseIsLost(): void
    {
        $this->writeMarker();
        foreach (['aaaaaaaa', 'bbbbbbbb', 'cccccccc'] as $did) {
            $this->enqueue('put', StoreLayout::handoff($did), '');
        }
        $db = $this->appDb();
        // During the first op the lease runs short: the applier renews it before the next op.
        $this->writer->during = function (string $rel) use ($db): void {
            if ($rel === 'h/aaaaaaaa') {
                $db->exec('UPDATE access_state SET lease_until = ?', [Clock::iso(Clock::now()->modify('+5 seconds'))]);
            }
        };
        self::assertSame(3, $this->applier()->applyNow(8.0)['applied']);

        // Now the lease is lost to the Mac during the first op: the applier stops at once.
        foreach (['dddddddd', 'eeeeeeee'] as $did) {
            $this->enqueue('put', StoreLayout::handoff($did), '');
        }
        $this->writer->during = function (string $rel) use ($db): void {
            if ($rel === 'h/dddddddd') {
                $db->exec("UPDATE access_state SET lease_holder = 'mac', lease_until = ?", [Clock::iso(Clock::now()->modify('+5 seconds'))]);
            }
        };
        $result = $this->applier()->applyNow(8.0);
        self::assertSame(1, $result['applied']);
        self::assertNotContains('put h/eeeeeeee', $this->writer->calls);
        self::assertSame('mac', $db->scalar('SELECT lease_holder FROM access_state'));
    }

    public function testRefusesAMissingForeignOrUnreadableMarker(): void
    {
        $this->enqueue('put', StoreLayout::handoff('aaaaaaaa'), '');
        $db = $this->appDb();

        $missing = $this->applier()->applyNow(8.0);
        self::assertSame('store_unverified', $missing['reason']);
        self::assertStringStartsWith('store_unverified: the store marker is missing', (string) $db->scalar('SELECT writer_error FROM access_state'));
        self::assertSame([], $this->writer->calls);

        $this->writeMarker(Tokens::hex16());
        self::assertSame('store_unverified', $this->applier()->applyNow(8.0)['reason']);
        self::assertStringContainsString('another store', (string) $db->scalar('SELECT writer_error FROM access_state'));

        $this->writer->files[StoreLayout::MARKER] = '{"format":2}';
        self::assertSame('store_unverified', $this->applier()->applyNow(8.0)['reason']);
        self::assertSame(1, $this->ops()->pendingCount(), 'ops stay pending');
        self::assertSame([], $this->writer->calls);

        $db->exec('UPDATE access_state SET store_id = NULL');
        self::assertSame('store_unverified', $this->applier()->applyNow(8.0)['reason']);
    }

    public function testInitNeverOverwritesAnExistingMarker(): void
    {
        // Same store: the init op is a no-op, the ops after it run.
        $this->writeMarker();
        $this->enqueue('init', StoreLayout::MARKER, StoreApplier::markerJson($this->storeId, $this->epoch(), 0));
        $this->enqueue('put', StoreLayout::handoff('aaaaaaaa'), '');
        self::assertSame(1, $this->applier()->applyNow(8.0)['applied']);
        self::assertNotContains('put .omw-store.json', $this->writer->calls);
        self::assertSame(0, $this->ops()->pendingCount());

        // A foreign marker: init does not replace it and nothing is applied.
        $foreign = StoreApplier::markerJson(Tokens::hex16(), $this->epoch(), 9);
        $this->writer->files[StoreLayout::MARKER] = $foreign;
        $this->writer->calls = [];
        $this->enqueue('init', StoreLayout::MARKER, StoreApplier::markerJson($this->storeId, $this->epoch(), 0));
        $this->enqueue('put', StoreLayout::handoff('bbbbbbbb'), '');
        self::assertSame('store_unverified', $this->applier()->applyNow(8.0)['reason']);
        self::assertSame($foreign, $this->writer->files[StoreLayout::MARKER]);
        self::assertSame([], $this->writer->calls);
    }

    public function testAPendingInitIsAppliedFirstWhenTheMarkerIsMissing(): void
    {
        // Ops enqueued before the store was initialised wait for the init op behind them.
        $this->enqueue('put', StoreLayout::handoff('aaaaaaaa'), '');
        $this->enqueue('init', StoreLayout::MARKER, StoreApplier::markerJson($this->storeId, $this->epoch(), 0));
        self::assertSame(1, $this->applier()->applyNow(8.0)['applied']);
        self::assertSame(0, $this->ops()->pendingCount());
        self::assertSame('put .omw-store.json', $this->writer->calls[1]);
    }

    public function testDrainsOpsEnqueuedDuringTheRun(): void
    {
        $this->writeMarker();
        $this->enqueue('put', StoreLayout::handoff('aaaaaaaa'), '');
        $ops = $this->ops();
        $db = $this->appDb();
        $done = false;
        $this->writer->during = function () use (&$done, $ops, $db): void {
            if (!$done) {
                $done = true; // another request enqueues while this run holds the lock
                $db->write(fn (): int => $ops->enqueue('put', StoreLayout::handoff('bbbbbbbb'), ''));
            }
        };
        self::assertSame(2, $this->applier()->applyNow(8.0)['applied']);
        self::assertSame(0, $ops->pendingCount());
    }

    public function testNeverRunsInsideATransaction(): void
    {
        $db = $this->service(Db::class);
        $this->expectException(LogicException::class);
        $db->write(fn (): array => $this->applier()->applyNow(8.0));
    }

    public function testAnAuthFailureBlocksTheWriterUntilRetry(): void
    {
        $this->writeMarker();
        $this->enqueue('put', StoreLayout::handoff('aaaaaaaa'), '');
        $this->factory->throw = new StoreWriterException('auth', 'The SFTP login was refused');
        self::assertSame('writer', $this->applier()->applyNow(20.0)['reason']);
        $db = $this->appDb();
        self::assertNotNull($db->scalar('SELECT writer_blocked_at FROM access_state'));
        self::assertSame(1, $this->factory->opened);

        // Never retried automatically (requests and cron alike).
        self::assertSame('blocked', $this->applier()->applyNow(20.0)['reason']);
        self::assertSame('blocked', $this->applier()->applyNow(8.0)['reason']);
        self::assertSame(1, $this->factory->opened);
        self::assertTrue(\Omw\Api\Http\Backend\AccessSyncController::needsWriter($db, $this->service(\Omw\Api\Config::class)));

        $this->factory->throw = null;
        $this->applier()->clearBlock();
        self::assertSame(1, $this->applier()->applyNow(8.0)['applied']);
    }

    public function testRequestsBackOffAfterAConnectFailureButCronRetries(): void
    {
        $this->writeMarker();
        $this->enqueue('put', StoreLayout::handoff('aaaaaaaa'), '');
        $this->factory->throw = new StoreWriterException('connect', 'timeout');
        $this->applier()->applyNow(8.0);
        self::assertSame(1, $this->factory->opened);
        self::assertSame('backoff', $this->applier()->applyNow(8.0)['reason']);
        self::assertSame(1, $this->factory->opened, 'a request does not wait for a broken connection again');
        $this->factory->throw = null;
        self::assertSame(1, $this->applier()->applyNow(20.0)['applied'], 'cron tries');
    }

    public function testAMarkerFromAnotherEpochFreezesJoinsUntilReconciled(): void
    {
        $this->writeMarker(null, Tokens::hex16());
        $this->enqueue('put', StoreLayout::handoff('aaaaaaaa'), '');
        $this->applier()->applyNow(8.0);
        $db = $this->appDb();
        self::assertNotSame($db->scalar('SELECT epoch FROM access_state'), $db->scalar('SELECT reconciled_epoch FROM access_state'));
        $result = $this->applier()->applyNow(20.0, true);
        self::assertTrue($result['reconciled']);
        self::assertSame($db->scalar('SELECT epoch FROM access_state'), $db->scalar('SELECT reconciled_epoch FROM access_state'));
        $marker = StoreApplier::parseMarker($this->writer->files[StoreLayout::MARKER]);
        self::assertSame($this->epoch(), $marker['epoch'] ?? null, 'the marker gets the new epoch after the reconcile');
    }

    public function testAPersonTombstoneIsUpgradedFromRevokedToDeleted(): void
    {
        $this->writeMarker();
        $path = StoreLayout::personTombstone(self::FID);
        $this->enqueue('put', $path, StoreOps::json(['s' => 'revoked', 'at' => '2026-11-19T00:00:00.000Z']));
        $this->enqueue('put', $path, StoreOps::json(['s' => 'deleted', 'at' => '2026-11-20T00:00:00.000Z']));
        $this->enqueue('put', $path, StoreOps::json(['s' => 'revoked', 'at' => '2026-11-21T00:00:00.000Z']));
        $this->applier()->applyNow(8.0);
        self::assertSame('{"s":"deleted","at":"2026-11-20T00:00:00.000Z"}', $this->writer->files[$path], 'never back from deleted');
    }

    public function testInvalidOpsAreRefusedAtEnqueue(): void
    {
        $this->expectException(LogicException::class);
        $this->enqueue('put', '../etc/passwd', '');
    }
}
