<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Infra;

use Omw\Api\Domain\Access\AccessState;
use Omw\Api\Domain\Access\Reconciler;
use Omw\Api\Domain\Access\StoreApplier;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Store\DirectStoreWriter;
use Omw\Api\Tests\Http\AccessTestCase;

/**
 * The reconcile against concurrent changes (spec-wave5 §3.8.5, §3.3 Lock 4): an unlock committed
 * between the listing and the plan neither re-locks the site nor imports the old lock, and its
 * own op deletes the old file; a lock file newer than unlocked_at (the Mac's lock button) is
 * imported and never deleted by the repair job.
 */
final class ReconcileRaceTest extends AccessTestCase
{
    public function testAnUnlockDuringTheListingWins(): void
    {
        $this->bootAccess();
        $this->initStoreDirect();
        $state = $this->service(AccessState::class);
        $applier = $this->service(StoreApplier::class);
        $state->lock('admin');
        $applier->applyNow(8.0);
        self::assertTrue($this->storeHas('locked'));

        // The repair job lists the store ...
        $listedThrough = (int) $state->row()['last_applied_op'];
        $listing = StoreApplier::listing(new DirectStoreWriter($this->storeDir()));
        self::assertNotNull($listing['locked']);

        // ... meanwhile the owner unlocks (committed, op not applied yet) ...
        Clock::advance('+1 second');
        $state->unlock();

        // ... then the plan runs on the old listing.
        $report = $this->service(Reconciler::class)->run($listing, $listedThrough);
        self::assertSame([], $report['imported'], 'the old lock is not imported');
        self::assertFalse($state->isLocked(), 'no re-lock');
        self::assertSame(1, (int) $this->appDb()->scalar('SELECT COUNT(*) FROM store_ops WHERE applied_at IS NULL'), 'only the unlock\'s own op');
        $applier->applyNow(8.0);
        self::assertFalse($this->storeHas('locked'), 'the unlock deleted the old file');
        self::assertFalse($state->isLocked());
    }

    public function testALockFileNewerThanTheLastUnlockIsImported(): void
    {
        $this->bootAccess();
        $this->initStoreDirect();
        $state = $this->service(AccessState::class);
        $state->lock('admin');
        Clock::advance('+1 minute');
        $state->unlock();
        $applier = $this->service(StoreApplier::class);
        $applier->applyNow(8.0);
        self::assertFalse($this->storeHas('locked'));

        // The Mac's lock button writes the file directly (§5.6.6).
        Clock::advance('+1 minute');
        file_put_contents($this->storeDir() . '/locked', '{"at":"' . Clock::nowIso() . '","by":"mac"}');
        $result = $applier->applyNow(20.0, true);
        self::assertTrue($result['reconciled']);
        self::assertTrue($state->isLocked());
        self::assertSame('mac', $state->row()['locked_by']);
        self::assertTrue($this->storeHas('locked'), 'never deleted by the repair job');
        $applier->applyNow(20.0, true);
        self::assertTrue($this->storeHas('locked'));

        // An older leftover file is deleted instead.
        Clock::advance('+1 minute');
        $state->unlock();
        $applier->applyNow(8.0);
        file_put_contents($this->storeDir() . '/locked', '{"at":"2026-11-01T00:00:00.000Z","by":"mac"}');
        $applier->applyNow(20.0, true);
        self::assertFalse($state->isLocked());
        $applier->applyNow(8.0);
        self::assertFalse($this->storeHas('locked'));
    }
}
