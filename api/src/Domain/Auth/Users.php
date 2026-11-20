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
     * Sets a new password and revokes the user's sessions.
     */
    public function setPassword(int $userId, string $passwordHash): void
    {
        $now = Clock::nowIso();
        $this->db->write(function () use ($userId, $passwordHash, $now): void {
            $this->db->exec('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [$passwordHash, $now, $userId]);
            $this->db->exec(
                "UPDATE api_tokens SET revoked_at = ? WHERE user_id = ? AND kind = 'session' AND revoked_at IS NULL",
                [$now, $userId],
            );
        });
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
