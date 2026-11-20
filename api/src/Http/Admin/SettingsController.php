<?php

declare(strict_types=1);

namespace Omw\Api\Http\Admin;

use InvalidArgumentException;
use Omw\Api\Config;
use Omw\Api\Domain\Settings;
use Omw\Api\Http\ApiException;
use Omw\Api\Http\Input;
use Omw\Api\Http\Responder;
use Omw\Api\Infra\BlockedDestination;
use Omw\Api\Infra\OutboundUrl;
use Omw\Api\Infra\PublicAddressGuard;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use RuntimeException;
use stdClass;

/**
 *   GET   /admin/settings   Settings
 *   PATCH /admin/settings   SettingsPatch -> Settings (null clears site.author / site.intro /
 *                           site.avatar / alerts.email / alerts.ntfy_url; a newly picked
 *                           site.avatar must be a captured, non-revoked photo, else 422;
 *                           publish.mode_since is maintained by the API: it moves only on
 *                           instant -> delayed/review, delayed -> review and a changed delay
 *                           while delayed, see Policy::nextModeSince(); time zones are stored
 *                           canonically)
 *
 * In production an alerts.ntfy_url whose host is or resolves to a loopback, private, link-local,
 * CGNAT, unique-local or otherwise non-public address is refused with 422 (the contract schema
 * is unchanged; ChannelNotifier refuses such URLs at send time as well). A host that does not
 * resolve right now is accepted: delivery checks again.
 */
final class SettingsController
{
    public function __construct(
        private readonly Input $input,
        private readonly Responder $responder,
        private readonly Settings $settings,
        private readonly Config $config,
        private readonly PublicAddressGuard $guard,
    ) {
    }

    public function get(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        return $this->responder->json($response, $this->settings->all(), 'Settings');
    }

    public function patch(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $patch = $this->input->body($request, 'SettingsPatch');
        $this->vetAlertUrl($patch);

        return $this->responder->json($response, $this->settings->patch($patch), 'Settings');
    }

    /** @throws ApiException 422 for an alert URL that may not be used (production only) */
    private function vetAlertUrl(stdClass $patch): void
    {
        $url = $patch->{'alerts.ntfy_url'} ?? null;
        if (!is_string($url) || !$this->config->isProduction()) {
            return;
        }
        try {
            $this->guard->vet(OutboundUrl::parse($url));
        } catch (InvalidArgumentException|BlockedDestination $e) {
            throw ApiException::validation('alerts.ntfy_url ' . $e->getMessage() . '.', ['errors' => ['/alerts.ntfy_url: ' . $e->getMessage()]]);
        } catch (RuntimeException) {
            // Does not resolve at the moment: accepted, the next delivery checks it again.
        }
    }
}
