<?php

declare(strict_types=1);

namespace Omw\Api\Http;

use Omw\Api\Infra\SchemaValidator;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Routing\RouteContext;
use stdClass;

/**
 * Request input helpers: JSON bodies and query strings validated against the contract's JSON
 * Schemas (api/schemas), path parameters, client IP.
 */
final class Input
{
    /** JSON request bodies larger than this are refused (413) before parsing. */
    public const MAX_JSON_BYTES = 1024 * 1024;

    public function __construct(private readonly SchemaValidator $schemas)
    {
    }

    /**
     * The parsed JSON object body, validated against api/schemas/<$schema>.json.
     *
     * @throws ApiException 413 (too large), 422 (not a JSON object / schema mismatch)
     */
    public function body(ServerRequestInterface $request, string $schema): stdClass
    {
        $size = $request->getBody()->getSize();
        $length = $request->getHeaderLine('Content-Length');
        if (($size !== null && $size > self::MAX_JSON_BYTES) || (ctype_digit($length) && (int) $length > self::MAX_JSON_BYTES)) {
            throw new ApiException(413, 'payload_too_large', sprintf('Request bodies are limited to %d bytes.', self::MAX_JSON_BYTES));
        }
        $type = strtolower(trim(explode(';', $request->getHeaderLine('Content-Type'))[0]));
        if ($type !== 'application/json') {
            throw new ApiException(415, 'unsupported_media_type', 'Request bodies must be application/json.');
        }
        $body = $request->getParsedBody();
        if (!$body instanceof stdClass) {
            throw ApiException::validation('The request body must be a JSON object.');
        }
        $this->validate($body, $schema);

        return $body;
    }

    /**
     * Query parameters as an object validated against $schema. Parameters named in $intKeys are
     * converted to integers first (422 when they are not decimal integers). Repeated or array
     * parameters are rejected.
     *
     * @param list<string> $intKeys
     */
    public function query(ServerRequestInterface $request, string $schema, array $intKeys = []): stdClass
    {
        $out = new stdClass();
        foreach ($request->getQueryParams() as $key => $value) {
            $key = (string) $key;
            if (!mb_check_encoding($key, 'UTF-8') || (is_string($value) && !mb_check_encoding($value, 'UTF-8'))) {
                // The schema validator (opis) throws on malformed UTF-8; this is a client error.
                throw ApiException::validation('Query parameters must be valid UTF-8.');
            }
            if (!is_string($value)) {
                throw ApiException::validation("Query parameter \"$key\" must be a single value.");
            }
            if (in_array($key, $intKeys, true)) {
                if (preg_match('/^(0|[1-9]\d{0,8})$/D', $value) !== 1) {
                    throw ApiException::validation("Query parameter \"$key\" must be a non-negative integer.");
                }
                $out->{$key} = (int) $value;
            } else {
                $out->{$key} = $value;
            }
        }
        $this->validate($out, $schema);

        return $out;
    }

    public function validate(mixed $data, string $schema, string $pointer = ''): void
    {
        $errors = $this->schemas->errors($data, $schema, $pointer);
        if ($errors !== []) {
            throw ApiException::validation('The request does not match the contract (' . $schema . ').', ['errors' => $errors]);
        }
    }

    /** A decoded route argument ("wa%3AABC" -> "wa:ABC"). */
    public static function arg(ServerRequestInterface $request, string $name): string
    {
        $route = RouteContext::fromRequest($request)->getRoute();
        $value = $route?->getArgument($name);
        if ($value === null) {
            throw ApiException::notFound();
        }

        return str_contains($value, '%') ? rawurldecode($value) : $value;
    }

    public static function basePath(ServerRequestInterface $request): string
    {
        return RouteContext::fromRequest($request)->getBasePath();
    }

    /** Client IP as seen by PHP (REMOTE_ADDR); proxies are not trusted. */
    public static function clientIp(ServerRequestInterface $request): string
    {
        $ip = $request->getServerParams()['REMOTE_ADDR'] ?? null;

        return is_string($ip) && $ip !== '' ? substr($ip, 0, 64) : '0.0.0.0';
    }

    public static function isHttps(ServerRequestInterface $request): bool
    {
        if ($request->getUri()->getScheme() === 'https') {
            return true;
        }
        $https = $request->getServerParams()['HTTPS'] ?? null;

        return is_string($https) && $https !== '' && strtolower($https) !== 'off';
    }

    /**
     * Bearer token of the Authorization header. Apache with PHP-FPM/CGI may hide the header;
     * public/.htaccess copies it into HTTP_AUTHORIZATION (which becomes REDIRECT_… after rewrites).
     */
    public static function bearer(ServerRequestInterface $request): ?string
    {
        $header = $request->getHeaderLine('Authorization');
        if ($header === '') {
            $server = $request->getServerParams();
            foreach (['HTTP_AUTHORIZATION', 'REDIRECT_HTTP_AUTHORIZATION', 'REDIRECT_REDIRECT_HTTP_AUTHORIZATION'] as $key) {
                if (is_string($server[$key] ?? null) && $server[$key] !== '') {
                    $header = $server[$key];
                    break;
                }
            }
        }
        if (preg_match('/^Bearer\s+(\S+)\s*$/i', $header, $m) !== 1) {
            return null;
        }

        return $m[1];
    }
}
