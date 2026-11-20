<?php

declare(strict_types=1);

namespace Omw\Api\Http;

use Omw\Api\Config;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/** GET / : redirects to the admin PWA when it is deployed (public/admin/), else 404. */
final class RootAction
{
    public function __construct(private readonly Config $config)
    {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        if (!is_file($this->config->rootDir . '/public/admin/index.html')) {
            throw ApiException::notFound();
        }

        return $response->withStatus(302)->withHeader('Location', Input::basePath($request) . '/admin/')->withHeader('Cache-Control', 'no-store');
    }
}
