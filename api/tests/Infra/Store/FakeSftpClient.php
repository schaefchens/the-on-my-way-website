<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Infra\Store;

use Omw\Api\Infra\Store\SftpClient;
use Omw\Api\Infra\Store\StoreWriterException;

/** An in-memory SFTP server for SftpStoreWriter tests. */
final class FakeSftpClient implements SftpClient
{
    /** @var array<string, string|null> path => content (null = directory) */
    public array $fs = [];
    public string $hostKey = 'fake-host-key-blob';
    public bool $acceptLogin = true;
    public bool $posixRename = true;
    public bool $unreachable = false;
    public int $logins = 0;
    /** @var list<string> */
    public array $calls = [];

    public function connect(string $host, int $port, int $timeoutSeconds): string
    {
        $this->calls[] = "connect $host:$port/$timeoutSeconds";
        if ($this->unreachable) {
            throw new StoreWriterException('connect', 'timeout');
        }

        return $this->hostKey;
    }

    public function loginWithKey(string $user, string $privateKey, string $passphrase): bool
    {
        ++$this->logins;
        $this->calls[] = "login-key $user";

        return $this->acceptLogin;
    }

    public function loginWithPassword(string $user, string $password): bool
    {
        ++$this->logins;
        $this->calls[] = "login-password $user";

        return $this->acceptLogin;
    }

    public function type(string $path): ?string
    {
        if (!array_key_exists($path, $this->fs)) {
            return null;
        }

        return $this->fs[$path] === null ? 'dir' : 'file';
    }

    public function put(string $path, string $content): bool
    {
        $this->calls[] = "put $path";
        if ($this->type(dirname($path)) !== 'dir') {
            return false;
        }
        $this->fs[$path] = $content;

        return true;
    }

    public function get(string $path, int $maxBytes): ?string
    {
        $c = $this->fs[$path] ?? null;

        return $c === null ? null : substr($c, 0, $maxBytes);
    }

    public function mkdir(string $path, int $mode): bool
    {
        if (array_key_exists($path, $this->fs) || $this->type(dirname($path)) !== 'dir') {
            return false;
        }
        $this->fs[$path] = null;

        return true;
    }

    public function chmod(string $path, int $mode): bool
    {
        $this->calls[] = sprintf('chmod %s %o', $path, $mode);

        return true;
    }

    public function delete(string $path): bool
    {
        $this->calls[] = "delete $path";
        if ($this->type($path) !== 'file') {
            return false;
        }
        unset($this->fs[$path]);

        return true;
    }

    public function rmdir(string $path): bool
    {
        foreach (array_keys($this->fs) as $p) {
            if (str_starts_with($p, $path . '/')) {
                return false;
            }
        }
        unset($this->fs[$path]);

        return true;
    }

    public function rename(string $from, string $to): bool
    {
        $this->calls[] = "rename $from $to";
        if ($this->type($from) !== 'file' || array_key_exists($to, $this->fs)) {
            return false;
        }
        $this->fs[$to] = $this->fs[$from];
        unset($this->fs[$from]);

        return true;
    }

    public function supportsPosixRename(): bool
    {
        return $this->posixRename;
    }

    public function posixRename(string $from, string $to): bool
    {
        $this->calls[] = "posix-rename $from $to";
        $this->fs[$to] = $this->fs[$from] ?? '';
        unset($this->fs[$from]);

        return true;
    }

    public function nlist(string $dir): ?array
    {
        if ($this->type($dir) !== 'dir') {
            return null;
        }
        $out = [];
        $prefix = rtrim($dir, '/') . '/';
        foreach (array_keys($this->fs) as $p) {
            if (str_starts_with($p, $prefix) && !str_contains(substr($p, strlen($prefix)), '/')) {
                $out[] = substr($p, strlen($prefix));
            }
        }

        return $out;
    }

    public function disconnect(): void
    {
        $this->calls[] = 'disconnect';
    }
}
