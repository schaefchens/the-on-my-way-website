<?php

declare(strict_types=1);

namespace Omw\Api\Domain\App;

use Omw\Api\Http\ApiException;
use Omw\Api\Infra\Paths;
use RuntimeException;

/**
 * The transfer slots of the app inbox (app-plan §3.6): chunk uploads (PATCH bodies) and the
 * backend's content downloads hold one each, so a slow upload abroad can never take every PHP
 * worker of the shared host (the admin, the sync and wave 5's gate need them too). JSON requests
 * never take one.
 *
 * A slot is an exclusive, non-blocking flock on var/app-inbox/.slots/<n>.lock; the OS releases it
 * when the handle closes, also when PHP dies mid-request. All busy -> 503 transfer_busy with a
 * jittered Retry-After.
 */
final class TransferSlots
{
    public const RETRY_AFTER_MIN = 5;
    public const RETRY_AFTER_MAX = 20;

    public function __construct(
        private readonly Paths $paths,
        private readonly AppInboxConfig $config,
    ) {
    }

    /**
     * @return resource the locked handle; pass it to {@see release()} (or let it be closed)
     *
     * @throws ApiException 503 transfer_busy when every slot is taken
     */
    public function acquire(): mixed
    {
        $dir = $this->paths->var(AppInbox::DIR . '/.slots');
        Paths::ensureDir($dir);
        for ($i = 0; $i < $this->config->transferSlots; ++$i) {
            $handle = @fopen($dir . '/' . $i . '.lock', 'c');
            if ($handle === false) {
                throw new RuntimeException('Cannot open the transfer slot lock ' . $i);
            }
            if (flock($handle, LOCK_EX | LOCK_NB)) {
                return $handle;
            }
            fclose($handle);
        }

        throw (new ApiException(503, 'transfer_busy', 'Another transfer is running. Try again shortly.'))
            ->withHeaders(['Retry-After' => (string) random_int(self::RETRY_AFTER_MIN, self::RETRY_AFTER_MAX)]);
    }

    /** @param resource|null $handle */
    public static function release(mixed $handle): void
    {
        if (is_resource($handle)) {
            flock($handle, LOCK_UN);
            fclose($handle);
        }
    }
}
