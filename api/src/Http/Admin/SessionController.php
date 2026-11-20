<?php

declare(strict_types=1);

namespace Omw\Api\Http\Admin;

use Omw\Api\Domain\Auth\ApiTokens;
use Omw\Api\Domain\Auth\Csrf;
use Omw\Api\Domain\Auth\Sessions;
use Omw\Api\Http\ApiException;
use Omw\Api\Http\AuthContext;
use Omw\Api\Http\Input;
use Omw\Api\Http\Responder;
use Omw\Api\Http\SessionCookie;
use Omw\Api\Infra\SchemaValidator;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use stdClass;

/**
 *   POST   /api/v1/admin/session  LoginRequest -> Me + Set-Cookie (__Host-omw_session, see Http\SessionCookie); 401 generic; 429
 *   DELETE /api/v1/admin/session  204, clears the cookie (needs X-CSRF-Token while the session is valid)
 *   GET    /api/v1/admin/me       Me
 */
final class SessionController
{
    public function __construct(
        private readonly Responder $responder,
        private readonly Sessions $sessions,
        private readonly ApiTokens $tokens,
        private readonly SchemaValidator $schemas,
        private readonly SessionCookie $cookies,
    ) {
    }

    public function create(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $body = $request->getParsedBody();
        $email = $body instanceof stdClass && is_string($body->email ?? null) ? $body->email : null;
        $password = $body instanceof stdClass && is_string($body->password ?? null) ? $body->password : null;
        if (!$body instanceof stdClass || $this->schemas->errors($body, 'LoginRequest') !== []) {
            // Malformed requests fail exactly like wrong passwords (and count towards the limit).
            $email = $email !== null && strlen($email) <= 254 ? $email : null;
            $password = null;
        }
        $login = $this->sessions->login($email, $password, Input::clientIp($request));

        return $this->responder
            ->json($response, self::meDto($login['email'], $login['displayName'], $login['token']), 'Me')
            ->withAddedHeader('Set-Cookie', $this->cookies->issue($request, $login['token'], $this->sessions->maxAgeSeconds()));
    }

    public function delete(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $cookie = $this->cookies->read($request);
        if ($cookie !== null) {
            $row = $this->tokens->authenticate($cookie);
            if ($row !== null && $row['kind'] === 'session') {
                $header = $request->getHeaderLine(Csrf::HEADER);
                if (!Csrf::verify($cookie, $header === '' ? null : $header)) {
                    throw ApiException::forbidden('Missing or invalid X-CSRF-Token header.', 'csrf');
                }
                $this->tokens->revokeToken($cookie);
            }
        }

        return $this->responder->noContent($response)->withAddedHeader('Set-Cookie', $this->cookies->clear($request));
    }

    public function me(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $auth = self::auth($request);

        return $this->responder->json($response, self::meDto((string) $auth->email, $auth->displayName, $auth->token), 'Me');
    }

    /** @return array{email: string, displayName: string|null, csrfToken: string} */
    private static function meDto(string $email, ?string $displayName, string $token): array
    {
        return ['email' => $email, 'displayName' => $displayName, 'csrfToken' => Csrf::tokenFor($token)];
    }

    public static function auth(ServerRequestInterface $request): AuthContext
    {
        $auth = $request->getAttribute(AuthContext::ATTRIBUTE);
        if (!$auth instanceof AuthContext) {
            throw ApiException::unauthorized();
        }

        return $auth;
    }
}
