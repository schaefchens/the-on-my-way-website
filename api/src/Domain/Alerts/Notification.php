<?php

declare(strict_types=1);

namespace Omw\Api\Domain\Alerts;

/** One alert message (opened, repeated or resolved). */
final class Notification
{
    public function __construct(
        public readonly string $kind,
        public readonly string $severity,
        public readonly string $title,
        public readonly string $message,
        public readonly bool $resolved,
        public readonly string $at,
    ) {
    }
}
