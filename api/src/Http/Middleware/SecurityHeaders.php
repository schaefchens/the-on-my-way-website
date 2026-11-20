<?php

declare(strict_types=1);

namespace Omw\Api\Http\Middleware;

use Omw\Api\Http\Input;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;

/**
 * Security headers on every response of the PHP app (JSON, previews, errors). Static files of
 * the admin PWA get the equivalent headers from public/.htaccess.
 */
final class SecurityHeaders implements MiddlewareInterface
{
    public const HSTS = 'max-age=31536000';

    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        $response = $handler->handle($request)
            ->withHeader('X-Content-Type-Options', 'nosniff')
            ->withHeader('Referrer-Policy', 'same-origin')
            ->withHeader('X-Frame-Options', 'DENY')
            ->withHeader('Cross-Origin-Resource-Policy', 'same-origin')
            ->withHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
        if (Input::isHttps($request)) {
            $response = $response->withHeader('Strict-Transport-Security', self::HSTS);
        }

        return $response;
    }
}
