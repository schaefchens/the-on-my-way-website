<?php

declare(strict_types=1);

namespace Omw\Api\Http\Admin;

use Omw\Api\Domain\Ids;
use Omw\Api\Domain\Trips;
use Omw\Api\Http\ApiException;
use Omw\Api\Http\Input;
use Omw\Api\Http\Responder;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 *   GET    /admin/trips          TripListResponse (by start date)
 *   GET    /admin/trips/{slug}   AdminTrip
 *   PUT    /admin/trips/{slug}   TripUpsert -> AdminTrip (201 created, 200 updated); 422 overlapping; 409 stale
 *   DELETE /admin/trips/{slug}   204 (also when already gone)
 */
final class TripController
{
    public function __construct(
        private readonly Input $input,
        private readonly Responder $responder,
        private readonly Trips $trips,
    ) {
    }

    public function list(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        return $this->responder->json($response, ['items' => $this->trips->list()], 'TripListResponse');
    }

    public function get(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $slug = Input::arg($request, 'slug');
        if (!Ids::isSlug($slug)) {
            throw ApiException::notFound('No such trip.');
        }

        return $this->responder->json($response, $this->trips->get($slug), 'AdminTrip');
    }

    public function put(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $slug = Input::arg($request, 'slug');
        if (!Ids::isSlug($slug)) {
            throw ApiException::validation('Invalid slug (lowercase letters, digits and dashes).');
        }
        $result = $this->trips->upsert($slug, $this->input->body($request, 'TripUpsert'));

        return $this->responder->json($response, $result['trip'], 'AdminTrip', $result['created'] ? 201 : 200);
    }

    public function delete(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $slug = Input::arg($request, 'slug');
        if (Ids::isSlug($slug)) {
            $this->trips->delete($slug);
        }

        return $this->responder->noContent($response);
    }
}
