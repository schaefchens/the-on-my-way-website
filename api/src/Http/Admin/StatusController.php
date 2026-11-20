<?php

declare(strict_types=1);

namespace Omw\Api\Http\Admin;

use Omw\Api\Config;
use Omw\Api\Domain\BackendStatus;
use Omw\Api\Http\Input;
use Omw\Api\Http\Responder;
use Omw\Api\Infra\CronRunner;
use Omw\Api\Infra\Doctor;
use Omw\Api\Infra\DoctorCheck;
use Omw\Api\Infra\HttpClient;
use Omw\Api\Infra\Clock;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 *   GET /admin/status   StatusResponse (backend heartbeat, last seen, publish reports, alerts)
 *   GET /admin/doctor   {ok, checks: [{name, status: ok|warn|fail, message, hint}]} — environment
 *                       checks as seen by the web SAPI, plus an HTTP self-check that private files
 *                       (/.env, /var/…, /src/…, /vendor/…, /composer.json) are not reachable
 *                       (not part of packages/contracts)
 */
final class StatusController
{
    public function __construct(
        private readonly Responder $responder,
        private readonly BackendStatus $status,
        private readonly Config $config,
        private readonly HttpClient $http,
        private readonly CronRunner $cron,
    ) {
    }

    public function status(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        return $this->responder->json($response, $this->status->status(), 'StatusResponse');
    }

    public function doctor(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $doctor = new Doctor($this->config);
        $checks = $doctor->run();
        $checks[] = Doctor::cron($this->cron->last(), Clock::now());
        $baseUrl = $this->config->appUrl;
        if ($baseUrl === '') {
            $uri = $request->getUri();
            $baseUrl = ($uri->getHost() !== '' ? $uri->getScheme() . '://' . $uri->getAuthority() : '') . Input::basePath($request);
        }
        $checks = array_merge($checks, $doctor->httpExposure($baseUrl, $this->http));

        return $this->responder->json($response, [
            'ok' => !Doctor::hasFailures($checks),
            'checks' => array_map(static fn (DoctorCheck $c): array => $c->toArray(), $checks),
        ]);
    }
}
