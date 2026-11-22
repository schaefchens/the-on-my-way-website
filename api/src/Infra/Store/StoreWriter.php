<?php

declare(strict_types=1);

namespace Omw\Api\Infra\Store;

/**
 * Writes the site-store (spec-wave5 §2.2, §3.8.1): the session files Apache checks with `-f`,
 * handoff markers, the lock file, tombstones and the store marker. Implementations: the direct
 * filesystem writer (same account as Apache) and the SFTP writer (phpseclib). Paths are
 * store-relative and checked against Domain\Access\StoreLayout before any filesystem call.
 *
 * Every method throws {@see StoreWriterException} on failure; its message never contains a
 * session id (paths are redacted).
 */
interface StoreWriter
{
    /** "direct" | "sftp" */
    public function mode(): string;

    /** Creates the file; with $exclusive an existing file is left as is (no rewrite). */
    public function put(string $rel, string $content, bool $exclusive): void;

    /** Atomic replace (temp file + rename): the marker, the F3 .htaccess and a person tombstone upgrade only. */
    public function replace(string $rel, string $content): void;

    /** Missing = ok. */
    public function delete(string $rel): void;

    /** Deletes the files in $relDir whose name starts with $namePrefix, e.g. ("s/<fid>", "<did>."). */
    public function deletePrefix(string $relDir, string $namePrefix): int;

    /** Deletes a directory with everything in it, or a single file; missing = ok. */
    public function deleteTree(string $relDir): void;

    /**
     * Entry names of a store directory ("" = the store root); [] when it is missing.
     *
     * @return list<string>
     */
    public function list(string $relDir): array;

    /** Small files only (marker, tombstone, lock); null when missing. */
    public function read(string $rel): ?string;

    /** True when $rel exists and is a directory. */
    public function isDir(string $rel): bool;

    public function close(): void;
}
