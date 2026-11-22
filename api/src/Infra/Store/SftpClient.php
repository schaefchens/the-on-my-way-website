<?php

declare(strict_types=1);

namespace Omw\Api\Infra\Store;

/**
 * The few SFTP operations the store writer needs (spec-wave5 §3.8.1). Production:
 * {@see PhpseclibSftpClient}; tests use a fake. Paths are as the SFTP server sees them.
 * Operations return false / null on failure instead of throwing; connect() throws.
 */
interface SftpClient
{
    /**
     * Opens the connection (the timeout applies to the connect and to every later operation)
     * and returns the server's raw public host key blob (what "SHA256:<base64>" fingerprints hash).
     *
     * @throws StoreWriterException reason "connect"
     */
    public function connect(string $host, int $port, int $timeoutSeconds): string;

    public function loginWithKey(string $user, string $privateKey, string $passphrase): bool;

    public function loginWithPassword(string $user, string $password): bool;

    /** "file" | "dir" | "other", null when the path does not exist. */
    public function type(string $path): ?string;

    public function put(string $path, string $content): bool;

    public function get(string $path, int $maxBytes): ?string;

    public function mkdir(string $path, int $mode): bool;

    public function chmod(string $path, int $mode): bool;

    /** Deletes one file (never recursive). */
    public function delete(string $path): bool;

    public function rmdir(string $path): bool;

    public function rename(string $from, string $to): bool;

    /** True when the server advertises posix-rename@openssh.com (atomic replace). */
    public function supportsPosixRename(): bool;

    public function posixRename(string $from, string $to): bool;

    /**
     * Entry names of a directory without "." and "..", null when it is missing or unreadable.
     *
     * @return list<string>|null
     */
    public function nlist(string $dir): ?array;

    public function disconnect(): void;
}
