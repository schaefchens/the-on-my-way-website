<?php

declare(strict_types=1);

namespace Omw\Api\Http;

/**
 * Who is calling (request attribute {@see self::ATTRIBUTE}), set by the auth middlewares.
 */
final class AuthContext
{
    public const ATTRIBUTE = 'omw.auth';

    /**
     * @param string   $kind  session | app | backend
     * @param string   $via   cookie | bearer
     * @param string   $token the presented token (only kept in memory; derives the CSRF token)
     */
    public function __construct(
        public readonly int $tokenId,
        public readonly string $kind,
        public readonly string $via,
        public readonly string $token,
        public readonly ?int $userId = null,
        public readonly ?string $email = null,
        public readonly ?string $displayName = null,
    ) {
    }
}
