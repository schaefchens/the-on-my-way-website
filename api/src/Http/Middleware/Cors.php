<?php

declare(strict_types=1);

namespace Omw\Api\Http\Middleware;

use Omw\Api\Config;
use Omw\Api\Http\JsonErrorHandler;
use Psr\Http\Message\ResponseFactoryInterface;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Throwable;

/**
 * CORS for the public routes (/api/v1/public/*): only the static site's origin (SITE_ORIGIN) is
 * allowed. Admin and backend routes never get CORS headers (the admin PWA is same-origin; the
 * backend is not a browser).
 *
 * The site calls the public routes as "simple requests" (text/plain JSON, credentials omitted):
 * no preflight. Every answer carries the CORS headers, errors included (429 with Retry-After,
 * 503 busy, 413, 400): this middleware renders exceptions itself so the browser can read them.
 * `Access-Control-Expose-Headers: Content-Disposition, Retry-After` lets the page read the export's
 * file name and the wait time. Only with ACCESS_COOKIE_MODE=parent (F2) do join, device/poll and
 * me/hello answer with `Access-Control-Allow-Credentials: true` (the API sets the cookies there).
 */
final class Cors implements MiddlewareInterface
{
    public const ALLOW_METHODS = 'GET, POST';
    public const ALLOW_HEADERS = 'Content-Type';
    public const EXPOSE_HEADERS = 'Content-Disposition, Retry-After';
    public const MAX_AGE = '600';
    /** Path suffixes that may carry cookies in F2. */
    public const CREDENTIAL_ROUTES = ['/public/join', '/public/device/poll', '/public/me/hello'];

    public function __construct(
        private readonly Config $config,
        private readonly ResponseFactoryInterface $responses,
        private readonly JsonErrorHandler $errors,
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
                if ($this->credentials($request)) {
                    $response = $response->withHeader('Access-Control-Allow-Credentials', 'true');
                }
            }

            return $response;
        }

        try {
            $response = $handler->handle($request);
        } catch (Throwable $e) {
            $debug = $this->config->debug;
            $response = ($this->errors)($request, $e, $debug, true, $debug || !$this->config->isProduction());
        }
        $response = $response->withAddedHeader('Vary', 'Origin');
        if (!$allowed) {
            return $response;
        }
        $response = $response
            ->withHeader('Access-Control-Allow-Origin', $this->config->siteOrigin)
            ->withHeader('Access-Control-Expose-Headers', self::EXPOSE_HEADERS);

        return $this->credentials($request) ? $response->withHeader('Access-Control-Allow-Credentials', 'true') : $response;
    }

    private function credentials(ServerRequestInterface $request): bool
    {
        if (!$this->config->access->isParent()) {
            return false;
        }
        $path = rtrim($request->getUri()->getPath(), '/');
        foreach (self::CREDENTIAL_ROUTES as $suffix) {
            if (str_ends_with($path, $suffix)) {
                return true;
            }
        }

        return false;
    }
}
