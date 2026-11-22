<?php

declare(strict_types=1);

namespace Omw\Api\Http\App;

use Omw\Api\Domain\App\AppInbox;
use Omw\Api\Domain\App\AppPhones;
use Omw\Api\Domain\App\AppRateLimiter;
use Omw\Api\Domain\App\AppRules;
use Omw\Api\Http\ApiException;
use Omw\Api\Http\Input;
use Omw\Api\Http\Responder;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * /api/v1/app/* for the traveler's phone (contracts ./app and ./app-inbox; auth: {@see AppAuth},
 * except POST /pair). Native app: no CORS, no cookies.
 *
 *   POST   /pair                         AppPairRequest -> AppPairResponse (201); 401 pairing_invalid,
 *                                        410 pairing_expired, 429 rate_limited
 *   POST   /entries                      AppEntryCreate -> AppEntryState (201 new, 200 replay); 409
 *                                        entry_conflict, 413 upload_too_large, 422, 507 inbox_full
 *   GET    /entries?ids=a,b              AppEntryListResponse
 *   GET    /entries/{entryId}            AppEntryState
 *   DELETE /entries/{entryId}            withdraw -> 204
 *   POST   /entries/{entryId}/commit     AppCommitRequest -> AppEntryState; 409 incomplete, 422 sha256_mismatch
 *   HEAD   /uploads/{uploadId}           Upload-Offset / Upload-Length
 *   PATCH  /uploads/{uploadId}           one chunk -> 204 + Upload-Offset (tus 1.0 subset, ./app APP_TUS)
 *   DELETE /uploads/{uploadId}           leave an original out -> 204
 *   PUT    /visibility/{sourceKey}       AppVisibilityRequest -> AppEntryState (tighten own entries only)
 *   GET    /hints                        AppHints
 * POST with X-HTTP-Method-Override: PATCH|HEAD|DELETE works too (Slim's MethodOverrideMiddleware).
 */
final class AppController
{
    public const TUS_VERSION = '1.0.0';
    public const TUS_CONTENT_TYPE = 'application/offset+octet-stream';

    public function __construct(
        private readonly Input $input,
        private readonly Responder $responder,
        private readonly AppInbox $inbox,
        private readonly AppPhones $phones,
        private readonly AppRateLimiter $limiter,
    ) {
    }

    public function pair(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $ip = Input::clientIp($request);
        $this->limiter->checkPairing($ip);
        $body = $this->input->body($request, 'AppPairRequest');
        try {
            $paired = $this->phones->pair($body);
        } catch (ApiException $e) {
            if (in_array($e->errorCode, ['pairing_invalid', 'pairing_expired'], true)) {
                $this->limiter->pairingFailed($ip);
            }
            throw $e;
        }

        return $this->responder->json($response, $paired, 'AppPairResponse', 201);
    }

    public function create(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $phone = AppAuth::phone($request);
        $body = $this->input->body($request, 'AppEntryCreate');
        $result = $this->inbox->create($phone['id'], $body);

        return $this->responder->json($response, $result['state'], 'AppEntryState', $result['created'] ? 201 : 200);
    }

    public function list(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $phone = AppAuth::phone($request);
        $query = $request->getQueryParams();
        $raw = $query['ids'] ?? null;
        if (!is_string($raw) || array_diff(array_map('strval', array_keys($query)), ['ids']) !== []) {
            throw ApiException::validation('Use ?ids=<ULID>,<ULID>,… (and nothing else).');
        }
        $ids = array_values(array_filter(explode(',', $raw), static fn (string $id): bool => $id !== ''));
        if ($ids === [] || count($ids) > AppRules::LIST_IDS) {
            throw ApiException::validation(sprintf('Ask for 1 to %d ids.', AppRules::LIST_IDS));
        }
        foreach ($ids as $id) {
            if (!AppRules::isEntryId($id)) {
                throw ApiException::validation('Every id must be a ULID.');
            }
        }

        return $this->responder->json($response, ['items' => $this->inbox->states($phone['id'], $ids)], 'AppEntryListResponse');
    }

