<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Support;

use Omw\Api\Domain\Access\StoreLayout;
use Omw\Api\Infra\Store\DirectStoreWriter;
use Omw\Api\Infra\Store\StoreWriter;

/**
 * A direct writer that takes a fixed time per store op and logs every op it applies (pid, op,
 * redacted path) to a file: the concurrency test (StoreApplierConcurrencyTest) runs it inside
 * `php -S` workers.
 */
final class SlowStoreWriter implements StoreWriter
{
    public function __construct(
        private readonly DirectStoreWriter $inner,
        private readonly int $delayMs,
        private readonly string $logFile,
    ) {
    }

    public function mode(): string
    {
        return 'direct';
    }

    public function put(string $rel, string $content, bool $exclusive): void
    {
        $this->slow('put', $rel);
        $this->inner->put($rel, $content, $exclusive);
    }

    public function replace(string $rel, string $content): void
    {
        if ($rel !== StoreLayout::MARKER) {
            $this->slow('replace', $rel);
        }
        $this->inner->replace($rel, $content);
    }

    public function delete(string $rel): void
    {
        $this->slow('delete', $rel);
        $this->inner->delete($rel);
    }

    public function deletePrefix(string $relDir, string $namePrefix): int
    {
        $this->slow('delete_prefix', $relDir . '/' . $namePrefix);

        return $this->inner->deletePrefix($relDir, $namePrefix);
    }

    public function deleteTree(string $relDir): void
    {
        $this->slow('delete_tree', $relDir);
        $this->inner->deleteTree($relDir);
    }

    public function list(string $relDir): array
    {
        return $this->inner->list($relDir);
    }

    public function read(string $rel): ?string
    {
        return $this->inner->read($rel);
    }

    public function isDir(string $rel): bool
    {
        return $this->inner->isDir($rel);
    }

    public function close(): void
    {
    }

    private function slow(string $op, string $rel): void
    {
        usleep($this->delayMs * 1000);
        file_put_contents($this->logFile, getmypid() . ' ' . $op . ' ' . StoreLayout::redact($rel) . "\n", FILE_APPEND | LOCK_EX);
    }
}
