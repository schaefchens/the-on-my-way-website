<?php

declare(strict_types=1);

namespace Omw\Api\Http\App;

use Omw\Api\Domain\App\AppPhones;
use Omw\Api\Domain\App\AppRateLimiter;
use Omw\Api\Domain\Auth\ApiTokens;
use Omw\Api\Http\ApiException;
use Omw\Api\Http\Input;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;

/**
 * /api/v1/app/* (except POST /app/pair): Bearer capture token of a connected phone (table
 * app_phones, scope "capture"). 401 unauthorized / token_revoked (the owner disconnected the
 * phone: the app wipes its server data and keeps its outbox), 403 for an admin or backend token,
 * 429 above the per-phone request limit. The phone is passed on as {@see ATTRIBUTE}.
 */
final class AppAuth implements MiddlewareInterface
{
    public const ATTRIBUTE = 'omw.app.phone';

    public function __construct(
        private readonly AppPhones $phones,
        private readonly ApiTokens $tokens,
        private readonly AppRateLimiter $limiter,
    ) {
    }

    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        $token = Input::bearer($request);
        if ($token === null) {
            throw ApiException::unauthorized('A phone token is required (Authorization: Bearer omw_…).')
                ->withHeaders(['WWW-Authenticate' => 'Bearer realm="omw-app"']);
        }
        $phone = $this->phones->authenticate($token);
        if ($phone === null) {
            if ($this->phones->isRevoked($token)) {
                throw (new ApiException(401, 'token_revoked', 'This phone was disconnected. Connect it again with a new code.'))
                    ->withHeaders(['WWW-Authenticate' => 'Bearer realm="omw-app", error="invalid_token"']);
            }
            if ($this->tokens->authenticate($token) !== null) {
                throw ApiException::forbidden('This token may not use the app API.');
            }
            throw ApiException::unauthorized('Invalid or expired token.')
                ->withHeaders(['WWW-Authenticate' => 'Bearer realm="omw-app", error="invalid_token"']);
        }
        $this->limiter->phoneRequest($phone['id']);
        $this->phones->touch($phone['id'], $phone['lastUsedAt'], Input::clientIp($request));

        return $handler->handle($request->withAttribute(self::ATTRIBUTE, $phone));
    }

    /** @return array{id: int, userId: int, name: string, expiresAt: string|null, lastUsedAt: string|null} */
    public static function phone(ServerRequestInterface $request): array
    {
        $phone = $request->getAttribute(self::ATTRIBUTE);
        if (!is_array($phone)) {
            throw ApiException::unauthorized();
        }

        /** @var array{id: int, userId: int, name: string, expiresAt: string|null, lastUsedAt: string|null} $phone */
        return $phone;
    }
}
