<?php

declare(strict_types=1);

namespace Omw\Api\Infra\Store;

use Closure;
use Omw\Api\Config;

/**
 * Opens the configured store writer (ACCESS_STORE_MODE): null for "none" (the Mac writes the
 * store), {@see DirectStoreWriter} for "direct", a connected {@see SftpStoreWriter} for "sftp".
 * Not final: tests replace {@see open()} with fakes.
 */
class StoreWriterFactory
{
    /** @param (Closure(): SftpClient)|null $sftpClient */
    public function __construct(
        private readonly Config $config,
        private readonly ?Closure $sftpClient = null,
    ) {
    }

    public static function fromConfig(Config $config): ?StoreWriter
    {
        return (new self($config))->open();
    }

    /** "none" | "direct" | "sftp" */
    public function mode(): string
    {
        return $this->config->access->storeMode;
    }

    /** @throws StoreWriterException */
    public function open(): ?StoreWriter
    {
        $access = $this->config->access;

        return match ($access->storeMode) {
            'direct' => new DirectStoreWriter($access->storeDir, $access->dirMode, $access->fileMode),
            'sftp' => $this->openSftp(),
            default => null,
        };
    }

    private function openSftp(): SftpStoreWriter
    {
        $client = $this->sftpClient !== null ? ($this->sftpClient)() : new PhpseclibSftpClient();
        $writer = new SftpStoreWriter($client, $this->config->access);
        $writer->connect();

        return $writer;
    }
}
