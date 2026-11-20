<?php

declare(strict_types=1);

namespace Omw\Api\Domain\Auth;

use InvalidArgumentException;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;

/**
 * API tokens: "omw_" + 43 base64url characters (256 random bits). Only the lowercase hex
 * sha256 of the whole token string is stored, so a token is shown exactly once at creation.
 */
final class ApiTokens
{
    public const PREFIX = 'omw_';
    public const KINDS = ['session', 'backend', 'app'];

    /** Scopes: "backend" = /api/v1/backend/*, "admin" = /api/v1/admin/*. */
    public const SCOPES = ['backend', 'admin'];

    /** Scopes are fixed per kind (contracts TOKEN_KIND_SCOPES; api_tokens CHECK constraint). */
    public const DEFAULT_SCOPES = [
        'session' => ['admin'],
        'backend' => ['backend'],
        'app' => ['admin'],
    ];

    public function __construct(private readonly Db $db)
    {
    }

    public static function generate(): string
    {
        return self::PREFIX . rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
    }

    public static function hash(string $token): string
    {
        return hash('sha256', $token);
    }

    public static function looksLikeToken(string $value): bool
    {
        return preg_match('/^omw_[A-Za-z0-9_-]{43}$/D', $value) === 1;
    }

    /**
     * Creates a token and returns it in clear text (the only time it is available).
     *
     * @param list<string>|null $scopes null = default scopes of the kind
     * @return array{id: int, token: string}
     */
    public function create(string $kind, string $name, ?array $scopes = null, ?int $userId = null, ?string $expiresAt = null): array
    {
        if (!in_array($kind, self::KINDS, true)) {
            throw new InvalidArgumentException(sprintf('Token kind must be one of %s.', implode('|', self::KINDS)));
        }
        $scopes ??= self::DEFAULT_SCOPES[$kind];
        foreach ($scopes as $scope) {
            if (!in_array($scope, self::SCOPES, true)) {
                throw new InvalidArgumentException(sprintf('Unknown scope "%s" (known: %s).', $scope, implode(', ', self::SCOPES)));
            }
        }
        $scopes = array_values(array_unique($scopes));
        if ($scopes !== self::DEFAULT_SCOPES[$kind]) {
            throw new InvalidArgumentException(sprintf(
                'A "%s" token always has the scope(s) %s.',
                $kind,
                implode(',', self::DEFAULT_SCOPES[$kind]),
            ));
        }
        if ($kind !== 'backend' && $userId === null) {
            throw new InvalidArgumentException(sprintf('A "%s" token must belong to a user.', $kind));
        }

        $token = self::generate();
        $id = $this->db->write(function () use ($kind, $name, $scopes, $userId, $expiresAt, $token): int {
            $this->db->exec(
                'INSERT INTO api_tokens (kind, name, user_id, token_hash, token_hint, scopes, created_at, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [
                    $kind,
                    $name,
                    $userId,
                    self::hash($token),
                    substr($token, 0, 10) . '…',
                    json_encode($scopes, JSON_THROW_ON_ERROR),
                    Clock::nowIso(),
                    $expiresAt,
                ],
            );

            return (int) $this->db->pdo()->lastInsertId();
        });

