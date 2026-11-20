<?php

declare(strict_types=1);

namespace Omw\Api\Http\Middleware;

use Omw\Api\Infra\AutoMigrator;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;

/**
 * Zero-shell operation: before the first request after a deploy is routed, pending migrations
 * are applied and var/bootstrap.json is consumed ({@see AutoMigrator}). The fast path is a few
 * stat() calls and one tiny file read.
 */
final class AutoSetup implements MiddlewareInterface
{
    public function __construct(private readonly AutoMigrator $migrator)
    {
    }

    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        $this->migrator->ensure();

        return $handler->handle($request);
    }
}
