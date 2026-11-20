<?php

declare(strict_types=1);

namespace Omw\Api\Domain\Alerts;

interface Notifier
{
    /**
     * Delivers the notification to every configured channel.
     *
     * @return int number of channels that accepted it (0 = no channel configured)
     *
     * @throws \RuntimeException when channels are configured but all of them failed
     */
    public function send(Notification $notification): int;
}
