<?php

declare(strict_types=1);

namespace Omw\Api\Infra\Store;

use phpseclib3\Crypt\PublicKeyLoader;
use phpseclib3\Net\SFTP;
use Throwable;

/**
 * {@see SftpClient} on phpseclib 3 (pure PHP; uses sodium and gmp when available, otherwise the
 * key exchange takes seconds). The stat cache is off: the store changes under other writers.
 */
final class PhpseclibSftpClient implements SftpClient
{
    private ?SFTP $sftp = null;

    public function connect(string $host, int $port, int $timeoutSeconds): string
    {
        try {
            $sftp = new SFTP($host, $port, $timeoutSeconds);
            $sftp->setTimeout($timeoutSeconds);
            $sftp->disableStatCache();
            $key = $sftp->getServerPublicHostKey();
        } catch (Throwable $e) {
            throw new StoreWriterException('connect', 'SFTP connection failed: ' . $e->getMessage(), $e);
        }
        if (!is_string($key) || !str_contains($key, ' ')) {
            throw new StoreWriterException('connect', 'SFTP server sent no usable host key');
        }
        $blob = base64_decode(explode(' ', $key, 2)[1], true);
        if ($blob === false || $blob === '') {
            throw new StoreWriterException('connect', 'SFTP server sent no usable host key');
        }
        $this->sftp = $sftp;

        return $blob;
    }

    public function loginWithKey(string $user, string $privateKey, string $passphrase): bool
    {
        try {
            $key = $passphrase === '' ? PublicKeyLoader::loadPrivateKey($privateKey) : PublicKeyLoader::loadPrivateKey($privateKey, $passphrase);

            return $this->sftp()->login($user, $key);
        } catch (Throwable) {
            return false;
        }
    }

    public function loginWithPassword(string $user, string $password): bool
    {
        try {
            return $this->sftp()->login($user, $password);
        } catch (Throwable) {
            return false;
        }
    }

    public function type(string $path): ?string
    {
        $stat = $this->guard(fn (SFTP $s): mixed => $s->stat($path));
        if (!is_array($stat)) {
            return null;
        }

        return match ($stat['type'] ?? null) {
            1 => 'file',
            2 => 'dir',
            default => 'other',
        };
    }

    public function put(string $path, string $content): bool
    {
        return $this->guard(fn (SFTP $s): mixed => $s->put($path, $content)) === true;
    }

    public function get(string $path, int $maxBytes): ?string
    {
        $data = $this->guard(fn (SFTP $s): mixed => $s->get($path, false, 0, $maxBytes));

        return is_string($data) ? $data : null;
    }

    public function mkdir(string $path, int $mode): bool
    {
        return $this->guard(fn (SFTP $s): mixed => $s->mkdir($path, $mode)) === true;
    }

    public function chmod(string $path, int $mode): bool
    {
        return $this->guard(fn (SFTP $s): mixed => $s->chmod($mode, $path)) !== false;
    }

    public function delete(string $path): bool
    {
        return $this->guard(fn (SFTP $s): mixed => $s->delete($path, false)) === true;
    }

    public function rmdir(string $path): bool
    {
        return $this->guard(fn (SFTP $s): mixed => $s->rmdir($path)) === true;
    }

    public function rename(string $from, string $to): bool
    {
        return $this->guard(fn (SFTP $s): mixed => $s->rename($from, $to)) === true;
    }

    public function supportsPosixRename(): bool
    {
        $ext = $this->guard(fn (SFTP $s): mixed => $s->getSupportedExtensions());

        return is_array($ext) && array_key_exists('posix-rename@openssh.com', $ext);
    }

    public function posixRename(string $from, string $to): bool
    {
        return $this->guard(fn (SFTP $s): mixed => $s->posix_rename($from, $to)) === true;
    }

    public function nlist(string $dir): ?array
    {
        $list = $this->guard(fn (SFTP $s): mixed => $s->nlist($dir));
        if (!is_array($list)) {
            return null;
        }
        $out = [];
        foreach ($list as $name) {
            if (is_string($name) && $name !== '.' && $name !== '..') {
                $out[] = $name;
            }
        }

        return $out;
    }

    public function disconnect(): void
    {
        try {
            $this->sftp?->disconnect();
        } catch (Throwable) {
            // closing anyway
        }
        $this->sftp = null;
    }

    private function sftp(): SFTP
    {
        return $this->sftp ?? throw new StoreWriterException('connect', 'SFTP is not connected');
    }

    /** @param callable(SFTP): mixed $fn */
    private function guard(callable $fn): mixed
    {
        try {
            return $fn($this->sftp());
        } catch (StoreWriterException $e) {
            throw $e;
        } catch (Throwable) {
            return false;
        }
    }
}
