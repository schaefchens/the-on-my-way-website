<?php

declare(strict_types=1);

namespace Omw\Api\Http\Middleware;

use Omw\Api\Config;
use Omw\Api\Http\ApiException;
use Omw\Api\Http\Public\PublicBody;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;
use Omw\Api\Infra\RateLimiter;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;

/**
 * In front of every public route (spec-wave5 §3.4, §3.7), inside Cors:
 * - maintenance → 503 maintenance;
 * - Content-Length above 8192 → 413 before the body is read;
 * - the global cap: 1200 public requests per hour → 503 busy (Retry-After: 60) and the
 *   public_flood alert (viewing the site never needs the API, so a flood only delays joins).
 */
final class PublicGuard implements MiddlewareInterface
{
    public const GLOBAL_PER_HOUR = 1200;

    public function __construct(
        private readonly Config $config,
        private readonly RateLimiter $limiter,
        private readonly Db $db,
    ) {
    }

    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        if ($this->config->inMaintenance()) {
            throw (new ApiException(503, 'maintenance', 'A deploy is in progress. Try again in a few seconds.'))->withHeaders(['Retry-After' => '30']);
        }
        $length = $request->getHeaderLine('Content-Length');
        if (ctype_digit($length) && (int) $length > PublicBody::MAX_BYTES) {
            throw new ApiException(413, 'payload_too_large', sprintf('Request bodies are limited to %d bytes.', PublicBody::MAX_BYTES));
        }
        if (strtoupper($request->getMethod()) === 'POST' && $this->limiter->hit('pub', '', self::GLOBAL_PER_HOUR, 3600) > 0) {
            $this->db->write(fn (): int => $this->db->exec(
                "INSERT INTO meta (key, value) VALUES ('public_flood_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                [Clock::nowIso()],
            ));
            throw (new ApiException(503, 'busy', 'Too many requests right now. Please try again in a minute.'))->withHeaders(['Retry-After' => '60']);
        }

        return $handler->handle($request);
    }
}
