<?php

declare(strict_types=1);

namespace Omw\Api\Infra\Store;

use FilesystemIterator;
use Omw\Api\Domain\Access\StoreLayout;
use RecursiveDirectoryIterator;
use RecursiveIteratorIterator;
use SplFileInfo;

/**
 * The store on the API's own filesystem (ACCESS_STORE_MODE=direct: site and API share one hosting
 * account, P0b-1). Exclusive creates use fopen(…, 'x'); the marker is replaced with a temp file in
 * the same directory + rename(); directories get ACCESS_STORE_DIR_MODE, files ACCESS_STORE_FILE_MODE.
 * The store root is created on demand, together with its parent when only that is missing: the
 * documented layout <account home>/omw-store/site1 needs both on a fresh account, whose SFTP
 * logins cannot reach the home (P0b). Deeper missing paths are refused (a typo must not create a
 * second store somewhere else).
 */
final class DirectStoreWriter implements StoreWriter
{
    public function __construct(
        private readonly string $root,
        private readonly int $dirMode = 0o711,
        private readonly int $fileMode = 0o600,
    ) {
        if (!StoreLayout::isSafeStoreDir($root)) {
            throw new StoreWriterException('config', 'ACCESS_STORE_DIR is not a safe absolute path');
        }
    }

    public function mode(): string
    {
        return 'direct';
    }

    public function put(string $rel, string $content, bool $exclusive): void
    {
        self::check($rel, ['marker', 'locked', 'session', 'handoff', 'personTombstone', 'deviceTombstone', 'htaccess']);
        if (!$exclusive) {
            $this->replace($rel, $content);

            return;
        }
        $path = $this->abs($rel);
        $this->ensureParent($rel);
        $handle = @fopen($path, 'x');
        if ($handle === false) {
            clearstatcache(true, $path);
            if (file_exists($path)) {
                return; // existence files are never rewritten
            }
            throw StoreWriterException::io('create', $rel);
        }
        $ok = $content === '' || @fwrite($handle, $content) === strlen($content);
        fclose($handle);
        @chmod($path, $this->fileMode);
        if (!$ok) {
            throw StoreWriterException::io('write', $rel);
        }
    }

    public function replace(string $rel, string $content): void
    {
        self::check($rel, ['marker', 'htaccess', 'personTombstone']);
        $path = $this->abs($rel);
        $this->ensureParent($rel);
        $tmp = dirname($path) . '/.tmp-' . bin2hex(random_bytes(6));
        $handle = @fopen($tmp, 'x');
        if ($handle === false) {
            throw StoreWriterException::io('create temp file for', $rel);
        }
        $ok = $content === '' || @fwrite($handle, $content) === strlen($content);
        fclose($handle);
        @chmod($tmp, $this->fileMode);
        if (!$ok || !@rename($tmp, $path)) {
            @unlink($tmp);
            throw StoreWriterException::io('replace', $rel);
        }
    }

    public function delete(string $rel): void
    {
        self::check($rel, ['locked', 'session', 'handoff', 'stray']);
        $path = $this->abs($rel);
        clearstatcache(true, $path);
        if (is_dir($path) && !is_link($path)) {
            throw StoreWriterException::io('delete (a directory)', $rel);
        }
        if (!file_exists($path) && !is_link($path)) {
            return;
        }
        if (!@unlink($path)) {
            clearstatcache(true, $path);
            if (file_exists($path)) {
                throw StoreWriterException::io('delete', $rel);
            }
        }
    }

    public function deletePrefix(string $relDir, string $namePrefix): int
    {
        self::check($relDir, ['sessionDir']);
        if (preg_match('/^' . StoreLayout::DID . '\.$/D', $namePrefix) !== 1) {
            throw new StoreWriterException('path', 'Invalid delete prefix');
        }
        $deleted = 0;
        foreach ($this->list($relDir) as $name) {
            if (!str_starts_with($name, $namePrefix)) {
                continue;
            }
            $path = $this->abs($relDir . '/' . $name);
            if (is_dir($path) && !is_link($path)) {
                $this->removeTree($path, $relDir . '/' . $name);
            } elseif (!@unlink($path) && file_exists($path)) {
                throw StoreWriterException::io('delete', $relDir . '/' . $name);
            }
            ++$deleted;
        }

        return $deleted;
    }

