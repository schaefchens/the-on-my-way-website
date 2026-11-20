<?php

declare(strict_types=1);

namespace Omw\Api\Infra;

use InvalidArgumentException;
use Omw\Api\Domain\Auth\ApiTokens;
use Omw\Api\Domain\Auth\Passwords;
use Omw\Api\Domain\Auth\Users;
use Psr\Log\LoggerInterface;
use RuntimeException;

/**
 * First-run / recovery bootstrap without a shell: the deploy script (scripts/deploy-api.ts)
 * uploads var/bootstrap.json, the app consumes it once on the next request (under the setup
 * lock, see {@see AutoMigrator}) and deletes it. The file never contains clear-text secrets:
 *
 *   {
 *     "version": 1,
 *     "admin": {                                   // optional
 *       "email": "owner@example.org",
 *       "passwordHash": "$argon2id$…",             // password_hash(…, PASSWORD_ARGON2ID)
 *       "passwordHashFallback": "$2y$12$…",        // optional bcrypt, used where Argon2 is missing
 *       "displayName": "Owner",                    // optional
 *       "reset": false                             // true: replace the password of an existing user
 *     },
 *     "tokens": [                                  // optional, e.g. the backend token
 *       {"kind": "backend", "name": "home", "tokenHash": "<sha256 hex of the token>", "hint": "omw_AbC12…"}
 *     ],
 *     "rotateFeedId": false,                       // true after a restore (docs/HOSTING.md)
 *     "adminEmail": {                              // optional: change the login e-mail
 *       "from": "old@example.org", "to": "new@example.org"
 *     }
 *   }
 *
 * Existing users are never changed without "reset"; tokens with a known hash are skipped, so a
 * re-uploaded file is harmless. "adminEmail" uses the same code as bin/set-admin-email.php
 * (Users::changeEmail: sessions stay valid); it is applied after "admin", is idempotent (a user
 * that already has "to" counts as done) and, when it cannot apply (no user with "from", "to"
 * taken by another user), it is logged and skipped instead of blocking every request. All DB changes run in one transaction. A file that cannot be
 * parsed is renamed to bootstrap.json.invalid-<time> (and the error logged) so it never blocks
 * the app. If the file cannot be deleted after a successful run, meta.bootstrap_sha256 prevents
 * a second consumption.
 */
final class Bootstrapper
{
    public const FILE = 'bootstrap.json';

    public function __construct(
        private readonly Db $db,
        private readonly Paths $paths,
        private readonly ?LoggerInterface $logger = null,
    ) {
    }

    /**
     * @return array{admin: string, tokens: int, rotatedFeedId: bool, adminEmail: string}|null null when there was no file
     *
     * @phpstan-impure reads and deletes var/bootstrap.json
     */
    public function consume(): ?array
    {
        $file = $this->paths->var(self::FILE);
        $raw = @file_get_contents($file);
        if ($raw === false) {
            return null;
        }
        $sha = hash('sha256', $raw);
        if ($this->db->scalar("SELECT value FROM meta WHERE key = 'bootstrap_sha256'") === $sha) {
            Fs::remove($file);

            return null;
        }

        try {
            // Everything that does not depend on the database is checked here, so a file that can
            // never be applied is set aside instead of being retried (under the setup lock and in a
            // write transaction) on every request. Database errors (e.g. a lock timeout) keep the
            // file for the next request.
            $spec = self::parse($raw);
            $adminHash = $spec['admin'] === null ? null : self::usableHash($spec['admin']['passwordHash'], $spec['admin']['passwordHashFallback']);
        } catch (InvalidArgumentException $e) {
            $aside = $file . '.invalid-' . gmdate('Ymd\THis\Z');
            @rename($file, $aside);
            throw new RuntimeException('Invalid var/bootstrap.json (moved to ' . basename($aside) . '): ' . $e->getMessage(), 0, $e);
        }

        $result = $this->db->write(function () use ($spec, $sha, $adminHash): array {
            $adminResult = 'none';
            $userId = null;
            if ($spec['admin'] !== null && $adminHash !== null) {
                [$adminResult, $userId] = $this->applyAdmin($spec['admin'], $adminHash);
            }
            $tokens = 0;
            foreach ($spec['tokens'] as $token) {
                $owner = $token['kind'] === 'backend' ? null : $userId;
                if ($token['kind'] !== 'backend' && $owner === null) {
                    throw new RuntimeException('App tokens in bootstrap.json need an "admin" entry.');
                }
                if ((new ApiTokens($this->db))->insertHashed($token['kind'], $token['name'], $token['tokenHash'], $token['hint'], $owner, $token['expiresAt']) !== null) {
                    ++$tokens;
                }
            }
            $emailResult = $spec['adminEmail'] === null ? 'none' : $this->applyAdminEmail($spec['adminEmail']['from'], $spec['adminEmail']['to']);
            if ($spec['rotateFeedId']) {
                $this->db->exec("UPDATE meta SET value = lower(hex(randomblob(16))) WHERE key = 'feed_id'");
            }
            $this->db->exec(
                "INSERT INTO meta (key, value) VALUES ('bootstrap_sha256', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                [$sha],
            );

            return ['admin' => $adminResult, 'tokens' => $tokens, 'rotatedFeedId' => $spec['rotateFeedId'], 'adminEmail' => $emailResult];
        });

        if (!Fs::remove($file)) {
            $this->logger?->warning('Could not delete var/bootstrap.json after consuming it; delete it via SFTP.');
        }
        $this->logger?->notice('Consumed var/bootstrap.json', $result);

        return $result;
    }

