<?php

declare(strict_types=1);

namespace Omw\Api\Domain\App;

use Psr\Http\Message\StreamInterface;
use RuntimeException;
use Throwable;

/**
 * A read-only PSR-7 body over bytes [start, start + length) of an open file, for Range downloads
 * of the app inbox. Slim's emitter rewinds seekable bodies first; here rewind() goes back to the
 * range start, so the emitted bytes are exactly the range. Closing it (or its destruction at the
 * end of the request) also releases the transfer slot it holds ({@see TransferSlots}).
 */
final class FileRangeStream implements StreamInterface
{
    private const CHUNK = 65536;

    /** @var resource|null */
    private mixed $handle;

    /** @var resource|null */
    private mixed $slot;

    private int $position = 0;

    /**
     * @param resource      $handle
     * @param resource|null $slot   transfer slot lock to release on close
     */
    public function __construct(mixed $handle, private readonly int $start, private readonly int $length, mixed $slot = null)
    {
        $this->handle = $handle;
        $this->slot = $slot;
    }

    public function __destruct()
    {
        $this->close();
    }

    public function __toString(): string
    {
        try {
            $this->rewind();

            return $this->getContents();
        } catch (Throwable) {
            return '';
        }
    }

    public function close(): void
    {
        if (is_resource($this->handle)) {
            fclose($this->handle);
        }
        $this->handle = null;
        TransferSlots::release($this->slot);
        $this->slot = null;
    }

    public function detach()
    {
        $handle = $this->handle;
        $this->handle = null;
        TransferSlots::release($this->slot);
        $this->slot = null;

        return $handle;
    }

    public function getSize(): int
    {
        return $this->length;
    }

    public function tell(): int
    {
        return $this->position;
    }

    public function eof(): bool
    {
        return $this->handle === null || $this->position >= $this->length;
    }

    public function isSeekable(): bool
    {
        return $this->handle !== null;
    }

    public function seek(int $offset, int $whence = SEEK_SET): void
    {
        $target = match ($whence) {
            SEEK_SET => $offset,
            SEEK_CUR => $this->position + $offset,
            SEEK_END => $this->length + $offset,
            default => throw new RuntimeException('Invalid whence'),
        };
        if ($target < 0 || $target > $this->length) {
            throw new RuntimeException('Seek outside the range');
        }
        $this->position = $target;
    }

    public function rewind(): void
    {
        $this->seek(0);
    }

    public function isWritable(): bool
    {
        return false;
    }

    public function write(string $string): int
    {
        throw new RuntimeException('Read-only stream');
    }

    public function isReadable(): bool
    {
        return $this->handle !== null;
    }

    public function read(int $length): string
    {
        if ($this->handle === null) {
            throw new RuntimeException('Stream is closed');
        }
        $want = min(max(0, $length), $this->length - $this->position);
        if ($want < 1) {
            return '';
        }
        if (fseek($this->handle, $this->start + $this->position) !== 0) {
            throw new RuntimeException('Cannot seek the file');
        }
        $data = fread($this->handle, $want);
        if ($data === false) {
            throw new RuntimeException('Cannot read the file');
        }
        $this->position += strlen($data);
        if ($data === '' && $want > 0) {
            // The file is shorter than recorded: end the body instead of looping forever.
            $this->position = $this->length;
        }

        return $data;
    }

    public function getContents(): string
    {
        $out = '';
        while (!$this->eof()) {
            $out .= $this->read(self::CHUNK);
        }

        return $out;
    }

    public function getMetadata(?string $key = null)
    {
        $meta = is_resource($this->handle) ? stream_get_meta_data($this->handle) : [];

        return $key === null ? $meta : ($meta[$key] ?? null);
    }
}
