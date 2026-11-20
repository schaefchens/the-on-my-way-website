<?php

declare(strict_types=1);

namespace Omw\Api\Http\Admin;

use Omw\Api\Domain\Captures;
use Omw\Api\Domain\Ids;
use Omw\Api\Http\ApiException;
use Omw\Api\Http\Input;
use Omw\Api\Http\Responder;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Stream;

/**
 *   GET   /admin/captures?date=&visibility=&kind=&cursor=&limit=  CaptureListResponse (newest first)
 *   GET   /admin/captures/{sourceKey}                             CaptureListItem
 *   PATCH /admin/captures/{sourceKey}                             AnnotationPatch -> CaptureListItem; 409
 *   GET   /admin/captures/{sourceKey}/preview|poster              the private image (only if stored)
 */
final class CaptureController
{
    public function __construct(
        private readonly Input $input,
        private readonly Responder $responder,
        private readonly Captures $captures,
    ) {
    }

    public function list(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $query = $this->input->query($request, 'CaptureListQuery', ['limit']);

        return $this->responder->json($response, $this->captures->list($query, Input::basePath($request)), 'CaptureListResponse');
    }

    public function get(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        return $this->responder->json($response, $this->captures->get(self::sourceKey($request), Input::basePath($request)), 'CaptureListItem');
    }

    public function patch(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $sourceKey = self::sourceKey($request);
        $body = $this->input->body($request, 'AnnotationPatch');

        return $this->responder->json($response, $this->captures->annotate($sourceKey, $body, Input::basePath($request)), 'CaptureListItem');
    }

    public function preview(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        return $this->image($request, $response, 'preview');
    }

    public function poster(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        return $this->image($request, $response, 'poster');
    }

    private function image(ServerRequestInterface $request, ResponseInterface $response, string $role): ResponseInterface
    {
        $file = $this->captures->previewFile(self::sourceKey($request), $role);
        if ($file === null) {
            throw ApiException::notFound('No ' . $role . ' stored for this capture.');
        }
        $etag = '"' . $file['version'] . '"';
        $requested = $request->getQueryParams()['v'] ?? null;
        $response = $response
            ->withHeader('ETag', $etag)
            // Private (behind auth): browsers may cache, shared caches must not. A ?v= that matches
            // the stored content hash makes the URL immutable.
            ->withHeader('Cache-Control', $requested === $file['version'] ? 'private, max-age=31536000, immutable' : 'private, no-cache');
        if (in_array($etag, array_map('trim', explode(',', $request->getHeaderLine('If-None-Match'))), true)) {
            return $response->withStatus(304);
        }
        $handle = fopen($file['path'], 'rb');
        if ($handle === false) {
            throw ApiException::notFound('No ' . $role . ' stored for this capture.');
        }

        return $response
            ->withBody(new Stream($handle))
            ->withHeader('Content-Type', $file['mime'])
            ->withHeader('Content-Length', (string) filesize($file['path']));
    }

    private static function sourceKey(ServerRequestInterface $request): string
    {
        $sourceKey = Input::arg($request, 'sourceKey');
        if (!Ids::isSourceKey($sourceKey)) {
            throw ApiException::notFound('No such capture.');
        }

        return $sourceKey;
    }
}
