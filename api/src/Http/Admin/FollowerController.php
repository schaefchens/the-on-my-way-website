<?php

declare(strict_types=1);

namespace Omw\Api\Http\Admin;

use Omw\Api\Domain\Access\FollowerData;
use Omw\Api\Domain\Access\Followers;
use Omw\Api\Domain\Access\StoreApplier;
use Omw\Api\Http\Input;
use Omw\Api\Http\Responder;
use Omw\Api\Infra\Clock;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * People (spec-wave5 §3.5; persons only, the service follower is never listed):
 *   GET  /admin/followers               FollowerListResponse (active first, then revoked; newest first)
 *   POST /admin/followers               FollowerCreate -> FollowerCreated (201; the link is shown once); 409 config_missing
 *   GET  /admin/followers/{fid}         AdminFollower
 *   PATCH /admin/followers/{fid}        FollowerPatch -> AdminFollower
 *   POST /admin/followers/{fid}/link    {} -> PersonalLinkCreated (rotates the link)
 *   POST /admin/followers/{fid}/revoke  {} -> AccessActionResult (idempotent)
 *   GET  /admin/followers/{fid}/export  FollowerDataExport (attachment)
 *   POST /admin/followers/{fid}/delete  FollowerDeleteRequest -> AccessActionResult (deleted_by owner)
 * Access actions apply their store ops right after the commit; effect.applied says whether they
 * are in the store yet. They are idempotent and called outside the admin's offline write queue.
 */
final class FollowerController
{
    public function __construct(
        private readonly Input $input,
        private readonly Responder $responder,
        private readonly Followers $followers,
        private readonly FollowerData $data,
        private readonly StoreApplier $applier,
    ) {
    }

    public function list(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        return $this->responder->json($response, $this->followers->list(), 'FollowerListResponse');
    }

    public function create(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $body = $this->input->body($request, 'FollowerCreate');
        $created = $this->followers->create((string) $body->name, is_string($body->note ?? null) ? $body->note : null);

        return $this->responder->json($response, [
            'follower' => $this->followers->dto($this->followers->get($created['fid'])),
            'link' => $created['link'],
        ], 'FollowerCreated', 201);
    }

    public function get(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        return $this->responder->json($response, $this->followers->dto($this->followers->get(Input::arg($request, 'fid'))), 'AdminFollower');
    }

    public function patch(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $fid = Input::arg($request, 'fid');
        $this->followers->get($fid);
        $this->followers->patch($fid, $this->input->body($request, 'FollowerPatch'));

        return $this->responder->json($response, $this->followers->dto($this->followers->get($fid)), 'AdminFollower');
    }

    public function link(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $link = $this->followers->rotateLink(Input::arg($request, 'fid'));

        return $this->responder->json($response, ['link' => $link], 'PersonalLinkCreated');
    }

    public function revoke(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $fid = Input::arg($request, 'fid');
        $op = $this->followers->revoke($fid);
        if ($op > 0) {
            $this->applier->applyNow(8.0);
        }

        return $this->responder->json($response, [
            'effect' => $this->applier->effect($op),
            'follower' => $this->followers->dto($this->followers->get($fid)),
        ], 'AccessActionResult');
    }

    public function export(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $fid = Input::arg($request, 'fid');
        $this->followers->get($fid);

        return $this->responder->json($response, $this->data->export($fid), 'FollowerDataExport')
            ->withHeader('Content-Disposition', 'attachment; filename="on-my-way-data-' . substr(Clock::nowIso(), 0, 10) . '.json"');
    }

    public function delete(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $fid = Input::arg($request, 'fid');
        $this->input->body($request, 'FollowerDeleteRequest');
        $this->followers->get($fid);
        $op = $this->data->delete($fid, 'owner');
        $this->applier->applyNow(8.0);

        return $this->responder->json($response, ['effect' => $this->applier->effect($op)], 'AccessActionResult');
    }
}
