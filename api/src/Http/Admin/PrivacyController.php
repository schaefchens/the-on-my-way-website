<?php

declare(strict_types=1);

namespace Omw\Api\Http\Admin;

use Omw\Api\Domain\Access\PrivacyNotices;
use Omw\Api\Http\Input;
use Omw\Api\Http\Responder;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * The privacy notice (D11, Q7; spec-wave5 §3.5):
 *   GET  /admin/privacy          PrivacyState (the draft is seeded from the template on first use)
 *   PUT  /admin/privacy/draft    PrivacyNoticeDraft -> PrivacyState
 *   POST /admin/privacy/publish  PrivacyPublishRequest {ifDraftSha256} -> PrivacyState; 422 notice_incomplete, 409 conflict
 */
final class PrivacyController
{
    public function __construct(
        private readonly Input $input,
        private readonly Responder $responder,
        private readonly PrivacyNotices $notices,
    ) {
    }

    public function get(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        return $this->responder->json($response, $this->notices->state(), 'PrivacyState');
    }

    public function putDraft(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $this->notices->putDraft($this->input->body($request, 'PrivacyNoticeDraft'));

        return $this->responder->json($response, $this->notices->state(), 'PrivacyState');
    }

    public function publish(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $body = $this->input->body($request, 'PrivacyPublishRequest');
        $this->notices->publish((string) $body->ifDraftSha256);

        return $this->responder->json($response, $this->notices->state(), 'PrivacyState');
    }
}
