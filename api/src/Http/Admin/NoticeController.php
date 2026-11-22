<?php

declare(strict_types=1);

namespace Omw\Api\Http\Admin;

use Omw\Api\Domain\Access\OwnerNotices;
use Omw\Api\Http\Input;
use Omw\Api\Http\Responder;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * One-shot owner notices without names (spec-wave5 §3.5, §3.9):
 *   GET  /admin/notices       OwnerNoticeList (newest first)
 *   POST /admin/notices/read  NoticeReadRequest {ids} -> 204
 */
final class NoticeController
{
    public function __construct(
        private readonly Input $input,
        private readonly Responder $responder,
        private readonly OwnerNotices $notices,
    ) {
    }

    public function list(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        return $this->responder->json($response, ['items' => $this->notices->list()], 'OwnerNoticeList');
    }

    public function read(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $body = $this->input->body($request, 'NoticeReadRequest');
        $this->notices->markRead(array_values(array_map('intval', (array) $body->ids)));

        return $this->responder->noContent($response);
    }
}
