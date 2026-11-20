<?php

declare(strict_types=1);

namespace Omw\Api\Http\Middleware;

use Omw\Api\Domain\Auth\ApiTokens;
use Omw\Api\Http\ApiException;
use Omw\Api\Http\AuthContext;
use Omw\Api\Http\Input;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;

/**
 * /api/v1/backend/*: Bearer token of kind "backend" with scope "backend".
 * 401 without a valid token, 403 for a valid token of another kind.
 */
final class BackendAuth implements MiddlewareInterface
{
    public function __construct(private readonly ApiTokens $tokens)
    {
    }

    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        $token = Input::bearer($request);
        if ($token === null) {
            throw ApiException::unauthorized('A backend token is required (Authorization: Bearer omw_…).')
                ->withHeaders(['WWW-Authenticate' => 'Bearer realm="omw-backend"']);
        }
        $row = $this->tokens->authenticate($token);
        if ($row === null) {
            throw ApiException::unauthorized('Invalid or expired token.')
                ->withHeaders(['WWW-Authenticate' => 'Bearer realm="omw-backend", error="invalid_token"']);
        }
        if ($row['kind'] !== 'backend' || !in_array('backend', $row['scopes'], true)) {
            throw ApiException::forbidden('This token may not use the backend API.');
        }
        $this->tokens->touch($row['id'], $row['lastUsedAt'], Input::clientIp($request));

        return $handler->handle($request->withAttribute(
            AuthContext::ATTRIBUTE,
            new AuthContext($row['id'], 'backend', 'bearer', $token),
        ));
    }
}
