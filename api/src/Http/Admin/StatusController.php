<?php

declare(strict_types=1);

namespace Omw\Api\Http\Admin;

use Omw\Api\Config;
use Omw\Api\Domain\Access\AccessState;
use Omw\Api\Domain\BackendStatus;
use Omw\Api\Http\Input;
use Omw\Api\Http\Responder;
use Omw\Api\Infra\CronRunner;
use Omw\Api\Infra\Doctor;
use Omw\Api\Infra\DoctorCheck;
use Omw\Api\Infra\HttpClient;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Store\StoreWriterFactory;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 *   GET /admin/status   StatusResponse (backend heartbeat, last seen, publish reports, alerts, and the
 *                       counts-only access summary of spec-wave5 §4.2: no names, it is persisted by the admin)
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
        private readonly AccessState $access,
        private readonly StoreWriterFactory $writers,
    ) {
    }

    public function status(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $status = $this->status->status();
        $status['access'] = $this->access->summary();

        return $this->responder->json($response, $status, 'StatusResponse');
    }

    public function doctor(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $doctor = new Doctor($this->config);
        $checks = $doctor->run();
        $checks[] = Doctor::cron($this->cron->last(), Clock::now());
        $storeId = $this->access->row()['store_id'] ?? null;
        $checks[] = $doctor->accessStore($this->writers, is_string($storeId) ? $storeId : null);
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