    public function get(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        return $this->responder->json($response, $this->inbox->state(AppAuth::phone($request)['id'], self::entryId($request)), 'AppEntryState');
    }

    public function withdraw(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $this->inbox->withdraw(AppAuth::phone($request)['id'], self::entryId($request));

        return $this->responder->noContent($response);
    }

    public function commit(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $phone = AppAuth::phone($request);
        $body = $this->input->body($request, 'AppCommitRequest');
        /** @var list<string> $roles */
        $roles = array_values(array_map('strval', is_array($body->roles) ? $body->roles : []));

        return $this->responder->json($response, $this->inbox->commit($phone['id'], self::entryId($request), $roles), 'AppEntryState');
    }

    public function head(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $slot = $this->inbox->head(AppAuth::phone($request)['id'], self::uploadId($request));

        return self::tus($response->withStatus(200))
            ->withHeader('Upload-Offset', (string) $slot['offset'])
            ->withHeader('Upload-Length', (string) $slot['bytes']);
    }

    public function patch(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $phone = AppAuth::phone($request);
        $uploadId = self::uploadId($request);
        $version = $request->getHeaderLine('Tus-Resumable');
        if ($version !== self::TUS_VERSION) {
            throw (new ApiException(412, 'tus_version', 'Send Tus-Resumable: 1.0.0.'))->withHeaders(['Tus-Version' => self::TUS_VERSION]);
        }
        $type = strtolower(trim(explode(';', $request->getHeaderLine('Content-Type'))[0]));
        if ($type !== self::TUS_CONTENT_TYPE) {
            throw new ApiException(415, 'unsupported_media_type', 'Chunks are sent as application/offset+octet-stream.');
        }
        $offset = $request->getHeaderLine('Upload-Offset');
        if (preg_match('/^\d{1,15}$/D', $offset) !== 1) {
            throw new ApiException(400, 'bad_request', 'Upload-Offset must be a non-negative integer.');
        }
        $length = $request->getHeaderLine('Content-Length');
        $checksum = $request->getHeaderLine('Upload-Checksum');
        $newOffset = $this->inbox->patch(
            $phone['id'],
            $uploadId,
            (int) $offset,
            preg_match('/^\d{1,15}$/D', $length) === 1 ? (int) $length : null,
            $checksum === '' ? null : AppRules::parseUploadChecksum($checksum),
            $request->getBody(),
        );

        return self::tus($response->withStatus(204))->withHeader('Upload-Offset', (string) $newOffset);
    }

    public function abandon(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $this->inbox->abandon(AppAuth::phone($request)['id'], self::uploadId($request));

        return self::tus($this->responder->noContent($response));
    }

    public function visibility(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $phone = AppAuth::phone($request);
        $body = $this->input->body($request, 'AppVisibilityRequest');
        $sourceKey = Input::arg($request, 'sourceKey');

        return $this->responder->json($response, $this->inbox->setVisibility($phone['id'], $sourceKey, (string) $body->visibility), 'AppEntryState');
    }

    public function hints(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        return $this->responder->json($response, $this->inbox->hints(), 'AppHints');
    }

    private static function tus(ResponseInterface $response): ResponseInterface
    {
        return $response->withHeader('Tus-Resumable', self::TUS_VERSION)->withHeader('Cache-Control', 'no-store');
    }

    private static function entryId(ServerRequestInterface $request): string
    {
        $id = Input::arg($request, 'entryId');
        if (!AppRules::isEntryId($id)) {
            throw ApiException::notFound('No such entry.');
        }

        return $id;
    }

    private static function uploadId(ServerRequestInterface $request): string
    {
        $id = Input::arg($request, 'uploadId');
        if (preg_match('/^u_[A-Za-z0-9_-]{16,64}$/D', $id) !== 1) {
            throw ApiException::notFound('No such upload.');
        }

        return $id;
    }
}
