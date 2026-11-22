<?php

declare(strict_types=1);

namespace Omw\Api\Http\App;

use Omw\Api\Domain\App\AppInbox;
use Omw\Api\Domain\App\AppPhones;
use Omw\Api\Domain\App\AppRules;
use Omw\Api\Domain\Ids;
use Omw\Api\Http\Admin\SessionController;
use Omw\Api\Http\ApiException;
use Omw\Api\Http\Input;
use Omw\Api\Http\Responder;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * /api/v1/admin/app-* ("Connect a phone" in the admin; Middleware\AdminAuth + RequireJsonBody).
 *
 *   POST   /app-pairings               AppPairingCreate -> AppPairingCreated (201); cancels the open code
 *   GET    /app-phones                 AppPhoneListResponse
 *   DELETE /app-phones/{id}            "Disconnect" -> 204 (404 for an unknown phone)
 *   GET    /app-entries/{sourceKey}    AppEntryAdminInfo (the App badge's details)
 */
final class AppAdminController
{
    public function __construct(
        private readonly Input $input,
        private readonly Responder $responder,
        private readonly AppPhones $phones,
        private readonly AppInbox $inbox,
    ) {
    }

    public function createPairing(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $body = $this->input->body($request, 'AppPairingCreate');
        $auth = SessionController::auth($request);
        if ($auth->userId === null) {
            throw ApiException::forbidden('Only the owner can connect a phone.');
        }
        $ttl = isset($body->ttlMinutes) && is_int($body->ttlMinutes) ? $body->ttlMinutes : AppRules::PAIRING_TTL_DEFAULT;

        return $this->responder->json($response, $this->phones->createPairing($auth->userId, $ttl), 'AppPairingCreated', 201);
    }

    public function phones(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        return $this->responder->json($response, [
            'items' => $this->phones->list(),
            'openPairing' => $this->phones->openPairing(),
            'inbox' => ['usedBytes' => $this->inbox->usage(), 'maxBytes' => $this->inbox->maxBytes()],
            'archiveOnly' => $this->inbox->archiveOnly(),
        ], 'AppPhoneListResponse');
    }

    public function disconnect(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        if (!$this->phones->revoke((int) Input::arg($request, 'id'))) {
            throw ApiException::notFound('No such phone.');
        }

        return $this->responder->noContent($response);
    }

    public function entry(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $sourceKey = Input::arg($request, 'sourceKey');
        if (!Ids::isSourceKey($sourceKey)) {
            throw ApiException::validation('Invalid sourceKey (expected "<ns>:<id>").');
        }

        return $this->responder->json($response, $this->inbox->adminInfo($sourceKey), 'AppEntryAdminInfo');
    }
}
