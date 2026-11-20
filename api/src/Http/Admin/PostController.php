<?php

declare(strict_types=1);

namespace Omw\Api\Http\Admin;

use Omw\Api\Domain\Ids;
use Omw\Api\Domain\Posts;
use Omw\Api\Http\ApiException;
use Omw\Api\Http\Input;
use Omw\Api\Http\Responder;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 *   GET    /admin/posts?date=&kind=&visibility=&cursor=&limit=  PostListResponse (newest first)
 *   POST   /admin/posts              PostCreate -> AdminPost (201; 200 with the stored post for a known publicId)
 *   GET    /admin/posts/{publicId}   AdminPost
 *   PATCH  /admin/posts/{publicId}   PostUpdate -> AdminPost; 409 for a stale ifUpdatedAt
 *   DELETE /admin/posts/{publicId}   204 (also when the post is already gone)
 */
final class PostController
{
    public function __construct(
        private readonly Input $input,
        private readonly Responder $responder,
        private readonly Posts $posts,
    ) {
    }

    public function list(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $query = $this->input->query($request, 'PostListQuery', ['limit']);

        return $this->responder->json($response, $this->posts->list($query), 'PostListResponse');
    }

    public function create(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $result = $this->posts->create($this->input->body($request, 'PostCreate'));

        return $this->responder->json($response, $result['post'], 'AdminPost', $result['created'] ? 201 : 200);
    }

    public function get(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        return $this->responder->json($response, $this->posts->get(self::publicId($request)), 'AdminPost');
    }

    public function update(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $publicId = self::publicId($request);

        return $this->responder->json($response, $this->posts->update($publicId, $this->input->body($request, 'PostUpdate')), 'AdminPost');
    }

    public function delete(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $publicId = Input::arg($request, 'publicId');
        if (Ids::isPostPublicId($publicId)) {
            $this->posts->delete($publicId);
        }

        return $this->responder->noContent($response);
    }

    private static function publicId(ServerRequestInterface $request): string
    {
        $publicId = Input::arg($request, 'publicId');
        if (!Ids::isPostPublicId($publicId)) {
            throw ApiException::notFound('No such post.');
        }

        return $publicId;
    }
}
