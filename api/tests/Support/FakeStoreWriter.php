<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Support;

use Omw\Api\Domain\Access\StoreLayout;
use Omw\Api\Infra\Db;
use Omw\Api\Infra\Store\StoreWriter;
use Omw\Api\Infra\Store\StoreWriterException;
use PHPUnit\Framework\Assert;

/**
 * In-memory store for StoreApplier tests: records every call, fails on request, and asserts on
 * every call that no database transaction is open (spec-wave5 §3.8.3).
 */
final class FakeStoreWriter implements StoreWriter
{
    /** @var array<string, string> path => content */
    public array $files = [];

    /** @var list<string> "op path" */
    public array $calls = [];

    /** Path prefix whose writes fail with an io error. */
    public ?string $failOn = null;

    /** @var (callable(string): void)|null runs inside every write call (e.g. enqueue more ops) */
    public $during = null;

    public float $sleepSeconds = 0.0;

    public function __construct(private readonly ?Db $db = null)
    {
    }

    public function mode(): string
    {
        return 'direct';
    }

    public function put(string $rel, string $content, bool $exclusive): void
    {
        $this->touch('put', $rel);
        if ($exclusive && isset($this->files[$rel])) {
            return;
        }
        $this->files[$rel] = $content;
    }

    public function replace(string $rel, string $content): void
    {
        $this->touch('replace', $rel);
        $this->files[$rel] = $content;
    }

    public function delete(string $rel): void
    {
        $this->touch('delete', $rel);
        unset($this->files[$rel]);
    }

    public function deletePrefix(string $relDir, string $namePrefix): int
    {
        $this->touch('delete_prefix', $relDir . '/' . $namePrefix);
        $n = 0;
        foreach (array_keys($this->files) as $path) {
            if (str_starts_with($path, $relDir . '/' . $namePrefix)) {
                unset($this->files[$path]);
                ++$n;
            }
        }

        return $n;
    }

    public function deleteTree(string $relDir): void
    {
        $this->touch('delete_tree', $relDir);
        foreach (array_keys($this->files) as $path) {
            if ($path === $relDir || str_starts_with($path, $relDir . '/')) {
                unset($this->files[$path]);
            }
        }
    }

    public function list(string $relDir): array
    {
        $this->assertNoTransaction();
        $prefix = $relDir === '' ? '' : $relDir . '/';
        $names = [];
        foreach (array_keys($this->files) as $path) {
            if ($prefix === '' || str_starts_with($path, $prefix)) {
                $names[explode('/', substr($path, strlen($prefix)))[0]] = true;
            }
        }

        return array_keys($names);
    }

    public function read(string $rel): ?string
    {
        $this->assertNoTransaction();

        return $this->files[$rel] ?? null;
    }

    public function isDir(string $rel): bool
    {
        $this->assertNoTransaction();
        foreach (array_keys($this->files) as $path) {
            if (str_starts_with($path, $rel . '/')) {
                return true;
            }
        }

        return false;
    }

    public function close(): void
    {
    }

    private function touch(string $op, string $rel): void
    {
        $this->assertNoTransaction();
        $this->calls[] = $op . ' ' . StoreLayout::redact($rel);
        if ($this->sleepSeconds > 0) {
            usleep((int) ($this->sleepSeconds * 1_000_000));
        }
        if ($this->during !== null) {
            ($this->during)($rel);
        }
        if ($this->failOn !== null && str_starts_with($rel, $this->failOn)) {
            throw StoreWriterException::io($op, $rel);
        }
    }

    private function assertNoTransaction(): void
    {
        if ($this->db !== null) {
            Assert::assertFalse($this->db->pdo()->inTransaction(), 'no database transaction may span a store call');
        }
    }
}
