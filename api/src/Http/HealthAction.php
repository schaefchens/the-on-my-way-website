<?php

declare(strict_types=1);

namespace Omw\Api\Http;

use Omw\Api\App;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/v1/health: liveness only (no database access), for uptime checks and the backend.
 * Deep environment checks live in bin/doctor.php.
 */
final class HealthAction
{
    public function __invoke(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        return Json::respond($response, [
            'ok' => true,
            'version' => App::VERSION,
            'contractVersion' => App::CONTRACT_VERSION,
        ]);
    }
}
