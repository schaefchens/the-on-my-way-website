<?php

declare(strict_types=1);

namespace Omw\Api\Http;

use RuntimeException;
use Throwable;

/**
 * An error with a stable machine-readable code, rendered by {@see JsonErrorHandler} as
 * {"error": {"code": "...", "message": "...", "details": ...}} (contract: ApiError).
 */
final class ApiException extends RuntimeException
{
    /**
     * @param array<string, mixed>|list<mixed>|null $details
     * @param array<string, string>                 $headers extra response headers (Retry-After, Set-Cookie, …)
     */
    public function __construct(
        public readonly int $status,
        public readonly string $errorCode,
        string $message,
        public readonly ?array $details = null,
        ?Throwable $previous = null,
        public readonly array $headers = [],
    ) {
        parent::__construct($message, $status, $previous);
    }

    /** @param array<string, string> $headers */
    public function withHeaders(array $headers): self
    {
        return new self($this->status, $this->errorCode, $this->getMessage(), $this->details, $this->getPrevious(), array_merge($this->headers, $headers));
    }

    public static function unauthorized(string $message = 'Authentication required.'): self
    {
        return new self(401, 'unauthorized', $message);
    }

    public static function forbidden(string $message = 'Forbidden.', string $code = 'forbidden'): self
    {
        return new self(403, $code, $message);
    }

    /** @param array<string, mixed>|list<mixed>|null $details */
    public static function validation(string $message, ?array $details = null): self
    {
        return new self(422, 'validation_failed', $message, $details);
    }

    public static function notFound(string $message = 'Not found.'): self
    {
        return new self(404, 'not_found', $message);
    }

    public static function conflict(string $message): self
    {
        return new self(409, 'conflict', $message);
    }
}
