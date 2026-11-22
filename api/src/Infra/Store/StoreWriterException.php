<?php

declare(strict_types=1);

namespace Omw\Api\Infra\Store;

use Omw\Api\Domain\Access\StoreLayout;
use RuntimeException;
use Throwable;

/**
 * A store write failed. {@see $reason} is a stable code:
 *   path       the path is not one of the store layout's paths (a programming error)
 *   io         a filesystem / SFTP operation failed
 *   connect    the SFTP server could not be reached
 *   host_key   the server's host key is not one of ACCESS_STORE_SFTP_HOSTKEYS
 *   auth       the SFTP login was refused (never retried automatically: the host bans repeated failures)
 *   site_login the SFTP login can see the site docroot (refused unless ACCESS_STORE_SFTP_ALLOW_SITE_LOGIN)
 *   config     the writer is not configured completely
 * The message is redacted: it never contains a session id.
 */
final class StoreWriterException extends RuntimeException
{
    public function __construct(public readonly string $reason, string $message, ?Throwable $previous = null)
    {
        parent::__construct(StoreLayout::redactText($message), 0, $previous);
    }

    public static function io(string $what, string $rel): self
    {
        return new self('io', $what . ' ' . StoreLayout::redact($rel) . ' failed');
    }
}
