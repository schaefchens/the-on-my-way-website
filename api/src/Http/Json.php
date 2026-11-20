<?php

declare(strict_types=1);

namespace Omw\Api\Http;

use Psr\Http\Message\ResponseInterface;

final class Json
{
    /**
     * Invalid UTF-8 (e.g. echoed from a malformed query string into an error message) is replaced
     * by U+FFFD instead of failing: a JsonException here would escape the error handler and end
     * the request with an empty 500.
     */
    public const FLAGS = JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION | JSON_INVALID_UTF8_SUBSTITUTE;

    public static function encode(mixed $data): string
    {
        return json_encode($data, self::FLAGS);
    }

    /**
     * Writes $data as the JSON body of $response. API responses are never cacheable.
     */
    public static function respond(ResponseInterface $response, mixed $data, int $status = 200): ResponseInterface
    {
        $response->getBody()->write(self::encode($data));

        return $response
            ->withStatus($status)
            ->withHeader('Content-Type', 'application/json; charset=utf-8')
            ->withHeader('Cache-Control', 'no-store');
    }
}