    public function deleteTree(string $relDir): void
    {
        self::check($relDir, ['sessionDir', 'stray']);
        $path = $this->abs($relDir);
        clearstatcache(true, $path);
        if (is_dir($path) && !is_link($path)) {
            $this->removeTree($path, $relDir);
        } elseif ((file_exists($path) || is_link($path)) && !@unlink($path)) {
            throw StoreWriterException::io('delete', $relDir);
        }
    }

    public function list(string $relDir): array
    {
        if (!in_array($relDir, ['', 's', 'h', 't'], true)) {
            self::check($relDir, ['sessionDir', 'stray']);
        }
        $path = $relDir === '' ? $this->root : $this->abs($relDir);
        clearstatcache(true, $path);
        if (!is_dir($path)) {
            return [];
        }
        $entries = @scandir($path);
        if ($entries === false) {
            throw StoreWriterException::io('list', $relDir === '' ? '/' : $relDir);
        }

        return array_values(array_filter($entries, static fn (string $e): bool => $e !== '.' && $e !== '..' && !str_starts_with($e, '.tmp-')));
    }

    public function read(string $rel): ?string
    {
        self::check($rel, ['marker', 'locked', 'personTombstone', 'deviceTombstone', 'htaccess']);
        $path = $this->abs($rel);
        clearstatcache(true, $path);
        if (!is_file($path)) {
            return null;
        }
        $data = @file_get_contents($path, false, null, 0, 4096);
        if ($data === false) {
            throw StoreWriterException::io('read', $rel);
        }

        return $data;
    }

    public function isDir(string $rel): bool
    {
        if (!in_array($rel, ['s', 'h', 't'], true)) {
            self::check($rel, ['sessionDir', 'stray']);
        }
        $path = $this->abs($rel);
        clearstatcache(true, $path);

        return is_dir($path) && !is_link($path);
    }

    public function close(): void
    {
    }

    /** @param list<string> $kinds */
    private static function check(string $rel, array $kinds): void
    {
        $kind = StoreLayout::kind($rel);
        if ($kind === null || !in_array($kind, $kinds, true)) {
            throw new StoreWriterException('path', 'Refused store path ' . StoreLayout::redact($rel));
        }
    }

    private function abs(string $rel): string
    {
        return $this->root . '/' . $rel;
    }

    private function ensureParent(string $rel): void
    {
        clearstatcache(true, $this->root);
        if (!is_dir($this->root)) {
            $parent = dirname($this->root);
            clearstatcache(true, $parent);
            if (!is_dir($parent) && $parent !== '/' && is_dir(dirname($parent))) {
                $this->ensureDir($parent, true);
            }
        }
        $this->ensureDir($this->root, true);
        $parts = explode('/', $rel);
        array_pop($parts);
        $dir = $this->root;
        foreach ($parts as $part) {
            $dir .= '/' . $part;
            $this->ensureDir($dir, false);
        }
    }

    private function ensureDir(string $dir, bool $isRoot): void
    {
        clearstatcache(true, $dir);
        if (is_dir($dir)) {
            return;
        }
        if (!@mkdir($dir, $this->dirMode) && !is_dir($dir)) {
            throw new StoreWriterException('io', $isRoot ? 'Cannot create the store directory (does its parent exist?)' : 'Cannot create a store directory');
        }
        @chmod($dir, $this->dirMode);
    }

    private function removeTree(string $path, string $rel): void
    {
        $it = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($path, FilesystemIterator::SKIP_DOTS),
            RecursiveIteratorIterator::CHILD_FIRST,
        );
        /** @var SplFileInfo $file */
        foreach ($it as $file) {
            $ok = $file->isDir() && !$file->isLink() ? @rmdir($file->getPathname()) : @unlink($file->getPathname());
            if (!$ok) {
                throw StoreWriterException::io('delete', $rel);
            }
        }
        if (!@rmdir($path)) {
            throw StoreWriterException::io('delete', $rel);
        }
    }
}
