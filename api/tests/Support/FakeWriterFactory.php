<?php

declare(strict_types=1);

namespace Omw\Api\Tests\Support;

use Omw\Api\Config;
use Omw\Api\Infra\Store\StoreWriter;
use Omw\Api\Infra\Store\StoreWriterException;
use Omw\Api\Infra\Store\StoreWriterFactory;

/** Hands out a fixed writer (or throws a configured writer exception). */
final class FakeWriterFactory extends StoreWriterFactory
{
    public ?StoreWriterException $throw = null;
    public int $opened = 0;

    public function __construct(Config $config, private readonly StoreWriter $writer)
    {
        parent::__construct($config);
    }

    public function open(): StoreWriter
    {
        ++$this->opened;
        if ($this->throw !== null) {
            throw $this->throw;
        }

        return $this->writer;
    }
}
