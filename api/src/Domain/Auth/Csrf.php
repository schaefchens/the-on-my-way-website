<?php

declare(strict_types=1);

namespace Omw\Api\Domain\Auth;

/**
 * CSRF tokens DERIVED from the admin session token (contract Me.csrfToken):
 *   csrf = base64url(sha256("omw-csrf:" . sessionToken))
 * Nothing is stored, so GET /me returns the same token in every tab and after a PWA restart, and
 * logging out (revoking the session) invalidates it. The session token never leaves its HttpOnly
 * cookie and cannot be derived back from the CSRF token.
 */
final class Csrf
{
    public const HEADER = 'X-CSRF-Token';

    public static function tokenFor(string $sessionToken): string
    {
        return rtrim(strtr(base64_encode(hash('sha256', 'omw-csrf:' . $sessionToken, true)), '+/', '-_'), '=');
    }

    public static function verify(string $sessionToken, ?string $headerValue): bool
    {
        return $headerValue !== null && $headerValue !== '' && hash_equals(self::tokenFor($sessionToken), $headerValue);
    }
}
