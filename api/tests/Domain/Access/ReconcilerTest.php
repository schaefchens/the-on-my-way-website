<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Domain\Access;

use Omw\Api\Domain\Access\Reconciler;
use Omw\Api\Domain\Access\StoreLayout;
use Omw\Api\Tests\TestCase;

/**
 * Reconciler::plan() against fixtures/vectors/store-reconcile.json (spec-wave5 §3.8.5, §4.3):
 * both modes, the sticky lock older/newer than unlocked_at, ops newer than the listing skipped,
 * orphans removed, unknown fids tombstoned, missing sessions, stray files.
 */
final class ReconcilerTest extends TestCase
{
    public function testVectors(): void
    {
        $file = dirname(__DIR__, 4) . '/fixtures/vectors/store-reconcile.json';
        $doc = json_decode((string) file_get_contents($file), true, 64, JSON_THROW_ON_ERROR);
        self::assertIsArray($doc);
        self::assertGreaterThanOrEqual(15, count($doc['cases']));
        foreach ($doc['cases'] as $c) {
            $plan = Reconciler::plan($c['mode'], $c['desired'], $c['listing'], $c['touched'], $doc['now']);
            self::assertSame($c['expected']['imports'], $plan['imports'], $c['name'] . ' (imports)');
            self::assertSame($c['expected']['ops'], $plan['ops'], $c['name'] . ' (ops)');
            self::assertSame($c['expected']['report'], $plan['report'], $c['name'] . ' (report)');
            foreach ($plan['ops'] as $op) {
                self::assertTrue(StoreLayout::isValidOpPath($op['op'], $op['path'], $op['exclusive']), $c['name'] . ': ' . $op['op'] . ' ' . $op['path']);
            }
        }
    }

    public function testDesiredTombstones(): void
    {
        $t = Reconciler::desiredTombstones(
            ['aaaaaaaaaaaa' => ['state' => 'revoked', 'at' => 'T1'], 'bbbbbbbbbbbb' => ['state' => 'active', 'at' => null], 'cccccccccccc' => ['state' => 'deleted', 'at' => 'T2']],
            [
                'aaaaaaaa' => ['fid' => 'bbbbbbbbbbbb', 'state' => 'revoked', 'sidHash' => null, 'handoff' => false, 'revokedAt' => 'T3', 'together' => false],
                'bbbbbbbb' => ['fid' => 'aaaaaaaaaaaa', 'state' => 'revoked', 'sidHash' => null, 'handoff' => false, 'revokedAt' => 'T1', 'together' => true],
            ],
            'NOW',
        );
        self::assertSame([
            't/aaaaaaaaaaaa' => ['s' => 'revoked', 'at' => 'T1'],
            't/bbbbbbbbbbbb.aaaaaaaa' => ['s' => 'revoked', 'at' => 'T3'],
            't/cccccccccccc' => ['s' => 'deleted', 'at' => 'T2'],
        ], $t);
    }
}
