<?php

declare(strict_types=1);

namespace Omw\Api\Domain\Auth;

/**
 * Password hashing: Argon2id when PHP was built with it, bcrypt (cost 12) otherwise.
 * Hashes made with the fallback are upgraded on the next successful login via {@see needsRehash()}.
 * New passwords need at least {@see MIN_LENGTH} characters (contracts PASSWORD_MIN_LENGTH; wave 5
 * raised it from 10 to 12 for the admin's "change password" and bin/create-admin.php).
 */
final class Passwords
{
    public const MIN_LENGTH = 12;
    private const BCRYPT_COST = 12;

    public static function argon2idAvailable(): bool
    {
        return defined('PASSWORD_ARGON2ID') && in_array('argon2id', password_algos(), true);
    }

    public static function algorithmName(): string
    {
        return self::argon2idAvailable() ? 'argon2id' : 'bcrypt';
    }

    public static function hash(string $password): string
    {
        if (self::argon2idAvailable()) {
            return password_hash($password, 'argon2id');
        }

        return password_hash($password, PASSWORD_BCRYPT, ['cost' => self::BCRYPT_COST]);
    }

    public static function verify(string $password, string $hash): bool
    {
        return password_verify($password, $hash);
    }

    public static function needsRehash(string $hash): bool
    {
        return self::argon2idAvailable()
            ? password_needs_rehash($hash, 'argon2id')
            : password_needs_rehash($hash, PASSWORD_BCRYPT, ['cost' => self::BCRYPT_COST]);
    }

    /** @return string|null reason the password is rejected, null if acceptable */
    public static function weakness(string $password): ?string
    {
        if (mb_strlen($password) < self::MIN_LENGTH) {
            return sprintf('Password must be at least %d characters long.', self::MIN_LENGTH);
        }
        if (strlen($password) > 4096) {
            return 'Password is too long.';
        }

        return null;
    }
}
