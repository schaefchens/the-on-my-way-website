<?php

declare(strict_types=1);

namespace Omw\Api\Http\Admin;

use Omw\Api\Domain\Days;
use Omw\Api\Http\Input;
use Omw\Api\Http\Responder;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 *   GET   /admin/days               DayListResponse (every date with content, ascending)
 *   GET   /admin/days/{localDate}   AdminDayDetail (200 also without a days row)
 *   PATCH /admin/days/{localDate}   DayPatch -> AdminDayDetail; 409 for a stale ifUpdatedAt
 */
final class DayController
{
    public function __construct(
        private readonly Input $input,
        private readonly Responder $responder,
        private readonly Days $days,
    ) {
    }

    public function list(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        return $this->responder->json($response, ['items' => $this->days->list(Input::basePath($request))], 'DayListResponse');
    }

    public function get(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        return $this->responder->json($response, $this->days->detail(Input::arg($request, 'localDate'), Input::basePath($request)), 'AdminDayDetail');
    }

    public function patch(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $date = Input::arg($request, 'localDate');
        Days::assertDate($date);
        $body = $this->input->body($request, 'DayPatch');

        return $this->responder->json($response, $this->days->patch($date, $body, Input::basePath($request)), 'AdminDayDetail');
    }
}
