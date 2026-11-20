<?php

declare(strict_types=1);

namespace Omw\Api\Domain\Alerts;

use Omw\Api\Config;
use Omw\Api\Domain\Settings;
use InvalidArgumentException;
use Omw\Api\Infra\HttpClient;
use Omw\Api\Infra\OutboundUrl;
use Omw\Api\Infra\PublicAddressGuard;
use Psr\Log\LoggerInterface;
use RuntimeException;
use Symfony\Component\Mailer\Mailer;
use Symfony\Component\Mailer\Transport;
use Symfony\Component\Mime\Address;
use Symfony\Component\Mime\Email;
use Throwable;

/**
 * Sends alerts by e-mail (settings "alerts.email" + MAIL_DSN via Symfony Mailer) and/or ntfy
 * (settings "alerts.ntfy_url", optional NTFY_TOKEN). Channels are read on every send, so
 * changing them in the admin takes effect at the next cron run.
 *
 * alerts.ntfy_url is chosen in the admin (a session or an app token can change it), so:
 * - NTFY_TOKEN (an operator secret from .env) is sent only when the URL's origin is NTFY_SERVER
 *   (default https://ntfy.sh); any other server gets the alert without it;
 * - in production the URL must point to the public internet ({@see PublicAddressGuard}: every
 *   resolved address is checked and the connection is pinned to them, no redirects), so the
 *   setting cannot make this host POST into its own network. A refusal is a delivery error with
 *   the reason (logged, the alert is retried on the next run).
 */
final class ChannelNotifier implements Notifier
{
    public function __construct(
        private readonly Config $config,
        private readonly Settings $settings,
        private readonly HttpClient $http,
        private readonly PublicAddressGuard $guard,
        private readonly ?LoggerInterface $logger = null,
    ) {
    }

    public function send(Notification $notification): int
    {
        $delivered = 0;
        $errors = [];
        $email = $this->settings->get('alerts.email');
        if (is_string($email) && $email !== '' && $this->config->mailDsn !== '') {
            try {
                $this->sendMail($email, $notification);
                ++$delivered;
            } catch (Throwable $e) {
                $errors[] = 'e-mail: ' . $e->getMessage();
            }
        }
        $ntfy = $this->settings->get('alerts.ntfy_url');
        if (is_string($ntfy) && $ntfy !== '') {
            try {
                $this->sendNtfy($ntfy, $notification);
                ++$delivered;
            } catch (Throwable $e) {
                $errors[] = 'ntfy: ' . $e->getMessage();
            }
        }
        foreach ($errors as $error) {
            $this->logger?->error('Alert notification failed: {error}', ['error' => $error, 'kind' => $notification->kind]);
        }
        if ($delivered === 0 && $errors !== []) {
            throw new RuntimeException(implode('; ', $errors));
        }

        return $delivered;
    }

    private function sendMail(string $to, Notification $n): void
    {
        $from = $this->config->mailFrom !== '' ? Address::create($this->config->mailFrom) : new Address($to, 'On My Way');
        $message = (new Email())
            ->from($from)
            ->to($to)
            ->subject($n->title)
            ->text($n->message . "\n\n" . ($n->resolved ? 'Resolved' : 'Since') . ': ' . $n->at . "\nKind: " . $n->kind . "\n");
        (new Mailer(Transport::fromDsn($this->config->mailDsn)))->send($message);
    }

    private function sendNtfy(string $setting, Notification $n): void
    {
        try {
            $url = OutboundUrl::parse($setting);
        } catch (InvalidArgumentException $e) {
            throw new RuntimeException('alerts.ntfy_url ' . $e->getMessage(), 0, $e);
        }
        // Production: only public destinations, and the connection is pinned to the vetted addresses.
        $pinned = $this->config->isProduction() ? $this->guard->vet($url) : null;
        $headers = [
            'Title' => $n->title,
            'Priority' => $n->resolved ? 'default' : ($n->severity === 'critical' ? 'urgent' : 'high'),
            'Tags' => $n->resolved ? 'white_check_mark' : ($n->severity === 'critical' ? 'rotating_light' : 'warning'),
            'Content-Type' => 'text/plain; charset=utf-8',
        ];
        if ($this->config->ntfyToken !== '' && $url->origin() === $this->config->ntfyServer) {
            $headers['Authorization'] = 'Bearer ' . $this->config->ntfyToken;
        }
        $response = $this->http->request('POST', $url->toString(), $headers, $n->message, 10.0, $pinned);
        if ($response['status'] < 200 || $response['status'] >= 300) {
            throw new RuntimeException('ntfy answered HTTP ' . $response['status']);
        }
    }
}
