<?php

declare(strict_types=1);

namespace Omw\Api\Http\App;

use Omw\Api\Domain\App\AppInbox;
use Omw\Api\Domain\App\AppInboxConfig;
use Omw\Api\Domain\App\AppRules;
use Omw\Api\Http\ApiException;
use Omw\Api\Http\Input;
use Omw\Api\Http\Responder;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * /api/v1/backend/app/* (Bearer backend token, Middleware\BackendAuth): the home computer's side
 * of the app inbox (contracts ./app-inbox).
 *
 *   GET  /entries?archiveOnly=0|1&limit=   AppInboxResponse (also records the backend's switch)
 *   GET  /uploads/{uploadId}/content       the committed file (200, or 206 for Range: bytes=N-[M]);
 *                                          X-Omw-Sha256 = sha256 of the whole file; 503 transfer_busy
 *   POST /entries/{entryId}/ack            AppInboxAck -> 204 (410 gone: withdrawn meanwhile)
 *   POST /entries/{entryId}/reject         AppInboxReject -> 204
 */
final class AppBackendController
{
    public function __construct(
        private readonly Input $input,
        private readonly Responder $responder,
        private readonly AppInbox $inbox,
    ) {
    }

    public function entries(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $query = $request->getQueryParams();
        $unknown = array_diff(array_map('strval', array_keys($query)), ['archiveOnly', 'limit']);
        if ($unknown !== []) {
            throw ApiException::validation('Unknown query parameter(s).');
        }
        $archiveOnly = match ($query['archiveOnly'] ?? null) {
            null => null,
            '1', 'true' => true,
            '0', 'false' => false,
            default => throw ApiException::validation('archiveOnly must be 0 or 1.'),
        };
        $limit = AppInboxConfig::PAGE_SIZE;
        if (isset($query['limit'])) {
            if (!is_string($query['limit']) || preg_match('/^[1-9]\d?$/D', $query['limit']) !== 1 || (int) $query['limit'] > 50) {
                throw ApiException::validation('limit must be between 1 and 50.');
            }
            $limit = (int) $query['limit'];
        }

        return $this->responder->json($response, $this->inbox->pending($limit, $archiveOnly), 'AppInboxResponse');
    }

    public function content(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $uploadId = Input::arg($request, 'uploadId');
        if (preg_match('/^u_[A-Za-z0-9_-]{16,64}$/D', $uploadId) !== 1) {
            throw ApiException::notFound('No such upload.');
        }
        $file = $this->inbox->openContent($uploadId, $request->getHeaderLine('Range'));
        $response = $response
            ->withBody($file['stream'])
            ->withHeader('Content-Type', $file['mimetype'])
            ->withHeader('Content-Length', (string) $file['length'])
            ->withHeader('Accept-Ranges', 'bytes')
            ->withHeader('Cache-Control', 'no-store')
            ->withHeader('X-Omw-Sha256', $file['sha256']);
        if ($file['partial']) {
            return $response
                ->withStatus(206)
                ->withHeader('Content-Range', sprintf('bytes %d-%d/%d', $file['start'], $file['start'] + $file['length'] - 1, $file['total']));
        }

        return $response->withStatus(200);
    }

    public function ack(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $this->inbox->ack(self::entryId($request), $this->input->body($request, 'AppInboxAck'));

        return $this->responder->noContent($response);
    }

    public function reject(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $body = $this->input->body($request, 'AppInboxReject');
        $this->inbox->reject(self::entryId($request), (string) $body->reason);

        return $this->responder->noContent($response);
    }

    private static function entryId(ServerRequestInterface $request): string
    {
        $id = Input::arg($request, 'entryId');
        if (!AppRules::isEntryId($id)) {
            throw ApiException::notFound('No such entry.');
        }

        return $id;
    }
}
