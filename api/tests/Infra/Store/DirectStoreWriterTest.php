<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Infra\Store;

use Omw\Api\Domain\Access\StoreLayout;
use Omw\Api\Infra\Store\DirectStoreWriter;
use Omw\Api\Infra\Store\StoreWriterException;
use Omw\Api\Tests\TestCase;

/**
 * The direct store writer (spec-wave5 §3.8.1) on a scratch folder: exclusive creates, file and
 * directory modes, prefix and tree deletes, the marker replace, and path validation (no "..", no
 * absolute paths, no unknown shapes; errors never contain a session id).
 */
final class DirectStoreWriterTest extends TestCase
{
    private const FID = 'abcdefgh2345';
    private const DID = 'qrst2345';

    private function writer(int $dirMode = 0o711, int $fileMode = 0o600): DirectStoreWriter
    {
        return new DirectStoreWriter($this->tmpDir() . '/store', $dirMode, $fileMode);
    }

    public function testExclusivePutModesAndReads(): void
    {
        $w = $this->writer();
        $sid = str_repeat('a', 43);
        $path = StoreLayout::session(self::FID, self::DID, $sid);
        $w->put($path, '', true);
        $w->put(StoreLayout::LOCKED, '{"at":"x","by":"admin"}', true);
        $w->put(StoreLayout::LOCKED, 'rewritten?', true);
        self::assertSame('{"at":"x","by":"admin"}', $w->read(StoreLayout::LOCKED), 'existence files are never rewritten');
        $root = $this->tmpDir() . '/store';
        self::assertFileExists("$root/$path");
        self::assertSame(0o600, fileperms("$root/$path") & 0o777);
        self::assertSame(0o711, fileperms("$root/s/" . self::FID) & 0o777);
        self::assertSame(0o711, fileperms("$root/s") & 0o777);
        self::assertSame(['s'], array_values(array_diff($w->list(''), ['locked'])));
        self::assertSame([self::FID], $w->list('s'));
        self::assertTrue($w->isDir('s/' . self::FID));
        self::assertSame([], $w->list('h'), 'missing = empty');
        self::assertNull($w->read(StoreLayout::MARKER));

        $w->replace(StoreLayout::MARKER, '{"v":1}');
        $w->replace(StoreLayout::MARKER, '{"v":2}');
        self::assertSame('{"v":2}', $w->read(StoreLayout::MARKER));
        $w->put(StoreLayout::MARKER, '{"v":3}', false);
        self::assertSame('{"v":3}', $w->read(StoreLayout::MARKER));
        self::assertSame([], glob("$root/.tmp-*") ?: [], 'no temp files left');

        $loose = new DirectStoreWriter($root . '2', 0o755, 0o644);
        $loose->put(StoreLayout::handoff(self::DID), '', true);
        self::assertSame(0o644, fileperms("{$root}2/h/" . self::DID) & 0o777);
    }

    public function testPrefixAndTreeDeletes(): void
    {
        $w = $this->writer();
        foreach (['a', 'b'] as $c) {
            $w->put(StoreLayout::session(self::FID, self::DID, str_repeat($c, 43)), '', true);
        }
        $w->put(StoreLayout::session(self::FID, 'zzzz2345', str_repeat('c', 43)), '', true);
        self::assertSame(2, $w->deletePrefix('s/' . self::FID, self::DID . '.'));
        self::assertSame(['zzzz2345.' . str_repeat('c', 43)], $w->list('s/' . self::FID));
        $w->deleteTree('s/' . self::FID);
        self::assertSame([], $w->list('s'));
        $w->deleteTree('s/' . self::FID); // missing = ok
        $w->delete(StoreLayout::handoff(self::DID)); // missing = ok
        $w->put('t/' . self::FID, '{"s":"revoked"}', true);
        self::assertSame('{"s":"revoked"}', $w->read('t/' . self::FID));
    }

    public function testPathValidation(): void
    {
        $w = $this->writer();
        $sid = str_repeat('Q', 43);
        foreach (['../locked', '/locked', 's/../t/' . self::FID, 's/.hidden', 'x/' . self::FID, 'locked/', '', 's//' . self::FID] as $bad) {
            try {
                $w->put($bad, '', true);
                self::fail('accepted ' . $bad);
            } catch (StoreWriterException $e) {
                self::assertSame('path', $e->reason);
            }
        }
        foreach ([['delete', 't/' . self::FID], ['delete', StoreLayout::MARKER], ['replace', StoreLayout::LOCKED]] as [$method, $path]) {
            try {
                $method === 'delete' ? $w->delete($path) : $w->replace($path, 'x');
                self::fail("$method accepted $path");
            } catch (StoreWriterException $e) {
                self::assertSame('path', $e->reason, "tombstones and the marker are never deleted; only the marker is replaced ($path)");
            }
        }
        try {
            $w->deletePrefix('s/' . self::FID, '*');
            self::fail('accepted a wildcard prefix');
        } catch (StoreWriterException $e) {
            self::assertSame('path', $e->reason);
        }
        try {
            $w->put('s/' . self::FID . '/' . self::DID . '.' . $sid . '/x', '', true);
            self::fail('accepted a nested session path');
        } catch (StoreWriterException $e) {
            self::assertStringNotContainsString($sid, $e->getMessage(), 'errors never contain a session id');
        }
        $this->expectException(StoreWriterException::class);
        new DirectStoreWriter('relative/store');
    }

    public function testTheRootAndItsParentAreCreatedOnAFreshAccount(): void
    {
        $home = $this->tmpDir();
        $w = new DirectStoreWriter($home . '/omw-store/site1');
        $w->put(StoreLayout::LOCKED, '{}', true);
        self::assertFileExists($home . '/omw-store/site1/' . StoreLayout::LOCKED);
        self::assertSame(0o711, fileperms($home . '/omw-store') & 0o777);
        self::assertSame(0o711, fileperms($home . '/omw-store/site1') & 0o777);
    }

    public function testTheRootIsCreatedOnlyWhenItsParentExists(): void
    {
        $w = new DirectStoreWriter($this->tmpDir() . '/missing/parent/store');
        $this->expectException(StoreWriterException::class);
        $w->put(StoreLayout::LOCKED, '{}', true);
    }
}
