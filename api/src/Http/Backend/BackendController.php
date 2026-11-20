<?php

declare(strict_types=1);

namespace Omw\Api\Http\Backend;

use finfo;
use Omw\Api\Domain\BackendStatus;
use Omw\Api\Domain\Captures;
use Omw\Api\Domain\ChangeLog;
use Omw\Api\Domain\Ids;
use Omw\Api\Http\ApiException;
use Omw\Api\Http\Input;
use Omw\Api\Http\Responder;
use Omw\Api\Infra\Backups;
use Omw\Api\Infra\Doctor;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Message\UploadedFileInterface;
use Slim\Psr7\Stream;

/**
 * /api/v1/backend/* (Bearer token of kind "backend", see Middleware\BackendAuth).
 *
 *   PUT  /captures/{sourceKey}           CaptureMirror -> 201 (created) | 204 (updated or unchanged)
 *   POST /captures/{sourceKey}/preview   multipart role+file -> 204; 404 capture_not_mirrored; 413; 415
 *                                        (204 but discarded for a revoked capture while ingest.on_revoke = hide)
 *   POST /captures/{sourceKey}/revoke    CaptureRevoke -> 204; 404 capture_not_mirrored (on_revoke = hide:
 *                                        its private preview and poster are deleted)
 *   GET  /changes?after=&limit=          ChangesResponse; 409 feed_reset
 *   POST /heartbeat                      Heartbeat -> 204
 *   POST /published                      PublishedReport -> 204
 *   GET  /backup/latest                  newest snapshot (application/vnd.sqlite3) | 304 | 404
 */
final class BackendController
{
    public const CHANGES_DEFAULT_LIMIT = 200;
    public const CHANGES_MAX_LIMIT = 1000;

    public function __construct(
        private readonly Input $input,
        private readonly Responder $responder,
        private readonly Captures $captures,
        private readonly ChangeLog $changes,
        private readonly BackendStatus $status,
        private readonly Backups $backups,
    ) {
    }

    public function putCapture(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $sourceKey = self::sourceKey($request);
        $body = $this->input->body($request, 'CaptureMirror');
        $created = $this->captures->mirror($sourceKey, $body);

        return $created ? $response->withStatus(201)->withHeader('Cache-Control', 'no-store') : $this->responder->noContent($response);
    }

    public function preview(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $sourceKey = self::sourceKey($request);
        $length = $request->getHeaderLine('Content-Length');
        $postMax = Doctor::iniBytes((string) ini_get('post_max_size'));
        // The multipart envelope adds a little overhead to the file itself.
        if (ctype_digit($length) && ((int) $length > Captures::PREVIEW_MAX_BYTES + 64 * 1024 || ($postMax > 0 && (int) $length > $postMax))) {
            throw self::tooLarge();
        }
        $type = strtolower(trim(explode(';', $request->getHeaderLine('Content-Type'))[0]));
        if ($type !== 'multipart/form-data') {
            throw new ApiException(415, 'unsupported_media_type', 'Previews are uploaded as multipart/form-data (fields "role" and "file").');
        }
        $fields = $request->getParsedBody();
        $role = is_array($fields) ? ($fields['role'] ?? null) : null;
        if (!is_string($role) || !in_array($role, Captures::ROLES, true)) {
            throw ApiException::validation('Field "role" must be "preview" or "poster".', ['errors' => ['/role: must be preview|poster']]);
        }
        $file = $request->getUploadedFiles()['file'] ?? null;
        if (!$file instanceof UploadedFileInterface) {
            throw ApiException::validation('Field "file" is missing.', ['errors' => ['/file: required']]);
        }
        $error = $file->getError();
        if ($error === UPLOAD_ERR_INI_SIZE || $error === UPLOAD_ERR_FORM_SIZE) {
            throw self::tooLarge();
        }
        if ($error === UPLOAD_ERR_NO_FILE) {
            throw ApiException::validation('Field "file" is missing.', ['errors' => ['/file: required']]);
        }
        if ($error !== UPLOAD_ERR_OK) {
            throw new ApiException(500, 'internal', 'The upload failed on the server (PHP upload error ' . $error . ').');
        }
        $size = $file->getSize();
        if ($size !== null && $size > Captures::PREVIEW_MAX_BYTES) {
            throw self::tooLarge();
        }
        $stream = $file->getStream();
        $bytes = $stream->read(Captures::PREVIEW_MAX_BYTES + 1);
        if (strlen($bytes) > Captures::PREVIEW_MAX_BYTES) {
            throw self::tooLarge();
        }
        if ($bytes === '') {
            throw ApiException::validation('The file is empty.', ['errors' => ['/file: empty']]);
        }
        $mime = (new finfo(FILEINFO_MIME_TYPE))->buffer($bytes);
        if (!is_string($mime) || !isset(Captures::PREVIEW_MIME_TYPES[$mime])) {
            throw new ApiException(415, 'unsupported_media_type', 'Previews must be WebP or JPEG (got ' . (is_string($mime) ? $mime : 'unknown') . ').');
        }
        $this->captures->storePreview($sourceKey, $role, $bytes, $mime);

        return $this->responder->noContent($response);
    }

