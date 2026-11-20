<?php

declare(strict_types=1);

namespace Omw\Api\Domain;

use InvalidArgumentException;

/**
 * PHP port of packages/contracts/src/ids.ts (D4), checked against fixtures/vectors/ids.json.
 *
 *   capture publicId = "e_" + base32(sha256(utf8(sourceKey)))[0..12], lowercase
 */
final class Ids
{
    public const CAPTURE_ID_PREFIX = 'e_';
    public const POST_ID_PREFIX = 'p_';
    public const SOURCE_KEY_RE = '/^([a-z]+):([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/D';
    public const POST_ID_RE = '/^p_[A-Za-z0-9_-]{4,64}$/D';
    public const CAPTURE_ID_RE = '/^e_[a-z2-7]{12}$/D';
    public const SLUG_RE = '/^[a-z0-9]+(?:-[a-z0-9]+)*$/D';

    private const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

    /** RFC 4648 base32, lowercase, without padding. */
    public static function base32Lower(string $bytes): string
    {
        $out = '';
        $buffer = 0;
        $bits = 0;
        $len = strlen($bytes);
        for ($i = 0; $i < $len; ++$i) {
            $buffer = ($buffer << 8) | ord($bytes[$i]);
            $bits += 8;
            while ($bits >= 5) {
                $out .= self::BASE32_ALPHABET[($buffer >> ($bits - 5)) & 31];
                $bits -= 5;
            }
            $buffer &= (1 << $bits) - 1;
        }
        if ($bits > 0) {
            $out .= self::BASE32_ALPHABET[($buffer << (5 - $bits)) & 31];
        }

        return $out;
    }

    public static function publicIdForSourceKey(string $sourceKey): string
    {
        if (!self::isSourceKey($sourceKey)) {
            throw new InvalidArgumentException("Invalid sourceKey: $sourceKey");
        }

        return self::CAPTURE_ID_PREFIX . substr(self::base32Lower(hash('sha256', $sourceKey, true)), 0, 12);
    }

    public static function isSourceKey(mixed $value): bool
    {
        return is_string($value) && strlen($value) <= 160 && preg_match(self::SOURCE_KEY_RE, $value) === 1;
    }

    public static function isPostPublicId(mixed $value): bool
    {
        return is_string($value) && preg_match(self::POST_ID_RE, $value) === 1;
    }

    public static function isSlug(mixed $value): bool
    {
        return is_string($value) && strlen($value) <= 64 && preg_match(self::SLUG_RE, $value) === 1;
    }
}
