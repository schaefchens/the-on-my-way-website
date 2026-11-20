<?php

declare(strict_types=1);

namespace Omw\Api\Http\Middleware;

use Omw\Api\Config;
use Psr\Http\Message\ResponseFactoryInterface;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;

/**
 * CORS for the public visitor endpoints (/api/v1/public/*, "later" in the plan): only the static
 * site's origin (SITE_ORIGIN) is allowed, without credentials. Admin and backend routes never get
 * CORS headers (the admin PWA is same-origin; the backend is not a browser).
 */
final class Cors implements MiddlewareInterface
{
    public const ALLOW_METHODS = 'GET, POST';
    public const ALLOW_HEADERS = 'Content-Type';
    public const MAX_AGE = '600';

    public function __construct(
        private readonly Config $config,
        private readonly ResponseFactoryInterface $responses,
    ) {
    }

    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        $origin = $request->getHeaderLine('Origin');
        $allowed = $origin !== '' && $this->config->siteOrigin !== '' && strtolower($origin) === $this->config->siteOrigin;

        if (strtoupper($request->getMethod()) === 'OPTIONS' && $request->hasHeader('Access-Control-Request-Method')) {
            $response = $this->responses->createResponse(204)->withHeader('Vary', 'Origin');
            if ($allowed) {
                $response = $response
                    ->withHeader('Access-Control-Allow-Origin', $this->config->siteOrigin)
                    ->withHeader('Access-Control-Allow-Methods', self::ALLOW_METHODS)
                    ->withHeader('Access-Control-Allow-Headers', self::ALLOW_HEADERS)
                    ->withHeader('Access-Control-Max-Age', self::MAX_AGE);
            }

            return $response;
        }

        $response = $handler->handle($request)->withAddedHeader('Vary', 'Origin');

        return $allowed ? $response->withHeader('Access-Control-Allow-Origin', $this->config->siteOrigin) : $response;
    }
}
