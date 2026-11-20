<?php

declare(strict_types=1);

namespace Omw\Api\Http\Middleware;

use Omw\Api\Domain\Auth\ApiTokens;
use Omw\Api\Domain\Auth\Csrf;
use Omw\Api\Domain\Auth\Sessions;
use Omw\Api\Http\ApiException;
use Omw\Api\Http\AuthContext;
use Omw\Api\Http\Input;
use Omw\Api\Http\SessionCookie;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Routing\RouteContext;

/**
 * /api/v1/admin/*: either
 *   - the session token in the __Host-omw_session cookie (local http dev: see Http\SessionCookie);
 *     mutating methods additionally need the X-CSRF-Token header (derived from the session, see
 *     Domain\Auth\Csrf), or
 *   - a Bearer token of kind "app" with scope "admin" (native apps; no cookie, so no CSRF).
 * POST/DELETE /admin/session handle authentication themselves.
 *
 * Sessions slide: when less than SESSION_DAYS - 1 day is left, the expiry is pushed out and the
 * cookie is re-sent with a fresh Max-Age.
 */
final class AdminAuth implements MiddlewareInterface
{
    private const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];
    private const PUBLIC_ROUTES = ['admin.session.create', 'admin.session.delete'];

    public function __construct(
        private readonly ApiTokens $tokens,
        private readonly Sessions $sessions,
        private readonly SessionCookie $cookies,
    ) {
    }

    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        $routeName = RouteContext::fromRequest($request)->getRoute()?->getName();
        if (in_array($routeName, self::PUBLIC_ROUTES, true)) {
            return $handler->handle($request);
        }

        $ip = Input::clientIp($request);
        $bearer = Input::bearer($request);
        if ($bearer !== null) {
            $row = $this->tokens->authenticate($bearer);
            if ($row === null) {
                throw ApiException::unauthorized('Invalid or expired token.')
                    ->withHeaders(['WWW-Authenticate' => 'Bearer realm="omw-admin", error="invalid_token"']);
            }
            if ($row['kind'] !== 'app' || !in_array('admin', $row['scopes'], true)) {
                throw ApiException::forbidden('This token may not use the admin API.');
            }
            $this->tokens->touch($row['id'], $row['lastUsedAt'], $ip);

            return $handler->handle($request->withAttribute(
                AuthContext::ATTRIBUTE,
                new AuthContext($row['id'], 'app', 'bearer', $bearer, $row['userId'], $row['email'], $row['displayName']),
            ));
        }

        $cookie = $this->cookies->read($request);
        if ($cookie === null) {
            throw ApiException::unauthorized('Not logged in.');
        }
        $row = $this->tokens->authenticate($cookie);
        if ($row === null || $row['kind'] !== 'session') {
            throw ApiException::unauthorized('The session expired. Please log in again.')
                ->withHeaders(['Set-Cookie' => $this->cookies->clear($request)]);
        }
        if (!in_array(strtoupper($request->getMethod()), self::SAFE_METHODS, true)) {
            $header = $request->getHeaderLine(Csrf::HEADER);
            if (!Csrf::verify($cookie, $header === '' ? null : $header)) {
                throw ApiException::forbidden('Missing or invalid X-CSRF-Token header.', 'csrf');
            }
        }
        $this->tokens->touch($row['id'], $row['lastUsedAt'], $ip);
        $extend = $this->sessions->shouldExtend($row['expiresAt']);
        if ($extend) {
            $this->tokens->extend($row['id'], $this->sessions->expiry());
        }

        $response = $handler->handle($request->withAttribute(
            AuthContext::ATTRIBUTE,
            new AuthContext($row['id'], 'session', 'cookie', $cookie, $row['userId'], $row['email'], $row['displayName']),
        ));

        return $extend
            ? $response->withAddedHeader('Set-Cookie', $this->cookies->issue($request, $cookie, $this->sessions->maxAgeSeconds()))
            : $response;
    }
}
