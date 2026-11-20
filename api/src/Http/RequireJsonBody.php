<?php

declare(strict_types=1);

namespace Omw\Api\Http;

use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;

/**
 * Mutating admin requests (POST/PUT/PATCH/DELETE with a body) must be application/json: forms
 * (which a cross-site page can submit without a preflight) are refused with 415 before any
 * handler runs. Defence in depth next to the X-CSRF-Token check.
 */
final class RequireJsonBody implements MiddlewareInterface
{
    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        $method = strtoupper($request->getMethod());
        if (in_array($method, ['POST', 'PUT', 'PATCH', 'DELETE'], true) && self::hasBody($request)) {
            $type = strtolower(trim(explode(';', $request->getHeaderLine('Content-Type'))[0]));
            if ($type !== 'application/json') {
                throw new ApiException(415, 'unsupported_media_type', 'Request bodies must be application/json.');
            }
        }

        return $handler->handle($request);
    }

    /**
     * HTTP/1.1: a request has a body iff it carries Content-Length or Transfer-Encoding. The stream
     * size is only a fallback for PSR-7 requests built in code (php://input has no known size, so
     * a bodyless DELETE from a real client must not be mistaken for one with a body).
     */
    public static function hasBody(ServerRequestInterface $request): bool
    {
        $length = $request->getHeaderLine('Content-Length');
        if ($length !== '' && ctype_digit($length)) {
            return (int) $length > 0;
        }
        if ($request->hasHeader('Transfer-Encoding')) {
            return true;
        }
        $size = $request->getBody()->getSize();

        return $size !== null && $size > 0;
    }
}