    public function revoke(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $sourceKey = self::sourceKey($request);
        $body = $this->input->body($request, 'CaptureRevoke');
        $this->captures->revoke($sourceKey, (string) $body->at);

        return $this->responder->noContent($response);
    }

    public function changes(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $query = $request->getQueryParams();
        $after = self::intParam($query, 'after', 0, 0, PHP_INT_MAX);
        $limit = self::intParam($query, 'limit', self::CHANGES_DEFAULT_LIMIT, 1, self::CHANGES_MAX_LIMIT);
        $unknown = array_diff(array_map('strval', array_keys($query)), ['after', 'limit']);
        if ($unknown !== []) {
            throw ApiException::validation('Unknown query parameter(s): ' . mb_scrub(implode(', ', $unknown), 'UTF-8'));
        }

        return $this->responder->json($response, $this->changes->page($after, $limit), 'ChangesResponse');
    }

    public function heartbeat(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $this->status->recordHeartbeat($this->input->body($request, 'Heartbeat'));

        return $this->responder->noContent($response);
    }

    public function published(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $this->status->recordPublished($this->input->body($request, 'PublishedReport'));

        return $this->responder->noContent($response);
    }

    public function backupLatest(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $latest = $this->backups->latest();
        if ($latest === null) {
            throw ApiException::notFound('No backup yet (cron creates one per night).');
        }
        $etag = '"' . $latest['sha256'] . '"';
        $response = $response
            ->withHeader('ETag', $etag)
            ->withHeader('Cache-Control', 'no-store')
            ->withHeader('X-Omw-Backup-Created-At', $latest['createdAt'])
            ->withHeader('X-Omw-Backup-Sha256', $latest['sha256']);
        if (in_array($etag, array_map('trim', explode(',', $request->getHeaderLine('If-None-Match'))), true)) {
            return $response->withStatus(304);
        }
        $handle = fopen($latest['path'], 'rb');
        if ($handle === false) {
            throw new ApiException(500, 'internal', 'Cannot read the backup.');
        }

        return $response
            ->withBody(new Stream($handle))
            ->withHeader('Content-Type', 'application/vnd.sqlite3')
            ->withHeader('Content-Length', (string) $latest['bytes'])
            ->withHeader('Content-Disposition', 'attachment; filename="' . $latest['name'] . '"');
    }

    private static function sourceKey(ServerRequestInterface $request): string
    {
        $sourceKey = Input::arg($request, 'sourceKey');
        if (!Ids::isSourceKey($sourceKey)) {
            throw ApiException::validation('Invalid sourceKey (expected "<ns>:<id>").');
        }

        return $sourceKey;
    }

    /** @param array<array-key, mixed> $query */
    private static function intParam(array $query, string $name, int $default, int $min, int $max): int
    {
        if (!array_key_exists($name, $query)) {
            return $default;
        }
        $value = $query[$name];
        if (!is_string($value) || preg_match('/^(0|[1-9]\d{0,17})$/D', $value) !== 1 || (int) $value < $min || (int) $value > $max) {
            throw ApiException::validation(sprintf('Query parameter "%s" must be an integer between %d and %d.', $name, $min, $max));
        }

        return (int) $value;
    }

    private static function tooLarge(): ApiException
    {
        return new ApiException(413, 'payload_too_large', sprintf('Previews are limited to %d bytes.', Captures::PREVIEW_MAX_BYTES));
    }
}
