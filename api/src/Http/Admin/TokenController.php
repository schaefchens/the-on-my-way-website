<?php

declare(strict_types=1);

namespace Omw\Api\Http\Admin;

use Omw\Api\Domain\Auth\ApiTokens;
use Omw\Api\Domain\Time;
use Omw\Api\Http\ApiException;
use Omw\Api\Http\Input;
use Omw\Api\Http\Responder;
use Omw\Api\Infra\Clock;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 *   GET    /admin/tokens        TokenListResponse (active backend/app tokens, newest first)
 *   POST   /admin/tokens        TokenCreate -> TokenCreated (201; the token is shown once)
 *   DELETE /admin/tokens/{id}   204; 404 when no active backend/app token has that id
 */
final class TokenController
{
    public function __construct(
        private readonly Input $input,
        private readonly Responder $responder,
        private readonly ApiTokens $tokens,
    ) {
    }

    public function list(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        return $this->responder->json($response, ['items' => $this->tokens->list()], 'TokenListResponse');
    }

    public function create(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $body = $this->input->body($request, 'TokenCreate');
        $expiresAt = isset($body->expiresAt) && is_string($body->expiresAt) ? Time::toIsoUtc($body->expiresAt) : null;
        if ($expiresAt !== null && $expiresAt <= Clock::nowIso()) {
            throw ApiException::validation('expiresAt must be in the future.', ['errors' => ['/expiresAt: must be in the future']]);
        }
        $kind = (string) $body->kind;
        $auth = SessionController::auth($request);
        $created = $this->tokens->create($kind, trim((string) $body->name), null, $kind === 'app' ? $auth->userId : null, $expiresAt);
        $info = $this->tokens->info($created['id']) ?? throw new ApiException(500, 'internal', 'Token vanished.');

        return $this->responder->json($response, ['token' => $created['token'], 'info' => $info], 'TokenCreated', 201);
    }

    public function revoke(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $id = (int) Input::arg($request, 'id');
        if (!$this->tokens->revoke($id, false)) {
            throw ApiException::notFound('No active token with this id.');
        }

        return $this->responder->noContent($response);
    }
}
