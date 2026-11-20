<?php

declare(strict_types=1);

namespace Omw\Api\Infra;

use RuntimeException;

/** Small filesystem helpers. */
final class Fs
{
    /** Writes a file atomically (temp file in the same directory + rename). */
    public static function writeAtomic(string $path, string $contents, int $mode = 0640): void
    {
        Paths::ensureDir(dirname($path));
        $tmp = dirname($path) . '/.tmp-' . bin2hex(random_bytes(6)) . '-' . basename($path);
        if (@file_put_contents($tmp, $contents, LOCK_EX) === false) {
            throw new RuntimeException('Cannot write ' . $tmp);
        }
        @chmod($tmp, $mode);
        if (!@rename($tmp, $path)) {
            @unlink($tmp);
            throw new RuntimeException('Cannot replace ' . $path);
        }
    }

    /** Deletes a file if it exists; true when it is gone afterwards. */
    public static function remove(string $path): bool
    {
        if (!file_exists($path)) {
            return true;
        }

        return @unlink($path) || !file_exists($path);
    }
}