    /**
     * @param array{email: string, passwordHash: string, passwordHashFallback: string|null, displayName: string|null, reset: bool} $admin
     * @param string $hash the hash this PHP build can verify ({@see usableHash()})
     * @return array{0: string, 1: int}
     */
    private function applyAdmin(array $admin, string $hash): array
    {
        $users = new Users($this->db);
        $existing = $users->findByEmail($admin['email']);
        if ($existing === null) {
            return ['created', $users->create($admin['email'], $hash, $admin['displayName'])];
        }
        if ($admin['reset']) {
            $users->setPassword($existing['id'], $hash);

            return ['password_reset', $existing['id']];
        }

        return ['exists', $existing['id']];
    }

    /** @return string changed | unchanged | skipped */
    private function applyAdminEmail(string $from, string $to): string
    {
        $users = new Users($this->db);
        if ($users->findByEmail($from) === null) {
            if ($users->findByEmail($to) !== null) {
                return 'unchanged'; // applied before (or "from" == "to")
            }
            $this->logger?->warning('bootstrap.json adminEmail skipped: no user {from}', ['from' => $from]);

            return 'skipped';
        }
        try {
            return $users->changeEmail($from, $to)['changed'] ? 'changed' : 'unchanged';
        } catch (InvalidArgumentException $e) {
            $this->logger?->warning('bootstrap.json adminEmail skipped: {error}', ['error' => $e->getMessage()]);

            return 'skipped';
        }
    }

    /**
     * The Argon2id hash, or the fallback where this PHP build cannot verify Argon2id.
     *
     * @throws InvalidArgumentException when no usable hash is present
     */
    private static function usableHash(string $hash, ?string $fallback): string
    {
        $algo = password_get_info($hash)['algoName'];
        if ($algo === 'argon2id' && !Passwords::argon2idAvailable()) {
            if ($fallback === null || password_get_info($fallback)['algoName'] === 'unknown') {
                throw new InvalidArgumentException('this PHP build cannot verify Argon2id hashes and there is no passwordHashFallback');
            }

            return $fallback;
        }
        if ($algo === 'unknown') {
            throw new InvalidArgumentException('admin.passwordHash is not a password_hash() hash');
        }

        return $hash;
    }

    /**
     * @return array{
     *   admin: array{email: string, passwordHash: string, passwordHashFallback: string|null, displayName: string|null, reset: bool}|null,
     *   tokens: list<array{kind: string, name: string, tokenHash: string, hint: string, expiresAt: string|null}>,
     *   rotateFeedId: bool,
     *   adminEmail: array{from: string, to: string}|null
     * }
     */
    public static function parse(string $raw): array
    {
        try {
            $data = json_decode($raw, true, 16, JSON_THROW_ON_ERROR);
        } catch (\JsonException $e) {
            throw new InvalidArgumentException('not valid JSON: ' . $e->getMessage());
        }
        if (!is_array($data) || ($data['version'] ?? null) !== 1) {
            throw new InvalidArgumentException('expected an object with "version": 1');
        }
        $admin = null;
        if (isset($data['admin'])) {
            $a = $data['admin'];
            if (!is_array($a) || !is_string($a['email'] ?? null) || !is_string($a['passwordHash'] ?? null)) {
                throw new InvalidArgumentException('admin needs "email" and "passwordHash"');
            }
            $admin = [
                'email' => Users::normalizeEmail($a['email']),
                'passwordHash' => $a['passwordHash'],
                'passwordHashFallback' => is_string($a['passwordHashFallback'] ?? null) ? $a['passwordHashFallback'] : null,
                'displayName' => is_string($a['displayName'] ?? null) ? mb_substr($a['displayName'], 0, 100) : null,
                'reset' => ($a['reset'] ?? false) === true,
            ];
        }
        $tokens = [];
        foreach (is_array($data['tokens'] ?? null) ? $data['tokens'] : [] as $i => $t) {
            if (!is_array($t) || !in_array($t['kind'] ?? null, ['backend', 'app'], true) || !is_string($t['tokenHash'] ?? null)
                || preg_match('/^[0-9a-f]{64}$/D', $t['tokenHash']) !== 1) {
                throw new InvalidArgumentException("tokens[$i] needs kind backend|app and a sha256 hex tokenHash");
            }
            $tokens[] = [
                'kind' => (string) $t['kind'],
                'name' => is_string($t['name'] ?? null) ? mb_substr($t['name'], 0, 100) : 'bootstrap',
                'tokenHash' => $t['tokenHash'],
                'hint' => is_string($t['hint'] ?? null) ? mb_substr($t['hint'], 0, 32) : 'omw_…',
                'expiresAt' => is_string($t['expiresAt'] ?? null) ? $t['expiresAt'] : null,
            ];
        }

        if ($admin === null && array_filter($tokens, static fn (array $t): bool => $t['kind'] !== 'backend') !== []) {
            throw new InvalidArgumentException('app tokens need an "admin" entry (they belong to a user)');
        }
        $adminEmail = null;
        if (isset($data['adminEmail'])) {
            $e = $data['adminEmail'];
            if (!is_array($e) || !is_string($e['from'] ?? null) || !is_string($e['to'] ?? null)) {
                throw new InvalidArgumentException('adminEmail needs "from" and "to"');
            }
            $adminEmail = ['from' => Users::normalizeEmail($e['from']), 'to' => Users::normalizeEmail($e['to'])];
            if (strlen($adminEmail['to']) > 254) {
                throw new InvalidArgumentException('adminEmail.to is longer than 254 characters');
            }
        }

        return ['admin' => $admin, 'tokens' => $tokens, 'rotateFeedId' => ($data['rotateFeedId'] ?? false) === true, 'adminEmail' => $adminEmail];
    }
}