        return ['id' => $id, 'token' => $token];
    }

    /**
     * Backend and app tokens in the contract shape ApiTokenInfo (GET /api/v1/admin/tokens),
     * newest first. Session tokens are never listed.
     *
     * @return list<array{id: int, kind: string, name: string, hint: string, scopes: list<string>,
     *                    createdAt: string, expiresAt: string|null, lastUsedAt: string|null, revokedAt: string|null}>
     */
    public function list(bool $includeRevoked = false): array
    {
        $rows = $this->db->all(
            "SELECT id, kind, name, token_hint, scopes, created_at, expires_at, last_used_at, revoked_at
             FROM api_tokens WHERE kind <> 'session'"
            . ($includeRevoked ? '' : ' AND revoked_at IS NULL')
            . ' ORDER BY id DESC',
        );

        $out = [];
        foreach ($rows as $row) {
            /** @var list<string> $scopes */
            $scopes = json_decode((string) $row['scopes'], true, 4, JSON_THROW_ON_ERROR);
            $out[] = [
                'id' => (int) $row['id'],
                'kind' => (string) $row['kind'],
                'name' => (string) $row['name'],
                'hint' => (string) $row['token_hint'],
                'scopes' => $scopes,
                'createdAt' => (string) $row['created_at'],
                'expiresAt' => $row['expires_at'] === null ? null : (string) $row['expires_at'],
                'lastUsedAt' => $row['last_used_at'] === null ? null : (string) $row['last_used_at'],
                'revokedAt' => $row['revoked_at'] === null ? null : (string) $row['revoked_at'],
            ];
        }

        return $out;
    }

    /**
     * Inserts a token that was generated elsewhere (first-run bootstrap: the deploy script keeps
     * the clear text locally and ships only its sha256). Returns the new id, or null when a
     * token with that hash already exists.
     */
    public function insertHashed(string $kind, string $name, string $tokenHash, string $hint, ?int $userId = null, ?string $expiresAt = null): ?int
    {
        if (!in_array($kind, self::KINDS, true)) {
            throw new InvalidArgumentException(sprintf('Token kind must be one of %s.', implode('|', self::KINDS)));
        }
        if (preg_match('/^[0-9a-f]{64}$/D', $tokenHash) !== 1) {
            throw new InvalidArgumentException('tokenHash must be a lowercase sha256 hex digest.');
        }
        if ($kind !== 'backend' && $userId === null) {
            throw new InvalidArgumentException(sprintf('A "%s" token must belong to a user.', $kind));
        }

        return $this->db->write(function () use ($kind, $name, $tokenHash, $hint, $userId, $expiresAt): ?int {
            if ($this->db->scalar('SELECT 1 FROM api_tokens WHERE token_hash = ?', [$tokenHash]) !== null) {
                return null;
            }
            $this->db->exec(
                'INSERT INTO api_tokens (kind, name, user_id, token_hash, token_hint, scopes, created_at, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [$kind, $name, $userId, $tokenHash, mb_substr($hint, 0, 32), json_encode(self::DEFAULT_SCOPES[$kind], JSON_THROW_ON_ERROR), Clock::nowIso(), $expiresAt],
            );

            return (int) $this->db->pdo()->lastInsertId();
        });
    }

    /**
     * Looks up an active (not revoked, not expired) token by its clear text.
     *
     * @return array{id: int, kind: string, scopes: list<string>, userId: int|null, email: string|null,
     *               displayName: string|null, expiresAt: string|null, lastUsedAt: string|null}|null
     */
    public function authenticate(string $token): ?array
    {
        if (!self::looksLikeToken($token)) {
            return null;
        }
        $row = $this->db->one(
            'SELECT t.id, t.kind, t.scopes, t.user_id, t.expires_at, t.last_used_at, u.email, u.display_name
             FROM api_tokens t LEFT JOIN users u ON u.id = t.user_id
             WHERE t.token_hash = ? AND t.revoked_at IS NULL',
            [self::hash($token)],
        );
        if ($row === null) {
            return null;
        }
        $expiresAt = $row['expires_at'] === null ? null : (string) $row['expires_at'];
        if ($expiresAt !== null && $expiresAt <= Clock::nowIso()) {
            return null;
        }
        if ($row['kind'] !== 'backend' && $row['email'] === null) {
            return null; // user deleted (ON DELETE CASCADE normally removes the token anyway)
        }
        /** @var list<string> $scopes */
        $scopes = json_decode((string) $row['scopes'], true, 4, JSON_THROW_ON_ERROR);

        return [
            'id' => (int) $row['id'],
            'kind' => (string) $row['kind'],
            'scopes' => $scopes,
            'userId' => $row['user_id'] === null ? null : (int) $row['user_id'],
            'email' => $row['email'] === null ? null : (string) $row['email'],
            'displayName' => $row['display_name'] === null ? null : (string) $row['display_name'],
            'expiresAt' => $expiresAt,
            'lastUsedAt' => $row['last_used_at'] === null ? null : (string) $row['last_used_at'],
        ];
    }

    /**
     * Records the use of a token, at most once per $everySeconds (keeps GET requests write-free
     * most of the time). Returns true when it wrote.
     */
    public function touch(int $id, ?string $lastUsedAt, string $ip, int $everySeconds = 60): bool
    {
        $now = Clock::now();
        if ($lastUsedAt !== null && $lastUsedAt > Clock::iso($now->modify("-$everySeconds seconds"))) {
            return false;
        }

        return $this->db->write(fn (): bool => $this->db->exec(
            'UPDATE api_tokens SET last_used_at = ?, last_used_ip = ? WHERE id = ?',
            [Clock::iso($now), $ip, $id],
        ) > 0);
    }

    /** Sets a new expiry (sliding admin sessions). */
    public function extend(int $id, string $expiresAt): void
    {
        $this->db->write(fn (): int => $this->db->exec('UPDATE api_tokens SET expires_at = ? WHERE id = ? AND revoked_at IS NULL', [$expiresAt, $id]));
    }

    /** Revokes the token with this clear text (logout). */
    public function revokeToken(string $token): bool
    {
        return $this->db->write(
            fn (): bool => $this->db->exec('UPDATE api_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL', [Clock::nowIso(), self::hash($token)]) > 0,
        );
    }

    /**
     * Deletes session tokens that expired or were revoked before $olderThanIso (cron cleanup).
     * Backend/app tokens are kept for the audit trail.
     */
    public function pruneSessions(string $olderThanIso): int
    {
        return $this->db->write(fn (): int => $this->db->exec(
            "DELETE FROM api_tokens WHERE kind = 'session'
               AND ((revoked_at IS NOT NULL AND revoked_at < ?) OR (expires_at IS NOT NULL AND expires_at < ?))",
            [$olderThanIso, $olderThanIso],
        ));
    }

    /**
     * One token in the contract shape ApiTokenInfo, or null.
     *
     * @return array{id: int, kind: string, name: string, hint: string, scopes: list<string>,
     *               createdAt: string, expiresAt: string|null, lastUsedAt: string|null, revokedAt: string|null}|null
     */
    public function info(int $id): ?array
    {
        foreach ($this->list(true) as $token) {
            if ($token['id'] === $id) {
                return $token;
            }
        }

        return null;
    }

    /** @return bool false if no active token had that id */
    public function revoke(int $id, bool $includeSessions = true): bool
    {
        return $this->db->write(
            fn (): bool => $this->db->exec(
                'UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL' . ($includeSessions ? '' : " AND kind <> 'session'"),
                [Clock::nowIso(), $id],
            ) > 0,
        );
    }

    public function countActive(string $kind): int
    {
        return (int) $this->db->scalar(
            'SELECT COUNT(*) FROM api_tokens WHERE kind = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)',
            [$kind, Clock::nowIso()],
        );
    }
}
