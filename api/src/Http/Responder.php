<?php

declare(strict_types=1);

namespace Omw\Api\Http;

use LogicException;
use Omw\Api\Config;
use Omw\Api\Infra\SchemaValidator;
use Psr\Http\Message\ResponseInterface;

/**
 * Writes JSON responses. Outside production every response that names a contract schema is
 * validated against api/schemas/<Name>.json first, so the test suite (and local development)
 * fails loudly when PHP output drifts from packages/contracts.
 */
final class Responder
{
    public function __construct(
        private readonly SchemaValidator $schemas,
        private readonly Config $config,
    ) {
    }

    public function json(ResponseInterface $response, mixed $data, ?string $schema = null, int $status = 200): ResponseInterface
    {
        if ($schema !== null && !$this->config->isProduction()) {
            $errors = $this->schemas->errors(SchemaValidator::toJsonValue($data), $schema);
            if ($errors !== []) {
                throw new LogicException("Response does not match the contract $schema: " . implode('; ', $errors));
            }
        }

        return Json::respond($response, $data, $status);
    }

    public function noContent(ResponseInterface $response): ResponseInterface
    {
        return $response->withStatus(204)->withHeader('Cache-Control', 'no-store');
    }
}
