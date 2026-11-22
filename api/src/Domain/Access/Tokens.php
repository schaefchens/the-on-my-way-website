<?php

declare(strict_types=1);

namespace Omw\Api\Domain\Access;

/**
 * Random identifiers and secrets of the access gate (spec-wave5 §0.3):
 *
 *   follower id  12 chars of base32 (a-z2-7) from 8 random bytes (60 bits), never reused
 *   device id    8 chars of base32 from 5 random bytes (40 bits)
 *   token        base64url of 32 random bytes, no padding (43 chars): link secret t, session id
 *                sid, device key k, panic key
 *   epoch, storeId  16 lowercase hex chars (8 random bytes)
 *
 * Presented tokens are looked up by their sha256 hex ({@see hash()}), never compared by prefix.
 */
final class Tokens
{
    private const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

    public static function token(): string
    {
        return rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
    }

    public static function followerId(): string
    {
        return substr(self::base32(random_bytes(8)), 0, 12);
    }

    public static function deviceId(): string
    {
        return self::base32(random_bytes(5));
    }

    public static function hex16(): string
    {
        return bin2hex(random_bytes(8));
    }

    /** Lowercase hex sha256 of a presented token (how the API stores and looks up tokens). */
    public static function hash(string $token): string
    {
        return hash('sha256', $token);
    }

    public static function isToken(mixed $value): bool
    {
        return is_string($value) && preg_match('/^' . StoreLayout::TOKEN . '$/D', $value) === 1;
    }

    public static function isFollowerId(mixed $value): bool
    {
        return is_string($value) && preg_match('/^' . StoreLayout::FID . '$/D', $value) === 1;
    }

    public static function isDeviceId(mixed $value): bool
    {
        return is_string($value) && preg_match('/^' . StoreLayout::DID . '$/D', $value) === 1;
    }

    /** RFC 4648 base32 with the lowercase alphabet, no padding. */
    public static function base32(string $bytes): string
    {
        $bits = '';
        foreach (str_split($bytes) as $byte) {
            $bits .= str_pad(decbin(ord($byte)), 8, '0', STR_PAD_LEFT);
        }
        $out = '';
        foreach (str_split($bits, 5) as $chunk) {
            $out .= self::BASE32[(int) bindec(str_pad($chunk, 5, "0"))];
        }

        return $out;
    }
}
