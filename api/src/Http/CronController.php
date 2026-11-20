<?php

declare(strict_types=1);

namespace Omw\Api\Http;

use Omw\Api\Config;
use Omw\Api\Infra\CronRunner;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET|POST /api/v1/cron — web-cron for hosts without a CLI cron. Runs the same jobs as
 * bin/cron.php. The secret CRON_KEY (.env, at least 24 characters) is sent as the X-Cron-Key
 * header (preferred), as "Authorization: Bearer <CRON_KEY>" (cron multiplexers such as Enoch's
 * scheduled requests, which send only a Bearer token and allow about 8 s per call), or as ?key=…
 * for web-cron services that cannot set headers; it is compared in constant time. Without
 * CRON_KEY the endpoint does not exist (404).
 *
 * Answers 200 {ok, at, skipped, jobs, durationMs}; 403 for a wrong key. A run normally takes well
 * under a second; if the caller gives up early, ignore_user_abort lets the run finish.
 */
final class CronController
{
    public function __construct(
        private readonly Config $config,
        private readonly CronRunner $cron,
        private readonly Responder $responder,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        if (!$this->config->webCronEnabled()) {
            throw ApiException::notFound();
        }
        $key = $request->getHeaderLine('X-Cron-Key');
        if ($key === '') {
            $key = Input::bearer($request) ?? '';
        }
        if ($key === '') {
            $query = $request->getQueryParams()['key'] ?? '';
            $key = is_string($query) ? $query : '';
        }
        if (!hash_equals($this->config->cronKey, $key)) {
            throw ApiException::forbidden('Wrong cron key.');
        }
        ignore_user_abort(true);
        if (function_exists('set_time_limit')) {
            @set_time_limit(55);
        }

        return $this->responder->json($response, $this->cron->run());
    }
}
