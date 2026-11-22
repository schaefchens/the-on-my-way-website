<?php

declare(strict_types=1);

namespace Omw\Api\Http\Admin;

use Omw\Api\Config;
use Omw\Api\Domain\Access\AccessState;
use Omw\Api\Domain\Access\StoreApplier;
use Omw\Api\Domain\Access\StoreLayout;
use Omw\Api\Domain\Access\StoreOps;
use Omw\Api\Domain\Access\Tokens;
use Omw\Api\Domain\Auth\LoginThrottle;
use Omw\Api\Domain\Auth\Passwords;
use Omw\Api\Http\ApiException;
use Omw\Api\Http\Input;
use Omw\Api\Http\Responder;
use Omw\Api\Infra\Db;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * The site's access as a whole (spec-wave5 §3.5):
 *   GET    /admin/access             AccessStatus (also runs the pending restore reconcile)
 *   POST   /admin/access/lock        LockRequest -> AccessActionResult (unlock needs the password: 403 forbidden, counted like a login; 429)
 *   POST   /admin/access/retry       {} -> AccessStatus (clears an SFTP auth block once, applies and reconciles now)
 *   POST   /admin/access/store-init  {} -> AccessActionResult ("Website-Speicher einrichten": store id + init op)
 *   POST   /admin/access/panic-link  {} -> PanicLinkCreated (the link is shown once)
 *   DELETE /admin/access/panic-link  204
 */
final class AccessController
{
    public function __construct(
        private readonly Input $input,
        private readonly Responder $responder,
        private readonly AccessState $state,
        private readonly StoreApplier $applier,
        private readonly StoreOps $ops,
        private readonly LoginThrottle $throttle,
        private readonly Config $config,
        private readonly Db $db,
    ) {
    }

    public function status(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        if ($this->state->isRestoring() && $this->config->access->apiWrites()) {
            $this->applier->applyNow(8.0, true);
        }

        return $this->responder->json($response, $this->accessStatus(), 'AccessStatus');
    }

    public function lock(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $body = $this->input->body($request, 'LockRequest');
        if ($body->locked === true) {
            $op = $this->state->lock('admin');
        } else {
            $this->verifyPassword($request, (string) $body->password);
            $op = $this->state->unlock();
        }
        if ($op > 0) {
            $this->applier->applyNow(8.0);
        }

        return $this->responder->json($response, ['effect' => $this->applier->effect($op), 'status' => $this->state->summary()], 'AccessActionResult');
    }

    public function retry(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $this->applier->clearBlock();
        $this->applier->applyNow(8.0, true);

        return $this->responder->json($response, $this->accessStatus(), 'AccessStatus');
    }

    public function storeInit(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $op = $this->db->write(function (): int {
            $row = $this->state->row();
            $storeId = is_string($row['store_id'] ?? null) ? $row['store_id'] : Tokens::hex16();
            if (!is_string($row['store_id'] ?? null)) {
                $this->db->exec('UPDATE access_state SET store_id = ?, updated_at = ? WHERE id = 1', [$storeId, \Omw\Api\Infra\Clock::nowIso()]);
            }
            $pending = $this->ops->pendingInit();
            if ($pending !== null) {
                return $pending;
            }

            return $this->ops->enqueue('init', StoreLayout::MARKER, StoreApplier::markerJson($storeId, (string) $row['epoch'], (int) $row['last_applied_op']));
        });
        $this->applier->applyNow(8.0);

        return $this->responder->json($response, ['effect' => $this->applier->effect($op), 'status' => $this->state->summary()], 'AccessActionResult');
    }

    public function createPanicLink(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $origin = $this->config->siteOrigin;
        if (!StoreLayout::isOrigin($origin)) {
            throw new ApiException(409, 'config_missing', 'SITE_ORIGIN is not configured on the API.');
        }
        $key = Tokens::token();
        $this->state->setPanicHash(Tokens::hash($key));

        return $this->responder->json($response, ['url' => StoreLayout::panicLinkUrl($origin, $key)], 'PanicLinkCreated');
    }

    public function deletePanicLink(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $this->state->setPanicHash(null);

        return $this->responder->noContent($response);
    }

    /** @return array<string, mixed> contract AccessStatus */
    private function accessStatus(): array
    {
        $row = $this->state->row();
        $origin = $this->config->siteOrigin;
        $pending = array_map(static fn (array $r): array => [
            'did' => (string) $r['did'],
            'fid' => (string) $r['fid'],
            'name' => (string) $r['name'],
            'label' => (string) $r['label'],
            'createdAt' => (string) $r['created_at'],
        ], $this->db->all(
            "SELECT d.id AS did, f.id AS fid, f.name, d.label, d.created_at FROM devices d JOIN followers f ON f.id = d.follower_id
             WHERE d.state = 'pending' AND f.kind = 'person' AND f.state = 'active' ORDER BY d.created_at DESC, d.id LIMIT 3",
        ));

        return $this->state->summary() + [
            'panicLink' => is_string($row['panic_hash'] ?? null),
            'siteOrigin' => StoreLayout::isOrigin($origin) ? $origin : null,
            'cookieMode' => $this->config->access->cookieMode,
            'lastReconcile' => $this->state->reconcileReport(),
            'lastAppliedAt' => is_string($row['last_applied_at'] ?? null) ? $row['last_applied_at'] : null,
            'storeId' => is_string($row['store_id'] ?? null) ? $row['store_id'] : null,
            'storeProofAt' => is_string($row['store_proof_at'] ?? null) ? $row['store_proof_at'] : null,
            'gateCheck' => $this->state->gateCheck(),
            'pending' => $pending,
        ];
    }

    /** The logged-in owner's password, rate limited and recorded like a login (§3.3 Lock 2). */
    private function verifyPassword(ServerRequestInterface $request, string $password): void
    {
        $auth = SessionController::auth($request);
        $user = $auth->userId === null ? null : $this->db->one('SELECT email, password_hash FROM users WHERE id = ?', [$auth->userId]);
        $attempt = $this->throttle->begin(Input::clientIp($request), is_string($user['email'] ?? null) ? $user['email'] : null);
        if ($attempt['attemptId'] === null) {
            throw new ApiException(429, 'rate_limited', 'Too many failed attempts. Try again later.', ['retryAfter' => $attempt['retryAfter']]);
        }
        if ($user === null || strlen($password) > 4096 || !Passwords::verify($password, (string) $user['password_hash'])) {
            throw ApiException::forbidden('The password is not correct.');
        }
        $this->throttle->succeeded($attempt['attemptId']);
    }
}
