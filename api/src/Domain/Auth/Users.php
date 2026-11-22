<?php

declare(strict_types=1);

namespace Omw\Api\Domain\Auth;

use InvalidArgumentException;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;

final class Users
{
    public function __construct(private readonly Db $db)
    {
    }

    /** @return array{id: int, email: string, role: string}|null */
    public function findByEmail(string $email): ?array
    {
        $row = $this->db->one('SELECT id, email, role FROM users WHERE email = ?', [self::normalizeEmail($email)]);

        return $row === null ? null : ['id' => (int) $row['id'], 'email' => (string) $row['email'], 'role' => (string) $row['role']];
    }

    public function passwordHash(int $userId): ?string
    {
        $hash = $this->db->scalar('SELECT password_hash FROM users WHERE id = ?', [$userId]);

        return is_string($hash) ? $hash : null;
    }

    public function count(): int
    {
        return (int) $this->db->scalar('SELECT COUNT(*) FROM users');
    }

    /** @return int new user id */
    public function create(string $email, string $passwordHash, ?string $displayName = null): int
    {
        $email = self::normalizeEmail($email);
        $now = Clock::nowIso();

        return $this->db->write(function () use ($email, $passwordHash, $displayName, $now): int {
            $this->db->exec(
                'INSERT INTO users (email, password_hash, display_name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
                [$email, $passwordHash, $displayName, 'owner', $now, $now],
            );

            return (int) $this->db->pdo()->lastInsertId();
        });
    }

    /**
     * Sets a new password and revokes the user's session tokens, except $keepTokenId (the session
     * that changed the password, spec-wave5 §3.12). With $revokeAppTokens the user's app tokens
     * (kind "app", admin scope) are revoked too. Backend tokens are never touched: they belong to
     * the Mac and revoking them would stop publishing.
     */
    public function setPassword(int $userId, string $passwordHash, ?int $keepTokenId = null, bool $revokeAppTokens = false): void
    {
        $now = Clock::nowIso();
        $this->db->write(function () use ($userId, $passwordHash, $now, $keepTokenId, $revokeAppTokens): void {
            $this->db->exec('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [$passwordHash, $now, $userId]);
            $kinds = $revokeAppTokens ? "'session', 'app'" : "'session'";
            $this->db->exec(
                "UPDATE api_tokens SET revoked_at = ? WHERE user_id = ? AND kind IN ($kinds) AND revoked_at IS NULL AND id IS NOT ?",
                [$now, $userId, $keepTokenId],
            );
        });
    }

    /** True when the user has app tokens that are still valid (the admin then offers to end them). */
    public function hasAppTokens(int $userId): bool
    {
        return $this->db->scalar(
            "SELECT 1 FROM api_tokens WHERE user_id = ? AND kind = 'app' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) LIMIT 1",
            [$userId, Clock::nowIso()],
        ) !== null;
    }

    /**
     * Changes the login e-mail of the user that currently has $currentEmail (both validated and
     * normalized; unique case-insensitively). Sessions and app tokens stay valid: they belong to
     * the user id. The user's successful login attempts move to the new e-mail, so the owner's
     * usual devices stay exempt from the per-e-mail login block (LoginThrottle known devices);
     * failures stay with the old e-mail.
     *
     * @return array{id: int, changed: bool} changed false: the user already had exactly $newEmail
     *
     * @throws InvalidArgumentException invalid e-mail, no user with $currentEmail, or $newEmail taken by another user
     */
    public function changeEmail(string $currentEmail, string $newEmail): array
    {
        $from = self::normalizeEmail($currentEmail);
        $to = self::normalizeEmail($newEmail);
        if (strlen($to) > 254) {
            throw new InvalidArgumentException('The e-mail address is longer than 254 characters.');
        }

        return $this->db->write(function () use ($from, $to): array {
            $user = $this->findByEmail($from) ?? throw new InvalidArgumentException(sprintf('No user with the e-mail %s.', $from));
            if ($user['email'] === $to) {
                return ['id' => $user['id'], 'changed' => false];
            }
            $other = $this->findByEmail($to);
            if ($other !== null && $other['id'] !== $user['id']) {
                throw new InvalidArgumentException(sprintf('Another user already has the e-mail %s.', $to));
            }
            $now = Clock::nowIso();
            $this->db->exec('UPDATE users SET email = ?, updated_at = ? WHERE id = ?', [$to, $now, $user['id']]);
            $this->db->exec('UPDATE login_attempts SET email = ? WHERE email = ? AND success = 1', [$to, $from]);

            return ['id' => $user['id'], 'changed' => true];
        });
    }

    public static function normalizeEmail(string $email): string
    {
        $email = trim($email);
        if (filter_var($email, FILTER_VALIDATE_EMAIL) === false) {
            throw new InvalidArgumentException(sprintf('"%s" is not a valid e-mail address.', $email));
        }

        return mb_strtolower($email);
    }
}
