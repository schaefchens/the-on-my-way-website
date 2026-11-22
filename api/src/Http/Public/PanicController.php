<?php

declare(strict_types=1);

namespace Omw\Api\Http\Public;

use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 *   POST /public/panic  PanicRequest {key} -> PanicResponse {ok: true}
 *
 * The optional panic link (Q6): locks the site when the key matches the stored hash. The answer
 * is always {ok: true}, so it tells nobody whether the key was right.
 */
final class PanicController
{
    public function __construct(
        private readonly PublicBody $body,
        private readonly PublicSupport $s,
    ) {
    }

    public function panic(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $body = $this->body->read($request, 'PanicRequest');
        $ip = PublicSupport::ip($request);
        $this->s->limit([['ip', $ip, 60, 600], ['panic_ip', $ip, 10, 3600]]);
        if ($this->s->state->panicMatches((string) $body->key) && $this->s->state->lock('panic') > 0) {
            $this->s->applier->applyNow(8.0);
        }

        return $this->s->answer($response, ['ok' => true], 'PanicResponse');
    }
}
