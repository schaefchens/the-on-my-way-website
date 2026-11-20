<?php

declare(strict_types=1);

namespace Omw\Api\Infra;

use RuntimeException;

/** An outgoing request was refused because its host is or resolves to a non-public address ({@see PublicAddressGuard}). */
final class BlockedDestination extends RuntimeException
{
}
