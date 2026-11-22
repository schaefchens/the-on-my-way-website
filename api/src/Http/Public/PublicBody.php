<?php

declare(strict_types=1);

namespace Omw\Api\Http\Public;

use Omw\Api\Http\ApiException;
use Omw\Api\Infra\SchemaValidator;
use Psr\Http\Message\ServerRequestInterface;
use stdClass;

/**
 * Bodies of the public routes (spec-wave5 §3.4): CORS "simple requests" with
 * `Content-Type: text/plain;charset=UTF-8` (no preflight, no cookies) or application/json, a JSON
 * object of at most 8192 bytes, validated against api/schemas/<Name>.json. Every refusal is
 * 400 validation_failed (413 when too large).
 */
final class PublicBody
{
    public const MAX_BYTES = 8192;

    public function __construct(private readonly SchemaValidator $schemas)
    {
    }

    public function read(ServerRequestInterface $request, string $schema): stdClass
    {
        $type = strtolower(trim(explode(';', $request->getHeaderLine('Content-Type'))[0]));
        if ($type !== 'text/plain' && $type !== 'application/json') {
            throw self::invalid('Send the body as text/plain (JSON).');
        }
        $stream = $request->getBody();
        if ($stream->isSeekable()) {
            $stream->rewind();
        }
        $raw = $stream->read(self::MAX_BYTES + 1);
        if (strlen($raw) > self::MAX_BYTES) {
            throw new ApiException(413, 'payload_too_large', sprintf('Request bodies are limited to %d bytes.', self::MAX_BYTES));
        }
        if (!mb_check_encoding($raw, 'UTF-8')) {
            throw self::invalid('The body must be UTF-8 JSON.');
        }
        try {
            $body = json_decode($raw, false, 16, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw self::invalid('The body must be a JSON object.');
        }
        if (!$body instanceof stdClass) {
            throw self::invalid('The body must be a JSON object.');
        }
        $errors = $this->schemas->errors($body, $schema);
        if ($errors !== []) {
            throw new ApiException(400, 'validation_failed', 'The request does not match the contract (' . $schema . ').', ['errors' => $errors]);
        }

        return $body;
    }

    public static function invalid(string $message): ApiException
    {
        return new ApiException(400, 'validation_failed', $message);
    }
}
