<?php

declare(strict_types=1);

namespace Omw\Api\Http\Admin;

use Omw\Api\Domain\Auth\ApiTokens;
use Omw\Api\Domain\Auth\Csrf;
use Omw\Api\Domain\Auth\LoginThrottle;
use Omw\Api\Domain\Auth\Passwords;
use Omw\Api\Domain\Auth\Sessions;
use Omw\Api\Domain\Auth\Users;
use Omw\Api\Http\ApiException;
use Omw\Api\Http\AuthContext;
use Omw\Api\Http\Input;
use Omw\Api\Http\Responder;
use Omw\Api\Http\SessionCookie;
use Omw\Api\Infra\SchemaValidator;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Log\LoggerInterface;
use stdClass;

/**
 *   POST   /api/v1/admin/session  LoginRequest -> Me + Set-Cookie (__Host-omw_session, see Http\SessionCookie); 401 generic; 429
 *   DELETE /api/v1/admin/session  204, clears the cookie (needs X-CSRF-Token while the session is valid)
 *   GET    /api/v1/admin/me       Me
 *   PUT    /api/v1/admin/me/password  PasswordChange -> 204 (session only, CSRF; spec-wave5 §3.12): rate
 *          limited like a login; 403 wrong_password; 422 validation_failed for a weak new password
 *          (Passwords::MIN_LENGTH), the current one or the e-mail address; other sessions end
 */
final class SessionController
{
    public function __construct(
        private readonly Responder $responder,
        private readonly Sessions $sessions,
        private readonly ApiTokens $tokens,
        private readonly SchemaValidator $schemas,
        private readonly SessionCookie $cookies,
        private readonly Input $input,
        private readonly LoginThrottle $throttle,
        private readonly Users $users,
        private readonly LoggerInterface $logger,
    ) {
    }

    public function password(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $auth = self::auth($request);
        if ($auth->kind !== 'session' || $auth->userId === null) {
            throw ApiException::forbidden('The password can only be changed in the admin (logged in with the password).');
        }
        $body = $this->input->body($request, 'PasswordChange');
        $user = $this->users->findByEmail((string) $auth->email);
        $hash = $user === null ? null : $this->users->passwordHash($user['id']);
        $attempt = $this->throttle->begin(Input::clientIp($request), $auth->email);
        if ($attempt['attemptId'] === null) {
            throw new ApiException(429, 'rate_limited', 'Too many failed attempts. Try again later.', ['retryAfter' => $attempt['retryAfter']]);
        }
        $current = (string) $body->currentPassword;
        if ($user === null || $hash === null || $user['id'] !== $auth->userId || !Passwords::verify($current, $hash)) {
            $this->logger->notice('Password change refused: wrong current password', ['userId' => $auth->userId]);
            throw ApiException::forbidden('The current password is not correct.', 'wrong_password');
        }
        $this->throttle->succeeded($attempt['attemptId']);
        $new = (string) $body->newPassword;
        $problem = Passwords::weakness($new);
        if ($problem === null && hash_equals($current, $new)) {
            $problem = 'The new password must differ from the current one.';
        }
        if ($problem === null && mb_strtolower(trim($new)) === mb_strtolower((string) $auth->email)) {
            $problem = 'The new password must not be the e-mail address.';
        }
        if ($problem !== null) {
            throw ApiException::validation($problem, ['errors' => ['/newPassword: ' . $problem]]);
        }
        $this->users->setPassword($auth->userId, Passwords::hash($new), $auth->tokenId, $body->revokeAppTokens === true);
        $this->logger->info('Admin password changed', ['userId' => $auth->userId, 'appTokensRevoked' => $body->revokeAppTokens === true]);

        return $this->responder->noContent($response);
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
